<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Implemented architecture

**Status:** Reference solution validated locally and in `ap-southeast-2` on
2026-10-26. Scoped writes, fresh shared tenant recall, cross-tenant denial,
direct Memory denial, and Gateway role-assumption denial passed. The teardown
audit found all recorded service resources absent; only two
permissionless IAM roles remain because the deployment session denies their
deletion. See `VALIDATION.md`.

## Purpose and identity

The vendor pools one Memory resource for synthetic tenant organisations.
The issuer supplies full memory scopes; Gateway validates signed JWTs and
enforces Cedar. Both A agents have the same actor/shared path and distinct
session claims ([ADR-0001](adr/0001-use-issuer-scoped-claims.md)). Clients cannot
construct a broader permit.

Inbound `CUSTOM_JWT` and outbound `GATEWAY_IAM_ROLE` make the dedicated Gateway
role the identity that reaches Memory. Cedar evaluates claims on the typed
`AgentCore::OAuthUser` principal; those claims do not become IAM session tags
on the execution role. No Gateway interceptor or STS vending service is
configured. ADR-0001 documents upstream caller IAM credentials, custom-target
vending, and an optional hybrid as alternative designs.

## Components

`src/gateway_memory.py` routes SDK-serialized native HTTP requests through the
named connector. `src/render_config.py` emits resource, target, role, and policy
configuration without submitting it. `src/validate_live.py` explicitly opts
into real calls and reports observed status. `src/live_environment.py` creates
the dedicated environment and tears it down in a `finally` block.
`src/test_identity.py` supplies Cognito access-token scopes for three fixed
synthetic identities (ADR-0003); production tenant membership is an external
responsibility. This Lambda produces issuer claims; it does not vend downstream
credentials.

## Data model and workflows

Events belong to an actor and session. The strategy extracts tenant-wide facts
to `/tenants/{actorId}/shared/`. Retrieval uses only the exact issuer-provided
namespacePath; descendants must have the same sharing entitlement.
CreateEvent cannot supply extractionConfig in this kit.

Event creation has its own permit. Short-term event reads and deletion are
excluded because their live request context did not expose the actor and
session path parameters needed for a safe tenant check. Retrieve/List records
share a namespace permit. Record-ID access is excluded because the ID alone
does not prove namespace ownership.
Resource-based IAM denies the listed Memory data APIs outside the exact
Gateway execution role, using `aws:PrincipalArn`. Its trust allows only the
AgentCore service with the exact source account and Gateway/Policy engine
ARNs. Gateway's role grants only the demonstrated Memory operations.

## Deployment details

The native Memory target uses the HTTP connector. Gateway creation omits
`protocolType`; an explicitly MCP-only Gateway rejects that target.
Policy engine and policy names use letters, digits, and underscores.

The Gateway role also needs `AuthorizeAction`, `PartiallyAuthorizeActions`, and
`GetPolicyEngine` for its Policy engine. During creation, Policy evaluation
temporarily permits `gateway/*` in the selected account and Region, while Memory
permissions stay pinned to the dedicated resource. Before adding a target, the
driver replaces the wildcard with the actual Gateway ARN and narrows role trust
to the Gateway and engine ARNs. JWT authentication and ENFORCE remain enabled
throughout. The role separately allows `GetMemory` on the dedicated resource
for target metadata validation; the three tenant data actions stay unchanged.

## Validation

Thirty policy cases run in Cedar WASM 4.14.0. Thirty-two Python tests cover
SDK wire serialization, HTTP error classification, redirects, endpoint/target
validation, generated IAM/connector configuration, live harness inputs,
issuer-controlled scopes, idempotent readiness retries, diagnostic redaction,
failure cleanup, and the combined resource-policy/role-trust boundary.
The results are recorded in `VALIDATION.md`.

The cloud harness requires the real Gateway URL and connector configuration to
match its inputs, three separately scoped signed JWTs, and AWS read permissions
for preflight checks. It submits synthetic facts, waits for both tenants'
canaries, probes cross-tenant and cross-session access, and tests a direct IAM
request outside Gateway and an attempted direct role assumption. Failed
extraction is a failed/incomplete test, not a
successful isolation outcome.

The repository contribution requirements remain documented in
[ADR-0002](adr/0002-deliver-draft-validation-kit.md).

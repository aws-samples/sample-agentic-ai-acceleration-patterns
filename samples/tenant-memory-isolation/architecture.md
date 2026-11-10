<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Implemented architecture

**Status:** Reference solution, verified locally on 2026-11-10 and last run
live in `ap-southeast-2` on 2026-10-26.

| Check (live run 2026-10-26, SDK driver) | Observed outcome |
| --- | --- |
| Gateway authentication and authorization | `CUSTOM_JWT`, Policy `ENFORCE`, Gateway `READY` |
| Scoped event writes | Allowed for Tenant A shopping, Tenant A support, and Tenant B shopping |
| Cross-tenant write | Denied by Cedar |
| Caller-supplied extraction override | Denied by Cedar |
| Exact tenant namespace retrieval | Allowed for both tenants |
| Two agents sharing Tenant A long-term memory | Both returned the same Tenant A record |
| Tenant B isolation | Tenant B returned only its own record; no Tenant A canary appeared |
| Changed namespace paths (retrieve) | Tenant B, tenant root, and actor root paths denied |
| Actor enumeration and record-ID access | Denied by default |
| Direct IAM retrieval and direct role assumption | Denied |
| New semantic extraction | Both tenant canaries became retrievable through Gateway |

The run removed every service resource it created; its two IAM roles were
emptied of permissions and left for later deletion. Teardown now deletes both
roles.

Changes since that run, verified by the unit and Cedar suites only: the fence
covers `IngestData` (ADR-0007), the policies reject actor and namespace claims
outside one tenant path, and the harness adds cross-session write,
`ListMemoryRecords` namespace, direct `IngestData`, and 401 expired-token
probes, with direct probes attributable to the fence (see Validation).

## Purpose and identity

The vendor pools one Memory resource for synthetic tenant organisations.
The issuer supplies full memory scopes; Gateway validates signed JWTs and
enforces Cedar. Both A agents have the same actor/shared path and distinct
session claims ([ADR-0001](adr/0001-enforce-tenant-memory-scope-in-agentcore-gateway.md)). Clients cannot
construct a broader permit.

Inbound `CUSTOM_JWT` and outbound `GATEWAY_IAM_ROLE` make the dedicated Gateway
role the identity that reaches Memory. Cedar evaluates claims on the typed
`AgentCore::OAuthUser` principal; those claims do not become IAM session tags
on the execution role. Enforcement sits in Gateway and Policy, with no
interceptor or credential vending on the path (ADR-0001).

## Components

`src/gateway_memory.py` routes SDK-serialized native HTTP requests through the
named connector. `src/render_config.py` emits resource, target, role, and policy
configuration without submitting it. `src/validate_live.py` explicitly opts
into real calls and reports observed status. `src/live_environment.py` creates
the dedicated environment and tears it down in a `finally` block.
`src/test_identity.py` supplies Cognito access-token scopes for three fixed
synthetic identities (ADR-0003), building actor, session, and namespace from
one tenant id; production tenant membership is an external responsibility.

## Data model and workflows

Events belong to an actor and session. The strategy extracts tenant-wide facts
to `/tenants/{actorId}/shared/`. Retrieval uses only the exact issuer-provided
namespacePath; descendants must have the same sharing entitlement, so the
policies accept only actor claims of one path segment and namespace claims of
exactly `/tenants/<one segment>/shared/`. CreateEvent cannot supply
extractionConfig.

Event creation has its own permit. Short-term event reads and deletion are
excluded because their live request context did not expose the actor and
session path parameters needed for a safe tenant check (ADR-0005). Retrieve/List records
share a namespace permit. Record-ID access is excluded because the ID alone
does not prove namespace ownership.
Resource-based IAM denies every Memory data operation in the service model
outside the exact Gateway execution role, using `aws:PrincipalArn` (ADR-0004,
ADR-0007). Its trust allows only the
AgentCore service with the exact source account and Gateway/Policy engine
ARNs. Gateway's role grants only the demonstrated Memory operations.

## Deployment details

The native Memory target uses the HTTP connector. Gateway creation omits
`protocolType`; an explicitly MCP-only Gateway rejects that target (ADR-0006).
Gateway errors use the default exception level, so callers see no service
detail.
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

`npm test` runs 38 policy cases in Cedar WASM 4.14.0. `python -m unittest`
runs 44 tests: SDK wire serialization, HTTP error classification, redirects,
endpoint and target validation, generated IAM and connector configuration,
the fence against the service model, live harness inputs, issuer-controlled
scopes, idempotent readiness retries, diagnostic redaction, failure cleanup,
and the combined resource-policy and role-trust boundary.

The cloud harness requires the real Gateway URL and connector configuration to
match its inputs, three separately scoped signed JWTs, and AWS read permissions
for preflight checks. It submits synthetic facts, waits for both tenants'
canaries, and probes cross-tenant and cross-session writes, changed namespaces
for retrieve and list, ingestion through Gateway, and record-ID access. A
direct call outside Gateway (retrieve, ingest, role assumption) runs only when
`iam:SimulatePrincipalPolicy` shows the caller's own policies would allow it,
so its denial is attributable to the fence or the role trust; otherwise it is
recorded `NOT_RUN`. An expired token must fail with 401 on a request its scope
permits. Failed extraction is a failed run, not an isolation result.

Access tokens last 60 minutes and are not refreshed, so the extraction wait is
capped at 30 minutes.

The repository contribution requirements remain documented in
[ADR-0002](adr/0002-deliver-draft-validation-kit.md).

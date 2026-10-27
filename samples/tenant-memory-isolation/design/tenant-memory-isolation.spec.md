<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant memory isolation solution code sample

## Problem statement

Demonstrate a pool of tenant organisations using one AgentCore Memory resource
through its native HTTP connector on AgentCore Gateway. Two agents in a tenant
share deliberately selected long-term facts while retaining separate short-term
sessions. This draft includes a disposable SDK test deployment and a synthetic
Cognito issuer. Production identity integration and the repository's complete
CDK contribution gates remain outside this iteration.

## Guiding principles

1. **P-1: The vendor's identity provider owns the memory scope.** A caller cannot
   obtain a broader actor, session, or namespace by changing request arguments.
2. **P-2: Share only the facts the tenant has agreed to share.** Tenant-wide
   memory contains synthetic organisational facts, not private user preferences.
3. **P-3: A missing claim or an unlisted operation denies access.** Each Cedar
   permit names its operations and Gateway. The connector fixes the Memory ID,
   and IAM permissions pin the Memory resource ARN.
4. **P-4: Evidence must distinguish policy evaluation from deployed enforcement.**
   Local Cedar tests are real language evaluation, but do not prove JWT
   validation, Gateway context mapping, extraction, or resource-policy enforcement.

## System shape

The vendor supplies an OIDC issuer, audience/client restrictions, a Gateway
execution role, one Memory resource with a semantic strategy, and a Policy
engine in ENFORCE mode. The issuer verifies tenant membership and agent/session
entitlement before issuing `memory_actor`, `memory_session`, and
`memory_namespace` claims. Gateway authenticates each bearer token and uses its
execution role downstream. There is no token vending service in this path.

## Data model

`actorId=tenant-a` represents a tenant organisation. Its semantic strategy writes
to `/tenants/{actorId}/shared/`. Agent sessions such as `shopping-001` and
`support-001` remain separate under that actor. A tenant token carries the exact
shared path and exactly one permitted session. A real private-user extension
must use a distinct actor/path and issue separate scoped tokens.

## API surface

Native Memory HTTP operations are routed through `/{targetName}/{Memory path}`.
The SDK model supplies the Memory method, path, and wire serialization. The
agent-facing API permits `CreateEvent` only for the signed actor/session pair,
and `RetrieveMemoryRecords` and `ListMemoryRecords` only for the signed
`namespacePath`. Stored event reads and deletion, actor/session enumeration,
record-ID access, batch writes, and extraction administration receive no tenant
permits. Applications retain the context needed to continue active conversations
in their own session layer.

## Contracts

The sample promises repeatable local Cedar tests, SDK shape/serialization tests,
configuration generation, an explicit live isolation harness, and journalled
cleanup of its disposable environment. It does not
promise a green cloud run until its `--execute` harness passes in the deployer's
chosen Region. No deployment or hosting credentials belong in its source.

The test issuer assigns fixed scopes to administrator-created identities and
ignores client metadata and user attributes. It demonstrates claim enforcement,
not production tenant membership verification. Gateway creation omits the
MCP-only protocol setting so the native Memory HTTP target can be added.
Before targets are created, the driver narrows bootstrap IAM Policy evaluation
permissions to the returned Gateway and Policy engine ARNs.

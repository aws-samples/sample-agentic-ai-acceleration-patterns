<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0009: Bind each tenant to the namespace equal to its tenant id

- Status: Accepted
- Date: 2026-11-10
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

The sample's tokens must carry the repository token contract only
(`ARCHITECTURE.md` §2.1): `tenant_id`, `sub`, `client_id`, and
`token_use: access`. Writes already bind `actorId` to a claim. Recall needs
the requested namespace bound to the tenant too, and Cedar cannot build
`/tenants/<tenant_id>/shared/` from `tenant_id`: it has no string
concatenation and `like` patterns are literals
([policy examples](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-fgac-policy-examples.html)).
`RetrieveMemoryRecords` and `ListMemoryRecords` take either an exact
`namespace` or a hierarchical `namespacePath`; a strategy's namespace
template may be `{actorId}` alone (pinned SDK model).

## Options considered

### Option 1: A namespace claim minted by the issuer

The previous design (`memory_namespace`). Pros: keeps slash-delimited
namespaces. Cons: a non-standard claim every issuer must mint and keep in
step with the actor claim (T-1).

### Option 2: One policy per tenant with literal values

`tenant_id == "tenant-a" && namespace == "/tenants/tenant-a/shared/"`,
written at onboarding. Pros: standard claims. Cons: an onboarding hook per
tenant and the engine's policy quota as a tenant limit.

### Option 3: The namespace is the tenant id, compared exactly

The strategy template is `{actorId}`; writes require
`actorId == tenant_id`; recall requires `namespace == tenant_id` and no
`namespacePath`. Pros: standard claims, two fixed policies, actor and
namespace tied by construction. Cons: departs from the documented
slash-delimited convention, whose purpose is to stop prefix collisions in
hierarchical (`namespacePath`) retrieval; exact matching only holds while
`namespacePath` stays refused.

## Decision

Option 3. Every extracted fact of a tenant lands in the namespace that
equals its tenant id, and an agent can name only that namespace, exactly.
The policies also refuse tenant ids containing `/`, `:`, or `*`, so a tenant
id can never act as a path, a scope, or a wildcard. Sessions are bound to
`sub` by default: each user's conversation history is its own, and the
tenant's facts are shared by every user and agent of the tenant.

## Consequences

The tenant claim alone decides both the actor and the namespace, so an
issuer cannot pair them wrongly. The integration test names Tenant B
`tenant-ab`, an id that extends Tenant A's, to show exact matching live. A
deployment that needs several namespaces per tenant (for example private
user facts) needs a second strategy and a second recall policy; per-user
private namespaces would need `{actorId}` to be the user, which Option 1
serves better. A token with one `sub` writes to one session; per-conversation
sessions need a session claim from the issuer.

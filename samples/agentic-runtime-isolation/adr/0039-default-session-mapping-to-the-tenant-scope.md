<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0039: Default session mapping to the tenant scope when it is turned on

- Status: Accepted
- Date: 2026-11-02
- Amends: ADR-0013
- Deciders: Dave Roberts (PSA)

## Context
ADR-0013 made session mapping an optional module, off by default, with `session: { scope?: 'user' | 'tenant' }` and `'user'` as the scope when `session` is set without one. In v2 an agent is a product a tenant subscribes to (ADR-0032), and a conversation with such an agent is most often the tenant's: several tenant users pick up the same case, order or thread, and the agent's tools read tenant data under the tenant's credentials (P-8). A per-user default makes two colleagues naming the same `conversationId` land in two units, which surprises the vendor who turned the module on for exactly that continuity. The module stays off by default: a fresh unit per request remains the strictest setting and the v1 default.

## Options considered
### Option 1: Keep `'user'` as the scope when `session` is set
Pros: the stricter of the two scopes; no change from v1. Cons: the common case (a tenant's shared conversation) needs an explicit `scope: 'tenant'`, and a deployer who forgets it ships continuity that breaks across colleagues.

### Option 2: `'tenant'` when `session` is set; `'user'` as the option
`runtimeSessionId = "s-" + base32(sha256(tenant_id))[0:26] + "-" + conversationId` by default; `scope: 'user'` keeps the per-user prefix. Pros: matches the product model; one conversation per tenant per `conversationId`; the tenant boundary is unchanged, since the prefix still comes only from the verified `tenant_id`. Cons: within one tenant, users who name the same `conversationId` share a unit, so the agent MUST treat unit state as tenant-shared and MUST NOT cache one user's authority or transaction token in it; a user who wants privacy from colleagues needs `scope: 'user'`.

### Option 3: Require `scope` whenever `session` is set
Pros: no surprise either way. Cons: one more required prop for the common case; the standard asks for secure defaults, not for refusing to default.

## Decision
Option 2. The module default (off) does not change; only the scope used when the deployer turns it on becomes `'tenant'`, with `'user'` as the explicit option. Both ingresses apply the same rule (P-2).

## Consequences
Easier: a vendor turning session mapping on gets tenant-wide continuity without reading the prop table. Harder: the demo agent and the README state that unit state is tenant-shared under the default; the transaction token (ADR-0031) is per user and per request, so the agent MUST read it from each request's header and never from unit state. The integration test's step 4b splits: the default stack shows A2 sharing A1's conversation and B1 refused, and a `scope: 'user'` stack shows A2 refused. Revisit if a consumer needs a third scope (for example per agent) or a per-tenant choice of scope.

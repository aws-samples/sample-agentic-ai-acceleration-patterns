<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0032: Model an agent as a product: a backend plus the tools it may use, capped below the tenant's subscription

- Status: Accepted
- Date: 2026-11-02
- Amends: ADR-0011, ADR-0024
- Amended by: the 2026-11-04 review (grant compression)
- Deciders: Dave Roberts (PSA)

## Context
A tenant subscribes to agents and tools; a tenant admin may narrow that per user; and an agent should reach only the tools it was built for, whatever the user holds (spec R-2, R-5, R-6). Other platforms cap the agent the same way. Microsoft Entra Agent ID gives each agent its own identity and permissions ([Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/what-is-agent-id)), and Google Cloud's Principal Access Boundary limits what a principal may ever reach regardless of its grants ([principal access boundary policies](https://cloud.google.com/iam/docs/principal-access-boundary-policies)). ADR-0011 defined a backend as compute only, and ADR-0024's registry entry holds `scopes` only (ADR-0025, now superseded by ADR-0030).

## Options considered
### Option 1: The agent inherits everything the user holds
Pros: nothing to declare. Cons: a prompt-injected agent can call any tool the user may call; one agent's tools leak into another's `tools/list`; no product shape a vendor can sell.

### Option 2: An agent definition is `needs[]` plus `tools[]`, intersected at mint
`needs` are the non-tool permissions the agent requires to run (the old `scopes`); `tools` are the tools it may ever use. The agent must be in `tenant.agents ∩ user.agents`, and the grant is `needs ∪ (tools ∩ tenant.tools ∩ user.tools)`. Pros: three sets and one intersection; the agent's cap is code-reviewed with the agent; a user cut or a tenant drop narrows the grant without touching the agent. Cons: a breaking rename on `AgentBackend`; the vendor must list an agent's tools.

### Option 3: A Cedar policy per agent at the Gateway
Pros: the cap is enforced where the tool is called; the policy is auditable. Cons: the Gateway sees only the token, so it still needs a grant to check; the user and tenant layers would have to be in policy too, which is O(tenants).

## Decision
Option 2, computed at the ingress when it mints the transaction token (ADR-0031), so the token's `scope` is the grant. Option 3 is kept as the Gateway's second wall: one Cedar policy per target permits a tool only when `scope` names it (ADR-0034), so a grant the ingress got wrong still has to match the target's policy.

## Consequences
Easier: an agent is one construct with its compute, its needs and its tools; a reviewer sees an agent's maximum reach in one place. Harder: `AgentBackend.scopes` is renamed `needs` (breaking) and `tools` is added; the registry entry gains `needs` and `tools`. An agent with no granted tools still runs with its `needs`, so a tenant can subscribe to an agent before any of its tools. Follow-up: synth checks that each `tools` entry is `<target>/<tool>`; the e2e suite proves a tool outside the agent's `tools` is absent from `tools/list` and refused on `tools/call`. Revisit if agents need tools chosen at run time, or per-call conditions the intersection cannot express.

**Amended 2026-11-04.** From the review of the implemented sample (no new ADR): the granted set is compressed to `<target>/*` only for a target that every contributing set held as `<target>/*` itself, `A.tools`, `T.tools` (the tenant row or its plan) and `U.tools` (no cut names a tool of the target). An explicit list stays explicit even when it covers the whole catalogue today, because `<target>/*` in `scope` admits every tool of the target at the interceptor and in Policy, so a tool added to the catalogue later would otherwise be granted to an agent, tenant or plan that never named it (`compressTools` in `src/shared/grant.ts`; threat model T-99, M-80).

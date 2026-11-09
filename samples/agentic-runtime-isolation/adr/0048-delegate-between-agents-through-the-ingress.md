<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0048: Delegate between agents through the ingress, with a replacement transaction token

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR-0031 (the ingress accepts its own token on one route), ADR-0032 (the grant is computed per hop)
- Deciders: Dave Roberts (PSA)

## Context
An agent of this sample cannot call another agent. Each Runtime's resource policy allows `InvokeAgentRuntime` to the ingress role only (P-1, ADR-0001); the transaction token is bound by `aud` to one agent and its tools gateways (P-14, ADR-0031, ADR-0041); and the ingress refuses its own issuer, so an agent cannot replay its token as a sign-in. Every agent call therefore starts at the client, one agent per request.

Multi-agent applications want agent A to hand part of a job to agent B for the same tenant and user, decided by the model at run time. The question is how to do that without giving up the three guarantees above: the ingress alone picks the isolation unit, the identity token never leaves the ingress, and each hop holds the narrowest token that works. The IETF transaction tokens draft ([draft-ietf-oauth-transaction-tokens-09](https://datatracker.ietf.org/doc/draft-ietf-oauth-transaction-tokens/09/), §7.4) covers this case as a *replacement* token: a trusted service re-issues the token for the next hop and records the chain in `act` (RFC 8693 §4.1, nested `act`).

Facts that bound the options:

- The API Gateway ingress exposes `POST /{backend}/invocations` behind a REQUEST authoriser and an integration Lambda that mints the token and invokes the Runtime (ADR-0024). The `agentcore-gateway` ingress authenticates with `CUSTOM_JWT` on the identity issuer and can read one issuer only.
- The grant for an agent is `A.needs ∪ (A.tools ∩ T.tools ∩ U.tools)` (ADR-0032, ADR-0046), computed from the registry entry, the tenant's subscription row and the user's cut row. It depends on tenant, user and agent, not on which caller asked.
- The tools interceptor requires `act.sub` to be the ingress role (spec §6.2.1) and refuses a token whose `aud` lacks its own gateway.
- The agent may hold vended tenant credentials (`tvm`, ADR-0012), but that module is optional; the transaction token is the one credential every agent has.
- The token is bounded at 10,240 bytes (ADR-0045) and cached per (tenant, user, agent, tenant version) for its life (ADR-0031).

## Options considered
### Option 1: Orchestrate outside the agents
The client, or a workflow in front of the ingress, calls `/invocations` for A and then for B, each with the user's identity token. Pros: no new trust; the sample is unchanged; every hop is a first-class request audited today. Cons: the model cannot decide to delegate; the plan lives outside the agents, which is the opposite of what a multi-agent application asks for.

### Option 2: Direct Runtime to Runtime with the vended tenant credentials
Grant the TVM role `InvokeAgentRuntime` on B's Runtime, with an ABAC condition on `TenantId`. Pros: no ingress change. Cons: A would pick B's session, which moves the isolation-unit choice out of the ingress (breaks P-1); B would receive A's token, whose `aud` names A and A's gateways, so B could reach no tool; the key chain ends at A, so nothing records the hop; and it needs `tvm` to be set. Rejected.

### Option 3: Agent B as a tool on a tools gateway
Register B as a `ToolTarget` (a Lambda) whose tool `agents/<B>` the tenant and user may be granted. The Lambda receives the signed `_ri_ctx` (tenant, user, calling agent) and calls the ingress on B's behalf. Pros: delegation becomes a tool grant, so entitlements, Policy, the interceptor, tenant-admin cuts and metering all apply as they are; the model sees B like any tool. Cons: the Lambda still needs an ingress route that accepts a non-identity proof, so this option needs Option 4 underneath it; the path is four hops (A, gateway, Lambda, ingress, B); the answer is one MCP result, not a stream; and two signers (`ToolContextKey` and the signing key) vouch for one call.

### Option 4: A delegation route on the ingress that re-issues the token for the next hop
The API Gateway ingress adds `POST /{backend}/delegations`, where `{backend}` is the target agent B. The bearer is the caller's transaction token. The ingress verifies it against its own JWKS (same issuer, `typ: txn+jwt`, `aud` contains `agent:<token.agent>`, `act` present, `exp` with the 60 s margin of ADR-0043), computes B's grant for the token's tenant and user exactly as a direct call to B would, mints a replacement token for B with the caller pushed onto `act`, invokes B's Runtime and streams the answer back. Pros: one authority and one signer; the ingress still picks the unit; B holds its own scope, never A's; the chain is in the token; streaming end to end. Cons: the ingress accepts a token it minted, on one route, which ADR-0031 forbade everywhere; a loop (A to B to A) and unbounded depth must be refused; two Runtime sessions are billed per user request; delegated tokens cannot share the per-agent cache.

Two sub-choices inside Option 4:

- **B's scope.** (a) `grant(B)` for the tenant and user, as if the user had called B directly. (b) `grant(B) ∩ scope(A)`. (b) is rejected: A never holds B's tools, so the intersection is usually empty, and `scope` describes what B may do for this tenant and user, which does not change with who asked. The authority to call B at all is a separate check (below).
- **Who may delegate to whom.** (a) Any subscribed agent may call any other subscribed agent. (b) The deployer declares `delegatesTo` on A's registry entry, and the tenant must also hold B. (b) is chosen: delegation is a product decision the vendor makes per agent, and a tenant that bought A but not B must not reach B through A.

## Decision
Option 4, with Option 3 left open as a thin layer on top of it for deployers who want delegation governed as a tool grant.

1. **Route.** `POST /{backend}/delegations` on the `api-gateway` ingress, alongside `/{backend}/invocations`. Same body contract (`prompt`, `conversationId`). The `agentcore-gateway` ingress has no delegation route: its `CUSTOM_JWT` authoriser reads one issuer. A deployment that needs delegation adds the `api-gateway` ingress.
2. **Authentication.** The bearer is a transaction token this ingress minted. The authoriser and the integration function verify it against the ingress's own JWKS: `iss` = self, `typ: txn+jwt`, `agent` claim present and `aud` contains `agent:<agent>`, `act` present with the ingress role as the innermost `act.sub`, `exp - 60 s` in the future. An identity token on this route is 401 `token_invalid`. On `/invocations` the ingress still refuses its own issuer (P-14 unchanged there).
3. **Authority.** Both must hold, else 403: (a) A's registry entry names B in `delegatesTo` (`delegation_not_declared`); (b) the token's tenant holds B, after the user's cuts, by the same `grantFor` path a direct call uses (`agent_not_subscribed`, `tenant_suspended`). Synth checks that every `delegatesTo` name is a registered backend.
4. **Replacement token.** `sub`, `user`, `tenant_id` copied from the caller's token; `agent` = B; `scope` = `grant(B)`; `aud` = `["agent:<B>", "tools-gateway:<gw>", ...]` for B's granted tools; `act` = `{ "sub": "agent:<A>", "act": <the caller's act> }`, so the innermost `act.sub` stays the ingress role and each hop adds one level; `txn` = the caller's `txn`, so both sessions carry one transaction id; `jti`, `iat`, `exp` fresh, lifetime `transactionToken.ttl`. Delegated tokens are minted per call and never cached: the cache key would have to include the parent `txn`, and the chain must be exact.
5. **Depth and loops.** `agentDelegation.maxDepth` on `SharedIngress`, default 1, maximum 3: the number of `agent:` entries allowed in the chain after the hop. A caller whose chain is already at the cap is refused `delegation_depth`. A target already named in the chain, or equal to the caller, is refused `delegation_loop`.
6. **Invoke.** The integration function invokes B's Runtime as for a direct call: session id from the claims and `conversationId` (ADR-0002), the replacement token in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token`, vended credentials when `tvm` is set, response streamed back to A. The agent learns the route from `RI_DELEGATION_URL`, set only when `agentDelegation` is configured.
7. **Verifiers.** The tools interceptor accepts a nested `act` and requires the ingress role at the innermost `act.sub`; the outer entries are logged. Policy and the Gateway authoriser are unchanged: they read `scope`, `tenant_id` and `aud`.
8. **Limits and metering.** A delegation counts against the tenant's per-minute counter like any request (P-10); the ingress log line is `delegation admitted` or `delegation refused` with `from`, `to`, `depth`, `txn` and the reason. KMS `Sign` grows by one per delegation, covered by the existing `Sign` alarm (ADR-0037).

## Consequences
Easier: an agent can hand work to another agent while every guarantee of the sample holds: the ingress still picks the unit, the identity token still stops at the ingress, and B holds exactly the authority the user could have given B directly. The chain is readable from the token. Cost rolls up to one `txn`. Harder: the ingress accepts a token it issued, on one route; the route exists only on the `api-gateway` ingress; a user request can fan out to `maxDepth` more sessions and `Sign` calls; nested `act` adds about 100 bytes per level inside the ADR-0045 bound; the `delegatesTo` list is one more registry field the deployer must keep right. Breaking: none; the feature is off until `agentDelegation` and at least one `delegatesTo` are set. Spec: a new §3.7 (delegation), P-14 narrowed to `/invocations`, C-2 (the demo agent gains a `delegate <agent> <prompt>` prompt), C-15a (nested `act`), §5.1 (new reason codes), §6.2.2 (the `act` claim). Threat model: a delegate route forged by an in-account principal (same control as T-102), a stolen token used to start delegations within its life (bounded by `exp`, `delegatesTo`, `maxDepth`), and a loop or fan-out used to spend the tenant's quota (bounded by the counter and `maxDepth`). Integration test: a direct call to B and a delegated call to B carry the same `scope`; A without `delegatesTo` is `delegation_not_declared`; a tenant without B is `agent_not_subscribed`; depth 2 at `maxDepth` 1 is `delegation_depth`; B delegating back to A is `delegation_loop`; an identity token on the route is 401. Revisit if AgentCore Runtime offers A2A with an inbound authoriser that can name the ingress as issuer, or if the Gateway authoriser can read a second issuer, which would bring the route to the `agentcore-gateway` ingress.

**2026-11-09.** Spec §3.3 narrows the synth check in Decision 3: synth can see only the `AgentBackend`s of its own app, so it checks the shape of `delegatesTo` and the existence of same-app names; a name in another stack is resolved at request time through the registry, and a name with no entry is 404 `not found`, as a direct call to it would be.

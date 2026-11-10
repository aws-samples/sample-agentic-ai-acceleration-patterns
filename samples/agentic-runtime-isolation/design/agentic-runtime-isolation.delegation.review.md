<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Delegation between agents through the ingress (ADR-0048): semantic review

> Review of branch `docs/runtime-isolation-delegation-adr` against `ff57f73`
> (its merge base with `origin/main`), 2026-11-09. Scope: everything under
> `samples/agentic-runtime-isolation/`. Build and scans were green before the
> review (`npx projen build`, 42 suites, 823 tests; ProtoShield, ASH, Holmes
> with nothing in the changed code). No deploy and no integration run were
> part of this review; step 25 has not been executed yet.

ADR-0048 adds a second route to the `api-gateway` ingress, `POST /{backend}/delegations`, whose bearer is a transaction token the ingress itself minted. The authoriser and the integration function verify that token against the ingress's own JWKS, read the caller's and the target's registry entries, run three cheap checks (the caller's `delegatesTo` names the target, the chain after the hop fits `agentDelegation.maxDepth`, the target is neither the caller nor already in the chain), then grant the target exactly as a direct call by the same tenant and user would (`grant(target)`, the caller's `scope` plays no part) and sign a replacement token with the caller nested in `act` and the caller's `txn` copied, bypassing the mint cache. The identity route keeps refusing transaction tokens and the new route refuses identity tokens, so no token is accepted in two roles. The whole feature is off until `agentDelegation` is set and at least one backend declares `delegatesTo`.

Watch for: on a `multiTenant` ingress the authoriser's identity sources include `X-Tenant-Id`, which the delegating agent never sends, so API Gateway answers 401 before the authoriser runs and delegation is dead on that configuration (likely); the integration function's M-82 recheck on the new route verifies the forwarded token for tenant and target only, not for the caller chain or `txn`, so with a hand-written context the function enforces none of the three delegation checks itself (confirmed, low exposure); the check order differs from spec §5.1.1 in that both registry entries are read before `delegatesTo`, depth and loop (confirmed); a backend named `delegations` becomes unreachable with no synth error (confirmed).

**Verdict**: NEEDS_CHANGES (fix first: items 1 and 2; the rest can land with them or follow).

## High-level view

Route and token role are decided together, by path, in `routeFromPath`, before either function touches a bearer. The identity verifier refuses `iss = self` or `typ: txn+jwt` (P-14, unchanged) and the delegation verifier requires both, so no token passes on both routes. The one route-level hole is in front of the code: on a `multiTenant` ingress the shared authoriser lists `X-Tenant-Id` as an identity source, the agent does not send it, and API Gateway refuses before the authoriser runs.

Scope cannot widen across a hop: `delegate` grants the target through the same private `grant` the direct route uses and never reads the caller's `scope`. The replacement token nests `agent:<caller>` over the caller's verified `act`, copies `txn`, and bypasses the mint cache in `mint()` itself, so it cannot be served to a later direct mint. Its `exp` is fresh per hop, so one `txn` can outlive the first token by up to `maxDepth` TTLs.

Depth and loop are arithmetic on the parsed chain and run before any KMS or STS call. What the spec puts after them, the target's registry read, the code runs before them, so an undeclared, unknown target is refused as 404 rather than 403.

The M-82 recheck on the new route is the direct route's recheck unchanged: the integration function verifies the forwarded token for `tenantId` and `agent` only. On this route the token also carries the decision in `act` and `txn`, and neither is compared to the caller the function just verified, so with a hand-written context the function enforces none of `delegatesTo`, depth or loop itself.

The TVM receives only `tenant_id` and `sub`; `claimTags` is refused at synth and fails closed at runtime. The demo agent relays the target's SSE as JSON-stringified `delegated` chunks, so a target stream cannot break the caller's framing. Neither the `multiTenant` interaction nor the reserved route word `delegations` as a backend name is covered by tests or by step 25.

<details>
<summary>Issues (9)</summary>

1. **Delegation dead on a multi-tenant ingress** (likely, medium) — `src/shared-ingress.cdk.ts:1222` adds `X-Tenant-Id` to the authoriser's identity sources when `multiTenant` is set; with the 60 s result cache on, API Gateway returns 401 for a request missing any identity source without invoking the authoriser. `delegateTo` (`src/agent/app.ts:389`) sends `Authorization` only, and spec §5.1.1 (line 1204) says the header "is not read". Either send `X-Tenant-Id: <token tenant_id>` from the agent and have the authoriser ignore it on this route, or give the delegation route its own `RequestAuthorizer` without the header. Add a `multiTenant + agentDelegation` synth test and an integ case.
2. **M-82 recheck ignores `act` and `txn` on the delegation route** (confirmed, low) — `src/shared/request.ts:401-405` accepts any ingress-minted token for `(tenant, target)`, including one minted for a direct call. Return `act` and `txn` from `forwardedTokenVerifierFor` and require `act.sub === agent:<caller.agent>`, `act.act` deep-equal to `caller.act`, and `txn === caller.txn`; or re-run `delegate()`'s three checks on `callerEntry` before accepting the context.
3. **Check order diverges from spec §5.1.1** (confirmed, low) — `src/ingress/api-gateway-authorizer.function.ts:131-141` and `src/shared/request.ts:327-328` read both registry entries before `delegatesTo`, depth and loop; the spec (line 1227) puts the target's entry after them. Move depth and loop ahead of any registry read (they need only the token), and read the target's entry after `delegatesTo`; or amend the spec and accept that an undeclared target leaks existence as 404 vs 403.
4. **Backend named `delegations` becomes unreachable** (confirmed, low) — `src/shared/registry.ts:305` now refuses the route word as a backend name, but `AgentBackend` (`src/agent-backend.cdk.ts:121`) accepts it (as it already accepted `invocations`). Fail synth for both route words.
5. **`maxDepth` "default 1" in ADR and threat model, no default in code** (confirmed, low) — ADR-0048 Decision 5 (line 50) and T-108 (`threat-model.md:192`) say default 1; `AgentDelegationProps.maxDepth` is required and §3.3 says unset means no route. Align the ADR and T-108 with the code.
6. **Replacement tokens are shared through the API Gateway authoriser cache** (confirmed, informational) — the minter signs every delegation, but the Allow (with the token) is cached for `authorizerCacheTtlSeconds` (60 s by default) per `(Authorization, path)`, so two delegations by the same caller token to the same target within that window carry one replacement token. The chain is still exact. Soften "never cached" and "Sign grows by exactly one per admitted delegation" in spec §3.7 (line 930), M-86 and T-108; while there, add that one `txn` can live up to `(maxDepth + 1) × ttl` because `exp` is fresh per hop, and that a draining caller is refused.
7. **Verifier falls back to the remote JWKS on any failure** (confirmed, nit) — `src/shared/delegation.ts:84` retries against the remote set on every error, not only `JWKSNoMatchingKey`; an identity token or a forged bearer on this route costs one remote fetch per jose cooldown. Same pattern as `forwardedTokenVerifierFor`; narrow both to the no-matching-key error.
8. **`delegatesTo` "checked" at synth is a warning** (confirmed, nit) — spec §3.3 says synth checks that a same-app name exists; `src/agent-backend.cdk.ts:205-223` emits `Annotations.addWarning`. Say "warns" in the spec or make it an error when the name is in the same stack.
9. **Threat-model status still says "designed, not yet in code"** (confirmed, docs) — `threat-model.md:11,190-192` and M-84 to M-86. Intentional until step 25 is green; flip the status in the same PR that records the run.

</details>

<details>
<summary>Details</summary>

### Route split and the multi-tenant identity source

`routeFromPath` (`src/shared/registry.ts:290-306`) is the single parser for both routes and refuses a name equal to either route word. The authoriser (`src/ingress/api-gateway-authorizer.function.ts:98-102, 173-176`) dispatches on it from `event.path`, not `pathParameters.backend`, before any identity-token code runs; the pipeline (`src/shared/request.ts:258-266`) answers `404 unknown_backend` for a `/delegations` path when `config.delegation` is unset, which closes the one way a direct Lambda invoke could name the route on a deployment without it. The verifiers are disjoint by `iss` and `typ` (`src/shared/verifier.ts:100-105, 161`; `src/shared/delegation.ts:65-110`), and an identity token on the new route fails at the issuer with the same `token_invalid` as a forged one.

The gap is in front of the code (`src/shared-ingress.cdk.ts:1219-1223`). The `RequestAuthorizer` is shared by both routes; on a `multiTenant` ingress its identity sources are `Authorization`, `context.path` and `X-Tenant-Id`. With the result cache enabled (`resultsCacheTtl` is `min(60, ttl - 120)` s, 60 s with the defaults) API Gateway requires every identity source to be present and answers 401 without calling the authoriser when one is missing. `delegateTo` sends only `Authorization` and `content-type`. Nothing in the unit tests or step 25 exercises `multiTenant` together with `agentDelegation`; the multi-tenant integ stack has no `billing` backend. The fix that keeps M-53's cache-key argument intact is to have the agent send `X-Tenant-Id` with the token's `tenant_id` and have `authorizeDelegation` ignore it (the tenant still comes from the verified token); a separate authoriser for the route without the header is the alternative.

### Scope across a hop, and the replacement token

```
caller token A ──verify (self JWKS)──▶ DelegationCaller { tenantId, sub=user, agent=A, chain, act, txn }
                                           │
            callerEntry.delegatesTo ∋ B ───┤  403 delegation_not_declared
            chain.length + 1 ≤ maxDepth ───┤  403 delegation_depth
            B ≠ A, B ∉ chain ──────────────┤  403 delegation_loop
                                           ▼
            grant(tenantId, sub, B, entryB)  ── same private path as resolve()
                                           ▼
            mint { ..., delegation: { from: A, act: A.act, txn: A.txn } }  ── sign(), never store()
                                           ▼
            token B: scope = grant(B), aud = [agent:B, gateways of B],
                     act = { sub: agent:A, act: A.act }, txn = A.txn, fresh jti/iat/exp
```

`AuthorityResolver.delegate` (`src/shared/authority.ts:68-85`) never reads the caller's `scope` or `aud`; `grant` is the renamed body of `resolve`, so a target the tenant does not hold is `agent_not_subscribed` as on a direct call (`test/shared/delegation.test.ts:233`). `TokenMinter.mint` (`src/shared/mint.ts:285-287`) returns `sign()` for a delegation before computing a cache key, and `sign()` never calls `store()`, so the minter cache cannot hold a replacement token under a direct-mint key.

`exp` is fresh per hop (the spec says so), so a chain of distinct agents can keep one `txn` alive for up to `(maxDepth + 1) × ttl` after the user's sign-in, each hop needing a caller token with more than 60 s left. Bounded by `maxDepth ≤ 3` and `delegatesTo`; informational, but worth a sentence in §3.7 so a deployer picking `ttl` knows it.

### Depth and loop, and where the registry reads sit

Depth is `chain.length + 1 > maxDepth` (`src/shared/authority.ts:79`), matching §3.7's "entries a chain may hold after the hop". `agentChainOf` (`src/shared/mint.ts:102-122`) bounds the walk at `MAX_DELEGATION_DEPTH + 1` levels, so a token at depth 3 still parses for the interceptor and is refused as a caller, and a hostile token cannot drive a long walk; a chain whose innermost level is the ingress role with a nested `act` beneath it is refused, as is any outer level that is not an `agent:` entry.

The three checks run before `grant`, so before KMS and STS. What runs before them is the registry read for both the caller's and the target's entries (`src/ingress/api-gateway-authorizer.function.ts:131-141`; `src/shared/request.ts:327-328`), while spec §5.1.1 (line 1227) orders "verify the caller's token, `delegatesTo`, depth, loop, registry entry of the target, per-tenant limit, …". `delegatesTo` needs the caller's entry, so one read before it is unavoidable, but depth and loop need only the token, and the target's entry is only needed once `delegatesTo` passes. The observable difference: an undeclared target with no entry is `404 not found` (authoriser: Deny with no reason, 403 `forbidden`) rather than `403 delegation_not_declared`, so an agent learns which backend names exist regardless of its `delegatesTo`. Low, since the agent is inside the trust boundary, but it is a stated order the code does not follow.

A draining caller is refused as well (its entry resolves to a `RegistryError`); the spec does not say either way. It is the right behaviour and deserves one sentence in §3.7.

### The authoriser-context trust path on the new route (M-82)

The integration function re-verifies the caller's bearer (`src/shared/request.ts:322-326`), so a cached Allow replayed after the caller token's `exp` is 401 there, and a context whose `tenantId` or `backend` disagrees with the token is `tenant_not_allowed`. It then verifies the forwarded replacement token with `forwardedTokenVerifierFor`, which returns only `{ tenantId, agent }` (`src/shared/request.ts:401-405`), and accepts the context.

On the direct route that is complete: the forwarded token's decision-bearing claims are tenant, agent and scope, and scope is the authoriser's to compute. On the delegation route the token also carries the decision in `act` and `txn`, and the function compares neither to the `DelegationCaller` it just verified. Under T-106's premise (an in-account principal with `lambda:InvokeFunction` on the integration function), a context carrying a token minted for a direct call to the target, paired with a real caller token, passes: the function invokes the target with a chain-less token, never checks `delegatesTo`, depth or loop, and logs `delegatedFrom` from the caller token but `txn` from the context. The exposure is small (two real tokens plus the T-102 deployer action, and the target is one the tenant holds), and the fix is a few comparisons: have the forwarded verifier return `act` and `txn`, then require `act.sub === agent:<caller.agent>`, `act.act` equal to `caller.act`, and `txn === caller.txn`. Then the function enforces the delegation invariants for itself, as M-84 says it does ("in the authoriser and again in the integration function").

### Cache behaviour of replacement tokens

The minter never caches a replacement token, but the API Gateway authoriser result cache in front of it does, keyed on `(Authorization, context.path)` for 60 s by default, and the Allow carries the token. A caller agent's own token is itself cache-served by the minter for most of its life, so two user requests to the caller within the window produce the same caller bearer, the same cache key on `/<target>/delegations`, and the same replacement token (same `jti`). The chain is still exact and the reuse is the direct route's, but §3.7 ("Minted per delegation, never cached", line 930), M-86 and T-108 ("Sign grows by exactly one per admitted delegation") overstate it. Say "never cached by the minter; the authoriser cache may reuse one for up to 60 s".

The 60 s `exp` margin and the ≤ 60 s authoriser cache line up: a cached Allow can outlive the caller token by seconds at most, and the integration function's own verification refuses it.

### TVM claims built from the token

`validateDelegation` (`src/shared/request.ts:356-367`) hands the TVM `{ tenantId, sub, clientId: '', scopes: [], claims: { tenant_id, sub } }`; `sessionTags` and `roleSessionName` read nothing else unless `claimTags` is set. `resolveOptions` (`src/shared-ingress.cdk.ts:582`) refuses `agentDelegation` with a non-empty `tvm.claimTags`; if a `claimTags` entry reaches the function anyway (environment edited by hand), `sessionTags` throws `ClaimMissingError` and the request is `403 claim_missing`, fail-closed.

### The agent's relay of the delegated stream

`delegateTo` (`src/agent/app.ts:378-405`) relays each body chunk as `data: {"agent":…,"chunk":…}` under `event: delegated`. The chunk is JSON-stringified, so a target stream (or a hostile target) cannot inject SSE frames into the caller's stream, and the caller still ends with `event: usage`. The transaction token leaves the Runtime only toward the ingress URL the construct set, which P-14 permits (it is not the identity token).

Two small things. `conversationIdOf` (`src/agent/app.ts:207-216`) accepts `[A-Za-z0-9_-]{1,64}` while the ingress's `CONVERSATION_ID_PATTERN` is `[A-Za-z0-9]{16,64}`; the ingress validated the id before forwarding it, so the looser regex has no effect today, but the two should be one constant. `delegateTo` has no timeout or abort; it relies on the API Gateway integration timeout (two minutes) on the inner request and the Runtime's session limit on the outer one. Acceptable for a demo agent, worth a comment.

### Spec and code, remaining mismatches

ADR-0048 Decision 5 and T-108 say `maxDepth` "default 1"; `AgentDelegationProps.maxDepth` is a required `1 | 2 | 3` and §3.3 says unset means no route. The code's reading is the safer one; fix the two documents.

Spec §3.3 says synth "checks … for an `AgentBackend` in the same app, that the name exists". The aspect (`src/agent-backend.cdk.ts:205-223`) emits a warning, not a failure, because it cannot tell a cross-app name from a typo. "Warns" is the accurate verb.

`routeFromPath` now reserves `delegations` as it reserved `invocations`, but `AgentBackend` accepts both as names (`src/agent-backend.cdk.ts:121`). A backend named `delegations` deployed before this change answers 404 after the ingress functions are updated, with nothing at synth to say why. `invocations` had the same gap before; fail synth on both.

The threat-model header and T-106 to T-108 / M-84 to M-86 still read "designed, not yet in code" by design, pending step 25. Flip them with the run record.

### Test coverage

Covered: `agentChainOf` shapes and the depth bound; claims and cache bypass for a delegation; `routeFromPath`; `delegatesTo` shape and legacy entries; every verifier refusal including an identity token by issuer and by `typ`; `delegate()`'s three refusals before any mint and `agent_not_subscribed`; the pipeline minting here, taking a matching context and refusing a mismatched one, 401/404 cases, the module-off 404, and a transaction token on `/invocations`; the interceptor accepting a nested `act`; the authoriser's Allow context and log fields, the three public Deny reasons, and the module-off Deny; the CDK on/off wiring, `delegatesTo` validation and the published document; the agent's probe, relay, refusal events and chain report.

Not tested: `multiTenant` together with `agentDelegation` (the identity-source gap above); a context whose forwarded token is a chain-less direct token for the target (the M-82 gap above); `delegations` as an `AgentBackend` name; the agent's behaviour when the inner stream exceeds the integration timeout. Step 25 covers the end-to-end positive path, the four refusals, the identity-token and route-confusion cases, and the `txn` equality in the logs; it does not run on the multi-tenant stack.

</details>

## Findings

| # | File:line | Severity | Behaviour at risk | Confidence |
|---|---|---|---|---|
| 1 | `src/shared-ingress.cdk.ts:1222`, `src/agent/app.ts:389`, spec §5.1.1 line 1204 | Medium | On a `multiTenant` ingress every delegation is 401 from API Gateway before the authoriser runs; the feature does not work on that configuration (fails closed) | likely |
| 2 | `src/shared/request.ts:401-405` | Low | With a hand-written authoriser context (T-106 premise) the integration function does not enforce `delegatesTo`, depth or loop and may log a `txn` that is not the caller's; M-84's "and again in the integration function" is not fully true | confirmed |
| 3 | `src/ingress/api-gateway-authorizer.function.ts:131-141`, `src/shared/request.ts:327-328`, spec line 1227 | Low | Check order differs from §5.1.1; an undeclared target's existence leaks as 404 vs 403 | confirmed |
| 4 | `src/shared/registry.ts:305`, `src/agent-backend.cdk.ts:121` | Low | A backend named `delegations` (or `invocations`) synthesises but is unreachable | confirmed |
| 5 | `adr/0048…md:50`, `threat-model.md:192` | Low (docs) | `maxDepth` "default 1" vs required prop | confirmed |
| 6 | spec §3.7 line 930, M-86, T-108 | Informational | Replacement tokens are reused through the authoriser cache for up to 60 s; "never cached" and "exactly one Sign per delegation" overstate | confirmed |
| 7 | `src/shared/delegation.ts:84` | Nit | Any verification failure triggers a remote JWKS attempt; narrow to no-matching-key | confirmed |
| 8 | `src/agent-backend.cdk.ts:205-223`, spec §3.3 | Nit (docs) | "checks that the name exists" is a warning | confirmed |
| 9 | `threat-model.md:11,190-192` | Docs | Status "not yet in code" to flip after step 25 | confirmed |

**Verdict: fix first.** Items 1 and 2 before the integration run and the PR; item 1 because a supported configuration (`multiTenant` with `agentDelegation`) is broken and untested, item 2 because it is a few lines that make the integration function's recheck mean what M-84 says. Items 3 to 9 are low and can ride along or follow; none of them weakens P-1, P-14, least privilege per hop, or the no-KMS/STS-on-refusal invariant, all four of which the code upholds.

<details>
<summary>File map</summary>

Full diff: `git diff ff57f73...HEAD -- samples/agentic-runtime-isolation` in the worktree.

- `src/shared/mint.ts`: `ActClaim`, `MAX_DELEGATION_DEPTH`, `agentChainOf`, `DelegationInput` on `MintInput`, nested `act` and copied `txn` in `transactionClaims`, cache bypass in `mint()`.
- `src/shared/registry.ts`: `delegatesTo` on entries (absent reads as empty), `backendDelegatesToProblem`, `DELEGATION_ROUTE`, `routeFromPath`; `backendFromPath` becomes a projection.
- `src/shared/delegation.ts` (new): caller-token verifier against the ingress JWKS, `DelegationCaller`, 60 s margin.
- `src/shared/authority.ts`: `delegate()` with the three checks; `resolve()` and `delegate()` share `grant()`; new refusal reasons.
- `src/shared/request.ts`: route dispatch in `validate()`, `validateDelegation`, `entryFor`, `delegationAuthorityFor`, `delegationVerifierFor`, `PUBLIC_REASONS` extended, `conversationId` on the validated request.
- `src/shared/config.ts`: `RI_DELEGATION_MAX_DEPTH`, `RI_DELEGATION_URL`, `DelegationConfig`, `ingressRoleArn` on a non-minting function.
- `src/ingress/api-gateway-authorizer.function.ts`: `authorizeDelegation`, dispatch before the identity path, `delegatedFrom`/`depth` in the Allow context.
- `src/ingress/api-gateway-ingress.function.ts`: `delegatedFrom`/`depth` in the log line.
- `src/tools/transaction-token.ts`, `src/tools/interceptor.function.ts`: innermost `act.sub` via `agentChainOf`, `chain` reported and logged.
- `src/shared-ingress.cdk.ts`: `agentDelegation` prop and validation (api-gateway only, not with `claimTags`), the route, env on both functions, `delegationUrl` on the construct, the ref and the published document.
- `src/agent-backend.cdk.ts`: `delegatesTo` prop, synth shape check, same-app warning aspect, `RI_DELEGATION_URL`, entry field.
- `src/shared/registry-entry.cdk.ts`, `src/shared/registry-entry.function.ts`: `DelegatesTo` property through the custom resource.
- `src/backend/backend.ts`, `src/backend/agentcore-runtime.transport.ts`: `conversationId` in the Runtime payload; `delegatedFrom`/`depth` on `ValidatedRequest`.
- `src/agent/app.ts`: `delegate <agent> <prompt>` probe, `delegateTo` relay, `conversationIdOf`, `chain` in the report.
- `src/demo.cdk.ts`: `agentDelegation: { maxDepth: 1 }` and `default -> billing` on the api-gateway demo with the billing backend.
- `scripts/integ.sh`: step 25 and helpers.
- `test/`: `shared/delegation.test.ts` (new), authoriser, CDK, agent, registry, transport and helper updates.
- `design/agentic-runtime-isolation.spec.md`: §3.7, §3.3, §5.1.1, §6.2.2, P-14, C-2, C-15a, step 25. `design/agentic-runtime-isolation.delegation.plan.md` (new). `adr/0048-*.md` (new), ADR index, notes on ADR-0031/0032/0036. `threat-model.md`: T-106 to T-108, M-84 to M-86, scan review entry. `README.md`: delegation section. `.ash/.ash.yaml`: suppressions for the ADR-0047 probe fixtures.

</details>

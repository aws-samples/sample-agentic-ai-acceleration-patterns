<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Implementation plan: delegation between agents (ADR-0048, spec §3.7)

Status: done. Every phase landed on `docs/runtime-isolation-delegation-adr`;
phase 6 passed with integration run 18 (2026-11-09, us-east-1, 58 of 58
steps, step 25 SKIP on `agentcore-gateway` by design) after runs 16 (deploy
throttled by the API Gateway control plane at concurrency 6) and 17 (step 25
assertions and the ACCESS_DENIED template, both fixed).

## Scope

A second route on the `api-gateway` ingress, `POST /{backend}/delegations`,
whose bearer is a transaction token this ingress minted. The ingress re-issues
the token for the target agent (`act` nested, `txn` copied, `scope` =
`grant(target)`), invokes the target's Runtime and streams back. Off until
`SharedIngress.agentDelegation` and at least one `AgentBackend.delegatesTo`
are set. Nothing changes for a deployment without them.

Out of scope: the `agentcore-gateway` ingress (its authoriser reads one
issuer; synth fails when `agentDelegation` is set on it), and agent B as a
tool target (ADR-0048 Option 3).

## Decisions the spec leaves to the code

| Question | Answer |
|---|---|
| How the integration function knows the route | API Gateway resource `/{backend}/delegations` with the same authoriser and integration; the pipeline reads `event.path` and dispatches on the last segment (`invocations` or `delegations`) |
| Caller identity for the TVM | `tenant_id` and `user` from the caller's token. `tvm.claimTags` needs identity claims the transaction token does not carry, so `agentDelegation` with a non-empty `tvm.claimTags` fails synth |
| Authoriser cache | unchanged: the key is `Authorization` plus `context.path`, so a caller's token is cached per target route; the cached Allow carries the replacement token, which has a stream's worth of life left (same margin as today) |
| Replacement-token cache | none: `TokenMinter.mint` takes a `delegation` input and signs every time |
| Depth counting | `agentChainOf(act)` returns the agent names in `act` from outer to inner, or undefined when the innermost `sub` is not the ingress role. Depth after the hop = chain length + 1; refused when it exceeds `maxDepth` |
| `delegatesTo` existence at synth | same-app `AgentBackend` names are checked (an aspect over the app); other names at request time (404) |
| Agent discovery of the route | `RI_DELEGATION_URL` = the `api-gateway` base URL; the agent appends `/<agent>/delegations` |

## Phases

### Phase 1: shared core (pure code, unit tests)

| File | Change |
|---|---|
| `src/shared/mint.ts` | `ActClaim` (recursive `{ sub, act? }`); `agentChainOf(act, ingressRoleArn)`; `MintInput.delegation?: { from: string; act: ActClaim; txn: string }`; `transactionClaims` nests `act` and copies `txn` for a delegation; `TokenMinter.mint` skips the cache for a delegation |
| `src/shared/registry.ts` | `RegistryEntry.delegatesTo`; `parseRegistryEntry` accepts an absent field as `[]`; `backendDelegatesToProblem(backend, list)`; `MAX_DELEGATES_TO = 32`; `DELEGATION_ROUTE = 'delegations'`; `routeFromPath(path, defaultBackend)` returning `{ backend, route }`; `backendFromPath` unchanged |
| `src/shared/config.ts` | `ENV.DELEGATION_MAX_DEPTH`; `IngressConfig.delegation?: { maxDepth }`; `AGENT_ENV.DELEGATION_URL` |
| `src/shared/delegation.ts` (new) | `DelegationCaller`; `delegationTokenVerifierFor(issuer, ingressRoleArn, jwks?)`: `typ: txn+jwt`, `iss`, `exp - 60 s`, `aud ∋ agent:<agent>`, innermost `act.sub`; returns tenant, user, agent, chain, `act`, `txn` |
| `src/shared/authority.ts` | `AuthorityResolver.delegate(caller, target, targetEntry, callerEntry, maxDepth)`: `delegation_not_declared`, `delegation_depth`, `delegation_loop`, then the grant for the target and an uncached mint. New `AuthorityError` reasons |
| `src/shared/request.ts` | `PUBLIC_REASONS` + 3; `IngressPipeline.validate` dispatches on the route: for `delegations` it verifies the bearer as a transaction token, resolves caller and target entries, applies the limit, takes the authoriser's token (checked for tenant and target) or delegates locally, chooses the unit, vends; `ValidatedRequest.delegatedFrom?`, `depth?` |
| `src/tools/transaction-token.ts` | innermost `act.sub`; `ToolCaller.chain` |
| Tests | `test/shared/mint.test.ts`, `registry.test.ts`, `authority.test.ts`, `request.test.ts`, `delegation.test.ts` (new), `test/tools/transaction-token.test.ts` |

### Phase 2: ingress functions

| File | Change |
|---|---|
| `src/ingress/api-gateway-authorizer.function.ts` | route dispatch; `deps.delegation` verifier; `authority.delegate`; Allow context gains `delegatedFrom`, `depth`; log `delegation admitted` / `delegation refused` |
| `src/ingress/api-gateway-ingress.function.ts` | passes the path (already); `authorizedContext` reads `delegatedFrom`, `depth`; `request served` carries `delegatedFrom`, `depth` |
| Tests | `test/ingress/api-gateway-authorizer.function.test.ts`, `api-gateway-ingress.function.test.ts` |

### Phase 3: CDK

| File | Change |
|---|---|
| `src/shared-ingress.cdk.ts` | `agentDelegation?: { maxDepth: 1 \| 2 \| 3 }`; validation (api-gateway only, claimTags conflict); env on authoriser and integration; `/{backend}/delegations` resource; `SharedIngressRef.delegationUrl?`; published document field |
| `src/agent-backend.cdk.ts` | `delegatesTo?` prop, `backendDelegatesToProblem`, same-app existence aspect, registry entry, `RI_DELEGATION_URL` |
| `src/shared/registry-entry.function.ts` / `.cdk.ts` | `DelegatesTo` property into the entry |
| Tests | `test/runtime-isolation.cdk.test.ts`, `test/v2.cdk.test.ts`, `test/shared/registry-entry.test.ts` |

### Phase 4: demo agent

| File | Change |
|---|---|
| `src/agent/app.ts` | `delegate <agent> <prompt>`: POST to `RI_DELEGATION_URL/<agent>/delegations` with the transaction token, relay the stream; `NoDelegation` without the URL; `chain` in the report |
| `src/demo.cdk.ts` | `default.delegatesTo: ['billing']`, `agentDelegation: { maxDepth: 1 }` on the `api-gateway` demo |
| Tests | `test/agent/*.test.ts` |

### Phase 5: integration test and docs

| File | Change |
|---|---|
| `test/integ.runtime.ts`, `test/integ/*` | step 25 as spec §8 |
| `README.md` | delegation section under "Use the construct in your own app", props rows, reason codes, hardening checklist line (`delegatesTo` review) |
| `architecture.md`, `diagrams/` | the delegation hop on the request-path diagram |
| `threat-model.md` | T-106 to T-108, M-84 to M-86 from "Designed" to "Mitigated", with the run that proved them |

### Phase 6: gates

`npx projen build` green; ProtoShield and Holmes clean; semantic review of the
diff; integration run with step 25 passing on a non-production account; then
the PR.

## Acceptance

- A direct call to B and a delegated call to B by the same user carry the
  same `scope` (spec §3.7, T-107).
- A transaction token on `/invocations` is still refused; an identity token
  on `/delegations` is refused (T-106).
- `delegation_not_declared`, `delegation_depth`, `delegation_loop` are
  refused before any `Sign` or STS call (T-108).
- A deployment without `agentDelegation` synthesises to the same template as
  before, apart from nothing (snapshot test).

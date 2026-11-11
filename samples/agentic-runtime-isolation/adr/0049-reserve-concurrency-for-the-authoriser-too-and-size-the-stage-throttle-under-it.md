<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0049: Reserve concurrency for the authoriser as well as the integration Lambda, and size the stage throttle under it

- Status: Accepted
- Date: 2026-11-11
- Amends: ADR-0023 (the cold and hot paths), ADR-0029 (the `api-gateway` ingress), ADR-0043 (the authoriser cache)
- Source: the stress test, `design/agentic-runtime-isolation.stress-test.md` §11.1, findings F-1, F-12 and F-16

## Context

The `api-gateway` ingress is two Lambda functions. The REQUEST authoriser verifies the identity token, resolves the agent, runs the grant and mints the transaction token; API Gateway caches its Allow for up to 60 s per `Authorization` header (ADR-0043). The integration Lambda re-verifies, applies the limit, vends credentials and relays the stream; it is held for the whole stream, up to two minutes. Both draw on the account's Lambda concurrency pool, 1,000 by default, shared with the tools interceptors, every tool function and everything else in the account.

The 2026-11-05 scale review added `ingressReservedConcurrency`: reserved concurrency for the integration Lambda, so a burst of long streams cannot starve the rest of the account. The authoriser got nothing, on the reasoning that it is short (tens of milliseconds) and cached (one call per token per minute at most), so its concurrency need is a small fraction of the request rate.

The stress test (2026-11-09 and 2026-11-10) showed that reasoning to be wrong in two ways, and found a third gap next to it.

**The authoriser's peak is not a fraction of the request rate; it is the token-refresh burst.** Access tokens live five minutes. A client that refreshes its token gets a new `Authorization` header, which misses the authoriser cache. When many clients took their tokens at the same moment, they refresh at the same moment, and the authoriser sees one call per live token in one burst, whatever the request rate was a second before. At `large` (1,000 tenants x 4 users, 500 rps) S1 ran clean for ten minutes, then 4,000 refreshes landed in one burst: 520 authoriser throttles, with the authoriser's concurrency peaking at 30 and the integration Lambda's at 338 of its 800 (F-12). The driver's tokens were in lockstep because its setup issued them in one pass; a real population of clients is less aligned, but a deploy, an outage recovery or a shift change aligns it too.

**Reserving for the integration Lambda takes from the authoriser.** Reserved concurrency is subtracted from the account pool. At `large`, `ingressReservedConcurrency: 800` left 194 for the authoriser, the six interceptors and every other function in the account, which is why 30 concurrent authoriser invocations were enough to throttle. At S6 (1,000 rps) the same happened with 577 throttles (F-16). The prop that protects the account from the ingress also exposes the ingress's own front door.

**A throttled authoriser is a bare 500.** API Gateway answers a throttled authoriser with `500 Internal Server Error`, no body the sample controls, no `tenantId` in the access log (the authoriser never ran) and no reason. Every other refusal the ingress makes names the tenant and the reason (429 `tenant_rate_limited`, 502 `tvm_failed`, 403 `tenant_not_allowed`): the operator's dashboards and the 429-attribution check key on them. The 500s from F-1, F-12 and F-16 are the only refusals in the whole test that could not be attributed, 1,116 of them.

**The stage throttle does not catch it.** `stageThrottle` (50 rps, burst 25 by default) is the one control that answers a refusal with a 429 and a reason before any Lambda runs. At `medium` the herd (300 rps against 200 reserved) threw 19 bare 500s because the stage throttle sat at 300 rps, above the point where the integration Lambda ran out (F-1). Nothing in the construct ties the two props together.

## Options considered

### Option 1: Document the sizing rule, change no code
Pros: no behaviour change. Cons: a deployer who sets `ingressReservedConcurrency` by the documented formula (rps x stream seconds) still starves the authoriser, because the formula has no term for it; the stress test did exactly that.

### Option 2: Reserve for the authoriser too, from the same prop
Replace the number with a pair, or derive the authoriser's share from the integration Lambda's. Pros: one prop still; the authoriser can no longer be starved by the sibling it fronts. Cons: the right ratio is not fixed. The authoriser's peak is live tokens / cache TTL (60 s) in a burst, the integration Lambda's is rps x stream seconds; the two have nothing to do with each other. A ratio would be wrong at one end.

### Option 3: Two props, each with its own formula, and a synth check between them and the stage throttle
`ingressReservedConcurrency` stays as it is (the integration Lambda). A new `authorizerReservedConcurrency` reserves for the authoriser, sized to the refresh burst: live tokens / authoriser cache TTL, rounded up, with the live-token count a deployer knows from their identity provider. A synth warning fires when `stageThrottle.rateLimit` is above `ingressReservedConcurrency / 1` (a stream is at least a second, so the integration Lambda cannot admit more than its reserve per second) or above `authorizerReservedConcurrency x 1000 / authoriser p99 ms`; the warning names the bare-500 consequence. Pros: each number has its own meaning and formula; the warning catches the F-1 shape at synth. Cons: a second prop to understand; reserved concurrency for a short function is a blunt tool (it also caps it).

### Option 4: Provisioned concurrency on the authoriser instead of reserved
Pros: warm instances, no cold start in the burst. Cons: provisioned concurrency is billed while idle, and it does not stop the account pool from being eaten by the sibling; it adds to Option 3 rather than replacing it. The tools interceptors already offer it (`interceptorProvisionedConcurrency`), so the shape is familiar; it stays optional.

### Option 5: Move the mint out of the authoriser so a throttle there is cheap
Pros: a smaller authoriser. Cons: ADR-0031 put the mint in the authoriser so that one cached Allow carries one token for the cache window; moving it back costs a KMS `Sign` per request. The throttle problem is not the mint's size; a tiny authoriser throttles just the same when it has no concurrency.

## Decision

Option 3, with Option 4 left as the existing optional knob.

1. `SharedIngressProps.authorizerReservedConcurrency?: number` (api-gateway only, positive integer), set as `reservedConcurrentExecutions` on `AuthorizerFunction`. Documented formula: live access tokens / authoriser cache TTL in seconds (60 by default), rounded up, times 2 for a burst that does not spread. Example: 4,000 live tokens -> 134.
2. `ingressReservedConcurrency` keeps its meaning and formula (rps x average stream seconds).
3. A synth warning, `RuntimeIsolation: stageThrottle above the ingress's concurrency`, when `stageThrottle.rateLimit > ingressReservedConcurrency` (both set), or when `authorizerReservedConcurrency` is set and `stageThrottle.rateLimit > authorizerReservedConcurrency x 20` (an authoriser call is about 50 ms, so one reserved unit admits about 20 calls a second). The text says what happens past the point: API Gateway answers a throttled Lambda with a bare 500, no tenant and no reason, where the stage throttle would have answered 429 with one. The existing warning for an unset `stageThrottle` stays.
4. `architecture.md` Scale limits gets two rows for the two Lambdas, with the measured figures: the authoriser's peak is the refresh burst, not the request rate (4,000 tokens -> 520 throttles at 194 available); the integration Lambda's is rps x stream seconds. The "shared pools" table says that reserving for one function takes from the others in the account.
5. The README's deployment section says: set the three props together, and gives the three formulas in one place.

Not changed: the authoriser cache TTL (ADR-0043), the mint's place (ADR-0031), the stage throttle's defaults. The refresh burst itself is a client-side shape; the construct cannot spread it, and should not pretend to.

## Implementation (2026-11-11)

`authorizerReservedConcurrency` on `SharedIngressProps` (api-gateway only, a positive integer), set on `AuthorizerFunction`. Two synth warnings: `runtime-isolation:authorizer-unreserved` when `ingressReservedConcurrency` is set and this is not; `runtime-isolation:stage-throttle-above-concurrency` when `stageThrottle.rateLimit` is above `ingressReservedConcurrency` or above `authorizerReservedConcurrency x 20`. `architecture.md` Scale limits carries one row per Lambda with the measured figures; the README's scale section gives the three formulas together. The stress tiers set all three (`large`: 800, 34, 1,200 rps, which still warns on the stage throttle: the peak scenario is meant to run past the reserve, and the warning is the point).

## Consequences

Easier: a deployer who follows the README's three formulas gets refusals that name a tenant and a reason at every rate up to the stage throttle, and a synth warning when the three do not fit. The stress test's `large` tier sets all three and its S1 and S6 pass tables lose their bare-500 rows. Harder: one more number to size, and reserved concurrency on the authoriser also caps it, so an undersized value throttles exactly the function it meant to protect (the warning covers the stage-throttle side of that, not the live-token side, which the construct cannot know). Reserving for both functions eats more of the account pool; an account with several ingresses or other heavy functions needs a quota increase sooner. Unchanged: the agentcore-gateway ingress has no authoriser Lambda and no stage throttle, and is not touched.

Revisit if API Gateway REST authorisers gain a way to return a configured status on a throttled Lambda, or if Lambda gains per-function minimum concurrency that does not subtract from the account pool.

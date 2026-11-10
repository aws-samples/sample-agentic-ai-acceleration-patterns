<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0043: Cap the authoriser cache at 60 seconds

- Status: Accepted
- Date: 2026-11-04
- Amends: ADR-0015, ADR-0023
- Amended by: the implementation (2026-11-10)
- Deciders: Dave Roberts (PSA)

## Context
ADR-0023 raised the API Gateway authoriser result cache from 60 s to 300 s. That was safe in v1 because the cached Allow carried only the verified claims, and the integration Lambda re-verified the identity token, including `exp`, before every invoke. In v2 the authoriser is also the mint (ADR-0031): its Allow carries a transaction token, and API Gateway hands the cached context, token included, to every request the cache answers. The token lives `transactionToken.ttl` (300 s by default, 120 s to 900 s), and the mint reuses a cached token only while enough of its life is left for the longest stream the ingress serves (`LONGEST_STREAM`, 120 s). A 300 s authoriser cache in front of a 300 s token would hand an expired token to a request near the end of the cache window, and nothing downstream refreshes it: the agent would present it to the tools gateway and be refused.

The AgentCore Gateway's JWT authoriser also refuses a token with 60 s or less left before `exp` (integration run 7, 2026-11-03: fresh tokens of 60 s and 61 s were 403 `insufficient_scope`, 62 s and longer were served). A token is therefore usable at a tools gateway until `exp - 60 s`.

On a single-tenant `api-gateway` ingress `X-Tenant-Id` is checked by the authoriser but is not a cache identity source: making it one would turn every request without the header into API Gateway's own 401, because a missing identity source refuses before the authoriser runs. So the cached decision for a token and path is reused whatever header the next request sends. On a `multiTenant` ingress the header is required, so it can be an identity source.

## Options considered
### Option 1: Keep 300 s and re-mint in the integration Lambda
Pros: fewest authoriser invocations. Cons: the integration Lambda would need `kms:Sign` and the entitlement read, so two principals mint and the check order of spec §5.1 splits across two functions; a cached Deny still lasts 300 s.

### Option 2: Turn the authoriser cache off
Pros: every request is decided and minted fresh. Cons: one authoriser invocation per request; the mint cache absorbs the KMS call but not the Lambda invocation or the entitlement batch get.

### Option 3: Cap the cache at min(60 s, ttl - longest stream) and widen the reuse margin by the cache TTL
The cache TTL is `min(60, ttl - LONGEST_STREAM)` seconds on `api-gateway` (0 on `agentcore-gateway`, which has no such cache), and the mint reuses a token only while more than `cache TTL + LONGEST_STREAM` seconds of its life are left. With `multiTenant`, `X-Tenant-Id` joins `Authorization` and `context.path` as an identity source. Pros: a token served from the authoriser cache still outlives a whole stream; a cached decision is at most 60 s stale; one authoriser invocation per token, path (and tenant) per minute. Cons: five times the authoriser invocations of ADR-0023 for a chatty client; at the 120 s floor of `ttl` the cache TTL is 0 and every request runs the authoriser.

## Decision
Option 3. On `api-gateway` the authoriser result cache is `min(60 s, transactionToken.ttl - 120 s)`, keyed on `Authorization` and `context.path`, plus `X-Tenant-Id` when `identity.multiTenant` is on. The mint's reuse margin is the cache TTL plus 120 s (180 s at the default 300 s life; 120 s on `agentcore-gateway`). `transactionToken.ttl` is validated at 120 s to 900 s, so the margin always leaves a positive life. On a single-tenant `api-gateway` ingress a cached decision answers the same token on the same path for up to 60 s whatever `X-Tenant-Id` it sends: after a Deny for a foreign header the token's next header-less request is denied too, and after an Allow a foreign header is ignored and the request is served as the token's own tenant. Both outcomes are fail-closed or own-tenant; neither crosses a tenant.

## Consequences
Easier: a cached Allow never carries a token that expires before its stream ends, and a cached Deny lasts at most a minute. Harder: a busy client reaches the authoriser once a minute per token and path instead of once in five; a client that sends a wrong `X-Tenant-Id` on a single-tenant ingress sees its next requests with that token refused for up to 60 s, so the README and spec §5.1 say so and the integration driver uses fresh identity tokens around step 19-tenant_id. A stream that outlives `exp - 60 s` loses its tool calls 60 s before `exp`; the reuse margin (180 s by default) keeps that out of reach for a stream that starts on a cached token. ADR-0023's change 6 and the threat model's M-6 and T-12 figures of 300 s are superseded; the rest of ADR-0023 (warm-up at init, pre-connects, TVM refresh-ahead, the bounded limiter client) stands. Revisit if API Gateway lets an optional header be an identity source, or if the AgentCore Gateway's 60 s refusal margin changes.

**2026-11-10.** Amended by the implementation (no new decision): on a single-tenant `api-gateway` ingress a foreign `X-Tenant-Id` after a cached Allow is not served as the token's own tenant. The integration Lambda re-verifies the token against the header (`src/ingress/api-gateway-ingress.function.ts`, through the tenant selection in `src/shared/tenant.ts`) and refuses it with 403 `tenant_not_allowed`. The outcome stays fail-closed; the cache still answers the authoriser step, not the tenant check.

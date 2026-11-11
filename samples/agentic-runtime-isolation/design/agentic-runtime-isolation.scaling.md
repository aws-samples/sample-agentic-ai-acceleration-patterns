# Agentic runtime isolation: running it at scale

Options and trade-offs for the pools this sample draws on, in the order they
give out, with the figures the stress test measured (design
[stress-test plan](./agentic-runtime-isolation.stress-test.md), results in
[`stress-results/`](./stress-results/)). `architecture.md` lists the limits;
this document is about what to do about them.

- Date: 2026-11-11
- Measured on: the `api-gateway` ingress, three scales, seven scenarios,
  1.9 million requests; the largest: 1,000 to 2,000 active tenants, 100
  agents, 1,000 tools, 500 rps steady, 800 rps cold herd, 1,000 rps peak.

## 1. What scales for free

Nothing in the design grows a policy, a role, a Gateway or a token per tenant
or per user. The test confirmed the parts of that which could be measured:

| Dimension | Measured | Why it is free |
|---|---|---|
| Tenants, 20 to 2,000 active | p90 TTFB 120 to 130 ms at every count | the grant is one `GetItem` on the tenant row; the TVM, the mint and the authoriser cache key on the tenant, not on a count |
| Users | one `(tenant, user, agent)` mint-cache entry each; no other trace | user identity rides in the token |
| Agents, 2 to 100 | one Runtime and one registry entry each; the ingress reads one entry per request, cached | the route names the agent; the registry is a map |
| Tools, 20 to 1,000 | one star permit per target (about 450 bytes); `scope` 72 bytes in the token with every tool granted | tools are catalogue rows and one Cedar permit per target |
| Isolation | 0 cross-tenant reads in 1.9 million requests, every `read <B>` denied by IAM, every `read <A>` served | IAM on vended credentials, not code |

Spend the design effort on the pools below, not on the counts above.

## 2. The pools, in the order they give out

Each pool: what it is, where it gave out in the test, the options, and what
each costs. "Deploy time" means how long the change takes to land; "blast
radius" means what else in the account the change touches.

### 2.1 STS `AssumeRole`: 600 requests a second per account per Region

The TVM at the ingress and the TVM in every tool interceptor each assume a
tenant role per tag set, cached per instance for the credential life (900 s
by default) with a refresh margin. Steady state costs almost nothing (S1 at
500 rps: 0 retries). A cold start costs one call per instance per tag set
that arrives: the herd (S2, 800 rps on cold instances, 1,000 tenants) made
14,349 retries the SDK absorbed and 1,336 it did not; the peak (S6, 1,000
rps) 14,386 and 2,917. Every exhausted retry was a `502 tvm_failed` that
named the tenant, as designed.

| Option | Effect | Cost | Blast radius |
|---|---|---|---|
| Bound the fan-out with `ingressReservedConcurrency` | fewer instances can start at once, so fewer cold TVM caches fill at once | throttles the ingress Lambda above the reserve (see 2.2); the stage throttle must sit under it | the reserve leaves the account pool (2.2) |
| `tvm.includeUserIdTag: false` (the default) | one tag set per tenant, not per (tenant, user): the cache hit rate follows tenants, not users | the vended credential cannot be scoped per user; fine when the data model is per tenant | none |
| Longer `tvm.durationSeconds` (900 to 3,600) | fewer refreshes per instance-hour; steady-state STS rate falls in proportion | a cut tenant's cached credential lives longer (up to the duration); the sample's refusal path is the grant, not the credential, so this is a defence-in-depth loss, not an isolation loss | none |
| An STS quota increase | the only option that raises the ceiling | a Support case, not a Service Quotas console request; days | account-wide; shared with every other STS caller |
| A regional or VPC STS endpoint | the quota is per Region; the global endpoint has its own | the ingress already uses the regional endpoint | none |
| Spread the cold start: deploy agents or ingress versions in waves | the herd is a deploy or a recovery; a canary or a rolling restart turns 800 rps of cold instances into 80 | slower deploys | none |

Recommendation: at 1,000 active tenants and under 500 rps steady, nothing;
the cold herd refuses correctly and recovers in a minute. Above that, the
quota increase and waved deploys together. Do not add a shared credential
cache across instances: it is a credential store, a new boundary, and it
saves about one call per instance per tenant that jitter already spreads.

### 2.2 Lambda concurrency: the account pool, and what reserving does to it

The `api-gateway` ingress is two functions in one account pool (1,000 by
default) with the tools interceptors, the tool functions and everything else
in the account. The integration Lambda is held for the whole stream; its
peak is rps x average stream seconds (measured 338 concurrent at 500 rps of
130 ms probes, 251 at 1,000 rps, 720 for 12 rps of 60 s streams). The
authoriser is short (17 ms warm) but its peak is not a share of the request
rate: every live access token misses its 60 s cache once per refresh, and
clients that took their tokens together refresh together. The burst lands on
a fleet that must grow, so each call pays a cold start (p99 900 ms in the
burst minute): 1,000 misses in a few seconds want about 1,000 concurrent.

What the test did: `ingressReservedConcurrency: 800` left 194 for the
authoriser and the rest of the account; the refresh burst threw 520 bare
500s (F-12), and at 1,000 rps 577 (F-16). Reserving 34 for the authoriser by
the warm-call formula pinned it at 34 and threw 369 (F-17). A throttled
authoriser is a `500` from API Gateway with no tenant and no reason, the only
refusal in the test that could not be attributed.

| Option | Effect | Cost | Blast radius |
|---|---|---|---|
| Both reserves, sized together, stage throttle under them (ADR-0049) | every refusal names a tenant and a reason; synth warns when the three do not fit | the reserves leave the account pool: 800 + 1,000 is more than the default 1,000, so a Lambda concurrency quota increase first (Service Quotas, adjustable, usually same day) | every other function in the account has less |
| Provisioned concurrency on the authoriser | removes the cold start from the burst: 20 ms a call, so a reserve of live tokens / 50 does | billed while idle (per GB-second provisioned); for 1,000 tokens about 20 to 40 provisioned instances | none beyond cost |
| Spread the token refresh client-side | clients that jitter their refresh over the token life turn the burst into a trickle of live tokens / 300 a second | a client change the ingress cannot make; the SDKs most clients use refresh at expiry minus a fixed margin | none |
| A longer authoriser cache | not available: the cache is capped at 60 s because the Allow carries a minted token (ADR-0043) | - | - |
| The `agentcore-gateway` ingress | no authoriser Lambda, no stage throttle, the Gateway holds the connection; the interceptor is the one Lambda | per-tenant metrics and output-token limits are not available there (the interceptor sees the request only); caps at 100 agents | none |

Recommendation: ADR-0049's three props plus the quota increase, and
provisioned concurrency on the authoriser for a deployment whose clients
refresh together (a mobile fleet after a push, a batch system). The Lambda
quota is the cheapest ceiling to raise in this list.

### 2.3 AgentCore Runtime: 25 new sessions a second, 2,500 active, 1,000 TPS

A conversation is a Runtime session, a microVM held until the idle timeout.
The test kept one conversation per tenant (session scope `tenant`), so 1,000
active tenants were 1,000 sessions; the herd reused the warm ones. A herd of
new conversations is a session-creation test: 300 a second against 25 gave
167 `502 backend_failed` at `medium` (F-2), each with the tenant and the
reason. The peak scenario ran at the 1,000 TPS data-plane quota on purpose.

| Option | Effect | Cost | Blast radius |
|---|---|---|---|
| Quota increases (all three are adjustable) | the only way past 2,500 concurrent conversations or 1,000 rps | Service Quotas request; Runtime seconds are billed per active microVM, so 10,000 sessions is 10,000 microVMs of CPU and memory | account-wide |
| Session scope `tenant` (the default) over `user` | sessions follow tenants, not users: 10x fewer microVMs when users share conversations | users of a tenant share conversation state the agent keeps; the agent must read the token on every request (T-23, T-81) | none |
| Fresh session per request (session off) | no idle microVMs between requests | a cold microVM per request, about 1.5 to 3.5 s TTFB (step 1.4 measured 1.6 to 3.7 s cold against 0.12 s warm); 25 a second ceiling becomes the request ceiling | none |
| Shorter idle timeout on the Runtime | microVMs leave sooner, so active sessions stay under the quota | the next request after the timeout pays the cold start | none |
| Waved restarts | a recovery that reopens 1,000 conversations at once hits the 25 a second | slower recovery | none |

Recommendation: session scope `tenant`, the active-sessions quota raised to
the expected concurrent conversations with a margin, and the knowledge that
the first request after a quiet hour is slow.

### 2.4 Cognito and tenant-identity: tokens, groups and writes

The sample trusts tenant-identity's user pool. Three of its limits shaped
the test.

| Limit | Measured | Options |
|---|---|---|
| Groups per user pool, 10,000, not adjustable; tenant-identity holds two per tenant | 5,000 tenants per pool; two killed seeds left 2,822 tenants' groups orphaned (F-11) | one pool per 4,000 tenants; the ingress trusts several issuers through `identity.multiTenant` and the published parameters of each tenant-identity deployment; or a tenant-identity change to one group per tenant |
| Token refresh, tenant-identity's `/token` route at 20 rps (burst 40) | 4,000 live tokens on a 5-minute life need 13 a second and lost 2,338 refreshes to the throttle (F-13) | a longer access-token life on the pool (the ingress's cost is the authoriser cache TTL, which stays 60 s); a higher route throttle on a dedicated identity deployment; fewer live tokens per client |
| Cognito user-write categories, tens a second | `CreateTenant` above about 4 a second returned 500 (F-3, issue #28) | pace onboarding at 4 tenants a second; tenant-identity should answer 503 with `Retry-After` |

Recommendation: the pool is the tenant ceiling. Plan one identity deployment
per 4,000 tenants from the start if the target is 10,000s; the ingress's
issuer list is built for it.

### 2.5 KMS `Sign`: 1,000 RSA requests a second per account

One `Sign` per mint miss (one per live `(tenant, user, agent)` per token life)
and one per admitted `tools/call` (the tool context). The test never
throttled it (0 retries at every scale), because the mint cache hit 20 to
40 % and the tool storm ran at 200 rps.

| Option | Effect | Cost |
|---|---|---|
| `toolContextKey.algorithm: 'ES256'` | tool contexts move to the ECC quota, a separate bucket | the tool side verifies ES256; same code |
| `transactionToken.algorithm: 'ES256'` | the mint moves too | the Runtime and the gateways verify ES256; same code |
| A longer `transactionToken.ttl` (120 to 900 s) | fewer mints per user-hour | revocation lags by the TTL (Known limitations) |
| A quota increase | adjustable | account-wide |

Recommendation: ES256 for the tool context first; it is the call that scales
1:1 with tool traffic.

### 2.6 The tools path: latency, not throughput

A tool call is ingress, Runtime, MCP `tools/call`, the REQUEST interceptor
(verify the token, the Cedar policy, the tool's own TVM), the tool function,
and back. At 200 rps across 1,000 tenants the p90 was 2.8 s against 125 ms
for a `report` probe (F-4), with no pool throttled.

| Option | Effect | Cost |
|---|---|---|
| `interceptorProvisionedConcurrency` (default 1) | the interceptor's cold start leaves the path | billed while idle, per gateway |
| Measure the split first: the interceptor's `tool admitted` line carries its own duration; the Runtime's trace carries the MCP round trip | find the slow hop before tuning | none |
| Fewer gateways per agent | an agent lists only the gateways in its `aud`; a tool call still goes to one gateway | - |
| Tool TVM cache | the interceptor caches vended credentials per tag set like the ingress; its hit rate follows how many tenants one instance serves | none; already in place |

Recommendation: measure the split before spending on provisioned
concurrency; the test did not.

### 2.7 Cedar schema: about 290 tools per policy engine

The policy engine's schema holds every tool of every target on its gateway;
400 KB is the bound, and 300 tools of a one-line description and a
one-property schema were 413 KB (F-9). `maxToolsPerGateway` fails synth
above its value.

| Option | Effect | Cost |
|---|---|---|
| Gateways by tool domain (`toolsGateways`) | each gateway its own engine, rate bucket and interceptor | one more MCP client per agent that uses it, 10 rps more tool rate limit per tenant per gateway |
| Shorter tool descriptions and schemas | more tools per engine | less for the model to read |
| `maxToolsPerGateway: 250` | synth fails before the deploy does | none |

Recommendation: four gateways for 1,000 tools, by domain; set
`maxToolsPerGateway` to 250.

### 2.8 Per-tenant limits and the stage throttle

The per-tenant limit is a fixed one-minute window in DynamoDB (up to 2x the
limit across a boundary), checked before any cost is incurred; it never
throttled (0 `ThrottledRequests` at 1,000 rps) and attributed every 429 to
the right tenant in every scenario. The stage throttle is one bucket for
every tenant and every refusal.

| Option | Effect | Cost |
|---|---|---|
| `stageThrottle.rateLimit` >= tenants x `requestsPerMinute` / 60, and under both Lambda reserves (ADR-0049) | the stage refuses with 429 and a reason before a Lambda throttles with a bare 500 | - |
| A WAF rate rule per tenant in front | an edge limit per tenant, before API Gateway counts the request | WAF per-request and per-rule cost; the tenant must be visible at the edge (a header or a path) |
| `tenantLimits.outputTokensPerMinute` | caps model spend per tenant, not only requests | `api-gateway` only |

### 2.9 Observability cost

Per-tenant CloudWatch metrics are off by default (ADR-0021): 9 metrics x
(1 + agents) per tenant per ingress is about 180,000 metrics at 10,000
tenants on one agent. The ingress log carries the same figures with the
`tenantId`; Contributor Insights (top 500 per rule, billed per rule and
matched event) and Logs Insights replace the dashboards at scale. The test
read every per-tenant figure from the log group.

## 3. By target scale

What to set and request before deploying, from the test's figures.

| Target | Tenants active | Steady rps | Set | Request | Expect |
|---|---|---|---|---|---|
| Pilot | 100 | 10 | defaults; `stageThrottle` 100 | nothing | p90 130 ms; no pool near its edge |
| Business | 1,000 | 100 to 300 | `stageThrottle` 300, `ingressReservedConcurrency` 200 (at 1 s streams), `authorizerReservedConcurrency` = live tokens, four tools gateways, `interceptorProvisionedConcurrency` 2 | Lambda concurrency to 1,500 | p90 130 ms; a cold herd throttles STS for a minute and refuses with the tenant named |
| Platform | 5,000 to 10,000 | 500 to 1,000 | the above at the larger figures; session scope `tenant`; ES256 tool contexts; a WAF rate rule per tenant; waved deploys | Lambda concurrency 2,500 to 5,000; STS to 1,500 (Support case); Runtime active sessions to the concurrent conversations, data plane past 1,000 TPS; one tenant-identity deployment per 4,000 tenants | the STS and Runtime quotas, not the sample, set the ceiling |

## 4. What the test did not show

- Behaviour past 1,000 rps (the Runtime data-plane quota).
- More than 4,000 tenants (one identity pool) or several issuers at once.
- Repeatability: one run per scale so far; the plan is a `large` run a month
  on the same tenants.
- The tools path split (2.6): measured end to end, not per hop.
- Provisioned concurrency on the authoriser (2.2): reasoned from the
  cold-start figure, not run.

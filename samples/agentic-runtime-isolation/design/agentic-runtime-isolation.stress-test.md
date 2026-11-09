# Agentic runtime isolation: stress-test plan

- Status: Proposed
- Date: 2026-11-09
- Target: the `api-gateway` ingress of this sample at the scale named in
  `architecture.md` (Scale limits) and the spec §3.6

## 1. Purpose

The sample claims two things at scale. Neither is proven by the integration
run (`scripts/integ.sh`, one tenant at a time) or by the latency harness
(`scripts/perf.sh`, one tenant, 10 parallel requests from one shell).

| Claim | Where it is made | What must be shown |
|---|---|---|
| Counts: 10,000s of tenants, 100,000s of users, 100s of agents, 1,000s of tools | `architecture.md` Scale limits, spec §3.6, P-16 | nothing grows per tenant or per user; the grant, the token and the catalogue stay inside their documented bounds |
| Rates: the shared pools hold under load | `architecture.md` Scale limits (second table) | isolation never slips under concurrency; refusals land on the right tenant; no hidden throttle |

Isolation under load is the test that matters. A tenant-scoped credential
that is right at 1 rps and wrong at 500 rps is a leak, not a slow path.

## 2. Out of scope

- The `agentcore-gateway` ingress (its 100-target cap is documented, not a
  load question).
- Model quality or model throughput; Amazon Bedrock quotas are per account
  per model and are not this sample's design.
- Soak tests over days. One run is 30 to 60 minutes.
- A load driver inside the sample's deployed stacks. The driver is a test
  asset, not part of the construct.

## 3. Test environment

| Item | Value |
|---|---|
| Account, Region | a non-production test account, `eu-central-1` |
| Identity | the long-lived `TenantIdentity-shared-pool` deployment the integration runs reuse; tenants created for a run are deleted at its end, the pool itself is never touched |
| Stack | `RuntimeIsolation-api-gateway` deployed from `main` with the stress props of §3.1, `publishParameters=false`, stack name suffixed `-stress` |
| Driver host | one EC2 instance, `c6i.2xlarge`, private subnet, no inbound rule, no public IP, reached through SSM Session Manager; k6 and the AWS CLI v2 installed by user data |
| Driver | [k6](https://k6.io/) for the ingress path (bearer token, SSE); bash and the AWS CLI for seeding and teardown, reusing `scripts/lib.sh` |
| Results | k6 JSON summary plus `scripts/stress/collect.sh` output, kept outside the repo with the run date |

### 3.1 Stress props

The defaults are sized for a demo. The test stack raises the shared pools
so the ingress, not its throttle, is what is measured.

| Prop | Default | Stress value | Why |
|---|---|---|---|
| `stageThrottle` | 50 rps, burst 25 | 1,200 rps, burst 600 | above the top scenario rate; the per-tenant limit must be what refuses |
| `tenantLimits.requestsPerMinute` | 60 | 60 | unchanged: the noisy-neighbour scenario needs a real limit |
| `ingressReservedConcurrency` | unset | 800 | leaves 200 of the account's 1,000 for everything else in the account |
| `transactionToken.ttl` | 120 s | 120 s | unchanged: the mint rate is a measured output |
| `perTenantMetrics` | off | off | 1,000 tenants would be 9,000+ custom metrics (ADR-0021) |
| `toolsGateways` | `default` | `default`, `finance`, `hr`, `ops` | 1,000 tools need four engines at `maxToolsPerGateway` 300 |

## 4. Scale targets and pass criteria

| Dimension | Target | Source |
|---|---|---|
| Tenants seeded | 10,000 | spec §3.6 "10,000s" lower bound |
| Tenants active in traffic | 1,000 | bounded by the Runtime's 2,500 active session workloads and its 25 new sessions a second (measured in the test account, 2026-11-09) |
| Users | 1 per tenant seeded, 10 per active tenant | user count does not touch the design (P-16); 10 is enough to exercise the `(tenant, user, agent)` mint key |
| Agents | 100 | one Runtime each (quota 1,000 agents per account, measured 2026-11-09); registry entries in SSM |
| Tools | 1,000 across 10 `ToolTarget`s and four gateways | 100 tools per target |
| Steady rate | 500 rps | ten times the default stage throttle |
| Peak rate | 1,000 rps for 60 s | at the Runtime data-plane quota |

Pass criteria, every scenario:

| Check | Pass |
|---|---|
| Cross-tenant mismatch (§6) | 0, with the positive control passing |
| 5xx from the ingress | 0, excluding documented 502 `grant_too_large` where provoked |
| 429 attribution | every 429 carries a `tenantId` that is over its limit in that minute; tenants under their limit see none |
| STS `AssumeRole` throttles (CloudTrail) | 0 at steady state; counted and reported for the herd |
| KMS `Sign` throttles (CloudTrail) | 0 |
| Lambda `Throttles` | 0 |
| DynamoDB `ThrottledRequests` (entitlement store, `TenantLimits`) | 0 |
| p90 TTFB, `report` probe, warm | within 1.5x of the single-tenant `perf.sh` figure of the same day |
| p90 TTFB flat | the 1,000-tenant steady run and a 100-tenant run differ by under 20 % |

Deploy and destroy time are results, not footnotes.
Every phase reports them.

## 5. Phases

### Phase 1: count scale (no traffic, about one hour)

Proves the first claim with a seed script and single requests.

| Step | Action | Measure | Pass |
|---|---|---|---|
| 1.1 | Deploy the stress stack with 100 `AgentBackend`s and 10 `ToolTarget`s | deploy time; `SecondsToActive` per policy (ADR-0040) | deploy under 45 min; one star permit per target, about 450 bytes each |
| 1.2 | Seed 10,000 tenants (`CreateTenant`, `app/use`, one admin user) at 20 rps | wall time; Cognito and platform API status histogram | 0 non-201 after retry |
| 1.3 | Subscribe each tenant: `PutTenantSubscription` with `agents: ["default"]`, `tools: ["crm/*"]`; 1,000 of them with all 100 agents and `<target>/*` for all 10 targets | wall time; 4xx | 0 4xx; the 1,000 wide rows are under 40 KB each (spec §3.6) |
| 1.4 | 1,000 `report` probes, one per tenant, at 20 a second, after the subscription writes | grant time from the authoriser log; p90 TTFB | p90 TTFB within 20 % of a 100-tenant sample: the grant is a `GetItem`, flat in tenant count |
| 1.5 | One tenant with all 1,000 tools: `report`, then `tools/list` on each gateway | `scope` bytes after compression; encoded token bytes; pages | under 6,144 and 10,240 bytes, or a 502 `grant_too_large` and nothing else; about 30 tools a page |
| 1.6 | Provoke `grant_too_large`: widen the token with `tvm.includeUserIdTag` and 1,000 named tools until it tips | the status | 502 `grant_too_large`, never a 500 or a truncated token |
| 1.7 | Cold registry read of all 100 agents in one second (restart the ingress by a config change, then 100 parallel probes, one per agent) | SSM `GetParameter` throttles; `registry_unavailable` count | documented behaviour: a throttled read is cached as `registry_unavailable` for one `registryTtl` on that instance; report how many |
| 1.8 | Destroy the stack | destroy time | clean, no `DELETE_FAILED` |

Cognito user writes are the slow part. The pool's user write categories are
tens of requests per second; 10,000 tenants with one user each is about ten
minutes to seed and ten to delete at 20 rps. Seed once, keep the tenants for
Phase 2, delete at the very end.

### Phase 2: rate scale (k6, about 40 minutes of traffic)

The driver holds one access token per (tenant, user). Shared-pool access
tokens live 5 minutes, so the driver refreshes each one at 4 minutes with
its refresh token (RFC 8693 exchange through tenant-identity, as
`scripts/lib.sh` `narrow` does), outside the timed request. 10,000 tokens on
a 4-minute cycle is about 42 refreshes a second, inside Cognito's
`UserAuthentication` category. Tokens are never written to disk or to the
k6 summary.

| Scenario | Shape | What it stresses | Watch |
|---|---|---|---|
| S1 steady | 1,000 tenants, 10 users each, 500 rps, `report` probe, one warm conversation per VU (warmed at 20 new conversations a second, about 7 min, untimed), 10 min | the authoriser cache, the grant, the mint cache, the TVM cache | p50/p90 TTFB, 5xx, mint hit rate (`mint` on `request served`) |
| S2 thundering herd | fresh deploy (no warm instance), then 0 to 800 rps in 5 s, 1,000 tenants, 2 min | cold-start fan-out: new instances × tenants each on STS; SSM cold reads; KMS `Sign` on first mint | STS throttles, Lambda cold starts, `registry_unavailable`, TTFB max |
| S3 noisy neighbour | S1 plus one tenant at 600 rpm (10x its limit) for 5 min | the per-tenant limit as the fairness control; the stage throttle behind it | that tenant: 429 after 60 requests in each minute, 2x at a minute boundary at most (ADR-0020); every other tenant: 0 429, p90 unchanged against S1 |
| S4 tool storm | 200 rps of `tool crm/get_account {}` across 1,000 tenants, 5 min | KMS `Sign` one per admitted `tools/call`; the gateway's 10 rps per tenant; the REQUEST interceptor's TVM | KMS throttles, gateway 429 per tenant, interceptor duration |
| S5 long streams | `stream 60` at 12 rps across 500 tenants, 5 min | Lambda concurrency held for the whole stream (12 × 60 = 720 of the 800 reserved) | `ConcurrentExecutions`, `Throttles` as it approaches 800, stream breaks (`stream interrupted`) |
| S6 peak | S1 shape at 1,000 rps for 60 s | the Runtime data plane at its quota | 5xx, Runtime throttles, TTFB |
| S7 cache eviction | S1 shape with 10,000 tenants, 1 user each, 300 rps, 5 min | more than 1,000 tag sets per instance: the TVM and mint caches evict (ADR-0022) | STS and KMS call rate rising to one per request; TTFB p90 |

S5 uses the model-free `stream <N>` probe. No scenario calls the model at
rate; model spend across the run is a handful of `perf.sh`-style
one-word prompts for the day's baseline.

### Phase 3: isolation under load (runs inside every Phase 2 scenario)

Every k6 request is also an isolation assertion. Section 6 defines it.

## 6. Isolation assertions

Each VU holds a token for tenant A and knows a second tenant B from the seed
list. Each request is one of three probes, chosen per iteration:

| Probe | Share | Expect | What a failure means |
|---|---|---|---|
| `report` | 70 % | `tokenTenant` equals A; `tokenUser` is the VU's user; `unitId` and `sessionPrefix` are A's; `transactionToken` and `credentials` true; `callerArn` names A's tenant role session | the wrong token, grant, unit or credential reached the Runtime |
| `read <A>` | 20 % | `read.result` is `ok` with A's row (positive control) | the vended credential is not usable: a deny-all role would pass the next line and still be broken |
| `read <B>` | 10 % | `read.result` is `error` and `read.error` names `AccessDeniedException`; never B's row | the vended credential is not scoped to A |

The positive control runs before the deny check counts: a scenario whose
`read <A>` success rate is under 99.9 % does not pass on its `read <B>`
denials.

The driver records every mismatch with the request id, the A and B tenant
ids, the probe and the status, and nothing from the token. One mismatch
fails the run.

The 429 attribution check reads the ingress log group after the run:
`request refused` lines with status 429 grouped by `tenantId` and
`epochMinute`, joined against the driver's per-tenant send counts.

## 7. Observability during a run

| Source | Fields | Use |
|---|---|---|
| k6 summary | `http_req_duration` p50/p90/max, `http_req_failed`, custom counters `isolation_mismatch`, `positive_control_fail`, per-status counts, per-tenant 429 | the pass table |
| Ingress log group, `request served` | `totalMs`, `ttfbMs`, `backendInvokeSeconds`, `mint` hit or miss, `tenantId` | server-side latency split; mint cache rate |
| Ingress log group, Lambda `REPORT` | init duration, duration, memory | cold-start count in S2 |
| CloudWatch, API Gateway | `Count`, `4XXError`, `5XXError`, `Latency`, `IntegrationLatency` | shape of each scenario |
| CloudWatch, Lambda | `ConcurrentExecutions`, `Throttles`, `Duration` for the authoriser and the integration Lambda | S5 and S6 |
| CloudWatch, DynamoDB | `ThrottledRequests` on the entitlement store and `TenantLimits` | the limiter's `UpdateItem` under S3 |
| CloudWatch, AgentCore Runtime | active sessions, throttles, invocation latency | S6 and the 2,500-session ceiling |
| CloudTrail | `AssumeRole` and `Sign` events with `errorCode: ThrottlingException`, `Decrypt` for the tool context | STS and KMS have no throttle metric |
| Contributor Insights, the demo rules | top tenants by requests, by 429, by backend seconds | the S3 tenant must be the top contributor by 429 and by nothing else |

`scripts/stress/collect.sh` pulls all of these for the run window into one
JSON file and prints the pass table.

## 8. Driver layout

```
scripts/stress/
  README.md          how to run, in the order below; expected durations
  deploy.sh          cdk deploy of the stress stack with the §3.1 props; prints deploy time
  seed.sh            Phase 1 steps 1.2 and 1.3; writes tenant ids and usernames to a local manifest (no tokens)
  count.sh           Phase 1 steps 1.4 to 1.7
  host.sh            launches and terminates the EC2 driver host; copies k6/ and the manifest over SSM
  k6/
    lib.js           token refresh, probe builder, isolation assertions, per-tenant counters
    s1-steady.js ... s7-eviction.js
  collect.sh         Section 7 for a run window; prints the pass table
  teardown.sh        deletes the seeded tenants at 20 rps, then the stack; prints destroy time
```

The scripts follow `scripts/CONVENTIONS.md`: statuses and timings on stdout,
never a token, a credential or a header value; `set -euo pipefail`; cleanup
on failure. `seed.sh` and `teardown.sh` reuse `scripts/lib.sh`.

## 9. Quotas the run itself can trip

Checked before the run.

| Quota | Account-wide | How the plan stays inside it |
|---|---|---|
| Lambda concurrency, 1,000 | shared with every other stack in the account | reserved 800; S5 sized at 720; no other integ run during the window |
| STS `AssumeRole`, 600 rps | shared with every TVM in the account | S2 is the one scenario expected to approach it; its throttle count is a result |
| KMS RSA `Sign`, 1,000 rps | shared with every RSA key | S4 at 200 rps plus mints well under; S7 is the one that climbs |
| Cognito `UserAuthentication`, about 120 rps | shared pool | refresh cycle sized at 42 rps |
| Cognito user write categories, tens of rps | shared pool | seed and teardown at 20 rps |
| AgentCore Runtime active session workloads, 2,500 | account | 1,000 active tenants × 1 warm conversation, S5 500; never a new conversation per request at rate |
| AgentCore Runtime new session creation, 25 a second | account | every warm-up (S1: 10,000 conversations, about 7 min) and step 1.4 run at 20 new conversations a second; S2's herd reuses the conversations the Runtime already holds |
| AgentCore Runtime data plane, 1,000 TPS | account | S6 is at the quota on purpose, for 60 s |
| SSM `PutParameter`, 3 TPS | account | the stress stack publishes nothing |
| API Gateway control plane | account, low TPS | one deploy at a time; no parallel runs |

## 10. Cost and risk

- Compute: one `c6i.2xlarge` for about two hours; the ingress Lambda at 500
  rps for 30 minutes (about 900,000 invocations); AgentCore Runtime seconds
  for the same; no model calls at rate. Estimate before the run from the
  current price list; expect tens of dollars, not hundreds. Reported next to
  the results.
- The test account is shared. Announce the window to its other users first;
  an integ run of another sample during S5 or S6 fails on Lambda concurrency.
- The seeded tenants live in the shared identity pool for the run. Teardown
  deletes them; a run that dies leaves them, and `teardown.sh` is idempotent
  from the manifest.
- The driver host has no inbound path and is terminated by `host.sh` at the
  end. Tokens live only in k6 memory.

## 11. Deliverables

1. `scripts/stress/` as in §8, with its README.
2. One results file per run, kept outside the repo, with deploy time,
   destroy time, the pass table and the k6 summary.
3. `architecture.md` Scale limits: each row that the run measured gets its
   measured value next to the documented one, with the run date.
4. An ADR if a run changes a default (for example the stage throttle
   warning, the cache sizes or `registryTtl`).

## 12. Options considered for the driver

| Option | Deploy time | Destroy time | For | Against |
|---|---|---|---|---|
| k6 on one EC2 host (chosen) | about 3 min | about 1 min | one process holds 10,000 tokens and the refresh cycle; SSE supported; JSON summary; no listening socket | one host caps at about 1,000 to 2,000 rps for SSE; enough for the targets |
| Lambda fan-out (Step Functions distributed map) | about 2 min | about 1 min | scales past 10,000 rps | token refresh and per-tenant counters are spread over thousands of invocations; the driver's own Lambda concurrency competes with the ingress's in the same account |
| Extend `scripts/perf.sh` | none | none | already there | bash subshells and curl fork per request; one tenant; no assertion counters; stops well under 100 rps |
| Distributed k6 on ECS | about 10 min | about 3 min | scales horizontally | more to build than the targets need |

## 13. Open questions

1. Does tenant-identity's platform API accept 20 `CreateTenant` a second, or
   does it hold its own stage throttle? Check `samples/tenant-identity`
   before `seed.sh` is written.
2. The S2 herd needs an instance-free ingress. A config change to the
   integration Lambda forces new instances; confirm it also empties the
   authoriser cache, or run S2 right after `deploy.sh`.

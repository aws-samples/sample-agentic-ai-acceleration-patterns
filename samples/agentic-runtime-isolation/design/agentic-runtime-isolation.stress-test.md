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
| Stack | `RuntimeIsolation-api-gateway` deployed from `main` with the stress props of §3.1, `publishParameters=false`, `--context tvm=true` (the demo table and the vended-credential path), stack name suffixed `-stress` |
| Driver host | the `StressDriver` CDK stack (§8.1): one EC2 instance, `c6i.2xlarge`, isolated subnet, no inbound rule, no public IP, reached through SSM Session Manager; k6 and the AWS CLI v2 installed by user data |
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
| 5xx from the ingress | 0, excluding documented 502 `grant_too_large` where provoked and the 503s of S6 that carry a tenant and a throttle reason |
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
| 1.3 | Subscribe each tenant: `PutTenantSubscription` with `agents: ["default"]`, `tools: ["crm/*"]`; 1,000 of them with all 100 agents and `<target>/*` for all 10 targets. Write one demo-table row per tenant, `PK = TENANT#<tenantId>` with a label, by `BatchWriteItem` (25 a batch), as `scripts/demo.sh` does one at a time; the `read <A>` positive control of §6 needs it | wall time; 4xx; unprocessed items | 0 4xx; 0 unprocessed after retry; the 1,000 wide rows are under 40 KB each (spec §3.6) |
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
| S6 peak | S1 shape at 1,000 rps for 60 s | the Runtime data plane at its quota (1,000 rps, no margin): throttles are expected | every Runtime throttle surfaces as a 429 or 503 that names the right tenant, none as a 500; the throttle count; TTFB of the admitted requests |
| S7 cache eviction | 2,000 tenants, 1 user each, 300 rps, 5 min; each VU walks its tenants in turn, one request per tenant per pass, so at most 2,000 session workloads live at once (warm-up 100 s at 20 a second) | more than 1,000 tag sets per instance: the TVM and mint caches evict (ADR-0022) | STS and KMS call rate rising to one per request; TTFB p90 |

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
| Ingress and interceptor log groups, `sdk retried` (§7.1) | `service` (`sts`, `kms`), `operation`, `attempts`, `error` when every attempt failed | retried throttles and timeouts on STS and KMS |
| Ingress log group, Lambda `REPORT` | init duration, duration, memory | cold-start count in S2 |
| CloudWatch, API Gateway | `Count`, `4XXError`, `5XXError`, `Latency`, `IntegrationLatency` | shape of each scenario |
| CloudWatch, Lambda | `ConcurrentExecutions`, `Throttles`, `Duration` for the authoriser and the integration Lambda | S5 and S6 |
| CloudWatch, DynamoDB | `ThrottledRequests` on the entitlement store and `TenantLimits` | the limiter's `UpdateItem` under S3 |
| CloudWatch, AgentCore Runtime | active sessions, throttles, invocation latency | S6 and the 2,500-session ceiling |
| CloudTrail | `AssumeRole` and `Sign` events with `errorCode: ThrottlingException`, `Decrypt` for the tool context; management events, free, 5 to 15 minutes late | the cross-check of the `sdk retried` lines; STS and KMS have no throttle metric |
| Contributor Insights, the demo rules | top tenants by requests, by 429, by backend seconds | the S3 tenant must be the top contributor by 429 and by nothing else |

`scripts/stress/collect.sh` pulls all of these for the run window into one
JSON file and prints the pass table.

### 7.1 Retried throttles: the `sdk retried` line

The STS client (`src/shared/tvm.ts`) and the KMS client (`src/shared/jws.ts`)
use the SDK's default retry, three attempts. Before 2026-11-09 a throttle the
retry absorbed was logged nowhere; only a throttle that beat all three
attempts surfaced, as a 502 `tvm_failed` or `mint_failed` with the reason and
no error name. A run at 590 STS calls a second looked clean in the log while
every third call retried.

Now every `AssumeRole` and `Sign` call reads `$metadata.attempts` from its
response or its error (`logRetries` in `src/shared/logger.ts`) and, when it
is above 1, writes one WARN line `sdk retried` with `service`, `operation`,
`attempts` and, when every attempt failed, the error's name. Nothing from the
request or the response. The line is written where the call is made, so the
tools interceptor's TVM and context signer emit it too. It is a separate line
rather than a field on `request served` because the signer behind the mint
is a plain `DigestSigner` function shared with the tools context and the
tests; a throttle is account-wide, not a per-tenant fact, so per-request
attribution adds nothing.

`collect.sh` sums `attempts - 1` per service per minute; the §4 pass lines
for STS and KMS read that sum, CloudTrail is the cross-check.

## 8. Driver layout

```
scripts/stress/
  README.md          how to run, in the order below; expected durations
  deploy.sh          cdk deploy of the stress stack (§3.1 props) and the StressDriver stack; prints both deploy times
  seed.sh            Phase 1 steps 1.2 and 1.3; writes tenant ids and usernames to a local manifest (no tokens)
  count.sh           Phase 1 steps 1.4 to 1.7
  run.sh             copies k6/ and the manifest to the driver over SSM, starts one scenario, streams its summary back
  k6/
    lib.js           token refresh, probe builder, isolation assertions, per-tenant counters
    s1-steady.js ... s7-eviction.js
  collect.sh         Section 7 for a run window; prints the pass table
  teardown.sh        deletes the seeded tenants at 20 rps, then both stacks; prints both destroy times
test/stress/
  stress-driver.cdk.ts   the StressDriver stack (§8.1)
  stress-driver.cdk.test.ts
```

The scripts follow `scripts/CONVENTIONS.md`: statuses and timings on stdout,
never a token, a credential or a header value; `set -euo pipefail`; cleanup
on failure. `seed.sh` and `teardown.sh` reuse `scripts/lib.sh`.

### 8.1 The StressDriver stack

The driver host is infrastructure, so it is a CDK stack, not a
`run-instances` call in bash. It lives under `test/`, beside the integ
driver, because it is a test asset and no part of the construct.

| Resource | Setting | Why |
|---|---|---|
| VPC | one AZ, one public subnet holding one NAT gateway, one private subnet holding the host; no public IP on the host | every call (the ingress, the Entitlements API, the platform API, STS, SSM, S3) leaves through the NAT gateway to the public AWS endpoints, as a tenant's client would |
| Endpoints | `s3` gateway endpoint only (free); no interface endpoints, in particular no `execute-api` one | an `execute-api` interface endpoint turns on private DNS for every `*.execute-api` name in the VPC and reaches only APIs whose resource policy admits that endpoint; the stress stack's API is a regional endpoint and would need a policy change for the test alone |
| Instance | `c6i.2xlarge`, Amazon Linux 2023, IMDSv2 required, 30 GB gp3, no key pair, no public IP | one process holds 10,000 tokens and 1,000 rps of SSE |
| Security group | no inbound rule; outbound 443 only | nothing listens |
| Instance role | `AmazonSSMManagedInstanceCore`; `execute-api:Invoke` on the stress stack's Entitlements API and tenant-identity's platform API; `s3:PutObject` on the results prefix | least privilege; the identity tokens come from the platform API, not from IAM |
| User data | installs k6 from its RPM, the AWS CLI v2 and `jq`; creates `/opt/stress` | no interactive step |
| Results bucket | one bucket, SSE-S3, block public access, 30-day expiry, `autoDeleteObjects` | the k6 summaries leave the host before it is destroyed |
| Outputs | instance id, bucket name | `run.sh` and `collect.sh` read them; nothing in SSM Parameter Store (the 3 TPS rule) |
| Context | `--context stressDriver=true` | the stack is in the app only when asked for; `cdk synth` of the sample is unchanged |

cdk-nag runs on it as on every stack in the sample; the one expected
suppression is the missing flow log (cost, a test VPC).

Deploy and destroy time of this stack are reported with the run (expected:
the NAT gateway dominates, about 3 minutes up and 2 down). The NAT gateway
costs about $0.05 an hour plus $0.05 a GB; a run moves a few GB.

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
| NAT gateway, 55,000 concurrent connections per destination, 45 Gbps | the driver stack's own | S5 holds 720 streams at once, S6 about 1,000 short ones; k6 reuses connections |

## 10. Cost and risk

### 10.1 Cost lines

Priced from the public price list before the run, written into the results
file next to the measured usage. Quantities below are the plan's; the run
reports the actual ones.

| Line | Quantity in one full run | Where it comes from |
|---|---|---|
| AgentCore Runtime session-seconds (CPU and memory) | about 1,000 warm microVMs across the 40-minute Phase 2 window, plus 2,000 for S7; 12,000 session starts | the largest line: every active tenant holds a microVM for the whole window, idle time included until the Runtime's idle timeout |
| AgentCore Runtime invocations | about 1.4 million | S1 300k, S2 96k, S3 150k, S4 60k, S5 3.6k, S6 60k, S7 90k, warm-ups and Phase 1 |
| Lambda GB-seconds | authoriser about 1.4 million short invocations; integration Lambda the same count, held for each stream (S5: 720 × 300 s) | the second line; `ingressReservedConcurrency` caps it at 800 |
| API Gateway REST requests | about 1.4 million | one per ingress call, refusals included |
| KMS `Sign` | about 70,000 | one per mint miss (120 s TTL per active triple) and one per admitted `tools/call` in S4 (60,000) |
| STS `AssumeRole` | about 20,000 | one per TVM miss; S2 and S7 dominate |
| DynamoDB on-demand | about 3 million reads and writes | the grant's `GetItem`, the limiter's `UpdateItem`, the seed's `BatchWriteItem` |
| Cognito | 10,000 monthly active users (§10.2) | one token per seeded user |
| NAT gateway | about 2 hours and a few GB | the driver's egress |
| EC2 `c6i.2xlarge` | about 2 hours | the driver host |
| CloudWatch Logs ingestion | about 1.5 GB | one `request served` line per request plus the authoriser's |
| Amazon Bedrock | a handful of one-word prompts | the day's baseline only; no model call at rate |

Expect the Runtime line to be the largest and Lambda the second; the rest
are single-digit dollars each. Say the total in the results, not here.

### 10.2 Risks

- Cognito bills by monthly active user, and every seeded user is active once
  its token is issued: 10,000 MAUs per run in the shared pool. One run a
  month stays inside the pool's free tier for Essentials (10,000); a second
  run in the same calendar month, or a run on a pool that already has active
  users, is billed per MAU. Check the pool's MAU count for the month before
  seeding; a run with 10,000 tenants and a run with 2,000 (S7's count) in
  the same month need separate approval.
- The test account is shared. Announce the window to its other users first;
  an integ run of another sample during S5 or S6 fails on Lambda concurrency.
- The seeded tenants live in the shared identity pool for the run. Teardown
  deletes them; a run that dies leaves them, and `teardown.sh` is idempotent
  from the manifest.
- The driver host has no inbound path and goes with its stack in
  `teardown.sh`. Tokens live only in k6 memory; the results bucket holds
  k6 summaries, never a token.
- The Runtime holds a microVM per active conversation until its idle timeout
  after the last request. `teardown.sh` runs after that timeout, or the
  stack delete waits on the Runtime; the window between the last scenario
  and the teardown is paid Runtime time.

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
| k6 on one EC2 host, as a CDK stack (chosen) | about 3 min | about 2 min | one process holds 10,000 tokens and the refresh cycle; SSE supported; JSON summary; no listening socket | one host caps at about 1,000 to 2,000 rps for SSE; enough for the targets |
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

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
| Results | the pass table as `design/stress-results/<date>.md` in the repo (§11); the raw k6 JSON and log exports outside it |

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
| Users | 1 per tenant seeded, 4 per active tenant | user count does not touch the design (P-16); 4 is enough to exercise the `(tenant, user, agent)` mint key, and 4,000 live tokens is what the identity `/token` route can refresh (§13, question 1) |
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
| 1.2 | Seed 10,000 tenants (`CreateTenant`, `app/use`, one admin user) at 8 rps, under the platform API's 10 rps stage throttle (about 21 min) | wall time; Cognito and platform API status histogram | 0 non-201 after retry |
| 1.3 | Subscribe each tenant: `PutTenantSubscription` with `agents: ["default"]`, `tools: ["crm/*"]`; 1,000 of them with all 100 agents and `<target>/*` for all 10 targets. Write one demo-table row per tenant, `PK = TENANT#<tenantId>` with a label, by `BatchWriteItem` (25 a batch), as `scripts/demo.sh` does one at a time; the `read <A>` positive control of §6 needs it | wall time; 4xx; unprocessed items | 0 4xx; 0 unprocessed after retry; the 1,000 wide rows are under 40 KB each (spec §3.6) |
| 1.4 | 1,000 `report` probes, one per tenant, at 20 a second, after the subscription writes | grant time from the authoriser log; p90 TTFB | p90 TTFB within 20 % of a 100-tenant sample: the grant is a `GetItem`, flat in tenant count |
| 1.5 | One tenant with all 1,000 tools: `report`, then `tools/list` on each gateway | `scope` bytes after compression; encoded token bytes; pages | under 6,144 and 10,240 bytes, or a 502 `grant_too_large` and nothing else; about 30 tools a page |
| 1.6 | Provoke `grant_too_large`: widen the token with `tvm.includeUserIdTag` and 1,000 named tools until it tips | the status | 502 `grant_too_large`, never a 500 or a truncated token |
| 1.7 | Cold registry read of all 100 agents in one second (restart the ingress by a config change, then 100 parallel probes, one per agent) | SSM `GetParameter` throttles; `registry_unavailable` count | documented behaviour: a throttled read is cached as `registry_unavailable` for one `registryTtl` on that instance; report how many |
| 1.8 | Destroy the stack | destroy time | clean, no `DELETE_FAILED` |

The platform API's stage throttle (10 rps, burst 20, tenant-identity N-5)
is the slow part, not Cognito: 10,000 tenants with one user each is about
21 minutes to seed and 21 to delete at 8 rps, and the 6,000 first tokens
(`IssueToken`, the same route family) another 13 minutes. Seed once, keep
the tenants for Phase 2, delete at the very end.

### Phase 2: rate scale (k6, about 40 minutes of traffic)

The driver holds one access token per (tenant, user). Shared-pool access
tokens live 5 minutes, so the driver refreshes each one at 4 minutes with
its refresh token (RFC 8693 exchange through tenant-identity's `/token`
route, as `scripts/lib.sh` `narrow` does), outside the timed request. That
route is throttled at 20 rps, burst 40 (tenant-identity N-6), so at most
4,000 tokens can be live at once (17 refreshes a second on a 4-minute cycle,
§13 question 1); the shapes below stay under that. Tokens are never written
to disk or to the k6 summary.

| Scenario | Shape | What it stresses | Watch |
|---|---|---|---|
| S1 steady | 1,000 tenants, 4 users each, 500 rps, `report` probe, one warm conversation per VU (warmed at 20 new conversations a second, about 3.5 min, untimed), 10 min | the authoriser cache, the grant, the mint cache, the TVM cache | p50/p90 TTFB, 5xx, mint hit rate (`mint` on `request served`) |
| S2 thundering herd | an instance-free ingress (the §13 question 2 recipe: new Lambda instances, the authoriser cache flushed, 60 s idle), then 0 to 800 rps in 5 s, 1,000 tenants, 2 min, on the warm conversations of the last S1 run (F-2) | cold-start fan-out: new instances × tenants each on STS; SSM cold reads; KMS `Sign` on first mint | STS throttles, Lambda cold starts, `registry_unavailable`, TTFB max |
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
  cost.sh            the next day: Cost Explorer cost by service, run day against a baseline day (§10.1)
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

### 8.2 Scale tiers and reuse

The same scripts run at three scales. A run is validated at `small` before
`medium`, and at `medium` before `large`; a failure at a smaller scale is
fixed and rerun there first. `STRESS_SCALE` selects the tier; `small` is
the default.

| | `small` | `medium` | `large` |
|---|---|---|---|
| Agents | 2 (`default` and `a001`, both in the ingress stack) | 10 (`default` plus `a001`..`a009` in one agents stack) | 100 (`default` plus `a001`..`a099` in five agents stacks of 20) |
| Tool targets | 2 x 10 tools (`t01`, `t02`) | 4 x 100 tools (`t01`..`t04`) | 10 x 100 tools (`t01`..`t10`) |
| Tools gateways | `default`, `finance` | `default`, `finance`, `hr`, `ops` | the same four |
| Tenants seeded | 20 | 200 | 4,000 (one pool holds 5,000, F-11) |
| Tenants active | 20 | 200 | 1,000 (S7: 2,000) |
| Users per active tenant | 2 | 2 | 4 |
| Steady rate (S1) | 10 rps | 100 rps | 500 rps |
| Peak rate (S6) | 40 rps | 300 rps | 1,000 rps |
| Scenario length | 1 min | 3 min | the §5 figures |
| `stageThrottle` | 100 / 50 | 300 / 150 | 1,200 / 600 |
| `ingressReservedConcurrency` | 50 | 200 | 800 |
| Driver instance | `t3.large` | `c6i.xlarge` | `c6i.2xlarge` |

Seeded tenants and their users are reused across runs, because Cognito
bills per monthly active user and a month of runs must fit the pool's free
tier: `seed.sh` keeps a manifest outside the repo
(`~/.runtime-isolation-stress/<prefix>/manifest.json`: tenant ids, user
names, the scale; never a token or a password), reuses the tenants it lists
when they still exist, and creates only what is missing. `teardown.sh`
keeps the tenants unless `--tenants` is passed. Each tenant is created once
and its users authenticate many times: one MAU per user per month, however
many runs.

### 8.3 Implementation contract

The pieces are built in parallel against this contract. Names are exact.

**Stacks** (`test/stress.runtime.ts`, the CDK app; stack classes in
`test/stress/`). Prefix `RuntimeIsolationStress`, overridable with
`STRESS_PREFIX`, same pattern as `INTEG_PREFIX`.

| Stack | Class, file | Holds |
|---|---|---|
| `<prefix>-ingress` | `StressIngressStack`, `test/stress/stress-ingress.cdk.ts` | the identity lookup as `RuntimeIsolationDemoStack` does it (tenant-identity's published parameters, or placeholders with `identityParameterPlaceholders`); a demo table and a tenant role as the demo stack's `tvm` branch; `SharedIngress` with `ingress: 'api-gateway'`, `session: { scope: 'tenant' }`, `tvm: { role }`, `tenantLimits` default, `stageThrottle` and `ingressReservedConcurrency` from the tier, `toolsGateways` from the tier (`finance` with `responseFilter: true`), `publish: true`, `registryPrefix: '/application-plane/shared/agent-runtime/<stackName>/'` (a stack-scoped prefix, so the account-wide one stays free; the agents stacks read this prefix); `AgentBackend` `default` with `needs: ['default/chat']` and `tools: ['<target>/*']` for every target; one `ToolTarget` per tier target, `kind: 'lambda'`, one `NodejsFunction` per target over the stress tool (below), `tvm: { role: <tool tenant role> }` on `t01` only, the targets spread over the gateways round-robin; for `small` also `AgentBackend` `a001`. Outputs: `EndpointUrl`, `EntitlementsApiUrl`, `EntitlementsTableName`, `DemoTableName`, `Issuer`, `RegistryPrefix`, `RestApiId`, `StageName`, `IngressLogGroupName`, `AuthorizerFunctionName`, `IngressFunctionName`, `ToolsGatewayUrl<Name>` and `PolicyEngineId<Name>` per gateway, `PolicySecondsToActive<Target>` per target, `InterceptorFunctionNames` (comma-separated) |
| `<prefix>-agents-<k>` | `StressAgentsStack`, `test/stress/stress-agents.cdk.ts` | `SharedIngress.fromParameters(this, 'Ingress', registryPrefix, 'api-gateway')`; `AgentBackend` `a<NNN>` for its slice, `needs: ['a<NNN>/chat']`, `tools: ['t01/*']`, `owner: 'RuntimeIsolationStress'`. Needs `env: { account, region }`. Exists for `medium` (k = 1) and `large` (k = 1..5). Deployed after the ingress stack, because the lookup reads the published document |
| `<prefix>-driver` | `StressDriverStack`, `test/stress/stress-driver.cdk.ts` | §8.1. Outputs `InstanceId`, `ResultsBucketName`. The instance role holds `execute-api:Invoke` on `arn:aws:execute-api:<region>:<account>:*/*/*/*` (the Entitlements API and the platform API have ids the stack does not know), `ssm:GetParameter` on `/application-plane/shared/identity/*` and on the stress registry prefix, `s3:GetObject`/`PutObject`/`ListBucket` on the results bucket; no other grant |

The stress tool (`test/stress/stress-tool.function.ts`): `toolHandler` over
an implementation that returns `{ tool: context.tool, tenantId:
context.tenantId, callerArn }` where `callerArn` is `GetCallerIdentity` with
the vended credentials when they are present, else `null`. The tool list of
a target is generated: `tool_001`..`tool_NNN`, each with a one-line
description and `inputSchema: { type: 'object', properties: { id: { type:
'string' } } }`.

`test/stress.runtime.ts` reads `STRESS_SCALE`, builds the tier (exported as
`STRESS_TIERS` and `tierOf(scale)` from `test/stress/tiers.ts`), and
creates the stacks; `STRESS_DRIVER=false` leaves the driver stack out;
`STRESS_AGENTS=false` leaves the agents stacks out (the first deploy, before
the published document exists). Unit tests in `test/stress/*.cdk.test.ts`
synthesise each stack with placeholders at `small` and assert the resource
counts stay under 450 and the outputs exist.

**Scripts** (`scripts/stress/`, bash, `scripts/CONVENTIONS.md`, sourcing
`scripts/lib.sh`). Every script takes `AWS_REGION` and reads
`STRESS_SCALE` and `STRESS_PREFIX` with the defaults above. The CDK app is
`npx ts-node -P tsconfig.json --prefer-ts-exts test/stress.runtime.ts`
synthesised into `cdk.stress.out/` (gitignored), as `integ.sh` does.

| Script | Does | Prints |
|---|---|---|
| `deploy.sh` | checks the shared identity deployment exists (as `integ.sh`, never deploys or destroys it); synth and deploy `<prefix>-ingress` with `STRESS_AGENTS=false STRESS_DRIVER=false`; then synth again and deploy the agents stacks (concurrency 1) and the driver stack | one line per stack: name, deploy seconds; the `PolicySecondsToActive*` outputs |
| `seed.sh` | §8.2 reuse; `CreateTenant` with `app/use` at 8 rps for the tier's seeded count, `PutTenantSubscription` on the Entitlements API (`agents: ['default', 'a001', ...]` all agents, `tools: ['<target>/*']` all targets) for the active tenants, `BatchWriteItem` one demo-table row per tenant (`PK`, a `label`, `crmAccount`); `CreateUser` to the tier's users per active tenant; writes the manifest; `--tenants N` overrides the seeded count | counts created and reused, wall seconds, status histogram |
| `count.sh` | Phase 1 steps 1.4 to 1.7 at the tier's size | the step table |
| `run.sh <s1..s7>` | uploads `k6/` and the manifest to `s3://<bucket>/in/`, runs k6 on the host through `ssm send-command` (`AWS-RunShellScript`), waits, downloads `s3://<bucket>/out/<run-id>/summary.json` and the k6 stdout; `s2` first applies the §13 recipe (env marker on the authoriser, the ingress function and every interceptor; `flush-stage-authorizers-cache`; 60 s idle) | the scenario's summary line and the isolation counters |
| `collect.sh <run-id>` | Logs Insights on the ingress log group for the run window (`request served` percentiles, 429 by tenant and minute, `sdk retried` sums by service), CloudWatch metrics (API Gateway, Lambda, DynamoDB), the k6 summary; writes `design/stress-results/<YYYY-MM-DD>-<scale>.md` after a redaction check (`[0-9]{12}`, tenant ids and user names from the manifest, `eyJ`, `https://`) | the pass table |
| `teardown.sh [--tenants]` | destroys driver, agents, ingress stacks in that order (concurrency 1); with `--tenants`, first deletes the manifest's tenants at 8 rps | one line per stack: name, destroy seconds |

**k6** (`scripts/stress/k6/`). `lib.js` exports `setupTokens(manifest,
tier)` (SigV4 `IssueToken` on the platform API with k6's `SignatureV4`,
at 8 rps; a random password per call; tokens live in memory only),
`refreshIfNeeded(entry)` (the `/token` exchange when under 90 s remain, at
most 17 rps), `probe(entry, kind)` for `report`, `read-own`, `read-other`,
`tool` with the §6 assertions, and the counters `isolation_mismatch`,
`positive_control_fail`, `status_<code>`, `tenant_429` (tagged by tenant).
`s1-steady.js`..`s7-eviction.js` read `__ENV.TIER` (JSON) and `__ENV.MANIFEST`
(path), apply the §5 shapes at the tier's rate and length, and write
`summary.json` with `handleSummary`. The pass table is computed in
`collect.sh`, not in k6.

**Order of work.** The three pieces (stacks, scripts, k6) are independent
against this contract; each is built and unit-tested on its own, then
`deploy.sh` at `small` is the first integration.

## 9. Quotas the run itself can trip

Checked before the run.

| Quota | Account-wide | How the plan stays inside it |
|---|---|---|
| Lambda concurrency, 1,000 | shared with every other stack in the account | reserved 800; S5 sized at 720; no other integ run during the window |
| STS `AssumeRole`, 600 rps | shared with every TVM in the account | S2 is the one scenario expected to approach it; its throttle count is a result |
| KMS RSA `Sign`, 1,000 rps | shared with every RSA key | S4 at 200 rps plus mints well under; S7 is the one that climbs |
| tenant-identity platform routes, 10 rps, burst 20 (N-5) | the shared identity deployment | seed, first tokens and teardown at 8 rps |
| tenant-identity `/token` route, 20 rps, burst 40 (N-6) | the shared identity deployment | at most 4,000 live tokens, refreshed at 17 rps |
| Cognito `UserAuthentication`, about 120 rps | shared pool | behind the two throttles above; never reached |
| AgentCore Runtime active session workloads, 2,500 | account | 1,000 active tenants × 1 warm conversation, S5 500; never a new conversation per request at rate |
| AgentCore Runtime new session creation, 25 a second | account | every warm-up (S1: 4,000 conversations, about 3.5 min) and step 1.4 run at 20 new conversations a second; S2's herd reuses the conversations the Runtime already holds |
| AgentCore Runtime data plane, 1,000 TPS | account | S6 is at the quota on purpose, for 60 s |
| SSM `PutParameter`, 3 TPS | account | the stress stack publishes nothing |
| API Gateway control plane | account, low TPS | one deploy at a time; no parallel runs |
| NAT gateway, 55,000 concurrent connections per destination, 45 Gbps | the driver stack's own | S5 holds 720 streams at once, S6 about 1,000 short ones; k6 reuses connections |

## 10. Cost and risk

### 10.1 Cost lines

Priced from the public price list before the run. The day after the run,
`scripts/stress/cost.sh` reads the account's unblended cost by service from
Cost Explorer for the run day and for a quiet baseline day and writes the
delta into the results file: that is the run's measured cost. A member
account of an organization cannot activate cost allocation tags, so the
stacks cannot be billed apart from the rest of the account; the baseline
delta stands in. Quantities below are the plan's; the run reports the actual
ones.

| Line | Quantity in one full run | Where it comes from |
|---|---|---|
| AgentCore Runtime session-seconds (CPU and memory) | about 1,000 warm microVMs across the 40-minute Phase 2 window, plus 2,000 for S7; about 7,000 session starts | the largest line: every active tenant holds a microVM for the whole window, idle time included until the Runtime's idle timeout |
| AgentCore Runtime invocations | about 1.4 million | S1 300k, S2 96k, S3 150k, S4 60k, S5 3.6k, S6 60k, S7 90k, warm-ups and Phase 1 |
| Lambda GB-seconds | authoriser about 1.4 million short invocations; integration Lambda the same count, held for each stream (S5: 720 × 300 s) | the second line; `ingressReservedConcurrency` caps it at 800 |
| API Gateway REST requests | about 1.4 million | one per ingress call, refusals included |
| KMS `Sign` | about 70,000 | one per mint miss (120 s TTL per active triple) and one per admitted `tools/call` in S4 (60,000) |
| STS `AssumeRole` | about 20,000 | one per TVM miss; S2 and S7 dominate |
| DynamoDB on-demand | about 3 million reads and writes | the grant's `GetItem`, the limiter's `UpdateItem`, the seed's `BatchWriteItem` |
| Cognito | about 6,000 monthly active users (§10.2) | one token per user that sends traffic: 1,000 × 4 in S1 to S6, 2,000 in S7, 1,000 in step 1.4; the other seeded tenants never authenticate |
| NAT gateway | about 2 hours and a few GB | the driver's egress |
| EC2 `c6i.2xlarge` | about 2 hours | the driver host |
| CloudWatch Logs ingestion | about 1.5 GB | one `request served` line per request plus the authoriser's |
| Amazon Bedrock | a handful of one-word prompts | the day's baseline only; no model call at rate |

Expect the Runtime line to be the largest and Lambda the second; the rest
are single-digit dollars each. Say the total in the results, not here.

### 10.2 Risks

- Cognito bills by monthly active user, and a user is active once its
  token is issued: about 6,000 MAUs per run in the shared pool (§10.1). One
  run a month stays inside the pool's free tier for Essentials (10,000); a
  second run in the same calendar month, or a run on a pool that already has
  active users, is billed per MAU. Check the pool's MAU count for the month
  before seeding.
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
2. One results file per run in the repo,
   `design/stress-results/<YYYY-MM-DD>.md`, written by `collect.sh`: the
   commit tested, the scenario shapes as run, deploy and destroy time of both
   stacks, the §4 pass table with measured values, the `sdk retried` sums
   per service, and, written by `cost.sh` the next day, the run day's cost by
   service against a baseline day (§10.1). No account id,
   no tenant id, no user name, no token, no endpoint URL; `collect.sh`
   refuses to write a file that matches any of those shapes. The raw k6
   JSON and the log exports stay outside the repo.
3. `architecture.md` Scale limits: each row that the run measured gets its
   measured value next to the documented one, with the run date.
4. An ADR if a run changes a default (for example the stage throttle
   warning, the cache sizes or `registryTtl`). ADR-0049 (proposed) records
   F-1, F-12 and F-16: reserved concurrency for the authoriser and the
   stage throttle sized under both Lambdas.

## 11.1 Findings from the runs

Run on 2026-11-09 at `small` and `medium`, and on 2026-11-10 at `large`, all seven scenarios at every scale (results in `design/stress-results/`).
Every scenario passed the isolation assertions at every scale: 0 mismatches
over about 1.9 million requests (1.6 million of them at `large`: 1,000 to 2,000 active tenants, 100 agents, 1,000 tools, 500 rps steady, 800 rps herd, 1,000 rps peak), every `read <B>` denied, every `read <A>`
served. What the runs found beyond that:

| Id | Finding | Where | Consequence |
|---|---|---|---|
| F-1 | A cold herd above `ingressReservedConcurrency` divided by the cold-start seconds throttles the integration Lambda, and API Gateway answers those requests with a 500 that names no tenant and no reason (medium S2: 300 rps in 5 s against 200 reserved; 19 throttles, 19 bare 500s). The stage throttle, which would answer 429 with a reason, sits above that point (300 rps) | the sample's `api-gateway` ingress | `architecture.md` Scale limits: size `stageThrottle.rateLimit` at or under `ingressReservedConcurrency` / p99 cold-start seconds, or accept bare 500s in a herd. Candidate for an ADR |
| F-2 | A herd of new conversations is a Runtime session-creation test, not an ingress test: 300 new sessions a second against the 25 a second quota gave 167 `backend_failed` 502s (with tenant and reason, so the ingress behaved) | AgentCore Runtime quota | S2 reuses the conversations of the last S1 run (`run.sh`); the plan's §5 S2 row says so. A real deployment that restarts with many live conversations sees the same, and sees it correctly as 502 `backend_failed` |
| F-3 | tenant-identity's `CreateTenant` returns 500 `Internal server error` when Cognito answers `TooManyRequestsException` (medium seed at 8 rps: 139 of 180 calls; its platform function logged the exception). A throttle should surface as 429 or 503 with `Retry-After` | the `tenant-identity` sample | an issue on tenant-identity; `seed.sh` creates tenants at 4 a second and retries 5xx |
| F-4 | The tools path is slow under a tool storm: medium S4 (200 tenants, 100 tools a target, 4 gateways) p90 5.4 s against 0.14 s for `report`. The chain is ingress, Runtime, MCP `tools/call`, REQUEST interceptor (verify, policy, tool TVM), the tool Lambda, and back | the tools gateway path | measure the split with the interceptor's log before tuning; `interceptorProvisionedConcurrency` is the first knob |
| F-5 | The limiter bins by request start, the `request served` line by request end: a request that crosses a minute boundary appears in the next bin. Attribution checks over logs must allow for it | `collect.sh` | the under-limit rule skips the window's first and last minute and allows 5 under the limit |
| F-6 | Logs Insights undercounts for about two minutes after a run (117 of 474 refusals when queried at once) | `collect.sh` | wait 150 s after the window before querying |
| F-7 | The k6 host's first-boot `dnf install k6` lost the rpm lock to the image's own update and the GPG key import failed, so k6 was missing | `StressDriver` user data | every install retries until the lock is free; `k6 version` at the end fails the boot loudly |
| F-9 | At 300 tools of the stress shape on one gateway the policy engine's Cedar schema was 413 KB, over its 400 KB bound, and the `ToolTarget` policy failed to create. The construct's `maxToolsPerGateway` default of 300 and the "about 330 tools" in `architecture.md` are both over the real ceiling for tools with a one-line description and a one-property schema | the `ToolsGateway` default and `architecture.md` | lower the default to 250 or make the synth check sum the tool definitions' bytes; the large tier spreads 1,000 tools over five gateways |
| F-10 | An `AgentBackend` whose ingress is in another stack added its own inline policy with the one-model statement to the imported tenant role, 308 bytes per agent; IAM caps a role's inline policies at 10,240 bytes in all, so about 30 cross-stack agents filled the role and the 31st failed to deploy. Fixed: one policy per stack and model, named with the stack (`grantModelFromStack`, `src/agent-backend.cdk.ts`) | the construct | fixed in this branch; the 100-agent tier deploys (five stacks, five policies) |
| F-11 | tenant-identity holds two Cognito groups per tenant (`t-<id>`, `admin-<id>`) and a user pool holds 10,000 groups, a hard quota: one pool caps at 5,000 tenants. Two seeds killed mid-run left 2,822 tenants' groups with no tenant row, which `DeleteTenant` cannot remove (404); they were removed with `DeleteGroup` by hand | the `tenant-identity` sample and `seed.sh` | the large tier seeds 4,000 tenants; `seed.sh` checks the pool's group headroom first and folds the manifest every 50 tenants; the spec's "10,000s of tenants" needs more than one pool (an issuer per pool on the ingress's `multiTenant` list), which the plan should say |
| F-12 | `ingressReservedConcurrency` takes concurrency away from the authoriser. At `large` the integration Lambda held 800 of the account's 1,000; the REQUEST authoriser lived in the 194 left, shared with every other function in the account. S1 at 500 rps ran clean for ten minutes, then the 5-minute token refresh made 4,000 authoriser cache misses in one burst: 520 authoriser throttles, 520 bare 500s (no tenant, no reason), while the authoriser's own concurrency peaked at 30 and the ingress Lambda's at 338 of its 800 | the sample's `api-gateway` ingress | the construct should reserve for the authoriser too (or size the prop as a pair), and `architecture.md` Scale limits should say that the authoriser's peak is the token-refresh burst, about active users / cache TTL, not the request rate. Candidate for an ADR with F-1 |
| F-13 | 4,000 live tokens on a 5-minute access-token life need 13.3 refreshes a second against tenant-identity's `/token` route at 20 rps, burst 40; with the issue traffic on the same family the driver saw 2,338 refresh failures and 1,255 issue failures in S1, and skipped 542,000 iterations for tenants whose token had lapsed. The sustained rate was well under the planned 500 rps for stretches of the run | the stress driver against the shared identity fixture | the large tier needs fewer live tokens (1,000 tenants x 1 user, refresh at 3.3 rps) or a longer access-token life on a dedicated pool; the plan's §5 refresh arithmetic assumed the throttle was the only bound and ignored the burst shape |
| F-14 | k6 at the herd's 1,600 VUs (800 rps x 2) ran the `c6i.2xlarge` out of memory while initialising VUs ("1258/1600 VUs initialized" was its last line); the SSM agent died with it and the host was unreachable until a reboot. Each VU is a JavaScript runtime holding lib.js and the token entries | the stress driver | fewer VUs per rps (`VU_PER_RPS` 0.5 for the herd), the token entries shared through k6's `SharedArray` instead of copied per VU, and a `c6i.4xlarge` or `r6i.2xlarge` for `large`; `run.sh` should fail the run when the SSM ping is lost instead of waiting |
| F-15 | The STS `AssumeRole` ceiling, measured. The herd (S2 large, 800 rps on cold instances, 1,000 tenants) made 14,349 STS retries the SDK absorbed and 1,336 it did not, each a 502 `tvm_failed` with the tenant and the reason; the peak (S6, 1,000 rps) 14,386 and 2,917. Steady state (S1, 500 rps) had none; eviction (S7, 2,000 tenants against the 1,000-entry TVM cache) three. The `sdk retried` line (§7.1) is what made the absorbed ones visible | the sample, the account's 600 rps STS quota | the ingress behaves as designed (refusals name the tenant and the reason); the plan's cold-start fan-out formula holds. The README's scale section should carry the measured figures and name the mitigations already listed (reserved concurrency to bound the fan-out, `tvm.includeUserIdTag` off, a quota increase) |
| F-16 | At 1,000 rps (S6) the authoriser throttled again, 577 times, as F-12 predicted: with 800 reserved for the ingress function the authoriser shares 194 with the account. Bare 500s | the sample | the same fix as F-12 |
| F-17 | The first ADR-0049 formula (live tokens / 60 x 2) undersized the authoriser reserve by a factor of 30: a refresh burst lands on cold instances at about 900 ms a call (p99 of the burst minute), not the warm 20 ms, so 1,000 misses in a few seconds need about 1,000 concurrent. The rerun with the reserve at 34 pinned the authoriser's concurrency at 34 and threw 40 (S1) and 369 (S6) throttles: the reserve had become the cap. Formula and warning amended; `large` now reserves 1,000 for the authoriser, which with the 800 for the integration Lambda exceeds the account's default pool, so the Lambda concurrency quota must be raised to about 2,500 before the tier deploys | the sample (ADR-0049, amended) and the test account's quota | the rerun needs the quota increase first |
| F-8 | An integ run deletes the vendor scopes it registered on the shared identity deployment at its end, so a stress deploy after an integ run finds no `app/use` | shared fixture | `deploy.sh` registers the two vendor scopes when missing and leaves them |

## 12. Options considered for the driver

| Option | Deploy time | Destroy time | For | Against |
|---|---|---|---|---|
| k6 on one EC2 host, as a CDK stack (chosen) | about 3 min | about 2 min | one process holds 10,000 tokens and the refresh cycle; SSE supported; JSON summary; no listening socket | one host caps at about 1,000 to 2,000 rps for SSE; enough for the targets |
| Lambda fan-out (Step Functions distributed map) | about 2 min | about 1 min | scales past 10,000 rps | token refresh and per-tenant counters are spread over thousands of invocations; the driver's own Lambda concurrency competes with the ingress's in the same account |
| Extend `scripts/perf.sh` | none | none | already there | bash subshells and curl fork per request; one tenant; no assertion counters; stops well under 100 rps |
| Distributed k6 on ECS | about 10 min | about 3 min | scales horizontally | more to build than the targets need |

## 13. Questions answered from the code

1. **Does tenant-identity's platform API accept 20 `CreateTenant` a second?**
   No. `src/identity.cdk.ts` throttles the route families per method (N-5
   to N-7): platform routes (`CreateTenant`, `CreateUser`, `IssueToken`,
   `DeleteTenant`) at 10 rps, burst 20; the `/token` exchange at 20 rps,
   burst 40; `/tenant/*` at 50 rps shared and 10 rps per tenant key. The
   shared identity deployment is a fixture other runs use, so its limits
   are not raised for this test. Consequences, applied above: the seed, the
   first tokens and the teardown run at 8 rps (§5 Phase 1, §9); at most
   4,000 tokens are live at once, so S1 has 4 users per tenant, not 10 (§4,
   §5); the refresh cycle is 17 rps (§5 Phase 2). The Cognito app client
   allows `adminUserPassword` only, so there is no shorter path to a token
   than the platform API.
2. **How does S2 get an instance-free ingress?** Two caches, two steps,
   because a Lambda configuration change does not touch API Gateway's
   authoriser cache. The per-instance caches (TVM, mint, registry, JWKS)
   go with the instance: `aws lambda update-function-configuration` with a
   changed environment marker on the authoriser, the integration Lambda and
   each interceptor retires every warm instance. The authoriser result cache
   lives in API Gateway, keyed on `Authorization` and the path, TTL at most
   60 s (ADR-0043): `aws apigateway flush-stage-authorizers-cache` empties
   it at once. `run.sh s2` does both, then waits 60 s with no traffic (so
   nothing re-warms an instance), then fires. Running S2 right after
   `deploy.sh` is the same state with a longer wait; the recipe lets S2
   rerun without a deploy.

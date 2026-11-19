<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0052: Run the stress test as a slice of the platform stress contract

- Status: Accepted
- Date: 2026-11-19
- Amends: the stress-test plan (`design/agentic-runtime-isolation.stress-test.md`, §8)
- Deciders: Dave Roberts (PSA)

## Context
The sample's stress test was a row of scripts an operator ran by hand (`deploy.sh`, `seed.sh`, `run.sh s1`, `collect.sh <run id>`, `teardown.sh`). The platform stress test (`docs/stress-test.spec.md` §3.4, work item W-3) runs every sample through one contract: `scripts/stress/slice.json` and `slice.sh` with six verbs, the `STRESS_*` environment, one result record per scenario, a quota budget, and a runner that deploys, runs and tears down in order. Six choices were not obvious.

1. **Which tier table.** The contract's tiers (`stress/src/tiers.ts`) size a cell (`agentsPerCell`, `toolTargetsPerCell`). This sample's table (`test/stress/tiers.ts`) sizes one ingress that holds the whole load: 100 agents and 1,000 tools at `large`, as its earlier runs measured them.
2. **Which identity.** Stress ADR-0002 gives the platform run its own `tenant-identity` pool. This sample's integration and stress tests have always reused the long-lived `TenantIdentity-shared-pool` deployment.
3. **Where state lives.** The scripts kept their outputs, manifest and timings in `~/.runtime-isolation-stress/<prefix>/`. The contract keeps manifests under `$STRESS_HOME/<prefix>/`.
4. **Who writes the record.** The k6 library (stress ADR-0008) writes each record from `handleSummary` with every 4xx and 5xx the driver saw as `unattributed`. Only the hops' logs say which tenant a refusal belonged to.
5. **What happens to the tenants.** Stress ADR-0004 keeps a fleet only when the tier onboards once (`large`).
6. **Platform mode.** In the platform run the control plane deploys the cells (W-5); this slice has nothing to deploy there yet.

## Options considered
### Option 1: Port the scripts to the contract, keep the sample's tiers and identity
Pros: the 2026-11 runs stay comparable (same agents, tools, reserves); no new identity deployment; the shipped scripts keep their tested behaviour. Cons: at `medium` and `large` the slice stresses one big ingress while the platform run stresses several small cells, so per-cell numbers are not comparable across modes (stress ADR-0003 says as much); the shared pool's 10,000-group cap applies.

### Option 2: Rebuild the slice on the contract's per-cell tiers and the stress identity
Pros: one meaning of a tier everywhere. Cons: loses the comparison with the earlier runs; the stress identity belongs to the `tenant-identity` slice (W-6), which this slice would then depend on in slice mode too.

### Option 3: Keep the manual scripts beside a thin slice
Pros: nothing is removed. Cons: two ways to run the same scenario, one of them copying files through S3 and polling SSM by hand; the second goes stale.

## Decision
Option 1.

- **Tiers and identity.** The slice reads the sample's tier table; the shared figures (tenants, users, rates, scenario length, driver size) still come from `stress/src/tiers.ts`. In slice mode identity is the published `TenantIdentity-shared-pool` deployment: the slice reads its parameters, registers the vendor scopes it needs (`app/use`, `entitlements/admin`), creates and deletes its own tenants, and never deploys, replaces, updates or destroys the stacks. `slice.sh` refuses a prefix that starts with `TenantIdentity`. Stress ADR-0002's own pool is for the platform run.
- **State.** `slice.sh` exports `STRESS_STATE_DIR=$STRESS_HOME/$STRESS_PREFIX/agentic-runtime-isolation/`, and `deploy.sh`, `seed.sh`, `teardown.sh` and `count.sh` use it when set and `~/.runtime-isolation-stress/<prefix>/` otherwise. It holds a folder, not one file, because it holds stack outputs, a manifest and timings.
- **Run.** `slice.sh run S<n>` calls `stress/driver/k6.sh` with the sample's tier JSON as `STRESS_TIER_JSON` (the scenarios read `agents`, `tenantLimitRpm` and the reserves from it) and the seed manifest as an input file. `run.sh`, which uploaded to S3 and polled SSM itself, is deleted. S2's recipe (new Lambda instances, authoriser cache flushed, 60 s idle) moved into `slice.sh`. S2 reuses S1's warm conversations because every scenario of a run shares the run id that names them, so `CONVERSATION_RUN_ID` is not needed.
- **Collect.** For each record it wrote, `collect.sh` reads the window the record names, queries `request refused` lines by tenant and reason on the authoriser and ingress log groups, and sets `refusals` from them (`attribute.jq`): the lines that carry a tenant are `byTenantReason`; what the driver saw beyond them is `unattributed`. It also fills `latency.ingress`, `latency.ingress-ttfb` and the Lambda concurrency in `quotas`, keeps the sample's pass table (still appended to `design/stress-results/`), and exits 1 on a failed row, so an unattributed refusal fails the run (P-7). It leaves `cost` empty: Cost Explorer settles a day later, and `cost.sh` still reads it then.
- **Budget.** Six draws, all on `cell-account-1`, computed from the sample's tier (`test/stress/slice-cli.ts`): Lambda concurrency (both reserves plus the 100 Lambda keeps unreserved), STS `AssumeRole` and KMS RSA `Sign` at the peak rate, Runtime invocations at the peak rate, Runtime new sessions at the warm-up rate, and active sessions (twice the active tenants, capped by the seeded). No new quota id: the API Gateway control plane has no Service Quotas code (stress README, known limitations).
- **Tenants.** Teardown deletes the run's tenants when the tier onboards every run (`small`, `medium`) or on `--fixtures`, and keeps the seeded set at `large`, as W-6 does.
- **Platform mode.** Every verb but `budget` exits 2 with a message when `STRESS_MODE` is `platform`, until W-5 deploys cells and this slice only drives them.

## Consequences
Easier: one command (`stress/run.sh run --tier small --slices agentic-runtime-isolation`) deploys, runs S1 to S7, attributes refusals, tears down and checks for leftovers; the same verbs will run under the platform run once the platform mode exists.

Harder: the slice and the platform run measure different shapes at `medium` and `large` (one ingress against several cells); a refusal that has no log line with a tenant (an API Gateway throttle, a Lambda throttle in S2's herd, a cached authoriser deny) now fails the run as unattributed, where the earlier pass table counted it as expected; `collect.sh` matches refusals to log lines by count, not by correlation id, because the ingress does not log `x-correlation-id` yet (stress ADR-0005, W-8). Each tenant's 429 lines are credited only up to the driver's own 429 count for that tenant (`tenant_429{tenant:<id>}` in the k6 summary), so one tenant's excess lines cannot hide another's unattributed 429; lines with other statuses have no per-tenant driver count and are credited as logged.

Revisit when: the ingress logs the correlation id (join per request, drop the count match); W-5 lets the platform run deploy this sample as a cell (platform mode, the stress identity); or a slice run at `medium` shows the 10,000-group cap of the shared pool in the way.

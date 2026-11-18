<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Platform stress test: the shared contract

The code every sample's stress slice plugs into, so the samples can be
stress-tested alone or together as one agent platform. The design is
[`docs/stress-test.spec.md`](../docs/stress-test.spec.md); the decisions are
in [`adr/`](./adr/README.md). Nothing here is deployed: it is a test asset.

| Part | File | What it holds |
|---|---|---|
| Tiers | [`src/tiers.ts`](./src/tiers.ts) | `small`, `medium`, `large`: accounts, cells, agents, tools, tenants, rates (spec §4.1) and the rules a tier keeps |
| Slice declaration | [`src/slice.ts`](./src/slice.ts) | what `scripts/stress/slice.json` in a sample holds, and the order slices run in (spec §3.4) |
| Quota budget | [`src/budget.ts`](./src/budget.ts) | the account-wide quotas slices draw on, with their Service Quotas codes and defaults (spec §4.4) |
| Result records | [`src/result.ts`](./src/result.ts) | one JSON record per slice per scenario, its checks and the results file (spec §4.3) |
| Runner | [`src/runner.ts`](./src/runner.ts), [`run.sh`](./run.sh) | budget, then `deploy`, `seed`, `run`, `collect` in dependency order, `teardown` in reverse (spec §3.5) |

## A slice

A sample joins with two files in `samples/<name>/scripts/stress/`:

```json
{
  "name": "control-plane",
  "needs": ["tenant-identity"],
  "scenarios": ["PS-1", "PS-5", "placement-race"],
  "quotas": ["codebuild-linux-small", "lambda-concurrency"]
}
```

and `slice.sh <verb> [args]`, where the verb is one of:

| Verb | Does | Prints or writes |
|---|---|---|
| `budget` | its draw on each declared quota at `$STRESS_TIER`, without credentials | stdout: `{"draws": [{"account": "platform" \| "cell-<n>", "quota": "<id>", "amount": <n>}]}` |
| `deploy` | deploys or reuses its stacks; publishes what the next slice needs through its published parameters | - |
| `seed` | creates or reuses its data; never writes a token or a password | manifests in `$STRESS_HOME/$STRESS_PREFIX/` |
| `run <scenario>` | runs one scenario; exits non-zero when a pass criterion fails | `$STRESS_RESULTS/<name>.<scenario>.json` |
| `collect` | reads logs and metrics for the run window | - |
| `teardown [--fixtures]` | removes what it deployed; keeps fixtures unless `--fixtures` | - |

Every verb gets `STRESS_TIER`, `STRESS_RUN_ID`, `STRESS_PREFIX`,
`STRESS_HOME`, `STRESS_MODE` (`slice` or `platform`), `STRESS_RESULTS`,
`STRESS_REPO` and `STRESS_COMMIT`. The runner writes one `lifecycle` record
per slice with its deploy and destroy seconds.

## Run it

```bash
cd stress
./run.sh check
./run.sh plan --tier small --slices tenant-identity,control-plane
AWS_REGION=eu-central-1 ./run.sh run --tier small --slices agentic-runtime-isolation --limits limits.json
./run.sh report ~/.aaa-stress/stress/<run id>/results
./run.sh quotas
```

`--limits` takes `{"platform": {"<quota>": <n>}, "cell-1": {...}}` with the
accounts' real values; a quota without a value uses its default, which is
the service default and often lower than an account holds. `run.sh quotas`
lists the Service Quotas codes to read them from
(`aws service-quotas get-service-quota --service-code <s> --quota-code <c>`).

One run per `STRESS_PREFIX` at a time: the runner holds
`$STRESS_HOME/$STRESS_PREFIX/run.lock` and refuses a second run. The default
home is `~/.aaa-stress`.

## Build

```bash
cd stress
npm ci
npx projen build
```

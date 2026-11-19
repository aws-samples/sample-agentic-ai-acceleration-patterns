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
| `budget` | its draw on each declared quota at `$STRESS_TIER`, without credentials (no `AWS_*` variables, an empty `HOME`, no instance metadata) | stdout: `{"draws": [{"account": "platform" \| "cell-account-<n>", "quota": "<id>", "amount": <n>}]}` |
| `deploy` | deploys or reuses its stacks; publishes what the next slice needs through its published parameters | - |
| `seed` | creates or reuses its data; never writes a token or a password | manifests in `$STRESS_HOME/$STRESS_PREFIX/` |
| `run <scenario>` | runs one scenario; exits non-zero when a pass criterion fails | `$STRESS_RESULTS/<name>.<scenario>.json` |
| `collect` | reads logs and metrics for the run window | may fill in its own records' late fields (`refusals`, `cost`) in `$STRESS_RESULTS` |
| `teardown [--fixtures]` | removes what it deployed; keeps fixtures unless `--fixtures` | - |

Every verb gets `STRESS_TIER`, `STRESS_TIER_JSON` (the whole tier, as
`run.sh tier <name>` prints it), `STRESS_RUN_ID`, `STRESS_PREFIX`,
`STRESS_HOME`, `STRESS_MODE` (`slice` or `platform`), `STRESS_RESULTS`,
`STRESS_REPO` and `STRESS_COMMIT`. `cell-account-<n>` counts from 1 and
stops at the tier's `cellAccounts`; a draw on any other account fails the
run. The runner times `deploy` and `teardown` itself and writes one
`lifecycle` record per slice with the deploy and destroy seconds.

Scenarios run platform scenarios first (`PS-1`, `PS-2`, ... by number),
then each slice's own scenarios in slice order. A scenario no slice
declares is refused before the run starts, so the run id stays free. A run fails when a
scenario's record is missing, does not parse, belongs to another run, or
makes no isolation assertion, when a record names a slice or a scenario
the run did not run, when a record is already there before its own `run`
starts (the runner removes it), and when a record changed after its own
`run` returned (another slice rewrote it). Only the slice's own `collect` may
change its records after `run`, and only records nobody else changed.

Each verb runs in its own session and process group with no stdin, so
`slice.sh` must not prompt (`cdk deploy --require-approval never`). Its
stdout and stderr go through the runner to the terminal and to
`$STRESS_HOME/$STRESS_PREFIX/<run id>/run.log` (folder 0700, file 0600), so
a verb never prints a token, a password or a key, and never runs `set -x`
around one. When `slice.sh` exits,
anything it left running in its group gets SIGTERM, then SIGKILL after
30 seconds.

## Run it

```bash
cd stress
./run.sh check
./run.sh tier small
./run.sh plan --tier small --slices tenant-identity,control-plane
AWS_REGION=eu-central-1 ./run.sh run --tier small --slices agentic-runtime-isolation --limits limits.json
./run.sh report ~/.aaa-stress/stress/<run id>/results
./run.sh quotas
```

`--limits` takes `{"platform": {"<quota>": <n>}, "cell-account-1": {...}}` with the
accounts' real values; a quota without a value uses its default, which is
the service default and often lower than an account holds. `run.sh quotas`
lists the Service Quotas codes to read them from
(`aws service-quotas get-service-quota --service-code <s> --quota-code <c>`).

The run id defaults to the start time (UTC); the runner refuses a run
folder that already exists. Ctrl-C, SIGTERM or a hangup (SIGHUP) stops the
current step, with everything it started, and then tears down every slice
that started. Signals during teardown are logged and ignored. An
interrupted run exits 129 (SIGHUP), 130 (SIGINT) or 143 (SIGTERM); a failed
run exits 1. Long runs belong in `tmux` or `screen`, or
`setsid ./run.sh run ... > run.out 2>&1 &`, so a dropped connection does not
interrupt them. `nohup` does not help: Node resets the ignored SIGHUP.

The run writes `$STRESS_HOME/$STRESS_PREFIX/<run id>/results.md`, with the
run's verdict (`PASSED` or `FAILED`) and every failure the runner found.
`run.sh report` renders every record in a results folder without checking
it against a run, so it shows no verdict and includes records the runner
refused; use `results.md` as the run's record. To keep a
run, copy that file to `stress/results/<date>-<tier>.md` and commit it
(spec §4.3); the raw records and logs stay outside the repository.

## Known limitations

- The lock is per prefix on the local host: the runner holds
  `$STRESS_HOME/$STRESS_PREFIX/run.lock` and refuses a second run with the
  same prefix there. A run from another host, or with another prefix,
  against the same accounts is not detected. Run one stress test per set of
  accounts at a time.
- Budget limits are what `--limits` says; without it the runner checks
  against service defaults, not the accounts' applied quotas.
- Scenarios run one after another. Spec §5.1 runs PS-5 (churn) and PS-7
  (cross-cell probes) during PS-2; until the platform driver (W-2) runs
  them concurrently, PS-5 and PS-7 run on their own after PS-4, without
  PS-2's load.
- The quota catalogue has no ids yet for the API Gateway control plane or
  for CloudFront Functions compute and KeyValueStore size (spec §4.4), so
  no slice can declare them. They are added with the first slice that
  draws on them (W-7 for the front door).
- A SIGKILL to the runner leaves the current verb's process group
  running, and the run lock in place.
- A process a verb starts with `setsid` leaves the group, so the runner
  cannot stop it, and while it holds the verb's stdout or stderr the verb
  does not end. Redirect the output of anything started that way.
- `run.log` keeps stdout and stderr as two pipes, so their lines can
  interleave out of the script's order.
- Off Linux, the runner cannot tell a zombie from a running process, so
  where pid 1 does not reap orphans, a verb that left a child behind
  waits the full 30 seconds plus 5 before it counts as done.

## Build

```bash
cd stress
npm ci
npx projen build
```

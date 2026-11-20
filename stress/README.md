<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Platform stress test: the shared contract

The code every sample's stress slice plugs into, so the samples can be
stress-tested alone or together as one agent platform. The design is
[`docs/stress-test.spec.md`](../docs/stress-test.spec.md); the decisions are
in [`adr/`](./adr/README.md). It is a test asset that deploys two things:
the driver host, for the length of a run, and the account owner's stacks in
`application/`, which stay in each standalone cell account.

| Part | File | What it holds |
|---|---|---|
| Tiers | [`src/tiers.ts`](./src/tiers.ts) | `small`, `medium`, `large`: accounts, cells, agents, tools, tenants, rates (spec §4.1) and the rules a tier keeps |
| Slice declaration | [`src/slice.ts`](./src/slice.ts) | what `scripts/stress/slice.json` in a sample holds, and the order slices run in (spec §3.4) |
| Quota budget | [`src/budget.ts`](./src/budget.ts) | the account-wide quotas slices draw on, with their Service Quotas codes and defaults (spec §4.4) |
| Result records | [`src/result.ts`](./src/result.ts) | one JSON record per slice per scenario, its checks and the results file (spec §4.3) |
| Runner | [`src/runner.ts`](./src/runner.ts), [`run.sh`](./run.sh) | budget, then `deploy`, `seed`, `run`, `collect` in dependency order, `teardown` in reverse (spec §3.5) |
| Driver host | [`driver/`](./driver/stress-driver.cdk.ts) | the k6 host every slice runs its load from: one EC2 instance, no inbound rule, no public IP, SSM Session Manager (ADR-0007, ADR-0009) |
| k6 library | [`k6/`](./k6/README.md) | tokens, pacing, the correlation header and the result record every slice's scenarios share (ADR-0008) |
| Cell account owner's stacks | [`application/`](./application/README.md) | the cell policies, the account base, the `/cell/` path aspect, the cell bootstrap and its probes (spec §3.7, §8 decision 7; ADR-0006, ADR-0011) |

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
declares is refused before the run starts, so the run id stays free.

A run fails when a scenario's record is missing, does not parse, belongs
to another run, or makes no isolation assertion, when a record names a
slice or a scenario the run did not run, when a record is already there
before its own `run` starts (the runner removes it), and when a record
changed after its own `run` returned (another slice rewrote it). Only the
slice's own `collect` may change its records after `run`, and only
records nobody else changed.

Each verb runs in its own session and process group with no stdin, so
`slice.sh` must not prompt (`cdk deploy --require-approval never`). Its
stdout and stderr go through the runner to the terminal and to
`$STRESS_HOME/$STRESS_PREFIX/<run id>/run.log` (folder 0700, file 0600), so
a verb never prints a token, a password or a key, and never runs `set -x`
around one. When `slice.sh` exits,
anything it left running in its group gets SIGTERM, then SIGKILL after
30 seconds.

## The driver host and the k6 library

A slice runs its load from one host, `<prefix>-driver`, with k6 and the AWS CLI installed. It
is its own CDK app, run from `stress/`:

```bash
export AWS_REGION=eu-central-1 STRESS_PREFIX=StressDriver STRESS_TIER=small
driver/deploy.sh
driver/host.sh 'k6 version'
driver/teardown.sh
```

`deploy.sh` prints the deploy seconds, waits until the SSM Agent is online and the user data has
installed k6, prints those seconds as `ready_seconds`, then the stack outputs (`InstanceId`, `ResultsBucketName`);
`teardown.sh` prints the destroy seconds and checks nothing is left. The host reads the stress
identity, `/<STRESS_PREFIX>/identity` (ADR-0002), and `STRESS_PARAMETER_PREFIXES` lists further
SSM paths it may read (a slice's registry prefix). Its role holds no AWS managed policy (ADR-0009). `host.sh` runs one command on
the host through Run Command and reads its output from the results bucket.

`driver/k6.sh <script> [NAME=value ...]` runs a k6 script on the host: it mirrors `stress/k6/` and
the script's folder under `/opt/stress/repo/` at their repository paths, passes the `STRESS_*`
variables, and brings the result records back to `$STRESS_RESULTS`. A slice's `run` verb calls it
(the runtime-isolation slice's `run` verb does). The library, the record it writes and the
correlation header are described in [`k6/README.md`](./k6/README.md); `k6/smoke.js` is the
check that a deployed host runs k6 and writes a record `parseRecord` accepts.

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
- One run per driver host. `stress/driver/k6.sh` clears `/opt/stress/repo`, `inputs` and `out`
  on the host before it unpacks, so two runs against one `<prefix>-driver` overwrite each other's
  files. Nothing on the host locks; give a concurrent run its own prefix and driver.
- Budget limits are what `--limits` says; without it the runner checks
  against service defaults, not the accounts' applied quotas.
- Scenarios run one after another. Spec §5.1 runs PS-5 (churn) and PS-7
  (cross-cell probes) during PS-2; the runner runs PS-5 and PS-7 on their
  own after PS-4, without PS-2's load.
- The quota catalogue has no ids yet for the API Gateway control plane or
  for CloudFront Functions compute and KeyValueStore size (spec §4.4), so
  no slice can declare them. They are added with the first slice that
  draws on them (W-7 for the front door).
- The k6 library has no k6 run in this folder's build: `record.js` is tested, `lib.js` is
  checked by running `k6/smoke.js` and `K6_COMMAND=inspect` on a deployed host. A change to
  `lib.js` needs that check again.
- `refusals` in a record from k6 are all unattributed until the slice's `collect` joins them
  with the hops' logs (ADR-0008).
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

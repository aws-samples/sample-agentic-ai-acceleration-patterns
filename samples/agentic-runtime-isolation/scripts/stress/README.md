<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Stress test

The stress test of the `api-gateway` ingress, as a slice of the platform stress
test ([ADR-0052](../../adr/0052-run-the-stress-test-as-a-slice-of-the-platform-stress-contract.md),
[`docs/stress-test.spec.md`](../../../../docs/stress-test.spec.md) §3.4).
The plan, the pass criteria and the implementation contract are in
[`design/agentic-runtime-isolation.stress-test.md`](../../design/agentic-runtime-isolation.stress-test.md);
the scripts follow [`scripts/CONVENTIONS.md`](../CONVENTIONS.md): statuses and
timings on stdout, never a token, a credential or a header value.

## Run it

From the repository's `stress/` folder, one command deploys the stacks, seeds
the tenants, runs S1 to S7 on the driver host, collects, tears down and checks
nothing is left:

```bash
cd stress
export AWS_REGION=eu-central-1
STRESS_PREFIX=StressRi ./run.sh run --tier small --slices agentic-runtime-isolation --remove-fixtures
```

The runner prints the verdict and writes
`~/.aaa-stress/<prefix>/<run id>/results.md`; the verbs' output is in `run.log`
beside it. Run `small` first, `medium` only when `small` passes, and `large`
only when `medium` passes. `--scenarios S1,S3` runs some of the seven; S2
reuses the conversations S1 opens, so it runs only after S1 in the same run.

## Before you start

- A non-production account, CDK-bootstrapped in the Region, with nobody
  else's integration run planned for the window (the run takes most of the
  account's Lambda concurrency at `large`).
- The shared tenant-identity deployment (`TenantIdentity-shared-pool`)
  published in that account, with the scope catalogue. The slice reuses it and
  never deploys, replaces or destroys it; `deploy` registers the vendor scopes
  `app/use` and `entitlements/admin` when they are missing and leaves them, and
  stops with a message if the deployment is missing.
- `STRESS_PREFIX` of 1 to 40 letters and digits, not starting with
  `TenantIdentity`. It names the stacks (`<prefix>-ingress`,
  `<prefix>-agents-<k>`, `<prefix>-driver`).
- `--limits` with the account's real quotas when they are above the service
  defaults (`stress/README.md`). At `large` the Lambda concurrency quota must be
  raised to at least 1,900 first (both reserves plus the 100 Lambda keeps
  unreserved, the budget's draw): the budget refuses the run otherwise.
- Check the user pool's monthly active users for the month before seeding:
  every user that gets a token is one MAU (plan §10.2).
- `bash`, the AWS CLI v2, `curl` 7.75 or later, `jq`, `node` and `npm` (the
  slice runs `npm ci` and `smithy build` once on a fresh checkout), `git`, and
  GNU `date` (teardown paces its deletes in milliseconds).

## The verbs

`slice.sh` implements the six verbs of the contract. The runner calls them;
each also runs by hand with the runner's `STRESS_*` variables set
(`stress/README.md`). A verb refuses an argument it does not take, and a runner
variable it needs that is not set, with exit code 2.

| Verb | Does |
|---|---|
| `budget` | prints the tier's draws on six quotas, no credentials (`test/stress/slice-cli.ts`) |
| `deploy` | `deploy.sh`: checks the identity deployment; deploys `<prefix>-ingress`, then the agents stacks one at a time, then `<prefix>-driver` through `stress/driver/deploy.sh`; prints `stack=<name> deploy_seconds=<n>` and the `PolicySecondsToActive*` outputs |
| `seed` | `seed.sh`: reuses or creates the tier's tenants at 4 a second, subscribes the active ones to every agent and tool target, creates their users, writes one demo-table row per tenant; prints counts, wall seconds and the status histogram |
| `run S1..S7` | `stress/driver/k6.sh` runs the scenario's k6 script on the driver host; the script writes `agentic-runtime-isolation.S<n>.json`; `S2` refuses to start without S1's record in this run, then retires every warm Lambda instance, flushes the authoriser cache and idles 60 s; every scenario starts at most 3 s into a minute and at least 3 s past the last recorded scenario's CloudWatch minutes (`window.sh`); exits non-zero when a k6 threshold fails (isolation, positive control, S3 delivery) |
| `collect` | `collect.sh`: for each record, Logs Insights and the k6 summary over the record's window, CloudWatch metrics over its whole minutes (start minute to one past the end minute; per-minute datapoints kept in `<scenario>/cloudwatch/`); fills `refusals` (P-7), `latency.ingress` and `quotas` in the record; appends the pass table to `design/stress-results/<YYYY-MM-DD>-<tier>.md` in this checkout (so a run leaves that file new or changed; commit it with the run, as earlier runs' files are; "Commit tested" is the runner's `STRESS_COMMIT`) after a redaction check that refuses any 12-digit number, any tenant id, tenant name or user name from the manifest, `eyJ` and `https://`; exits 1 on a failed row |
| `teardown [--fixtures]` | `teardown.sh`: deletes the seeded tenants (at `small` and `medium`, or with `--fixtures`), destroys driver, agents and ingress stacks in that order, removes the Runtime log groups a late line recreated and the log groups of the CDK provider functions, which no stack owns, and fails if a stack, a log group a stack owned, any other log group with the stacks' names, an agent runtime or a registry parameter with the prefix is left |

With `STRESS_MODE=platform` the verbs work on the other slices' manifests instead of this
sample's own stacks: `deploy` and `seed` read the manifests and deploy only the k6 host,
`run` takes `PS-2`, `PS-3`, `PS-4`, `PS-6` and `PS-8` instead of `S1` to `S7`, `collect` reads
the refusals from the driver's own lines, and `teardown` removes the run files (the last
bullet under [Also](#also) has the details). `platform.sh` reads and checks the manifests,
`platform-tenants.jq` picks the tenants to drive, `k6/edge-refusals.js` counts each refused
request by tenant, status and minute, and `collect-platform.sh` with `attribute-edge.jq`
turns those lines into the record's refusals.

`attribute.jq` is the P-7 step of `collect`: the refusals the hops log with a
tenant, matched by count with the 4xx and 5xx the driver counted. Each tenant's
429 lines count at most up to the driver's own 429 count for that tenant
(`tenant_429{tenant:<id>}` in the k6 summary, read by `caps.jq`). What no line
accounts for is `unattributed`, and one unattributed refusal fails the run.
`noisy.jq` is S3's row: the noisy tenant (named by `s3-noisy.js` on k6's
stderr) is refused, and every other tenant has 0 429. `delivered.jq` is S3's
delivery row: the steady VUs sent at least 95 % of `steadyRps × seconds`.
`window.sh` holds the window maths `slice.sh run` and `collect` share
(ADR-0052, "CloudWatch windows").

State lives in `$STRESS_HOME/$STRESS_PREFIX/agentic-runtime-isolation/`
(default `~/.aaa-stress/<prefix>/agentic-runtime-isolation/`): `outputs.json`
(stack outputs), `manifest.json` (tenant ids, names and user names; never a
token or a password), `timings.txt` (deploy and destroy seconds, and the driver
host's ready seconds), `pending.jsonl` and, until a teardown's leftover check
passes, `teardown-state` (the log groups the stacks owned, the CDK provider
functions' groups, the Runtime ids, the REST API id and the registry prefix,
so a rerun checks them after their stacks are gone). Without
`STRESS_STATE_DIR` the scripts use `~/.runtime-isolation-stress/<prefix>/`
instead, for a run by hand.

## By hand, step by step

For debugging one step, with the scripts directly. Set `STRESS_SCALE`
(`small`, `medium` or `large`) and `STRESS_PREFIX` (default
`RuntimeIsolationStress`); there is no runner, so no record is written and
`run` and `collect` are not available.

```bash
export AWS_REGION=eu-central-1 STRESS_SCALE=small
scripts/stress/deploy.sh
scripts/stress/seed.sh --dry-run
scripts/stress/seed.sh
scripts/stress/count.sh
scripts/stress/teardown.sh
scripts/stress/cost.sh <run-date> --baseline <quiet day> --scale <tier>
```

| Script | Does |
|---|---|
| `count.sh` | Phase 1 steps 1.4 to 1.7 at the tier's size; prints the step table |
| `cost.sh <run-date> [--baseline <day>] [--scale <tier>]` | the next day: the account's cost by service from Cost Explorer for the run day and a quiet baseline day; writes the "Cost (Cost Explorer)" section of the results file, replacing an earlier one. The delta is the run's cost; the account is shared and a member account cannot activate cost allocation tags |

`seed.sh [--tenants N] [--dry-run]` and `teardown.sh [--tenants]` take those
options by hand. One scenario by hand: `K6_COMMAND=inspect` and
`stress/driver/k6.sh` check a script's imports, see
[`k6/README.md`](./k6/README.md).

| Variable | Default | Meaning |
|---|---|---|
| `AWS_REGION` | none, required | the Region to deploy and run in |
| `STRESS_SCALE` | `small` | the tier, set by `slice.sh` from `STRESS_TIER` |
| `STRESS_PREFIX` | `RuntimeIsolationStress` | stack name prefix |
| `STRESS_STATE_DIR` | `~/.runtime-isolation-stress/<prefix>` | where the state files live, set by `slice.sh` |
| `STRESS_BASELINE_TTFB_P90_MS` | unset | `collect` only: the day's `scripts/perf.sh` warm-report p90 TTFB in ms, for the 1.5x check |

`count.sh` changes an environment variable on the stress stack's Lambda
functions to retire warm instances, and `run S2` does the same; the next
`deploy` resets it.

## Tenant reuse

At `small` and `medium` every run seeds and deletes its tenants (stress
ADR-0004). At `large` the seeded tenants and their users are a fixture: Cognito
bills per monthly active user and each user counts once a month however often
it signs in, so `seed.sh` reads the manifest, checks each listed tenant still
exists, drops the ones that do not, and creates only what is missing. Teardown
keeps them unless `--fixtures` is passed, and is idempotent from the manifest:
a run that died is cleaned up by running it again.

Wait for the Runtime's idle timeout after the last scenario before
teardown, or the stack delete waits on the live sessions.

## Expected durations

Estimates from the plan; the scripts print the measured figures.

| Step | `small` | `medium` | `large` |
|---|---|---|---|
| `deploy` | about 15 min | about 25 min | under 45 min |
| `seed`, first run | under 1 min | about 2 min | about 21 min tenants plus 8 min users |
| `seed`, reuse | under 1 min | under 1 min | about 21 min (every tenant is checked at 8 rps) |
| `count.sh` | about 2 min | about 3 min | about 6 min |
| `run`, each scenario | 1 min plus token set-up | 3 min plus token set-up | the plan's §5 figures, 5 to 10 min plus warm-up |
| `collect` | 150 s settle plus about 1 min a scenario | the same | a few minutes a scenario |
| `teardown` | about 15 min, tenants included | about 15 min | about 30 min; the tenants add 21 min |
| `cost.sh` | seconds, the next day | seconds, the next day | seconds, the next day |

## Also

- The driver host and its helpers are shared and live in `stress/driver/`
  (stress ADR-0007, ADR-0009): `deploy` and `teardown` call its `deploy.sh`
  and `teardown.sh`. `STRESS_PREFIX=<prefix> stress/driver/host.sh '<command>'`
  runs one shell command on the host through Run Command and prints its output
  (read back from the results bucket); a debugging aid, nothing listens on the
  host.
- `large` reserves 800 + 1,000 Lambda concurrency (ADR-0049): the account's
  Lambda concurrency quota must be at least 1,900 before `deploy` at that
  scale, or CloudFormation refuses the reserve.
- In the platform run (`STRESS_MODE=platform`) the slice deploys no cell: the cells
  are the control plane's. `deploy` and `seed` check the manifests the other
  slices write, `run` sends the S1, S2, S3, S5 and S6 shapes to the edge as
  `PS-2`, `PS-3`, `PS-4`, `PS-6` and `PS-8`, `collect` takes each refusal's
  tenant and reason from k6's own lines (`collect-platform.sh`), and `teardown`
  removes only the files `run` wrote and a k6 host its own `deploy` made.
  `S1` to `S7` are refused in platform mode and the `PS-n` scenarios in slice mode. The
  manifests and what each field is for are in
  [`stress/README.md`](../../../../stress/README.md#platform-mode-manifests).

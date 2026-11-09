<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Stress test

The scripts that drive the stress test of the `api-gateway` ingress. The plan,
the pass criteria and the implementation contract are in
[`design/agentic-runtime-isolation.stress-test.md`](../../design/agentic-runtime-isolation.stress-test.md);
the scripts follow [`scripts/CONVENTIONS.md`](../CONVENTIONS.md): statuses and
timings on stdout, never a token, a credential or a header value.

## Before you start

- A non-production account, CDK-bootstrapped in the Region, with nobody
  else's integration run planned for the window (the run takes most of the
  account's Lambda concurrency at `large`).
- The shared tenant-identity deployment (`TenantIdentity-shared-pool`)
  published in that account, with the scope catalogue and the vendor scope
  `app/use` registered. The scripts reuse it and never deploy, replace or
  destroy it; `deploy.sh` stops with a message if it is missing.
- Check the user pool's monthly active users for the month before seeding:
  every user that gets a token is one MAU (plan §10.2).
- `bash`, the AWS CLI v2, `curl` 7.75 or later, `jq`, `npx` (from this
  sample's `npm ci`), `git`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AWS_REGION` | none, required | the Region to deploy and run in |
| `STRESS_SCALE` | `small` | the tier: `small`, `medium` or `large` (plan §8.2) |
| `STRESS_PREFIX` | `RuntimeIsolationStress` | stack name prefix; also names the local state directory |
| `STRESS_BASELINE_TTFB_P90_MS` | unset | `collect.sh` only: the day's `scripts/perf.sh` warm-report p90 TTFB in ms, for the 1.5x check |

Local state lives outside the repo in `~/.runtime-isolation-stress/<prefix>/`:
`outputs.json` (stack outputs), `manifest.json` (tenant ids, names and user
names; never a token or a password), `timings.txt` (deploy and destroy
seconds) and `runs/<run-id>/` (window, k6 summary, query results).

## Run order

Run every step at `small` first. Go to `medium` only when `small` passes,
and to `large` only when `medium` passes; a failure is fixed and rerun at the
scale where it showed.

```bash
export AWS_REGION=eu-central-1 STRESS_SCALE=small
scripts/stress/deploy.sh
scripts/stress/seed.sh --dry-run
scripts/stress/seed.sh
scripts/stress/count.sh
scripts/stress/run.sh s1
scripts/stress/collect.sh <run-id printed by run.sh>
scripts/stress/teardown.sh
```

Repeat `run.sh` and `collect.sh` for `s2` to `s7`. Each `collect.sh` appends
a section to `design/stress-results/<YYYY-MM-DD>-<scale>.md`, after a
redaction check that refuses any 12-digit number, any tenant id, tenant name
or user name from the manifest, `eyJ` and `https://`.

| Script | Does |
|---|---|
| `deploy.sh` | checks the identity deployment; deploys `<prefix>-ingress`, then the agents stacks one at a time, then `<prefix>-driver`; prints `stack=<name> deploy_seconds=<n>` and the `PolicySecondsToActive*` outputs |
| `seed.sh [--tenants N] [--dry-run]` | reuses or creates the tier's tenants at 8 rps, subscribes the active ones to every agent and tool target, creates their users, writes one demo-table row per tenant; prints counts, wall seconds and the status histogram |
| `count.sh` | Phase 1 steps 1.4 to 1.7 at the tier's size; prints the step table |
| `run.sh s1..s7` | runs one k6 scenario on the driver host over SSM; `s2` first retires every warm Lambda instance, flushes the authoriser cache and idles 60 s; prints the summary line and the isolation counters |
| `collect.sh <run-id>` | Logs Insights, CloudWatch metrics and the k6 summary for the run window; prints and writes the pass table |
| `teardown.sh [--tenants]` | destroys driver, agents and ingress stacks in that order; with `--tenants`, deletes the seeded tenants first at 8 rps |

`count.sh` and `run.sh s2` change an environment variable on the stress
stack's Lambda functions to retire warm instances; the next `deploy.sh`
resets it.

## Tenant reuse

Seeded tenants and their users are kept between runs, because Cognito bills
per monthly active user and each user counts once a month however often it
signs in. `seed.sh` reads the manifest, checks each listed tenant still
exists, drops the ones that do not, and creates only what is missing for the
tier. `teardown.sh` keeps them unless `--tenants` is passed, and is
idempotent from the manifest: a run that died is cleaned up by running it
again.

Wait for the Runtime's idle timeout after the last scenario before
`teardown.sh`, or the stack delete waits on the live sessions.

## Expected durations

Estimates from the plan; the scripts print the measured figures.

| Step | `small` | `medium` | `large` |
|---|---|---|---|
| `deploy.sh` | about 15 min | about 25 min | under 45 min |
| `seed.sh`, first run | under 1 min | about 2 min | about 21 min tenants plus 8 min users |
| `seed.sh`, reuse | under 1 min | under 1 min | about 21 min (every tenant is checked at 8 rps) |
| `count.sh` | about 2 min | about 3 min | about 6 min |
| `run.sh`, each scenario | 1 min plus token set-up | 3 min plus token set-up | the plan's §5 figures, 5 to 10 min plus warm-up |
| `collect.sh` | about 1 min | about 1 min | a few minutes |
| `teardown.sh` | about 10 min | about 15 min | about 30 min; `--tenants` adds 21 min |

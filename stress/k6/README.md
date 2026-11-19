<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# The shared k6 library

What every slice's k6 scenarios import (stress ADR-0007, ADR-0008). It knows no sample: a
slice adds the calls and assertions of its own sample in a module beside its scenarios
(`samples/agentic-runtime-isolation/scripts/stress/k6/probe.js` is the first) and imports
this library by its repository-relative path.

| File | Holds |
|---|---|
| `lib.js` | the tier (`loadTier`) and seed manifest (`loadManifest`, `plan`, `tokenMode`); identity tokens (`setupTokens`, `refreshIfNeeded`, `ensureToken`, per-VU ownership with `adopt`, pacing); the correlation header (`correlate`); the counters and `isolationCheck`; the per-tenant ledger lines; `buildOptions`; `summarize` (summary files and the result record) |
| `record.js` | `buildRecord`: the result record from k6's end-of-test data, with no k6 import so the contract's tests run it (`stress/test/record.test.ts` checks that `parseRecord` accepts it) |
| `smoke.js` | five requests to one public endpoint and a record: proves that k6 runs on the driver host and that the library loads from its mirrored path |

## The result record

`summarize(data, { slice, scenario })` writes `$STRESS_RESULTS/<slice>.<scenario>.json` when
`STRESS_RESULTS` is set, in the shape of `stress/src/result.ts` (`ResultRecord`). It needs
`STRESS_RUN_ID`, `STRESS_TIER_JSON`, `STRESS_MODE` and `STRESS_COMMIT` as the runner sets
them, and fails the scenario without them. What a record holds from k6:

| Field | From |
|---|---|
| `requests` | `status_<code>` counters (`countStatus`); `other` for a code the library does not list |
| `latency.client`, `latency['client-ttfb']` | the `client_ms` and `ttfb_ms` trends (`timed`), p50, p95, p99 in seconds; the ingress, router and origin hops come from the slices' logs |
| `isolation` | `isolation_assertions` and `isolation_mismatch` (`isolationCheck`, one assertion per checked request, P-1). P-1 counts answered probes only: a 200 is one assertion, and a mismatch when the slice cannot parse its answer; a non-200 makes no assertion (it is counted under `requests` and `refusals`), so `assertions` can be lower than `requests` |
| `refusals` | `unattributed` is the count of 4xx and 5xx the driver saw; `byTenantReason` is empty. The slice's `collect` attributes them from the hops' logs (it may join the `tenant_minute` lines the library prints) and moves attributed refusals across (P-7) |
| `quotas` | empty; a slice's `collect` fills it from its own measurements |
| `window` | the end of the test and its duration |

`cost` is absent; `collect` adds it.

## The correlation header

Every request the library makes, and every one `correlate()` is used for, carries
`x-correlation-id: <run>-<vu>-<counter>`: at most 64 characters of `[A-Za-z0-9-]`, fresh per
request (stress ADR-0005). Mismatch lines on stderr carry it, so a mismatch joins the hops' logs.

## Environment

| Variable | Meaning |
|---|---|
| `STRESS_TIER_JSON` | the tier from `stress/src/tiers.ts`, as `stress/run.sh tier <name>` prints it; `tenantsActive`, `usersPerActiveTenant`, `steadyRps`, `peakRps` required; a slice may add fields (`loadTier().raw`) |
| `STRESS_RUN_ID`, `STRESS_MODE`, `STRESS_COMMIT`, `STRESS_RESULTS` | the runner's (stress/README.md); `STRESS_RESULTS` unset writes no record |
| `MANIFEST` | absolute path of the seed manifest: `{ tenants: [{ tenantId, admin, users: [...], active? }] }` |
| `PLATFORM_API`, `APP_CLIENT_ID` | tenant-identity's API base URL and app client id, for `IssueToken` (SigV4) and the token exchange |
| AWS credentials and Region | signing `IssueToken`; `stress/driver/k6.sh` resolves the instance role's on the host |

Tuning, all optional: `ISSUE_RPS` (8), `REFRESH_RPS` (17), `REFRESH_MARGIN_S` (90), `WARM_RPS`
(20), `VU_PER_RPS` (1), `REFRESH_SCOPE` (`app/use`), `TOKENS_IN` (`setup` or `vu`),
`MEMORY_BUDGET_MB` (2048), `SCENARIO_SECONDS`, `SUMMARY_PATH` (`summary.json`),
`STRESS_SMOKE_URL` (`smoke.js` only).

## Limits worth knowing

- k6 has no cross-VU rate limiter. Each tenant belongs to one VU slot, and each VU spaces its
  own refreshes `VUs / REFRESH_RPS` seconds apart, so the run never exceeds 17 exchanges a
  second. A token that cannot be refreshed in time is not sent (`token_deferred`).
- Setup data is copied into every VU. When tokens x VUs would pass `MEMORY_BUDGET_MB`, setup
  returns entries without tokens and each VU issues its own during the warm-up.
- Nothing logs a token, a password or a caller ARN. Never add `--http-debug`.
- k6 signs with one copy of the driver host's instance role credentials, exported when the run
  starts; it cannot refresh them. `stress/driver/k6.sh` reads their expiration on the host and
  refuses to start k6 (exit 3) when they expire sooner than `K6_TIMEOUT` (default 3600 s, at
  most 14400 s) plus 300 s. A run is therefore bounded by the copy's remaining lifetime: keep
  `K6_TIMEOUT` to the longest scenario plus its setup, and rerun after a few minutes when the
  check refuses (the host rotates the credentials well before they expire).
- The library imports `jslib.k6.io` (SigV4 signing, the text summary) when k6 starts, so the
  driver host needs outbound HTTPS to it, which its security group allows.
- Written for k6 v1.x and checked on v2.4 (ES modules, `k6/execution`). `stress/driver/k6.sh` runs a script on the
  host with `K6_COMMAND=inspect` to check that its imports resolve.

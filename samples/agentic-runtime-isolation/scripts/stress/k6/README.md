# k6 scenarios for the stress test

The load half of the stress test in
[design/agentic-runtime-isolation.stress-test.md](../../../design/agentic-runtime-isolation.stress-test.md)
(§5 Phase 2, §6, §8.3). `run.sh` copies this folder and the seed manifest to the
driver host and runs one scenario; the pass table is computed by `collect.sh`,
not here. Written for k6 v0.5x (ES modules, `k6/execution`); the syntax was
checked with esbuild, not yet by a k6 run.

| File | Does |
|---|---|
| `lib.js` | tokens (`setupTokens`, `refreshIfNeeded`), `invoke`, `probe` with the §6 assertions, `pickProbe` (70/20/10), `recordMismatch`, the counters, the warm-up and pacing helpers, `summarize` |
| `s1-steady.js` | active tenants x users, steady rate, §6 probe mix, tier length (large 600 s) |
| `s2-herd.js` | token prime only (ingress idle), then 0 to 1.6 x steady in 5 s, held (large 120 s); no warm-up |
| `s3-noisy.js` | S1 minus one tenant, plus scenario `noisy`: that tenant at 10 x `tenantLimitRpm` a minute |
| `s4-tools.js` | `tool t01/tool_001 {}` at 0.4 x steady |
| `s5-streams.js` | `stream 60` (small: `stream 10`) over half the active tenants at 90 % of the reserved concurrency |
| `s6-peak.js` | the S1 shape at `peakRps` for 60 s |
| `s7-eviction.js` | 2 x active tenants, one user each, 0.6 x steady, each VU walking its tenants in turn |

Every scenario starts with an untimed `warmup` scenario (one iteration per VU):
it issues or refreshes the VU's tokens and opens one conversation per owned
tenant at 20 new conversations a second overall. The timed scenario starts
after it. Thresholds: `isolation_mismatch` and `positive_control_fail` count 0.
`handleSummary` writes `summary.json` (without `setup_data`) and the text
summary to stdout.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `TIER` | yes | the tier as JSON: `tenantsActive`, `usersPerActiveTenant`, `steadyRps`, `peakRps` (required), `scale`, `scenarioSeconds`, `agents`, `tenantLimitRpm`, `ingressReservedConcurrency` |
| `MANIFEST` | yes | absolute path of `manifest.json`: `{ tenants: [{ tenantId, admin, users: [...], active? }] }` |
| `ENDPOINT` | yes | the ingress `EndpointUrl` output; `/<agent>/invocations` is appended as `lib.sh backend_url` does |
| `PLATFORM_API` | yes | tenant-identity's API base URL (`.../prod/`): `platform/tenants/{t}/users/{u}/token` (SigV4) and `oauth2/token` (exchange) |
| `APP_CLIENT_ID` | yes | tenant-identity's app client id (`/application-plane/shared/identity/appClientId`); the exchange form requires it |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` (or `REGION`) | yes | signs IssueToken. On the driver, `run.sh` exports the instance role's credentials from IMDSv2 first; the k6 aws jslib does not read IMDS |
| `RUN_ID` | no | names the run's conversations (`stress<run><tenant>`); default a timestamp |
| `ISSUER` | no | when set, each report's `tokenIss` is checked against it (a check, not a mismatch) |
| `ENTITLEMENTS_API` | no | read by the operator scripts; unused here |

Tuning, all optional: `ISSUE_RPS` (8), `REFRESH_RPS` (17), `REFRESH_MARGIN_S` (90),
`WARM_RPS` (20), `VU_PER_RPS` (1), `REFRESH_SCOPE` (`app/use`),
`SESSION_SCOPE` (`tenant`), `AGENT_SPREAD` (`false`: every probe on `default`),
`TOKENS_IN` (`setup` or `vu`), `MEMORY_BUDGET_MB` (2048), `CONVERSATION_RUN_ID`
(S2: reuse an S1 run's conversations), `SCENARIO_SECONDS`, `HERD_RPS`,
`TOOL_RPS`, `TOOL_PROMPT`, `STREAM_RPS`, `STREAM_SECONDS`, `PEAK_SECONDS`,
`EVICTION_RPS`, `SUMMARY_PATH` (`summary.json`).

## Limits worth knowing

- k6 has no cross-VU rate limiter. Each tenant belongs to one VU slot, and each VU
  spaces its own refreshes `VUs / REFRESH_RPS` seconds apart, so the run never
  exceeds 17 exchanges a second. A token that cannot be refreshed in time is
  not sent (`token_deferred`).
- Setup data is copied into every VU. When tokens x VUs would pass
  `MEMORY_BUDGET_MB`, setup returns entries without tokens and each VU issues
  its own during the warm-up, at the same overall 8 a second.
- The `tenant_minute` lines (stdout, one per tenant per minute per VU) are the
  per-tenant send counts for the 429 attribution. A VU's final minute is
  flushed per request in the last 1 % of the scenario.
- Nothing logs a token, a password or a caller ARN. Never add `--http-debug`.

## Debugging one scenario against a deployed small stack

From a shell with credentials for the account (the platform API needs
`execute-api:Invoke`) and the small stack's outputs:

```bash
export AWS_REGION=eu-central-1
export TIER='{"scale":"small","tenantsActive":20,"usersPerActiveTenant":2,"steadyRps":10,"peakRps":40,"scenarioSeconds":60,"agents":2,"ingressReservedConcurrency":50}'
export MANIFEST="$HOME/.runtime-isolation-stress/RuntimeIsolationStress/manifest.json"
export ENDPOINT=<EndpointUrl output>
export PLATFORM_API="$(aws ssm get-parameter --name /application-plane/shared/identity/apiUrl --query Parameter.Value --output text)"
export APP_CLIENT_ID="$(aws ssm get-parameter --name /application-plane/shared/identity/appClientId --query Parameter.Value --output text)"
eval "$(aws configure export-credentials --format env)"
k6 run --env SCENARIO_SECONDS=30 scripts/stress/k6/s1-steady.js
```

`aws configure export-credentials --format env` puts the credentials in the
shell environment, where k6 reads them; close the shell afterwards.

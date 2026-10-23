<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. SPDX-License-Identifier: MIT-0 -->

# End-to-end scenario (spec §10)

This directory holds the acceptance scenario of
[`design/tenant-identity.spec.md`](../../design/tenant-identity.spec.md) §10.
It runs **against already-deployed stacks**, once per topology, with the same
test code (spec P-1), plus one focused scenario for the `tiered` deployment
(ADR-0027). It is **test code, not sample code** (spec §3.2): it verifies every
token it asserts on with `aws-jwt-verify`, and it uses the
`IssueToken`/`RefreshToken` test-aid routes (ADR-0006) to obtain tokens.

## What runs where

| File | Role |
|---|---|
| `jest.config.json` | ts-jest config; `maxWorkers: 4` so the four stack files run in parallel; `testTimeout` 15 min |
| `clients.ts` | stack discovery (CloudFormation outputs), SigV4 platform client, form-POST exchange client, bearer tenant client, and the `aws-jwt-verify` helper |
| `scenario.ts` | `defineScenario(topology)` — spec §10 steps 2–9 and 11 (steps 1 and 10 are unit-level, in `test/main.test.ts` and the trigger tests) |
| `<topology>.e2e.test.ts` | one entry per topology; `describe.skip` when `E2E_TOPOLOGIES` excludes it |
| `tiered.e2e.test.ts` | the ADR-0027 scenario against `TenantIdentity-tiered` (below); `describe.skip` when `E2E_TOPOLOGIES` excludes `tiered` |

## The tiered scenario (ADR-0027)

The three single-topology stacks already prove each strategy on its own, so
`tiered.e2e.test.ts` covers only what `tiered` adds. Its steps, in order:

| Step | Proves |
|---|---|
| a | `CreateTenant` without `tier` → 400 `InvalidInput`: the tier is chosen explicitly, never defaulted (P-7 as amended) |
| b | `CreateTenant` with `tier: standard` (S) and `tier: premium` (P) → 201 with the tier echoed; S runs `shared-pool` with no pool fields of its own, P runs `pool-per-tenant` with its own `userPoolId`/`appClientId`/`issuer`, trigger and tenant tag; `GetTenant` and `ListTenants` return the tier. A second standard tenant S2 is created here and left behind (step h) |
| c | S's API key is in the `<stack>-tenant` usage plan and P's in `<stack>-tenant-premium`, and neither is in the other (ADR-0025) |
| d | A user in S and a user in P each receive `tenant_id` from their own pool; each token verifies against that pool and fails against the other (P-6) |
| e | Each tenant admin narrows its refresh token through its own `client_id` (the shared client for S, P's client for P) to `tenant-admin/users` and lists only its own tenant's users; un-narrowed tokens are refused (P-10, P-11) |
| f | The binding rule: cross-tier reads by username → 404 (R-12); a shared-pool refresh token presented with P's `client_id`, a premium refresh token with the shared `client_id`, or an unknown `client_id` → 400 with an OAuth error, never a token; naming the other tenant as `resource` → `invalid_target` |
| g | On the `TenantIdentity-shared-pool` stack, `CreateTenant` with any `tier` → 400 `UnsupportedInTopology` (P-4). Skipped when `E2E_TOPOLOGIES` excludes `shared-pool` |
| h | `DeleteTenant` S and P → 204; the narrowed admin tokens are refused at once; P's pool is gone (`DescribeUserPool` → `ResourceNotFoundException`); both keys are gone; the shared pool keeps only S2's admin from the run |

Step h leaves S2 behind on purpose, for the same reason the §10 scenario
leaves one tenant per stack: the tiered stack's `TenantDrain` must offboard a
standard tenant during `cdk destroy` (ADR-0022), and `scripts/integ.sh`'s
leftover check fails the run if it does not.

## Run against deployed stacks

Deploy the four stacks first (see the sample README's **Deploy** section),
named `TenantIdentity-pool-per-tenant`, `TenantIdentity-shared-pool`,
`TenantIdentity-shared-pool-multi-tenant`, and `TenantIdentity-tiered` in one
Region. Then:

```bash
export AWS_REGION=eu-central-1        # the Region the stacks are deployed in
npx projen e2e                        # runs every scenario against all four
```

Environment variables:

| Variable | Default | Effect |
|---|---|---|
| `AWS_REGION` | — (required) | the Region the stacks are deployed in |
| `E2E_STACK_PREFIX` | `TenantIdentity` | stack name prefix: `${prefix}-${deployment}` |
| `E2E_TOPOLOGIES` | all four | comma-separated subset of `pool-per-tenant`, `shared-pool`, `shared-pool-multi-tenant`, `tiered` to run (e.g. `shared-pool,tiered`) |

Credentials: the scenario signs `/platform/*` calls with SigV4 using the
ambient credentials (`fromNodeProviderChain`), so the principal running it must
hold `execute-api:Invoke` on the deployed APIs (spec §3.2). The same
credentials are used for the direct-to-Cognito checks (the P-3 claim-integrity
step, the narrowing-bypass step, and the tiered pool and tag checks) and for
the API Gateway usage-plan checks.

## As part of the deployment integration test

`npx projen integ` (see the sample README) deploys the four stacks at once,
runs these scenarios, then destroys them at once (ADR-0023). Every scenario
leaves one tenant in its stack on purpose: the stack's own `TenantDrain`
custom resource offboards it during `cdk destroy` (ADR-0022), so a pool, group,
or user left after the destroy is a failure. Running the scenarios on their own
with `npx projen e2e` is the faster loop when the stacks are already up; delete
the leftover tenants through the platform API (or redeploy and destroy) when
you are done.

## Hygiene

The scenarios never log or print a token, refresh token, or password
(spec N-4/N-6/N-7). Assertion failures surface claim *names*, usernames, and
tenant ids, never token values.

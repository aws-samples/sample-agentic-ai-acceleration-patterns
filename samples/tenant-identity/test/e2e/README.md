<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. SPDX-License-Identifier: MIT-0 -->

# End-to-end scenario (spec §10)

This directory holds the acceptance scenario of
[`design/tenant-identity.spec.md`](../../design/tenant-identity.spec.md) §10.
It runs **against already-deployed stacks**, once per topology, with the same
test code (spec P-1). It is **test code, not sample code** (spec §3.2): it
verifies every token it asserts on with `aws-jwt-verify`, and it uses the
`IssueToken`/`RefreshToken` test-aid routes (ADR-0006) to obtain tokens.

## What runs where

| File | Role |
|---|---|
| `jest.config.json` | ts-jest config; `maxWorkers: 3` so the three topology files run in parallel; `testTimeout` 15 min |
| `clients.ts` | stack discovery (CloudFormation outputs), SigV4 platform client, form-POST exchange client, bearer tenant client, and the `aws-jwt-verify` helper |
| `scenario.ts` | `defineScenario(topology)` — spec §10 steps 2–9 and 11 (steps 1 and 10 are unit-level, in `test/main.test.ts` and the trigger tests) |
| `<topology>.e2e.test.ts` | one entry per topology; `describe.skip` when `E2E_TOPOLOGIES` excludes it |

## Run against deployed stacks

Deploy the three topology stacks first (see the sample README's **Deploy**
section), named `TenantIdentity-pool-per-tenant`, `TenantIdentity-shared-pool`,
and `TenantIdentity-shared-pool-multi-tenant` in one Region. Then:

```bash
export AWS_REGION=eu-central-1        # the Region the stacks are deployed in
npx projen e2e                        # runs this scenario against all three
```

Environment variables:

| Variable | Default | Effect |
|---|---|---|
| `AWS_REGION` | — (required) | the Region the stacks are deployed in |
| `E2E_STACK_PREFIX` | `TenantIdentity` | stack name prefix: `${prefix}-${topology}` |
| `E2E_TOPOLOGIES` | all three | comma-separated subset to run (e.g. `shared-pool`) |

Credentials: the scenario signs `/platform/*` calls with SigV4 using the
ambient credentials (`fromNodeProviderChain`), so the principal running it must
hold `execute-api:Invoke` on the deployed APIs (spec §3.2). The same
credentials are used for the direct-to-Cognito checks (the P-3 claim-integrity
step and the narrowing-bypass step).

## As part of the deployment integration test

`npx projen integ` (see the sample README) deploys the three stacks, runs this
scenario as integ-runner's `postDeploy` hook, then destroys the stacks. Step 11
leaves one tenant in every stack on purpose: the stack's own `TenantDrain`
custom resource offboards it during `cdk destroy` (ADR-0022), so a pool, group,
or user left after the destroy is a failure. Running the scenario on its own
with `npx projen e2e` is the faster loop when the stacks are already up; delete
the leftover tenant through the platform API (or redeploy and destroy) when you
are done.

## Hygiene

The scenario never logs or prints a token, refresh token, or password
(spec N-4/N-6/N-7). Assertion failures surface claim *names* and tenant ids,
never token values.

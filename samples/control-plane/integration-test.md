# The Cell-Based Control Plane: deployment integration test

This file describes the sample's deployment integration test, as the
[sample standard §5.3](../../docs/sample-standard.md#53-integration-test-document-integration-testmd)
lays it out. The [README](./README.md) carries the command and a link here.

## What it is

[`test/integ.tenant.ts`](./test/integ.tenant.ts) is an
[AWS CDK integration test](https://docs.aws.amazon.com/cdk/api/v2/docs/integ-tests-alpha-readme.html),
driven by `@aws-cdk/integ-runner` through the projen `integ` task. It deploys
temporary infrastructure into **two real, non-production AWS accounts** and
exercises the complete account, cell and tenant lifecycle: account A is the
one your credentials point at (the control plane's own, registered as
vendor-owned), account B is a second account named by `CP_INTEG_ACCOUNT_B`
(registered as tenant-owned, behind an external id).

Per [sample standard §5.2](../../docs/sample-standard.md#52-integration-test)
the test is the reference implementation of this sample's wiring: how the
vendor IdP, the stamped script source, the `cellDefinition` and the account
role pair in a second account fit together is read from that file, not from
prose.

## How to run it

Both accounts must be non-production and bootstrapped for AWS CDK, and
account B's bootstrap must trust account A, because the test deploys the
role pair into B with A's credentials. Once, with credentials for account B:

```bash
npx cdk bootstrap aws://<ACCOUNT_B_ID>/$AWS_REGION --trust <ACCOUNT_A_ID> --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

That trust and the `AdministratorAccess` execution policy are test-only
shortcuts so one runner can deploy into both accounts (see Test-only
shortcuts below).

Run the test in one explicitly selected Region. The `integ` task pins
integ-runner to `$AWS_REGION` (overriding its multi-Region defaults) and
fails fast when either variable is unset:

```bash
export AWS_REGION=eu-central-1
export CP_INTEG_ACCOUNT_B=<ACCOUNT_B_ID>
npx projen integ
```

| Knob | Default | Effect |
|---|---|---|
| `AWS_REGION` | none (required) | The single Region the test deploys to and runs in, in both accounts |
| `CP_INTEG_ACCOUNT_B` | none (required) | The second, tenant-owned test account (12 digits, different from the account the credentials point at) |
| `CDK_DEFAULT_ACCOUNT` | resolved by the task with `sts get-caller-identity` | Account A |

The `integ` task always runs integ-runner with `--force` and
`--update-on-failed`. The integ-runner snapshot
(`test/integ.tenant.ts.snapshot/`) is intentionally not committed: it is
generated output that would ship megabytes of bundled third-party code (a
vendored AWS CLI layer, esbuild-bundled custom-resource handlers) with the
sample. Because the task always runs with `--force`, no workflow depends on a
committed snapshot; your local snapshot is kept (gitignored) to speed up
repeated runs.

## What it stands up

| Stack | Account | Contents |
|---|---|---|
| `control-plane-integ-setup` | A | A throwaway Cognito user pool as the vendor IdP, with a pre token generation trigger that adds the `role: "operator"` claim (ADR-018); an S3 bucket hosting `scripts/sample-cell` and `scripts/sample-tenant` as the stamped source; a probe function that assumes a test-only read role in B to count SSM parameters there |
| `control-plane-integ` | A | The stack under test: `TenantStack` with a `cellDefinition` that points both shared CodeBuild projects at the test bucket, `maxTenants: 1` (every cell is a silo, so cells, not tenants, are what the accounts count); it installs the home account's role pair (R-25) |
| `control-plane-integ-account-b` | B | `CellAccountStack`: the account role pair trusting A's build roles and API role by ARN, behind the fixed external id `control-plane-integ-handshake`; plus the test-only `control-plane-integ-probe` read role |
| `ControlPlaneIntegDefaultTestDeployAssert<hash>` | A | The integ-tests-alpha assertion stack of the `ControlPlaneInteg` test: the API calls and polls that drive the steps below |

The test reuses nothing that exists in either account. Its own steps tear
down every tenant, all three cells and both account registrations, leaving
the SSM namespaces in both accounts empty; the runner then destroys its
CloudFormation stacks by default.

## Steps

Every API operation runs at least once. The steps run in this order:

| # | Step | What it checks |
|---|---|---|
| 1 | Unauthenticated request | No vendor JWT: API Gateway answers 401 before any Lambda runs |
| 2 | Mint an operator | `adminCreateUser`, `adminSetUserPassword`, `adminInitiateAuth` in the vendor IdP return an ID token (operator authentication) |
| 3 | Register accounts | `PutAccount` for an account with no role pair is a 400 (handshake, R-26); `PutAccount` A as tenant-owned with an external id its pair does not require is a 400 naming the role (ADR-030); `PutAccount` B as tenant-owned without an external id is a 400 (ADR-029) and with the wrong one a 400 naming the role; `PutAccount` A (vendor-owned, 2 cells) and B (tenant-owned, 1 cell, external id) are 200; `ListAccounts` shows both at 0/n; `GetAccount` B reports only that an external id is set |
| 4 | Onboard tenant #1 | `CreateTenant` with a `clientToken` (202) implicitly creates cell 1 in A; `GetTenant` polls to ACTIVE; the cell namespace and tenant parameter exist in A; account A is 1/2; replaying the identical request returns the same tenant (ADR-017); the token with different parameters is a 409; still one cell |
| 5 | Onboard tenant #2 | Cell 1 is full, so placement creates cell 2 in A; account A is 2/2 |
| 6 | Fleet full | `CreateTenant` #3 untargeted is a 409 `InsufficientCapacityError` (A full, B is tenant-owned and never eligible without a target, ADR-026); still two cells |
| 7 | Targeted placement into B | `CreateTenant` #3 with `accountId` B creates cell 3 in B; `DeleteTenant` while CREATING is a 409 (in-flight guard); polls to ACTIVE; `GetCell` names B; the cell namespace and tenant parameter exist in B and not in A, so the scripts ran under B's role pair; account B is 1/1 |
| 8 | Account guards | `CreateTenant` #4 targeted at B is a 409 (account full); `DeleteAccount` B is a 409 (occupied); `PutAccount` B with another owner is a 409 (owner immutable) |
| 9 | Reads | `ListCells` returns three cells with `accountId`; `ListCells?accountId=A` returns cells 1 and 2; an unknown account returns an empty page; `ListTenants?cellId=` filters; `GetResource` names cell and account; `UpdateTenant` edits metadata |
| 10 | Updates in both accounts | `UpdateResource` on tenant #1 (in A) and `UpdateCell` on cell 3 (in B) poll back to ACTIVE |
| 11 | Occupied-cell guard and cell reuse | `DeleteCell` on the occupied cell 1 is a 409 (ADR-014); `DeleteTenant` #1 polls to 404; cell 1 stays at 0/1 and account A at 2/2; `CreateTenant` #5 untargeted reuses cell 1 (no new cell) |
| 12 | Teardown through the API | `DeleteTenant` #5, #2, #3 poll to 404; tenant namespaces are empty in A and B; `DeleteCell` 1, 2, 3 poll to 404; A is 0/2 and B 0/1; cell namespaces are empty in both accounts; `DeleteAccount` A and B are 200; `ListAccounts` is empty |

Success is reported as one passing integration test.

## Runtime and cost

Expect about 35 minutes (about 5 to deploy, 15 for the scenario's 16
CodeBuild builds, 13 to destroy) and well under a dollar per run: 16 short
CodeBuild builds, a few hundred DynamoDB and Lambda requests, and SSM standard
parameters, all torn down at the end.

The last green run was on 2026-11-10 in eu-central-1 across two
non-production accounts: 74 assertions, 16 builds, 33 minutes, covering every
step above. See the status block at the top of
[`architecture.md`](./architecture.md).

## After an interruption

If execution is interrupted, inspect active stacks containing
`control-plane-integ` in both accounts, and parameters under
`/application-plane/cells/` and `/application-plane/tenants/` in both
accounts, before removing test resources. Delete the stacks with the account
each lives in: `control-plane-integ-account-b` with credentials for B (or
through A's credentials and B's bootstrap trust), the others in A.

After a complete run the test harness still leaves default Lambda log
groups in A (`/aws/lambda/control-plane-integ-setup-*` from the setup stack's
custom resources and probe functions, `/aws/lambda/ControlPlaneIntegDefaultTest*`
from integ-runner's assertion provider); the sample's own functions write to
explicit log groups the stack owns and leave nothing. Delete them by prefix;
they hold test output only (README, Known issues).

## Test-only shortcuts

| In the test | What a consumer does instead |
|---|---|
| Account B's CDK bootstrap trusts account A with the `AdministratorAccess` execution policy, so one runner deploys the role pair into B | A customer deploys `CellAccountStack` with their own credentials in their own account; no cross-account bootstrap trust exists |
| A `control-plane-integ-probe` read role in B lets a probe function in A count SSM parameters there | Nothing: the control plane never reads a customer's account; the probe exists only so the assertions can see what the scripts wrote |
| The external id is the fixed string `control-plane-integ-handshake` | The account owner generates a value and hands it to the operator out of band |
| A throwaway Cognito user pool stands in for the vendor IdP, and a pre token generation trigger adds `role: "operator"` | Configures its own vendor IdP to mint `role: "operator"` on operator tokens (ADR-018) and passes its issuer URL and audience |
| The operator is created and authenticated with Cognito admin APIs, with a password generated at run time | Signs operators in through its own IdP |
| The stamped source is an S3 bucket of the sample scripts, read by both shared CodeBuild projects through `grantRead` | Points the `cellDefinition` source at its own cell and tenant scripts |
| `maxTenants: 1`, so every cell is a silo and the account cell limits are what fill up | Sets `maxTenants` for its own cells |

# The Cell-Based Control Plane: deployment integration test

This file describes the sample's deployment integration test, as the
[sample standard §5.3](../../docs/sample-standard.md#53-integration-test-document-integration-testmd)
lays it out. The [README](./README.md) carries the command and a link here.

## What it is

[`test/integ.tenant.ts`](./test/integ.tenant.ts) is an
[AWS CDK integration test](https://docs.aws.amazon.com/cdk/api/v2/docs/integ-tests-alpha-readme.html),
driven by `@aws-cdk/integ-runner` through the projen `integ` task. It deploys
temporary infrastructure into **two real, non-production AWS accounts** and
exercises the complete application, account, tenant, deployment and cell
lifecycle with **two applications**, as the acceptance scenario of
[spec §10](./design/control-plane.spec.md#10-acceptance-criteria) describes.
Account A is the one your credentials point at (the control plane's own,
registered as vendor-owned and shared); account B is a second account named
by `CP_INTEG_ACCOUNT_B` (registered as tenant-owned, behind an external id,
and dedicated to one application). Applications `integ-x` (X) and `integ-y`
(Y) share one source and one set of scripts and differ in id and in
their parameter declarations: X declares `ALLOWED_EMAIL_DOMAIN` (required),
`LOG_LEVEL` (default `info`) and the cell parameter `CELL_SIZE` (default
`small`); Y declares none. Both have `maxTenants: 1`.

Per [sample standard §5.2](../../docs/sample-standard.md#52-integration-test)
the test is the reference implementation of this sample's wiring: how the
vendor IdP, the applications' script source, the run-time registration of
applications and accounts, and the account role pair in a second account fit
together is read from that file, not from prose.

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
integ-runner to `$AWS_REGION` (overriding its multi-Region defaults). It
fails fast when either variable is unset, and when any stack of the test
already exists in account A. Such a stack belongs either to a run in
progress, whose stacks a second run would update and whose assertion stack
it would delete mid-scenario, or to an interrupted run, whose leftovers must
be removed first (After an interruption).

The run lasts about 55 minutes. Start it from a shell that outlives it (for
example `nohup`, `tmux` or `screen`), with credentials that last as long.

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
| `control-plane-integ-setup` | A | A throwaway Cognito user pool as the vendor IdP, with a pre token generation trigger that adds the `role: "operator"` claim (ADR-018); an S3 bucket hosting `scripts/sample-cell` and `scripts/sample-tenant`, the source both applications are registered with; a probe function that assumes a test-only read role in B to count SSM parameters there; a build probe that returns the `PARAM_` variables of a CodeBuild project's latest build |
| `control-plane-integ` | A | The stack under test: `TenantStack` with the two vendor IdP inputs and `demoApplicationIds: ["integ-x", "integ-y"]`, which publishes each application's demo shared parameter in A (ADR-034); both shared CodeBuild projects may read the test bucket; it installs the home account's role pair (R-25). No application is a stack input: the test registers X and Y with `PutApplication` |
| `control-plane-integ-account-b` | B | `CellAccountStack`: the account role pair trusting A's build roles and API role by ARN, behind the fixed external id `control-plane-integ-handshake`, with `demoApplicationIds: ["integ-y"]` (B hosts cells of Y only); plus the test-only `control-plane-integ-probe` read role |
| `ControlPlaneIntegDefaultTestDeployAssert<hash>` | A | The integ-tests-alpha assertion stack of the `ControlPlaneInteg` test: the API calls and polls that drive the steps below |

The test reuses nothing that exists in either account. Its own steps delete
every deployment, all three cells, every tenant, both account registrations
and both applications, leaving the cell and tenant SSM namespaces in both
accounts empty; the runner then destroys its CloudFormation stacks, and with
them the demo shared parameters, by default.

## Steps

Every API operation runs at least once. The steps are those of spec §10, in
this order:

| # | Step | What it checks |
|---|---|---|
| 1 | Authentication | No vendor JWT: API Gateway answers 401 before any Lambda runs; `adminCreateUser`, `adminSetUserPassword`, `adminInitiateAuth` in the vendor IdP return an ID token that every later call carries |
| 2 | Applications | `PutApplication` with a missing script path is a 400 and with an id outside `[a-z0-9-]{1,32}` a 400; a lower-case parameter name, a duplicate, a required parameter with a default, a cell parameter without one, or one name in both lists is a 400; `PutApplication` X (with its declarations) and Y are 200 with `placementStrategy: FILL` and `cellCount: 0`; `ListApplications` shows both; `PutAccount` naming an unregistered application in `applicationIds` is a 404 (ADR-033) |
| 3 | Handshake and accounts | `PutAccount` for an account with no role pair is a 400 (R-26); `PutAccount` A as tenant-owned with an external id its pair does not require is a 400 naming the role (ADR-030); `PutAccount` B as tenant-owned without an external id is a 400 (ADR-029) and with the wrong one a 400 naming the role; `PutAccount` A (vendor-owned, 2 cells, shared) and B (tenant-owned, 1 cell, external id, `applicationIds: [Y]`) are 200; `ListAccounts` shows both at 0/n with B's allowlist; `GetAccount` B reports only that an external id is set |
| 4 | Tenants are synchronous | `CreateTenant` T1, T2, T3 are 200 with `deploymentCount: 0`; `ListTenants` shows three and `ListCells` none; `UpdateTenant` T3 edits metadata; `DeleteTenant` T3 is 200; `CreateDeployment` for T3 is a 404, and for an unregistered application a 404 |
| 5 | Implicit creation in the home account | `CreateDeployment` T1/X without `ALLOWED_EMAIL_DOMAIN`, or with an undeclared parameter, is a 400; with it and a `clientToken` (202) it creates cell 1 in A; `GetDeployment` polls to ACTIVE and returns the stamped definition, the account and the stored value only; `GetCell` names X and A; A is 1/2, X has one cell, T1 one deployment; the cell namespace and `/application-plane/tenants/<T1>/integ-x` exist in A; the tenant create build got `PARAM_ALLOWED_EMAIL_DOMAIN` and `PARAM_LOG_LEVEL=info`, the cell create build `PARAM_CELL_SIZE=small` and nothing else |
| 6 | One tenant, two applications | `CreateDeployment` T1/Y untargeted creates cell 2 in A (cell 1 serves X; B is tenant-owned); neither build got a `PARAM_` variable; A is 2/2, Y has one cell, T1 two deployments; `ListCells?applicationId=` and `ListDeployments?tenantId=` / `?applicationId=` filter; each cell read its own application's shared parameter and T1's two deployments wrote disjoint tenant namespaces; T1/X again is a 409; `DeleteTenant` T1 is a 409 (occupied) |
| 7 | Idempotent replay | The identical T1/X request with the same `clientToken` returns the original deployment, already ACTIVE, in cell 1; the same token with Y, or with another `ALLOWED_EMAIL_DOMAIN`, is a 409; A is still 2/2 and T1 still at two (ADR-017) |
| 8 | Fleet full for one application | `CreateDeployment` T2/X untargeted is a 409 `InsufficientCapacityError` (A full, B tenant-owned, ADR-026) |
| 9 | Admission | `CreateDeployment` T2/X with `accountId` B is a 400 (B admits only Y, ADR-033); still two cells, T2 at zero |
| 10 | Targeted creation in the second account | `CreateDeployment` T2/Y with `accountId` B creates cell 3 in B; `DeleteDeployment` while CREATING is a 409 (in-flight guard); polls to ACTIVE; neither build got a `PARAM_` variable; `GetCell` names Y and B; the cell namespace and `/application-plane/tenants/<T2>/integ-y` exist in B and not in A, so the scripts ran under B's role pair; B is 1/1 and Y has two cells |
| 11 | Account full and occupied guards | `CreateTenant` T4, then `CreateDeployment` T4/Y at B is a 409 `InsufficientCapacityError`; `DeleteAccount` B and `DeleteApplication` Y are 409 (occupied); `PutAccount` B with another owner is a 409 (owner immutable); `DeleteTenant` T4 is 200 |
| 12 | Reads | `ListCells` returns three cells with their application and account; `ListCells?accountId=A` returns cells 1 and 2, an unknown account an empty page, two filters a 400; `ListDeployments?cellId=` and `?applicationId=Y` filter, an unknown cell gives an empty page, two filters a 400; `UpdateTenant` T1 edits metadata and leaves `deploymentCount` at two; `PutApplication` Y with `maxTenants: 3` and `ROUND_ROBIN` keeps its `cellCount`, and cell 3 keeps its stamped `maxTenants: 1` (P-4) |
| 13 | Re-apply across accounts | `UpdateDeployment` T1/X (in A) and `UpdateCell` on cell 3 (in B) answer 202 and poll back to ACTIVE; `UpdateDeployment` T1/X with `LOG_LEVEL=debug` keeps `ALLOWED_EMAIL_DOMAIN` and its build gets both; removing the required parameter, one name in both lists, `CELL_SIZE` on the deployment and a control character are each a 400, and the stored values are unchanged; `UpdateCell` on cell 1 with `CELL_SIZE=large` stores it and its build gets it, a tenant parameter or an undeclared name on `UpdateCell` is a 400, and removing `CELL_SIZE` gives the next build `small` again; cell 3's build got no `PARAM_` variable |
| 14 | Declarations change under live records | `PutApplication` X without the lists keeps both; with `LOG_LEVEL` defaulting to `warn` and `CELL_SIZE` to `medium`, `UpdateDeployment` T1/X removing `LOG_LEVEL` gets `warn` and `UpdateCell` on cell 1 gets `medium`; `PutApplication` X with `LOG_LEVEL` and a required `TIER`, and no `cellParameters`, keeps `CELL_SIZE`; `UpdateDeployment` T1/X is then a 400 naming `TIER` |
| 15 | Reuse before create | `DeleteCell` on the occupied cell 1 is a 409 (ADR-014); `DeleteDeployment` T1/X (which lacks `TIER`) polls to 404, its delete build got the stale `ALLOWED_EMAIL_DOMAIN` and `LOG_LEVEL=warn` and no `TIER`, and its tenant parameter is gone; cell 1 stays at 0/1, A at 2/2, X at one cell, T1 drops to one; `CreateDeployment` T2/X with `TIER=gold`, untargeted, reuses cell 1 (no new cell) |
| 16 | Teardown through the API | `DeleteDeployment` T2/X, T1/Y, T2/Y poll to 404 (T2/X's delete build got `TIER=gold` and `LOG_LEVEL=warn`, Y's builds no `PARAM_` variable); both tenants are at zero and the tenant namespaces are empty in A and B; `DeleteCell` 1, 2, 3 poll to 404 (cell 1's delete build got `CELL_SIZE=medium`); A is 0/2, B 0/1, X and Y at `cellCount: 0`, `ListCells` empty, the cell namespaces empty in both accounts; `DeleteTenant` T1 and T2, `DeleteAccount` A and B, `DeleteApplication` X and Y are 200; `ListTenants`, `ListAccounts` and `ListApplications` are empty |

Success is reported as one passing integration test.

## Runtime and cost

Expect about 55 minutes (deploy, the scenario's 21 CodeBuild builds, and
destroy) and well under a dollar per run: 21 short CodeBuild builds, a few
hundred DynamoDB and Lambda requests, and SSM standard parameters, all torn
down at the end. The three new-cell deployments each run two builds in one
execution and poll with a 30-minute budget; every other build polls with
15 minutes.

## After an interruption

If execution is interrupted, inspect active stacks containing
`control-plane-integ` in both accounts, and parameters under
`/application-plane/cells/` and `/application-plane/tenants/` in both
accounts (tenant parameters are
`/application-plane/tenants/<tenantId>/integ-x` and `.../integ-y`), before
removing test resources. The demo parameters under
`/application-plane/applications/integ-x/shared/` and
`/application-plane/applications/integ-y/shared/` belong to the stacks and go
with them. Delete the stacks with the account each lives in:
`control-plane-integ-account-b` with credentials for B (or through A's
credentials and B's bootstrap trust), the others in A.

If the runner process ends early, CloudFormation finishes whichever stack it
was deploying, and every stack it had deployed stays in A and B because the
runner never finished its destroy step. The `integ` task refuses to start until they are
gone.

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
| A build probe in A reads the `PARAM_` variables of each project's latest build, so the assertions see what each script received, including the delete scripts whose namespaces end empty | Nothing; it relies on the test running one build at a time |
| The external id is the fixed string `control-plane-integ-handshake` | The account owner generates a value and hands it to the operator out of band |
| A throwaway Cognito user pool stands in for the vendor IdP, and a pre token generation trigger adds `role: "operator"` | Configures its own vendor IdP to mint `role: "operator"` on operator tokens (ADR-018) and passes its issuer URL and audience |
| The operator is created and authenticated with Cognito admin APIs, with a password generated at run time | Signs operators in through its own IdP |
| Both applications are registered with an S3 bucket of the sample scripts as their source, read by both shared CodeBuild projects through `grantRead` | Registers each application with `PutApplication`, pointing its source at its own cell and tenant scripts |
| `demoApplicationIds` on both stacks publishes a stand-in shared parameter per application | The application plane publishes its own shared infrastructure under `/application-plane/applications/<applicationId>/shared/*` |
| `maxTenants: 1`, so every cell is a silo and the account cell limits are what fill up | Sets `maxTenants` per application |

# The Cell-Based Control Plane: deployment integration test

This file describes the sample's deployment integration test, as the
[sample standard §5.3](../../docs/sample-standard.md#53-integration-test-document-integration-testmd)
lays it out. The [README](./README.md) carries the command and a link here.

## What it is

[`test/integ.tenant.ts`](./test/integ.tenant.ts) is an
[AWS CDK integration test](https://docs.aws.amazon.com/cdk/api/v2/docs/integ-tests-alpha-readme.html),
driven by `@aws-cdk/integ-runner` through the projen `integ` task. It deploys
temporary infrastructure into **two real, non-production AWS accounts** and
exercises the complete application, account, tenant, deployment, cell and
hook lifecycle with **three applications**, as the acceptance scenario of
[spec §10](./design/control-plane.spec.md#10-acceptance-criteria) describes.
Account A is the one your credentials point at (the control plane's own,
registered as vendor-owned and shared); account B is a second account named
by `CP_INTEG_ACCOUNT_B` (registered as tenant-owned, behind an external id,
and dedicated to one application).

Each run takes its own fleet name, `cp-integ-<run id>`, and names its
applications after the run id: `x-<run id>` (X), `y-<run id>` (Y) and
`z-<run id>` (Z). X and Y share one source and one set of scripts and
differ in id and in their parameter declarations: X declares
`ALLOWED_EMAIL_DOMAIN` (required), `LOG_LEVEL` (default `info`) and the
cell parameter `CELL_SIZE` (default `small`); Y declares none. Both have
`maxTenants: 1`. Z, registered in step 16, uses Y's source and scripts with
`maxTenants: 2`, three parameters that steer its hooks, and two application
hooks.

Per [sample standard §5.2](../../docs/sample-standard.md#52-integration-test)
the test is the reference implementation of this sample's wiring: how the
vendor IdP, the applications' script source, the run-time registration of
applications, accounts and global hooks, the hook roles and their policies,
and the account role pair in a second account fit together is read from
that file, not from prose.

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
fails fast when either required variable is unset, and when a stack of
this run's fleet name already exists in account A: such a stack belongs to
an interrupted run with the same run id, whose leftovers must be removed
first (After an interruption).

The run lasts about one hour 45 minutes. Start it from a shell that
outlives it (for example `nohup`, `tmux` or `screen`), with credentials
that last as long.

```bash
export AWS_REGION=eu-central-1
export CP_INTEG_ACCOUNT_B=<ACCOUNT_B_ID>
npx projen integ
```

| Knob | Default | Effect |
|---|---|---|
| `AWS_REGION` | none (required) | The single Region the test deploys to and runs in, in both accounts |
| `CP_INTEG_ACCOUNT_B` | none (required) | The second, tenant-owned test account (12 digits, different from the account the credentials point at) |
| `CP_INTEG_RUN_ID` | generated per run | The run id: `[a-z0-9]{1,23}`, without `aws`, `amazon` or `cognito`. It makes the fleet name `cp-integ-<run id>`, at most 32 characters within the `fleetName` pattern `[a-z0-9][a-z0-9-]{0,31}`, and a user pool domain prefix Cognito accepts |
| `CDK_DEFAULT_ACCOUNT` | resolved by the task with `sts get-caller-identity` | Account A |

The `integ` task always runs integ-runner with `--force` and
`--update-on-failed`. The integ-runner snapshot
(`test/integ.tenant.ts.snapshot/`) is intentionally not committed: it is
generated output that would ship megabytes of bundled third-party code (a
vendored AWS CLI layer, esbuild-bundled custom-resource handlers) with the
sample. Because the task always runs with `--force`, no workflow depends on a
committed snapshot; your local snapshot is kept (gitignored) to speed up
repeated runs.

### Parallel runs

Two runs can share accounts A and B and one Region. The run's fleet name
is in every stack name, the assertion stack's test name included, is the
`fleetName` of the stack under test and of the role pair the account B
stack installs, and is in every other name the test creates that must be
unique in an account or a Region: the probe role in B, the hook test paths
and policies, and the user pool domain prefix. The stack under test names
its roles, build projects and workflow after the fleet (spec R-41), so
those differ per run as well. The application ids carry the run id because
an application id is at most 32 characters, too short for the fleet name
plus a suffix, and the parameter paths it names
(`/application-plane/applications/<id>/shared/` from `demoApplicationIds`,
`/application-plane/tenants/<tenantId>/<id>`) are per account and Region.
The leftover check looks for that run's stacks only, and a check that a
parameter namespace ends empty looks at that run's applications, cells and
tenants only. Each run uses its own checkout or worktree, because
integ-runner writes its snapshot and `cdk.out` beside the test.

Runs in one account and Region share its quotas, and those limit how many
fit at once: CodeBuild's concurrent builds per account and Region, which
every run's script builds and hook builds draw on, and the API Gateway
control plane request rate, which a deploy of several REST APIs at once can
exceed.

They also share state that per-run names do not separate. The stack under
test's REST API creates the API Gateway CloudWatch role and the
`AWS::ApiGateway::Account` setting that names it. That setting is one per
account and Region, goes to whichever run deployed last, and CDK retains
both when the stack is deleted. The role and the setting are expected
leftovers, outside the per-run leftover check.

## What it stands up

`<fleet>` below is the run's fleet name, `cp-integ-<run id>`.

| Stack | Account | Contents |
|---|---|---|
| `<fleet>-setup` | A | A throwaway Cognito user pool as the vendor IdP, with a pre token generation trigger that adds the `role` claim: `operator` for the operator user (ADR-018), `control-plane:reader` for the reader user, and a value in neither list for a third user (ADR-042), on the V3 event and the Essentials plan; a domain whose prefix carries the fleet name, a resource server with the `control-plane/read` and `control-plane/other` scopes and two client-credentials machine clients allowed both, whose access tokens get `control-plane:reader` (ADR-043); a machine probe that fetches a client's token and makes one API call, returning the status, the token's `aud`/`sub` facts and its `scope`, never the secret or the token; an S3 bucket hosting `scripts/sample-cell`, `scripts/sample-tenant` and the test-only `test/integ-scripts/hook` and `test/integ-scripts/z-tenant` scripts, the source every application and hook is registered with; the two hook test policies (below); a probe function that assumes a test-only read role in B to count SSM parameters there; a build probe that returns the `PARAM_` variables of a CodeBuild project's latest build; a ledger probe that reads what the test's hooks recorded together with the start time of every script build, so the assertions can check the order hooks and scripts ran in |
| `<fleet>` | A | The stack under test: `TenantStack` with `fleetName: <fleet>`, the two vendor IdP inputs, `vendorIdpClientIds` naming the first machine client, `vendorIdpRequiredScope: "control-plane/read"`, `readerRoles: ["control-plane:reader"]`, `globalHookManagedPolicyArns` and `appHookManagedPolicyArns` naming one test policy each, and `demoApplicationIds` naming X and Y, which publishes each application's demo shared parameter in A (ADR-034); the provisioning and hook projects may read the test bucket; it installs the home account's role pair (R-25) and outputs `ApiFunctionName` and `StateMachineArn`. No application or hook is a stack input: the test registers them through the API |
| `<fleet>-account-b` | B | `CellAccountStack` with `fleetName: <fleet>`: the account role pair trusting A's build roles and API role by ARN, behind the fixed external id `control-plane-integ-handshake`, with `demoApplicationIds` naming Y (B hosts cells of Y only); plus the test-only probe read role, named after the fleet |
| the integ-tests-alpha assertion stack (`DeployAssert`) | A | The API calls and polls that drive the steps below; its test name carries the fleet name |

The two hook test policies exist before the stack under test, because the
stack validates both hook inputs at synth. Each lets its hook role write SSM
parameters under that scope's test path in A (under `/cp-integ/<fleet>/hooks/`) and nowhere else, which is
where step 16's hooks record what they saw. The application hook policy
also allows `states:StartExecution` on the workflow, named by its computed
ARN `arn:<partition>:states:<region>:<account>:stateMachine:<fleet>-workflow`,
and `lambda:InvokeFunction` on every function of the account, so step 16
can show the stack's deny overriding both allows.

The test reuses nothing that exists in either account. Its own steps delete
every deployment, all four cells, every tenant, every global hook, both
account registrations and all three applications, leaving the cell and
tenant SSM namespaces in both accounts empty; the runner then destroys its
CloudFormation stacks, and with them the demo shared parameters, the hook
test parameters and the hook test policies, by default.

## Steps

Every API operation runs at least once. The steps are those of spec §10, in
this order:

| # | Step | What it checks |
|---|---|---|
| 1 | Authentication and grants | No vendor JWT: API Gateway answers 401 before any Lambda runs; `adminCreateUser`, `adminSetUserPassword`, `adminInitiateAuth` in the vendor IdP return an ID token that every later call carries, and the same for a reader user and an unlisted-role user. Once step 4's tenants exist: the reader's first call, `CreateTenant`, returns 403, and its `ListTenants`, `GetTenant` and `GetApplication` then return 200 (the cached policy depends on the grant, not the first method); its `UpdateTenant`, `DeleteTenant` and `PutApplication` return 403; the unlisted role's `ListTenants` and `CreateTenant` return 403; the operator then reads three tenants and T1 unchanged. Once their resources exist (step 5's deployment and cell, step 16's hook), the reader's other `GET` operations return 200, so all twelve are proven (R-36). The listed machine client's token has no `aud` and a `sub` equal to its client id; it returns 200 on `ListTenants` and `GetTenant` and 403 on `CreateTenant`; its token for `control-plane/other` alone and the unlisted machine client's token return 403 on `ListTenants` (R-38) |
| 2 | Applications | `PutApplication` with a missing script path, a script path holding a control character or a source location with userinfo is a 400, and with an id outside `[a-z0-9-]{1,32}` a 400; a lower-case parameter name, a duplicate, a required parameter with a default, a cell parameter without one, or one name in both lists is a 400; `PutApplication` X (with its declarations) and Y are 200 with `placementStrategy: FILL` and `cellCount: 0`; `ListApplications` shows both; `PutAccount` naming an unregistered application in `applicationIds` is a 404 (ADR-033) |
| 3 | Handshake and accounts | `PutAccount` for an account with no role pair is a 400 (R-26); `PutAccount` A as tenant-owned with an external id its pair does not require is a 400 naming the role (ADR-030); `PutAccount` B as tenant-owned without an external id is a 400 (ADR-029) and with the wrong one a 400 naming the role; `PutAccount` A (vendor-owned, 2 cells, shared) and B (tenant-owned, 1 cell, external id, `applicationIds: [Y]`) are 200; `ListAccounts` shows both at 0/n with B's allowlist; `GetAccount` B reports only that an external id is set |
| 4 | Tenants are synchronous | `CreateTenant` T1, T2, T3 are 200 with `deploymentCount: 0`; `ListTenants` shows three and `ListCells` none; `UpdateTenant` T3 edits metadata; `DeleteTenant` T3 is 200; `CreateDeployment` for T3 is a 404, and for an unregistered application a 404 |
| 5 | Implicit creation in the home account | `CreateDeployment` T1/X without `ALLOWED_EMAIL_DOMAIN`, or with an undeclared parameter, is a 400; with it and a `clientToken` (202) it creates cell 1 in A; `GetDeployment` polls to ACTIVE and returns the stamped definition, the account and the stored value only; `GetCell` names X and A; A is 1/2, X has one cell, T1 one deployment; the cell namespace and `/application-plane/tenants/<T1>/<X>` exist in A; the tenant create build got `PARAM_ALLOWED_EMAIL_DOMAIN` and `PARAM_LOG_LEVEL=info`, the cell create build `PARAM_CELL_SIZE=small` and nothing else |
| 6 | One tenant, two applications | `CreateDeployment` T1/Y untargeted creates cell 2 in A (cell 1 serves X; B is tenant-owned); neither build got a `PARAM_` variable; A is 2/2, Y has one cell, T1 two deployments; `ListCells?applicationId=` and `ListDeployments?tenantId=` / `?applicationId=` filter; each cell read its own application's shared parameter and T1's two deployments wrote disjoint tenant namespaces; T1/X again is a 409; `DeleteTenant` T1 is a 409 (occupied) |
| 7 | Idempotent replay | The identical T1/X request with the same `clientToken` returns the original deployment, already ACTIVE, in cell 1; the same token with Y, or with another `ALLOWED_EMAIL_DOMAIN`, is a 409; A is still 2/2 and T1 still at two (ADR-017) |
| 8 | Fleet full for one application | `CreateDeployment` T2/X untargeted is a 409 `InsufficientCapacityError` (A full, B tenant-owned, ADR-026) |
| 9 | Admission | `CreateDeployment` T2/X with `accountId` B is a 400 (B admits only Y, ADR-033); still two cells, T2 at zero |
| 10 | Targeted creation in the second account | `CreateDeployment` T2/Y with `accountId` B creates cell 3 in B; `DeleteDeployment` while CREATING is a 409 (in-flight guard); polls to ACTIVE; neither build got a `PARAM_` variable; `GetCell` names Y and B; the cell namespace and `/application-plane/tenants/<T2>/<Y>` exist in B and not in A, so the scripts ran under B's role pair; B is 1/1 and Y has two cells |
| 11 | Account full and occupied guards | `CreateTenant` T4, then `CreateDeployment` T4/Y at B is a 409 `InsufficientCapacityError`; `DeleteAccount` B and `DeleteApplication` Y are 409 (occupied); `PutAccount` B with another owner is a 409 (owner immutable); `DeleteTenant` T4 is 200 |
| 12 | Reads | `ListCells` returns three cells with their application and account; `ListCells?accountId=A` returns cells 1 and 2, an unknown account an empty page, two filters a 400; `ListDeployments?cellId=` and `?applicationId=Y` filter, an unknown cell gives an empty page, two filters a 400; `UpdateTenant` T1 edits metadata and leaves `deploymentCount` at two; `PutApplication` Y with `maxTenants: 3` and `ROUND_ROBIN` keeps its `cellCount`, and cell 3 keeps its stamped `maxTenants: 1` (P-4) |
| 13 | Re-apply across accounts | `UpdateDeployment` T1/X (in A) and `UpdateCell` on cell 3 (in B) answer 202 and poll back to ACTIVE; `UpdateDeployment` T1/X with `LOG_LEVEL=debug` keeps `ALLOWED_EMAIL_DOMAIN` and its build gets both; removing the required parameter, one name in both lists, `CELL_SIZE` on the deployment and a control character are each a 400, and the stored values are unchanged; `UpdateCell` on cell 1 with `CELL_SIZE=large` stores it and its build gets it, a tenant parameter or an undeclared name on `UpdateCell` is a 400, and removing `CELL_SIZE` gives the next build `small` again; cell 3's build got no `PARAM_` variable |
| 14 | Declarations change under live records | `PutApplication` X without the lists keeps both; with `LOG_LEVEL` defaulting to `warn` and `CELL_SIZE` to `medium`, `UpdateDeployment` T1/X removing `LOG_LEVEL` gets `warn` and `UpdateCell` on cell 1 gets `medium`; `PutApplication` X with `LOG_LEVEL` and a required `TIER`, and no `cellParameters`, keeps `CELL_SIZE`; `UpdateDeployment` T1/X is then a 400 naming `TIER` |
| 15 | Reuse before create | `DeleteCell` on the occupied cell 1 is a 409 (ADR-014); `DeleteDeployment` T1/X (which lacks `TIER`) polls to 404, its delete build got the stale `ALLOWED_EMAIL_DOMAIN` and `LOG_LEVEL=warn` and no `TIER`, and its tenant parameter is gone; cell 1 stays at 0/1, A at 2/2, X at one cell, T1 drops to one; `CreateDeployment` T2/X with `TIER=gold`, untargeted, reuses cell 1 (no new cell) |
| 16 | Hooks | `ListHooks` is empty. `PutHook` with an unknown event, a phase outside `PRE`/`POST`, a timeout of 4 or 31, a script path with a space, a source location with userinfo or a source ref holding a control character is a 400; a reader's `PutHook` is a 403, nothing written. `PutHook` G (`POST`, all six events) is 200 with `revision: 1`, re-sent unchanged `revision: 2`, and `GetHook` G returns it at revision 2. `PutAccount` A with `maxCells: 3`. `PutApplication` Z with `HOOK_FAIL` (default `no`), `API_FUNCTION_NAME` and `WORKFLOW_ARN` (defaults from the stack outputs) and two application hooks, `a-pre` (`PRE`, `DEPLOYMENT_DELETE`, fails when `HOOK_FAIL` is `yes`) and `b-post` (`POST`, `DEPLOYMENT_CREATE`, fails when it is `post`); a third hook with a repeated id is a 400. `CreateDeployment` T1/Z creates cell 4 in A, and the sequence stamps read: cell create script, G on `CELL_CREATE`, tenant create script, `b-post`, G on `DEPLOYMENT_CREATE`. `b-post` saw the R-42 environment for T1 in cell 4 in A, `ATTEMPT=1`, `PARAM_HOOK_FAIL=no` and `SCRIPT_OUTPUTS={"endpoint":"<T1>.example.com"}`, the compact form of what the script wrote to `OUTPUTS_FILE`; G on `CELL_CREATE` saw no `TENANT_ID` and `SCRIPT_OUTPUTS={}`. Each hook ran as its own hook role, never a provisioning role; `b-post` was refused an SSM write under the global test path, `states:StartExecution` on the workflow, and an unqualified and a `$LATEST` invoke of the API function with a forged `GET /hooks` event, each `AccessDenied` despite its test policy's allow. `GetCell` 4 shows the two stamped hooks, and `GetCell` 4 and `GetDeployment` T1/Z report `lastGlobalHooks` with G at revision 2 and the commit its build ran. `UpdateDeployment` T1/Z returns to ACTIVE and G recorded `DEPLOYMENT_UPDATE` under another `EXECUTION_ID`. `PutHook` P (`PRE`, `DEPLOYMENT_CREATE`, always fails): `CreateDeployment` T2/Z with `HOOK_FAIL=yes` lands in cell 4 and ends `CREATE_FAILED` naming `GLOBAL/P`, with no script run and no tenant namespace. `DeleteHook` P is 200, `GetHook` P a 404. `DeleteDeployment` T2/Z: `a-pre` fails with `ATTEMPT` 1, 2 and 3, the skip is logged and counted, the tenant delete script runs, the record goes and G recorded `DEPLOYMENT_DELETE` after the script. `CreateDeployment` T2/Z with `HOOK_FAIL=post` ends `CREATE_FAILED` naming `APPLICATION/b-post`, with the tenant namespace in place and no G for it; its `DeleteDeployment` runs `a-pre`, which passes, and empties the namespace. `DeleteDeployment` T1/Z: `a-pre` recorded before the script, G after it. `ListHooks` shows G alone |
| 17 | Teardown through the API | `DeleteDeployment` T2/X, T1/Y, T2/Y poll to 404 (T2/X's delete build got `TIER=gold` and `LOG_LEVEL=warn` and no `ALLOWED_EMAIL_DOMAIN`, Y's builds no `PARAM_` variable); every tenant is at zero and the tenant namespaces are empty in A and B; `DeleteCell` 1 to 4 poll to 404 (cell 1's delete build got `CELL_SIZE=medium`), and G recorded a `CELL_DELETE` for every cell; A is 0/3, B 0/1, X, Y and Z at `cellCount: 0`, `ListCells` empty, the cell namespaces empty in both accounts; `DeleteHook` G, `DeleteTenant` T1 and T2, `DeleteAccount` A and B, `DeleteApplication` X, Y and Z are 200; `ListTenants`, `ListAccounts`, `ListApplications` and `ListHooks` are empty |

Success is reported as one passing integration test.

### Asynchronous records and hooks on record events (specified, not built)

[ADR-045](./adr/0045-run-hooks-on-application-tenant-and-account-events.md)
makes `PutApplication`, `DeleteApplication`, `CreateTenant`,
`UpdateTenant`, `DeleteTenant`, `PutAccount` and `DeleteAccount`
asynchronous and runs hooks on their events
([spec §8.4](./design/control-plane.spec.md#84-record-events)). The
vendor hook steps of ADR-044 (spec §10 step 16) are not in the table
above either; both land with the hook build. Until then the steps are as
written. Once built:

- Each of the seven calls answers 202 with the record and its `status`.
  The test polls `GetApplication`, `GetTenant` or `GetAccount` to
  `ACTIVE` before a later call uses the record, and a delete to 404.
  That changes steps 2, 3, 4, 11, 12, 14 and 16 above, which assert
  200 today. A call with no hook takes seconds, so the run grows by the
  hook builds of the new step, not by the polls.
- Step 3 also checks that `PutAccount` with 101 `applicationIds` is a
  400.
- A new step before teardown (spec §10 step 17) registers two global
  hooks: R, a pre hook on `TENANT_CREATE` and `TENANT_UPDATE` that
  fails when `TENANT_NAME` is `blocked`, and N, a post hook on
  `ACCOUNT_CREATE`. A tenant named `blocked` polls to `CREATE_FAILED`
  naming R, cannot be deployed (409) and is deleted; a tenant T5 polls
  to `ACTIVE`, and an update renaming it `blocked` polls to
  `UPDATE_FAILED` with the old name kept and no `pending`. The step
  adds an application post hook `c-post` on `APPLICATION_UPDATE` to
  application Z of spec §10 step 16; the put polls through `UPDATING`
  to `ACTIVE`, a second put while `UPDATING` is a 409, and `c-post` sees
  `EVENT = APPLICATION_UPDATE`, `SCRIPT_OUTPUTS = {}` and no cell. An
  application hook on a tenant or account event is a 400.
- Teardown (spec §10 step 18) registers B again after its delete, so N
  runs on `ACCOUNT_CREATE` and records B's id, `TENANT` as owner and
  Y's id as the admitted list, and no variable holding the external id;
  B is then deleted again.
- Not tested, by choice of four new steps only: a hook on an
  `APPLICATION_DELETE`, `TENANT_DELETE` or `ACCOUNT_DELETE` event (the
  retry-and-skip path that keeps cleanup reachable), any hook on
  `ACCOUNT_UPDATE`, `DELETE_FAILED` on an application, a tenant or an
  account, a `PutAccount` rotation on an `UPDATING` account, and a
  workflow start with an unknown outcome. Spec §10 lists them; unit
  assertions cover the record delete's two writes, the commit replay,
  the rotation, the unknown start and a start that went through after
  all.

## Runtime and cost

Expect about one hour 45 minutes per run, an estimate from the scenario's
build count: deploy, 29 script builds, 21 hook builds and destroy. A run
without the hook steps took about 51 minutes in all (the last green run in
the [`architecture.md` status block](./architecture.md#verification-status):
2026-11-16, eu-central-1, every step of the scenario without hooks). Steps
16 and 17 add eight script builds and 21 hook builds, which run one at a
time. A hook build is polled every 60 seconds, so each takes about two
minutes, and `a-pre`'s retries add three minutes of backoff: about 55
minutes more. The cost stays well under a dollar: 50 short CodeBuild builds
on the smallest compute type, Step Functions transitions (three per hook
minute), a few hundred DynamoDB and Lambda requests, and SSM standard
parameters, all torn down at the end.

## After an interruption

If execution is interrupted, inspect the stacks whose names start with the
run's fleet name (`cp-integ-<run id>`) in both accounts, and the parameters
under `/application-plane/cells/` and `/application-plane/tenants/` in both
accounts that belong to that run's cells and tenants (tenant parameters are
`/application-plane/tenants/<tenantId>/<application id>` for the run's
`x-`, `y-` and `z-<run id>` applications), before removing test resources.
Leave other runs' stacks and parameters alone. The demo parameters under
`/application-plane/applications/<application id>/shared/`, the hook test
parameters and the hook test policies belong to the stacks and go with them.
Delete the stacks with the account each lives in: `<fleet>-account-b` with
credentials for B (or through A's credentials and B's bootstrap trust), the
others in A.

If the runner process ends early, CloudFormation finishes whichever stack it
was deploying, and every stack it had deployed stays in A and B because the
runner never finished its destroy step. A rerun with the same run id refuses
to start until they are gone. Hook builds the workflow had started stop by
themselves within their run and queued timeouts; the hook projects go with
the stack under test.

After a complete run the test harness still leaves default Lambda log
groups in A, from the setup stack's custom resources and probe functions and
from integ-runner's assertion provider, with names under `/aws/lambda/`
that carry the fleet name; the sample's own functions write to explicit log
groups the stack owns and leave nothing. Delete them by prefix; they hold
test output only (README, Known issues).

## Test-only shortcuts

| In the test | What a consumer does instead |
|---|---|
| Account B's CDK bootstrap trusts account A with the `AdministratorAccess` execution policy, so one runner deploys the role pair into B | A customer deploys `CellAccountStack` with their own credentials in their own account; no cross-account bootstrap trust exists |
| A probe read role in B lets a probe function in A count SSM parameters there | Nothing: the control plane never reads a customer's account; the probe exists only so the assertions can see what the scripts wrote |
| A build probe in A reads the `PARAM_` variables of each project's latest build, so the assertions see what each script received, including the delete scripts whose namespaces end empty | Nothing; it relies on the test running one build at a time |
| The external id is the fixed string `control-plane-integ-handshake` | The account owner generates a value and hands it to the operator out of band |
| A throwaway Cognito user pool stands in for the vendor IdP, and a pre token generation trigger picks the `role` value from the user name | Configures its own vendor IdP to mint `role: "operator"` on operator tokens (ADR-018) and its reader value on the reader client's tokens (ADR-042), lists its own machine clients in `vendorIdpClientIds` (ADR-043), and passes its issuer URL and audience |
| A machine probe reads each machine client's secret from the user pool with `DescribeUserPoolClient`, gets its token from the token endpoint and makes one call | Each machine client keeps its secret in a secrets store, rotates it, and fetches its own token (T38) |
| The operator is created and authenticated with Cognito admin APIs, with a password generated at run time | Signs operators in through its own IdP |
| Every application and hook is registered with an S3 bucket of the sample and test scripts as its source, read by the provisioning and hook projects through `grantRead` | Registers each application with `PutApplication` and each hook with `PutHook` or in the application's `hooks`, pointing each source at its own repository or bucket, pinned to a commit |
| `demoApplicationIds` on both stacks publishes a stand-in shared parameter per application | The application plane publishes its own shared infrastructure under `/application-plane/applications/<applicationId>/shared/*` |
| `maxTenants: 1` on X and Y, so every cell is a silo and the account cell limits are what fill up | Sets `maxTenants` per application |
| The application hook test policy allows `states:StartExecution` on the workflow and `lambda:InvokeFunction` on every function, so the test can show the stack's deny overriding both | Attaches only least-privilege policies to the hook roles, never one over the control plane's own resources (T41) |
| The test reads the stack outputs `ApiFunctionName` and `StateMachineArn` and hands them to Z's hooks as parameter defaults, because a hook receives neither name | Nothing; a hook has no business with the control plane's own function or workflow |
| Hooks record what they saw as SSM parameters under a test path, and the hook P and the `HOOK_FAIL` parameter fail hooks on demand | Hooks act on their own downstream systems and fail only for a reason of their own |

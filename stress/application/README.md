<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Stress application: the cell account owner's half

What the owner of a standalone cell account deploys before the platform
stress test can build cells in it ([spec](../../docs/stress-test.spec.md)
§3.7 and §8, decision 7; stress
[ADR-0006](../adr/0006-deploy-cells-through-a-scoped-cell-bootstrap.md) and
[ADR-0011](../adr/0011-give-the-roles-a-cell-creates-a-workload-boundary-without-iam.md)).
This folder replaces the policies of the two spikes in
[`../spikes/`](../spikes/), which stay as the record of their runs.

It also holds the stress application (W-5, spec §3.1): the control-plane
application whose cell scripts deploy one runtime-isolation cell through the
role pair and the cell bootstrap, and whose tenant scripts subscribe one
tenant on its cell. The control-plane slice
(`samples/control-plane/scripts/stress/`) registers it and runs it.

| File | What it is |
|---|---|
| [`cell-policies.ts`](./cell-policies.ts) | the five cell policies as typed policy documents, and their names |
| [`cell-account.cdk.ts`](./cell-account.cdk.ts) | the owner stacks: `CellPolicies` and `CellAccountBase` |
| [`cell-path.ts`](./cell-path.ts) | `CellRolePath`, the aspect that puts every role on `/cell/`, and `cellSynthContext`, the context a cell app synthesises with |
| [`cell-probe.cdk.ts`](./cell-probe.cdk.ts) | the two probe stacks `probes.sh` runs against, with their decoys |
| [`owner-app.ts`](./owner-app.ts), [`probe-app.ts`](./probe-app.ts) | the CDK apps the scripts run |
| [`deploy-owner.sh`](./deploy-owner.sh), [`bootstrap-cell.sh`](./bootstrap-cell.sh) | steps 1 and 2 below |
| [`probe-deploy.sh`](./probe-deploy.sh), [`probes.sh`](./probes.sh), [`probe-remove.sh`](./probe-remove.sh) | step 3 below |
| [`role-pair.ts`](./role-pair.ts), [`role-pair-app.ts`](./role-pair-app.ts), [`deploy-role-pair.sh`](./deploy-role-pair.sh) | step 4 below: control-plane's role pair, as plain CloudFormation |
| [`cell-app.ts`](./cell-app.ts), [`cell-stack.ts`](./cell-stack.ts) | the stress application's cell: the runtime-isolation demo stack for the cell bootstrap |
| [`scripts/cell/`](./scripts/cell/create.sh), [`scripts/tenant/`](./scripts/tenant/create.sh), [`scripts/lib.sh`](./scripts/lib.sh) | the stress application's cell and tenant scripts |

## The policies

| Policy | On | Holds |
|---|---|---|
| `cell-execution-policy` | the cell bootstrap's CloudFormation execution role | the services a cell deploys (API Gateway, Application Auto Scaling, AgentCore, CloudWatch, DynamoDB, KMS, Lambda, CloudWatch Logs, SSM), IAM read, read of the `cdk-cell-assets-*` bucket, IAM role writes on `role/cell/*`, `iam:CreateRole` and `iam:PutRolePermissionsBoundary` there only with the workload boundary, `iam:PassRole` of `role/cell/*` to Lambda and AgentCore only, and the two service-linked roles (`ops.apigateway.amazonaws.com`, `runtime-identity.bedrock-agentcore.amazonaws.com`) |
| `cell-permissions-boundary` | the same execution role, as its boundary | the same deploy-time services and IAM role writes; it assumes no role and holds none of the run-time calls. It denies a role without the workload boundary, any IAM role write, `iam:PassRole` or `sts:AssumeRole` outside `role/cell/*`, `iam:PassRole` to any other service, other service-linked roles, boundary removal, users, access keys, policy writes, Lambda function URLs with `AuthType NONE`, SSM writes to `/application-plane/shared/identity/*` and `/cdk-bootstrap/cell/*`, and changes to the API Gateway account setting |
| `cell-workload-boundary` | every role a cell creates (ADR-0011) | the run-time services, read of the cell asset bucket, `sts:AssumeRole` on `role/cell/*` only; denies every IAM action, `sts:AssumeRole` outside `role/cell/*`, resource-policy and sharing writes (Lambda permissions and function URLs, KMS key policies and grants, CloudWatch Logs resource policies, subscription filters, destinations, account policies, log deliveries and export tasks, DynamoDB resource policies and table exports, SSM, AgentCore and X-Ray resource policies), Lambda function URLs with `AuthType NONE`, the owner's parameters and the API Gateway account setting |
| `cell-build-policy` | the role pair's cell role, through control-plane's `cellBuildManagedPolicyArns` (control-plane ADR-0047) | `sts:AssumeRole` on `cdk-cell-deploy-role-*`, `cdk-cell-file-publishing-role-*` and `cdk-cell-image-publishing-role-*` of the account and Region, and `sts:TagSession` on the same roles with the `CellId` key only; not the lookup role. `sts:TagSession` because the cell build's session carries a transitive `CellId` tag, and chaining with it needs that action on the caller (control-plane ADR-0051) |
| `cell-tenant-build-policy` | the role pair's tenant role, through control-plane's `tenantBuildManagedPolicyArns` (ADR-0012) | `execute-api:Invoke` on `GET`, `PUT` and `DELETE` `/entitlements/tenants/*` of the account's APIs in the Region: a cell's tenant subscriptions, not its plans, agents or tools |

The tests in [`../test/cell-policies.test.ts`](../test/cell-policies.test.ts)
pin every deny, the `iam:PassRole`, boundary and service-linked-role
conditions, and the names.

`CellAccountBase` holds the API Gateway account's CloudWatch Logs role and
setting (every runtime-isolation stage logs), and, when given, the identity
parameters a cell reads: `/application-plane/shared/identity/userPoolId` and
`appClientId`, naming the stress identity (stress ADR-0002). For a platform
run it also holds the ingress reader role (spec §3.5), when given the
platform account id (`PLATFORM_ACCOUNT_ID`): a role on `/` that the platform
account's root may assume, with one allow, `ssm:GetParameter` on
`parameter/application-plane/shared/agent-runtime/StressCell-*/ingress` in the
stack's Region, and the output `IngressReaderRoleArn`. That is the parameter
each cell's ingress publishes (`publishParameters` off puts it under the
stack's own name, `StressCell-<cell id>`); its value is one JSON document with
`baseUrl`. The account check lists roles on `/cell/` only, so it takes this
role without a change; it still wants the stack's ARN on the list of
account-base stacks.

Both owner stacks use the CDK's legacy synthesizer: the CLI deploys their
asset-free templates inline with your credentials, so the account never needs
a default CDK bootstrap. Both carry the stack tag `stress:part=account-base`,
which the control-plane slice's account check looks for. Give the check
their stack ARNs (W-11).

## Deploy it in a cell account

You need:

- a standalone, non-production account that holds nothing else (spec §3.7);
- the account owner's credentials (an administrator role) as an AWS CLI
  profile;
- the AWS CLI v2, `zip`, Node.js 24, and this repository cloned.

Every script prints the caller's account first: check it is the cell account
before you go on. Run all the steps from `stress/`, in one shell:

```bash
cd stress
npm ci
export AWS_PROFILE=<cell account profile> AWS_REGION=eu-central-1
```

1. Deploy the owner stacks. Give the stress identity's user pool and app
   client to write the identity parameters a cell reads, or leave both
   variables out and run the step again with them later. For a platform run
   also give the platform account id, which adds the ingress reader role (the
   script then prints its ARN as `IngressReaderRoleArn=`):

   ```bash
   CELL_USER_POOL_ID=<stress identity pool id> CELL_APP_CLIENT_ID=<its app client id> PLATFORM_ACCOUNT_ID=<platform account id> application/deploy-owner.sh
   ```

   `CELL_OWNER_STACKS=base` deploys `CellAccountBase` alone and leaves
   `CellPolicies` out of the app: use it to add the identity or the reader
   role to an account whose policies are in place, without touching them.

   For the run dashboard (stress ADR-0022) also give `OBSERVABILITY_SINK_ARN`, the ARN that
   [`dashboard/deploy-sink.sh`](../dashboard/README.md) printed in the platform account. `CellAccountBase`
   then holds one observability link that shares the account's `AWS/Lambda`, `AWS/Bedrock-AgentCore` and
   `StressCell` metrics with that sink, and no log group. It makes no role in this account. Without it the
   dashboard shows no cell account. The cell app also adds metric filters on the cell's own log lines
   (`cell-metrics.ts`), which publish the `StressCell` metrics; no filter has a tenant, user, agent or token
   dimension.

2. Bootstrap the cell qualifier against the policies:

   ```bash
   application/bootstrap-cell.sh
   ```

   It runs `cdk bootstrap aws://<account>/<region> --qualifier cell
   --toolkit-stack-name CDKToolkit-cell --cloudformation-execution-policies
   <cell-execution-policy ARN> --custom-permissions-boundary
   cell-permissions-boundary` from an empty folder, and stops if a policy is
   missing.

3. Probe the policies, then remove the probe stacks:

   ```bash
   application/probe-deploy.sh
   application/probes.sh
   application/probe-remove.sh
   ```

   `probes.sh` prints one `PASS` or `FAIL` line per probe and ends with
   `probes passed: <n> failed: 0`; `probe-remove.sh` ends with
   `no probe leftovers`. "Probe the policies" below says what they check.

4. Deploy the control-plane role pair: control-plane's own
   `CellAccountStack`, `<fleet>-cell-account`, as plain CloudFormation with
   your credentials (the CDK's legacy synthesizer, no service role, no CDK
   bootstrap). Its two roles stay on `/` without a cell boundary; the cell
   role gets `cell-build-policy` and the tenant role
   `cell-tenant-build-policy`. The fleet name is the control-plane slice's
   `STRESS_PREFIX` in lower case, and the trust names the platform account:

   ```bash
   STRESS_FLEET_NAME=<fleet> CONTROL_PLANE_ACCOUNT_ID=<platform account id> application/deploy-role-pair.sh
   ```

   It installs `samples/control-plane`'s dependencies when they are missing,
   because the stack is that sample's code. Then give the control-plane
   slice the account: its id, a profile with read access, and the stack ARNs
   of `CellPolicies` and `CellAccountBase` (the slice's README).

   The pair's trust requires the build's session tags (control-plane
   ADR-0051), so the pair and the control plane must come from versions that
   agree on them. Before the first run on a platform deployed from a newer
   control-plane version, run step 1 again (`cell-build-policy` must allow
   `sts:TagSession` on the cell bootstrap roles) and then this step, in every
   cell account, with no build between that and the platform deploy. A pair
   that does not match fails every build at AssumeRole; a
   `cell-build-policy` without `sts:TagSession`, or a cell bootstrap whose
   role trust lacks it, fails it at the `cdk deploy`. Check with
   `aws iam get-role --role-name cdk-cell-deploy-role-<ACCOUNT_ID>-<REGION>`;
   if its trust lacks `sts:TagSession`, run step 2 again (it uses the CDK
   CLI pinned in `stress/package.json`, whose template has it) before step 4
   (control-plane README, "Upgrading to session-tagged builds").

To change a policy, edit `cell-policies.ts` and run step 1 again: the
managed policies get a new version in place. `CELL_POLICY_SUFFIX` (for
example `-v2`) deploys a second set of names beside the first, for an
account that already has policies by the default names; every script and
the cell synth context then need the same suffix, and step 2 must run again.

### Bring back a tenant build policy left behind

A deploy of `CellPolicies` from a version without `cell-tenant-build-policy`
cannot delete that policy while the role pair holds it: CloudFormation leaves
it behind, and the next step 1 fails on the name. Bring it back under the
stack instead of deleting it. Run it from `stress/`, in the same shell as the
steps above (the cell account owner's `AWS_PROFILE` and `AWS_REGION`), with
the account id and the same `CELL_POLICY_SUFFIX` the owner stacks use (empty
for none), so the policy name in the mapping and in the template agree:

```bash
export CELL_POLICY_SUFFIX=<suffix>
echo "{\"CellTenantBuildPolicy37F02D91\":{\"PolicyArn\":\"arn:aws:iam::<account>:policy/cell-tenant-build-policy${CELL_POLICY_SUFFIX}\"}}" > /tmp/import.json
npx cdk --app "npx ts-node --transpile-only application/owner-app.ts" import CellPolicies --resource-mapping /tmp/import.json --output cdk.application.out/import --force
```

The import applies no other change in the template, so run step 1 again
afterwards (`application/deploy-owner.sh` with the same suffix) to bring the
rest of `CellPolicies` up to date.

## Add a second Region to a cell account

The cell policies and the role pair are not Region-free. `cell-policies.ts`
names the Region's cell asset bucket (`cdk-cell-assets-<account>-<Region>`) in
the execution policy and both boundaries, and the cell build policy names that
Region's bootstrap roles (`cdk-cell-deploy-role-<account>-<Region>` and the two
publishing roles). IAM names are account-wide, so a second `CellPolicies`
under the same names fails, and one set serves one Region. The role pair has
fixed role names too (`<fleet>-cell-provisioning`, `<fleet>-tenant-provisioning`),
so a fleet's pair exists once per account. A cell account therefore takes a
second Region as a second, complete set: a policy suffix and a fleet name that
the account does not hold yet, which is what the W-10 run did for the
policies (`-w10r`, below). Run each step in the second Region, in the cell
account owner's shell, from `stress/`:

```bash
export AWS_PROFILE=<cell account profile> AWS_REGION=<second Region> CELL_POLICY_SUFFIX=<new suffix>
```

1. The owner stacks with the new suffix, the identity of that Region (SSM
   parameters are per Region, and the stress identity's user pool must be in
   the Region of the cells that trust it) and the platform account id:

   ```bash
   CELL_USER_POOL_ID=<pool id in this Region> CELL_APP_CLIENT_ID=<its app client id> PLATFORM_ACCOUNT_ID=<platform account id> application/deploy-owner.sh
   ```

   Stacks are per Region, so `CellPolicies` and `CellAccountBase` are new
   stacks here; only the policy names need the new suffix.
2. `application/bootstrap-cell.sh`, which bootstraps `CDKToolkit-cell` in this
   Region against the suffixed policies.
3. The role pair of the run's fleet name, with a fleet name the account holds
   no pair for (`STRESS_FLEET_NAME=<fleet> CONTROL_PLANE_ACCOUNT_ID=<platform account id> application/deploy-role-pair.sh`). The run's `STRESS_CELL_POLICY_SUFFIX` is the new suffix.
4. Give the run the reader role of this Region: the `IngressReaderRoleArn` step 1
   printed (each Region's base stack has its own role, and its policy names only
   that Region's parameters), as `ingressReaderRoleArn` of the account in the
   cell accounts file.
5. Add the stack ARNs of this Region to that account's `accountBaseStackArns`:
   the account check lists the stacks of every Region, and refuses a stack
   tagged account-base that is not on the list. The base stack ARN of each
   Region used goes there, with the `CellPolicies` ARN of each set.

`CELL_OWNER_STACKS=base` is not a way round the suffix: it leaves the policies
out, and the policies of the first Region name that Region's bucket and roles.
Widening them to every Region (a wildcard Region in `assetStatement` and
`cellBuildBootstrapRoleArns`) would let one set and one pair serve all
Regions of a cell account, at the price of a wider grant in each, and it is not
done here.

## Probe the policies

`probe-deploy.sh` deploys `CellBoundaryProbe`, an owner stack with one role,
`cell/cell-policy-probe`, under the cell permissions boundary: it stands in
for the execution role, which cannot create a role under its own boundary.
Its trust refuses every `/cell/` principal, so no cell role can assume it;
only principals outside `/cell/`, such as the account owner, can. The same
stack holds the decoys: `cell-policy-probe-decoy`, a role on `/` with no
policy that only the probe roles may assume, and a managed policy of the
same name, attached to nothing. It then deploys `CellWorkloadProbe`
through the cell bootstrap, with the cell synth context, so the execution
role creates its three roles on `/cell/` under the workload boundary. Both
probe roles hold an identity policy that allows, on `*`, every action the
probes call.

Every write a deny probe tries lands on something the account does not use:
the decoys, new parameter names under the owner's paths, or the API Gateway
account setting set to the value it already has. A probe that names a
`cdk-cell-*` bootstrap role only tries to assume it. So a probe that a
regressed policy lets through changes nothing that matters, and
`probe-remove.sh` lists what it left (users, policies, roles, functions,
parameters, log resource policies and destinations, and the Elastic Load
Balancing service-linked role, which a cell account never uses) and exits 1.
Look at the policy before you remove those by hand.

`probes.sh` assumes each probe role, checks that the CLI really runs as it
and stops otherwise, and counts a deny probe as passed only when the error
names an explicit deny in a permissions boundary. The one exception is the
workload probe's attempt to assume the stand-in, which the stand-in's trust
refuses. It retries a throttled call. `probe-remove.sh` removes the two
probe stacks, and only stacks tagged `stress:part=cell-policy-probe`.

| As | Probe | Expected |
|---|---|---|
| cell boundary | `iam:UpdateAssumeRolePolicy`, `iam:PutRolePolicy`, `iam:AttachRolePolicy` `AdministratorAccess` on the decoy role on `/` | denied |
| cell boundary | `sts:AssumeRole` of the decoy role and of `cdk-cell-deploy-role` | denied |
| cell boundary | `iam:PassRole` of the decoy role to Lambda | denied |
| cell boundary | `iam:PassRole` of a `/cell/` role to CloudWatch Logs (`logs:PutDestination`), a service the cell does not pass roles to | denied |
| cell boundary | `iam:CreateRole` on `/`; on `/cell/` without a boundary; on `/cell/` with the cell permissions boundary | denied |
| cell boundary | `iam:PutRolePermissionsBoundary` with `AdministratorAccess`, or with the cell permissions boundary, on a `/cell/` role | denied |
| cell boundary | `iam:CreateServiceLinkedRole` for another service; `iam:DeleteRolePermissionsBoundary` on itself | denied |
| cell boundary | `iam:CreatePolicyVersion`, `iam:SetDefaultPolicyVersion` on the decoy policy; `iam:CreateUser`; `iam:CreateAccessKey`; `iam:CreatePolicy` | denied |
| cell boundary | `ssm:PutParameter` under `/application-plane/shared/identity/` and `/cdk-bootstrap/cell/`; `apigateway:PATCH` `/account` | denied |
| cell boundary | `lambda:CreateFunctionUrlConfig` and `lambda:AddPermission` with `AuthType NONE` | denied |
| cell boundary | `iam:CreateServiceLinkedRole` for API Gateway; `iam:UpdateRoleDescription` on a `/cell/` role; `iam:CreateRole` on `/cell/` with the workload boundary, then `iam:DeleteRole`; `iam:PutRolePermissionsBoundary` of a `/cell/` role to the workload boundary; `iam:PassRole` of a `/cell/` role to Lambda (`lambda:CreateFunction`, deleted at the end); `iam:GetRole` on the decoy | allowed |
| workload boundary | `iam:UpdateRoleDescription`, `iam:PutRolePolicy` on a `/cell/` role; `iam:CreateRole` on `/cell/` with the workload boundary | denied |
| workload boundary | `iam:PassRole` of a `/cell/` role to Lambda; `iam:CreateServiceLinkedRole` for API Gateway; `iam:DeleteRolePermissionsBoundary` on itself | denied |
| workload boundary | `sts:AssumeRole` of `cdk-cell-deploy-role` and of the decoy role | denied |
| workload boundary | `sts:AssumeRole` of the execution role's stand-in, `cell/cell-policy-probe` | refused by its trust |
| workload boundary | `ssm:PutParameter` under `/application-plane/shared/identity/` and `/cdk-bootstrap/cell/`; `apigateway:PATCH` `/account` | denied |
| workload boundary | `lambda:AddPermission` on a cell function; `lambda:CreateFunctionUrlConfig` with `AuthType NONE`; `logs:PutResourcePolicy`; `dynamodb:PutResourcePolicy`; `kms:PutKeyPolicy` | denied |
| workload boundary | `sts:AssumeRole` of a `/cell/` tenant role, as the TVM does | allowed |

## The stress application

The control-plane slice registers it as the application `stress` (spec §3.1,
§3.3), with an S3 source: the repository at the run's commit, as one zip with
runtime-isolation's generated Smithy code (ADR-0014). Every script runs in
the platform account's control-plane CodeBuild projects, under the cell
account's role pair, and logs ids and timings only.

| Script | Runs as | Does |
|---|---|---|
| `scripts/cell/create.sh` (and `update.sh`) | the role pair cell role | installs the runtime-isolation sample, synthesises `cell-app.ts` (every role on `/cell/` under the workload boundary, qualifier `cell`) and deploys `StressCell-<cell id>` through `CDKToolkit-cell`; publishes the stack name and the Entitlements API base URL under `/application-plane/cells/<cell id>/`; with the cell parameter `DISTRIBUTION_ARN` also deploys the cell API origin and publishes its host as `api-domain` there, and writes `{"stackName", "frontDoorApiDomain"}` to `OUTPUTS_FILE` |
| `scripts/cell/delete.sh` | the role pair cell role, then the cell bootstrap's deploy role | deletes the cell stack under the bootstrap's execution role, the role that created it, with no install or synth; removes the cell's parameters (`stack`, `entitlements-api-url`, `api-domain`) |
| `scripts/tenant/create.sh` (and `update.sh`) | the role pair tenant role | `PutTenantSubscription` for the tenant on its cell's Entitlements API, SigV4, with the agents and tools of the tenant parameters `AGENTS` and `TOOLS` (default `default` and none); records the tenant, cell and subscription version under `/application-plane/tenants/<tenant id>/stress/state`, a child of the tenant namespace, which the front door cell API's hosts check reads (ADR-0012) |
| `scripts/tenant/delete.sh` | the role pair tenant role | `DeleteTenantSubscription` and the record |

The cell is the runtime-isolation demo stack with the `api-gateway` ingress
and the TVM, `publishParameters` off, so cells in one account do not
overwrite each other's parameters. The cell parameter `CELL_POLICY_SUFFIX`
carries the owner stacks' policy suffix (`STRESS_CELL_POLICY_SUFFIX` of the
slice). `cell-app.ts` loads one copy of the CDK: the cell script installs
only the runtime-isolation sample and runs the app with `NODE_PATH` set to its
`node_modules`, and the app refuses to run when this package's `aws-cdk-lib`
would load too.

### The cell API origin (platform mode)

With the cell parameter `DISTRIBUTION_ARN` (the tenant front door's edge
distribution; empty is slice mode, and the cell is as above) the cell app adds
a `DemoCellApi` from `samples/tenant-front-door/src/demo-cell/` to the cell
stack (spec §3.3, step 2): a Lambda function with an `AWS_IAM` function URL,
the permissions that let that distribution, and only it, invoke the URL, and
the per-tenant counter table. It trusts the stress identity: the cell script
reads `/application-plane/shared/identity/userPoolId` and `appClientId`, which
the account base writes, and passes them to the app with the distribution ARN.
The stack's output `FrontDoorApiDomain` is the URL's host. The cell script
checks it against `^[a-z0-9]{32}\.lambda-url\.<Region>\.on\.aws$` before it
publishes `/application-plane/cells/<cell id>/api-domain` and writes it to the
outputs file.

The cell API's function is bundled by the CDK from tenant-front-door's folder.
The cell build still installs only the runtime-isolation sample:
`link_front_door_modules` in `scripts/lib.sh` links tenant-front-door's
`node_modules` to the sample's, so `esbuild`, `jose` and the SDK clients
resolve in that one install. The bundle uses the sample's `jose` 5.10.0, not
tenant-front-door's 6.2.10.

## Results

### W-5: the role pair, the account check, Q-1 and the control-plane slice

Region `eu-central-1`; the platform account and the cell accounts A and B
of the W-10 run below; fleet `stressw5`, `CELL_POLICY_SUFFIX=-w10`.

| Step | Account A | Account B |
|---|---|---|
| `deploy-owner.sh` (`CellPolicies` with `cell-tenant-build-policy`, `CellAccountBase`) | `CellPolicies` had been redeployed without the tenant build policy, which CloudFormation could not delete while the pair held it; brought back with `cdk import` ([Bring back a tenant build policy left behind](#bring-back-a-tenant-build-policy-left-behind)), then `deploy-owner.sh`: no change left | 37 s |
| `deploy-role-pair.sh` (`stressw5-cell-account`) | no change (5 s) | no change (4 s) |
| `probe-deploy.sh`, `probes.sh`, `probe-remove.sh` | 53 s and 51 s; 50 of 50 pass; no probe leftovers | 50 s and 52 s; 50 of 50 pass; no probe leftovers |
| `PutAccount` handshake through the pair | `ACTIVE` | not registered (`small` uses one cell account) |
| Account check, with the owner's account-base list and the `-w10` suffix, reading the pair's policies and trust | passed (6 stacks, 67 roles) | passed (6 stacks, 66 roles) |
| Account check, with a list that leaves out the two `*-spike` account-base stacks | refused: both `*-spike` stacks are tagged account-base but not on the list | refused, the same |
| Account check, expecting the policies without the suffix | refused: each pair half holds a managed policy outside its stack's set and lacks the expected one | refused, the same |

The three account-check rows are from a separate account check at commit
`4f69c38`, 2026-11-20 19:48 UTC. Each slice run repeats the first row for
the cell accounts its tier uses.

The check refuses an account while `CellBoundaryProbe` is deployed: it is
none of the stacks a cell account may hold. `CellWorkloadProbe` deploys
through the cell bootstrap, so the check counts it as a cell. Remove the
probe stacks (step 3) before a run. The unit tests in
`samples/control-plane/test/stress/account-check.test.ts` cover the cases no
live account should be put into: a `cdk-hnb659fds-*` role, a role pair on
`/cell/`, under either cell boundary, holding a policy its stack did not
give it or with a widened trust, a `/cell/` role trusted from another
account, a federated principal, `*` or an unused service, a stack with
another service role, and a stack ARN from another Region or a recreated
stack. `stress/test/role-pair-app.test.ts` pins the role pair template.

Q-1, one cell built by the control plane's cell CodeBuild project into cell
account A (`BUILD_GENERAL1_SMALL`, 3,831 MiB, 2 vCPUs), one column per run;
the last column spans three earlier runs (the in-build lines of one were
not kept):

| | `20261120T142632Z` | Three earlier runs |
|---|---|---|
| `CreateDeployment` to the cell `ACTIVE` (the cell record's own times) | 486 s | 456 to 471 s |
| Install of the runtime-isolation sample (`npm ci`) | 20 s | 21 to 22 s |
| Synth of `cell-app.ts` | 10 s | 11 s |
| `cdk deploy` through `CDKToolkit-cell` | 421 s | 405 s |
| Container memory, peak | 1,977 MiB | 1,914 to 1,971 MiB |
| Cell stack create (CloudFormation events) | 403 s | 390 to 404 s |
| Cell stack delete by `scripts/cell/delete.sh` (CloudFormation events) | 519 s | 517 to 521 s |

`BUILD_GENERAL1_SMALL` holds the synth with half its memory to spare. The
cell's 27 roles are on `/cell/` under the workload boundary (the synth), and
the cell deploys with the role pair's cell role and `cell-build-policy` alone,
without the bootstrap's lookup role. The cell build's log holds ids,
timings and resource bundling lines, and none of the stack's outputs.

The slice runs (`./run.sh run --tier small --slices control-plane
--remove-fixtures`), from the results file the runner wrote:

| Run | Result | Deploy | Destroy | In all |
|---|---|---|---|---|
| `20261120T142632Z` | PASSED, pass criteria met | 223 s | 765 s (the cell delete is most of it) | 2,499 s |
| `20261120T194839Z` (commit `4f69c38`) | PASSED, pass criteria met | 203 s | 792 s (the cell delete is most of it) | 2,668 s |

| Run | Scenario | Requests | Isolation (mismatches / assertions) | Unattributed | Measured |
|---|---|---|---|---|---|
| `20261120T142632Z` | PS-1 | 65 | 0 / 63 | 0 | 20 of 20 onboarded in 550 s, the first with its cell; onboard p50 31 s once the cell is up; peak 19 operations in flight |
| `20261120T142632Z` | placement-race | 27 | 0 / 25 | 0 | 10 racers on 5 free slots: 5 placed, 5 refused `InsufficientCapacityError`, each attributed |
| `20261120T142632Z` | read-rate | 678 | 0 / 1,015 | 0 | 598 reads at 10 rps while 5 deployments were placed and tenants updated |
| `20261120T142632Z` | build-limit-scaling | 194 | 0 / 189 | 0 | 20 deployments in 152 s at limit 5, 49 s at 20, 48 s at 50 (one tenant build took about 25 s, so 20 ran at once at 20 and 50); 2 `DELETE_FAILED:retried` |
| `20261120T194839Z` | PS-1 | 74 | 0 / 63 | 0 | 20 of 20 placed in 647 s; the first, with its cell, `ACTIVE` after 516 s |
| `20261120T194839Z` | placement-race | 29 | 0 / 25 | 0 | 10 racers on 5 free slots: 5 placed, 5 refused `InsufficientCapacityError`, each attributed; 2 `500:internal-server` with the ambiguous-placement message, retried and attributed (ADR-0013) |
| `20261120T194839Z` | read-rate | 678 | 0 / 1,015 | 0 | 598 reads at 10 rps; 60 of 60 tenant updates accepted; 5 deployments placed |
| `20261120T194839Z` | build-limit-scaling | 202 | 0 / 189 | 0 | 20 deployments in 152 s at limit 5, 111 s at 20, 39 s at 50; 3 `DELETE_FAILED:retried` |

The limit-20 wave varies between runs. In `20261120T194839Z` a tenant
build at limit 20 took twice as long (onboard p50 59 s against 30 s at 5
and 50), so 20 builds in flight did not finish in one build's time. Limit 5
gave 152 s in both runs.

Leftovers after run `20261120T194839Z`: the same as below. Its teardown read
the retained API Gateway CloudWatch role from the stack and listed it, not
counted.

Leftovers after run `20261120T142632Z`: none of the slice's in either cell
account (cell stacks, cell and tenant parameters, `/cell/` roles: 0). In the
platform account no stack, project, state machine or `stressw5-*` role;
listed and not counted (control-plane README, Known issues): the API access
log groups and `SourceZipLogs` that late writes recreated, the setup stack's
default Lambda log groups of this and earlier runs, and one retained API
Gateway CloudWatch role per run.

### W-10: the cell policies and probes

Run 2026-11-20 in the two standalone non-production cell accounts (A and B)
the path spike used, in `us-west-2` with `CELL_POLICY_SUFFIX=-w10r`, beside
other cell stacks those accounts hold in `eu-central-1`. Stacks are per
Region, but IAM names are account-wide, so the second set of policies
takes its own suffix. `bootstrap-cell.sh` bootstrapped `CDKToolkit-cell`
in `us-west-2` against the `-w10r` policies. It names the policies, not
their versions, so a later policy change needs no new bootstrap.

| Step | Account A | Account B |
|---|---|---|
| `deploy-owner.sh` (`CellPolicies`, `CellAccountBase`, no identity parameters) | 74 s | 71 s |
| `bootstrap-cell.sh` | 55 s | 54 s |
| `probe-deploy.sh` (`CellBoundaryProbe`, `CellWorkloadProbe`) | 56 s and 54 s | 55 s and 60 s |
| `probes.sh` | 50 of 50 pass: 24 deny and 8 allowed as the cell boundary probe; 16 deny, 1 refused by the stand-in's trust and 1 allowed as the workload probe | 50 of 50 pass, the same |
| `probe-remove.sh` | 32 s and 33 s; no probe leftovers | 32 s and 32 s; no probe leftovers |
| runtime-isolation cell (`api-gateway`, `tvm=true`, `publishParameters=false`) in `eu-central-1`, through that Region's cell bootstrap and the `-w10` policies, with `CellRolePath` and `cellSynthContext` | `CREATE_COMPLETE` in 417 s; 27 of 27 roles on `/cell/` under the workload boundary; destroyed in 527 s, nothing left | not deployed |

The cell deploy ran once, in `eu-central-1` under the `-w10` set of the
same policies: the same execution policy and cell permissions boundary,
and a workload boundary without the denies on log deliveries, export
tasks, table exports and X-Ray resource policies. No role of the cell
calls those actions, so the cell was not deployed again. It needed no
change to deploy under the workload boundary: its 27 roles call no IAM
action, pass no role, write no resource policy, and assume only `/cell/`
roles. The cell app must load one copy of the CDK: the aspect and the
synth context register on the app's own `aws-cdk-lib`, so W-5's cell app
compiles these files against the sample's CDK (the cell deploy resolved
them through the sample's `node_modules`).

## Security scan

ProtoShield v0.18.0 (2026-11-20), with `stress/.protoshield/config.yaml`
and `--max-tokens 32000`, on `stress/` without `spikes/`: the spike files
are the record of their runs and are not deployed, and with them in scope
the IAM agent runs out of output tokens. Semgrep, secrets and license
headers: 0. CVE: 2 medium. IAM least privilege: 0 critical, 3 high. Every
phase completed.

| Finding | Outcome |
|---|---|
| Service wildcards (`apigateway:*`, `bedrock-agentcore:*`, `dynamodb:*`, `kms:*`, `lambda:*`, `logs:*`, `ssm:*`, ...) on `*`, in the execution policy, the cell permissions boundary and the workload boundary (high, 3) | Accepted. ADR-0006 chose standalone cell accounts so that IAM is the only thing scoped by resource: the account holds nothing but cells, the cell bootstrap, the role pair and these stacks, so the service grants reach only cells. The roles a cell creates carry their own narrow identity policies; the boundaries are the backstop. Their explicit denies keep every cell principal off IAM outside `/cell/` (and roles under the workload boundary off IAM entirely), off public function URLs, the owner's parameters and the API Gateway account setting, and keep cell roles off resource-policy writes, which the probes show. Listing actions one by one would break the next cell construct that calls a new action, with no gain inside a cell-only account. What stays open is under Known limitations. Never deploy these policies in an account that holds anything else |
| `minimatch` 10.2.6 (bundled in `aws-cdk-lib` and in the test tooling) and `glob` 10.5.0 (test tooling) in `stress/package-lock.json` (medium, 2) | Not this folder: both run on the deployer's machine at synth or test time and are not deployed; this change does not touch the lock file. A dependency update fixes them |

Two more grants are accepted for the same reason. The execution policy
and the cell permissions boundary hold `iam:Get*` and `iam:List*` on `*`:
CloudFormation reads roles and policies while it creates and updates the
cell's roles, and IAM reads expose no data in a cell-only account. The
workload boundary has none. The execution policy and both boundaries
allow `s3:ListBucket` on the cell asset bucket: the CDK lists it when it
publishes and reads assets, and it holds only cell assets.

## Known limitations

- The stress cell is the runtime-isolation demo stack: its agents and tool
  targets are the demo's, not the tier's `agentsPerCell` and tool counts.
  The tier-sized cell is W-3's stress ingress.
- The tenant scripts subscribe a tenant on its cell only. A platform run adds
  the tenant's identity (the control-plane driver, stress ADR-0017) and the
  front-door route (the route hook); this folder's scripts do neither.
- `cell-tenant-build-policy` reaches the tenant subscription methods of every
  API in the cell account, so a compromised tenant build can change any
  tenant's subscription on any cell there. The control plane's API role can
  assume the tenant role too (control-plane ADR-0028), so it holds the same
  reach (ADR-0012).
- Two control-plane defects shaped the slice (ADR-0013). A build over a
  project's concurrent build limit was refused, not queued, so every wave
  was paced at the limit. The control plane now waits for a free slot
  (control-plane ADR-0049), and `STRESS_UNPACED=1` sends a wave at once. A
  transaction conflict between concurrent operations on one cell surfaced
  as a 500 or a `*_FAILED` record, which the driver retries and counts.
  The workflow now retries a cancelled terminal write (ADR-0049), and the
  API sends a race-only cancellation again and then answers a retryable
  409 (control-plane ADR-0050).
- A cell is stamped with its source when it is created: a fixed cell or
  tenant script reaches an existing cell only after it is deleted and created
  again (ADR-0014).
- The request path under the workload boundary (authoriser, TVM, streamed
  answers) was served in a cell account by the first platform run at `small`
  (spec Q-5, `stress/results/2026-11-21-small.md`). Tool calls and model
  usage events are not counted apart in the record.
- The policies allow the cell's services on `*`. That is safe only in a
  standalone cell account that holds nothing but cells, the cell bootstrap,
  the role pair and these stacks (spec §3.7, ADR-0006); never deploy them in
  an account that holds anything else.
- The workload boundary blocks two optional runtime-isolation features: a
  tool target with OAuth or API-key outbound auth needs
  `secretsmanager:GetSecretValue`, and a tool target whose spec is in S3
  needs `s3:GetObject` outside the cell asset bucket. Neither is in the
  workload boundary, so such a cell deploys but its calls fail. Add the
  grant, scoped to the cell's secrets or bucket, before a cell uses them.
- The execution role, and so CloudFormation, can still write resource
  policies (it creates the cell's Lambda permissions and AgentCore resource
  policy), so a compromised cell build can share a cell resource with
  another account. Of those writes, the cell permissions boundary denies
  only public function URLs. The pre-run account check does not look at
  resource policies. The execution role also keeps `apigateway:*`, so a
  compromised cell build can publish an API method with no authorization.
- Under the workload boundary a compromised cell role can still read and
  write every cell's data in the account (DynamoDB, SSM outside the owner's
  paths, KMS use), invoke any cell function, and create or delete cell
  resources with the service grants (`lambda:CreateFunction` needs a passed
  role, which it cannot pass). That is the role pair's scope (ADR-0006).
- A compromised workload role can still send data out of the account: by
  calling a resource in another account whose own resource policy allows it
  (the `lambda:*`, `dynamodb:*` and `bedrock-agentcore:*` grants are on `*`),
  or from a function that runs outside a VPC and reaches the internet. An
  `aws:ResourceAccount` deny would close the first, but could break the
  Bedrock model calls, so it is not set.
- A new service in a cell that receives a passed role, or a cell role that
  needs any IAM permission or a resource-policy write, needs both
  boundaries changed before its first deploy (ADR-0011).
- `CellAccountBase` sets the account-wide API Gateway CloudWatch Logs role.
  A second stack that sets it too wins on its next deploy.
- The runtime-isolation cell was deployed once, before the workload
  boundary gained its last denies (log deliveries, export tasks, table
  exports, X-Ray resource policies). It was not deployed again under the
  final boundary. No cell role calls those actions, but the next cell
  deploy is the check.
- The security scan left out `spikes/`. With those files in scope the IAM
  agent runs out of output tokens. The spike files are the record of their
  runs and are not deployed.

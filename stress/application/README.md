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

The control-plane application with its cell and tenant scripts, and the
cell app that deploys runtime-isolation, are work item W-5. They build on
what is here: the `/cell/` path aspect and the cell synth context.

| File | What it is |
|---|---|
| [`cell-policies.ts`](./cell-policies.ts) | the four cell policies as typed policy documents, and their names |
| [`cell-account.cdk.ts`](./cell-account.cdk.ts) | the owner stacks: `CellPolicies` and `CellAccountBase` |
| [`cell-path.ts`](./cell-path.ts) | `CellRolePath`, the aspect that puts every role on `/cell/`, and `cellSynthContext`, the context a cell app synthesises with |
| [`cell-probe.cdk.ts`](./cell-probe.cdk.ts) | the two probe stacks `probes.sh` runs against |
| [`owner-app.ts`](./owner-app.ts), [`probe-app.ts`](./probe-app.ts) | the CDK apps the scripts run |
| [`deploy-owner.sh`](./deploy-owner.sh), [`bootstrap-cell.sh`](./bootstrap-cell.sh) | steps 1 and 2 below |
| [`probe-deploy.sh`](./probe-deploy.sh), [`probes.sh`](./probes.sh), [`probe-remove.sh`](./probe-remove.sh) | step 3 below |

## The policies

| Policy | On | Holds |
|---|---|---|
| `cell-execution-policy` | the cell bootstrap's CloudFormation execution role | the services a cell deploys (API Gateway, Application Auto Scaling, AgentCore, CloudWatch, DynamoDB, KMS, Lambda, CloudWatch Logs, SSM), IAM read, read of the `cdk-cell-assets-*` bucket, IAM role writes on `role/cell/*` (a boundary change only to the workload boundary, which the cell permissions boundary enforces), `iam:PassRole` of `role/cell/*` to Lambda and AgentCore only, and the two service-linked roles (`ops.apigateway.amazonaws.com`, `runtime-identity.bedrock-agentcore.amazonaws.com`) |
| `cell-permissions-boundary` | the same execution role, as its boundary | the same services plus the run-time calls (`execute-api`, the Bedrock model calls, `sts:TagSession`, X-Ray), `sts:AssumeRole` on `role/cell/*`; denies a role without the workload boundary, any IAM write, `iam:PassRole` or `sts:AssumeRole` outside `role/cell/*`, `iam:PassRole` to any other service, other service-linked roles, boundary removal, users, access keys, policy writes, SSM writes to `/application-plane/shared/identity/*` and `/cdk-bootstrap/cell/*`, and changes to the API Gateway account setting |
| `cell-workload-boundary` | every role a cell creates (ADR-0011) | the run-time services, `sts:AssumeRole` on `role/cell/*` only; denies every IAM action, `sts:AssumeRole` outside `role/cell/*`, the owner's parameters and the API Gateway account setting |
| `cell-build-policy` | the role pair's cell role, through control-plane's `cellBuildManagedPolicyArns` (control-plane ADR-0047) | `sts:AssumeRole` on `cdk-cell-deploy-role-*`, `cdk-cell-file-publishing-role-*` and `cdk-cell-image-publishing-role-*` of the account and Region; not the lookup role |

The tests in [`../test/cell-policies.test.ts`](../test/cell-policies.test.ts)
pin every deny, the `iam:PassRole` and service-linked-role conditions, and
the names.

`CellAccountBase` holds the API Gateway account's CloudWatch Logs role and
setting (every runtime-isolation stage logs), and, when given, the identity
parameters a cell reads: `/application-plane/shared/identity/userPoolId` and
`appClientId`, naming the stress identity (stress ADR-0002).

Both owner stacks use the CDK's legacy synthesizer: the CLI deploys their
asset-free templates inline with your credentials, so the account never needs
a default CDK bootstrap. Both carry the stack tag `stress:part=account-base`,
which the control-plane slice's account check looks for. Give the check
their stack ARNs (W-11).

## Deploy it in a cell account

You need a standalone, non-production account that holds nothing else
(spec §3.7), the account owner's credentials (an administrator role), the
AWS CLI, Node.js 24 and `npm ci` in `stress/`. Every script prints the
caller's account first: check it is the cell account before you go on.

1. Deploy the owner stacks:

   ```bash
   cd stress
   export AWS_PROFILE=<cell account profile> AWS_REGION=eu-central-1
   CELL_USER_POOL_ID=<stress identity pool id> CELL_APP_CLIENT_ID=<its app client id> application/deploy-owner.sh
   ```

   Leave out both identity variables to deploy without the identity
   parameters; set them later by running the script again with them.

2. Bootstrap the cell qualifier against the policies:

   ```bash
   application/bootstrap-cell.sh
   ```

   It runs `cdk bootstrap aws://<account>/<region> --qualifier cell
   --toolkit-stack-name CDKToolkit-cell --cloudformation-execution-policies
   <cell-execution-policy ARN> --custom-permissions-boundary
   cell-permissions-boundary` from an empty folder, and stops if a policy is
   missing.

3. Probe the policies (below), then deploy the control-plane role pair
   (`CellAccountStack`) with `cellBuildManagedPolicyArns` set to the
   `cell-build-policy` ARN. The role pair needs the control plane's account
   and handshake, so its stack belongs to W-5 and W-11; it stays on `/`,
   without a cell boundary.

To change a policy, edit `cell-policies.ts` and run step 1 again: the
managed policies get a new version in place. `CELL_POLICY_SUFFIX` (for
example `-v2`) deploys a second set of names beside the first, for an
account that already has policies by the default names; every script and
the cell synth context then need the same suffix, and step 2 must run again.

## Probe the policies

```bash
export CELL_ROLE_PAIR_ROLE=<the role pair's cell role name, on />
application/probe-deploy.sh
application/probes.sh
application/probe-remove.sh
```

`probe-deploy.sh` deploys `CellBoundaryProbe`, an owner stack with one role,
`cell/cell-policy-probe`, under the cell permissions boundary: it stands in
for the execution role, which cannot create a role under its own boundary.
It then deploys `CellWorkloadProbe` through the cell bootstrap, with the cell
synth context, so the execution role creates its three roles on `/cell/`
under the workload boundary. Both probe roles hold an identity policy that
allows every escalation on `*`.

`probes.sh` assumes each probe role, checks that the CLI really runs as it
and stops otherwise, and counts a deny probe as passed only when the error
names an explicit deny in a permissions boundary. `probe-remove.sh` removes
the two probe stacks, and only stacks tagged `stress:part=cell-policy-probe`.

| As | Probe | Expected |
|---|---|---|
| cell boundary | `iam:UpdateAssumeRolePolicy`, `iam:PutRolePolicy`, `iam:AttachRolePolicy` `AdministratorAccess` on the role pair | denied |
| cell boundary | `iam:PutRolePolicy`, `iam:AttachRolePolicy` `AdministratorAccess` on `cdk-cell-deploy-role` | denied |
| cell boundary | `sts:AssumeRole` of the role pair and of `cdk-cell-deploy-role` | denied |
| cell boundary | `iam:PassRole` of the role pair to Lambda | denied |
| cell boundary | `iam:PassRole` of a `/cell/` role to CloudWatch Logs (`logs:PutDestination`), a service the cell does not pass roles to | denied |
| cell boundary | `iam:CreateRole` on `/`; on `/cell/` without a boundary; on `/cell/` with the cell permissions boundary | denied |
| cell boundary | `iam:PutRolePermissionsBoundary` with `AdministratorAccess`, or with the cell permissions boundary, on a `/cell/` role | denied |
| cell boundary | `iam:CreateServiceLinkedRole` for another service; `iam:DeleteRolePermissionsBoundary` on itself | denied |
| cell boundary | `iam:CreatePolicyVersion` on either boundary; `iam:SetDefaultPolicyVersion` on the execution policy | denied |
| cell boundary | `ssm:PutParameter` over the identity pool id and the cell bootstrap version; `apigateway:PATCH` `/account` | denied |
| cell boundary | `iam:CreateServiceLinkedRole` for API Gateway; `iam:UpdateRoleDescription` on a `/cell/` role; `iam:CreateRole` on `/cell/` with the workload boundary, then `iam:DeleteRole`; `iam:GetRole` on the role pair | allowed |
| workload boundary | `iam:UpdateRoleDescription`, `iam:PutRolePolicy` on a `/cell/` role; `iam:CreateRole` on `/cell/` with the workload boundary | denied |
| workload boundary | `iam:PassRole` of a `/cell/` role to Lambda; `iam:CreateServiceLinkedRole` for API Gateway; `iam:DeleteRolePermissionsBoundary` on itself | denied |
| workload boundary | `sts:AssumeRole` of `cdk-cell-deploy-role` and of the role pair | denied |
| workload boundary | `ssm:PutParameter` over the identity pool id; `apigateway:PATCH` `/account` | denied |
| workload boundary | `sts:AssumeRole` of a `/cell/` tenant role, as the TVM does | allowed |

## Results

Run 2026-11-20, `eu-central-1`, in the two standalone non-production cell
accounts (A and B) the path spike used, with `CELL_POLICY_SUFFIX=-w10`,
because the spike's policies already held the default names there. The
role pair was the spike's stand-in, a role on `/` that trusts the account.

| Step | Account A | Account B |
|---|---|---|
| `deploy-owner.sh` (`CellPolicies`, `CellAccountBase`, no identity parameters: the spike's base stack holds them) | 62 s | 62 s |
| `bootstrap-cell.sh` (updates `CDKToolkit-cell` in place to the new policies) | 39 s | 39 s |
| `probe-deploy.sh` | 50 s and 50 s | 50 s and 51 s |
| `probes.sh` | 38 of 38 pass: 22 deny and 5 allowed as the cell boundary probe, 10 deny and 1 allowed as the workload probe | 38 of 38 pass, the same |
| `probe-remove.sh` | 32 s and 31 s; no probe role left | 32 s and 31 s; no probe role left |
| runtime-isolation cell (`api-gateway`, `tvm=true`, `publishParameters=false`) through the cell bootstrap, with `CellRolePath` and `cellSynthContext` | `CREATE_COMPLETE` in 407 s; 27 of 27 roles on `/cell/` under the workload boundary; destroyed in 527 s, nothing left | not deployed |

The first probe run in each account had one failure that was not the
policies: the workload probe's `apigateway:PATCH` `/account` came back
`TooManyRequestsException`, seconds after the cell probe's. `probes.sh` now
waits out throttling; the second run passed in both accounts.

The runtime-isolation cell needed no change to pass under the workload
boundary: its 27 roles call no IAM action, pass no role, and assume only
`/cell/` roles. The cell app must load one copy of the CDK: the aspect and
the synth context register on the app's own `aws-cdk-lib`, so W-5's cell app
compiles these files against the sample's CDK (the check above resolved
them through the sample's `node_modules`).

After these runs the execution policy gained `iam:PutRolePermissionsBoundary`
on `role/cell/*`, so a redeploy can move an existing cell role to a new
workload boundary. `deploy-owner.sh` updated both accounts in place (32 s
and 31 s). The probes were not run again: they assume the probe roles, not
the execution role, and neither boundary changed.

## Security scan

ProtoShield v0.18.0 on `stress/` (2026-11-20), with
`stress/.protoshield/config.yaml` and `--max-tokens 32000` (the IAM agent
ran out of output tokens at the default). Semgrep, CVE, secrets and license
headers: 0. IAM least privilege: 3 high, 3 medium, 1 info.

| Finding | Outcome |
|---|---|
| Service wildcards (`apigateway:*`, `bedrock-agentcore:*`, `dynamodb:*`, `kms:*`, `lambda:*`, `logs:*`, `ssm:*`, ...) on `*`, in the execution policy, the cell permissions boundary and the workload boundary (high, 3) | Accepted. ADR-0006 chose standalone cell accounts so that IAM is the only thing scoped by resource: the account holds nothing but cells, the cell bootstrap, the role pair and these stacks, so the service grants reach only cells. The roles a cell creates carry their own narrow identity policies; the boundaries are the backstop, and their explicit denies keep every cell principal off IAM outside `/cell/` (the workload boundary off IAM entirely), the owner's parameters and the API Gateway account setting, which the probes show. Listing actions one by one would break the next cell construct that calls a new action, with no gain inside a cell-only account. Never deploy these policies in an account that holds anything else |
| SSM Agent actions on `*`, `execute-api:Invoke` on the account's APIs, SSM parameter prefixes, in `driver/stress-driver.cdk.ts` (medium, 3) | Not this folder: the driver host role, unchanged by W-10 and acknowledged in its own code (stress ADR-0009) |
| The probe roles' `EveryEscalation` statement (info) | Intended: the probes need an identity policy that allows every escalation, so only a boundary can refuse. The probe stacks live for one probe run |

## Known limitations

- The request path under the workload boundary (authoriser, TVM, model
  call, tools) has not run in a cell account; the first platform run at
  `small` is the check (spec Q-5).
- The policies allow the cell's services on `*`. That is safe only in a
  standalone cell account that holds nothing but cells, the cell bootstrap,
  the role pair and these stacks (spec §3.7, ADR-0006); never deploy them in
  an account that holds anything else.
- A new service in a cell that receives a passed role, or a cell role that
  needs any IAM permission, needs both boundaries changed before its first
  deploy (ADR-0011).
- The probes need a role on `/` that trusts the account to aim at
  (`CELL_ROLE_PAIR_ROLE`); in a cell account that is the role pair's cell
  role.
- `CellAccountBase` sets the account-wide API Gateway CloudWatch Logs role.
  A second stack that sets it too wins on its next deploy.

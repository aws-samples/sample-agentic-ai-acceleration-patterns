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
| [`cell-policies.ts`](./cell-policies.ts) | the four cell policies as typed policy documents, and their names |
| [`cell-account.cdk.ts`](./cell-account.cdk.ts) | the owner stacks: `CellPolicies` and `CellAccountBase` |
| [`cell-path.ts`](./cell-path.ts) | `CellRolePath`, the aspect that puts every role on `/cell/`, and `cellSynthContext`, the context a cell app synthesises with |
| [`cell-probe.cdk.ts`](./cell-probe.cdk.ts) | the two probe stacks `probes.sh` runs against, with their decoys |
| [`owner-app.ts`](./owner-app.ts), [`probe-app.ts`](./probe-app.ts) | the CDK apps the scripts run |
| [`deploy-owner.sh`](./deploy-owner.sh), [`bootstrap-cell.sh`](./bootstrap-cell.sh) | steps 1 and 2 below |
| [`probe-deploy.sh`](./probe-deploy.sh), [`probes.sh`](./probes.sh), [`probe-remove.sh`](./probe-remove.sh) | step 3 below |

## The policies

| Policy | On | Holds |
|---|---|---|
| `cell-execution-policy` | the cell bootstrap's CloudFormation execution role | the services a cell deploys (API Gateway, Application Auto Scaling, AgentCore, CloudWatch, DynamoDB, KMS, Lambda, CloudWatch Logs, SSM), IAM read, read of the `cdk-cell-assets-*` bucket, IAM role writes on `role/cell/*`, `iam:CreateRole` and `iam:PutRolePermissionsBoundary` there only with the workload boundary, `iam:PassRole` of `role/cell/*` to Lambda and AgentCore only, and the two service-linked roles (`ops.apigateway.amazonaws.com`, `runtime-identity.bedrock-agentcore.amazonaws.com`) |
| `cell-permissions-boundary` | the same execution role, as its boundary | the same deploy-time services and IAM role writes; it assumes no role and holds none of the run-time calls. It denies a role without the workload boundary, any IAM role write, `iam:PassRole` or `sts:AssumeRole` outside `role/cell/*`, `iam:PassRole` to any other service, other service-linked roles, boundary removal, users, access keys, policy writes, Lambda function URLs with `AuthType NONE`, SSM writes to `/application-plane/shared/identity/*` and `/cdk-bootstrap/cell/*`, and changes to the API Gateway account setting |
| `cell-workload-boundary` | every role a cell creates (ADR-0011) | the run-time services, read of the cell asset bucket, `sts:AssumeRole` on `role/cell/*` only; denies every IAM action, `sts:AssumeRole` outside `role/cell/*`, resource-policy and sharing writes (Lambda permissions and function URLs, KMS key policies and grants, CloudWatch Logs resource policies, subscription filters and destinations, DynamoDB, SSM and AgentCore resource policies), Lambda function URLs with `AuthType NONE`, the owner's parameters and the API Gateway account setting |
| `cell-build-policy` | the role pair's cell role, through control-plane's `cellBuildManagedPolicyArns` (control-plane ADR-0047) | `sts:AssumeRole` on `cdk-cell-deploy-role-*`, `cdk-cell-file-publishing-role-*` and `cdk-cell-image-publishing-role-*` of the account and Region; not the lookup role |

The tests in [`../test/cell-policies.test.ts`](../test/cell-policies.test.ts)
pin every deny, the `iam:PassRole`, boundary and service-linked-role
conditions, and the names.

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
   variables out and run the step again with them later:

   ```bash
   CELL_USER_POOL_ID=<stress identity pool id> CELL_APP_CLIENT_ID=<its app client id> application/deploy-owner.sh
   ```

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

The control-plane role pair (`CellAccountStack`, with
`cellBuildManagedPolicyArns` set to the `cell-build-policy` ARN) comes next.
It needs the control plane's account and handshake, so its steps belong to
the control-plane slice (W-5, W-11); it stays on `/`, without a cell
boundary.

To change a policy, edit `cell-policies.ts` and run step 1 again: the
managed policies get a new version in place. `CELL_POLICY_SUFFIX` (for
example `-v2`) deploys a second set of names beside the first, for an
account that already has policies by the default names; every script and
the cell synth context then need the same suffix, and step 2 must run again.

## Probe the policies

`probe-deploy.sh` deploys `CellBoundaryProbe`, an owner stack with one role,
`cell/cell-policy-probe`, under the cell permissions boundary: it stands in
for the execution role, which cannot create a role under its own boundary.
The same stack holds the decoys: `cell-policy-probe-decoy`, a role on `/`
with no policy that only the probe roles may assume, and a managed policy of
the same name, attached to nothing. It then deploys `CellWorkloadProbe`
through the cell bootstrap, with the cell synth context, so the execution
role creates its three roles on `/cell/` under the workload boundary. Both
probe roles hold an identity policy that allows every escalation on `*`.

Every write a deny probe tries lands on something the account does not use:
the decoys, new parameter names under the owner's paths, or the API Gateway
account setting set to the value it already has. A probe that names a
`cdk-cell-*` bootstrap role only tries to assume it. So a probe that a
regressed policy lets through changes nothing that matters, and
`probe-remove.sh` lists what it left (users, policies, roles, functions,
parameters, log resource policies and destinations) and exits 1. Look at
the policy before you remove those by hand.

`probes.sh` assumes each probe role, checks that the CLI really runs as it
and stops otherwise, and counts a deny probe as passed only when the error
names an explicit deny in a permissions boundary. It retries a throttled
call. `probe-remove.sh` removes the two probe stacks, and only stacks tagged
`stress:part=cell-policy-probe`.

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
| workload boundary | `ssm:PutParameter` under `/application-plane/shared/identity/` and `/cdk-bootstrap/cell/`; `apigateway:PATCH` `/account` | denied |
| workload boundary | `lambda:AddPermission` on a cell function; `lambda:CreateFunctionUrlConfig` with `AuthType NONE`; `logs:PutResourcePolicy`; `dynamodb:PutResourcePolicy`; `kms:PutKeyPolicy` | denied |
| workload boundary | `sts:AssumeRole` of a `/cell/` tenant role, as the TVM does | allowed |

## Results

Run 2026-11-20, `eu-central-1`, in the two standalone non-production cell
accounts (A and B) the path spike used, with `CELL_POLICY_SUFFIX=-w10`,
because the spike's policies already held the default names there.
`CDKToolkit-cell` in both accounts was bootstrapped against the `-w10`
policies by `bootstrap-cell.sh` (39 s each) on the first run; the policy
names have not changed since, so it was not run again.

| Step | Account A | Account B |
|---|---|---|
| `deploy-owner.sh` (`CellPolicies`, `CellAccountBase`, no identity parameters: the spike's base stack holds them); updates the policies in place | 37 s | 37 s |
| `probe-deploy.sh` (`CellBoundaryProbe`, `CellWorkloadProbe`) | 50 s and 52 s | 50 s and 50 s |
| `probes.sh` | 49 of 49 pass: 24 deny and 8 allowed as the cell boundary probe, 16 deny and 1 allowed as the workload probe | 49 of 49 pass, the same |
| `probe-remove.sh` | 31 s and 31 s; no probe leftovers | 31 s and 32 s; no probe leftovers |
| runtime-isolation cell (`api-gateway`, `tvm=true`, `publishParameters=false`) through the cell bootstrap, with `CellRolePath` and `cellSynthContext`, under the boundaries as shipped | `CREATE_COMPLETE` in 417 s; 27 of 27 roles on `/cell/` under the workload boundary; destroyed in 527 s, nothing left | not deployed |

The runtime-isolation cell needed no change to deploy under the workload
boundary: its 27 roles call no IAM action, pass no role, write no resource
policy, and assume only `/cell/` roles. The cell app must load one copy of
the CDK: the aspect and the synth context register on the app's own
`aws-cdk-lib`, so W-5's cell app compiles these files against the sample's
CDK (the check above resolved them through the sample's `node_modules`).

Earlier runs of the same day, before the review fixes (decoys, the
resource-policy and function URL denies, the narrower cell permissions
boundary), passed 38 of 38 probes in both accounts, and a cell deployed in
407 s and was destroyed in 527 s. One first run hit
`TooManyRequestsException` on the API Gateway account setting; `probes.sh`
now retries throttled calls.

## Security scan

ProtoShield v0.18.0 on `stress/` (2026-11-20, after the review fixes), with
`stress/.protoshield/config.yaml` and `--max-tokens 32000` (the IAM agent
runs out of output tokens at the default). Semgrep, CVE, secrets and
license headers: 0. IAM least privilege: 0 critical, 6 high, 3 medium,
2 low; every phase completed.

| Finding | Outcome |
|---|---|
| Service wildcards (`apigateway:*`, `bedrock-agentcore:*`, `dynamodb:*`, `kms:*`, `lambda:*`, `logs:*`, `ssm:*`, ...) on `*`, in the execution policy, the cell permissions boundary and the workload boundary (high, 3) | Accepted. ADR-0006 chose standalone cell accounts so that IAM is the only thing scoped by resource: the account holds nothing but cells, the cell bootstrap, the role pair and these stacks, so the service grants reach only cells. The roles a cell creates carry their own narrow identity policies; the boundaries are the backstop. Their explicit denies keep every cell principal off IAM outside `/cell/` (the workload boundary off IAM entirely), off public function URLs, the owner's parameters and the API Gateway account setting, and keep cell roles off resource-policy writes, which the probes show. Listing actions one by one would break the next cell construct that calls a new action, with no gain inside a cell-only account. What stays open is under Known limitations. Never deploy these policies in an account that holds anything else |
| `iam:Get*` and `iam:List*` on `*` in the execution policy and the cell permissions boundary (medium, 2) | Accepted: CloudFormation reads roles and policies while it creates and updates the cell's roles, and IAM reads expose no data in a cell-only account. The workload boundary has none |
| `s3:ListBucket` on the cell asset bucket (low) | Accepted: the CDK lists the bucket when it publishes and reads assets; the bucket holds only cell assets |
| The same wildcards and IAM reads in `spikes/*/cell-policies.yaml` (high, 2; medium, 1) | Accepted as before: the spike files are the record of their runs and are not deployed; the shipped policies replace them |
| SSM Agent actions on `*` and `execute-api:Invoke` on the account's APIs in `driver/stress-driver.cdk.ts` (high, 1; low, 1) | Not this folder: the driver host role, unchanged by W-10 and acknowledged in its own code (stress ADR-0009) |

## Known limitations

- The request path under the workload boundary (authoriser, TVM, model
  call, tools) has not run in a cell account; the first platform run at
  `small` is the check (spec Q-5).
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
  resource policies.
- Under the workload boundary a compromised cell role can still read and
  write every cell's data in the account (DynamoDB, SSM outside the owner's
  paths, KMS use), invoke any cell function, and create or delete cell
  resources with the service grants (`lambda:CreateFunction` needs a passed
  role, which it cannot pass). That is the role pair's scope (ADR-0006).
- A new service in a cell that receives a passed role, or a cell role that
  needs any IAM permission or a resource-policy write, needs both
  boundaries changed before its first deploy (ADR-0011).
- `CellAccountBase` sets the account-wide API Gateway CloudWatch Logs role.
  A second stack that sets it too wins on its next deploy.

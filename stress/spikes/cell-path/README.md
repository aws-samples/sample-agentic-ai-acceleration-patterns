<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Path spike: the `/cell/` path in standalone cell accounts

Questions ([spec](../../../docs/stress-test.spec.md) §8, decision 7; §10 Q-5, the request path, stays open (CP-6);
stress [ADR-0006](../../adr/0006-deploy-cells-through-a-scoped-cell-bootstrap.md)):
does a cell bootstrap whose execution role and every cell role carry the
cell boundary, with IAM scoped to the `/cell/` role path, refuse every way
a cell role could reach a role that is not a cell role? And does a
runtime-isolation cell deploy with every role on `/cell/` in a fresh
standalone account?

The boundary spike ([`../cell-boundary/`](../cell-boundary/README.md)) proved the
boundary alone, in a shared account.

Run 2026-11-18, `eu-central-1`, two new, empty, non-production accounts
(cell account A and cell account B).

## Files

| File | What it is |
|---|---|
| `cell-policies.yaml` | the cell execution policy and the cell permissions boundary, IAM on `role/cell/*` |
| `app.js` | the account owner's stacks (policies; a role pair stand-in on `/`; the API Gateway CloudWatch Logs role; the identity parameters) and two probe stacks through the cell bootstrap |
| `probes.sh` | assumes the bounded `/cell/` probe role and tries each escalation; it stops before the first probe unless it runs as that role, and a probe passes only on an explicit deny in the permissions boundary |
| `cell-app.ts` | the runtime-isolation demo app plus an aspect that puts every `AWS::IAM::Role` on `/cell/` |

## Steps

`NODE_PATH` points at a sample's `node_modules` for `app.js`.

1. `cdk deploy CellPolicies-spike CellAccountBase-spike --app "node app.js" --context userPoolId=<id> --context appClientId=<id>`.
   The owner stacks use the CDK's legacy synthesizer, so they deploy as
   plain CloudFormation with the account owner's credentials and need no
   CDK bootstrap.
2. From a folder without `cdk.json`:
   `cdk bootstrap aws://<account>/eu-central-1 --qualifier cell --toolkit-stack-name CDKToolkit-cell --cloudformation-execution-policies arn:aws:iam::<account>:policy/cell-execution-policy --custom-permissions-boundary cell-permissions-boundary`.
3. Synthesise each probe stack with the qualifier and boundary as object
   context (`CDK_CONTEXT_JSON`), then `cdk deploy` it with
   `--toolkit-stack-name CDKToolkit-cell`. `CellPathDenyProbe-spike` must
   fail.
4. `AWS_PROFILE=<cell account> ./probes.sh`.
5. In cell account A, synthesise `cell-app.ts` from the runtime-isolation
   sample folder with `ingress=api-gateway`, `tvm=true`,
   `publishParameters=false` and the same object context, then deploy it
   through the cell bootstrap.

## Results

| Step | Account A | Account B |
|---|---|---|
| Owner stacks (policies, base) | 61 s | 62 s |
| Cell bootstrap | 54 s; execution role bounded | 54 s; execution role bounded |
| Probe stack (`cell-spike-probe` on `/cell/`, bounded) | 50 s | 49 s |
| Deny probe: a bounded role on `/` | refused at `iam:CreateRole`, explicit deny in the boundary | the same |
| `probes.sh` | 19 of 19 pass (re-run 2026-11-19 after the review) | 19 of 19 pass (re-run 2026-11-19) |
| runtime-isolation cell | `CREATE_COMPLETE` in 424 s; 27 of 27 roles on `/cell/` and bounded; destroyed in 528 s, nothing left | not deployed |

`probes.sh`, as the bounded `/cell/` role whose own policy allows `iam:*`,
`sts:AssumeRole` and SSM parameter writes on `*`. A deny probe passes only
when the error names an explicit deny in the permissions boundary. The
script stops before the first probe unless the caller is the probe role.
The first run (2026-11-18) had 11 deny probes; the re-run added six and
the SSM deny below.

| Probe | Result |
|---|---|
| `iam:UpdateAssumeRolePolicy` on the role pair | denied |
| `iam:PutRolePolicy` on the role pair | denied |
| `iam:PutRolePolicy` on `cdk-cell-deploy-role` | denied |
| `iam:AttachRolePolicy` `AdministratorAccess` on the role pair | denied |
| `sts:AssumeRole` of the role pair (it trusts the account) | denied |
| `sts:AssumeRole` of `cdk-cell-deploy-role` (it trusts the account) | denied |
| `iam:PassRole` of the role pair, through `lambda:CreateFunction` | denied |
| `iam:CreateRole` on `/` with the boundary | denied |
| `iam:CreateRole` on `/cell/` without the boundary | denied |
| `iam:CreateServiceLinkedRole` for another service | denied |
| `iam:DeleteRolePermissionsBoundary` on itself | denied |
| `iam:AttachRolePolicy` `AdministratorAccess` on `cdk-cell-deploy-role` | denied |
| `iam:PutRolePermissionsBoundary` `AdministratorAccess` on a `/cell/` role | denied |
| `iam:CreatePolicyVersion` on `cell-permissions-boundary` | denied |
| `iam:SetDefaultPolicyVersion` on `cell-execution-policy` | denied |
| `ssm:PutParameter` over `/application-plane/shared/identity/userPoolId` | denied |
| `ssm:PutParameter` over `/cdk-bootstrap/cell/version` | denied |
| `iam:UpdateRoleDescription` on another `/cell/` role (positive control) | allowed |
| `iam:GetRole` on the role pair | allowed |

## Findings

| Id | Finding | Consequence |
|---|---|---|
| CP-1 | The `/cell/` path holds: every probe on a role outside `/cell/` was refused by the boundary, in both accounts, while a write to a `/cell/` role still worked | answers the deny probes of decision 7 |
| CP-2 | A fresh account needs service-linked roles the cell creates on its first deploy: `ops.apigateway.amazonaws.com` (the first API Gateway stage: "Caller does not have permissions to create a Service Linked Role") and `runtime-identity.bedrock-agentcore.amazonaws.com` (the first Runtime: `CreateAgentRuntime` `AccessDenied`, no detail in CloudTrail). The DynamoDB replication and Application Auto Scaling roles were not needed for the demo's single-Region tables | the allowed service names are these two; a cell with table replicas would need `replication.dynamodb.amazonaws.com` added |
| CP-3 | Every runtime-isolation role takes `Path: /cell/` from an aspect on `AWS::IAM::Role` resources, custom-resource provider roles included; the stack names roles by `Fn::GetAtt`, so no ARN breaks | answers the deploy of decision 7 |
| CP-4 | A cell account needs more than the bootstrap and the role pair: the API Gateway account's CloudWatch Logs role (runtime-isolation stages log) and the identity parameters a cell reads (`/application-plane/shared/identity/*`, pointing at the platform's issuer) | the account owner's stack holds them; spec §3.7 lists it |
| CP-5 | `cdk deploy` with the default or the CLI-credentials synthesizer needs the default bootstrap's bucket and roles; the legacy synthesizer deploys an asset-free stack inline with the caller's credentials | the owner stacks use it, so the account never gets a default bootstrap |
| CP-6 | Not tested: the request path under `/cell/` in a cell account (the integration test reuses a shared pool and deploys stacks of its own beside the cell) | the first platform run at `small` is the check |
| CP-7 | With `ssm:*` on `*`, any cell role could overwrite the owner's identity parameters, so the next cell would trust an issuer the attacker picks (found in review) | the boundary denies SSM writes to `/application-plane/shared/identity/*` and `/cdk-bootstrap/cell/*`; probed |

## Teardown

The cell and the probe stacks are destroyed. The 2026-11-19 re-run
updated `CellPolicies-spike` in place (the SSM deny) and deployed the
probe stack again (50 s), then destroyed it (16 s). The cell deploy
predates the SSM deny; runtime-isolation with `publishParameters=false`
only reads those parameters. The owner stacks
(`CellPolicies-spike`, `CellAccountBase-spike`) and `CDKToolkit-cell` stay
in both accounts: they are what a cell account holds.

## Security scan

ProtoShield v0.18.0 on `stress/` (2026-11-19), with `stress/.protoshield/config.yaml`
setting the license check to MIT-0. Semgrep, CVE, secrets and license
headers: 0. IAM least privilege for this spike: 2 high, 2 medium, all in
`cell-policies.yaml`.

| Finding | Outcome |
|---|---|
| Service wildcards (`apigateway:*`, `dynamodb:*`, `kms:*`, `lambda:*`, `logs:*`, `ssm:*`, ...) on `*`, in both policies (high) | Accepted: the file records the policies the spike ran, so CP-1 to CP-7 stay reproducible. The standalone cell account scopes them: it holds nothing but cells, the bootstrap and the owner stacks, and the boundary's explicit denies keep cell roles off everything the owner deployed |
| `iam:PassRole` on `role/cell/*` without `iam:PassedToService` (medium) | Accepted for the spike: every role on `/cell/` carries the boundary, so a role passed to any service holds at most the boundary's permissions. The cell policies in `stress/application/` (W-10) can add an `iam:PassedToService` list once the cell's services are fixed |

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0011: Give the roles a cell creates a workload boundary without IAM

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0006
- Deciders: Dave Roberts (PSA)

## Context
ADR-0006 puts one permissions boundary, the cell permissions boundary, on the
cell bootstrap's CloudFormation execution role and on every role a cell
creates. The execution role needs IAM headroom: it creates, changes and
passes the cell's roles on `role/cell/*`, assumes nothing, and creates two
service-linked roles. A workload role (a Lambda function, the AgentCore
Runtime, a Gateway, a TVM) needs none of that, and no resource-policy write
either. In the synthesised runtime-isolation cell, CloudFormation creates
every Lambda permission and resource policy, and no workload role calls
`lambda:AddPermission`, `kms:PutKeyPolicy`, `kms:CreateGrant` or a
`PutResourcePolicy`. All 27 of its roles also call no IAM action, pass no
role, and use `sts:AssumeRole` only on `/cell/` roles (the TVM and the
Entitlements API assume the cell's tenant roles). Under the one boundary,
each of them still holds IAM write, `iam:PassRole` and `sts:AssumeRole`
headroom on `role/cell/*` that it never uses (path spike finding CP-9). A
mistake in a workload role's own policy, such as `iam:*` on `*` in a
sample construct, would then let a compromised function rewrite every cell
role in the account.

The CDK applies one boundary to every role in an app
(`@aws-cdk/core:permissionsBoundary`); the cell bootstrap's execution role
takes its boundary from `--custom-permissions-boundary`. The two can name
different policies.

## Options considered
### Option 1: Keep one boundary
Pros: one policy to review; the path spike ran it. Cons: CP-9 stays; the
boundary is the only backstop for a workload role's policy, and it allows
IAM writes.

### Option 2: A second boundary for workload roles; the execution role may create roles under either
Pros: workload roles lose the headroom. Cons: the execution role can still
create a `/cell/` role under the cell permissions boundary, and so a
compromised cell build can leave a role with IAM write headroom that
outlives the build.

### Option 3: A second boundary for workload roles, and the only one the execution role may set
The cell permissions boundary denies `iam:CreateRole` and
`iam:PutRolePermissionsBoundary` unless the boundary is the cell workload
boundary. The workload boundary allows the services cell roles call at run
time, `sts:AssumeRole` on `role/cell/*` only, and denies every IAM action
and every resource-policy or sharing write.
Pros: no role a cell creates holds any IAM permission, whoever made the
mistake; the execution role is the only cell principal with IAM headroom,
and it lives in the cell bootstrap. Cons: a cell that needs a role with an
IAM permission (a custom resource that creates roles at run time) cannot
deploy until both policies change; a probe of the execution role's cap needs
an owner-made stand-in, because the execution role cannot create a role
under its own boundary.

## Decision
Option 3. `stress/application/` ships `cell-workload-boundary` beside the
cell execution policy and the cell permissions boundary. The cell synth
context names it (`cellSynthContext`), and the cell bootstrap names the
cell permissions boundary. It also scopes `iam:PassRole` in the
execution policy and the cell permissions boundary to the services the
cell passes roles to, Lambda and AgentCore (`iam:PassedToService`), and the
cell permissions boundary denies a pass to any other service. The workload
boundary also drops API Gateway and Application Auto Scaling, which only
the execution role uses, and denies the writes that share a resource
outside the account without IAM: Lambda permissions and function URLs, KMS
key policies and grants, CloudWatch Logs resource policies, subscription
filters, destinations, account policies, log deliveries and export tasks,
DynamoDB resource policies and table exports, and SSM, AgentCore and X-Ray
resource policies. Both boundaries deny a Lambda function URL, or an invoke
permission for one, with `AuthType NONE` (`lambda:FunctionUrlAuthType`); a
cell serves its traffic through its ingress. The cell permissions boundary
holds the deploy-time services only: it drops the run-time calls
(`execute-api`, the Bedrock model calls, `sts:TagSession`,
`sts:GetCallerIdentity`, X-Ray) and `sts:AssumeRole`, which the execution
role never calls, and which its execution policy never granted. The
execution policy repeats the workload-boundary condition on
`iam:CreateRole` and `iam:PutRolePermissionsBoundary`.

## Consequences
Easier: a workload role's policy can be wrong about IAM without reaching any
role, and wrong about a resource policy without sharing anything; a
compromised function can assume only `/cell/` roles, as the TVM does.

Harder: a new service that receives a passed role (a Step Functions
state machine, an EventBridge target) needs both policies changed; a cell
that needs IAM or a resource-policy write at run time needs a new decision.
The workload boundary has no `secretsmanager:GetSecretValue` and reads only
the cell asset bucket, so runtime-isolation's optional tool targets with
OAuth or API-key outbound auth, and an S3-hosted tool spec, fail until it
gains a scoped grant. Open points: the execution role keeps resource-policy
writes and `apigateway:*`, since CloudFormation creates the cell's Lambda
permissions, AgentCore resource policy and API methods, so a compromised
cell build can share a cell resource with another account or publish an
API method with no authorization; the cell permissions boundary denies only
the public function URL case, and the pre-run check does not read resource
policies. A compromised cell role still reaches every cell's data in the
account, which is ADR-0006's accepted scope. The probes in
`stress/application/probes.sh` run as two roles: an owner-made `/cell/`
role under the cell permissions boundary (the execution role's cap) and a
cell-made role under the workload boundary. The owner-made stand-in exists
only for a probe run, and its trust refuses every `/cell/` principal, so a
workload role cannot assume it to reach the IAM headroom of the cell
permissions boundary; a probe checks that refusal. The request path under the
workload boundary (spec Q-5) is not yet proven; the first platform run at
`small` checks it. The deploy of a runtime-isolation cell is recorded in
`stress/application/README.md`. Revisit if the CDK gains per-role
boundaries, or if a cell needs a role with IAM permissions.

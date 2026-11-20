<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0011: Give the roles a cell creates a workload boundary without IAM

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (PSA)

## Context
ADR-0006 puts one permissions boundary, the cell permissions boundary, on the
cell bootstrap's CloudFormation execution role and on every role a cell
creates. The execution role needs IAM headroom: it creates, changes and
passes the cell's roles on `role/cell/*`, assumes nothing, and creates two
service-linked roles. A workload role (a Lambda function, the AgentCore
Runtime, a Gateway, a TVM) needs none of that. In the synthesised
runtime-isolation cell, 27 of 27 roles call no IAM action, pass no role, and
use `sts:AssumeRole` only on `/cell/` roles (the TVM and the Entitlements
API assume the cell's tenant roles). Under the one boundary, each of them
still holds IAM write, `iam:PassRole` and `sts:AssumeRole` headroom on
`role/cell/*` that it never uses (path spike finding CP-9). A mistake in a
workload role's own policy, such as `iam:*` on `*` in a sample construct,
would then let a compromised function rewrite every cell role in the
account.

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
time, `sts:AssumeRole` on `role/cell/*` only, and denies every IAM action.
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
context names it (`cellSynthContext`), the cell bootstrap still names the
cell permissions boundary. The same change scopes `iam:PassRole` in the
execution policy and the cell permissions boundary to the services the
cell passes roles to, Lambda and AgentCore (`iam:PassedToService`), and the
cell permissions boundary denies a pass to any other service. The workload
boundary also drops API Gateway and Application Auto Scaling, which only
the execution role uses.

## Consequences
Easier: a workload role's policy can be wrong about IAM without reaching any
role; a compromised function can assume only `/cell/` roles, as the TVM
does. Harder: a new service that receives a passed role (a Step Functions
state machine, an EventBridge target) needs both policies changed; a cell
that needs IAM at run time needs a new decision. The probes in
`stress/application/probes.sh` run as two roles: an owner-made `/cell/`
role under the cell permissions boundary (the execution role's cap) and a
cell-made role under the workload boundary. Still open: the request path
under the workload boundary (spec Q-5), which the first platform run at
`small` checks; the deploy of a runtime-isolation cell is recorded in
`stress/application/README.md`. Revisit if the CDK gains per-role
boundaries, or if a cell needs a role with IAM permissions.

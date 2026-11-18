<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0006: Deploy cells through a scoped cell bootstrap with a permissions boundary

- Status: Accepted
- Date: 2026-11-18
- Deciders: Dave Roberts (PSA)

## Context
The stress application's cell script deploys one runtime-isolation cell
with the CDK from a pinned commit, inside the control plane's cell build,
through the cell account's role pair. The cell provisioning role holds only
its SSM namespace grants. A `cdk deploy` needs `sts:AssumeRole` on the
account's bootstrap roles, and those roles trust their own account, so one
grant is enough. The default bootstrap's CloudFormation execution role
holds `AdministratorAccess` in both test accounts, so that grant alone
would make the cell build an administrator of the cell account.

## Options considered
### Option 1: Allow the default bootstrap roles
Pros: smallest change. Cons: the cell build is an account administrator; a
compromised pinned source owns the account.

### Option 2: A second bootstrap for cells, with a scoped execution policy and a permissions boundary
Pros: the cell build can create only what a cell needs; the default
bootstrap stays as it is for everything else in the account. Cons: the
account owner maintains two managed policies as the cell grows; the
boundary must reach every role a cell creates.

### Option 3: The cell script calls CloudFormation with a scoped service role
Pros: no bootstrap dependency. Cons: the script synthesises and publishes
the cell's assets itself, which the CDK already does.

## Decision
Option 2. Each cell account runs `cdk bootstrap --qualifier cell
--toolkit-stack-name CDKToolkit-cell --cloudformation-execution-policies
<cell execution policy> --custom-permissions-boundary
cell-permissions-boundary` once. The boundary sits on the execution role
and on every role a cell creates; it allows the cell's services and denies
`iam:CreateRole` without itself, boundary removal, users, access keys and
policy writes. The cell synth sets `@aws-cdk/core:bootstrapQualifier` and
`@aws-cdk/core:permissionsBoundary` as object context (a CLI `--context`
passes the boundary as a string, which the CDK ignores). The role pair gets
`sts:AssumeRole` on the four `cdk-cell-*` roles through control-plane
ADR-0047. Both policies ship in `stress/application/`.

Spike Q-5 (`stress/spikes/q5-cell-boundary/`, 2026-11-18) proved it: one
cell deployed in 402 s with 27 of 27 roles bounded; a role without the
boundary was refused at `iam:CreateRole`; the destroy needed Application
Auto Scaling for the DynamoDB global tables; the sample's integration test
passed 60 of 60 steps through the same bootstrap, 139 of 139 roles bounded.

## Consequences
Easier: a cell build cannot create an administrator role or reach outside
the cell's services. Harder: a new service in a cell needs both policies
updated before its first deploy, and an integration run under the boundary
is the check. Unchanged: a compromised cell build can still change any cell
in its account, which is the role pair's scope. Revisit if the CDK bootstrap
gains per-stack execution roles, or if cells move to a deploy path without
the CDK.

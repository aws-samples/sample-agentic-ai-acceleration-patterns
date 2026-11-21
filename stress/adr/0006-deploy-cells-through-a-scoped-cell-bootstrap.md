<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0006: Deploy cells in standalone accounts through a scoped cell bootstrap

- Status: Accepted
- Date: 2026-11-18
- Amended by: ADR-0011
- Deciders: Dave Roberts (PSA)

## Context
The stress application's cell script deploys one runtime-isolation cell
with the CDK from a pinned commit, inside the control plane's cell build,
through the cell account's role pair. A `cdk deploy` needs `sts:AssumeRole`
on the account's bootstrap roles, and those roles trust their own account.
The default bootstrap's CloudFormation execution role holds
`AdministratorAccess`, so a cell build that reaches it is an administrator
of the account.

A permissions boundary on every role a cell creates stops a cell build from
creating an unbounded role. It does not stop a bounded role from acting on
roles that already exist: with IAM role writes, `iam:PassRole` and
`sts:AssumeRole` on `*`, a bounded role can rewrite the trust of an
administrator role and assume it, attach a policy to the role pair, pass
any role to a Lambda function, or assume a default bootstrap role. Service
grants on `*` (`lambda:*`, `ssm:*`, `kms:*`, `dynamodb:*`, `apigateway:*`)
also reach every other workload in the account.

## Options considered
### Option 1: Allow the default bootstrap roles
Pros: smallest change. Cons: the cell build is an account administrator.

### Option 2: A scoped cell bootstrap and a boundary, in a shared account
Pros: no new accounts. Cons: every service grant must be scoped by name or
tag to cell resources, so the policies grow with each service a cell uses;
an account that also holds a default bootstrap, the control plane or the
driver host leaves admin and data paths that a scoping mistake opens.

### Option 3: A scoped cell bootstrap, a boundary and a `/cell/` role path, in standalone cell accounts
Pros: IAM is the only thing scoped by resource, on one path; the account
itself bounds the service grants, because it holds nothing but cells.
Cons: one or two more accounts to create and bootstrap.

### Option 4: The cell script calls CloudFormation with a scoped service role
Pros: no bootstrap dependency. Cons: the script synthesises and publishes
the cell's assets itself, and the IAM scoping problem is the same.

## Decision
Option 3.

| Wall | Holds |
|---|---|
| Standalone cell account | only `CDKToolkit-cell`, the role pair and the account base (plain CloudFormation by the account owner with the CDK's legacy synthesizer, on `/`, no cell boundary; the base is one or more owner stacks tagged `stress:part=account-base`, holding the cell policies, the API Gateway logs role and the identity parameters) and cells; no default CDK bootstrap; the `control-plane` slice refuses an account with any other stack, a stack with a service role other than the cell execution role, a `cdk-hnb659fds-*` role, a role pair on `/cell/` or under the cell boundary, or a `/cell/` role trusted from outside, before every run |
| Cell bootstrap | `cdk bootstrap --qualifier cell --toolkit-stack-name CDKToolkit-cell --cloudformation-execution-policies <cell execution policy> --custom-permissions-boundary cell-permissions-boundary` |
| `/cell/` path | every role a cell creates is on `/cell/`, set by a CDK aspect in the stress cell app that matches every `AWS::IAM::Role` resource; IAM role writes, `iam:PassRole` and `sts:AssumeRole` are allowed on `role/cell/*` only; `iam:CreateServiceLinkedRole` only on `role/aws-service-role/*` and for `ops.apigateway.amazonaws.com` and `runtime-identity.bedrock-agentcore.amazonaws.com` |
| Boundary | on the execution role and every cell role: the cell's services and the same service-linked-role allow, and denies on `iam:CreateRole` without the boundary or outside `/cell/`, any other IAM write or `iam:PassRole` on a role outside `/cell/` (`NotResource` `role/cell/*`), `iam:CreateServiceLinkedRole` for any other service, boundary removal, users, access keys, policy writes, SSM writes to the owner's parameters (`/application-plane/shared/identity/*`, `/cdk-bootstrap/cell/*`), and changes to the API Gateway account setting |

The cell synth sets `@aws-cdk/core:bootstrapQualifier` and
`@aws-cdk/core:permissionsBoundary` as object context (a CLI `--context`
passes the boundary as a string, which the CDK ignores). The role pair gets
`sts:AssumeRole` on the deploy and asset-publishing `cdk-cell-*` roles
(not the lookup role) through control-plane ADR-0047. The policies ship in `stress/application/`.

## Consequences
Proven so far: the boundary spike (`stress/spikes/cell-boundary/`, 2026-11-18), in a shared
account and without the `/cell/` path, proved the boundary half: one cell
deployed in 402 s with 27 of 27 roles bounded; a role without the boundary
was refused at `iam:CreateRole`; the destroy needed Application Auto
Scaling for the DynamoDB global tables; the sample's integration test
passed 60 of 60 steps through the same bootstrap, 139 of 139 roles
bounded. The path spike (`stress/spikes/cell-path/`), in two standalone
cell accounts with the `/cell/` path, proved the path half. A
runtime-isolation cell deployed on 2026-11-18 in 424 s with 27 of 27
roles on `/cell/` and bounded, creating its two service-linked roles on
the way. On 2026-11-19, with the policies as shipped in the spike, a
bounded `/cell/` role whose own policy allows `iam:*` and
`sts:AssumeRole` on `*` was refused 18 escalations by an explicit deny in
the boundary (rewriting, attaching to, assuming or passing the role pair
and the bootstrap roles, a role on `/`, a role without the boundary,
another service-linked role, removing or swapping a boundary, new
versions of the cell policies, overwriting the owner's identity and
bootstrap parameters, and repointing the API Gateway account's logs
role) while a write to another `/cell/` role worked. Still to
prove before this record is accepted (spec Q-5): the request path in a
cell account.

Easier: a cell build cannot create, change, pass or assume a role outside
the cell, apart from the two service-linked roles above, whose trust IAM
fixes to their service; and the account holds nothing else for its service
grants to reach. Harder: each stress run needs cell accounts that hold
only cells; a compromised cell build can give a cell role a trust to
another account, which the boundary still caps and a redeploy does not
undo, so the pre-run check refuses a `/cell/` role trusted from outside;
a new service in a cell needs both policies updated before its first
deploy, and an integration run under the boundary is the check; one
boundary caps both the execution role and every role a cell creates, so
a workload role holds IAM write, `iam:PassRole` and `sts:AssumeRole`
headroom on `role/cell/*` it never uses, and W-10 decides whether cell
roles get a second boundary without IAM writes (TVM roles still need
`sts:AssumeRole` on `/cell/` tenant roles). Unchanged:
a compromised cell build can change any cell in its account, which is the
role pair's scope. Revisit if the CDK bootstrap gains per-stack execution
roles, or if cells move to a deploy path without the CDK.

Note 2026-11-20: ADR-0011 keeps the cell permissions boundary on the
execution role only and gives every role a cell creates the cell workload
boundary, which allows no IAM action and `sts:AssumeRole` on `role/cell/*`
only. The execution role may create or re-bound a role only with the
workload boundary, assumes no role, and passes `/cell/` roles to Lambda and
AgentCore only. The pre-run check refuses a role pair under either
boundary. The shipped policies, the `/cell/` aspect, the cell bootstrap
script and the probes are in
[`stress/application/`](../application/README.md), whose README records
their probe runs in both cell accounts.

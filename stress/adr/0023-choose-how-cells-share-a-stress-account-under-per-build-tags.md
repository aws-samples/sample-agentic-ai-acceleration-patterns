<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0023: Choose how cells share a stress account under per-build tags

- Status: Proposed
- Date: 2026-11-23
- Amends: ADR-0006
- Deciders: Dave Roberts (PSA)

## Context
"Spec" below means
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md).

A cell account holds one role pair, and every cell build in the account
assumes the same pair role (spec §3.7). ADR-0006 accepts the result: a
compromised cell build can change any cell in its account, and nothing else
in it, because the account holds only cells.

The control plane's per-build identity change (control-plane ADR-0051,
Proposed) narrows that for some calls. It tags a cell build with a
transitive `CellId` and a tenant build with `CellId`, `TenantId` and
`ApplicationId`, and it scopes the role pair's own SSM grants by the tag. An
owner can then write policies for `cellBuildManagedPolicyArns` and
`tenantBuildManagedPolicyArns` that match the tag. The change leaves one
path open. A `cdk deploy` hands the work to the CloudFormation execution
role, which CloudFormation assumes as a service, with no caller tags. The
tag cannot reach the roles and resources the stacks create, so two cells in
one account still share that one role's reach through the CDK.

The stress cell bootstrap names that role (`CDKToolkit-cell`, spec §8,
decision 7). Its execution policy and boundary are scoped to cell resources
and cell roles on the IAM path `/cell/`, never to one cell. The tiers put
cells in accounts as follows (`stress/src/tiers.ts`):

| Tier | Cell accounts | Cells | Cells per account |
|---|---|---|---|
| `small` | 1 | 1 | 1 |
| `medium` | 2 | 2 | 1 |
| `large` | 2 | 4 | 2 |

Only `large` puts two cells in one account. The stress test measures load,
quotas and run-time isolation through the edge (spec §1.1). The cell accounts
hold only stress cells, which the driver deploys from one pinned commit of
the repository (stress ADR-0014). No hostile cell script runs in them. The
decision is whether `large` must change so that the build-time path above is
closed, and what to record if it is not.

Cell ids are ULIDs the control plane mints when it creates a cell. No
cell id is known before a run, so nothing can be provisioned for one.

## Options considered
### Option 1: One cell per account
Register every cell account with `maxCells` 1. At `large` that is 4 cell
accounts, so 2 more than today. `small` and `medium` already work this way.

- Accounts: 4 cell accounts (plus the platform account) at `large`. Each
  new account needs the owner stacks, `CDKToolkit-cell`, the role pair, the
  account base and the ingress reader role (W-11 repeated twice), and an
  entry in the cell accounts file.
- Cost: no charge for an account. The same four cells run, so the compute
  and storage of a run stay the same. Each extra account adds the idle
  items of one cell account (the bootstrap, the base stacks, the reader
  role), which have no meter of their own. The idle fixture between runs
  (spec Q-3, P-5) spreads over 4 accounts. Cost per run is not measured at
  `large`.
- Quota and comparability: every per-account quota (STS, Lambda
  concurrency, API Gateway control plane) sees one cell's load instead of
  two. The quota budget sums draws per account (spec §4.4) and PS-3 reports
  STS and Lambda throttles by account (spec §5.1), so at `large` the numbers
  by account no longer match a two-account `large`. No `large`
  result exists yet (only `stress/results/2026-11-21-small.md`), so nothing
  breaks. The rule becomes the same at every tier: one cell, one account.
- Residual threat: closed for cell against cell, by script call or by CDK.
  A compromised build still changes its own cell and the role pair.
- Stress code: `tiers.ts` (`large.cellAccounts` 4) and its test, the spec
  tier table (§4.1) and account list (§3.6, §3.7), W-11, the cell accounts
  file and `check-accounts`, the seeded-fleet fixture (P-5), and the owner
  steps in `stress/application/README.md`.

### Option 2: A CloudFormation execution role for each cell
Give each cell its own execution role, scoped to that cell, and let the
deploy role pass only that role (`iam:PassRole` limited by the build's
`CellId` tag).

- Accounts: 2 at `large`, as today.
- Cost: no new account. A second bootstrap role, policy and boundary pair
  for every cell, in every account.
- Quota and comparability: none. The load profile stays as it is.
- Residual threat: closed, if the roles hold.
- It does not fit this test, for three reasons:
  1. The cell id is minted when the control plane creates the cell. The
     owner cannot create `cell-exec-<cellId>` beforehand. A role created at
     cell time needs IAM writes that the cell build does not have: its pair
     role allows `sts:AssumeRole` on three `cdk-cell-*` roles and nothing
     else (spec §8, decision 7). A fixed set of slots (`cell-exec-1`,
     `cell-exec-2`) needs the control plane to hand a slot to each cell, which it
     does not do.
  2. The `/cell/` path rule allows cell roles to write other `/cell/` roles
     (ADR-0006, spec §8). An execution role on `/cell/` can be rewritten by
     the other cell's execution role, which removes the separation. An
     execution role off `/cell/` needs the cell build to create it, which
     the path rule forbids, or the owner to create it, which returns to
     point 1.
  3. A per-cell qualifier means one `cdk bootstrap` for each cell, and the
     cell build cannot run one.

### Option 3: Keep two cells in each `large` account, and record the residual
Change nothing in the tiers. Record in the spec that two cells in one
account share the CloudFormation execution role, and why that is acceptable
here.

- Accounts: 2 at `large`, as today.
- Cost: none.
- Quota and comparability: none. `large` keeps the load per account that the
  spec was written for.
- Residual threat: a compromised cell build can change the other cell in
  its account through the CDK, and a script that calls the service
  directly is limited only as far as the owner's tag policies go. The
  accounts hold only stress cells from one pinned commit, and the
  cross-cell probes (PS-7, spec §5.1) test the run-time path through the
  edge, not the build path. A hostile build in a stress account is outside
  what the test measures.
- Stress code: none. The role pair in each cell account is redeployed once
  with the control plane's new trust (`stress/application/deploy-role-pair.sh`),
  as in the other options.

## Decision
Proposed: Option 3. Dave decides.

The stress accounts hold nothing but cells that the driver builds from a
pinned commit, and the test measures load and quotas, so the build-time
reach between two cells in one account is a risk the test accepts. Option 1
buys that closure by changing the load per account at `large`, which moves
the per-account numbers of spec §4.4 and §5.1, and by adding two accounts
for the owner to build and check. Option 2 does not work with run-time
cell ids and the `/cell/` path rule.

Option 1 is the choice if a `large` run will ever build a cell script that
is not the pinned commit, or if the account-by-account quota numbers should
read the same at every tier. It can be adopted later: it changes
`tiers.ts` and the owner steps and nothing in a cell.

If Dave picks Option 3, the spec's §3.7 states that cells in one account share the
execution role and its reach, and the README for the stress application
lists it under known limitations. If Dave picks Option 1, the tier, spec and
owner-step changes above follow in a separate pull request, and this record
moves to Accepted with a note that names the account count.

## Consequences
Easier under Option 3: no change to the tiers, the cell accounts or the
quota numbers. The stress test keeps one rule it already has: the account
is the wall, and a cell build can change any cell in its account.

Harder: the isolation claim for two cells in one account stays at ADR-0006's
level for the CDK path. The tags narrow script calls only as far as the
owner's policies go. The role pair in every stress cell account must be
redeployed before the first run that uses a control plane with the
per-build tags, because a trust without `sts:TagSession` refuses the
assume-role call. The first `large` run, not this ADR, shows whether two
cells in one account raise any per-account quota problem.

Revisit when a stress run builds a cell script outside the pinned commit,
when the first `large` run shows a per-account quota that two cells share
badly, when the CDK bootstrap gains per-stack execution roles, or when the
control plane mints a cell id before the cell build starts.

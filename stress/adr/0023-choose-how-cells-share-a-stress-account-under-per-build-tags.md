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
compromised cell build can change any cell in its account, which is the
role pair's scope, and spec §3.7 adds that it can change nothing else in
the account, because the account holds only cells.

The control plane's per-build identity change (control-plane ADR-0051, the
number reserved for that change, which is not on main yet) narrows that for
some calls. It tags a cell build with a transitive `CellId` and a tenant
build with `CellId`, `TenantId` and `ApplicationId`, and it scopes the role
pair's own SSM grants by the tag. An owner can then write policies for
`cellBuildManagedPolicyArns` and `tenantBuildManagedPolicyArns` that match
the tag. The change leaves one path open. A `cdk deploy` hands the work to
the CloudFormation execution role, which CloudFormation assumes as a
service, with no caller tags. The tag cannot reach the roles and resources
the stacks create, so two cells in one account still share that one role's
reach through the CDK.

The stress cell bootstrap names that role (`CDKToolkit-cell`, spec §8,
decision 7). Its execution policy and boundary are scoped to cell
resources and to cell roles on the IAM path `/cell/`, never to one cell.
The tiers put cells in accounts as follows (`stress/src/tiers.ts`):

| Tier | Cell accounts | Cells | Cells per account |
|---|---|---|---|
| `small` | 1 | 1 | 1 |
| `medium` | 2 | 2 | 1 |
| `large` | 2 | 4 | 2 |

Only `large` puts two cells in one account. The stress test measures
load, quotas and run-time isolation through the edge (spec §1.1). The
cell accounts hold only stress cells, which the control plane's cell build
deploys from one pinned commit of the repository (stress ADR-0014). No
hostile cell script runs in them. The decision is whether `large` must
change so that the build-time path above is closed, and what to record if
it is not.

The control plane mints each cell id as a ULID when it creates the cell,
and the cell build receives it as `CELL_ID`. The account owner cannot know
a cell id before a run, so the owner cannot provision anything named for
one.

Under every option the role pair in each stress cell account is
redeployed once with the control plane's new trust, since a trust without
`sts:TagSession` refuses a tagged assume-role call
(`stress/application/deploy-role-pair.sh`). The pre-run account check
(`pairTrustProblems` in `samples/control-plane/test/stress/account-check.ts`,
and the account check text of spec §3.7) accepts one statement allowing
`sts:AssumeRole` only, so it must accept the new trust first. That change
comes with the control-plane change, not with this record.

## Options considered
### Option 1: One cell per account
Register every cell account with `maxCells` 1. At `large` that is 4 cell
accounts, so 2 more than today. `small` and `medium` already work this
way.

- Accounts: 4 cell accounts (plus the platform account) at `large`. Each
  new account needs the owner stacks, `CDKToolkit-cell`, the role pair,
  the account base (which holds the ingress reader role and the
  observability link of stress ADR-0022) and an entry in the cell accounts
  file. That is W-11 repeated twice.
- Cost: no charge for an account. The same four cells run, so the compute
  and storage of a run stay the same. Each extra account adds the idle
  items of one cell account (the bootstrap, the base stacks, the reader
  role), which have no meter of their own. The idle fixture between runs
  (spec Q-3, P-5) spreads over 4 accounts. The cost per run at `large` is
  not measured.
- Quota and comparability: every per-account quota (STS, Lambda
  concurrency, API Gateway control plane) sees one cell's load instead of
  two. The quota budget sums draws per account (spec §4.4) and PS-3
  reports STS and Lambda throttles by account (spec §5.1), so at `large`
  the numbers by account no longer match a two-account `large`. No `large`
  result exists yet (only `stress/results/2026-11-21-small.md`), so
  nothing breaks. The rule becomes the same at every tier: one cell, one
  account.
- Residual threat: closed for cell against cell, by script call and by
  CDK. A compromised build still changes its own cell and the role pair.
- Stress code and text: `tiers.ts` (`large.cellAccounts` 4) and its test,
  the spec's tier table (§4.1), the account rows of §3.1, §3.2 and §3.6,
  W-11, the cell accounts file and `check-accounts`, the seeded-fleet
  fixture (P-5), and the owner steps in `stress/application/README.md`.
  The registration needs no change: the control plane computes `maxCells`
  as the cells divided by the cell accounts.

### Option 2: A CloudFormation execution role for each cell
Give each cell its own execution role, scoped to that cell, and let the
deploy role pass only that role (`iam:PassRole` limited by the build's
`CellId` tag).

- Accounts: 2 at `large`, as today.
- Cost: no new account. Each cell adds one execution role, its policy and
  its boundary in a cell account, with no meter of their own.
- Quota and comparability: none. The load per account stays as it is.
- Residual threat: closed, if the roles hold.
- It does not fit this test, for three reasons:
  1. The owner cannot create the role beforehand, because the cell id is
     minted when the cell is created (above). A fixed set of slots
     (`cell-exec-1`, `cell-exec-2`) would need the control plane to hand a
     slot to each cell, which it does not do. The cell's own execution
     role can create a `/cell/` role at cell time (ADR-0006), but
     that role cannot be protected from the other cell, as the next point
     shows.
  2. The `/cell/` path rule lets every execution role write any
     `/cell/` role (ADR-0006, spec §8 decision 7). A per-cell execution
     role on `/cell/` can be rewritten by the other cell's execution
     role, which removes the separation. A role off `/cell/` cannot be
     created by a cell build under the path rule, so it returns to the
     owner and to point 1.
  3. A per-cell bootstrap qualifier means one `cdk bootstrap` for each
     cell, and the cell build cannot run one: `cell-build-policy` allows
     `sts:AssumeRole` on three `cdk-cell-*` roles and nothing else
     (spec §8, decision 7).

### Option 3: Keep two cells in each `large` account, and record the residual
Change nothing in the tiers. Record that two cells in one account share
the CloudFormation execution role and keep the build-time reach that
ADR-0006 describes, and say why that is acceptable here.

- Accounts: 2 at `large`, as today.
- Cost: none.
- Quota and comparability: none. `large` keeps the load per account that
  the spec was written for.
- Residual threat: a compromised cell build can change the other cell in
  its account through the CDK, and a script that calls a service directly
  is limited only as far as the owner's tag policies go. The accounts hold
  only stress cells from one pinned commit, and the cross-cell probes
  (PS-7, spec §5.1) test the run-time path through the edge, not the
  build path. A hostile build in a stress account is outside what the
  test measures.
- Stress code and text: none beyond the redeploy and the account check
  above. The spec and `stress/application/README.md` list the shared
  execution role under the known limitations.

## Decision
Recommended: Option 3. The decision is open until Dave picks.

The stress accounts hold nothing but cells that the control plane builds
from a pinned commit, and the test measures load and quotas, so the
build-time reach between two cells in one account is a risk the test
accepts. Option 1 closes that reach by changing the load per account at
`large`, which moves the per-account numbers of spec §4.4 and §5.1, and by
adding two accounts for the owner to build and check. Option 2 does not
work with run-time cell ids and the `/cell/` path rule.

Option 1 is the choice if a `large` run will build a cell script that is
not the pinned commit, or if the account-by-account quota numbers should
read the same at every tier. It can be adopted later: it changes
`tiers.ts` and the owner steps, and nothing in a cell.

If Option 3 is chosen, this record moves to Accepted and the known
limitation above goes into the spec and the application README. If
Option 1 is chosen, the tier, spec and owner-step changes above follow in
a separate pull request, and this record moves to Accepted with the
account count named.

## Consequences
Easier under Option 3: no change to the tiers, the cell accounts or the
quota numbers. The stress test keeps the rule it has: the account is the
wall, and a cell build can change any cell in its account.

Harder: the isolation claim for two cells in one account stays at
ADR-0006's level for the CDK path, and the tags narrow script calls only
as far as the owner's policies go. Every stress cell account redeploys its
role pair before the first run that uses a control plane with the
per-build tags, and the account check accepts the new trust before that
run. The first `large` run, not this record, shows whether two cells in
one account raise a per-account quota problem.

Revisit when a stress run builds a cell script outside the pinned
commit, when the first `large` run shows a per-account quota that two
cells share badly, when the CDK bootstrap gains per-stack execution
roles, or when an account owner can provision a role for a cell before the
cell exists.

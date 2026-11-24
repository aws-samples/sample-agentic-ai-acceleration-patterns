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
assumes the pair's cell role (spec §3.7). ADR-0006 accepts the result: a
compromised cell build can change any cell in its account, which is the
role pair's scope, and spec §3.7 adds that it can change nothing else in
the account, because the account holds only cells.

The control plane's per-build identity change (control-plane ADR-0051,
written in
[PR 149](https://github.com/aws-samples/sample-agentic-ai-acceleration-patterns/pull/149)
and not on main until that PR merges) narrows that for some calls. It tags a cell build with a transitive `CellId` and a tenant
build with `CellId`, `TenantId` and `ApplicationId`, and it scopes the role
pair's own SSM grants by the tag. An owner can then write policies for
`cellBuildManagedPolicyArns` and `tenantBuildManagedPolicyArns` that match
the tag. The change leaves one path open. A `cdk deploy` hands the work to
the CloudFormation execution role, which CloudFormation assumes as a
service, with no caller tags. The tag cannot reach the roles and resources
the stacks create, so two cells in one account still share that one role's
reach through the CDK.

The stress cell bootstrap creates that role (`CDKToolkit-cell`, spec §8,
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

Under every option each stress cell account takes two changes once, before
the first run on a control plane with the per-build tags, and no build runs
between the role pair redeploy and the platform deploy:

1. `CellPolicies` is deployed again, because `cell-build-policy` must allow
   `sts:TagSession` on the three `cdk-cell-*` roles, limited to the
   `CellId` key. The build's session carries the tag, and chaining into
   the cell bootstrap with it needs that action on the caller.
2. The role pair is redeployed with the trust that control-plane
   ADR-0051 defines (`stress/application/deploy-role-pair.sh`). Each
   half's trust has three statements: the API role may `sts:AssumeRole`
   with no tags; the build role may `sts:AssumeRole` only with its half's
   tag keys and the external id; and the build role may `sts:TagSession`
   only with those keys, at least one of them transitive, with no
   external id (STS does not evaluate the external id on
   `sts:TagSession`). A pair with the old single `sts:AssumeRole`
   statement refuses every tagged build.

The pre-run account check (`pairTrustProblems` in
`samples/control-plane/test/stress/account-check.ts`, and the account check
text of spec §3.7) accepts the three statements, and PR 149 carries that
change and the policy change, not this record.

## Options considered
### Option 1: One cell per account
Register every cell account with `maxCells` 1. At `large` that is 4 cell
accounts, where `large` has 2 (spec §4.1). `small` and `medium` already
work this way.

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
  CDK. A compromised build still changes its own cell and nothing else
  in the account.
- Stress code and text: `tiers.ts` (`large.cellAccounts` 4) and its test,
  the spec's tier table (§4.1), the account rows of §3.1, §3.2 and §3.6,
  W-11, the cell accounts file and `check-accounts`, the seeded-fleet
  fixture (P-5), the `large` fixture of
  `samples/control-plane/test/stress/plan.test.ts`, and the owner steps in
  `stress/application/README.md`. The registration code needs no change:
  the control-plane slice driver computes `maxCells` as the cells divided
  by the cell accounts (`maxCellsPerAccount` in
  `samples/control-plane/test/stress/plan.ts`).

### Option 2: A CloudFormation execution role for each cell
Give each cell its own execution role, scoped to that cell, and let the
deploy role pass only that role (`iam:PassRole` limited by the build's
`CellId` tag).

- Accounts: 2 at `large` (spec §4.1).
- Cost: no new account. Each cell adds one execution role, its policy and
  its boundary in a cell account, with no meter of their own.
- Quota and comparability: none. The load per account is unchanged.
- Residual threat: closed, if the other cell cannot rewrite a per-cell
  role (see the reasons below).
- It does not fit this test, for three reasons:
  1. The owner cannot create the role beforehand, because the cell id is
     minted when the cell is created (above). A fixed set of slots
     (`cell-exec-1`, `cell-exec-2`) would need the control plane to hand a
     slot to each cell, which it does not do. The cell's own execution
     role can create a `/cell/` role at cell time (ADR-0006), but
     that role cannot be protected from the other cell, as the next point
     shows.
  2. The `/cell/` path rule lets a cell's execution role write any
     `/cell/` role (ADR-0006, spec §8 decision 7). A per-cell execution
     role on `/cell/` can be rewritten by the other cell's execution
     role, which removes the separation. A role off `/cell/` cannot be
     created by a cell build under the path rule, so it returns to the
     owner and to point 1.
  3. A per-cell bootstrap qualifier means one `cdk bootstrap` for each
     cell, and the cell build cannot run one: `cell-build-policy` allows
     `sts:AssumeRole` and `sts:TagSession` (the `CellId` key only) on three
     `cdk-cell-*` roles and nothing else (spec §8, decision 7).

### Option 3: Keep two cells in each `large` account, and record the residual
Change nothing in the tiers. Record that two cells in one account share
the CloudFormation execution role and keep the build-time reach that
ADR-0006 describes, and say why that is acceptable here.

- Accounts: 2 at `large` (spec §4.1).
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
- Stress code and text: no tier or code change. The redeploy and the
  account check above apply under every option. Spec §3.7 and the
  "Known limitations" of `stress/application/README.md` name the shared
  execution role, which is the text change of this option.

## Decision
Recommended: Option 3. The decision is open until the deciders choose.

The stress accounts hold nothing but cells that the control plane builds
from a pinned commit, and the test measures load and quotas, so the
build-time reach between two cells in one account is a risk the test
accepts. Option 1 closes that reach by changing the load per account at
`large`, which moves the per-account numbers of spec §4.4 and §5.1, and by
adding two accounts for the owner to build and check. Option 2 does not
work with run-time cell ids and the `/cell/` path rule.

Option 1 is the choice if a `large` run will build a cell script that is
not the pinned commit, or if the account-by-account quota numbers should
read the same at every tier. It can be adopted later: it changes the tier,
the spec and fixtures listed under Option 1 and the owner steps, and
nothing in a cell.

If Option 3 is chosen, this record moves to Accepted and the shared
execution role goes into spec §3.7 and the "Known limitations" of the
application README. If Option 1 is chosen, the tier, spec and owner-step
changes above follow in a separate pull request, and this record moves to
Accepted with the account count named.

## Consequences
Easier under Option 3: no change to the tiers, the cell accounts or the
quota numbers. The stress test applies the rule that the account is the
wall, and a cell build can change any cell in its account through the
CDK.

Harder: the isolation claim for two cells in one account stays at
ADR-0006's level for the CDK path, and the tags narrow script calls only
as far as the owner's policies go. Every stress cell account redeploys
`CellPolicies` and then its role pair before the first run that uses a
control plane with the per-build tags, and the account check accepts the
three-statement trust before that run. The first `large` run, not this
record, shows whether two cells in one account raise a per-account quota
problem.

Revisit when a stress run builds a cell script outside the pinned
commit, when the first `large` run shows a per-account quota that two
cells share badly, when the CDK bootstrap gains per-stack execution
roles, or when an account owner can provision a role for a cell before the
cell exists.

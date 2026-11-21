<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0015: Check the cell accounts with the owner's read access

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (PSA)

## Context
Spec §3.7 has the control-plane slice refuse a cell account that holds more than the cell
bootstrap, the role pair, the owner's account-base stacks and cells, before every run. The
check needs the stack list in each Region the run uses and `iam:ListRoles` in each cell
account, and for the two role pair roles `iam:GetRole` (path, boundary, trust),
`iam:ListAttachedRolePolicies`, `iam:ListRolePolicies` and `iam:GetRolePolicy`. The slice
runs with the platform account's credentials. The control plane's role pair is the only
cross-account path into a cell account, and its roles hold the SSM namespace grants and
the two owner policies only. The owner names the account-base stacks by stack ARN (W-11).

## Options considered
### Option 1: The owner's own read access, through AWS CLI profiles named in a file
The operator gives `STRESS_CELL_ACCOUNTS`, a file outside the repository listing each cell
account's id, a CLI profile with read access to it, and the account-base stack ARNs. The
driver reads with those profiles and decides with a pure function that the tests pin.
Pros: nothing new in the cell account; a person who runs a platform test has access to all
its accounts anyway. Cons: the run needs credentials for every account.

### Option 2: A read-only role in each cell account, trusted from the platform account
Pros: the run needs only the platform account's credentials. Cons: one more stack the check
must allow, and a trust into the cell account from outside it that the role pair does not
need.

### Option 3: Give the role pair read on CloudFormation and IAM
Pros: no new role. Cons: the API role can assume the pair too (control-plane ADR-0028), and
the cell build would read every role and stack in the account.

## Decision
Option 1, the owner's own read access through CLI profiles named in a file. It adds no
stack and no cross-account trust to a cell account, which Option 2 needs, and it leaves
the role pair's reach as it is, where Option 3 would give the API role and every cell
build read on every role and stack in the account.

## Consequences
The cell accounts file holds account ids and profile names, never credentials; it stays in
`STRESS_HOME`. The check refuses a stack the owner did not list by ARN, so a recreated stack
or the same name in another Region needs the list updated. It refuses a role pair half that
holds a policy its stack did not give it, or whose trust is not the stack's, so a policy
attached or a trust widened out of band fails the next run; the check needs the platform
account id and the owner policy suffix for that. It reads stacks, roles and the pair's
policies, not resource policies (stress/application README, Known limitations).

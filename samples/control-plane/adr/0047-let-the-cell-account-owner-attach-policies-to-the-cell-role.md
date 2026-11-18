# ADR-0047: Let the cell account owner attach policies to the cell role

- Status: Accepted
- Date: 2026-11-18
- Amends: ADR-025 (the account role pair)
- Deciders: Dave Roberts (PSA)

## Context
The account role pair (ADR-025) gives the cell provisioning role its SSM
namespace grants only. The tenant role already takes the account owner's
managed policies through `tenantBuildManagedPolicyArns` (ADR-022), so a
tenant script can reach what its application needs. A cell script has no
such path. An application whose cell is a CDK deployment, such as the
platform stress test's (stress ADR-0006), needs the cell role to assume the
account's cell bootstrap roles, and nothing in the sample lets the account
owner grant that.

## Options considered
### Option 1: `cellBuildManagedPolicyArns` on `CellAccountRoles`, as for the tenant role
Pros: the same rule and validation as the tenant side; the account owner
decides what a cell build may do, in their own stack. Cons: a broad policy
widens the cell build, the same as for tenant builds today.

### Option 2: A built-in grant for the CDK bootstrap roles
Pros: one switch. Cons: names one deploy tool in the control plane; which
bootstrap qualifier and roles is the account owner's choice.

### Option 3: The application deploys cells without the cell role
Pros: no change. Cons: cells in tenant-owned accounts must go through the
role pair the owner installed; a side path breaks the trust model.

## Decision
Option 1. `CellAccountRolesProps` and `CellAccountStackProps` take
`cellBuildManagedPolicyArns?: string[]`, validated like
`tenantBuildManagedPolicyArns` (this stack's partition and account), and
attached to the cell provisioning role. The README shows the one policy the
stress application uses: `sts:AssumeRole` on
`arn:aws:iam::<account>:role/cdk-cell-*-role-<account>-<region>`.

## Consequences
Easier: an application can deploy its cell with any tool the account owner
allows. Harder: the threat model's cell-role row gains the residual that an
owner-attached policy widens the cell build; the safe pattern (a scoped
bootstrap with a permissions boundary) is in the README. Revisit if cell
and tenant roles need the same policy set often enough to merge the props.

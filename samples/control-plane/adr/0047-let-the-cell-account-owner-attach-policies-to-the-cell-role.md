# ADR-0047: Let the cell account owner attach policies to the cell role

- Status: Accepted
- Date: 2026-11-18
- Amends: ADR-0025 (the account role pair)
- Deciders: Dave Roberts (SA)

## Context
The account role pair (ADR-0025) gives the cell provisioning role its SSM
namespace grants only. The tenant role already takes the account owner's
managed policies through `tenantBuildManagedPolicyArns` (ADR-0022), so a
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
stress application uses: `sts:AssumeRole` on the cell bootstrap's deploy,
file-publishing and image-publishing roles
(`arn:${Partition}:iam::<account>:role/cdk-cell-{deploy,file-publishing,image-publishing}-role-<account>-<region>`),
not its lookup role, which holds `ReadOnlyAccess`,
and states where it is safe: in a cell account that holds only cells, with
a cell bootstrap whose execution role and every cell role carry a
permissions boundary and sit on a `/cell/` role path (stress ADR-0006).

## Consequences
Easier: an application can deploy its cell with any tool the account owner
allows. Harder: an owner-attached policy widens two principals, not one.
The cell role trusts the control-plane API role as well as the cell build
(the `PutAccount` handshake, ADR-0028), so the API Lambda can use every
attached policy too; with the stress policy it can assume the cell
bootstrap roles. The threat model's cell-role row gains that residual. A
policy that reaches a default CDK bootstrap, or any role outside a scoped
path, makes the cell build and the API role administrators of the account;
the README says so beside the example. Revisit if the handshake can use a
role of its own, so the API role leaves the cell role's trust, or if cell
and tenant roles need the same policy set often enough to merge the props.

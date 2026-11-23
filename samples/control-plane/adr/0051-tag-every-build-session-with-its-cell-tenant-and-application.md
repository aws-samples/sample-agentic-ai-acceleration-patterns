# ADR-0051: Tag every build session with its cell, tenant and application

- Status: Proposed
- Date: 2026-11-23
- Amends: ADR-0025 (the pair's trust and namespace grants)
- Deciders: Dave Roberts (SA)

## Context
Every cell in an account shares that account's role pair (ADR-0025). A cell
build runs as `<fleet>-cell-provisioning` with the same identity for every
cell, and a tenant build runs as `<fleet>-tenant-provisioning` with the same
identity for every tenant. Nothing in the session says which cell, tenant or
application it acts for. So the account owner cannot write a policy that
lets cell 1's script change cell 1's resources and not cell 2's, and the
pair's own grants reach every cell's `/application-plane/cells/*` and every
deployment's `/application-plane/tenants/*` parameters. A defect or a
hostile script in one cell can overwrite another cell's routing parameters
in the same account.

The build already assumes the pair with the operator as session name
(ADR-0025, M23). The cell, tenant and application ids it acts for are
service-resolved variables of the build (`CELL_ID`, `TENANT_ID`,
`APPLICATION_ID`), not script input. A deployment is one tenant in one
application (ADR-037), so these three ids name it; there is no deployment id.
The ids are ULIDs and `[a-z0-9-]{1,32}`, safe as session tag values.

STS session tags can carry those ids on the session. Transitive tags pass
down a role chain and cannot be replaced by a later session, so a script
that assumes a further role (the CDK bootstrap deploy role, for example)
keeps them. Every role in the chain must allow `sts:TagSession` in its
trust; the current default CDK bootstrap template does. A cross-account
AssumeRole that passes tags is checked on both sides, so the caller's
identity policy needs `sts:TagSession` as well as the target's trust.

The account owner widens the pair with their own managed policies
(ADR-0022 for the tenant role, ADR-0047 for the cell role). Those policies
are where per-cell scoping of the owner's own resources would live.

## Options considered
### Option 1: Session tags on every build, required by the pair's trust
Cell builds pass `CellId`; tenant builds pass `CellId`, `TenantId` and
`ApplicationId`; all transitive. The pair trusts the build role only with
exactly those keys (a `Null` condition per key and on
`sts:TransitiveTagKeys`, and `ForAllValues:StringEquals` on `aws:TagKeys`
and `sts:TransitiveTagKeys`), in a statement of its own. The API role keeps
a separate `sts:AssumeRole`-only statement with no tags. The pair's own SSM
grants name the session's own namespace with `${aws:PrincipalTag/...}`.
Pros: one identity per cell and per deployment in every account, with no new
role per cell; the owner can scope their policies with the same tags; the
pair's built-in grants stop crossing cells. Cons: every pair deployed before
this change refuses a tagged AssumeRole, so owners must redeploy their pair
before the control plane updates; a resource the CloudFormation execution
role creates is created by a role that carries no session tags; not every
service supports `aws:ResourceTag` or `aws:RequestTag` for every action.

### Option 2: One CloudFormation execution role per cell
Each cell deploys through its own execution role (a bootstrap qualifier per
cell, or `cell-exec-<cellId>` with `iam:PassRole` limited by tag). Pros:
stack-created resources are created by a role that is the cell's own. Cons:
a role (or a bootstrap) per cell, created at cell time, which needs IAM
writes the cell build should not hold; cell ids are minted at run time, so
nothing can be prepared ahead. It does not give tenant builds an identity.

### Option 3: One cell per account
Register every account with `maxCells: 1`. Pros: the account boundary
separates cells and needs no new code. Cons: one account per cell; quotas
that are per account (STS, Lambda, API Gateway) change with the cell count;
tenants of one cell still share the tenant role.

## Decision
Option 1, because it gives every cell and every deployment its own identity
in every account at the cost of one trust statement and one grant per build
role, and it is the base Options 2 and 3 still need for tenant builds. The
pair's trust requires the tags, so an untagged or widened build session is
refused rather than admitted with less scoping; the API role path is
unchanged, because the PutAccount probe passes no tags (ADR-027). Each build
role's identity policy allows `sts:TagSession` on its half of the pair only
with the same keys. The pair's own grants are scoped by the tags: the cell
role manages `/application-plane/cells/${aws:PrincipalTag/CellId}` and what
is under it, the tenant role reads the same and manages
`/application-plane/tenants/${aws:PrincipalTag/TenantId}/${aws:PrincipalTag/ApplicationId}`
and what is under it. The shared and application namespaces stay
account-wide, because every cell reads them. For resources the CloudFormation
execution role creates, the owner chooses Option 2 or Option 3 for their own
account; this record does not choose for them.

## Consequences
- Breaking change for every account owner. A pair deployed before this
  change trusts the build role for `sts:AssumeRole` only and refuses the
  tagged AssumeRole, so every build in that account lands in `*_FAILED`.
  Upgrade order: redeploy the pair (`CellAccountStack`, or the control plane
  stack for the home account) in every registered account first, then update
  the control plane. A new pair with the old control plane fails the same
  way, because the build trust requires the tags, so the two steps must run
  back to back with no build in between.
- The PutAccount handshake does not show that a pair accepts tags, because
  the API role passes none. A pair that does not allow `sts:TagSession`
  fails its first build with the AssumeRole refusal as the reason (ADR-0025).
- Owner policy pattern: attach a policy that allows the cell's actions only
  where `aws:ResourceTag/CellId` (or the service's own resource tag key)
  equals `${aws:PrincipalTag/CellId}`, and requires `aws:RequestTag/CellId`
  to equal it on create, plus a name-prefix scope for services that support
  neither key. The same pattern with `TenantId` and `ApplicationId` applies to
  tenant policies. Which key each service supports is listed per service in
  the README (planned).
- A script that calls a service directly carries the tags. A `cdk deploy`
  hands creation to the CloudFormation execution role, which acts without
  them; an owner who needs per-cell scoping of stack-created resources takes
  Option 2 or Option 3.
- A chained role must allow `sts:TagSession` in its trust, or the chained
  AssumeRole fails. Whether the calling role also needs `sts:TagSession` in
  its identity policy for inherited transitive tags is to be shown by the
  integration test (planned); a cell build policy that only allows
  `sts:AssumeRole` on the bootstrap roles may need it too.
- The integration test (planned) shows: a cell build's session carries
  exactly `CellId` and a tenant build's the three tags, through the
  cross-account path; a build session without the tags is refused; a
  transitive tag survives a chained AssumeRole and cannot be replaced; cell
  1's role cannot write cell 2's parameters while it can write its own.
- Revisit if STS changes how transitive tags pass, if a deployment gains an
  id of its own, or if the control plane starts creating per-cell roles.

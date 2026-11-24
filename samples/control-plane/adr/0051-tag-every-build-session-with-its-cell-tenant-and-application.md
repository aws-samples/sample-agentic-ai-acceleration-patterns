# ADR-0051: Tag every build session with its cell, tenant and application

- Status: Accepted
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
deployment's `/application-plane/tenants/*` parameters. A defect in one
cell's script can overwrite another cell's routing parameters in the same
account.

The build already assumes the pair with the operator as session name
(ADR-0025, M23). The cell, tenant and application ids it acts for are
service-resolved variables of the build (`CELL_ID`, `TENANT_ID`,
`APPLICATION_ID`), not script input. A deployment is one tenant in one
application (ADR-037), so these three ids name it; there is no deployment id.
The ids are ULIDs and `[a-z0-9-]{1,32}`, safe as session tag values.

STS session tags can carry those ids on the session. Transitive tags pass
down a role chain and cannot be set again by a later session. A
cross-account AssumeRole that passes tags is checked on both sides, so the
caller's identity policy needs `sts:TagSession` as well as the target's
trust.

The account owner widens the pair with their own managed policies
(ADR-0022 for the tenant role, ADR-0047 for the cell role). Those policies
are where per-cell scoping of the owner's own resources would live.

## Options considered
### Option 1: Session tags on every build, required by the pair's trust
Cell builds pass `CellId`; tenant builds pass `CellId`, `TenantId` and
`ApplicationId`; all transitive. The pair trusts the build role only with
exactly those keys, and keeps a separate `sts:AssumeRole`-only statement
with no tags for the API role. The pair's own SSM grants name the session's
own namespace with `${aws:PrincipalTag/...}`.
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
in every account at the cost of three trust statements and one grant per
build role, and it is the base Options 2 and 3 still need for tenant builds.
The pair's trust requires the tags, so an untagged or widened build session
is refused rather than admitted with less scoping; the API role path keeps
its untagged statement, because the PutAccount probe passes no tags
(ADR-027).

Each half's trust has three statements. The API role may `sts:AssumeRole`
with no tags. The build role may `sts:AssumeRole` only when every tag key of
its half is present and no other key is passed (`Null` false on each
`aws:RequestTag/<key>`, `ForAllValues:StringEquals` on `aws:TagKeys`); this
is the statement that refuses an untagged build, because STS checks
`sts:TagSession` only when a request carries tags. The build role may
`sts:TagSession` only with exactly those keys, at least one of them
transitive and no other key transitive (`Null` false also on
`sts:TransitiveTagKeys`, `ForAllValues:StringEquals` on
`sts:TransitiveTagKeys`). The buildspec makes every key transitive; the
trust does not require that of each key, so a build role that made only
`CellId` transitive would leave `TenantId` and `ApplicationId` settable on
a chained hop (threat model M35). The external id is a condition of the two
AssumeRole statements only: a TagSession statement that required it refused
every tagged request in the integration test, so STS does not evaluate
`sts:ExternalId` there. Each build role's identity policy allows
`sts:TagSession` on its half of the pair with the same TagSession
conditions.

The pair's own grants are scoped by the tags: the cell role manages
`/application-plane/cells/${aws:PrincipalTag/CellId}` and what is under it,
the tenant role reads the same and manages
`/application-plane/tenants/${aws:PrincipalTag/TenantId}/${aws:PrincipalTag/ApplicationId}`
and what is under it. The shared and application namespaces stay
account-wide, because every cell reads them. For resources the
CloudFormation execution role creates, the owner chooses Option 2 or
Option 3 for their own account; this record does not choose for them.

## Consequences
- Breaking change for every account owner. A pair deployed before this
  change trusts the build role for `sts:AssumeRole` only and refuses the
  tagged AssumeRole, so every build in that account lands in `*_FAILED`.
  Upgrade order: redeploy the pair (`CellAccountStack`) in every other
  registered account first, then deploy the control plane stack, which
  carries the home account's pair. A new pair with the old control plane
  fails the same way, because the build trust requires the tags, so the two
  steps run back to back with no build in between (README, "Upgrading to
  session-tagged builds").
- The PutAccount handshake does not show that a pair accepts tags, because
  the API role passes none. A pair that does not allow `sts:TagSession`
  fails its first build with the AssumeRole refusal as the reason (ADR-0025).
- A role the script chains into inherits the tags, and a later AssumeRole
  cannot set an inherited key again: STS answers `InvalidParameterValue`,
  whatever the value. The chained AssumeRole needs `sts:TagSession` on both
  sides: in the next role's trust (the current default CDK bootstrap
  template allows it) and in the policy that lets the pair role assume it.
  A caller policy with `sts:AssumeRole` alone is refused. Owner policies in
  `cellBuildManagedPolicyArns` and `tenantBuildManagedPolicyArns` that
  assume further roles need `sts:TagSession` on the same roles; the stress
  test's `cell-build-policy` carries it.
- Owner policy pattern: name the cell's resources from the tag, as the
  pair's own SSM grants do, or allow an action only where
  `aws:ResourceTag/CellId` equals `${aws:PrincipalTag/CellId}` and require
  `aws:RequestTag/CellId` to equal it on create, for the actions that
  support those keys (the Service Authorization Reference lists them per
  action). The same pattern with `TenantId` and `ApplicationId` applies to
  tenant policies. An action that supports neither a tag key nor a name the
  owner controls cannot be scoped per cell.
- A script that calls a service directly carries the tags. A `cdk deploy`
  hands creation to the CloudFormation execution role, which acts without
  them; an owner who needs per-cell scoping of stack-created resources takes
  Option 2 or Option 3.
- The tags hold for defects and scripts that stay in their session. The
  build role sets them, and the script runs in the same container as the
  agent that holds the build role's credentials (threat model T29). A
  script that has reached those credentials (a container escape or
  `/proc` access to the agent) can assume the pair in any registered
  account with any cell's or tenant's tags. The sample does not stop a
  script that has reached them; that is the CodeBuild trust boundary the
  sample accepts (T29, M35), and `maxCells: 1` does not change it.
- The API role's refusal of a tagged AssumeRole is shown by the trust
  evaluator in the unit tests only; the integration test does not call the
  pair as the API role with tags.
- The session tag integration test (`test/integ.session-tags.ts`) shows,
  in two accounts with real IAM: the pair refuses a build role's AssumeRole
  untagged, with none of the tags transitive, with another key, with a missing
  key and without the external id, and admits the correct one; two cell
  sessions in one account each write their own cell namespace and neither
  writes the other's; a tenant session writes its own deployment namespace
  only and reads its own cell only; a chained role sees the cell's tag and
  writes only under it; setting the tag again on the chain is refused.
- Revisit if STS changes how transitive tags pass, if a deployment gains an
  id of its own, or if the control plane starts creating per-cell roles.

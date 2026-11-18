<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0017: Register routes from a control-plane global hook

- Status: Proposed
- Date: 2026-11-18
- Amends: ADR-0002, ADR-0003, ADR-0012, ADR-0014, ADR-0015
- Deciders: Dave Roberts (PSA)

## Context

ADR-0013 had the control plane's cell and tenant scripts call the route
registrar from the cell's own account, signed with the account's
provisioning role pair. The registrar checked the calling account
against the control plane's placement. In a tenant-owned account the
tenant controls that pair: it can assume the roles, edit them, or run
its own code under them, whenever it likes. A design review found the
consequence: the tenant's role calls `DeleteTenantRoute` for its
suspended tenant, then `PutTenantRoute`. The deployment is still placed
in that account, so the second call passes the placement check and
writes a new `tenant#` entry, which starts `active`. The suspension is
lifted. The placement check proves which account is calling. It cannot
prove that the vendor's script is the caller.

The control plane's global hooks (control-plane R-39 to R-46,
control-plane ADR-0044, on `main` and Proposed) run vendor code on cell and deployment
events: `PRE` before the script, `POST` after it succeeded, global hooks
wrapping application hooks. They run in CodeBuild in the control plane's
account under `<fleet>-global-hook`, a role no cell account holds or
trusts. A failing `POST` hook fails a create or update; a delete hook is
retried three times and then skipped, so it never stops a delete. A
`POST` hook receives the script's outputs (`SCRIPT_OUTPUTS`) as
untrusted data. Constraints: one front door per application (ADR-0014),
while a global hook runs for every application; every global hook
shares the one role (control-plane R-41); a control plane holds at most
five global hooks (control-plane R-39).

## Options considered

### Option 1: The provisioning role in the cell account calls the registrar

ADR-0013 as designed. Pros: no dependency on control-plane hooks; the
script holds everything it needs. Cons: a tenant-owned account holds a
credential the registrar admits and can use it at any time, in any
order, with any body. The delete and re-put above lifts a suspension,
and every later rule has to be proven safe against any sequence of
calls a tenant can make.

### Option 2: Option 1 plus tombstones and operator-only rules

A delete of a suspended entry by the tenant's role leaves a tombstone
that keeps `suspended`; only the edge operator role removes it. Pros: a
small change to the registrar; no new dependency. Cons: it closes one
sequence, not the cause. The tenant still holds a credential that
reaches the registrar, so each status or lifecycle rule added later
needs its own counter-rule. A tombstone is a third kind of `tenant#`
entry for the router, the size ceilings and the delete paths. Dave
Roberts rejected it for that reason.

### Option 3: The control plane writes the route table directly

A control-plane role holds `cloudfront-keyvaluestore:PutKey` on the
store. Pros: no registrar hop. Cons: KeyValueStore actions name the
store, not a key (ADR-0012), so that role could write any key, the
`signin` key and other tenants' routes included. The registrar's checks
(reserved labels, `appDomain`, domain owner, store size, ETag retry)
would move into the control plane or be lost. The control plane would
learn this sample's route format, which its other applications do not
use (ADR-0013 Option 3).

### Option 4: A control-plane global hook calls the registrar

The front door ships a route hook and registers it as two global hooks.
Pros: the only non-operator credential the registrar admits lives in
the vendor's control-plane account; no role of a cell account is
admitted, so a tenant cannot call the registrar at all. The registrar
keeps every check. The route is written by the operation itself, so a
failed registration fails the create or update, and `ACTIVE` means
routed. A `PRE` delete hook removes the route before the delete script
tears down what it points at. Cons: depends on control-plane ADR-0044,
still Proposed. Each cell and deployment event runs one more CodeBuild
build: its start time plus the 45 s propagation wait. The front door
takes two of the control plane's five global hook slots. The global
hook role is shared by every global hook, so the registrar cannot trust
the role alone. The deployer has setup in the control plane's account.
A global hook runs for every application on the control plane, not only
front-door applications: every create and update runs one
`front-door-post` build (a CodeBuild start and a parameter read) and
every delete one `front-door-pre` build, even when the hook exits 0. A
`RouteHookAccess` policy that answers AccessDenied fails the creates and
updates of every application and delays every delete by three attempts.
An application whose front door hook parameter is missing reaches
`ACTIVE` with no route, so "`ACTIVE` means routed" holds only while the
parameter exists. One `register-hooks.sh` pin serves every front door
on the control plane, so upgrading the hook for one upgrades it for
all.

## Decision

Option 4; once accepted, it supersedes ADR-0013. `hooks/route-hook.sh` is registered
by `register-hooks.sh` with `PutHook` as two global hooks, because a
hook has one phase: `front-door-post`, `POST` on `CELL_CREATE`,
`CELL_UPDATE`, `DEPLOYMENT_CREATE` and `DEPLOYMENT_UPDATE`, puts the cell
or tenant route; `front-door-pre`, `PRE` on `CELL_DELETE` and
`DEPLOYMENT_DELETE`, deletes it. Cell routes come from the hook too,
with the API domain from the cell script's `frontDoorApiDomain` output:
otherwise the registrar would still admit cell provisioning roles, and a
tenant-owned account would keep a credential that reaches it. Deletes
run `PRE`, so the route goes while the record exists, and goes even when
the delete script then fails; a `POST` delete hook would run only after
a successful script and leave a `DELETE_FAILED` deployment routed. The
hook acts only for an application with a front door hook parameter
(`/application-plane/applications/<applicationId>/shared/front-door-hook`)
in the control plane's account, which each front door's
`RouteHookAccess` stack writes, so one pair of hooks serves every front
door on the control plane (ADR-0014). The name differs from the copy
that each cell account holds, so a control-plane account that also
hosts cells holds both. The registrar's resource policy
admits one control-plane role ARN, `<fleet>-global-hook` in the
control plane's account, plus the edge operator role (an input of
the stack, `edgeOperatorRoleArn`, which the deployer brings; spec §3.6),
and denies everything else with the explicit `Deny` spike S-8 proved. The registrar
still reads the control plane on every hook write (ADR-0015): every
global hook runs under the same role, so admission proves only that
some vendor global hook is calling. It takes the cell and account from
the record, never the body, and admits a hook's put only while the
record is `CREATING` or `UPDATING` and a hook's delete only while it is
`DELETING` or gone. That check binds a write to the record's status,
not to the hook: any global hook can write while an operation on the
record runs. So the one value a hook supplies, a cell's origin, is
pinned to a Lambda function URL host in the control plane's Region and
is write-once for the global hook role: a put for a `cell#` that holds
another origin gets 409, and only the edge operator role changes it,
also for cells that predate the hooks (backfill). A `tenant#` entry
records the deployment's `createdAt` as `dt`, so a hook put for a new
deployment replaces an entry that a skipped delete hook left, while
retries and updates of one deployment keep it. The display name comes from the control plane's `GetTenant` and not from
the hook's `TENANT_NAME`, so no global hook can set it. Trusting the hook
and dropping the read was rejected: one faulty or hostile global hook could
then route or unroute any tenant. The hook retries a 5xx, 429 or missing answer inside its
build for about two minutes, and a throttled read of the front door hook
parameter for about a minute, so another application's burst of creates
does not fail this one's. It fails at once on 400, 403, 409 or 507,
printing the registrar's message.

## Consequences

- A tenant cannot lift its own suspension: no role it holds reaches the
  registrar, a hook's put keeps the stored status, and a hook's delete
  is refused while the deployment is live. Only the vendor's
  `DeleteDeployment` and a new `CreateDeployment` start a route
  `active` again (spec §4.2, the suspension step of the integration
  test).
- No global hook can remove a live tenant's route, or re-create one
  during its delete, through the shared role: the status check admits a
  hook's put only while the record is `CREATING` or `UPDATING` and its
  delete only while the record is `DELETING` or gone. It does not bind
  the write to the hook that runs: any global hook, in either phase,
  can write while an operation on that record is in flight.
- Residual, until the control plane offers a role per global hook (its
  §11 seam): any global hook can set the origin of a cell that has no
  route yet, during the cell's create or, for a cell older than the
  hooks, during an `UpdateCell`, and can put a tenant's route during
  that deployment's create or update. The write-once origin turns the
  first into a failed operation: the route hook's own put then gets
  409 (an older cell's hook already fails on its missing output), the
  cell lands in `CREATE_FAILED` or `UPDATE_FAILED`, placement
  claims only `ACTIVE` cells, and the cell stays out of `ACTIVE` until
  the edge operator role replaces the origin. The second
  gains nothing, because the record supplies cell and account and a put
  keeps `s`. The [threat model](../threat-model.md) records this residual
  (T-20, AR-1).
- A failing `POST` hook leaves the cell or deployment in
  `CREATE_FAILED` or `UPDATE_FAILED` with the hook named. From
  `UPDATE_FAILED` the operator fixes the cause and retries with
  `UpdateCell` or `UpdateDeployment`. `CREATE_FAILED` cannot be retried
  with an update (control-plane §5.2, §5.3): the operator deletes the
  failed deployment, and a failed cell once empty, whose `front-door-pre`
  hooks remove any route already written, and creates it again. A cell
  event whose script wrote no `frontDoorApiDomain` fails the same way.
- A cell whose API moves to a new host fails its `UpdateCell` with 409
  until the edge operator role sets the new origin. Cells created before
  the hooks get their routes from the edge operator role's
  `PutCellRoute` while the cell is `ACTIVE`, then `UpdateDeployment`
  for each `ACTIVE` or `UPDATE_FAILED` deployment in it, and delete and
  create for each `CREATE_FAILED` one, which `UpdateDeployment` refuses
  (spec §3.4).
- A delete hook that fails three times is skipped, and the control
  plane's skip alarm fires (control-plane T42). The route it left is
  removed by the edge operator role, which may now call
  `DeleteTenantRoute` and `DeleteCellRoute` for any route.
  `DeleteCellRoute` does not scan for tenant routes that name the cell:
  the control plane refuses `DeleteCell` while the cell holds a
  deployment, and a leftover tenant route answers 503 once its cell
  route is gone. A later
  `CreateDeployment` for the tenant does not inherit a leftover entry:
  its `createdAt` differs from the entry's `dt`, so the hook's put
  replaces it and the route starts `active`.
- `dt` adds 19 bytes to every `tenant#` entry, so the ADR-0012 ceilings
  fall to 16,949 tenants in `single` mode and 8,583 in `host` mode.
- A control-plane read outage now also fails hooks: creates and updates
  fail after the hook's retries, and deletes skip the hook. Routing,
  which reads only the store, is unaffected.
- Deployer setup in the control plane's account: the `RouteHookAccess`
  stack, its policy in `globalHookManagedPolicyArns` and a control-plane
  update, then `register-hooks.sh`. These live partly outside
  CloudFormation, so teardown is ordered (spec §6.2): delete the
  application's deployments and cells, run `register-hooks.sh --delete`
  for the last front door, remove the policy ARN and update the control
  plane, destroy `RouteHookAccess`, then destroy the front door. With
  the hooks still registered and no `RouteHookAccess` policy left, the
  hook cannot read the front door hook parameters and fails every create
  and update on the control plane.
- The hook-to-registrar API stays backward compatible across sample
  versions, or every front door on one control plane upgrades together,
  because one hook pin serves them all.
- The `controlPlane` input gains the control plane's account id, which
  names the admitted role (spec §3.6). Cell scripts no longer need the
  registrar URL; cell accounts keep only the `distributionArn` copy for
  `CellRouteAccess`.
- Spike S-8 still covers the admission: it proved a cross-account
  `aws:PrincipalArn` match on a role ARN and the need for the explicit
  `Deny`; only the admitted principal changes. The integration test
  checks that the provisioning roles of both cell accounts get 403, the
  tenant-owned edge account's from the explicit `Deny` and the control
  plane account's from the resource policy (spec §10, the steps that
  call the registrar from a provisioning role).
- This record stays Proposed, and ADR-0013 Accepted, until
  control-plane ADR-0044 (on `main`, Proposed) is accepted. On
  acceptance this record supersedes ADR-0013.
- Revisit when control-plane ADR-0044 changes before it is accepted
  (spec Q-5), or when the control plane offers a role per global hook
  (its §11 seam), which would let the registrar admit the route hook
  alone and close the residual above.

# ADR-0044: Run vendor hooks around cell and deployment scripts

- Status: Proposed
- Date: 2026-11-17
- Amends: ADR-0002, ADR-0032, ADR-0042
- Deciders: Dave Roberts (SA)

## Context
Some systems must act when a cell or a deployment is created, updated or
deleted, and they must act from the vendor's side. The motivating case is
the `tenant-front-door` sample's route registrar (its spec §3.4, its
ADR-0013). Today the cell and tenant scripts call it, signed with the
account's provisioning role pair. In a tenant-owned account the tenant
controls that pair: it can assume the roles, edit them, or run its own
code under them. So the tenant can call the registrar whenever it likes.
It can write, delete and re-create its own route, and because a new
`tenant#` entry starts `active`, a delete and re-create lifts a
suspension the vendor set. The registrar's placement check proves which
account is calling. It cannot prove that the vendor's script is the
caller.

The same need appears elsewhere: metering that counts cells and
deployments, a CMDB that tracks them, a policy gate that refuses a create
before anything is built, and an export of lifecycle events to the
vendor's audit store. Each of these is vendor code that must run on
lifecycle events without credentials a tenant-owned account can use. Each
also needs a definition of when it runs relative to the script, and what
a failure does to the operation.

## Options considered
### Option 1: Vendor hooks run by the control plane, global and per application, pre and post
A hook is vendor code (a source, a script path, a timeout) that the
workflow runs before (`pre`) or after (`post`) a cell or deployment
script, on the events it names. Global hooks apply to every application
and are registered at run time through four operator operations
(`PutHook`, `GetHook`, `ListHooks`, `DeleteHook`); application hooks are
part of an application's definition on `PutApplication`. Hooks run in
CodeBuild in the control plane account under hook roles that hold only
policies the deployer attaches, never the account role pair. Pros: the
credential a downstream system admits is held in the vendor's account
and nowhere else; a pre hook can stop an operation before the script
runs; a post hook sees the script's outputs; the order and the failure
rule are fixed by the control plane, the same in every account; the
execution history and the build logs record every run. Cons: four more
operations, one more record type, two more build projects and two more
roles; each hook adds a build, so operations take longer and cost more;
a failing global pre hook stops every create and update in the fleet.

### Option 2: Scripts keep calling external systems with the pair
The status quo. Pros: no new mechanism; the script holds everything it
needs. Cons: whatever the script can call, the owner of a tenant-owned
account can call too, at any time and with any body; a downstream system
cannot tell the vendor's script from the tenant; each system rebuilds the
same placement checks and still cannot close the gap.

### Option 3: An event bus the control plane publishes to
The workflow publishes lifecycle events to Amazon EventBridge; downstream
systems subscribe with their own rules and targets. Pros: decoupled;
adding a consumer needs no control plane change; consumers run in their
own accounts with their own credentials. Cons: there is no pre gate, so
nothing can stop an operation before the script runs; there is no
ordering with the script, so a route can be removed after the cell it
points at is gone; a consumer cannot fail the operation, so a failed
registration leaves an `ACTIVE` deployment nobody can reach; delivery is
at least once, so every consumer needs de-duplication and its own
retries, and a dropped event is found only by reconciliation.

### Option 4: Application hooks only, no global hooks
Option 1 without the global scope. Pros: one scope, no new operations,
no new record type. Cons: a vendor-wide concern (a policy gate, metering,
audit export) must be copied into every application's definition, and
any application registered without it escapes it; an application's
definition is written by whoever registers the application, so a gate
lives where it can be removed by the code it gates.

## Decision
Option 1. Six events (cell create, update and delete; deployment create,
update and delete) and two phases. Pre hooks run global then application,
post hooks application then global, so global hooks wrap the
application's; within a scope by hook id. A pre hook failure on create or
update ends the operation in its `*_FAILED` status before the script
runs; a post hook failure does so after it; on delete each hook is
retried a bounded number of times and then logged and skipped, so cleanup
stays reachable (P-9). Application hooks are stamped onto each cell with
the rest of the definition (P-4); global hooks run at the revision current
when the operation is accepted, and the cell or deployment records which
revisions it resolved. A script may hand a post hook a small JSON object
in `outputs.json`, validated by the build and treated as untrusted data;
the control plane never reads it. Hooks run in two hook build projects in
the control plane account, one per scope, each with its own role
(`<fleet>-global-hook`, `<fleet>-app-hook`) holding only the
customer-managed policies the deployer names (`globalHookManagedPolicyArns`,
`appHookManagedPolicyArns`, validated as ADR-0022 validates
`tenantBuildManagedPolicyArns`). One project per role follows P-12: the
permission boundary is a project boundary, so an application hook cannot
run with the global role through a wrong override, and the workflow role
passes no role. Reusing the two provisioning projects with a role override
was rejected: their roles are the ones every account's pair trusts, and
the separation between code that holds a pair and code that must never
hold one would rest on a per-build override instead of on the project.
Only a control plane operation starts a hook; no API runs one, and nothing
a tenant controls can declare, skip, change or start one. An event bus
(option 3) stays possible as a consumer of a global post hook.

## Consequences
- Spec changes: P-1, P-3, P-4, P-6, P-12, §1.2, §1.3, §3.1 (R-4, R-6),
  §3.2 (R-36, R-37), §3.3 (`fleetName`, two new inputs), §4.1 (R-29),
  §4.2, §4.4 (R-31), §4.7 (R-10), new §4.8 (R-39, R-40), §5.5 (`PutHook`,
  `GetHook`, `ListHooks`, `DeleteHook`; `PutApplication` `hooks`), §5.7,
  §6.4, new §6.5 (R-41 to R-44), §8 (R-20, R-23, §8.2, new §8.3 with R-45
  and R-46), N-12, §10 steps 16 and 17, §11, §12. Threat model: T5, T16,
  T34, T36, M10, M12, M17, M24, M26 widened; new T39 to T43 and M28 to
  M31.
- The reader grant grows from ten to twelve `GET` operations (`GetHook`,
  `ListHooks`), as ADR-0042 anticipated for a new `GET`; R-37 holds, and a
  hook's source location is disclosed like a script's (T34, T36).
- The definition gains `hooks` (ADR-0032). An absent `hooks` on
  `PutApplication` keeps the current list and `[]` clears it, the rule the
  parameter lists already follow, so a put that changes `maxTenants`
  cannot silently drop a hook. Existing cells keep the hooks they were
  stamped with; the definition-replacing `UpdateCell` seam (spec §11) is
  how a hook change would reach them.
- The build runners go from two projects to four (ADR-0002, ADR-0012):
  two provisioning projects whose roles assume the pair, two hook projects
  whose roles never do. The pair's trust policy is unchanged and names
  neither hook role.
- `tenant-front-door` can move its registrar calls out of the scripts:
  post hooks on cell and deployment create write the routes, pre hooks on
  deployment and cell delete remove them, so a route is gone before its
  deployment or cell is torn down. The registrar then admits one hook
  role in the control plane account in place of every account's pair,
  reads `accountId` from the placement record instead of from the caller,
  and validates any value it takes from a script's outputs (the cell's
  API domain), which a tenant-owned account influences (T40). Registering
  those hooks as global hooks keyed on `APPLICATION_ID` keeps the route
  table out of reach of every application hook. That change is
  `tenant-front-door`'s own record to write.
- Each hook adds a build per event, so operation latency and CodeBuild
  cost grow with the hooks registered; the hook projects carry the same
  concurrency cap as the provisioning projects (M17). The execution-level
  timeout grows to cover the caps (R-23).
- A delete hook that keeps failing is skipped after its retries, so an
  external system can keep state for a cell or deployment that is gone
  (T42). The skip is logged and alarmed; reconciling it is the external
  system's job.
- Seams (spec §11): hooks on tenant record events and on account events;
  outputs from a pre hook into the script; a hook role per application;
  publishing to an event bus as a built-in.
- ADR-0002, ADR-0032 and ADR-0042 get "Amended by ADR-0044" lines and
  dated trailing notes when this record is accepted.
- Revisit if a downstream system needs to veto a delete (today a delete
  cannot be gated), if per-application hook permissions are needed, or if
  hook latency on every operation becomes the larger cost.

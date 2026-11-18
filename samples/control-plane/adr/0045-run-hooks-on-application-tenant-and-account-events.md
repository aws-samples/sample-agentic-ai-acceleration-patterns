# ADR-0045: Run hooks on application, tenant and account events

- Status: Proposed
- Date: 2026-11-18
- Amends: ADR-0005, ADR-0024, ADR-0032, ADR-0037, ADR-0044
- Deciders: Dave Roberts (SA)

## Context
ADR-0044 runs vendor hooks around cell and deployment scripts and
leaves hooks on tenant record events and on account events as a seam
(spec §11). The same downstream systems need those events too. A
policy gate must be able to refuse a tenant before it exists, not only
its first deployment. A CMDB or a metering system must learn that an
account was registered, re-scoped or removed. An audit export must see
an application's definition change, because that change decides what
every later cell runs. Today these operations are synchronous
(`PutApplication`, `DeleteApplication`, `CreateTenant`, `UpdateTenant`,
`DeleteTenant`, `PutAccount`, `DeleteAccount` all answer 200) and run
no workflow, so nothing runs around them.

A hook build takes minutes: a run timeout of 5 to 30 minutes and up to
10 minutes of refusals and queue (spec R-46). The API's integration
timeout is 29 seconds. A pre hook therefore cannot run inside the
request, and a gate needs a pre hook. Tenants span several
applications and accounts hold cells of several, so a hook on their
events cannot belong to one application's definition.

## Options considered
### Option 1: Asynchronous record operations with pre and post hooks (A)
The seven operations become asynchronous, as cell and deployment
operations are (P-8): the request validates, writes a transitional
status and starts the one workflow, which runs pre hooks, commits the
record, runs post hooks and writes the terminal status. A create
inserts the record `CREATING`; an update stages the new values in a
`pending` attribute and commits them after the pre hooks; a delete
moves the record to `DELETING` with its empty check. Pros: pre hooks
can gate, with the order and failure rules ADR-0044 already fixed; one
workflow path for every lifecycle operation; post hooks see a
committed change. Cons: a breaking API change (200 becomes 202 and
callers must poll); three record types gain a status, a reason and a
staged copy; one Step Functions execution per operation, also when no
hook matches; a record can be stranded in a transitional status like a
cell.

### Option 2: Post hooks only, after a synchronous write (B)
The operations stay synchronous; after the write commits, the service
starts an execution that runs post hooks only. Pros: no API change for
callers; no status on these records. Cons: no gate, so a policy hook
cannot refuse a tenant or a registration, the case that motivated the
change; a failed post hook has no record status to land in, so it is
logged and lost, as an event bus delivery would be (ADR-0044 option
3); the service still needs the workflow start and its compensation.

### Option 3: Leave them as seams (C)
Downstream systems learn of tenants through their deployments' events
and of accounts through their cells' events. Pros: nothing changes.
Cons: an empty tenant and an account with no cells are invisible to
every hook; a gate on onboarding acts only at the first deployment,
after the tenant record exists; a definition change reaches hooks only
when a cell is next created.

## Decision
Option 1, chosen by Dave Roberts on 2026-11-18. A gate is the
requirement options 2 and 3 cannot meet, and option 1 meets it with
the order, failure rules, build projects and roles ADR-0044 already
specifies, so the new surface is nine events, a status on three record
types and one workflow path without a build. The script slot of
ADR-0044 becomes the record commit: one conditional write the workflow
makes to the table, with no script and no build in a cell account, and
post hooks get `SCRIPT_OUTPUTS` `{}`. Application events run global and
application hooks, the application hooks of the definition being
written on create and update and the stored ones on delete; tenant and
account events run global hooks only, and `PutApplication` refuses an
application hook that names one of them. Validation and the account
handshake probe stay in the request, so an operator still gets a 400 or
a 404 at once. Live values never change before the commit: placement,
parameter validation and build inputs read only them. A pre hook
failure on update drops `pending` and keeps the old values live. The
one exception is an account's `externalId`: `PutAccount` writes it in
the request's conditional write, after the handshake probe proved it,
and stages only `maxCells` and `applicationIds`. An owner rotates a
leaked id by redeploying the pair to refuse the old one, so a staged id
would fail every build into the account while hooks run, and for good
when a pre hook refused it. A security rotation must not wait on a
gate, so an `ACCOUNT_UPDATE` pre hook cannot refuse an external id
change, and a running one cannot delay it: a `PutAccount` on an
`UPDATING` account writes only the new id, after the probe, with no
execution and no hook, because the commit never touches it. Each
operation stores its execution's name on the record as `operationId`,
and every workflow write is conditioned on it, so a start whose
outcome is unknown is compensated to `CREATE_FAILED` and a stray
execution cannot finish a later request's record. A delete is never
gated (P-9). Hook operations stay synchronous
and fire no hooks.

## Consequences
- Spec changes: §1.2, P-1, P-5, P-8, P-9, §4.1 (status fields, R-29,
  item size), §4.3, §4.5 (status fields, R-24, `applicationIds` at most
  100), §4.8 (events, R-39, R-40), §5 intro, §5.1, §5.4, §5.5, §5.6
  (record statuses, remedies, new R-47 to R-49, R-13), §5.7 (409
  triggers, R-14), §6.5 (R-42 columns for the three new event kinds,
  R-45), §7.1 (live-status conditions), §7.2, §7.4, §8 (§8.1 budget,
  §8.2, R-23, R-46, new §8.4 with R-50 and R-51), §9 (N-13), §10 (202
  and polling for every record call, spelled out in steps 2, 3, 4, 11
  and 18, new step 17, teardown becomes step 18, unit assertions,
  untested paths), §11. Threat model: T16, T28, T43 widened; new T45
  to T47 and M33, M34. `integration-test.md` gains the changes the
  built test will need.
- Breaking change for API clients: the seven operations answer 202
  with the record and its `status` instead of 200, and a record is
  usable only once it is `ACTIVE` (or `UPDATING` or `UPDATE_FAILED`
  after a replace). A client that creates a tenant and deploys it at
  once must poll `GetTenant` first, or retry the 409. The integration
  test, the README's examples and every client of these operations
  (the `tenant-front-door` sample's onboarding path among them) change
  with it. The README gains an upgrade note when the change is built.
  Records stored before the upgrade have no `status` and read as
  `ACTIVE`, so the upgrade writes nothing to the table and needs no
  drain beyond ADR-0044's.
- Every one of these operations costs one Standard execution, with a
  few state transitions and seconds of latency when no hook matches,
  plus each matching hook's build and polling (ADR-0044). The path is
  the same whether or not a hook matches (P-1).
- The execution is smaller than any cell or deployment execution: no
  parameter set, no script source, no external id or role ARN, and the
  commit names the fields to copy from `pending`, never their values.
  Under 25 KiB of input at the caps, against about 217 KiB for a
  new-cell create (spec §8.1). A delete at the caps runs about 1,440
  minutes of hooks, the hook time of a cell delete without its
  60-minute script, so the 26-hour execution timeout and the
  25,000-event history quota hold with the numbers ADR-0044 measured.
- An application record holds its definition and both declaration
  lists twice while an update is staged: about 100 KiB at the caps,
  under 200 KiB with `pending`, inside DynamoDB's 400 KB item limit.
  `applicationIds` on an account is capped at 100 ids, so
  `ACCOUNT_APPLICATION_IDS` stays at most 3,299 bytes, under the
  4,096-byte single value spike H-5 delivered; `PutAccount` refuses a
  longer list with 400, and a re-put of an account that holds more is
  a 400 until it is shortened.
- Placement's claims gain a status condition on the tenant, and on the
  new-cell path on the account and the application, so no cell or
  deployment counts toward a record that is `CREATING` or `DELETING`.
  That condition is what keeps a record's count at 0 from the moment
  its delete is accepted. `DeleteDeployment` and `DeleteCell` stay
  exempt (P-9).
- An `ACCOUNT_UPDATE` pre hook gates `maxCells` and `applicationIds`
  only. A new `externalId` is in force from the request, before any
  hook runs, and stays when a pre hook refuses the rest (spec R-48,
  T28). That is the one exception to "nothing changes before the gate",
  and a hook that must vet external ids has no place to do it.
- A rotation on an account whose `ACCOUNT_UPDATE` is running writes
  only `externalId`, with no execution and no hook, and its other
  fields must equal the change in flight (409 otherwise). Hooks
  therefore see no event for it. `CREATING` and `DELETING` accounts get
  no such path, because no build runs into them. An account stranded
  `UPDATING` (T47) can still rotate, but cannot change `maxCells` or
  `applicationIds` or be deleted until it is repaired. A rotation whose
  write loses its condition because the event ended reads the record
  once more and takes the replace path, without a second probe.
- Every record carries the `operationId` of its last operation, the
  name of the execution it started, with 8 random hex characters at
  the end so no two operations share one. A failed workflow start
  deletes a record the request inserted only when `StartExecution`
  itself returned an error Step Functions raises before any execution
  exists. `DescribeExecution` is eventually consistent, so it proves
  only that a start went through: a miss, like any other failure, is
  an unknown outcome and leaves the record `CREATE_FAILED`, so the
  delete hooks still reach anything a stray execution's create hooks
  did. A re-put, an update and a delete go to their `*_FAILED` status.
  A start shown to have gone through (`ExecutionAlreadyExists` on the
  operation's own name, an execution `DescribeExecution` found, or a
  compensation that finds the record finished under the same
  `operationId`) answers 202 (spec R-51). A `CreateTenant`
  refused at the start leaves no tenant, and a retry makes one; one
  with an unknown start leaves a `CREATE_FAILED` tenant that
  `ListTenants` finds. Cell and deployment executions keep their
  unstored names and status-only conditions; storing an id there too
  is a seam (spec §11).
- `PutApplication`'s write, which needed no condition when both
  declaration lists were sent, is now always conditional on the status
  it read; a failed condition is classified from the item, as R-14
  does for deployments.
- More events share the two hook projects' concurrency caps. A burst
  of sign-ups can push cell and deployment hook builds onto the
  refusal path of R-46, and the reverse (spec N-13).
- A failing global pre hook on `TENANT_CREATE` or `ACCOUNT_CREATE`
  stops every sign-up or registration in the fleet until `DeleteHook`
  or `PutHook` (T45). Hooks on account events learn every account's id,
  owner and admitted applications, never its external id (T46). A crash
  between the conditional write and the workflow start strands a
  record as it strands a cell (T47); the stuck-execution sweep seam
  covers these records too.
- An application hook on an application event that always fails has a
  cheap exit, unlike a stamped one: the `PutApplication` that removes
  it runs without it, because application events run the hooks of the
  definition being written.
- Seams (spec §11): hooks on hook operations stay out. `PutHook` and
  `DeleteHook` stay synchronous; a hook that gated its own removal would
  have no exit.
- ADR-0005, ADR-0024, ADR-0032 and ADR-0037 get "Amended by ADR-0045"
  lines and dated trailing notes when this record is accepted. ADR-0044
  carries a dated note now, because it is still Proposed and its seam
  is the one this record closes; it gets the `Amended by` line too.
- Revisit if a client cannot poll (a synchronous `CreateTenant` would
  then need option 2 beside this one), if the execution per operation
  becomes a cost that matters at the fleet's request rate, or if a hook
  on tenant or account events needs a role or a scope of its own.

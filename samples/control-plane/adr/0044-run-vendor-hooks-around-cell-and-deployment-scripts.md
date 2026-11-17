# ADR-0044: Run vendor hooks around cell and deployment scripts

- Status: Proposed
- Date: 2026-11-17
- Amends: ADR-0002, ADR-0011, ADR-0012, ADR-0021, ADR-0022, ADR-0025,
  ADR-0032, ADR-0042
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

A post hook often needs something only the script knows: the endpoint
it created, a name it chose. The natural carrier is a CodeBuild exported
variable, which Step Functions returns with the build result. Spike H-1
(2026-11-17, eu-central-1) measured it through
`codebuild:startBuild.sync`. A single exported value of 1,024, 4,096 or
8,192 bytes came back intact. A single value of 16,384 bytes, 32 KiB or
64 KiB, and four values of 4,096 bytes (16 KiB in all), came back with
every exported value an empty string, while the build and the execution
reported `SUCCEEDED`. A declared exported variable the build never set
came back as `""`. The limit is on the total of a build's exported
variables, between 8 and 16 KiB, and overflow is silent. A carrier built
on exported variables must keep that total small and must treat an
empty value as a failure, never as "no outputs".

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
runs; a post hook failure does so after it. On delete each hook is
retried, three attempts 60 and 120 seconds apart, and then logged and
skipped, so cleanup stays reachable (P-9).

Application hooks are stamped onto each cell with the rest of the
definition (P-4). Global hooks are read before the operation's first
write, so a failed read leaves nothing to compensate, and run at the
revision current at that read. The cell or deployment records which
global hooks ran, with the commit each build resolved, not only the ref
it named. Hook fields are limited to characters JSON never escapes
(URL characters without `@` for a location, so it carries no userinfo;
git ref characters for a version, a `<ref>^{<commit>}` pin and a SemVer
`+` included; path characters for a script), and the application's own
source and script paths get the same charsets, a change to
`PutApplication`'s validation (ADR-0032). With outputs held to
printable ASCII, the execution input then stays inside its 256 KiB
budget with about 39 KiB to spare, of which the application's source
and paths take at most 4.3 KiB.

A script hands its post hooks a small JSON object through a file at
`OUTPUTS_FILE`, a path outside the source tree. Its keys are unique and
its values printable ASCII, so a byte is a character in every component
that counts it, and only `"` and `\` are escaped. The provisioning
buildspec parses the file, refuses a repeated key, checks the rest (at
most 4,096 bytes in compact form) and exports as `SCRIPT_OUTPUTS` its
own compact re-serialisation of the parsed object (as `jq -c .`
writes it: no insignificant whitespace, `"` and `\` the only escapes),
never the file's bytes. It exports it always, `{}` when there is none,
and exports nothing else, so the build stays under the limit spike H-1
found. That check runs in the container the script ran in, so it is a
format check, not a trust boundary. The workflow checks the value
again, by the same rule, in the script task's `Output`, with a linear
regular expression that admits only the compact form, and never
`$parse`, whose error would reach the task's failure write: an empty,
over-long or malformed value fails a create or update and becomes `{}`
on a delete. The pattern cannot see a repeated key, so a hook refuses
an object that has one. The control plane never reads the outputs, and
hooks treat them as untrusted data.

Hooks run in two hook build projects in the control plane account, one
per scope, each with its own role (`<fleet>-global-hook`,
`<fleet>-app-hook`) holding only the customer-managed policies the
deployer names (`globalHookManagedPolicyArns`,
`appHookManagedPolicyArns`, validated as ADR-0022 validates
`tenantBuildManagedPolicyArns`). One project per role follows P-12: the
permission boundary is a project boundary, so an application hook
cannot run with the global role through a wrong override. A hook
project must accept source and buildspec overrides, so starting a build
in it is running code as its role. Only the workflow role may start
hook builds, and it holds no `iam:PassRole` on either hook role, so a
role override fails at the API; the provisioning build roles and the
API role hold neither. Starting an execution of the workflow is the
same grant, because the workflow runs whatever hook source its input
names: only the API role holds `states:StartExecution`, no build role
or hook role does, and a compromised API function therefore reaches
both hook roles (threat model T30). Every global hook shares one role,
and the hooks of all applications share the other. The hook buildspec
passes every value to the hook script as an environment variable and
never interpolates one into a command. Reusing the two provisioning
projects with a role override was rejected: their roles are the ones
every account's pair trusts, and the separation between code that holds
a pair and code that must never hold one would rest on a per-build
override instead of on the project.

No pair trusts a hook role, but grants of three kinds still lead from a
role to the provisioning build roles and through them to every pair.
The direct ones start an execution of the workflow, start a build in a
provisioning project, or write to the table, whose hook records declare
hooks. The second kind runs new code as a role that holds a pair or one
of those grants: `iam:PassRole` on it with a create on CodeBuild, Step
Functions or Lambda. The third rewrites what a pair holder runs next,
or removes the deny itself: an IAM write on one of the stack's roles,
or an update to a project, the workflow or the API function. The stack
therefore adds to each build role, each hook role and the two pair
roles of its own account an inline explicit deny on:

- `iam:PassRole` on the two build roles, the workflow role, the API
  role and the two hook roles;
- `iam:PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy`,
  `DetachRolePolicy`, `UpdateAssumeRolePolicy`,
  `PutRolePermissionsBoundary` and `DeleteRolePermissionsBoundary` on
  every role the stack creates;
- `codebuild:StartBuild`, `StartBuildBatch`, `RetryBuild`,
  `UpdateProject`, `CreateWebhook` and `UpdateWebhook` on the four
  projects;
- `states:StartExecution`, `UpdateStateMachine` and `RedriveExecution`
  on the workflow;
- `lambda:UpdateFunctionCode`, `UpdateFunctionConfiguration`,
  `PublishVersion`, `CreateAlias`, `UpdateAlias` and `DeleteAlias` on
  the API and authorizer functions;
- `dynamodb:PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`,
  `PartiQLInsert`, `PartiQLUpdate` and `PartiQLDelete` on the table,
  through which `TransactWriteItems` and `ExecuteTransaction` are
  authorised per item.

Each build role also trusts CodeBuild only on its own project's
`aws:SourceArn`, as each hook role does, so no new project runs as it.
That changes the build roles' trust, which ADR-0025 left as CodeBuild
with no condition. The stack still never reads an attached policy
(P-3), and the list names only its own resources. The deny also limits
the policies of `tenantBuildManagedPolicyArns` (ADR-0022), which attach
to the tenant provisioning role of the stack's own account. The
workflow and API roles carry no deny, because the direct actions are
their own grants. The deny leaves a residual, which is stated, not
closed: an attached grant of `sts:AssumeRole` on another role in the
control plane account (an admin role or a CDK bootstrap role), or of
CloudFormation writes through a privileged execution role, still
reaches the pair, and so does a principal outside the denied roles
that the deployer grants a denied action. Both stay the deployer's
choice (T41).

A hook build starts with a request-response `startBuild`, so its id is
known from the first call, and a loop polls that one build with
`batchGetBuilds` every 60 seconds, keeping only its id, status, phase
timing and resolved commit. A hook's `timeoutMinutes` (T, 5 to 30) is
CodeBuild's run timeout. The start is an explicit loop that holds two
variables, computed once per try: the try index `TRY`, and that try's
queued timeout q, 10 minutes less the minutes refused so far and never
below CodeBuild's minimum of 5. A refused `StartBuild` (throttling, a
concurrency quota, the project at its cap) goes through a `Catch`, a
30-second `Wait` and a `Choice` that increments `TRY`, for at most 5
minutes, so refusals and the queue take at most 10 minutes together. A
transient error is a task `Retry` (`TimeoutSeconds` 15, at most three
repeats 10 seconds apart), which re-sends the same variables. The
idempotency token is the JSONata `$hash` of the execution, the event,
the phase, the hook, the attempt and `TRY`. It has a fixed length,
differs on every try and stays the same on every repeat, so a call that
created a build before it failed returns that build again instead of
leaving one with no id to stop. A try whose repeats all fail ends the
attempt as "start outcome unknown", never a new try under another
token. The attempt's deadline is data: the run timeout, the 10 minutes
and five minutes of margin from the first start try, and on delete
never later than 2 minutes before the end of the hook's budget. At the
deadline the loop calls `StopBuild`, in the same loop shape, and polls
the build until it is final, within the 2 minutes the bound allows. So
a queue wait is never read as a hook timeout, and no hook build
outlives its attempt, except a build hidden behind a start whose
repeats all failed, which CodeBuild stops within q + T.

A delete hook's three attempts are a loop through the failure handling,
each starting its own build only after the last one is final. An
attempt refused for its whole window started no build and does not
count, and the next try follows the 60-second backoff. An attempt that
ended "start outcome unknown" counts, and the next attempt waits until
q + T have passed, so it never runs beside the hidden build. A budget
of three attempts' time, 144 minutes at the cap, bounds the hook; when
it runs out the loop stops the build and logs the skip as "budget ran
out". A `.sync` task was the first draft. It was dropped because
finding the build after a task timeout meant reading the project's
recent builds, whose results each echo up to about 100 KiB of
environment and could pass the state limit, and because a task `Retry`
on delete would skip stopping the earlier builds.

Only a control plane operation starts a hook; no API runs one, and
nothing a tenant controls can declare, skip, change or start one: an
execution's hooks come from records only the API writes, in an
execution only the API starts. An event bus (option 3) stays possible
as a consumer of a global post hook.

## Consequences
- Spec changes: P-1, P-3, P-4, P-6, P-9, P-12, §1.2, §1.3, §3.1 (R-4,
  R-6, the system diagram), §3.2 (R-36, R-37), §3.3 (`fleetName`, two
  new inputs, the home pair's deny), §4.1 (R-29, source and script
  charsets), §4.2, §4.4 (R-31), §4.7 (R-10), new §4.8 (R-39, R-40),
  §5.2, §5.3, §5.5 (`PutHook`, `GetHook`, `ListHooks`, `DeleteHook`;
  `PutApplication` `hooks` and charsets), §5.7, §6.1 (`OUTPUTS_FILE`),
  §6.3 (the note after R-35), §6.4, new §6.5 (R-41 to R-44), §7.1
  step 0, §7.2, §7.4, §8 (R-20, R-22, R-23, §8.2, new §8.3 with R-45
  and R-46), N-12, new §9.1 (H-1 to H-10), §10 setup, steps 2, 16 and
  17 and the unit assertions, §11, §12. Threat model: T5, T16, T30,
  T34, T36, T43, M10, M12, M15, M17, M18, M24, M26 widened; new T39 to
  T44 and M28 to M32.
- The reader grant grows from ten to twelve `GET` operations (`GetHook`,
  `ListHooks`), as ADR-0042 anticipated for a new `GET`; R-37 holds, and
  a hook's source location is disclosed like a script's (T34, T36).
- The definition gains `hooks` (ADR-0032). An absent `hooks` on
  `PutApplication` keeps the current list and `[]` clears it, the rule
  the parameter lists already follow, so a put that changes
  `maxTenants` cannot silently drop a hook. A kept `hooks` list adds no
  write condition, because hooks share no invariant with another list.
  Existing cells keep the hooks they were stamped with.
- `PutApplication` also refuses an application source or script path
  outside the hook charsets (ADR-0032), where it admitted any value
  starting with a non-blank character. A re-put of an application
  registered with such a value is a 400 until it is corrected; cells
  stamped before keep their stamp. The `sourceVersion` charset admits
  branches, tags (SemVer `+` included), commit SHAs, `<ref>^{<commit>}`
  pins and object versions.
- A stamped application hook that always fails has no cheap exit: fix
  forward on an unpinned ref, or, for a hook pinned to a commit, delete
  the cell's deployments and then the cell (spec §8.3, P-9). Gates and
  registrars therefore belong in global scope, where `PutHook` replaces
  them. The definition-replacing `UpdateCell` seam (spec §11) would be
  the non-destructive exit.
- The resolved input (ADR-0011) gains the hooks of each event, read
  before the first write, and the execution input budget gains their
  definitions and one script's outputs.
- A script may write its outputs file in any valid JSON spelling with
  unique keys; hooks always see the compact form. A file with a
  repeated key fails a create or update.
- The build runners go from two projects to four (ADR-0002, ADR-0012):
  two provisioning projects whose roles assume the pair, two hook
  projects whose roles never do. The pair's trust policy is unchanged
  and names neither hook role. Each build role's trust gains an
  `aws:SourceArn` condition on its own project (ADR-0025), so a project
  the stack did not create cannot run as a build role.
- Every build role, every hook role and the two pair roles of the
  control plane's own account carry the inline deny, so a deployer can
  no longer grant them, through `tenantBuildManagedPolicyArns`
  (ADR-0022) or otherwise, any action on its list: passing one of the
  stack's roles, writing a role's policies, starting a build in or
  updating one of the four projects, starting, updating or redriving
  the workflow, changing the API or authorizer function, or writing to
  the table. A policy that grants one of these for an application plane
  need is now refused at the deny; the producer policy in this
  repository, tenant-identity's `PlatformInvokePolicy`
  (`execute-api:Invoke`, KMS encrypt), grants none of them. A grant of
  `sts:AssumeRole` on another role of the control plane account, or of
  CloudFormation writes through a privileged execution role, still
  reaches the pair; that residual is the deployer's (T41).
- The concurrency cap and log retention of ADR-0021 cover all four
  projects. All global hook builds of the fleet share one project
  capped at five, and CodeBuild documents builds over the cap as
  refused, not queued (H-9). A refused start is tried again for up to 5
  minutes; then a create or update ends in a named `*_FAILED` ("cannot
  start") rather than a silent wait, and a delete hook spends its
  budget and is skipped (T42, T43).
- A start whose repeats all failed ends "start outcome unknown" and may
  hide a build that runs until CodeBuild stops it, within q + T. On
  create, a post hook hidden this way can still write state, a route
  included, beside the record's `CREATE_FAILED` (T40). On delete the
  next attempt waits it out, but a skip at the budget's end can leave it
  running beside the delete script (T42).
- Polling costs three state transitions per hook minute, about $0.002
  for a 30-minute hook. History grows at the larger of two rates:
  polling writes nine events a minute, and the refusal loop about 15.7.
  At the caps a delete writes about 13,000 of a Standard execution's
  25,000 history events while polling, and about 22,600 when every hook
  is refused for its whole budget. The refusal interval stays 30
  seconds; a 30-second poll would pass the quota.
- The execution-level timeout grows from 3 hours to 26 hours. At the
  caps (ten hooks per event, 30-minute runs, three attempts per delete
  hook) a delete can run 25 hours and a new-cell create about 18. The
  timeout is a safety net that costs nothing on Standard workflows; it
  bounds how long a hung execution holds its record.
- `tenant-front-door` can move its registrar calls out of the scripts:
  post hooks on cell and deployment create write the routes, pre hooks
  on deployment and cell delete remove them, so a route is gone before
  its deployment or cell is torn down. The registrar then admits one
  hook role in the control plane account in place of every account's
  pair, reads `accountId` from the placement record instead of from the
  caller, and validates any value it takes from a script's outputs (the
  cell's API domain), which a tenant-owned account influences (T40).
  Registering those hooks as global hooks keyed on `APPLICATION_ID`
  keeps the route table out of reach of every application hook. It does
  not keep it from other global hooks: they share `<fleet>-global-hook`,
  so a metering or audit global hook can write routes too (T41). A
  vendor that owns every global hook can accept that; a role per global
  hook is the seam. That change is `tenant-front-door`'s own record to
  write.
- A global hook deleted or replaced after its source was poisoned keeps
  running in executions already accepted; `StopExecution` stops them and
  strands their records (spec §7.2, T5).
- A delete hook that keeps failing is skipped after its retries or when
  its budget runs out, so an external system can keep state for a cell
  or deployment that is gone (T42). The skip is logged and alarmed;
  reconciling it is the external system's job.
- Assumptions to verify before the hooks are built (spec §9.1, with H-1
  verified; H-3, H-4 and H-6 asked how a `.sync` hook task behaves and
  are not needed with the poll loop):
  - H-2: a `batchGetBuilds` result carries `resolvedSourceVersion`.
  - H-5: CodeBuild accepts a hook build's environment override (about
    fifteen fixed variables, 40 `PARAM_` variables, 4 KB of outputs).
  - H-7: a CodeBuild role's trust policy conditioned on `aws:SourceArn`
    admits its own project's builds only, for each hook role and each
    provisioning build role.
  - H-8: a refused `StartBuild` or `StopBuild` fails with a service
    error name no started build produces, and a refused try creates no
    build; the idempotency token passes through the Step Functions
    integration, and a repeat within its 5-minute validity returns the
    same build id; a task `Retry` re-sends the evaluated `Arguments`
    unchanged, and a refused request does not bind its token.
  - H-9: what `StartBuild` returns at the project's
    `concurrentBuildLimit`; the design assumes a refusal.
  - H-10: a 4,096-byte outputs value of worst-case escapes round-trips
    through the build export and Step Functions, and the guard, run in
    a real Step Functions `Output`, accepts the largest valid value and
    rejects the 4,096-character near miss in recorded time.
- Seams (spec §11): hooks on tenant record events and on account events;
  outputs from a pre hook into the script; a hook role per application
  or per global hook; publishing to an event bus as a built-in.
- ADR-0002, ADR-0011, ADR-0012, ADR-0021, ADR-0022, ADR-0025, ADR-0032
  and ADR-0042 get "Amended by ADR-0044" lines and dated trailing notes
  when this record is accepted.
- Revisit if a downstream system needs to veto a delete (today a delete
  cannot be gated), if per-application or per-hook permissions are
  needed, if hook latency on every operation becomes the larger cost, if
  H-7 finds that the `aws:SourceArn` condition refuses a project's own
  builds, if H-9 finds that the project cap queues builds rather than
  refusing them, if H-8 finds that the token does not return the same
  build or that a `Retry` re-evaluates its `Arguments`, or if H-10 finds
  that the export counts escapes past its limit or that Step Functions'
  JSONata engine cannot run the guard.

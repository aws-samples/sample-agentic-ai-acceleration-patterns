# The Cell-Based Control Plane: Architecture

## Verification Status

This sample has been verified as working via automated integration tests and end-to-end deployment validation:

| Date | Commit | Test accounts | Region | Verified by | Notes |
|------|--------|---------------|--------|-------------|-------|
| 2026-11-23 | f0f4214 | two non-production test accounts (platform, one cell account) | eu-central-1 | control-plane stress slice (`scripts/stress/slice.sh`, tier `small`, `concurrentBuildLimit` 5, `STRESS_UNPACED=1`) | Build-slot wait (ADR-0049), every wave sent at once: a teardown (the 15 `DELETE_FAILED` deployments of the control run below deleted again, the cell, the tenants), `PS-1` (the cell, then 19 creates), two `build-limit-scaling` runs (20 deletes, then 20 creates) and a second teardown (20 deletes, the cell, the tenants). Every wave ended with 0 findings, 0 `*_FAILED` records and 0 isolation mismatches; 361 refused starts in 104 executions were retried, at most 11 in one execution. The deployed definition carried the refusal reason of this commit (read back from the live state machine). Control run on the code before ADR-0049, same stacks: one unpaced delete wave of 20 left 15 `DELETE_FAILED` (`CodeBuild.AccountLimitExceededException`, one try each). No transaction conflict occurred in these runs, so the terminal-write retry is covered by unit tests only. The later commits change docs, comments and tests, and in `src/` only the wording of the refusal reason (it names the project's or the account's limit); an integ-runner run on the head is still to come. Deploy of both stacks (the control run) 232 s, the redeploy with this commit 75 s; the teardowns 727 s and 772 s; the two stacks stay, for a destroy outside the run |
| 2026-11-19 | 93e7ae4 | two non-production test accounts | eu-central-1 | `npx projen integ` (integ-runner) | `SUCCESS integ.tenant 6359s`: every step of spec §10 passed, with the vendor hooks of ADR-044 in step 16 (global and application pre and post hooks around cell and deployment scripts, `SCRIPT_OUTPUTS` through the outputs guard, a failing pre and post hook, a skipped delete hook, the deny on the hook roles) and the asynchronous record operations of ADR-045 (202 and polling on every application, tenant and account call, hooks on tenant, application and account events in step 17, teardown through the API in step 18). Deploy about 5 min, assertions about 64 min, teardown about 37 min; nothing of the run left in either account apart from the harness's default Lambda log groups (README Known issues). The later commits change docs and comments only |
| 2026-11-18 | 255aa7b | two non-production test accounts | eu-central-1 | `npx projen integ` (integ-runner) | `SUCCESS integ.tenant 3115s`: every step of spec §10 passed, with the deployment inputs in step 1: both CodeBuild projects carried the stack's `concurrentBuildLimit` of 50 (ADR-0046), and B's cell provisioning role carried exactly the policy its stack attached through `cellBuildManagedPolicyArns` (ADR-0047). Nothing left in the control plane account. The later commits change docs, a comment, and the assertion that names B's cell role, which now derives the name from the fleet name and gets the same name the run used; the deployed templates are those of the run |
| 2026-11-16 | aa1221a | two non-production test accounts | eu-central-1 | `npx projen integ` (integ-runner) | `SUCCESS integ.tenant 3071s`: every step of spec §10 passed, with the required scope (R-38) in step 1: the listed machine client's `control-plane/read` token read and was refused on a write, its `control-plane/other` token was refused, and the unlisted client was refused. Deploy about 4 min, assertions 23 min, teardown about 24 min; nothing left in either account |
| 2026-11-16 | d6f0fcb | two non-production test accounts | eu-central-1 | `npx projen integ` (integ-runner) | `SUCCESS integ.tenant 2890s`: every step of spec §10 passed, with the client id path (R-38) in step 1: the listed machine client's token (no `aud`, `sub` equal to its client id) read and was refused on a write, and the unlisted client was refused. Nothing left in either account |
| 2026-11-13 | 219c26d | two non-production test accounts | eu-central-1 | `npx projen integ` (integ-runner) | `SUCCESS integ.tenant 3005s`: every step of spec §10 passed, with the reader grant (R-36) in step 1. Deploy about 4 min, assertions 22 min, teardown about 34 min; nothing left in either account |

**Integration test coverage:**
- Two-account, two-application deployment scenario
- Operator and reader grants: all ten reader reads, every reader write refused (its first call included), a role in neither list refused, nothing written
- Client id path (R-38): a listed machine client's token without `aud` reads and is refused on a write; its token without the required scope is refused; an unlisted client is refused
- Account handshake validation (external ID verification)
- Cell lifecycle: creation, tenant placement, reuse after evacuation
- Cross-account cell and tenant provisioning
- Admission controls: fleet capacity limits, allowlist enforcement
- Idempotency: replaying operations safely
- Complete teardown sequence in both accounts

**Test harness:** `test/integ.tenant.ts` — documented in `integration-test.md`

**Vendor hooks (ADR-044) and hooks on application, tenant and account events
(ADR-045):** covered by the 2026-11-19 run above and by unit tests
(`test/tenant/hook*.test.ts`, `test/tenant/tenant.hooks.test.ts`,
`test/shared/hook-transactions.test.ts`,
`test/tenant/record-event.types.test.ts`,
`test/tenant/record-writes.test.ts`,
`test/tenant/record-event-workflow.test.ts`,
`test/tenant/tenant.record-events.test.ts`). The runs before it predate
hooks and called the seven record operations as synchronous.

---

> Status: **Implemented** — the current architecture. Applications are
> registered at run time and every cell is stamped from its application;
> a tenant is a customer record and each of its deployments is placed into
> a cell of one application, in a registered account. The integration test
> (`test/integ.tenant.ts`, described in
> [`integration-test.md`](./integration-test.md)) exercises the whole
> lifecycle against deployed infrastructure in **two accounts** with **two
> applications**: application registration, the account handshake (no
> pair; a pair that does not require the external id it is given; missing
> and wrong external id), account registration with and without an
> application allowlist, tenant records, implicit cell creation in the
> vendor-owned account, one tenant in two applications, idempotent replay,
> the fleet-full refusal, the admission refusal, targeted placement into a
> tenant-owned account whose role pair carries an external id,
> cross-account cell and tenant builds, the in-flight / occupied-tenant /
> occupied-cell / occupied-account / occupied-application guards, reads
> with every filter, reuse of an emptied cell, and complete teardown in
> both accounts. Vendor hooks run before and after each cell and
> deployment script in the control plane account (§7, Vendor hooks), and
> around each change to an application, a tenant or an account (§7,
> Record events). ADRs: see [`adr/`](./adr/README.md) (ADR-001..045).

## 1. Purpose

**Goal: a cell-based control plane for many applications, across
accounts.**

A multi-tenant control plane sample for **cell-based
deployments**.

An **application** is something the vendor deploys for tenants: a CodeBuild
source, the scripts that deploy it, and how many tenants share one
deployment (`maxTenants`). Operators register applications at run time with
`PutApplication` (ADR-032); one control plane serves any number of them.

A **tenant** is a customer of the vendor. A tenant can use any number of
the vendor's applications; each use is a **deployment** — the tenant in one
application, provisioned once and tracked through its own lifecycle
(ADR-037). A tenant has at most one deployment per application.

A *cell* is the deployment unit of one application: one **shared
application deployment** plus up to `maxTenants` deployments, each a
tenant's **own per-tenant application deployment** inside the cell. Setting
`maxTenants = 1` degenerates the cell model to the silo model — every
deployment gets its own cell — so the cell model is a strict generalisation
of a silo control plane (ADR-012).

Cells live in **accounts** (ADR-024). An account is an AWS account an
operator registered with a cell limit (`maxCells`), an owner, and the
applications it admits: a **vendor-owned** account is fleet capacity that
placement fills; a **tenant-owned** account belongs to a customer and
receives only deployments whose `CreateDeployment` names it. An account
without an application allowlist is **shared** and admits every
application; one with `applicationIds` is **dedicated** to those
(ADR-033). New cells go to dedicated accounts before shared ones (ADR-035),
and inside each group the application's **placement strategy** decides:
`FILL` takes the oldest registered account until it is full, `ROUND_ROBIN`
the one with the fewest cells (ADR-036). The account owner installs a
provisioning role pair (ADR-025) and can withdraw it; the control plane
holds no credentials for any account, only its id. The control plane's own
account is registered like any other. Scenarios that follow directly:
scaling the fleet to a second account in the Region, spreading an
application's cells over several accounts, hosting several applications in
one account, one customer using several applications, and deploying into
the customer's own account on demand.

Deployment scripts may provision infrastructure or perform non-infrastructure setup. An "empty" deployment is represented by explicit, idempotent no-op lifecycle scripts; both script sets remain required so every lifecycle path has a total contract. This supports the following scenarios:

* Dedicated resources per tenant
  * Shared: No infra
  * Per-tenant: Full stack, other tenant provisioning (optional)
* Shared resources across tenants
  * Shared: Full stack
  * Per-tenant: No infra, other tenant provisioning (optional)
* Shared infrastructure, logical dedicated resources
  * Shared: Database cluster, compute
  * Per-tenant: Database instance (on shared cluster), S3 object store, other tenant provisioning (optional)

It demonstrates:

- **Application registry** — operators register applications
  (`PutApplication`), read and list them, and delete empty ones. An
  application's definition names a CodeBuild
  [`ProjectSource`](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ProjectSource.html)
  and two script sets: `cellScripts` (create/update/delete the shared cell
  deployment) and `tenantScripts` (create/update/delete a per-tenant
  deployment), plus `maxTenants`. Lifecycle operations invoke CodeBuild to
  run the matching script (ADR-002, ADR-012, ADR-032). The application's
  `cellCount` is the authoritative count of its cells. A put or delete
  answers 202 and takes effect when the workflow commits it (ADR-045).
- **Tenant management** — CRUDL for tenants; the mutations run no build
  and answer 202 (ADR-045). A tenant is a customer record (`name`,
  `description`, `deploymentCount`); creating one provisions nothing, and
  an empty tenant persists until an operator deletes it.
- **Deployment lifecycle** — `CreateDeployment` places a tenant into a cell
  of the named application with free capacity and provisions its per-tenant
  deployment; `UpdateDeployment` re-applies it; `DeleteDeployment`
  deprovisions it and frees the slot.
- **Cell lifecycle** — cells are created **implicitly**: when a deployment
  finds no cell of its application with free capacity, a new cell is
  provisioned first, then the deployment is placed into it (ADR-013). Cells
  are read, re-applied, and explicitly deleted (empty cells only) via the
  API; there is no explicit cell-create operation.
- **Vendor IdP authentication** — a vendor IdP (deployment-time input)
  protects every control plane operation via a Lambda Authorizer.
- **Account registry** — operators register accounts (`PutAccount`), see
  their occupancy (`ListAccounts`), and deregister empty ones. Registration
  verifies the handshake by assuming both roles of the pair and, when an
  external id is given, proving each role refuses the call without it
  (ADR-027, ADR-030); the
  account's `cellCount` is the authoritative cell counter, claimed and
  released by the same transactional discipline as the cell's `tenantCount`.
  A put or delete answers 202, like an application's.
- **Vendor hooks** — vendor code the workflow runs before or after each
  cell and deployment script, in the control plane account under roles no
  cell account holds or trusts (ADR-044). Global hooks are registered with
  `PutHook` and apply to every application; application hooks are part of
  an application's definition and are stamped onto its cells. A pre hook
  can stop a create or update before the script runs; a post hook sees the
  script's outputs. A downstream system that admits only a hook role admits
  only the vendor, even for a cell in a tenant-owned account. Hooks also
  run on the nine events of application, tenant and account records
  (ADR-045), where a pre hook can refuse a create or an update before it
  takes effect.

Cells are **homogeneous by construction, per application**: the
application's definition is stamped onto each of its cell records at
creation, and every deployment in a cell is provisioned with that cell's
stamped definition. Tenants and deployments carry no source or scripts of
their own — a deployment must be placeable into any cell of its
application with capacity, which per-tenant provisioning definitions would
break (ADR-012, ADR-032). A replaced application definition reaches only
cells created afterwards.

The design is one service: applications, accounts, cells, tenants,
deployments and global hooks share one API, one table, one workflow. The
deployment is the join between a tenant and the cells of its applications;
it lives as `deployment.cellId` on a record keyed by tenant and application,
not as a separate placement service (ADR-037).

Out of scope: billing/metering, tenant tiers, cell rebalancing/migration
(between cells or accounts), dependencies between applications,
pre-provisioning capacity ahead of demand, placement by load, account
vending, a Region per account, and all application plane concerns —
including customer identity (ADR-004).

## 2. Actors and Identity Model

Control plane callers are **vendor operators**; the **vendor IdP** (OIDC issuer URL + audience) is a
deployment-time input consumed by the Lambda Authorizer (JWKS-based JWT
validation) on every operation. There are no unauthenticated operations.

### Caller context

The authorizer writes `sub`, `role` (ADR-006) and `grant` (ADR-042); the
handler is a pass-through building an immutable
`CallerContext { operatorId, role, grant }`, and answers 500 when the grant
is missing or unknown; the
service receives `CallerContext` per operation and a static `ServiceConfig`
at cold start. Callers act across tenants, applications and cells — control
plane data is not tenant-scoped by caller.

The configured issuer is a dedicated control-plane trust boundary: it issues
tokens to vendor operators and to the reader systems the deployer names.
Before the role is read, the audience step takes one path per token
(ADR-043): a token with an `aud` key must name the audience; a token
without one, such as a Cognito client-credentials access token, passes only
when its `client_id` is in `VENDOR_IDP_CLIENT_IDS` (default none) and
equals `sub`, so a listed machine client acts as itself and a person's
access token through it is refused. When `VENDOR_IDP_REQUIRED_SCOPE` is
set, that token's `scope` must also hold it, which binds it to this API.
The authorizer maps the `role` claim to one of two grants (ADR-018,
ADR-042): a value in `ALLOWED_ROLES` (default `operator`) gets the operator
grant, a value in `READER_ROLES` (default none) the reader grant, and a
token whose `role` is missing or in neither list is denied, never
defaulted. A value in both lists fails synth and cold start. The grant is
the authorizer's policy: the whole stage for an operator, `GET/*` for a
reader, computed from the grant alone so the token-keyed cache never holds
a Deny for a reader's reads (`src/shared/authorizer-policy.ts`). The service
checks again by operation name (`src/shared/grant-check.ts`): the twelve read
operations are open to both grants, every other operation requires the
operator grant and refuses a reader with `UnauthorizedError` (403). This
backstops issuer misconfiguration and issuer scope creep — a broader
population's tokens do not carry either role value. Every operator holds all
twenty-six operations (ADR-015); finer operator roles are the recorded seam
(spec §11), and connecting a general workforce or customer issuer needs them
first.

## 3. Components

```
                     vendor JWT
Vendor operator ─────────────────────┐
                                     ▼
              ┌───────────────────────────────────────────┐
              │ API Gateway (REST, Smithy-generated)       │
              │  + Lambda Authorizer (vendor IdP, JWKS)    │
              └────────────────────┬──────────────────────┘
                                   │
                        ┌──────────▼───────────┐
                        │ Tenant Service        │
                        │ (Lambda)              │
                        │ DDB: applications,    │◄───────────┐
                        │ accounts, cells,      │            │ terminal status
                        │ tenants, deployments  │            │ written directly
                        │ (one table)           │            │
                        └──────────┬───────────┘            │
                                   │ async ops (202)         │
                        ┌──────────▼──────────────────┐     │
                        │ Provisioning Workflow        │─────┘
                        │ (Step Functions)             │
                        │  ├ optional cell build       │
                        │  │  (create/update/delete    │
                        │  │   shared cell deployment) │
                        │  └ optional tenant build     │
                        │     (create/update/delete    │
                        │      per-tenant deployment)  │
                        │  each build wrapped in its   │
                        │  event's pre and post hooks  │
                        │  or one record event: pre    │
                        │  hooks, commit, post hooks   │
                        └──────────────┬───────────────┘
                                       │ startBuild / batchGetBuilds / stopBuild
                        ┌──────────────▼───────────────┐
                        │ Hook builds (CodeBuild),     │
                        │ control plane account only:  │
                        │  <fleet>-global-hook project │
                        │  <fleet>-app-hook project    │
                        │ no pair trust, no AssumeRole │
                        └──────────────────────────────┘
```

One service, one API, one DynamoDB table, one state machine, and four
shared CodeBuild projects — for any number of applications: two
provisioning projects, one for cell builds and one for tenant builds, and
two hook projects, one for global hooks and one for application hooks
(ADR-044). The workflow has an optional first build phase: a deployment
that needs a new cell runs the cell create build, then the tenant create
build, in a single execution. Each build serves one event and runs inside
that event's hooks (§7, Vendor hooks). A change to an application, a tenant
or an account runs no build: its execution runs the record event's hooks
around one conditional write to the table, the commit (§7, Record events).

```
                                              sts:AssumeRole (external id)
  CodeBuild cell scripts  ──┐            ┌──► Account A (vendor-owned, shared)
  CodeBuild tenant scripts ─┴── bus ─────┤      <fleet>-cell-provisioning
                                         │      <fleet>-tenant-provisioning
                                         │      /application-plane/* (SSM)
                                         │      cells of applications X and Y
                                         └──► Account B (tenant-owned, admits Y)
                                                same pair, same namespaces
                                                cells of application Y
```

Cells of different applications in one account differ only in the
definition they were stamped from; the account, its role pair and its cell
limit do not know which application a cell serves.

The CodeBuild project roles hold no application-plane permission (ADR-025).
Every account that hosts cells — the control plane's own included — installs the
**account role pair** `<fleet>-cell-provisioning` / `<fleet>-tenant-provisioning`
(`src/cell-account/cell-account.cdk.ts`: the `CellAccountRoles` construct,
deployed by the control plane stack into its own account and by the
`CellAccountStack` into every other). Each half trusts its control-plane
build role and the control-plane API role (`<fleet>-api`, for the registration
probe, ADR-028) by `aws:PrincipalArn`, optionally behind `sts:ExternalId`, and
carries the cell-script/tenant-script asymmetry (§7). The build roles may only
assume their half of the pair, by name, in any account; the buildspec does so
before the script runs. The pair in each account is the provisioning blast
radius and the hardening point; the account owner decides what it may do.
One pair serves every application the account admits.

The hook projects run in the control plane account under two roles of their
own, `<fleet>-global-hook` and `<fleet>-app-hook`
(`src/tenant/tenant.cdk.ts`, `hookRole`). No pair trusts either role,
neither is granted `sts:AssumeRole` on a pair, and each holds only its
project's logs and the customer-managed policies the deployer attaches
(`globalHookManagedPolicyArns`, `appHookManagedPolicyArns`); read on a hook
source is the deployer's grant, as for the provisioning projects (N-6). Both
build roles and both hook roles trust CodeBuild only on their own project's
`aws:SourceArn`. Those four roles and the home account's pair carry one
standalone explicit deny (`src/tenant/control-plane-deny.ts`, the
`ControlPlaneDeny` policy) on every grant that would lead back to the pair:
passing the stack's roles, writing their policies, starting or changing the
four projects or the workflow, redriving its executions, changing the API or
authorizer function, invoking the API function or changing its permissions,
writing the REST API, and writing the table (spec R-41, §7 Vendor hooks).

## 4. Data Model

Single table, six entity types — application, account, cell, tenant,
deployment, global hook — plus a small control-plane-internal idempotency
record type (ADR-017) and the hook counter (ADR-044).

### Application (ADR-032)

| Field | Type | Notes |
|---|---|---|
| `applicationId` | string | operator-chosen, `[a-z0-9-]{1,32}` — the item's identity, never generated; usable as a parameter path segment (§7) |
| `source` | `SourceDefinition` | the CodeBuild source of the application's scripts |
| `cellScripts` | `ScriptLocations` | shared deployment lifecycle |
| `tenantScripts` | `ScriptLocations` | per-tenant deployment lifecycle |
| `maxTenants` | integer | deployments per cell, at least one; a replaced value applies to cells created afterwards |
| `placementStrategy` | enum | `FILL \| ROUND_ROBIN`, default `FILL`; orders accounts when a new cell is created (§6, ADR-036); never stamped |
| `hooks` | `HookDefinition` list | the application hooks, at most five, ids unique in the list (ADR-044); part of the definition, stamped onto each new cell. An absent `hooks` on `PutApplication` keeps the stored list, `[]` clears it |
| `cellCount` | integer | the authoritative count of this application's cells — claimed by the new-cell placement transaction, released by the cell-delete transaction; never written by `PutApplication` |
| `status` | enum | `CREATING \| ACTIVE \| UPDATING \| DELETING \| CREATE_FAILED \| UPDATE_FAILED \| DELETE_FAILED` (ADR-045); absent on a record stored before statuses existed, read as `ACTIVE` |
| `statusReason` | string? | populated on failure |
| `lastGlobalHooks` | list | as on the cell, for the application's last event |
| `pending` | object? | present only while `UPDATING`: the definition, the strategy and each list a replacing `PutApplication` sent, staged until the workflow commits them |
| `operationId` | string | the name of the execution the last accepted operation started (`<applicationId>-application-<verb>-<ms>-<hex8>`); written only by the API, and every workflow write and compensation on the record is conditioned on it |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=APPLICATION#<applicationId>`, `SK=META`. `source`,
`cellScripts`, `tenantScripts`, `maxTenants` and `hooks` are the
application's **definition**, the bundle a new cell is stamped from. The
source location and version and the script paths are held to the hook
charsets (URL characters without `@`, git ref characters, path characters),
which JSON never escapes, so the definition is as large in the execution
input as it is raw.

The record is **live** in `ACTIVE`, `UPDATING` and `UPDATE_FAILED` (or
with no status): its definition is in force and placement may count a new
cell against it (`src/tenant/record-event.types.ts`, `isLive`). Every
condition treats an absent status as `ACTIVE`, so records stored before
ADR-045 need no migration. `PutApplication` is one conditional
`UpdateItem` on every path, its path chosen from a strongly consistent read
(`src/tenant/application.data-model.ts`, `putApplicationUpdate`): a create
inserts the record `CREATING` (`attribute_not_exists(PK)`); a re-put of a
`CREATE_FAILED` record writes the values and moves it back to `CREATING`;
a replace of a live record (`ACTIVE`, `UPDATE_FAILED` or no status) writes
the values into `pending` and moves it to `UPDATING`, leaving the live
definition unchanged until the workflow commits it. Every path stores a new
`operationId` and sets `cellCount` and `createdAt` through `if_not_exists`,
so a re-put never resets them (spec R-29). On a re-put or a replace, a
declaration list the request does not send adds a condition that the
stored list is as read.
`DeleteApplication` is one conditional move to `DELETING` (`cellCount = 0`
and status `ACTIVE` or a `*_FAILED` status), the counterpart of the
cell-slot claim; the workflow deletes the record.

### Account (ADR-024)

| Field | Type | Notes |
|---|---|---|
| `accountId` | string | the AWS account id, 12 digits — operator-supplied, the item's identity |
| `owner` | enum | `VENDOR \| TENANT`; immutable after registration (`PutAccount` with another owner is a 409) |
| `applicationIds` | string list? (unique, never empty) | absent: the account is **shared** and admits every application; present: the account is **dedicated** and admits only those (ADR-033). Each id must name a registered application when written (404 otherwise); replaceable; narrowing it stops new cells of the removed applications there and withdraws their cells' free slots from untargeted placement; the cells stay |
| `maxCells` | integer | cell capacity; replaceable; lowering below `cellCount` only stops new cells |
| `cellCount` | integer | the authoritative cell counter — claimed by the new-cell placement transaction, released by the cell-delete transaction; never written by `PutAccount` |
| `externalId` | string? | required when `owner = TENANT`, optional for `VENDOR` (ADR-029); presented on every AssumeRole into the account (ADR-025); never returned by the API (`externalIdConfigured` is); never staged |
| `status`, `statusReason`, `lastGlobalHooks`, `operationId` | | as on the application (ADR-045) |
| `pending` | object? | present only while `UPDATING`: the `maxCells` and `applicationIds` a replacing `PutAccount` sent (an absent `applicationIds` makes the account shared on commit) |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=ACCOUNT#<accountId>`, `SK=META`. `PutAccount` is one
conditional `UpdateItem` whose path comes from a strongly consistent read
(`src/tenant/account.data-model.ts`, `putAccountUpdate`): a create inserts
the account `CREATING` (`attribute_not_exists(PK)`) and initialises
`owner`, `cellCount` and `createdAt`; a re-put of a `CREATE_FAILED` account
writes the policy fields and moves it back to `CREATING` (`owner =
:owner`); a replace of a live account writes `externalId` at once, stages
`maxCells` and `applicationIds` in `pending` and moves it to `UPDATING`
(`owner = :owner`, status `ACTIVE`, `UPDATE_FAILED` or none); a **rotation**
on an `UPDATING` account writes only `externalId`, conditioned on `owner`,
`UPDATING` and the `operationId` it read, and starts no execution. On every
path but the create, an absent `externalId` removes the stored one. No path
writes `cellCount`, so a capacity cut and a concurrent claim compose
without a lost update (spec R-24). `DeleteAccount` is one conditional move
to `DELETING` (`cellCount = 0`), the counterpart of the cell-slot claim;
the workflow deletes the record.

### Cell

| Field | Type | Notes |
|---|---|---|
| `cellId` | string (ULID) | generated |
| `applicationId` | string | the application the cell serves — assigned at creation, never changes (ADR-032) |
| `accountId` | string | the account the cell is provisioned in — assigned at creation, never changes (ADR-024) |
| `status` | enum | `CREATING \| ACTIVE \| UPDATING \| DELETING \| CREATE_FAILED \| UPDATE_FAILED \| DELETE_FAILED` |
| `maxTenants` | integer | stamped from the application's definition at creation (ADR-012) |
| `tenantCount` | integer | atomic slot counter — the number of deployments in the cell, the capacity and occupancy guard (ADR-013) |
| `source` | `SourceDefinition` | stamped from the application's definition |
| `cellScripts` | `ScriptLocations` | stamped — shared deployment lifecycle |
| `tenantScripts` | `ScriptLocations` | stamped — per-tenant deployment lifecycle |
| `hooks` | `HookDefinition` list | stamped — the application hooks of every event of the cell and of its deployments (ADR-044) |
| `lastBuildId` | string? | most recent successful cell-scoped CodeBuild build ARN |
| `lastGlobalHooks` | list | the global hooks that ran for the cell's last event, in run order: `hookId`, `phase`, `revision`, the `sourceVersion` it names and the `resolvedSourceVersion` its build's final poll reported (absent for an S3 source). Written only by the workflow's terminal writes; empty when none ran |
| `statusReason` | string? | populated on failure |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=CELL#<cellId>`, `SK=META`. The stamped definition is immutable for
the cell's lifetime — replacing the application's definition affects only
cells created afterwards (ADR-012, ADR-032). New provisioning *code* flows
in without a definition change: git sources are fetched fresh on every
build.

### Tenant

| Field | Type | Notes |
|---|---|---|
| `tenantId` | string (ULID) | generated |
| `name` | string | required; not unique |
| `description` | string? | |
| `deploymentCount` | integer | the authoritative count of the tenant's deployments — claimed by both placement transactions, released by the deployment-delete transaction; never written by `CreateTenant` or `UpdateTenant` |
| `status`, `statusReason`, `lastGlobalHooks`, `operationId` | | as on the application (ADR-045) |
| `pending` | object? | present only while `UPDATING`: the merged `name` and `description` an `UpdateTenant` writes |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=TENANT#<tenantId>`, `SK=META`. The tenant carries **no source,
no scripts, no cell and no build state** — everything provisioned for a
tenant is a deployment (ADR-037). `CreateTenant` inserts the record
`CREATING` (conditional on non-existence). `UpdateTenant` merges the
request into the stored `name` and `description` and stages the result in
`pending`, moving the tenant to `UPDATING` in one conditional write on
`ACTIVE`/`UPDATE_FAILED` and on the `operationId` it read, so the merge
cannot land on a record another update has committed since
(`src/tenant/record-writes.ts`, `stageRecordTransition`, `operationIdAsRead`).
A merged value without a description removes it on commit. `DeleteTenant`
is one conditional move to `DELETING` (`deploymentCount = 0`), the
counterpart of the deployment claim (`deleteRecordTransition`); the
workflow deletes the record. Tenant builds read `TENANT_NAME` from the live
`name`, never from `pending`.

### Deployment (ADR-037)

| Field | Type | Notes |
|---|---|---|
| `tenantId` | string | the tenant — with `applicationId` the item's identity |
| `applicationId` | string | the application; one deployment per tenant per application |
| `cellId` | string | the placement — assigned at creation, never changes; always a cell of `applicationId` |
| `status` | enum | `CREATING \| ACTIVE \| UPDATING \| DELETING \| CREATE_FAILED \| UPDATE_FAILED \| DELETE_FAILED` |
| `lastBuildId` | string? | most recent successful tenant-scoped CodeBuild build ARN |
| `lastGlobalHooks` | list | as on the cell, for the deployment's last event |
| `statusReason` | string? | populated on failure |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=TENANT#<tenantId>`, `SK=DEPLOYMENT#<applicationId>`. A tenant's
deployments share its partition and are one base-table query. The
deployment carries **no source and no scripts** — its effective definition
is its cell's stamped definition.

Writes are field-owned (ADR-011): after initial creation,
service and workflow use `UpdateItem` expressions touching only the fields
each operation owns. Lifecycle transitions are compare-and-set writes,
conditional on the exact status read or on the operation's explicit accepted
status set. Metadata and failure writes are additionally conditional on
`attribute_exists(PK)` so no write can recreate a concurrently deleted record
as a ghost (§7).

### Global hook (ADR-044)

| Field | Type | Notes |
|---|---|---|
| `hookId` | string | operator-chosen, `[a-z0-9-]{1,32}` — the item's identity; orders global hooks (byte order) |
| `events` | enum list | non-empty, distinct: `CELL_CREATE \| CELL_UPDATE \| CELL_DELETE \| DEPLOYMENT_CREATE \| DEPLOYMENT_UPDATE \| DEPLOYMENT_DELETE` and the nine record events `APPLICATION_*`, `TENANT_*`, `ACCOUNT_*` (`CREATE`, `UPDATE`, `DELETE`; ADR-045). An application hook may name the cell, deployment and `APPLICATION_*` events only |
| `phase` | enum | `PRE \| POST` |
| `source` | `{type, location, sourceVersion?}` | the shape of an application's source; `location` admits URL characters without `@`, so it carries no userinfo; a ref that is not a full commit SHA is accepted with a logged warning naming the hook (ADR-020) |
| `script` | string | path in the source, `[A-Za-z0-9._/-]{1,256}` |
| `timeoutMinutes` | integer | 5–30, default 10, stored resolved; the hook build's run timeout |
| `revision` | integer | 1 on create, incremented by every replace |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=HOOK`, `SK=HOOK#<hookId>`; the **hook counter** is
`PK=HOOK`, `SK=META`, holding `hookCount`, at most five. One partition holds
every global hook, so the service reads them all in one strongly
consistent query (`SK begins_with HOOK#`) that leaves the counter out. No
status: hook operations are synchronous and run no build. `PutHook` creates
a hook in one transaction (insert `IF attribute_not_exists`, `hookCount + 1`
while below five) and replaces one with a single update conditioned on
existence that increments `revision`; `DeleteHook` deletes the hook and
decrements `hookCount` in one transaction (`src/shared/hook-transactions.ts`).
Those are the only two code paths that write `hookCount`. An application
hook uses the same definition shape without `revision` or timestamps.

### Idempotency record (ADR-017)

Written only when `CreateDeployment` carries a `clientToken` — as the last
item in the placement transaction (§6), never separately.

| Field | Type | Notes |
|---|---|---|
| `clientToken` | string | caller-supplied, 1–64 chars — the item's identity |
| `tenantId` | string | the tenant of the deployment the original request created |
| `applicationId` | string | the application of that deployment |
| `requestHash` | string | SHA-256 of the request parameters (`tenantId`, `applicationId`, `adminEmail`, `accountId`) — reuse with different input is a 409 |
| `createdAt` | timestamp | |
| `expiresAt` | number | epoch seconds — the table's DynamoDB TTL attribute (24h) |

Keys: `PK=IDEMPOTENCY#<clientToken>`, `SK=META`. No GSI attributes — the
record is never listed and never returned; it exists only to cancel a
replayed placement transaction. TTL deletion is lazy, so a token is honoured
for **at least** 24 hours; replay handling ignores `expiresAt` and treats
any surviving record as authoritative. `DeleteDeployment` does not remove
it: a replay after the delete is a 409, not a silent re-create.

### GSI-1 / GSI-2 / GSI-3 — listing and per-cell / per-account / per-application lookup

Three GSIs serve nine listing patterns; a tenant's deployments and the
global hooks are base-table queries. Each item carries at most one partition
attribute per index:

| Index | Item | PK | SK | Serves |
|---|---|---|---|---|
| GSI-1 | Cell | `CELL` (static) | `CELL#<cellId>` | unfiltered `ListCells` |
| GSI-1 | Account | `ACCOUNT` (static) | `ACCOUNT#<accountId>` | `ListAccounts`, placement account scan |
| GSI-1 | Application | `APPLICATION` (static) | `APPLICATION#<applicationId>` | `ListApplications` |
| GSI-1 | Deployment | `CELL#<cellId>` | `DEPLOYMENT#<tenantId>` | `ListDeployments?cellId=` filter |
| GSI-2 | Tenant | `TENANT` (static) | `TENANT#<tenantId>` | `ListTenants` |
| GSI-2 | Deployment | `DEPLOYMENT` (static) | `DEPLOYMENT#<tenantId>#<applicationId>` | unfiltered `ListDeployments` |
| GSI-2 | Cell | `ACCOUNT#<accountId>` | `CELL#<cellId>` | `ListCells?accountId=` filter, targeted candidate scan |
| GSI-3 | Cell | `APPLICATION#<applicationId>` | `CELL#<cellId>` | `ListCells?applicationId=` filter, untargeted candidate scan |
| GSI-3 | Deployment | `APPLICATION#<applicationId>` | `DEPLOYMENT#<tenantId>` | `ListDeployments?applicationId=` filter |
| base table | Deployment | `TENANT#<tenantId>` | `begins_with DEPLOYMENT#` | `ListDeployments?tenantId=` filter |
| base table | Global hook | `HOOK` (static) | `begins_with HOOK#` | `ListHooks`, hook resolution (strongly consistent) |

Account and application items carry GSI-1 attributes only, tenant items
GSI-2 only; cells and deployments appear in all three; idempotency records,
global hooks and the hook counter in none. A cell of one application holds
at most one deployment per tenant, so `DEPLOYMENT#<tenantId>` is unique
inside a cell or application partition. ULID sort keys give the cell, tenant
and deployment listings creation order; accounts and applications list by
id. The static partitions are a deliberate trade-off, fine at sample fleet
sizes.

All three GSIs project **all attributes** (`ProjectionType: ALL`): the
placement candidate scan needs `status`, `tenantCount`, and `maxTenants`,
and the listings return full summaries — with `ALL`, each is a single query
with no follow-up base-table reads. The write amplification is irrelevant
at sample scale; a production fleet would trim to `INCLUDE` projections.

The GSIs are **eventually consistent and never authoritative**: the four
counters — `tenantCount` on the cell, `deploymentCount` on the tenant, and
`cellCount` on the account and on the application — not GSI counts, are
the occupancy guards, and every claim is a conditional write on the base
table (§6). The GSIs nominate candidates; the base table decides. Every
list query is pinned to a partition the request names (a static constant or
a validated id), never one taken from the pagination token (ADR-016).

### `SourceDefinition` / `ScriptLocations`

`ScriptLocations` names the three scripts of one script set. `SourceDefinition`
has `type`, `location`, and an optional `sourceVersion` — a git ref
forwarded to CodeBuild StartBuild as `SourceVersion`. A full 40-character
commit SHA pins the provisioning source immutably (ADR-020); `PutApplication`
logs a warning when the ref is absent or mutable and accepts the
definition. These shapes live on the application record and are stamped
onto cell records, never onto tenants or deployments.

## 5. API — All Operations

Smithy `restJson1`, generated OpenAPI → API Gateway + Lambda proxy, token
authorizer applied per operation. Paths lowercase, plural collections,
singleton sub-resource singular.

### Tenant operations

No tenant operation runs a build (ADR-037). The three mutations answer 202
so that hooks on tenant events can gate them (ADR-045); how a record event
is started and compensated is in §7, Record events.

| Operation | HTTP | Status | Behaviour |
|---|---|---|---|
| `CreateTenant` | `POST /tenants` | **202** | Input `{name, description?}`. Reads the global hooks, inserts the record `CREATING` with `deploymentCount = 0` and a new `operationId` (conditional on non-existence), and starts `TENANT_CREATE`. Nothing is provisioned. A start that Step Functions refused deletes the record again (500, nothing left); an unknown start outcome leaves it `CREATE_FAILED` (500) |
| `GetTenant` | `GET /tenants/{tenantId}` | 200 | The polling endpoint: `name`, `description`, `deploymentCount`, `status`, `statusReason`, `lastGlobalHooks`, `operationId`, and `pending` while an update is staged. 404 if missing |
| `UpdateTenant` | `PUT /tenants/{tenantId}` | **202** | Metadata only (`name`, `description`); never `deploymentCount`. An omitted field keeps its stored value. One conditional write stages the merged values in `pending` and moves the tenant to `UPDATING` (from `ACTIVE`/`UPDATE_FAILED`, `operationId` as read), then `TENANT_UPDATE` starts; the live values change at the commit. 404 if missing; 409 while in flight (retry once it has finished), from `CREATE_FAILED`, `DELETING` or `DELETE_FAILED`, or when another operation was accepted since the read (retry) |
| `DeleteTenant` | `DELETE /tenants/{tenantId}` | **202** | **Empty tenants only**: one conditional move to `DELETING` (`deploymentCount = 0` and status `ACTIVE` or a `*_FAILED` status); 409 otherwise, with a retry hint while `CREATING` or `UPDATING`. `TENANT_DELETE` runs the pre hooks, deletes the record (conditioned on `DELETING`, the `operationId` and `deploymentCount = 0`), then the post hooks. Deployments are deleted first, one by one |
| `ListTenants` | `GET /tenants` | 200 | Paginated, unfiltered, with each tenant's `status`. The tenants of one cell or application are listed through `ListDeployments` |

### Deployment operations (ADR-037)

| Operation | HTTP | Status | Sync/Async | Behaviour |
|---|---|---|---|---|
| `CreateDeployment` | `POST /tenants/{tenantId}/deployments` | **202** | Async | Input: `{applicationId, adminEmail, accountId?, clientToken?}` — **no resource definition**. 404 for an unknown tenant or an unregistered application. Placement (§6): in **one transaction**, claim a slot in an `ACTIVE` cell of the application with capacity — or claim a cell slot on an eligible account, count the cell on the application, and create a new cell record (`CREATING`, deployment slot pre-claimed, `applicationId` and `accountId` set, definition stamped) — count the deployment on the tenant, and persist the deployment `CREATING` with `cellId`; then start the workflow (tenant create build, preceded by the cell create build if a new cell was needed). `accountId` pins the deployment to one registered account (the only way into a tenant-owned one; 404 if unregistered; 400 if it does not admit the application, ADR-033); absent, vendor-owned accounts that admit the application only. 409 `ConflictError` when the tenant already has a deployment of the application; 409 `InsufficientCapacityError` when no eligible account has cell capacity (ADR-026). Returns the deployment including `cellId`. `adminEmail` is pass-through bootstrap input, never persisted (ADR-004). `clientToken` makes the call idempotent (ADR-017): a retry with the same token returns the original deployment; reuse with different parameters is a 409 |
| `GetDeployment` | `GET /tenants/{tenantId}/deployments/{applicationId}` | 200 | Sync | The polling endpoint — `status`, `statusReason`, `lastBuildId`, `lastGlobalHooks`, `cellId`, `createdAt`, `updatedAt` (RFC 3339 `date-time` in UTC with milliseconds; the serializer drops a `.000` fraction, so parse before comparing), plus the **effective definition** (`source`, `scripts` and the application hooks resolved from the cell's stamped definition) and the cell's `accountId`. 404 if missing |
| `UpdateDeployment` | `PUT /tenants/{tenantId}/deployments/{applicationId}` | **202** | Async | Re-apply the deployment: **no body** — runs the cell's stamped **tenant update** script. Allowed when the deployment is `ACTIVE`/`UPDATE_FAILED` **and** the cell is `ACTIVE`; 409 otherwise. 404 if missing |
| `DeleteDeployment` | `DELETE /tenants/{tenantId}/deployments/{applicationId}` | **202** | Async | 409 if the deployment is in-flight. Allowed from `ACTIVE` and all `*_FAILED` states **regardless of cell status** — the delete script is the cleanup path, including when the cell itself is `CREATE_FAILED`. Sets `DELETING`; the workflow runs the **tenant delete** script, then in one transaction removes the record, decrements the cell's `tenantCount` and the tenant's `deploymentCount` |
| `ListDeployments` | `GET /deployments[?tenantId=\|?cellId=\|?applicationId=]` | 200 | Sync | Paginated. At most one filter per request (400 for two). `tenantId` is a base-table query, `cellId` uses GSI-1, `applicationId` GSI-3, no filter GSI-2. An unknown id yields an empty page, not a 404 (the filter is a query predicate, not a resource lookup) |

### Cell operations

| Operation | HTTP | Status | Sync/Async | Behaviour |
|---|---|---|---|---|
| `ListCells` | `GET /cells[?accountId=\|?applicationId=]` | 200 | Sync | Paginated fleet topology: `applicationId`, `accountId`, `status`, `tenantCount`/`maxTenants` per cell. At most one filter (400 for two): `accountId` via GSI-2, `applicationId` via GSI-3 — an unknown id yields an empty page, not a 404 |
| `GetCell` | `GET /cells/{cellId}` | 200 | Sync | Full cell record including `applicationId`, `accountId`, the stamped definition (application hooks included) and `lastGlobalHooks`. 404 if missing |
| `UpdateCell` | `PUT /cells/{cellId}` | **202** | Async | Re-apply the shared cell deployment: no body — runs the stamped **cell update** script. Allowed from `ACTIVE`/`UPDATE_FAILED`; 409 if in-flight or `CREATE_FAILED` — re-running the **update** script against a half-created shared deployment would break the create/update script contract, so remediation for a failed cell create is deployment delete + cell delete. 404 if missing |
| `DeleteCell` | `DELETE /cells/{cellId}` | **202** | Async | **Empty cells only**: 409 if `tenantCount > 0` or the cell is in-flight (ADR-014). Allowed from `ACTIVE` and `*_FAILED` states. Sets `DELETING` via a **single conditional `UpdateItem`** (`condition: status IN {ACTIVE, *_FAILED} AND tenantCount = 0`) — the emptiness check and the transition are one atomic write, the counterpart of the placement claim. A read-then-write here would let a concurrent placement claim a slot before `DELETING` lands; condition failure maps to the 409. Once `DELETING` is set, placement is closed (placement requires `ACTIVE`); the workflow runs the **cell delete** script, then removes the record and releases the account's cell slot and the application's count in **one transaction** (§7) |

### Account operations (ADR-024, ADR-027, ADR-033)

No account operation runs a build. `PutAccount` and `DeleteAccount`
answer 202 so that hooks on account events can gate them (ADR-045).

| Operation | HTTP | Status | Behaviour |
|---|---|---|---|
| `PutAccount` | `PUT /accounts/{accountId}` | **202** | Create-or-replace. Input `{owner, maxCells, applicationIds?, externalId?}`; `externalId` required when `owner = TENANT` (400 otherwise, ADR-029); `applicationIds` holds 1 to 100 distinct ids (400 otherwise), each naming a registered application (404 otherwise). A strongly consistent read picks the path of §4 and refuses an `owner` change or a status that admits no put (409) before any STS call. Then the handshake: the API function assumes both halves of the account's role pair with the given `externalId` and discards the credentials, and when an `externalId` is given assumes each half once more without it and requires that call to be refused (ADR-030); a refusal is a 400 naming the role and the reason (`ValidationException`); a probe STS could not answer is a 500 asking for a retry. Then one conditional `UpdateItem`: a create or re-put (`CREATING`) or a replace (`externalId` written, `maxCells`/`applicationIds` staged in `pending`, `UPDATING`), each starting `ACCOUNT_CREATE` or `ACCOUNT_UPDATE` after reading the global hooks; or, on an `UPDATING` account, a rotation that writes only `externalId` and starts nothing, allowed only when `maxCells` and `applicationIds` equal the change in flight (409 otherwise). A rotation that loses its condition reads the record once more and takes the path its new status selects, without a second probe. 409 while `CREATING`, `DELETING` or `DELETE_FAILED`. `cellCount` untouched |
| `GetAccount` | `GET /accounts/{accountId}` | 200 | The polling endpoint: `owner`, `applicationIds` (absent when shared), `cellCount`/`maxCells`, `externalIdConfigured`, `status`, `statusReason`, `lastGlobalHooks`, `operationId`, and `pending` (`maxCells`, `applicationIds`) while a replace is staged. 404 if unregistered |
| `ListAccounts` | `GET /accounts` | 200 | Paginated capacity view one level above `ListCells`, with each account's `status` |
| `DeleteAccount` | `DELETE /accounts/{accountId}` | **202** | **Empty accounts only**: one conditional move to `DELETING` (`cellCount = 0` and status `ACTIVE` or a `*_FAILED` status); 409 otherwise. `ACCOUNT_DELETE` runs the pre hooks, deletes the record, then the post hooks. The account's roles stay installed — removing them is the owner's act |

### Application operations (ADR-032, ADR-036)

No application operation runs a build. `PutApplication` and
`DeleteApplication` answer 202 so that hooks on application events can
gate them (ADR-045).

| Operation | HTTP | Status | Behaviour |
|---|---|---|---|
| `PutApplication` | `PUT /applications/{applicationId}` | **202** | Create-or-replace. Input `{source, cellScripts, tenantScripts, maxTenants, hooks?, placementStrategy?, parameters?, cellParameters?}`, validated as a whole by the generated server SDK and the service before any write (400 on a missing script path, a malformed source, a source field or script path outside its charset, `maxTenants < 1`, an unknown strategy, an id outside `[a-z0-9-]{1,32}`, more than five hooks, a repeated `hookId`, an invalid hook definition, an application hook on a `TENANT_*` or `ACCOUNT_*` event, or an invalid declaration). An unpinned source, the application's or a hook's, is accepted with a logged warning (ADR-020). An absent list (`hooks`, `parameters`, `cellParameters`) keeps the stored one; `[]` clears it. A strongly consistent read picks the path of §4; validation runs first, so a request that is both invalid and in flight is a 400. Then the global hooks are read, one conditional `UpdateItem` writes (create or re-put, `CREATING`) or stages (replace, `UPDATING`) the values, and `APPLICATION_CREATE` or `APPLICATION_UPDATE` starts with the application hooks of the definition being written. 409 while `CREATING`, `UPDATING`, `DELETING` or `DELETE_FAILED`, or when a kept declaration list changed after the read (retry). Cells already created keep their stamp |
| `GetApplication` | `GET /applications/{applicationId}` | 200 | The polling endpoint: the definition, `placementStrategy`, both declaration lists, `cellCount`, `status`, `statusReason`, `lastGlobalHooks`, `operationId`, and `pending` while a replace is staged. 404 if unregistered |
| `ListApplications` | `GET /applications` | 200 | Paginated: `applicationId`, `maxTenants`, `placementStrategy`, `cellCount`, `status` per application |
| `DeleteApplication` | `DELETE /applications/{applicationId}` | **202** | **Empty applications only**: one conditional move to `DELETING` (`cellCount = 0` and status `ACTIVE` or a `*_FAILED` status); 409 otherwise. `APPLICATION_DELETE` runs the pre hooks (global, then the stored application hooks), deletes the record, then the post hooks. Accounts that name the application in `applicationIds` are not touched; the id is inert there |

### Hook operations (ADR-044)

All synchronous — no hook operation runs a build or fires a hook, and no
operation runs a hook on demand.

| Operation | HTTP | Status | Behaviour |
|---|---|---|---|
| `PutHook` | `PUT /hooks/{hookId}` | 200 | Create-or-replace a global hook. Input `{events, phase, source, script, timeoutMinutes?}`, validated per §4 (400). The path is chosen from a strongly consistent read: a create claims a `hookCount` slot in the same transaction (a sixth hook → 409 without a retry hint: delete a hook first); a replace increments `revision`. A create or replace that raced a create or delete of the same hook → 409, retry. Applies to operations accepted afterwards; an unpinned source is accepted with a warning naming the hook |
| `GetHook` | `GET /hooks/{hookId}` | 200 | The definition, `revision`, timestamps. 404 if unregistered |
| `ListHooks` | `GET /hooks` | 200 | Paginated, in `hookId` order, the order global hooks run in |
| `DeleteHook` | `DELETE /hooks/{hookId}` | 200 | Deletes the hook and releases its `hookCount` slot in one transaction; 404 if unregistered. Executions already accepted keep the snapshot they hold; `StopExecution` is the only stop for them, and it strands their records |

Twenty-six operations: five tenant, five deployment, four cell, four
account, four application, four hook. Twelve are `GET` reads, the ones the
reader grant reaches, and twelve answer 202 with a record to poll: the five
cell and deployment mutations and the seven record operations. There is
deliberately **no `POST /cells`** — cell
creation is a placement outcome, not an operator action (ADR-013) — no
implicit account creation: an account exists only after an operator
registered it (ADR-024) — and no application-level provisioning: an
application owns no deployment of its own, only the definition its cells
are built from. The stamped definition is immutable per cell; a
definition-replacing `UpdateCell` body is a noted extension, not included.

### Status state machines

Cells, deployments, applications, tenants and accounts share one status
vocabulary:

```
            create                     update
  (none) ──────────► CREATING ──ok──► ACTIVE ◄──ok── UPDATING
                        │fail            │  ▲            │fail
                        ▼                │  └────────────┴──► UPDATE_FAILED ──► (update/delete allowed)
                  CREATE_FAILED          │ delete (empty only, for cells)
                        │delete          ▼
                        └──────────► DELETING ──ok──► (record deleted)
                                        │fail
                                        ▼
                                  DELETE_FAILED ──► (delete retry allowed)
```

For an application, a tenant or an account the same diagram holds, with
three differences (`src/tenant/record-writes.ts`). A put of a
`CREATE_FAILED` application or account goes back to `CREATING`. The record
is live in `ACTIVE`, `UPDATING` and `UPDATE_FAILED`, so a staged update
leaves it usable. A record with no status reads as `ACTIVE`. Updates
start from `ACTIVE` or `UPDATE_FAILED`, deletes from `ACTIVE` or any
`*_FAILED` status.

Transitional statuses remain the concurrency guard (409 on in-flight
mutations) for every entity type. Every transition into `CREATING`, `UPDATING`,
or `DELETING` is one conditional `UpdateItem` (or transaction member) that
checks the exact expected/accepted status. A read-time status check alone is
never the concurrency guard; a failed compare-and-set maps to 409.

Cross-entity guards:

- Placement requires the cell `ACTIVE` (a slot cannot be claimed in a
  `CREATING`/`UPDATING`/`DELETING`/failed cell) — the single condition that
  closes the place-into-deleting-cell race.
- `UpdateDeployment` (tenant build) requires the cell `ACTIVE` — no tenant
  builds against a shared deployment that is mid-change.
- The build guards are one-directional and **tolerated as such**:
  `UpdateDeployment`'s cell-`ACTIVE` check is read-then-act, and `UpdateCell`
  consults only the cell's own status (in-flight tenant builds don't change
  it) — so a cell build and a tenant build can overlap when their accepts
  race. Closing this would need an in-flight-build counter on the cell with
  the same conditional-claim discipline as placement; accepted instead — an
  overlap can fail a build (surfaced as `*_FAILED` + `statusReason`, on the
  documented retry paths) but never corrupts control plane state.
- `DeleteDeployment` is exempt from cell-status guards — cleanup must always
  be reachable.
- Placement counts a deployment only against a live tenant, and a new cell
  only against a live account and a live application: each claim is
  conditioned on `attribute_not_exists(status) OR status IN (ACTIVE,
  UPDATING, UPDATE_FAILED)` (`src/shared/repository.ts`, `LIVE_CONDITION`)
  and classified from the item it returns. That condition keeps a record's
  count at 0 from the moment its delete is accepted. A record that is not
  live is a 409, with a retry hint only while it is `CREATING`; a targeted
  account that is not live is a `ConflictError`, never
  `InsufficientCapacityError`. `DeleteDeployment` and `DeleteCell` stay
  exempt.

### Error shapes

`ValidationException` 400 (malformed input; two list filters at once; an
invalid application definition; a targeted `CreateDeployment` into an
account that does not admit the application; a `PutAccount` whose handshake
was refused; an invalid hook definition on `PutHook` or `PutApplication`),
`UnauthorizedError` 401/403, `ResourceNotFoundError` 404 (unknown tenant,
deployment, cell, account, application or global hook — including an
unregistered `CreateDeployment.accountId` or `applicationId` and an
unregistered id in `PutAccount.applicationIds`), `ConflictError` 409
(in-flight mutations; a second deployment of one application for one tenant;
occupied-tenant, occupied-cell, occupied-account and occupied-application
deletes; `owner` change; cell-not-ACTIVE guards; a tenant, account or
application that is not live at placement; a put or update on a record in
flight or being deleted, or one accepted since the request read it — retry;
a `CreateDeployment` that lost every bounded claim on candidate cells while
no account had a free cell slot — retry, ADR-031; `clientToken` reuse with
different parameters, ADR-017; a `PutHook` that raced a create or delete of
the same hook — retry; a sixth global hook — delete one first),
`InsufficientCapacityError` 409 (no eligible account has cell capacity;
nothing was written; the remedy is an operator act — raise `maxCells`,
register an account, or admit the application in one — ADR-026),
`InternalServerError` 500.

## 6. Placement and Capacity (ADR-013)

Placement happens synchronously inside `CreateDeployment`, before the
workflow starts:

```
0. Target (ADR-024, ADR-032, ADR-033, ADR-035, ADR-036):
     a clientToken already on record → replay (below) before anything else
     read the tenant and the application (404 if either is missing); the
       application record is the stamp for a new cell
     read every global hook in one strongly consistent query (ADR-044):
       before any write, so a failed read is a 500 with nothing written
     an account ADMITS the application when its applicationIds is absent
       (shared) or contains the id (dedicated)
     accountId given  → that one registered account (any owner; 404 if not
                        registered; 400 if it does not admit the
                        application); candidate cells = its GSI-2 partition
     accountId absent → every VENDOR-owned account that admits the
                        application: dedicated before shared, inside each
                        group ordered by the application's placementStrategy
                          FILL        → oldest registered first
                          ROUND_ROBIN → fewest cells first (cellCount as
                                        read), ties oldest first
                        candidate cells = the application's GSI-3 partition,
                        filtered to those accounts (a tenant-owned or
                        non-admitting account's cells are skipped)
1. Filter candidates: status=ACTIVE AND tenantCount < maxTenants; oldest first
2. For each candidate (oldest first, **at most 5**):
     TransactWriteItems:
       UpdateItem cell:
         SET tenantCount = tenantCount + 1
         CONDITION status = ACTIVE AND tenantCount < maxTenants   (first item)
       UpdateItem tenant: SET deploymentCount = deploymentCount + 1
         CONDITION attribute_exists(PK) AND live (ADR-045)
       PutItem deployment: status=CREATING, cellId=<candidate>
         CONDITION attribute_not_exists(PK)
       [PutItem idempotency record — only when clientToken supplied (ADR-017)
         CONDITION attribute_not_exists(PK); always last]
     success → slot claimed, tenant counted, deployment persisted atomically;
       stop
     idempotency condition cancelled → replay: return the original
       deployment (or 409 on parameter mismatch); takes precedence over every
       other classification
     deployment condition cancelled → the tenant already has a deployment of
       this application → 409; stop
     tenant condition cancelled → the tenant was deleted meanwhile → 404,
       or is not live → 409; stop
     capacity/status condition cancelled (lost a race) → try next candidate
     any other cancellation or transaction error → fail the request; never
       retarget the same deployment after an ambiguous transaction outcome
3. No candidate claimed (none found, or the candidate budget is exhausted):
     for each eligible account in order, TransactWriteItems:
       UpdateItem account: SET cellCount = cellCount + 1
         CONDITION attribute_exists(PK) AND cellCount < maxCells
                   AND live                                          (first item)
       UpdateItem application: SET cellCount = cellCount + 1
         CONDITION attribute_exists(PK) AND live
       PutItem new cell: status=CREATING, applicationId, accountId=<account>,
         tenantCount=1 (slot pre-claimed), definition stamped from the
         application record read in step 0
         CONDITION attribute_not_exists(PK)
       UpdateItem tenant: SET deploymentCount = deploymentCount + 1
         CONDITION attribute_exists(PK) AND live
       PutItem deployment: status=CREATING, cellId=<new cell>
         CONDITION attribute_not_exists(PK)
       [PutItem idempotency record — as above (ADR-017), still last]
     account condition cancelled alone → that account is full, or not live
       (read from the returned item); next account, or 409 when targeted
     application condition cancelled → application deleted meanwhile → 404,
       or not live → 409
     tenant / deployment / idempotency conditions → as in step 2
     every eligible account refused (or none) → 409 InsufficientCapacityError,
       nothing written (ADR-026)
     → workflow will run the cell create build before the tenant create build
```

Step 1's candidate list comes from a GSI and is **eventually consistent** —
a stale read can nominate a full or `DELETING` cell, and the conditional
claim in step 2 is what rejects it. Correctness lives entirely in the
base-table condition; the GSI read is an optimisation, never a guard — do
not "simplify" the claim into a plain write. The `PutItem`s are conditional
on `attribute_not_exists(PK)` too — fresh ULIDs make a collision negligible,
and the deployment insert is the uniqueness guard: one deployment per
tenant per application, decided by the write, not by a read. The account
order in step 3 is read from the account scan, so it nominates as well; a
stale `cellCount` can send a round-robin cell to an account one cell
fuller than the best one, and the account's conditional claim still
decides. Step 1 does not group or order by strategy: a cell with room is
reused before a new one is created, wherever it is.

**Slot lifetime = deployment record lifetime — atomically, at both ends.**
The claim, the tenant's count and the deployment record are created in one
`TransactWriteItems` (a service crash cannot leave a phantom slot with no
deployment record referencing it — a counter that could never be
decremented and would block `DeleteCell` and `DeleteTenant` forever), and
released in one — the delete workflow's terminal transaction (deployment
`DeleteItem` + cell `tenantCount` decrement + tenant `deploymentCount`
decrement in one `TransactWriteItems`). A `CREATE_FAILED` deployment still
holds its slot and its tenant's count; its remediation
(`DeleteDeployment`) is what frees them.

**The same holds one level up (ADR-024, ADR-032):** the account's
`cellCount` and the application's `cellCount` are claimed in the
transaction that creates the cell and released in the cell-delete
workflow's terminal transaction (cell `DeleteItem` + account and
application `cellCount` decrements). A `CREATE_FAILED` cell holds its
account slot and its application's count until `DeleteCell` releases them;
`PutAccount` and `PutApplication` never write a counter. Four counters, two
code paths each, all eight transactional.

**Tolerated races** (over-provisioning, never corruption):

- Two concurrent deployments that both find no capacity both create a cell —
  the fleet ends up with one more cell than strictly needed, **bounded by
  the account's `maxCells`** (the account claim refuses beyond it). Accepted:
  serialising cell creation would need a fleet-wide lock for a rare, benign
  outcome.
- Two deployments racing for an account's last cell slot: one claims, the
  other moves to the next eligible account or gets the 409. No corruption.
- Two applications placing at once into one shared account contend for the
  same cell slots; each loses at most one account claim per slot and moves
  on. Nothing an application does changes another's counters.
- Two concurrent `CreateDeployment` calls for the same tenant and
  application: one inserts, the other's deployment condition fails → 409.
  For the same tenant and different applications both succeed; the
  `deploymentCount` increment is a plain `ADD`, so the order does not
  matter.
- Under `ROUND_ROBIN`, two concurrent new-cell placements read the same
  `cellCount` and pick the same account; both land there if it has two free
  slots, leaving the spread one cell uneven until the next placement.
- Deployments arriving while the only cell is still `CREATING` cannot place
  into it (placement requires `ACTIVE`) and will create further cells.
  Accepted for the same reason; a real fleet warms capacity ahead of demand,
  which is out of scope.
- Oldest-first candidate order funnels concurrent claims at the same cell,
  so racing deployments burn one cancelled transaction per contended
  candidate before spreading. Accepted at sample fleet sizes — the same
  trade-off as the static GSI partitions; a production fleet would randomise
  candidate order (or use power-of-two-choices) to spread claim contention.
- The candidate budget (at most 5 claim attempts) keeps `CreateDeployment`
  comfortably inside the synchronous API Gateway window. Its miss case —
  every attempt loses a race on a cell that read as ACTIVE with room,
  whether another request took the slot or an operator moved the cell out
  of ACTIVE — falls through to new-cell creation: over-provisioning again
  rather than a failed placement. If that fall-through meets a full fleet,
  the request fails with a retryable `ConflictError` (the loop reports that
  its budget, not the fleet, ran out; the fleet was changing under the
  request), never with the terminal `InsufficientCapacityError` (ADR-031).

A non-`ACTIVE` cell accepts no placements — in particular, a cell stuck in
`UPDATE_FAILED` removes its remaining capacity from its application until
an operator re-runs `UpdateCell`; deployments meanwhile fill other cells or
create new ones. Visible in `ListCells` (`status`, `tenantCount`/`maxTenants`).

**Replay:** a `clientToken` already on record is recognised before
placement runs, so a fleet that filled or an account that was narrowed in
between does not turn the retry into a 400 or a capacity error; a token
that lands between that read and the transaction still cancels the
transaction and is classified there. A matching request hash returns the
original deployment whatever its current status; a different hash, a
deployment deleted since, or a record lost to the TTL race is a 409. The
hash covers `tenantId` and `applicationId`, so the same token for another
application is a 409.

**Compensation:** if `StartExecution` rejects after the placement
transaction, the service conditionally compensates the exact in-flight state.
For placement into an existing cell, one deployment update moves
`CREATING → CREATE_FAILED`. For a newly created cell, one
`TransactWriteItems` moves both the deployment and cell from `CREATING` to
`CREATE_FAILED`, so compensation cannot leave only one record recoverable.
Both remain on the documented remediation path (delete the deployment, then
the cell). Compensation never touches a counter: the `CREATE_FAILED`
records keep them until that path releases them.

**Residual tolerated failure:** a process crash *between* the placement
transaction and `StartExecution` can still strand the deployment — and, for
a new cell, the cell — in `CREATING` with no workflow running. The placement
transaction keeps the records mutually consistent (no phantom slot), but the
sample has no stuck-execution sweep, so this pre-execution gap requires manual
record repair. Known workflow failures, including build timeouts and terminal
write failures, are caught inside the state machine and routed to the
conditional `*_FAILED` transitions (§7) — but that failure write is itself a
DynamoDB write that can exhaust retries, so catching shrinks the stranding
window without eliminating it. Both gaps are why a production control plane
would additionally sweep aged transitional records. The same residual
applies to application, tenant and account records between their
conditional write and the workflow start (§7, Record events; threat T47).

## 7. Provisioning Workflow (Step Functions)

One state machine, resolved execution input (ADR-011: the service resolves
sources, script paths from the cell's stamp, and failure statuses; the
workflow rereads no mutable records). The first state,
`RecordEventRequested`, sends an input with a top-level `recordEvent` to
the record event path (Record events, below); every other input is a cell
or deployment input:

```json
{
  "sourceType": "GITHUB",
  "sourceLocation": "https://example/repository.git",
  "sourceVersion": "<full commit SHA or ''>",
  "operatorId": "<authorizer sub>",
  "sessionName": "<STS-safe operator id>",
  "accountId": "<12 digits>",
  "externalId": "<the account's external id, or ''>",
  "cellRoleArn": "arn:...:iam::<accountId>:role/<fleet>-cell-provisioning",
  "tenantRoleArn": "arn:...:iam::<accountId>:role/<fleet>-tenant-provisioning",
  "applicationId": "...",
  "cellId": "...",
  "cellBuild":   { "operation": "create|update|delete",
                   "scriptPath": "...", "failedStatus": "...",
                   "parameters": { "<NAME>": "<value>" },
                   "hooks": { "event": "CELL_CREATE|CELL_UPDATE|CELL_DELETE",
                              "pre": [ <resolved hook> ], "post": [ ... ] } },
  "tenantId": "...",
  "tenantBuild": { "operation": "create|update|delete",
                   "scriptPath": "...", "failedStatus": "...",
                   "tenantName": "...", "adminEmail": "...",
                   "parameters": { "<NAME>": "<value>" },
                   "hooks": { "event": "DEPLOYMENT_CREATE|...", "pre": [ ... ], "post": [ ... ] } }
}
```

A resolved hook is flat and fully populated: `hookId`, `scope`
(`GLOBAL | APPLICATION`), `revision` (0 for an application hook),
`sourceType`, `sourceLocation`, `sourceVersion` (`''` when none), `script`,
`timeoutMinutes` (`src/tenant/hook.types.ts`, `ResolvedHook`). The lists are
already in run order (`src/tenant/hooks.ts`, `resolveHooks`).

`cellBuild` and `tenantBuild` are each optional; the combination encodes the
operation shape. `tenantId` and `applicationId` key the deployment record;
`applicationId` and `accountId` name the counters the cell-delete
transaction releases.

| Trigger | `cellBuild` | `tenantBuild` |
|---|---|---|
| `CreateDeployment` into an existing cell | — | create |
| `CreateDeployment` requiring a new cell | create | create |
| `UpdateDeployment` | — | update |
| `DeleteDeployment` | — | delete |
| `UpdateCell` | update | — |
| `DeleteCell` | delete | — |

```
1. Choice: cellBuild present?
     cell PRE hooks (Vendor hooks, below); a failure goes to the failure
       write without running the script
     StartBuild (.sync) — cell CodeBuild project, with a task-level timeout:
       sourceTypeOverride / sourceLocationOverride = stamped cell source
       sourceVersion = stamped pin, when present (ADR-020)
       buildspecOverride  = inline (ADR-025): `aws sts assume-role` on
            PROVISIONING_ROLE_ARN with OPERATOR_SESSION_NAME and, when set,
            PROVISIONING_EXTERNAL_ID; export the three AWS credential
            variables; `bash "$SCRIPT_PATH"`
       env: SCRIPT_PATH=cellBuild.scriptPath, APPLICATION_ID, CELL_ID,
            CELL_ACCOUNT_ID, OPERATION=cellBuild.operation, OPERATOR_ID
            (ADR-019), PARAM_<NAME>, PROVISIONING_ROLE_ARN=cellRoleArn,
            PROVISIONING_EXTERNAL_ID, OPERATOR_SESSION_NAME; the buildspec
            sets OUTPUTS_FILE and exports SCRIPT_OUTPUTS
     the task Output keeps the build ARN and status and the raw
       SCRIPT_OUTPUTS; the next state (a Pass in a one-branch Parallel)
       guards it (rejected → failure write on create/update, {} on
       delete)
     cell POST hooks; a failure on create/update goes to the failure write
     success (choice on cellBuild.operation):
       delete → TransactWriteItems with a stable ClientRequestToken (ADR-024):
                  DeleteItem cell
                    CONDITION attribute_exists(PK) AND status = DELETING
                              AND tenantCount = 0
                  UpdateItem account: cellCount = cellCount - 1
                    CONDITION attribute_exists(PK) AND cellCount > 0
                  UpdateItem application: cellCount = cellCount - 1
                    CONDITION attribute_exists(PK) AND cellCount > 0
                transaction cancellation → GetItem cell:
                  missing → deletion already committed; end successfully
                  present → compare-and-set status=DELETE_FAILED + reason; end
       update → compare-and-set UPDATING→ACTIVE + lastBuildId
                + lastGlobalHooks; end
       create → compare-and-set CREATING→ACTIVE + lastBuildId
                + lastGlobalHooks; continue to 2
     build failure, task timeout, rejected outputs or a failed create/update
     hook (Catch):
       if tenantBuild present → TransactWriteItems:
         UpdateItem cell CREATING→CREATE_FAILED + statusReason
         UpdateItem deployment CREATING→CREATE_FAILED +
           statusReason="cell provisioning failed"; end
       otherwise → compare-and-set cell from the operation's in-flight status
         to cellBuild.failedStatus + statusReason; end
2. Choice: tenantBuild present?
     tenant PRE hooks
     StartBuild (.sync) — tenant CodeBuild project, with a task-level timeout:
       env: SCRIPT_PATH=tenantBuild.scriptPath, TENANT_ID,
            TENANT_NAME (the tenant's stored name, every operation; ADR-023),
            APPLICATION_ID, CELL_ID, CELL_ACCOUNT_ID,
            OPERATION=tenantBuild.operation, OPERATOR_ID (ADR-019),
            ADMIN_EMAIL (create only; empty string otherwise), PARAM_<NAME>,
            PROVISIONING_ROLE_ARN=tenantRoleArn, PROVISIONING_EXTERNAL_ID,
            OPERATOR_SESSION_NAME; OUTPUTS_FILE / SCRIPT_OUTPUTS as above
     outputs guard as above; tenant POST hooks
     success (choice on tenantBuild.operation):
       delete → TransactWriteItems with a stable ClientRequestToken:
                  DeleteItem deployment
                    CONDITION attribute_exists(PK) AND status = DELETING
                  UpdateItem cell: tenantCount = tenantCount - 1
                    CONDITION attribute_exists(PK) AND tenantCount > 0
                  UpdateItem tenant: deploymentCount = deploymentCount - 1
                    CONDITION attribute_exists(PK) AND deploymentCount > 0
                transaction cancellation → GetItem deployment:
                  missing → deletion already committed; end successfully
                  present → compare-and-set DELETING→DELETE_FAILED + reason; end
       create → compare-and-set CREATING→ACTIVE + lastBuildId
                + lastGlobalHooks
       update → compare-and-set UPDATING→ACTIVE + lastBuildId
                + lastGlobalHooks
     build failure, task timeout, rejected outputs or a failed create/update
     hook (Catch):
       compare-and-set deployment from the operation's in-flight status to
         tenantBuild.failedStatus + statusReason + lastGlobalHooks
3. Every terminal DynamoDB task retries transient failures, and retries a
   transaction cancelled by a concurrent one five times with jitter; a failed
   condition is never retried (ADR-0049). Retry exhaustion is caught and
   routed through the same conditional *_FAILED transition when the record
   still exists; an already-absent record means the terminal delete committed
   and the workflow ends successfully.
```

Design points:

- **Two shared provisioning projects** separate cell builds from tenant
  builds, for every application, beside the two hook projects (Vendor hooks,
  below). All four use per-execution source and script overrides and have
  physical names from the fleet name (`<fleet>-cell-build`,
  `<fleet>-tenant-build`). Each build role trusts CodeBuild only on its own
  project's `aws:SourceArn`, computed from that name, so no other project
  can run as it.
  Their roles,
  `<fleet>-cell-build` and `<fleet>-tenant-build`, hold no application-plane
  permission: each may only `sts:AssumeRole` on its half of the account role
  pair, by name, in any account (ADR-025; spec N-8). The target role's trust
  policy, written by the account owner, is the gate; the AssumeRole session
  name is the operator id, so the owner's CloudTrail attributes every
  provisioning call (M23). Role chaining caps the script's credentials at one
  hour, which is also the build task budget (N-7). The credentials are read
  into shell variables inside the buildspec and never written to CodeBuild
  environment variables, the execution input, or the log (M21).
- **Threat-model hardening (ADR-019/020/021, ADR-0046):** all four projects cap
  `concurrentBuildLimit` at the deployer's value, 5 by default, so a leaked
  token's amplification cannot fan out. CodeBuild refuses a start over the
  cap; a script build's start is retried every 30 seconds or less (full
  jitter) for about 10 minutes, at most 20, then the operation fails with a
  reason that names the refusal (ADR-0049). The projects log to explicit
  one-month-retention log groups. Every build receives `OPERATOR_ID` (the
  verified JWT `sub`) so application-plane changes attribute to the
  initiating operator, not just the shared fleet role. A stamped
  `sourceVersion` commit SHA pins what the build fetches. Action-less
  CloudWatch alarms watch execution-start rate and API 4XX rate.
  Provisioning scripts follow `scripts/CONVENTIONS.md`: log parameter names,
  never values.
- The inline buildspec assumes the account's provisioning role and then runs
  `bash "$SCRIPT_PATH"`. Lifecycle scripts must be idempotent and safe to rerun after
  partial completion; explicit no-op scripts represent empty deployments.
- **Scripts learn their application via `APPLICATION_ID`, tenant scripts
  their tenant via `TENANT_ID` and their cell via `CELL_ID`.** The contract
  between the shared cell deployment and its tenants is SSM (ADR-010), in
  the cell's account: the **cell create script publishes** the cell's shared
  resource identifiers to `/application-plane/cells/<cellId>/<name>`; tenant
  scripts read that namespace, both read the account-wide
  `/application-plane/shared/*` and their application's
  `/application-plane/applications/<applicationId>/shared/*` (ADR-034,
  ADR-038), and tenant scripts own
  `/application-plane/tenants/<tenantId>/<applicationId>/*`
  (ADR-037). The cell delete script cleans its namespace up. Cell ids are
  unique across applications, so the cell namespace needs no application
  segment. The control plane still carries no application-plane
  configuration and never reads the namespaces.
- The deployment-delete terminal write is **transactional**
  (`aws-sdk:dynamodb:transactWriteItems` service integration) so the record
  removal, slot release and count release cannot diverge. Replay safety does
  **not** rely on `ClientRequestToken` alone: DynamoDB's token window is
  finite. The deployment delete requires the deployment to exist in
  `DELETING`, and the decrements require an existing cell with
  `tenantCount > 0` and an existing tenant with `deploymentCount > 0`; after
  a committed delete, an identical transaction outside the token window
  cancels before changing a counter. The workflow reads the deployment after
  cancellation: absence proves the prior delete committed, while presence is
  a real failure. The tenant record always exists here, because
  `DeleteTenant` refuses while `deploymentCount > 0`. A stable token remains
  short-window protection for identical automatic retries. Placement uses
  the same stable-token discipline (§6).
- **Every lifecycle transition is compare-and-set.** Its condition checks
  the exact expected status or accepted status set, which is both the
  concurrency guard and an existence check. Metadata and failure writes use
  `attribute_exists(PK)`. `UpdateItem` on a missing key would otherwise
  create a ghost containing only the updated fields. Repository condition
  failures are modelled explicitly: a stale lifecycle transition maps to
  409, while an `UpdateTenant` metadata write that loses a concurrent delete
  maps to 404 rather than an unmodelled 500.
- The cell-delete terminal `DeleteItem` is conditional on
  `attribute_exists(PK) AND tenantCount = 0`. The atomic `DELETING`
  transition (§5) already blocks new placement. On condition failure, a read
  distinguishes an already-committed delete (missing is success) from an
  invariant violation (present becomes `DELETE_FAILED` with a reason). The
  account and application records always exist here, because
  `DeleteAccount` and `DeleteApplication` refuse while `cellCount > 0`.
- Each script build Task has a catchable task-level timeout of one hour,
  counted again on each attempt, so the build-slot wait is outside it; a
  hook attempt is bounded by its own deadline (Vendor hooks, below). The
  state-machine execution timeout, 26 hours, is greater than every build and
  hook budget an execution can run at the caps plus terminal-write recovery
  margin (a delete with ten hooks at 30 minutes, each spending its three
  attempts, and a script build that waits 20 minutes for its slot runs
  about 25.3 hours); it is a final safety net, not the normal timeout path,
  and costs nothing on a Standard workflow. Terminal writes retry transient
  failures and transaction conflicts, and retry exhaustion is caught so
  records do not remain indefinitely in an in-flight state. `StartExecution`
  rejection is compensated as in §6.
- The **account role pair** (`CellAccountRoles`, installed per account) carries
  the asymmetry: `<fleet>-cell-provisioning` reads `/application-plane/shared/*`
  and `/application-plane/applications/*` and gets/puts/deletes
  `/application-plane/cells/*`; `<fleet>-tenant-provisioning` reads those two
  and `/application-plane/cells/*`, and
  gets/puts/deletes `/application-plane/tenants/*` — all in that account. It
  cannot mutate cell-owned parameters. One pair serves every application the
  account admits, so one application's scripts can read another's shared and
  cell namespaces in the same account (trusted vendor code; a pair per
  application is a recorded seam, spec §11). Each half trusts the control
  plane account narrowed by `aws:PrincipalArn` to the matching build role
  and the API role, and by `sts:ExternalId` when the owner set one. The pair
  is installed by the account owner (the control plane stack for its own
  account, the `CellAccountStack` elsewhere), so provisioning source remains
  trusted vendor code and the pair's policies remain the documented
  hardening point in each account.
- The optional `tenantBuildManagedPolicyArns` input (§10, ADR-022 narrowed by
  ADR-025) attaches deployer-supplied customer-managed policies to the
  **tenant provisioning role of the stack's own account**, in addition to the
  grants above, so a tenant script can call an application-plane API with a
  policy the application plane publishes (producer-owned least privilege).
  Synthesis validates each entry is a managed-policy ARN in that stack's own
  partition and account. The policies are attached by reference, never read:
  the control plane learns an ARN list, not what a policy is for (P-3). The
  role runs every tenant script in that account, so what is attached widens
  the blast radius of all of them; a customer attaches policies in their own
  account through their `CellAccountStack`, the vendor never does.
- The optional `cellBuildManagedPolicyArns` input (§10, ADR-0047) does the
  same for the **cell provisioning role**, with the same check, so a cell
  script can deploy with a tool the account owner allows, such as a CDK
  bootstrap kept for cells. The cell role also trusts the API role, for the
  `PutAccount` handshake, so an attached policy widens the API role too.

### Vendor hooks (ADR-044)

**Events and phases.** Each build serves one event: `CELL_CREATE`,
`CELL_UPDATE` or `CELL_DELETE` for the cell build, `DEPLOYMENT_CREATE`,
`DEPLOYMENT_UPDATE` or `DEPLOYMENT_DELETE` for the tenant build. A hook
names the events it runs on and one phase, `PRE` (before the script) or
`POST` (after the script succeeded). A new-cell `CreateDeployment` runs two
events, the cell's first, its post hooks included, before the deployment's
pre hooks start. The nine events of application, tenant and account
records run without a build, around the record's commit (Record events,
below).

**Resolution.** When an operation is accepted, the service resolves the
hooks of each event it runs: the application hooks stamped on the cell
(never the application record's current list) and the global hooks from
the strongly consistent query, each with the `revision` and `source` it
had at that read. The query runs before the operation's first write
(placement step 0 for `CreateDeployment`, beside the record read that
precedes the transitional write for every other build-starting
operation), so a failed read is a 500 with nothing to compensate. The
workflow runs that snapshot and never re-reads a hook; a hook put or
deleted afterwards changes only later operations (`src/tenant/hooks.ts`,
`src/tenant/tenant.ts`).

**Run order.**

```
PRE hooks (global, then application)
  → script
  → POST hooks (application, then global)
  → terminal write
```

Global hooks wrap the application's; within a scope hooks run in
ascending `hookId` (byte order), one at a time. Deletes keep the order, so
a pre hook acts while the cell or deployment still exists: a hook that
removes a route removes it before the delete script tears down what the
route points at.

**Projects and roles.** Global hooks start only in the `<fleet>-global-hook`
project, which runs as the `<fleet>-global-hook` role; application hooks
start only in `<fleet>-app-hook`, under `<fleet>-app-hook`. The workflow
sends no role override and holds no `iam:PassRole` on either hook role, so
the project alone decides the role. Only the workflow role holds
`codebuild:StartBuild`, `StopBuild` and `BatchGetBuilds` on the hook
projects; the build roles and the API role hold none of them. Starting an
execution runs whatever hooks its input names, so only the API role holds
`states:StartExecution` on the workflow (`src/tenant/tenant.cdk.ts`,
`grantStartExecution`), and a compromise of the API function reaches both
hook roles (threat model T30). The four projects and the workflow
(`<fleet>-workflow`) have physical names from the fleet name, so each
role's `aws:SourceArn` condition and the deny name them by ARNs computed
before they exist, with no CloudFormation cycle.

**The deny.** One standalone `AWS::IAM::Policy`,
`<fleet>-control-plane-deny`, created outside every role construct and
attached through its `Roles` list to `<fleet>-cell-build`,
`<fleet>-tenant-build`, `<fleet>-global-hook`, `<fleet>-app-hook` and the
home account's `<fleet>-cell-provisioning` and
`<fleet>-tenant-provisioning`, so nothing in the stack depends on it
(`src/tenant/control-plane-deny.ts`). Its nine statements deny
`iam:PassRole` on the build, workflow, API and hook roles; seven IAM role
writes on all ten roles the stack creates; `StartBuild`, `StartBuildBatch`,
`RetryBuild`, `UpdateProject`, `CreateWebhook` and `UpdateWebhook` on the
four projects; `StartExecution` and `UpdateStateMachine` on the workflow and
`RedriveExecution` on its executions; six code, configuration, version and
alias writes on the API and authorizer functions; `InvokeFunction`,
`InvokeAsync`, `AddPermission` and `RemovePermission` on the API function,
every Lambda entry on both the unqualified ARN and `:*`; `PUT`, `PATCH`,
`POST` and `DELETE` on the REST API; and seven table writes. An explicit
deny wins over any allow, so no attached policy
(`tenantBuildManagedPolicyArns` and both hook inputs included) can grant
those roles a denied action. The workflow and API roles carry none, because
those actions are their own grants; the authorizer and API Gateway
CloudWatch roles hold only logs. What the deny does not close (an attached
`sts:AssumeRole` on another role in the account, CloudFormation writes
through a privileged role, IAM role creation, admin writes on the vendor
IdP, writes to a script or hook source) is the deployer's to withhold
(threat model T41).

**Environment.** A hook build gets `EVENT`, `PHASE`, `HOOK_ID`,
`HOOK_SCOPE`, `APPLICATION_ID`, `CELL_ID`, `CELL_ACCOUNT_ID`, `OPERATOR_ID`,
`EXECUTION_ID` (the execution name, one per accepted operation), `ATTEMPT`,
`HOOK_SCRIPT`, the record's resolved `PARAM_<NAME>` set, `TENANT_ID` and
`TENANT_NAME` on deployment events, and `SCRIPT_OUTPUTS` on `POST`. It gets
no `ADMIN_EMAIL`, no external id and no role ARN. The hook buildspec is
`bash "$HOOK_SCRIPT"` and nothing else: it assumes no role and interpolates
no value into a command (`src/tenant/hook.workflow.ts`, `HOOK_BUILDSPEC`).
Hooks are idempotent; `EXECUTION_ID` with `EVENT`, `PHASE` and `HOOK_ID`
names one occurrence across its attempts.

**Script outputs.** Before each script the provisioning buildspec makes a
fresh directory outside the source tree and passes `OUTPUTS_FILE`, a path
in it that does not exist yet. After the script succeeds it parses the
file, refuses a symbolic link, a repeated key, a key outside
`[A-Za-z][A-Za-z0-9_]{0,63}`, a value that is not a string of printable
ASCII, or more than 4,096 bytes in compact form, and exports its own
compact re-serialisation (`jq -c .`) as `SCRIPT_OUTPUTS`, the build's only
exported variable, `{}` when there is no file. CodeBuild returns every
exported value as an empty string past a total between 8 and 16 KiB, so
one small variable stays clear of it. That check runs in the container the
script ran in, so a JSONata state after the script task checks the value
again with a linear regular expression over the compact grammar, never
`$parse`: an empty, over-long or malformed value ends a create or update
`*_FAILED` with "script outputs rejected" and becomes `{}` on a delete. The
control plane never reads or stores the outputs; they leave state when the
event's post hooks finish.

**Start, poll, stop.** Each hook attempt starts its build with a
request-response `startBuild`, so its id is known from the first call, and
polls that one id with the SDK integration `batchGetBuilds` every 60
seconds, keeping only the id, status, phase timing and the
`resolvedSourceVersion` of the poll that saw the final status. Each try
sends the hook's `timeoutMinutes` as the run timeout, a queued timeout of
10 minutes less the minutes already refused (never below 5), and an
idempotency token that is the SHA-256 of the execution, event, phase,
hook scope, hook, attempt and try index. A start refused at a
concurrency cap (`CodeBuild.AccountLimitExceededException`) waits 30
seconds and tries again under a new token for up to 5 minutes; any
other error except `CodeBuild.InvalidInputException` goes to a task
`Retry` under the same token (`TimeoutSeconds` 15, three repeats 10
seconds apart, no jitter), so a call that created a build returns it
instead of leaving a second one; a try whose repeats all fail ends the
attempt as "start outcome unknown". The attempt's deadline is the run
timeout plus 10 minutes of refusals and queue plus 5 of margin; at the
deadline the workflow calls `StopBuild` and polls the build to a final
status within 2 minutes. So one attempt takes at most 47 minutes at the
30-minute cap.

**Failure.** On create and update the first failing hook ends the event.
A `PRE` failure lands the record in `CREATE_FAILED` or `UPDATE_FAILED`
before the script runs, so the script changed nothing; a `POST` failure
does the same after it, with the script's changes in place. `statusReason`
names the scope, the hook id, the build and the kind of failure (a run
timeout told from a queued one by the phase timing, a start still refused,
a start outcome unknown). A failed cell create with a pending deployment
create moves both records. Remediation is P-9's: retry the update, or
delete the failed create. On delete a failing hook is retried as an
explicit loop of three attempts that started a build, 60 and 120 seconds
apart, each starting only after the last build is final, within one
budget of 3 × (`timeoutMinutes` + 17) + 3 minutes (144 at the cap). An
attempt refused for its whole window does not count; an attempt that
ended "start outcome unknown" counts, and the next waits until that
build's queued and run timeouts have passed. When the attempts or the
budget run out, the workflow logs the skip (scope, hook id, event, record,
build ids, whether the budget ran out), counts it in the `HookSkipped`
metric of the `<fleet>/hooks` namespace, which has an alarm with no
actions, and goes on with the next hook and the script, so a delete hook
cannot stop a delete.

**What ran.** Every terminal write that leaves the record in place writes
`lastGlobalHooks`: the global hooks that ran for the event, in run order,
with the revision, the ref each names and, for a git source, the full
commit SHA its build ran. A hook a `PRE` failure kept from running is not
listed. Application hooks need no such record; the cell's stamp names
them.

**Cost and limits.** Polling costs three state transitions per hook
minute, about $0.002 for a 30-minute hook. At the caps (five global and
five application hooks per event) a delete's hook steps write about 13,000
history events while polling and about 22,600 when every start is refused
for its whole budget, inside the 25,000-event history quota of a Standard
execution. The execution input stays inside its 256 KiB with about 39 KiB
to spare.

### Record events (ADR-045)

`PutApplication`, `DeleteApplication`, `CreateTenant`, `UpdateTenant`,
`DeleteTenant`, `PutAccount` and `DeleteAccount` each start one execution
of the same state machine, which serves one record event and runs no build.
The path is the same whether or not a hook matches: with none, the
execution runs the commit and the terminal write and ends in seconds.

| Trigger | Event | Commit |
|---|---|---|
| `PutApplication` with no record, or on `CREATE_FAILED` | `APPLICATION_CREATE` | none: the request wrote the values |
| `PutApplication` on a live record | `APPLICATION_UPDATE` | `pending` → the fields it holds |
| `DeleteApplication` | `APPLICATION_DELETE` | delete the record |
| `CreateTenant` | `TENANT_CREATE` | none |
| `UpdateTenant` | `TENANT_UPDATE` | `pending` → `name`, `description` (a missing description is removed) |
| `DeleteTenant` | `TENANT_DELETE` | delete the record |
| `PutAccount` with no record, or on `CREATE_FAILED` | `ACCOUNT_CREATE` | none |
| `PutAccount` on a live record | `ACCOUNT_UPDATE` | `pending` → `maxCells`, `applicationIds` (a missing list is removed: shared); the request already wrote `externalId` |
| `DeleteAccount` | `ACCOUNT_DELETE` | delete the record |

**Input.** The service builds everything the execution needs
(`src/tenant/record-event.types.ts`, `RecordEventInput`;
`src/tenant/tenant.ts`, `recordEventInput`), so the workflow never reads
the record or a hook:

```json
{
  "recordEvent": {
    "event": "TENANT_UPDATE",
    "recordType": "TENANT",
    "recordId": "<tenantId>",
    "key": { "PK": "TENANT#<tenantId>", "SK": "META" },
    "operationId": "<tenantId>-tenant-update-<ms>-<hex8>",
    "hooks": { "event": "TENANT_UPDATE", "pre": [ <resolved hook> ], "post": [ ... ] },
    "environment": { "EVENT": "TENANT_UPDATE", "OPERATOR_ID": "...",
                     "EXECUTION_ID": "<operationId>",
                     "TENANT_ID": "...", "TENANT_NAME": "..." },
    "commit": { "action": "UPDATE", "set": ["name", "description"], "remove": [] }
  }
}
```

`commit` names fields, never their values (`recordCommit`): `action` is
`NONE` on a create, `DELETE` on a delete, and `UPDATE` with the commit
fields `pending` holds in `set` and the removable fields it lacks in
`remove`. The input holds no parameter, source, script, external id or role
ARN, and stays under 25 KiB at the caps. The event-level environment is
`recordEventEnvironment`: `EVENT`, `OPERATOR_ID`, `EXECUTION_ID` and the
record's fields (`APPLICATION_ID`; `TENANT_ID` and `TENANT_NAME`; or
`ACCOUNT_ID`, `ACCOUNT_OWNER` and `ACCOUNT_APPLICATION_IDS`, the ids joined
by `,`, empty when shared). On create and update those are the values being
written, on delete the stored ones.

**Operation id.** Every accepted record operation generates an
`operationId` (`newOperationId`): the record id, the record type, the verb,
the accept time in milliseconds and 8 random hex characters, at most 74
characters. The request's conditional write stores it on the record, the
execution starts under it as its name, and hooks see it as `EXECUTION_ID`.
The random suffix keeps two operations accepted in one millisecond on two
hosts apart.

**States.** `src/tenant/record-event.workflow.ts`, `recordEventStates`;
every state is JSONata:

```
RecordPreHooks ─► RecordCommit ─┬─ NONE ───────────────────────────────────────┐
                                ├─ UPDATE ─► CommitRecordUpdate ───────────────┤
                                │             └ fail ► ProbeRecordCommitted ───┤ (replay)
                                └─ DELETE ─► CommitRecordDelete ───────────────┤
                                              └ fail ► ProbeRecordDeleted ─────┤ (replay)
                                                                               ▼
               RecordPostHooks ─► RecordSucceeded ─┬─ delete ─► RecordEventDone
                                                   └─ SetRecordActive ─► RecordEventDone
a failed create or update hook, a failed commit, a failed success write ─► FailRecord
a write whose condition fails on another operation ─► RecordSuperseded
```

- **Hooks.** The pre and post lists run through the hook sub-graph of
  Vendor hooks (`HookRunner`, lists `recordPre` and `recordPost`), with
  its order, attempts, deadlines and failure rules: on create and update
  the first failing hook ends the event, on delete a failing hook is
  retried and skipped. The list is filtered to `GLOBAL` hooks unless the
  record is an application, so a tenant or account event never runs an
  application hook. Each hook build gets the input's environment plus
  `PHASE`, `HOOK_ID`, `HOOK_SCOPE`, `HOOK_SCRIPT` and `ATTEMPT`, and
  `SCRIPT_OUTPUTS` `{}` on `POST` (`RECORD_HOOK_ENVIRONMENT`, the state
  form of `recordHookEnvironment`).
- **Commit of an update.** One `UpdateItem` sets each `set` field from
  `pending.<field>`, removes each `remove` field and `pending`, conditioned
  on `status = UPDATING AND operationId = :op AND attribute_exists(pending)`
  (`commitUpdateArguments`). Every field name goes into
  `ExpressionAttributeNames` behind a placeholder, and a name outside the
  record type's commit fields raises, so a malformed input can never write
  `status`, `operationId`, a counter or `externalId`. The commit touches
  nothing else.
- **Commit of a delete.** One `DeleteItem` conditioned on `status =
  DELETING AND operationId = :op` and the record's count (`cellCount`, or
  `deploymentCount` for a tenant) still 0 (`commitDeleteArguments`). A
  delete has no terminal write once it commits.
- **Replay probes.** A commit whose condition fails is classified by one
  more conditional write, never by a read. `ProbeRecordCommitted` is
  `REMOVE pending` conditioned on `UPDATING`, this `operationId` and no
  `pending`: it changes nothing and succeeds only when an earlier attempt
  of the commit landed. `ProbeRecordDeleted` is a `DeleteItem` conditioned
  on `attribute_not_exists(PK)`: it deletes nothing and succeeds only when
  the record is already gone. A probe that passes goes on to the post
  hooks; one that fails goes to the failure write.
- **Terminal writes.** `SetRecordActive` moves `CREATING` or `UPDATING`
  to `ACTIVE` with `lastGlobalHooks` and removes `statusReason`;
  `FailRecord` moves the in-flight status to its `*_FAILED` status with
  `statusReason` and `lastGlobalHooks` and removes `pending` when it is
  still there. Both are conditioned on the in-flight status and on
  `operationId = :op` and retry as the cell and deployment terminal writes
  do; a success write that exhausts its retries goes through `FailRecord`.
- **Superseded.** A terminal or failure write whose condition fails
  belongs to an execution that a compensation or a later request has
  replaced: the record holds another `operationId`, no longer holds the
  in-flight status, or is gone outside a delete's replay. The execution
  ends at `RecordSuperseded` with no further write and no further hook.
  A delete is the exception (`RecordFailWriteLost`): when its failure
  write loses its condition, the delete landed or another operation took
  the record over, so the post hooks still run and cleanup stays
  reachable.
- **Allowlist errors.** A commit that names a field outside the commit
  fields raises `States.QueryEvaluationError`, which is never retried:
  the update goes straight to `UPDATE_FAILED` (`COMMIT_ALLOWLIST_REASON`).

**Starting a record event (the API).** Each of the seven operations makes
its one conditional write, storing the new `operationId`, and then calls
`acceptRecordEvent` (`src/tenant/tenant.ts`). `startRecordWorkflow` starts
the execution under the `operationId` and classifies the outcome:

- **Started**: `StartExecution` succeeded or answered
  `ExecutionAlreadyExists`; or its outcome was unknown and
  `DescribeExecution` on the name found the execution, or a second start
  under the same name and input answered with it or with
  `ExecutionAlreadyExists`. The name and input are the operation's own, so
  only its earlier attempt can have created that execution. The request
  answers 202.
- **Refused**: the start call failed with an error Step Functions raises
  before it creates an execution (validation, throttling, limit, access,
  missing state machine, KMS and credential errors; `START_REFUSALS`).
  Starts go through their own client with SDK retries off
  (`recordStartClient`, `maxAttempts: 1`), so that error belongs to the
  one attempt that was made. The same error on a later same-name start
  proves nothing about the first.
- **Unknown**: everything else, a `DescribeExecution` miss included:
  `DescribeExecution` is eventually consistent, so only a found execution
  counts.

A start that did not go through is compensated, every compensating write
conditioned on the operation's `operationId` (`src/tenant/record-writes.ts`),
and the request answers 500:

- a record the request inserted, whose start was refused, is deleted again,
  conditioned on `CREATING`, the `operationId` and its count at 0
  (`freshInsertDeleteCondition`), so a retried `CreateTenant` makes one
  tenant;
- a fresh insert with an unknown outcome, and every re-put, goes to
  `CREATE_FAILED`, never deleted: an execution may be running its create
  hooks, and only the record's delete runs the delete hooks;
- `UPDATING` goes to `UPDATE_FAILED` with `pending` removed, conditioned
  also on `attribute_exists(pending)` so a commit that already landed is
  never marked failed; an `externalId` the replace wrote stays;
  `DELETING` goes to `DELETE_FAILED` (`compensateRecordTransition`).

A compensating write whose condition fails reads the record once. The same
`operationId` in `ACTIVE` or the matching `*_FAILED` status, the record
`UPDATING` without `pending`, or the record gone after a delete means the
execution ran, and the request answers 202 with the record as read (the
`DELETING` record for a delete). A compensation that fails in turn leaves
the record in flight, the residual of §6 (threat T47). A stray execution
that started despite an unknown outcome cannot finish a later request's
record: its writes fail on the `operationId` and it ends superseded.

**Grants.** The workflow role needs nothing new: its base-table
`GetItem`/`UpdateItem`/`DeleteItem` statement covers the commits, the
probes and the terminal writes (`src/tenant/tenant.sfn.ts`). The API role
gains one statement, `DescribeOwnRecordEventExecution`:
`states:DescribeExecution` on `execution:<fleet>-workflow:*`, the
executions of this stack's own workflow and nothing else
(`src/tenant/tenant.cdk.ts`, `src/shared/fleet.ts`,
`workflowExecutionArnPattern`), with the cdk-nag wildcard finding
acknowledged on the execution-name segment. `DescribeExecution` returns an
execution's input, so the API role can read the inputs of cell and
deployment executions: external ids, which it already reads in the table
(spec N-10), and the `adminEmail` of create executions, which the API
itself put there and never stores. The deny lists no `Describe`
action.

**Cost and limits.** One Standard execution per operation, a few state
transitions when no hook matches, plus each matching hook's build and
polling. Record hook builds share the two hook projects' concurrency caps
with cell and deployment hook builds. A record delete at the caps runs the
hook time of a cell delete without its script and stays inside the
25,000-event history quota (`test/tenant/record-event-workflow.test.ts`,
budgets).

## 8. Smithy Model Sketch

Condensed; every shape gets `@documentation`, cross-resource ids get
`@references`:

```smithy
// model/application.smithy (ADR-032)
resource Application {
    identifiers: { applicationId: ApplicationId }   // ^[a-z0-9-]{1,32}$
    put: PutApplication       // PUT /applications/{applicationId} → 202, create-or-replace, staged (ADR-045)
    read: GetApplication      // GET /applications/{applicationId}
    delete: DeleteApplication // DELETE /applications/{applicationId} → 202, empty applications only
    list: ListApplications    // GET /applications
}

// model/tenant.smithy — the customer; asynchronous with a status, no build (ADR-045)
resource Tenant {
    identifiers: { tenantId: TenantId }
    create: CreateTenant      // POST /tenants → 202, nothing provisioned
    read: GetTenant           // the polling endpoint
    update: UpdateTenant      // PUT — metadata only, 202, staged in pending
    delete: DeleteTenant      // DELETE → 202, empty tenants only
    list: ListTenants         // GET /tenants
}

// model/deployment.smithy (ADR-037) — one tenant in one application
resource Deployment {
    identifiers: { tenantId: TenantId, applicationId: ApplicationId }
    read: GetDeployment       // GET /tenants/{tenantId}/deployments/{applicationId}
    update: UpdateDeployment  // PUT → 202 (tenant update build), no body
    delete: DeleteDeployment  // DELETE → 202 (tenant delete build, frees the slot)
    list: ListDeployments     // GET /deployments[?tenantId=|?cellId=|?applicationId=]
    operations: [CreateDeployment]   // POST /tenants/{tenantId}/deployments → 202 (placement)
}

// model/cell.smithy
resource Cell {
    identifiers: { cellId: CellId }
    read: GetCell             // GET /cells/{cellId}
    update: UpdateCell        // PUT /cells/{cellId} → 202 (cell update build), no body
    delete: DeleteCell        // DELETE /cells/{cellId} → 202, empty cells only
    list: ListCells           // GET /cells[?accountId=|?applicationId=]
    // no create — cells are created implicitly by placement (ADR-013)
}

// model/account.smithy (ADR-024, ADR-033)
resource Account {
    identifiers: { accountId: AccountId }   // ^[0-9]{12}$
    put: PutAccount           // PUT /accounts/{accountId} → 202, verifies the handshake first (ADR-027, ADR-030)
    read: GetAccount          // GET /accounts/{accountId}
    delete: DeleteAccount     // DELETE /accounts/{accountId} → 202, empty accounts only
    list: ListAccounts        // GET /accounts
}

// model/hook.smithy (ADR-044) — a global hook; synchronous, no status
resource Hook {
    identifiers: { hookId: HookId }         // ^[a-z0-9-]{1,32}$
    put: PutHook              // PUT /hooks/{hookId} → 200, create-or-replace, revision + 1
    read: GetHook             // GET /hooks/{hookId}
    delete: DeleteHook        // DELETE /hooks/{hookId} → 200
    list: ListHooks           // GET /hooks, in hookId order
}

structure HookDefinition {
    @required hookId: HookId
    @required events: HookEventList            // CELL_* | DEPLOYMENT_* | APPLICATION_* | TENANT_* | ACCOUNT_*, distinct;
                                               //   TENANT_* and ACCOUNT_* global hooks only (ADR-045)
    @required phase: HookPhase                 // PRE | POST
    @required source: HookSource               // {type, location, sourceVersion?}
    @required script: HookScriptPath
    timeoutMinutes: HookTimeoutMinutes         // 5..30, default 10
}

structure PutApplicationInput {
    @required @httpLabel applicationId: ApplicationId
    @required source: SourceDefinition         // {type, location, sourceVersion?}
    @required cellScripts: ScriptLocations     // {create, update, delete}
    @required tenantScripts: ScriptLocations
    @required maxTenants: MaxTenants           // >= 1
    hooks: HookDefinitionList                  // at most 5; absent keeps, [] clears (ADR-044)
    placementStrategy: PlacementStrategy       // FILL (default) | ROUND_ROBIN (ADR-036)
}

structure CreateDeploymentInput {
    @required @httpLabel tenantId: TenantId
    @required applicationId: ApplicationId
    @required adminEmail: EmailAddress   // passed to the tenant create build as ADMIN_EMAIL
    accountId: AccountId                 // pin to one registered account (ADR-024)
    @idempotencyToken clientToken: IdempotencyToken   // optional retry-safety (ADR-017)
    // no resource definition — the cell's stamped definition applies (ADR-012)
}

structure PutAccountInput {
    @required @httpLabel accountId: AccountId
    @required owner: AccountOwner              // VENDOR | TENANT
    @required maxCells: MaxCells
    applicationIds: ApplicationIdList          // absent = shared (ADR-033)
    externalId: ExternalId                     // required for TENANT (ADR-029)
}

@error("client") @httpError(409)
structure InsufficientCapacityError { @required message: String }   // ADR-026

structure DeploymentSummary {
    @required tenantId: TenantId
    @required applicationId: ApplicationId
    @references([{resource: Cell}])
    @required cellId: CellId
    @required status: LifecycleStatus
    // ...
}
```

`SourceDefinition` / `ScriptLocations` are shared shapes referenced by the
application, cell and `GetDeployment` output structures. Authorizer wiring:
`httpApiKeyAuth` token authorizer, `@authorizer` per operation,
`PLACEHOLDER` URI patched at synth.

## 9. Project Layout

projen `awscdk-app-ts`, TypeScript, single package (dependencies in
`.projenrc.ts`). Verified with `npx projen build`.

```
samples/control-plane/
├── .projenrc.ts
├── smithy-build.json
├── model/
│   ├── __global.smithy            # service shape, authorizer, errors, shared types
│   ├── application.smithy         # Application resource (ADR-032)
│   ├── tenant.smithy              # Tenant resource (the customer; asynchronous, ADR-045)
│   ├── deployment.smithy          # Deployment resource (ADR-037; no per-tenant definition)
│   ├── cell.smithy                # Cell resource (no create — ADR-013)
│   ├── account.smithy             # Account resource (ADR-024)
│   └── hook.smithy                # Hook resource, hook definitions, lastGlobalHooks (ADR-044)
├── src/
│   ├── main.ts                    # CDK app entry point (context parsing; --context
│   │                              #   cellAccount synthesizes only the role pair stack)
│   ├── smithy/                    # generated SSDK output (git- and lint-ignored)
│   ├── cell-account/
│   │   └── cell-account.cdk.ts    # CellAccountRoles construct + CellAccountStack: the
│   │                              #   role pair an account owner installs (ADR-025)
│   ├── shared/
│   │   ├── authorizer.function.ts # vendor IdP JWT validation (JWKS)
│   │   ├── service-config.ts      # ServiceConfig / CallerContext base, source pinning check
│   │   ├── data-model.ts          # DataModel<TSchema, TItem>
│   │   ├── repository.ts          # DynamoDBRepository + PlacementTransactions
│   │   ├── fleet.ts               # fleet naming: roles, projects, workflow, ARNs, STS session name
│   │   ├── hook-transactions.ts   # PutHook / DeleteHook transactions on hookCount
│   │   ├── ssm-namespaces.ts      # the §6.2 namespace grants for the role pair
│   │   └── key-builder.ts
│   └── tenant/
│       ├── tenant.ts              # service impl: placement, application + account +
│       │                          #   cell + tenant + deployment ops
│       ├── application.data-model.ts  # application item mapping, PutApplication update shape
│       ├── tenant.data-model.ts   # tenant item mapping (GSI-2 attributes)
│       ├── deployment.data-model.ts   # deployment item mapping (GSI-1/2/3 attributes,
│       │                          #   base-table query by tenant)
│       ├── cell.data-model.ts     # cell item mapping (GSI-1, GSI-2 by account, GSI-3
│       │                          #   by application)
│       ├── account.data-model.ts  # account item mapping, PutAccount update shape
│       ├── account.handshake.ts   # the PutAccount STS probe, positive and negative (ADR-027, ADR-030)
│       ├── idempotency.data-model.ts  # CreateDeployment idempotency record (ADR-017)
│       ├── validation.ts          # synth-time stack input validation shared by both stacks
│       ├── tenant.function.ts     # API handler (pass-through)
│       ├── tenant.sfn.ts          # workflow: optional cell build phase, assume-role
│       │                          #   buildspec, outputs guard, transactional deletes,
│       │                          #   build roles, the four projects
│       ├── hook.types.ts          # the hook contract: events, charsets, environment, limits
│       ├── hooks.ts               # hook validation, pinning warning, resolution and run order
│       ├── hook.data-model.ts     # global hook and counter items, lastGlobalHooks
│       ├── hook.workflow.ts       # hook buildspec and the start/poll/stop sub-graph
│       ├── hook.infra-validation.ts   # synth checks of the two hook policy inputs
│       ├── control-plane-deny.ts  # the standalone deny's statements
│       ├── record-event.types.ts  # record events: status rules, operation id, commit,
│       │                          #   hook environment, execution input (ADR-045)
│       ├── record-writes.ts       # the API's staging, DELETING and compensation writes
│       ├── record-event.workflow.ts   # the record event states: commit, probes,
│       │                          #   terminal writes, superseded
│       └── tenant.cdk.ts          # stack: API GW, Lambda (<fleet>-api role), DDB (PITR,
│                                  #   GSI-1/2/3), SFN, home account role pair, hook roles,
│                                  #   the deny
├── scripts/
│   ├── sample-cell/{create,update,delete}.sh    # demo shared deployment: reads its
│   │                                            #   application's shared namespace,
│   │                                            #   publishes/removes
│   │                                            #   /application-plane/cells/<cellId>/*
│   ├── sample-tenant/{create,update,delete}.sh  # reads the cell namespace, writes
│   │                                            #   /application-plane/tenants/<tenantId>/<applicationId>
│   └── sample-noop/{create,update,delete}.sh    # explicit no-op set for empty deployments
└── test/                          # jest unit/assertion tests + integ.tenant.ts
```

One service directory and one table (PITR enabled); two deployable
stacks — the control plane, and the account role pair for every other account
that hosts cells. API URL to SSM (`/control-plane/tenant-api-url`) for
tooling/demo convenience.

## 10. Deployment Inputs

| Input | Used by |
|---|---|
| `vendorIdp.issuerUrl`, `vendorIdp.audience` | Lambda Authorizer |
| `vendorIdp.clientIds` (optional, default none) | Lambda Authorizer: client ids accepted on a token without `aud`, when `client_id` equals `sub` (ADR-043) |
| `vendorIdp.requiredScope` (optional, default none) | Lambda Authorizer: the scope a token without `aud` must also carry (ADR-043) |
| `fleetName` (optional, default `control-plane`) | names the seven fleet roles: `<fleet>-api`, `<fleet>-cell-build`, `<fleet>-tenant-build`, `<fleet>-global-hook`, `<fleet>-app-hook` in the control plane account and `<fleet>-cell-provisioning`, `<fleet>-tenant-provisioning` in every account that hosts cells (ADR-025, ADR-028, ADR-044); the four CodeBuild projects (`<fleet>-cell-build`, `<fleet>-tenant-build`, `<fleet>-global-hook`, `<fleet>-app-hook`) and the workflow (`<fleet>-workflow`); `[a-z0-9][a-z0-9-]{0,31}`, checked at synth, because a CodeBuild project name starts with a letter or digit |
| `tenantBuildManagedPolicyArns` (optional) | customer-managed IAM policy ARNs attached to the tenant provisioning role of the stack's own account, in addition to its §7 SSM grants (ADR-022, ADR-025) |
| `cellBuildManagedPolicyArns` (optional) | the same, for the cell provisioning role of the stack's own account (ADR-0047); the API role can use them too, because the cell role trusts it; the R-41 deny on that role overrides them (ADR-044) |
| `concurrentBuildLimit` (optional, default 5) | the cap on concurrent builds of every CodeBuild project, the two hook projects included (M17, ADR-0046); 1 to 100, a warning above 20 |
| `globalHookManagedPolicyArns` (optional, default none) | customer-managed IAM policy ARNs attached to `<fleet>-global-hook`, validated as `tenantBuildManagedPolicyArns` is (ADR-044) |
| `appHookManagedPolicyArns` (optional, default none) | the same for `<fleet>-app-hook`; an ARN in both hook lists fails synth (ADR-044) |
| `demoApplicationIds` (optional, default none) | publishes `/application-plane/applications/<applicationId>/shared/base-domain` in the stack's own account for each listed id, the demo shared resource the sample cell script reads (ADR-034); a real application plane publishes its own |

Applications, accounts and global hooks are **not** deployment inputs:
they are registered through the API — applications (`PutApplication`) and
global hooks (`PutHook`) so a new one needs no redeploy (ADR-032, ADR-044),
accounts (`PutAccount`) because a customer's account appears on demand
(ADR-024). The control plane stack therefore
carries no provisioning source, no script path and no tenant limit. The
home account is registered like any other before the first deployment.

**Account role pair stack** (`--context cellAccount='{...}'` makes
`src/main.ts` synthesize only `<fleetName>-cell-account`,
`control-plane-cell-account` by default; deployed by the account owner with
their own credentials):

| Input | Used by |
|---|---|
| `cellAccount.controlPlaneAccountId` | the trust policies: the control plane account, narrowed to its build roles and API role |
| `fleetName` | MUST match the control plane's |
| `cellAccount.externalId` (required for a tenant-owned account, ADR-029) | `sts:ExternalId` condition on both trust policies, validated against the STS pattern at synth; the operator supplies the same value at `PutAccount` |
| `cellAccount.tenantBuildManagedPolicyArns` (optional) | attached to this account's tenant provisioning role; validated to be in this account |
| `cellAccount.cellBuildManagedPolicyArns` (optional) | attached to this account's cell provisioning role; validated to be in this account (ADR-0047) |
| `cellAccount.demoApplicationIds` (optional, default none) | publishes the demo `/application-plane/applications/<applicationId>/shared/base-domain` in this account for each listed id; absent, a customer's account gets the two roles and nothing else |

Supplied via CDK context. When `tenantBuildManagedPolicyArns` or
`cellBuildManagedPolicyArns` is non-empty, synthesis fails if any entry is
not a managed-policy ARN in the stack's own partition and account, or if the
stack's account or Region is unresolved so that check cannot run (ADR-022,
ADR-0047). A `concurrentBuildLimit` outside 1 to 100 fails synthesis
(ADR-0046). The application definition is
validated by `PutApplication` instead: the generated server SDK rejects a
missing script path, a malformed source, `maxTenants` below one, an
unknown strategy or an id outside the charset, and the service warns (does
not refuse) when `source.sourceVersion` is absent or not a full commit SHA
(ADR-020). Replacing an application's definition affects only cells created
afterwards; existing cells keep their stamped definition.

A deployment whose provisioning projects and workflow carry CDK-generated
names is replaced on the upgrade that gives them physical names, and the
state machine's deletion would strand its running executions; that upgrade
is deployed after a drain of three deploys (close with `allowedRoles` set to
`control-plane:closed`, wait at least 90 seconds and for no `RUNNING`
execution, upgrade with the gate kept, reopen), as the README's upgrade
step describes (spec R-41).

The upgrade to asynchronous application, tenant and account operations
(ADR-045) changes every API client, which must poll the record's `Get`
operation after the 202, but not the table: a record stored before has no
`status` and reads as `ACTIVE`, so the upgrade writes nothing and needs no
drain of its own (README, upgrade step; spec §8.4).

## 11. Deployment Lessons

`externalModules: []` bundling, the `re2.wasm` commandHook, and an
extensible `CallerContext` for the SSDK handler.

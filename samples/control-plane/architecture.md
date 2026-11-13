# The Cell-Based Control Plane: Architecture

## Verification Status

This sample has been verified as working via automated integration tests and end-to-end deployment validation:

| Date | Commit | Test accounts | Region | Verified by | Notes |
|------|--------|---------------|--------|-------------|-------|
| 2026-11-13 | 219c26d | two non-production test accounts | eu-central-1 | `npx projen integ` (integ-runner) | `SUCCESS integ.tenant 3005s`: every step of spec §10 passed, with the reader grant (R-36) in step 1. Deploy about 4 min, assertions 22 min, teardown about 34 min; nothing left in either account. The integ-runner process stays alive after it prints the result ([#41](https://github.com/aws-samples/sample-agentic-ai-acceleration-patterns/issues/41)) |

**Integration test coverage:**
- Two-account, two-application deployment scenario
- Operator and reader grants: all ten reader reads, every reader write refused (its first call included), a role in neither list refused, nothing written
- Account handshake validation (external ID verification)
- Cell lifecycle: creation, tenant placement, reuse after evacuation
- Cross-account cell and tenant provisioning
- Admission controls: fleet capacity limits, allowlist enforcement
- Idempotency: replaying operations safely
- Complete teardown sequence in both accounts

**Test harness:** `test/integ.tenant.ts` — documented in `integration-test.md`

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
> application allowlist, synchronous tenants, implicit cell creation in the
> vendor-owned account, one tenant in two applications, idempotent replay,
> the fleet-full refusal, the admission refusal, targeted placement into a
> tenant-owned account whose role pair carries an external id,
> cross-account cell and tenant builds, the in-flight / occupied-tenant /
> occupied-cell / occupied-account / occupied-application guards, reads
> with every filter, reuse of an emptied cell, and complete teardown in
> both accounts.
> ADRs: see [`adr/`](./adr/README.md) (ADR-001..038).

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
  `cellCount` is the authoritative count of its cells.
- **Tenant management** — synchronous CRUDL for tenants. A tenant is a
  customer record (`name`, `description`, `deploymentCount`); creating one
  provisions nothing, and an empty tenant persists until an operator
  deletes it.
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

Cells are **homogeneous by construction, per application**: the
application's definition is stamped onto each of its cell records at
creation, and every deployment in a cell is provisioned with that cell's
stamped definition. Tenants and deployments carry no source or scripts of
their own — a deployment must be placeable into any cell of its
application with capacity, which per-tenant provisioning definitions would
break (ADR-012, ADR-032). A replaced application definition reaches only
cells created afterwards.

The design is one service: applications, accounts, cells, tenants and
deployments share one API, one table, one workflow. The deployment is the
join between a tenant and the cells of its applications; it lives as
`deployment.cellId` on a record keyed by tenant and application, not as a
separate placement service (ADR-037).

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
The authorizer maps the `role` claim to one of two grants (ADR-018,
ADR-042): a value in `ALLOWED_ROLES` (default `operator`) gets the operator
grant, a value in `READER_ROLES` (default none) the reader grant, and a
token whose `role` is missing or in neither list is denied, never
defaulted. A value in both lists fails synth and cold start. The grant is
the authorizer's policy: the whole stage for an operator, `GET/*` for a
reader, computed from the grant alone so the token-keyed cache never holds
a Deny for a reader's reads (`src/shared/authorizer-policy.ts`). The service
checks again by operation name (`src/shared/grant-check.ts`): the ten read
operations are open to both grants, every other operation requires the
operator grant and refuses a reader with `UnauthorizedError` (403). This
backstops issuer misconfiguration and issuer scope creep — a broader
population's tokens do not carry either role value. Every operator holds all
twenty-two operations (ADR-015); finer operator roles are the recorded seam
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
                        └──────────────────────────────┘
```

One service, one API, one DynamoDB table, one state machine, and two shared
CodeBuild projects: one for cell builds and one for tenant builds — for any
number of applications. The workflow has an optional first build phase: a
deployment that needs a new cell runs the cell create build, then the tenant
create build, in a single execution.

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

## 4. Data Model

Single table, five entity types — application, account, cell, tenant,
deployment — plus a small control-plane-internal idempotency record type
(ADR-017).

### Application (ADR-032)

| Field | Type | Notes |
|---|---|---|
| `applicationId` | string | operator-chosen, `[a-z0-9-]{1,32}` — the item's identity, never generated; usable as a parameter path segment (§7) |
| `source` | `SourceDefinition` | the CodeBuild source of the application's scripts |
| `cellScripts` | `ScriptLocations` | shared deployment lifecycle |
| `tenantScripts` | `ScriptLocations` | per-tenant deployment lifecycle |
| `maxTenants` | integer | deployments per cell, at least one; a replaced value applies to cells created afterwards |
| `placementStrategy` | enum | `FILL \| ROUND_ROBIN`, default `FILL`; orders accounts when a new cell is created (§6, ADR-036); never stamped |
| `cellCount` | integer | the authoritative count of this application's cells — claimed by the new-cell placement transaction, released by the cell-delete transaction; never written by `PutApplication` |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=APPLICATION#<applicationId>`, `SK=META`. `source`,
`cellScripts`, `tenantScripts` and `maxTenants` are the application's
**definition**, the bundle a new cell is stamped from. No status:
application operations are synchronous and run no build. `PutApplication`
is one unconditional `UpdateItem` that replaces the definition fields and
the strategy and sets `cellCount` and `createdAt` through `if_not_exists`,
so a replace never resets them (spec R-29) — the one write that is correct
in every prior state. `DeleteApplication` is one conditional `DeleteItem`
(`cellCount = 0`), the counterpart of the cell-slot claim.

### Account (ADR-024)

| Field | Type | Notes |
|---|---|---|
| `accountId` | string | the AWS account id, 12 digits — operator-supplied, the item's identity |
| `owner` | enum | `VENDOR \| TENANT`; immutable after registration (`PutAccount` with another owner is a 409) |
| `applicationIds` | string list? (unique, never empty) | absent: the account is **shared** and admits every application; present: the account is **dedicated** and admits only those (ADR-033). Each id must name a registered application when written (404 otherwise); replaceable; narrowing it stops new cells of the removed applications there and withdraws their cells' free slots from untargeted placement; the cells stay |
| `maxCells` | integer | cell capacity; replaceable; lowering below `cellCount` only stops new cells |
| `cellCount` | integer | the authoritative cell counter — claimed by the new-cell placement transaction, released by the cell-delete transaction; never written by `PutAccount` |
| `externalId` | string? | required when `owner = TENANT`, optional for `VENDOR` (ADR-029); presented on every AssumeRole into the account (ADR-025); never returned by the API (`externalIdConfigured` is) |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=ACCOUNT#<accountId>`, `SK=META`. No status: account operations
are synchronous and run no build. `PutAccount` is one conditional
`UpdateItem` (`attribute_not_exists(PK) OR owner = :owner`) that initialises
`owner`, `cellCount`, and `createdAt` with `if_not_exists` and replaces the
policy fields (`applicationIds`, `maxCells`, `externalId`), so a capacity
cut and a concurrent claim compose without a lost update (spec R-24).
`DeleteAccount` is one conditional `DeleteItem` (`cellCount = 0`), the
counterpart of the cell-slot claim.

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
| `lastBuildId` | string? | most recent successful cell-scoped CodeBuild build ARN |
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
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=TENANT#<tenantId>`, `SK=META`. No status: tenant operations are
synchronous and run no build. The tenant carries **no source, no scripts,
no cell and no build state** — everything provisioned for a tenant is a
deployment (ADR-037). `DeleteTenant` is one conditional `DeleteItem`
(`deploymentCount = 0`), the counterpart of the deployment claim.

### Deployment (ADR-037)

| Field | Type | Notes |
|---|---|---|
| `tenantId` | string | the tenant — with `applicationId` the item's identity |
| `applicationId` | string | the application; one deployment per tenant per application |
| `cellId` | string | the placement — assigned at creation, never changes; always a cell of `applicationId` |
| `status` | enum | `CREATING \| ACTIVE \| UPDATING \| DELETING \| CREATE_FAILED \| UPDATE_FAILED \| DELETE_FAILED` |
| `lastBuildId` | string? | most recent successful tenant-scoped CodeBuild build ARN |
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

Three GSIs serve nine listing patterns; the tenth, a tenant's deployments,
is a base-table query. Each item carries at most one partition attribute
per index:

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

Account and application items carry GSI-1 attributes only, tenant items
GSI-2 only; cells and deployments appear in all three; idempotency records
in none. A cell of one application holds at most one deployment per
tenant, so `DEPLOYMENT#<tenantId>` is unique inside a cell or application
partition. ULID sort keys give the cell, tenant and deployment listings
creation order; accounts and applications list by id. The static
partitions are a deliberate trade-off, fine at sample fleet sizes.

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

All synchronous — no tenant operation runs a build (ADR-037).

| Operation | HTTP | Status | Behaviour |
|---|---|---|---|
| `CreateTenant` | `POST /tenants` | 200 | Input `{name, description?}`. Inserts the record with `deploymentCount = 0`, conditional on non-existence. Nothing is provisioned |
| `GetTenant` | `GET /tenants/{tenantId}` | 200 | `name`, `description`, `deploymentCount`. 404 if missing |
| `UpdateTenant` | `PUT /tenants/{tenantId}` | 200 | Metadata only (`name`, `description`), field-ownership write conditional on existence; never `deploymentCount`. 404 if missing |
| `DeleteTenant` | `DELETE /tenants/{tenantId}` | 200 | **Empty tenants only**: one conditional `DeleteItem` (`attribute_exists(PK) AND deploymentCount = 0`); 409 otherwise. Deployments are deleted first, one by one |
| `ListTenants` | `GET /tenants` | 200 | Paginated, unfiltered. The tenants of one cell or application are listed through `ListDeployments` |

### Deployment operations (ADR-037)

| Operation | HTTP | Status | Sync/Async | Behaviour |
|---|---|---|---|---|
| `CreateDeployment` | `POST /tenants/{tenantId}/deployments` | **202** | Async | Input: `{applicationId, adminEmail, accountId?, clientToken?}` — **no resource definition**. 404 for an unknown tenant or an unregistered application. Placement (§6): in **one transaction**, claim a slot in an `ACTIVE` cell of the application with capacity — or claim a cell slot on an eligible account, count the cell on the application, and create a new cell record (`CREATING`, deployment slot pre-claimed, `applicationId` and `accountId` set, definition stamped) — count the deployment on the tenant, and persist the deployment `CREATING` with `cellId`; then start the workflow (tenant create build, preceded by the cell create build if a new cell was needed). `accountId` pins the deployment to one registered account (the only way into a tenant-owned one; 404 if unregistered; 400 if it does not admit the application, ADR-033); absent, vendor-owned accounts that admit the application only. 409 `ConflictError` when the tenant already has a deployment of the application; 409 `InsufficientCapacityError` when no eligible account has cell capacity (ADR-026). Returns the deployment including `cellId`. `adminEmail` is pass-through bootstrap input, never persisted (ADR-004). `clientToken` makes the call idempotent (ADR-017): a retry with the same token returns the original deployment; reuse with different parameters is a 409 |
| `GetDeployment` | `GET /tenants/{tenantId}/deployments/{applicationId}` | 200 | Sync | The polling endpoint — `status`, `statusReason`, `lastBuildId`, `cellId`, plus the **effective definition** (`source` + `scripts` resolved from the cell's stamped definition) and the cell's `accountId`. 404 if missing |
| `UpdateDeployment` | `PUT /tenants/{tenantId}/deployments/{applicationId}` | **202** | Async | Re-apply the deployment: **no body** — runs the cell's stamped **tenant update** script. Allowed when the deployment is `ACTIVE`/`UPDATE_FAILED` **and** the cell is `ACTIVE`; 409 otherwise. 404 if missing |
| `DeleteDeployment` | `DELETE /tenants/{tenantId}/deployments/{applicationId}` | **202** | Async | 409 if the deployment is in-flight. Allowed from `ACTIVE` and all `*_FAILED` states **regardless of cell status** — the delete script is the cleanup path, including when the cell itself is `CREATE_FAILED`. Sets `DELETING`; the workflow runs the **tenant delete** script, then in one transaction removes the record, decrements the cell's `tenantCount` and the tenant's `deploymentCount` |
| `ListDeployments` | `GET /deployments[?tenantId=\|?cellId=\|?applicationId=]` | 200 | Sync | Paginated. At most one filter per request (400 for two). `tenantId` is a base-table query, `cellId` uses GSI-1, `applicationId` GSI-3, no filter GSI-2. An unknown id yields an empty page, not a 404 (the filter is a query predicate, not a resource lookup) |

### Cell operations

| Operation | HTTP | Status | Sync/Async | Behaviour |
|---|---|---|---|---|
| `ListCells` | `GET /cells[?accountId=\|?applicationId=]` | 200 | Sync | Paginated fleet topology: `applicationId`, `accountId`, `status`, `tenantCount`/`maxTenants` per cell. At most one filter (400 for two): `accountId` via GSI-2, `applicationId` via GSI-3 — an unknown id yields an empty page, not a 404 |
| `GetCell` | `GET /cells/{cellId}` | 200 | Sync | Full cell record including `applicationId`, `accountId` and the stamped definition. 404 if missing |
| `UpdateCell` | `PUT /cells/{cellId}` | **202** | Async | Re-apply the shared cell deployment: no body — runs the stamped **cell update** script. Allowed from `ACTIVE`/`UPDATE_FAILED`; 409 if in-flight or `CREATE_FAILED` — re-running the **update** script against a half-created shared deployment would break the create/update script contract, so remediation for a failed cell create is deployment delete + cell delete. 404 if missing |
| `DeleteCell` | `DELETE /cells/{cellId}` | **202** | Async | **Empty cells only**: 409 if `tenantCount > 0` or the cell is in-flight (ADR-014). Allowed from `ACTIVE` and `*_FAILED` states. Sets `DELETING` via a **single conditional `UpdateItem`** (`condition: status IN {ACTIVE, *_FAILED} AND tenantCount = 0`) — the emptiness check and the transition are one atomic write, the counterpart of the placement claim. A read-then-write here would let a concurrent placement claim a slot before `DELETING` lands; condition failure maps to the 409. Once `DELETING` is set, placement is closed (placement requires `ACTIVE`); the workflow runs the **cell delete** script, then removes the record and releases the account's cell slot and the application's count in **one transaction** (§7) |

### Account operations (ADR-024, ADR-027, ADR-033)

All synchronous — no account operation runs a build.

| Operation | HTTP | Status | Behaviour |
|---|---|---|---|
| `PutAccount` | `PUT /accounts/{accountId}` | 200 | Create-or-replace. Input `{owner, maxCells, applicationIds?, externalId?}`; `externalId` required when `owner = TENANT` (400 otherwise, ADR-029); every `applicationIds` entry must name a registered application (404 otherwise). Then verifies the handshake: the API function assumes both halves of the account's role pair with the given `externalId` and discards the credentials, and when an `externalId` is given assumes each half once more without it and requires that call to be refused (ADR-030); a refusal is a 400 naming the role and the reason (`ValidationException`); a probe STS could not answer is a 500 asking for a retry. Then one conditional `UpdateItem`: `owner` immutable (409 on change), `maxCells`/`applicationIds`/`externalId` replaced (an absent `applicationIds` makes the account shared), `cellCount` untouched |
| `GetAccount` | `GET /accounts/{accountId}` | 200 | `owner`, `applicationIds` (absent when shared), `cellCount`/`maxCells`, `externalIdConfigured`. 404 if unregistered |
| `ListAccounts` | `GET /accounts` | 200 | Paginated capacity view one level above `ListCells` |
| `DeleteAccount` | `DELETE /accounts/{accountId}` | 200 | **Empty accounts only**: one conditional `DeleteItem` (`cellCount = 0`); 409 otherwise. The account's roles stay installed — removing them is the owner's act |

### Application operations (ADR-032, ADR-036)

All synchronous — no application operation runs a build.

| Operation | HTTP | Status | Behaviour |
|---|---|---|---|
| `PutApplication` | `PUT /applications/{applicationId}` | 200 | Create-or-replace. Input `{source, cellScripts, tenantScripts, maxTenants, placementStrategy?}`, validated as a whole by the generated server SDK (400 on a missing script path, a malformed source, `maxTenants < 1`, an unknown strategy, or an id outside `[a-z0-9-]{1,32}`). An unpinned source is accepted with a logged warning (ADR-020). One `UpdateItem`: definition and strategy replaced, `cellCount` and `createdAt` set through `if_not_exists`. Cells already created keep their stamp |
| `GetApplication` | `GET /applications/{applicationId}` | 200 | The definition, `placementStrategy` and `cellCount`. 404 if unregistered |
| `ListApplications` | `GET /applications` | 200 | Paginated: `applicationId`, `maxTenants`, `placementStrategy`, `cellCount` per application |
| `DeleteApplication` | `DELETE /applications/{applicationId}` | 200 | **Empty applications only**: one conditional `DeleteItem` (`cellCount = 0`); 409 otherwise. Accounts that name the application in `applicationIds` are not touched; the id is inert there |

Twenty-two operations: five tenant, five deployment, four cell, four
account, four application. There is deliberately **no `POST /cells`** — cell
creation is a placement outcome, not an operator action (ADR-013) — no
implicit account creation: an account exists only after an operator
registered it (ADR-024) — and no application-level provisioning: an
application owns no deployment of its own, only the definition its cells
are built from. The stamped definition is immutable per cell; a
definition-replacing `UpdateCell` body is a noted extension, not included.

### Status state machines

Cells and deployments share one status vocabulary; applications, accounts
and tenants have no status:

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

Transitional statuses remain the concurrency guard (409 on in-flight
mutations) for both entity types. Every transition into `CREATING`, `UPDATING`,
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

### Error shapes

`ValidationException` 400 (malformed input; two list filters at once; an
invalid application definition; a targeted `CreateDeployment` into an
account that does not admit the application; a `PutAccount` whose handshake
was refused), `UnauthorizedError` 401/403, `ResourceNotFoundError` 404
(unknown tenant, deployment, cell, account, or application — including an
unregistered `CreateDeployment.accountId` or `applicationId` and an
unregistered id in `PutAccount.applicationIds`), `ConflictError` 409
(in-flight mutations; a second deployment of one application for one
tenant; occupied-tenant, occupied-cell, occupied-account and
occupied-application deletes; `owner` change; cell-not-ACTIVE guards; a
`CreateDeployment` that lost every bounded claim on candidate cells
while no account had a free cell slot — retry, ADR-031; `clientToken` reuse
with different parameters, ADR-017), `InsufficientCapacityError` 409 (no
eligible account has cell capacity; nothing was written; the remedy is an
operator act — raise `maxCells`, register an account, or admit the
application in one — ADR-026), `InternalServerError` 500.

## 6. Placement and Capacity (ADR-013)

Placement happens synchronously inside `CreateDeployment`, before the
workflow starts:

```
0. Target (ADR-024, ADR-032, ADR-033, ADR-035, ADR-036):
     a clientToken already on record → replay (below) before anything else
     read the tenant and the application (404 if either is missing); the
       application record is the stamp for a new cell
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
         CONDITION attribute_exists(PK)
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
     tenant condition cancelled → the tenant was deleted meanwhile → 404; stop
     capacity/status condition cancelled (lost a race) → try next candidate
     any other cancellation or transaction error → fail the request; never
       retarget the same deployment after an ambiguous transaction outcome
3. No candidate claimed (none found, or the candidate budget is exhausted):
     for each eligible account in order, TransactWriteItems:
       UpdateItem account: SET cellCount = cellCount + 1
         CONDITION attribute_exists(PK) AND cellCount < maxCells   (first item)
       UpdateItem application: SET cellCount = cellCount + 1
         CONDITION attribute_exists(PK)
       PutItem new cell: status=CREATING, applicationId, accountId=<account>,
         tenantCount=1 (slot pre-claimed), definition stamped from the
         application record read in step 0
         CONDITION attribute_not_exists(PK)
       UpdateItem tenant: SET deploymentCount = deploymentCount + 1
         CONDITION attribute_exists(PK)
       PutItem deployment: status=CREATING, cellId=<new cell>
         CONDITION attribute_not_exists(PK)
       [PutItem idempotency record — as above (ADR-017), still last]
     account condition cancelled alone → that account is full; next account
     application condition cancelled → application deleted meanwhile → 404
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
would additionally sweep aged transitional records.

## 7. Provisioning Workflow (Step Functions)

One state machine, resolved execution input (ADR-011: the service resolves
sources, script paths from the cell's stamp, and failure statuses; the
workflow rereads no mutable records):

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
                   "scriptPath": "...", "failedStatus": "..." },
  "tenantId": "...",
  "tenantBuild": { "operation": "create|update|delete",
                   "scriptPath": "...", "failedStatus": "...",
                   "tenantName": "...", "adminEmail": "..." }
}
```

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
     StartBuild (.sync) — cell CodeBuild project, with a task-level timeout:
       sourceTypeOverride / sourceLocationOverride = stamped cell source
       sourceVersion = stamped pin, when present (ADR-020)
       buildspecOverride  = inline (ADR-025): `aws sts assume-role` on
            PROVISIONING_ROLE_ARN with OPERATOR_SESSION_NAME and, when set,
            PROVISIONING_EXTERNAL_ID; export the three AWS credential
            variables; `bash "$SCRIPT_PATH"`
       env: SCRIPT_PATH=cellBuild.scriptPath, APPLICATION_ID, CELL_ID,
            CELL_ACCOUNT_ID, OPERATION=cellBuild.operation, OPERATOR_ID
            (ADR-019), PROVISIONING_ROLE_ARN=cellRoleArn,
            PROVISIONING_EXTERNAL_ID, OPERATOR_SESSION_NAME
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
       update → compare-and-set UPDATING→ACTIVE + lastBuildId; end
       create → compare-and-set CREATING→ACTIVE + lastBuildId; continue to 2
     build failure or task timeout (Catch):
       if tenantBuild present → TransactWriteItems:
         UpdateItem cell CREATING→CREATE_FAILED + statusReason
         UpdateItem deployment CREATING→CREATE_FAILED +
           statusReason="cell provisioning failed"; end
       otherwise → compare-and-set cell from the operation's in-flight status
         to cellBuild.failedStatus + statusReason; end
2. Choice: tenantBuild present?
     StartBuild (.sync) — tenant CodeBuild project, with a task-level timeout:
       env: SCRIPT_PATH=tenantBuild.scriptPath, TENANT_ID,
            TENANT_NAME (the tenant's stored name, every operation; ADR-023),
            APPLICATION_ID, CELL_ID, CELL_ACCOUNT_ID,
            OPERATION=tenantBuild.operation, OPERATOR_ID (ADR-019),
            ADMIN_EMAIL (create only; empty string otherwise),
            PROVISIONING_ROLE_ARN=tenantRoleArn, PROVISIONING_EXTERNAL_ID,
            OPERATOR_SESSION_NAME
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
       update → compare-and-set UPDATING→ACTIVE + lastBuildId
     build failure or task timeout (Catch):
       compare-and-set deployment from the operation's in-flight status to
         tenantBuild.failedStatus + statusReason
3. Every terminal DynamoDB task retries transient failures. Retry exhaustion
   is caught and routed through the same conditional *_FAILED transition when
   the record still exists; an already-absent record means the terminal delete
   committed and the workflow ends successfully.
```

Design points:

- **Two shared CodeBuild projects** separate cell builds from tenant builds,
  for every application. Both use per-execution source and script overrides.
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
- **Threat-model hardening (ADR-019/020/021):** both projects cap
  `concurrentBuildLimit` at 5 so a leaked token's amplification queues
  instead of fanning out, and log to explicit one-month-retention log
  groups. Every build receives `OPERATOR_ID` (the verified JWT `sub`) so
  application-plane changes attribute to the initiating operator, not just
  the shared fleet role. A stamped `sourceVersion` commit SHA pins what the
  build fetches. Action-less CloudWatch alarms watch execution-start rate
  and API 4XX rate. Provisioning scripts follow `scripts/CONVENTIONS.md`:
  log parameter names, never values.
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
- Each build Task has a catchable task-level timeout. The state-machine
  execution timeout is greater than the sum of both build-task budgets plus
  terminal-write recovery margin; it is a final safety net, not the normal
  timeout path. Terminal writes retry transient failures, and retry exhaustion
  is caught so records do not remain indefinitely in an in-flight state.
  `StartExecution` rejection is compensated as in §6.
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

## 8. Smithy Model Sketch

Condensed; every shape gets `@documentation`, cross-resource ids get
`@references`:

```smithy
// model/application.smithy (ADR-032)
resource Application {
    identifiers: { applicationId: ApplicationId }   // ^[a-z0-9-]{1,32}$
    put: PutApplication       // PUT /applications/{applicationId} → 200, create-or-replace
    read: GetApplication      // GET /applications/{applicationId}
    delete: DeleteApplication // DELETE /applications/{applicationId} → 200, empty applications only
    list: ListApplications    // GET /applications
}

// model/tenant.smithy — the customer; synchronous, no status
resource Tenant {
    identifiers: { tenantId: TenantId }
    create: CreateTenant      // POST /tenants → 200, nothing provisioned
    read: GetTenant
    update: UpdateTenant      // PUT — metadata only, sync 200
    delete: DeleteTenant      // DELETE → 200, empty tenants only
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
    put: PutAccount           // PUT /accounts/{accountId} → 200, verifies the handshake first (ADR-027, ADR-030)
    read: GetAccount          // GET /accounts/{accountId}
    delete: DeleteAccount     // DELETE /accounts/{accountId} → 200, empty accounts only
    list: ListAccounts        // GET /accounts
}

structure PutApplicationInput {
    @required @httpLabel applicationId: ApplicationId
    @required source: SourceDefinition         // {type, location, sourceVersion?}
    @required cellScripts: ScriptLocations     // {create, update, delete}
    @required tenantScripts: ScriptLocations
    @required maxTenants: MaxTenants           // >= 1
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
│   ├── tenant.smithy              # Tenant resource (the customer; synchronous)
│   ├── deployment.smithy          # Deployment resource (ADR-037; no per-tenant definition)
│   ├── cell.smithy                # Cell resource (no create — ADR-013)
│   └── account.smithy             # Account resource (ADR-024)
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
│   │   ├── fleet.ts               # fleet role naming, role ARNs, STS session name
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
│       │                          #   buildspec, transactional deletes, build roles
│       └── tenant.cdk.ts          # stack: API GW, Lambda (<fleet>-api role), DDB (PITR,
│                                  #   GSI-1/2/3), SFN, home account role pair
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
| `fleetName` (optional, default `control-plane`) | names the five fleet roles: `<fleet>-api`, `<fleet>-cell-build`, `<fleet>-tenant-build` in the control plane account and `<fleet>-cell-provisioning`, `<fleet>-tenant-provisioning` in every account that hosts cells (ADR-025, ADR-028); `[a-z0-9-]{1,32}` |
| `tenantBuildManagedPolicyArns` (optional) | customer-managed IAM policy ARNs attached to the tenant provisioning role of the stack's own account, in addition to its §7 SSM grants (ADR-022, ADR-025) |
| `demoApplicationIds` (optional, default none) | publishes `/application-plane/applications/<applicationId>/shared/base-domain` in the stack's own account for each listed id, the demo shared resource the sample cell script reads (ADR-034); a real application plane publishes its own |

Applications and accounts are **not** deployment inputs: they are
registered through the API — applications (`PutApplication`) so a new one
needs no redeploy (ADR-032), accounts (`PutAccount`) because a customer's
account appears on demand (ADR-024). The control plane stack therefore
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
| `cellAccount.demoApplicationIds` (optional, default none) | publishes the demo `/application-plane/applications/<applicationId>/shared/base-domain` in this account for each listed id; absent, a customer's account gets the two roles and nothing else |

Supplied via CDK context. When `tenantBuildManagedPolicyArns` is non-empty,
synthesis fails if any entry is not a managed-policy ARN in the stack's own
partition and account, or if the stack's account or Region is unresolved
so that check cannot run (ADR-022). The application definition is
validated by `PutApplication` instead: the generated server SDK rejects a
missing script path, a malformed source, `maxTenants` below one, an
unknown strategy or an id outside the charset, and the service warns (does
not refuse) when `source.sourceVersion` is absent or not a full commit SHA
(ADR-020). Replacing an application's definition affects only cells created
afterwards; existing cells keep their stamped definition.

## 11. Deployment Lessons

`externalModules: []` bundling, the `re2.wasm` commandHook, and an
extensible `CallerContext` for the SSDK handler.

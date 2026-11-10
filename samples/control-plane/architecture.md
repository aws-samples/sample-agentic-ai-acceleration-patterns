# Multi-Tenant Control Plane — Architecture (Cell-Based, Multi-Account)

> Status: **Implemented and verified** — the current architecture. The
> integration test (`test/integ.tenant.ts`) passed against deployed
> infrastructure on 2026-11-10 (eu-central-1) across **two accounts**: the
> handshake check (no pair; a pair that does not require the external id it
> is given; missing and wrong external id), account
> registration, implicit cell creation in the vendor-owned account, fill-to-capacity at the account cell limit, the
> fleet-full refusal, targeted placement into a tenant-owned account whose
> role pair carries an external id, cross-account cell and tenant builds, the
> in-flight / occupied-cell / occupied-account guards, reads including the
> `?accountId=` filter, reuse of an emptied cell, and complete teardown in
> both accounts including account deregistration (74 assertions, 16 builds,
> 33 minutes: about 5 deploy, 15 scenario, 13 destroy). The joint
> control-plane mount test owned by the `tenant-identity` sample
> (`samples/tenant-identity/test/integ.control-plane.ts`) registers the home
> account before onboarding and passed on 2026-11-10 in a single account
> (12 minutes). The API access log group can reappear after teardown;
> the joint test deletes it with a warning (README, Known issues).
> ADRs: see [`adr/`](./adr/README.md) (ADR-001..031).

## 1. Purpose

**Goal: a cell-based control plane for a single deployment model,
across accounts.**

A multi-tenant control plane sample for **cell-based
deployments**.

A *cell* is a deployment unit containing one **shared
application deployment** plus up to `maxTenants` tenants, each with its **own
per-tenant application deployment** inside the cell. Setting `maxTenants = 1`
degenerates the cell model to the silo model — every tenant gets its own
cell — so the cell model is a strict generalisation of a silo control plane
(ADR-012).

Cells live in **accounts** (ADR-024). An account is an AWS account an
operator registered with a cell limit (`maxCells`) and an owner: a
**vendor-owned** account is fleet capacity that placement fills, oldest
registered first; a **tenant-owned** account belongs to a customer and
receives only tenants whose `CreateTenant` names it. The account owner
installs a provisioning role pair (ADR-025) and can withdraw it; the control
plane holds no credentials for any account, only its id. The control plane's
own account is registered like any other. Two scenarios follow directly:
scaling the fleet to a second account in the Region, and deploying a tenant
into the customer's own account on demand.

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

- **Tenant management** — CRUDL for tenants. Creating a tenant places it into
  a cell with free capacity and provisions its per-tenant deployment;
  deleting a tenant deprovisions it and frees the slot.
- **Cell lifecycle** — cells are created **implicitly**: when onboarding
  finds no cell with free capacity, a new cell is provisioned first, then the
  tenant is placed into it (ADR-013). Cells are read, re-applied, and
  explicitly deleted (empty cells only) via the API; there is no explicit
  cell-create operation.
- **Script-driven provisioning** — one deployment-configured
  **CellDefinition** supplies a CodeBuild
  [`ProjectSource`](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ProjectSource.html)
  and two script sets: `cellScripts` (create/update/delete the shared cell
  deployment) and `tenantScripts` (create/update/delete a per-tenant
  deployment). Lifecycle operations invoke CodeBuild to run the matching
  script (ADR-002, ADR-012).
- **Vendor IdP authentication** — a vendor IdP (deployment-time input)
  protects every control plane operation via a Lambda Authorizer.
- **Account registry** — operators register accounts (`PutAccount`), see
  their occupancy (`ListAccounts`), and deregister empty ones. Registration
  verifies the handshake by assuming both roles of the pair and, when an
  external id is given, proving each role refuses the call without it
  (ADR-027, ADR-030); the
  account's `cellCount` is the authoritative cell counter, claimed and
  released by the same transactional discipline as the cell's `tenantCount`.

Cells are **homogeneous by construction**: the CellDefinition is deployment
configuration, stamped onto each cell record at creation, and every tenant in
a cell is provisioned with that cell's stamped definition. Tenants carry no
source or scripts of their own — a tenant must be placeable into any cell
with capacity, which per-tenant provisioning definitions would break
(ADR-012).

The design is one service: accounts, cells and tenants share one API, one
table, one workflow. The cell is the N:1 placement join between a tenant and
its deployment; it lives as `tenant.cellId`, not as a separate service
(ADR-001).

Out of scope: billing/metering, tenant tiers, cell rebalancing/migration
(between cells or accounts), pre-provisioning capacity ahead of demand,
account vending, a Region per account, and all application plane concerns —
including customer identity (ADR-004).

## 2. Actors and Identity Model

Control plane callers are **vendor operators**; the **vendor IdP** (OIDC issuer URL + audience) is a
deployment-time input consumed by the Lambda Authorizer (JWKS-based JWT
validation) on every operation. There are no unauthenticated operations.

### Caller context

The authorizer writes `sub`, `role` (ADR-006); the handler is a
pass-through building an immutable `CallerContext { operatorId, role }`; the
service receives `CallerContext` per operation and a static `ServiceConfig`
at cold start. Callers act across tenants and cells — control plane data is
not tenant-scoped by caller.

The configured issuer is a dedicated control-plane trust boundary: it issues
tokens exclusively to fully privileged vendor operators. The authorizer
enforces the `role` claim as a coarse membership gate (ADR-018): a token
whose `role` is missing or outside the allowed set (`ALLOWED_ROLES` env var,
default `operator`) is denied, never defaulted. This backstops issuer
misconfiguration and issuer scope creep — a broader population's tokens do
not carry the operator role. There is no per-operation role matrix
(ADR-015): every allowed role holds all fifteen operations. Connecting a
general workforce or customer issuer requires adding explicit per-operation
authorization before deployment; the membership gate alone is not sufficient
for a trust population with mixed privileges.

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
                        ┌──────────▼──────────┐
                        │ Tenant Service       │
                        │ (Lambda)             │
                        │ DDB: accounts, cells,│◄────────────┐
                        │ tenants (one table)  │             │ terminal status
                        └──────────┬──────────┘             │ written directly
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
CodeBuild projects: one for cell builds and one for tenant builds. The
workflow has an optional first build phase: an onboarding that needs a new
cell runs the cell create build, then the tenant create build, in a single
execution.

```
                                              sts:AssumeRole (external id)
  CodeBuild cell scripts  ──┐            ┌──► Account A (vendor-owned)
  CodeBuild tenant scripts ─┴── bus ─────┤      <fleet>-cell-provisioning
                                         │      <fleet>-tenant-provisioning
                                         │      /application-plane/* (SSM)
                                         └──► Account B (tenant-owned)
                                                same pair, same namespaces
```

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

## 4. Data Model

Single table, three entity types — plus a small control-plane-internal
idempotency record type (ADR-017).

### Account (ADR-024)

| Field | Type | Notes |
|---|---|---|
| `accountId` | string | the AWS account id, 12 digits — operator-supplied, the item's identity |
| `owner` | enum | `VENDOR \| TENANT`; immutable after registration (`PutAccount` with another owner is a 409) |
| `maxCells` | integer | cell capacity; replaceable; lowering below `cellCount` only stops new cells |
| `cellCount` | integer | the authoritative cell counter — claimed by the new-cell placement transaction, released by the cell-delete transaction; never written by `PutAccount` |
| `externalId` | string? | required when `owner = TENANT`, optional for `VENDOR` (ADR-029); presented on every AssumeRole into the account (ADR-025); never returned by the API (`externalIdConfigured` is) |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=ACCOUNT#<accountId>`, `SK=META`. No status: account operations
are synchronous and run no build. `PutAccount` is one conditional
`UpdateItem` (`attribute_not_exists(PK) OR owner = :owner`) that initialises
`owner`, `cellCount`, and `createdAt` with `if_not_exists` and replaces the
policy fields, so a capacity cut and a concurrent claim compose without a
lost update (spec R-24). `DeleteAccount` is one conditional `DeleteItem`
(`cellCount = 0`), the counterpart of the cell-slot claim.

### Cell

| Field | Type | Notes |
|---|---|---|
| `cellId` | string (ULID) | generated |
| `accountId` | string | the account the cell is provisioned in — assigned at creation, never changes (ADR-024) |
| `status` | enum | `CREATING \| ACTIVE \| UPDATING \| DELETING \| CREATE_FAILED \| UPDATE_FAILED \| DELETE_FAILED` |
| `maxTenants` | integer | stamped from deployment config at creation (ADR-012) |
| `tenantCount` | integer | atomic slot counter — the capacity and occupancy guard (ADR-013) |
| `source` | `SourceDefinition` | stamped from the CellDefinition |
| `cellScripts` | `ScriptLocations` | stamped — shared deployment lifecycle |
| `tenantScripts` | `ScriptLocations` | stamped — per-tenant deployment lifecycle |
| `lastBuildId` | string? | most recent successful cell-scoped CodeBuild build ARN |
| `statusReason` | string? | populated on failure |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=CELL#<cellId>`, `SK=META`. The stamped definition is immutable for
the cell's lifetime — changing the deployment config affects only cells
created afterwards (ADR-012). New provisioning *code* flows in without
a definition change: git sources are fetched fresh on every build.

### Tenant

| Field | Type | Notes |
|---|---|---|
| `tenantId` | string (ULID) | generated |
| `name` | string | required |
| `description` | string? | |
| `cellId` | string | the placement — assigned at onboarding, never changes |
| `status` | enum | `CREATING \| ACTIVE \| UPDATING \| DELETING \| CREATE_FAILED \| UPDATE_FAILED \| DELETE_FAILED` |
| `lastBuildId` | string? | most recent successful tenant-scoped CodeBuild build ARN |
| `statusReason` | string? | populated on failure |
| `createdAt` / `updatedAt` | timestamp | |

Keys: `PK=TENANT#<tenantId>`, `SK=META`. The tenant carries **no source and
no scripts** — its deployment is defined by its cell's stamped definition.

Writes are field-owned (ADR-011): after initial creation,
service and workflow use `UpdateItem` expressions touching only the fields
each operation owns. Lifecycle transitions are compare-and-set writes,
conditional on the exact status read or on the operation's explicit accepted
status set. Metadata and failure writes are additionally conditional on
`attribute_exists(PK)` so no write can recreate a concurrently deleted record
as a ghost (§7).

### Idempotency record (ADR-017)

Written only when `CreateTenant` carries a `clientToken` — as a third item
in the placement transaction (§6), never separately.

| Field | Type | Notes |
|---|---|---|
| `clientToken` | string | caller-supplied, 1–64 chars — the item's identity |
| `tenantId` | string | the tenant the original request onboarded |
| `requestHash` | string | SHA-256 of the request parameters — reuse with different input is a 409 |
| `createdAt` | timestamp | |
| `expiresAt` | number | epoch seconds — the table's DynamoDB TTL attribute (24h) |

Keys: `PK=IDEMPOTENCY#<clientToken>`, `SK=META`. No GSI attributes — the
record is never listed and never returned; it exists only to cancel a
replayed placement transaction. TTL deletion is lazy, so a token is honoured
for **at least** 24 hours; replay handling ignores `expiresAt` and treats
any surviving record as authoritative.

### GSI-1 / GSI-2 — listing and per-cell / per-account lookup

Two GSIs serve the five listing patterns: GSI-1 carries three partition
shapes, GSI-2 two:

| Index | Item | PK | SK | Serves |
|---|---|---|---|---|
| GSI-1 | Cell | `CELL` (static) | `CELL#<cellId>` | `ListCells`, untargeted placement candidate scan |
| GSI-1 | Account | `ACCOUNT` (static) | `ACCOUNT#<accountId>` | `ListAccounts`, placement account scan |
| GSI-1 | Tenant | `CELL#<cellId>` | `TENANT#<tenantId>` | `ListTenants?cellId=` filter |
| GSI-2 | Tenant | `TENANT` (static) | `TENANT#<tenantId>` | unfiltered `ListTenants` |
| GSI-2 | Cell | `ACCOUNT#<accountId>` | `CELL#<cellId>` | `ListCells?accountId=` filter, targeted candidate scan |

Account items carry no GSI-2 attributes and never appear in it. ULID sort
keys give the cell and tenant listings creation order; accounts list by
account id. The static partitions are a deliberate trade-off, fine
at sample fleet sizes.

Both GSIs project **all attributes** (`ProjectionType: ALL`): the placement
candidate scan needs `status`, `tenantCount`, and `maxTenants`, and both
listings return full summaries — with `ALL`, each is a single query with no
follow-up base-table reads. The write amplification is irrelevant at sample
scale; a production fleet would trim to `INCLUDE` projections.

The GSIs are **eventually consistent and never authoritative**:
`tenantCount` on the cell record and `cellCount` on the account record — not
GSI counts — are the occupancy guards, and every claim is a conditional
write on the base table (§6). The GSIs nominate candidates; the base table
decides.

### `SourceDefinition` / `ScriptLocations`

`ScriptLocations` names the three scripts of one script set. `SourceDefinition`
has `type`, `location`, and an optional `sourceVersion` — a git ref
forwarded to CodeBuild StartBuild as `SourceVersion`. A full 40-character
commit SHA pins the provisioning source immutably (ADR-020); synthesis warns
when the ref is absent or mutable. These shapes live on the cell record and
in deployment configuration, not on tenants.

## 5. API — All Operations

Smithy `restJson1`, generated OpenAPI → API Gateway + Lambda proxy, token
authorizer applied per operation. Paths lowercase, plural collections,
singleton sub-resource singular.

### Tenant operations

| Operation | HTTP | Status | Sync/Async | Behaviour |
|---|---|---|---|---|
| `CreateTenant` | `POST /tenants` | **202** | Async | Input: `{name, description?, adminEmail, accountId?, clientToken?}` — **no resource definition**. Placement (§6): in **one transaction**, claim a slot in an `ACTIVE` cell with capacity — or claim a cell slot on an eligible account and create a new cell record (`CREATING`, tenant slot pre-claimed, `accountId` set) — and persist the tenant `CREATING` with `cellId`; then start the workflow (tenant create build, preceded by the cell create build if a new cell was needed). `accountId` pins the tenant to one registered account (the only way into a tenant-owned one; 404 if unregistered); absent, vendor-owned accounts only. 409 `InsufficientCapacityError` when no eligible account has cell capacity (ADR-026). Returns tenant including `cellId`. `adminEmail` is pass-through bootstrap input, never persisted (ADR-004). `clientToken` makes the onboard idempotent (ADR-017): a retry with the same token returns the original tenant; reuse with different parameters is a 409 |
| `GetTenant` | `GET /tenants/{tenantId}` | 200 | Sync | The polling endpoint — `status`, `statusReason`, `lastBuildId`, `cellId`. 404 if missing |
| `UpdateTenant` | `PUT /tenants/{tenantId}` | 200 | Sync | Metadata only (`name`, `description`), field-ownership write. No state guard. 404 if missing |
| `DeleteTenant` | `DELETE /tenants/{tenantId}` | **202** | Async | 409 if tenant in-flight. Allowed from `ACTIVE` and all `*_FAILED` tenant states **regardless of cell status** — the delete script is the cleanup path, including when the cell itself is `CREATE_FAILED`. Sets `DELETING`; workflow runs the **tenant delete** script, then transactionally removes the record and decrements the cell's `tenantCount` |
| `ListTenants` | `GET /tenants[?cellId=]` | 200 | Sync | Paginated. Optional `cellId` filter via GSI-1 — an unknown `cellId` yields an empty page, not a 404 (the filter is a query predicate, not a resource lookup) |
| `GetResource` | `GET /tenants/{tenantId}/resource` | 200 | Sync | The tenant deployment's **effective definition and state**: `source` + `scripts` resolved from the cell's stamped definition, plus `status`, `lastBuildId`, `statusReason`, `cellId`, `accountId`. 404 if tenant missing |
| `UpdateResource` | `PUT /tenants/{tenantId}/resource` | **202** | Async | Re-apply the tenant deployment: **no body** — runs the cell's stamped **tenant update** script. Allowed when tenant is `ACTIVE`/`UPDATE_FAILED` **and** the cell is `ACTIVE`; 409 otherwise. 404 if tenant missing |

### Cell operations

| Operation | HTTP | Status | Sync/Async | Behaviour |
|---|---|---|---|---|
| `ListCells` | `GET /cells[?accountId=]` | 200 | Sync | Paginated fleet topology: `accountId`, `status`, `tenantCount`/`maxTenants` per cell. Optional `accountId` filter via GSI-2 — an unknown account yields an empty page, not a 404 |
| `GetCell` | `GET /cells/{cellId}` | 200 | Sync | Full cell record including `accountId` and the stamped definition. 404 if missing |
| `UpdateCell` | `PUT /cells/{cellId}` | **202** | Async | Re-apply the shared cell deployment: no body — runs the stamped **cell update** script. Allowed from `ACTIVE`/`UPDATE_FAILED`; 409 if in-flight or `CREATE_FAILED` — re-running the **update** script against a half-created shared deployment would break the create/update script contract, so remediation for a failed cell create is tenant delete + cell delete. 404 if missing |
| `DeleteCell` | `DELETE /cells/{cellId}` | **202** | Async | **Empty cells only**: 409 if `tenantCount > 0` or the cell is in-flight (ADR-014). Allowed from `ACTIVE` and `*_FAILED` states. Sets `DELETING` via a **single conditional `UpdateItem`** (`condition: status IN {ACTIVE, *_FAILED} AND tenantCount = 0`) — the emptiness check and the transition are one atomic write, the counterpart of the placement claim. A read-then-write here would let a concurrent placement claim a slot before `DELETING` lands; condition failure maps to the 409. Once `DELETING` is set, placement is closed (placement requires `ACTIVE`); workflow runs the **cell delete** script, then removes the record and releases the account's cell slot in **one transaction** (§7) |

### Account operations (ADR-024, ADR-027)

All synchronous — no account operation runs a build.

| Operation | HTTP | Status | Behaviour |
|---|---|---|---|
| `PutAccount` | `PUT /accounts/{accountId}` | 200 | Create-or-replace. Input `{owner, maxCells, externalId?}`; `externalId` required when `owner = TENANT` (400 otherwise, ADR-029). First verifies the handshake: the API function assumes both halves of the account's role pair with the given `externalId` and discards the credentials, and when an `externalId` is given assumes each half once more without it and requires that call to be refused (ADR-030); a refusal is a 400 naming the role and the reason (`ValidationException`); a probe STS could not answer is a 500 asking for a retry. Then one conditional `UpdateItem`: `owner` immutable (409 on change), `maxCells`/`externalId` replaced, `cellCount` untouched |
| `GetAccount` | `GET /accounts/{accountId}` | 200 | `owner`, `cellCount`/`maxCells`, `externalIdConfigured`. 404 if unregistered |
| `ListAccounts` | `GET /accounts` | 200 | Paginated capacity view one level above `ListCells` |
| `DeleteAccount` | `DELETE /accounts/{accountId}` | 200 | **Empty accounts only**: one conditional `DeleteItem` (`cellCount = 0`); 409 otherwise. The account's roles stay installed — removing them is the owner's act |

Fifteen operations. There is deliberately **no `POST /cells`** — cell
creation is a placement outcome, not an operator action (ADR-013) — and no
implicit account creation: an account exists only after an operator registered
it (ADR-024). The stamped definition is immutable per cell; a
definition-replacing `UpdateCell` body is a noted extension, not included.

### Status state machines

Tenants and cells share one status vocabulary:

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
- `UpdateResource` (tenant build) requires the cell `ACTIVE` — no tenant
  builds against a shared deployment that is mid-change.
- The build guards are one-directional and **tolerated as such**:
  `UpdateResource`'s cell-`ACTIVE` check is read-then-act, and `UpdateCell`
  consults only the cell's own status (in-flight tenant builds don't change
  it) — so a cell build and a tenant build can overlap when their accepts
  race. Closing this would need an in-flight-build counter on the cell with
  the same conditional-claim discipline as placement; accepted instead — an
  overlap can fail a build (surfaced as `*_FAILED` + `statusReason`, on the
  documented retry paths) but never corrupts control plane state.
- `DeleteTenant` is exempt from cell-status guards — cleanup must always be
  reachable.

### Error shapes

`ValidationException` 400 (malformed input; a `PutAccount` whose handshake
was refused), `UnauthorizedError` 401/403, `ResourceNotFoundError` 404 (unknown
tenant, cell, or account — including an unregistered `CreateTenant.accountId`),
`ConflictError` 409 (in-flight mutations; occupied-cell and occupied-account
deletes; `owner` change; cell-not-ACTIVE guards; a `CreateTenant` that lost
every bounded claim against cells with room while no account had a free
cell slot — retry, ADR-031; `clientToken` reuse with
different parameters, ADR-017), `InsufficientCapacityError` 409 (no eligible
account has cell capacity; nothing was written; the remedy is an operator
act — ADR-026), `InternalServerError` 500.

## 6. Placement and Capacity (ADR-013)

Placement happens synchronously inside `CreateTenant`, before the workflow
starts:

```
0. Target (ADR-024):
     accountId given  → that one registered account (any owner; 404 if not
                        registered); candidate cells = its GSI-2 partition
     accountId absent → every VENDOR-owned account, oldest registered first;
                        candidate cells = GSI-1 CELL partition, filtered to
                        those accounts (a tenant-owned account's cells are
                        skipped)
1. Filter candidates: status=ACTIVE AND tenantCount < maxTenants
2. For each candidate (oldest first, **at most 5**):
     TransactWriteItems:
       UpdateItem cell:
         SET tenantCount = tenantCount + 1
         CONDITION status = ACTIVE AND tenantCount < maxTenants
       PutItem tenant: status=CREATING, cellId=<candidate>
         CONDITION attribute_not_exists(PK)
       [PutItem idempotency record — only when clientToken supplied (ADR-017)
         CONDITION attribute_not_exists(PK)]
     success → slot claimed and tenant persisted atomically; stop
     idempotency condition cancelled → replay: return the original tenant
       (or 409 on parameter mismatch); takes precedence over every other
       classification
     capacity/status condition cancelled (lost a race) → try next candidate
     any other cancellation or transaction error → fail the request; never
       retarget the same tenant after an ambiguous transaction outcome
3. No candidate claimed (none found, or the candidate budget is exhausted):
     for each eligible account in order, TransactWriteItems:
       UpdateItem account: SET cellCount = cellCount + 1
         CONDITION attribute_exists(PK) AND cellCount < maxCells   (first item)
       PutItem new cell: status=CREATING, accountId=<account>, tenantCount=1
         (slot pre-claimed), definition stamped from deployment config
         CONDITION attribute_not_exists(PK)
       PutItem tenant: status=CREATING, cellId=<new cell>
         CONDITION attribute_not_exists(PK)
       [PutItem idempotency record — as above (ADR-017), still last]
     account condition cancelled alone → that account is full; next account
     every eligible account refused (or none) → 409 InsufficientCapacityError,
       nothing written (ADR-026)
     → workflow will run the cell create build before the tenant create build
```

Step 1's candidate list comes from GSI-1 and is **eventually consistent** —
a stale read can nominate a full or `DELETING` cell, and the conditional
claim in step 2 is what rejects it. Correctness lives entirely in the
base-table condition; the GSI read is an optimisation, never a guard — do
not "simplify" the claim into a plain write. The `PutItem`s are conditional
on `attribute_not_exists(PK)` too — fresh ULIDs make a collision negligible,
but no write in this design is unconditional.

**Slot lifetime = tenant record lifetime — atomically, at both ends.** The
claim and the tenant record are created in one `TransactWriteItems` (a
service crash cannot leave a phantom slot with no tenant record referencing
it — a counter that could never be decremented and would block `DeleteCell`
forever), and released in one — the delete workflow's terminal transaction
(tenant `DeleteItem` + cell `tenantCount` decrement in one
`TransactWriteItems`). A `CREATE_FAILED` tenant still holds its slot; its
remediation (`DeleteTenant`) is what frees it. No other code path touches
the counter, which is what makes it trustworthy.

**The same holds one level up (ADR-024):** the account's `cellCount` is
claimed in the transaction that creates the cell and released in the
cell-delete workflow's terminal transaction (cell `DeleteItem` + account
`cellCount` decrement). A `CREATE_FAILED` cell holds its account slot until
`DeleteCell` releases it; `PutAccount` never writes the counter. Two
counters, two code paths each, all four transactional.

**Tolerated races** (over-provisioning, never corruption):

- Two concurrent onboards that both find no capacity both create a cell —
  the fleet ends up with one more cell than strictly needed, **bounded by
  the account's `maxCells`** (the account claim refuses beyond it). Accepted:
  serialising cell creation would need a fleet-wide lock for a rare, benign
  outcome.
- Two onboards racing for an account's last cell slot: one claims, the other
  moves to the next eligible account or gets the 409. No corruption.
- Onboards arriving while the only cell is still `CREATING` cannot place
  into it (placement requires `ACTIVE`) and will create further cells.
  Accepted for the same reason; a real fleet warms capacity ahead of demand,
  which is out of scope.
- Oldest-first candidate order funnels concurrent claims at the same cell,
  so racing onboards burn one cancelled transaction per contended candidate
  before spreading. Accepted at sample fleet sizes — the same
  trade-off as the static GSI partitions; a production fleet would randomise
  candidate order (or use power-of-two-choices) to spread claim contention.
- The candidate budget (at most 5 claim attempts) keeps `CreateTenant`
  comfortably inside the synchronous API Gateway window. Its miss case —
  every attempt loses a race while capacity still exists elsewhere — falls
  through to new-cell creation: over-provisioning again rather than a
  failed onboard. If that fall-through meets a full fleet, the request
  fails with a retryable `ConflictError` (the loop reports that its budget,
  not the fleet, ran out), never with the terminal
  `InsufficientCapacityError` (ADR-031).

A non-`ACTIVE` cell accepts no placements — in particular, a cell stuck in
`UPDATE_FAILED` removes its remaining capacity from the fleet until an
operator re-runs `UpdateCell`; onboards meanwhile fill other cells or create
new ones. Visible in `ListCells` (`status`, `tenantCount`/`maxTenants`).

**Compensation:** if `StartExecution` rejects after the placement
transaction, the service conditionally compensates the exact in-flight state.
For placement into an existing cell, one tenant update moves
`CREATING → CREATE_FAILED`. For a newly created cell, one
`TransactWriteItems` moves both the tenant and cell from `CREATING` to
`CREATE_FAILED`, so compensation cannot leave only one record recoverable.
Both remain on the documented remediation path (delete tenant, then delete
cell).

**Residual tolerated failure:** a process crash *between* the placement
transaction and `StartExecution` can still strand the tenant — and, for a new
cell, the cell — in `CREATING` with no workflow running. The placement
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
sources, script paths, and failure statuses; the workflow rereads no mutable
records):

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
  "cellId": "...",
  "cellBuild":   { "operation": "create|update|delete",
                   "scriptPath": "...", "failedStatus": "..." },
  "tenantId": "...",
  "tenantBuild": { "operation": "create|update|delete",
                   "scriptPath": "...", "failedStatus": "...", "adminEmail": "..." }
}
```

`cellBuild` and `tenantBuild` are each optional; the combination encodes the
operation shape:

| Trigger | `cellBuild` | `tenantBuild` |
|---|---|---|
| `CreateTenant` into an existing cell | — | create |
| `CreateTenant` requiring a new cell | create | create |
| `UpdateResource` | — | update |
| `DeleteTenant` | — | delete |
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
       env: SCRIPT_PATH=cellBuild.scriptPath, CELL_ID, CELL_ACCOUNT_ID,
            OPERATION=cellBuild.operation, OPERATOR_ID (ADR-019),
            PROVISIONING_ROLE_ARN=cellRoleArn, PROVISIONING_EXTERNAL_ID,
            OPERATOR_SESSION_NAME
     success (choice on cellBuild.operation):
       delete → TransactWriteItems with a stable ClientRequestToken (ADR-024):
                  DeleteItem cell
                    CONDITION attribute_exists(PK) AND status = DELETING
                              AND tenantCount = 0
                  UpdateItem account: cellCount = cellCount - 1
                    CONDITION attribute_exists(PK) AND cellCount > 0
                transaction cancellation → GetItem cell:
                  missing → deletion already committed; end successfully
                  present → compare-and-set status=DELETE_FAILED + reason; end
       update → compare-and-set UPDATING→ACTIVE + lastBuildId; end
       create → compare-and-set CREATING→ACTIVE + lastBuildId; continue to 2
     build failure or task timeout (Catch):
       if tenantBuild present → TransactWriteItems:
         UpdateItem cell CREATING→CREATE_FAILED + statusReason
         UpdateItem tenant CREATING→CREATE_FAILED +
           statusReason="cell provisioning failed"; end
       otherwise → compare-and-set cell from the operation's in-flight status
         to cellBuild.failedStatus + statusReason; end
2. Choice: tenantBuild present?
     StartBuild (.sync) — tenant CodeBuild project, with a task-level timeout:
       env: SCRIPT_PATH=tenantBuild.scriptPath, TENANT_ID,
            TENANT_NAME (the tenant's stored name, every operation; ADR-023),
            CELL_ID, CELL_ACCOUNT_ID, OPERATION=tenantBuild.operation,
            OPERATOR_ID (ADR-019), ADMIN_EMAIL (create only; empty string
            otherwise), PROVISIONING_ROLE_ARN=tenantRoleArn,
            PROVISIONING_EXTERNAL_ID, OPERATOR_SESSION_NAME
     success (choice on tenantBuild.operation):
       delete → TransactWriteItems with a stable ClientRequestToken:
                  DeleteItem tenant
                    CONDITION attribute_exists(PK) AND status = DELETING
                  UpdateItem cell: tenantCount = tenantCount - 1
                    CONDITION attribute_exists(PK) AND tenantCount > 0
                transaction cancellation → GetItem tenant:
                  missing → deletion already committed; end successfully
                  present → compare-and-set DELETING→DELETE_FAILED + reason; end
       create → compare-and-set CREATING→ACTIVE + lastBuildId
       update → compare-and-set UPDATING→ACTIVE + lastBuildId
     build failure or task timeout (Catch):
       compare-and-set tenant from the operation's in-flight status to
         tenantBuild.failedStatus + statusReason
3. Every terminal DynamoDB task retries transient failures. Retry exhaustion
   is caught and routed through the same conditional *_FAILED transition when
   the record still exists; an already-absent record means the terminal delete
   committed and the workflow ends successfully.
```

Design points:

- **Two shared CodeBuild projects** separate cell builds from tenant builds.
  Both use per-execution source and script overrides. Their roles,
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
- **Tenant scripts learn their cell via `CELL_ID`.** The contract between
  the shared cell deployment and its tenants is SSM (ADR-010): the **cell
  create script publishes** the cell's shared resource identifiers to
  `/application-plane/cells/<cellId>/<name>`; tenant scripts read that
  namespace (plus the global `/application-plane/shared/*`) at deploy time.
  The cell delete script cleans its namespace up. The control plane still
  carries no application-plane configuration.
- The tenant-delete terminal write is **transactional**
  (`aws-sdk:dynamodb:transactWriteItems` service integration) so the record
  removal and slot release cannot diverge. Replay safety does **not** rely on
  `ClientRequestToken` alone: DynamoDB's token window is finite. The tenant
  delete requires the tenant to exist in `DELETING`, and the decrement
  requires an existing cell with `tenantCount > 0`; after a committed delete,
  an identical transaction outside the token window cancels before changing
  the counter. The workflow reads the tenant after cancellation: absence
  proves the prior delete committed, while presence is a real failure. A
  stable token remains short-window protection for identical automatic
  retries. Placement uses the same stable-token discipline (§6).
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
  invariant violation (present becomes `DELETE_FAILED` with a reason).
- Each build Task has a catchable task-level timeout. The state-machine
  execution timeout is greater than the sum of both build-task budgets plus
  terminal-write recovery margin; it is a final safety net, not the normal
  timeout path. Terminal writes retry transient failures, and retry exhaustion
  is caught so records do not remain indefinitely in an in-flight state.
  `StartExecution` rejection is compensated as in §6.
- The **account role pair** (`CellAccountRoles`, installed per account) carries
  the asymmetry: `<fleet>-cell-provisioning` reads `/application-plane/shared/*`
  and gets/puts/deletes `/application-plane/cells/*`;
  `<fleet>-tenant-provisioning` reads `/application-plane/shared/*` and
  `/application-plane/cells/*`, and gets/puts/deletes
  `/application-plane/tenants/*` — all in that account. It cannot mutate
  cell-owned parameters. Each half trusts the control plane account narrowed by
  `aws:PrincipalArn` to the matching build role and the API role, and by
  `sts:ExternalId` when the owner set one. The pair is installed by the
  account owner (the control plane stack for its own account, the
  `CellAccountStack` elsewhere), so provisioning source remains trusted vendor
  code and the pair's policies remain the documented hardening point in each
  account.
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
// model/tenant.smithy
resource Tenant {
    identifiers: { tenantId: TenantId }
    create: CreateTenant      // POST /tenants → 202 (placement + tenant create build)
    read: GetTenant
    update: UpdateTenant      // PUT — metadata only, sync 200
    delete: DeleteTenant      // DELETE → 202 (tenant delete build, frees slot)
    list: ListTenants         // optional ?cellId= filter
    resources: [TenantResource]
}

// Embedded singleton — the tenant's deployment (state + effective definition)
resource TenantResource {
    identifiers: { tenantId: TenantId }
    read: GetResource         // GET /tenants/{tenantId}/resource
    update: UpdateResource    // PUT → 202 (tenant update build), no body
}

// model/cell.smithy
resource Cell {
    identifiers: { cellId: CellId }
    read: GetCell             // GET /cells/{cellId}
    update: UpdateCell        // PUT /cells/{cellId} → 202 (cell update build), no body
    delete: DeleteCell        // DELETE /cells/{cellId} → 202, empty cells only
    list: ListCells           // GET /cells[?accountId=]
    // no create — cells are created implicitly by tenant placement (ADR-013)
}

// model/account.smithy (ADR-024)
resource Account {
    identifiers: { accountId: AccountId }   // ^[0-9]{12}$
    put: PutAccount           // PUT /accounts/{accountId} → 200, verifies the handshake first (ADR-027, ADR-030)
    read: GetAccount          // GET /accounts/{accountId}
    delete: DeleteAccount     // DELETE /accounts/{accountId} → 200, empty accounts only
    list: ListAccounts        // GET /accounts
}

structure CreateTenantInput {
    @required name: String
    description: String
    @required adminEmail: String   // passed to the tenant create build as ADMIN_EMAIL
    accountId: AccountId           // pin to one registered account (ADR-024)
    @idempotencyToken clientToken: IdempotencyToken   // optional retry-safety (ADR-017)
    // no resource definition — the cell's stamped CellDefinition applies (ADR-012)
}

@error("client") @httpError(409)
structure InsufficientCapacityError { @required message: String }   // ADR-026

structure TenantSummary {
    @required tenantId: TenantId
    @references([{resource: Cell}])
    @required cellId: CellId
    // ...
}
```

`SourceDefinition` / `ScriptLocations` are shared shapes referenced by the
cell output structures. Authorizer wiring: `httpApiKeyAuth` token authorizer, `@authorizer` per operation,
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
│   ├── tenant.smithy              # Tenant + TenantResource (no per-tenant definition)
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
│   │   ├── service-config.ts      # ServiceConfig / CallerContext base
│   │   ├── data-model.ts          # DataModel<TSchema, TItem>
│   │   ├── repository.ts          # DynamoDBRepository + PlacementTransactions
│   │   ├── fleet.ts               # fleet role naming, role ARNs, STS session name
│   │   ├── ssm-namespaces.ts      # the §6.2 namespace grants for the role pair
│   │   └── key-builder.ts
│   └── tenant/
│       ├── tenant.ts              # service impl: placement, account + cell + tenant ops
│       ├── tenant.data-model.ts   # tenant item mapping (GSI-1/GSI-2 attributes)
│       ├── cell.data-model.ts     # cell item mapping (GSI-1 + GSI-2 by account)
│       ├── account.data-model.ts  # account item mapping, PutAccount update shape
│       ├── account.handshake.ts   # the PutAccount STS probe, positive and negative (ADR-027, ADR-030)
│       ├── idempotency.data-model.ts  # CreateTenant idempotency record (ADR-017)
│       ├── validation.ts          # synth-time input validation shared by both stacks
│       ├── tenant.function.ts     # API handler (pass-through)
│       ├── tenant.sfn.ts          # workflow: optional cell build phase, assume-role
│       │                          #   buildspec, transactional deletes, build roles
│       └── tenant.cdk.ts          # stack: API GW, Lambda (<fleet>-api role), DDB (PITR,
│                                  #   GSI-1/GSI-2), SFN, home account role pair
├── scripts/
│   ├── sample-cell/{create,update,delete}.sh    # demo shared deployment: publishes/
│   │                                            #   removes /application-plane/cells/<cellId>/*
│   ├── sample-tenant/{create,update,delete}.sh  # reads the cell namespace, writes
│   │                                            #   /application-plane/tenants/<tenantId>
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
| `cellDefinition.source` (`{type, location, sourceVersion?}`) | stamped onto new cell records; `sourceVersion` forwarded to CodeBuild as the supply-chain pin (ADR-020) |
| `cellDefinition.cellScripts` (`{create, update, delete}`) | shared cell deployment lifecycle |
| `cellDefinition.tenantScripts` (`{create, update, delete}`) | per-tenant deployment lifecycle |
| `cellDefinition.maxTenants` | cell capacity, stamped at cell creation (ADR-012) |
| `fleetName` (optional, default `control-plane`) | names the five fleet roles: `<fleet>-api`, `<fleet>-cell-build`, `<fleet>-tenant-build` in the control plane account and `<fleet>-cell-provisioning`, `<fleet>-tenant-provisioning` in every account that hosts cells (ADR-025, ADR-028); `[a-z0-9-]{1,32}` |
| `tenantBuildManagedPolicyArns` (optional) | customer-managed IAM policy ARNs attached to the tenant provisioning role of the stack's own account, in addition to its §7 SSM grants (ADR-022, ADR-025) |

Accounts are **not** a deployment input: they are registered through the API
(`PutAccount`) because a customer's account appears on demand (ADR-024). The
home account is registered the same way before the first onboard.

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
| `cellAccount.demoSharedParameters` (optional, default false) | publishes the demo `/application-plane/shared/base-domain` the sample cell script reads; off by default so a customer's account gets the two roles and nothing else |

Supplied via CDK context. Synthesis validates `maxTenants` as an integer of
at least one and requires non-empty source and script values; it warns (does
not fail) when `source.sourceVersion` is absent or not a full commit SHA
(ADR-020). When `tenantBuildManagedPolicyArns` is non-empty, synthesis fails if
any entry is not a managed-policy ARN in the stack's own partition and account,
or if the stack's account or Region is unresolved so that check cannot run
(ADR-022). Changing `cellDefinition` affects only cells created after the
change; existing cells keep their stamped definition.

## 11. Deployment Lessons

`externalModules: []` bundling, the `re2.wasm` commandHook, and an
extensible `CallerContext` for the SSDK handler.

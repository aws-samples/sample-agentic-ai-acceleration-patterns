# Specification: A Cell-Based Control Plane

> **Status:** This document is the *requirements and principles* layer of
> the control plane design: it states what a correct implementation must do
> and why, without prescribing every implementation detail. An implementer
> (human or LLM) should be able to build a functionally equivalent control
> plane from this spec alone. Where a requirement is a deliberate design
> position rather than an obvious necessity, the reasoning is given inline —
> the spec is also a teaching document.

The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

---

## 1. Problem Statement

Vendors of multi-tenant applications need a **control plane**: the management layer
that onboards tenants, provisions their infrastructure, tracks lifecycle
state, and offboards them. Most published control plane examples are either
toy CRUD APIs (no real provisioning) or sprawling platforms (dozens of
services obscuring the core ideas).

This spec defines a **control plane for cell-based
deployments** — small enough to read in a sitting, complete enough to be
correct under concurrency and failure.

### 1.1 The deployment model

A **cell** is the unit of deployment: one **shared application deployment**
plus up to `maxTenants` tenants, each with its **own per-tenant deployment**
inside the cell.

The cell model is a strict generalisation of the two classic isolation
models:

- `maxTenants = 1` → **silo**: every tenant gets a dedicated cell.
- `maxTenants = N` → **cell/pool hybrid**: N tenants share the cell's
  shared deployment, each with its own per-tenant slice.

What "shared deployment" and "per-tenant deployment" mean is entirely up to
the provisioning scripts (see §6) — a deployment is **anything the vendor
can script**: infrastructure provisioning, application bootstrapping,
configuration, data seeding, user setup, or any combination. The one
constraint is time: each script runs inside a build task with a bounded
time budget (R-23), so a deployment must complete within it. Any of these
is a valid instantiation:

| Scenario | Shared (cell) deployment | Per-tenant deployment |
|---|---|---|
| Dedicated resources per tenant | nothing (no-op) | full stack |
| Fully shared resources | full stack | nothing (no-op), or logical setup only |
| Shared infra, dedicated logical resources | database cluster, compute | database on the shared cluster, object store prefix |

"Nothing" is represented by **explicit, idempotent no-op scripts** — never
by omitting the scripts. Every lifecycle path must have a total contract
(see P-9).

Cells live in **accounts**. An account is an AWS account the control plane
may provision cells into. Operators register accounts at run time (§5.3),
each with a cell capacity (`maxCells`) and an **owner**:

- **Vendor-owned** accounts form the fleet. When no cell has a free slot,
  placement creates a new cell in the first vendor-owned account with free
  cell capacity. Registering a second vendor-owned account is how the fleet
  scales past one account's limits.
- **Tenant-owned** accounts belong to a customer. Placement never chooses
  them: a tenant lands there only when `CreateTenant` names the account.
  The customer installs the provisioning role pair (§6.4) in their own
  account, keeps every resource and all data there, and can revoke the
  control plane at any time by removing the roles. The control plane holds
  no customer credentials, only the account id.

The control plane's own account is just another account: register it as
vendor-owned to host cells there. Capacity is bounded at three levels:
tenants per cell (`maxTenants`), cells per account (`maxCells`), and the
accounts registered. When every eligible account is full, onboarding fails
with a modelled error (§5.5) rather than creating capacity nobody authorised.

| Scenario | How the model expresses it |
|---|---|
| One account, many cells | one vendor-owned account, `maxCells = N` |
| Scale to a second account in the Region | register a second vendor-owned account; placement spills over when the first is full |
| Deploy into a customer's account on demand | the customer installs the role pair; the operator registers the account as tenant-owned; `CreateTenant` names it |

### 1.2 What this control plane is NOT

The control plane manages *deployments of* the application plane; it never
becomes part of it. Out of scope, deliberately:

- Billing, metering, tenant tiers
- Cell rebalancing, tenant migration between cells or accounts
- Pre-provisioning capacity ahead of demand (auto-scaling the fleet)
- Creating AWS accounts (account vending) — an account exists before it is
  registered, and whoever owns it installs the role pair
- A Region per account — cells are provisioned in the control plane's
  Region; a per-account Region is a recorded seam (§11)
- **All application plane concerns — including customer identity.** Which
  IdP a tenant's users authenticate against is a property of the
  deployed application, owned by the provisioning scripts.

---

## 2. Guiding Principles

These principles generated every decision in the design. When this spec is
silent on a detail, resolve it by applying these principles — they are the
spec's extension mechanism.

### P-1. Minimalism is a correctness strategy, not an aesthetic

Every service boundary, entity, and workflow brings cross-cutting
machinery: auth between services, state propagation, discovery, partial
failure between the parts. A boundary that adds machinery without adding
capability does not belong in the design. Two applications of the principle
here:

- The tenant↔cell relationship is a single field, `tenant.cellId` — not a
  placement entity with its own lifecycle and API. An entity that would
  store nothing its neighbours don't, mirror their status, and pass through
  their operations is a field, not an entity.
- Cells, tenants, accounts, and the provisioning workflow live in **one
  service on one table**, so terminal workflow state is written directly —
  there is no cross-service auth, no status-propagation machinery, and no
  service discovery anywhere in the system.
- The account *is* an entity, by the same test: it holds the authoritative
  cell counter and the trust handshake, which no neighbour stores, and
  operators register it explicitly (P-10). Its lifecycle is synchronous —
  no build, no workflow — so it adds four operations on the same table and
  nothing else.

The result: **one service, one API, one table, one workflow, two build
projects, and one role pair per account.** An implementation of this spec
MUST NOT introduce additional services, tables, or workflows unless a
requirement below is unimplementable without them.

Corollary: when generality is speculative, leave it out and *record the
seam* (§11). For example, the `/tenants/{id}/resource` sub-path is the
extraction point should a standalone resource service ever be needed —
deferred generality is a documented evolution path, not live code.

### P-2. The model is the architecture

The API contract is defined first, in a machine-readable interface model
(Smithy in the reference implementation), and everything else — OpenAPI
spec, server SDK, API Gateway wiring — is *generated* from it. Nobody
hand-edits generated output; the model is fixed and regeneration follows.
This makes the contract the single point of change and keeps implementation
drift structurally impossible.

### P-3. Strict plane separation: the control plane carries no application plane configuration

The control plane knows *that* a tenant exists and *whether* its deployment
succeeded. It does not know *what* the deployment is. Consequences:

- Provisioning is delegated to vendor-supplied **lifecycle scripts** — the
  control plane runs them and records the outcome, nothing more.
- Shared resource identifiers flow from the cell to its tenants through an
  **out-of-band parameter namespace** (SSM Parameter Store) **in the cell's
  account**, written by cell scripts and read by tenant scripts *at deploy
  time*. The control plane is not involved in that exchange and never reads
  the namespace.
- Customer identity is an application plane decision.

The boundary test is *configuration vs. onboarding input*: `adminEmail`
(the first application-plane admin user) crosses the boundary exactly once,
as an environment variable to the create script, and is **never persisted**
by the control plane.

### P-4. Cells are homogeneous by construction

Every cell in the fleet is provisioned from the same **CellDefinition** —
a deployment-time configuration bundle (source + cell scripts + tenant
scripts + `maxTenants`) that is **stamped immutably onto each cell record at
creation**.

Why: placement only works if a tenant is placeable into *any* cell with free
capacity. Per-tenant provisioning definitions would break that fungibility.
So tenants carry **no source and no scripts** — their deployment is defined
by their cell's stamped definition.

Stamping makes configuration changes forward-only: a changed CellDefinition
affects only cells created afterwards; existing cells keep the definition
they were built with. New provisioning *code* still reaches existing cells
because git sources are fetched fresh on every build — the definition pins
*where the scripts live*, not their content.

Accounts are homogeneous the same way: every account — the control plane's
own included — installs the same role pair under the same names (§6.4), so
a cell is provisionable in any registered account by **one code path**.
There is no "local" special case; the home account is reached exactly like
a customer's.

### P-5. Correctness lives in conditional writes — reads only nominate

The single most important consistency principle in the design:

> **Indexes and reads nominate candidates; conditional writes on the
> authoritative record decide.**

- The placement candidate scan reads an eventually-consistent index; a stale
  read can nominate a full or deleting cell. That is fine, because the
  *claim* is a conditional write (`status = ACTIVE AND tenantCount <
  maxTenants`) on the base record that simply fails if the nomination was
  stale.
- Every lifecycle transition is a compare-and-set on the exact expected
  status. A read-time status check is **never** the concurrency guard; a
  failed compare-and-set maps to HTTP 409.
- **No write in the design is unconditional** — even fresh-ULID inserts are
  conditional on non-existence, and metadata/failure writes are conditional
  on existence so they cannot resurrect a concurrently deleted record as a
  ghost.

### P-6. Invariants are protected by atomicity at both ends of their lifetime

The core capacity invariant — *a claimed slot corresponds to exactly one
live tenant record* — is enforced transactionally at both boundaries:

- **Birth:** the slot claim (counter increment) and the tenant record are
  created in **one transaction**. A crash cannot leave a phantom slot with
  no tenant referencing it (a counter that could never be decremented would
  block cell deletion forever).
- **Death:** the tenant record deletion and the counter decrement happen in
  **one transaction** at the end of the delete workflow.

Exactly two code paths touch the counter, both transactional — *that* is
what makes it trustworthy. When you find an invariant in your own design,
count the code paths that can violate it and drive that number to the
minimum, each one atomic.

The same discipline applies one level up. The account's `cellCount` — *a
claimed cell slot corresponds to exactly one live cell record* — is claimed
in the transaction that creates the cell and released in the transaction
that deletes it. Two counters, two code paths each, all four transactional.

### P-7. Tolerate benign races; prevent corruption; document the difference

Not every race must be eliminated. The design explicitly classifies races
into two buckets:

- **Corruption** (wrong counter, orphaned records, double-claimed slots) —
  eliminated by P-5/P-6 mechanisms.
- **Over-provisioning** (two concurrent onboards each create a new cell;
  onboards arriving while the only cell is still creating spawn more cells)
  — *tolerated*, because eliminating them would require a fleet-wide lock
  for a rare, benign outcome.

An implementation MUST document its tolerated races and residual failure
windows explicitly (see §8.4). "We accept X because fixing it costs Y and
the impact is Z" is a design output, not an admission of defeat.

### P-8. Long-running mutations are asynchronous: 202 + transitional status + polling

Provisioning runs arbitrary infrastructure code and may take minutes to
hours; synchronous API gateways cap at ~29 seconds. Therefore:

- Every mutation that ends in a provisioning build returns **HTTP 202**
  after persisting a transitional status (`CREATING`/`UPDATING`/`DELETING`).
- A durable workflow engine — not a compute function waiting on the build:
  wait billing, invocation time caps, and crash-loss of the terminal
  transition all disqualify that — runs the build and writes terminal state.
- The read endpoint (`GetTenant`/`GetCell`) is the polling contract.
- **Transitional statuses double as the concurrency guard**: any mutation
  against an in-flight record is a 409. One mechanism serves two purposes.

### P-9. Total contracts: every lifecycle path exists, every failure is a modelled state with a remediation path

- Both script sets (cell + tenant) MUST define all three operations
  (create/update/delete). Empty deployments use explicit no-op scripts —
  never absent ones — so every lifecycle path is executable.
- Every failure lands in a modelled `*_FAILED` status with a
  `statusReason`, and every `*_FAILED` status has a documented operator
  action that leads out of it (retry the update; delete the tenant, then
  the cell). There are no dead-end states.
- Cleanup MUST always be reachable: tenant deletion is allowed from failed
  states *regardless of cell status*, because the delete script is the
  cleanup path even when the cell itself failed to create.

### P-10. Explicit over implicit for operator-facing decisions

- **Scale-out is implicit** (placement creates cells on demand — a
  mechanical decision with a clear trigger), but **scale-in is explicit**:
  an empty cell persists until an operator deletes it. Tearing
  down shared infrastructure as a side effect of the last tenant leaving
  would silently expand `DeleteTenant`'s blast radius.
- **Accounts are registered, never discovered.** Provisioning into an AWS
  account is the most consequential thing the control plane does, and into
  a customer's account most of all. An operator registers each account with
  its owner and capacity (`PutAccount`); cell creation *inside* a registered
  account stays implicit. The same asymmetry applies on the way out: an
  empty account persists until an operator deletes it.
- The trust model is stated, not implied: the design gates on
  authentication alone *because* the issuer is declared a dedicated
  operator-only trust boundary. A half-built role matrix that
  protects nothing is worse than an honest, documented assumption.

### P-11. Retry safety where retries actually happen

The dangerous retry is the client's: a network timeout after the placement
write commits leaves the client unsure whether onboarding happened, and the
natural reaction — retry — creates a duplicate tenant (and possibly a
duplicate cell). The design addresses this with an **optional client-supplied
idempotency token** whose detection record is written *in the same
transaction* as the placement itself — there is no
check-then-act window. Replays return the original result; token reuse with
different parameters is a 409.

Layered beneath it, infrastructure-level tokens (transaction client request
tokens) protect identical automatic SDK retries — but only within their
finite window. Beyond that window, safety comes from **item-state
conditions** (the delete requires the tenant to exist in `DELETING`; the
decrement requires `tenantCount > 0`), which remain correct forever. Choose
the mechanism that matches the retry's origin and time horizon.

### P-12. Least privilege expressed as role asymmetry

The provisioning scripts are the arbitrary-code surface of the system. The
blast radius is bounded not by reviewing script content but by the IAM
roles they run under — and the roles are deliberately **asymmetric**:

- The **cell provisioning role** may write the cell parameter namespace
  (`/application-plane/cells/*`).
- The **tenant provisioning role** may *read* that namespace but only
  *write* its own (`/application-plane/tenants/*`).

A compromised or buggy tenant script cannot corrupt cell-owned state. The
permission boundary — not throughput — is why there are two build projects
instead of one.

The pair lives **in the account that hosts the cell**, installed by that
account's owner (the vendor, or the customer for a tenant-owned account),
and is assumed by the matching build project before the script runs (§6.4).
The build projects' own roles hold no application-plane permission at all:
each may only assume its half of the pair. So the account owner — not the
control plane — decides what provisioning may do in their account, and can
withdraw it. These roles are THE hardening point of the whole design.

---

## 3. System Shape

### 3.1 Required components

| # | Component | Requirement |
|---|---|---|
| R-1 | **API layer** | One HTTP API, generated from the interface model (P-2), fronting one service. REST semantics, JSON protocol. |
| R-2 | **Authorizer** | Every operation MUST require a JWT from the vendor IdP (OIDC issuer URL + audience are deployment-time inputs), validated via the issuer's JWKS. There are no unauthenticated operations. |
| R-3 | **Service** | One stateless compute function implementing all operations, including synchronous placement and the account registry. |
| R-4 | **Store** | One database table holding all three entity types (account + cell + tenant) plus the idempotency record type, with support for multi-item ACID transactions and conditional writes. (The reference uses DynamoDB single-table design; any store with equivalent transactional conditional-write semantics qualifies.) |
| R-5 | **Workflow** | One durable state machine executing provisioning builds and writing terminal state directly to the table. |
| R-6 | **Build runners** | **Two** shared build projects (cell builds, tenant builds). Per-execution overrides select the source and script; the projects themselves are never mutated per tenant, cell, or account. Before the script runs, each build assumes its half of the hosting account's provisioning role pair (R-25), so the script executes with that account's permissions. The projects' own roles may only assume those roles, read the source, and write their logs. |
| R-25 | **Account role pair** | One deployable unit (reference: a CDK stack) that installs `<fleet>-cell-provisioning` and `<fleet>-tenant-provisioning` in an account with the asymmetric permissions of §6.2, trusting the control plane's two build roles and its API role (the registration probe, R-26) — and an optional external id. The account owner deploys it; the control plane stack installs the same pair in its own account so the home account needs no extra step (P-4). |

```
Vendor operator ──JWT──► API + Authorizer ──► Service (sync ops, placement,
                                                 │        account registry)
                                          202 async ops       ▲
                                                 ▼            │ terminal status
                                          Workflow ──► cell build │ tenant build
                                                        (shared projects)
                                                             │ AssumeRole
                                     ┌───────────────────────┴──────────────────────┐
                                     ▼                                              ▼
                        account A (vendor-owned)                    account B (tenant-owned)
                        <fleet>-cell-provisioning                   <fleet>-cell-provisioning
                        <fleet>-tenant-provisioning                 <fleet>-tenant-provisioning
                        /application-plane/* (SSM)                  /application-plane/* (SSM)
                        cells 1..maxCells                           cells 1..maxCells
```

Account A may be the control plane's own account. Nothing in the picture
changes when it is.

### 3.2 Caller and identity model

- Callers are **vendor operators** managing all tenants. Control plane data
  is NOT tenant-scoped by caller — tenants are the *subject* of the API,
  not the caller. (Application plane services built on top of this design
  would use the conventional caller-tenant-scoped context; this inversion
  is specific to control planes.)
- The authorizer MUST extract caller identity (subject, role claim) into an
  immutable caller context; the handler is a pass-through; the service
  never sees the raw request event. Static configuration (table names,
  ARNs) is initialised once at cold start, separate from per-request
  context.
- Authorization is authentication-only, under an explicit assumption that
  MUST be documented: the configured issuer is a dedicated control-plane
  trust boundary issuing tokens exclusively to fully privileged operators.
  The `role` claim is carried for audit and as the extension point — never
  fabricated, never currently enforced. Connecting any broader issuer
  REQUIRES adding an explicit per-operation role matrix first (P-10).

### 3.3 Deployment inputs

Supplied at deployment time, validated at synthesis/deploy.

**Control plane stack:**

| Input | Constraint |
|---|---|
| `vendorIdp.issuerUrl`, `vendorIdp.audience` | non-empty; OIDC discovery must work against the issuer |
| `cellDefinition.source` | `{type, location}` — a build-service source reference (e.g. GitHub repo, S3 bucket); non-empty |
| `cellDefinition.cellScripts` | `{create, update, delete}` — all three paths required, non-empty |
| `cellDefinition.tenantScripts` | `{create, update, delete}` — all three paths required, non-empty |
| `cellDefinition.maxTenants` | integer ≥ 1 |
| `fleetName` | names the role pair every account installs (`<fleetName>-cell-provisioning`, `<fleetName>-tenant-provisioning`) and the control plane's three roles the pair trusts (`<fleetName>-cell-build`, `<fleetName>-tenant-build`, `<fleetName>-api`); `[a-z0-9-]{1,32}`. Default `control-plane`. Two control planes in one account MUST use different fleet names |
| `tenantBuildManagedPolicyArns` (optional, [ADR-022](../adr/0022-attach-deployer-supplied-managed-policies-to-the-tenant-build-role.md)) | array of customer-managed IAM policy ARNs (`arn:<partition>:iam::<account>:policy/...`), each in the stack's own partition and account; synth MUST fail otherwise. Attached to the tenant provisioning role the stack installs in its own account. Default: none |

Changing `cellDefinition` after deployment MUST affect only cells created
afterwards (P-4). Accounts are NOT a deployment input: they are registered
through the API (§5.3), because a customer's account appears on demand, not
at deploy time (P-10, [ADR-024](../adr/0024-register-accounts-at-run-time-and-claim-cell-slots-atomically.md)).

**Account role pair** (deployed once per account by its owner,
[ADR-025](../adr/0025-provision-through-a-per-account-role-pair.md)):

| Input | Constraint |
|---|---|
| `controlPlaneAccountId` | the account the control plane stack runs in; 12 digits |
| `fleetName` | MUST equal the control plane's `fleetName` |
| `externalId` | `[\w+=,.@:/-]{2,1224}`, checked at synth; when set, the roles' trust policies require it and the operator supplies the same value at `PutAccount`. MUST be set for a tenant-owned account (`PutAccount` refuses `owner: TENANT` without one, §6.4); optional for a vendor-owned one |
| `tenantBuildManagedPolicyArns` (optional) | as above, in *this* account; attached to this account's tenant provisioning role |

`tenantBuildManagedPolicyArns` attaches each policy to a tenant provisioning
role in addition to the §6.2 grants. The control plane learns an ARN list,
never what the policies are for (P-3); the application plane that needs the
permission publishes the policy.

---

## 4. Data Model

One table, three public entity types plus one internal record type. All keys
shown as the reference implementation's convention; the requirement is the
*shape*, not the literal strings.

### 4.1 Cell

| Field | Requirement |
|---|---|
| `cellId` | generated, sortable unique id (ULID) — creation-ordered ids give listings chronological order for free |
| `accountId` | the account the cell is provisioned in — assigned at creation, **never changes** (migration is out of scope) |
| `status` | `CREATING \| ACTIVE \| UPDATING \| DELETING \| CREATE_FAILED \| UPDATE_FAILED \| DELETE_FAILED` |
| `maxTenants` | stamped from deployment config at creation; immutable |
| `tenantCount` | **the authoritative occupancy counter** — see R-20..R-22 |
| `source`, `cellScripts`, `tenantScripts` | stamped CellDefinition; immutable for the cell's lifetime |
| `lastBuildId` | most recent successful cell-scoped build id (nullable) |
| `statusReason` | populated on failure (nullable) |
| `createdAt`, `updatedAt` | timestamps |

Key: `PK=CELL#<cellId>`, `SK=META`.

### 4.2 Tenant

| Field | Requirement |
|---|---|
| `tenantId` | generated ULID |
| `name` | required; NOT unique (uniqueness is deliberately not a tenant-name property) |
| `description` | optional |
| `cellId` | the placement — assigned at onboarding, **never changes** (migration is out of scope) |
| `status` | same enum as cell |
| `lastBuildId`, `statusReason`, timestamps | as for cell |

Key: `PK=TENANT#<tenantId>`, `SK=META`.

**R-7:** The tenant record MUST NOT carry provisioning source or scripts
(P-4). Its effective definition is resolved from its cell.

**R-8:** `adminEmail` MUST NOT be persisted on any record (P-3). It survives
only in workflow execution history and build logs, which suffice for audit.

### 4.3 Account

| Field | Requirement |
|---|---|
| `accountId` | the AWS account id, 12 digits — the item's identity; supplied by the operator, never generated |
| `owner` | `VENDOR \| TENANT` — set at registration, **immutable**: it decides whether placement may choose the account (§7), and flipping it under live cells would silently change who those cells belong to |
| `maxCells` | cell capacity; integer ≥ 1; replaceable. Lowering it below `cellCount` is allowed and simply stops new cells there (R-24) |
| `cellCount` | **the authoritative cell counter** — claimed in the cell-creating transaction, released in the cell-deleting one (P-6); never written by `PutAccount` |
| `externalId` | required for `TENANT`, optional for `VENDOR` (§6.4); sent on every AssumeRole into this account. Not a secret, but never logged |
| `createdAt`, `updatedAt` | timestamps |

Key: `PK=ACCOUNT#<accountId>`, `SK=META`.

An account has **no status**: its operations are synchronous and run no
build, so there is nothing transitional to guard. Its lifecycle is register
(`PutAccount`) → in use → delete (empty only).

**R-24 (field ownership on accounts):** `PutAccount` MUST write only the
policy fields it owns (`owner` on first write, `maxCells`, `externalId`,
`updatedAt`) and MUST NOT touch `cellCount`; the two counter paths MUST NOT
touch the policy fields. `updatedAt` is the one attribute both paths write;
it is a timestamp, so last-writer-wins there loses nothing. A capacity cut
and a concurrent claim then compose
without a lost update: the claim's condition `cellCount < maxCells`
evaluates against whichever `maxCells` landed first.

### 4.4 Idempotency record (internal)

Written only when `CreateTenant` carries a `clientToken`, and only as an
additional item inside the placement transaction — never as a separate
write (P-11).

| Field | Requirement |
|---|---|
| `clientToken` | caller-supplied, 1–64 chars — the item's identity (`PK=IDEMPOTENCY#<token>`) |
| `tenantId` | the tenant the original request onboarded |
| `requestHash` | hash (e.g. SHA-256) of the request parameters — reuse with different input is a 409 |
| `expiresAt` | TTL, ≥ 24h. TTL deletion is lazy, so replay handling MUST ignore `expiresAt` and treat any surviving record as authoritative — the honoured window is "*at least* 24 hours". |

The record is never listed, never returned, and carries no index attributes.
`DeleteTenant` MUST NOT clean it up: a replayed create after a delete is a
409 pointing at the deleted tenant, not a silent re-onboard — the safer
semantics for an operator API.

### 4.5 Listing indexes

Five listing patterns require secondary indexes (reference: two GSIs; the
first serves three partition shapes, the second two):

| Pattern | Index shape |
|---|---|
| List all cells / placement candidate scan | static partition (`CELL`) → `CELL#<cellId>` |
| List tenants of one cell | `CELL#<cellId>` → `TENANT#<tenantId>` |
| List all accounts / placement account scan | static partition (`ACCOUNT`) → `ACCOUNT#<accountId>` |
| List all tenants | static partition (`TENANT`) → `TENANT#<tenantId>`, sparse (cells and accounts absent) |
| List cells of one account / targeted candidate scan | `ACCOUNT#<accountId>` → `CELL#<cellId>` |

**R-9:** Indexes MUST be treated as eventually consistent and **never
authoritative** (P-5). `tenantCount` on the cell record and `cellCount` on
the account record — not index counts — are the occupancy guards.

**R-10:** Every list query MUST be pinned to a server-side partition. The
partition value is either a static constant (`CELL`, `TENANT`, `ACCOUNT`)
or a validated resource identifier the request names explicitly
(`cellId`, `accountId`), prefixed by the service; it is never taken from
the pagination token. This is what makes unsigned pagination tokens safe:
a forged token can only reposition the caller *within* the partition the
request already named; it can never widen the result set. Preserve this
invariant — reintroducing an unpinned scan, or letting a token select the
partition, reopens the token-signing question.

Static partitions are an accepted trade-off at sample fleet
sizes; a production fleet would shard them. Full-attribute projections
(single-query listings, no follow-up reads) are the same trade — trim to
included attributes at scale.

---

## 5. API Surface

Fifteen operations. Conventions: lowercase plural collection paths,
kebab-case segments, singleton sub-resource singular. Sync operations
return 200; async (build-triggering) operations return 202 (P-8).

### 5.1 Tenant operations

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `CreateTenant` | `POST /tenants` | **202** | Input `{name, description?, adminEmail, accountId?, clientToken?}` — **no resource definition** (P-4). `accountId` pins the tenant to one registered account (the only way into a tenant-owned account); absent, placement chooses among vendor-owned accounts. Runs placement (§7), starts the workflow, returns the tenant including `cellId`. 404 for an unregistered `accountId`; 409 `InsufficientCapacityError` when no eligible account has capacity. |
| `GetTenant` | `GET /tenants/{tenantId}` | 200 | The polling endpoint: `status`, `statusReason`, `lastBuildId`, `cellId`. 404 if missing. |
| `UpdateTenant` | `PUT /tenants/{tenantId}` | 200 | Metadata only (`name`, `description`). Synchronous, no build, no state guard — but see R-21 (field ownership). 404 if missing. |
| `DeleteTenant` | `DELETE /tenants/{tenantId}` | **202** | 409 if in-flight. Allowed from `ACTIVE` and all `*_FAILED` states **regardless of cell status** — cleanup must always be reachable (P-9). Runs the tenant delete script; on success the workflow removes the record and releases the slot in one transaction. |
| `ListTenants` | `GET /tenants[?cellId=]` | 200 | Paginated. An unknown `cellId` filter yields an **empty page, not a 404** — a filter is a query predicate, not a resource lookup. |
| `GetResource` | `GET /tenants/{tenantId}/resource` | 200 | The tenant deployment's *effective* definition (resolved from the cell's stamped definition), its `cellId` and `accountId`, plus build state. This sub-path is the documented extraction seam if a standalone resource service is ever needed (P-1). |
| `UpdateResource` | `PUT /tenants/{tenantId}/resource` | **202** | Re-apply the tenant deployment: **no body** — runs the stamped tenant update script. Requires tenant `ACTIVE`/`UPDATE_FAILED` **and** cell `ACTIVE`; 409 otherwise. |

### 5.2 Cell operations

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `ListCells` | `GET /cells[?accountId=]` | 200 | Fleet topology: `accountId`, `status`, `tenantCount`/`maxTenants` per cell — the operator's capacity view. Paginated. An unknown `accountId` filter yields an **empty page, not a 404** (same rule as `ListTenants?cellId=`). |
| `GetCell` | `GET /cells/{cellId}` | 200 | Full record including `accountId` and the stamped definition. |
| `UpdateCell` | `PUT /cells/{cellId}` | **202** | Re-apply the shared deployment: no body, runs the stamped cell update script. Allowed from `ACTIVE`/`UPDATE_FAILED`. **409 from `CREATE_FAILED`** — running the *update* script against a half-created deployment breaks the create/update script contract; remediation for a failed cell create is tenant delete + cell delete. |
| `DeleteCell` | `DELETE /cells/{cellId}` | **202** | **Empty cells only** (P-10): the `DELETING` transition MUST be a single conditional write (`status ∈ {ACTIVE, *_FAILED} AND tenantCount = 0`) — the emptiness check and the transition are one atomic write, the counterpart of the placement claim. A read-then-write would let a concurrent placement claim a slot before `DELETING` lands. Condition failure → 409. On success the workflow removes the record and releases the account's cell slot in one transaction (§8.2). |

**R-11:** There MUST be no `POST /cells`. Cell creation is exclusively a
placement outcome (§7). An operator API for pre-provisioning capacity is a
noted extension, not part of this spec.

### 5.3 Account operations

All synchronous: no account operation runs a build (P-1).

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `PutAccount` | `PUT /accounts/{accountId}` | 200 | Create-or-replace. Input `{owner, maxCells, externalId?}`; `externalId` MUST be present when `owner` is `TENANT` (400 otherwise, §6.4). Before writing, the service MUST verify the handshake by assuming both roles of the account's pair with the given `externalId` and, when one is given, proving each role refuses the call without it (R-26); failure → 400 naming the role and the reason. On an existing account `owner` MUST match (409 otherwise); `maxCells` and `externalId` are replaced; `cellCount` is untouched (R-24). The write is conditional (`attribute_not_exists` on create; `owner = :owner` on replace). |
| `GetAccount` | `GET /accounts/{accountId}` | 200 | The record: `owner`, `cellCount`/`maxCells`, whether an `externalId` is set (never its value). 404 if unregistered. |
| `ListAccounts` | `GET /accounts` | 200 | Paginated capacity view: `owner`, `cellCount`/`maxCells` per account. |
| `DeleteAccount` | `DELETE /accounts/{accountId}` | 200 | **Empty accounts only** (P-10): a single conditional delete (`attribute_exists AND cellCount = 0`), the counterpart of the cell-slot claim; condition failure → 409. A deleted account's roles stay installed — removing them is the owner's act, not the control plane's. |

**R-26 (handshake at registration, [ADR-027](../adr/0027-verify-the-account-handshake-at-registration.md), [ADR-030](../adr/0030-prove-the-pair-enforces-the-external-id.md)):** `PutAccount` MUST fail closed when
either role of the pair cannot be assumed with the supplied `externalId`,
and — when an `externalId` is supplied — when either role CAN be assumed
without it (the pair does not enforce the id). Registration is the moment
the operator is present and can act on the error; the first build is not.
The check is a probe only — no API call is made under the assumed
credentials, and nothing is written in the account. A probe STS could not
answer (throttling, a network fault) is a 500 asking for a retry, not a
refusal: the pair may be fine.

### 5.4 Status state machine (cells and tenants)

```
            create                     update
  (none) ──────────► CREATING ──ok──► ACTIVE ◄──ok── UPDATING
                        │fail            │  ▲            │fail
                        ▼                │  └────────────┴──► UPDATE_FAILED ──► (update/delete)
                  CREATE_FAILED          │ delete (empty only, for cells)
                        │delete          ▼
                        └──────────► DELETING ──ok──► (record deleted)
                                        │fail
                                        ▼
                                  DELETE_FAILED ──► (delete retry)
```

**R-12:** Every transition into a transitional status (`CREATING`,
`UPDATING`, `DELETING`) MUST be one conditional write (or transaction
member) checking the exact expected/accepted status set (P-5). A failed
compare-and-set maps to 409.

**R-13 — cross-entity guards:**
- Placement requires the cell `ACTIVE` — the single condition that closes
  the place-into-deleting-cell race.
- `UpdateResource` requires the cell `ACTIVE` — no tenant builds against a
  shared deployment mid-change.
- `DeleteTenant` is exempt from cell-status guards (P-9).
- The build guards are one-directional and this is a **documented tolerated
  race** (P-7): a cell build and tenant build can overlap when their
  accepts race. An overlap can fail a build (surfacing as `*_FAILED` on the
  normal retry path) but never corrupts control plane state. Closing it
  would need an in-flight-build counter with the same conditional-claim
  discipline as placement — accepted instead.

### 5.5 Error model

| Error | HTTP | Triggers |
|---|---|---|
| `ValidationException` | 400 | malformed input, malformed pagination token; `PutAccount` handshake refusal (R-26: a half could not be assumed, or admits the call without the supplied external id) |
| `UnauthorizedError` | 401/403 | missing/invalid JWT |
| `ResourceNotFoundError` | 404 | unknown tenant, cell, or account (including an unregistered `CreateTenant.accountId`) |
| `ConflictError` | 409 | in-flight mutation; occupied-cell delete; occupied-account delete; `owner` change on `PutAccount`; cell-not-ACTIVE guard; `clientToken` reuse with different parameters; `CreateTenant` lost every bounded claim against cells with free capacity and no account had a free cell slot — retry ([ADR-031](../adr/0031-lost-placement-races-on-a-full-fleet-are-a-retryable-conflict.md)) |
| `InsufficientCapacityError` | 409 | `CreateTenant` found no eligible cell and no eligible account with cell capacity: every vendor-owned account is full (untargeted), or the named account is full (targeted). Nothing was written. The remedy is an operator act — raise `maxCells` or register an account — so the error is distinct from `ConflictError`, which a client may simply retry later ([ADR-026](../adr/0026-fleet-full-is-a-modelled-error.md)) |
| `InternalServerError` | 500 | everything else, including a `PutAccount` whose handshake probe STS could not answer (throttling, network): the handshake is unknown, not refused, and the operator retries |

**R-14:** Repository condition failures MUST be classified, not blanket-500d:
a stale lifecycle transition → 409; a metadata write that loses a
concurrent delete → 404.

---

## 6. Provisioning Contract (Scripts)

Provisioning is delegated to vendor-supplied lifecycle scripts, executed in
the build runners with per-execution source and script overrides. The
control plane's entire contract with them:

### 6.1 Environment contract

| Variable | Cell scripts | Tenant scripts |
|---|---|---|
| `CELL_ID` | ✓ | ✓ |
| `CELL_ACCOUNT_ID` | ✓ | ✓ (the account the cell lives in — the account the script is already running in, for scripts that need to name it) |
| `TENANT_ID` | — | ✓ |
| `TENANT_NAME` | — | ✓ every operation; the tenant's `name` as stored on the Tenant record ([ADR-023](../adr/0023-pass-the-tenant-name-to-tenant-scripts.md)) |
| `OPERATION` | `create\|update\|delete` | `create\|update\|delete` |
| `ADMIN_EMAIL` | — | create only (empty string otherwise) |
| `OPERATOR_ID` | ✓ | ✓ (the verified operator identity, [ADR-019](../adr/0019-operator-identity-end-to-end.md)) |

That's it. No application plane configuration is injected (P-3). `TENANT_NAME`
passes the same boundary test as `ADMIN_EMAIL` (ADR-004): onboarding input the
control plane already holds, not application-plane configuration. If a
future variant wants opaque per-tenant configuration, the extension point
is a generic `parameters: map<string,string>` passed through as environment
variables — deliberately generic, never shaped like any specific concern.

**Credentials.** A script's environment never carries the build project's
own role: before the script starts, the build runner assumes the hosting
account's provisioning role (cell or tenant half, matching the project),
exports the resulting credentials as the standard AWS environment
variables, and unsets the container credential variables through which the
build role could be fetched (the residual — the build agent process still
holds that endpoint — is threat T29). The
script therefore runs *in* the cell's account with exactly the permissions
that account's owner installed (§6.4) — the same way whether the account is
the control plane's own or a customer's (P-4).

### 6.2 Parameter namespace contract (P-3)

All three namespaces live **in the cell's account**. Each account's
application plane is its own; a cell never reads another account's
parameters.

| Namespace | Cell role | Tenant role | Written by |
|---|---|---|---|
| `/application-plane/shared/*` | read | read | shared infrastructure in that account, out of band |
| `/application-plane/cells/<cellId>/*` | read + **write/delete** | read | the **cell create script** publishes the cell's shared resource identifiers here; the cell delete script cleans them up |
| `/application-plane/tenants/<tenantId>/*` | — | read + **write/delete** | tenant scripts own their state here |

Tenant scripts learn their cell via `CELL_ID` and resolve shared resources
from the cell namespace **at deploy time**. Deploy-time resolution means
shared resource changes take effect on the next build with no control plane
change and no record mutation. A missing required parameter fails the
script fast → `*_FAILED` with the parameter named in `statusReason`.

### 6.3 Script requirements

**R-15:** Scripts MUST be idempotent and safe to re-run after partial
completion — the workflow's retry paths (`UpdateCell` after
`UPDATE_FAILED`, `DeleteTenant` retry after `DELETE_FAILED`) re-execute
them. Empty deployments are explicit no-op scripts (P-9).

The scripts are trusted vendor code; the provisioning role policies (§6.2,
§6.4, P-12) are the documented hardening point that bounds what they can do
in each account. Any `tenantBuildManagedPolicyArns` (§3.3, ADR-022) widen an
account's tenant provisioning role by exactly what that account's owner
attaches, so they are part of that bound — and a customer attaches them to
their own account, the vendor never does.

**R-27 (credential budget):** a script's credentials come from role
chaining (build role → provisioning role), which AWS caps at **one hour**
and which cannot be extended by the role's own maximum session duration.
The build task budget (R-23) MUST NOT exceed that hour, so a script that
outlives its budget is stopped by the task timeout, not by expired
credentials mid-write. Longer deployments split into idempotent steps the
update script can resume (R-15).

### 6.4 Account role pair contract (P-12)

The unit an account owner installs, once per account
([ADR-025](../adr/0025-provision-through-a-per-account-role-pair.md)):

| Role | Trusted principals | Permissions |
|---|---|---|
| `<fleet>-cell-provisioning` | the control plane's **cell build role** (`arn:…:iam::<controlPlaneAccountId>:role/<fleet>-cell-build`) and its **API role** (`…:role/<fleet>-api`, for the registration probe, R-26) | the cell-role column of §6.2 |
| `<fleet>-tenant-provisioning` | the control plane's **tenant build role** (`…:role/<fleet>-tenant-build`) and its **API role** | the tenant-role column of §6.2, plus any `tenantBuildManagedPolicyArns` |

The trust is expressed as the control plane account plus an
`aws:PrincipalArn` condition naming those roles, so the pair can be installed
before the control plane exists and survives the control plane's roles being
recreated.

Both trust policies require `sts:ExternalId` to equal the configured
`externalId` when one is set. The control plane presents it on every
AssumeRole into that account; without it the assume MUST be refused by the
trust policy. This is the standard guard against the confused deputy: a
third party who learns a customer's role ARN cannot have the control plane
act in that account by registering it, because they do not hold the
customer's external id. A tenant-owned account MUST have one: `PutAccount`
rejects `owner: TENANT` without `externalId` (400) before the handshake
probe
([ADR-029](../adr/0029-require-an-external-id-for-tenant-owned-accounts.md)),
and the probe MUST prove the pair *enforces* a supplied id — STS accepts an
`ExternalId` against a trust policy that never conditions on it, so the
probe assumes each half once more without the id and treats a success as a
refusal
([ADR-030](../adr/0030-prove-the-pair-enforces-the-external-id.md)). A pair
installed without an id is therefore caught at registration whenever an id
is supplied, and `externalIdConfigured` is true only when the pair requires
it. Vendor-owned accounts sit inside the vendor's own trust, where the
`aws:PrincipalArn` condition already names the only callers, and MAY omit
it. The external id gates registration only: once stored, every operator's
`CreateTenant` into that account presents it, and it reaches the build as a
plaintext environment override (N-10). The wall against cross-account
reach is the trust policy's principal pin plus the build's credential
scoping (§6.1, "Credentials"); the external id is the consent check on top.

The build roles' AssumeRole permission names the role *by name across all
accounts* (`arn:…:iam::*:role/<fleet>-cell-provisioning`), because the
accounts are not known at deploy time. That is deliberate and safe: the
role's **trust policy** is the gate, and only the account owner writes it.
The control plane can act in an account only after its owner installed the
pair and an operator registered it — both explicit (P-10). The AssumeRole
session name is the verified operator id (ADR-019), so the account owner's
CloudTrail attributes every provisioning call to the operator who caused it.

The pair is the whole handshake. There is no secret exchanged, no
credential stored, and revocation is one act by the owner (delete the
pair): the next build in that account fails into `*_FAILED` with the
refusal in `statusReason`, and every record stays consistent.

---

## 7. Placement (the heart of the design)

Placement happens **synchronously inside `CreateTenant`**, before the
workflow starts. It embodies P-5, P-6, P-7, and P-11 simultaneously.

### 7.1 Algorithm

```
0. TARGET    — accountId given:
                 read the account record; missing → 404.
                 eligible accounts = [that account] (any owner).
                 candidate cells   = that account's cells (the
                                     ACCOUNT#<id> → CELL# index).
               accountId absent:
                 eligible accounts = registered accounts with
                                     owner = VENDOR, oldest registered first.
                 candidate cells   = all cells (the CELL index) whose
                                     accountId is in that set.
               Tenant-owned accounts are never eligible without a target.
1. NOMINATE  — filter candidate cells: status=ACTIVE AND
               tenantCount < maxTenants; order oldest first.
2. CLAIM     — for each candidate (bounded: at most 5 attempts), one
               transaction:
                 • cell:   tenantCount += 1
                           IF status = ACTIVE AND tenantCount < maxTenants
                 • tenant: insert {status: CREATING, cellId: <candidate>}
                           IF not exists
                 • [idempotency record: insert IF not exists — only when
                    clientToken supplied; always the LAST item so its
                    cancellation index is fixed]
               outcomes:
                 success                       → placed; start workflow
                 idempotency condition failed  → REPLAY (see 7.3) — takes
                                                 precedence over every
                                                 other classification
                 capacity/status cond. failed  → lost a race; next candidate
                 anything else / ambiguous     → FAIL the request; never
                                                 retarget the same tenant
                                                 after an ambiguous
                                                 transaction outcome
3. CREATE    — no candidate claimed (none found, or budget exhausted):
               for each eligible account in order, one transaction:
                 • account: cellCount += 1
                            IF exists AND cellCount < maxCells
                 • cell:    insert {status: CREATING, accountId: <account>,
                            tenantCount: 1 (slot PRE-CLAIMED), definition
                            stamped from deployment config} IF not exists
                 • tenant:  insert {status: CREATING, cellId: <new>}
                            IF not exists
                 • [idempotency record as above — still the LAST item]
               outcomes:
                 success                        → placed; start workflow
                 idempotency condition failed   → REPLAY (7.3)
                 account condition failed       → account full (or deleted
                                                  meanwhile); next account
                 anything else / ambiguous      → FAIL the request
               every eligible account refused   → 409 InsufficientCapacity
                                                  (nothing was written)
```

The account claim nominates from the account listing index and decides on
the base record, exactly as the cell claim does (P-5): a stale read may
nominate a full account; the condition rejects it. Reading
`ListAccounts`-style data to skip obviously full accounts is an
optimisation an implementation MAY add; it is never the guard.

**R-16 (nomination vs decision):** step 1's read is an optimisation, never
a guard. Correctness lives entirely in step 2's conditions. Do NOT
"simplify" the claim into a plain write (P-5).

**R-17 (atomic birth):** the claim and the tenant record MUST be created in
one transaction; the new-cell path MUST pre-claim the tenant slot in the
same insert **and** claim the account's cell slot in the same transaction
(P-6). A cell record never exists without its account slot held.

**R-18 (bounded work):** the candidate loop MUST be bounded so `CreateTenant`
stays inside the synchronous gateway window. The miss case — every attempt
loses a race while capacity exists elsewhere — falls through to new-cell
creation: over-provisioning rather than a failed onboard (P-7). When that
fall-through meets a full fleet, the request MUST fail with a retryable
`ConflictError`, not `InsufficientCapacityError`: capacity exists, the
request did not win it, and a retry will
([ADR-031](../adr/0031-lost-placement-races-on-a-full-fleet-are-a-retryable-conflict.md)).
The account loop is bounded by the number of eligible accounts, which is
operator-controlled and small.

**R-28 (fleet full is terminal for the request):** when every eligible
account refuses the claim, `CreateTenant` MUST fail with
`InsufficientCapacityError` and MUST NOT create an account, widen a limit,
or place into an ineligible account. Capacity is an operator decision
(P-10); the control plane reports that it ran out.

### 7.2 Tolerated races (MUST be documented, MAY remain open)

- Two concurrent no-capacity onboards both create a cell → one extra cell,
  **bounded by `maxCells`**: the account claim turns unbounded
  over-provisioning into at most `maxCells` cells per account.
- Onboards while the only cell is `CREATING` create further cells
  (placement requires `ACTIVE`), again up to `maxCells`.
- Two onboards racing for an account's last cell slot: one claims, the
  other moves to the next eligible account or gets the 409. No corruption.
- Five consecutive lost claims against cells with room, on a fleet with no
  free cell slot: the request fails with `ConflictError` and nothing is
  written; the client retries and almost certainly places (R-18, ADR-031).
- Oldest-first ordering funnels concurrent claims at the same candidate —
  one cancelled transaction per contended cell before spreading. At
  production scale, randomise candidate order or use power-of-two-choices.
- A cell stuck `UPDATE_FAILED` removes its remaining capacity from the
  fleet until an operator re-runs `UpdateCell`; onboards meanwhile fill
  other cells or create new ones. Visible in `ListCells`.

All over-provision; none corrupts (P-7).

### 7.3 Idempotent replay (P-11)

On a cancelled idempotency condition: read the record and

- request hash matches → return the **original tenant**, whatever its
  current lifecycle status (200-shaped 202 response semantics: same
  outcome as the original call);
- hash differs, or the tenant was since deleted, or the record vanished in
  the TTL race between transaction and read → **409**.

### 7.4 Compensation and the residual gap

**R-19:** if starting the workflow fails *after* the placement transaction,
the service MUST conditionally compensate the exact in-flight state:
existing-cell placement → tenant `CREATING → CREATE_FAILED`; new-cell
placement → **both** records to `CREATE_FAILED` in one transaction (never
leave only one record recoverable). Both land on the documented remediation
path. The account's cell slot stays claimed by the `CREATE_FAILED` cell —
exactly as a `CREATE_FAILED` tenant keeps its tenant slot — and is released
by `DeleteCell` on the remediation path. Compensation never touches a
counter.

**Residual tolerated failure (document it):** a process crash *between* the
placement transaction and workflow start strands the records in `CREATING`
with no workflow running. The transaction guarantees they are mutually
consistent (no phantom slot), but recovery is manual. A production control
plane adds a sweep for aged transitional records; this spec notes it and
deliberately omits it (P-1).

---

## 8. Provisioning Workflow

One durable state machine. Composition over proliferation: `cellBuild` and
`tenantBuild` phases are each optional, and the combination encodes every
operation shape:

| Trigger | cellBuild | tenantBuild |
|---|---|---|
| `CreateTenant` into an existing cell | — | create |
| `CreateTenant` requiring a new cell | create | create |
| `UpdateResource` | — | update |
| `DeleteTenant` | — | delete |
| `UpdateCell` | update | — |
| `DeleteCell` | delete | — |

### 8.1 Resolved input

**R-20:** the service MUST resolve everything the workflow needs — source,
script paths, failure statuses, ids, the cell's `accountId`, the two
provisioning role ARNs derived from it, and the account's `externalId` —
into the execution input. The workflow MUST NOT re-read mutable records to
decide what to do. Why: a
mid-workflow read of a record that a concurrent operation is mutating
reintroduces exactly the races the conditional writes eliminated, and each
read adds a missing-item failure branch. The execution input is an
immutable snapshot of the decision, taken at accept time. (Execution
history then contains the resolved source/script path — acceptable for
operator-visible control plane data.)

**R-21 (field ownership):** after initial creation, the service and the
workflow MUST update records with expressions touching only the fields each
operation owns — never whole-item overwrites. Metadata edits cannot revert
status or erase `lastBuildId`; lifecycle transitions cannot restore stale
metadata.

### 8.2 Terminal writes

- **create/update success** → compare-and-set in-flight → `ACTIVE` +
  `lastBuildId`.
- **tenant delete success** → **one transaction**: delete the tenant
  (condition: exists AND status = `DELETING`) + decrement the cell counter
  (condition: exists AND `tenantCount > 0`) (P-6). After a committed
  delete, an identical replayed transaction cancels on those conditions
  before changing the counter; the workflow then reads the tenant —
  **absence proves the prior delete committed (success)**, presence is a
  real failure (`DELETE_FAILED`). Item-state conditions, not token windows,
  are the durable replay guard (P-11).
- **cell delete success** → **one transaction**: delete the cell
  (condition: exists AND status = `DELETING` AND `tenantCount = 0`) +
  decrement the account's `cellCount` (condition: exists AND
  `cellCount > 0`) (P-6) — the mirror of the tenant delete one level up.
  Same absence-is-success read on cancellation: a missing cell proves the
  prior transaction committed; a present cell becomes `DELETE_FAILED`. The
  account record always exists here, because `DeleteAccount` refuses while
  `cellCount > 0`.
- **build start** → every build task first assumes the resolved
  provisioning role (with the resolved `externalId`, session name =
  `OPERATOR_ID`) and runs the script under those credentials (§6.1). A
  refused AssumeRole is a build failure like any other: it lands in the
  operation's `*_FAILED` status with the refusal in `statusReason` — which
  is what a customer revoking the pair looks like from the control plane.
- **build failure / task timeout** → compare-and-set from the operation's
  in-flight status to the resolved `*_FAILED` status + `statusReason`. For
  a failed **cell create with a pending tenant create**, one transaction
  moves *both* records to `CREATE_FAILED` (the tenant's reason: "cell
  provisioning failed").

**R-22:** every terminal write retries transient failures; retry exhaustion
is caught and routed through the same conditional `*_FAILED` transition when
the record still exists. This shrinks — but does not eliminate — the
stranding window, because the failure write is itself a write that can
exhaust retries (documented residual, §7.4).

**R-23 (timeouts):** each build task MUST have a catchable task-level
timeout routed to the failure path. The execution-level timeout MUST exceed
the sum of both build budgets plus terminal-write margin — it is a final
safety net, never the normal timeout path (a tripped execution timeout
bypasses the Catch and strands records).

---

## 9. Non-Functional Requirements

| # | Requirement | Rationale |
|---|---|---|
| N-1 | Authorizer result caching MUST use a short, explicit TTL (reference: 60s, not the platform's implicit default). | The cached policy covers the whole API per token; the TTL bounds how long a revoked token retains access. A deliberate trade of cache hit rate for a tighter revocation window. |
| N-2 | The API stage MUST be throttled (reference: 20 rps / 40 burst). | Operations that start builds make a leaked token a **cost-amplification vector**; cap the rate explicitly. |
| N-3 | The table MUST have point-in-time recovery. Sample uses `DESTROY` removal for cleanup; a real control plane RETAINS its tenant registry. | The tenant registry is the system of record. |
| N-4 | Provisioning roles scoped to the parameter namespaces of §6.2, in every account — widen deliberately, per provisioning need, by the account owner. | P-12: this is THE hardening point. |
| N-5 | Pagination tokens are unsigned (see R-10 for the invariant that makes this safe). | No signing key to provision/rotate — material simplification, valid only while R-10 holds. |
| N-6 | Private script sources need source-credential configuration on the build projects (project-level, not per-tenant). | Accepted trade-off: per-tenant source credentials would require per-tenant build infrastructure. |
| N-7 | The build task budget (R-23) MUST NOT exceed one hour. | Role chaining caps the script's credentials at one hour (R-27); a longer budget would let scripts fail on expired credentials instead of on the timeout. |
| N-8 | The build roles' AssumeRole resource is the provisioning role **by fixed name in any account**; the control plane never maps account ids into IAM policy. | Accounts are registered at run time (P-10); the target role's trust policy — written by the account owner — is the gate, and `externalId` closes the confused deputy. Enumerating accounts in IAM would make registration a deployment, defeating on-demand customer accounts. |
| N-9 | `PutAccount` probes both roles before writing (R-26); the probe makes no call under the assumed credentials. | Fail at registration, when the operator is present, not at the first build; and never touch the account during a check. |
| N-10 | `externalId` is never returned by the API and never logged by the sample. It reaches the build as a plaintext CodeBuild environment-variable override carried in the Step Functions execution input, readable by principals with `states:DescribeExecution` or `codebuild:BatchGetBuilds` in the control plane account (the operator role, the account's administrators). | Not a secret by AWS's definition; the guard's value is that outsiders do not hold it, and nobody outside the control plane account can read those APIs. |

---

## 10. Acceptance Criteria

A correct implementation demonstrably passes the following end-to-end
scenario against real infrastructure in **two accounts** (this mirrors the
reference integration test). Account A is the control plane's own account;
account B is a second account with the role pair installed under an
`externalId`. With `maxTenants = 1` (every cell is a silo, so cells — not
tenants — are what the accounts count):

1. **Auth:** an operation without a JWT is rejected; with a valid vendor
   IdP JWT it succeeds.
2. **Handshake:** `PutAccount` for an account with no role pair → 400;
   `PutAccount` B as `TENANT` without `externalId` → 400; with the wrong
   `externalId` → 400 naming the role; `PutAccount` A (`VENDOR`,
   `maxCells = 2`) and B (`TENANT`, `maxCells = 1`, `externalId`) → 200;
   `ListAccounts` shows 0/2 and 0/1 with `maxCells`; `GetAccount` B does not
   return the `externalId` value.
3. **Implicit creation in the home account:** onboarding tenant 1 with an
   empty fleet creates cell 1 in A (`CREATING → ACTIVE`), then tenant 1;
   `GetTenant` reports `cellId`, `GetCell` reports `accountId = A`; the cell
   namespace and the tenant parameter exist **in A**. Account A is 1/2.
4. **Idempotent replay:** re-sending tenant 1's request with the same
   `clientToken` returns the original tenant (no second tenant, no new
   cell, A still 1/2); the same token with different parameters is a 409.
5. **Scale within the account:** onboarding tenant 2 creates cell 2 in A
   (cell 1 is full). Account A is 2/2.
6. **Tenant-owned accounts are not fleet capacity:** onboarding tenant 3
   without a target → 409 `InsufficientCapacityError` (A is full, B is
   tenant-owned); no tenant, cell, or account changed.
7. **Targeted creation in the second account:** onboarding tenant 3 with
   `accountId = B` creates cell 3 in B; `GetCell` reports `accountId = B`;
   the cell namespace and the tenant parameter exist **in B** and do not
   exist in A. Account B is 1/1. An in-flight mutation on tenant 3 while
   `CREATING` → 409.
8. **Account full:** onboarding tenant 4 with `accountId = B` → 409
   `InsufficientCapacityError`; `DeleteAccount` B → 409 (occupied);
   `PutAccount` B with a different `owner` → 409.
9. **Reads:** `ListCells` shows three cells with their `accountId`;
   `ListCells?accountId=A` returns exactly cells 1 and 2 and an unknown
   account yields an empty page; `ListTenants?cellId=` filters correctly;
   `GetResource`/`GetCell` return the stamped definition and the account;
   `UpdateTenant` edits metadata without touching lifecycle fields.
10. **Re-apply across accounts:** `UpdateResource` on tenant 1 (in A) and
    `UpdateCell` on cell 3 (in B) run the update scripts under the
    respective account's provisioning role and return to `ACTIVE`.
11. **Reuse before create:** deleting tenant 1 frees its slot
    (transactionally); cell 1 stays, empty, and account A stays 2/2 (the
    cell slot is held by the cell, not the tenant). Onboarding tenant 5
    without a target places it into cell 1 — no new cell, no 409.
12. **Teardown:** deleting all tenants frees their slots; deleting the
    now-empty cells removes them **and releases the account slots**
    (A → 0/2, B → 0/1); `DeleteAccount` A and B → 200; `ListAccounts` is
    empty; the parameter namespaces in **both** accounts end empty. Every
    operation has run at least once.

Plus unit-level assertions that no write path is unconditional (P-5), that
exactly two code paths mutate `tenantCount` and exactly two mutate
`cellCount` (P-6), and that `PutAccount` never writes `cellCount` (R-24).

---

## 11. Extension Seams (documented, not built)

Per P-1, deferred generality is recorded as seams, not code:

| Extension | Seam |
|---|---|
| Standalone resource service (pooled/hybrid re-split) | extract at `/tenants/{tenantId}/resource`; introduce a placement entity as the tenant↔resource join; propagate terminal status back via event push or M2M-authenticated polling |
| Definition-replacing `UpdateCell` body | noted extension; today the stamped definition is immutable |
| Explicit capacity pre-provisioning (`POST /cells`) | deliberately absent; placement is the only creator |
| Per-operation authorization matrix | authorizer already forwards `role`; caller context already carries it |
| Opaque per-tenant script parameters | generic `parameters: map<string,string>` → build env vars |
| Stuck-execution sweep for aged transitional records | covers the two documented stranding gaps (§7.4, R-22) |
| Auto-scale-in (delete after N days empty) | business plane policy layered on the explicit `DeleteCell` and `DeleteAccount` APIs |
| A Region per account | an `accountId`-plus-`region` target on the account record; the build runner's AssumeRole already yields credentials usable in any Region, so the seam is the account record and the scripts' Region input, not the trust model |
| Account vending | an upstream system creates the account and installs the role pair, then calls `PutAccount`; the control plane's contract starts at registration |
| Per-account placement policy (drain, prefer, weights) | today: `owner` decides eligibility and `maxCells` decides capacity; a `placement` field on the account record is where a richer policy would live |
| Tenant migration between cells or accounts | would need a tenant-level transitional status spanning two cells and two counters; deliberately excluded |

---

## 12. Reading Order for Implementers

1. §2 (principles) — internalise P-5 and P-6 before writing any data code.
2. §4 + §5 — model the entities and the API contract first (P-2); generate,
   don't hand-write, the API layer.
3. §7 — implement placement with its transactions exactly as specified,
   the account claim included; this is where correctness is won or lost.
4. §8 — the workflow; resolved input and field ownership are not optional
   niceties.
5. §6 + §9 — the script contract, the role asymmetry, and the account role
   pair that carries it into every account.
6. §10 — build the acceptance test alongside, not after; it needs two
   accounts from the first run.

The reference implementation's `architecture.md` and `adr/`
carry the detailed rationale behind each requirement — consult them when a
requirement here seems arbitrary; it almost certainly isn't.

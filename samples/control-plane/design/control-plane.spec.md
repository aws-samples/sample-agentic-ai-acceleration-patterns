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
that onboards tenants, provisions their deployments, tracks lifecycle
state, and offboards them. Most published control plane examples are either
toy CRUD APIs (no real provisioning) or sprawling platforms (dozens of
services obscuring the core ideas).

This spec defines a **control plane for cell-based
deployments** of one or more applications — small enough to read in a
sitting, complete enough to be correct under concurrency and failure.

### 1.1 The deployment model

An **application** is something the vendor deploys for tenants: a source,
the scripts that deploy it, and how many tenants share one deployment.
One control plane serves many applications. Operators register
applications at run time (§5.5).

A **tenant** is a customer of the vendor. A tenant can use any number of
the vendor's applications; each use is a **deployment** — the tenant in
one application, provisioned once and tracked through its own lifecycle
([ADR-037](../adr/0037-a-deployment-is-one-tenant-in-one-application.md)).
A tenant has at most one deployment per application.

A **cell** is the unit of deployment of one application: one **shared
application deployment** plus up to `maxTenants` deployments, each a
tenant's **own per-tenant deployment** inside the cell. Every cell belongs
to one application and is built from that application's definition.

The cell model is a strict generalisation of the two classic isolation
models:

- `maxTenants = 1` → **silo**: every tenant gets a dedicated cell.
- `maxTenants = N` → **pool**: N tenants share the cell's shared
  deployment, each with its own per-tenant slice.

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
may provision cells into. Operators register accounts at run time (§5.4),
each with a cell capacity (`maxCells`), an **owner**, and which
applications it **admits** — one, several, or all of them:

- **Vendor-owned** accounts form the fleet. When no cell of the
  application has a free slot, placement creates a new cell in a
  vendor-owned account that admits the application and has free cell
  capacity; the application's **placement strategy** (§7.1) decides which
  one. Registering a second vendor-owned account is how the fleet
  scales past one account's limits.
- **Tenant-owned** accounts belong to a customer. Placement never chooses
  them: a deployment lands there only when `CreateDeployment` names the
  account.
  The customer installs the provisioning role pair (§6.4) in their own
  account, keeps every resource and all data there, and can revoke the
  control plane at any time by removing the roles. The control plane holds
  no customer credentials, only the account id.
- An account is **shared** when it admits every application, or
  **dedicated** when it names the applications it admits. Cells of
  different applications in one shared account are separate cells; they
  share only the account's cell capacity and its role pair.

The control plane's own account is just another account. A production
control plane normally runs in an account of its own and hosts no cells;
registering the home account as vendor-owned is how the sample keeps its
acceptance test to two accounts, and nothing in the design depends on it.
Capacity is bounded at three levels:
tenants per cell (`maxTenants`, per application), cells per account
(`maxCells`), and the accounts registered. When every eligible account is
full, placement fails with a modelled error (§5.7) rather than creating
capacity nobody authorised.

| Scenario | How the model expresses it |
|---|---|
| One account, many cells | one vendor-owned account, `maxCells = N` |
| Scale to a second account in the Region | register a second vendor-owned account; with `placementStrategy = FILL` new cells spill over when the first is full |
| Spread an application's cells over all open accounts | `placementStrategy = ROUND_ROBIN` on the application; the next cell goes to the eligible account with the fewest cells |
| Deploy into a customer's account on demand | the customer installs the role pair; the operator registers the account as tenant-owned; `CreateDeployment` names it |
| Two applications, one account | register both applications; one shared vendor-owned account hosts cells of each |
| One tenant, two applications | two deployments of the same tenant, one per application, each in a cell of its application; the same `TENANT_ID` reaches both sets of scripts |
| An application with accounts of its own | register the accounts with `applicationIds` naming that application; new cells of that application go there first (§7.1) |
| A customer hosting two of the vendor's applications | one role pair in the customer's account, registered tenant-owned; `CreateDeployment` names the account for either application |

### 1.2 What this control plane does not do yet

Control plane concerns this version leaves out. Each has a recorded seam
(§11) and may be built later:

- Billing, metering, tenant tiers
- Cell rebalancing, deployment migration between cells or accounts
- Dependencies between applications (one application's deployment needing
  another's) — each deployment is provisioned on its own
- Pre-provisioning capacity ahead of demand (auto-scaling the fleet)
- Placement by load: the placement strategies choose by cell count, never
  by what the cells are doing
- Creating AWS accounts (account vending) — an account exists before it is
  registered, and whoever owns it installs the role pair
- A Region per account — cells are provisioned in the control plane's
  Region
- Per-operation authorization and a sweep for stranded in-flight records

### 1.3 What this control plane is NOT

The control plane manages *deployments of* the application plane; it never
becomes part of it. These are application plane concerns and stay out by
design:

- What a deployment contains — infrastructure, code, configuration and
  data are the provisioning scripts' business; the control plane records
  that a deployment exists and whether its last build succeeded. It
  carries the deployment's declared parameter values to the scripts
  (§6.1) without knowing what they mean
- Serving tenant traffic, or routing tenants to their cells
- **Customer identity.** Which IdP a tenant's users authenticate against
  is a property of the deployed application, owned by the provisioning
  scripts

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

- The tenant↔cell relationship is a field on the **deployment**,
  `deployment.cellId` — not a placement entity with its own lifecycle and
  API. The deployment *is* the join between a tenant and the cells of its
  applications, and it exists because that relation is 1:N
  ([ADR-037](../adr/0037-a-deployment-is-one-tenant-in-one-application.md));
  it stores what no neighbour does — the lifecycle of one tenant in one
  application. An entity that would store nothing its neighbours don't,
  mirror their status, and pass through their operations is a field, not
  an entity.
- Applications, tenants, deployments, cells, accounts, and the provisioning
  workflow live in **one service on one table**, so terminal workflow state
  is written directly — there is no cross-service auth, no
  status-propagation machinery, and no service discovery anywhere in the
  system.
- The account *is* an entity, by the same test: it holds the authoritative
  cell counter and the trust handshake, which no neighbour stores, and
  operators register it explicitly (P-10). Its lifecycle is synchronous —
  no build, no workflow — so it adds four operations on the same table and
  nothing else.
- The application *is* an entity for the same reason: it holds the
  definition every one of its cells is stamped from and the authoritative
  count of those cells, and operators register it explicitly. Its
  lifecycle is synchronous too. Which applications an account admits is a
  field on the account, not an entity: it stores nothing its neighbours
  don't ([ADR-033](../adr/0033-account-admission-is-an-application-allowlist-on-the-account.md)).

The result: **one service, one API, one table, one workflow, two build
projects, and one role pair per account — for any number of
applications.** An implementation of this spec MUST NOT introduce
additional services, tables, or workflows unless a requirement below is
unimplementable without them.

Corollary: when generality is speculative, leave it out and *record the
seam* (§11). For example, `GetDeployment` returns the deployment's
effective definition resolved from its cell; a standalone resource service,
if ever needed, is extracted at the deployment collection — deferred
generality is a documented evolution path, not live code.

### P-2. The model is the architecture

The API contract is defined first, in a machine-readable interface model
(Smithy in the reference implementation), and everything else — OpenAPI
spec, server SDK, API Gateway wiring — is *generated* from it. Nobody
hand-edits generated output; the model is fixed and regeneration follows.
This makes the contract the single point of change and keeps implementation
drift structurally impossible.

### P-3. Strict plane separation: the control plane never interprets application plane configuration

The control plane knows *that* a deployment exists and *whether* its
build succeeded. It does not know *what* the deployment is. Consequences:

- Provisioning is delegated to vendor-supplied **lifecycle scripts** — the
  control plane runs them and records the outcome, nothing more.
- Shared resource identifiers flow from the cell to its tenants through an
  **out-of-band parameter namespace** (SSM Parameter Store) **in the cell's
  account**, written by cell scripts and read by tenant scripts *at deploy
  time*. The control plane is not involved in that exchange and never reads
  the namespace.
- Customer identity is an application plane decision.
- Per-deployment values the scripts need (an allowed email domain, a
  feature switch) are **declared parameters**: the application names
  them, the operator supplies values on the deployment, and the control
  plane validates names and presence, stores the values and hands them to
  every tenant script as environment variables (§6.1,
  [ADR-039](../adr/0039-applications-declare-deployment-parameters.md)).
  Per-cell values the cell scripts need (an instance size, a shard count)
  are **declared cell parameters**: the application names them with a
  default, a new cell starts on the defaults, and the operator changes a
  cell's values through `UpdateCell`
  ([ADR-040](../adr/0040-applications-declare-cell-parameters-with-defaults.md)).
  The values are opaque strings: the control plane never reads their
  meaning, never derives a decision from them, and never shapes the
  contract around a specific concern.

The boundary test is *configuration vs. onboarding input*: `adminEmail`
(the first application-plane admin user of a deployment) crosses the
boundary exactly once, as an environment variable to the create script,
and is **never persisted** by the control plane. Declared parameters are
the configuration side of that test, made explicit: the application owns
the set, the deployment owns the values, and every lifecycle script of
the deployment — create, update and delete — receives them.

### P-4. Cells are homogeneous by construction, per application

Every cell of an application is provisioned from that application's
**definition** — source + cell scripts + tenant scripts + `maxTenants`,
held on the application record (§4.1) — and the definition is **stamped
immutably onto each cell record at creation**
([ADR-032](../adr/0032-register-applications-at-run-time-and-stamp-their-definition-onto-cells.md)).

Why: placement only works if a deployment is placeable into *any* cell of
its application with free capacity. Per-tenant provisioning definitions
would break that fungibility. So tenants and deployments carry **no source
and no scripts** — a deployment is defined by its cell's stamped
definition, and it is only ever placed into a cell of its own application.
A deployment's parameter values do not break that fungibility: they are
input to the same scripts in every cell, never a different definition,
and placement never reads them. Cell parameter values (R-34) do not break
it either: they tune one cell (its size, its shard count) without
changing what it can host, every deployment of the application MUST work
in a cell whatever its values, and placement never reads them.

Stamping makes configuration changes forward-only: a replaced application
definition affects only cells created afterwards; existing cells keep the
definition they were built with. Parameter declarations are the one
application change that reaches existing cells and deployments: they are
never stamped, so a changed default or a new declaration applies to each
record's next build (R-32, R-34). New provisioning *code* still reaches
existing cells because git sources are fetched fresh on every build — the
definition pins *where the scripts live*, not their content.

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
- **No write whose correctness depends on prior state is unconditional** —
  even fresh-ULID inserts are conditional on non-existence, and
  metadata/failure writes are conditional on existence so they cannot
  resurrect a concurrently deleted record as a ghost. The one write that is
  correct in every prior state, `PutApplication`'s create-or-replace, sets
  its counter through `if_not_exists` instead (§5.5).

### P-6. Invariants are protected by atomicity at both ends of their lifetime

The core capacity invariant — *a claimed slot corresponds to exactly one
live deployment record* — is enforced transactionally at both boundaries:

- **Birth:** the slot claim (counter increment) and the deployment record
  are created in **one transaction**. A crash cannot leave a phantom slot
  with no deployment referencing it (a counter that could never be
  decremented would block cell deletion forever).
- **Death:** the deployment record deletion and the counter decrement
  happen in **one transaction** at the end of the delete workflow.

Exactly two code paths touch the counter, both transactional — *that* is
what makes it trustworthy. When you find an invariant in your own design,
count the code paths that can violate it and drive that number to the
minimum, each one atomic.

The same discipline applies to every other counter. The tenant's
`deploymentCount` — *every live deployment is counted by exactly one
tenant* — is claimed and released in those same two transactions. The
account's `cellCount` — *a claimed cell slot corresponds to exactly one
live cell record* — is claimed in the transaction that creates the cell
and released in the transaction that deletes it. The application's
`cellCount` — *every live cell is counted by exactly one application* — is
claimed and released in those same two transactions. Four counters, two
code paths each, all eight transactional.

### P-7. Tolerate benign races; prevent corruption; document the difference

Not every race must be eliminated. The design explicitly classifies races
into two buckets:

- **Corruption** (wrong counter, orphaned records, double-claimed slots) —
  eliminated by P-5/P-6 mechanisms.
- **Over-provisioning** (two concurrent placements each create a new cell;
  placements arriving while the only cell is still creating spawn more
  cells)
  — *tolerated*, because eliminating them would require a fleet-wide lock
  for a rare, benign outcome.

An implementation MUST document its tolerated races and residual failure
windows explicitly (see §7.2). "We accept X because fixing it costs Y and
the impact is Z" is a design output, not an admission of defeat.

### P-8. Long-running mutations are asynchronous: 202 + transitional status + polling

Provisioning runs arbitrary infrastructure code and may take minutes to
hours; synchronous API gateways cap at ~29 seconds. Therefore:

- Every mutation that ends in a provisioning build returns **HTTP 202**
  after persisting a transitional status (`CREATING`/`UPDATING`/`DELETING`).
- A durable workflow engine — not a compute function waiting on the build:
  wait billing, invocation time caps, and crash-loss of the terminal
  transition all disqualify that — runs the build and writes terminal state.
- The read endpoint (`GetDeployment`/`GetCell`) is the polling contract.
- **Transitional statuses double as the concurrency guard**: any mutation
  against an in-flight record is a 409. One mechanism serves two purposes.

### P-9. Total contracts: every lifecycle path exists, every failure is a modelled state with a remediation path

- Both script sets (cell + tenant) MUST define all three operations
  (create/update/delete). Empty deployments use explicit no-op scripts —
  never absent ones — so every lifecycle path is executable.
- Every failure lands in a modelled `*_FAILED` status with a
  `statusReason`, and every `*_FAILED` status has a documented operator
  action that leads out of it (retry the update; delete the deployment,
  then the cell). There are no dead-end states.
- Cleanup MUST always be reachable: deployment deletion is allowed from
  failed states *regardless of cell status*, because the delete script is
  the cleanup path even when the cell itself failed to create.

### P-10. Explicit over implicit for operator-facing decisions

- **Scale-out is implicit** (placement creates cells on demand — a
  mechanical decision with a clear trigger), but **scale-in is explicit**:
  an empty cell persists until an operator deletes it. Tearing
  down shared infrastructure as a side effect of the last deployment
  leaving would silently expand `DeleteDeployment`'s blast radius. The same
  holds one level down: an empty tenant persists until an operator deletes
  it, and a tenant with deployments cannot be deleted at all.
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
write commits leaves the client unsure whether the deployment was created,
and the natural reaction — retry — creates a duplicate deployment or a
duplicate cell. Two guards close it. A tenant has at most one deployment
per application, so a plain retry of `CreateDeployment` is a 409 on the
existing record — never a duplicate. And an **optional client-supplied
idempotency token**, whose detection record is written *in the same
transaction* as the placement itself, turns that 409 into the original
result: there is no check-then-act window. Token reuse with different
parameters is a 409.

Layered beneath it, infrastructure-level tokens (transaction client request
tokens) protect identical automatic SDK retries — but only within their
finite window. Beyond that window, safety comes from **item-state
conditions** (the delete requires the deployment to exist in `DELETING`;
the decrement requires `tenantCount > 0`), which remain correct forever.
Choose the mechanism that matches the retry's origin and time horizon.

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
| R-3 | **Service** | One stateless compute function implementing all operations, including synchronous placement, the tenant registry, the application registry and the account registry. |
| R-4 | **Store** | One database table holding all five entity types (application + account + cell + tenant + deployment) plus the idempotency record type, with support for multi-item ACID transactions and conditional writes. (The reference uses DynamoDB single-table design; any store with equivalent transactional conditional-write semantics qualifies.) |
| R-5 | **Workflow** | One durable state machine executing provisioning builds and writing terminal state directly to the table. |
| R-6 | **Build runners** | **Two** shared build projects (cell builds, tenant builds). Per-execution overrides select the source and script; the projects themselves are never mutated per deployment, cell, or account. Before the script runs, each build assumes its half of the hosting account's provisioning role pair (R-25), so the script executes with that account's permissions. The projects' own roles may only assume those roles, read the source, and write their logs. |
| R-25 | **Account role pair** | One deployable unit (reference: a CDK stack) that installs `<fleet>-cell-provisioning` and `<fleet>-tenant-provisioning` in an account with the asymmetric permissions of §6.2, trusting the control plane's two build roles and its API role (the registration probe, R-26) — and an optional external id. The account owner deploys it; the control plane stack installs the same pair in its own account so the home account needs no extra step (P-4). |

```
Vendor operator ──JWT──► API + Authorizer ──► Service (sync ops, placement,
                                                 │        application + account
                                          202 async ops       ▲        registries)
                                                 ▼            │ terminal status
                                          Workflow ──► cell build │ tenant build
                                                        (shared projects)
                                                             │ AssumeRole
                                     ┌───────────────────────┴──────────────────────┐
                                     ▼                                              ▼
                        account A (vendor-owned, shared)            account B (tenant-owned)
                        <fleet>-cell-provisioning                   <fleet>-cell-provisioning
                        <fleet>-tenant-provisioning                 <fleet>-tenant-provisioning
                        /application-plane/* (SSM)                  /application-plane/* (SSM)
                        cells 1..maxCells                           cells 1..maxCells
                          app X cells, app Y cells                    app Y cells
```

Account A may be the control plane's own account. Nothing in the picture
changes when it is. Cells of different applications in one account differ
only in the definition they were stamped from; the account, its role pair
and its cell limit do not know which application a cell serves.

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

### 3.3 Stack inputs

Supplied at deployment time, validated at synthesis/deploy.

**Control plane stack:**

| Input | Constraint |
|---|---|
| `vendorIdp.issuerUrl`, `vendorIdp.audience` | non-empty; OIDC discovery must work against the issuer |
| `fleetName` | names the role pair every account installs (`<fleetName>-cell-provisioning`, `<fleetName>-tenant-provisioning`) and the control plane's three roles the pair trusts (`<fleetName>-cell-build`, `<fleetName>-tenant-build`, `<fleetName>-api`); `[a-z0-9-]{1,32}`. Default `control-plane`. Two control planes in one account MUST use different fleet names |
| `tenantBuildManagedPolicyArns` (optional, [ADR-022](../adr/0022-attach-deployer-supplied-managed-policies-to-the-tenant-build-role.md)) | array of customer-managed IAM policy ARNs (`arn:<partition>:iam::<account>:policy/...`), each in the stack's own partition and account; synth MUST fail otherwise. Attached to the tenant provisioning role the stack installs in its own account. Default: none |

Neither applications nor accounts are stack inputs: both are
registered through the API (§5.4, §5.5), because a customer's account
appears on demand, not at deploy time (P-10,
[ADR-024](../adr/0024-register-accounts-at-run-time-and-claim-cell-slots-atomically.md)),
and a new application MUST NOT need a redeploy of the control plane
([ADR-032](../adr/0032-register-applications-at-run-time-and-stamp-their-definition-onto-cells.md)).
The control plane stack therefore carries no provisioning source, no
script path and no tenant limit.

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

One table, five public entity types plus one internal record type. All keys
shown as the reference implementation's convention; the requirement is the
*shape*, not the literal strings.

### 4.1 Application

| Field | Requirement |
|---|---|
| `applicationId` | operator-chosen, `[a-z0-9-]{1,32}` — the item's identity; never generated. The charset keeps it usable as a parameter path segment (§6.2) and readable in listings |
| `source` | `{type, location, sourceVersion?}` — a build-service source reference (e.g. GitHub repo, S3 bucket) and an optional git ref forwarded to the build as its source version; non-empty type and location. A source whose ref is not a full commit SHA is accepted with a logged warning ([ADR-020](../adr/0020-supply-chain-pinning-warn-and-allow.md)) |
| `cellScripts` | `{create, update, delete}` — all three paths required, non-empty (P-9) |
| `tenantScripts` | `{create, update, delete}` — all three paths required, non-empty (P-9) |
| `maxTenants` | integer ≥ 1; replaceable. A new value applies to cells created afterwards (P-4) |
| `placementStrategy` | `FILL \| ROUND_ROBIN`; default `FILL`; replaceable, takes effect on the next placement ([ADR-036](../adr/0036-the-application-chooses-fill-or-round-robin-across-accounts.md)). How a new cell picks among eligible accounts with free capacity (§7.1): `FILL` takes the oldest registered account until it is full; `ROUND_ROBIN` takes the account with the fewest cells, so cells rotate over the open accounts |
| `parameters` | optional list of **parameter declarations**, at most 20, default none; replaced when sent (absent on an existing application keeps it, `[]` clears it), takes effect on the next deployment request ([ADR-039](../adr/0039-applications-declare-deployment-parameters.md)). Each is `{name, required, default?, description?}`: `name` matches `[A-Z][A-Z0-9_]{0,63}` and is unique in the list; `required` is a boolean, default `false`; `default` is a string of at most 1,024 bytes (UTF-8) with no control characters (as for values, R-33) and MUST NOT be set on a required parameter; `description` is at most 256 characters of operator-facing text |
| `cellParameters` | optional list of **cell parameter declarations**, at most 20, default none; replaced when sent (absent on an existing application keeps it, `[]` clears it), takes effect on the next cell build ([ADR-040](../adr/0040-applications-declare-cell-parameters-with-defaults.md)). Each is `{name, default, description?}`: `name` as for `parameters`, unique in the list and MUST NOT also appear in `parameters` (one name, one meaning); `default` is **required**, a string of at most 1,024 bytes (UTF-8) with no control characters, because a cell is created by placement and no operator is present to supply a value; `description` as for `parameters`. There is no `required` flag |
| `cellCount` | **the authoritative count of this application's cells** — claimed in the cell-creating transaction, released in the cell-deleting one (P-6); never written by `PutApplication` |
| `createdAt`, `updatedAt` | timestamps |

Key: `PK=APPLICATION#<applicationId>`, `SK=META`.

`source`, `cellScripts`, `tenantScripts` and `maxTenants` together are the
application's **definition**: the bundle a new cell is stamped from.
`placementStrategy`, `parameters` and `cellParameters` are not part of
the definition and are never stamped. The strategy steers where the next
cell goes; the declarations validate requests and supply defaults when a
build's input is resolved (R-32, R-34), so every deployment and every
cell of the application is checked against one current set. A script
stamped onto an older cell receives any parameter added since as one more
environment variable, which it ignores. An
application has **no status**: its operations are synchronous and run no
build. Its lifecycle is register (`PutApplication`) → in use → delete
(empty only).

**R-29 (field ownership on applications):** `PutApplication` MUST write
only the definition fields, `placementStrategy`, `updatedAt`, and each of
`parameters` and `cellParameters` **only when the request sent it** (on
an existing application an absent list is kept, `[]` clears it, §5.5),
and MUST NOT touch `cellCount`;
the two counter paths MUST NOT touch the definition. A definition replaced
while a cell is being created does not change that cell: the cell was
stamped inside the placement transaction, from the definition read before
it (§7.1 step 0).

### 4.2 Cell

| Field | Requirement |
|---|---|
| `cellId` | generated, sortable unique id (ULID) — creation-ordered ids give listings chronological order for free |
| `applicationId` | the application the cell serves — assigned at creation, **never changes** |
| `accountId` | the account the cell is provisioned in — assigned at creation, **never changes** (migration is out of scope) |
| `status` | `CREATING \| ACTIVE \| UPDATING \| DELETING \| CREATE_FAILED \| UPDATE_FAILED \| DELETE_FAILED` |
| `maxTenants` | stamped from the application's definition at creation; immutable |
| `tenantCount` | **the authoritative occupancy counter**: the number of deployments in the cell, which in a cell of one application is the number of distinct tenants — see R-16..R-18 |
| `source`, `cellScripts`, `tenantScripts` | stamped from the application's definition; immutable for the cell's lifetime |
| `parameters` | map of cell parameter name → value, the values an operator set on this cell through `UpdateCell`; at most 20 entries, each value at most 1,024 bytes (UTF-8); **empty at birth**. Never holds a default the operator did not supply, so a changed default reaches the cell on its next build |
| `lastBuildId` | most recent successful cell-scoped build id (nullable) |
| `statusReason` | populated on failure (nullable) |
| `createdAt`, `updatedAt` | timestamps |

Key: `PK=CELL#<cellId>`, `SK=META`.

**R-34 (cell parameters,
[ADR-040](../adr/0040-applications-declare-cell-parameters-with-defaults.md)):**
when a cell build's input is resolved (create, update and delete alike,
§8.1), the service MUST build the cell's parameter set as every stored
value on the cell plus the declared `default` of each cell parameter
without one; stored values for names no longer declared are still passed,
so a script sees every value an operator set (R-35 says what a delete
script may rely on). `UpdateCell` MUST validate a supplied body against
the application's current `cellParameters` and refuse with 400 an
undeclared name in `parameters` (a tenant parameter name included), a
value over 1,024 bytes (UTF-8), more than 20 stored entries after the
merge, or a name in both `parameters` and `removeParameters`. The merge
and its precedence follow R-33 exactly: the whole merged map written in
the conditional update that moves the cell to `UPDATING`, conditioned on
the status guard **and** on the cell's `parameters` attribute being
exactly as the request read it; the same `removeParameters` rules, character rule and
error classification; validation before the status check. The map
condition matters most here: placements and deployment deletes write the
cell's counter and `updatedAt` while it is `ACTIVE`, and they must not
fail an `UpdateCell` that has nothing to do with them.
`removeParameters` naming a stored entry returns the cell to the default.
`DeleteCell` MUST NOT validate. A new cell is inserted with an empty map (§7.1 step 3): no
request supplies cell values at birth. The cell's set reaches **cell
scripts only**; tenant scripts that need a cell value read what the cell
create script published under `/application-plane/cells/<cellId>/*`
(§6.2).

### 4.3 Tenant

| Field | Requirement |
|---|---|
| `tenantId` | generated ULID |
| `name` | required; NOT unique (uniqueness is deliberately not a tenant-name property) |
| `description` | optional |
| `deploymentCount` | **the authoritative count of this tenant's deployments** — claimed in the placement transaction, released in the deployment-deleting one (P-6); never written by `CreateTenant` or `UpdateTenant` |
| `createdAt`, `updatedAt` | timestamps |

Key: `PK=TENANT#<tenantId>`, `SK=META`.

A tenant has **no status**: its operations are synchronous and run no
build. Its lifecycle is create → in use → delete (empty only). Everything
provisioned for a tenant is a deployment.

**R-7:** The tenant record MUST NOT carry provisioning source, scripts, a
cell or a build state (P-4, [ADR-037](../adr/0037-a-deployment-is-one-tenant-in-one-application.md)):
those belong to its deployments, one per application.

**R-8:** `adminEmail` MUST NOT be persisted on any record (P-3). It survives
only in workflow execution history and build logs, which suffice for audit.

### 4.4 Deployment

The tenant in one application
([ADR-037](../adr/0037-a-deployment-is-one-tenant-in-one-application.md)).

| Field | Requirement |
|---|---|
| `tenantId`, `applicationId` | the item's identity — one deployment per tenant per application; a second create is a 409 |
| `cellId` | the placement — assigned at creation, **never changes** (migration is out of scope); always a cell of `applicationId` |
| `status` | same enum as cell |
| `parameters` | map of parameter name → value, the values the operator supplied for this deployment; at most 20 entries, each value at most 1,024 bytes (UTF-8); empty when none were supplied. Written by `CreateDeployment`, merged by `UpdateDeployment` (R-33); never holds a default the operator did not supply, so a changed default reaches the deployment on its next build |
| `lastBuildId`, `statusReason`, timestamps | as for cell |

Key: `PK=TENANT#<tenantId>`, `SK=DEPLOYMENT#<applicationId>`. A tenant's
deployments are therefore one base-table query and need no index.

**R-31:** The deployment record MUST NOT carry provisioning source or
scripts (P-4). Its effective definition is resolved from its cell.

**R-32 (parameter resolution):** when a deployment build's input is
resolved (create, update and delete alike, §8.1), the service MUST build
the parameter set as: every stored value on the deployment, plus the
declared `default` of each parameter the application declares that has no
stored value. A declared parameter with neither is **absent** from the
build environment, never an empty string, so a script can tell "not set"
from "set to empty". Stored values for names the application no longer
declares are still passed, so a script sees every value an operator set.
Defaults are resolved per build and never recorded, so a delete build can
see a different default from its create build, or none once the
declaration is dropped; R-35 is the rule that makes this safe. The
resolved set goes into the execution
input; the workflow never re-reads the application or the deployment for
it (R-20).

**R-33 (parameter validation and merge):** `CreateDeployment` and
`UpdateDeployment` MUST validate supplied parameters against the
application's current declarations and refuse with 400 a name the
application does not declare, a value over 1,024 bytes (UTF-8), more than 20
stored entries after the merge, or a required parameter with no value
after the merge (the error names the parameter). `UpdateDeployment` MUST
merge, not replace: names in `parameters` are set, names in
`removeParameters` are removed, every other stored value is kept. A name
in both lists is a 400; removing a required parameter is a 400.
`removeParameters` holds at most 40 names, each matching the name pattern
(400 otherwise); it may name any stored entry, declared or not, so stale
values can be cleared, and a name that is not stored is a no-op. The merge
MUST be written in the same conditional update that moves the deployment
to `UPDATING`, as one `SET #parameters = :merged` of the whole merged map
the request validated, never per-name `SET` (a nested path is invalid
on a record with no `parameters` attribute, which includes every record
written before parameters existed). The write is conditioned on the
status guard **and** on the `parameters` attribute being exactly as the
request read it: `attribute_not_exists(#parameters)` when the attribute
was absent, `#parameters = :read` when it was present, an empty `{}`
included. An implementation MUST NOT treat absent and `{}` as the same
read, or the condition can never pass. The status
condition stops two updates from interleaving; the map condition stops a
request from writing a merge it validated against a map that a whole
update cycle has since replaced. The map is the guard, not `updatedAt`,
because only these requests write the map (R-21) while other writers
move `updatedAt`. Failures are classified (R-14). Validation runs on the read record before the conditional
write, so a request that is both invalid and in flight is a 400, with
nothing written. A value MUST NOT contain a control character (U+0000 to
U+001F, U+007F): 400. A build environment cannot carry NUL, and the rule
bounds a value's JSON-encoded size at twice its raw size (§8.1).
`DeleteDeployment` MUST NOT validate parameters: cleanup runs with what is
stored, whatever the declarations now say (P-9).

### 4.5 Account

| Field | Requirement |
|---|---|
| `accountId` | the AWS account id, 12 digits — the item's identity; supplied by the operator, never generated |
| `owner` | `VENDOR \| TENANT` — set at registration, **immutable**: it decides whether placement may choose the account (§7), and flipping it under live cells would silently change who those cells belong to |
| `applicationIds` | optional list of application ids, each at most once, never empty (400); replaceable. **Absent: the account is shared** and admits every application. **Present: the account is dedicated** and admits only those ([ADR-033](../adr/0033-account-admission-is-an-application-allowlist-on-the-account.md)). Each id MUST name a registered application when written (404 otherwise); an id whose application is later deleted is inert — nothing can be placed for it. Narrowing the set under live cells is allowed: it stops new cells of the removed applications there and withdraws their existing cells' free slots from untargeted placement (§7.1 step 0 filters candidates by account); the cells themselves stay |
| `maxCells` | cell capacity; integer ≥ 1; replaceable. Lowering it below `cellCount` is allowed and simply stops new cells there (R-24) |
| `cellCount` | **the authoritative cell counter** — claimed in the cell-creating transaction, released in the cell-deleting one (P-6); never written by `PutAccount` |
| `externalId` | required for `TENANT`, optional for `VENDOR` (§6.4); sent on every AssumeRole into this account. Not a secret, but never logged |
| `createdAt`, `updatedAt` | timestamps |

Key: `PK=ACCOUNT#<accountId>`, `SK=META`.

An account has **no status**: its operations are synchronous and run no
build, so there is nothing transitional to guard. Its lifecycle is register
(`PutAccount`) → in use → delete (empty only).

**R-24 (field ownership on accounts):** `PutAccount` MUST write only the
policy fields it owns (`owner` on first write, `applicationIds`,
`maxCells`, `externalId`, `updatedAt`) and MUST NOT touch `cellCount`; the two counter paths MUST NOT
touch the policy fields. `updatedAt` is the one attribute both paths write;
it is a timestamp, so last-writer-wins there loses nothing. A capacity cut
and a concurrent claim then compose
without a lost update: the claim's condition `cellCount < maxCells`
evaluates against whichever `maxCells` landed first.

### 4.6 Idempotency record (internal)

Written only when `CreateDeployment` carries a `clientToken`, and only as
an additional item inside the placement transaction — never as a separate
write (P-11).

| Field | Requirement |
|---|---|
| `clientToken` | caller-supplied, 1–64 chars — the item's identity (`PK=IDEMPOTENCY#<token>`) |
| `tenantId`, `applicationId` | the deployment the original request created |
| `requestHash` | hash (e.g. SHA-256) of the request parameters — reuse with different input is a 409 |
| `expiresAt` | TTL, ≥ 24h. TTL deletion is lazy, so replay handling MUST ignore `expiresAt` and treat any surviving record as authoritative — the honoured window is "*at least* 24 hours". |

The record is never listed, never returned, and carries no index attributes.
`DeleteDeployment` MUST NOT clean it up: a replayed create after a delete
is a 409 pointing at the deleted deployment, not a silent re-create — the
safer semantics for an operator API.

### 4.7 Listing indexes

Ten listing patterns; nine need secondary indexes (reference: three GSIs;
each item carries at most one partition attribute per index) and one is a
base-table query:

| Pattern | Index shape |
|---|---|
| List all cells | static partition (`CELL`) → `CELL#<cellId>` |
| List deployments of one cell | `CELL#<cellId>` → `DEPLOYMENT#<tenantId>` (one application per cell, so the tenant id is unique within it) |
| List all accounts / placement account scan | static partition (`ACCOUNT`) → `ACCOUNT#<accountId>` |
| List all applications | static partition (`APPLICATION`) → `APPLICATION#<applicationId>` |
| List all tenants | static partition (`TENANT`) → `TENANT#<tenantId>`, sparse (every other type absent) |
| List all deployments | static partition (`DEPLOYMENT`) → `DEPLOYMENT#<tenantId>#<applicationId>`, sparse |
| List cells of one account / targeted candidate scan | `ACCOUNT#<accountId>` → `CELL#<cellId>` |
| List cells of one application / untargeted candidate scan | `APPLICATION#<applicationId>` → `CELL#<cellId>` |
| List deployments of one application | `APPLICATION#<applicationId>` → `DEPLOYMENT#<tenantId>` (same partition as the previous row, separated by sort-key prefix) |
| List deployments of one tenant | base table: `PK = TENANT#<tenantId>`, `SK begins_with DEPLOYMENT#` — no index |

**R-9:** Indexes MUST be treated as eventually consistent and **never
authoritative** (P-5). `tenantCount` on the cell record, `deploymentCount`
on the tenant record and `cellCount` on the account and application
records — not index counts — are the occupancy guards.

**R-10:** Every list query MUST be pinned to a server-side partition. The
partition value is either a static constant (`CELL`, `TENANT`,
`DEPLOYMENT`, `ACCOUNT`, `APPLICATION`) or a validated resource identifier
the request names explicitly (`tenantId`, `cellId`, `accountId`,
`applicationId`), prefixed by the
service; it is never taken from
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

Twenty-two operations. Conventions: lowercase plural collection paths,
kebab-case segments, singleton sub-resource singular. Sync operations
return 200; async (build-triggering) operations return 202 (P-8).

### 5.1 Tenant operations

All synchronous: no tenant operation runs a build
([ADR-037](../adr/0037-a-deployment-is-one-tenant-in-one-application.md)).
A tenant is the customer; what is provisioned for it is a deployment (§5.2).

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `CreateTenant` | `POST /tenants` | 200 | Input `{name, description?}`. Inserts the record with `deploymentCount = 0` (conditional on non-existence, P-5). Nothing is provisioned. |
| `GetTenant` | `GET /tenants/{tenantId}` | 200 | The record: `name`, `description`, `deploymentCount`. 404 if missing. |
| `UpdateTenant` | `PUT /tenants/{tenantId}` | 200 | Metadata only (`name`, `description`), conditional on existence; never `deploymentCount` (R-21). 404 if missing. |
| `DeleteTenant` | `DELETE /tenants/{tenantId}` | 200 | **Empty tenants only** (P-10): a single conditional delete (`attribute_exists AND deploymentCount = 0`), the counterpart of the deployment claim; condition failure → 409. Deployments are deleted first, one by one, through `DeleteDeployment`. |
| `ListTenants` | `GET /tenants` | 200 | Paginated, unfiltered. Tenants of one cell or application are listed through `ListDeployments`. |

### 5.2 Deployment operations

A deployment is addressed by its tenant and its application. Create runs
placement; update and delete run builds; every lifecycle rule that applied
to a provisioned tenant applies here.

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `CreateDeployment` | `POST /tenants/{tenantId}/deployments` | **202** | Input `{applicationId, adminEmail, accountId?, parameters?, clientToken?}` — **no resource definition** (P-4). `parameters` is a name → value map validated against the application's declarations (R-33); 400 on an undeclared name, an over-long value or a missing required parameter, after the replay read (§7.3) and before placement runs. 404 for an unknown tenant or an unregistered `applicationId`. `accountId` pins the deployment to one registered account (the only way into a tenant-owned account); the account MUST admit the application (400 otherwise, §4.5); absent, placement chooses among vendor-owned accounts that admit it. Runs placement (§7), starts the workflow, returns the deployment including `cellId`. 404 for an unregistered `accountId`; 409 `ConflictError` when the tenant already has a deployment of that application; 409 `InsufficientCapacityError` when no eligible account has capacity. |
| `GetDeployment` | `GET /tenants/{tenantId}/deployments/{applicationId}` | 200 | The polling endpoint: `status`, `statusReason`, `lastBuildId`, `cellId`, plus the deployment's *effective* definition (resolved from the cell's stamped definition), the cell's `accountId` and the stored `parameters` (the supplied values only; defaults are not merged in). 404 if missing. |
| `UpdateDeployment` | `PUT /tenants/{tenantId}/deployments/{applicationId}` | **202** | Re-apply the deployment, optionally changing parameter values first. Input `{parameters?, removeParameters?}`, both optional: an empty body re-applies with the stored values. Names in `parameters` are set and names in `removeParameters` removed; every other stored value is kept (R-33). Runs the stamped tenant update script with the merged set resolved per R-32. Requires deployment `ACTIVE`/`UPDATE_FAILED` **and** cell `ACTIVE`; 409 otherwise. 400 on a validation failure of R-33, with nothing written. |
| `DeleteDeployment` | `DELETE /tenants/{tenantId}/deployments/{applicationId}` | **202** | 409 if in-flight. Allowed from `ACTIVE` and all `*_FAILED` states **regardless of cell status** — cleanup must always be reachable (P-9). Runs the tenant delete script with the stored parameters resolved per R-32, never validated against the current declarations; on success the workflow removes the record and releases the cell slot and the tenant's count in one transaction (§8.2). |
| `ListDeployments` | `GET /deployments[?tenantId=\|?cellId=\|?applicationId=]` | 200 | Paginated. At most one filter per request (400 for two). An unknown `tenantId`, `cellId` or `applicationId` filter yields an **empty page, not a 404** — a filter is a query predicate, not a resource lookup. |

### 5.3 Cell operations

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `ListCells` | `GET /cells[?accountId=\|?applicationId=]` | 200 | Fleet topology: `applicationId`, `accountId`, `status`, `tenantCount`/`maxTenants` per cell — the operator's capacity view. Paginated. At most one filter per request (400 for two). An unknown `accountId` or `applicationId` filter yields an **empty page, not a 404** (same rule as `ListDeployments?cellId=`). |
| `GetCell` | `GET /cells/{cellId}` | 200 | Full record including `applicationId`, `accountId`, the stamped definition and the stored cell `parameters` (the operator-set values only; defaults are not merged in). |
| `UpdateCell` | `PUT /cells/{cellId}` | **202** | Re-apply the shared deployment, optionally changing cell parameter values first. Input `{parameters?, removeParameters?}`, both optional: an empty body re-applies with the stored values. Names in `parameters` are set and names in `removeParameters` removed; every other stored value is kept (R-34). Runs the stamped cell update script with the merged set resolved per R-34. 400 on a validation failure of R-34, with nothing written. Allowed from `ACTIVE`/`UPDATE_FAILED`. **409 from `CREATE_FAILED`** — running the *update* script against a half-created deployment breaks the create/update script contract; remediation for a failed cell create is deployment delete + cell delete. |
| `DeleteCell` | `DELETE /cells/{cellId}` | **202** | **Empty cells only** (P-10): the `DELETING` transition MUST be a single conditional write (`status ∈ {ACTIVE, *_FAILED} AND tenantCount = 0`) — the emptiness check and the transition are one atomic write, the counterpart of the placement claim. A read-then-write would let a concurrent placement claim a slot before `DELETING` lands. Condition failure → 409. Runs the cell delete script with the stored cell parameters resolved per R-34, never validated. On success the workflow removes the record and releases the account's and the application's cell slots in one transaction (§8.2). |

**R-11:** There MUST be no `POST /cells`. Cell creation is exclusively a
placement outcome (§7). An operator API for pre-provisioning capacity is a
noted extension, not part of this spec.

### 5.4 Account operations

All synchronous: no account operation runs a build (P-1).

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `PutAccount` | `PUT /accounts/{accountId}` | 200 | Create-or-replace. Input `{owner, maxCells, applicationIds?, externalId?}`; `externalId` MUST be present when `owner` is `TENANT` (400 otherwise, §6.4); every `applicationIds` entry MUST name a registered application (404 otherwise). Before writing, the service MUST verify the handshake by assuming both roles of the account's pair with the given `externalId` and, when one is given, proving each role refuses the call without it (R-26); failure → 400 naming the role and the reason. On an existing account `owner` MUST match (409 otherwise); `maxCells`, `applicationIds` and `externalId` are replaced (an absent `applicationIds` makes the account shared); `cellCount` is untouched (R-24). The write is conditional (`attribute_not_exists` on create; `owner = :owner` on replace). |
| `GetAccount` | `GET /accounts/{accountId}` | 200 | The record: `owner`, `applicationIds` (absent when shared), `cellCount`/`maxCells`, whether an `externalId` is set (never its value). 404 if unregistered. |
| `ListAccounts` | `GET /accounts` | 200 | Paginated capacity view: `owner`, `applicationIds`, `cellCount`/`maxCells` per account. |
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

### 5.5 Application operations

All synchronous: no application operation runs a build
([ADR-032](../adr/0032-register-applications-at-run-time-and-stamp-their-definition-onto-cells.md)).

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `PutApplication` | `PUT /applications/{applicationId}` | 200 | Create-or-replace. Input `{source, cellScripts, tenantScripts, maxTenants, placementStrategy?, parameters?, cellParameters?}` — the definition of §4.1 plus the strategy and both sets of parameter declarations, validated as a whole (400 on a missing script path, a malformed source, `maxTenants < 1`, an unknown strategy, an id outside `[a-z0-9-]{1,32}`, a parameter name outside `[A-Z][A-Z0-9_]{0,63}`, a duplicate name within or across the two lists, more than 20 declarations in either list, a `default` on a required parameter, or a cell parameter without a `default`). On an existing application the definition fields and the strategy are replaced. The two declaration lists are replaced only when sent: an absent `parameters` or `cellParameters` **keeps** the current list, and an empty list `[]` clears it, so a `PutApplication` that only changes `maxTenants` cannot silently drop every required check and default. On a new application an absent list declares none. Existing cells and deployments keep their stored values. A cell parameter added since reaches each cell's next build as its default. A newly required parameter makes the next `UpdateDeployment` of every deployment lacking it a 400 until the operator supplies the value; it never blocks a `DeleteDeployment`. `cellCount` is untouched (R-29). The "one name in one list" check runs against the lists the request sent plus any list it keeps. One write, with `cellCount` and `createdAt` set through `if_not_exists`, so a replace never resets them. When both lists are sent the write carries no condition — an application has no immutable field, so it is correct in every prior state (P-5). When a list is kept, the write is conditioned on that list being exactly as the request read it (`attribute_not_exists` when the attribute was absent, equality when present, an empty `[]` included; absent and `[]` are different reads), so two concurrent puts that each send one list cannot store one name in both; a failed condition → 409, retryable. The condition is never on `updatedAt`, which cell creates and deletes also write. Cells already created keep their stamp (P-4). |
| `GetApplication` | `GET /applications/{applicationId}` | 200 | The record: the definition, `placementStrategy`, both sets of parameter declarations and `cellCount`. 404 if unregistered. |
| `ListApplications` | `GET /applications` | 200 | Paginated: `applicationId`, `maxTenants`, `placementStrategy`, `cellCount` per application. |
| `DeleteApplication` | `DELETE /applications/{applicationId}` | 200 | **Empty applications only** (P-10): a single conditional delete (`attribute_exists AND cellCount = 0`), the counterpart of the cell-slot claim; condition failure → 409. Accounts that name the application in `applicationIds` are not touched (§4.5). |

**R-30:** There MUST be no application-level provisioning: an application
owns no deployment of its own, only the definition its cells are built
from. Shared infrastructure an application needs in an account is
provisioned out of band and published under that application's shared
namespace (§6.2).

### 5.6 Status state machine (cells and deployments)

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
- `UpdateDeployment` requires the cell `ACTIVE` — no tenant builds against
  a shared deployment mid-change.
- `DeleteDeployment` is exempt from cell-status guards (P-9).
- The build guards are one-directional and this is a **documented tolerated
  race** (P-7): a cell build and tenant build can overlap when their
  accepts race. An overlap can fail a build (surfacing as `*_FAILED` on the
  normal retry path) but never corrupts control plane state. Closing it
  would need an in-flight-build counter with the same conditional-claim
  discipline as placement — accepted instead.

### 5.7 Error model

| Error | HTTP | Triggers |
|---|---|---|
| `ValidationException` | 400 | malformed input, malformed pagination token, two list filters at once; an invalid application definition or parameter declaration on `PutApplication`; a deployment parameter that fails R-33 on `CreateDeployment` or `UpdateDeployment`; a cell parameter that fails R-34 on `UpdateCell`; a targeted `CreateDeployment` into an account that does not admit the application; `PutAccount` handshake refusal (R-26: a half could not be assumed, or admits the call without the supplied external id) |
| `UnauthorizedError` | 401/403 | missing/invalid JWT |
| `ResourceNotFoundError` | 404 | unknown tenant, deployment, cell, account or application (including an unregistered `CreateDeployment.accountId` or `applicationId`, and an unregistered id in `PutAccount.applicationIds`) |
| `ConflictError` | 409 | in-flight mutation; a second deployment of the same application for one tenant; occupied-tenant delete; occupied-cell delete; occupied-account delete; occupied-application delete; `owner` change on `PutAccount`; cell-not-ACTIVE guard; `clientToken` reuse with different parameters; a parameter merge or a list-keeping `PutApplication` whose read went stale — retry (R-14); `CreateDeployment` lost every bounded claim on candidate cells and no account had a free cell slot — retry ([ADR-031](../adr/0031-lost-placement-races-on-a-full-fleet-are-a-retryable-conflict.md)) |
| `InsufficientCapacityError` | 409 | `CreateDeployment` found no eligible cell and no eligible account with cell capacity: every vendor-owned account admitting the application is full (untargeted), or the named account is full (targeted). Nothing was written. The remedy is an operator act — raise `maxCells`, register an account, or admit the application in one — so the error is distinct from `ConflictError`, which a client may simply retry later ([ADR-026](../adr/0026-fleet-full-is-a-modelled-error.md)) |
| `InternalServerError` | 500 | everything else, including a `PutAccount` whose handshake probe STS could not answer (throttling, network): the handshake is unknown, not refused, and the operator retries |

**R-14:** Repository condition failures MUST be classified, not blanket-500d:
a stale lifecycle transition → 409; a metadata write that loses a
concurrent delete → 404; an insert that finds the deployment already there
→ 409. A failed parameter merge (R-33, R-34) or list-keeping
`PutApplication` (§5.5) is a 409, with a **retry hint only** when the
item that failed shows a changed `parameters` (or kept list) under a
status the operation admits, or the status `CREATING` or `UPDATING`
(in flight, and it ends in a state the update admits). Every other status (`CREATE_FAILED`, `DELETE_FAILED`,
`DELETING`, a cell not `ACTIVE` under `UpdateDeployment`) is a 409
without a hint: a retry cannot succeed, and the remedy is a delete or
an operator `UpdateCell`. The service classifies from the item returned
by `ReturnValuesOnConditionCheckFailure: ALL_OLD` (or the transaction's
cancellation reasons), never from a second read, so the label describes
the state that actually failed the condition.

---

## 6. Provisioning Contract (Scripts)

Provisioning is delegated to vendor-supplied lifecycle scripts, executed in
the build runners with per-execution source and script overrides. The
control plane's entire contract with them:

### 6.1 Environment contract

| Variable | Cell scripts | Tenant scripts |
|---|---|---|
| `APPLICATION_ID` | ✓ | ✓ (the application the cell serves; the scripts resolve their shared namespace from it, §6.2) |
| `CELL_ID` | ✓ | ✓ |
| `CELL_ACCOUNT_ID` | ✓ | ✓ (the account the cell lives in — the account the script is already running in, for scripts that need to name it) |
| `TENANT_ID` | — | ✓ (the same id in every application the tenant uses) |
| `TENANT_NAME` | — | ✓ every operation; the tenant's `name` as stored on the Tenant record ([ADR-023](../adr/0023-pass-the-tenant-name-to-tenant-scripts.md)) |
| `OPERATION` | `create\|update\|delete` | `create\|update\|delete` |
| `ADMIN_EMAIL` | — | create only (empty string otherwise); the `adminEmail` of the `CreateDeployment` request |
| `OPERATOR_ID` | ✓ | ✓ (the verified operator identity, [ADR-019](../adr/0019-operator-identity-end-to-end.md)) |
| `PARAM_<NAME>` | ✓ every operation; one variable per cell parameter in the cell's resolved set (R-34): the stored value, else the declared default | ✓ every operation; one variable per parameter in the deployment's resolved set (R-32): the stored value, else the declared default; absent when neither exists |

That's it. `TENANT_NAME` passes the same boundary test as `ADMIN_EMAIL`
(ADR-004): onboarding input the control plane already holds. The
`PARAM_` variables are the only application-plane configuration that
reaches a script through the control plane, and only in the shape the
application declared (P-3,
[ADR-039](../adr/0039-applications-declare-deployment-parameters.md)).
The fixed prefix keeps a declared name from overriding a variable of this
contract or of the build environment (`TENANT_ID`, `AWS_REGION`, `PATH`).
Each script sees one set only: a cell script gets the cell's
`cellParameters`, a tenant script the deployment's `parameters`. The two
lists never share a name at any one time (§4.1), so a declared name has
one meaning across the application. A stored value whose name is no
longer declared keeps the meaning it had when it was stored, even if the
name has since been declared in the other list; an operator moving a name
between lists clears the old values with `removeParameters`. A tenant script that needs a cell value reads
it from the cell's namespace, where the cell create script published it
(§6.2,
[ADR-040](../adr/0040-applications-declare-cell-parameters-with-defaults.md)).

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

All four namespaces live **in the cell's account**. Each account's
application plane is its own; a cell never reads another account's
parameters. Shared infrastructure has two namespaces
([ADR-034](../adr/0034-the-shared-parameter-namespace-is-per-application.md),
[ADR-038](../adr/0038-an-account-wide-shared-namespace-beside-the-per-application-one.md)):
an account-wide one for infrastructure every application in the account
may use (an identity platform, a shared network), and one per application,
so two applications hosted in one account keep their own shared
infrastructure apart. The publisher's choice of namespace states what the
infrastructure is for. Cell ids are unique across applications, so the cell
namespace needs no application segment; a tenant can have a deployment in
several applications, so its namespace is keyed by both
([ADR-037](../adr/0037-a-deployment-is-one-tenant-in-one-application.md)).

| Namespace | Cell role | Tenant role | Written by |
|---|---|---|---|
| `/application-plane/shared/*` | read | read | infrastructure every application in that account may use, out of band |
| `/application-plane/applications/<applicationId>/shared/*` | read | read | that application's shared infrastructure in that account, out of band. The roles' grant covers `/application-plane/applications/*` |
| `/application-plane/cells/<cellId>/*` | read + **write/delete** | read | the **cell create script** publishes the cell's shared resource identifiers here; the cell delete script cleans them up |
| `/application-plane/tenants/<tenantId>/<applicationId>/*` | — | read + **write/delete** | tenant scripts own their deployment's state here. The roles' grant covers `/application-plane/tenants/*` |

Scripts learn their application via `APPLICATION_ID`, tenant scripts their
tenant via `TENANT_ID` and their cell via `CELL_ID`, and resolve shared
resources from those namespaces **at
deploy time**. Deploy-time resolution means
shared resource changes take effect on the next build with no control plane
change and no record mutation. A missing SSM parameter the script needs,
or a missing `PARAM_` variable it cannot do without, fails the script
fast → `*_FAILED` with the name in `statusReason`.

### 6.3 Script requirements

**R-15:** Scripts MUST be idempotent and safe to re-run after partial
completion — the workflow's retry paths (`UpdateCell` after
`UPDATE_FAILED`, `DeleteDeployment` retry after `DELETE_FAILED`) re-execute
them. Empty deployments are explicit no-op scripts (P-9).

**R-35 (delete finds, never recomputes):** a delete script MUST locate
what its create and update scripts made through its own namespace
(`/application-plane/cells/<cellId>/*` for a cell,
`/application-plane/tenants/<tenantId>/<applicationId>/*` for a
deployment, §6.2), never by recomputing names or sizes from `PARAM_`
values. Defaults are resolved per build (R-32, R-34), so the `PARAM_` set
a delete script receives can differ from the one its create used. A
create script that makes a resource MUST either name it only from the
contract's ids (`APPLICATION_ID`, `CELL_ID`, `TENANT_ID`), or record its
identifier in its namespace **before** creating it. A create that fails
partway goes to `CREATE_FAILED`, whose remedy is delete, not a create
retry, so the delete must find the resource from what was recorded or
from the ids alone.

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
`CreateDeployment` into that account presents it, and it reaches the build as a
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

Placement happens **synchronously inside `CreateDeployment`**, before the
workflow starts. It embodies P-5, P-6, P-7, and P-11 simultaneously.

### 7.1 Algorithm

```
0. TARGET    — read the tenant record; missing → 404.
               read the application record; missing → 404. Its
               definition is the stamp for a new cell (step 3).
               An account ADMITS the application when its
               applicationIds is absent (shared) or contains the
               id (dedicated).
               accountId given:
                 read the account record; missing → 404;
                 does not admit the application → 400.
                 eligible accounts = [that account] (any owner).
                 candidate cells   = that account's cells (the
                                     ACCOUNT#<id> → CELL# index)
                                     with this applicationId.
               accountId absent:
                 eligible accounts = registered accounts with
                                     owner = VENDOR that admit the
                                     application; dedicated ones
                                     first, then shared; within each
                                     group ordered by the application's
                                     placementStrategy:
                                       FILL        → oldest registered
                                                     first
                                       ROUND_ROBIN → fewest cells first
                                                     (cellCount as read),
                                                     ties oldest first
                 candidate cells   = the application's cells (the
                                     APPLICATION#<id> → CELL# index)
                                     whose accountId is in that set,
                                     oldest first regardless of group
                                     or strategy.
               Tenant-owned accounts are never eligible without a target.
1. NOMINATE  — filter candidate cells: status=ACTIVE AND
               tenantCount < maxTenants; order oldest first.
2. CLAIM     — for each candidate (bounded: at most 5 attempts), one
               transaction:
                 • cell:       tenantCount += 1
                               IF status = ACTIVE AND tenantCount < maxTenants
                 • tenant:     deploymentCount += 1
                               IF exists
                 • deployment: insert {status: CREATING, cellId: <candidate>}
                               IF not exists
                 • [idempotency record: insert IF not exists — only when
                    clientToken supplied; always the LAST item so its
                    cancellation index is fixed]
               outcomes:
                 success                       → placed; start workflow
                 idempotency condition failed  → REPLAY (see 7.3) — takes
                                                 precedence over every
                                                 other classification
                 deployment condition failed   → the tenant already has
                                                 this application → 409;
                                                 stop
                 tenant condition failed       → tenant deleted meanwhile
                                                 → 404; stop
                 capacity/status cond. failed  → lost a race; next candidate
                 anything else / ambiguous     → FAIL the request; never
                                                 retarget the same
                                                 deployment after an
                                                 ambiguous transaction
                                                 outcome
3. CREATE    — no candidate claimed (none found, or budget exhausted):
               for each eligible account in order, one transaction:
                 • account:     cellCount += 1
                                IF exists AND cellCount < maxCells
                 • application: cellCount += 1
                                IF exists
                 • cell:        insert {status: CREATING,
                                applicationId, accountId: <account>,
                                tenantCount: 1 (slot PRE-CLAIMED),
                                definition stamped from the application
                                record read in step 0} IF not exists
                 • tenant:      deploymentCount += 1
                                IF exists
                 • deployment:  insert {status: CREATING, cellId: <new>}
                                IF not exists
                 • [idempotency record as above — still the LAST item]
               outcomes:
                 success                        → placed; start workflow
                 idempotency condition failed   → REPLAY (7.3)
                 deployment condition failed    → already deployed → 409;
                                                  stop
                 tenant condition failed        → tenant deleted → 404; stop
                 account condition failed       → account full (or deleted
                                                  meanwhile); next account
                 application condition failed   → application deleted
                                                  meanwhile → 404; stop
                 anything else / ambiguous      → FAIL the request
               every eligible account refused   → 409 InsufficientCapacity
                                                  (nothing was written)
```

The account claim nominates from the account listing index and decides on
the base record, exactly as the cell claim does (P-5): a stale read may
nominate a full account; the condition rejects it. Reading
`ListAccounts`-style data to skip obviously full accounts is an
optimisation an implementation MAY add; it is never the guard. The
application and tenant claims have no capacity condition — neither has a
limit — but they MUST be conditional on existence, so a cell is never born
counting toward an application, and a deployment never toward a tenant,
that was deleted between step 0 and the transaction. The deployment insert
is the uniqueness guard: one deployment per tenant per application, decided
by the write, not by the step 0 read.

The account order in step 3 fills a dedicated account before a shared one
([ADR-035](../adr/0035-new-cells-go-to-dedicated-accounts-before-shared-ones.md)):
a dedicated account exists to be used first, and shared capacity stays for
applications that have nothing else. Inside a group the application's
`placementStrategy` orders the accounts
([ADR-036](../adr/0036-the-application-chooses-fill-or-round-robin-across-accounts.md)):
`FILL` exhausts one account before touching the next, `ROUND_ROBIN` gives
the next cell to the account with the fewest cells. Both orders are read
from the account scan, so they nominate (P-5): a stale `cellCount` can
send a round-robin cell to an account that is one cell fuller than the
best one — tolerated, never corruption (§7.2). Step 1 does not group or
order by strategy: a cell with room is reused before a new one is created,
wherever it is (P-7).

**R-16 (nomination vs decision):** step 1's read is an optimisation, never
a guard. Correctness lives entirely in step 2's conditions. Do NOT
"simplify" the claim into a plain write (P-5).

**R-17 (atomic birth):** the claim, the tenant's count and the deployment
record MUST be created in one transaction; the new-cell path MUST pre-claim
the deployment slot in the same insert **and** claim the account's and the
application's cell slots in the same transaction (P-6). A cell record never
exists without its account slot held and its application counting it; a
deployment record never exists without its cell slot held and its tenant
counting it.

**R-18 (bounded work):** the candidate loop MUST be bounded so
`CreateDeployment`
stays inside the synchronous gateway window. The miss case — every attempt
loses a race on a cell that read as ACTIVE with room — falls through to
new-cell creation: over-provisioning rather than a failed placement (P-7).
When that fall-through meets a full fleet, the request MUST fail with a
retryable `ConflictError`, not `InsufficientCapacityError`: the candidates
were there moments ago and the fleet is changing under the request, so a
retry may succeed where a terminal error would be wrong
([ADR-031](../adr/0031-lost-placement-races-on-a-full-fleet-are-a-retryable-conflict.md)).
The account loop is bounded by the number of eligible accounts, which is
operator-controlled and small.

**R-28 (fleet full is terminal for the request):** when every eligible
account refuses the claim, `CreateDeployment` MUST fail with
`InsufficientCapacityError` and MUST NOT create an account, widen a limit,
or place into an ineligible account. Capacity is an operator decision
(P-10); the control plane reports that it ran out.

### 7.2 Tolerated races (MUST be documented, MAY remain open)

- Two concurrent no-capacity placements both create a cell → one extra
  cell, **bounded by `maxCells`**: the account claim turns unbounded
  over-provisioning into at most `maxCells` cells per account.
- Placements while the only cell is `CREATING` create further cells
  (placement requires `ACTIVE`), again up to `maxCells`.
- Two placements racing for an account's last cell slot: one claims, the
  other moves to the next eligible account or gets the 409. No corruption.
- Five consecutive lost claims on candidate cells, on a fleet with no free
  cell slot: the request fails with `ConflictError` and nothing is written;
  the client retries against the fleet as it then is (R-18, ADR-031).
- Oldest-first ordering funnels concurrent claims at the same candidate —
  one cancelled transaction per contended cell before spreading. At
  production scale, randomise candidate order or use power-of-two-choices.
- Two applications placing at once into one shared account contend for
  the same cell slots; each loses at most one account claim per slot and
  moves on. Nothing an application does changes another's counters: the
  application counter is only ever claimed in a transaction that also
  creates one of its own cells.
- Two concurrent `CreateDeployment` calls for the same tenant and
  application: one inserts, the other's deployment condition fails → 409.
  Two for the same tenant and *different* applications both succeed and
  both increment `deploymentCount`; the counter is a plain `ADD`, so the
  order does not matter.
- Under `ROUND_ROBIN`, two concurrent new-cell placements read the same
  `cellCount` and pick the same account; both land there if it has two
  free slots, leaving the spread one cell uneven until the next placement
  corrects it. Nomination, not a guard (P-5).
- `PutApplication` replaces the parameter declarations while a
  `CreateDeployment` or `UpdateDeployment` is between its read of the
  application and its write. The request is validated against the
  declarations it read, and the build gets the values that passed. A
  parameter made required in between is missing from that build only;
  the script fails fast (§6.2) or ignores it, and the next
  `UpdateDeployment` is checked against the new set. The same holds for
  `cellParameters` and an `UpdateCell` in that window. Nomination, not a
  guard (P-5).
- A cell stuck `UPDATE_FAILED` removes its remaining capacity from the
  fleet until an operator re-runs `UpdateCell`; placements meanwhile fill
  other cells or create new ones. Visible in `ListCells`.

All over-provision; none corrupts (P-7).

### 7.3 Idempotent replay (P-11)

A request carrying a `clientToken` MUST first read the token's idempotency
record and, when one exists, replay from it before placement runs. The
read only nominates: a token written between the read and the transaction
still cancels the transaction and is classified there (P-5). Replaying
first means a retry gets the original outcome even when the fleet changed
in between — an account narrowed or filled since the first call, or a
parameter made required since, must not turn the retry into a 400 or a
capacity error. The replay read therefore runs before parameter
validation (R-33) as well as before placement.

On a cancelled idempotency condition, or on a record found by that read:

- request hash matches → return the **original deployment**, whatever its
  current lifecycle status (200-shaped 202 response semantics: same
  outcome as the original call);
- hash differs, or the deployment was since deleted, or the record vanished
  in the TTL race between transaction and read → **409**.

The request hash covers every request input, `tenantId`, `applicationId`,
`accountId` and the `parameters` map (in a canonical, name-sorted form)
included: the same token reused for another application or with other
parameter values is a different request, hence a 409. An absent map and
an empty map `{}` are the same request, and both hash exactly as a request
did before parameters existed (the map is left out of the hash input when
empty), so a token issued before the upgrade still replays inside its
window.

### 7.4 Compensation and the residual gap

**R-19:** if starting the workflow fails *after* the placement transaction,
the service MUST conditionally compensate the exact in-flight state:
existing-cell placement → deployment `CREATING → CREATE_FAILED`; new-cell
placement → **both** records to `CREATE_FAILED` in one transaction (never
leave only one record recoverable). Both land on the documented remediation
path. The account's cell slot and the application's count stay claimed by
the `CREATE_FAILED` cell — exactly as a `CREATE_FAILED` deployment keeps
its cell slot and its tenant's count — and are released by `DeleteCell` on
the remediation path. Compensation never touches a counter.

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
| `CreateDeployment` into an existing cell | — | create |
| `CreateDeployment` requiring a new cell | create | create |
| `UpdateDeployment` | — | update |
| `DeleteDeployment` | — | delete |
| `UpdateCell` | update | — |
| `DeleteCell` | delete | — |

### 8.1 Resolved input

**R-20:** the service MUST resolve everything the workflow needs — source,
script paths (from the cell's stamp, never from the application record),
failure statuses, ids including the `tenantId` and `applicationId`, the
tenant's `name`, the deployment's resolved parameter set (R-32), the
cell's resolved parameter set (R-34) when the execution has a cell build, the
cell's `accountId`, the two provisioning role ARNs derived from it, and
the account's `externalId` — into the execution input. The workflow MUST NOT re-read mutable records to
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
metadata. The `parameters` map on a deployment or cell is owned by its
create and update requests (R-33, R-34); workflow terminal writes MUST
NOT touch it.

**Payload budget:** each resolved parameter set holds at most 40 entries
(20 stored, stale ones included, plus up to 20 defaults) of at most 1,088
bytes (a 64-byte name and a 1,024-byte value), about 43 KiB raw. The
execution input is JSON. With control characters refused (R-33), only
`"` and `\` need escaping, so a value grows at most twofold: about 87 KiB
per set. A new-cell create carries a cell set and a tenant set, about
174 KiB, inside the 256 KiB Step Functions limit with the rest of the
R-20 input. That limit applies to every state's payload, not only the
input, and a CodeBuild `Build` result echoes the build's environment
variables, values included. So each build task MUST keep only what the
terminal writes read (a `ResultSelector` holding the build ARN and
status); a full result kept in state would add a second copy of each
parameter set and pass the limit. Keeping the results small also keeps
the values out of execution history a second time (N-11).

### 8.2 Terminal writes

- **create/update success** → compare-and-set in-flight → `ACTIVE` +
  `lastBuildId`.
- **deployment delete success** → **one transaction**: delete the
  deployment (condition: exists AND status = `DELETING`) + decrement the
  cell counter (condition: exists AND `tenantCount > 0`) + decrement the
  tenant's `deploymentCount` (condition: exists AND `deploymentCount > 0`)
  (P-6). After a committed delete, an identical replayed transaction
  cancels on those conditions before changing a counter; the workflow then
  reads the deployment — **absence proves the prior delete committed
  (success)**, presence is a real failure (`DELETE_FAILED`). Item-state
  conditions, not token windows, are the durable replay guard (P-11). The
  tenant record always exists here, because `DeleteTenant` refuses while
  `deploymentCount > 0`.
- **cell delete success** → **one transaction**: delete the cell
  (condition: exists AND status = `DELETING` AND `tenantCount = 0`) +
  decrement the account's `cellCount` (condition: exists AND
  `cellCount > 0`) + decrement the application's `cellCount` (same
  condition) (P-6) — the mirror of the deployment delete one level up.
  Same absence-is-success read on cancellation: a missing cell proves the
  prior transaction committed; a present cell becomes `DELETE_FAILED`. The
  account and application records always exist here, because
  `DeleteAccount` and `DeleteApplication` refuse while `cellCount > 0`.
- **build start** → every build task first assumes the resolved
  provisioning role (with the resolved `externalId`, session name =
  `OPERATOR_ID`) and runs the script under those credentials (§6.1). A
  refused AssumeRole is a build failure like any other: it lands in the
  operation's `*_FAILED` status with the refusal in `statusReason` — which
  is what a customer revoking the pair looks like from the control plane.
- **build failure / task timeout** → compare-and-set from the operation's
  in-flight status to the resolved `*_FAILED` status + `statusReason`. For
  a failed **cell create with a pending deployment create**, one
  transaction moves *both* records to `CREATE_FAILED` (the deployment's
  reason: "cell provisioning failed").

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
| N-11 | Deployment and cell parameter values MUST NOT be secrets. They are stored in plain text on the deployment or cell record, returned by `GetDeployment` or `GetCell`, and reach the build as CodeBuild environment-variable overrides carried in the Step Functions execution input. The service logs parameter names, never values. A script that needs a secret receives its *name* as a parameter (a Secrets Manager secret or an SSM `SecureString` under the deployment's tenant namespace or the application's shared namespace, §6.2) and reads it under its own role. | Everyone who can read the table, the execution history or `codebuild:BatchGetBuilds` in the control plane account can read the values; secret-shaped storage would need a KMS key, extra IAM and a second read path for a concern the application plane already solves. |

---

## 10. Acceptance Criteria

A correct implementation demonstrably passes the following end-to-end
scenario against real infrastructure in **two accounts** with **two
applications** and **two tenants** (this mirrors the reference integration
test). Account A is the control plane's own account; account B is a second
account with the role pair installed under an `externalId`. Applications X
and Y share the same source and scripts and differ in id and in their parameter declarations; both have
`maxTenants = 1` (every cell is a silo, so cells — not deployments — are
what the accounts count). Tenants T1 and T2 are plain records. X declares
parameters (step 2); every `CreateDeployment` of X supplies
`ALLOWED_EMAIL_DOMAIN = example.com` unless a step says otherwise.

1. **Auth:** an operation without a JWT is rejected; with a valid vendor
   IdP JWT it succeeds.
2. **Applications:** `PutApplication` with a missing script path → 400;
   with an id outside the charset → 400; `PutApplication` X and Y → 200;
   `ListApplications` shows both with `cellCount = 0`; `PutAccount` naming
   an unregistered application in `applicationIds` → 404. X declares two
   parameters, `ALLOWED_EMAIL_DOMAIN` (required) and `LOG_LEVEL` (default
   `info`), and one cell parameter, `CELL_SIZE` (default `small`); a
   declaration named in lower case, a duplicate name, a required
   parameter with a default, a cell parameter without a default, or one
   name in both lists → 400.
3. **Handshake:** `PutAccount` for an account with no role pair → 400;
   `PutAccount` B as `TENANT` without `externalId` → 400; with the wrong
   `externalId` → 400 naming the role; `PutAccount` A (`VENDOR`,
   `maxCells = 2`, shared) and B (`TENANT`, `maxCells = 1`, `externalId`,
   `applicationIds = [Y]`) → 200; `ListAccounts` shows 0/2 and 0/1 with
   `maxCells` and B's `applicationIds`; `GetAccount` B does not return the
   `externalId` value.
4. **Tenants are synchronous:** `CreateTenant` T1, T2 and T3 → 200 with
   `deploymentCount = 0`, no cell created, no build started;
   `ListTenants` shows three; `UpdateTenant` T3 edits metadata;
   `DeleteTenant` T3 → 200 (empty); `CreateDeployment` for T3 → 404;
   `CreateDeployment` for an unregistered application → 404.
5. **Implicit creation in the home account:** `CreateDeployment` T1/X
   without `ALLOWED_EMAIL_DOMAIN`, or with an undeclared parameter → 400,
   nothing written. `CreateDeployment` T1/X with
   `ALLOWED_EMAIL_DOMAIN = example.com` and an empty fleet creates cell 1
   in A (`CREATING → ACTIVE`), then the
   deployment; `GetDeployment` T1/X reports `cellId`, the stamped
   definition and `parameters = {ALLOWED_EMAIL_DOMAIN: example.com}`,
   `GetCell` reports `accountId = A` and `applicationId = X`;
   the cell namespace and `/application-plane/tenants/T1/X/*` exist
   **in A**, and the tenant create script recorded there that it received
   `PARAM_ALLOWED_EMAIL_DOMAIN = example.com` and `PARAM_LOG_LEVEL = info`;
   the cell create script recorded `PARAM_CELL_SIZE = small` and no
   tenant parameter, and `GetCell` reports empty `parameters`. Account A is 1/2; X has `cellCount = 1`; T1 has
   `deploymentCount = 1`.
6. **One tenant, two applications:** `CreateDeployment` T1/Y without a
   target creates cell 2 in A (B is tenant-owned and never chosen
   untargeted; cell 1 belongs to X and is never a candidate for Y).
   Account A is 2/2; Y has `cellCount = 1`; T1 has `deploymentCount = 2`.
   `ListDeployments?tenantId=T1` returns both; `?applicationId=X` returns
   exactly T1/X; `ListCells?applicationId=X` returns exactly cell 1. Each
   cell's scripts read their own application's shared namespace
   (`/application-plane/applications/X/shared/*` vs `.../Y/shared/*`) and
   T1's two deployments write disjoint tenant namespaces.
   `CreateDeployment` T1/X again → 409 `ConflictError` (already deployed);
   `DeleteTenant` T1 → 409 (occupied).
7. **Idempotent replay:** re-sending T1/X's request with the same
   `clientToken` returns the original deployment (no second deployment, no
   new cell, A still 2/2, T1 still 2); the same token with a different
   `applicationId`, or with a different `ALLOWED_EMAIL_DOMAIN`, is a 409.
8. **Fleet full for one application:** `CreateDeployment` T2/X without a
   target → 409 `InsufficientCapacityError` (A is full, B is tenant-owned);
   no deployment, cell, tenant count, account or application changed.
9. **Admission:** `CreateDeployment` T2/X with `accountId = B` → 400 (B
   admits only Y); nothing changed.
10. **Targeted creation in the second account:** `CreateDeployment` T2/Y
    with `accountId = B` creates cell 3 in B; `GetCell` reports
    `accountId = B`, `applicationId = Y`; the cell namespace and
    `/application-plane/tenants/T2/Y/*` exist **in B** and do not exist in
    A. Account B is 1/1; Y has `cellCount = 2`; T2 has
    `deploymentCount = 1`. An in-flight mutation on T2/Y while `CREATING`
    → 409.
11. **Account full:** `CreateTenant` T4, then `CreateDeployment` T4/Y with
    `accountId = B` → 409 `InsufficientCapacityError`; `DeleteAccount` B →
    409 (occupied); `DeleteApplication` Y → 409 (occupied); `PutAccount` B
    with a different `owner` → 409; `DeleteTenant` T4 → 200.
12. **Reads:** `ListCells` shows three cells with their `accountId` and
    `applicationId`; `ListCells?accountId=A` returns exactly cells 1 and 2
    and an unknown account yields an empty page; `ListDeployments?cellId=`
    and `?applicationId=Y` filter correctly, two filters at once → 400;
    `GetDeployment`/`GetCell` return the stamped definition, the account
    and the application; `UpdateTenant` T1 edits metadata without touching
    `deploymentCount`; `PutApplication` Y with a new `maxTenants` leaves
    cells 2 and 3 stamped as before.
13. **Re-apply across accounts:** `UpdateDeployment` T1/X (in A) and
    `UpdateCell` on cell 3 (in B) run the update scripts under the
    respective account's provisioning role, with `APPLICATION_ID`,
    `TENANT_ID` and `TENANT_NAME` set, and return to `ACTIVE`.
    `UpdateDeployment` T1/X with `parameters = {LOG_LEVEL: debug}` keeps
    `ALLOWED_EMAIL_DOMAIN`, and the update script records both values;
    `removeParameters = [ALLOWED_EMAIL_DOMAIN]` → 400 (required), and the
    same name in both lists → 400, with the stored values unchanged.
    `UpdateCell` on cell 1 with `parameters = {CELL_SIZE: large}` stores
    the value and the cell update script records `PARAM_CELL_SIZE = large`
    and no tenant parameter; `UpdateCell` with `LOG_LEVEL` (a tenant
    parameter) or an undeclared name → 400, and `UpdateDeployment` T1/X
    with `CELL_SIZE` → 400, nothing written; `UpdateCell` with
    `removeParameters = [CELL_SIZE]` empties the map and the update build
    of that same call gets `small` again. A value holding a control
    character → 400. Cells 2 and 3 and the tenant scripts of T1/Y and
    T2/Y (application Y) recorded no `PARAM_` variable in any build.
14. **Declarations change under live records:** `PutApplication` X
    re-sent with its definition and no parameter lists keeps both
    lists (`GetApplication` shows them unchanged). `PutApplication` X
    then sends `parameters = [ALLOWED_EMAIL_DOMAIN (required), LOG_LEVEL
    (default warn)]` and `cellParameters = [CELL_SIZE (default medium)]`.
    `UpdateDeployment` T1/X with `removeParameters = [LOG_LEVEL]` → 202,
    and the update script records `PARAM_LOG_LEVEL = warn` (an existing
    deployment falls back to the changed default). `UpdateCell` on cell 1
    with an empty body records `PARAM_CELL_SIZE = medium` (the new
    default reaches an existing cell). `PutApplication` X then sends
    `parameters = [LOG_LEVEL (default warn), TIER (required)]` and no
    `cellParameters`, dropping `ALLOWED_EMAIL_DOMAIN` and keeping
    `CELL_SIZE`. `UpdateDeployment` T1/X with an empty body → 400 naming
    `TIER`, nothing written. No `TIER` is supplied to T1/X. From here on
    every `CreateDeployment` of X supplies `TIER = gold` instead of
    `ALLOWED_EMAIL_DOMAIN`.
15. **Reuse before create:** `DeleteDeployment` T1/X frees its slot
    (transactionally); cell 1 stays, empty, account A stays 2/2, X stays at
    `cellCount = 1` (the cell slot is held by the cell, not the
    deployment), T1 drops to `deploymentCount = 1`. `CreateDeployment`
    T2/X without a target places it into cell 1 — no new cell, no 409.
    T1/X's delete ran although T1/X lacks the now-required `TIER` (a
    newly required parameter never blocks a delete). Its tenant delete
    script recorded the stale `PARAM_ALLOWED_EMAIL_DOMAIN = example.com`
    (no longer declared, still passed), `PARAM_LOG_LEVEL = warn` (the
    default) and no `PARAM_TIER`.
16. **Teardown:** deleting all deployments frees their slots and every
    tenant's `deploymentCount` returns to 0; deleting the now-empty cells
    removes them **and releases the account and application slots**
    (A → 0/2, B → 0/1, X and Y → `cellCount = 0`); `DeleteTenant` T1 and
    T2 → 200; `DeleteAccount` A and B → 200; `DeleteApplication` X and Y →
    200; `ListTenants`, `ListAccounts` and `ListApplications` are empty;
    the parameter namespaces in **both** accounts end empty. Cell 1's
    delete script recorded `PARAM_CELL_SIZE = medium`; T2/X's tenant
    delete script recorded `PARAM_TIER = gold` and `PARAM_LOG_LEVEL =
    warn` (a default) and no `PARAM_ALLOWED_EMAIL_DOMAIN`. Every
    operation has run at least once.

Plus unit-level assertions that no state-dependent write path is
unconditional (P-5), that
exactly two code paths mutate each of `tenantCount`, `deploymentCount` and
the two `cellCount`s (P-6), that `PutAccount`, `PutApplication`,
`CreateTenant` and `UpdateTenant` never write a counter (R-24, R-29,
§4.3), that untargeted placement into a fleet with a
shared vendor account registered before a dedicated one creates the new
cell in the dedicated account ([ADR-035](../adr/0035-new-cells-go-to-dedicated-accounts-before-shared-ones.md)),
and that with two shared accounts at 1/2 and 0/2 a `FILL` application
creates its next cell in the first and a `ROUND_ROBIN` application in the
second ([ADR-036](../adr/0036-the-application-chooses-fill-or-round-robin-across-accounts.md)).

---

## 11. Extension Seams (documented, not built)

Per P-1, deferred generality is recorded as seams, not code:

| Extension | Seam |
|---|---|
| Standalone resource service (pooled/hybrid re-split) | extract at the deployment collection (`/tenants/{tenantId}/deployments`); the deployment is already the tenant↔cell join; propagate terminal status back via event push or M2M-authenticated polling |
| Definition-replacing field on the `UpdateCell` body | noted extension; the body carries cell parameter values only (R-34); today the stamped definition is immutable and a replaced application definition reaches only new cells |
| Per-application cell cap inside a shared account | a join record per (account, application) with its own counter and cap, layered under the account's `maxCells` ([ADR-033](../adr/0033-account-admission-is-an-application-allowlist-on-the-account.md), option 3); today an account admits applications but does not meter them separately |
| A role pair per application | would make the application a deployment unit again and give each one its own trust boundary in every account; today one pair per account serves every application it admits, and the scripts of one application can read another's cell namespace in the same account (trusted vendor code, §6.3) |
| Explicit capacity pre-provisioning (`POST /cells`) | deliberately absent; placement is the only creator |
| Per-operation authorization matrix | authorizer already forwards `role`; caller context already carries it |
| Secret deployment parameters | a `secret` flag on the declaration, with the value stored as a reference to a control-plane-owned secret and resolved only inside the build; today a script receives a secret's name as a plain parameter and reads it under its own role (N-11) |
| Cell parameter values at birth | a body on the pre-provisioning seam (`POST /cells`) or a per-account override map; today a new cell always starts on the declared defaults and differs only after `UpdateCell` (R-34). Values that differ per account belong in the application's shared namespace in that account (§6.2) |
| Stuck-execution sweep for aged transitional records | covers the two documented stranding gaps (§7.4, R-22) |
| Auto-scale-in (delete after N days empty) | business plane policy layered on the explicit `DeleteCell` and `DeleteAccount` APIs |
| A Region per account | an `accountId`-plus-`region` target on the account record; the build runner's AssumeRole already yields credentials usable in any Region, so the seam is the account record and the scripts' Region input, not the trust model |
| Account vending | an upstream system creates the account and installs the role pair, then calls `PutAccount`; the control plane's contract starts at registration |
| Per-account placement policy (drain, prefer, weights) | today: `owner` and `applicationIds` decide eligibility, `maxCells` decides capacity, dedicated accounts are filled before shared ones, and the application's `placementStrategy` orders the rest; a `placement` field on the account record is where a per-account policy would live |
| Load-aware placement | a strategy that reads what the cells are doing (utilisation, cost, latency) rather than how many there are; the `placementStrategy` enum is where it would be added, the account scan is where the signal would be joined in |
| Tenant migration between cells or accounts | would need a tenant-level transitional status spanning two cells and two counters; deliberately excluded |

---

## 12. Reading Order for Implementers

1. §2 (principles) — internalise P-5 and P-6 before writing any data code.
2. §4 + §5 — model the entities and the API contract first (P-2); generate,
   don't hand-write, the API layer.
3. §7 — implement placement with its transactions exactly as specified,
   the account and application claims included; this is where correctness
   is won or lost.
4. §8 — the workflow; resolved input and field ownership are not optional
   niceties.
5. §6 + §9 — the script contract, the role asymmetry, and the account role
   pair that carries it into every account.
6. §10 — build the acceptance test alongside, not after; it needs two
   accounts and two applications from the first run.

The reference implementation's `architecture.md` and `adr/`
carry the detailed rationale behind each requirement — consult them when a
requirement here seems arbitrary; it almost certainly isn't.

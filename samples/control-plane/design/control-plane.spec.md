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

Vendors of multi-tenant applications need a **control plane**: the
management layer that onboards tenants, provisions their deployments,
tracks lifecycle state, and offboards them. Most published control plane
examples are either toy CRUD APIs (no real provisioning) or sprawling
platforms (dozens of services obscuring the core ideas).

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
- Finer operator roles (an application registrar apart from an onboarder,
  operators scoped to accounts) and a sweep for stranded in-flight records
- Hooks on tenant record events and on account events: vendor hooks
  (§6.5) run on cell and deployment events only

### 1.3 What this control plane is NOT

The control plane manages *deployments of* the application plane; it never
becomes part of it. These are application plane concerns and stay out by
design:

- What a deployment contains — infrastructure, code, configuration and
  data are the provisioning scripts' business; the control plane records
  that a deployment exists and whether its last build succeeded. It
  carries the deployment's declared parameter values to the scripts
  (§6.1) without knowing what they mean
- Serving tenant traffic, or routing tenants to their cells. A vendor
  hook (§6.5) can tell a routing system that a cell or deployment
  exists; the routing is that system's
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

- The global hook *is* an entity by the same test: it holds a hook
  definition and its revision, which no neighbour stores, and operators
  register it explicitly. An application hook is not: it is part of its
  application's definition and is stamped with it, like the scripts.

The result: **one service, one API, one table, one workflow, four build
projects (two that provision, two that run vendor hooks), and one role
pair per account — for any number of applications.** An
implementation of this spec MUST NOT introduce additional services,
tables, or workflows unless a requirement below is unimplementable
without them.

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
- Systems that must act on a cell's or a deployment's lifecycle from the
  vendor's side are **vendor hooks** (§6.5,
  [ADR-044](../adr/0044-run-vendor-hooks-around-cell-and-deployment-scripts.md)):
  vendor code the workflow runs before or after a script, in the control
  plane account. The control plane decides when a hook runs and what its
  failure does to the operation. It never reads what the hook does, and it
  hands a script's outputs to a post hook without reading them.
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
**definition** — source + cell scripts + tenant scripts +
`maxTenants` + application hooks, held on the application record
(§4.1) — and the definition is **stamped immutably onto each cell record
at creation**
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
claimed and released in those same two transactions. The hook counter's
`hookCount` — *every registered global hook is counted once* — is claimed
in the transaction that creates a global hook and released in the one
that deletes it (§4.8). Five counters, two code paths each, all ten
transactional.

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
- A stamped application hook that fails on every run keeps its cell's
  creates or updates failing, because every retry runs the same stamp.
  Its exits are in §8.3: fix forward on an unpinned ref, or, for a hook
  pinned to a commit, the destructive exit (delete the cell's
  deployments, then the cell). Gates and registrars therefore belong in
  global scope, where `PutHook` replaces them.

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
- The trust model is stated, not implied: the issuer is declared a
  dedicated control-plane trust boundary, and it mints at most two kinds of
  caller. An **operator** holds every operation. A **reader** holds the
  read operations and nothing else, so a system that only needs to look
  placement up (a route registrar, a dashboard) never holds a credential
  that can change the fleet. The matrix is complete for those two roles;
  finer operator roles are a recorded seam (§11).

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

Vendor hooks (§6.5) are the second arbitrary-code surface, and they sit
on the other side of the same line. They run in the control plane
account, in two hook build projects of their own, under two hook roles
(`<fleet>-global-hook`, `<fleet>-app-hook`) that hold only what the
deployer attaches. No pair trusts either role, and neither may assume a
pair. Code that holds an account's pair and code that must act where
that account cannot reach never share a role or a project, and an
application hook never shares a role with a global hook. Whoever can
start a hook build runs code as its role, so only the workflow may
start one (R-41).

---

## 3. System Shape

### 3.1 Required components

| # | Component | Requirement |
|---|---|---|
| R-1 | **API layer** | One HTTP API, generated from the interface model (P-2), fronting one service. REST semantics, JSON protocol. |
| R-2 | **Authorizer** | Every operation MUST require a JWT from the vendor IdP (OIDC issuer URL + audience are deployment-time inputs, plus the client ids accepted on a token without an audience and the scope such a token must carry, R-38), validated via the issuer's JWKS. There are no unauthenticated operations. |
| R-3 | **Service** | One stateless compute function implementing all operations, including synchronous placement, the tenant registry, the application registry and the account registry. |
| R-4 | **Store** | One database table holding all six entity types (application + account + cell + tenant + deployment + global hook) plus the idempotency record type and the hook counter, with support for multi-item ACID transactions and conditional writes. (The reference uses DynamoDB single-table design; any store with equivalent transactional conditional-write semantics qualifies.) |
| R-5 | **Workflow** | One durable state machine executing provisioning builds and writing terminal state directly to the table. |
| R-6 | **Build runners** | **Four** shared build projects: two provisioning projects (cell builds, tenant builds) and two hook projects (global hooks, application hooks, R-41). Per-execution overrides select the source and script; the projects themselves are never mutated per deployment, cell, account or hook. Before the script runs, each provisioning build assumes its half of the hosting account's provisioning role pair (R-25), so the script executes with that account's permissions. The provisioning projects' own roles may only assume those roles, read the source, and write their logs; each build role trusts CodeBuild only on its own project's `aws:SourceArn` and carries the R-41 deny. The hook projects' roles never assume a pair (R-41). |
| R-25 | **Account role pair** | One deployable unit (reference: a CDK stack) that installs `<fleet>-cell-provisioning` and `<fleet>-tenant-provisioning` in an account with the asymmetric permissions of §6.2, trusting the control plane's two build roles and its API role (the registration probe, R-26) — and an optional external id. The account owner deploys it; the control plane stack installs the same pair in its own account so the home account needs no extra step (P-4). |

```
Vendor operator ──JWT──► API + Authorizer ──► Service (sync ops, placement,
                                                 │        application + account
                                          202 async ops       ▲        registries)
                                                 ▼            │ terminal status
  hook builds (shared projects) ◄──────── Workflow ──► cell build │ tenant build
  in the control plane account                          (shared projects)
  <fleet>-global-hook                                        │ AssumeRole
  <fleet>-app-hook                   ┌───────────────────────┴──────────────────────┐
  no pair trust, no AssumeRole       ▼                                              ▼
                        account A (vendor-owned, shared)            account B (tenant-owned)
                        <fleet>-cell-provisioning                   <fleet>-cell-provisioning
                        <fleet>-tenant-provisioning                 <fleet>-tenant-provisioning
                        /application-plane/* (SSM)                  /application-plane/* (SSM)
                        cells 1..maxCells                           cells 1..maxCells
                          app X cells, app Y cells                    app Y cells
```

The two hook builds run in the control plane account under the hook
roles. No pair trusts either role and neither assumes a role, so no
line leaves them for an account (R-41).

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
- Authorization is by the `role` claim, under an explicit assumption that
  MUST be documented: the configured issuer is a dedicated control-plane
  trust boundary that mints `role` only for the two populations of P-10.
  The claim is never fabricated: a token without it, or with a role in
  neither set, is denied. Connecting any broader issuer REQUIRES finer
  roles first (§11).

**R-36 (role matrix,
[ADR-042](../adr/0042-a-read-only-role-beside-the-operator.md)):** the
authorizer MUST map the verified `role` claim to one of two grants:

| Role set (stack input) | Grant | Operations |
|---|---|---|
| `allowedRoles` (default `operator`) | operator | all twenty-six |
| `readerRoles` (default none) | reader | the twelve `GET` operations: `GetTenant`, `ListTenants`, `GetDeployment`, `ListDeployments`, `GetCell`, `ListCells`, `GetAccount`, `ListAccounts`, `GetApplication`, `ListApplications`, `GetHook`, `ListHooks` |

The grant is the authorizer's IAM policy, and the policy is a function of
the grant alone, never of the method the request named: an operator's
policy allows `execute-api:Invoke` on `<api>/<stage>/*`, a reader's on
`<api>/<stage>/GET/*`, whichever operation filled the token-keyed result
cache. A reader whose first call is a write therefore caches its read
grant, not a `Deny` that would block its reads for the cache window, and
API Gateway refuses the write with 403 before any code runs. The service
MUST check again, by operation name: a reader may run only the twelve read
operations listed above, and every other operation requires the
`operator` grant and refuses any other with 403
(`UnauthorizedError`); a caller context with no grant is an ingress fault,
500, as a missing `operatorId` is. A service unit test covers that wall,
because the integration test can only reach the first. The caller context
carries the grant beside `operatorId` and `role`, and the access log
records it.

The role lists reach the authorizer as `ALLOWED_ROLES` and
`READER_ROLES`, comma-separated. `ALLOWED_ROLES` unset or empty means
`operator`; `READER_ROLES` unset or empty means no reader. Either set but
yielding no names (`",,"`) throws at cold start, and so does a value in
both lists, so an edit to the function's environment after deploy fails
closed like a bad stack input does.

**R-37 (reads are reads):** every `GET` operation MUST write nothing,
start no execution or build, and return no secret. The reader grant is
defined by method in the authorizer policy, so a new `GET` widens the
first wall; the service lists the reader operations by name, so a new
`GET` reaches readers only once it is added to that list too. This rule
is what keeps the widening safe, and a `GET` that cannot meet it is a
different method and a new matrix row. Today's reads return no `adminEmail`
(never stored, R-8) and no `externalId` (never returned, N-10). They do
return parameter values, which are not secrets by contract only (N-11,
T35), and the source location and version of every application and every
hook (§4.8), which name the repository a supply-chain attacker would target
(T34).

**R-38 (machine clients,
[ADR-043](../adr/0043-accept-listed-client-ids-when-a-token-has-no-audience.md)):**
the authorizer MUST verify the signature (`RS256`), issuer, `exp` and
`sub` once, without an audience, and then MUST take exactly one of two
paths on the verified payload, chosen by whether the `aud` key is
present (`payload.aud !== undefined`):

| Token | Check | Example |
|---|---|---|
| `aud` present, any value | `aud` equals `audience`, or is an array that contains it; no fallback | a person's Cognito ID token |
| `aud` absent | `client_id` is a string in `clientIds` and equals `sub`; when `requiredScope` is set, the space-separated `scope` claim holds it as a whole token | a Cognito client-credentials access token |

An `aud` of `[]`, `""` or `null` is present and fails the first path. A
token whose `aud` fails is denied, even when its `client_id` is listed.
The `sub` check admits a listed client acting as itself and refuses a
person's access token issued through that client, which also has no
`aud` and carries `client_id`, but whose `sub` names the person. The
required scope binds the token to this API: a listed client that also
calls another API on the issuer cannot replay that token here (T37). It
chooses no grant; the grant comes from `role` alone on both paths
(R-36). The second path expects the RFC 9068 claims: the client in
`client_id` and the same value in `sub`. An issuer that names the client
in another claim (Okta `cid`, Entra `appid`) never passes it. Trying
the audience check and retrying without it on failure is not this rule:
each token is checked once. On a client-credentials token `sub` is the
client id, so the caller context, the access log and every build's
`OPERATOR_ID` name the client (M12).

The issuer MUST mint `role` for each listed machine client. Cognito does
it with a pre-token-generation trigger on the V3 event, which needs the
Essentials or Plus feature plan; it ignores any `aud` the trigger sets on
an access token.

The list reaches the authorizer as `VENDOR_IDP_CLIENT_IDS`,
comma-separated. Unset or empty means none, so the second path admits
nothing and a deployment that does not set `clientIds` checks the
audience alone. Set but yielding no names (`",,"`) throws at cold start, and so
does a duplicate. The scope reaches it as `VENDOR_IDP_REQUIRED_SCOPE`;
unset or empty means none, and a value outside the scope-token pattern
or with no client ids throws. A unit
test covers the cases the integration test cannot mint: an `aud` that
fails with a listed `client_id`, the malformed `aud` values above, a
person's access token from a listed client, and a scope that only shares
a prefix with the required one.

### 3.3 Stack inputs

Supplied at deployment time, validated at synthesis/deploy.

**Control plane stack:**

| Input | Constraint |
|---|---|
| `vendorIdp.issuerUrl`, `vendorIdp.audience` | non-empty; OIDC discovery must work against the issuer |
| `vendorIdp.clientIds` (optional, R-38, [ADR-043](../adr/0043-accept-listed-client-ids-when-a-token-has-no-audience.md)) | client ids accepted on a token that has no `aud`. Default: none. Each matches `[A-Za-z0-9+._:-]{1,128}` (Cognito ids are `[\w+]+`), so it survives the comma-separated environment variable; a duplicate MUST fail synth. List only the vendor's own machine clients on the dedicated issuer (T37) |
| `vendorIdp.requiredScope` (optional, R-38) | a scope a token without `aud` must also carry, such as this API's resource-server scope (`control-plane/read`): one RFC 6749 scope token (`[\x21\x23-\x5B\x5D-\x7E]{1,256}`), given as a literal, since a CDK token is refused at synth. Default: none. Set without `clientIds` it MUST fail synth. Set it whenever a listed client may call another API on the issuer (T37) |
| `fleetName` | names the role pair every account installs (`<fleetName>-cell-provisioning`, `<fleetName>-tenant-provisioning`) and the control plane's three roles the pair trusts (`<fleetName>-cell-build`, `<fleetName>-tenant-build`, `<fleetName>-api`), plus its two hook roles, which no pair trusts (`<fleetName>-global-hook`, `<fleetName>-app-hook`, R-41). It also names the four build projects (`<fleetName>-cell-build`, `<fleetName>-tenant-build`, `<fleetName>-global-hook`, `<fleetName>-app-hook`) and the workflow (`<fleetName>-workflow`), so their ARNs can be computed before they exist (R-41); `[a-z0-9][a-z0-9-]{0,31}`, checked at synth, so a name starts with a letter or digit as a CodeBuild project name must. Default `control-plane`. Role names are account-wide and project and state machine names are per Region, so the fleet name already separates two control planes in one account, and the named projects and workflow add no new clash. Two control planes in one account MUST use different fleet names, in every Region. The upgrade that first gives the projects and the workflow these names replaces them and is deployed only after the drain of R-41, as its three deploys (close with `allowedRoles` set to a value no token carries, upgrade with the gate kept, open) |
| `allowedRoles` (optional, R-36) | role claim values that get the operator grant; non-empty. Default `["operator"]`. Every role value in either list matches `[A-Za-z0-9:._-]{1,64}`, so it survives the comma-separated environment variable |
| `readerRoles` (optional, R-36, [ADR-042](../adr/0042-a-read-only-role-beside-the-operator.md)) | role claim values that get the reader grant. Default: none, so no reader is admitted until the deployer names one. A value in both lists MUST fail synth. Use a namespaced value (`control-plane:reader`), not a word a broader issuer may already mint (`reader`, `viewer`) (T2, T20) |
| `tenantBuildManagedPolicyArns` (optional, [ADR-022](../adr/0022-attach-deployer-supplied-managed-policies-to-the-tenant-build-role.md)) | array of customer-managed IAM policy ARNs (`arn:<partition>:iam::<account>:policy/...`), each in the stack's own partition and account; synth MUST fail otherwise. Attached to the tenant provisioning role the stack installs in its own account. Default: none |
| `globalHookManagedPolicyArns` (optional, R-41, [ADR-044](../adr/0044-run-vendor-hooks-around-cell-and-deployment-scripts.md)) | array of customer-managed IAM policy ARNs, validated exactly as `tenantBuildManagedPolicyArns` (the stack's own partition and account; synth MUST fail otherwise). Attached to `<fleet>-global-hook`, the role every global hook runs under. Default: none, so a global hook can write its logs, read its source and nothing else |
| `appHookManagedPolicyArns` (optional, R-41) | as above; attached to `<fleet>-app-hook`, the role every application hook runs under. An ARN in both lists MUST fail synth, so no policy reaches both scopes by accident (T41) |

Neither applications, accounts nor global hooks are stack inputs: all
three are registered through the API (§5.4, §5.5), because a
customer's account appears on demand, not at deploy time (P-10,
[ADR-024](../adr/0024-register-accounts-at-run-time-and-claim-cell-slots-atomically.md)),
and a new application or hook MUST NOT need a redeploy of the control plane
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
permission publishes the policy. The two hook inputs work the same way in
the control plane's own account: the control plane learns which policies
its hook roles hold, never what the hooks do with them.
In the control plane's own account both pair roles also carry the R-41
deny, so an attached policy cannot grant them the denied actions.

---

## 4. Data Model

One table, six public entity types plus two internal record types (the
idempotency record and the hook counter). All keys
shown as the reference implementation's convention; the requirement is the
*shape*, not the literal strings.

### 4.1 Application

| Field | Requirement |
|---|---|
| `applicationId` | operator-chosen, `[a-z0-9-]{1,32}` — the item's identity; never generated. The charset keeps it usable as a parameter path segment (§6.2) and readable in listings |
| `source` | `{type, location, sourceVersion?}` — a build-service source reference (e.g. GitHub repo, S3 bucket) and an optional git ref forwarded to the build as its source version; non-empty type and location. `location` (at most 2,048 bytes) and `sourceVersion` (at most 256) use the charsets of a hook source (R-39): URL characters without `@`, so a location carries no userinfo, and for `sourceVersion` `[A-Za-z0-9._/^{}+-]`, the characters of a git ref (a `<ref>^{<commit>}` pin and a SemVer `+` included) or object version. Neither admits a control character or a character JSON escapes (§8.1). A source whose ref is not a full commit SHA is accepted with a logged warning ([ADR-020](../adr/0020-supply-chain-pinning-warn-and-allow.md)) |
| `cellScripts` | `{create, update, delete}` — all three paths required, non-empty (P-9), each at most 1,024 bytes in the charset of a hook `script`, `[A-Za-z0-9._/-]` (R-39) |
| `tenantScripts` | `{create, update, delete}` — all three paths required, non-empty (P-9), each at most 1,024 bytes in the charset of a hook `script`, `[A-Za-z0-9._/-]` (R-39) |
| `maxTenants` | integer ≥ 1; replaceable. A new value applies to cells created afterwards (P-4) |
| `placementStrategy` | `FILL \| ROUND_ROBIN`; default `FILL`; replaceable, takes effect on the next placement ([ADR-036](../adr/0036-the-application-chooses-fill-or-round-robin-across-accounts.md)). How a new cell picks among eligible accounts with free capacity (§7.1): `FILL` takes the oldest registered account until it is full; `ROUND_ROBIN` takes the account with the fewest cells, so cells rotate over the open accounts |
| `parameters` | optional list of **parameter declarations**, at most 20, default none; replaced when sent (absent on an existing application keeps it, `[]` clears it), takes effect on the next deployment request ([ADR-039](../adr/0039-applications-declare-deployment-parameters.md)). Each is `{name, required, default?, description?}`: `name` matches `[A-Z][A-Z0-9_]{0,63}` and is unique in the list; `required` is a boolean, default `false`; `default` is a string of at most 1,024 bytes (UTF-8) with no control characters (as for values, R-33) and MUST NOT be set on a required parameter; `description` is at most 256 characters of operator-facing text |
| `cellParameters` | optional list of **cell parameter declarations**, at most 20, default none; replaced when sent (absent on an existing application keeps it, `[]` clears it), takes effect on the next cell build ([ADR-040](../adr/0040-applications-declare-cell-parameters-with-defaults.md)). Each is `{name, default, description?}`: `name` as for `parameters`, unique in the list and MUST NOT also appear in `parameters` (one name, one meaning); `default` is **required**, a string of at most 1,024 bytes (UTF-8) with no control characters, because a cell is created by placement and no operator is present to supply a value; `description` as for `parameters`. There is no `required` flag |
| `hooks` | optional list of **application hooks** (§4.8), at most 5, default none; part of the definition, so each new cell is stamped with the list current at its creation (P-4, R-40). Replaced only when sent, the rule the declaration lists follow: absent on an existing application keeps it, `[]` clears it. Each entry is a hook definition (R-39); `hookId` is unique in the list |
| `cellCount` | **the authoritative count of this application's cells** — claimed in the cell-creating transaction, released in the cell-deleting one (P-6); never written by `PutApplication` |
| `createdAt`, `updatedAt` | timestamps |

Key: `PK=APPLICATION#<applicationId>`, `SK=META`.

`source`, `cellScripts`, `tenantScripts`, `maxTenants` and `hooks`
together are the application's **definition**: the bundle a new cell is
stamped from.
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

The source and script charsets change `PutApplication`'s validation,
which admitted any value that starts with a non-blank character,
control characters included
([ADR-044](../adr/0044-run-vendor-hooks-around-cell-and-deployment-scripts.md)
amends ADR-032). A re-put of an application registered with a value
outside them is a 400 until the value is corrected. A cell stamped before the change keeps
its stamp, so the §8.1 bound for the application's source and paths
holds for cells stamped afterwards.

**R-29 (field ownership on applications):** `PutApplication` MUST write
the definition fields except `hooks`, plus `placementStrategy` and
`updatedAt`, and each of `hooks`, `parameters` and `cellParameters`
**only when the request sent it** (on an existing application an absent
list is kept, `[]` clears it, §5.5), and MUST NOT touch `cellCount`;
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
| `source`, `cellScripts`, `tenantScripts`, `hooks` | stamped from the application's definition; immutable for the cell's lifetime. `hooks` is the application's hook list when the cell was created; it runs on the cell's events and on the events of every deployment in it (R-40) |
| `parameters` | map of cell parameter name → value, the values an operator set on this cell through `UpdateCell`; at most 20 entries, each value at most 1,024 bytes (UTF-8); **empty at birth**. Never holds a default the operator did not supply, so a changed default reaches the cell on its next build |
| `lastBuildId` | most recent successful cell-scoped build id (nullable) |
| `lastGlobalHooks` | the global hooks that ran in the cell's last cell event, in run order, each `{hookId, phase, revision, sourceVersion, resolvedSourceVersion}`: the ref the hook names and the commit its build ran, absent for a source that has none such as S3 (R-40); written by the workflow's terminal writes only; empty when none ran |
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
exactly as the request read it; the same `removeParameters` rules,
character rule and error classification; validation before the status
check. The map condition matters most here: placements and deployment
deletes write the cell's counter and `updatedAt` while it is `ACTIVE`, and
they must not fail an `UpdateCell` that has nothing to do with them.
`removeParameters` naming a stored entry returns the cell to the default.
`DeleteCell` MUST NOT validate. A new cell is inserted with an empty map
(§7.1 step 3): no request supplies cell values at birth. The cell's set
reaches **cell scripts only**; tenant scripts that need a cell value read
what the cell create script published under
`/application-plane/cells/<cellId>/*` (§6.2).

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
cell or a build state (P-4,
[ADR-037](../adr/0037-a-deployment-is-one-tenant-in-one-application.md)):
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
| `lastBuildId`, `lastGlobalHooks`, `statusReason`, timestamps | as for cell |

Key: `PK=TENANT#<tenantId>`, `SK=DEPLOYMENT#<applicationId>`. A tenant's
deployments are therefore one base-table query and need no index.

**R-31:** The deployment record MUST NOT carry provisioning source,
scripts or hooks (P-4). Its effective definition, application hooks
included, is resolved from its cell.

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
move `updatedAt`. Failures are classified (R-14). Validation runs on the
read record before the conditional write, so a request that is both invalid
and in flight is a 400, with nothing written. A value MUST NOT contain a
control character (U+0000 to U+001F, U+007F): 400. A build environment
cannot carry NUL, and the rule bounds a value's JSON-encoded size at twice
its raw size (§8.1). `DeleteDeployment` MUST NOT validate parameters:
cleanup runs with what is stored, whatever the declarations now say (P-9).

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
`maxCells`, `externalId`, `updatedAt`) and MUST NOT touch `cellCount`; the
two counter paths MUST NOT touch the policy fields. `updatedAt` is the one
attribute both paths write; it is a timestamp, so last-writer-wins there
loses nothing. A capacity cut and a concurrent claim then compose without a
lost update: the claim's condition `cellCount < maxCells` evaluates against
whichever `maxCells` landed first.

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

Eleven listing patterns; nine need secondary indexes (reference: three
GSIs; each item carries at most one partition attribute per index) and
two are base-table queries:

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
| List global hooks / hook resolution at accept time | base table: `PK = HOOK`, `SK begins_with HOOK#` — no index, and strongly consistent (R-40) |

**R-9:** Indexes MUST be treated as eventually consistent and **never
authoritative** (P-5). `tenantCount` on the cell record, `deploymentCount`
on the tenant record and `cellCount` on the account and application
records — not index counts — are the occupancy guards.

**R-10:** Every list query MUST be pinned to a server-side partition. The
partition value is either a static constant (`CELL`, `TENANT`,
`DEPLOYMENT`, `ACCOUNT`, `APPLICATION`, `HOOK`) or a validated resource
identifier the request names explicitly (`tenantId`, `cellId`, `accountId`,
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

### 4.8 Hook

A **hook** is vendor code the workflow runs before or after a cell or
deployment script (§6.5,
[ADR-044](../adr/0044-run-vendor-hooks-around-cell-and-deployment-scripts.md)).
A **global hook** applies to every application and is registered through
the API (§5.5); an **application hook** is part of one application's
definition (§4.1). Both use one definition shape:

| Field | Requirement |
|---|---|
| `hookId` | operator-chosen, `[a-z0-9-]{1,32}`; the item's identity for a global hook, unique within the list for an application hook. It orders hooks within a scope (R-45) |
| `events` | non-empty list of distinct events: `CELL_CREATE`, `CELL_UPDATE`, `CELL_DELETE`, `DEPLOYMENT_CREATE`, `DEPLOYMENT_UPDATE`, `DEPLOYMENT_DELETE` |
| `phase` | `PRE \| POST`: before the script, or after it succeeded |
| `source` | `{type, location, sourceVersion?}`, the shape of the application's `source` (§4.1) under the same pinning rule: a ref that is not a full 40-character commit SHA is accepted with a logged warning naming the hook ([ADR-020](../adr/0020-supply-chain-pinning-warn-and-allow.md)). `type` is a CodeBuild source type name (`GITHUB`, `CODECOMMIT`, `S3`, ...). `location` matches `[A-Za-z0-9._~:/?#\[\]!$&'()*+,;=%-]{1,1024}`: URL characters without `@`, so it can carry no userinfo (`https://user:token@host/...` is a 400). `sourceVersion` matches `[A-Za-z0-9._/^{}+-]{1,128}`, the characters of a branch, a tag (SemVer build metadata after `+` included), a commit SHA, a `<ref>^{<commit>}` pin or an object version. Neither holds a character JSON escapes: `^`, `{`, `}` and `+` need none |
| `script` | path of the hook's script in its source, matching `[A-Za-z0-9._/-]{1,256}` |
| `timeoutMinutes` | integer 5–30, default 10; the hook build's run timeout, sent as CodeBuild's `timeoutInMinutesOverride`, whose minimum is 5. Queue time is bounded apart from it (R-46) |
| `revision` | global hooks only: 1 on create, incremented by every replace; never supplied |
| `createdAt`, `updatedAt` | global hooks only: timestamps |

Key: `PK=HOOK`, `SK=HOOK#<hookId>`. One partition holds every global
hook, so the service reads them all in one strongly consistent query
(§4.7). Beside them, the **hook counter** (`PK=HOOK`, `SK=META`) holds
`hookCount`, the authoritative count of global hooks, at most 5 (P-6).
A global hook has no status: its operations are synchronous and run no
build. Its lifecycle is register (`PutHook`) → in use → delete.

**R-39 (hook definitions):** `PutHook` and `PutApplication` MUST
validate every hook definition against the table above and refuse with
400 a malformed id, an empty or repeating event list, an unknown event or
phase, an unknown source type, a source field or script path outside its
pattern (a control character included), a `location` with userinfo, a
timeout outside 5–30, a repeated `hookId` in an application's list, or
more than 5 hooks in that list. The patterns admit no character JSON
escapes, so a definition is as large in the execution input as it is
raw (§8.1). `PutHook` MUST create a hook in
one transaction (the hook inserted `IF attribute_not_exists`;
`hookCount += 1` `IF attribute_not_exists(hookCount) OR hookCount < 5`)
and replace one with a single update conditioned on the hook's existence
that sets `revision = revision + 1`. It chooses the path from a strongly
consistent read. A condition that fails because a concurrent create or
delete of the same hook won is a 409, retryable: a create that met a new
hook becomes a replace on retry, and a replace that met a delete becomes
a create. A create the counter refuses is a 409 without a retry hint,
because the remedy is `DeleteHook`. `DeleteHook` MUST delete the hook
(`IF attribute_exists`) and decrement `hookCount` (`IF hookCount > 0`)
in one transaction; a missing hook is 404. A hook definition MUST NOT
carry a secret: `GetHook`, `ListHooks`, `GetApplication`, `GetCell` and
`GetDeployment` return it to operators and readers alike (R-37, N-12).

**R-40 (hook resolution):** when an operation is accepted (R-20), the
service MUST resolve the hooks of each event the execution runs (§8.3):
the application hooks stamped on the cell, never the application
record's current list (P-4), and the global hooks read in one strongly
consistent query (`PK=HOOK`, `SK begins_with HOOK#`), each with the
`revision` and `source` it had at that read. The query MUST run before
the operation's first write: in §7.1 step 0 for `CreateDeployment`, and
with the record read that precedes the transitional conditional write
for `UpdateDeployment`, `DeleteDeployment`, `UpdateCell` and
`DeleteCell`. A failed query is then a 500 with nothing written, never
a record left `CREATING`, `UPDATING` or `DELETING` with no execution.
The application hooks need no read of their own: a stamp is immutable,
so the cell the operation already read, or for a new cell the
application record read in step 0, holds them. The workflow runs that
snapshot and never re-reads a hook (R-20). A global hook put or deleted
after the read does not change an execution already accepted; the next
operation sees it. Both are tolerated races (§7.2). Every terminal write
that leaves the record in place (§8.2) MUST record on the cell or the
deployment the global hooks that ran for its event as
`lastGlobalHooks`, each with the `resolvedSourceVersion` its build
reported (H-2), so an operator can tell which commit of a gate or an
audit hook an `ACTIVE` record passed, also when the hook names a
branch. A hook that a `PRE` failure kept from running is not listed.
Application hooks need no such record: the cell's stamp names them.

---

## 5. API Surface

Twenty-six operations. Conventions: lowercase plural collection paths,
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
| `GetDeployment` | `GET /tenants/{tenantId}/deployments/{applicationId}` | 200 | The polling endpoint: `status`, `statusReason`, `lastBuildId`, `lastGlobalHooks`, `cellId`, plus the deployment's *effective* definition (resolved from the cell's stamped definition, the application hooks stamped on the cell included), the cell's `accountId` and the stored `parameters` (the supplied values only; defaults are not merged in). 404 if missing. |
| `UpdateDeployment` | `PUT /tenants/{tenantId}/deployments/{applicationId}` | **202** | Re-apply the deployment, optionally changing parameter values first. Input `{parameters?, removeParameters?}`, both optional: an empty body re-applies with the stored values. Names in `parameters` are set and names in `removeParameters` removed; every other stored value is kept (R-33). Runs the stamped tenant update script with the merged set resolved per R-32. Requires deployment `ACTIVE`/`UPDATE_FAILED` **and** cell `ACTIVE`; 409 otherwise. 400 on a validation failure of R-33, with nothing written. |
| `DeleteDeployment` | `DELETE /tenants/{tenantId}/deployments/{applicationId}` | **202** | 409 if in-flight. Allowed from `ACTIVE` and all `*_FAILED` states **regardless of cell status** — cleanup must always be reachable (P-9). Runs the tenant delete script with the stored parameters resolved per R-32, never validated against the current declarations; on success the workflow removes the record and releases the cell slot and the tenant's count in one transaction (§8.2). |
| `ListDeployments` | `GET /deployments[?tenantId=\|?cellId=\|?applicationId=]` | 200 | Paginated. At most one filter per request (400 for two). An unknown `tenantId`, `cellId` or `applicationId` filter yields an **empty page, not a 404** — a filter is a query predicate, not a resource lookup. |

### 5.3 Cell operations

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `ListCells` | `GET /cells[?accountId=\|?applicationId=]` | 200 | Fleet topology: `applicationId`, `accountId`, `status`, `tenantCount`/`maxTenants` per cell — the operator's capacity view. Paginated. At most one filter per request (400 for two). An unknown `accountId` or `applicationId` filter yields an **empty page, not a 404** (same rule as `ListDeployments?cellId=`). |
| `GetCell` | `GET /cells/{cellId}` | 200 | Full record including `applicationId`, `accountId`, the stamped definition (application hooks included), `lastGlobalHooks` and the stored cell `parameters` (the operator-set values only; defaults are not merged in). |
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

**R-26 (handshake at registration,
[ADR-027](../adr/0027-verify-the-account-handshake-at-registration.md),
[ADR-030](../adr/0030-prove-the-pair-enforces-the-external-id.md)):**
`PutAccount` MUST fail closed when either role of the pair cannot be
assumed with the supplied `externalId`, and — when an `externalId` is
supplied — when either role CAN be assumed without it (the pair does not
enforce the id). Registration is the moment the operator is present and can
act on the error; the first build is not. The check is a probe only — no
API call is made under the assumed credentials, and nothing is written in
the account. A probe STS could not answer (throttling, a network fault) is
a 500 asking for a retry, not a refusal: the pair may be fine.

### 5.5 Application and hook operations

All synchronous: no application or hook operation runs a build
([ADR-032](../adr/0032-register-applications-at-run-time-and-stamp-their-definition-onto-cells.md),
[ADR-044](../adr/0044-run-vendor-hooks-around-cell-and-deployment-scripts.md)).

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `PutApplication` | `PUT /applications/{applicationId}` | 200 | Create-or-replace. Input `{source, cellScripts, tenantScripts, maxTenants, hooks?, placementStrategy?, parameters?, cellParameters?}` — the definition of §4.1 plus the strategy and both sets of parameter declarations, validated as a whole (400 on a missing script path, a source field or script path outside its charset (§4.1), a malformed source, `maxTenants < 1`, an unknown strategy, an id outside `[a-z0-9-]{1,32}`, a parameter name outside `[A-Z][A-Z0-9_]{0,63}`, a duplicate name within or across the two lists, more than 20 declarations in either list, a `default` on a required parameter, a cell parameter without a `default`, or a hook definition that fails R-39). A hook source whose ref is not a full commit SHA is logged with a warning naming the application and the hook, as the application's own source is. On an existing application the definition fields other than `hooks`, and the strategy, are replaced. The two declaration lists are replaced only when sent: an absent `parameters` or `cellParameters` **keeps** the current list, and an empty list `[]` clears it, so a `PutApplication` that only changes `maxTenants` cannot silently drop every required check and default. On a new application an absent list declares none. `hooks` follows the same rule: absent keeps the current list, `[]` clears it, and a changed list reaches only cells created afterwards (P-4). Existing cells and deployments keep their stored values. A cell parameter added since reaches each cell's next build as its default. A newly required parameter makes the next `UpdateDeployment` of every deployment lacking it a 400 until the operator supplies the value; it never blocks a `DeleteDeployment`. `cellCount` is untouched (R-29). The "one name in one list" check runs against the lists the request sent plus any list it keeps. One write, with `cellCount` and `createdAt` set through `if_not_exists`, so a replace never resets them. When both declaration lists are sent the write carries no condition — an application has no immutable field, so it is correct in every prior state (P-5). When a declaration list is kept, the write is conditioned on that list being exactly as the request read it (`attribute_not_exists` when the attribute was absent, equality when present, an empty `[]` included; absent and `[]` are different reads), so two concurrent puts that each send one list cannot store one name in both; a failed condition → 409, retryable. A kept `hooks` list adds no condition: a put that keeps it writes no hook attribute, and hooks share no invariant with another list. The condition is never on `updatedAt`, which cell creates and deletes also write. Cells already created keep their stamp (P-4). |
| `GetApplication` | `GET /applications/{applicationId}` | 200 | The record: the definition, `placementStrategy`, both sets of parameter declarations and `cellCount`. 404 if unregistered. |
| `ListApplications` | `GET /applications` | 200 | Paginated: `applicationId`, `maxTenants`, `placementStrategy`, `cellCount` per application. |
| `DeleteApplication` | `DELETE /applications/{applicationId}` | 200 | **Empty applications only** (P-10): a single conditional delete (`attribute_exists AND cellCount = 0`), the counterpart of the cell-slot claim; condition failure → 409. Accounts that name the application in `applicationIds` are not touched (§4.5). |
| `PutHook` | `PUT /hooks/{hookId}` | 200 | Create-or-replace a global hook. Input `{events, phase, source, script, timeoutMinutes?}`, validated per R-39 (400). A create claims a `hookCount` slot in the same transaction; a sixth hook → 409. A replace increments `revision`. Takes effect on operations accepted afterwards; executions in flight keep the snapshot they were accepted with (R-40). Logs a warning naming the hook when the source ref is not a full commit SHA. |
| `GetHook` | `GET /hooks/{hookId}` | 200 | The record: the definition, `revision`, timestamps. 404 if unregistered. |
| `ListHooks` | `GET /hooks` | 200 | Paginated, in `hookId` order, which is the order global hooks run in (R-45). |
| `DeleteHook` | `DELETE /hooks/{hookId}` | 200 | Deletes the hook and releases its `hookCount` slot in one transaction (R-39); 404 if unregistered. No guard on executions in flight: each runs the snapshot it holds (R-40), and `StopExecution` is the only stop for them (§7.2). |

**R-30:** There MUST be no application-level provisioning: an application
owns no deployment of its own, only the definition its cells are built
from. Shared infrastructure an application needs in an account is
provisioned out of band and published under that application's shared
namespace (§6.2). There is likewise no operation that runs a hook: hooks
run only as steps of an execution a lifecycle operation started (R-44).

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
| `ValidationException` | 400 | malformed input, malformed pagination token, two list filters at once; an invalid application definition or parameter declaration on `PutApplication`; a deployment parameter that fails R-33 on `CreateDeployment` or `UpdateDeployment`; a cell parameter that fails R-34 on `UpdateCell`; a targeted `CreateDeployment` into an account that does not admit the application; `PutAccount` handshake refusal (R-26: a half could not be assumed, or admits the call without the supplied external id); an invalid hook definition on `PutHook` or `PutApplication` (R-39) |
| `UnauthorizedError` | 401/403 | missing/invalid JWT; a role in neither set; a reader calling a non-`GET` operation (R-36); a token without `aud` whose `client_id` is not listed or does not equal `sub`, or that lacks the required scope (R-38) |
| `ResourceNotFoundError` | 404 | unknown tenant, deployment, cell, account, application or global hook (including an unregistered `CreateDeployment.accountId` or `applicationId`, and an unregistered id in `PutAccount.applicationIds`) |
| `ConflictError` | 409 | in-flight mutation; a second deployment of the same application for one tenant; occupied-tenant delete; occupied-cell delete; occupied-account delete; occupied-application delete; `owner` change on `PutAccount`; cell-not-ACTIVE guard; `clientToken` reuse with different parameters; a parameter merge or a list-keeping `PutApplication` whose read went stale — retry (R-14); `CreateDeployment` lost every bounded claim on candidate cells and no account had a free cell slot — retry ([ADR-031](../adr/0031-lost-placement-races-on-a-full-fleet-are-a-retryable-conflict.md)); a `PutHook` that raced a create or delete of the same hook — retry; a `PutHook` create with five global hooks registered — no retry hint, delete a hook first (R-39) |
| `InsufficientCapacityError` | 409 | `CreateDeployment` found no eligible cell and no eligible account with cell capacity: every vendor-owned account admitting the application is full (untargeted), or the named account is full (targeted). Nothing was written. The remedy is an operator act — raise `maxCells`, register an account, or admit the application in one — so the error is distinct from `ConflictError`, which a client may simply retry later ([ADR-026](../adr/0026-fleet-full-is-a-modelled-error.md)) |
| `InternalServerError` | 500 | everything else, including a `PutAccount` whose handshake probe STS could not answer (throttling, network): the handshake is unknown, not refused, and the operator retries |

**R-14:** Repository condition failures MUST be classified, not blanket-500d:
a stale lifecycle transition → 409; a metadata write that loses a
concurrent delete → 404; an insert that finds the deployment already there
→ 409. A failed parameter merge (R-33, R-34) or list-keeping
`PutApplication` (§5.5) is a 409, with a **retry hint only** when the
item that failed shows a changed `parameters` (or kept list) under a
status the operation admits, or the status `CREATING` or `UPDATING`
(in flight, and it ends in a state the update admits). Every other status
(`CREATE_FAILED`, `DELETE_FAILED`, `DELETING`) is a 409 without a hint: a
retry cannot succeed, and the remedy is a delete. The merge is a single
conditional `UpdateItem` on the record being updated; the service
classifies from the item returned by `ReturnValuesOnConditionCheckFailure:
ALL_OLD`, never from a second read, so the label describes the state that
actually failed the condition. When `ALL_OLD` returns no item the record
was deleted → 404. Under `UpdateDeployment` the cell-`ACTIVE` guard is
checked on the read before the write (R-13) and a cell not `ACTIVE` is a
409 without a hint from that read; the cell MUST NOT be added to the merge
write as a transaction `ConditionCheck`, because placements and deployment
deletes write the cell in their own transactions and would cancel the merge
with no item to classify. A list-keeping `PutApplication` is the exception
to the item-based rules: an application has no status, so its failed
condition is always a 409 with a retry hint, also when the application was
deleted in between, because the retry is a create-or-replace that succeeds
(§5.5).

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
| `OUTPUTS_FILE` | ✓ every operation; a path, outside the source tree, the script MAY write its outputs to (R-43) | ✓ as for cells |

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
between lists clears the old values with `removeParameters`. A tenant
script that needs a cell value reads it from the cell's namespace, where
the cell create script published it (§6.2,
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
their own account, the vendor never does. In the control plane's own
account both pair roles also carry the R-41 deny, so an attached
policy cannot grant them the denied actions.

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
recreated. The two hook roles (§6.5) are deliberately absent from both
trust policies: a hook never acts in a cell account. In the control
plane's own account both pair roles also carry the R-41 deny, so an
attached policy cannot grant them the denied actions.

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

### 6.5 Vendor hooks

Hooks are how the vendor acts on a cell's or a deployment's lifecycle
from its own side: register a route, meter a cell, refuse a create,
export an audit record
([ADR-044](../adr/0044-run-vendor-hooks-around-cell-and-deployment-scripts.md)).
A script runs with the pair of the account that hosts the cell, and in a
tenant-owned account the tenant controls that pair, so anything a script
can call, the tenant can call too, whenever it likes. A hook runs in the
control plane account under a role that no cell account holds or trusts, so
a downstream system that admits only a hook role admits only the vendor.
When each hook runs, and what its failure does to the operation, is §8.3.

**R-41 (hook isolation):** hooks MUST run in the control plane account,
in CodeBuild, in two hook build projects beside the two provisioning
projects: global hooks in one, under `<fleet>-global-hook`; application
hooks in the other, under `<fleet>-app-hook`. The workflow MUST NOT pass
a role override to a hook build, so the project alone decides the role,
and it MUST start a global hook only in the global hook project and an
application hook only in the application hook project. An application
hook therefore cannot use what a global hook holds. Each hook role
trusts only `codebuild.amazonaws.com`, conditioned on its own project
(`aws:SourceArn`, H-7), and the stack grants it only its project's
logs, read access to its source, and the customer-managed policies the
deployer attaches (`globalHookManagedPolicyArns`,
`appHookManagedPolicyArns`, §3.3). The stack grants neither role
`sts:AssumeRole` on `<fleet>-cell-provisioning` or
`<fleet>-tenant-provisioning`, and no pair trusts either role (§6.4),
so for a direct AssumeRole the trust policy is the gate whatever a
deployer attaches. The hook buildspec MUST NOT assume a role, and a
hook build's environment MUST NOT carry the account's `externalId` or
the pair's role ARNs. The stack grants neither role anything on the
control plane's own table, workflow, build projects or API. The
indirect paths to the pair are closed by an explicit deny, up to a
stated residual (below); any other attached policy over the control
plane's own resources is the deployer's choice in the vendor's most
sensitive account (T41).
Every global hook shares `<fleet>-global-hook` and the hooks of all
applications share `<fleet>-app-hook`, so a hook can use what any other
hook of its scope holds: a metering hook holds what a route registrar
holds. A role per global hook or per application is a seam (§11).

A hook project accepts source and buildspec overrides, because every
hook has its own, so whoever can start a build in it runs any code as
its role. Only the workflow role MAY hold `codebuild:StartBuild` on the
hook projects (with `StopBuild` and `BatchGetBuilds`, R-46). The
workflow role MUST NOT hold `iam:PassRole` on either hook role, so a
role override fails at the CodeBuild API whatever a definition sends.
The provisioning build roles and the API role MUST hold neither
permission on the hook projects: a script that reaches its build role
(T29) must not reach a hook role. A principal the deployer grants
either permission in the control plane account holds that hook role
(T41).

The workflow starts whatever hook source, script and scope its
execution input names, as it runs the source and scripts the input
names (R-20). So `states:StartExecution` on the workflow is equivalent
to `codebuild:StartBuild` on the hook projects and on the provisioning
projects: a principal that starts an execution with an input of its
choice runs any code as either hook role and as either provisioning
build role. The API role MUST be the only role the stack grants
`states:StartExecution` on the workflow, and a build role or a hook
role MUST NOT hold it, so a script or a hook cannot start an execution
of its own. A compromise of the API function therefore reaches both
hook roles (T30).

Grants of four kinds lead from a role to the provisioning build
roles, and through them to the pair of every registered account. The
direct ones are `states:StartExecution` on the workflow,
`codebuild:StartBuild` on a provisioning project, and a write to the
table, whose `PK=HOOK` partition declares hooks (R-44). The second
kind runs new code as a role that holds a pair or one of these grants:
`iam:PassRole` on a build role, the workflow role, `<fleet>-api` or a
hook role, with a create on CodeBuild, Step Functions or Lambda. The
third rewrites what a pair holder runs next, or removes the deny
itself: an IAM write on one of the stack's roles, or an update to a
build project, the workflow or the API function. The fourth makes the
caller the operator, who reaches every pair through `PutApplication`
or `PutHook`. The API function runs every operation on the word of
`requestContext.authorizer`, which the authorizer sets only for calls
through API Gateway. A direct `lambda:InvokeFunction` or `lambda:InvokeAsync` on the
function, with an authorizer context of the caller's choosing, skips the
authorizer; `lambda:AddPermission` opens that invoke to any principal;
and an API Gateway write on the REST API can take the authorizer off
a method and deploy the change. The stack MUST therefore attach to
each build role, each hook role and the two pair roles it installs in
its own account a policy that explicitly denies:

- `iam:PassRole` on `<fleet>-cell-build`, `<fleet>-tenant-build`, the
  workflow role, `<fleet>-api`, `<fleet>-global-hook` and
  `<fleet>-app-hook`;
- `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, `iam:AttachRolePolicy`,
  `iam:DetachRolePolicy`, `iam:UpdateAssumeRolePolicy`,
  `iam:PutRolePermissionsBoundary` and
  `iam:DeleteRolePermissionsBoundary` on every role the stack creates
  (the table below), the denied roles included;
- `codebuild:StartBuild`, `codebuild:StartBuildBatch`,
  `codebuild:RetryBuild`, `codebuild:UpdateProject`,
  `codebuild:CreateWebhook` and `codebuild:UpdateWebhook` on all four
  projects;
- `states:StartExecution` and `states:UpdateStateMachine` on the
  workflow,
  `arn:<partition>:states:<region>:<account>:stateMachine:<fleet>-workflow`;
- `states:RedriveExecution` on the workflow's executions,
  `arn:<partition>:states:<region>:<account>:execution:<fleet>-workflow:*`,
  because Step Functions authorises a redrive on the execution ARN, so
  a statement on the state machine ARN would never match it;
- `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration`,
  `lambda:PublishVersion`, `lambda:CreateAlias`, `lambda:UpdateAlias`
  and `lambda:DeleteAlias` on the API function and the authorizer
  function, each named twice, unqualified
  (`arn:<partition>:lambda:<region>:<account>:function:<name>`) and
  qualified (`...:function:<name>:*`);
- `lambda:InvokeFunction`, `lambda:InvokeAsync`,
  `lambda:AddPermission` and `lambda:RemovePermission` on the API
  function, unqualified and qualified (`function:<api-fn>` and
  `function:<api-fn>:*`). Lambda matches a request that names a
  qualifier (`$LATEST`, a version or an alias) only against a
  qualified ARN, so a deny on the unqualified ARN alone would leave
  `Invoke` with `Qualifier=$LATEST` open to an allow on `*`. The
  deprecated `InvokeAsync` operation still runs and is documented with
  an action of its own, so a deny of `InvokeFunction` alone could leave
  an asynchronous call with a forged `requestContext.authorizer` open;
- `apigateway:PUT`, `apigateway:PATCH`, `apigateway:POST` and
  `apigateway:DELETE` on the control plane's REST API,
  `arn:<partition>:apigateway:<region>::/restapis/<api-id>` and
  `arn:<partition>:apigateway:<region>::/restapis/<api-id>/*`;
- `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`,
  `dynamodb:BatchWriteItem`, `dynamodb:PartiQLInsert`,
  `dynamodb:PartiQLUpdate` and `dynamodb:PartiQLDelete` on the table.
  `TransactWriteItems` and `ExecuteTransaction` are authorised per
  item through these actions, so they need no entry of their own.

API Gateway invokes the API function through the function's resource
policy, as its service principal, so the invoke deny on the denied
roles does not touch the API's own path.

The deny MUST be one standalone `AWS::IAM::Policy` resource, created
outside every role construct and attached to the denied roles through
its `Roles` list, so that nothing in the stack depends on it. In a
role's default policy it would close a CloudFormation cycle: the home
pair depends on every child of the build role constructs, and the deny
names the home pair roles. As a managed policy it would make every
role depend on it while it names the projects, which depend on their
roles. A role, a project or the workflow that has a physical name MUST
be named in the deny by an ARN computed from that name
(`Stack.formatArn`), never by a reference to its resource. The roles
with CDK-generated names, the table, the two functions and the REST
API are named by their attributes, which the standalone policy may
reference because nothing references it; the qualified form of a
function is its ARN attribute followed by `:*`. The stack creates eight roles
today, three of them with CDK-generated names, and ten with the two
hook roles:

| Role | Name | Carries the deny |
|---|---|---|
| Cell build role | `<fleet>-cell-build` | yes |
| Tenant build role | `<fleet>-tenant-build` | yes |
| Home cell provisioning role | `<fleet>-cell-provisioning` | yes |
| Home tenant provisioning role | `<fleet>-tenant-provisioning` | yes |
| Global hook role (new) | `<fleet>-global-hook` | yes |
| Application hook role (new) | `<fleet>-app-hook` | yes |
| API role | `<fleet>-api` | no: its grants are among the direct actions |
| Workflow role | CDK-generated | no: its grants are among the direct actions |
| Authorizer function role | CDK-generated | no: it holds its logs only |
| API Gateway CloudWatch role | CDK-generated | no: it holds API Gateway's logs only. It outlives the stack: CDK retains it and the `AWS::ApiGateway::Account` setting that names it, one per account and Region (§10) |

Each build role MUST also trust `codebuild.amazonaws.com` only on its
own project's `aws:SourceArn`, as each hook role does (H-7), so no new
project can run as it; until now the build roles trusted CodeBuild
with no condition. The project names its role as `ServiceRole`, so a
trust condition that referenced the project would close a cycle. Each
of the four projects therefore MUST have a physical name built from
the fleet name (`<fleet>-cell-build`, `<fleet>-tenant-build`,
`<fleet>-global-hook`, `<fleet>-app-hook`), and each role's trust
condition MUST carry the ARN computed from that name
(`Stack.formatArn`), never one taken from the project resource. The
workflow MUST likewise have the physical name `<fleet>-workflow`, so
the deny and the test policy of §10 can name it by a computed ARN. The
fleet name already separates two control planes in one account (§3.3),
so these names add no new clash.

Giving the two existing provisioning projects and the workflow their
physical names replaces them on upgrade. When CloudFormation deletes
the old state machine (`DeleteStateMachine`), Step Functions terminates
each of its running executions at its next state transition. Like
`StopExecution` (§7.2), that bypasses the Catch and strands the
execution's record in `CREATING`, `UPDATING` or `DELETING`, with
nothing to finish it. The upgrade that introduces the physical names
MUST therefore be deployed only after a drain: no mutating operation
is accepted from the start of the drain until the upgrade deploy
completes, and that deploy starts only when `ListExecutions` with
status `RUNNING` on the old workflow is empty. The drain covers
accepted operations, not only running executions: an operation the old
API function accepted just before its environment changed starts its
execution on the old state machine. The stack has no maintenance
mode; `allowedRoles` (R-36) is the switch, and the upgrade MUST be
three deploys:

1. **Close.** Redeploy the current version with `allowedRoles` set to
   the single value `control-plane:closed`. The issuer MUST mint no
   token with that role, and the value MUST NOT be in `readerRoles`,
   so no token carries it. This deploy changes only the authorizer's
   environment and replaces nothing. The refusal does not take effect
   when the deploy completes: the authorizer caches each token's
   policy and context for its TTL (N-1, 60 s), and the service reads
   the grant from that cached context (R-36). Within the TTL plus the
   API's integration timeout (about 29 s), every mutating call is
   refused with 403, while readers keep their `GET`s.
2. **Upgrade.** Wait at least the authorizer TTL plus the integration
   timeout (90 s with the reference values) after the Close deploy
   completes. Only then check that `ListExecutions` with status
   `RUNNING` on the old workflow is empty, and deploy the upgrade with
   `allowedRoles` still `control-plane:closed`. A call accepted from a
   cached grant just before the wait ends can take until the
   integration timeout to start its execution, so a check made
   earlier can see an empty list and miss it.
3. **Open.** Redeploy the upgrade with `allowedRoles` restored. An
   operator refused during the drain may stay refused for up to one
   TTL after Open, because that refusal is cached too.

Deploy 2 MUST NOT restore the roles. Within one stack update,
CloudFormation may update the authorizer before the API function's
environment points at the new workflow, and it deletes the old state
machine only at cleanup. An operation accepted in that window would
start on the old workflow, be terminated at cleanup and strand its
record, the case the drain exists to prevent. Deploy 3 replaces
nothing. The grant comes from `role` alone on both token paths (R-38),
so the gate treats people and machine clients alike. Readers keep
their `GET`s. A machine client whose role is in `allowedRoles` is
refused with 403 until Open, so automation that calls mutating
operations MUST hold off, or retry after Open. The build MUST add
these three deploys to the README as an upgrade step, with the
`control-plane:closed` value and the 90 s wait, beside the
`fleetName` pattern change of §3.3.

An explicit deny wins over any allow, and the stack never reads an
attached policy to keep it (P-3). The list names only the stack's own
resources and fits one policy. It also closes the older path of
`tenantBuildManagedPolicyArns`, whose policies attach to the tenant
provisioning role in the stack's own account (§3.3). No denied role
needs a denied action. The deny does not close every path. An attached
grant of `sts:AssumeRole` on another role in the control plane account
(an admin role or a CDK bootstrap role), or of CloudFormation writes
through a privileged execution role, still reaches the pair. So do
admin writes on the vendor IdP, which can create a user or a client
that carries the operator role, and writes to the location of a
registered script or hook source (an S3 bucket or a repository), which
change what the next provisioning build runs with the pair or what a
hook runs with its role. So does a principal outside the denied roles
that the deployer grants a denied action. These stay the deployer's
choice: grant no hook role write access to the vendor IdP or to any
script or hook source (T41, M30).

The hook buildspec MUST hand every variable of R-42 to the hook script
as an environment variable only and run it as `bash "$HOOK_SCRIPT"`,
and MUST NOT interpolate any value into the buildspec or a command
line: `TENANT_NAME`, the `PARAM_` values and `SCRIPT_OUTPUTS` are
tenant-shaped, and interpolated they would run as code under the hook
role (T44). Each hook project has the provisioning projects' concurrency
cap and log retention (M15, M17), and private hook sources need source
credentials on the hook projects, as for the provisioning projects
(N-6).

**R-42 (hook environment):** a hook build MUST receive these variables
and no other control plane state (H-5):

| Variable | Cell events | Deployment events |
|---|---|---|
| `EVENT` | `CELL_CREATE\|CELL_UPDATE\|CELL_DELETE` | `DEPLOYMENT_CREATE\|DEPLOYMENT_UPDATE\|DEPLOYMENT_DELETE` |
| `PHASE` | `PRE\|POST` | `PRE\|POST` |
| `HOOK_ID`, `HOOK_SCOPE` | the hook's id; `GLOBAL\|APPLICATION` | as for cells |
| `APPLICATION_ID`, `CELL_ID`, `CELL_ACCOUNT_ID` | ✓ | ✓ |
| `TENANT_ID`, `TENANT_NAME` | — | ✓ |
| `OPERATOR_ID` | ✓ (the verified operator identity, M12) | ✓ |
| `EXECUTION_ID` | the execution's name, one per accepted operation | as for cells |
| `ATTEMPT` | `1`; `2` or `3` on a delete hook's later attempts, counting attempts that started a build (R-46) | as for cells |
| `HOOK_SCRIPT` | the hook's `script` path (R-41) | as for cells |
| `PARAM_<NAME>` | the cell's resolved set (R-34), as the cell script receives it | the deployment's resolved set (R-32), as the tenant script receives it |
| `SCRIPT_OUTPUTS` | `POST` only: the script's outputs (R-43), `{}` when it wrote none | as for cells |

There is no `ADMIN_EMAIL`: onboarding input crosses the boundary once, to
the create script (P-3). There is no `externalId` and no pair
credential (R-41). A hook MUST take the identity it acts on
(`APPLICATION_ID`, `CELL_ID`, `TENANT_ID`, `CELL_ACCOUNT_ID`) from these
variables, never from `SCRIPT_OUTPUTS`. Hooks MUST be idempotent and safe
to re-run, as scripts are (R-15): an update runs them again, a delete
retry runs them again, and a failed create is cleaned up by a delete
whose hooks run even when the create's hooks never did. `EXECUTION_ID`,
with `EVENT`, `PHASE` and `HOOK_ID`, names one occurrence of a hook
across its attempts, so a hook that must record each event once (an
audit export, a meter) keys on it and treats a repeat as done.

**R-43 (script outputs):** before each script the provisioning buildspec
MUST create a fresh temporary directory outside the source tree and
pass the script `OUTPUTS_FILE`, a path in it that does not yet exist,
so nothing committed to the source can stand in for output. A cell or
tenant script MAY write a JSON object to that path: keys matching
`[A-Za-z][A-Za-z0-9_]{0,63}`, values strings of printable ASCII (0x20
to 0x7E), at most 4,096 bytes in its compact form. Keys MUST be
unique: parsers resolve a repeated key differently (first wins or last
wins), so a value could mean one thing to a hook's validator and
another to its user. Values MUST be printable ASCII so that a byte is
a character to the buildspec, to CodeBuild, to JSONata and to Step
Functions, and so that the compact form escapes only `"` and `\`. The
script runs as a child process (`bash "$SCRIPT_PATH"`). After the
script succeeds the buildspec MUST parse the file, refuse it when a key
repeats, check it against the other rules, and export as
`SCRIPT_OUTPUTS` its own re-serialisation of the parsed object, never
the file's bytes, always: `{}` when the script wrote no file. The
re-serialisation MUST be the compact form, with no insignificant
whitespace and `"` and `\` the only escapes, which `jq -c .` produces
for printable ASCII, and the 4,096-byte limit is measured on it. A
script that writes `{"endpoint": "a"}` therefore exports
`{"endpoint":"a"}`. On create and update a file that fails the check
fails the build, so the operation ends `*_FAILED` with the broken rule
in `statusReason`. On delete the buildspec logs the drop and exports
`{}`, so a bad file never blocks cleanup (P-9). `SCRIPT_OUTPUTS` MUST
be the build's only exported variable. CodeBuild limits the total of a
build's exported variables to between 8 and 16 KiB and, past it,
returns every exported value as an empty string while the build and
the execution succeed (spike H-1, §9.1). A 4,096-byte value with
nothing else exported is half the 8,192 bytes H-1 saw kept. A value
made of `"` and `\` escapes doubles when serialised again, so H-10
checks that such a value round-trips too.

The buildspec check is a format check, not a trust boundary: it runs in
the container the script just ran in, with tools the script could have
replaced, and in a tenant-owned account the script reads what the
tenant controls (T40, T44). The workflow MUST therefore check the value
again, by the same rule, in the script task's JSONata `Output`, which
keeps it beside the build ARN and status (§8.1). It rejects a value
that is absent or empty (the H-1 overflow, or a build that did not
export), longer than 4,096 characters, or not a compact JSON object of
printable ASCII string values. With printable ASCII, 4,096 characters
are 4,096 bytes, so the guard and the buildspec enforce one rule. The
last test is a regular expression over that grammar, and the pattern
MUST be linear: no quantifier may hold another unbounded quantifier
(the key's bounded `{0,63}` inside the `*` loop is allowed), and every
choice the pattern makes MUST be decided by the next two characters,
the loop exit included, so a near miss is rejected in one pass over at
most 4,096 characters. A pattern of that shape, with `K` standing for
the key pattern above:

```
^\{(?:"K":"(?:[ !#-\[\]-~]|\\["\\]|","K":")*")?\}$
```

The pattern admits only the compact spelling. A value it refuses for
its spelling alone (a space after `:` or `,`, a `\/`, a `\u0041`)
never came from a buildspec that ran as specified, because the
buildspec exports its own compact form. The pattern cannot see a
repeated key: it admits `{"a":"1","a":"2"}`. A hook MUST therefore
refuse an object with a repeated key, as the buildspec does.

The guard MUST NOT use `$parse`. On bad input `$parse` raises
`States.QueryEvaluationError`, which goes to the task's Catch, and the
Catch path is a failure write, which is wrong on delete. Any evaluation
error the guard still raises is a defect, and on delete it MUST still
yield `{}`: the delete script task catches `States.QueryEvaluationError`
apart from build failures and goes on with `{}`. On create and update a
rejected value, or an evaluation error, takes the failure path (§8.2)
with `statusReason` "script outputs rejected", the script's changes
staying in place as after a post hook failure; on delete the workflow
goes on with `{}`. Once escaped in state an admitted value is at most
8 KiB, which §8.1 budgets. The control plane MUST NOT read, interpret
or store the outputs beyond the execution: they exist only in the
execution history and the build records. Outputs are untrusted data,
and a hook MUST validate every value it uses. Outputs MUST NOT be
secrets (N-12). Nothing a pre hook produces reaches the script (§11).

**R-44 (only operations start hooks):** a hook MUST run only as a step of
an execution that a control plane operation started (§8.3). There MUST
be no operation that runs a hook on demand. Nothing a script, a cell
account or a tenant controls can declare, select, skip, change or start
a hook: an execution's hooks are fixed when the operation is accepted
(R-40), from records that only the API writes, in an execution only
the API starts (R-41).

---

## 7. Placement (the heart of the design)

Placement happens **synchronously inside `CreateDeployment`**, before the
workflow starts. It embodies P-5, P-6, P-7, and P-11 simultaneously.

### 7.1 Algorithm

```
0. TARGET    — read the tenant record; missing → 404.
               read the application record; missing → 404. Its
               definition is the stamp for a new cell (step 3).
               read the global hooks (R-40); failure → 500,
               nothing written.
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
- `PutHook` or `DeleteHook` lands while an operation is between its
  read of the global hooks and its write (R-40). That one operation
  runs without the new hook, or with the deleted one, and its
  `lastGlobalHooks` says which; the next operation sees the change.
  Nomination, not a guard (P-5).
- A global hook deleted or replaced, for instance because its source
  was poisoned (T5), keeps running in every execution accepted before,
  until each ends: up to the execution timeout (R-23). The only stop is
  `StopExecution` on each such execution, which bypasses the Catch and
  strands its record in `CREATING`, `UPDATING` or `DELETING` (§7.4); an
  operator weighs that against letting the hook run (T5, T43).

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
the remediation path. Compensation never touches a counter. Hook
resolution adds no window here: the global hooks are read in step 0,
before the placement transaction (R-40).

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

Around each build the workflow runs the hooks of its event (§8.3).

### 8.1 Resolved input

**R-20:** the service MUST resolve everything the workflow needs — source,
script paths (from the cell's stamp, never from the application record),
failure statuses, ids including the `tenantId` and `applicationId`, the
tenant's `name`, the deployment's resolved parameter set (R-32), the
cell's resolved parameter set (R-34) when the execution has a cell build, the
cell's `accountId`, the two provisioning role ARNs derived from it, the
account's `externalId`, and the hooks of each event the execution runs
(R-40), already in run order (R-45) — into the execution input. The
workflow MUST NOT re-read mutable records to decide what to do. Why: a
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
174 KiB. Hooks add at most 20 resolved definitions to that execution (five
global and five application hooks for each of its two events). R-39
admits no character JSON escapes in a hook field, so a definition is as
large in the input as raw: under 1,600 bytes as compact JSON (id,
source, script, timeout, revision), about 1.5 KiB, 31 KiB in all.
One script's outputs (R-43) are in state while its post hooks run: at
most 4,096 printable ASCII characters, of which only `"` and `\`
escape, so at most 8 KiB, for a value the buildspec checked and for any
value the workflow guard admits alike. The cell event's outputs leave
state when its post hooks finish, before the deployment event starts,
so a new-cell create never holds two. The global hook results kept for
`lastGlobalHooks` (R-40) add at most ten entries of about 0.4 KiB,
4 KiB; an application hook's result leaves state once the hook
succeeded. That is about 217 KiB, which leaves about 39 KiB of the
256 KiB Step Functions limit for the rest of the R-20 input. The
application's source and the two script paths of a new-cell create
take at most 4.3 KiB of it (2,048 + 256 + 2 × 1,024 bytes), because
their charsets admit no character JSON escapes (§4.1). The ids, the two
role ARNs, the external id of at most 1,224 bytes, the tenant name and
the failure statuses need a few KiB more. That limit applies to every
state's payload, not only the input, and a CodeBuild `Build` result
echoes the build's environment variables, values included. So each
build task's JSONata `Output` MUST keep only what later states read:
the build ARN and status, plus the guarded outputs for a script build
(R-43), and for a hook build's `startBuild` and each of its
`batchGetBuilds` polls the build id, status, phase timing and
`resolvedSourceVersion`, never the environment (R-40, R-46). A full
result kept in state would add a second copy of each parameter set and
pass the limit. The limit also holds for a task's raw result before
`Output` runs, so a poll MUST name one build id per call: one hook
build's result, environment included, is under 100 KiB at the caps,
and three would pass the limit. The same holds on the failure path:
a build task's `Catch` MUST keep only the build ARN and status from the
error before it enters state, never the raw `Cause` string or a parsed
copy of the `Build`. A payload over the limit fails the execution with
`States.DataLimitExceeded`, which `States.ALL` does not catch, so no
`*_FAILED` write would run.
Keeping state small does not keep values out of the task history events
(they record the raw service result); N-11 already accepts values in
execution history.

### 8.2 Terminal writes

- **create/update success** → compare-and-set in-flight → `ACTIVE` +
  `lastBuildId` + `lastGlobalHooks` (R-40).
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
- **build start** → every provisioning build task first assumes the resolved
  provisioning role (with the resolved `externalId`, session name =
  `OPERATOR_ID`) and runs the script under those credentials (§6.1). A
  refused AssumeRole is a build failure like any other: it lands in the
  operation's `*_FAILED` status with the refusal in `statusReason` — which
  is what a customer revoking the pair looks like from the control plane.
- **build failure / task timeout** → compare-and-set from the operation's
  in-flight status to the resolved `*_FAILED` status + `statusReason` +
  `lastGlobalHooks`; a failed create or update hook is a build failure
  here (R-46), and so are script outputs the workflow rejects (R-43);
  a hook build assumes nothing (R-41). For
  a failed **cell create with a pending deployment create**, one
  transaction moves *both* records to `CREATE_FAILED` (the deployment's
  reason: "cell provisioning failed").

**R-22:** every terminal write retries transient failures (reference: a
2-second interval, backoff rate 2, `MaxAttempts` 6 (six retries after
the first try), 126 s of waits); retry exhaustion is caught and routed
through the same conditional `*_FAILED` transition when
the record still exists. This shrinks — but does not eliminate — the
stranding window, because the failure write is itself a write that can
exhaust retries (documented residual, §7.4).

**R-23 (timeouts):** each script build task MUST have a catchable
task-level timeout routed to the failure path. A hook attempt is bounded
on both sides instead (R-46): CodeBuild stops the run at
`timeoutMinutes`, refused starts end after 5 minutes, and CodeBuild
stops a queued build at 10 minutes less the minutes its start was
refused, so refusals and queue together take at most 10. The attempt's
deadline is the run, those 10 minutes and five minutes of margin, at
which the workflow stops the build itself, so the deadline is a
backstop and a wait in the queue never reads as a hook timeout. The
execution-level timeout MUST
exceed the sum of every build budget the execution can run at the caps,
queue time included, plus terminal-write margin. It is a final safety
net, never the normal timeout path: a tripped execution timeout
bypasses the Catch and strands records. At the caps (ten hooks per
event, R-39) one hook attempt takes at most 47 minutes (its deadline of
30 run, 10 refused or queued and 5 margin, plus 2 for `StopBuild` and
the polls until the build is final) and a script build at most 60:

| Execution | Worst case at the caps |
|---|---|
| create or update, one event | 10 × 47 + 60 = 530 min |
| `CreateDeployment` with a new cell, two events | 2 × 530 = 1,060 min (17.7 h) |
| cell or deployment delete, one event | 10 × 144 (each hook's budget, 3 × 47 + 3 of backoff, R-46) + 60 = 1,500 min (25 h) |

With hooks, the execution timeout is therefore 26 hours. The worst case
needs every hook at the 30-minute cap and every attempt to run it out.
Standard workflows are billed per state transition, not by duration,
so the longer net costs nothing; it bounds how long a hung execution
holds its record. The hook steps of the longest execution, a delete at
the caps, write at the larger of the refusal loop's rate of about 15.7
history events a minute and the 60-second poll's nine (R-46). With
every hook refused for its whole budget that is about 22,600 events,
and polling throughout about 13,000, both inside the 25,000-event
quota of a Standard execution. A 30-second poll would pass it.

Refusals are capped at 5 minutes and the queued timeout is shortened
by the minutes refused, so refusals and queue together never pass the
10 minutes the attempt bound counts. That keeps every number above:
the attempt bound of 47 minutes, the per-hook budget of 144 and the
history count. The delete row holds because the loop cuts every
attempt of a delete hook at the hook's budget (R-46), however many
refusal-only attempts came first.

### 8.3 Hook steps

Each build of §8 serves one **event**: `CELL_CREATE`, `CELL_UPDATE` or
`CELL_DELETE` for the cell build, `DEPLOYMENT_CREATE`,
`DEPLOYMENT_UPDATE` or `DEPLOYMENT_DELETE` for the tenant build. A
`CreateDeployment` that needs a new cell runs two events, the cell's
first. Around each build the workflow runs the event's hooks:

```
PRE hooks (global, then application)
  → script
  → POST hooks (application, then global)
  → terminal write
```

**R-45 (hook order):** for each event the workflow MUST run the `PRE`
hooks resolved for it (R-40), global hooks first and then application
hooks; then the script; then the `POST` hooks, application hooks first
and then global hooks, so global hooks wrap the application's. Within a
scope hooks run in ascending `hookId` (byte order), one at a time. Each
hook runs once per event of an execution, delete retries aside (R-46),
and post hooks run only after the script succeeded. The cell event of a
new-cell create finishes, post hooks included, before the deployment
event's pre hooks start. Deletes keep the same order, so pre hooks act
while the cell or deployment still exists: a hook that removes a route
removes it before the delete script tears down what the route points at.

**R-46 (hook failure):** a hook fails when its build does not succeed,
times out (CodeBuild's run timeout, its queued timeout, or the
attempt's deadline), or cannot start. Each hook attempt MUST start its
build with a request-response `codebuild:startBuild`, never `.sync`,
so the build id is known from the first call, and MUST then poll that
one id with `codebuild:batchGetBuilds` every 60 seconds. Each start
try sends `timeoutInMinutesOverride` set to the hook's
`timeoutMinutes` (T) and `queuedTimeoutInMinutesOverride` set to
q = 10 − ceil(r), where r is the minutes from the attempt's first try to
this one, at most 5 (below). The queued timeout is therefore never
below CodeBuild's minimum of 5, and refusals and queue together take
at most 10 minutes. The attempt's deadline MUST be data, computed from
the definition when the attempt starts: the earlier of its first
`StartBuild` try plus the run timeout, the 10 minutes of refusals and
queue, and five minutes of margin, and, on delete, 2 minutes before
the end of the hook's budget (below), so a stop at the budget's end
finishes inside it. Each poll's `Output` keeps the id, the status, the
phase timing and `resolvedSourceVersion` (H-2), never the environment
(§8.1). The loop ends when the build reaches a final status. At the
deadline the loop MUST call `StopBuild` on that id, then poll it until
it reaches a final status, within the 2 minutes R-23 budgets for
this, and treat the attempt as a timeout, or, when the budget set the
deadline, record the skip with "budget ran out". So no hook build
outlives its attempt, whatever CodeBuild did with its own timeouts,
except a build hidden behind a start whose repeats all failed, which
CodeBuild stops within q + T (below). A build that is still not final
after those 2 minutes ends the hook: `statusReason`, or on delete the
skip log, names the build as not confirmed stopped, and no further
attempt starts beside it. A failed
poll call starts nothing, so the loop polls again at the next interval
until the deadline. `statusReason` MUST tell a queued timeout from a
run timeout by the phase timing, so a hook that never ran is not taken
for a slow one.

The start of an attempt MUST be an explicit loop, never one task
`Retry`, because a refusal needs a new try and a transient error needs
the same one. When a try begins, the loop computes once, in variables,
`TRY`, the try index (1 for the attempt's first try), and that try's
q. The try's `idempotencyToken` MUST be the SHA-256 of the six
values joined by `|`, as this JSONata expression:

```
$hash($join([EXECUTION_ID, EVENT, PHASE, HOOK_ID,
  $string(ATTEMPT), $string(TRY)], '|'), 'SHA-256')
```

It is 64 hexadecimal characters (H-8), so it has a fixed length, and
it differs on every try by construction; q is not part of it. A
`StartBuild` the service refuses (throttling, the
account's concurrent build quota, the project at its
`concurrentBuildLimit`; H-8, H-9) MUST go through a `Catch` to a
30-second `Wait`, without backoff, and then a `Choice`. The `Choice`
ends the start when 5 minutes have passed since the attempt's first
try or the next try would pass the deadline; otherwise it increments
`TRY` and starts the next try. A start still refused when its window
ends is a hook that cannot start, and `statusReason` says so. Each try
computes its own q, so a refusal never lengthens an attempt past its
deadline.

A transient server error (a 5xx, or the task's own timeout) can follow
a call that created a build. It MUST be handled by a task `Retry` on
the start task, which has `TimeoutSeconds` 15. The `Retry` MUST set
`IntervalSeconds` 10, `BackoffRate` 1 and `MaxAttempts` 3, with no
jitter (`JitterStrategy` `NONE`), so each of the three repeats waits
10 seconds; the ASL default `BackoffRate` of 2 would wait 10, 20 and
40 seconds. A `Retry` re-sends the task's evaluated
`Arguments` unchanged (H-8), so every repeat carries the same `TRY`, q
and token. CodeBuild documents a token as valid for 5 minutes, within
which a repeat returns the build the first call created (to verify,
H-8). A try and its repeats end within 90 seconds (15 + 3 × (10 + 15)),
inside the token's validity. A build a late repeat starts keeps its
try's q, so it waits at most 1.5 minutes past the 10, inside the five
minutes of margin. A try whose repeats all fail ends the attempt as a
hook that cannot start, with `statusReason` "start outcome unknown",
never a new try under another token, because its first call may have
created a build that no id names. CodeBuild stops such a build within
q + T of the try's last call, by its own queued and run timeouts.
`StopBuild` MUST use the same shape: a refusal goes through the
`Catch`, a 30-second `Wait` and the `Choice` within the 2 minutes of a
stop, and a transient error is the same task `Retry`. That transient
repeat is the only task `Retry` in a hook attempt. It MUST name only
transient errors, and the refusal `Catch` only the refusal names, so
neither starts a second build for one that ran (H-8).

The poll costs three state transitions (a `Wait`, the task and a
`Choice`) per minute a hook runs: at the Standard workflow price of
$0.025 per 1,000 transitions, about $0.002 for a 30-minute hook. The
history the hook steps write grows at the larger of two rates. Polling
writes nine events a minute. The refusal loop writes about nine events
per 30-second try, which is about 15.7 a minute over 5 minutes of
refusals and the 60-second backoff that follows them. At the caps a
delete's hooks run for at most 1,440 minutes in all (R-23). Polling
throughout writes about 13,000 events, and refused throughout, about
22,600, both inside the 25,000-event history quota of a Standard
execution. The refusal interval therefore stays 30 seconds. A
30-second poll would pass that quota at the caps.

On delete each attempt MUST be one pass of an explicit loop through the
failure handling: an attempt that times out has its build stopped and
polled to a final status, the loop increments `ATTEMPT` and waits out
the backoff, and only then does the next attempt start its own build.
A task `Retry` MUST NOT run a delete attempt again, because a retried
task never enters the failure handling and would leave the earlier
build running. `ATTEMPT` counts started builds: an attempt whose start
was refused for its whole 5-minute window started none, does not count
against the three attempts and leaves `ATTEMPT` unchanged, and the
next start try follows the 60-second backoff. An attempt that ended
"start outcome unknown" may have started one, so it counts: the loop
increments `ATTEMPT`, and the next attempt MUST NOT start until q + T
have passed since that try's last call, so it never runs beside the
hidden build. That wait ends at most T + 11.5 minutes after the
attempt began, inside the attempt's share of the budget. When the
budget ends first, the skip is logged with "start outcome unknown"
and the hidden build is the residual of T42. The hook's attempts
share one budget, computed as data from the definition when its first
attempt starts: three attempts at their bound plus the backoff,
3 × (`timeoutMinutes` + 17) + 3 minutes, 144 at the cap. Every
attempt's deadline and refusal window end 2 minutes before the
budget's end at the latest (above), so a hook never runs past its
budget, however many refusal-only attempts it had. When the budget
sets the deadline, the loop calls `StopBuild` on a running build,
polls it to a final status and records the skip with "budget ran
out". Then:

| Event | Phase | Effect |
|---|---|---|
| create, update | `PRE` | The event MUST stop before the script runs. The record MUST land in `CREATE_FAILED` or `UPDATE_FAILED` with `statusReason` naming the scope, the hook id, the build and the kind of failure; later hooks and the script MUST NOT run, so the script has changed nothing. A failed cell create with a pending deployment create moves both records (§8.2). A global pre hook can therefore act as a gate on every application |
| create, update | `POST` | The record MUST land in `CREATE_FAILED` or `UPDATE_FAILED` as if the script had failed, `statusReason` naming the hook. The script's changes stay in place, and later hooks MUST NOT run |
| delete | `PRE`, `POST` | The workflow MUST retry the hook, three attempts in all, 60 seconds after the first failure and 120 seconds after the second (interval 60 s, backoff rate 2), each attempt a pass of the loop above. When every attempt fails, or the hook's budget is spent, it MUST log the skip (scope, hook id, event, record, build ids, and whether the budget ran out), count it (below) and go on with the next hook, the script and the terminal write, so cleanup stays reachable (P-9). A delete hook cannot stop a delete and cannot be a gate |

The remediation paths are those of P-9. `UPDATE_FAILED` is retried with
`UpdateDeployment` or `UpdateCell`, which runs the pre hooks, the script
and the post hooks again. `CREATE_FAILED` is deleted (deployment, then
cell), and the delete runs the delete hooks and the delete script
against whatever the create left, which after a pre hook failure is
nothing. Creates and updates are not retried automatically: a hook that
wants retries makes them inside its own build. The workflow MUST count
skipped delete hooks in a metric with an alarm (no actions, as for M17),
because a skip can leave an external system holding state for a record
that is gone (T42).

A stamped application hook that fails on every run is the one case a
retry cannot fix: `UpdateCell` and `UpdateDeployment` run the same
stamped hook again, and a pre hook on `DEPLOYMENT_CREATE` fails every
placement into that cell. The exits, in order:

1. Fix forward when the stamped `sourceVersion` is a branch or absent:
   push the fix to that ref, which the next build fetches (P-4), then
   retry the update or delete the failed create.
2. Stop new cells inheriting it: `PutApplication` with the hook removed
   or corrected, and, where the job must keep running, the hook
   registered as a global hook instead.
3. For a cell whose stamped hook is pinned to a commit, the destructive
   exit: delete every deployment in the cell, then the cell (each delete
   runs the hook, which cannot block it), and re-create the
   deployments, which placement puts in cells stamped from the new
   definition.

Gates and registrars, which must change after cells exist, SHOULD
therefore be global hooks, replaced through `PutHook`; an application
hook SHOULD be one its application can keep for a cell's life. The
definition-replacing `UpdateCell` that would replace a stamp is a seam
(§11).

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
| N-11 | Deployment and cell parameter values MUST NOT be secrets. They are stored in plain text on the deployment or cell record, returned by `GetDeployment` or `GetCell` to operators and readers alike (R-36), and reach the build as CodeBuild environment-variable overrides carried in the Step Functions execution input. The service logs parameter names, never values. A script that needs a secret receives its *name* as a parameter (a Secrets Manager secret or an SSM `SecureString` under the deployment's tenant namespace or the application's shared namespace, §6.2) and reads it under its own role. | Every operator and reader, and everyone who can read the table, the execution history or `codebuild:BatchGetBuilds` in the control plane account, can read the values; secret-shaped storage would need a KMS key, extra IAM and a second read path for a concern the application plane already solves. |
| N-12 | Script outputs (R-43) and hook definitions (R-39) MUST NOT be secrets. Outputs ride the Step Functions execution history, the script build's exported variables and the post hook builds' environment overrides; hook definitions are stored in plain text and returned to operators and readers alike. | The same readers as N-11; a secret-shaped path for either would need the same KMS key and second read path N-11 declines. A hook that needs a secret reads it under its own role. |

### 9.1 Service behaviour the hook design relies on

Spike results and the assumptions still to verify. Each row to verify
is a spike before hooks are built; a result that differs changes the
requirement the row names. H-3, H-4 and H-6 asked how a `.sync` hook
task behaves; the poll loop of R-46 relies on none of them, and the
rows stay so that their ids stay stable.

| # | Behaviour | Status | Relied on by |
|---|---|---|---|
| H-1 | Through Step Functions `codebuild:startBuild.sync`, `Build.ExportedEnvironmentVariables` keeps a single value of 1,024, 4,096 or 8,192 bytes. A single value of 16,384 bytes, 32 KiB or 64 KiB, and four values of 4,096 bytes (16 KiB in all), come back with every exported value an empty string, while the build and the execution report `SUCCEEDED`. A declared exported variable the build never set comes back as `""`. The limit is on the total of a build's exported variables, between 8 and 16 KiB, and overflow is silent | Verified: spike H-1, 2026-11-17, eu-central-1 | R-43, §8.1 |
| H-2 | A `batchGetBuilds` result carries `resolvedSourceVersion` for a git source; CodeBuild documents none for S3 | To verify | R-40, R-46, §8.1 |
| H-3 | Whether a `.sync` task that times out stops its CodeBuild build | Not needed: poll loop (R-46 stops the build at its deadline) | — |
| H-4 | Whether the error of a timed-out `.sync` task carries the build id | Not needed: poll loop (`startBuild` returns the id) | — |
| H-5 | CodeBuild accepts a hook build's `environmentVariablesOverride`: about fifteen fixed variables, up to 40 `PARAM_` variables of up to 1,024 bytes, and a `SCRIPT_OUTPUTS` of up to 4,096 bytes | To verify | R-42 |
| H-6 | A JSONata expression in a task's `TimeoutSeconds` sets a timeout per hook state; today's build tasks use a constant | Not needed: poll loop (the deadline is data) | — |
| H-7 | A CodeBuild service role trust policy conditioned on `aws:SourceArn` equal to the project ARN, computed from the project's physical name before the project exists, admits that project's builds and no other, for each hook role and each provisioning build role | To verify (documented for confused-deputy prevention; one synth-and-run check) | R-41 |
| H-8 | A `StartBuild` refused through a request-response `codebuild:startBuild` task (throttling, the account's concurrent build quota) fails with a `CodeBuild.` service error name that no started build produces, a refused try creates no build, and a refused `StopBuild` fails with the same names. An `idempotencyToken` passes through the Step Functions integration unchanged, and a repeat of the same request with the same token within its documented 5-minute validity returns the same build id, also after a transient error. A task `Retry` re-sends the evaluated `Arguments` unchanged, so a repeat carries its try's token, and a refused request does not bind its token. So the refusal `Catch` on those names, and a repeat under the token, never starts a second build for one that ran. CodeBuild accepts a 64-character token, the SHA-256 hex of R-46; the API reference documents no length limit | To verify | R-46 |
| H-9 | What a request-response `codebuild:startBuild` returns when the project is at its `concurrentBuildLimit`: a refusal, and its error name, or a build queued behind the cap. The CodeBuild user guide says builds over the limit are "throttled and are not run" | To verify; R-46 is designed for a refusal, and a queued build is bounded by the queued timeout and the deadline | R-46 |
| H-10 | A 4,096-byte compact outputs file whose values are all `\"` and `\\` escapes, the worst case for escaping, exported alone as `SCRIPT_OUTPUTS`, comes back byte for byte in the `startBuild.sync` result, through a JSONata `Output` into state, and into a hook build's environment override. The R-43 guard, run in a real Step Functions JSONata `Output`, accepts the largest valid value and rejects the 4,096-character near miss of §10, so the engine takes the regex literal and neither fails nor stalls over 4,096 loop iterations; the time of each run is recorded | To verify | R-43, §8.1 |

---

## 10. Acceptance Criteria

A correct implementation demonstrably passes the following end-to-end
scenario against real infrastructure in **two accounts** with **two
applications** and **two tenants** (this mirrors the reference integration
test). Account A is the control plane's own account; account B is a second
account with the role pair installed under an `externalId`. Applications X
and Y share the same source and scripts and differ in id and in their
parameter declarations; both have `maxTenants = 1` (every cell is a silo,
so cells — not deployments — are what the accounts count). Tenants T1 and
T2 are plain records. X declares parameters (step 2); every
`CreateDeployment` of X supplies `ALLOWED_EMAIL_DOMAIN = example.com`
unless a step says otherwise. The test's own vendor IdP (a throwaway user
pool) mints `role: operator` for the operator user and `role:
control-plane:reader` for a second, reader user; the stack sets
`readerRoles = ["control-plane:reader"]`. The pool is on the Essentials
plan with a user pool domain, whose `/oauth2/token` endpoint is the only
way to run the client credentials flow. It has a resource server with two
custom scopes (Cognito refuses a client-credentials client without one):
`control-plane/read`, which the stack sets as `requiredScope`, and
`control-plane/other`, which stands in for another API. Two machine clients
have a secret and both scopes: a reader client the stack lists in
`clientIds`, and an unlisted client. The trigger runs on the V3 event: it
branches on `triggerSource`, putting the users' roles under
`idTokenGeneration` and `role: control-plane:reader` under
`accessTokenGeneration` for both machine clients. A setup-stack function
reads a client's secret, gets its token for one scope from the token
endpoint and makes one API call. It returns the status, whether the token
has `aud`, whether `sub` equals `client_id`, its `role` and its `scope`,
never the secret or the token, so neither reaches a template, an output or
the assertion results. The stack sets `globalHookManagedPolicyArns` and
`appHookManagedPolicyArns` to one test policy each, which lets that hook
role write SSM parameters under its own test path in A and nowhere else;
step 16's hooks record what they saw there. The application hook test
policy also allows `states:StartExecution` on the workflow and
`lambda:InvokeFunction` on every function of the account. The R-41
deny must override both allows. The policy must exist before the stack,
because the stack validates `appHookManagedPolicyArns` at synth, so it
names the workflow by its computed ARN,
`arn:<partition>:states:<region>:<account>:stateMachine:<fleet>-workflow`
(R-41), and the functions as
`arn:<partition>:lambda:<region>:<account>:function:*`, because the
API function has a generated name. The stack under test outputs the
API function's name (`ApiFunctionName`) and the workflow's ARN
(`StateMachineArn`), and the test reads both after the deploy.

Each run of the test takes its own fleet name, `cp-integ-<run id>`,
within the `fleetName` charset and length (§3.3). The run id matches
`[a-z0-9]{1,23}` and MUST NOT contain `aws`, `amazon` or `cognito`:
the fleet name is then at most 32 characters, and the user pool domain
prefix built from it ends in no hyphen and holds none of the words
Cognito refuses in a domain prefix. The run uses the fleet name in
every stack name, as the `fleetName` of the stack under test and of
the role pair the account B stack installs, and in every other name
the test creates that must be unique in an account or a Region: the
probe role in B, the hook test paths and policies, and the user pool
domain prefix. The application ids derive from the run id, not the
fleet name (`x-<run id>`, `y-<run id>`, `z-<run id>`, at most 25
characters), because an application id is at most 32 characters
(§4.1) and the parameter paths it names
(`/application-plane/applications/<id>/shared/`,
`/application-plane/tenants/<tenantId>/<id>`) are per account and
Region, so two runs with one id would share them. Two runs can then
share both accounts and a Region. The test's leftover check looks for
that run's stacks only, and a check that a parameter namespace ends
empty looks at that run's applications, cells and tenants only. Runs
in one account and Region still share its quotas, and those limit how
many fit at once: CodeBuild's concurrent builds per account and
Region, which every run's builds and hook builds draw on, and the API
Gateway control plane request rate, which a deploy of several REST
APIs at once can exceed. They also share state that per-run names do
not separate: the stack under test's REST API creates the API Gateway
CloudWatch role and the `AWS::ApiGateway::Account` setting that names
it, which is one per account and Region, goes to whichever run
deployed last, and is retained when the stack is deleted. That role
and setting are expected leftovers, outside the per-run leftover
check.

1. **Auth:** an operation without a JWT is rejected; with a valid vendor
   IdP JWT it succeeds. A reader token (R-36) succeeds on every `GET`
   operation and is refused with 403 on `POST`, `PUT` and `DELETE` alike,
   nothing written; a token whose role is in neither set is refused on
   every operation. The listed machine client's access token, which has
   no `aud` (R-38), succeeds on `ListTenants` and `GetTenant` and is
   refused with 403 on `CreateTenant`, nothing written; its token for
   `control-plane/other` alone and the unlisted client's token are
   refused with 403 on `ListTenants`.
2. **Applications:** `PutApplication` with a missing script path, a
   script path holding a control character or a source location with
   userinfo → 400; with an id outside the charset → 400;
   `PutApplication` X and Y → 200;
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
   tenant parameter, and `GetCell` reports empty `parameters`. Account A is
   1/2; X has `cellCount = 1`; T1 has `deploymentCount = 1`.
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
16. **Hooks:** `ListHooks` is empty. `PutHook` with an unknown event, a
    phase outside `PRE|POST`, a timeout of 4 or 31, a script path with
    a space, a source location with userinfo
    (`https://u:p@host/r.git`) or a source ref holding a control
    character → 400; a reader's `PutHook` → 403, nothing written.
    `PutHook` G (`POST`, all six events) → 200 with `revision = 1`;
    re-sent unchanged → `revision = 2`; `GetHook` G returns the
    definition with `revision = 2`. `PutAccount` A with `maxCells = 3`.
    `PutApplication` Z (Y's source and scripts, `maxTenants = 2`, three
    parameters: `HOOK_FAIL` with default `no`, and `API_FUNCTION_NAME`
    and `WORKFLOW_ARN`, whose defaults the test sets from the stack
    outputs `ApiFunctionName` and `StateMachineArn` before this put,
    because R-42 hands a hook neither name) with two application
    hooks: `a-pre` (`PRE`, `DEPLOYMENT_DELETE`), which fails when
    `PARAM_HOOK_FAIL` is `yes`, and `b-post` (`POST`,
    `DEPLOYMENT_CREATE`), which fails when it is `post`; a third hook
    with a repeated id → 400. Every hook records, under its own scope's
    test path in A, a sequence stamp, `EVENT`, `PHASE`, `HOOK_ID`,
    `HOOK_SCOPE`, `EXECUTION_ID`, `ATTEMPT`, the ids, `OPERATOR_ID`,
    its `PARAM_` variables, `SCRIPT_OUTPUTS` and its caller identity;
    Z's scripts record a sequence stamp too, and its tenant create
    script writes `{"endpoint": "<TENANT_ID>.example.com"}` to
    `OUTPUTS_FILE`. `CreateDeployment` T1/Z creates cell 4 in A, and
    the stamps show this order: cell create script, G (`CELL_CREATE`),
    tenant create script, `b-post`, G (`DEPLOYMENT_CREATE`), so
    application post hooks run before global ones. `b-post` saw
    `EVENT = DEPLOYMENT_CREATE`, `PHASE = POST`,
    `HOOK_SCOPE = APPLICATION`, `APPLICATION_ID = Z`, cell 4,
    `TENANT_ID = T1`, `CELL_ACCOUNT_ID = A`, the operator's id,
    `ATTEMPT = 1`, `PARAM_HOOK_FAIL = no` and
    `SCRIPT_OUTPUTS = {"endpoint":"T1.example.com"}`, the compact
    re-serialisation of what the script wrote; G on `CELL_CREATE` saw
    no `TENANT_ID` and
    `SCRIPT_OUTPUTS = {}`. Each hook's caller identity is its own hook
    role in A, never a provisioning role, and `b-post`'s attempt to
    write under the global test path was refused. `b-post` also
    called `states:StartExecution` on `PARAM_WORKFLOW_ARN` with input
    `{}`, which its test policy allows, and recorded `AccessDenied`
    beside its refused SSM write. Its test policy also allows it to
    invoke the API function, and it invoked `PARAM_API_FUNCTION_NAME`
    twice, unqualified and with `Qualifier=$LATEST`, each time with a
    `GET /hooks` event whose `requestContext.authorizer` claims the
    operator role, and recorded `AccessDenied` both times. The forged
    event names a read route, so a deny that failed would show as a
    recorded success and write no state. `GetCell` 4 shows the two stamped application hooks; `GetCell` 4 and `GetDeployment`
    T1/Z report `lastGlobalHooks` naming G at revision 2 with the
    commit its build ran. `UpdateDeployment` T1/Z returns to `ACTIVE`,
    and G recorded `DEPLOYMENT_UPDATE` under an `EXECUTION_ID` other
    than the create's. `PutHook` P (`PRE`, `DEPLOYMENT_CREATE`), which
    always fails. `CreateDeployment` T2/Z with `HOOK_FAIL = yes` lands
    in cell 4 and ends `CREATE_FAILED` with `statusReason` naming
    `GLOBAL/P`; T2/Z's tenant create script and `b-post` recorded
    nothing, and `/application-plane/tenants/T2/Z/*` does not exist.
    `DeleteHook` P → 200; `GetHook` P → 404. `DeleteDeployment` T2/Z:
    `a-pre` fails three times, recording `ATTEMPT` 1, 2 and 3, the skip
    is logged and counted, the tenant delete script runs, the record is
    removed and cell 4 drops to one tenant; G recorded
    `DEPLOYMENT_DELETE` after the script. `CreateDeployment` T2/Z with
    `HOOK_FAIL = post` lands in cell 4 and ends `CREATE_FAILED` with
    `statusReason` naming `APPLICATION/b-post`; the tenant create
    script ran, `/application-plane/tenants/T2/Z/*` exists, and G
    recorded no `DEPLOYMENT_CREATE` for it. `DeleteDeployment` T2/Z:
    `a-pre` passes, the tenant delete script empties the namespace and
    cell 4 drops to one tenant again. `DeleteDeployment` T1/Z: `a-pre`
    recorded before the tenant delete script, G after it. `ListHooks`
    shows G alone.
17. **Teardown:** deleting all deployments frees their slots and every
    tenant's `deploymentCount` returns to 0; deleting the now-empty cells
    removes them **and releases the account and application slots**
    (A → 0/3, B → 0/1, X, Y and Z → `cellCount = 0`); G recorded a
    `CELL_DELETE` for every cell; `DeleteHook` G → 200; `DeleteTenant` T1
    and T2 → 200; `DeleteAccount` A and B → 200; `DeleteApplication` X, Y
    and Z → 200; `ListTenants`, `ListAccounts`, `ListApplications` and
    `ListHooks` are empty; the parameter namespaces in **both** accounts
    end empty. Cell 1's
    delete script recorded `PARAM_CELL_SIZE = medium`; T2/X's tenant
    delete script recorded `PARAM_TIER = gold` and `PARAM_LOG_LEVEL =
    warn` (a default) and no `PARAM_ALLOWED_EMAIL_DOMAIN`. Every
    operation has run at least once.

Plus unit-level assertions that no state-dependent write path is
unconditional (P-5), that
exactly two code paths mutate each of `tenantCount`, `deploymentCount` and
the two `cellCount`s and `hookCount` (P-6), that `PutAccount`,
`PutApplication`, `CreateTenant` and `UpdateTenant` never write a
counter (R-24, R-29, §4.3), that neither hook role is trusted by the
pair or granted its AssumeRole, that a global hook starts only in the
global hook project and an application hook only in the other, that
only the workflow role holds `codebuild:StartBuild` on the hook projects
and it holds no `iam:PassRole` on either hook role, while the build and
API roles hold neither, that only the API role holds
`states:StartExecution` on the workflow and no build role and no hook
role holds it, that one standalone `AWS::IAM::Policy`, on which no
resource depends, carries the explicit deny of R-41 with every action
and resource of its list (`iam:PassRole` on the six roles, the seven
IAM role writes on the stack's ten roles, the six CodeBuild actions on
the four projects, `states:StartExecution` and `UpdateStateMachine` on
the workflow's state machine ARN and `states:RedriveExecution` on its
execution ARN, `execution:<fleet>-workflow:*`, the six Lambda writes
on the API and authorizer functions, the four Lambda invoke and
permission actions (`InvokeFunction`, `InvokeAsync`, `AddPermission`,
`RemovePermission`) on the API function, each Lambda entry on both the
unqualified ARN and the qualified `:*` form, the four API
Gateway writes on the REST API and its sub-resources, and the seven
table writes), that its `Roles` name each of the six denied role
resources of the template and no other role, so the workflow, API,
authorizer and API Gateway CloudWatch roles carry none, that the four
projects and the workflow have their fleet-derived physical names, that
each build role and each hook role trusts CodeBuild only on the
`aws:SourceArn` computed from its own project's name, that the
hook buildspec assumes no role, passes
no external id, interpolates no variable and runs `bash "$HOOK_SCRIPT"`
(R-41), that the resolved hook lists follow R-40 and R-45 and are read
before the operation's first write, that an invalid `OUTPUTS_FILE`, one
with a value outside printable ASCII included, fails a create and is
dropped on a delete, that the provisioning buildspec exports
`SCRIPT_OUTPUTS` alone, as its compact re-serialisation of the parsed
file, and `{}` when no file was written, and refuses a repeated key,
that the
script task's `Output` rejects an empty, over-long or malformed value
on create and update and substitutes `{}` on delete, that the guard
rejects a 4,096-character near miss (a valid object of `\"` escapes
with its closing `}` missing) within 100 ms, and that an `Output`
evaluation error on a delete still yields `{}` (R-43), that a hook
attempt starts its build request-response with the run timeout, a
queued timeout of 10 less the minutes refused and an idempotency token
that is the SHA-256 `$hash` of the execution, event, phase, hook,
attempt and try index joined by `|`, the try index and queued timeout
held in variables per try,
polls that one id with `batchGetBuilds` every 60 seconds, keeping only
its id, status, phase timing and `resolvedSourceVersion`, and at its
deadline calls `StopBuild` and polls the build to a final status, that
a `StartBuild` or `StopBuild` refusal loops through a `Catch`, a
30-second `Wait` and a `Choice` that advances the try index, for at
most 5 minutes on a start, and the only task `Retry` is the transient
repeat (`TimeoutSeconds` 15, `IntervalSeconds` 10, `BackoffRate` 1,
`MaxAttempts` 3, no jitter), and that
a failing delete hook runs as a loop of three started builds, 60 and
120 seconds apart, each started only after the last is final, a
refusal-only attempt not counted and followed by the 60-second
backoff, a "start outcome unknown" attempt counted and followed by a
wait of q + T, every deadline cut at the hook's budget, and is then
skipped (R-46), that
untargeted placement into a fleet with a
shared vendor account registered before a dedicated one creates the new
cell in the dedicated account
([ADR-035](../adr/0035-new-cells-go-to-dedicated-accounts-before-shared-ones.md)),
and that with two shared accounts at 1/2 and 0/2 a `FILL` application
creates its next cell in the first and a `ROUND_ROBIN` application in the
second
([ADR-036](../adr/0036-the-application-chooses-fill-or-round-robin-across-accounts.md)).

---

## 11. Extension Seams (documented, not built)

Per P-1, deferred generality is recorded as seams, not code:

| Extension | Seam |
|---|---|
| Standalone resource service (pooled/hybrid re-split) | extract at the deployment collection (`/tenants/{tenantId}/deployments`); the deployment is already the tenant↔cell join; propagate terminal status back via event push or M2M-authenticated polling |
| Definition-replacing field on the `UpdateCell` body | noted extension; the body carries cell parameter values only (R-34); today the stamped definition, application hooks included, is immutable and a replaced application definition reaches only new cells. It is also the non-destructive exit for a stamped application hook that always fails (§8.3) |
| Per-application cell cap inside a shared account | a join record per (account, application) with its own counter and cap, layered under the account's `maxCells` ([ADR-033](../adr/0033-account-admission-is-an-application-allowlist-on-the-account.md), option 3); today an account admits applications but does not meter them separately |
| A role pair per application | would make the application a deployment unit again and give each one its own trust boundary in every account; today one pair per account serves every application it admits, and the scripts of one application can read another's cell namespace in the same account (trusted vendor code, §6.3) |
| Explicit capacity pre-provisioning (`POST /cells`) | deliberately absent; placement is the only creator |
| Finer operator roles (an application registrar apart from an onboarder, operators scoped to accounts) | the authorizer already maps `role` to a grant (R-36) and the caller context carries it; a new grant is a new row in the matrix and a new policy shape. T34 and T27 are the threats it would close |
| Secret deployment parameters | a `secret` flag on the declaration, with the value stored as a reference to a control-plane-owned secret and resolved only inside the build; today a script receives a secret's name as a plain parameter and reads it under its own role (N-11) |
| Cell parameter values at birth | a body on the pre-provisioning seam (`POST /cells`) or a per-account override map; today a new cell always starts on the declared defaults and differs only after `UpdateCell` (R-34). Values that differ per account belong in the application's shared namespace in that account (§6.2) |
| Stuck-execution sweep for aged transitional records | covers the two documented stranding gaps (§7.4, R-22) |
| Auto-scale-in (delete after N days empty) | business plane policy layered on the explicit `DeleteCell` and `DeleteAccount` APIs |
| A Region per account | an `accountId`-plus-`region` target on the account record; the build runner's AssumeRole already yields credentials usable in any Region, so the seam is the account record and the scripts' Region input, not the trust model |
| Account vending | an upstream system creates the account and installs the role pair, then calls `PutAccount`; the control plane's contract starts at registration |
| Per-account placement policy (drain, prefer, weights) | today: `owner` and `applicationIds` decide eligibility, `maxCells` decides capacity, dedicated accounts are filled before shared ones, and the application's `placementStrategy` orders the rest; a `placement` field on the account record is where a per-account policy would live |
| Load-aware placement | a strategy that reads what the cells are doing (utilisation, cost, latency) rather than how many there are; the `placementStrategy` enum is where it would be added, the account scan is where the signal would be joined in |
| Tenant migration between cells or accounts | would need a tenant-level transitional status spanning two cells and two counters; deliberately excluded |
| Hooks on tenant record and account events | `CreateTenant`, `UpdateTenant`, `DeleteTenant`, `PutAccount` and `DeleteAccount` run no workflow, so a hook on them needs one, or a synchronous hook inside the request. The `EVENT` enum and the hook definition's `events` are where the events would be added; today a tenant change reaches downstream systems through its deployments' events ([ADR-044](../adr/0044-run-vendor-hooks-around-cell-and-deployment-scripts.md)) |
| Outputs from a pre hook into the script | a pre hook that allocates something (an address range, a name) writes outputs the script receives as variables; today pre hooks only gate and act, and the script's inputs come from §6.1 alone (R-43) |
| A hook role per application or per global hook | one hook role per application, or per global hook, so one hook cannot use what another needs; today every application hook runs as `<fleet>-app-hook` and every global hook as `<fleet>-global-hook`, so a metering hook holds what a route registrar holds (R-41, T41) |
| Lifecycle events on an event bus | a global post hook that publishes each event to Amazon EventBridge gives asynchronous consumers what option 3 of ADR-044 offered, and keeps the ordering and failure rules of §8.3 for the hooks that need them |
| Gating deletes | a delete hook that can stop a delete; deliberately absent, because cleanup must stay reachable (P-9, R-46) |

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
5. §6 + §9 — the script contract, the hook contract (§6.5, §8.3), the
   role asymmetry, and the account role
   pair that carries it into every account.
6. §10 — build the acceptance test alongside, not after; it needs two
   accounts and two applications from the first run.

The reference implementation's `architecture.md` and `adr/`
carry the detailed rationale behind each requirement — consult them when a
requirement here seems arbitrary; it almost certainly isn't.

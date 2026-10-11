# ADR-0012: Cell-based deployment model with a deployment-configured CellDefinition

**Status:** Accepted (2026-09-07)

**Context:** The silo model gives every tenant a fully dedicated deployment
defined by tenant-supplied `source` + `scripts`. Moving to a cell model — a
shared application deployment per cell plus a per-tenant deployment inside
it, with a maximum tenant count per cell — raises the question of where the
two provisioning definitions (cell-level and tenant-level) live. Options:
keep per-tenant script definitions and add cell scripts separately, or make
the whole definition deployment configuration.

**Decision:** One deployment-configured **CellDefinition**
(`{source, cellScripts, tenantScripts, maxTenants}`, via CDK context),
**stamped onto each cell record at creation**. Every tenant in a cell is
provisioned with that cell's stamped definition; `CreateTenantInput` shrinks
to `{name, description?, adminEmail}`. The cell is the N:1 placement join
predicted by ADR-001/ADR-009 — it returns as an entity and a `tenant.cellId`
field, not as a separate service: the sample stays one service, one table,
one API, and one workflow. Provisioning uses two shared CodeBuild projects:
a cell project whose role owns `/application-plane/cells/*`, and a tenant
project whose role can read cell parameters but cannot mutate them. This
refines ADR-002 for the different permission boundaries introduced by cells.

**Consequences:** Cells are homogeneous by construction — a tenant is
placeable into *any* cell with capacity, which per-tenant provisioning
definitions would break. Stamping makes config changes forward-only: existing
cells keep the definition they were built with; new provisioning *code*
still flows in without a definition change because git sources are fetched
fresh per build. The tenant's `/resource` sub-path survives with new
semantics: `GET` returns the effective (cell-inherited) definition plus build
state, `PUT` (no body) re-applies the tenant deployment. The no-body `PUT`
re-apply (here and on `/cells/{cellId}`) is action semantics carried in a
`PUT` for consistency with the implemented silo baseline; a `POST .../apply`
action path would be the more literal modelling and is a reasonable rename if
the baseline API is ever revised. What is lost:
heterogeneous per-tenant deployments — that is the silo model, preserved in
`architecture.md`'s history. A definition-replacing `UpdateCell` body is a
noted extension, deliberately excluded.

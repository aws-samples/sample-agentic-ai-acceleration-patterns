# ADR-0037: A deployment is one tenant in one application

- Status: Accepted
- Date: 2026-11-11
- Supersedes: ADR-0001
- Amends: ADR-0009, ADR-0012, ADR-0013, ADR-0017, ADR-0023, ADR-0032
- Deciders: Dave Roberts (SA)

## Context
A tenant is a customer of the vendor, and a customer can use several of the vendor's applications (ADR-032). The tenant record carried the placement itself — one `cellId`, one lifecycle status, one build state — because a tenant had exactly one deployment; ADR-001 removed the placement entity for that reason, and ADR-009 folded the per-tenant resource into the tenant record. With several applications a tenant has one deployment per application, each in a cell of that application, each with its own lifecycle. One record cannot carry N placements with N statuses and still be written by field ownership and conditional writes (P-5, R-21).

## Options considered
### Option 1: A tenant record per application
Keep tenant = one placement; a customer on two applications is two tenant records that share nothing but a non-unique name. Pros: no model change. Cons: the control plane cannot say which tenants are the same customer, which is the one fact the vendor asked it to hold; `TENANT_ID` differs per application, so the application plane cannot correlate either.

### Option 2: Tenant plus a Deployment entity
The tenant is the customer: name, description, and a count of its deployments. A **deployment** is the tenant in one application, identified by `(tenantId, applicationId)`, holding `cellId`, status, `lastBuildId`, `statusReason`. Placement runs on `CreateDeployment`; the tenant's own lifecycle is synchronous and runs no build. Pros: the join exists because the relation is 1:N, which is the test ADR-001 set for reintroducing it; every lifecycle field lives on exactly one record; a tenant's deployments are one base-table query (`PK = TENANT#<id>`, `SK begins_with DEPLOYMENT#`); `TENANT_ID` is the same across applications, so the application plane can correlate. Cons: one more entity, one more counter (`Tenant.deploymentCount`), three more operations.

### Option 3: A map of placements on the tenant record
`deployments: {applicationId → {cellId, status, …}}` on one item. Cons: conditional writes and field ownership on nested attributes; no way to list a cell's or an application's deployments through an index, because one item carries one index attribute.

## Decision
Option 2. `Deployment` is keyed `PK=TENANT#<tenantId>`, `SK=DEPLOYMENT#<applicationId>`; one per tenant per application (a second create is a 409). It owns everything the tenant record used to own about provisioning: status, `cellId`, `lastBuildId`, `statusReason`, the stamped definition view and the idempotency replay target. The tenant record keeps `name`, `description` and gains `deploymentCount`, claimed in the placement transaction (`IF exists`, which also makes a deleted tenant a 404) and released in the deployment-delete transaction; `DeleteTenant` is a conditional delete on `deploymentCount = 0`. The cell's `tenantCount` counts deployments — in a cell of one application that is the number of distinct tenants, so `maxTenants` keeps its name and meaning. `adminEmail` moves to `CreateDeployment`: the first admin user is per application. Tenant scripts own `/application-plane/tenants/<tenantId>/<applicationId>/*`, so two deployments of one tenant in one account never share a path; the role grant (`/application-plane/tenants/*`) is unchanged. Scripts receive `TENANT_ID`, `TENANT_NAME`, `APPLICATION_ID`, `CELL_ID` as before.

## Consequences
Four counters, two transactional code paths each (P-6). The API has 22 operations: five tenant (all synchronous), five deployment, four cell, four account, four application; `GetResource` and `UpdateResource` become `GetDeployment` and `UpdateDeployment`, `DeleteTenant`'s build path becomes `DeleteDeployment`. The status state machine applies to cells and deployments; a tenant has no status. The acceptance test onboards one tenant into two applications and shows both deployments in one account. The §11 seam "standalone resource service" is now the deployment collection itself. Revisit if a deployment ever needs more than one cell (an application spanning cells), which would make the deployment-to-cell link 1:N in turn.

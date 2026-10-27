# ADR-0023: Pass the tenant name to tenant scripts as `TENANT_NAME`

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (SA)

## Context
Tenant scripts receive `TENANT_ID`, `CELL_ID`, `OPERATION`, `ADMIN_EMAIL` and `OPERATOR_ID`. A downstream onboarding call (tenant-identity `CreateTenant`, [control-plane mounting spec](../../tenant-identity/design/control-plane-mounting.spec.md)) needs a human-readable name, which the control plane already stores.

## Options considered
### Option 1: Add `TENANT_NAME` on every tenant operation
Same boundary test as `ADMIN_EMAIL` (ADR-004): onboarding input, not configuration. Already persisted, so no new data.

### Option 2: The script uses the tenant id as the name
No change. Con: downstream registries show ids where people expect names.

### Option 3: Wait for the opaque `parameters` map (spec §11)
General. Con: a larger change for one field the record already has.

## Decision
Option 1. The name passes the same boundary test ADR-004 applied to `ADMIN_EMAIL`: it is an input the operator supplies at onboarding and the application plane needs to act on, not control-plane configuration, so forwarding it keeps the control plane ignorant of what the application plane does with it. The record already holds the value, so no new data is collected and no schema changes; delivering it on every operation (not only create) lets update and delete scripts address the same downstream object by the same name. Option 2 would make the consumer's registry show opaque ids, and Option 3 would hold a one-field change behind a general mechanism that has no second consumer yet.

## Consequences
Spec §6.1 gains a row (dated amendment when accepted). The name is not a secret and may be logged, but it is operator-supplied free text (length-limited only), so scripts must quote it and never use it unsanitised as an identifier (`scripts/CONVENTIONS.md`, Untrusted inputs). `UpdateTenant` changes the stored name without starting a build, so a rename reaches the tenant scripts, and anything they maintain downstream, only on the next `UpdateResource` or `DeleteTenant` for that tenant; until then the application plane holds the name it last received.

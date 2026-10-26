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
Option 1.

## Consequences
Spec §6.1 gains a row (dated amendment when accepted). The name is not a secret and may be logged.

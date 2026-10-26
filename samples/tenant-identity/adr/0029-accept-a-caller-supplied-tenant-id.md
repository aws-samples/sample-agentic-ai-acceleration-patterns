# ADR-0029: Accept an optional caller-supplied `tenantId` on `CreateTenant`

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (SA)

## Context
Mounted under the control plane, a tenant already has a ULID before this sample sees it. `CreateTenant` generates its own, so the two planes would hold two ids for one tenant. Retries also need a stable key: control-plane re-runs the create script after a partial run (control-plane R-15).

## Options considered
### Option 1: Optional `tenantId` input, conditional write
One id across planes (spec M-P-1). The existing `attribute_not_exists(PK)` write makes a repeat a 409, so replay is safe. Con: a caller can pick an id; acceptable because `/platform/*` is IAM-authorised and vendor-only.

### Option 2: Keep generated ids, store a mapping parameter
No API change. Con: a second record of one fact, with a window after `CreateTenant` and before the write where the mapping is lost and a retry onboards a duplicate.

### Option 3: Idempotency token (as control-plane ADR-017)
Safe retries without exposing the id. Con: still two ids, plus an idempotency record to store and expire.

## Decision
Option 1. It removes the mapping and the duplicate-on-retry window with no new storage. The id pattern is validated by the Smithy model before any write.

## Consequences
Callers without an id are unchanged. The README API section and spec §5.1 gain the field (amend with a dated note when accepted). Revisit if `/platform/*` ever admits a non-vendor caller.

# ADR-0013: Implicit cell creation; capacity via an atomic slot claim whose lifetime equals the tenant record

**Status:** Accepted (2026-09-07 — with a bounded candidate loop: at most 5 claim attempts before falling through to new-cell creation, see §6 of the architecture)

**Context:** Cells must be created when onboarding finds no free capacity.
Concurrent onboards can race for the last slot in a cell, race to create
"the" new cell, or place into a cell that is being deleted. A correct design
needs one authoritative occupancy guard and defined slot-release semantics.

**Decision:** No `POST /cells` — cell creation is exclusively a placement
outcome inside `CreateTenant`. Placement is a single `TransactWriteItems`:
a conditional `tenantCount + 1` update guarded by `status = ACTIVE AND
tenantCount < maxTenants` **plus the tenant `PutItem`**, retrying across
candidate cells; if none succeeds, the transaction instead creates a new
cell record (`CREATING`, `tenantCount = 1` pre-claimed) together with the
tenant, and the workflow runs the cell create build before the tenant
create build in one execution. **Slot lifetime = tenant record lifetime,
atomically at both ends**: the claim and the tenant record are born in one
transaction (a service crash cannot leave a phantom slot with no tenant
referencing it), and the only decrement is the delete workflow's terminal
`TransactWriteItems`. That transaction deletes the tenant only when it exists
in `DELETING` and decrements only an existing cell with `tenantCount > 0`.
Those conditions make replays safe even after DynamoDB's finite
`ClientRequestToken` window; a stable token remains short-window protection.
After cancellation, an absent tenant proves that a prior attempt committed,
while a present tenant is moved conditionally to `DELETE_FAILED`. A
`CREATE_FAILED` tenant keeps its slot until deleted. Placement requires the
cell `ACTIVE` — the same condition closes the
place-into-`DELETING`-cell race.

**Consequences:** The counter is trustworthy because exactly two code paths
touch it, both transactional and replay-safe through item-state conditions;
client tokens add short-window duplicate suppression. A transaction
cancellation is treated as a lost placement race only when cancellation
reasons identify the cell status/capacity condition — ambiguous failures never
retarget the same tenant. Tolerated races over-provision but never corrupt:
two no-capacity onboards may create two cells, and onboards arriving while a
cell is still `CREATING` create further cells — accepted, since serialising
cell creation would need a fleet-wide lock for a rare, benign outcome (real
fleets warm capacity ahead of demand, which is out of scope). If
`StartExecution` rejects for a new-cell placement, one transaction moves both
records to `CREATE_FAILED`; cell-build failure uses the same paired failure
transition. A process crash between placement and `StartExecution` remains a
manual-repair gap. Build Tasks have catchable timeouts and terminal-write
failures are caught and routed to the conditional `*_FAILED` transitions —
which shrinks the stranding window but does not eliminate it, since the
failure write is itself a DynamoDB write that can exhaust retries; the
aged-transitional-record sweep noted in the architecture covers both gaps in
production. Cell `CREATE_FAILED` remediation follows the existing cleanup
contract: delete the tenant (frees the slot), then delete the empty cell —
both delete scripts are idempotent and tolerate partial provisioning.

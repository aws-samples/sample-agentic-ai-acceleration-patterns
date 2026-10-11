# ADR-0014: Cell scale-in is explicit — empty cells persist until an operator deletes them

**Status:** Accepted (2026-09-07)

**Context:** When the last tenant offboards, the cell's shared deployment
could be deprovisioned automatically (tight, no idle cost) or retained until
an operator acts.

**Decision:** The cell stays, empty and `ACTIVE`, and accepts future
placements. `DELETE /cells/{cellId}` is the explicit scale-in operation:
the `DELETING` transition is a **single conditional `UpdateItem`**
(`condition: status IN {ACTIVE, *_FAILED} AND tenantCount = 0`) — the
emptiness check and the transition are one atomic write, the counterpart of
ADR-013's placement claim (a read-then-write would let a concurrent placement
claim a slot before `DELETING` lands); condition failure maps to the 409.
Once accepted, `DELETING` blocks new placement, the workflow runs the cell
delete script, and removes the record with a `tenantCount = 0` conditional
delete as defence in depth.

**Consequences:** `DeleteTenant`'s blast radius stays constant — it never
implicitly tears down shared infrastructure. Idle-cell cost is an operator
decision, visible in `ListCells` (`tenantCount = 0`). The terminal
conditional delete should never fail (the atomic transition already excludes
occupancy). On condition failure, the workflow reads the cell: a missing
record means an earlier attempt committed and is treated as success; a
present record is moved conditionally to `DELETE_FAILED` with a
`statusReason`. The failure write is guarded by `attribute_exists`, so it
cannot resurrect a deleted cell as a ghost item. Auto-scale-in policies (e.g.
delete after N days empty) are a business-plane concern layered on the
explicit API, not built into the control plane.

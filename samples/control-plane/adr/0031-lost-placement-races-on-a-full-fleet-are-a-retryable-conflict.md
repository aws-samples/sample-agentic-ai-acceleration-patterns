# ADR-0031: Lost placement races on a full fleet are a retryable conflict

- Status: Accepted
- Date: 2026-11-10
- Amends: ADR-0026
- Deciders: Dave Roberts (SA)

## Context
The bounded claim loop (R-18) attempts at most five claims against existing cells and falls through to new-cell creation when all five lose a race, so that `CreateTenant` stays inside the synchronous gateway window. Before accounts had a cell limit, the fall-through always succeeded (over-provisioning, never a failed onboard). With ADR-024 and ADR-026 the fall-through can meet a full fleet: every eligible account refuses the cell-slot claim and the request ends in `InsufficientCapacityError`, whose contract says the condition "will not clear by waiting" and tells the operator to raise `maxCells`. In the miss case that is wrong: the five lost races were against cells that still had room, so a retry would almost certainly place the tenant. The case needs five consecutive lost `TransactWriteItems` on a saturated fleet, so it is rare, but it is the one place a client was told the wrong thing about retrying.

## Options considered
### Option 1: Distinguish the miss in the return value and raise a retryable `ConflictError`
The claim loop reports whether it ran out of budget or out of candidates; when the budget was spent and the fleet then refuses, `CreateTenant` throws `ConflictError` ("lost N claim races against cells with free capacity; retry") instead of `InsufficientCapacityError`. Pros: both error contracts stay exact — `ConflictError` may clear by retrying, `InsufficientCapacityError` never does; no new error shape; nothing is written in either case. Cons: one more branch in the caller.

### Option 2: Document the case under §7.2 and soften the `InsufficientCapacityError` doc
Cons: the error would then sometimes be retryable and sometimes not, and the client could not tell which from the response.

### Option 3: Loop again on budget exhaustion
Re-run the candidate scan once more before falling through. Cons: doubles the worst-case time inside the gateway window for a case that a client-side retry handles as well; still needs Option 1 for the second miss.

## Decision
Option 1. `placeIntoExistingCell` returns a `PlacementMiss` with `budgetExhausted` set when every attempt lost a race against a cell with room, and false when no candidate was eligible. When the new-cell path then fails with `InsufficientCapacityError` and the miss was the budget, `CreateTenant` converts it to `ConflictError` naming the retry. Every other path is unchanged: no candidate and a full fleet is still the terminal `InsufficientCapacityError` of ADR-026.

## Consequences
`ConflictError`'s model documentation lists the case; `InsufficientCapacityError` keeps its "will not clear by waiting" clause truthfully. Spec R-18 and §7.2 name the race and its outcome; `architecture.md` follows. A unit test provokes the path (five lost races, then `AccountFullError` from the only vendor-owned account) and asserts the 409 is a `ConflictError` with no workflow started. Revisit if a queueing semantics is ever added (ADR-026's own trigger); the budget miss would then park rather than conflict.

**2026-11-10.** The message no longer asserts free capacity. A lost claim means the cell read as ACTIVE with room and the conditional write then failed, whether another request took the slot or an operator moved the cell out of ACTIVE; the loop cannot tell which. The `ConflictError` reads "lost N claim races on candidate cells" and the retry is justified by the fleet changing under the request, not by capacity the code observed.

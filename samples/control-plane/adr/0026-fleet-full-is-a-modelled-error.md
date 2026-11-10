# ADR-0026: Fleet full is a modelled `InsufficientCapacityError`, never new capacity

- Status: Accepted
- Date: 2026-11-09
- Deciders: Dave Roberts (SA)

## Context
Before accounts had a cell limit, placement could always create a cell, so `CreateTenant` never ran out of room. With `maxCells` per account (ADR-024) it can: every vendor-owned account full for an untargeted request, or the named account full for a targeted one. The failure needs a response that a client can act on and that does not corrupt or create anything.

## Options considered
### Option 1: Reuse `ConflictError` (409) with a message
Pros: no new shape. Cons: a client cannot tell "retry later, something is in flight" from "an operator must add capacity" without parsing text.

### Option 2: A distinct `InsufficientCapacityError` (409)
Pros: machine-distinguishable; the remedy is an operator act (raise `maxCells`, register an account), which is a different client path from waiting out an in-flight transition. Cons: one more error shape in the model.

### Option 3: 503 or 429
Cons: both signal "retry", which is wrong: nothing will change until an operator acts.

### Option 4: Create the missing capacity implicitly (register the home account, lift the limit)
Cons: capacity is an operator decision (P-10); implicit widening is exactly what `maxCells` exists to forbid.

## Decision
Option 2, HTTP 409: the request conflicts with the fleet's current capacity state. The error is raised only after every eligible account's conditional claim was refused, and the placement loop writes nothing before then, so a failed request leaves no record and needs no compensation. A `clientToken` on such a request is simply unused; a retry after an operator adds capacity is a fresh onboard.

## Consequences
The Smithy model gains one error shape, bound to `CreateTenant`. The integration test must provoke it twice: untargeted with only tenant-owned capacity left, and targeted at a full account. Operators read `ListAccounts` to see which limit was hit. Revisit if a queueing or waitlist semantics is ever wanted; that would be a new transitional state, not a reuse of this error.

---

**Amended by ADR-0031 (2026-11-10):** when the bounded claim loop spent its budget on cells that still had room and the fleet then refuses a new cell, the request fails with a retryable `ConflictError`, not this error; `InsufficientCapacityError` is raised only when no candidate was eligible and every account refused.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0016: Make PROCESSING a lease, not a terminal state

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
The processor's first step moves a delivery from `AWAITING_UPLOAD` to
`PROCESSING` with a conditional write, which makes a duplicate event harmless.
But every legitimate retry also arrives after that write: the SQS retry after
a thrown error, an operator's DLQ redrive under `onValidatorError: hold`
(ADR-0009), and the redrive after a crash between the copy and the status
write (ADR-0010). If `PROCESSING` only admits the first run, every one of them
exits as a duplicate, the delivery stays `PROCESSING` forever and the drop
object expires without a terminal state or an event (F-8). The fix must keep
the duplicate protection (two processors must never both land a delivery) and
must guarantee every delivery a terminal state within a bounded time (§6.2).
Realises P-5, P-10 and §4.2, §6.2, §8.

## Options considered
### Option 1: Status-only conditional write
Pros: one attribute; the current design. Cons: cannot tell a retry of the same
work from a duplicate, so it either strands retries (F-8) or, if relaxed to
admit `PROCESSING`, lets two concurrent messages for the same object both
process and both land.
### Option 2: Lease with owner and expiry
Pros: `PROCESSING` carries `leaseOwner` (the SQS message id) and `leaseUntil`
(now plus the processor timeout). The same message id arriving again (an SQS
retry, a DLQ redrive) re-enters and continues; any message arriving after the
lease expired takes it over; a different message while the lease is live
exits; every later transition is conditional on `leaseOwner`, so only the
holder can land. A sweep finds dead leases. Cons: two more attributes and a
re-entry rule to test; each step after the lease must be safe to repeat
(the ETag-pinned reads, copy and delete are, ADR-0008).
### Option 3: Step Functions execution per delivery
Pros: the workflow's own state, retries and history replace the lease; an
execution name per object gives deduplication. Cons: a state machine and a
role per deployment and per-transition cost at N-2; moves landing out of the
processor; heavier than the problem, and already kept as the validator
carrier seam (ADR-0009).

## Decision
Option 2. `AWAITING_UPLOAD -> PROCESSING` writes `leaseOwner = messageId` and
`leaseUntil = now + processor timeout`; `PROCESSING` is re-entered when
`leaseOwner` equals the arriving message id or `leaseUntil` has passed, and
the re-entry refreshes `leaseUntil`; a live lease held by another message makes
the arrival exit. Every transition out of `PROCESSING` (`ACCEPTED`,
`REJECTED`, `KEY_UNAVAILABLE`) is conditional on `leaseOwner` and decrements
the tenant's `inFlight` in the same transaction (ADR-0015). The hourly sweep
queries the `statusBucket` GSI (ADR-0011) and moves `PROCESSING` rows whose
`leaseUntil` is more than one processor timeout in the past to
`REJECTED structural:PROCESSING_ABANDONED`, deleting the drop object under the
tenant session and publishing `DeliveryRejected`.

## Consequences
Easier: a retry, a redrive and a crash recovery all finish the delivery; a
held validator error is a pause, not a dead end; every delivery reaches a
terminal state within one sweep interval after the processor timeout, which
§6.2 can promise and the integration test proves (§10 step 7b redrive, step 7c
abandoned lease). Harder: two attributes and the re-entry rule are new
invariants with their own unit tests; a held delivery an operator does not
redrive in time is rejected, which the README states; the lease length is tied
to the processor timeout, so a change to the validator chain changes it.
Revisit if deliveries need pauses longer than a sweep cycle, which belongs to
the Step Functions carrier.

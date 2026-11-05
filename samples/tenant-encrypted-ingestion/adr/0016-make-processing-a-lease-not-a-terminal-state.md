<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0016: Make PROCESSING a lease, not a terminal state

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, second security review (G-6, G-18)

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

The second review showed the sweep's timing was wrong for SQS. With processor
timeout T, the visibility timeout is 6T and `maxReceiveCount` is 3, so a
failed attempt is visible again only after 6T and a message reaches the DLQ
after about 18T. A sweep that abandons a row once its lease is one T past
abandons an in-progress retry, deletes its drop object before SQS has
retried, and always does so for a held validator error, long before an
operator can redrive it (G-6). Realises P-5, P-10 and §4.2, §6.2, §8.

## Options considered
### Option 1: Status-only conditional write
Pros: one attribute; the original design. Cons: cannot tell a retry of the
same work from a duplicate, so it either strands retries (F-8) or, if relaxed
to admit `PROCESSING`, lets two concurrent messages for the same object both
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
Option 2, with a separate `HELD` state and sweep timing derived from SQS.
`AWAITING_UPLOAD -> PROCESSING` writes `leaseOwner = messageId` and
`leaseUntil = now + processor timeout`; `PROCESSING` is re-entered when
`leaseOwner` equals the arriving message id or `leaseUntil` has passed, and
the re-entry refreshes `leaseUntil`; a live lease held by another message makes
the arrival exit. The row is read with `ConsistentRead` under the tenant
session, so a fresh row is never mistaken for a missing one (G-18).

A validator error under `onValidatorError: hold` writes the row **`HELD`**,
clears the lease and keeps `statusBucket = OPEN` (G-6, ADR-0009); any later
arrival, an SQS retry or a DLQ redrive, takes the lease from `HELD` and
continues. Every transition out of `PROCESSING` or `HELD` to a terminal state
(`ACCEPTED`, `REJECTED`, `KEY_UNAVAILABLE`) is conditional on `leaseOwner`
(for `HELD`, on the status) and decrements the tenant's `inFlight` in the
same transaction (ADR-0015).

The hourly sweep queries the `statusBucket` GSI (ADR-0011), reads each row
with `ConsistentRead`, and:

- abandons a `PROCESSING` row only when `leaseUntil` is more than **18T plus
  one hour** in the past, after SQS has given up on every receive, moving it
  to `REJECTED structural:PROCESSING_ABANDONED`, deleting the drop object
  under the tenant session and publishing `DeliveryRejected`;
- leaves a `HELD` row alone until **14 days** after `updatedAt`, the DLQ
  retention, during which an operator can redrive, and then abandons it the
  same way.

The worst case from upload to a terminal state is therefore 18T plus one hour
plus up to one sweep interval for a crashing processor (at the 15-minute cap
on T, about 5.5 hours), and 14 days plus one sweep interval for a held
validator error; spec §6.2 states both.

## Consequences
Easier: a retry, a redrive and a crash recovery all finish the delivery; a
held validator error is a pause that survives for the DLQ's whole retention,
not a race with the sweep; every delivery still reaches a terminal state
within a bound §6.2 can promise, and the integration test proves the parts
(§10 step 7b: `HELD`, untouched by the sweep, redrive to `ACCEPTED`; step 7c:
abandoned lease, with the test shortening the wait through context). Harder:
the lease, the re-entry rule and `HELD` are invariants with their own unit
tests; a crashed delivery waits hours, not minutes, for its terminal state; a
held delivery an operator does not redrive in 14 days is rejected, which the
README states; the abandonment bound is tied to the processor timeout and the
queue settings, so a change to the validator chain or `maxReceiveCount`
changes it, and the construct derives all three from one synth-time value.
Revisit if deliveries need pauses longer than the DLQ retention, which
belongs to the Step Functions carrier.

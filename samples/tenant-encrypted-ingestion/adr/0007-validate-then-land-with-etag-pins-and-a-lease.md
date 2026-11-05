<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0007: Validate, then land, with ETag pins and a lease

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
Consumers act on landed documents, often automatically, so a document must be
checked before anyone can read it, and the bytes that land must be the bytes
checked (P-10). Delivery is at least once: SQS can hand the same message to two
processors, retry it after a crash, or redrive it from the DLQ, and a crash can
fall between any two steps. A status-only conditional write cannot tell a
retry of the same work from a duplicate, so it either strands retries or lets
two processors land one delivery. A delivery must still reach a terminal
state within a bounded time, and a terminal event must be published at least
once even if the processor dies after the row flips. Realises P-10, spec §8.

## Options considered
### Option 1: Land, then flag
Pros: one prefix, no copy, documents visible soonest. Cons: every consumer
must check a flag, and one that does not acts on an unvalidated file; the gap
between landing and flagging exposes the file anyway.
### Option 2: One prefix with object tags for status
Pros: no copy. Cons: tag conditions in every consumer policy; tags change with
`PutObjectTagging`; same failure as Option 1 for a consumer that ignores them.
### Option 3: Quarantine prefix, pinned copy to a landed prefix, lease
Pros: `documents/` holds only accepted objects; `tenantUploadRole` cannot
write there at all; `ingest/` is a quarantine with a short lifecycle; a lease
(`leaseOwner` = SQS message id, `leaseUntil`) tells a retry from a duplicate.
Cons: one `CopyObject` per accepted delivery; a re-entry rule per step to
test; the object briefly exists in both prefixes. A Step Functions execution
per delivery would replace the lease, at per-transition cost (ADR-0009).

## Decision
Option 3. The processor reads the delivery and key rows with
`ConsistentRead`. `AWAITING_UPLOAD`, or `PROCESSING` with its own or an
expired lease, takes the lease; another live lease exits; every later
transition is conditional on `leaseOwner`. Structural checks run first:
`HeadObject` records `dropEtag` and `dropVersionId` and compares the key id,
`BucketKeyEnabled`, storage class and size with the row; `GetObject IfMatch
dropEtag` checks magic bytes, a ZIP directory and the hash; then the
validator chain (ADR-0008). The step order is copy, flip, delete, publish:
step 6 `CopyObject` to `documents/<t>/<d>` with `CopySourceIfMatch`, Bucket
Keys off and `Content-Disposition` (`PreconditionFailed` is
`OBJECT_CHANGED`); step 7 flips the row to `ACCEPTED` with `landedKey`;
step 8 `DeleteObjectVersion` of the version read; step 9 publishes, then sets
`eventPublishedAt`. A crash after the copy leaves a lease the next receive
retakes (the pinned copy repeats); a terminal row met at step 2 has any
leftover drop version deleted and, without `eventPublishedAt`, its event
published. A validator error throws and SQS retries; on the last receive
(`ApproximateReceiveCount == maxReceiveCount`) the processor marks
`REJECTED <name>:VALIDATOR_ERROR`, deletes the drop version and publishes
`DeliveryRejected`, and the message lands in the DLQ as an audit copy only,
so no delivery waits in an intermediate state. The hourly sweep abandons a
lease older than `maxReceiveCount × visibilityTimeoutFactor × T +
abandonGraceSeconds` as `PROCESSING_ABANDONED`, after SQS has given up.

## Consequences
Easier: consumers have one rule, subscribe to `DeliveryAccepted` and never
read `ingest/`; no overwrite between check and copy goes unnoticed; every
delivery ends terminal within 18T plus one hour by default; the integration
test drives each path through read-only properties and the `test-switch`
validator (§10 steps 7b, 7c). Harder: each step must be safe to repeat, and
events are at least once, so consumers de-duplicate on `deliveryId`
(ADR-0009); `T` must stay under 15 minutes or synth fails naming the
validators; manual hold and redrive of validator errors is not built (§11).
Revisit if S3 offers an atomic conditional move between prefixes.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0010: Drive the pipeline with S3 Object Created, EventBridge, SQS and Lambda, and publish outcomes on a construct-owned bus

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-8, F-15, F-27)

## Context
Every upload to `ingest/` must be processed exactly once in effect, survive
bursts of 1,000 deliveries per minute (N-2), retry real faults, park poison
messages where an operator can see them, and still reach a terminal state
after a retry, a redrive or a crash (F-8). Downstream samples (the planned
extraction sample) need a stable signal that a delivery landed, without
reading the bucket. The construct must not take over bucket notifications a
deployer may already use. Within one account an identity-policy Allow is
enough to reach a queue or a bus, so a resource policy that only allows the
intended sender is filtered, not enforced (F-15). The repository standard
asks for encrypted queues, a target DLQ and retention that does not outlive
the object it points at (F-27). Realises P-5, P-10 and §3.1 (Pipeline),
§5.4, §6.2, §7.7, §8, N-7.

## Options considered
### Option 1: S3 event notification straight to Lambda
Pros: fewest parts, lowest latency. Cons: asynchronous invoke with two
retries and no backpressure; a burst scales the processor without bound; no
batching; failure handling is an on-failure destination, not a queue an
operator can redrive; S3 notification configuration is one per bucket and
overlapping prefixes conflict.
### Option 2: S3 event notification to SQS
Pros: buffering, retries, a DLQ. Cons: still the one-per-bucket notification
configuration; no second subscriber without fan-out added later.
### Option 3: S3 Object Created to EventBridge, rule on `ingest/`, then SQS (+DLQ) and Lambda
Pros: EventBridge notifications do not occupy the bucket's notification
configuration, so other subscribers can coexist; the rule filters on the key
prefix, so the processor's own copy to `documents/` is never re-processed;
SQS gives buffering, a visibility timeout, three receives, then a DLQ that can
be redriven; Lambda concurrency is bounded by the event source. Cons: two
more services in the path; a little added latency; EventBridge charges per
event.
### Option 4: Step Functions per delivery
Pros: explicit state and history. Cons: per-transition cost at N-2; the
pipeline is a short linear sequence that a Lambda handles; kept as the
validator carrier seam instead (ADR-0009, ADR-0016).

## Decision
Option 3. It is the only option that buffers, retries and parks failures
without claiming the bucket's notification configuration. Both queues use
SSE-SQS; the EventBridge target has a retry policy (24 hours, 185 attempts)
and its own DLQ; the SQS visibility timeout is six times the processor
timeout computed at synth (ADR-0009); the DLQ retains messages for 14 days,
longer than any drop object lives, so a held message never outlives the
reason to replay it unnoticed (F-27). Resource policies carry explicit
denies (F-15): the queue denies `sqs:SendMessage` unless `aws:SourceArn` is
the rule, the DLQ unless it is the source queue, and the bus denies
`events:PutEvents` unless `aws:PrincipalArn` is `processorRole`. Outcomes go
to the construct's bus, exposed as `eventBus`:
`source: tenant-encrypted-ingestion`, `detail-type` `DeliveryAccepted`,
`DeliveryRejected` or `DeliveryKeyUnavailable`, with ids, `landedKey`,
`keyArn` and `reason`, never a presigned URL and never the file name.
Idempotency and liveness come from a lease, not a one-shot status write
(ADR-0016): `AWAITING_UPLOAD -> PROCESSING` records `leaseOwner` (the SQS
message id) and `leaseUntil`; the same message arriving again, or any message
after the lease expired, re-enters and continues; a different message while
the lease is live exits; every later transition is conditional on
`leaseOwner`. The hourly sweep moves `PROCESSING` rows whose lease died more
than one processor timeout ago to `REJECTED structural:PROCESSING_ABANDONED`
and deletes their drop object.

## Consequences
Easier: consumers subscribe with a rule and read `landedKey` under their own
tenant-scoped credentials; the DLQ holds only real faults and `hold` validator
errors, because key loss is terminal (ADR-0005); a retry, a DLQ replay and a
redrive after a crash between copy and status write all finish on the next
pass; a forged `Object Created` is refused at the queue and would be harmless
anyway, because the processor acts only under the tenant session for the key's
prefix and only on a row it can lease. Harder: at-least-once delivery means
every step after the lease must be safe to repeat (copy and delete are, both
pinned to the ETag, ADR-0008); a template test asserts the denies, SSE-SQS, the
target DLQ and the retention. Revisit if per-delivery workflows need human
steps, which belongs to the extraction sample.

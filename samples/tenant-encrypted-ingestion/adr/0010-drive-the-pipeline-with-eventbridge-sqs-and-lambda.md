<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0010: Drive the pipeline with S3 Object Created, EventBridge, SQS and Lambda, and publish outcomes on a construct-owned bus

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
Every upload to `ingest/` must be processed exactly once in effect, survive
bursts of 1,000 deliveries per minute (N-2), retry real faults, and park
poison messages where an operator can see them. Downstream samples (the
planned extraction sample) need a stable signal that a delivery landed,
without reading the bucket. The construct must not take over bucket
notifications a deployer may already use. Realises P-5, P-10 and §3.1
(Pipeline), §5.4, §8.

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
prefix; SQS gives buffering, a visibility timeout, three receives, then a
DLQ that can be redriven; Lambda concurrency is bounded by the event source.
Cons: two more services in the path; a little added latency; EventBridge
charges per event.
### Option 4: Step Functions per delivery
Pros: explicit state and history. Cons: per-transition cost at N-2; the
pipeline is a short linear sequence that a Lambda handles; kept as the
validator carrier seam instead (ADR-0009).

## Decision
Option 3. It is the only option that buffers, retries and parks failures
without claiming the bucket's notification configuration. The SQS visibility
timeout is six times the processor timeout computed at synth (ADR-0009).
Outcomes go to an EventBridge bus the construct owns, exposed as `eventBus`:
`source: tenant-encrypted-ingestion`, `detail-type` `DeliveryAccepted`,
`DeliveryRejected` or `DeliveryKeyUnavailable`, with ids, `landedKey`, `keyArn`
and `reason`, never a presigned URL. Idempotency comes from conditional status
writes: `AWAITING_UPLOAD -> PROCESSING` succeeds once, and a duplicate or late
event sees `PROCESSING` or a terminal state and exits.

## Consequences
Easier: consumers subscribe with a rule and read `landedKey` under their own
tenant-scoped credentials; the DLQ holds only real faults and `hold` validator
errors, because key loss is terminal (ADR-0005). Harder: at-least-once
delivery means every step after the conditional write must be safe to repeat
(copy and delete are); a processor crash between copy and status write is
redriven and finishes on the second pass. Revisit if per-delivery workflows
need human steps, which belongs to the extraction sample.

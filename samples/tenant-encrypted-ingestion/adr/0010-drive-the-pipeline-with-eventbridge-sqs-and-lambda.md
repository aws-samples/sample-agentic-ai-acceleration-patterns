<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0010: Drive the pipeline with S3 Object Created, EventBridge, SQS and Lambda, and publish outcomes on a construct-owned bus

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-8, F-15, F-27)
- Revised: 2026-11-05, second security review (G-6, G-7, G-20)

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
the object it points at (F-27).

Three facts from the second review. An operator's DLQ redrive
(`StartMessageMoveTask`) needs the caller's own `sqs:SendMessage` on the
destination queue and carries no `aws:SourceArn`, so a queue Deny "unless
`aws:SourceArn` is the rule" also denies the redrive (G-7). The EventBridge
target's DLQ receives from EventBridge, not from the source queue, so it
cannot share the SQS redrive DLQ's policy. And S3 `Object Created` events
carry `source-ip-address` and `requester`, so every queue that holds them
holds tenant users' IP addresses (G-20). S3 delivers its events to the
account's **default** event bus. Realises P-5, P-10 and §3.1 (Pipeline),
§5.4, §6.2, §7.7, §8, N-6, N-7.

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
event; the rule lives on the account's default bus, which the construct does
not own.
### Option 4: Step Functions per delivery
Pros: explicit state and history. Cons: per-transition cost at N-2; the
pipeline is a short linear sequence that a Lambda handles; kept as the
validator carrier seam instead (ADR-0009, ADR-0016).

## Decision
Option 3. It is the only option that buffers, retries and parks failures
without claiming the bucket's notification configuration. The `Object
Created` rule lives on the account's **default** bus, where S3 delivers; the
construct's own bus carries only `Delivery*` events. Three queues, all
SSE-SQS: the main queue, its SQS redrive DLQ, and a separate EventBridge
target DLQ. The EventBridge target has a retry policy (24 hours, 185
attempts). The SQS visibility timeout is six times the processor timeout T
computed at synth (ADR-0009) and `maxReceiveCount` is 3, so a message reaches
the DLQ after at most 18T; both DLQs retain messages for 14 days, longer than
any drop object lives, so a held message never outlives the reason to replay
it unnoticed (F-27).

Resource policies carry explicit denies (F-15), with the redrive path kept
open (G-7):

- Main queue: Allow `sqs:SendMessage` to `events.amazonaws.com` with
  `aws:SourceArn` = the rule ARN; Deny `sqs:SendMessage` unless
  `aws:SourceArn` is the rule ARN **or** `aws:CalledViaLast =
  sqs.amazonaws.com`, which is how an operator's `StartMessageMoveTask` from
  the DLQ arrives.
- SQS redrive DLQ: Deny `sqs:SendMessage` unless `aws:SourceArn` is the main
  queue. Whether SQS's automatic move after `maxReceiveCount` is evaluated
  against the DLQ policy is not documented; integration step 7b shows it, and
  the Deny is dropped if it blocks the move.
- EventBridge target DLQ: its own policy, Allow `events.amazonaws.com` with
  `aws:SourceArn` = the rule ARN, Deny every other sender.
- Bus: Deny `events:PutEvents` unless `aws:PrincipalArn` is `processorRole`
  (the role ARN, which a Lambda session presents).

Outcomes go to the construct's bus, exposed as `eventBus`:
`source: tenant-encrypted-ingestion`, `detail-type` `DeliveryAccepted`,
`DeliveryRejected` or `DeliveryKeyUnavailable`, with ids, `landedKey`,
`keyArn` and `reason`, never a presigned URL and never the file name.
Idempotency and liveness come from a lease, not a one-shot status write
(ADR-0016): `AWAITING_UPLOAD -> PROCESSING` records `leaseOwner` (the SQS
message id) and `leaseUntil`; the same message arriving again, or any message
after the lease expired, re-enters and continues; a different message while
the lease is live exits; every later transition is conditional on
`leaseOwner`. The hourly sweep abandons a `PROCESSING` row only once its
lease is more than 18T plus one hour in the past, after SQS has given up, and
leaves `HELD` rows for the DLQ's 14 days (G-6, ADR-0016).

The queues and both DLQs hold S3 event bodies, so they hold tenant users'
source IP addresses and requester ARNs for up to 14 days; the threat model
names it, and the sample never copies those fields into logs or the
delivery row (G-20).

## Consequences
Easier: consumers subscribe with a rule and read `landedKey` under their own
tenant-scoped credentials; the DLQ holds only real faults and `hold` validator
errors, because key loss is terminal (ADR-0005); a retry, a DLQ replay and a
redrive after a crash between copy and status write all finish on the next
pass; a forged `Object Created` is refused at the queue and would be harmless
anyway, because the processor acts only under the tenant session for the key's
prefix and only on a row it can lease. Harder: at-least-once delivery means
every step after the lease must be safe to repeat (copy and delete are, both
pinned to the ETag, ADR-0008); the `aws:CalledViaLast` exception lets any
principal in the account with `sqs:SendMessage` on the main queue and a
redrive from some DLQ into it inject a message, which stays harmless for the
reason above; the default-bus rule is a resource in a bus every stack in the
account shares, so its name carries the construct's prefix; IP addresses in
the queues are personal data under some regimes, and a deployer with a
shorter retention duty lowers the DLQ retention and accepts a shorter replay
window; a template test asserts the denies, the `aws:CalledViaLast`
exception, SSE-SQS, the target DLQ's own policy and the retention. Revisit if
per-delivery workflows need human steps, which belongs to the extraction
sample.

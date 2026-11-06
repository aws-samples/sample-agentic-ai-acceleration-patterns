<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0009: Drive the pipeline with EventBridge, SQS and Lambda

- Status: Accepted
- Date: 2026-11-05
- Amended by: ADR-0017
- Deciders: Dave Roberts (PSA)

## Context
Every upload must start exactly one processing path, survive bursts of 1,000
deliveries per minute (N-2), retry on faults, keep a record of what failed,
and announce outcomes to consumers the sample does not know. In one account
an identity Allow reaches a queue or a bus, so an Allow-only resource policy
is filtered: any role with `sqs:SendMessage` or `events:PutEvents` could feed
the processor or forge an outcome. S3 events carry the uploader's source IP,
and an event bus shows every event to every rule in the account. Realises
P-10 and spec §5.4, §7.7.

## Options considered
### Option 1: S3 event notification straight to Lambda
Pros: fewest parts, lowest latency. Cons: asynchronous invoke with two
retries and no backpressure; a burst scales the processor without bound; no
queue to redrive; one notification configuration per bucket, so other
subscribers conflict.
### Option 2: S3 notification to SQS, or a Step Functions execution per delivery
SQS adds buffering and a DLQ but keeps the one-per-bucket configuration and
no second subscriber. Step Functions gives state and history at a
per-transition cost the short linear pipeline does not need; it stays the
validator carrier seam (ADR-0008).
### Option 3: S3 `Object Created` to EventBridge, a rule on `ingest/`, SQS and Lambda
Pros: EventBridge leaves the bucket's notification configuration free; the
rule filters on the prefix, so the processor's own copy to `documents/` never
re-enters; SQS gives a visibility timeout, bounded receives and a DLQ;
Lambda concurrency is bounded by the event source. Cons: two more services
and a little latency; the rule lives on the default bus, which the construct
does not own.

## Decision
Option 3, with Denies that make each resource policy enforced (spec §7.7).
The `Object Created` rule sits on the default bus, where S3 delivers. The
queue allows `sqs:SendMessage` to `events.amazonaws.com` with `aws:SourceArn`
= the rule and denies it unless `aws:SourceArn` is the rule or
`aws:PrincipalArn` is `redriveOperatorRole`; with that prop unset only the
rule sends and an operator redrive is not possible, which the README states.
The DLQ denies `SendMessage` unless the source is the queue (the integration
test shows the automatic move still works, else the Deny is dropped); the
EventBridge target DLQ keeps its own rule-only policy. Outcomes go to a
construct-owned bus that denies `events:PutEvents` unless the principal is
`processorRole`. Every queue uses SSE-SQS and carries object keys only; DLQ
retention is 14 days, so the source IPs in S3 events are kept that long. A
forged `Object Created` message is harmless, since the processor acts only
under the session for the key's prefix and on an `AWAITING_UPLOAD` row.
`Delivery*` events carry `tenantId`, `deliveryId`, `landedKey`, size, type
and reason, never a file name, URL or `keyArn`; delivery is at least once and
consumers de-duplicate on `deliveryId`. The bus is vendor-side and filtered:
its policy controls who puts events, any rule in the account sees every
tenant's events, so consumers filter on `detail.tenantId`.

## Consequences
Easier: other subscribers can listen to the bucket; a burst queues instead of
scaling without bound; a stuck message has a DLQ copy and, when the deployer
names a role, a redrive path; nothing in the account but `processorRole` can
publish an outcome. Harder: more resources to test (queue, DLQ and bus
policies are template tests, N-7); an event reaches any rule a vendor role
creates, so reading events is filtered and the README says so; a
per-tenant subscription with fixed `detail.tenantId` rules is a hardening
seam (§11). Revisit if EventBridge offers rule-level read permissions on a
bus, or if S3 events can omit the source IP.

Amended 2026-11-06 (ADR-0017): the bus denies `events:PutEvents` unless
the principal is `processorRole` or `sweepRole`; the sweep publishes
`DeliveryRejected` for abandoned leases and republishes owed events. So
"nothing in the account but `processorRole` can publish an outcome" above
reads, as built, "nothing but `processorRole` and `sweepRole`".
Implemented 2026-11-06 (`src/construct/events.ts`, `src/construct/queues.ts`);
§10 step 7b showed SQS's own move meets the DLQ Deny, so the Deny stays.

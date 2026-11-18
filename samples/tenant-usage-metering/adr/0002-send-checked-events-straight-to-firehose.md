<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0002: Send checked usage events straight to Firehose, and publish counted records on a bus

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (SA)

## Context
After the ingest function checks a batch (ADR-0001), the events must reach
a durable, replayable store with no loss. A spike on 2026-11-17 in a
non-production test account sent 10,000 events through four paths. Every
path delivered 10,000. An EventBridge rule targeting Firehose sends one
event per `PutRecord` call; under load Firehose throttled it, EventBridge
retried, and about 220 events arrived up to three minutes late. Most of
that path's cost was the bus. EventBridge drops an event after its retry
policy runs out unless a dead-letter queue is set.

## Options considered
### Option 1: Function → EventBridge → Firehose → S3
Pros: any later reader of raw events is a new rule; matches the bus-first
pattern some control-plane toolkits use for usage ingest. Cons: about
$1.20 per million events at list price (unverified); one event per
Firehose call, so it throttles; needs a DLQ, a retry policy and alarms to
be loss-free.

### Option 2: Function → Firehose (`PutRecordBatch`, up to 500) → S3
Pros: about $0.10 per million at list price (unverified); one call per
batch; one fewer service and role. Cons: the function must resend the
failed part of a batch; a new raw-event reader reads S3 or needs a
function change.

### Option 3: Emitters write to CloudWatch Logs; a subscription feeds Firehose
Pros: no function to own. Cons: a log group and subscription per cell;
cross-account cells need a Logs destination in each account; makes a log
store the record of billable events (P-1).

## Decision
Option 2, with counted records published on an EventBridge bus as the
`EVENT_BUS` sink. Readers that act on usage (limiters, dashboards,
billing adapters) want counted, deduplicated records, not raw events, so
the bus sits where it adds value and costs one event per tenant, meter
and hour instead of one per raw event. Status stays Proposed until the
no-bus path is measured under the same load.

## Consequences
- The ingest function retries `FailedPutCount` records with backoff and
  writes any that still fail to the error store (P-8).
- A raw-event reader is a seam: an S3 event notification on `raw/`, or
  option 1.
- A deployer who wants the bus-first shape for a toolkit that expects it
  can add a rule on the usage bus; the counted records are already there.

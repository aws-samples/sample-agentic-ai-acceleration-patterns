<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0002: Route checked usage events through an EventBridge Custom Event Bus to Firehose

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (SA)

## Context
After the ingest function checks a batch (ADR-0001), the events must reach
a durable, replayable store with no loss. No bus can do that check itself:
whether a tenant is bound to the caller's cell is a registry lookup, so the
function stays in front of whatever comes next.

A spike on 2026-11-17 in a non-production test account sent 10,000 events
through several paths, and every path delivered all 10,000. On the path
through an EventBridge *Custom Event Bus - Classic*, a rule targeting
Firehose makes one `PutRecord` call per event. Firehose admits about 2,000
calls a second per stream, so it throttled the rule. EventBridge retried,
and about 220 events arrived up to three minutes late. The classic bus
bills $1.00 per million events, which made it most of that path's cost.

In September 2026 EventBridge launched a new *Custom Event Bus*
(`AWS::EventsV2::*`). It changes three facts the classic bus decided:

- a Firehose target is called with `PutRecordBatch`, up to 500 events a
  call, so the bus no longer throttles Firehose;
- it is priced by data, about $0.18 per GB in and $0.05 per GB out, so a
  0.5 KB usage event costs about $0.11 per million in and out;
- it keeps every event for 1 to 365 days, and a subscriber can start from a
  point in the past, so a new reader can catch up without code in this
  sample. It also suppresses a repeated `DeduplicationId` within five
  minutes.

It runs in 14 Regions at launch, Europe (Frankfurt) included. Its
subscriber retries five times or for 300 seconds by default, then drops
the event unless a dead-letter queue is set.

Firehose bills ingestion in 5 KB steps per record. A record of one usage
event costs as much as a record of 5 KB, so packing many events into one
newline-delimited record cuts that cost by a factor of up to the packing
ratio.

Prices are list prices for Europe (Frankfurt) on 2026-11-18 and are not
verified with the AWS Pricing Calculator.

## Options considered
### Option 1: Function → Custom Event Bus - Classic → Firehose → S3
Pros: any later reader of raw events is a new rule. Cons: about $1.14 per
million events; one Firehose call per event, so it throttles at load; a
DLQ, a retry policy and alarms are needed to be loss-free; no retention
without an archive.

### Option 2: Function → Firehose (`PutRecordBatch`) → S3
Pros: about $0.14 per million with one event per record, and well under
$0.01 with events packed per record; one service and role fewer. Cons: the
function resends the failed part of each batch; a new raw-event reader
reads S3 or needs a change to the function; no shared place for other
accounts to subscribe.

### Option 3: Function → Custom Event Bus → Firehose subscriber → S3
The function publishes each checked batch with `PutEvents` (up to 100
entries), `DeduplicationId` set to `<tenantId>#<eventId>`. A subscriber
delivers to Firehose in batches of up to 500, with a retry policy set to
the bus's maximum event age and an SQS dead-letter queue. Pros: no
throttle; about $0.25 per million at one event per Firehose record;
retention gives a replay buffer in front of S3; other teams and accounts
attach readers through AWS RAM without a change to this sample; matches
the bus-first shape control-plane toolkits use. Cons: a service two
months old, in 14 Regions, with CloudFormation and CDK L1 support only;
one more hop to fail and to alarm; costs about twice option 2 at one
event per record.

### Option 4: Emitters write to CloudWatch Logs; a subscription feeds Firehose
Pros: no function to own. Cons: a log group and subscription per cell;
cross-account cells need a Logs destination in each account; makes a log
store the record of billable events (P-1).

## Decision
Option 3, subject to the spike in Consequences. It keeps a bus at the
point where other systems want to join, without the throttle and the
per-event price that ruled the classic bus out, and the bus's retention
gives a second replay source while S3 stays the store the hourly recount
reads (ADR-0003). The five-minute deduplication is a first filter only;
counting once still rests on the recount's `(tenantId, eventId)` dedupe
(P-5), because a retry after five minutes, or a Firehose retry, is not
caught by the bus. Option 2 with packed records is the fallback where the
new bus is not available, and the construct takes an `ingestPath` prop
(`EVENT_BUS` or `DIRECT`) so a deployer can choose.

## Consequences
- The subscriber MUST have an SQS dead-letter queue and a retry policy
  that holds events for the bus's maximum event age; an alarm on the DLQ
  depth and on the subscriber's failed deliveries is part of the stack.
- Firehose sees one record per event, so the Firehose cost is the
  5 KB-step cost; a subscriber transformer that packs events is a seam.
- The bus retention is set to the shortest useful period (1 day by
  default); S3 holds the long-term raw store.
- Before this is accepted, a spike in a non-production test account MUST
  show, for 10,000 events: deploy and destroy time, no throttling, every
  event in S3, duplicates published inside five minutes suppressed, and
  the DLQ empty. If it fails, option 2 with packed records is chosen.
- Revisit if the new bus is needed in a Region where it is not available,
  or if the per-GB price changes.

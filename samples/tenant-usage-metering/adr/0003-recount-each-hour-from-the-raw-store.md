<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0003: Recount each hour from the raw store and dedupe on (tenantId, eventId)

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (SA)

## Context
Duplicates come from three places: an emitter's retry, a Firehose retry
(at-least-once delivery), and a replay. Events also arrive late. The
counted record must be the same however many times the hour is counted,
and a sink must never see a total change under it.

## Options considered
### Option 1: Dedupe at ingest with a conditional put per event
A DynamoDB item per `eventId` with a TTL, and a running counter. Pros:
counts are live. Cons: one write per event; Firehose's own duplicates
pass after the check; a replay needs the counters reset; the counter is
state that can drift from the raw store.

### Option 2: Count in a stream processor (Managed Service for Apache Flink)
Pros: live, handles late events with watermarks. Cons: a running
application per Region with its own cost floor and operations; replay
means a savepoint or a second job.

### Option 3: Recount the hour from S3 in a scheduled workflow
Firehose partitions raw objects by event hour. After `lateGraceMinutes`
a Step Functions run reads the hour's objects, keeps one event per
`(tenantId, eventId)`, and sums each meter by its rule. Pros: the total
is a pure function of the stored events (P-4); replay is the same run;
no per-event writes. Cons: records land at least `lateGraceMinutes`
after the hour; a very large hour needs a distributed map.

## Decision
Option 3. Billing runs on hourly records, so live counts buy nothing the
bill needs, and a recount from the raw store is the one design where
replay, retry and audit give the same answer by construction. Late
events trigger a recount inside `recountWindowHours`, and the difference
goes out as an `ADJUSTMENT` record (P-7).

## Consequences
- A live limiter must keep its own short-window counter; the sample's
  records come too late for it (spec §1.1).
- The aggregation is bounded by how many objects an hour holds; the
  distributed map is a seam, measured by the stress plan.

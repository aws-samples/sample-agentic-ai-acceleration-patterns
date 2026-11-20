<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0003: Recount each hour from the raw store and dedupe on (applicationId, tenantId, eventId)

- Status: Accepted
- Date: 2026-11-18
- Deciders: Dave Roberts (SA)

## Context
Duplicates come from many places: an emitter's retry, the ingest bus
subscriber's at-least-once delivery, a Firehose retry, a redrive of the
ingest dead-letter queue, a re-admission from the error store, and a
recount. Events also arrive late, and the pipeline itself delays them: a
60-second Firehose buffer, and subscriber retries for up to 24 hours. The
counted record must be the same however many times the hour is counted,
and a sink must never see a total change under it.

An `eventId` is unique only for the emitter that chose it. Two
applications' emitters can report for the same tenant, and usage records
are kept per tenant and application.

## Options considered
### Option 1: Dedupe at ingest with a conditional put per event
A DynamoDB item per event key with a TTL, and a running counter. Pros:
counts are live. Cons: one write per event; the bus's and Firehose's own
duplicates pass after the check; a recount needs the counters reset; the
counter is state that can drift from the raw store.

### Option 2: Count in a stream processor (Managed Service for Apache Flink)
Pros: live, handles late events with watermarks. Cons: a running
application per Region with its own cost floor and operations; a recount
means a savepoint or a second job.

### Option 3: Recount the hour from S3 in a workflow
Firehose partitions raw objects by event hour. After `lateGraceMinutes`
a Step Functions execution reads the hour's objects, keeps one event per
`(applicationId, tenantId, eventId)`, and sums each meter by its rule. An
S3 notification increments the hour's generation for every object, and a
count that ends with a moved generation leaves the hour dirty, so it is
counted again while it is inside `recountWindowHours`. Pros:
the total is a pure function of the stored events (P-4); a recount is the
same execution; no per-event writes. Cons: records land at least
`lateGraceMinutes` after the hour; a very large hour needs a distributed
map.

## Decision
Option 3. Billing runs on hourly records, so live counts buy nothing the
bill needs, and a recount from the raw store is the one design where
retry, redrive and audit give the same answer by construction. The key
includes the application the emitter is registered for (P-2), so one
application's emitter cannot suppress another's events. When two copies
differ, the earliest `receivedAt` wins, then the lowest canonical JSON
(RFC 8785) of the enriched event, so the winner never depends on read
order or object format. Every recount writes only the
difference from the records already written, as an `ADJUSTMENT` (P-7).

## Consequences
- `lateGraceMinutes` must exceed the Firehose buffer plus a margin, or
  on-time events routinely become `ADJUSTMENT`s; synth enforces at least
  6 minutes (spec §3.3).
- The hour, recount jobs and their states are records of their own
  (spec §4.5, §4.6). One execution holds an hour at a time: a lease,
  and a condition on it in every write the execution makes.
- Dedupe runs within one hour, so an emitter must resend an event
  unchanged; a resend with a new `time` in another hour counts twice.
- A live limiter must keep its own short-window counter; the sample's
  records come too late for it (spec §1.1).
- The recount is bounded by how many objects an hour holds; the
  distributed map is a seam, measured by the stress plan.

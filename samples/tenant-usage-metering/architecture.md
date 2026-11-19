<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Tenant Usage Metering: Architecture

> **Status: implemented and verified in a non-production account in
> eu-central-1 on 2026-11-19.** Two demo stacks ran the integration test
> ([`integration-test.md`](integration-test.md)) side by side, one with
> `ingestPath: BUS` and one with `DIRECT`: deploy 223 s and 249 s, test
> about 85 minutes each, delete 183 s each, nothing left but the CDK
> provider log groups (§11). 47 of 48 checks passed in each. The one that
> failed, the `UsageSubscriber` filtered on a meter, matched nothing: its
> pattern was written against the record, and EventBridge matches a
> `PutEvents` event's `DATA` against the envelope, with the record under
> `detail`. The fix was deployed during the BUS run and the filtered
> reader then received the next record (an `ADJUSTMENT`) and no
> `agent.calls` record. The run also proved the `HTTP` sink's `FAILED`
> (403) and `BLOCKED` paths, `RESEND_BLOCKED` to revision 2,
> `SINK_REDRIVE` (backfill and `FAILED`), `StartIngestRedrive` (BUS: empty
> queue; DIRECT: 400) and the `DeliveriesFailed` alarm. A run of
> 2026-11-18 proved the stack update through the bucket configuration
> deny (116 s). Unit tests: 107.
> A third run on 2026-11-19 (`BUS`, after the filter fix and with
> `AWS_IAM` HTTP sinks) passed all 54 checks: deploy 228 s, test 40
> minutes, delete 183 s. It proved an `HTTP` sink `SENT` to an `AWS_IAM`
> function URL (SigV4 as the dispatcher role), revision 2 `SENT` after the
> resend, and the receiver's log of both records.
> A fourth run the same day, with `ingestPath: DIRECT` on the same code,
> also passed all 54 checks (deploy 233 s, delete 182 s).
> A fifth run (`BUS`), after the review fixes of the `AWS_IAM` sink
> (ADR-0007), passed all 54 checks: deploy 229 s, test 50 minutes, delete
> 182 s. The receiver refused an unsigned call with 403 `AccessDenied`,
> and signed deliveries to its URL with a repeated query key
> (`?tag=a&tag=b`) reached `SENT`. Unit tests: 125.
> **Not exercised live yet:** `StartIngestRedrive` with messages in the queue, the
> close of an hour after `recountWindowHours`, a cell in a second account,
> and the hook script against a deployed API.

This document describes what is built. The design is in
[`design/tenant-usage-metering.spec.md`](design/tenant-usage-metering.spec.md),
the decisions in [`adr/`](adr/README.md), and the threats in
[`threat-model.md`](threat-model.md).

## 1. Purpose

One metering service that the vendor owns. Emitters in cells send usage
events; the service admits an event only from a registered emitter and
for a tenant the control plane placed in that emitter's cell, keeps every
event in a replayable raw store, counts each hour from that store under a
run-time meter catalog, and hands each usage record to the sinks and the
usage bus.

## 2. Actors and identity

| Caller | Proves itself by | Reaches |
|---|---|---|
| Emitter | SigV4 as `<fleet>-ue-<cellId>`, path `/`, in any account | `POST /usage-events` |
| Registrar (`<fleet>-global-hook`) | SigV4 as a role in `registrarPrincipalArns` | the four registration writes |
| Operator | SigV4 as a role in `operatorPrincipalArns` | every admin route but the registration writes |
| Reader | SigV4 as a role in `readerPrincipalArns` | `GetUsage`, `ListUsage` |
| Bus reader | its account (the metering account or a shared one) | its own `UsageSubscriber` |

Two layers check each route, from one table
([`src/api/routes.ts`](src/api/routes.ts)):

1. The API's resource policy has an allow and an explicit deny per caller
   set, keyed on `aws:PrincipalArn`. The ingest route admits
   `arn:aws:iam::*:role/<fleet>-ue-*`; every other route admits only its
   listed roles.
2. The admin function reduces the verified caller ARN to its role and
   checks the same table again before it runs an operation. The ingest
   function reduces it to an emitter role and looks the role up in the
   registry; an unregistered role gets 403 and nothing is stored.

## 3. Components

| Component | Built as | Code |
|---|---|---|
| REST API | API Gateway, regional, every method `AWS_IAM`; stage 1,000 rps, ingest method 600 rps, each admin method 50 rps | [`src/construct/api.ts`](src/construct/api.ts) |
| Ingest function | Lambda, reserved concurrency 25; Smithy SSDK for `PutUsageEvents` | [`src/ingest/`](src/ingest/) |
| Admin function | Lambda; Smithy SSDK for the other 29 operations | [`src/api/`](src/api/) |
| Ingest bus | EventBridge Custom Event Bus; resource policy lets only the ingest role publish | [`src/construct/pipeline.ts`](src/construct/pipeline.ts) |
| Ingest subscriber | `AWS::EventsV2::Subscriber` to Firehose, batches of 500, 24 h and 185 attempts, SQS dead-letter queue | same |
| Raw stream | Firehose, dynamic partitioning on the event hour into `raw/hour=…/` | same |
| Table | DynamoDB `TableV2`, on demand, PITR, TTL, stream with both images, three sparse indexes | [`src/construct/table.ts`](src/construct/table.ts) |
| Object tracker | Lambda on S3 notifications for `raw/`, `readmitted/` and `firehose-error/`; on-failure queue | [`src/tracker/`](src/tracker/) |
| Recounter | Step Functions Standard, 25-minute timeout; one Lambda task (`count`, and `fail` on the catch path) | [`src/recount/`](src/recount/) |
| Scheduler | Lambda on an EventBridge Scheduler schedule, every 5 minutes, in the stack's own schedule group | [`src/scheduler/`](src/scheduler/) |
| Record publisher | Lambda on the table stream (filtered to usage records holding a marker), and on a second 5-minute schedule for the sweep | [`src/publisher/`](src/publisher/) |
| Usage bus | EventBridge Custom Event Bus; only the publisher role may publish | [`src/construct/pipeline.ts`](src/construct/pipeline.ts) |
| Sink dispatcher | Lambda on the delivery queue (batch 10, at most 10 concurrent) | [`src/dispatcher/`](src/dispatcher/) |
| Job workers | three Lambda handlers in one bundle: jobs (`RECOUNT`, `SINK_REDRIVE`, `RESEND_BLOCKED`), re-admission, ingest redrive | [`src/jobs/`](src/jobs/) |
| `UsageSubscriber` | published construct: a subscriber, a dead-letter queue, two alarms | [`src/subscriber/`](src/subscriber/) |

Every function: Node.js 24 on arm64, bundled with esbuild, JSON logs into
its own log group, its own role with no managed policy.

## 4. Roles and policies

| Role | Writes | Reads |
|---|---|---|
| ingest | table counters; `error/`; ingest bus or Firehose | registry, meters |
| admin | table (registrations, meters, sinks, jobs); invokes the three job workers | table |
| jobs | `generation` items, sink states, revision-2 records; the delivery queue | table (scan for `SINK_REDRIVE`) |
| readmission | `readmitted/`, `error/`, job items | `error/`, registry, meters |
| redrive | Firehose, `error/`, job items | the ingest dead-letter queue |
| tracker | hour items | hour items |
| recounter | usage records, hour items | `raw/`, `readmitted/`, table |
| scheduler | hour items; starts recounter executions | the `pending` index, the tracker failure queue |
| publisher | removes markers | stream, outbox index; publishes to the usage bus; the delivery queue |
| dispatcher | sink states, revision-2 records; the export bucket | table, secrets under `<fleet>/metering/sinks/` |
| firehose | `raw/`, `firehose-error/` | |
| subscriber | Firehose; the ingest dead-letter queue | |
| schedule | invokes the scheduler and the publisher | |

Resource policies deny every principal but these roles (spec §3.5):

- **Table.** `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`,
  the PartiQL writes and `ConditionCheckItem`, to all but the ten function
  roles.
- **Raw bucket.** Each prefix has its writers (`raw/`, `firehose-error/`:
  Firehose; `readmitted/`: re-admission; `error/`: ingest, re-admission,
  redrive); writes outside the four prefixes are denied; deletes only by
  the auto-delete provider; configuration changes only by the deployment
  role and the auto-delete and bucket-notifications providers.
- **Export bucket.** Writes only by the dispatcher; deletes and
  configuration as on the raw bucket.
- **Buses.** `events:PutEvents` and `PutRawEvents` denied to all but the
  one writer. The deny grants nothing, so each writer also has an identity
  allow.
- **Ingest dead-letter queue.** `SendMessage` only from the subscriber.

Trust: Firehose on its stream ARN; the subscriber role on its subscriber
ARN pattern; Scheduler on the stack's schedule group ARN (Scheduler sets
`aws:SourceArn` to the group, not the schedule).

## 5. Data model

One table, `PK`/`SK` (spec §4):

| Item | `PK` | `SK` |
|---|---|---|
| Meter version / head | `METER#<id>` | `V#<8-digit version>` / `CURRENT` |
| Emitter / cell lookup | `EMITTER#<account>#<role>` / `CELL#<cell>` | `META` |
| Binding / tenant lookup | `CELL#<cell>` / `TENANT#<tenant>` | `TENANT#<tenant>` / `APP#<app>#CELL#<cell>` |
| Sink | `SINK#<id>` | `META` |
| Hour / generation | `HOUR#<hour>` | `META` / `GEN` |
| Job | `JOB#<ULID>` | `META` |
| Usage record | `USAGE#<tenant>#<app>` | `<hour>#<meter>#<4-digit seq>` |
| Admission / refusal counter | `RATE#<account>#<role>` | `MIN#<minute>` / `REFUSED#<hour>` |

Indexes: `pending-hours` (hours not `CLOSED`), `publish-outbox` (records
holding `publishPending`, four shards), `list-by-type` (meters, sinks,
emitters, jobs for the `List*` operations).

## 6. Ingest

1. The body is measured in bytes; over 1,048,576 is a 413.
2. The caller ARN is reduced to `<fleet>-ue-<cellId>` and looked up; a
   miss, a closed registration or a cell mismatch is a 403.
3. The SSDK validates the batch (1 to 100 free JSON members).
4. The per-emitter minute counter takes the whole batch; events over the
   limit are `RETRY`.
5. Each event is checked: shape, time, the emitter's interval, the
   binding's interval, the meter in effect at its hour.
6. Refusals are stored in one `error/hour=<receipt hour>/…json` object:
   those that could still count always, the others up to the per-emitter
   hourly cap.
7. Accepted events are enriched with the caller's identity and published:
   `PutEvents` calls of at most 100 entries and 240 KB, `DeduplicationId`
   the SHA-256 of `<applicationId>#<tenantId>#<eventId>`, `EventGroupId`
   the tenant, throttled entries retried three times; or, with `DIRECT`,
   one Firehose record per hour of the batch.

Registry and meter reads are cached 60 seconds per container, misses
included.

## 7. Counting

1. The tracker creates `HOUR#<h>/META` `OPEN` on the hour's first object
   and adds one to `GEN` for every object.
2. The scheduler queries `pending-hours`, reads each `GEN`, marks a moved
   `COUNTED` hour `DIRTY`, closes a `COUNTED` hour past its close time,
   and starts an execution for each due hour (at most 100 per run).
3. The execution's task takes the hour with a conditional write and its
   execution name as the lease, reads `GEN`, lists and reads every object
   of the hour, runs the recount rule ([`src/recount/rule.ts`](src/recount/rule.ts)),
   writes new records in transactions of 99 fenced on the lease, and ends
   `COUNTED`, or `DIRTY` if `GEN` moved. A failure marks `COUNT_FAILED`
   with a backoff of 2^attempts minutes, at most an hour.

The task holds the whole hour in memory (3,008 MB); a distributed map is
the seam for hours larger than that (ADR-0003).

## 8. Publishing and sinks

Each new record carries `publishPending` and `publishShard`. The publisher
publishes `UsageRecorded` (`DeduplicationId <recordId>#<revision>`),
queues one delivery message per sink, and removes the marker on a
condition that the revision and the marker are unchanged. The sweep
publishes markers older than 15 minutes.

The dispatcher reads the record and the sink at each attempt. `S3_EXPORT`
writes `<prefix>hour=<h>/<recordId>-r<revision>.jsonl`. `HTTP` posts the
mapped record with `Idempotency-Key: <recordId>`; no redirects; a 3xx or a
4xx other than 408 and 429 is `FAILED` at once; anything else is retried
with backoff from 30 s to 15 minutes until 24 hours after the delivery was
queued. A record without `billingAccount` for a sink that needs one
follows spec §4.7: revision 2 when the binding has an account, `BLOCKED`
otherwise.

## 9. Jobs

`Start*` writes the job `RUNNING` and invokes its worker asynchronously.
A worker stops 13 minutes in; a job that ran out of time ends `FAILED`
with that reason and can be started again. `READMIT` judges each event
with its `receivedAt` as the clock and applies the close guard on the real
clock before each write.

## 10. Observability

Metrics are written in the embedded metric format, namespace
`TenantUsageMetering/<construct id>`, no tenant dimension. Sixteen alarms
(spec §3.1, §3.2, §3.5, §4.5, §4.7), all sent to `alarmTopicArn` when one is
given, including the two heartbeats: the scheduler has not run for 15
minutes, and hours wait past their grace with none counted for 2 hours.

## 11. Deployment and teardown

`npx cdk deploy TenantUsageMetering` deploys the demo stack
([`src/demo.cdk.ts`](src/demo.cdk.ts)). Every resource is `DESTROY`; the
buckets empty themselves on delete. A delete leaves the log groups of the
two CDK provider functions (auto-delete objects and bucket notifications),
which CDK creates outside the stack.

## 12. Known gaps and residuals

- An alarm fires when a delivery becomes `BLOCKED`, not after 24 hours
  `BLOCKED`; the timed alarm needs an index of blocked deliveries.
- `SINK_REDRIVE` scans the usage records.
- The integration test reads stack outputs for the stand-in callers' role
  ARNs; a consumer reads the published parameter instead (integration-test.md,
  test-only shortcuts).
- The residuals of [`threat-model.md`](threat-model.md) apply.

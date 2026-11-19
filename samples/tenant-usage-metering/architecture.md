<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Tenant Usage Metering: Architecture

> **Status: implemented and verified.** The integration test
> ([`integration-test.md`](integration-test.md)) last passed in a
> non-production account in eu-central-1 on 2026-11-19 on both ingest
> paths, 54 of 54 checks each: `ingestPath: BUS` (deploy 228 s, test about
> 40 minutes, delete 183 s) and `ingestPath: DIRECT` (deploy 233 s, test
> 80 minutes, delete 182 s). The runs covered registration and
> offboarding, admission and per-event refusals, the hourly count, a late
> event's `ADJUSTMENT`, re-admission, the `S3_EXPORT` sink, the `HTTP` sink
> (`SENT` to an `AWS_IAM` function URL signed as the dispatcher role,
> `FAILED`, `BLOCKED`, `RESEND_BLOCKED` to revision 2, `SINK_REDRIVE`),
> `StartIngestRedrive`, the `DeliveriesFailed` alarm, `UsageSubscriber`
> readers on the usage bus (and, on `BUS`, on the ingest bus), and a stack
> update through the raw bucket's configuration deny. The two paths differ
> only before the raw store; the `BUS` run is on the current code. A
> delete leaves only the CDK provider log groups (§11). Unit tests:
> 177.
> **Not exercised live:** `StartIngestRedrive` with messages in the queue,
> the close of an hour after `recountWindowHours`, a cell or a bus
> subscriber in a second account (the AWS RAM shares and the share guard
> of §4.1), and the hook script against a deployed API.

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
| Bus reader | its account: the metering account, or one the bus is shared with through AWS RAM (§4.1) | its own `UsageSubscriber` |

Two layers check each route, from one table
([`src/api/routes.ts`](src/api/routes.ts)):

1. The API's resource policy has an allow and an explicit deny per caller
   set, keyed on `aws:PrincipalArn`. The ingest route admits
   `arn:<partition>:iam::*:role/<fleet>-ue-*`; every other route admits
   only its listed roles.
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
| Bus shares | one AWS RAM resource share per bus with a non-empty subscriber list, managed permission `AWSRAMEventBridgeEventBusV2SubscribeOnly` | same |
| Share guard | custom resource that reads the registry before the shares change and fails the deploy if a listed account holds a registered cell | [`src/guard/share-guard.function.ts`](src/guard/share-guard.function.ts) |
| Table | DynamoDB `TableV2`, on demand, PITR, TTL, stream with both images, three sparse indexes | [`src/construct/table.ts`](src/construct/table.ts) |
| Object tracker | Lambda on S3 notifications for `raw/`, `readmitted/` and `firehose-error/`; on-failure queue | [`src/tracker/`](src/tracker/) |
| Recounter | Step Functions Standard, 25-minute timeout; one Lambda task (`count`, and `fail` on the catch path) | [`src/recount/`](src/recount/) |
| Scheduler | Lambda on an EventBridge Scheduler schedule, every 5 minutes, in the stack's own schedule group | [`src/scheduler/`](src/scheduler/) |
| Record publisher | Lambda on the table stream (filtered to usage records holding a marker), and on a second 5-minute schedule for the sweep | [`src/publisher/`](src/publisher/) |
| Usage bus | EventBridge Custom Event Bus; only the publisher role may publish | [`src/construct/pipeline.ts`](src/construct/pipeline.ts) |
| Sink dispatcher | Lambda on the delivery queue (batch 10, at most 10 concurrent); published as `dispatcherRole` for `AWS_IAM` sink grants | [`src/dispatcher/`](src/dispatcher/) |
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
| dispatcher | sink states, revision-2 records; the export bucket; invokes the `AWS_IAM` sink endpoints the deployer grants | table, secrets under `<fleet>/metering/sinks/` (`SECRET` sinks) |
| share guard | | registry |
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

### 4.1 Bus sharing

`rawSubscriberAccountIds` (`BUS` only) and `usageSubscriberAccountIds`
name the vendor accounts that read a bus (ADR-0006). For a non-empty list
the construct creates an AWS RAM resource share of that bus with those
accounts and the managed permission
`AWSRAMEventBridgeEventBusV2SubscribeOnly`: the account may create, update
and describe its own subscribers, and may not publish. External principals
are allowed, so an account outside the metering account's organization
can be listed; it accepts the resource share invitation before it can use
the bus. Every subscriber account then attaches a `UsageSubscriber`.

No account may hold cells and read a bus. The check runs at both ends:
`PutCellEmitter` refuses a cell in a listed account or the metering
account (`ACCOUNT_NOT_ALLOWED`), and the share guard, a custom resource
that runs before the shares change, reads the registry and fails the
deploy if any listed account already holds a registered cell. A subscriber
created while its account was listed keeps delivering after the account
is removed from the share; the vendor revokes it with EventBridge
`RevokeResource`.

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

An `HTTP` sink authenticates in one of two ways (spec §4.4). `SECRET`
reads the sink's secret under `<fleet>/metering/sinks/` and sends it as a
header; a stored `SECRET` sink without a secret name is `FAILED` at once.
`AWS_IAM` signs each delivery with SigV4 as the dispatcher role, only for a
Lambda function URL or API Gateway host, checked again before each send; a
stored sink that fails the check is `FAILED` with `AUTH_TARGET_INVALID`
(ADR-0007). The deployer grants `dispatcherRole` invoke on the billing
endpoint.

## 9. Jobs

`Start*` writes the job `RUNNING` and invokes its worker asynchronously.
A worker stops 13 minutes in; a job that ran out of time ends `FAILED`
with that reason and can be started again. `READMIT` judges each event
with its `receivedAt` as the clock and applies the close guard on the real
clock before each write.

## 10. Observability and costs

**Logs.** Every function writes JSON lines through one logger
([`src/shared/logger.ts`](src/shared/logger.ts)) that keeps only
allow-listed fields and drops any value that looks like a URL, a header or
a SigV4 parameter. `tenantId` is an allow-listed field. The lines the
functions write name the cell, application, meter, sink, hour or job, and
none names a tenant, because a batch, an hour and a delivery each span
tenants. API Gateway access logs carry the caller ARN (for an emitter,
`<fleet>-ue-<cellId>`) and the request id. The per-tenant view is the
service's own output: every event in the raw and error objects carries its
`tenantId`, and usage records are keyed by tenant (`GetUsage`,
`ListUsage`).

**Metrics.** Embedded metric format, namespace
`TenantUsageMetering/<construct id>`
([`src/shared/metrics.ts`](src/shared/metrics.ts)). Dimensions have low
cardinality (a reason, a sink id); no metric has a tenant dimension.
CloudWatch bills each custom metric, that is each unique combination of
name and dimensions, per month
([CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)), so a
tenant dimension would add one billed metric per tenant for each metric
name, while the usage records already hold exact per-tenant counts for
every hour. Sixteen alarms (spec §3.1, §3.2, §3.5, §4.5, §4.7), all sent
to `alarmTopicArn` when one is given, including the two heartbeats: the
scheduler has not run for 15 minutes, and hours wait past their grace
with none counted for 2 hours.

**Costs.** Every resource is pooled; nothing is tagged per tenant. The
sample's own records are the attribution data. Each usage record carries
`eventCount`, the accepted and deduplicated events of one tenant,
application and meter in one hour; on an `ADJUSTMENT` it is the new count
for that key, so the latest record of each key holds the count. A
tenant's share of an hour is

```
share(t, h) = Σ eventCount(t, *, *, h) / Σ eventCount(*, *, *, h)
records(t, h) = number of records of tenant t in hour h, all revisions
```

and its cost

```
tenant cost ≈ Σ over hours h:  share(t, h) × per-event cost(h)
                             + records(t, h) / records(*, h) × per-record cost(h)
            + fixed cost of the month / tenants with a record in the month
```

- **Per-event cost**: API Gateway requests and ingest Lambda time (one
  call carries up to 100 events of several tenants, so they are split by
  event), ingest bus publishes and deliveries, Firehose ingestion, S3
  writes and storage of `raw/`, and the recounter's execution and reads.
  Firehose and S3 bill by bytes; when tenants' events differ much in size,
  split those two by each tenant's bytes in the hour's raw objects instead.
- **Per-record cost**: table writes and stream reads of records, usage
  bus publishes and subscriber deliveries, sink deliveries.
- **Fixed cost, split equally**: the two 5-minute schedules and the
  functions they run, the alarms, the secrets of `SECRET` sinks, the
  table's storage of registrations, meters and sinks, and the log groups.
- **Unattributable remainder**: refused events and calls from unregistered
  roles, whose `tenantId` is only the emitter's claim, and the cost of
  jobs (re-admission, redrives, recounts). Refusals can be charged to the
  emitter's cell, which the `error/` objects and the access log name; the
  rest is vendor overhead.

Unit prices come from each service's pricing page; the sample states no
figures.

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
- No log line or metric names a tenant (§10); per-tenant questions are
  answered from the raw objects and the usage records.
- The integration test reads stack outputs for the stand-in callers' role
  ARNs; a consumer reads the published parameter instead (integration-test.md,
  test-only shortcuts).
- The residuals of [`threat-model.md`](threat-model.md) apply.

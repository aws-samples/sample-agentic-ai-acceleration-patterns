<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Specification: Tenant usage metering for agentic applications

Status: draft for review. No code yet.

## 1. Problem statement

A multi-tenant agentic application bills, tiers and limits its tenants on
what they use: agent sessions, model tokens, tool calls, API requests,
bytes stored. That usage is produced in many places. In the cell model of
[`control-plane`](../../control-plane/), it is produced by the cells, and a
cell can live in the vendor's account or in a tenant's own account.

Three things go wrong when each part of the application reports usage on
its own:

1. **Counts drift.** Each emitter has its own event shape, its own
   retries and its own duplicates. The same hour gives different totals
   depending on who is asked.
2. **Anyone can claim anything.** An emitter that can report usage can
   usually report it for any tenant, under any meter, as any other
   emitter. A billing system downstream cannot tell.
3. **The meter list is code.** A new meter, or a change to how a
   billing system wants a record shaped, is a redeploy of every emitter.

This sample demonstrates one metering service that the vendor owns:

- a single, versioned **usage event** that every emitter sends;
- an **ingest door** that admits a usage event only from an emitter the
  control plane registered, and only for a tenant the control plane placed
  in that emitter's cell;
- a durable, replayable **raw store**;
- an hourly **recount** driven by a run-time **meter catalog**, whose
  totals are a pure function of the raw store, so a recount of any hour
  gives the same records;
- **sinks** set by configuration, which hand each usage record to a
  billing system or an export file, and a **usage bus** on which every
  record is also published;
- **lifecycle wiring**: the control plane's vendor hooks
  (control-plane ADR-044) register cells and tenants with the metering
  service, so onboarding and offboarding drive metering with no manual
  step.

Deployment model: any. The sample assumes cells (pool, silo or bridge
inside a cell) placed by a control plane, and works without one: the
registration operations can be called by any principal the deployer
names. The usual topology has three accounts: the control plane's, the
metering service's, and the accounts that hold cells, vendor-owned or
tenant-owned.

### 1.1 What this sample does not do yet

- Rating, pricing, invoices, credits, tiers: the billing system's job.
- Live quota enforcement on usage (a tenant over its limit is refused):
  the sample publishes the counted records a limiter would read, and no
  more.
- Hooks on application and tenant record events (`PutApplication`,
  `DeleteApplication`, `CreateTenant`, `DeleteTenant`): the control plane
  runs hooks only on the six events of its `EVENT` enum, cell and
  deployment create, update and delete (control-plane R-42). The sample
  registers what those events give it (§3.4).
- Usage that the cell cannot see: AWS cost per tenant from CUR 2.0 is
  cost attribution, a separate concern (`ARCHITECTURE.md` §3.3, point 4).
- Multiple Regions: one metering service per Region.
- A reconciliation that compares the registry with the control plane's
  deployments and repairs a binding a skipped delete hook left behind
  (§3.4); the sample lists the registry so an operator can compare.

### 1.2 What this sample is NOT

- **Not telemetry.** Metrics, traces and logs describe how the system
  behaves; metering produces the records a bill is built from. They have
  different rules for loss, duplicates and lateness, so the sample does
  not carry billing events on the telemetry path.
- **Not proof of honest emitters.** The sample proves *who* sent a usage
  event and *which tenants* it may speak for. It cannot prove the quantity
  is true. Code that runs in a tenant-owned account is controlled by the
  tenant, and that tenant can under-report its own usage (T-3, in
  `threat-model.md`).
- **Not tenant isolation inside a pooled cell.** An emitter speaks for
  every tenant its cell holds; the cell is vendor code. A role per
  deployment would narrow it and is a seam.
- **Not a billing system.** The sink contract is the boundary.

## 2. Guiding principles

**P-1. Billing events have their own path.** A usage event never shares a
pipe with metrics or logs. The path is built for no loss and exactly-once
counting, which telemetry pipes do not promise.

**P-2. Identity comes from the signature, never from the body.** The
emitter, its cell, its application and its account are taken from the
verified caller of the ingest door. A body field that names an emitter, a
cell, an application or an account is ignored; a body `tenantId` is
admitted only when the caller's cell holds that tenant.

**P-3. The control plane is the source of truth for placement; metering
copies it.** Which cell holds which tenant is written into the metering
service by the control plane's vendor hooks, under a role no cell account
holds or trusts. Metering never reads placement from an emitter.

**P-4. Totals are a function of the raw store.** Every count is
recomputed from the raw events of its hour by a fixed rule. A recount, a
re-run after a failure, or an audit gives the same record. Nothing is
counted in flight.

**P-5. Duplicates are removed by identity, not by luck.** Every usage
event carries an `eventId` the emitter chooses once, as a ULID or UUID,
and reuses on every retry. The recount keeps one event per
`(applicationId, tenantId, eventId)`, with `applicationId` taken from the
verified emitter, so an emitter's unchanged resend, a bus or Firehose
retry, a redrive and a recount never double a total, and one
application's emitter cannot suppress another's events.

**P-6. A meter is data, a sum rule is code.** Adding or changing a meter,
or changing how a sink maps a record, is a write through the admin API and
needs no deploy. A new way of summing is a code change. An hour is always
counted under one meter version.

**P-7. Late is modelled, not dropped.** An event that arrives after its
hour was counted is kept, and the hour is recounted while it is inside
the recount window. The difference goes out as an `ADJUSTMENT` record; a
sink never receives a silently changed total.

**P-8. Every refusal of a registered emitter's event is kept.** An event
from a registered emitter that the ingest door refuses is written to the
error store with the reason, and can be re-admitted while its hour is
inside the recount window. Calls from unregistered callers are counted,
not stored.

## 3. System shape

### 3.1 Components

All in the metering account, one stack.

| Component | Job |
|---|---|
| Ingest door | REST API, IAM auth (SigV4), resource policy of §3.2. `PutUsageEvents`, batches of up to 100 |
| Ingest function | Verifies the caller is a registered emitter, checks each event against the cell's bindings and the meter catalog, validates the shape, publishes accepted events to the ingest bus (or Firehose, with `ingestPath: DIRECT`) and writes refused ones to the error store (ADR-0001, ADR-0002) |
| Ingest bus | EventBridge Custom Event Bus, `ingestBusRetentionDays` retention; `DeduplicationId = <applicationId>#<tenantId>#<eventId>`, `EventGroupId = tenantId`; a Firehose subscriber with a retry policy of 24 h maximum event age and an SQS dead-letter queue (ADR-0002) |
| Raw stream | Amazon Data Firehose to S3, 60 s buffer, dynamic partitioning by event hour into `raw/hour=YYYY-MM-DDTHH/` (§4.8) |
| Ingest redrive | A function an operator starts with `StartIngestRedrive`: moves messages from the ingest dead-letter queue into Firehose, each as the envelope the bus would have delivered, unchanged. An alarm fires on any object under Firehose's `firehose-error/` prefix, which the recount does not read |
| Table | One DynamoDB table, PITR on: registry, meters, sinks, hours, recounts, usage records (§4) |
| Admin API | Same REST API: meters, sinks, registrations, usage reads, recounts, re-admission, redrives |
| Object tracker | S3 event notification on `raw/` and `readmitted/`: for every new object, creates the hour item if absent and increments its `generation` (§4.5); failed invocations go to an SQS on-failure destination the scheduler replays |
| Recounter | Step Functions, one execution per hour: reads the hour's raw objects, dedupes, sums per meter rule, writes usage records (§4.9) |
| Scheduler | EventBridge Scheduler, every 5 minutes: batch-gets the hour items of the recount window and starts a recount for each hour that is due, `DIRTY`, `COUNT_FAILED` past its backoff, or `COUNTING` with an expired lease; replays the object tracker's failures; sweeps `publishPending` records |
| Record publisher | DynamoDB Streams on usage-record writes: publishes `UsageRecorded` to the usage bus, queues one delivery per sink, and clears the record's `publishPending` marker; the scheduler sweeps records whose marker is older than 15 minutes (§4.7), and an alarm fires on failed stream batches |
| Usage bus | EventBridge Custom Event Bus, `usageBusRetentionDays` retention; one `UsageRecorded` event per usage record (§4.8), `DeduplicationId = recordId`, `EventGroupId = tenantId`. Always on |
| Sink dispatcher | Sends each queued delivery to its sink, retries for 24 h, then marks it `FAILED` and alarms |
| Sinks | `HTTP` (any billing API, field mapping by configuration), `S3_EXPORT` (JSON lines into the sample's export bucket) |
| Error store | S3 `error/hour=YYYY-MM-DDTHH/`, one object per batch with refused events, each with its reason |
| `UsageSubscriber` | Published construct that attaches a reader to the ingest bus (`raw`) or the usage bus (`usage`) with a dead-letter queue, a retry policy and alarms built in (ADR-0006) |

### 3.2 Callers and identity

| Caller | Proves itself by | May call |
|---|---|---|
| Emitter | SigV4 as an assumed role named `<fleet>-ue-<cellId>`, registered for a cell | `PutUsageEvents` |
| Lifecycle hook | SigV4 as a role in `registrarPrincipalArns` (the control plane's `<fleet>-global-hook`) | `PutCellEmitter`, `DeleteCellEmitter`, `PutTenantBinding`, `DeleteTenantBinding` |
| Metering operator | SigV4 as a role in `operatorPrincipalArns` | meters, sinks, usage reads, recounts, re-admission, redrives, reads of registrations |
| Usage reader | SigV4 as a role in `readerPrincipalArns` | `GetUsage`, `ListUsage` |
| Bus subscriber | Its account: the metering account, or one a bus is shared with through AWS RAM (subscribe only) | create its own subscribers on that bus, through `UsageSubscriber` |

**Ingest door resource policy.** `POST /usage-events` admits any account's
principal whose `aws:PrincipalArn` matches
`arn:aws:iam::*:role/<fleet>-ue-*`; every other route admits only the
principals listed for it. The policy cannot name cell accounts, because
cells are registered at run time; the registry is the gate. The function
admits a caller only when `requestContext.identity.userArn` is an
assumed-role ARN; it reduces it to
`arn:aws:iam::<account>:role/<name>` and looks up
`EMITTER#<account>#<name>`. Any other caller, or a role with no
registration, gets a 403 for the whole batch; the function records one
metric data point and at most one log line per caller ARN per minute, and
stores nothing (P-8).

Registry reads are cached in the function for 60 seconds. A deleted or
closed registration therefore stops admitting within 60 seconds.

The role-name pattern is not a secret, so any AWS account can create a
matching role and call the ingest door. Its calls are refused, but they
draw on the stage throttle and the function's concurrency. The function
has reserved concurrency, so it cannot starve the other functions of the
stack, and an alarm fires on the unregistered-caller metric; a flood can
still delay real emitters until the vendor blocks the source, which the
threat model lists as a residual.

**Bus sharing.** The ingest bus carries every tenant's checked events, and
the usage bus every tenant's counted records, so both are shared only with
vendor accounts: `rawSubscriberAccountIds` and `usageSubscriberAccountIds`.
`PutCellEmitter` refuses a cell in any account on either list, vendor-owned
or not, and in the metering account itself (ADR-0006). `UsageSubscriber`'s `meters` and `tenants` filters are a
convenience; an account a bus is shared with can create an unfiltered
subscriber.

### 3.3 Deployment inputs

| Input | Meaning | Default |
|---|---|---|
| `fleetName` | the control plane's fleet name, `[a-z0-9][a-z0-9-]{0,31}` as there, checked at synth (`<fleet>-ue-<cellId>` is then at most 62 characters) | required |
| `registrarPrincipalArns` | roles that may register cells and tenants | required |
| `operatorPrincipalArns` | roles that may manage meters, sinks, recounts and redrives | required |
| `readerPrincipalArns` | roles that may read usage | `[]` |
| `lateGraceMinutes` | how long after an hour ends it is first counted; synth fails below the Firehose buffer (1 minute) plus 5 minutes | `15` |
| `recountWindowHours` | how long after an hour ends it may still be recounted; synth fails below 72. Ingest admits an event only while its hour ended less than `recountWindowHours` − 49 hours ago, so an accepted event has 48 hours (the subscriber's 24 h maximum event age plus 24 h to redrive its dead-letter queue) to reach S3, and one more hour for the Firehose buffer and the scheduler, before the hour closes | `96` |
| `closeGraceMinutes` | how long a closing emitter or binding is still admitted, for buffered events | `60` |
| `rawRetentionDays` | raw, re-admitted and error object lifetime | `400` |
| `ingestPath` | `BUS` (ingest bus, ADR-0002) or `DIRECT` (Firehose, events packed per hour) | `BUS` |
| `ingestBusRetentionDays` | ingest bus retention | `1` |
| `usageBusRetentionDays` | usage bus retention | `7` |
| `rawSubscriberAccountIds` | vendor accounts the ingest bus is shared with | `[]` |
| `usageSubscriberAccountIds` | vendor accounts the usage bus is shared with | `[]` |
| `alarmTopicArn` | optional SNS topic for every alarm of the stack | none |

### 3.4 Lifecycle wiring with the control plane

The control plane runs a global vendor hook on each event below
(control-plane §6.5, R-42). The hook script calls the metering admin API
under `<fleet>-global-hook`, so only the control plane registers what a
cell may report. Creates and updates run in the `PRE` phase, so a cell or
deployment metering refuses fails before its script builds anything, and
its first usage is already admitted. Deletes run in the `POST` phase,
after the delete script has flushed and stopped the emitters, so usage
the tenant consumed until its teardown is still admitted (control-plane
R-45).

| Event | Phase | Metering call | Takes from the hook environment |
|---|---|---|---|
| `CELL_CREATE` | `PRE` | `PutCellEmitter` (refused in a subscriber account or the metering account, §3.2) | `CELL_ID`, `CELL_ACCOUNT_ID`, `APPLICATION_ID` |
| `CELL_DELETE` | `POST` | `DeleteCellEmitter` (to `CLOSING`) | `CELL_ID` |
| `DEPLOYMENT_CREATE` | `PRE` | `PutTenantBinding` | `TENANT_ID`, `CELL_ID`, `APPLICATION_ID`, `PARAM_BILLING_ACCOUNT` |
| `DEPLOYMENT_UPDATE` | `PRE` | `PutTenantBinding` (billing account may change) | as create |
| `DEPLOYMENT_DELETE` | `POST` | `DeleteTenantBinding` (to `CLOSING`) | `TENANT_ID`, `CELL_ID`, `APPLICATION_ID` |

The hook script reads the metering admin API URL from a file in its own
source, `metering-hook.env`, which the deployer sets; it never takes it
from a `PARAM_` value, which deployment events carry from the
deployment's set, not the cell's (control-plane R-32, R-42). It builds
every request body with `jq --arg`, so a tenant-shaped value such as
`PARAM_BILLING_ACCOUNT` never reaches a command line (control-plane §6.5).

Hooks run again on updates, on delete retries, and on the delete that
cleans up a failed create (control-plane R-42), so every registration
operation is idempotent: `Put*` is an upsert that reaches the same item
whatever its prior state, and `Delete*` succeeds on a missing or already
`CLOSING` item.

Consequences of the wiring:

- **Onboarding and updates depend on metering.** A refused or failing
  `PutCellEmitter` or `PutTenantBinding` fails the cell create, or the
  deployment create or update, before its script runs.
- **A skipped delete hook leaves a registration `ACTIVE`.** A delete hook
  is retried three times and then skipped (control-plane R-46). The
  binding then stays `ACTIVE` and the cell can keep reporting for that
  tenant. `ListTenantBindings` and `ListCellEmitters` let an operator
  compare with the control plane; an automatic reconciliation is a seam
  (§1.1).
- **Every global hook can register.** All global hooks share
  `<fleet>-global-hook` (control-plane R-41), so any global hook the
  vendor registers holds the registrar grant. A role per global hook is a
  control-plane seam (its §11).

The emitter role name is fixed, `<fleet>-ue-<cellId>` with path `/`, so
the hook never takes it from `SCRIPT_OUTPUTS` (control-plane R-42:
identity comes from the variables). The cell create script creates that
role and grants it the ingest statement (§6.1); the tenant delete script stops
serving the tenant and flushes its usage; the cell delete script stops
the emitters, waits for their buffers to flush, then removes the role.

`BILLING_ACCOUNT` is a deployment parameter the application declares
(control-plane R-32). It is the tenant's account id in the billing
system. `PutTenantBinding` refuses a value outside
`[A-Za-z0-9._:-]{1,128}`. The metering API URL reaches the cells' emitters
as a cell parameter `METERING_API_URL` the application declares with the
URL as its default (control-plane R-34).

## 4. Data model

One DynamoDB table, `PK`/`SK`, PITR on, TTL on `expiresAt`.

### 4.1 Meter

`PK=METER#<meterId>`, `SK=V#<version>` (zero-padded), plus
`SK=CURRENT` holding the latest version number.

| Field | Meaning |
|---|---|
| `meterId` | `[a-z0-9_.-]{1,64}` |
| `unit` | free text, for sinks (`tokens`, `requests`, `seconds`) |
| `rule` | `COUNT`, `SUM`, `MAX`, `UNIQUE_COUNT` (of `value` as a string) |
| `allowedApplications` | application ids whose emitters may send this meter; empty is all |
| `effectiveFrom` | the first whole hour this version counts |
| `status` | `ACTIVE`, `RETIRED` |

`CreateMeter` sets `effectiveFrom` to the next whole hour, or to an
earlier whole hour the caller names, at most `recountWindowHours` back,
so events refused as `UNKNOWN_METER` can be re-admitted and counted.
`UpdateMeter` and `DeleteMeter` (which retires) write a new version with
`effectiveFrom` = the next whole hour (P-6). An event, at ingest and in
the recount, is checked against the version in effect at its hour: the
latest `effectiveFrom` at or before it.

`UNIQUE_COUNT` is per hour. Unique counts over a month are not the sum of
hourly ones; a billing system that needs them reads the raw store or the
`raw` stream.

### 4.2 Cell emitter

`PK=EMITTER#<accountId>#<roleName>`, `SK=META`, and a lookup item
`PK=CELL#<cellId>`, `SK=META`.

| Field | Meaning |
|---|---|
| `cellId`, `applicationId`, `accountId` | from the hook |
| `roleName` | `<fleet>-ue-<cellId>` |
| `status` | `ACTIVE`, `CLOSING` |
| `activeFrom` | set by `PutCellEmitter` when it creates the item or returns it to `ACTIVE`: now |
| `closedAt`, `closesAt` | set by `DeleteCellEmitter`: now, and now plus `closeGraceMinutes` |
| `intervals` | earlier `{activeFrom, closedAt}` pairs, kept while the end of `closedAt`'s hour is inside `recountWindowHours` |
| `expiresAt` | the end of `closedAt`'s hour plus `recountWindowHours`, for audit |

Transitions: none → `ACTIVE` (`PutCellEmitter`) → `CLOSING`
(`DeleteCellEmitter`) → removed by TTL. An emitter admits events whose
`time` is at or after `activeFrom`, and, once `CLOSING`, at or before
`closedAt`, until `closesAt`. Other events are refused
`REGISTRATION_CLOSED`. Past `closesAt` the emitter is refused like an
unregistered one. `PutCellEmitter` on a `CLOSING` item (a cell or
deployment created again on the same key) moves the current
`{activeFrom, closedAt}` into `intervals`, removes `closedAt`, `closesAt`
and `expiresAt`, and sets a new `activeFrom`. `READMIT` admits an event
whose `time` falls in the current interval or in any of `intervals`, so
an event is judged by the registration as it stood at the event's time.

### 4.3 Tenant binding

`PK=CELL#<cellId>`, `SK=TENANT#<tenantId>`, and a lookup item
`PK=TENANT#<tenantId>`, `SK=APP#<applicationId>#CELL#<cellId>`.

| Field | Meaning |
|---|---|
| `tenantId`, `applicationId`, `cellId` | from the hook |
| `billingAccount` | from `PARAM_BILLING_ACCOUNT`, optional |
| `status`, `activeFrom`, `closedAt`, `closesAt`, `intervals`, `expiresAt` | as for emitters, with `TENANT_NOT_IN_CELL` for a missing binding and `REGISTRATION_CLOSED` outside its intervals |

Transitions as for emitters. A deployment deleted and created again in
the same cell returns the item to `ACTIVE` and keeps the earlier interval;
placed in another cell, it lands in a new item, and the old one stays
`CLOSING` until its TTL.

### 4.4 Sink

`PK=SINK#<sinkId>`, `SK=META`.

| Field | Meaning |
|---|---|
| `type` | `HTTP`, `S3_EXPORT` |
| `enabled` | boolean |
| `endpoint` | `HTTP`: HTTPS URL. `S3_EXPORT`: a key prefix in the sample's export bucket |
| `secretName` | `HTTP` only: Secrets Manager name of the credential, read inside the dispatcher |
| `mapping` | `HTTP` only: target field name → source (record field, meter field, or constant) |
| `meters` | meter ids this sink takes; empty is all |

### 4.5 Hour

`PK=HOUR#<YYYY-MM-DDTHH>`, `SK=META`.

| Field | Meaning |
|---|---|
| `status` | `OPEN`, `COUNTING`, `COUNTED`, `DIRTY`, `COUNT_FAILED`, `CLOSED` |
| `generation` | incremented by the object tracker for every object of the hour |
| `countedGeneration`, `countedAt` | the generation and time of the last finished count |
| `lease`, `leaseExpiresAt` | the recount execution holding `COUNTING`, and when its hold lapses (30 minutes) |
| `attempts` | failed counts since the last success |

The object tracker creates the item, `OPEN`, on the hour's first object,
and increments `generation` on every object whatever the state. Its
invocations are asynchronous, with an SQS on-failure destination that
keeps the S3 event; the scheduler replays that queue, and an alarm fires
on its depth.

Every 5 minutes the scheduler batch-gets the hour items of the recount
window (one key per hour, at most `recountWindowHours` + 1) and starts a
recount for each one that is due. A recount takes the hour with a
conditional write (`OPEN` past `lateGraceMinutes`, `DIRTY`,
`COUNT_FAILED` past its backoff, or `COUNTING` past `leaseExpiresAt`) →
`COUNTING` with `lease` set to its execution id, reads `generation`, then
lists and counts. Every usage record it writes, and its final status
write, carry the condition `lease = <own execution id>`, so an execution
whose lease was taken over writes nothing more. The execution's timeout
is 25 minutes, below the lease. It finishes with
`COUNTED` if `generation` is unchanged, else `DIRTY`, so an object that
landed during the count is counted next. A `COUNTED` hour whose
`generation` moves past `countedGeneration` is `DIRTY`. A failed count →
`COUNT_FAILED`, retried with backoff; an alarm fires on the third
failure.

At hour end plus `recountWindowHours`, the scheduler moves a `COUNTED`
hour to `CLOSED`. An hour in any other state at that time gets a final
count first and raises an alarm; it closes only from `COUNTED`. A
`CLOSED` hour is never counted again, and an object that lands in it
raises an alarm.

### 4.6 Recount and re-admission jobs

`PK=JOB#<jobId>`, `SK=META`.

| Field | Meaning |
|---|---|
| `kind` | `RECOUNT` (an hour range), `READMIT` (error objects of an hour range, optionally one reason), `INGEST_REDRIVE` (the ingest dead-letter queue), `SINK_REDRIVE` (`FAILED` deliveries of one sink, or every record of an hour range for one sink), `RESEND_BLOCKED` (one tenant and application's `BLOCKED` deliveries) |
| `status` | `RUNNING`, `SUCCEEDED`, `FAILED` |
| `counts` | items processed, admitted, refused, redriven |

`RECOUNT` increments `generation` of each hour in range, the same path a
new object takes, so a `COUNTED` hour becomes `DIRTY` and a `COUNTING`
one ends `DIRTY`; a `CLOSED` hour in range is refused. `READMIT` runs every event of the chosen error objects through
the ingest checks again, judging each by the registrations' `activeFrom`
and `closedAt` and the meter version at its time, and writes the ones
that pass, with their original `receivedAt`, to `readmitted/hour=.../`,
which the recount reads with `raw/`. It writes S3 directly, so it may
re-admit into any hour that is not `CLOSED`. An event whose hour is
`CLOSED` stays refused, `TOO_LATE`.

### 4.7 Usage record

`PK=USAGE#<tenantId>#<applicationId>`, `SK=<hour>#<meterId>#<seq>`, `seq`
zero-padded from `0000`.

| Field | Meaning |
|---|---|
| `kind` | `HOURLY` for `seq` 0, `ADJUSTMENT` after |
| `quantity` | the hour's total for `HOURLY`; the difference from the sum of earlier `seq`s for `ADJUSTMENT`, which can be negative when a different copy of an event wins in a later count (§4.9) |
| `total` | the hour's total after this record, so a sink that missed earlier `seq`s still knows the total |
| `meterVersion`, `eventCount` | for audit |
| `billingAccount` | set once: from the tenant's `ACTIVE` binding for the application when the record is written (else its latest `CLOSING` one), or, if that has none, on the first resend from `BLOCKED` |
| `recordId` | `sha256(tenantId, applicationId, meterId, hour, seq)`; sinks use it as their idempotency key |
| `revision` | `1` when written; `2` once a late `billingAccount` is written onto it |
| `publishPending` | present until the record, at its current `revision`, is on the usage bus and queued for its sinks; a sparse index lists the records that hold it |
| `sinks` | per sink: `PENDING`, `RETRYING`, `SENT`, `BLOCKED` (reason), `FAILED` (reason) |

A record is written with a condition that its `seq` does not exist yet
and that the recount still holds the hour's lease (§4.5). `HOURLY` is
written for each `(tenant, application, meter)` with at least one event
in the hour; a first event that arrives late writes `HOURLY`. No record
is written when a recount changes nothing.

The table is the outbox. Each record is written with `publishPending`.
The record publisher (§3.1) handles each insert from the table's stream,
publishes `UsageRecorded` (`DeduplicationId = <recordId>#<revision>`),
queues the sink deliveries, and removes `publishPending`. The scheduler
also reads the `publishPending` index every 5 minutes and publishes any
record that has held it for more than 15 minutes, so a failed stream
batch is caught after the stream's 24-hour retention as well.

Sink delivery: a record goes to the sinks enabled when it is written that
take its meter. `PENDING` → `SENT`, or `RETRYING` with backoff for 24 h →
`FAILED` and an alarm; `SINK_REDRIVE` sends a sink's `FAILED` deliveries
again, or, given an hour range, every record of that range, which is how
a sink enabled later is backfilled. An `HTTP` sink whose mapping needs
`billingAccount` on a record without one marks it `BLOCKED`
(`NO_BILLING_ACCOUNT`), and an alarm fires when a delivery has been
`BLOCKED` for 24 hours. A `PutTenantBinding` that sets a billing account
starts a `RESEND_BLOCKED` job for that tenant and application and
returns; the job writes the value onto each `BLOCKED` record with
`revision` 2 and `publishPending`, so the record publisher sends it to the
blocked sinks and publishes it again on the usage bus.

### 4.8 Usage event and raw objects (the wire contract)

Smithy structure `UsageEvent`:

| Field | Required | Meaning |
|---|---|---|
| `eventId` | yes | a ULID or UUID, reused on retry (P-5) |
| `tenantId` | yes | must be bound to the caller's cell |
| `meterId` | yes | a meter in effect at the event's hour |
| `value` | yes | non-negative decimal string, at most 12 digits before the point and 6 after; `COUNT` ignores it, `UNIQUE_COUNT` treats it as a string |
| `time` | yes | ISO 8601 UTC; at most 5 minutes in the future, and in an hour that ended less than `recountWindowHours` − 49 hours ago (§3.3); older is `TOO_LATE` |
| `dimensions` | no | up to 10 string pairs, passed to sinks, not summed on |

The ingest function adds `applicationId`, `cellId`, `emitterAccountId`,
`emitterRole` and `receivedAt` before writing. None of these come from
the body (P-2).

Raw objects:

| Path | Object content | Firehose partition key |
|---|---|---|
| `ingestPath: BUS` | concatenated EventBridge envelopes, no delimiter, each with the enriched event as `detail` | `detail.time`, cut to the hour |
| `ingestPath: DIRECT` | concatenated records `{"hour": ..., "events": [...]}`, each holding the enriched events of one batch that share an hour | `hour` |
| `readmitted/` | newline-delimited enriched events, written by `READMIT` | the job writes the key |
| `error/` | one JSON document per batch: the caller, `receivedAt`, and each refused event with its reason | the function writes the key |

`UsageRecorded` on the usage bus: `source` `metering.usage`,
`detail-type` `UsageRecorded`, `detail` with `recordId`, `revision`, `kind`,
`tenantId`, `applicationId`, `meterId`, `meterVersion`, `unit`, `hour`,
`seq`, `quantity`, `total`, `eventCount`, `billingAccount` (may be
absent). The `raw` stream carries the enriched `UsageEvent` as `detail`.
Both are part of the published interface (§6.3).

### 4.9 The recount rule

For one hour, the recount reads every object under `raw/hour=H/` and
`readmitted/hour=H/`, and:

1. keeps one event per `(applicationId, tenantId, eventId)`: the earliest
   `receivedAt`, ties broken by the lowest canonical JSON (RFC 8785) of
   the enriched event, whatever object format it came from;
2. groups by `(tenantId, applicationId, meterId)` and applies the meter
   version in effect at `H`, in decimal arithmetic at 6 fractional
   digits, rounding half to even only for `SUM`'s final total;
3. compares each group's total with the sum of its existing records, and
   writes `HOURLY` or `ADJUSTMENT` for the difference.

The same objects give the same records, so a recount of a `COUNTED` hour
with no new object writes nothing.

Dedupe runs within one hour. Two copies of an event with different
`time` values land in different hours and both count, so an emitter MUST
resend an event unchanged (§6.1); the emitter snippet stores each event
once and resends the stored bytes.

## 5. API surface

Smithy, `aws.protocols#restJson1`, every operation IAM-authorised.

| Resource | Operations |
|---|---|
| Usage events | `PutUsageEvents` (`POST /usage-events`) |
| Meter | `CreateMeter`, `GetMeter`, `UpdateMeter`, `DeleteMeter` (retires), `ListMeters` |
| Sink | `CreateSink`, `GetSink`, `UpdateSink`, `DeleteSink`, `ListSinks` |
| Cell emitter | `PutCellEmitter`, `GetCellEmitter`, `DeleteCellEmitter`, `ListCellEmitters` |
| Tenant binding | `PutTenantBinding`, `GetTenantBinding`, `DeleteTenantBinding`, `ListTenantBindings` |
| Usage | `GetUsage` (one tenant, application and meter, an hour range), `ListUsage` (one tenant, all meters) |
| Hour | `GetHour`, `ListHours` |
| Jobs | `StartRecount`, `StartReadmission`, `StartIngestRedrive`, `StartSinkRedrive`, `GetJob`, `ListJobs` |

`PutUsageEvents` returns 200 with one result per event:

| Result | Meaning | Emitter action |
|---|---|---|
| `ACCEPTED` | stored, or already stored under the same key | none |
| `RETRY` | the ingest bus or Firehose throttled it after the function's retries | send again with the same `eventId` |
| `REFUSED` + reason | `TENANT_NOT_IN_CELL`, `REGISTRATION_CLOSED`, `UNKNOWN_METER`, `METER_NOT_ALLOWED`, `BAD_TIME`, `TOO_LATE`, `BAD_SHAPE`; written to the error store | fix the cause; an operator may re-admit |

Errors:

| Code | When |
|---|---|
| 400 `ValidationException` | malformed request, a field outside its charset, a `BILLING_ACCOUNT` out of format, a backdated `effectiveFrom` beyond the window |
| 403 `AccessDeniedException` | caller not permitted for the route; for `PutUsageEvents`, not an assumed role or not a registered emitter |
| 404 `ResourceNotFoundException` | unknown meter, sink, hour, job (never for `Delete*` of a registration) |
| 409 `ConflictException` | `PutCellEmitter` in a subscriber account or the metering account; `CreateMeter` on an existing meter; `StartRecount` over a `CLOSED` hour; a lost conditional write, retryable |
| 429 `ThrottlingException` | API Gateway stage throttle |
| 500, 502, 503, 504 | the function failed, was throttled or timed out; nothing in the batch is known to be stored |

### 5.1 Limits

| Limit | Value |
|---|---|
| Events per `PutUsageEvents` | 100 |
| Sustained ingest per metering account, `ingestPath: BUS` | about 1,000 events per second; the bus throttled entries above about 1,400 per second in a spike, a limit the quota pages do not name (ADR-0002) |
| Registry cache | 60 seconds |

## 6. Contracts

### 6.1 What the deployer supplies

- The inputs of §3.3.
- **In each cell account**, from the cell create script: the role
  `<fleet>-ue-<cellId>`, path `/`, trusted by the cell's emitter
  workloads, with an inline policy built from the published
  `ingestStatement` (allow `execute-api:Invoke` on `POST /usage-events`
  of the metering API). The cell and tenant delete scripts flush the
  emitters before they finish; the cell delete script then removes the
  role.
- **In the control plane account**: a customer-managed policy built from
  the published `registrarStatement`, attached to `<fleet>-global-hook`
  through `globalHookManagedPolicyArns` (control-plane §3.3); the hook
  script registered as a global hook on the five events of §3.4, in the
  phases that table names, with `metering-hook.env` in its source set to
  the metering API URL; the application's declarations of
  `BILLING_ACCOUNT` (deployment parameter) and `METERING_API_URL` (cell
  parameter).
- Emitters that send `UsageEvent`s with stable ULID or UUID `eventId`s,
  resend an event unchanged, and resend `RETRY` results. A 429, a 5xx or
  a timeout resends the whole batch unchanged, with backoff; a 403 or a
  400 is not resent.
- For an `HTTP` sink: the endpoint and a secret in Secrets Manager.

### 6.2 What the sample promises

1. An event from a role that is not a registered, admitted emitter is
   refused.
2. An event for a tenant not bound to the caller's cell is refused, also
   when the tenant exists in another cell.
3. Each `(applicationId, tenantId, eventId)` resent unchanged is counted
   once, through retries, redrives, re-admission and recounts.
4. A recount of an hour gives the records already written; a late event
   inside the recount window gives an `ADJUSTMENT`, never a changed
   record.
5. A new meter, a changed meter rule, and a changed sink mapping take
   effect without a deploy: meters from the hour their version names,
   sinks from the next dispatch.
6. Every sink enabled when a record is written receives it at least
   once, with a stable `recordId` to dedupe on and the hour's `total`, or
   the delivery is `BLOCKED` or `FAILED` with an alarm and can be sent
   again.
7. A reader attached through `UsageSubscriber` gets every matching event
   at least once, or finds it in its dead-letter queue; an alarm fires
   on the first event that reaches the queue.
8. An event the ingest function `ACCEPTED` reaches S3, or the ingest
   dead-letter queue with an alarm, from which `StartIngestRedrive`
   moves it to S3; if it reaches S3 within 48 hours, it is counted.

### 6.3 Published interface

- Construct `TenantUsageMetering` (`src/index.ts`): the props of §3.3;
  exposes `apiUrl`, `ingestStatement` and `registrarStatement` (IAM
  policy statements a deployer places in other accounts),
  `ingestBusArn`, `usageBusArn`, `emitterRoleNamePattern`.
- Construct `UsageSubscriber` (`src/index.ts`, ADR-0006):

  | Prop | Meaning | Default |
  |---|---|---|
  | `busArn` | the ingest or usage bus ARN, from the published parameter | required |
  | `stream` | `raw` (checked usage events) or `usage` (`UsageRecorded` records); sets the filter scope and the event shape | `usage` |
  | `targetArn`, `role` | any target the bus supports, and the role it delivers with | required |
  | `meters`, `tenants` | optional filters on `meterId` and `tenantId` | all |
  | `type` | `UNORDERED`, or `FIFO` per tenant | `UNORDERED` |
  | `startingPosition` | `LATEST`, or a point in time inside the bus's retention | `LATEST` |
  | `maxEventAge` | how long a failing event is retried before it goes to the DLQ | 24 hours |
  | `alarmTopic` | optional SNS topic for the alarms | none |

  It always creates an SQS dead-letter queue (SSE, 14-day retention) and
  alarms on queue depth above zero and on failed deliveries, and exposes
  `deadLetterQueue`. There is no prop to turn either off.
- Parameter `/application-plane/shared/metering/service` in the metering
  account, written by the demo stack: one JSON document with `version`,
  `apiUrl`, `region`, `ingestBusArn`, `usageBusArn`,
  `emitterRoleNamePattern`. Other accounts receive these values as
  inputs: cells through `METERING_API_URL`, subscriber accounts from the
  deployer. `ARCHITECTURE.md` §5.1 lists the sub-path.
- The hook script `scripts/control-plane/metering-hook.sh` and the
  emitter snippet `scripts/emit-usage.ts` (buffers, batches of 100,
  ULID `eventId`s, resends `RETRY` results with the same ids).

### 6.4 Samples consumed

- `control-plane`, for the lifecycle wiring of §3.4 only, through its
  hook contract (§6.5, R-41, R-42, R-45, R-46) and its parameter
  declarations (R-32, R-34). The construct does not name it: any
  registrar principal works. Its hooks are specified (ADR-044) and not
  yet released; until they are, the integration test calls the
  registration operations as a stand-in registrar.

## 7. Open questions

1. The `PutEvents` throttle near 1,400 events a second (§5.1): which
   quota it is, and whether it can be raised, needs an answer from the
   EventBridge team.
2. Application lifecycle events: does metering need `PutApplication` and
   `DeleteApplication` hooks (a new control-plane event), or do cell
   events cover it?

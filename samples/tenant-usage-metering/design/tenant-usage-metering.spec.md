<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Specification: Tenant usage metering for agentic applications

Status: accepted; implemented in src/ (integration test: test/integ.metering.ts).

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

**P-8. Every refusal of a registered emitter's event that could still
count is kept.** An event from a registered emitter that the ingest door
refuses for a cause that can be fixed (`TENANT_NOT_IN_CELL`,
`REGISTRATION_CLOSED`, `UNKNOWN_METER`, `METER_NOT_ALLOWED`) is written to
the error store with the reason, and can be re-admitted while its hour is
inside the recount window. Refusals that can never count (`BAD_SHAPE`,
`BAD_TIME`, `TOO_LATE`) are kept up to a per-emitter cap. Calls from unregistered callers are counted,
not stored.

## 3. System shape

### 3.1 Components

All in the metering account, one stack.

| Component | Job |
|---|---|
| Ingest door | REST API, IAM auth (SigV4), resource policy of §3.2. `PutUsageEvents`, batches of up to 100 |
| Ingest function | Verifies the caller is a registered emitter, checks each event against the cell's bindings and the meter catalog, validates the shape, publishes accepted events to the ingest bus (or Firehose, with `ingestPath: DIRECT`) and writes refused ones to the error store (ADR-0001, ADR-0002) |
| Ingest bus | EventBridge Custom Event Bus, `ingestBusRetentionDays` retention; `DeduplicationId` = SHA-256 (hex) of `<applicationId>#<tenantId>#<eventId>` (the bus caps the id at 128 characters and the key can reach 134), `EventGroupId = tenantId`; a Firehose subscriber with a retry policy of 24 h maximum event age and 185 attempts (the default of 5 would end retries early) and an SQS dead-letter queue (ADR-0002) |
| Raw stream | Amazon Data Firehose to S3, 60 s buffer, dynamic partitioning by event hour into `raw/hour=YYYY-MM-DDTHH/` (§4.8) |
| Ingest redrive | A function an operator starts with `StartIngestRedrive`: moves messages from the ingest dead-letter queue into Firehose, each as the envelope the bus would have delivered, unchanged. An alarm fires on any object under Firehose's `firehose-error/` prefix, which the recount does not read |
| Table | One DynamoDB table, PITR on: registry, meters, sinks, hours, recounts, usage records (§4) |
| Admin API | Same REST API: meters, sinks, registrations, usage reads, recounts, re-admission, redrives |
| Object tracker | S3 event notification on `raw/` and `readmitted/`: for every new object, creates the hour item if absent and increments its `generation` (§4.5); failed invocations go to an SQS on-failure destination the scheduler replays |
| Recounter | Step Functions, one execution per hour, under a role that only invokes its task function; the task function, under the recounter role, reads the hour's raw objects, dedupes, sums per meter rule, writes usage records (§4.9) |
| Scheduler | EventBridge Scheduler, in the stack's own schedule group, every 5 minutes: queries the sparse index of hours that are not `CLOSED` and starts a recount for each hour that is due, `DIRTY`, `COUNT_FAILED` past its backoff, or `COUNTING` with an expired lease; replays the object tracker's failures. A second 5-minute schedule runs the record publisher's sweep of `publishPending` records |
| Record publisher | DynamoDB Streams on usage-record writes that set `publishPending` (§4.7): publishes `UsageRecorded` to the usage bus, queues one delivery per sink, and clears the record's `publishPending` marker; the scheduler sweeps records whose marker is older than 15 minutes (§4.7), and an alarm fires on failed stream batches |
| Usage bus | EventBridge Custom Event Bus, `usageBusRetentionDays` retention; one `UsageRecorded` event per usage record revision (§4.8), `DeduplicationId = <recordId>#<revision>`, `EventGroupId = tenantId`. Always on |
| Sink dispatcher | Sends each queued delivery to its sink, retries for 24 h, then marks it `FAILED` and alarms |
| Sinks | `HTTP` (any billing API, field mapping by configuration), `S3_EXPORT` (JSON lines into the sample's separate export bucket, §3.5) |
| Error store | S3 `error/hour=YYYY-MM-DDTHH/`, one object per batch with refused events, each with its reason |
| `UsageSubscriber` | Published construct that attaches a reader to the ingest bus (`raw`) or the usage bus (`usage`) with a dead-letter queue, a retry policy and alarms built in (ADR-0006) |

### 3.2 Callers and identity

| Caller | Proves itself by | May call |
|---|---|---|
| Emitter | SigV4 as an assumed role named `<fleet>-ue-<cellId>`, registered for a cell | `PutUsageEvents` |
| Lifecycle hook | SigV4 as a role in `registrarPrincipalArns` (the control plane's `<fleet>-global-hook`) | `PutCellEmitter`, `DeleteCellEmitter`, `PutTenantBinding`, `DeleteTenantBinding` |
| Metering operator | SigV4 as a role in `operatorPrincipalArns` | meters, sinks, usage reads, recounts, re-admission, redrives, resends of `BLOCKED` deliveries, reads of registrations |
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
draw on the ingest route's throttle and the function's concurrency. The
function has reserved concurrency, so it cannot starve the other functions
of the stack, and an alarm fires on the unregistered-caller metric. The
admin routes sit on the same REST API but behind their own method-level
throttle, and `POST /usage-events` has a method-level throttle below the
stage limit, so an ingest flood cannot take the admin routes' headroom and
fail the control plane's `PRE` hooks. A flood can still delay real
emitters until the vendor blocks the source, which the threat model lists
as a residual.

**Per-emitter limits.** A registered emitter is admitted at most
`maxEventsPerEmitterPerMinute` events a minute, counted in a DynamoDB item
per emitter and minute over every event of each batch, before the checks,
refused ones included; events over it return `RETRY`. At most
`maxRefusedPerEmitterPerHour` refusals that can never count (`BAD_SHAPE`,
`BAD_TIME`, `TOO_LATE`) are stored per emitter and hour; the rest are
counted in a metric with an alarm, not stored. Refusals that could still
count are always stored (P-8), bounded by the admission limit. With the
defaults, sustained ingest of about 1,000 events a second (§5.1) is
shared by at least 20 emitters at their limit; more emitters at their
limit can still fill the account, and the others get `RETRY`.
The hour is a fleet-wide unit, so one emitter that fills an hour slows
every tenant's count of it; a distributed map in the recount is a seam
(ADR-0003).

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
| `registrarPrincipalArns` | roles that may register cells and tenants; synth fails if one also appears in `operatorPrincipalArns` or `readerPrincipalArns` | required |
| `operatorPrincipalArns` | roles that may manage meters, sinks, recounts, re-admission, redrives and resends of `BLOCKED` deliveries | required |
| `readerPrincipalArns` | roles that may read usage | `[]` |
| `lateGraceMinutes` | how long after an hour ends it is first counted; synth fails below the Firehose buffer (1 minute) plus 5 minutes | `15` |
| `recountWindowHours` | how long after an hour ends it may still be recounted; synth fails below 72. Ingest admits an event only while its hour ended less than `recountWindowHours` − 49 hours ago, so an accepted event has 48 hours (the subscriber's 24 h maximum event age plus 24 h to redrive its dead-letter queue) to reach S3, and one more hour for the Firehose buffer and the scheduler, before the hour closes | `96` |
| `closeGraceMinutes` | how long a closing emitter or binding is still admitted, for buffered events | `60` |
| `rawRetentionDays` | raw and re-admitted object lifetime | `400` |
| `errorRetentionDays` | error object lifetime; synth fails below ceil(`recountWindowHours` / 24) + 7 | `30` |
| `maxEventsPerEmitterPerMinute` | per-emitter admission limit (§3.2) | `3000` |
| `maxRefusedPerEmitterPerHour` | refusals that can never count stored per emitter and hour (§3.2) | `10000` |
| `ingestPath` | `BUS` (ingest bus, ADR-0002) or `DIRECT` (Firehose, events packed per hour) | `BUS` |
| `ingestBusRetentionDays` | ingest bus retention | `1` |
| `usageBusRetentionDays` | usage bus retention | `7` |
| `rawSubscriberAccountIds` | vendor accounts the ingest bus is shared with | `[]` |
| `usageSubscriberAccountIds` | vendor accounts the usage bus is shared with | `[]` |
| `deploymentRoleArn` | the role CloudFormation runs as, exempt from the bucket configuration denies (§3.5) | the bootstrap `cfn-exec` role |
| `alarmTopicArn` | optional SNS topic for every alarm of the stack | none |
| `testOnlyAllowCellsInMeteringAccount` | test only: lets `PutCellEmitter` register a cell in the metering account, so a one-account integration test can run an emitter; never set in a deployment | `false` |

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
Every registration call also carries `EXECUTION_ID` and `OPERATOR_ID`
from the hook environment, in the body of a `Put*` and in
`X-Control-Plane-Execution-Id` and `X-Control-Plane-Operator-Id` headers
of a `Delete*`, stored on the item as `controlPlaneExecutionId` and
`controlPlaneOperatorId` (create) and `closedByExecutionId` and
`closedByOperatorId` (delete), so a registration
can be traced to the control-plane operation that made it.

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
  gets three attempts in all and is then skipped (control-plane R-46);
  the control plane logs and alarms on the skip (its §8.3). The
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

### 3.5 Protection of the stores and the pipeline

| Control | Rule |
|---|---|
| Raw bucket (`raw/`, `readmitted/`, `error/`, `firehose-error/`) | The bucket policy is written as explicit denies with `aws:PrincipalArn` conditions, so an identity-policy allow in the metering account does not get around it: `s3:PutObject` is denied under `raw/` and `firehose-error/` to all but the Firehose role, under `readmitted/` to all but the re-admission function, and under `error/` to all but the ingest, re-admission and redrive functions; `s3:DeleteObject` and `s3:DeleteObjectVersion` are denied to all but the stack's auto-delete-objects provider role, which acts only when the stack is deleted; `s3:PutLifecycleConfiguration`, `s3:PutBucketVersioning`, `s3:PutBucketPolicy`, `s3:DeleteBucketPolicy` and `s3:PutBucketNotification` are denied to all but the deployment role and the auto-delete-objects and bucket-notifications provider roles. Versioning is on, so an overwrite keeps the earlier version for audit. Lifecycle expires current versions after `rawRetentionDays` (`raw/`, `readmitted/`, `firehose-error/`) or `errorRetentionDays` (`error/`), expires noncurrent versions 7 days later, and removes expired delete markers. Object Lock is a production option |
| Export bucket | A separate bucket. Its policy denies `s3:PutObject` to all but the dispatcher, and deletes and configuration changes as on the raw bucket; lifecycle expires objects after `rawRetentionDays`. An `S3_EXPORT` sink names only a key prefix inside it |
| Ingest bus | The bus resource policy denies `events:PutEvents` to all but the ingest function role. The deny grants nothing, so each bus writer also has an identity allow (verified in pg 2026-11-18) |
| Usage bus | The bus resource policy denies `events:PutEvents` to all but the record publisher role, which also runs the scheduler's `publishPending` sweep, so no other principal can publish a `UsageRecorded` that readers would bill from |
| Table | A DynamoDB resource-based policy denies `dynamodb:PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `PartiQLInsert`, `PartiQLUpdate`, `PartiQLDelete` and `ConditionCheckItem` on the table to all but the stack's function and state machine roles, so no other principal can write a registration, meter, sink or record |
| Ingest dead-letter queue | The queue policy denies `sqs:SendMessage` to all but `events.amazonaws.com` with `aws:SourceArn` = the ingest subscriber |
| Firehose stream | Firehose has no resource policy, so any principal in the metering account granted `firehose:PutRecord*` on the stream can write raw usage. The stack grants it only to the ingest and redrive functions and the subscriber role; an SCP or permissions boundary that denies it to everyone else is the production control |
| Service-principal trust | Every service-principal trust policy and resource policy (the Lambda permission for S3 notifications, SQS queue policies, Scheduler, Firehose and bus subscriber role trust) is conditioned on `aws:SourceArn` and `aws:SourceAccount`; Scheduler's `aws:SourceArn` is its schedule group, so the stack has a group of its own. A DynamoDB Streams trigger is polled with the function's own role and needs none |
| Audit | API Gateway access logs on every route with `$context.identity.userArn`, `$context.requestId` and the route, kept for `rawRetentionDays`; every item written through the API carries `createdBy` (the caller ARN) and `createdAt` (§4) |
| Logs | No event payload, sink request or response body, or credential is logged; recounter execution state holds keys and counts only |
| Heartbeat | An alarm that does not depend on the scheduler fires when the scheduler's target has not run for 15 minutes, or no hour has reached `COUNTED` for 2 hours while the `pending` index holds hours past their grace |

"The deployment role" is `deploymentRoleArn` (§3.3): by default the CDK
bootstrap `cfn-exec` role built from the synth-time bootstrap qualifier; any
deployment that does not run as that role (one that passes `--role-arn`,
or a synthesizer with no execution role) must set the input to the role
CloudFormation runs as; the
integration test runs a stack update that changes `rawRetentionDays` to
prove the exemption. The changes to the queue, bus and table policies
(`sqs:SetQueueAttributes`, `events:PutPermission`, `events:RemovePermission`,
`dynamodb:PutResourcePolicy`, `dynamodb:DeleteResourcePolicy`) are not
denied. Any principal allowed them, allowed to run the deployment or provider
roles, allowed `lambda:InvokeFunction` on the auto-delete-objects or
bucket-notifications provider functions (a crafted event wipes the raw
store or removes its notifications), or allowed to delete the stack, can undo these controls and is
trusted, as is an administrator of the metering account.

## 4. Data model

One DynamoDB table, `PK`/`SK`, PITR on, TTL on `expiresAt`. Every item
written through the API (meter versions, sinks, registrations, jobs) also
carries `createdBy`, the caller ARN, and `createdAt`; registrations also
carry `controlPlaneExecutionId` and `controlPlaneOperatorId` (§3.4).
A third sparse index, `list-by-type` (partition `listType`, sort
`listSort`), lists meters (their `CURRENT` item), sinks, emitters and
jobs for the `List*` operations.

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

`PutCellEmitter` for a known cell with another account or application is a
409 (`PLACEMENT_MISMATCH`): a cell never moves. Every registration also
holds `controlPlaneExecutionId` and `controlPlaneOperatorId` (the call that
made or last re-activated it) and, once `CLOSING`, `closedByExecutionId`
and `closedByOperatorId` (the delete). Re-activation moves the `closedBy*`
pair into the interval it closes and overwrites `controlPlane*`.

Transitions: none → `ACTIVE` (`PutCellEmitter`) → `CLOSING`
(`DeleteCellEmitter`) → removed by TTL. An emitter admits events whose
`time` is at or after `activeFrom`, and, once `CLOSING`, at or before
`closedAt`, until `closesAt`, or whose `time` falls in one of its
`intervals`. Other events are refused `REGISTRATION_CLOSED`. Past `closesAt` the emitter is refused like an
unregistered one. `PutCellEmitter` on a `CLOSING` item (a cell or
deployment created again on the same key) moves the current
`{activeFrom, closedAt}` into `intervals`, removes `closedAt`, `closesAt`
and `expiresAt`, and sets a new `activeFrom`. Ingest and `READMIT` apply
the same check, so an event is judged by the registration as it stood
at the event's time.

### 4.3 Tenant binding

`PK=CELL#<cellId>`, `SK=TENANT#<tenantId>`, and a lookup item
`PK=TENANT#<tenantId>`, `SK=APP#<applicationId>#CELL#<cellId>`.

| Field | Meaning |
|---|---|
| `tenantId`, `applicationId`, `cellId` | from the hook |
| `billingAccount` | from `PARAM_BILLING_ACCOUNT`, optional |
| `status`, `activeFrom`, `closedAt`, `closesAt`, `intervals`, `expiresAt` | as for emitters, with `TENANT_NOT_IN_CELL` for a missing binding and `REGISTRATION_CLOSED` outside its intervals |

Tenant ids are the registrar's: the control plane's are ULIDs, and any
id in `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` is accepted; ids are
case-sensitive. `PutTenantBinding` for a cell with no `ACTIVE` emitter
(none, or one that is `CLOSING`), or of another application, is a 409 (`PLACEMENT_MISMATCH`); an absent
`billingAccount` keeps the stored one.

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
| `secretName` | `HTTP` only: Secrets Manager name of the credential, under `<fleet>/metering/sinks/`; `CreateSink` and `UpdateSink` refuse any other name, and the dispatcher's role may read only that prefix |
| `mapping` | `HTTP` only: target field name → source (record field, meter field, or constant); without one, the body is the `UsageRecorded` detail |
| `meters` | meter ids this sink takes; empty is all |

### 4.5 Hour

`PK=HOUR#<YYYY-MM-DDTHH>`, `SK=META`, and a counter item
`PK=HOUR#<YYYY-MM-DDTHH>`, `SK=GEN` that holds only `generation`, so the
object tracker never writes the item the recount's fence checks.

| Field | Meaning |
|---|---|
| `status` | `OPEN`, `COUNTING`, `COUNTED`, `DIRTY`, `COUNT_FAILED`, `CLOSED` |
| `generation` | on the `GEN` item: incremented by the object tracker for every object of the hour |
| `countedGeneration`, `countedAt` | the generation and time of the last finished count |
| `lease`, `leaseExpiresAt` | the recount execution holding `COUNTING`, and when its hold lapses (30 minutes) |
| `attempts` | failed counts since the last success, a lease taken over after it lapsed included |
| `pending` | the constant `1`, present until the hour is `CLOSED`; a sparse index with partition key `pending` and sort key `PK` (the hour) is how the scheduler finds hours |

The object tracker creates the `META` item, `OPEN`, on the hour's first
object, and increments `generation` on the `GEN` item for every object
whatever the state. Every writer of these items retries a
`TransactionConflict` or throttling with jittered backoff before it
counts as a failure. A failed condition is a result, not retried: a
recount that lost its lease stops without writing, a moved `generation`
makes the hour `DIRTY`, and a lost take means another execution holds
the hour. Its
invocations are asynchronous, with an SQS on-failure destination that
keeps the S3 event; the scheduler replays that queue, and an alarm fires
when its depth stays above zero for 15 minutes.

Every 5 minutes the scheduler queries the `pending` index, which holds
every hour that is not `CLOSED`, past its close time or not, and starts
a recount for each one that is due. A recount takes the hour with a
conditional write (`OPEN` past `lateGraceMinutes`, `DIRTY`,
`COUNT_FAILED` past its backoff, or `COUNTING` past `leaseExpiresAt`) →
`COUNTING` with `lease` set to its execution id, reads `generation`, then
lists and counts. Taking over a lapsed lease increments `attempts`, as a
failure does, because the execution that held it timed out or died
without writing; an alarm also fires on the state machine's
`ExecutionsTimedOut` metric. Its writes are fenced on the lease: usage records go in
`TransactWriteItems` of up to 99 records plus a `ConditionCheck` that
the hour item's `lease` is its own execution id, each record also
conditioned on `attribute_not_exists(SK)`, and its final status write is
conditioned on the same lease, so an execution whose lease was taken
over writes nothing more. The execution's timeout
is 25 minutes, below the lease. It finishes with a transaction: a `ConditionCheck` that the `GEN`
item's `generation` is the value it read, and `COUNTED` on `META`; if
the check fails, `DIRTY`, so an object that
landed during the count is counted next. The scheduler reads the `GEN` item of each
hour it finds, and a `COUNTED` hour whose `generation` has moved past
`countedGeneration` is due, as `DIRTY` is; it writes `DIRTY` with a
condition on `COUNTED`. A failed count →
`COUNT_FAILED`, retried with backoff; an alarm fires on the third
failure.

At hour end plus `recountWindowHours`, the scheduler closes a `COUNTED`
hour in a transaction: a `ConditionCheck` that the `GEN` item's
`generation` equals `countedGeneration`, and `CLOSED` on `META`
(conditioned on `COUNTED`, removing `pending`); if the check fails, the
hour becomes `DIRTY`.

`READMIT`, `RECOUNT` and `INGEST_REDRIVE` check a close guard at each
write, not once per job: before each `readmitted/` object, each
`generation` increment and each Firehose put, an hour within 5 minutes of
its close, or `CLOSED`, is refused for that item. `READMIT` and
`INGEST_REDRIVE` write such an event to `error/` as `TOO_LATE`, delete
its dead-letter message where there is one, and count it in the job's
`refused`; `RECOUNT` counts the hour in `refused`.

An hour in any other state than `COUNTED` at hour end plus
`recountWindowHours` raises an alarm and stays in the index, retried like any other
until a count succeeds; it closes only from `COUNTED`. A
`CLOSED` hour is never counted again, and an object that lands in it
raises an alarm.

### 4.6 Recount and re-admission jobs

`PK=JOB#<jobId>`, `SK=META`.

| Field | Meaning |
|---|---|
| `kind` | `RECOUNT` (an hour range), `READMIT` (error objects of an hour range, optionally one reason), `INGEST_REDRIVE` (the ingest dead-letter queue), `SINK_REDRIVE` (`FAILED` deliveries of one sink, or every record of an hour range for one sink), `RESEND_BLOCKED` (one tenant and application's `BLOCKED` deliveries) |
| `status` | `RUNNING`, `SUCCEEDED`, `FAILED` |
| `counts` | items processed, admitted, refused, redriven |
| inputs | `from`, `to` (inclusive, at most 744 hours apart), `reason`, `sinkId`, `tenantId`, `applicationId`, as the kind needs |
| `statusReason`, `updatedAt` | why a job `FAILED`, and its last change |

A job runs in one invocation of its worker and stops 13 minutes in; a job
that ran out of time is `FAILED` with that reason and is started again,
because every kind is safe to repeat. `SINK_REDRIVE` scans the usage
records (the table has no index by hour or by sink state), so it is an
operator job, run rarely.

`RECOUNT` increments `generation` of each hour in range, the same path a
new object takes, so a `COUNTED` hour becomes `DIRTY` and a `COUNTING`
one ends `DIRTY`; a `CLOSED` hour in range is refused. `READMIT` runs every event of the chosen error objects through
the ingest checks again, with the event's `receivedAt` as their clock,
judging each by the §4.2 check (the current registration or any of its
`intervals`) and the meter version at its time, and writes the ones
that pass, with their original `receivedAt`, to `readmitted/hour=.../`,
which the recount reads with `raw/`. The error objects of an hour range
are those received in it (their key is the receipt hour). It writes S3 directly, so it may
re-admit into any hour that is not `CLOSED` and not within 5 minutes of
its close; other events stay refused, `TOO_LATE` (the close guard,
§4.5).

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
| `publishPending` | the time the marker was set; present until the record, at its current `revision`, is on the usage bus and queued for its sinks. It is set and removed together with `publishShard` (`0` to `3`, from `recordId`); a sparse index with partition key `publishShard` and sort key `publishPending` lists the records that hold it, and the sweep queries the four shards |
| `sinks` | per sink: `PENDING`, `RETRYING`, `SENT`, `BLOCKED` (reason), `FAILED` (reason) |

A record is written with a condition that its `seq` does not exist yet
and that the recount still holds the hour's lease (§4.5). `HOURLY` is
written for each `(tenant, application, meter)` with at least one event
in the hour; a first event that arrives late writes `HOURLY`. No record
is written when a recount changes nothing.

The table is the outbox. Each record is written with `publishPending`.
The record publisher (§3.1) handles a stream record when the marker
arrives: the new image holds `publishPending` and the old image does not,
or holds an earlier one. The dispatcher's own sink-state writes leave the
marker unchanged and so never trigger it. It publishes `UsageRecorded`
(`DeduplicationId = <recordId>#<revision>`), queues the deliveries
(revision 1: every sink of the record; revision 2: only the sinks that
are `BLOCKED`), and removes `publishPending` with a condition on the
`revision` it published, so a later revision's marker stays. The
scheduler also queries the index every 5 minutes for markers older than
15 minutes and publishes those records the same way, so a failed stream
batch is caught after the stream's 24-hour retention as well.

Sink delivery: a record goes to the sinks enabled when it is written that
take its meter. An `S3_EXPORT` delivery is one JSON line, the
`UsageRecorded` detail, at `<prefix>hour=<hour>/<recordId>-r<revision>.jsonl`.
An `HTTP` delivery is a POST with `Idempotency-Key: <recordId>` and the
secret as a header: a JSON secret `{"header": ..., "value": ...}`, or a
bare string sent as `Authorization: Bearer`. Redirects are not followed; a
3xx, or a 4xx other than 408 and 429, is `FAILED` at once. `PENDING` → `SENT`, or `RETRYING` with backoff for 24 h →
`FAILED` and an alarm; `SINK_REDRIVE` sends a sink's `FAILED` deliveries
again, or, given an hour range, every record of that range, which is how
a sink enabled later is backfilled.

An `HTTP` sink whose mapping needs `billingAccount` meets a record
without one. The dispatcher reads the tenant's binding for the
application, then makes one conditional write:

| Binding | Write | Condition |
|---|---|---|
| has an account | `billingAccount`, `revision` 2, `publishPending`, and this sink `BLOCKED`; the revision-2 publish queues every `BLOCKED` sink | `revision = 1` |
| has none | this sink `BLOCKED` (`NO_BILLING_ACCOUNT`) | `attribute_not_exists(billingAccount)` |

On a failed condition the dispatcher re-reads the record, which now
holds `billingAccount`, and sends with it. After a successful "has none"
write it reads the binding again, strongly consistent: if the binding
now has an account, it makes the "has an account" write; if it still has
none, any later `PutTenantBinding` starts a job that sees this sink
`BLOCKED`. So a sink is `BLOCKED` on a
revision-2 record only for the moment between that write and its
publish.

A `PutTenantBinding` that sets a billing account starts a
`RESEND_BLOCKED` job for that tenant and application and returns;
`StartResendBlocked` lets an operator start the same job. The job reads
the tenant and application's records with a strongly consistent query on
the base table. For each record with a `BLOCKED` sink, the job writes the value as revision 2 with
`publishPending` (condition `revision = 1`), or, on a record already at
revision 2, queues its `BLOCKED` sinks directly. An alarm fires when a
delivery becomes `BLOCKED`; an alarm on 24 hours `BLOCKED` would need an
index of blocked deliveries, a seam.

### 4.8 Usage event and raw objects (the wire contract)

The event, one free JSON member of the `PutUsageEvents` batch in the model;
the function, not the model, enforces the "Required" column and every rule
below, and refuses a bad event alone as `BAD_SHAPE` (P-8). A member not in
the table, a member of another JSON type, or a `null` entry is also
`BAD_SHAPE`:

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
| Jobs | `StartRecount`, `StartReadmission`, `StartIngestRedrive`, `StartSinkRedrive`, `StartResendBlocked`, `GetJob`, `ListJobs` |

`PutUsageEvents` returns 200 with one result per event, in request order (match on position; `eventId` is echoed when it was a string):

| Result | Meaning | Emitter action |
|---|---|---|
| `ACCEPTED` | stored, or already stored under the same key | none |
| `RETRY` | the ingest bus or Firehose throttled it after the function's retries, or the emitter is over `maxEventsPerEmitterPerMinute` | send again with the same `eventId` |
| `REFUSED` + reason | `TENANT_NOT_IN_CELL`, `REGISTRATION_CLOSED`, `UNKNOWN_METER`, `METER_NOT_ALLOWED`: always written to the error store, and an operator may re-admit them. `BAD_SHAPE`, `BAD_TIME`, `TOO_LATE`: written up to the per-emitter cap, never re-admitted | fix the cause |

Errors:

| Code | When |
|---|---|
| 400 `ValidationException` | malformed request, a field outside its charset (on routes other than `PutUsageEvents`, whose events are checked one by one), a `BILLING_ACCOUNT` out of format, a backdated `effectiveFrom` beyond the window |
| 403 `AccessDeniedException` | caller not permitted for the route; for `PutUsageEvents`, not an assumed role or not a registered emitter |
| 404 `ResourceNotFoundException` | unknown meter, sink, hour, job (never for `Delete*` of a registration) |
| 409 `ConflictException` | with a `reason`: `ACCOUNT_NOT_ALLOWED` (`PutCellEmitter` in a subscriber account or the metering account), `ALREADY_EXISTS` (`CreateMeter` or `CreateSink` on an existing id), `PLACEMENT_MISMATCH` (§4.2, §4.3), `RANGE_CLOSED` (`StartRecount` whose whole range is `CLOSED` or within 5 minutes of its close), `CONCURRENT_WRITE` (a lost conditional write; the only one worth retrying) |
| 413 `PayloadTooLargeException` | a `PutUsageEvents` body over 1,048,576 UTF-8 bytes; not resent |
| 429 `ThrottlingException` | API Gateway stage or method throttle |
| 500, 502, 503, 504 | the function failed, was throttled or timed out; nothing in the batch is known to be stored |

### 5.1 Limits

| Limit | Value |
|---|---|
| Events per `PutUsageEvents` | 100 |
| Request body of `PutUsageEvents` | 1,048,576 bytes of UTF-8, measured in bytes by the function before it parses the body; a larger body is a 413 and is not resent (a body over 6 MB fails before the function, as a 5xx) |
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
- Emitters that put no personal data in `dimensions`: they travel to the
  raw and error stores, both buses' subscriber accounts and every sink.
- Emitters that send `UsageEvent`s with stable ULID or UUID `eventId`s,
  resend an event unchanged, and resend `RETRY` results. A 429, a 5xx or
  a timeout resends the whole batch unchanged, with backoff; a 403, a
  400 or a 413 is not resent. A batch never exceeds 1,048,576 bytes of UTF-8;
  an emitter measures the encoded body and splits a larger one before it
  sends.
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
  ULID `eventId`s, stores each event once; resends `RETRY` results, and
  the whole batch after a 429, a 5xx or a timeout, with the same bytes
  and backoff).

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

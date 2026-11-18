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
- an hourly **aggregation** driven by a run-time **meter catalog**, whose
  totals are a pure function of the raw store, so a replay of any hour
  gives the same records;
- **sinks** set by configuration, which hand each hourly usage record to
  a billing system, an export file, or an event bus;
- **lifecycle wiring**: the control plane's vendor hooks
  (control-plane ADR-044) register cells and tenants with the metering
  service, so onboarding and offboarding drive metering with no manual
  step.

Deployment model: any. The sample assumes cells (pool, silo or bridge
inside a cell) placed by a control plane, and works without one: the
registration operations can be called by any principal the deployer
names.

### 1.1 What this sample does not do yet

- Rating, pricing, invoices, credits, tiers: the billing system's job.
- Live quota enforcement on usage (a tenant over its limit is refused):
  the sample publishes the counted records a limiter would read, and no
  more.
- Hooks on application and tenant record events (`PutApplication`,
  `DeleteApplication`, `CreateTenant`, `DeleteTenant`): the control plane
  runs hooks on cell and deployment events only (control-plane §11). The
  sample registers what those events give it (§3.4).
- Usage that the cell cannot see: AWS cost per tenant from CUR 2.0 is
  cost attribution, a separate concern (`ARCHITECTURE.md` §3.3, point 4).
- Multiple Regions: one metering service per Region.

### 1.2 What this sample is NOT

- **Not telemetry.** Metrics, traces and logs describe how the system
  behaves; metering produces the records a bill is built from. They have
  different rules for loss, duplicates and lateness, so the sample does
  not carry billing events on the telemetry path.
- **Not proof of honest emitters.** The sample proves *who* sent a usage
  event and *which tenants* it may speak for. It cannot prove the quantity
  is true. Code that runs in a tenant-owned account is controlled by the
  tenant, and that tenant can under-report its own usage (T-3).
- **Not a billing system.** The sink contract is the boundary.

## 2. Guiding principles

**P-1. Billing events have their own path.** A usage event never shares a
pipe with metrics or logs. The path is built for no loss and exactly-once
counting, which telemetry pipes do not promise.

**P-2. Identity comes from the signature, never from the body.** The
emitter, its cell and its account are taken from the verified caller of
the ingest door. A body field that names an emitter, a cell or an account
is ignored; a body `tenantId` is admitted only when the caller's cell
holds that tenant.

**P-3. The control plane is the source of truth for placement; metering
copies it.** Which cell holds which tenant is written into the metering
service by the control plane's vendor hooks, under a role no cell can
assume. Metering never reads placement from an emitter.

**P-4. Totals are a function of the raw store.** Every count is
recomputed from the raw events of its hour. A replay, a re-run after a
failure, or an audit gives the same record. Nothing is counted in flight.

**P-5. Duplicates are removed by identity, not by luck.** Every usage
event carries an `eventId` the emitter chooses once and reuses on every
retry. The aggregation counts one event per `(tenantId, eventId)`, so an
emitter's retry, a Firehose retry and a replay never double a total.

**P-6. A meter is data, a sum rule is code.** Adding or changing a meter,
or changing how a sink maps a record, is a write through the admin API and
needs no deploy. A new way of summing is a code change. A meter change
takes effect from the next whole hour, so an hour is always counted under
one rule.

**P-7. Late is modelled, not dropped.** An event that arrives after its
hour was counted is kept, and the hour is recounted. The difference goes
out as an `ADJUSTMENT` record; a sink never receives a silently changed
total.

**P-8. Every refusal is kept.** An event the ingest door refuses, or that
names an unknown meter, is written to the error store with the reason.
It can be replayed once the cause is fixed.

## 3. System shape

### 3.1 Components

| Component | Job |
|---|---|
| Ingest door | REST API, IAM auth (SigV4). `PutUsageEvents`, batches of up to 500 |
| Ingest function | Verifies the caller is a registered emitter, checks each event's tenant against the caller's cell, validates the shape, writes accepted events to the raw stream and refused ones to the error store (ADR-0002) |
| Raw stream | Amazon Data Firehose to S3, partitioned by event hour (`raw/hour=YYYY-MM-DDTHH/`) |
| Registry | DynamoDB: emitters (one per cell), tenant bindings, meters, sinks |
| Admin API | Same REST API, IAM auth: meters, sinks, registrations, usage reads, replay |
| Aggregator | Step Functions per hour: reads the hour's raw objects, dedupes, sums per meter rule, writes usage records |
| Usage records | DynamoDB, one item per `(tenant, meter, hour, version)` |
| Sink dispatcher | Sends each new usage record to every enabled sink, at least once, idempotent per record |
| Sinks | `HTTP` (any billing API, field mapping by configuration), `S3_EXPORT` (JSON lines), `EVENT_BUS` (EventBridge `UsageRecorded`) |
| Error store | S3 `error/` prefix, one object per refused batch, with reasons |

### 3.2 Callers and identity

| Caller | Proves itself by | May call |
|---|---|---|
| Emitter | SigV4 as a role registered for a cell | `PutUsageEvents` |
| Lifecycle hook | SigV4 as a role in `registrarPrincipalArns` (the control plane's `<fleet>-global-hook`) | `PutCellEmitter`, `DeleteCellEmitter`, `PutTenantBinding`, `DeleteTenantBinding` |
| Metering operator | SigV4 as a role in `operatorPrincipalArns` | meters, sinks, `GetUsage`, `ListUsage`, `StartReplay`, reads of registrations |
| Usage reader | SigV4 as a role in `readerPrincipalArns` | `GetUsage`, `ListUsage` |

An emitter role is registered by account and name. The ingest function
takes the caller's role ARN from the API Gateway identity
(`requestContext.identity.userArn`, an assumed-role ARN), reduces it to
`arn:aws:iam::<account>:role/<name>`, and looks it up. The account in the
ARN must equal the cell account the registration recorded (P-2).

### 3.3 Deployment inputs

| Input | Meaning | Default |
|---|---|---|
| `registrarPrincipalArns` | roles that may register cells and tenants | required |
| `operatorPrincipalArns` | roles that may manage meters and sinks | required |
| `readerPrincipalArns` | roles that may read usage | `[]` |
| `emitterOrganizationId` | optional `aws:PrincipalOrgID` the API resource policy requires of emitters | none |
| `lateGraceMinutes` | how long after an hour ends it is first counted | `15` |
| `recountWindowHours` | how long an hour may still be recounted for late events | `72` |
| `rawRetentionDays` | raw and error object lifetime | `400` |

### 3.4 Lifecycle wiring with the control plane

The control plane runs a global vendor hook on each event below
(control-plane §6.5, R-42). The hook script calls the metering admin API
under `<fleet>-global-hook`, so only the control plane can register what
a cell may report. The sample ships the hook script
(`scripts/control-plane/metering-hook.sh`) and the policy the deployer
attaches through the control plane's `globalHookManagedPolicyArns`.

| Event | Phase | Metering call | Takes from the hook environment |
|---|---|---|---|
| `CELL_CREATE` | `POST` | `PutCellEmitter` | `CELL_ID`, `CELL_ACCOUNT_ID`, `APPLICATION_ID` |
| `CELL_DELETE` | `POST` | `DeleteCellEmitter` (closing, §4.2) | `CELL_ID` |
| `DEPLOYMENT_CREATE` | `POST` | `PutTenantBinding` | `TENANT_ID`, `CELL_ID`, `APPLICATION_ID`, `PARAM_BILLING_ACCOUNT` |
| `DEPLOYMENT_UPDATE` | `POST` | `PutTenantBinding` (billing account may change) | as create |
| `DEPLOYMENT_DELETE` | `POST` | `DeleteTenantBinding` (closing, §4.3) | `TENANT_ID`, `APPLICATION_ID` |

The emitter role name is fixed by convention,
`<fleet>-usage-emitter-<cellId>`, so the hook never takes it from
`SCRIPT_OUTPUTS` (control-plane R-42: identity comes from the variables).
The cell create script creates that role; the hook only names it.

`BILLING_ACCOUNT` is a deployment parameter the application declares
(control-plane R-32). It is the tenant's account id in the billing system,
and sinks map it into their records. A tenant without one is metered and
exported, and the `HTTP` sink refuses its records to the error store
until it has one.

## 4. Data model

One table, `PK`/`SK`, PITR on.

### 4.1 Meter

`PK=METER#<meterId>`, `SK=V#<version>` (zero-padded), plus
`SK=CURRENT` pointing at the latest.

| Field | Meaning |
|---|---|
| `meterId` | `[a-z0-9_.-]{1,64}` |
| `unit` | free text, for sinks (`tokens`, `requests`, `seconds`) |
| `rule` | `COUNT`, `SUM`, `MAX`, `UNIQUE_COUNT` (of `value` as a string) |
| `allowedApplications` | application ids whose emitters may send this meter; empty is all |
| `effectiveFrom` | the first whole hour this version counts |
| `status` | `ACTIVE`, `RETIRED` |

An update writes a new version with `effectiveFrom` = the next whole
hour (P-6). An hour is counted with the version whose `effectiveFrom` is
the latest one at or before it.

### 4.2 Cell emitter

`PK=EMITTER#<accountId>#<roleName>`, `SK=META`, and a lookup item
`PK=CELL#<cellId>`, `SK=META`.

| Field | Meaning |
|---|---|
| `cellId`, `applicationId`, `accountId`, `roleName` | from the hook |
| `status` | `ACTIVE`, `CLOSING` |
| `closesAt` | set by `DeleteCellEmitter` to the end of the current hour plus `lateGraceMinutes` |

A `CLOSING` emitter is admitted until `closesAt` for events whose hour
is before the deletion, then the item is removed.

### 4.3 Tenant binding

`PK=CELL#<cellId>`, `SK=TENANT#<tenantId>`, and
`PK=TENANT#<tenantId>`, `SK=APP#<applicationId>`.

| Field | Meaning |
|---|---|
| `tenantId`, `applicationId`, `cellId` | from the hook |
| `billingAccount` | from `PARAM_BILLING_ACCOUNT`, optional |
| `status`, `closesAt` | as for emitters |

### 4.4 Sink

`PK=SINK#<sinkId>`, `SK=META`.

| Field | Meaning |
|---|---|
| `type` | `HTTP`, `S3_EXPORT`, `EVENT_BUS` |
| `enabled` | boolean |
| `endpoint` | `HTTP`: HTTPS URL. `S3_EXPORT`: prefix. `EVENT_BUS`: bus ARN |
| `secretName` | `HTTP` only: Secrets Manager name of the credential, read inside the dispatcher |
| `mapping` | `HTTP` only: target field name → source (record field, binding field, meter field, or constant) |
| `meters` | meter ids this sink takes; empty is all |

### 4.5 Usage record

`PK=USAGE#<tenantId>#<applicationId>`, `SK=<hour>#<meterId>#<seq>`.

| Field | Meaning |
|---|---|
| `kind` | `HOURLY` for the first count, `ADJUSTMENT` for a recount difference |
| `quantity` | the hour's total, or the difference for an adjustment |
| `meterVersion`, `eventCount` | for audit |
| `recordId` | `sha256(tenantId, applicationId, meterId, hour, seq)`; sinks use it as their idempotency key |
| `sinks` | per sink: `PENDING`, `SENT`, `FAILED` with reason |

### 4.6 Usage event (the wire contract)

Smithy structure `UsageEvent`:

| Field | Required | Meaning |
|---|---|---|
| `eventId` | yes | `[A-Za-z0-9_-]{1,64}`, unique per tenant, reused on retry (P-5) |
| `tenantId` | yes | must be bound to the caller's cell |
| `meterId` | yes | must be an `ACTIVE` meter |
| `value` | yes | decimal string; `COUNT` ignores it |
| `time` | yes | ISO 8601 UTC; at most 5 minutes in the future and `recountWindowHours` in the past |
| `dimensions` | no | up to 10 string pairs, passed to sinks, not summed on |

The ingest function adds `emitterAccountId`, `emitterRole`, `cellId`,
`applicationId` and `receivedAt` before writing. None of these come from
the body (P-2).

## 5. API surface

Smithy, `aws.protocols#restJson1`, every operation IAM-authorised.

| Resource | Operations |
|---|---|
| Usage events | `PutUsageEvents` (`POST /usage-events`) |
| Meter | `CreateMeter`, `GetMeter`, `UpdateMeter`, `DeleteMeter` (retires), `ListMeters` |
| Sink | `CreateSink`, `GetSink`, `UpdateSink`, `DeleteSink`, `ListSinks` |
| Cell emitter | `PutCellEmitter`, `GetCellEmitter`, `DeleteCellEmitter`, `ListCellEmitters` |
| Tenant binding | `PutTenantBinding`, `GetTenantBinding`, `DeleteTenantBinding`, `ListTenantBindings` |
| Usage | `GetUsage` (one tenant, one meter, an hour range), `ListUsage` (one tenant, all meters) |
| Replay | `StartReplay` (an hour range), `GetReplay`, `ListReplays` |

`PutUsageEvents` returns 200 with per-event results: `ACCEPTED`, or
`REFUSED` with a reason (`UNKNOWN_EMITTER`, `TENANT_NOT_IN_CELL`,
`UNKNOWN_METER`, `METER_NOT_ALLOWED`, `BAD_TIME`, `BAD_SHAPE`). A whole
batch from an unregistered caller is a 403 and is still written to the
error store (P-8). A retry of an accepted event is accepted again and
counted once (P-5).

Hour states: `OPEN` → `COUNTED` (after `lateGraceMinutes`) →
`RECOUNTED` (each late arrival inside `recountWindowHours`) → `CLOSED`.

## 6. Contracts

### 6.1 What the deployer supplies

- The principals of §3.3.
- Emitters that sign with their cell's emitter role and send
  `UsageEvent`s with stable `eventId`s.
- For the control plane wiring: the metering hook registered as a global
  hook on the five events of §3.4, the hook policy attached to
  `<fleet>-global-hook`, and the emitter role created by the cell create
  script.
- For an `HTTP` sink: the endpoint and a secret in Secrets Manager.

### 6.2 What the sample promises

1. An event from a role that is not a registered emitter is refused.
2. An event for a tenant not bound to the caller's cell is refused, also
   when the tenant exists in another cell.
3. Each `(tenantId, eventId)` is counted once, through retries and
   replays.
4. A replay of an hour gives the records already sent; a late event gives
   an `ADJUSTMENT`, never a changed `HOURLY` record.
5. A new meter, a changed meter rule, and a changed sink mapping take
   effect without a deploy, from the next whole hour (meters) or the next
   dispatch (sinks).
6. Every sink receives each record at least once, with a stable
   `recordId` to dedupe on.

### 6.3 Published interface

- Construct `TenantUsageMetering` (`src/index.ts`): the props of §3.3;
  exposes `apiUrl`, `ingestPolicy` (a managed policy an emitter role
  needs), `registrarPolicy`, `usageBusArn`.
- Parameter `/application-plane/shared/metering/service`, one JSON
  document: `version`, `apiUrl`, `region`, `usageBusArn`,
  `emitterRoleNamePattern`.
- The hook script `scripts/control-plane/metering-hook.sh` and the
  emitter snippet `scripts/emit-usage.ts`.

### 6.4 Samples consumed

- `control-plane`, for the lifecycle wiring of §3.4 only, through its
  hook contract (§6.5, R-42) and its published `/control-plane/*`
  parameters. The construct does not name it: any registrar principal
  works. Its hooks are specified (ADR-044) and not yet released; until
  they are, the integration test calls the registration operations as a
  stand-in registrar.

## 7. Open questions

1. Ingest after the check: straight to Firehose, or through an
   EventBridge bus first (ADR-0002, Proposed).
2. Application lifecycle events: does metering need `PutApplication` and
   `DeleteApplication` hooks (a new control-plane event), or do cell
   events cover it?
3. Within one pooled cell, one tenant's code can report usage for the
   cell's other tenants. Accept it (the cell is vendor code), or bind
   emitters per tenant (a role per deployment)?

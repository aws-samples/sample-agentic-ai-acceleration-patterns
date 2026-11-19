<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Tenant usage metering for agentic applications

A multi-tenant agentic application bills, tiers and limits its tenants on
what they use: agent sessions, model tokens, tool calls, requests. This
sample is one metering service the vendor owns. Every emitter sends one
versioned usage event. The ingest door admits an event only from an
emitter the control plane registered, and only for a tenant the control
plane placed in that emitter's cell. Every admitted event lands in a
replayable raw store. Each hour is counted from that store under a
run-time meter catalog, so a recount gives the same records, and a late
event gives an `ADJUSTMENT`, never a changed record. Records go to
configured sinks (an HTTP billing API or an export bucket) and to a usage
bus that billing and limit systems subscribe to.

The control plane's vendor hooks ([`control-plane`](../control-plane/),
ADR-044) register cells and tenants, so onboarding and offboarding drive
metering with no manual step.

What it is NOT: telemetry (billing events never share the metrics or logs
path), proof that an emitter reports honest quantities, tenant isolation
inside a pooled cell, or a billing system. See spec §1.2.

## Architecture

![Components](diagrams/tenant-usage-metering.components.drawio.svg)

An emitter signs its events as its cell's role; the ingest door checks
them against the registry the control plane writes; the raw store keeps
them; the recounter counts each hour into usage records; the outbox
publishes each record to the usage bus and queues it for each sink.

![Architecture](diagrams/tenant-usage-metering.drawio.svg)

API Gateway (IAM) → ingest Lambda → EventBridge Custom Event Bus →
Firehose → S3 `raw/`; EventBridge Scheduler → Step Functions recounter →
DynamoDB records → stream → publisher → usage bus and SQS → dispatcher →
HTTPS (secret or SigV4) or the export bucket.

- **REST API**: every method `AWS_IAM`, a resource policy with an explicit
  deny per caller set.
- **Ingest function**: identity from the signature only, each event
  checked alone.
- **Ingest bus and Firehose**: dedupe, 24 hours of retries, a dead-letter
  queue, objects partitioned by event hour.
- **Recounter**: one Step Functions execution per hour, fenced on a lease.
- **Outbox publisher and dispatcher**: every record on the usage bus and
  at each sink at least once.
- **`UsageSubscriber`**: the published construct a reader attaches to a
  bus with, dead-letter queue included. Each bus is shared through AWS RAM
  with the vendor accounts that read it.

## How it works

1. **Register.** On `CELL_CREATE` (`PRE`) the hook calls `PutCellEmitter`;
   on `DEPLOYMENT_CREATE` and `DEPLOYMENT_UPDATE` (`PRE`),
   `PutTenantBinding`; deletes run in `POST` and close the registration
   with a grace period (spec §3.4).
2. **Define meters.** An operator creates meters (`COUNT`, `SUM`, `MAX`,
   `UNIQUE_COUNT`) and sinks. A change writes a new version that counts
   from the next whole hour (ADR-0004).
3. **Emit.** A cell's workload sends batches of up to 100 events as
   `<fleet>-ue-<cellId>`. Each event gets `ACCEPTED`, `RETRY` or
   `REFUSED` with a reason (architecture.md §6).
4. **Store.** Accepted events go through the ingest bus and Firehose to
   `raw/hour=<event hour>/` (ADR-0002); refused ones go to `error/`.
5. **Count.** After the hour's grace, the recounter dedupes on
   `(applicationId, tenantId, eventId)` and writes `HOURLY` records, then
   `ADJUSTMENT` records for later changes (ADR-0003, architecture.md §7).
6. **Deliver.** Each record is published as `UsageRecorded` and delivered
   to each sink with `recordId` as the idempotency key (architecture.md §8).
7. **Repair.** Operators re-admit refused events, redrive the dead-letter
   queues and sinks, and recount hours (architecture.md §9).

## Deploy

Prerequisites: Node.js 24, a CDK-bootstrapped account and Region, the
`smithy` CLI on the path (the build generates the SSDK from `model/`).

```bash
npx projen build
npx cdk deploy TenantUsageMetering -c fleetName=demo
```

| Context | Default | Meaning |
|---|---|---|
| `stackName` | `TenantUsageMetering` | the demo stack's name, so two stacks can sit in one account |
| `fleetName` | `demo` | the control plane's fleet name; emitter roles are `<fleet>-ue-<cellId>` |
| `ingestPath` | `BUS` | `BUS` (ingest bus, ADR-0002) or `DIRECT` (Firehose) |
| `lateGraceMinutes` | `15` | how long after an hour ends it is first counted |
| `rawRetentionDays` | `400` | raw object lifetime |
| `publishServiceParameter` | `true` | write the published parameter; one stack per account and Region may |
| `integLocalCell` | `false` | test only: an emitter role and cell in this account |
| `integHttpReceiver` | `false` | test only: an `AWS_IAM` function URL that stands in for a billing API |

The demo stack creates stand-in registrar, operator and reader roles and
writes `/application-plane/shared/metering/service`. Teardown:

```bash
npx cdk destroy TenantUsageMetering --force
```

Use the construct in your own app:

```ts
import { TenantUsageMetering, UsageSubscriber } from './src';

const metering = new TenantUsageMetering(stack, 'Metering', {
  fleetName: 'control-plane',
  registrarPrincipalArns: [`arn:aws:iam::${controlPlaneAccount}:role/control-plane-global-hook`],
  operatorPrincipalArns: [operatorRole.roleArn],
  readerPrincipalArns: [billingReaderRole.roleArn],
  usageSubscriberAccountIds: [billingAccountId], // AWS RAM share, subscribe only
});

// In the billing account, after the share is accepted (or at once inside
// the organization with AWS RAM sharing enabled):
new UsageSubscriber(billingStack, 'Usage', {
  busArn: metering.usageBusArn,
  targetArn: billingQueue.queueArn,
  role: deliveryRole,
  meters: ['agent.tokens'],
});
```

The construct shares each bus whose subscriber list is not empty through
AWS RAM with the managed permission
`AWSRAMEventBridgeEventBusV2SubscribeOnly`. An account outside the
organization accepts the resource share invitation before it can attach a
subscriber. A deploy fails when a listed account already holds a
registered cell (architecture.md §4.1).

Then give `<fleet>-global-hook` a policy from `metering.registrarStatement`
and each cell's emitter role a policy from `metering.ingestStatement`, and
register [`scripts/control-plane/metering-hook.sh`](scripts/control-plane/metering-hook.sh)
as a global hook on the five events of spec §3.4. Cells send usage with
[`scripts/emit-usage.ts`](scripts/emit-usage.ts).

## Deployment integration test

`AWS_REGION=eu-central-1 npx projen integ` deploys the demo stack with a
local test cell, drives registration, ingest, counting, sinks, the usage
bus, a late event, re-admission and offboarding, and destroys the stack:
about 40 to 100 minutes, depending on how far the run starts from the next
hour, and under one US dollar. See [`integration-test.md`](integration-test.md).

## End-to-end demo

`scripts/demo.sh` walks the flow against a stack deployed with
`-c integLocalCell=true`, checks each response, and cleans up what it
created on exit.

| Step | Call | Expected |
|---|---|---|
| 1 | `PUT /cells/{cellId}/emitter` (registrar) | 200, `ACTIVE` |
| 2 | `PUT /cells/{cellId}/tenants/demo-tenant` (registrar) | 200, `ACTIVE` |
| 3 | `POST /meters` (operator) | 201 |
| 4 | `POST /usage-events` (emitter) | 200, `ACCEPTED`, then `TENANT_NOT_IN_CELL` |
| 5 | `GET /hours/{hour}` (operator) | 200, `OPEN` |
| 6 | cleanup: `DELETE` binding and emitter, `DELETE /meters/{id}` | 200 |

## API

Smithy, `aws.protocols#restJson1`, model in [`model/`](model/).

| Resource | Operations |
|---|---|
| Usage events | `PutUsageEvents` |
| Meter | `CreateMeter`, `GetMeter`, `UpdateMeter`, `DeleteMeter`, `ListMeters` |
| Sink | `CreateSink`, `GetSink`, `UpdateSink`, `DeleteSink`, `ListSinks` |
| Cell emitter | `PutCellEmitter`, `GetCellEmitter`, `DeleteCellEmitter`, `ListCellEmitters` |
| Tenant binding | `PutTenantBinding`, `GetTenantBinding`, `DeleteTenantBinding`, `ListTenantBindings` |
| Usage | `GetUsage`, `ListUsage` |
| Hour | `GetHour`, `ListHours` |
| Jobs | `StartRecount`, `StartReadmission`, `StartIngestRedrive`, `StartSinkRedrive`, `StartResendBlocked`, `GetJob`, `ListJobs` |

### HTTP sinks

An `HTTP` sink authenticates in one of two ways, set at `CreateSink`:

- `auth: SECRET` (the default): a Secrets Manager secret under
  `<fleet>/metering/sinks/`, sent as `Authorization: Bearer <value>` or
  as `{"header": ..., "value": ...}`.
- `auth: AWS_IAM` (ADR-0007): no secret. The dispatcher signs each delivery
  with SigV4 as its own role. The endpoint must be a Lambda function URL
  or an API Gateway `execute-api` host, on `https:` with no port. Grant the
  dispatcher role invoke on that endpoint only:

  ```ts
  billingFn.grantInvokeUrl(metering.dispatcherRole); // function URL
  metering.dispatcherRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['execute-api:Invoke'],
    resources: [billingApi.arnForExecuteApi('POST', '/usage')],
  })); // API Gateway with AWS_IAM authorization
  ```

  An endpoint in another account also needs a resource policy that names
  the dispatcher role. API Gateway custom domain names and private API
  hosts are not supported.

Hour states: `OPEN` → `COUNTING` → `COUNTED` (→ `DIRTY` → `COUNTING`) →
`CLOSED`, with `COUNT_FAILED` retried with backoff. Delivery states:
`PENDING` → `SENT`, or `RETRYING` → `FAILED`, or `BLOCKED` until a billing
account is known.

## Observability and costs

**Per tenant.** The service's output is per-tenant usage: every event in
the raw and error stores carries its `tenantId`, and `GetUsage` and
`ListUsage` return records per tenant, application, meter and hour. Logs
are JSON with an allow-list of fields
([`src/shared/logger.ts`](src/shared/logger.ts)); `tenantId` is on it, but
log lines name the cell, application, meter, sink, hour or job, since a
batch, an hour and a delivery each span tenants. Metrics have no tenant
dimension: CloudWatch bills every name and dimension combination as its
own custom metric, so a tenant dimension adds billed metrics per tenant
for numbers the usage records already hold exactly
([architecture.md §10](architecture.md#10-observability-and-costs)).

**Costs.** Everything is pooled, so nothing is tagged per tenant. Each
usage record carries `eventCount`, the accepted and deduplicated events of
one tenant, application and meter in one hour. A tenant's cost is its
share of the hour's accepted events times the per-event costs (API
Gateway, ingest Lambda, the ingest bus, Firehose, S3, the recounter), plus
its share of records times the per-record costs (table writes, the usage
bus, sink deliveries), plus an equal split of the fixed costs (the
schedules, alarms, sink secrets, logs):

```
tenant cost ≈ Σ hours [ share of accepted events × per-event cost
                      + share of records × per-record cost ]
            + fixed cost / tenants with a record in the month
```

Refused events, calls from unregistered roles, and repair jobs carry no
verified tenant; they are charged to the emitter's cell where it is known
and otherwise stay vendor overhead. Unit prices come from each service's
pricing page.

## Security notes

- Identity comes from the SigV4 signature, never the body (P-2). An
  emitter speaks for the tenants its cell holds, and only within the
  registration's intervals.
- The control plane is the source of truth for placement; only its hook
  role may register (P-3).
- Explicit-deny resource policies on the API, the buckets, the buses, the
  table and the dead-letter queue keep every store to its writers, whatever
  an identity policy in the account allows (M-24).
- No account both holds cells and reads a bus: `PutCellEmitter` and a
  deploy-time guard keep the two lists apart (M-6).
- Logs carry no event payload, sink body or credential (M-27).
- The sample proves who sent an event, not that its quantity is true: a
  tenant-owned cell can under-report (T-3).

Threats, mitigations and residuals: [`threat-model.md`](threat-model.md).

## Production hardening checklist

- [ ] An SCP or permissions boundary that denies `firehose:PutRecord*` on
      the raw stream to all but the stack's roles (M-24 residual: Firehose
      has no resource policy).
- [ ] S3 Object Lock on the raw bucket for an audit trail that cannot be
      shortened (M-24).
- [ ] WAF on the API, and a block list for floods from unregistered roles
      (M-5).
- [ ] `alarmTopicArn` wired to the on-call rotation (M-12, M-21).
- [ ] A reconciliation of the registry against the control plane's
      deployments, for delete hooks that were skipped (T-9).
- [ ] `RemovalPolicy.RETAIN` on the table and the buckets (M-24 residual:
      a stack delete removes them).
- [ ] A distributed map in the recounter for hours larger than one task's
      memory (M-23 residual, ADR-0003).
- [ ] An allowlist of `HTTP` sink endpoints set at deploy time, refusing
      private, loopback and link-local addresses (M-16).
- [ ] For `AWS_IAM` sinks, grant `dispatcherRole` invoke only on the named
      billing endpoints, never on `*` (M-17, ADR-0007).
- [ ] Customer-managed KMS keys on the stores, if the vendor must control
      the keys (T-20).

## Design trail

- Specification: [`design/tenant-usage-metering.spec.md`](design/tenant-usage-metering.spec.md)
- Decisions: [`adr/`](adr/README.md)
- Threat model: [`threat-model.md`](threat-model.md)
- Implemented state: [`architecture.md`](architecture.md)

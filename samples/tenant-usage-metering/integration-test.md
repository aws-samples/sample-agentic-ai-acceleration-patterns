<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Tenant Usage Metering: deployment integration test

## What it is

[`test/integ.metering.ts`](test/integ.metering.ts), driven by
[`scripts/integ.sh`](scripts/integ.sh) through `npx projen integ`. The
script deploys the demo stack with the CDK CLI, runs the test against it,
and destroys the stack from an exit trap, so the destroy also runs when a
step fails.

The test is the reference implementation of the sample's wiring: it calls
the API as each kind of caller (registrar, operator, reader, emitter) with
SigV4, the way the control plane's hook, an operator and a cell would, and
reads the buses through `UsageSubscriber`, the way a billing system
would.

## How to run it

- A non-production account, CDK-bootstrapped in the Region you test.
- Credentials whose principal may assume roles of the account (the demo
  stack's stand-in roles trust the account).
- One Region, from `AWS_REGION`; the script stops when it is unset.

```bash
npx projen build
AWS_REGION=eu-central-1 npx projen integ
```

| Knob | Default | Meaning |
|---|---|---|
| `INTEG_STACK_NAME` | `TenantUsageMetering` | the demo stack's name (`-c stackName`) |
| `INTEG_FLEET` | `demo` | the fleet name (`-c fleetName`) |
| `INTEG_INGEST_PATH` | `BUS` | `BUS` or `DIRECT` (`-c ingestPath`) |
| `INTEG_PUBLISH_SERVICE_PARAMETER` | `true` | whether the stack writes the published parameter; one stack per account and Region may |
| `INTEG_LATE_GRACE_MINUTES` | `6` | the demo stack's `lateGraceMinutes`, the shortest the construct accepts |
| `INTEG_KEEP_STACK` | `0` | `1` leaves the stack in place after the run |

The `DIRECT` path runs as a second stack, beside the first if wanted, with
its own name and fleet:

```bash
INTEG_STACK_NAME=TenantUsageMeteringDirect INTEG_FLEET=demo2 INTEG_INGEST_PATH=DIRECT INTEG_PUBLISH_SERVICE_PARAMETER=false AWS_REGION=eu-central-1 npx projen integ
```

## What it stands up

One stack, `TenantUsageMetering` by default, from
[`src/demo.cdk.ts`](src/demo.cdk.ts) with `-c integLocalCell=true`: the
construct, stand-in registrar, operator and reader roles, one cell's
emitter role in the same account, two reader queues on the usage bus
through `UsageSubscriber` (one unfiltered, one filtered to meter
`agent.tokens`), on `BUS` a reader queue on the ingest bus through
`UsageSubscriber` with `stream: raw`, and the published parameter. With
`-c integHttpReceiver=true` (set by `scripts/integ.sh`) it also holds a
test receiver: an `AWS_IAM` Lambda function URL that stands in for a
billing API, the target of an `auth: AWS_IAM` sink. Only the dispatcher's
role may invoke it, so Lambda refuses an unsigned call. It stores nothing,
runs at most two at a time, and is deleted with the stack. The run creates
meters, sinks, registrations and usage in it, and the destroy removes all
of them.

## Steps

| Step | Checks |
|---|---|
| Registrations | `PutCellEmitter` is `ACTIVE` and idempotent; a moved cell is 409 `PLACEMENT_MISMATCH`; an operator cannot register (resource policy); two tenants bound; a bad `billingAccount` is 400 |
| Meters and sinks | a backdated `SUM` meter; a second create is 409 `ALREADY_EXISTS`; an `S3_EXPORT` sink; an `HTTP` sink that maps `billingAccount`, pointed at an endpoint that refuses; the test receiver refuses an unsigned call at the function URL (403 `AccessDenied`); an `AWS_IAM` sink to the receiver, with a repeated query key (`?tag=a&tag=b`) so a later `SENT` proves the signature covers it; an `AWS_IAM` sink to a host that is not a function URL or API Gateway is a 400; an `HTTP` sink with a secret outside the fleet prefix is a 400 |
| Ingest | one batch judged event by event: four `ACCEPTED`, `TENANT_NOT_IN_CELL`, `UNKNOWN_METER`, `BAD_SHAPE`; an unchanged resend is `ACCEPTED`; a caller that is not an emitter role gets 403 |
| Raw-stream reader | `BUS` only: the `stream: raw` `UsageSubscriber` receives the four accepted events; its dead-letter queue stays empty |
| The count | after the hour closes and its grace passes: tenant-a counted once per event id (15.5), with its billing account; tenant-b counted without one; the hour `COUNTED` |
| Export sink | both records reach the export bucket as `UsageRecorded` lines; the record shows the delivery `SENT` |
| Usage-bus readers | an unfiltered `UsageSubscriber` and one filtered to `agent.tokens` each receive both records; on a miss the check prints the reader's dead-letter queue |
| HTTP sink deliveries | to the refusing endpoint, tenant-a's delivery is `FAILED` (`HTTP_403`); to the receiver it is `SENT`; tenant-b's, with no billing account, is `BLOCKED` (`NO_BILLING_ACCOUNT`) on both |
| Resend | a billing account for tenant-b starts `RESEND_BLOCKED`; the record becomes revision 2 with `acct-b`, is `SENT` to the receiver, and revision 2 reaches the usage bus; the receiver's log shows both records with `recordId` as the idempotency key and the mapped account |
| Sink redrive | a sink created after the records is backfilled by `StartSinkRedrive` with an hour range; `StartSinkRedrive` without one sends the `FAILED` deliveries again |
| Ingest redrive | `StartIngestRedrive` succeeds on the empty ingest dead-letter queue (`BUS`) or is a 400 (`DIRECT`) |
| Failed alarm | the `DeliveriesFailed` alarm goes to `ALARM` |
| Late event | a late event in the counted hour gives an `ADJUSTMENT` of 2, total 17.5, seq 0 unchanged |
| Re-admission | a meter backdated over the refused event; `StartReadmission` re-admits it; it is counted; the reader filter keeps that meter off the queue |
| Readers and offboarding | a reader reads usage and not meters; `DeleteTenantBinding` closes with the control-plane ids from its headers; a second delete and a delete of a missing binding succeed |
| Deployment-role exemption | `scripts/integ.sh` updates the stack with `rawRetentionDays=401`; the lifecycle change passes the raw bucket's configuration deny (spec §3.5) |

## Runtime and cost

About 40 to 100 minutes a run. The test waits for the hour its events
fall in to close, from 15 minutes (a run started just before the hour) to
about 75; the steps after the count take about 20 minutes; deploy and
destroy take about 7 together (about 4 and 3). Cost is well under one US
dollar a run.

Last green runs, 2026-11-19, eu-central-1, all 54 checks passed on each
path: `BUS` (deploy 228 s, test about 40 minutes, delete 183 s) and
`DIRECT` (deploy 233 s, test 80 minutes, delete 182 s). Coverage and the
unit-test count are in the [`architecture.md`](architecture.md) status
block.

## After an interruption

If the script stops before its teardown, delete the stack
(`npx cdk destroy <INTEG_STACK_NAME> --force`) and check for:

- the log groups of the two CDK provider functions,
  `/aws/lambda/<stack>-CustomS3AutoDeleteObjectsCusto-*` and
  `/aws/lambda/<stack>-BucketNotificationsHandler050a-*`, which every
  delete leaves behind;
- the parameter `/application-plane/shared/metering/service`, when
  `INTEG_PUBLISH_SERVICE_PARAMETER` was `true`.

## Test-only shortcuts

- `integLocalCell=true` registers a cell in the metering account, which
  `PutCellEmitter` refuses in a deployment (`testOnlyAllowCellsInMeteringAccount`).
  A consumer runs emitters in cell accounts.
- The bus readers sit in the metering account, so the run creates no AWS
  RAM share. A consumer lists its subscriber accounts in
  `rawSubscriberAccountIds` or `usageSubscriberAccountIds` and attaches
  `UsageSubscriber` there.
- The test reads the stand-in callers' role ARNs and the bucket names from
  stack outputs. A consumer reads the API URL and the bus ARNs from the
  published parameter, and knows its own roles.
- The `HTTP` sink points at a route of the metering API that refuses an
  unsigned call, so the test proves `FAILED`, `BLOCKED` and the resend
  without a public receiver; a consumer points a sink at its billing API.
  Its secret is created by the demo stack under `<fleet>/metering/sinks/`.
- The test receiver is an IAM-gated stand-in for a billing API, test
  only, off by default. A consumer's sink points at its own billing API.
- The stand-in registrar replaces the control plane's global hook, whose
  hooks are not yet released (spec §6.4); a consumer registers
  [`scripts/control-plane/metering-hook.sh`](scripts/control-plane/metering-hook.sh).

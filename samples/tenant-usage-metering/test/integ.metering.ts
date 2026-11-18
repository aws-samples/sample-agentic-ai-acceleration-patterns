// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test (standard §5): runs against a deployed demo stack
 * with `integLocalCell=true`, as the stand-in callers the stack outputs.
 *
 *   npx ts-node test/integ.metering.ts <outputs.json>
 *
 * The stack is the caller's to deploy and destroy (scripts/integ.sh).
 * Each check prints PASS or FAIL; the process exits non-zero on any FAIL.
 */

import * as fs from 'node:fs';
import { Sha256 } from '@aws-crypto/sha256-js';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import { ulid } from 'ulid';

const outputs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).TenantUsageMetering as Record<string, string>;
const REGION = process.env.AWS_REGION ?? 'eu-central-1';
const API = new URL(outputs.ApiUrl);
const base = fromNodeProviderChain();
const as = (roleArn: string): AwsCredentialIdentityProvider =>
  fromTemporaryCredentials({
    masterCredentials: base,
    params: { RoleArn: roleArn, RoleSessionName: 'metering-integ' },
    clientConfig: { region: REGION },
  });
const registrar = as(outputs.RegistrarRoleArn);
const operator = as(outputs.OperatorRoleArn);
const reader = as(outputs.ReaderRoleArn);
const emitter = as(outputs.EmitterRoleArn);
const CELL = outputs.CellId;
const ACCOUNT = outputs.EmitterRoleArn.split(':')[4];

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) {
    failures++;
  }
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}\n`,
  );
}

async function call(
  credentials: AwsCredentialIdentityProvider,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const [pathname, query] = path.split('?');
  const request = new HttpRequest({
    method,
    protocol: 'https:',
    hostname: API.hostname,
    path: `${API.pathname.replace(/\/$/, '')}${pathname}`,
    query: Object.fromEntries(new URLSearchParams(query ?? '')),
    headers: { 'host': API.hostname, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 });
  const signed = await signer.sign(request);
  const url = `https://${API.hostname}${signed.path}${query ? `?${query}` : ''}`;
  const response = await fetch(url, { method, headers: signed.headers as Record<string, string>, body: signed.body as string | undefined });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    // not JSON
  }
  return { status: response.status, body: parsed };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(name: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await probe();
    if (value !== undefined) {
      process.stdout.write(`  ${name}: ${Math.round((Date.now() - start) / 1000)} s\n`);
      return value;
    }
    await sleep(15_000);
  }
  return undefined;
}

const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13);
/** A whole second after now: never before a registration's `activeFrom`, which has milliseconds. */
const stamp = () => new Date(Math.ceil((Date.now() + 1000) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
/** The demo stack's `lateGraceMinutes` for this run (`-c lateGraceMinutes=6`). */
const LATE_GRACE_MINUTES = Number(process.env.LATE_GRACE_MINUTES ?? '6');

async function main(): Promise<void> {
  const t0 = Date.now();
  // Usage is admitted only from a registration's activeFrom (spec §4.2), so the
  // events are stamped after the registrations below, in the current hour, and
  // the hour is counted once it has ended and its grace has passed.
  let eventTime = '';
  const ev = (tenantId: string, meterId: string, value: string, _minute: number, eventId = ulid()) => ({
    eventId,
    tenantId,
    meterId,
    value,
    time: eventTime,
  });

  // Registrations ----------------------------------------------------------------
  const putEmitter = await call(registrar, 'PUT', `/cells/${CELL}/emitter`, {
    applicationId: 'demo-app',
    accountId: ACCOUNT,
    controlPlaneExecutionId: 'integ-exec-1',
    controlPlaneOperatorId: 'integ',
  });
  check('registrar registers the cell emitter', putEmitter.status === 200 && putEmitter.body.emitter?.status === 'ACTIVE', putEmitter);
  const again = await call(registrar, 'PUT', `/cells/${CELL}/emitter`, { applicationId: 'demo-app', accountId: ACCOUNT });
  check(
    'PutCellEmitter is idempotent',
    again.status === 200 && again.body.emitter?.activeFrom === putEmitter.body.emitter?.activeFrom,
    again,
  );
  const moved = await call(registrar, 'PUT', `/cells/${CELL}/emitter`, { applicationId: 'other-app', accountId: ACCOUNT });
  check('a cell never moves: 409 PLACEMENT_MISMATCH', moved.status === 409 && moved.body.reason === 'PLACEMENT_MISMATCH', moved);
  const opRegisters = await call(operator, 'PUT', `/cells/${CELL}/emitter`, { applicationId: 'demo-app', accountId: ACCOUNT });
  check('an operator cannot register (resource policy)', opRegisters.status === 403, opRegisters);
  for (const [tenantId, billingAccount] of [
    ['tenant-a', 'acct-a'],
    ['tenant-b', undefined],
  ] as const) {
    const bind = await call(registrar, 'PUT', `/cells/${CELL}/tenants/${tenantId}`, {
      applicationId: 'demo-app',
      ...(billingAccount ? { billingAccount } : {}),
    });
    check(`registrar binds ${tenantId}`, bind.status === 200 && bind.body.binding?.status === 'ACTIVE', bind);
  }
  const badBilling = await call(registrar, 'PUT', `/cells/${CELL}/tenants/tenant-b`, {
    applicationId: 'demo-app',
    billingAccount: 'has space',
  });
  check('a BILLING_ACCOUNT out of format is a 400', badBilling.status === 400, badBilling);

  // Meters and sinks ---------------------------------------------------------------
  const meterFrom = hourKey(Date.now() - 6 * 3_600_000);
  if (hourKey(Date.now()) !== hourKey(Date.now() + 120_000)) {
    process.stdout.write('  waiting 2 minutes so the events do not straddle an hour\n');
    await sleep(120_000);
  }
  const meter = await call(operator, 'POST', '/meters', { meterId: 'agent.tokens', unit: 'tokens', rule: 'SUM', effectiveFrom: meterFrom });
  check('operator creates a backdated SUM meter', meter.status === 201 && meter.body.meter?.effectiveFrom === meterFrom, meter);
  const dup = await call(operator, 'POST', '/meters', { meterId: 'agent.tokens', unit: 'tokens', rule: 'SUM' });
  check('a second CreateMeter is 409 ALREADY_EXISTS', dup.status === 409 && dup.body.reason === 'ALREADY_EXISTS', dup);
  const sink = await call(operator, 'POST', '/sinks', { sinkId: 'export', type: 'S3_EXPORT', enabled: true, endpoint: 'exports/integ' });
  check('operator creates an S3_EXPORT sink', sink.status === 201 && sink.body.sink?.endpoint === 'exports/integ/', sink);
  const badSink = await call(operator, 'POST', '/sinks', {
    sinkId: 'http',
    type: 'HTTP',
    enabled: true,
    endpoint: 'https://billing.example.com/usage',
    secretName: 'other/secret',
  });
  check('an HTTP sink with a secret outside the fleet prefix is a 400', badSink.status === 400, badSink);

  // Ingest -------------------------------------------------------------------------
  eventTime = stamp();
  await sleep(1500);
  const H = hourKey(Date.parse(eventTime));
  const receiptHour = hourKey(Date.now());
  const countDeadline = () => Math.max(60_000, Date.parse(`${H}:00:00Z`) + 3_600_000 + (LATE_GRACE_MINUTES + 12) * 60_000 - Date.now());
  process.stdout.write(`  events in hour ${H}; first count expected within ${Math.round(countDeadline() / 60_000)} min\n`);
  const resent = ulid();
  const batch = [
    ev('tenant-a', 'agent.tokens', '5', 10, resent),
    ev('tenant-a', 'agent.tokens', '7', 20),
    ev('tenant-a', 'agent.tokens', '3.5', 30),
    ev('tenant-b', 'agent.tokens', '11', 40),
    ev('tenant-c', 'agent.tokens', '1', 41),
    ev('tenant-a', 'agent.calls', '1', 42),
    { eventId: ulid(), tenantId: 'tenant-a', meterId: 'agent.tokens', value: '-1', time: eventTime },
  ];
  const put = await call(emitter, 'POST', '/usage-events', { events: batch });
  const results = (put.body.results ?? []).map((r: { result: string; reason?: string }) => r.reason ?? r.result);
  check(
    'each event is judged alone',
    put.status === 200 &&
      JSON.stringify(results) ===
        JSON.stringify(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'TENANT_NOT_IN_CELL', 'UNKNOWN_METER', 'BAD_SHAPE']),
    put,
  );
  const resend = await call(emitter, 'POST', '/usage-events', { events: [batch[0]] });
  check('an unchanged resend is ACCEPTED again', resend.status === 200 && resend.body.results?.[0]?.result === 'ACCEPTED', resend);
  const notEmitter = await call(operator, 'POST', '/usage-events', { events: [batch[1]] });
  check('a caller that is not an emitter role gets 403', notEmitter.status === 403, notEmitter);

  // The count ------------------------------------------------------------------------
  const usagePath = (tenantId: string, meterId: string) =>
    `/tenants/${tenantId}/applications/demo-app/meters/${meterId}/usage?from=${H}&to=${H}`;
  const hourly = await waitFor('HOURLY record for tenant-a', countDeadline(), async () => {
    const out = await call(operator, 'GET', usagePath('tenant-a', 'agent.tokens'));
    return out.body.records?.length > 0 ? out.body.records : undefined;
  });
  check(
    'tenant-a counts once per event id: 5 + 7 + 3.5 = 15.5',
    hourly?.length === 1 && hourly[0].kind === 'HOURLY' && hourly[0].total === '15.5' && hourly[0].eventCount === 3,
    hourly,
  );
  check('the record carries the tenant billing account', hourly?.[0]?.billingAccount === 'acct-a', hourly);
  const tenantB = await call(operator, 'GET', usagePath('tenant-b', 'agent.tokens'));
  check(
    'tenant-b counted, no billing account',
    tenantB.body.records?.[0]?.total === '11' && tenantB.body.records[0].billingAccount === undefined,
    tenantB,
  );
  const hourSummary = await call(operator, 'GET', `/hours/${H}`);
  check('the hour is COUNTED', hourSummary.body.hourSummary?.status === 'COUNTED', hourSummary);

  const s3 = new S3Client({ region: REGION });
  const exported = await waitFor('S3_EXPORT delivery', 5 * 60_000, async () => {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: outputs.ExportBucketName, Prefix: `exports/integ/hour=${H}/` }));
    return (list.Contents ?? []).length >= 2 ? list.Contents : undefined;
  });
  check(
    'both records reach the export sink',
    exported?.length === 2,
    exported?.map((o) => o.Key),
  );
  if (exported !== undefined) {
    const object = await s3.send(new GetObjectCommand({ Bucket: outputs.ExportBucketName, Key: exported[0].Key }));
    const line = JSON.parse((await object.Body!.transformToString()).trim());
    check('an export line is the UsageRecorded detail', typeof line.recordId === 'string' && line.hour === H, line);
  }
  const delivered = await waitFor('sink state SENT', 3 * 60_000, async () => {
    const out = await call(operator, 'GET', usagePath('tenant-a', 'agent.tokens'));
    return out.body.records?.[0]?.sinks?.export?.status === 'SENT' ? out.body.records[0] : undefined;
  });
  check('the record shows the export delivery SENT', delivered !== undefined);

  // A late event gives an ADJUSTMENT -----------------------------------------------------
  const late = await call(emitter, 'POST', '/usage-events', { events: [ev('tenant-a', 'agent.tokens', '2', 50)] });
  check('a late event inside the window is ACCEPTED', late.body.results?.[0]?.result === 'ACCEPTED', late);
  const adjusted = await waitFor('ADJUSTMENT record', 15 * 60_000, async () => {
    const out = await call(operator, 'GET', usagePath('tenant-a', 'agent.tokens'));
    return out.body.records?.length >= 2 ? out.body.records : undefined;
  });
  check(
    'the late event is an ADJUSTMENT of 2 with total 17.5; seq 0 is unchanged',
    adjusted?.[0]?.total === '15.5' &&
      adjusted?.[1]?.kind === 'ADJUSTMENT' &&
      adjusted[1].quantity === '2' &&
      adjusted[1].total === '17.5' &&
      adjusted[1].seq === 1,
    adjusted,
  );

  // Re-admission ---------------------------------------------------------------------------
  const calls = await call(operator, 'POST', '/meters', { meterId: 'agent.calls', unit: 'calls', rule: 'COUNT', effectiveFrom: meterFrom });
  check('a backdated meter for the refused event', calls.status === 201, calls);
  await sleep(65_000); // the ingest registry cache (60 s) does not matter to READMIT, which reads the table
  const readmit = await call(operator, 'POST', '/jobs/readmission', { from: receiptHour, to: receiptHour, reason: 'UNKNOWN_METER' });
  check('StartReadmission is accepted', readmit.status === 202, readmit);
  const job = await waitFor('READMIT job', 5 * 60_000, async () => {
    const out = await call(operator, 'GET', `/jobs/${readmit.body.job?.jobId}`);
    return out.body.job?.status !== 'RUNNING' ? out.body.job : undefined;
  });
  check('the job re-admits the one UNKNOWN_METER event', job?.status === 'SUCCEEDED' && job.counts?.admitted === 1, job);
  const callRecords = await waitFor('agent.calls record', 15 * 60_000, async () => {
    const out = await call(operator, 'GET', usagePath('tenant-a', 'agent.calls'));
    return out.body.records?.length > 0 ? out.body.records : undefined;
  });
  check('the re-admitted event is counted', callRecords?.[0]?.total === '1', callRecords);

  // Readers and offboarding -----------------------------------------------------------------
  const readerUsage = await call(reader, 'GET', usagePath('tenant-a', 'agent.tokens'));
  check('a reader reads usage', readerUsage.status === 200, readerUsage.status);
  const readerMeters = await call(reader, 'GET', '/meters');
  check('a reader cannot read meters', readerMeters.status === 403, readerMeters.status);
  const unbind = await call(registrar, 'DELETE', `/cells/${CELL}/tenants/tenant-b`, undefined, {
    'X-Control-Plane-Execution-Id': 'integ-exec-2',
  });
  check(
    'DeleteTenantBinding closes the binding',
    unbind.status === 200 && unbind.body.binding?.status === 'CLOSING' && unbind.body.binding.closedByExecutionId === 'integ-exec-2',
    unbind,
  );
  const unbindAgain = await call(registrar, 'DELETE', `/cells/${CELL}/tenants/tenant-b`);
  check('a second delete succeeds', unbindAgain.status === 200, unbindAgain);
  const missing = await call(registrar, 'DELETE', `/cells/${CELL}/tenants/never-bound`);
  check('a delete of a missing binding succeeds', missing.status === 200, missing);

  process.stdout.write(`${JSON.stringify({ failures, seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(2);
});

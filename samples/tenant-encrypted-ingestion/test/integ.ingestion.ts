// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's steps (spec §10), run by `scripts/integ.sh` after
 * it deployed tenant-identity (if absent), the test-aid stack and the demo
 * stack (test/integ/app.ts). One function per step, named and ordered as
 * spec §10 is, so the spec and this file read side by side.
 *
 *   INTEG_OUTPUTS=cdk.integ.out/outputs.json AWS_REGION=... npx ts-node -P tsconfig.dev.json test/integ.ingestion.ts
 *
 * It uses only what a consumer of the sample could: the published
 * parameters under /application-plane/shared/ingestion/, the demo and
 * test-aid stacks' outputs (the construct's read-only properties, §3.4),
 * the public API, and tenant-identity's own platform API.
 *
 * Status (2026-11-05, never run against an account): steps 1, 3, 4, 5, 6,
 * 7, 7b, 9 and 11 are implemented; 7c, 8, 10 and 12 print TODO with what
 * remains.
 *
 * Output follows scripts/CONVENTIONS.md: step names, HTTP statuses, tenant
 * ids and error codes; never a token, a presigned URL or a credential.
 */

import { readFileSync } from 'node:fs';
import { Sha256 } from '@aws-crypto/sha256-js';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentity } from '@smithy/types';

const REGION = process.env.AWS_REGION ?? '';
const OUTPUTS_FILE = process.env.INTEG_OUTPUTS ?? 'cdk.integ.out/outputs.json';
const TEST_AID_STACK = 'TenantEncryptedIngestionTestAid';
const DEMO_STACK = 'TenantEncryptedIngestionInteg';
const IDENTITY_PREFIX = '/application-plane/shared/identity/';
const INGESTION_PREFIX = '/application-plane/shared/ingestion/';
const KEY_POLICY_WAIT_MS = 5 * 60 * 1000;

type Outcome = 'pass' | 'fail' | 'todo' | 'skip';
interface StepResult {
  readonly step: string;
  readonly outcome: Outcome;
  readonly notes: string[];
}

/** Everything the steps share, filled as they run. */
interface World {
  readonly outputs: Record<string, Record<string, string>>;
  readonly apiUrl: string;
  readonly bucket: string;
  readonly identityApi: string;
  readonly tenants: Record<string, { tenantId: string; token?: string; readOnlyToken?: string; keyArn?: string }>;
  readonly deliveries: Record<string, { tenantId: string; deliveryId: string; landedKey?: string }>;
}

const credentials = fromNodeProviderChain();
const sts = new STSClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class Check {
  readonly notes: string[] = [];
  failed = false;
  expect(condition: boolean, what: string): void {
    this.notes.push(`${condition ? 'ok  ' : 'FAIL'} ${what}`);
    if (!condition) {
      this.failed = true;
    }
  }
  note(what: string): void {
    this.notes.push(`     ${what}`);
  }
}

async function param(name: string): Promise<string> {
  const value = (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
  if (value === undefined) {
    throw new Error(`parameter ${name} not found`);
  }
  return value;
}

/** A SigV4-signed JSON call to an execute-api URL (tenant-identity's or this sample's /platform). */
async function signed(method: string, url: string, body?: unknown, creds?: AwsCredentialIdentity): Promise<{ status: number; json: any }> {
  const u = new URL(url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const request = new HttpRequest({
    method,
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    headers: { host: u.hostname, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: payload,
  });
  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials: creds ?? credentials, sha256: Sha256 });
  const s = await signer.sign(request);
  const response = await fetch(url, { method, headers: s.headers as Record<string, string>, body: payload });
  const text = await response.text();
  return { status: response.status, json: text.length > 0 ? safeJson(text) : {} };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function tenantCall(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${WORLD!.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: safeJson(text) };
}

/** Credentials of `roleArn` with an optional TenantId session tag. */
async function assume(roleArn: string, tenantId?: string): Promise<AwsCredentialIdentity> {
  const r = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `integ-${tenantId ?? 'probe'}`.slice(0, 64),
      DurationSeconds: 3600,
      ...(tenantId !== undefined ? { Tags: [{ Key: 'TenantId', Value: tenantId }] } : {}),
    }),
  );
  const c = r.Credentials!;
  return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken!, expiration: c.Expiration };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function errorMentionsKms(error: unknown): boolean {
  const e = error as { name?: string; message?: string };
  return /kms/i.test(e.name ?? '') || /kms/i.test(e.message ?? '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tiny PDF of `pages` pages (synthetic). */
function pdf(pages: number): Buffer {
  return Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Pages /Count ${pages} >> endobj\n${'2 0 obj << /Type /Page >> endobj\n'.repeat(pages)}%%EOF\n`);
}

/** CreateDelivery, then the PUT with the returned headers (optionally altered). */
async function deliver(token: string, body: Buffer, contentType = 'application/pdf', fileName = 'synthetic-case.pdf') {
  const created = await tenantCall('POST', 'tenant/deliveries', token, { fileName, contentType, sizeBytes: body.length });
  if (created.status !== 201) {
    return { created, put: undefined as number | undefined };
  }
  const put = await fetch(created.json.uploadUrl, { method: 'PUT', headers: created.json.headers, body });
  return { created, put: put.status };
}

async function waitFor(token: string, deliveryId: string, terminal: string[], timeoutMs = 180_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = await tenantCall('GET', `tenant/deliveries/${deliveryId}`, token);
    if (got.status === 200 && terminal.includes(got.json.delivery?.status)) {
      return got.json.delivery;
    }
    if (Date.now() > until) {
      return got.json.delivery;
    }
    await sleep(5000);
  }
}

let WORLD: World | undefined;

// ---------------------------------------------------------------------------
// steps (spec §10)
// ---------------------------------------------------------------------------

/** 1. Two tenants, two tiers. */
async function step1(w: World): Promise<StepResult> {
  const c = new Check();
  const platform = `${w.apiUrl}platform/tenants`;
  const a = w.tenants.A.tenantId;
  const created = await signed('POST', `${platform}/${a}/key`, { tier: 'vendor-key' });
  c.expect(created.status === 201, `CreateTenantKey ${a} vendor-key -> ${created.status}`);
  w.tenants.A.keyArn = created.json.key?.keyArn;
  const got = await signed('GET', `${platform}/${a}/key`);
  c.expect(got.json.key?.keyStatus === 'ACTIVE', `GetTenantKey ${a} -> ${got.json.key?.keyStatus}`);
  const again = await signed('POST', `${platform}/${a}/key`, { tier: 'vendor-key' });
  c.expect(again.status === 409, `CreateTenantKey ${a} again -> ${again.status}`);

  const vendorKey = await signed('POST', `${platform}/tenant-c/key`, { tier: 'tenant-key', keyArn: w.tenants.A.keyArn });
  c.expect([400, 422].includes(vendorKey.status), `CreateTenantKey tenant-c tenant-key with a vendor-account key -> ${vendorKey.status} (422, or 400 UnsupportedInDeployment without tenantKeyAccount)`);

  const tenantKeyArn = process.env.INTEG_TENANT_KEY_ARN;
  if (tenantKeyArn === undefined) {
    c.note('tenant-key for B: no INTEG_TENANT_KEY_ARN (a key in the tenantKeyAccount account): the cross-account claim is UNPROVEN in this run');
  } else {
    const b = w.tenants.B.tenantId;
    const bk = await signed('POST', `${platform}/${b}/key`, { tier: 'tenant-key', keyArn: tenantKeyArn });
    c.expect(bk.status === 201, `CreateTenantKey ${b} tenant-key -> ${bk.status}`);
    w.tenants.B.keyArn = tenantKeyArn;
    const taken = await signed('POST', `${platform}/tenant-c/key`, { tier: 'tenant-key', keyArn: tenantKeyArn });
    c.expect(taken.status === 409, `CreateTenantKey tenant-c with B's keyArn -> ${taken.status}`);
  }
  if (w.tenants.B.keyArn === undefined) {
    // Without a second account, B is a second vendor-key tenant so the cross-tenant steps still run.
    const b = w.tenants.B.tenantId;
    const bk = await signed('POST', `${platform}/${b}/key`, { tier: 'vendor-key' });
    c.expect(bk.status === 201, `CreateTenantKey ${b} vendor-key (no second account) -> ${bk.status}`);
    w.tenants.B.keyArn = bk.json.key?.keyArn;
  }
  const d = await signed('POST', `${platform}/${w.tenants.D.tenantId}/key`, { tier: 'vendor-key' });
  c.expect(d.status === 201, `CreateTenantKey ${w.tenants.D.tenantId} vendor-key (the step 7 limit tenant) -> ${d.status}`);
  c.note('TODO: untagged and wrongly tagged tenant-key keys -> 422 need the second account (tenantKeyAccount)');
  return { step: '1', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

/** 2. Users and tokens from tenant-identity (its IssueToken test aid). */
async function step2(w: World): Promise<StepResult> {
  const c = new Check();
  for (const label of ['A', 'B', 'D'] as const) {
    const t = w.tenants[label];
    const created = await signed('POST', `${w.identityApi}platform/tenants`, {
      name: `tei-integ-${label}`,
      adminEmail: `success+tei-${label.toLowerCase()}@simulator.amazonses.com`,
      scopes: ['ingestion/deliver', 'ingestion/read'],
    });
    c.expect(created.status === 201, `tenant-identity CreateTenant ${label} -> ${created.status}`);
    const identityTenant = created.json.tenant?.tenantId;
    c.note(`tenant-identity tenant id for ${label} does ${/^[A-Za-z0-9][A-Za-z0-9-]{1,34}$/.test(identityTenant ?? '') ? '' : 'NOT '}match spec §7.0 `);
    const username = created.json.admin?.user?.username;
    const password = `Tei-${Math.random().toString(36).slice(2)}A1!`;
    const issued = await signed('POST', `${w.identityApi}platform/tenants/${identityTenant}/users/${username}/token`, { password });
    c.expect(issued.status === 200, `IssueToken ${label} -> ${issued.status}`);
    t.token = issued.json.accessToken;
  }
  c.note('TODO: a second token holding ingestion/read only (tenant admin cuts the user scopes, tenant-identity ADR-0036)');
  return { step: '2', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

/** 3. Happy path. */
async function step3(w: World): Promise<StepResult> {
  const c = new Check();
  for (const label of ['A', 'B'] as const) {
    const token = w.tenants[label].token;
    if (token === undefined) {
      c.expect(false, `no token for ${label}`);
      continue;
    }
    const { created, put } = await deliver(token, pdf(2));
    c.expect(created.status === 201, `CreateDelivery ${label} -> ${created.status}`);
    c.expect(put === 200, `PUT ${label} -> ${put}`);
    if (created.status !== 201) {
      continue;
    }
    const delivery = await waitFor(token, created.json.deliveryId, ['ACCEPTED', 'REJECTED', 'KEY_UNAVAILABLE']);
    c.expect(delivery?.status === 'ACCEPTED', `delivery ${label} -> ${delivery?.status} ${delivery?.reason ?? ''}`);
    w.deliveries[label] = { tenantId: w.tenants[label].tenantId, deliveryId: created.json.deliveryId, landedKey: delivery?.landedKey };
    if (delivery?.landedKey !== undefined) {
      const consumerCredentials = await assume(w.outputs[TEST_AID_STACK].TestConsumerRoleArn, w.tenants[label].tenantId);
      const consumer = new S3Client({ region: REGION, credentials: consumerCredentials });
      const head = await consumer.send(new GetObjectCommand({ Bucket: w.bucket, Key: delivery.landedKey }));
      c.expect(head.SSEKMSKeyId === w.tenants[label].keyArn, `landed ${label} encrypted with the tenant key`);
      c.expect((head.ContentDisposition ?? '').includes('synthetic-case.pdf'), `landed ${label} Content-Disposition names the file`);
      await head.Body?.transformToByteArray();
    }
  }
  c.note('TODO: one DeliveryAccepted per delivery without a key ARN (needs an event capture rule on the bus); no drop version left (ListObjectVersions as tenantPlatformRole)');
  c.note('TODO: read-only token: CreateDelivery -> 403, GetDelivery -> 200 (needs the step 2 read-only token)');
  return { step: '3', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

/** 4. The uploader cannot change the request. */
async function step4(w: World): Promise<StepResult> {
  const c = new Check();
  const token = w.tenants.A.token;
  if (token === undefined) {
    return { step: '4', outcome: 'fail', notes: ['no token for A'] };
  }
  const body = pdf(1);
  const created = await tenantCall('POST', 'tenant/deliveries', token, { fileName: 'tamper.pdf', contentType: 'application/pdf', sizeBytes: body.length });
  c.expect(created.status === 201, `CreateDelivery -> ${created.status}`);
  if (created.status !== 201) {
    return { step: '4', outcome: 'fail', notes: c.notes };
  }
  const url: string = created.json.uploadUrl;
  const headers: Record<string, string> = created.json.headers;
  const tries: [string, Record<string, string>, Buffer][] = [
    ["B's key id", { ...headers, 'x-amz-server-side-encryption-aws-kms-key-id': w.tenants.B.keyArn ?? 'x' }, body],
    ['no SSE header', Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'x-amz-server-side-encryption')), body],
    ['another Content-Length', { ...headers, 'Content-Length': String(body.length + 1) }, Buffer.concat([body, Buffer.from('x')])],
    ['x-amz-storage-class: GLACIER', { ...headers, 'x-amz-storage-class': 'GLACIER' }, body],
  ];
  for (const [what, h, b] of tries) {
    const r = await fetch(url, { method: 'PUT', headers: h, body: b });
    c.expect(r.status === 403, `PUT with ${what} -> ${r.status}`);
  }
  const edited = url.replace(`/ingest/${w.tenants.A.tenantId}/`, `/ingest/${w.tenants.B.tenantId}/`);
  const r1 = await fetch(edited, { method: 'PUT', headers, body });
  c.expect(r1.status === 403 && (await r1.text()).includes('SignatureDoesNotMatch'), `PUT with the path edited to B -> ${r1.status} SignatureDoesNotMatch`);
  const first = await fetch(url, { method: 'PUT', headers, body });
  c.expect(first.status === 200, `the PUT itself -> ${first.status}`);
  const second = await fetch(url, { method: 'PUT', headers, body });
  c.expect([412, 409].includes(second.status), `a second PUT before processing -> ${second.status} (412)`);
  const extra = await fetch(url, { method: 'PUT', headers: { ...headers, 'x-amz-meta-note': 'x' }, body });
  c.note(`extra unsigned header x-amz-meta-note -> ${extra.status} (recorded, spec §7.5)`);
  return { step: '4', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

/** 5. Each key-policy wall alone, against the mistaken Allow. */
async function step5(w: World): Promise<StepResult> {
  const c = new Check();
  const aid = w.outputs[TEST_AID_STACK];
  const scratch = aid.ScratchBucketName;
  const key = aid.ScratchKeyArn;
  const probe = new S3Client({ region: REGION, credentials: await assume(aid.TestProbeRoleArn) });
  const writer = new S3Client({ region: REGION, credentials: await assume(aid.TestScratchWriterRoleArn) });
  const put = (client: S3Client, k: string, bucketKey = false, bucket = scratch, kmsKey = key) =>
    client.send(
      new PutObjectCommand({ Bucket: bucket, Key: k, Body: 'x', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKey, BucketKeyEnabled: bucketKey, IfNoneMatch: k.startsWith('ingest/') ? '*' : undefined }),
    );
  const refusedByKms = async (what: string, call: () => Promise<unknown>) => {
    try {
      await call();
      c.expect(false, `${what}: succeeded`);
    } catch (error) {
      c.expect(errorMentionsKms(error), `${what}: ${errorName(error)} (KMS)`);
    }
  };
  await refusedByKms('4c: TestProbeRole PUT ingest/tenant-b/x', () => put(probe, `ingest/tenant-b/x-${Date.now()}`));
  await refusedByKms('4a-i: TestProbeRole PUT ingest/tenant-a/y', () => put(probe, `ingest/tenant-a/y-${Date.now()}`));
  await refusedByKms('4b: TestProbeRole direct GenerateDataKey', () =>
    new KMSClient({ region: REGION, credentials: probe.config.credentials }).send(new GenerateDataKeyCommand({ KeyId: key, KeySpec: 'AES_256' })),
  );
  const docKey = `documents/tenant-a/d-${Date.now()}`;
  await put(writer, docKey);
  await refusedByKms('4a-ii: TestProbeRole GET documents/tenant-a/d', () => probe.send(new GetObjectCommand({ Bucket: scratch, Key: docKey })));
  const consumer = new S3Client({ region: REGION, credentials: await assume(aid.TestConsumerRoleArn, 'tenant-a') });
  const read = await consumer.send(new GetObjectCommand({ Bucket: scratch, Key: docKey }));
  c.expect(read.$metadata.httpStatusCode === 200, '2b: TestConsumerRole for tenant-a reads documents/tenant-a/d');
  await read.Body?.transformToString();
  await refusedByKms('bucket key: TestScratchWriterRole PUT with bucket-key-enabled true', () => put(writer, `documents/tenant-a/bk-${Date.now()}`, true));

  try {
    await put(probe, `ingest/${w.tenants.A.tenantId}/z-${Date.now()}`, false, w.bucket, w.tenants.A.keyArn);
    c.expect(false, 'TestProbeRole PUT on the ingestion bucket with every header right: succeeded');
  } catch (error) {
    c.expect(!errorMentionsKms(error) && errorName(error) === 'AccessDenied', `TestProbeRole PUT on the ingestion bucket -> ${errorName(error)} (S3)`);
  }

  const [upload, processRole, platform] = w.outputs[DEMO_STACK].TenantRoleArns.split(',');
  const iam = new IAMClient({ region: REGION });
  const tableArn = `arn:aws:dynamodb:${REGION}:${(await sts.send(new GetCallerIdentityCommand({}))).Account}:table/${w.outputs[DEMO_STACK].RegistryTableName}`;
  for (const role of [upload, processRole, platform]) {
    const simulated = await iam.send(
      new SimulatePrincipalPolicyCommand({
        PolicySourceArn: role,
        ActionNames: ['s3:GetObject', 's3:PutObject', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem'],
        ResourceArns: [`arn:aws:s3:::${w.bucket}/ingest/${w.tenants.B.tenantId}/x`, tableArn],
        ContextEntries: [
          { ContextKeyName: 'aws:PrincipalTag/TenantId', ContextKeyType: 'string', ContextKeyValues: [w.tenants.A.tenantId] },
          { ContextKeyName: 'dynamodb:LeadingKeys', ContextKeyType: 'stringList', ContextKeyValues: [`TENANT#${w.tenants.B.tenantId}`] },
          { ContextKeyName: 'dynamodb:Attributes', ContextKeyType: 'stringList', ContextKeyValues: ['keyArn'] },
        ],
      }),
    );
    const allowed = (simulated.EvaluationResults ?? []).filter((r) => r.EvalDecision === 'allowed');
    c.expect(allowed.length === 0, `SimulatePrincipalPolicy ${role.split('/').pop()} as A on B's resources: ${allowed.length} allowed`);
  }
  return { step: '5', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

/** 6. Cross-tenant read. */
async function step6(w: World): Promise<StepResult> {
  const c = new Check();
  const a = w.deliveries.A;
  const b = w.deliveries.B;
  if (a?.landedKey === undefined || b?.landedKey === undefined) {
    return { step: '6', outcome: 'fail', notes: ['needs the landed objects of step 3'] };
  }
  const consumerA = new S3Client({ region: REGION, credentials: await assume(w.outputs[TEST_AID_STACK].TestConsumerRoleArn, a.tenantId) });
  const own = await consumerA.send(new GetObjectCommand({ Bucket: w.bucket, Key: a.landedKey }));
  c.expect(own.$metadata.httpStatusCode === 200, "TestConsumerRole for A reads A's landed object");
  await own.Body?.transformToByteArray();
  try {
    await consumerA.send(new GetObjectCommand({ Bucket: w.bucket, Key: b.landedKey }));
    c.expect(false, "TestConsumerRole for A reads B's object");
  } catch (error) {
    c.expect(errorName(error) === 'AccessDenied' && !errorMentionsKms(error), `TestConsumerRole for A on B's object -> ${errorName(error)} (S3)`);
  }
  const probe = new S3Client({ region: REGION, credentials: await assume(w.outputs[TEST_AID_STACK].TestProbeRoleArn) });
  try {
    await probe.send(new GetObjectCommand({ Bucket: w.bucket, Key: b.landedKey }));
    c.expect(false, "TestProbeRole reads B's object");
  } catch (error) {
    c.expect(errorMentionsKms(error), `TestProbeRole on B's object -> ${errorName(error)} (KMS)`);
  }
  return { step: '6', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

/** 7. Rejections and limits. */
async function step7(w: World): Promise<StepResult> {
  const c = new Check();
  const token = w.tenants.A.token;
  if (token === undefined) {
    return { step: '7', outcome: 'fail', notes: ['no token for A'] };
  }
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
  const mismatch = await deliver(token, zip, 'application/pdf');
  if (mismatch.created.status === 201) {
    const d = await waitFor(token, mismatch.created.json.deliveryId, ['REJECTED', 'ACCEPTED']);
    c.expect(d?.reason === 'structural:TYPE_MISMATCH', `declared PDF, uploaded ZIP -> ${d?.reason}`);
  }
  const oversize = await tenantCall('POST', 'tenant/deliveries', token, { fileName: 'big.pdf', contentType: 'application/pdf', sizeBytes: 200 * 1024 * 1024 });
  c.expect(oversize.status === 400, `oversize declared -> ${oversize.status}`);

  const unused = await tenantCall('POST', 'tenant/deliveries', token, { fileName: 'unused.pdf', contentType: 'application/pdf', sizeBytes: 10 });
  c.note('waiting past the URL TTL (60 s) plus the grace (60 s) for EXPIRED');
  await sleep(130_000);
  await new LambdaClient({ region: REGION }).send(new InvokeCommand({ FunctionName: w.outputs[DEMO_STACK].SweepFunctionName }));
  const expired = await tenantCall('GET', `tenant/deliveries/${unused.json.deliveryId}`, token);
  c.expect(expired.json.delivery?.status === 'EXPIRED', `unused URL after the sweep -> ${expired.json.delivery?.status}`);

  const d = w.tenants.D.token;
  if (d !== undefined) {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await tenantCall('POST', 'tenant/deliveries', d, { fileName: `open-${i}.pdf`, contentType: 'application/pdf', sizeBytes: 10 })).status);
    }
    c.expect(statuses.slice(0, 5).every((s) => s === 201) && statuses[5] === 429, `tenant D six open deliveries -> ${statuses.join(',')}`);
  } else {
    c.note('TODO: tenant D needs a key and a token (CreateTenantKey for D in step 1)');
  }
  return { step: '7', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

/** 7b. Validators. */
async function step7b(w: World): Promise<StepResult> {
  const c = new Check();
  const token = w.tenants.A.token;
  if (token === undefined) {
    return { step: '7b', outcome: 'fail', notes: ['no token for A'] };
  }
  const switchName = w.outputs[DEMO_STACK].TestSwitchParameterName;
  const mode = (value: string) => ssm.send(new PutParameterCommand({ Name: switchName, Value: value, Overwrite: true }));
  await mode('accept');
  const five = await deliver(token, pdf(5));
  if (five.created.status === 201) {
    const d = await waitFor(token, five.created.json.deliveryId, ['REJECTED', 'ACCEPTED']);
    c.expect(d?.reason === 'pdf-pages:TOO_MANY_PAGES', `5-page PDF -> ${d?.reason}`);
    c.expect((d?.validators ?? []).every((v: { validator: string }) => v.validator !== 'test-switch'), 'test-switch not invoked after the REJECT');
  }
  await mode('throw');
  const thrown = await deliver(token, pdf(1));
  if (thrown.created.status === 201) {
    const d = await waitFor(token, thrown.created.json.deliveryId, ['REJECTED', 'ACCEPTED']);
    c.expect(d?.reason === 'test-switch:VALIDATOR_ERROR', `mode throw -> ${d?.reason}`);
  }
  await mode('accept');
  c.note('TODO: the message is in deadLetterQueue (ReceiveMessage on DeadLetterQueueUrl), DeliveryRejected published, no log line holds X-Amz-Signature or a file name (Logs Insights over the stack log groups)');
  return { step: '7b', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

/** 7c, 8, 10, 12: outlined, not yet implemented. */
function todo(step: string, what: string): StepResult {
  return { step, outcome: 'todo', notes: [`TODO: ${what}`] };
}

/** 9. Rotation. */
async function step9(w: World): Promise<StepResult> {
  const c = new Check();
  const a = await signed('POST', `${w.apiUrl}platform/tenants/${w.tenants.A.tenantId}/key/rotate`);
  c.expect(a.status === 200, `RotateTenantKey A -> ${a.status}`);
  if (process.env.INTEG_TENANT_KEY_ARN !== undefined) {
    const b = await signed('POST', `${w.apiUrl}platform/tenants/${w.tenants.B.tenantId}/key/rotate`);
    c.expect(b.status === 400, `RotateTenantKey B (tenant-key) -> ${b.status}`);
  }
  c.note("TODO: step 3's object still reads after the rotation completes");
  return { step: '9', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

/** 11. Offboarding. */
async function step11(w: World): Promise<StepResult> {
  const c = new Check();
  for (const label of ['A', 'B', 'D'] as const) {
    const r = await signed('DELETE', `${w.apiUrl}platform/tenants/${w.tenants[label].tenantId}/key`);
    c.expect([202, 204].includes(r.status), `DeleteTenantKey ${label} -> ${r.status}`);
  }
  const again = await signed('DELETE', `${w.apiUrl}platform/tenants/${w.tenants.A.tenantId}/key`);
  c.expect(again.status === 204, `DeleteTenantKey A again -> ${again.status}`);
  if (w.tenants.A.token !== undefined) {
    const after = await tenantCall('POST', 'tenant/deliveries', w.tenants.A.token, { fileName: 'late.pdf', contentType: 'application/pdf', sizeBytes: 10 });
    c.expect(after.status === 403, `CreateDelivery A after offboarding -> ${after.status} (API key gone)`);
  }
  c.note('TODO: URL in flight -> 403; no version under either A prefix; alias gone; key PendingDeletion; B: key untouched, tombstone written, no alarm');
  return { step: '11', outcome: c.failed ? 'fail' : 'pass', notes: c.notes };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (REGION.length === 0) {
    throw new Error('AWS_REGION is not set');
  }
  const outputs = JSON.parse(readFileSync(OUTPUTS_FILE, 'utf8')) as Record<string, Record<string, string>>;
  const run = Date.now().toString(36);
  WORLD = {
    outputs,
    apiUrl: await param(`${INGESTION_PREFIX}apiUrl`),
    bucket: await param(`${INGESTION_PREFIX}bucketName`),
    identityApi: (await param(`${IDENTITY_PREFIX}apiUrl`)).replace(/\/?$/, '/'),
    tenants: { A: { tenantId: `ta-${run}` }, B: { tenantId: `tb-${run}` }, D: { tenantId: `td-${run}` } },
    deliveries: {},
  };
  const w = WORLD;
  const results: StepResult[] = [];
  const run1 = async (step: string, fn: () => Promise<StepResult> | StepResult) => {
    process.stdout.write(`== step ${step}\n`);
    try {
      const r = await fn();
      results.push(r);
      for (const n of r.notes) {
        process.stdout.write(`   ${n}\n`);
      }
    } catch (error) {
      results.push({ step, outcome: 'fail', notes: [`threw ${errorName(error)}`] });
      process.stdout.write(`   FAIL threw ${errorName(error)}\n`);
    }
  };
  await run1('1', () => step1(w));
  // The key policy and tag changes of step 1 take up to five minutes (spec §10).
  await sleep(KEY_POLICY_WAIT_MS);
  await run1('2', () => step2(w));
  await run1('3', () => step3(w));
  await run1('4', () => step4(w));
  await run1('5', () => step5(w));
  await run1('6', () => step6(w));
  await run1('7', () => step7(w));
  await run1('7b', () => step7b(w));
  await run1('7c', () => todo('7c', 'mode sleep: the processor times out holding the lease; after 2T + 60 s invoke SweepFunctionName -> PROCESSING_ABANDONED, drop gone, event published'));
  await run1('8', () =>
    todo('8', 'mode pause; disable B\'s key while PROCESSING -> KEY_UNAVAILABLE, REVOKED, DeliveryKeyUnavailable, DLQ unchanged, CreateDelivery B 409; re-enable, sweep -> ACTIVE; repeat removing only the use statement (needs the tenantKeyAccount key)'),
  );
  await run1('9', () => step9(w));
  await run1('10', () => todo('10', 'one processor line per delivery with tenantId, status, kmsRequests (Logs Insights); access-log Requester names t-<tenantId>-; kmsRequests matches CloudTrail'));
  await run1('11', () => step11(w));
  await run1('12', () => todo('12', 'teardown is scripts/integ.sh\'s EXIT trap; it lists the keys left pending deletion'));

  process.stdout.write('== results\n');
  for (const r of results) {
    process.stdout.write(`   ${r.step.padEnd(3)} ${r.outcome}\n`);
  }
  if (results.some((r) => r.outcome === 'fail')) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`integ.ingestion: ${errorName(error)}\n`);
    process.exitCode = 1;
  });
}

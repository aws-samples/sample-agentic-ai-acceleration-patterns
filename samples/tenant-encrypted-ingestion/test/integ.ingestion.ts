// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's steps (spec §10), run by `scripts/integ.sh` after
 * it deployed tenant-identity (if absent), the test-aid stack and the demo
 * stack (test/integ/app.ts). One function per step, named and ordered as
 * spec §10 is, so the spec and this file read side by side.
 *
 *   INTEG_OUTPUTS=cdk.integ.out/outputs.json AWS_REGION=... npx ts-node -P tsconfig.json --prefer-ts-exts test/integ.ingestion.ts
 *
 * It uses only what a consumer of the sample could: the published
 * parameters under /application-plane/shared/ingestion/, the demo and
 * test-aid stacks' outputs (the construct's read-only properties, §3.4),
 * the public API, and tenant-identity's own platform API.
 *
 * `TEI_TENANT_KEY_PROFILE` (set by integ.sh with the `tenantKeyAccount`
 * context) names the AWS profile of the second account: tenant B's
 * `tenant-key` key is created, tagged, disabled and re-enabled there, and
 * scheduled for deletion at the end. Without it B is a second `vendor-key`
 * tenant, the revocation steps act on B's vendor key through the account
 * administration statement, and the cross-account claim is not exercised.
 *
 * Step 12 (teardown) is integ.sh's EXIT trap. This driver prints a summary
 * table and exits non-zero on any failed step.
 *
 * Output follows scripts/CONVENTIONS.md: step names, HTTP statuses, tenant
 * ids, delivery ids and error codes; never a token, a presigned URL, a
 * credential, a file name or a log line.
 */

import { readFileSync } from 'node:fs';
import { Sha256 } from '@aws-crypto/sha256-js';
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { CloudWatchClient, DescribeAlarmsCommand, DescribeInsightRulesCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import {
  CreateKeyCommand,
  DescribeKeyCommand,
  DisableKeyCommand,
  EnableKeyCommand,
  GenerateDataKeyCommand,
  GetKeyPolicyCommand,
  KMSClient,
  ListAliasesCommand,
  PutKeyPolicyCommand,
  ScheduleKeyDeletionCommand,
} from '@aws-sdk/client-kms';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ListMessageMoveTasksCommand,
  ReceiveMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import { buildTenantKeyTemplate, type PolicyDocument, type PolicyStatement } from '../src/platform/key-policy';
import { EVENT_SOURCE } from '../src/shared/constants';
import { keyArnItemKey, keyRowKey, tombstoneKey } from '../src/shared/registry';

const REGION = process.env.AWS_REGION ?? '';
const OUTPUTS_FILE = process.env.INTEG_OUTPUTS ?? 'cdk.integ.out/outputs.json';
const TENANT_KEY_PROFILE = process.env.TEI_TENANT_KEY_PROFILE;
const TEST_AID_STACK = 'TenantEncryptedIngestionTestAid';
const DEMO_STACK = 'TenantEncryptedIngestionInteg';
const IDENTITY_PREFIX = '/application-plane/shared/identity/';
const INGESTION_PREFIX = '/application-plane/shared/ingestion/';
/** KMS key policy and tag changes take up to five minutes (spec §7.3, §10). */
const KEY_POLICY_WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 5000;

type Outcome = 'pass' | 'fail' | 'skip';
interface StepResult {
  readonly step: string;
  readonly outcome: Outcome;
  readonly notes: string[];
}

/** The resolved timings of the demo stack (construct `pipelineTiming`). */
interface PipelineTiming {
  readonly processorTimeoutSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly maxReceiveCount: number;
  readonly abandonGraceSeconds: number;
  readonly uploadUrlTtlSeconds: number;
  readonly maxInFlightPerTenant: number;
}

interface Tenant {
  tenantId: string;
  adminUsername?: string;
  token?: string;
  readOnlyToken?: string;
  readOnlyUsername?: string;
  keyArn?: string;
}

/** Where tenant B's key lives and who may change it (step 8). */
interface TenantKeyAccount {
  /** True when B's key is a `tenant-key` key in the second account. */
  readonly crossAccount: boolean;
  /** KMS in the account that administers B's key (the second account, or the test account). */
  readonly kms: KMSClient;
  /** Keys this run created in the second account; scheduled for deletion at the end. */
  readonly createdKeys: string[];
}

/** Everything the steps share, filled as they run. */
interface World {
  readonly outputs: Record<string, Record<string, string>>;
  readonly demo: Record<string, string>;
  readonly aid: Record<string, string>;
  readonly apiUrl: string;
  readonly bucket: string;
  readonly identityApi: string;
  readonly run: string;
  readonly startedAt: number;
  /** Every file name this run uses starts with it, so one log filter finds any that leaked (M-27). */
  readonly fileMarker: string;
  readonly timing: PipelineTiming;
  readonly tenantKey: TenantKeyAccount;
  readonly events: EventCapture;
  readonly tenants: Record<'A' | 'B' | 'D', Tenant>;
  /** Every tenant id this run created in tenant-identity's shared pool; deleted in main()'s finally. */
  readonly identityTenants: string[];
  readonly deliveries: Record<string, { tenantId: string; deliveryId: string; landedKey?: string }>;
}

const credentials = fromNodeProviderChain();
const sts = new STSClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const kms = new KMSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const logsClient = new CloudWatchLogsClient({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });
const cloudtrail = new CloudTrailClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class Check {
  readonly notes: string[] = [];
  failed = false;
  expect(condition: boolean, what: string): boolean {
    this.notes.push(`${condition ? 'ok  ' : 'FAIL'} ${what}`);
    if (!condition) {
      this.failed = true;
    }
    return condition;
  }
  note(what: string): void {
    this.notes.push(`     ${what}`);
  }
  result(step: string): StepResult {
    return { step, outcome: this.failed ? 'fail' : 'pass', notes: this.notes };
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

/**
 * A `/tenant/*` call. tenant-identity's access tokens live five minutes
 * (its offboarding promise), and several steps wait longer than that on
 * TTLs, leases and KMS propagation, so a 401 on a token this run issued is
 * answered by re-issuing that tenant's token and retrying once.
 */
async function tenantCall(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
  const once = async (bearer: string) => {
    const response = await fetch(`${WORLD!.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: safeJson(text) };
  };
  const first = await once(token);
  if (first.status !== 401 || WORLD === undefined) {
    return first;
  }
  const fresh = await reissue(WORLD, token);
  return fresh === undefined ? first : once(fresh);
}

/** Re-issues the token of the tenant user that `token` belonged to; undefined when it is not one of this run's. */
async function reissue(w: World, token: string): Promise<string | undefined> {
  for (const label of ['A', 'B', 'D'] as const) {
    const t = w.tenants[label];
    if (t.token === token && t.adminUsername !== undefined) {
      const issued = await signed('POST', `${w.identityApi}platform/tenants/${t.tenantId}/users/${t.adminUsername}/token`, { password: password() });
      if (issued.status === 200) {
        t.token = issued.json.accessToken;
        return t.token;
      }
    }
    if (t.readOnlyToken === token && t.readOnlyUsername !== undefined) {
      const issued = await signed('POST', `${w.identityApi}platform/tenants/${t.tenantId}/users/${t.readOnlyUsername}/token`, { password: password() });
      if (issued.status === 200) {
        t.readOnlyToken = issued.json.accessToken;
        return t.readOnlyToken;
      }
    }
  }
  return undefined;
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

/** Calls `fn` every `intervalMs` until `done` holds or `timeoutMs` passes; returns the last value. */
async function pollUntil<T>(fn: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, intervalMs = POLL_MS): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (done(value) || Date.now() > until) {
      return value;
    }
    await sleep(intervalMs);
  }
}

/** A tiny PDF of `pages` pages (synthetic). */
function pdf(pages: number): Buffer {
  return Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Pages /Count ${pages} >> endobj\n${'2 0 obj << /Type /Page >> endobj\n'.repeat(pages)}%%EOF\n`);
}

/** A synthetic file name carrying this run's marker. Never printed. */
function fileName(w: World, label: string): string {
  return `${w.fileMarker}-${label}.pdf`;
}

interface Delivered {
  readonly created: { status: number; json: any };
  readonly put?: number;
  /** The S3 error body named KMS (a failed PUT only). */
  readonly putKms?: boolean;
  readonly deliveryId?: string;
}

/**
 * CreateDelivery, then the PUT with the returned headers. With `retryPutMs`
 * a refused PUT is retried on the same URL (no new delivery, so the
 * in-flight count does not grow) until it succeeds or the time is up.
 */
async function deliver(token: string, body: Buffer, name: string, contentType = 'application/pdf', retryPutMs = 0): Promise<Delivered> {
  const created = await tenantCall('POST', 'tenant/deliveries', token, { fileName: name, contentType, sizeBytes: body.length });
  if (created.status !== 201) {
    return { created };
  }
  const until = Date.now() + retryPutMs;
  for (;;) {
    const response = await fetch(created.json.uploadUrl, { method: 'PUT', headers: created.json.headers, body });
    const text = await response.text();
    if (response.status === 200 || Date.now() > until) {
      return { created, put: response.status, putKms: response.status !== 200 && /kms/i.test(text), deliveryId: created.json.deliveryId };
    }
    await sleep(10_000);
  }
}

async function getDelivery(token: string, deliveryId: string): Promise<any> {
  const got = await tenantCall('GET', `tenant/deliveries/${deliveryId}`, token);
  return got.status === 200 ? got.json.delivery : undefined;
}

async function waitFor(token: string, deliveryId: string, statuses: string[], timeoutMs = 180_000): Promise<any> {
  return pollUntil(() => getDelivery(token, deliveryId), (d) => statuses.includes(d?.status), timeoutMs);
}

const TERMINAL = ['ACCEPTED', 'REJECTED', 'KEY_UNAVAILABLE', 'EXPIRED'];

/** How long a delivery may take once uploaded: T plus a margin. */
function processingBudgetMs(w: World): number {
  return (w.timing.processorTimeoutSeconds + 90) * 1000;
}

/** The current versions under `prefix`, listed with the runner's own credentials. */
async function versionCount(bucket: string, prefix: string): Promise<number | string> {
  try {
    let count = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const r = await s3.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
      );
      count += (r.Versions ?? []).length;
      if (r.IsTruncated !== true) {
        return count;
      }
      keyMarker = r.NextKeyMarker;
      versionMarker = r.NextVersionIdMarker;
    }
  } catch (error) {
    return errorName(error);
  }
}

async function dropGone(c: Check, w: World, tenantId: string, deliveryId: string, what: string): Promise<void> {
  const n = await pollUntil(() => versionCount(w.bucket, `ingest/${tenantId}/${deliveryId}`), (v) => v === 0, 60_000);
  c.expect(n === 0, `${what}: drop versions left -> ${n}`);
}

async function setMode(w: World, mode: string): Promise<void> {
  await ssm.send(new PutParameterCommand({ Name: w.demo.TestSwitchParameterName, Value: mode, Overwrite: true }));
}

async function invokeSweep(w: World): Promise<string> {
  const r = await lambda.send(new InvokeCommand({ FunctionName: w.demo.SweepFunctionName }));
  return r.FunctionError ?? 'ok';
}

async function queueDepth(queueUrl: string): Promise<number> {
  const r = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
  );
  return Number(r.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

/**
 * The `Delivery*` events, read from the test-aid capture queue (a rule on
 * the construct's bus). Every message read is kept and deleted, so a later
 * step still finds an event an earlier poll drained.
 */
class EventCapture {
  private readonly seen: { type: string; source: string; detail: Record<string, unknown> }[] = [];
  constructor(private readonly queueUrl: string) {}

  async drain(): Promise<void> {
    for (;;) {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
      const messages = r.Messages ?? [];
      if (messages.length === 0) {
        return;
      }
      for (const m of messages) {
        const event = safeJson(m.Body ?? '');
        this.seen.push({ type: event['detail-type'] ?? '', source: event.source ?? '', detail: event.detail ?? {} });
        await sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: m.ReceiptHandle! }));
      }
    }
  }

  of(deliveryId: string, type?: string) {
    return this.seen.filter((e) => e.detail.deliveryId === deliveryId && (type === undefined || e.type === type));
  }

  async waitFor(deliveryId: string, type: string, timeoutMs = 90_000) {
    const found = await pollUntil(
      async () => {
        await this.drain();
        return this.of(deliveryId, type);
      },
      (events) => events.length > 0,
      timeoutMs,
    );
    return found;
  }
}

/** The log groups of the construct (`logGroups`, §3.4), by writer. */
function logGroups(w: World): Record<string, string> {
  return JSON.parse(w.demo.LogGroupNames) as Record<string, string>;
}

/** Log events matching `pattern` in `group` since the run started (at most `pages` pages). */
async function filterLogs(w: World, group: string, pattern: string, pages = 20): Promise<string[] | string> {
  const messages: string[] = [];
  let nextToken: string | undefined;
  try {
    for (let i = 0; i < pages; i++) {
      const r = await logsClient.send(new FilterLogEventsCommand({ logGroupName: group, filterPattern: pattern, startTime: w.startedAt, nextToken }));
      messages.push(...(r.events ?? []).map((e) => e.message ?? ''));
      nextToken = r.nextToken;
      if (nextToken === undefined) {
        break;
      }
    }
    return messages;
  } catch (error) {
    return errorName(error);
  }
}

/** M-27: no log line of any construct log group holds a signature or one of this run's file names. */
async function scanLogsForLeaks(c: Check, w: World, label: string): Promise<void> {
  for (const [writer, group] of Object.entries(logGroups(w))) {
    for (const [what, pattern] of [
      ['X-Amz-Signature', '"X-Amz-Signature"'],
      ['a test file name', `"${w.fileMarker}"`],
    ] as const) {
      const hits = await filterLogs(w, group, pattern);
      c.expect(Array.isArray(hits) && hits.length === 0, `${label}: ${writer} log lines holding ${what} -> ${Array.isArray(hits) ? hits.length : hits}`);
    }
  }
}

/** A `delivery processed` line for `deliveryId`, as the logger or Lambda's JSON format wrote it. */
function processedLines(messages: string[], deliveryId: string): Record<string, unknown>[] {
  return messages
    .map((m) => safeJson(m))
    .map((line) => (typeof line.message === 'object' && line.message !== null ? line.message : line))
    .filter((line) => line.message === 'delivery processed' && line.deliveryId === deliveryId);
}

// ---- tenant B's key (steps 1, 8, 11) ----------------------------------------

async function keyPolicy(keyArn: string): Promise<PolicyDocument> {
  const r = await WORLD!.tenantKey.kms.send(new GetKeyPolicyCommand({ KeyId: keyArn, PolicyName: 'default' }));
  return JSON.parse(r.Policy ?? '{}') as PolicyDocument;
}

/** Retries a KMS administration call that a fresh key-policy grant may not admit yet (up to five minutes). */
async function kmsAdmin(what: string, call: () => Promise<unknown>): Promise<string> {
  const until = Date.now() + KEY_POLICY_WAIT_MS;
  for (;;) {
    try {
      await call();
      return 'ok';
    } catch (error) {
      if (errorName(error) !== 'AccessDeniedException' || Date.now() > until) {
        return `${what}: ${errorName(error)}`;
      }
      await sleep(15_000);
    }
  }
}

async function putKeyPolicy(keyArn: string, policy: PolicyDocument): Promise<string> {
  return kmsAdmin('PutKeyPolicy', () => WORLD!.tenantKey.kms.send(new PutKeyPolicyCommand({ KeyId: keyArn, PolicyName: 'default', Policy: JSON.stringify(policy) })));
}

const disableKey = (keyArn: string) => kmsAdmin('DisableKey', () => WORLD!.tenantKey.kms.send(new DisableKeyCommand({ KeyId: keyArn })));
const enableKey = (keyArn: string) => kmsAdmin('EnableKey', () => WORLD!.tenantKey.kms.send(new EnableKeyCommand({ KeyId: keyArn })));

function actions(s: PolicyStatement): string[] {
  return Array.isArray(s.Action) ? s.Action : [s.Action];
}

/** The policy without its use statement (statement 2: GenerateDataKey and Decrypt via S3), DescribeKey kept. */
function withoutUseStatement(policy: PolicyDocument): PolicyDocument {
  return {
    ...policy,
    Statement: policy.Statement.filter((s) => !(s.Effect === 'Allow' && actions(s).includes('kms:GenerateDataKey') && s.Principal !== '*' && !actions(s).includes('kms:*'))),
  };
}

/**
 * The vendor-key fallback: the account administration statement (§7.2
 * statement 3) holds no `DisableKey`/`EnableKey`, so the test adds them for
 * the account (a test-only PutKeyPolicy, which the PutKeyPolicy alarm sees).
 */
function withAccountDisable(policy: PolicyDocument): PolicyDocument {
  return {
    ...policy,
    Statement: policy.Statement.map((s) =>
      s.Sid === 'AccountAdministration' ? { ...s, Action: [...new Set([...actions(s), 'kms:DisableKey', 'kms:EnableKey'])] } : s,
    ),
  };
}

async function getTenantKey(w: World, tenantId: string): Promise<{ status: number; keyStatus?: string }> {
  const r = await signed('GET', `${w.apiUrl}platform/tenants/${tenantId}/key`);
  return { status: r.status, keyStatus: r.json.key?.keyStatus };
}

/** Sweep, then GetTenantKey, until the key row is ACTIVE (five minutes, early exit). */
async function sweepUntilActive(w: World, tenantId: string): Promise<string | undefined> {
  const r = await pollUntil(
    async () => {
      await invokeSweep(w);
      return getTenantKey(w, tenantId);
    },
    (k) => k.keyStatus === 'ACTIVE',
    KEY_POLICY_WAIT_MS,
    20_000,
  );
  return r.keyStatus;
}

let WORLD: World | undefined;

// ---------------------------------------------------------------------------
// steps (spec §10)
// ---------------------------------------------------------------------------

/** 0. Prelude: the three tenants in tenant-identity, whose ids the tokens carry. */
async function step0(w: World): Promise<StepResult> {
  const c = new Check();
  for (const label of ['A', 'B', 'D'] as const) {
    const created = await signed('POST', `${w.identityApi}platform/tenants`, {
      name: `tei-integ-${label}-${w.run}`,
      adminEmail: `success+tei-${label.toLowerCase()}-${w.run}@simulator.amazonses.com`,
      scopes: ['ingestion/deliver', 'ingestion/read'],
    });
    c.expect(created.status === 201, `tenant-identity CreateTenant ${label} -> ${created.status}`);
    const tenantId = created.json.tenant?.tenantId;
    if (typeof tenantId === 'string' && tenantId.length > 0) {
      w.identityTenants.push(tenantId);
    }
    if (typeof tenantId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{1,34}$/.test(tenantId)) {
      c.expect(false, `tenant-identity tenant id for ${label} matches spec §7.0`);
      continue;
    }
    w.tenants[label].tenantId = tenantId;
    w.tenants[label].adminUsername = created.json.admin?.user?.username;
    c.note(`tenant ${label} = ${tenantId}`);
  }
  return c.result('0');
}

/** 1. Two tenants, two tiers. */
async function step1(w: World): Promise<StepResult> {
  const c = new Check();
  const platform = `${w.apiUrl}platform/tenants`;
  const a = w.tenants.A.tenantId;
  const created = await signed('POST', `${platform}/${a}/key`, { tier: 'vendor-key' });
  c.expect(created.status === 201, `CreateTenantKey ${a} vendor-key -> ${created.status}`);
  w.tenants.A.keyArn = created.json.key?.keyArn;
  const got = await getTenantKey(w, a);
  c.expect(got.keyStatus === 'ACTIVE', `GetTenantKey ${a} -> ${got.keyStatus}`);
  const again = await signed('POST', `${platform}/${a}/key`, { tier: 'vendor-key' });
  c.expect(again.status === 409, `CreateTenantKey ${a} again -> ${again.status}`);
  const probes = await versionCount(w.bucket, `ingest/${a}/_probe/`);
  c.expect(probes === 0, `probe versions left under ingest/${a}/_probe/ -> ${probes}`);

  const vendorAccountKey = await signed('POST', `${platform}/tc-${w.run}/key`, { tier: 'tenant-key', keyArn: w.tenants.A.keyArn });
  const b = w.tenants.B.tenantId;
  if (w.tenantKey.crossAccount) {
    c.expect(vendorAccountKey.status === 422, `CreateTenantKey tc-${w.run} tenant-key with a key in the vendor account -> ${vendorAccountKey.status} ${vendorAccountKey.json.code ?? ''}`);
    const tenantSts = new STSClient({ region: REGION, credentials: fromIni({ profile: TENANT_KEY_PROFILE }) });
    const tenantAccount = (await tenantSts.send(new GetCallerIdentityCommand({}))).Account!;
    const template = (tenantId: string) =>
      buildTenantKeyTemplate({
        tenantAccount,
        region: REGION,
        bucket: w.bucket,
        tenantId,
        tenantRoleArns: w.demo.TenantRoleArns.split(','),
        consumerRoleArns: [w.aid.TestConsumerRoleArn],
      });
    const createKey = async (tenantId: string, tag: string | undefined) => {
      const r = await w.tenantKey.kms.send(
        new CreateKeyCommand({
          Description: `tenant-encrypted-ingestion integ ${w.run}: tenant-key for ${tenantId}`,
          KeySpec: 'SYMMETRIC_DEFAULT',
          KeyUsage: 'ENCRYPT_DECRYPT',
          MultiRegion: false,
          Policy: JSON.stringify(template(tenantId)),
          ...(tag !== undefined ? { Tags: [{ TagKey: 'TenantId', TagValue: tag }] } : {}),
        }),
      );
      w.tenantKey.createdKeys.push(r.KeyMetadata!.Arn!);
      return r.KeyMetadata!.Arn!;
    };
    const bKey = await createKey(b, b);
    const untagged = await createKey(`tx-${w.run}`, undefined);
    const wrongTag = await createKey(`ty-${w.run}`, `other-${w.run}`);
    // The new key's tag and policy take up to five minutes: retry until admitted, early exit.
    const bk = await pollUntil(() => signed('POST', `${platform}/${b}/key`, { tier: 'tenant-key', keyArn: bKey }), (r) => r.status !== 422, KEY_POLICY_WAIT_MS, 20_000);
    c.expect(bk.status === 201, `CreateTenantKey ${b} tenant-key (second account) -> ${bk.status} ${bk.json.code ?? ''}`);
    w.tenants.B.keyArn = bKey;
    const bRow = await getTenantKey(w, b);
    c.expect(bRow.keyStatus === 'ACTIVE', `GetTenantKey ${b} -> ${bRow.keyStatus}`);
    const bProbes = await versionCount(w.bucket, `ingest/${b}/_probe/`);
    c.expect(bProbes === 0, `probe versions left under ingest/${b}/_probe/ -> ${bProbes}`);
    // B's key admitted means the account's tag and policy changes propagated; the negatives now fail on the tag alone.
    const u = await signed('POST', `${platform}/tx-${w.run}/key`, { tier: 'tenant-key', keyArn: untagged });
    c.expect(u.status === 422, `CreateTenantKey tx-${w.run} with an untagged key -> ${u.status} ${u.json.code ?? ''}`);
    const t = await signed('POST', `${platform}/ty-${w.run}/key`, { tier: 'tenant-key', keyArn: wrongTag });
    c.expect(t.status === 422, `CreateTenantKey ty-${w.run} with a key tagged for another tenant -> ${t.status} ${t.json.code ?? ''}`);
    const taken = await signed('POST', `${platform}/tc-${w.run}/key`, { tier: 'tenant-key', keyArn: bKey });
    // The identity policy's tag check (B's tag, tc's session) refuses before the KEYARN# uniqueness check can: 422; the 409 branch is a unit test.
    c.expect(taken.status === 422 || taken.status === 409, `CreateTenantKey tc-${w.run} with B's keyArn -> ${taken.status} (422 tag check first, or 409 uniqueness)`);
  } else {
    c.expect(vendorAccountKey.status === 400, `CreateTenantKey tc-${w.run} tenant-key without tenantKeyAccount -> ${vendorAccountKey.status} ${vendorAccountKey.json.code ?? ''} (UnsupportedInDeployment)`);
    c.note('no TEI_TENANT_KEY_PROFILE: B is a second vendor-key tenant; the cross-account claim and the tenant-key 422s are NOT exercised in this run');
    const bk = await signed('POST', `${platform}/${b}/key`, { tier: 'vendor-key' });
    c.expect(bk.status === 201, `CreateTenantKey ${b} vendor-key (no second account) -> ${bk.status}`);
    w.tenants.B.keyArn = bk.json.key?.keyArn;
  }
  const d = await signed('POST', `${platform}/${w.tenants.D.tenantId}/key`, { tier: 'vendor-key' });
  c.expect(d.status === 201, `CreateTenantKey ${w.tenants.D.tenantId} vendor-key (the step 7 limit tenant) -> ${d.status}`);
  return c.result('1');
}

const password = () => `Tei-${Math.random().toString(36).slice(2)}A1!`;

/**
 * Access tokens live one hour and the run is longer (steps 7 to 8 wait on
 * TTLs, leases and KMS propagation), so the long steps re-issue the admin
 * tokens first. tenant-identity's IssueToken test aid sets the password.
 */
async function refreshTokens(w: World, c: Check): Promise<void> {
  for (const label of ['A', 'B', 'D'] as const) {
    const t = w.tenants[label];
    if (t.adminUsername === undefined) {
      continue;
    }
    const issued = await signed('POST', `${w.identityApi}platform/tenants/${t.tenantId}/users/${t.adminUsername}/token`, { password: password() });
    if (issued.status === 200) {
      t.token = issued.json.accessToken;
    } else {
      c.note(`token refresh ${label} -> ${issued.status}`);
    }
  }
}

/** 2. Users and tokens from tenant-identity (its IssueToken test aid). */
async function step2(w: World): Promise<StepResult> {
  const c = new Check();
  for (const label of ['A', 'B', 'D'] as const) {
    const t = w.tenants[label];
    const issued = await signed('POST', `${w.identityApi}platform/tenants/${t.tenantId}/users/${t.adminUsername}/token`, { password: password() });
    c.expect(issued.status === 200, `IssueToken ${label} (both scopes) -> ${issued.status}`);
    t.token = issued.json.accessToken;
  }
  // A second user of A holding ingestion/read only (tenant-identity ADR-0036).
  const a = w.tenants.A.tenantId;
  const user = await signed('POST', `${w.identityApi}platform/tenants/${a}/users`, { email: `success+tei-a-ro-${w.run}@simulator.amazonses.com` });
  c.expect(user.status === 201, `CreateUser read-only user of A -> ${user.status}`);
  const username = user.json.user?.username;
  if (username !== undefined) {
    const scoped = await signed('PATCH', `${w.identityApi}platform/tenants/${a}/users/${username}`, { scopes: ['ingestion/read'] });
    c.expect(scoped.status === 200, `UpdateUser scopes [ingestion/read] -> ${scoped.status}`);
    const issued = await signed('POST', `${w.identityApi}platform/tenants/${a}/users/${username}/token`, { password: password() });
    c.expect(issued.status === 200, `IssueToken read-only user of A -> ${issued.status}`);
    w.tenants.A.readOnlyToken = issued.json.accessToken;
    w.tenants.A.readOnlyUsername = username;
  }
  return c.result('2');
}

/** 3. Happy path. */
async function step3(w: World): Promise<StepResult> {
  const c = new Check();
  for (const label of ['A', 'B'] as const) {
    const t = w.tenants[label];
    if (t.token === undefined) {
      c.expect(false, `no token for ${label}`);
      continue;
    }
    const name = fileName(w, `case-${label}`);
    const { created, put, deliveryId } = await deliver(t.token, pdf(2), name);
    c.expect(created.status === 201, `CreateDelivery ${label} -> ${created.status}`);
    c.expect(put === 200, `PUT ${label} -> ${put}`);
    if (deliveryId === undefined) {
      continue;
    }
    const delivery = await waitFor(t.token, deliveryId, TERMINAL, processingBudgetMs(w));
    c.expect(delivery?.status === 'ACCEPTED', `delivery ${label} ${deliveryId} -> ${delivery?.status} ${delivery?.reason ?? ''}`);
    w.deliveries[label] = { tenantId: t.tenantId, deliveryId, landedKey: delivery?.landedKey };
    if (delivery?.landedKey !== undefined) {
      const consumer = new S3Client({ region: REGION, credentials: await assume(w.aid.TestConsumerRoleArn, t.tenantId) });
      const landed = await consumer.send(new GetObjectCommand({ Bucket: w.bucket, Key: delivery.landedKey }));
      c.expect(landed.SSEKMSKeyId === t.keyArn, `landed ${label} encrypted with the tenant key`);
      c.expect(landed.BucketKeyEnabled !== true, `landed ${label} without a bucket key`);
      c.expect((landed.ContentDisposition ?? '').includes(name), `landed ${label} Content-Disposition names the file`);
      await landed.Body?.transformToByteArray();
    }
    const accepted = await w.events.waitFor(deliveryId, 'DeliveryAccepted');
    await sleep(10_000);
    await w.events.drain();
    const all = w.events.of(deliveryId, 'DeliveryAccepted');
    c.expect(accepted.length > 0 && all.length === 1, `DeliveryAccepted events for ${label} -> ${all.length}`);
    const detail = JSON.stringify(all[0]?.detail ?? {});
    c.expect(all.length > 0 && all[0].source === EVENT_SOURCE && !/arn:aws[a-z-]*:kms:/.test(detail) && !detail.includes('keyArn'), `DeliveryAccepted ${label} carries no key ARN`);
    await dropGone(c, w, t.tenantId, deliveryId, `delivery ${label}`);
  }

  // Read-only token: deliver is refused, read is served, within the authoriser cache TTL.
  const ro = w.tenants.A.readOnlyToken;
  const aDelivery = w.deliveries.A?.deliveryId;
  if (ro === undefined || aDelivery === undefined) {
    c.expect(false, 'read-only token and an A delivery are needed');
  } else {
    const create = await tenantCall('POST', 'tenant/deliveries', ro, { fileName: fileName(w, 'ro'), contentType: 'application/pdf', sizeBytes: 10 });
    c.expect(create.status === 403, `read-only token CreateDelivery -> ${create.status}`);
    const read = await tenantCall('GET', `tenant/deliveries/${aDelivery}`, ro);
    c.expect(read.status === 200, `read-only token GetDelivery -> ${read.status}`);
  }
  return c.result('3');
}

/** 4. The uploader cannot change the request. */
async function step4(w: World): Promise<StepResult> {
  const c = new Check();
  const token = w.tenants.A.token;
  if (token === undefined) {
    return { step: '4', outcome: 'fail', notes: ['no token for A'] };
  }
  const body = pdf(1);
  const created = await tenantCall('POST', 'tenant/deliveries', token, { fileName: fileName(w, 'tamper'), contentType: 'application/pdf', sizeBytes: body.length });
  c.expect(created.status === 201, `CreateDelivery -> ${created.status}`);
  if (created.status !== 201) {
    return c.result('4');
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
  return c.result('4');
}

/** 5. Each key-policy wall alone, against the mistaken Allow. */
async function step5(w: World): Promise<StepResult> {
  const c = new Check();
  const scratch = w.aid.ScratchBucketName;
  const key = w.aid.ScratchKeyArn;
  const probe = new S3Client({ region: REGION, credentials: await assume(w.aid.TestProbeRoleArn) });
  const writer = new S3Client({ region: REGION, credentials: await assume(w.aid.TestScratchWriterRoleArn) });
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
  const consumer = new S3Client({ region: REGION, credentials: await assume(w.aid.TestConsumerRoleArn, 'tenant-a') });
  const read = await consumer.send(new GetObjectCommand({ Bucket: scratch, Key: docKey }));
  c.expect(read.$metadata.httpStatusCode === 200, '2b: TestConsumerRole for tenant-a reads documents/tenant-a/d');
  await read.Body?.transformToString();
  await refusedByKms('bucket key: TestScratchWriterRole PUT with bucket-key-enabled true', () => put(writer, `documents/tenant-a/bk-${Date.now()}`, true));

  // On the ingestion bucket both walls refuse TestProbeRole. S3 asks KMS for
  // the data key before it evaluates the bucket policy, so a PUT naming A's
  // key is answered by A's key policy (4a-i); the principal-scoped bucket
  // Deny is isolated with the AWS managed aws/s3 key, which the probe may use.
  await refusedByKms('TestProbeRole PUT ingest/A with A\'s key (key policy answers first)', () =>
    put(probe, `ingest/${w.tenants.A.tenantId}/z-${Date.now()}`, false, w.bucket, w.tenants.A.keyArn),
  );
  for (const prefix of ['ingest', 'documents'] as const) {
    try {
      await probe.send(
        new PutObjectCommand({ Bucket: w.bucket, Key: `${prefix}/${w.tenants.A.tenantId}/z-${Date.now()}`, Body: 'x', ServerSideEncryption: 'aws:kms', IfNoneMatch: prefix === 'ingest' ? '*' : undefined }),
      );
      c.expect(false, `TestProbeRole PUT ${prefix}/A with the aws/s3 key: succeeded`);
    } catch (error) {
      c.expect(!errorMentionsKms(error) && errorName(error) === 'AccessDenied', `TestProbeRole PUT ${prefix}/A with the aws/s3 key -> ${errorName(error)} (${errorMentionsKms(error) ? 'KMS' : 'S3, the principal-scoped Deny'})`);
    }
  }

  const [upload, processRole, platform] = w.demo.TenantRoleArns.split(',');
  const iam = new IAMClient({ region: REGION });
  const tableArn = `arn:aws:dynamodb:${REGION}:${(await sts.send(new GetCallerIdentityCommand({}))).Account}:table/${w.demo.RegistryTableName}`;
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
  return c.result('5');
}

/** 6. Cross-tenant read. */
async function step6(w: World): Promise<StepResult> {
  const c = new Check();
  const a = w.deliveries.A;
  const b = w.deliveries.B;
  if (a?.landedKey === undefined || b?.landedKey === undefined) {
    return { step: '6', outcome: 'fail', notes: ['needs the landed objects of step 3'] };
  }
  const consumerA = new S3Client({ region: REGION, credentials: await assume(w.aid.TestConsumerRoleArn, a.tenantId) });
  const own = await consumerA.send(new GetObjectCommand({ Bucket: w.bucket, Key: a.landedKey }));
  c.expect(own.$metadata.httpStatusCode === 200, "TestConsumerRole for A reads A's landed object");
  await own.Body?.transformToByteArray();
  try {
    await consumerA.send(new GetObjectCommand({ Bucket: w.bucket, Key: b.landedKey }));
    c.expect(false, "TestConsumerRole for A reads B's object");
  } catch (error) {
    c.expect(errorName(error) === 'AccessDenied' && !errorMentionsKms(error), `TestConsumerRole for A on B's object -> ${errorName(error)} (S3)`);
  }
  const probe = new S3Client({ region: REGION, credentials: await assume(w.aid.TestProbeRoleArn) });
  try {
    await probe.send(new GetObjectCommand({ Bucket: w.bucket, Key: b.landedKey }));
    c.expect(false, "TestProbeRole reads B's object");
  } catch (error) {
    c.expect(errorMentionsKms(error), `TestProbeRole on B's object -> ${errorName(error)} (KMS)`);
  }
  return c.result('6');
}

/** 7. Rejections and limits. */
async function step7(w: World): Promise<StepResult> {
  const c = new Check();
  const token = w.tenants.A.token;
  if (token === undefined) {
    return { step: '7', outcome: 'fail', notes: ['no token for A'] };
  }
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
  const mismatch = await deliver(token, zip, fileName(w, 'zip'), 'application/pdf');
  if (mismatch.deliveryId !== undefined) {
    const d = await waitFor(token, mismatch.deliveryId, TERMINAL, processingBudgetMs(w));
    c.expect(d?.reason === 'structural:TYPE_MISMATCH', `declared PDF, uploaded ZIP -> ${d?.reason}`);
  } else {
    c.expect(false, `declared PDF, uploaded ZIP: CreateDelivery ${mismatch.created.status} PUT ${mismatch.put}`);
  }
  const oversize = await tenantCall('POST', 'tenant/deliveries', token, { fileName: fileName(w, 'big'), contentType: 'application/pdf', sizeBytes: 200 * 1024 * 1024 });
  c.expect(oversize.status === 400, `oversize declared -> ${oversize.status}`);

  const unused = await tenantCall('POST', 'tenant/deliveries', token, { fileName: fileName(w, 'unused'), contentType: 'application/pdf', sizeBytes: 10 });
  c.expect(unused.status === 201, `CreateDelivery (never uploaded) -> ${unused.status}`);
  const waitMs = (w.timing.uploadUrlTtlSeconds + w.timing.abandonGraceSeconds + 15) * 1000;
  c.note(`waiting past the URL TTL (${w.timing.uploadUrlTtlSeconds} s) plus the grace (${w.timing.abandonGraceSeconds} s) for EXPIRED`);
  await sleep(waitMs);
  const expired = await pollUntil(
    async () => {
      await invokeSweep(w);
      return getDelivery(token, unused.json.deliveryId);
    },
    (d) => d?.status === 'EXPIRED',
    60_000,
    20_000,
  );
  c.expect(expired?.status === 'EXPIRED', `unused URL after the sweep -> ${expired?.status}`);

  const d = w.tenants.D.token;
  if (d === undefined) {
    c.expect(false, 'tenant D has no token');
  } else {
    const statuses: number[] = [];
    for (let i = 0; i < w.timing.maxInFlightPerTenant + 1; i++) {
      statuses.push((await tenantCall('POST', 'tenant/deliveries', d, { fileName: fileName(w, `open-${i}`), contentType: 'application/pdf', sizeBytes: 10 })).status);
    }
    const n = w.timing.maxInFlightPerTenant;
    c.expect(statuses.slice(0, n).every((s) => s === 201) && statuses[n] === 429, `tenant D ${n + 1} open deliveries -> ${statuses.join(',')}`);
  }
  return c.result('7');
}

/** 7b. Validators. */
async function step7b(w: World): Promise<StepResult> {
  const c = new Check();
  await refreshTokens(w, c);
  const t = w.tenants.A;
  if (t.token === undefined) {
    return { step: '7b', outcome: 'fail', notes: ['no token for A'] };
  }
  try {
    await setMode(w, 'accept');
    const five = await deliver(t.token, pdf(5), fileName(w, 'five'));
    if (five.deliveryId !== undefined) {
      const d = await waitFor(t.token, five.deliveryId, TERMINAL, processingBudgetMs(w));
      c.expect(d?.reason === 'pdf-pages:TOO_MANY_PAGES', `5-page PDF -> ${d?.reason}`);
      c.expect((d?.validators ?? []).every((v: { validator: string }) => v.validator !== 'test-switch'), 'test-switch not invoked after the REJECT');
    } else {
      c.expect(false, `5-page PDF: CreateDelivery ${five.created.status} PUT ${five.put}`);
    }

    const dlqBefore = await queueDepth(w.demo.DeadLetterQueueUrl);
    await setMode(w, 'throw');
    const thrown = await deliver(t.token, pdf(1), fileName(w, 'throw'));
    if (thrown.deliveryId === undefined) {
      c.expect(false, `mode throw: CreateDelivery ${thrown.created.status} PUT ${thrown.put}`);
      return c.result('7b');
    }
    const id = thrown.deliveryId;
    const d = await waitFor(t.token, id, TERMINAL, processingBudgetMs(w));
    c.expect(d?.reason === 'test-switch:VALIDATOR_ERROR', `mode throw, last receive -> ${d?.reason}`);
    await setMode(w, 'accept');
    await dropGone(c, w, t.tenantId, id, 'mode throw');
    const rejected = await w.events.waitFor(id, 'DeliveryRejected');
    c.expect(rejected.length === 1 && rejected[0].detail.reason === 'test-switch:VALIDATOR_ERROR', `DeliveryRejected for ${id} -> ${rejected.length}`);

    // The thrown receive returns to the queue after the visibility timeout, then moves to the DLQ (maxReceiveCount 1).
    const dropKey = `ingest/${t.tenantId}/${id}`;
    c.note(`waiting up to the visibility timeout (${w.timing.visibilityTimeoutSeconds} s) for the DLQ move`);
    const inDlq = await pollUntil(
      async () => {
        const r = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: w.demo.DeadLetterQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 5, VisibilityTimeout: 1 }),
        );
        return (r.Messages ?? []).some((m) => safeJson(m.Body ?? '').detail?.object?.key === dropKey);
      },
      (found) => found,
      (w.timing.visibilityTimeoutSeconds + 180) * 1000,
      10_000,
    );
    c.expect(inDlq, `the delivery's Object Created message is in deadLetterQueue (DLQ depth before ${dlqBefore})`);

    // Redrive under the redriveOperatorRole, which the queue's Deny exempts (§7.7).
    if (inDlq) {
      await sleep(5000);
      const operator = new SQSClient({ region: REGION, credentials: await assume(w.aid.TestRedriveOperatorRoleArn) });
      try {
        await operator.send(new StartMessageMoveTaskCommand({ SourceArn: w.demo.DeadLetterQueueArn, DestinationArn: w.demo.QueueArn }));
        const task = await pollUntil(
          async () => (await operator.send(new ListMessageMoveTasksCommand({ SourceArn: w.demo.DeadLetterQueueArn, MaxResults: 1 }))).Results?.[0],
          (r) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(r?.Status ?? ''),
          180_000,
          10_000,
        );
        c.expect(task?.Status === 'COMPLETED' && (task.ApproximateNumberOfMessagesMoved ?? 0) >= 1, `StartMessageMoveTask as redriveOperatorRole -> ${task?.Status} moved ${task?.ApproximateNumberOfMessagesMoved ?? 0}${task?.FailureReason !== undefined ? ` ${task.FailureReason}` : ''}`);
      } catch (error) {
        c.expect(false, `StartMessageMoveTask as redriveOperatorRole -> ${errorName(error)}`);
      }
      await sleep(30_000);
      const after = await getDelivery(t.token, id);
      c.expect(after?.status === 'REJECTED' && after?.reason === 'test-switch:VALIDATOR_ERROR', `after the redrive the row stays ${after?.status} ${after?.reason ?? ''}`);
    }
    await scanLogsForLeaks(c, w, '7b');
  } finally {
    await setMode(w, 'accept');
  }
  return c.result('7b');
}

/** 7c. Abandoned lease. */
async function step7c(w: World): Promise<StepResult> {
  const c = new Check();
  await refreshTokens(w, c);
  const t = w.tenants.A;
  if (t.token === undefined) {
    return { step: '7c', outcome: 'fail', notes: ['no token for A'] };
  }
  const T = w.timing.processorTimeoutSeconds;
  try {
    await setMode(w, 'sleep');
    const sent = await deliver(t.token, pdf(1), fileName(w, 'sleep'));
    if (sent.deliveryId === undefined) {
      c.expect(false, `mode sleep: CreateDelivery ${sent.created.status} PUT ${sent.put}`);
      return c.result('7c');
    }
    const id = sent.deliveryId;
    const leased = await waitFor(t.token, id, ['PROCESSING', ...TERMINAL], 90_000);
    c.expect(leased?.status === 'PROCESSING', `mode sleep -> ${leased?.status} (the processor holds the lease)`);
    const leasedAt = Date.now();
    // The lease runs out T after it was taken; the sweep abandons it maxReceiveCount × visibility + grace later (§8).
    const abandonAfterMs = (T + w.timing.maxReceiveCount * w.timing.visibilityTimeoutSeconds + w.timing.abandonGraceSeconds + 30) * 1000;
    c.note(`waiting ${Math.round(abandonAfterMs / 1000)} s: the processor times out (T = ${T} s), then the abandon threshold passes`);
    const mid = await pollUntil(() => getDelivery(t.token!, id), (d) => d?.status !== 'PROCESSING', T * 1000 + 30_000, 30_000);
    c.expect(mid?.status === 'PROCESSING', `after T the row is still ${mid?.status} (the processor timed out holding the lease)`);
    await sleep(Math.max(0, leasedAt + abandonAfterMs - Date.now()));
    const abandoned = await pollUntil(
      async () => {
        const fault = await invokeSweep(w);
        if (fault !== 'ok') {
          c.note(`sweep invoke -> ${fault}`);
        }
        return getDelivery(t.token!, id);
      },
      (d) => d?.status !== 'PROCESSING',
      120_000,
      20_000,
    );
    c.expect(abandoned?.status === 'REJECTED' && abandoned?.reason === 'structural:PROCESSING_ABANDONED', `sweepFunction -> ${abandoned?.status} ${abandoned?.reason ?? ''}`);
    await dropGone(c, w, t.tenantId, id, 'abandoned');
    const rejected = await w.events.waitFor(id, 'DeliveryRejected');
    c.expect(rejected.length === 1 && rejected[0].detail.reason === 'structural:PROCESSING_ABANDONED', `DeliveryRejected for ${id} -> ${rejected.length}`);
  } finally {
    await setMode(w, 'accept');
  }
  return c.result('7c');
}

/** 8. Revocation, decided by the probe. */
async function step8(w: World): Promise<StepResult> {
  const c = new Check();
  await refreshTokens(w, c);
  const t = w.tenants.B;
  const keyArn = t.keyArn;
  if (t.token === undefined || keyArn === undefined) {
    return { step: '8', outcome: 'fail', notes: ['no token or key for B'] };
  }
  const token = t.token;
  const tenantId = t.tenantId;
  const putRetryMs = (w.timing.uploadUrlTtlSeconds - 20) * 1000;
  let restore: PolicyDocument | undefined;
  try {
    if (w.tenantKey.crossAccount) {
      c.note('B holds a tenant-key key in the second account; the test changes it under that account');
    } else {
      c.note('no second account: the test changes B\'s vendor key; it first grants the account DisableKey/EnableKey (a PutKeyPolicy the alarm sees)');
      restore = await keyPolicy(keyArn);
      c.expect((await putKeyPolicy(keyArn, withAccountDisable(restore))) === 'ok', 'PutKeyPolicy granting the account DisableKey/EnableKey');
    }
    const dlqBefore = await queueDepth(w.demo.DeadLetterQueueUrl);

    // (a) Key disabled before the upload: CreateDelivery still 201 (no KMS call), the PUT fails on KMS.
    c.expect((await disableKey(keyArn)) === 'ok', 'DisableKey B before the upload');
    await sleep(20_000);
    const early = await deliver(token, pdf(1), fileName(w, 'disabled'));
    c.expect(early.created.status === 201, `(a) CreateDelivery B with the key disabled -> ${early.created.status}`);
    c.expect([400, 403].includes(early.put ?? 0) && early.putKms === true, `(a) PUT with the key disabled -> ${early.put} (KMS error: ${early.putKms === true})`);
    if (early.put !== undefined && early.put !== 403) {
      c.note(`(a) S3 answered ${early.put} for the disabled key (403 expected by the brief; S3 reports KMS.DisabledException)`);
    }

    // (b) Key disabled while PROCESSING: the copy and the probe fail -> KEY_UNAVAILABLE.
    c.expect((await enableKey(keyArn)) === 'ok', 'EnableKey B');
    await sleep(20_000);
    await setMode(w, 'pause:60');
    const paused = await deliver(token, pdf(1), fileName(w, 'revoke'), 'application/pdf', putRetryMs);
    c.expect(paused.put === 200, `(b) PUT after re-enable -> ${paused.put}`);
    if (paused.deliveryId !== undefined && paused.put === 200) {
      const id = paused.deliveryId;
      const processing = await waitFor(token, id, ['PROCESSING', ...TERMINAL], 60_000);
      c.expect(processing?.status === 'PROCESSING', `(b) delivery ${id} -> ${processing?.status} before the disable`);
      c.expect((await disableKey(keyArn)) === 'ok', '(b) DisableKey B while PROCESSING');
      const d = await waitFor(token, id, TERMINAL, processingBudgetMs(w));
      c.expect(d?.status === 'KEY_UNAVAILABLE', `(b) delivery ${id} -> ${d?.status} ${d?.reason ?? ''}`);
      const ev = await w.events.waitFor(id, 'DeliveryKeyUnavailable');
      c.expect(ev.length === 1, `(b) DeliveryKeyUnavailable for ${id} -> ${ev.length}`);
      await dropGone(c, w, tenantId, id, '(b) KEY_UNAVAILABLE');
      const refused = await tenantCall('POST', 'tenant/deliveries', token, { fileName: fileName(w, 'refused'), contentType: 'application/pdf', sizeBytes: 10 });
      c.expect(refused.status === 409 && refused.json.code === 'TenantKeyUnavailable', `(b) CreateDelivery B while REVOKED -> ${refused.status} ${refused.json.code ?? ''}`);
    }
    await setMode(w, 'accept');

    // (c) Re-enabled: the sweep's probe sets ACTIVE; a new delivery lands.
    c.expect((await enableKey(keyArn)) === 'ok', '(c) EnableKey B');
    const status = await sweepUntilActive(w, tenantId);
    c.expect(status === 'ACTIVE', `(c) sweepFunction, then GetTenantKey B -> ${status}`);
    const fresh = await deliver(token, pdf(1), fileName(w, 'after-enable'), 'application/pdf', putRetryMs);
    const freshDone = fresh.deliveryId === undefined ? undefined : await waitFor(token, fresh.deliveryId, TERMINAL, processingBudgetMs(w));
    c.expect(freshDone?.status === 'ACCEPTED', `(c) new delivery B -> ${freshDone?.status ?? `CreateDelivery ${fresh.created.status} PUT ${fresh.put}`}`);

    // (d) Only the use statement removed (DescribeKey kept), while PROCESSING: same outcome.
    const full = await keyPolicy(keyArn);
    const stripped = withoutUseStatement(full);
    c.expect(stripped.Statement.length === full.Statement.length - 1, `(d) the policy without its use statement drops exactly one statement (${full.Statement.length} -> ${stripped.Statement.length})`);
    c.expect(stripped.Statement.some((s) => s.Effect === 'Allow' && actions(s).includes('kms:DescribeKey')), '(d) DescribeKey kept for the tenant roles');
    await setMode(w, 'pause:120');
    const second = await deliver(token, pdf(1), fileName(w, 'policy'), 'application/pdf', putRetryMs);
    if (second.deliveryId !== undefined && second.put === 200) {
      const id = second.deliveryId;
      const processing = await waitFor(token, id, ['PROCESSING', ...TERMINAL], 60_000);
      c.expect(processing?.status === 'PROCESSING', `(d) delivery ${id} -> ${processing?.status} before the policy change`);
      c.expect((await putKeyPolicy(keyArn, stripped)) === 'ok', '(d) PutKeyPolicy without the use statement while PROCESSING');
      const d = await waitFor(token, id, TERMINAL, processingBudgetMs(w));
      if (!c.expect(d?.status === 'KEY_UNAVAILABLE', `(d) delivery ${id} -> ${d?.status} ${d?.reason ?? ''}`) && d?.status === 'ACCEPTED') {
        c.note('(d) the policy change had not reached KMS within the 120 s pause (propagation takes up to five minutes)');
      }
      const ev = await w.events.waitFor(id, 'DeliveryKeyUnavailable');
      c.expect(ev.length === 1, `(d) DeliveryKeyUnavailable for ${id} -> ${ev.length}`);
      const refused = await tenantCall('POST', 'tenant/deliveries', token, { fileName: fileName(w, 'refused-2'), contentType: 'application/pdf', sizeBytes: 10 });
      c.expect(refused.status === 409 && refused.json.code === 'TenantKeyUnavailable', `(d) CreateDelivery B while REVOKED -> ${refused.status} ${refused.json.code ?? ''}`);
    } else {
      c.expect(false, `(d) CreateDelivery ${second.created.status} PUT ${second.put}`);
    }
    await setMode(w, 'accept');
    c.expect((await putKeyPolicy(keyArn, full)) === 'ok', '(d) PutKeyPolicy restoring the use statement');
    const back = await sweepUntilActive(w, tenantId);
    c.expect(back === 'ACTIVE', `(d) REVOKED until the statement is back: sweepFunction, then GetTenantKey B -> ${back}`);
    const last = await deliver(token, pdf(1), fileName(w, 'after-restore'), 'application/pdf', putRetryMs);
    const lastDone = last.deliveryId === undefined ? undefined : await waitFor(token, last.deliveryId, TERMINAL, processingBudgetMs(w));
    c.expect(lastDone?.status === 'ACCEPTED', `(d) new delivery B after the restore -> ${lastDone?.status ?? `CreateDelivery ${last.created.status} PUT ${last.put}`}`);

    const dlqAfter = await queueDepth(w.demo.DeadLetterQueueUrl);
    c.expect(dlqAfter <= dlqBefore, `DLQ unchanged by the revocations -> ${dlqBefore} before, ${dlqAfter} after`);
  } finally {
    await setMode(w, 'accept');
    await enableKey(keyArn).catch(() => undefined);
    if (restore !== undefined) {
      const restored = await putKeyPolicy(keyArn, restore);
      c.expect(restored === 'ok', 'PutKeyPolicy restoring B\'s vendor-key policy (no DisableKey for the account)');
    }
  }
  return c.result('8');
}

/** 9. Rotation. */
async function step9(w: World): Promise<StepResult> {
  const c = new Check();
  await refreshTokens(w, c);
  const a = await signed('POST', `${w.apiUrl}platform/tenants/${w.tenants.A.tenantId}/key/rotate`);
  c.expect(a.status === 200, `RotateTenantKey A -> ${a.status}`);
  if (w.tenantKey.crossAccount) {
    const b = await signed('POST', `${w.apiUrl}platform/tenants/${w.tenants.B.tenantId}/key/rotate`);
    c.expect(b.status === 400, `RotateTenantKey B (tenant-key) -> ${b.status} ${b.json.code ?? ''}`);
  } else {
    c.note('RotateTenantKey B (tenant-key) -> 400 not exercised: no second account');
  }
  const landed = w.deliveries.A?.landedKey;
  if (landed === undefined) {
    c.expect(false, "step 3's object of A is needed");
  } else {
    await sleep(30_000);
    const consumer = new S3Client({ region: REGION, credentials: await assume(w.aid.TestConsumerRoleArn, w.tenants.A.tenantId) });
    const read = await consumer.send(new GetObjectCommand({ Bucket: w.bucket, Key: landed }));
    c.expect(read.$metadata.httpStatusCode === 200, "step 3's object of A still reads after the rotation");
    await read.Body?.transformToByteArray();
  }
  return c.result('9');
}

/** 10. Observability. */
async function step10(w: World): Promise<StepResult> {
  const c = new Check();
  const groups = logGroups(w);
  const a = w.deliveries.A;

  // One processor line per delivery, with tenantId, status, sizeBytes, kmsRequests.
  let kmsRequests: number | undefined;
  if (a === undefined) {
    c.expect(false, "step 3's delivery of A is needed");
  } else {
    const messages = await filterLogs(w, groups.processor, `"${a.deliveryId}"`);
    const lines = Array.isArray(messages) ? processedLines(messages, a.deliveryId) : [];
    c.expect(lines.length === 1, `processor 'delivery processed' lines for ${a.deliveryId} -> ${Array.isArray(messages) ? lines.length : messages}`);
    const line = lines[0] ?? {};
    c.expect(line.tenantId === a.tenantId, `the line carries tenantId ${a.tenantId}`);
    c.expect(line.status === 'ACCEPTED', `the line carries status -> ${String(line.status)}`);
    c.expect(typeof line.sizeBytes === 'number', `the line carries sizeBytes -> ${typeof line.sizeBytes}`);
    c.expect(typeof line.kmsRequests === 'number', `the line carries kmsRequests -> ${String(line.kmsRequests)}`);
    kmsRequests = typeof line.kmsRequests === 'number' ? line.kmsRequests : undefined;
  }

  // No log line holds a signature or a test file name (processor, API, authoriser and every other group).
  await scanLogsForLeaks(c, w, '10');

  // Contributor Insights rules (P-9), found by the construct's rule-name prefix.
  const expected = w.demo.ContributorInsightRuleNames.split(',').filter((n) => n.length > 0);
  const prefix = expected[0]?.slice(0, expected[0].indexOf('-tei-') + 5) ?? '';
  const rules: { name: string; state: string }[] = [];
  let next: string | undefined;
  do {
    const r = await cloudwatch.send(new DescribeInsightRulesCommand({ NextToken: next, MaxResults: 100 }));
    rules.push(...(r.InsightRules ?? []).filter((x) => (x.Name ?? '').startsWith(prefix)).map((x) => ({ name: x.Name ?? '', state: x.State ?? '' })));
    next = r.NextToken;
  } while (next !== undefined);
  c.expect(prefix.length > 5 && expected.every((n) => rules.some((r) => r.name === n && r.state === 'ENABLED')), `Contributor Insights rules with the construct's prefix -> ${rules.length} of ${expected.length} expected, all ENABLED`);

  // kmsRequests matches CloudTrail for one delivery (the processor session t-<tenantId>-<last 16 of deliveryId>).
  if (a !== undefined && kmsRequests !== undefined) {
    const session = `t-${a.tenantId}-${a.deliveryId.slice(-16)}`;
    const count = async () => {
      let n = 0;
      let token: string | undefined;
      do {
        const r = await cloudtrail.send(
          new LookupEventsCommand({ LookupAttributes: [{ AttributeKey: 'Username', AttributeValue: session }], StartTime: new Date(w.startedAt), NextToken: token }),
        );
        n += (r.Events ?? []).filter((e) => e.EventSource === 'kms.amazonaws.com').length;
        token = r.NextToken;
      } while (token !== undefined);
      return n;
    };
    const trail = await pollUntil(count, (n) => n >= kmsRequests!, 5 * 60 * 1000, 30_000);
    // Informational until the per-call accounting is settled: CloudTrail counts every KMS event the processor session made (incl. the probe and S3's own retries).
    c.note(`kmsRequests ${kmsRequests} vs CloudTrail KMS events of the processor session -> ${trail}`);
  }

  // Access-log Requester (best effort: S3 delivers server access logs late).
  const logBucket = w.demo.AccessLogBucketName;
  const listed = await pollUntil(
    async () => {
      try {
        return (await s3.send(new ListObjectsV2Command({ Bucket: logBucket, MaxKeys: 1000 }))).Contents ?? [];
      } catch (error) {
        c.note(`access-log bucket list -> ${errorName(error)}`);
        return [];
      }
    },
    (objects) => objects.length > 0,
    180_000,
    20_000,
  );
  if (listed.length === 0) {
    c.note('access-log Requester: no access log delivered within 3 minutes; not checked in this run (best effort)');
  } else {
    const reader = new S3Client({ region: REGION, credentials: await assume(w.aid.TestAccessLogReaderRoleArn) });
    const wanted = ['A', 'B'].map((l) => `t-${w.tenants[l as 'A' | 'B'].tenantId}-`);
    const found = new Set<string>();
    for (const object of listed.slice(-50)) {
      const body = await (await reader.send(new GetObjectCommand({ Bucket: logBucket, Key: object.Key! }))).Body?.transformToString();
      for (const s of wanted) {
        if ((body ?? '').includes(s)) {
          found.add(s);
        }
      }
    }
    if (found.size > 0) {
      c.expect(true, `access-log Requester names the tenant session (${found.size} of ${wanted.length} tenants seen)`);
    } else {
      c.note(`access-log Requester: ${listed.length} log objects, none yet names t-<tenantId>-; not checked in this run (best effort)`);
    }
  }
  return c.result('10');
}

/** 11. Offboarding. */
async function step11(w: World): Promise<StepResult> {
  const c = new Check();
  await refreshTokens(w, c);
  const a = w.tenants.A;
  const b = w.tenants.B;
  const platform = `${w.apiUrl}platform/tenants`;

  // A URL in flight across the offboarding.
  const inFlight = a.token === undefined ? undefined : await tenantCall('POST', 'tenant/deliveries', a.token, { fileName: fileName(w, 'in-flight'), contentType: 'application/pdf', sizeBytes: pdf(1).length });
  c.expect(inFlight?.status === 201, `CreateDelivery A (URL in flight) -> ${inFlight?.status}`);

  for (const label of ['A', 'B', 'D'] as const) {
    const r = await signed('DELETE', `${platform}/${w.tenants[label].tenantId}/key`);
    c.expect(r.status === 202, `DeleteTenantKey ${label} -> ${r.status}`);
  }

  // A: no version under either prefix, alias gone, key PendingDeletion.
  for (const prefix of [`ingest/${a.tenantId}/`, `documents/${a.tenantId}/`]) {
    const n = await pollUntil(() => versionCount(w.bucket, prefix), (v) => v === 0, 300_000, 15_000);
    c.expect(n === 0, `versions under ${prefix} -> ${n}`);
  }
  if (a.keyArn !== undefined) {
    const state = await pollUntil(async () => (await kms.send(new DescribeKeyCommand({ KeyId: a.keyArn }))).KeyMetadata?.KeyState, (s) => s === 'PendingDeletion', 180_000, 15_000);
    c.expect(state === 'PendingDeletion', `A's key -> ${state}`);
    const aliases = (await kms.send(new ListAliasesCommand({ KeyId: a.keyArn }))).Aliases ?? [];
    c.expect(!aliases.some((x) => x.AliasName === `alias/tenant-${a.tenantId}-ingestion`), `A's alias -> ${aliases.length === 0 ? 'gone' : 'present'}`);
  }
  const again = await signed('DELETE', `${platform}/${a.tenantId}/key`);
  c.expect(again.status === 204, `DeleteTenantKey A again -> ${again.status}`);
  if (a.token !== undefined) {
    const after = await tenantCall('POST', 'tenant/deliveries', a.token, { fileName: fileName(w, 'late'), contentType: 'application/pdf', sizeBytes: 10 });
    // 403 when API Gateway already refuses the deleted usage-plan key, 409 TenantKeyUnavailable from the handler while its key cache lasts: refused either way.
    c.expect(after.status === 403 || after.status === 409, `CreateDelivery A after offboarding -> ${after.status} (403 API key gone, or 409 from the handler)`);
  }
  if (inFlight?.status === 201) {
    const put = await fetch(inFlight.json.uploadUrl, { method: 'PUT', headers: inFlight.json.headers, body: pdf(1) });
    // The key is pending deletion: S3 answers 400 (KMS.KMSInvalidStateException) or 403; the upload fails either way.
    c.expect(put.status === 400 || put.status === 403, `the in-flight PUT of A -> ${put.status} (refused)`);
  }

  // B: key untouched (tenant-key), row and KEYARN# gone, tombstone written, no alarm.
  if (b.keyArn !== undefined) {
    const state = (await w.tenantKey.kms.send(new DescribeKeyCommand({ KeyId: b.keyArn }))).KeyMetadata?.KeyState;
    if (w.tenantKey.crossAccount) {
      c.expect(state === 'Enabled', `B's tenant-key key untouched -> ${state}`);
    } else {
      c.note(`B's key is a vendor key in this run (no second account) -> ${state}`);
    }
    const table = w.demo.RegistryTableName;
    const item = async (key: { PK: string; SK: string }) =>
      (await ddb.send(new GetItemCommand({ TableName: table, Key: { PK: { S: key.PK }, SK: { S: key.SK } }, ConsistentRead: true }))).Item;
    c.expect((await item(keyRowKey(b.tenantId))) === undefined, 'B\'s key row -> gone');
    c.expect((await item(keyArnItemKey(b.keyArn))) === undefined, "B's KEYARN# item -> gone");
    const tomb = await pollUntil(() => item(tombstoneKey(b.tenantId)), (x) => x !== undefined, 120_000, 10_000);
    c.expect(tomb !== undefined, `tombstone for ${b.tenantId} -> ${tomb === undefined ? 'absent' : 'written'}`);
    const got = await getTenantKey(w, b.tenantId);
    c.expect(got.status === 404, `GetTenantKey B -> ${got.status}`);
  }
  const alarm = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: [w.demo.KeyBindingChangedAlarmName] }))).MetricAlarms?.[0]?.StateValue;
  c.expect(alarm !== 'ALARM', `key binding alarm -> ${alarm}`);
  return c.result('11');
}

/** 12. Teardown: scripts/integ.sh's EXIT trap (cdk destroy --all, leftover stacks and keys). */
function step12(): StepResult {
  return { step: '12', outcome: 'skip', notes: ['     teardown is scripts/integ.sh (destroy, then it lists what is left and the keys pending deletion)'] };
}

/**
 * The tenants this run created in tenant-identity's shared pool, which
 * outlives the run: `DeleteTenant` (idempotent; it removes the tenant's
 * users too) up to three times each, then `GetTenant` must be 404. Never
 * throws: a failure is reported, and any tenant left makes the run fail.
 */
async function cleanupIdentityTenants(w: World): Promise<StepResult> {
  const notes: string[] = [];
  const left: string[] = [];
  for (const tenantId of w.identityTenants) {
    const url = `${w.identityApi}platform/tenants/${tenantId}`;
    let deleted = false;
    for (let attempt = 1; attempt <= 3 && !deleted; attempt++) {
      try {
        const r = await signed('DELETE', url);
        deleted = r.status === 204 || r.status === 404;
        if (!deleted) {
          notes.push(`tenant-identity DeleteTenant ${tenantId} attempt ${attempt} -> ${r.status}`);
        }
      } catch (error) {
        notes.push(`tenant-identity DeleteTenant ${tenantId} attempt ${attempt} threw ${errorName(error)}`);
      }
      if (!deleted && attempt < 3) {
        await sleep(5000);
      }
    }
    try {
      const after = await signed('GET', url);
      if (after.status !== 404) {
        left.push(tenantId);
        notes.push(`FAIL leftover tenant-identity tenant ${tenantId}: GetTenant -> ${after.status} (${after.json.tenant?.status ?? 'unknown status'})`);
      }
    } catch (error) {
      left.push(tenantId);
      notes.push(`FAIL leftover check for tenant-identity tenant ${tenantId} threw ${errorName(error)}`);
    }
  }
  notes.push(`${w.identityTenants.length - left.length} of ${w.identityTenants.length} tenant-identity tenants deleted`);
  if (left.length > 0) {
    notes.push(`FAIL WARNING: tenants left in the shared pool: ${left.join(', ')}; delete them with DELETE /platform/tenants/{tenantId}`);
  }
  return { step: 'cleanup', outcome: left.length === 0 ? 'pass' : 'fail', notes };
}

/** Keys this run created in the second account: scheduled for deletion (the vendor's leftovers are integ.sh's). */
async function cleanupTenantAccount(w: World): Promise<void> {
  let scheduled = 0;
  for (const keyArn of w.tenantKey.createdKeys) {
    try {
      await w.tenantKey.kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyArn, PendingWindowInDays: 7 }));
      scheduled++;
    } catch (error) {
      process.stdout.write(`   second-account key deletion -> ${errorName(error)}\n`);
    }
  }
  if (w.tenantKey.createdKeys.length > 0) {
    process.stdout.write(`== second account: ${scheduled} of ${w.tenantKey.createdKeys.length} test keys scheduled for deletion (7 days)\n`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (REGION.length === 0) {
    throw new Error('AWS_REGION is not set');
  }
  const outputs = JSON.parse(readFileSync(OUTPUTS_FILE, 'utf8')) as Record<string, Record<string, string>>;
  const demo = outputs[DEMO_STACK];
  const aid = outputs[TEST_AID_STACK];
  const run = Date.now().toString(36);
  // Read the profile again on every call: the second account's credentials
  // are short-lived and may be renewed in the file while the run is on.
  const tenantCredentials: AwsCredentialIdentityProvider | undefined =
    TENANT_KEY_PROFILE === undefined
      ? undefined
      : async () => ({
        ...(await fromIni({ profile: TENANT_KEY_PROFILE, ignoreCache: true })()),
        // A five-minute expiry makes the SDK re-read the profile instead of keeping the first credentials for the whole run.
        expiration: new Date(Date.now() + 5 * 60 * 1000),
      });
  WORLD = {
    outputs,
    demo,
    aid,
    apiUrl: await param(`${INGESTION_PREFIX}apiUrl`),
    bucket: await param(`${INGESTION_PREFIX}bucketName`),
    identityApi: (await param(`${IDENTITY_PREFIX}apiUrl`)).replace(/\/?$/, '/'),
    run,
    startedAt: Date.now(),
    fileMarker: `tei-fn-${run}`,
    timing: JSON.parse(demo.PipelineTiming) as PipelineTiming,
    tenantKey: {
      crossAccount: tenantCredentials !== undefined,
      kms: tenantCredentials === undefined ? kms : new KMSClient({ region: REGION, credentials: tenantCredentials }),
      createdKeys: [],
    },
    events: new EventCapture(aid.EventCaptureQueueUrl),
    tenants: { A: { tenantId: '' }, B: { tenantId: '' }, D: { tenantId: '' } },
    identityTenants: [],
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
  try {
    await run1('0', () => step0(w));
    if (results[0].outcome === 'fail') {
      process.stdout.write('   the remaining steps need the three tenant-identity tenants; not run\n');
      return;
    }
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
    await run1('7c', () => step7c(w));
    await run1('8', () => step8(w));
    await run1('9', () => step9(w));
    await run1('10', () => step10(w));
    await run1('11', () => step11(w));
    await run1('12', () => step12());
  } finally {
    await setMode(w, 'accept').catch(() => undefined);
    await cleanupTenantAccount(w);
    // Last, after every step that uses the tenants; its own row in the summary.
    await run1('cleanup', () => cleanupIdentityTenants(w));
    summary(results);
  }
}

/** The summary table; any failed step makes the exit status non-zero. */
function summary(results: StepResult[]): void {
  process.stdout.write('== results\n');
  process.stdout.write('   step  outcome  failed checks\n');
  for (const r of results) {
    const failed = r.notes.filter((n) => n.startsWith('FAIL')).length;
    process.stdout.write(`   ${r.step.padEnd(5)} ${r.outcome.padEnd(8)} ${failed}\n`);
  }
  const failedSteps = results.filter((r) => r.outcome === 'fail').map((r) => r.step);
  process.stdout.write(`== ${failedSteps.length === 0 ? 'all steps passed' : `failed steps: ${failedSteps.join(', ')}`}\n`);
  if (failedSteps.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`integ.ingestion: ${errorName(error)}\n`);
    process.exitCode = 1;
  });
}

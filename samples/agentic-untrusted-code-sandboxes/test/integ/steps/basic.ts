// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Behaviour steps 1: seed, parse, reuse, apart, race, prefix, iam-wall,
 * dead-handle, recycled-address, offboard, forged, standalone (spec §8).
 * Each implementation checks one unit (a step on one backend, or the step
 * alone) and records on `ctx.rec`; none throws for a failed check.
 */

import { SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { REGISTRY, registryPk, registrySk } from '../../../src/env';
import { MAX_INPUT_BYTES_CAP } from '../../../src/props';
import { agentPath } from '../agent-path';
import { callStandalone, sleep, until } from '../aws';
import { clusterArn, liveHandles, microvmTerminatedAt, sandboxState, stopOutOfBand, waitEnded } from '../cloud';
import { type Backend, TENANT } from '../common';
import { type CallResult, type Ctx } from '../ctx';
import { INPUT_AT_CAP, INPUT_OVER_CAP, INVOICES, inputAtCap } from '../fixtures';
import { probeCode } from '../hostile';
import { type Unit } from '../steps';
import { parseFunctionResponse, lastJsonLine, type RunResult } from '../tool-result';

const { a: A, b: B, c: C } = TENANT;

const backendOf = (u: Unit): Backend => {
  if (!u.backend) throw new Error(`step ${u.step} needs a backend`);
  return u.backend;
};

/** A field of a probe's output object. */
export function field<T = unknown>(out: Record<string, unknown>, name: string): T | undefined {
  return out[name] as T | undefined;
}

/** A probe's `attempt` record: `{ok, v}` or `{ok: false, err, errno}`. */
export interface Attempt { ok?: boolean; err?: string; errno?: number; v?: unknown }
export const attempt = (out: Record<string, unknown>, name: string): Attempt => (out[name] ?? {}) as Attempt;

/** The result's `sandbox` is `started`, or `reused` when the call already waited through `sandbox_starting`. */
export function startedOk(r: RunResult | undefined, starting: number): boolean {
  return r !== undefined && (r.sandbox === 'started' || (r.sandbox === 'reused' && starting > 0));
}

export async function seed(c: Ctx): Promise<void> {
  for (const instance of ['run-code', 'run-code-files'] as const) {
    const bucket = c.output(instance, 'Bucket');
    for (const [tenant, inv] of Object.entries(INVOICES)) {
      await c.aws.s3.send(new PutObjectCommand({ Bucket: bucket, Key: `inputs/${tenant}/invoice.csv`, Body: inv.body, ContentType: 'text/csv' }));
    }
    for (const tenant of [A, B]) {
      c.rec.check(`the test mint answers a token for tenant ${tenant} on ${instance}`, (await c.token(instance, tenant)).split('.').length === 3);
    }
  }
  // Inputs at the run-code instance's `maxInputBytes` (the cap) and one byte over it (limits).
  const bucket = c.output('run-code', 'Bucket');
  await c.aws.s3.send(new PutObjectCommand({ Bucket: bucket, Key: `inputs/${A}/${INPUT_AT_CAP}`, Body: inputAtCap() }));
  await c.aws.s3.send(new PutObjectCommand({ Bucket: bucket, Key: `inputs/${A}/${INPUT_OVER_CAP}`, Body: Buffer.alloc(MAX_INPUT_BYTES_CAP + 1) }));
  c.rec.note('invoices of tenants A and B, the inputs at and over the input cap, and mint tokens on both instances');
}

export async function parse(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const { call, out } = await c.probe('run-code', A, backend, 'parse', {}, { input: 'invoice.csv' });
  const r = call.result;
  c.rec.check(`parse on ${backend}: a result (got ${call.outcome.kind})`, r !== undefined);
  if (!r) return;
  c.parseRuns[backend] = r.runId;
  c.rec.check(`exit code 0 (got ${r.exitCode})`, r.exitCode === 0);
  c.rec.check('the output matches A\'s invoice (rows, owner and total)',
    field(out, 'rows') === INVOICES[A].rows && field(out, 'owner') === A && field(out, 'total') === INVOICES[A].total);
  c.rec.check(`sandbox is started, or retried after sandbox_starting (got ${r.sandbox}, ${call.starting} starting)`, startedOk(r, call.starting));
  c.rec.latency(backend, 'cold', call.ms);
  c.rec.note(`cold ${call.ms} ms, ${call.starting} starting answer(s)`);
  if (backend === 'microvm') {
    await agentPath(c);
  }
}

const markerValue = (c: Ctx, tenant: string): string => `${tenant}-${c.runId}`;

export async function reuse(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const value = markerValue(c, A);
  const w = await c.probe('run-code', A, backend, 'marker', { mode: 'write', value });
  c.rec.check(`A writes /work/marker on ${backend} (exit ${w.call.result?.exitCode})`, w.call.result?.exitCode === 0 && field(w.out, 'written') === true);
  const r = await c.probe('run-code', A, backend, 'marker', { mode: 'read' });
  c.rec.check('A\'s next call reads the marker back', field(r.out, 'value') === value);
  c.rec.check(`sandbox is reused (got ${r.call.result?.sandbox})`, r.call.result?.sandbox === 'reused');
  c.rec.latency(backend, 'warm', r.call.ms);
  c.rec.note(`warm ${r.call.ms} ms`);
}

export async function apart(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  // B also writes a marker of its own, which recycled-address and iam-wall read later.
  const r = await c.probe('run-code', B, backend, 'marker', { mode: 'read' });
  c.rec.check(`B's call on ${backend} cannot see A's marker (present ${String(field(r.out, 'present'))})`, field(r.out, 'present') === false);
  c.rec.check(`B's sandbox is started (got ${r.call.result?.sandbox}, ${r.call.starting} starting)`, startedOk(r.call.result, r.call.starting));
  await c.probe('run-code', B, backend, 'marker', { mode: 'write', value: markerValue(c, B) });
  const rowA = await c.aws.row(c.output('run-code', 'Table'), A, backend);
  const rowB = await c.aws.row(c.output('run-code', 'Table'), B, backend);
  c.rec.check('A and B have separate sandboxes (distinct handles)', rowA?.handle !== undefined && rowB?.handle !== undefined && rowA.handle !== rowB.handle);
}

/** An outcome for a failed check: its kind, with the error code or the refusal status. */
function shown(o: CallResult['outcome']): string {
  return o.kind === 'error' ? `error ${o.code}` : o.kind === 'refused' ? `refused ${o.status}` : o.kind;
}

export async function race(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const before = backend === 'agentcore' ? [] : await liveHandles(c, backend);
  const code = 'print("race")';
  const [x, y] = await Promise.all([
    c.call('run-code', C, { code, backend }),
    c.call('run-code', C, { code, backend }),
  ]);
  c.rec.check(`both concurrent first calls for C returned a result on ${backend} (${shown(x.outcome)}, ${shown(y.outcome)})`, x.result?.exitCode === 0 && y.result?.exitCode === 0);
  const row = await c.aws.row(c.output('run-code', 'Table'), C, backend);
  c.rec.check('one registry row exists for C', row !== undefined && typeof row.handle === 'string');
  if (backend === 'agentcore') {
    c.rec.check(`the session id is derived from the tenant (got ${String(row?.handle).slice(0, 3)}...)`, String(row?.handle).startsWith('rc-'));
    // One session: a third call is served by the same runner (no restart), so `reused`, and the boot id stays.
    const bootBefore = row?.bootId;
    const third = await c.call('run-code', C, { code, backend });
    const after = await c.aws.row(c.output('run-code', 'Table'), C, backend);
    c.rec.check(`a third call reuses the session (got ${third.result?.sandbox})`, third.result?.sandbox === 'reused' && bootBefore !== undefined && after?.bootId === bootBefore);
  } else {
    const after = await liveHandles(c, backend);
    const added = after.filter((h) => !before.includes(h));
    c.rec.check(`the two calls started exactly one sandbox (started ${added.length})`, added.length === 1);
  }
}

export async function prefix(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const bad = ['../B/invoice.csv', 'a/../../B/invoice.csv', '/etc/passwd', 'a b.csv', 'x'.repeat(257)];
  for (const input of bad) {
    const r = await c.call('run-code', A, { code: 'print(1)', input, backend }, { once: true });
    c.rec.check(`input "${input.length > 30 ? `${input.slice(0, 12)}...(${input.length})` : input}" is refused with invalid_argument (got ${r.outcome.kind === 'error' ? r.outcome.code : r.outcome.kind})`, r.outcome.kind === 'error' && r.outcome.code === 'invalid_argument');
  }
  for (const input of ['B/invoice.csv', 'missing.csv']) {
    const r = await c.call('run-code', A, { code: 'print(1)', input, backend }, { once: true });
    c.rec.check(`input "${input}" stays under A's prefix and is not found (got ${r.outcome.kind === 'error' ? r.outcome.code : r.outcome.kind})`, r.outcome.kind === 'error' && r.outcome.code === 'input_not_found');
  }
}

export async function iamWall(c: Ctx): Promise<void> {
  const role = c.output('run-code', 'ToolTenantRole');
  const bucket = c.output('run-code', 'Bucket');
  const table = c.output('run-code', 'Table');
  const tableArn = c.output('run-code', 'TableArn');
  const cluster = clusterArn(c);
  const rowB = await c.aws.row(table, B, 'nitro');
  const taskB = typeof rowB?.handle === 'string' ? rowB.handle : `${cluster.replace(':cluster/', ':task/')}/0000000000000000000000000000000b`;
  const principal = { ContextKeyName: 'aws:PrincipalTag/TenantId', ContextKeyValues: [A], ContextKeyType: 'string' as const };
  const decision = async (action: string, resource: string, extra: Array<{ ContextKeyName: string; ContextKeyValues: string[]; ContextKeyType: 'string' | 'stringList' }>): Promise<string | undefined> => {
    const r = await c.aws.iam.send(new SimulatePrincipalPolicyCommand({
      PolicySourceArn: role, ActionNames: [action], ResourceArns: [resource], ContextEntries: [principal, ...extra],
    }));
    return r.EvaluationResults?.[0]?.EvalDecision;
  };
  const leading = (v: string) => ({ ContextKeyName: 'dynamodb:LeadingKeys', ContextKeyValues: [v], ContextKeyType: 'stringList' as const });
  c.rec.check('A may read its own input object (control)', (await decision('s3:GetObject', `arn:aws:s3:::${bucket}/inputs/${A}/invoice.csv`, [])) === 'allowed');
  c.rec.check('A may not read B\'s input object', (await decision('s3:GetObject', `arn:aws:s3:::${bucket}/inputs/${B}/invoice.csv`, [])) !== 'allowed');
  c.rec.check('A may read its own registry row (control)', (await decision('dynamodb:GetItem', tableArn, [leading(`TENANT#${A}`)])) === 'allowed');
  c.rec.check('A may not read B\'s registry row', (await decision('dynamodb:GetItem', tableArn, [leading(`TENANT#${B}`)])) !== 'allowed');
  const tag = (v: string) => ({ ContextKeyName: 'aws:ResourceTag/TenantId', ContextKeyValues: [v], ContextKeyType: 'string' as const });
  const clusterKey = { ContextKeyName: 'ecs:cluster', ContextKeyValues: [cluster], ContextKeyType: 'string' as const };
  c.rec.check('A may stop a task tagged A (control)', (await decision('ecs:StopTask', taskB, [tag(A), clusterKey])) === 'allowed');
  c.rec.check('A may not stop B\'s task', (await decision('ecs:StopTask', taskB, [tag(B), clusterKey])) !== 'allowed');
}

export async function deadHandle(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const table = c.output('run-code', 'Table');
  const row = await c.aws.row(table, A, backend);
  const handle = typeof row?.handle === 'string' ? row.handle : undefined;
  c.rec.check(`A has a sandbox on ${backend} to stop`, handle !== undefined);
  if (!handle) return;
  await stopOutOfBand(c, backend, handle);
  if (backend !== 'agentcore') {
    // A task takes 45 to 78 s to stop (spec §5.3).
    c.rec.check('the stopped sandbox reports ended within 4 minutes', await waitEnded(c, backend, handle, 240_000));
    if (backend === 'microvm') {
      // The tool counts a MicroVM as dead only when terminatedAt is more than 2 s before its request left; a call
      // inside that window is no_answer, and the tool stops the sandbox and returns timedOut (ADR-0044). Wait until
      // 4 s past terminatedAt on this clock, which leaves 2 s for a driver clock ahead of the platform's.
      const endedAt = await microvmTerminatedAt(c, handle);
      await sleep(Math.max(0, (endedAt ?? Date.now()) + 4000 - Date.now()));
    }
  } else {
    await sleep(5000);
  }
  const r = await c.probe('run-code', A, backend, 'marker', { mode: 'read' });
  c.rec.check(`A's next call is a new sandbox (got ${r.call.result?.sandbox}, ${r.call.starting} starting)`, startedOk(r.call.result, r.call.starting));
  c.rec.check('the new sandbox has none of the old one\'s files', field(r.out, 'present') === false);
  const after = await c.aws.row(table, A, backend);
  if (backend === 'agentcore') {
    // The session id is derived from the tenant and stays; a restarted session shows as a new boot id (spec §4.1 step 3).
    c.rec.check('the session restarted under the same id: a new boot id', after?.bootId !== undefined && after.bootId !== row?.bootId);
  } else {
    c.rec.check('the row names a new handle', after?.handle !== undefined && after.handle !== handle);
  }
}

export async function recycledAddress(c: Ctx): Promise<void> {
  const table = c.output('run-code', 'Table');
  const readB = await c.probe('run-code', B, 'nitro', 'marker', { mode: 'read' });
  c.rec.check('B\'s task is live and holds B\'s marker', field(readB.out, 'value') === markerValue(c, B));
  await c.probe('run-code', A, 'nitro', 'marker', { mode: 'write', value: markerValue(c, A) });
  const rowA = await c.aws.row(table, A, 'nitro');
  const rowB = await c.aws.row(table, B, 'nitro');
  if (!rowA || !rowB || typeof rowB.address !== 'string') {
    c.rec.check('both rows exist with an address', false);
    return;
  }
  // TEST ONLY: stands in for a private IP that ECS reassigned to another tenant's task.
  await c.aws.ddb.send(new UpdateCommand({
    TableName: table,
    Key: { [REGISTRY.PK]: registryPk(A), [REGISTRY.SK]: registrySk('nitro') },
    UpdateExpression: 'SET address = :b ADD version :one',
    ExpressionAttributeValues: { ':b': rowB.address, ':one': 1 },
  }));
  const r = await c.probe('run-code', A, 'nitro', 'marker', { mode: 'read' });
  c.rec.check(`A's call fails the identity check and gets a fresh task (got ${r.call.result?.sandbox}, ${r.call.starting} starting)`, startedOk(r.call.result, r.call.starting));
  c.rec.check('A did not read B\'s marker (the call went to a task of its own)', field(r.out, 'value') !== markerValue(c, B));
  const after = await c.aws.row(table, A, 'nitro');
  c.rec.check('A\'s row names another task and another address than B\'s', after?.handle !== rowB.handle && after?.address !== rowB.address);
  const again = await c.probe('run-code', B, 'nitro', 'marker', { mode: 'read' });
  c.rec.check('B\'s task never received the job: its marker is intact and its sandbox reused', field(again.out, 'value') === markerValue(c, B) && again.call.result?.sandbox === 'reused');
}

export async function forged(c: Ctx): Promise<void> {
  const context = await c.forgedContext('F', 'run-code');
  const r = await c.aws.invoke(c.output('run-code', 'ToolFunction'), { code: 'print(1)', _ri_ctx: context });
  const o = parseFunctionResponse(r.functionError, r.body);
  c.rec.check(`a context signed with the wrong key returns context_invalid (got ${o.kind === 'error' ? o.code : o.kind})`, o.kind === 'error' && o.code === 'context_invalid');
  const row = await c.aws.row(c.output('run-code', 'Table'), 'F', 'microvm');
  c.rec.check('nothing started for the forged tenant (no registry row)', row === undefined);
}

export async function standalone(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const fn = c.output('run-code', 'RunCodeFunction');
  const client = new LambdaClient({ region: c.aws.region });
  const code = probeCode('parse');
  const r = await callStandalone(client, fn, { tenantId: A, code, input: 'invoice.csv', backend });
  const result = r.outcome.kind === 'result' ? r.outcome.result : undefined;
  const out = lastJsonLine(result?.stdout ?? '') ?? {};
  c.rec.check(`standalone parse on ${backend} (got ${r.outcome.kind})`, result?.exitCode === 0);
  c.rec.check('the standalone output matches A\'s invoice (rows, owner and total)',
    out.rows === INVOICES[A].rows && out.owner === A && out.total === INVOICES[A].total);
  if (backend !== 'microvm') return;
  const refused = async (args: Record<string, unknown>, what: string): Promise<void> => {
    const o = (await callStandalone(client, fn, args)).outcome;
    c.rec.check(`${what} returns invalid_argument (got ${o.kind === 'error' ? o.code : o.kind})`, o.kind === 'error' && o.code === 'invalid_argument');
  };
  await refused({ tenantId: A, code: 'print(1)', input: '../B/invoice.csv' }, 'input ../B/invoice.csv');
  await refused({ tenantId: 'A/x', code: 'print(1)' }, 'tenantId A/x');
  await refused({ tenantId: '', code: 'print(1)' }, 'an empty tenantId');
  const viaGateway = await c.call('run-code', A, { code: 'print(1)', tenantId: 'B' } as never, { once: true });
  c.rec.check(`through the gateway a tenantId argument returns invalid_argument (got ${viaGateway.outcome.kind === 'error' ? viaGateway.outcome.code : viaGateway.outcome.kind})`, viaGateway.outcome.kind === 'error' && viaGateway.outcome.code === 'invalid_argument');
  // A role with no invoke grant is refused: IAM applies (it does not show that only granted roles can reach it, T-82).
  const assumed = await c.aws.sts.send(new AssumeRoleCommand({ RoleArn: c.out.NoGrantRoleArn, RoleSessionName: 'rc-integ-nogrant' }));
  const cr = assumed.Credentials;
  const denied = new LambdaClient({ region: c.aws.region, credentials: { accessKeyId: cr?.AccessKeyId ?? '', secretAccessKey: cr?.SecretAccessKey ?? '', sessionToken: cr?.SessionToken } });
  const d = await callStandalone(denied, fn, { tenantId: A, code: 'print(1)' });
  c.rec.check(`a role with no invoke grant is refused (got ${d.outcome.kind})`, d.outcome.kind === 'refused');
  // The vendor role, which has the grant through grantInvokeRunCode, is served.
  const vendor = await c.aws.sts.send(new AssumeRoleCommand({ RoleArn: c.out.VendorRoleArn, RoleSessionName: 'rc-integ-vendor' }));
  const vc = vendor.Credentials;
  const granted = new LambdaClient({ region: c.aws.region, credentials: { accessKeyId: vc?.AccessKeyId ?? '', secretAccessKey: vc?.SecretAccessKey ?? '', sessionToken: vc?.SessionToken } });
  const g = await callStandalone(granted, fn, { tenantId: A, code: 'print(1)', backend: 'microvm' });
  c.rec.check(`the role granted with grantInvokeRunCode is served (got ${g.outcome.kind})`, g.outcome.kind === 'result');
}

export async function offboard(c: Ctx): Promise<void> {
  const fn = c.output('run-code', 'OffboardFunction');
  const table = c.output('run-code', 'Table');
  const backends = ['microvm', 'nitro', 'agentcore'] as const;
  // The sandboxes `race` started may have idled out by now: start one per backend again, so the offboard has three to stop.
  for (const b of backends) await c.call('run-code', C, { code: 'print("live")', backend: b });
  const rows = await Promise.all(backends.map(async (b) => [b, await c.aws.row(table, C, b)] as const));
  for (const [b, row] of rows) c.rec.check(`C has a row on ${b} before the offboard`, row !== undefined);
  // C's grant is the test mint's scope: the driver stops minting for C, so no further call for C can start a sandbox.
  c.revoke(C);
  const first = await c.aws.invoke(fn, { tenantId: C });
  c.rec.check('offboardTenant answers without a function error', first.functionError === undefined);
  const stopped = collectHandles(first.body);
  c.rec.check(`it stops C's sandboxes (reported ${stopped.length}, wanted at least 3)`, stopped.length >= 3);
  // The offboard keeps a STOPPING row for a sandbox that is still alive (agentcore always; a nitro task for up to 78 s).
  for (const b of backends) {
    const row = await c.aws.row(table, C, b);
    c.rec.check(`C's row on ${b} is deleted or STOPPING (state ${String(row?.state)})`, row === undefined || row.state === 'STOPPING');
  }
  for (const b of ['microvm', 'nitro'] as const) {
    const row = rows.find(([name]) => name === b)?.[1];
    if (typeof row?.handle === 'string') {
      const handle = row.handle;
      const ended = await until(async () => (STOPPING_STATES.includes(await sandboxState(c, b, handle)) ? true : undefined), 180_000, 5000);
      c.rec.check(`C's ${b} sandbox is stopping or stopped`, ended === true);
    }
  }
  const second = await c.aws.invoke(fn, { tenantId: C });
  const firstHandles = new Set(stopped);
  c.rec.check('a second call stops nothing new', second.functionError === undefined && collectHandles(second.body).every((h) => firstHandles.has(h)));
  c.rec.check('a second call returns the same shape', sameKeys(first.body, second.body));
}

const STOPPING_STATES = ['STOPPED', 'TERMINATED', 'TERMINATING', 'DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'gone'];

/** True when two JSON answers are objects with the same top-level keys. */
export function sameKeys(a: string, b: string): boolean {
  try {
    const x = JSON.parse(a) as Record<string, unknown>;
    const y = JSON.parse(b) as Record<string, unknown>;
    return JSON.stringify(Object.keys(x).sort()) === JSON.stringify(Object.keys(y).sort());
  } catch {
    return false;
  }
}

/** One entry per element of every array in the offboard answer: the shape is a list of stopped handles, wherever the function puts it. */
export function collectHandles(body: string): string[] {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {for (const e of x) out.push(JSON.stringify(e));} else if (typeof x === 'object' && x !== null) {
      for (const e of Object.values(x)) walk(e);
    }
  };
  walk(v);
  return out;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, type STSClient } from '@aws-sdk/client-sts';
import { ENV } from '../src/env';
import { handleLessStaleMs, loadConfig, toolTimeoutMs } from '../src/tool/config';
import { stsCredentialSource } from '../src/tool/credentials';
import { loadBackends } from '../src/tool/deps';
import { buildStopLine, errorName, Logger, MAX_REASON_CHARS } from '../src/tool/log';
import { InputError, s3ObjectStore, validInputName } from '../src/tool/objects';
import * as runCodeModule from '../src/tool/run-code';
import { handler } from '../src/tool/run-code.function';

const env = {
  [ENV.REGISTRY_TABLE]: 'registry',
  [ENV.INPUT_BUCKET]: 'bucket',
  [ENV.BACKENDS]: 'microvm,nitro',
  [ENV.DEFAULT_BACKEND]: 'nitro',
  [ENV.TOOL_TENANT_ROLE_ARN]: 'arn:aws:iam::ACCOUNT:role/tool-tenant',
  [ENV.RUN_TIMEOUT_MS]: '30000',
  [ENV.START_WAIT_MS]: '15000',
  [ENV.MAX_OUTPUT_BYTES]: '262144',
  [ENV.MAX_INPUT_BYTES]: '5242880',
  [ENV.SANDBOX_IDLE_MS]: '900000',
  [ENV.SANDBOX_MAX_LIFE_MS]: '28800000',
  [ENV.PER_TENANT_METRICS]: 'true',
};

describe('loadConfig', () => {
  test('reads the construct\'s environment', () => {
    expect(loadConfig(env)).toEqual({
      table: 'registry',
      bucket: 'bucket',
      backends: ['microvm', 'nitro'],
      defaultBackend: 'nitro',
      toolTenantRoleArn: 'arn:aws:iam::ACCOUNT:role/tool-tenant',
      runTimeoutMs: 30_000,
      startWaitMs: 15_000,
      maxOutputBytes: 262_144,
      maxInputBytes: 5_242_880,
      sandboxIdleMs: 900_000,
      sandboxMaxLifeMs: 28_800_000,
      perTenantMetrics: true,
    });
  });

  test('perTenantMetrics is off unless the variable is exactly "true"', () => {
    expect(loadConfig({ ...env, [ENV.PER_TENANT_METRICS]: 'false' }).perTenantMetrics).toBe(false);
    expect(loadConfig({ ...env, [ENV.PER_TENANT_METRICS]: undefined }).perTenantMetrics).toBe(false);
  });

  test.each(Object.values(ENV).filter((n) => n !== ENV.PER_TENANT_METRICS))('fails when %s is missing', (name) => {
    expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(name);
  });

  test('refuses an unknown backend, a default that is not deployed, and a non-numeric duration', () => {
    expect(() => loadConfig({ ...env, [ENV.BACKENDS]: 'microvm,lambda' })).toThrow(/unknown backend/);
    expect(() => loadConfig({ ...env, [ENV.DEFAULT_BACKEND]: 'agentcore' })).toThrow(/not one of/);
    expect(() => loadConfig({ ...env, [ENV.RUN_TIMEOUT_MS]: '3.5' })).toThrow(/whole number/);
    expect(() => loadConfig({ ...env, [ENV.START_WAIT_MS]: 'x' })).toThrow(/whole number/);
  });

  test('the tool timeout is 5 s + startWait + runTimeout + 10 s, and a handle-less start is stale after startWait more', () => {
    const c = loadConfig(env);
    expect(toolTimeoutMs(c)).toBe(5000 + 15_000 + 30_000 + 10_000);
    expect(handleLessStaleMs(c)).toBe(15_000 + 60_000);
  });

  test('loadBackends builds exactly the enabled backends', () => {
    expect([...loadBackends(loadConfig(env), env).keys()]).toEqual(['microvm', 'nitro']);
  });
});

describe('stsCredentialSource', () => {
  const out = (expiration: Date) => ({ Credentials: { AccessKeyId: 'AKIAEXAMPLE', SecretAccessKey: 's', SessionToken: 't', Expiration: expiration } });

  test('assumes the tool tenant role with the TenantId session tag, and caches until two minutes before expiry', async () => {
    let t = 1_000_000;
    const send = jest.fn(async () => out(new Date(t + 900_000)));
    const source = stsCredentialSource('arn:aws:iam::ACCOUNT:role/tool-tenant', { send } as unknown as STSClient, () => t);
    const first = await source('tenant-a');
    expect(first).toMatchObject({ tenantId: 'tenant-a', accessKeyId: 'AKIAEXAMPLE' });
    const cmd = send.mock.calls[0][0] as unknown as AssumeRoleCommand;
    expect(cmd.input).toMatchObject({ RoleArn: 'arn:aws:iam::ACCOUNT:role/tool-tenant', Tags: [{ Key: 'TenantId', Value: 'tenant-a' }], DurationSeconds: 900 });
    expect(cmd.input.RoleSessionName).toBe('run-code');
    expect(await source('tenant-a')).toBe(first);
    t += 900_000 - 120_001;
    expect(await source('tenant-a')).toBe(first);
    t += 2;
    expect(await source('tenant-a')).not.toBe(first);
    expect(send).toHaveBeenCalledTimes(2);
    await source('tenant-b');
    expect(send).toHaveBeenCalledTimes(3);
  });

  test('a response without credentials is an error', async () => {
    const source = stsCredentialSource('arn', { send: async () => ({}) } as unknown as STSClient);
    await expect(source('tenant-a')).rejects.toThrow(/no credentials/);
  });
});

describe('s3ObjectStore', () => {
  const creds = { tenantId: 'tenant-a', accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' };
  function store(respond: (cmd: unknown) => unknown) {
    const sent: unknown[] = [];
    const client = {
      send: async (cmd: unknown) => {
        sent.push(cmd);
        return respond(cmd);
      },
    } as unknown as S3Client;
    return { sent, objects: s3ObjectStore('bucket', creds, client) };
  }
  const named = (name: string, status?: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  const body = (bytes: number[]) => ({ transformToByteArray: async () => new Uint8Array(bytes) });

  test('reads inputs/<tenant>/<name> after a HeadObject, pinned to the ETag', async () => {
    const { sent, objects } = store((cmd) => (cmd instanceof HeadObjectCommand ? { ContentLength: 3, ETag: '"e1"' } : { Body: body([1, 2, 3]) }));
    expect(await objects.readInput('tenant-a', 'dir/f.csv', 10)).toEqual(new Uint8Array([1, 2, 3]));
    expect(sent[0]).toBeInstanceOf(HeadObjectCommand);
    expect((sent[0] as HeadObjectCommand).input).toMatchObject({ Bucket: 'bucket', Key: 'inputs/tenant-a/dir/f.csv' });
    expect((sent[1] as GetObjectCommand).input).toMatchObject({ Key: 'inputs/tenant-a/dir/f.csv', IfMatch: '"e1"' });
  });

  test('an object over the limit is refused from its size, and its body is never read', async () => {
    const { sent, objects } = store(() => ({ ContentLength: 11, ETag: 'e' }));
    await expect(objects.readInput('tenant-a', 'f', 10)).rejects.toMatchObject({ code: 'input_too_large' });
    expect(sent).toHaveLength(1);
  });

  test('exactly the limit is allowed; an empty object is an empty input', async () => {
    const at = store((cmd) => (cmd instanceof HeadObjectCommand ? { ContentLength: 2, ETag: 'e' } : { Body: body([1, 2]) }));
    expect((await at.objects.readInput('tenant-a', 'f', 2)).length).toBe(2);
    const empty = store((cmd) => (cmd instanceof HeadObjectCommand ? { ContentLength: 0, ETag: 'e' } : { Body: body([]) }));
    expect((await empty.objects.readInput('tenant-a', 'f', 2)).length).toBe(0);
    const noBody = store((cmd) => (cmd instanceof HeadObjectCommand ? { ContentLength: 0, ETag: 'e' } : {}));
    expect((await noBody.objects.readInput('tenant-a', 'f', 2)).length).toBe(0);
  });

  test('a body larger than the head said is refused (the object changed)', async () => {
    const { objects } = store((cmd) => (cmd instanceof HeadObjectCommand ? { ContentLength: 1, ETag: 'e' } : { Body: body([1, 2, 3]) }));
    await expect(objects.readInput('tenant-a', 'f', 2)).rejects.toMatchObject({ code: 'input_too_large' });
  });

  test.each([['NotFound', 404], ['NoSuchKey', 404], ['AccessDenied', 403], ['Forbidden', 403], ['Whatever', 404]])(
    'a %s on the head is input_not_found, so a missing key and a refused one look the same',
    async (name, status) => {
      const { objects } = store(() => { throw named(name, status); });
      await expect(objects.readInput('tenant-a', 'f', 10)).rejects.toBeInstanceOf(InputError);
      await expect(objects.readInput('tenant-a', 'f', 10)).rejects.toMatchObject({ code: 'input_not_found' });
    },
  );

  test('an object deleted between the head and the get is input_not_found', async () => {
    const { objects } = store((cmd) => {
      if (cmd instanceof HeadObjectCommand) return { ContentLength: 1, ETag: 'e' };
      throw named('NoSuchKey', 404);
    });
    await expect(objects.readInput('tenant-a', 'f', 10)).rejects.toMatchObject({ code: 'input_not_found' });
  });

  test('any other S3 error is not an input error', async () => {
    const { objects } = store(() => { throw named('SlowDown', 503); });
    await expect(objects.readInput('tenant-a', 'f', 10)).rejects.not.toBeInstanceOf(InputError);
  });

  test('writes outputs/<tenant>/<runId>.json', async () => {
    const { sent, objects } = store(() => ({}));
    await objects.writeOutput('tenant-a', 'r1', '{"a":1}');
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({ Bucket: 'bucket', Key: 'outputs/tenant-a/r1.json', Body: '{"a":1}', ContentType: 'application/json' });
  });

  test.each([
    ['a', true], ['a/b.c-d_e', true], ['a'.repeat(256), true], ['', false], ['a'.repeat(257), false], ['a..b', false], ['/a', false],
    ['a b', false], ['a*', false], ['a\\b', false], ['ä', false],
  ])('input name %p valid: %p', (name, valid) => {
    expect(validInputName(name)).toBe(valid);
  });
});

describe('the standalone entry', () => {
  test('returns tool_failed, not an exception, when its environment is not set', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(handler({ tenantId: 'tenant-a', code: 'x' })).resolves.toEqual({ error: 'tool_failed' });
      expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({ event: 'run', outcome: 'tool_failed' });
    } finally {
      write.mockRestore();
    }
  });
});

describe('the error and reason fields of a line', () => {
  test('errorName keeps a plain class name and nothing else', () => {
    expect(errorName(new TypeError('x'))).toBe('TypeError');
    expect(errorName(Object.assign(new Error('x'), { name: 'a'.repeat(65) }))).toBe('Error');
    expect(errorName(Object.assign(new Error('x'), { name: 'bad name\n{"event":"x"}' }))).toBe('Error');
    expect(errorName('text')).toBe('Error');
  });

  test('a platform reason is cut to 200 characters on a stop line and on a run line', () => {
    const line = buildStopLine({ row: { tenantId: 't', backend: 'nitro', handle: 'h' }, facts: { reason: 'r'.repeat(500) }, now: 1, sandboxIdleMs: 1, by: 'x' });
    expect(line.stoppedReason).toHaveLength(MAX_REASON_CHARS);
    const written: string[] = [];
    new Logger((l) => written.push(l)).run({ tenantId: 't', outcome: 'sandbox_failed', stoppedReason: 'r'.repeat(500) });
    expect(JSON.parse(written[0]).stoppedReason).toHaveLength(MAX_REASON_CHARS);
  });
});

describe('the standalone entry passes the function\'s remaining time on', () => {
  test('as options.remainingMs', async () => {
    const run = jest.spyOn(runCodeModule, 'runCode').mockResolvedValue({ error: 'tool_failed' });
    await handler({ tenantId: 'tenant-a', code: 'x' }, { getRemainingTimeInMillis: () => 4321 });
    expect(run.mock.calls[0][2]?.remainingMs?.()).toBe(4321);
    await handler({ tenantId: 'tenant-a', code: 'x' });
    expect(run.mock.calls[1][2]?.remainingMs).toBeUndefined();
    run.mockRestore();
  });
});

describe('buildStopLine', () => {
  const row = { tenantId: 't', backend: 'microvm' as const, handle: 'h', createdAt: 1000, lastUsedAt: 400_000, suspendedMs: 60_000 };

  test('microvm: running and suspended seconds, with the final idle gap added to the counter', () => {
    const line = buildStopLine({ row, facts: { startedAt: 1000, stoppedAt: 1_000_000 }, now: 5_000_000, sandboxIdleMs: 300_000, by: 'reaper', reason: 'idle' });
    // gap = 1_000_000 - 400_000 - 300_000 = 300_000; suspended = 60_000 + 300_000
    expect(line).toMatchObject({ sandboxSeconds: 999, suspendedSeconds: 360, runningSeconds: 639, estimated: true, by: 'reaper', reason: 'idle' });
  });

  test('suspended time never exceeds the sandbox\'s life, and a negative gap counts as zero', () => {
    const over = buildStopLine({ row: { ...row, suspendedMs: 9_999_999 }, facts: { startedAt: 0, stoppedAt: 100_000 }, now: 1, sandboxIdleMs: 1, by: 'x' });
    expect(over).toMatchObject({ sandboxSeconds: 100, suspendedSeconds: 100, runningSeconds: 0 });
    const none = buildStopLine({ row: { ...row, lastUsedAt: 2_000_000, suspendedMs: 0 }, facts: { startedAt: 0, stoppedAt: 100_000 }, now: 1, sandboxIdleMs: 1, by: 'x' });
    expect(none.suspendedSeconds).toBe(0);
  });

  test('without platform facts it uses the row and the time of the stop; an orphan with no start time is zero seconds', () => {
    const l = buildStopLine({ row: { ...row, backend: 'nitro' }, facts: {}, now: 61_000, sandboxIdleMs: 1, by: 'tool', reason: 'overrun' });
    expect(l).toMatchObject({ sandboxSeconds: 60, reason: 'overrun' });
    expect(l.estimated).toBeUndefined();
    const o = buildStopLine({ row: { tenantId: 'unknown', backend: 'nitro', handle: 'h' }, facts: {}, now: 61_000, sandboxIdleMs: 1, by: 'reaper', orphan: true });
    expect(o).toMatchObject({ sandboxSeconds: 0, orphan: true });
  });
});

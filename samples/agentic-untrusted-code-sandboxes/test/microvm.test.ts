// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  ConflictException,
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ResourceNotFoundException,
  RunMicrovmCommand,
  ServiceQuotaExceededException,
  ThrottlingException,
  TerminateMicrovmCommand,
  ValidationException,
} from '@aws-sdk/client-lambda-microvms';
import type { MicrovmState } from '@aws-sdk/client-lambda-microvms';
import { mockClient } from 'aws-sdk-client-mock';
import type { RegistryRow, RunJob, SandboxHandle, TenantCredentials } from '../src/backend';
import { MICROVM_START_CAP_MS, MicrovmBackend, MicrovmStartError, endpointOrigin, httpIngressConnectorArn } from '../src/backends/microvm';
import { BACKEND_ENV, ENV } from '../src/env';
import { buildJob, newNonce, nonceHash, resultProof, startToken } from '../src/protocol';
import type { RunResult } from '../src/protocol';

const ACCOUNT = '1'.repeat(12);
const IMAGE = `arn:aws:lambda:eu-central-1:${ACCOUNT}:microvm-image:sample-image`;
const CONNECTOR = `arn:aws:lambda:eu-central-1:${ACCOUNT}:network-connector:nc-0123456789abcdef`;
const INGRESS = 'arn:aws:lambda:eu-central-1:aws:network-connector:aws-network-connector:HTTP_INGRESS';
const ENDPOINT = 'abc123.lambda-microvm.eu-central-1.on.aws';
const ORIGIN = `https://${ENDPOINT}`;
const BOOT_ID = 'ab'.repeat(16);
const TOKEN = 'token-value-must-not-leak';

const ENV_OK = {
  [BACKEND_ENV.MICROVM_IMAGE_ARN]: IMAGE,
  [BACKEND_ENV.MICROVM_NETWORK_CONNECTOR_ARN]: CONNECTOR,
  [ENV.SANDBOX_MAX_LIFE_MS]: String(8 * 3600 * 1000),
  [ENV.SANDBOX_IDLE_MS]: String(15 * 60 * 1000),
};

const creds = (tenantId: string): TenantCredentials => ({ tenantId, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });

const aws = mockClient(LambdaMicrovmsClient);
let fetchMock: jest.Mock;

function backend(env: Record<string, string | undefined> = ENV_OK): MicrovmBackend {
  return new MicrovmBackend(env, { client: new LambdaMicrovmsClient({ region: 'eu-central-1' }), fetch: fetchMock as unknown as typeof fetch });
}

function handleOf(nonce: string, overrides: Partial<SandboxHandle> = {}): SandboxHandle {
  return { backend: 'microvm', tenantId: 'tenant-a', handle: 'mv-1', address: ORIGIN, nonce, ...overrides };
}

function rowOf(nonce: string, overrides: Partial<RegistryRow> = {}): RegistryRow {
  return {
    tenantId: 'tenant-a', backend: 'microvm', handle: 'mv-1', nonce, state: 'STARTING', createdAt: 0, expiresAt: 1, ttlAt: 1, version: 1, ...overrides,
  };
}

function microvm(state: MicrovmState, extra: Record<string, unknown> = {}) {
  return {
    microvmId: 'mv-1', state, endpoint: ENDPOINT, imageArn: IMAGE, imageVersion: '1', maximumDurationInSeconds: 28800, startedAt: new Date(1000), ...extra,
  };
}

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function resultFor(job: RunJob, overrides: Partial<RunResult> = {}): RunResult {
  return {
    v: 1,
    runId: job.runId,
    exitCode: 0,
    stdout: 'hi\n',
    stderr: '',
    truncated: false,
    durationMs: 12,
    timedOut: false,
    memoryExceeded: false,
    bootId: BOOT_ID,
    proof: resultProof(job.nonce, job.runId),
    ...overrides,
  };
}

function jobFor(nonce: string, overrides: { tenantId?: string; timeoutMs?: number } = {}): RunJob {
  return buildJob({
    runId: 'run-1',
    tenantId: overrides.tenantId ?? 'tenant-a',
    nonce,
    code: 'print("hi")',
    input: Buffer.from('in'),
    timeoutMs: overrides.timeoutMs ?? 30000,
    maxOutputBytes: 262144,
  });
}

beforeEach(() => {
  aws.reset();
  fetchMock = jest.fn();
  aws.on(CreateMicrovmAuthTokenCommand).resolves({ authToken: { 'X-aws-proxy-auth': TOKEN } });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('start', () => {
  test('runs the image with only the sample connector and only the nonce hash', async () => {
    const nonce = newNonce();
    aws.on(RunMicrovmCommand).resolves(microvm('PENDING'));
    const h = await backend().start('tenant-a', nonce, creds('tenant-a'));
    expect(h).toEqual({ backend: 'microvm', tenantId: 'tenant-a', handle: 'mv-1', address: ORIGIN, nonce });
    const calls = aws.commandCalls(RunMicrovmCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input).toEqual({
      imageIdentifier: IMAGE,
      egressNetworkConnectors: [CONNECTOR],
      ingressNetworkConnectors: [INGRESS],
      maximumDurationInSeconds: 28800,
      idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds: 900, suspendedDurationSeconds: 1800 },
      logging: { disabled: {} },
      runHookPayload: JSON.stringify({ nonceHash: nonceHash(nonce), tenant: 'tenant-a' }),
      clientToken: startToken(nonce),
    });
    expect(input).not.toHaveProperty('executionRoleArn');
    // The start call, which CloudTrail and GetMicrovm can show, never carries the nonce (ADR-0018).
    expect(JSON.stringify(input)).not.toContain(nonce);
  });

  test.each([
    ['missing', undefined, /is not set; a start without the sample's connector is refused/],
    ['empty', '', /is not set; a start without the sample's connector is refused/],
    ['the managed internet egress connector', 'arn:aws:lambda:eu-central-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS', /not a network connector of the image's partition, account and Region/],
    ['not an ARN', 'nc-1', /not a network connector of the image's partition, account and Region/],
    ['another account', `arn:aws:lambda:eu-central-1:${'2'.repeat(12)}:network-connector:nc-1`, /not a network connector of the image's partition, account and Region/],
    ['another Region', `arn:aws:lambda:us-east-1:${ACCOUNT}:network-connector:nc-1`, /not a network connector of the image's partition, account and Region/],
    ['another partition', `arn:aws-cn:lambda:eu-central-1:${ACCOUNT}:network-connector:nc-1`, /not a network connector of the image's partition, account and Region/],
  ])('refuses a start with the connector %s, and calls nothing', async (_name, value, message) => {
    await expect(backend({ ...ENV_OK, [BACKEND_ENV.MICROVM_NETWORK_CONNECTOR_ARN]: value }).start('tenant-a', newNonce(), creds('tenant-a')))
      .rejects.toThrow(message);
    expect(aws.commandCalls(RunMicrovmCommand)).toHaveLength(0);
  });

  test('refuses a start with no image, bad durations, a bad tenant or credentials of another tenant', async () => {
    const bad: [Record<string, string | undefined>, string, TenantCredentials, RegExp][] = [
      [{ ...ENV_OK, [BACKEND_ENV.MICROVM_IMAGE_ARN]: undefined }, 'tenant-a', creds('tenant-a'), /IMAGE_ARN is not set/],
      [{ ...ENV_OK, [BACKEND_ENV.MICROVM_IMAGE_ARN]: `${IMAGE}:2` }, 'tenant-a', creds('tenant-a'), /is not a MicroVM image ARN/],
      [{ ...ENV_OK, [ENV.SANDBOX_IDLE_MS]: 'soon' }, 'tenant-a', creds('tenant-a'), /SANDBOX_IDLE_MS is not set to a positive/],
      [{ ...ENV_OK, [ENV.SANDBOX_MAX_LIFE_MS]: undefined }, 'tenant-a', creds('tenant-a'), /SANDBOX_MAX_LIFE_MS is not set to a positive/],
      [ENV_OK, '../x', creds('../x'), /tenant id is not valid/],
      [ENV_OK, 'tenant-a', creds('tenant-b'), /credentials of another tenant/],
    ];
    for (const [env, tenant, c, message] of bad) {
      await expect(backend(env).start(tenant, newNonce(), c)).rejects.toThrow(message);
    }
    expect(aws.commandCalls(RunMicrovmCommand)).toHaveLength(0);
  });

  test('caps the life at 8 hours and rounds the idle time up', async () => {
    aws.on(RunMicrovmCommand).resolves(microvm('PENDING'));
    await backend({ ...ENV_OK, [ENV.SANDBOX_MAX_LIFE_MS]: String(9 * 3600 * 1000), [ENV.SANDBOX_IDLE_MS]: '61500' })
      .start('tenant-a', newNonce(), creds('tenant-a'));
    const input = aws.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(input.maximumDurationInSeconds).toBe(28800);
    expect(input.idlePolicy?.maxIdleDurationSeconds).toBe(62);
  });

  test('names the quota when RunMicrovm is refused for it, and tells throttling and capacity apart', async () => {
    const quota = new ServiceQuotaExceededException({ message: 'x', $metadata: {}, quotaCode: 'L-CD1C0CC4' } as never);
    aws.on(RunMicrovmCommand).rejectsOnce(quota).rejectsOnce(new ThrottlingException({ message: 'x', $metadata: {} } as never))
      .rejectsOnce(Object.assign(new Error('no room'), { name: 'InsufficientCapacityException' }));
    const b = backend();
    const failures: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await b.start('tenant-a', newNonce(), creds('tenant-a')).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(MicrovmStartError);
      failures.push((e as MicrovmStartError).failure);
      if (i === 0) expect((e as Error).message).toContain('L-CD1C0CC4');
    }
    expect(failures).toEqual(['quota', 'throttled', 'capacity']);
  });

  test('passes any other start failure on unchanged', async () => {
    const boom = new Error('boom');
    aws.on(RunMicrovmCommand).rejects(boom);
    await expect(backend().start('tenant-a', newNonce(), creds('tenant-a'))).rejects.toBe(boom);
  });

  test('starts with a versioned connector ARN, which the platform also accepts', async () => {
    aws.on(RunMicrovmCommand).resolves(microvm('PENDING'));
    await backend({ ...ENV_OK, [BACKEND_ENV.MICROVM_NETWORK_CONNECTOR_ARN]: `${CONNECTOR}:3` }).start('tenant-a', newNonce(), creds('tenant-a'));
    expect(aws.commandCalls(RunMicrovmCommand)[0].args[0].input.egressNetworkConnectors).toEqual([`${CONNECTOR}:3`]);
  });

  test('refuses an answer without an id', async () => {
    aws.on(RunMicrovmCommand).resolves({ state: 'PENDING' });
    await expect(backend().start('tenant-a', newNonce(), creds('tenant-a'))).rejects.toThrow(/returned no id/);
    expect(aws.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
  });

  test('ends a MicroVM whose endpoint it cannot use, rather than leaving it running', async () => {
    for (const endpoint of [undefined, 'abc.lambda-microvm.us-east-1.on.aws', 'example.com']) {
      aws.reset();
      aws.on(RunMicrovmCommand).resolves(microvm('PENDING', { endpoint }));
      aws.on(TerminateMicrovmCommand).rejects(new Error('terminate failed too'));
      await expect(backend().start('tenant-a', newNonce(), creds('tenant-a'))).rejects.toThrow(/no usable MicroVM endpoint; terminating MicroVM mv-1 failed/);
      expect(aws.commandCalls(TerminateMicrovmCommand).map((c) => c.args[0].input)).toEqual([{ microvmIdentifier: 'mv-1' }]);
      aws.reset();
      aws.on(RunMicrovmCommand).resolves(microvm('PENDING', { endpoint }));
      aws.on(TerminateMicrovmCommand).resolves({});
      await expect(backend().start('tenant-a', newNonce(), creds('tenant-a'))).rejects.toThrow(/no usable MicroVM endpoint; MicroVM mv-1 was terminated/);
    }
  });

  test('a malformed image ARN is refused before any token or request', async () => {
    const bad = backend({ ...ENV_OK, [BACKEND_ENV.MICROVM_IMAGE_ARN]: `${IMAGE}:2` });
    const handle = handleOf(newNonce());
    await expect(bad.run(handle, jobFor(handle.nonce))).rejects.toThrow(/is not a MicroVM image ARN/);
    expect(aws.commandCalls(CreateMicrovmAuthTokenCommand)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('with no image configured, an endpoint is never trusted: no token, no request', async () => {
    const empty = backend({});
    const handle = handleOf(newNonce(), { address: 'https://abc.lambda-microvm.us-east-1.on.aws' });
    await expect(empty.run(handle, jobFor(handle.nonce))).rejects.toThrow(/IMAGE_ARN is not set/);
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    await expect(empty.ready(handle, rowOf(handle.nonce))).rejects.toThrow(/IMAGE_ARN is not set/);
    expect(aws.commandCalls(CreateMicrovmAuthTokenCommand)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('has the spec start cap', () => {
    expect(backend().startCapMs).toBe(20_000);
    expect(MICROVM_START_CAP_MS).toBe(20_000);
  });
});

describe('endpoints', () => {
  test('are https origins', () => {
    expect(endpointOrigin(ENDPOINT)).toBe(ORIGIN);
    expect(endpointOrigin(`${ORIGIN}/`)).toBe(ORIGIN);
    for (const bad of ['http://x.on.aws', `${ORIGIN}/path`, `${ORIGIN}?q=1`, `https://user@${ENDPOINT}`, 'ftp://x']) {
      expect(() => endpointOrigin(bad)).toThrow(/https origin/);
    }
    for (const bad of ['https://example.com', 'https://on.aws.example.com', 'https://x.on.aws.evil.test', 'https://x.on.aws', 'https://abc.lambda-url.eu-central-1.on.aws']) {
      expect(() => endpointOrigin(bad)).toThrow(/platform endpoint domain/);
    }
    expect(() => endpointOrigin(ORIGIN, 'us-east-1')).toThrow(/platform endpoint domain/);
    expect(endpointOrigin(ORIGIN, 'eu-central-1')).toBe(ORIGIN);
  });

  test('the HTTP ingress connector follows the image ARN partition and Region', () => {
    expect(httpIngressConnectorArn(IMAGE)).toBe(INGRESS);
    expect(httpIngressConnectorArn(`arn:aws-us-gov:lambda:us-gov-west-1:${ACCOUNT}:microvm-image:x`))
      .toBe('arn:aws-us-gov:lambda:us-gov-west-1:aws:network-connector:aws-network-connector:HTTP_INGRESS');
    expect(() => httpIngressConnectorArn('not-an-arn')).toThrow();
  });
});

describe('ready', () => {
  const nonce = newNonce();

  test('PENDING is still starting and reports the endpoint it learnt', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('PENDING'));
    const r = await backend().ready(handleOf(nonce, { address: undefined }), rowOf(nonce));
    expect(r).toEqual({ state: 'starting', patch: { address: ORIGIN } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('RUNNING and a healthy ping with a bootId is ready, with a one-port five-minute token', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    fetchMock.mockResolvedValue(reply(200, { status: 'Healthy', bootId: BOOT_ID }));
    const r = await backend().ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN }));
    expect(r).toEqual({ state: 'ready', patch: { bootId: BOOT_ID } });
    expect(aws.commandCalls(CreateMicrovmAuthTokenCommand)[0].args[0].input).toEqual({
      microvmIdentifier: 'mv-1', expirationInMinutes: 5, allowedPorts: [{ port: 8080 }],
    });
    expect(fetchMock).toHaveBeenCalledWith(`${ORIGIN}/ping`, expect.objectContaining({ method: 'GET', headers: { 'X-aws-proxy-auth': TOKEN } }));
  });

  test('writes the address into the patch when the row has none', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    fetchMock.mockResolvedValue(reply(200, { status: 'Healthy', bootId: BOOT_ID }));
    expect(await backend().ready(handleOf(nonce), rowOf(nonce))).toEqual({ state: 'ready', patch: { address: ORIGIN, bootId: BOOT_ID } });
  });

  test('a stuck start stays starting: no bootId yet, a refused connection, a bad status, or not JSON', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    const answers: (() => Promise<Response>)[] = [
      async () => reply(200, { status: 'Healthy' }),
      async () => reply(200, { status: 'Healthy', bootId: 'not-hex' }),
      async () => { throw new TypeError('fetch failed'); },
      async () => reply(502, 'bad gateway'),
      async () => reply(200, 'not json'),
    ];
    for (const answer of answers) {
      fetchMock.mockImplementationOnce(answer);
      expect(await backend().ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN }))).toEqual({ state: 'starting', patch: {} });
    }
  });

  test('a ping that does not answer within five seconds is still starting', async () => {
    jest.useFakeTimers();
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = backend().ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN }));
    await jest.advanceTimersByTimeAsync(4999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ state: 'starting', patch: {} });
  });

  test('a token request that fails on a MicroVM that ended since the lookup ends the start', async () => {
    aws.on(GetMicrovmCommand).resolvesOnce(microvm('RUNNING')).resolves(microvm('TERMINATING', { stateReason: 'max duration' }));
    aws.on(CreateMicrovmAuthTokenCommand).rejects(new ValidationException({ message: 'not running', $metadata: {} } as never));
    expect(await backend().ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN }))).toEqual({ state: 'ended', reason: 'not_found' });
  });

  test('a SUSPENDING MicroVM is probed like a running one', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('SUSPENDING'));
    fetchMock.mockResolvedValue(reply(200, { status: 'Healthy', bootId: BOOT_ID }));
    expect((await backend().ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN }))).state).toBe('ready');
  });

  test('an endpoint that is not a platform endpoint is never probed', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING', { endpoint: undefined }));
    expect(await backend().ready(handleOf(nonce, { address: 'https://example.com' }), rowOf(nonce, { address: 'https://example.com' })))
      .toEqual({ state: 'starting', patch: {} });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(aws.commandCalls(CreateMicrovmAuthTokenCommand)).toHaveLength(0);
  });

  test('a MicroVM that stays PENDING reports starting every time; the start cap belongs to the caller', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('PENDING'));
    const b = backend();
    for (let i = 0; i < 3; i++) {
      expect((await b.ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN }))).state).toBe('starting');
    }
  });

  test('a suspended MicroVM is probed, which resumes it', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('SUSPENDED'));
    fetchMock.mockResolvedValue(reply(200, { status: 'Healthy', bootId: BOOT_ID }));
    expect((await backend().ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN }))).state).toBe('ready');
  });

  test.each([
    ['TERMINATED', 'start failed: image', 'start failed: image'],
    ['TERMINATING', undefined, 'terminating'],
  ] as const)('%s ended the start with its reason', async (state, stateReason, reason) => {
    aws.on(GetMicrovmCommand).resolves(microvm(state, { stateReason }));
    expect(await backend().ready(handleOf(nonce), rowOf(nonce))).toEqual({ state: 'ended', reason });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a MicroVM the platform no longer knows has ended', async () => {
    aws.on(GetMicrovmCommand).rejects(new ResourceNotFoundException({ message: 'x', $metadata: {} } as never));
    expect(await backend().ready(handleOf(nonce), rowOf(nonce))).toEqual({ state: 'ended', reason: 'not_found' });
  });

  test('a token request that finds it gone ends the start too, and other errors pass up', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    aws.on(CreateMicrovmAuthTokenCommand).rejectsOnce(new ResourceNotFoundException({ message: 'x', $metadata: {} } as never));
    expect(await backend().ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN }))).toEqual({ state: 'ended', reason: 'not_found' });
    const boom = new Error('boom');
    aws.on(CreateMicrovmAuthTokenCommand).rejects(boom);
    await expect(backend().ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN }))).rejects.toBe(boom);
    aws.on(GetMicrovmCommand).rejects(boom);
    await expect(backend().ready(handleOf(nonce), rowOf(nonce))).rejects.toBe(boom);
  });
});

describe('run', () => {
  const nonce = newNonce();

  test('sends the signed job with a fresh token and returns the verified result', async () => {
    const job = jobFor(nonce);
    fetchMock.mockResolvedValue(reply(200, resultFor(job)));
    const out = await backend().run(handleOf(nonce), job);
    expect(out).toEqual({ kind: 'result', result: resultFor(job) });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/run`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'X-aws-proxy-auth': TOKEN, 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual(job);
    expect(aws.commandCalls(CreateMicrovmAuthTokenCommand)[0].args[0].input.allowedPorts).toEqual([{ port: 8080 }]);
    // A nonzero exit code, timeout and memory flags are tenant data and pass through.
    fetchMock.mockResolvedValue(reply(200, resultFor(job, { exitCode: -9, timedOut: true, memoryExceeded: true, truncated: true })));
    const again = await backend().run(handleOf(nonce), job);
    expect(again).toEqual({ kind: 'result', result: resultFor(job, { exitCode: -9, timedOut: true, memoryExceeded: true, truncated: true }) });
  });

  test.each([
    [403, 'wrong_sandbox'],
    [409, 'busy'],
    [410, 'dirty'],
    [500, 'tool_failed'],
    [200, 'wrong_sandbox'],
  ] as const)('a refusal %s %s from the runner comes back as a refusal', async (status, error) => {
    fetchMock.mockResolvedValue(reply(status, { v: 1, error, bootId: BOOT_ID }));
    expect(await backend().run(handleOf(nonce), jobFor(nonce))).toEqual({ kind: 'refused', refusal: { v: 1, error, bootId: BOOT_ID } });
  });

  test('a refusal without a usable bootId carries none; an unknown refusal is a dead handle', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { v: 1, error: 'busy', bootId: 'x' }));
    expect(await backend().run(handleOf(nonce), jobFor(nonce))).toEqual({ kind: 'refused', refusal: { v: 1, error: 'busy' } });
    fetchMock.mockResolvedValueOnce(reply(418, { v: 1, error: 'teapot' }));
    expect(await backend().run(handleOf(nonce), jobFor(nonce))).toEqual({ kind: 'dead', reason: 'unknown_refusal' });
  });

  test('a result whose proof is wrong, absent or for another nonce is a failed identity check', async () => {
    const job = jobFor(nonce);
    for (const proof of ['AAAA', resultProof(newNonce(), job.runId), undefined]) {
      fetchMock.mockResolvedValueOnce(reply(200, { ...resultFor(job), proof }));
      expect(await backend().run(handleOf(nonce), job)).toEqual({ kind: 'dead', reason: 'identity_check_failed' });
    }
  });

  test('a result that proves the nonce but is malformed is an error, not a dead handle', async () => {
    const job = jobFor(nonce);
    fetchMock.mockResolvedValueOnce(reply(200, { ...resultFor(job), runId: 'another-run' }));
    await expect(backend().run(handleOf(nonce), job)).rejects.toThrow(/bad runId/);
    fetchMock.mockResolvedValueOnce(reply(200, { ...resultFor(job), exitCode: 'zero' }));
    await expect(backend().run(handleOf(nonce), job)).rejects.toThrow(/bad exitCode/);
    fetchMock.mockResolvedValueOnce(reply(200, { ...resultFor(job), bootId: 'short' }));
    await expect(backend().run(handleOf(nonce), job)).rejects.toThrow(/bad bootId/);
  });

  test('no answer by the job timeout plus five seconds is no_answer', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = backend().run(handleOf(nonce), jobFor(nonce, { timeoutMs: 2000 }));
    await jest.advanceTimersByTimeAsync(6999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ kind: 'no_answer' });
  });

  test('a stuck body read counts against the same deadline', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => Promise.resolve({
      status: 200,
      text: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    }));
    const pending = backend().run(handleOf(nonce), jobFor(nonce, { timeoutMs: 1000 }));
    await jest.advanceTimersByTimeAsync(6000);
    expect(await pending).toEqual({ kind: 'no_answer' });
  });

  test('a connection that never opened is a dead handle', async () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH']) {
      fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code } }));
      expect(await backend().run(handleOf(nonce), jobFor(nonce))).toEqual({ kind: 'dead', reason: `connection_failed: ${code}` });
    }
  });

  test('a connection lost after the job was sent is no answer, so the tenant\'s code is not run twice', async () => {
    for (const cause of [{ code: 'ECONNRESET' }, { code: 'UND_ERR_SOCKET' }, {}]) {
      fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause }));
      expect(await backend().run(handleOf(nonce), jobFor(nonce))).toEqual({ kind: 'no_answer' });
    }
  });

  test('an address that is not a platform endpoint gets no token and no job', async () => {
    for (const address of ['https://example.com', 'http://x.on.aws', 'not a url', 'https://abc.lambda-microvm.us-east-1.on.aws']) {
      expect(await backend().run(handleOf(nonce, { address }), jobFor(nonce))).toEqual({ kind: 'dead', reason: 'bad_address' });
    }
    expect(aws.commandCalls(CreateMicrovmAuthTokenCommand)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a terminated MicroVM is a dead handle, at the token or at the lookup', async () => {
    aws.on(CreateMicrovmAuthTokenCommand).rejects(new ResourceNotFoundException({ message: 'x', $metadata: {} } as never));
    expect(await backend().run(handleOf(nonce), jobFor(nonce))).toEqual({ kind: 'dead', reason: 'not_found' });
    aws.on(CreateMicrovmAuthTokenCommand).rejects(new ValidationException({ message: 'not running', $metadata: {} } as never));
    aws.on(GetMicrovmCommand).resolves(microvm('TERMINATED'));
    expect(await backend().run(handleOf(nonce), jobFor(nonce))).toEqual({ kind: 'dead', reason: 'not_found' });
    aws.on(GetMicrovmCommand).resolves(microvm('TERMINATED', { stateReason: 'max duration' }));
    expect(await backend().run(handleOf(nonce, { address: undefined }), jobFor(nonce))).toEqual({ kind: 'dead', reason: 'max duration' });
    aws.on(GetMicrovmCommand).rejects(new ResourceNotFoundException({ message: 'x', $metadata: {} } as never));
    expect(await backend().run(handleOf(nonce, { address: undefined }), jobFor(nonce))).toEqual({ kind: 'dead', reason: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a token error on a MicroVM that is still alive is an error, not a dead handle', async () => {
    const boom = new Error('boom');
    aws.on(CreateMicrovmAuthTokenCommand).rejects(boom);
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    await expect(backend().run(handleOf(nonce), jobFor(nonce))).rejects.toBe(boom);
  });

  test('looks the endpoint up when the handle carries none', async () => {
    const job = jobFor(nonce);
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    fetchMock.mockResolvedValue(reply(200, resultFor(job)));
    expect((await backend().run(handleOf(nonce, { address: undefined }), job)).kind).toBe('result');
    expect(fetchMock.mock.calls[0][0]).toBe(`${ORIGIN}/run`);
  });

  test('a proxy 502 is no answer; other proxy errors are errors that never carry the token', async () => {
    fetchMock.mockResolvedValueOnce(reply(502, 'Bad Gateway'));
    expect(await backend().run(handleOf(nonce), jobFor(nonce))).toEqual({ kind: 'no_answer' });
    for (const status of [400, 403, 429, 500]) {
      fetchMock.mockResolvedValueOnce(reply(status, `proxy error ${TOKEN}`));
      const e = await backend().run(handleOf(nonce), jobFor(nonce)).catch((x: unknown) => x as Error);
      expect((e as Error).message).toContain(`HTTP ${status}`);
      expect((e as Error).message).not.toContain(TOKEN);
      expect((e as Error).message).not.toContain(nonce);
    }
  });

  test('sends nothing for a job that is not the handle\'s own', async () => {
    const b = backend();
    await expect(b.run(handleOf(nonce), jobFor(newNonce()))).rejects.toThrow(/does not belong/);
    await expect(b.run(handleOf(nonce), jobFor(nonce, { tenantId: 'tenant-b' }))).rejects.toThrow(/does not belong/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(aws.commandCalls(CreateMicrovmAuthTokenCommand)).toHaveLength(0);
  });

  test('a token reply without the header is an error', async () => {
    aws.on(CreateMicrovmAuthTokenCommand).resolves({ authToken: {} });
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    await expect(backend().run(handleOf(nonce), jobFor(nonce))).rejects.toThrow(/no token/);
  });
});

describe('stop, list, isAlive and stopReason', () => {
  const nonce = newNonce();

  test('stop terminates the MicroVM and ignores the tenant credentials', async () => {
    aws.on(TerminateMicrovmCommand).resolves({});
    await backend().stop(handleOf(nonce), creds('tenant-a'));
    await backend().stop(handleOf(nonce));
    expect(aws.commandCalls(TerminateMicrovmCommand).map((c) => c.args[0].input)).toEqual([{ microvmIdentifier: 'mv-1' }, { microvmIdentifier: 'mv-1' }]);
  });

  test('stop is idempotent: gone, or already ending', async () => {
    aws.on(TerminateMicrovmCommand).rejects(new ResourceNotFoundException({ message: 'x', $metadata: {} } as never));
    await expect(backend().stop(handleOf(nonce))).resolves.toBeUndefined();
    aws.on(TerminateMicrovmCommand).rejects(new ConflictException({ message: 'x', $metadata: {} } as never));
    aws.on(GetMicrovmCommand).resolves(microvm('TERMINATING'));
    await expect(backend().stop(handleOf(nonce))).resolves.toBeUndefined();
  });

  test('stop passes a conflict on a live MicroVM, and any other error, up', async () => {
    const conflict = new ConflictException({ message: 'x', $metadata: {} } as never);
    aws.on(TerminateMicrovmCommand).rejects(conflict);
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    await expect(backend().stop(handleOf(nonce))).rejects.toBe(conflict);
    const boom = new Error('boom');
    aws.on(TerminateMicrovmCommand).rejects(boom);
    await expect(backend().stop(handleOf(nonce))).rejects.toBe(boom);
  });

  test('list pages through the image\'s MicroVMs and marks only TERMINATED ones not live', async () => {
    aws.on(ListMicrovmsCommand)
      .resolvesOnce({
        nextToken: 'p2',
        items: [
          { microvmId: 'a', state: 'RUNNING', imageArn: IMAGE, imageVersion: '1', startedAt: new Date(1000) },
          { microvmId: 'b', state: 'SUSPENDED', imageArn: IMAGE, imageVersion: '1', startedAt: new Date(2000) },
        ],
      })
      .resolvesOnce({
        items: [
          { microvmId: 'c', state: 'TERMINATING', imageArn: IMAGE, imageVersion: '1', startedAt: new Date(3000) },
          { microvmId: 'd', state: 'TERMINATED', imageArn: IMAGE, imageVersion: '1', startedAt: undefined },
          { state: 'RUNNING', imageArn: IMAGE, imageVersion: '1', startedAt: undefined },
        ],
      });
    const seen = [];
    for await (const s of backend().list()) seen.push(s);
    expect(seen).toEqual([
      { backend: 'microvm', handle: 'a', startedAt: 1000, live: true },
      { backend: 'microvm', handle: 'b', startedAt: 2000, live: true },
      { backend: 'microvm', handle: 'c', startedAt: 3000, live: true },
      { backend: 'microvm', handle: 'd', startedAt: undefined, live: false },
    ]);
    expect(aws.commandCalls(ListMicrovmsCommand).map((c) => c.args[0].input)).toEqual([
      { imageIdentifier: IMAGE, nextToken: undefined },
      { imageIdentifier: IMAGE, nextToken: 'p2' },
    ]);
  });

  test('list needs only the image', async () => {
    aws.on(ListMicrovmsCommand).resolves({ items: [] });
    const seen = [];
    for await (const s of backend({ [BACKEND_ENV.MICROVM_IMAGE_ARN]: IMAGE }).list()) seen.push(s);
    expect(seen).toEqual([]);
    await expect((async () => { for await (const s of backend({}).list()) void s; })()).rejects.toThrow(/IMAGE_ARN/);
  });

  test('isAlive is false once the MicroVM is ending or gone', async () => {
    const results: boolean[] = [];
    for (const state of ['RUNNING', 'SUSPENDED', 'PENDING', 'TERMINATING', 'TERMINATED'] as const) {
      aws.on(GetMicrovmCommand).resolves(microvm(state));
      results.push(await backend().isAlive(handleOf(nonce)));
    }
    aws.on(GetMicrovmCommand).rejects(new ResourceNotFoundException({ message: 'x', $metadata: {} } as never));
    results.push(await backend().isAlive(handleOf(nonce)));
    expect(results).toEqual([true, true, true, false, false, false]);
    const boom = new Error('boom');
    aws.on(GetMicrovmCommand).rejects(boom);
    await expect(backend().isAlive(handleOf(nonce))).rejects.toBe(boom);
  });

  test('stopReason reports the platform times and reason, and nothing for an unknown MicroVM', async () => {
    aws.on(GetMicrovmCommand).resolves(microvm('TERMINATED', { terminatedAt: new Date(5000), stateReason: 'max duration' }));
    expect(await backend().stopReason(handleOf(nonce))).toEqual({ startedAt: 1000, stoppedAt: 5000, reason: 'max duration' });
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    expect(await backend().stopReason(handleOf(nonce))).toEqual({ startedAt: 1000, stoppedAt: undefined, reason: undefined });
    aws.on(GetMicrovmCommand).rejects(new ResourceNotFoundException({ message: 'x', $metadata: {} } as never));
    expect(await backend().stopReason(handleOf(nonce))).toEqual({});
    const boom = new Error('boom');
    aws.on(GetMicrovmCommand).rejects(boom);
    await expect(backend().stopReason(handleOf(nonce))).rejects.toBe(boom);
  });
});

describe('secrets', () => {
  test('no error from start, ready or run carries the nonce, the token or a response body', async () => {
    const nonce = newNonce();
    const secret = `body-${TOKEN}`;
    const seen: string[] = [];
    const record = async (call: () => Promise<unknown>) => {
      const e = await call().then(() => undefined, (x: unknown) => x);
      if (e) seen.push(`${String(e)} ${JSON.stringify(e)}`);
    };
    const b = backend();
    aws.on(RunMicrovmCommand).rejects(new ServiceQuotaExceededException({ message: 'x', $metadata: {}, quotaCode: 'L-CD1C0CC4' } as never));
    await record(() => b.start('tenant-a', nonce, creds('tenant-a')));
    aws.on(RunMicrovmCommand).resolves({});
    await record(() => b.start('tenant-a', nonce, creds('tenant-a')));
    aws.on(GetMicrovmCommand).resolves(microvm('RUNNING'));
    aws.on(CreateMicrovmAuthTokenCommand).resolves({ authToken: {} });
    await record(() => b.ready(handleOf(nonce), rowOf(nonce, { address: ORIGIN })));
    await record(() => b.run(handleOf(nonce), jobFor(nonce)));
    fetchMock.mockResolvedValue(reply(500, secret));
    aws.on(CreateMicrovmAuthTokenCommand).resolves({ authToken: { 'X-aws-proxy-auth': TOKEN } });
    await record(() => b.run(handleOf(nonce), jobFor(nonce)));
    fetchMock.mockResolvedValue(reply(200, { ...resultFor(jobFor(nonce)), exitCode: secret }));
    await record(() => b.run(handleOf(nonce), jobFor(nonce)));
    expect(seen).toHaveLength(6);
    for (const text of seen) {
      expect(text).not.toContain(nonce);
      expect(text).not.toContain(TOKEN);
    }
  });
});

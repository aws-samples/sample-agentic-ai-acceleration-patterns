// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  ResourceNotFoundException,
  RuntimeClientError,
  StopRuntimeSessionCommand,
  ThrottlingException,
} from '@aws-sdk/client-bedrock-agentcore';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import type { RegistryRow, RunOutcome, SandboxHandle, TenantCredentials } from '../src/backend';
import { NO_ANSWER_MARGIN_MS } from '../src/backend';
import { AGENTCORE_START_CAP_MS, AgentcoreBackend } from '../src/backends/agentcore';
import {
  buildJob, newNonce, resultProof, sessionIdFor, type RunJob, type RunResult,
} from '../src/protocol';

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-west-1:ACCOUNT_ID:runtime/Example_runtime-AbCdEfGhIj';
const ENV = { AGENTCORE_RUNTIME_ARN: RUNTIME_ARN };
const BOOT_ID = '0123456789abcdef0123456789abcdef';

const creds = (tenantId: string): TenantCredentials => ({
  tenantId, accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example', sessionToken: 'example',
});
const row = { version: 1 } as RegistryRow;

const mock = mockClient(BedrockAgentCoreClient);

function body(text: string, statusCode = 200) {
  return { statusCode, contentType: 'application/json', response: { transformToString: async () => text } } as never;
}

function resultFor(job: RunJob, nonce: string, patch: Partial<RunResult> = {}): RunResult {
  return {
    v: 1,
    runId: job.runId,
    exitCode: 0,
    stdout: '1\n',
    stderr: '',
    truncated: false,
    durationMs: 12,
    timedOut: false,
    memoryExceeded: false,
    bootId: BOOT_ID,
    proof: resultProof(nonce, job.runId),
    ...patch,
  };
}

async function started(tenantId = 'tenant-a'): Promise<{ backend: AgentcoreBackend; handle: SandboxHandle }> {
  const backend = new AgentcoreBackend(ENV);
  const handle = await backend.start(tenantId, newNonce(), creds(tenantId));
  return { backend, handle };
}

function jobFor(handle: SandboxHandle, patch: Partial<Parameters<typeof buildJob>[0]> = {}): RunJob {
  return buildJob({
    runId: 'run-1',
    tenantId: handle.tenantId,
    nonce: handle.nonce,
    code: 'print(1)',
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    ...patch,
  });
}

beforeEach(() => mock.reset());

describe('start and the session id (ADR-0009)', () => {
  test('the session id is 67 characters, rc- plus hex SHA-256, and identical for the same tenant', async () => {
    const { backend, handle } = await started('tenant-a');
    expect(handle.handle).toMatch(/^rc-[0-9a-f]{64}$/);
    expect(handle.handle).toHaveLength(67);
    const again = await backend.start('tenant-a', newNonce(), creds('tenant-a'));
    expect(again.handle).toBe(handle.handle);
    expect((await backend.start('tenant-b', newNonce(), creds('tenant-b'))).handle).not.toBe(handle.handle);
  });

  test.each(['A', 'a'.repeat(64), 'a-b_c'])('tenant id %s maps to a 67-character id', async (tenantId) => {
    const { handle } = await started(tenantId);
    expect(handle.handle).toHaveLength(67);
    expect(handle.handle).toBe(sessionIdFor(tenantId));
  });

  test('start makes no AWS call, carries the runtime ARN and the nonce, and has a 30 s cap', async () => {
    const nonce = newNonce();
    const backend = new AgentcoreBackend(ENV);
    const handle = await backend.start('tenant-a', nonce, creds('tenant-a'));
    expect(handle).toEqual({
      backend: 'agentcore', tenantId: 'tenant-a', handle: sessionIdFor('tenant-a'), address: RUNTIME_ARN, nonce,
    });
    expect(mock.calls()).toHaveLength(0);
    expect(backend.startCapMs).toBe(30_000);
    expect(AGENTCORE_START_CAP_MS).toBe(30_000);
  });

  test.each(['', '-a', 'a b', 'a'.repeat(65)])('refuses tenant id %j', async (tenantId) => {
    await expect(new AgentcoreBackend(ENV).start(tenantId, newNonce(), creds('x'))).rejects.toThrow(/tenant id rule/);
  });

  test('refuses a nonce that is not 32 base64url bytes', async () => {
    await expect(new AgentcoreBackend(ENV).start('tenant-a', 'AAAA', creds('tenant-a'))).rejects.toThrow(/32 bytes/);
  });

  test('a missing runtime ARN is an error that names the variable', async () => {
    await expect(new AgentcoreBackend({}).start('tenant-a', newNonce(), creds('tenant-a'))).rejects.toThrow(/AGENTCORE_RUNTIME_ARN/);
  });
});

describe('ready, list, isAlive, stopReason', () => {
  test('ready is always ready with nothing to patch', async () => {
    const { backend, handle } = await started();
    expect(await backend.ready(handle, row)).toEqual({ state: 'ready', patch: {} });
    expect(mock.calls()).toHaveLength(0);
  });

  test('list is empty, isAlive is true, stopReason has no facts, and none of them calls AWS', async () => {
    const { backend, handle } = await started();
    const listed = [];
    for await (const s of backend.list()) listed.push(s);
    expect(listed).toEqual([]);
    expect(await backend.isAlive(handle)).toBe(true);
    expect(await backend.stopReason(handle)).toEqual({});
    expect(mock.calls()).toHaveLength(0);
  });
});

describe('run', () => {
  test('sends the signed job to the tenant session and returns the checked result', async () => {
    const { backend, handle } = await started();
    const job = jobFor(handle, { input: Buffer.from([0, 255, 1]) });
    mock.on(InvokeAgentRuntimeCommand).resolves(body(JSON.stringify(resultFor(job, handle.nonce))));
    const out = await backend.run(handle, job);
    expect(out).toEqual({ kind: 'result', result: resultFor(job, handle.nonce) });
    expect(mock).toHaveReceivedCommandTimes(InvokeAgentRuntimeCommand, 1);
    const input = mock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
    expect(input.agentRuntimeArn).toBe(RUNTIME_ARN);
    expect(input.runtimeSessionId).toBe(sessionIdFor('tenant-a'));
    expect(input.contentType).toBe('application/json');
    expect(JSON.parse(Buffer.from(input.payload as Uint8Array).toString('utf8'))).toEqual(job);
  });

  test.each(['wrong_sandbox', 'busy', 'dirty', 'tool_failed'] as const)('a %s refusal is returned to the caller', async (error) => {
    const { backend, handle } = await started();
    mock.on(InvokeAgentRuntimeCommand).resolves(body(JSON.stringify({ v: 1, error, bootId: BOOT_ID })));
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'refused', refusal: { v: 1, error, bootId: BOOT_ID } });
  });

  test('a refusal without a bootId is returned without one', async () => {
    const { backend, handle } = await started();
    mock.on(InvokeAgentRuntimeCommand).resolves(body('{"v":1,"error":"dirty"}'));
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'refused', refusal: { v: 1, error: 'dirty' } });
  });

  test('a dirty session is a refusal the tool turns into a takeover, and the next start reuses the same session id', async () => {
    const { backend, handle } = await started();
    mock.on(InvokeAgentRuntimeCommand).resolves(body('{"v":1,"error":"dirty"}'));
    const out = await backend.run(handle, jobFor(handle));
    expect(out).toMatchObject({ kind: 'refused', refusal: { error: 'dirty' } });
    mock.on(StopRuntimeSessionCommand).resolves({});
    await backend.stop(handle);
    const fresh = await backend.start('tenant-a', newNonce(), creds('tenant-a'));
    expect(fresh.handle).toBe(handle.handle);
    expect(fresh.nonce).not.toBe(handle.nonce);
  });

  test.each([
    ['a proof made with another nonce', (job: RunJob) => resultFor(job, newNonce())],
    ['a proof made for another run', (job: RunJob) => resultFor(job, job.nonce, { proof: resultProof(job.nonce, 'other') })],
    ['a runId that is not the job\'s', (job: RunJob) => resultFor(job, job.nonce, { runId: 'other' })],
  ])('%s is a failed identity check and a dead handle', async (_name, make) => {
    const { backend, handle } = await started();
    const job = jobFor(handle);
    mock.on(InvokeAgentRuntimeCommand).resolves(body(JSON.stringify(make(job))));
    expect(await backend.run(handle, job)).toEqual({ kind: 'dead', reason: 'identity_check_failed' });
  });

  test.each([
    ['not JSON', 'nope', 'not_json'],
    ['an empty body', '', 'not_json'],
    ['a JSON array', '[]', 'bad_response'],
    ['null', 'null', 'bad_response'],
    ['an unknown refusal code', '{"v":1,"error":"other"}', 'bad_response'],
    ['a refusal of another version', '{"v":2,"error":"busy"}', 'bad_response'],
    ['a result with no proof', JSON.stringify({ v: 1, runId: 'run-1', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, timedOut: false, memoryExceeded: false, bootId: BOOT_ID }), 'bad_response'],
    ['a result with a bad bootId', JSON.stringify({ v: 1, runId: 'run-1', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, timedOut: false, memoryExceeded: false, bootId: 'x', proof: 'p' }), 'bad_response'],
    ['a result with a fractional exit code', JSON.stringify({ v: 1, runId: 'run-1', exitCode: 0.5, stdout: '', stderr: '', truncated: false, durationMs: 1, timedOut: false, memoryExceeded: false, bootId: BOOT_ID, proof: 'p' }), 'bad_response'],
  ])('%s is a dead handle', async (_name, text, reason) => {
    const { backend, handle } = await started();
    mock.on(InvokeAgentRuntimeCommand).resolves(body(text));
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'dead', reason });
  });

  test('an answer with no body is a dead handle', async () => {
    const { backend, handle } = await started();
    mock.on(InvokeAgentRuntimeCommand).resolves({ statusCode: 200, contentType: 'application/json' } as never);
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'dead', reason: 'not_json' });
  });

  test('a status other than 200 is a dead handle', async () => {
    const { backend, handle } = await started();
    mock.on(InvokeAgentRuntimeCommand).resolves(body('{}', 424));
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'dead', reason: 'http_424' });
  });

  test('"not found" is a dead handle', async () => {
    const { backend, handle } = await started();
    mock.on(InvokeAgentRuntimeCommand).rejects(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'dead', reason: 'not_found' });
  });

  test('a container error is a dead handle', async () => {
    const { backend, handle } = await started();
    mock.on(InvokeAgentRuntimeCommand).rejects(new RuntimeClientError({ message: 'container', $metadata: {} }));
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'dead', reason: 'runtime_client_error' });
  });

  test('a throttle or any other error reaches the caller', async () => {
    const { backend, handle } = await started();
    mock.on(InvokeAgentRuntimeCommand).rejects(new ThrottlingException({ message: 'slow down', $metadata: {} }));
    await expect(backend.run(handle, jobFor(handle))).rejects.toThrow(/slow down/);
  });

  describe('the no-answer deadline (spec §4.1 step 5)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('no answer by timeoutMs + 5 s is no_answer, and the call is aborted', async () => {
      const { backend, handle } = await started();
      let signal: AbortSignal | undefined;
      mock.on(InvokeAgentRuntimeCommand).callsFake(() => new Promise(() => undefined));
      const spy = jest.spyOn(BedrockAgentCoreClient.prototype, 'send');
      const pending: Promise<RunOutcome> = backend.run(handle, jobFor(handle, { timeoutMs: 2000 }));
      await jest.advanceTimersByTimeAsync(2000 + NO_ANSWER_MARGIN_MS - 1);
      let settled = false;
      void pending.then(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ kind: 'no_answer' });
      signal = (spy.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal;
      expect(signal.aborted).toBe(true);
    });

    test('a body that stops mid-stream is no_answer too', async () => {
      const { backend, handle } = await started();
      mock.on(InvokeAgentRuntimeCommand).resolves({
        statusCode: 200, contentType: 'application/json', response: { transformToString: () => new Promise(() => undefined) },
      } as never);
      const pending = backend.run(handle, jobFor(handle, { timeoutMs: 1000 }));
      await jest.advanceTimersByTimeAsync(1000 + NO_ANSWER_MARGIN_MS);
      expect(await pending).toEqual({ kind: 'no_answer' });
    });

    test('a late failure after no_answer is not an unhandled rejection', async () => {
      const { backend, handle } = await started();
      let reject: (e: Error) => void = () => undefined;
      mock.on(InvokeAgentRuntimeCommand).callsFake(() => new Promise((_resolve, rej) => { reject = rej; }));
      const pending = backend.run(handle, jobFor(handle, { timeoutMs: 1000 }));
      await jest.advanceTimersByTimeAsync(1000 + NO_ANSWER_MARGIN_MS);
      expect(await pending).toEqual({ kind: 'no_answer' });
      reject(new Error('aborted'));
      await jest.advanceTimersByTimeAsync(0);
    });
  });

  describe('handle checks (S-8: the session id is derived by code)', () => {
    test('a handle that names another tenant\'s session is never sent', async () => {
      const { backend, handle } = await started('tenant-a');
      const other = { ...handle, handle: sessionIdFor('tenant-b') };
      await expect(backend.run(other, jobFor(handle))).rejects.toThrow(/not this tenant's session/);
      await expect(backend.stop(other)).rejects.toThrow(/not this tenant's session/);
      expect(mock.calls()).toHaveLength(0);
    });

    test('a handle of another backend is never sent', async () => {
      const { backend, handle } = await started();
      await expect(backend.run({ ...handle, backend: 'nitro' }, jobFor(handle))).rejects.toThrow(/not this tenant's session/);
      expect(mock.calls()).toHaveLength(0);
    });

    test('a job for another tenant or signed with another nonce is never sent', async () => {
      const { backend, handle } = await started('tenant-a');
      const otherTenant = buildJob({ runId: 'r', tenantId: 'tenant-b', nonce: handle.nonce, code: '', timeoutMs: 1000, maxOutputBytes: 1 });
      const otherNonce = buildJob({ runId: 'r', tenantId: 'tenant-a', nonce: newNonce(), code: '', timeoutMs: 1000, maxOutputBytes: 1 });
      await expect(backend.run(handle, otherTenant)).rejects.toThrow(/does not belong/);
      await expect(backend.run(handle, otherNonce)).rejects.toThrow(/does not belong/);
      expect(mock.calls()).toHaveLength(0);
    });
  });
});

describe('stop', () => {
  test('stops the tenant\'s session on the runtime', async () => {
    const { backend, handle } = await started();
    mock.on(StopRuntimeSessionCommand).resolves({});
    await backend.stop(handle);
    expect(mock).toHaveReceivedCommandTimes(StopRuntimeSessionCommand, 1);
    expect(mock).toHaveReceivedCommandWith(StopRuntimeSessionCommand, {
      agentRuntimeArn: RUNTIME_ARN, runtimeSessionId: sessionIdFor('tenant-a'),
    });
  });

  test('stopping with credentials does the same (the reaper passes none)', async () => {
    const { backend, handle } = await started();
    mock.on(StopRuntimeSessionCommand).resolves({});
    await backend.stop(handle, creds('tenant-a'));
    expect(mock).toHaveReceivedCommandTimes(StopRuntimeSessionCommand, 1);
  });

  test('a session that is already gone is a stop that has happened', async () => {
    const { backend, handle } = await started();
    mock.on(StopRuntimeSessionCommand).rejects(new ResourceNotFoundException({ message: 'no session', $metadata: {} }));
    await expect(backend.stop(handle)).resolves.toBeUndefined();
  });

  test('any other failure reaches the caller', async () => {
    const { backend, handle } = await started();
    mock.on(StopRuntimeSessionCommand).rejects(new ThrottlingException({ message: 'slow down', $metadata: {} }));
    await expect(backend.stop(handle)).rejects.toThrow(/slow down/);
  });
});

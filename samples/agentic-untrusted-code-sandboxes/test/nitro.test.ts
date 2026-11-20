// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createHash } from 'node:crypto';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  DeregisterContainerInstanceCommand,
  DescribeContainerInstancesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListContainerInstancesCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import { mockClient } from 'aws-sdk-client-mock';
import type { RegistryRow, SandboxHandle, TenantCredentials } from '../src/backend';
import {
  NitroBackend,
  NITRO_ENV,
  RunnerConnectionError,
  RunnerTimeoutError,
  runnerCrashed,
  stopFacts,
  taskAddress,
  type Connect,
  type HttpReply,
  type RunnerConnection,
} from '../src/backends/nitro';
import {
  buildJob,
  helloProof,
  newNonce,
  nonceHash,
  resultProof,
  startToken,
  type RunJob,
} from '../src/protocol';

// An account id built at run time: the terms check refuses a 12-digit literal anywhere in the tree.
const ACCOUNT = '1'.repeat(12);
const CLUSTER = `arn:aws:ecs:eu-central-1:${ACCOUNT}:cluster/c1`;
const TASK_DEF = `arn:aws:ecs:eu-central-1:${ACCOUNT}:task-definition/td:7`;
const TASK = `arn:aws:ecs:eu-central-1:${ACCOUNT}:task/c1/aaaa`;
const ENV = {
  [NITRO_ENV.CLUSTER_ARN]: CLUSTER,
  [NITRO_ENV.TASK_DEFINITION_ARN]: TASK_DEF,
  [NITRO_ENV.CONTAINER_NAME]: 'runner',
  [NITRO_ENV.SUBNET_IDS]: 'subnet-1,subnet-2',
  [NITRO_ENV.SECURITY_GROUP_ID]: 'sg-task',
};
const FP = createHash('sha256').update('the runner certificate').digest('hex');
const OTHER_FP = createHash('sha256').update('another certificate').digest('hex');
const BOOT_ID = '0123456789abcdef0123456789abcdef';
const row = { version: 1 } as RegistryRow;

const creds = (tenantId: string): TenantCredentials => ({
  tenantId, accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example-secret', sessionToken: 'example-token',
});

function eniTask(over: Partial<Task> = {}, ip = '10.0.8.21'): Task {
  return {
    taskArn: TASK,
    lastStatus: 'RUNNING',
    desiredStatus: 'RUNNING',
    attachments: [{ type: 'ElasticNetworkInterface', details: [{ name: 'subnetId', value: 'subnet-1' }, { name: 'privateIPv4Address', value: ip }] }],
    containers: [{ name: 'runner' }],
    ...over,
  };
}

type HelloMode = 'honest' | 'wrong_sandbox' | 'bad_proof' | 'other_fingerprint' | 'unavailable' | 'garbage';
type RunMode = 'result' | 'bad_proof' | 'other_run_id' | 'busy' | 'dirty' | 'wrong_sandbox' | 'tool_failed' | 'garbage' | 'http500' | 'timeout' | 'reset' | 'oversize';

/** A runner on the other side of a fake connection; it records every request it gets. */
class FakeRunner {
  public hello: HelloMode = 'honest';
  public run: RunMode = 'result';
  public connectError?: Error;
  public readonly requests: { path: string; body: Record<string, unknown>; timeoutMs: number; maxBytes: number }[] = [];
  public readonly connects: { host: string; port: number }[] = [];
  public closed = 0;
  /** Nonce the runner holds; the tool's own by default. */
  public heldNonce?: string;
  public constructor(private readonly nonce: string) {}

  public readonly connect: Connect = async (host, port) => {
    this.connects.push({ host, port });
    if (this.connectError) throw this.connectError;
    const conn: RunnerConnection = {
      fingerprint: FP,
      close: () => { this.closed += 1; },
      post: async (path, body, timeoutMs, maxBytes) => this.handle(path, JSON.parse(body) as Record<string, unknown>, timeoutMs, maxBytes),
    };
    return conn;
  };

  private async handle(path: string, body: Record<string, unknown>, timeoutMs: number, maxBytes: number): Promise<HttpReply> {
    this.requests.push({ path, body, timeoutMs, maxBytes });
    const held = this.heldNonce ?? this.nonce;
    if (path === '/hello') {
      switch (this.hello) {
        case 'unavailable': return { status: 503, body: 'busy booting' };
        case 'garbage': return { status: 200, body: 'not json' };
        case 'wrong_sandbox': return { status: 403, body: JSON.stringify({ v: 1, error: 'wrong_sandbox' }) };
        default: break;
      }
      if (body.nonce !== held) return { status: 403, body: JSON.stringify({ v: 1, error: 'wrong_sandbox' }) };
      const fp = this.hello === 'other_fingerprint' ? OTHER_FP : FP;
      const proof = this.hello === 'bad_proof' ? 'A'.repeat(43) : helloProof(held, body.challenge as string, fp);
      return { status: 200, body: JSON.stringify({ v: 1, bootId: BOOT_ID, certFingerprint: fp, proof }) };
    }
    const job = body as unknown as RunJob;
    switch (this.run) {
      case 'timeout': throw new RunnerTimeoutError('the runner did not answer in time');
      case 'reset': throw new RunnerConnectionError('connection lost');
      case 'oversize': throw new RunnerConnectionError('the runner answer is larger than allowed');
      case 'busy': return { status: 409, body: JSON.stringify({ v: 1, error: 'busy' }) };
      case 'dirty': return { status: 410, body: JSON.stringify({ v: 1, error: 'dirty', bootId: BOOT_ID }) };
      case 'wrong_sandbox': return { status: 403, body: JSON.stringify({ v: 1, error: 'wrong_sandbox' }) };
      case 'tool_failed': return { status: 500, body: JSON.stringify({ v: 1, error: 'tool_failed' }) };
      case 'garbage': return { status: 200, body: '<html>' };
      case 'http500': return { status: 500, body: '{}' };
      default: break;
    }
    const runId = this.run === 'other_run_id' ? 'another-run' : job.runId;
    const proof = this.run === 'bad_proof' ? 'B'.repeat(43) : resultProof(held, runId);
    return {
      status: 200,
      body: JSON.stringify({
        v: 1,
        runId,
        exitCode: 0,
        stdout: 'hi\n',
        stderr: '',
        truncated: false,
        durationMs: 12,
        timedOut: false,
        memoryExceeded: false,
        bootId: BOOT_ID,
        proof,
      }),
    };
  }
}

const ecsMock = mockClient(ECSClient);
const ec2Mock = mockClient(EC2Client);

beforeEach(() => {
  ecsMock.reset();
  ec2Mock.reset();
});

function make(nonce: string, runner = new FakeRunner(nonce), env: Record<string, string | undefined> = ENV, now = () => 1_000_000) {
  const sleeps: number[] = [];
  const backend = new NitroBackend(env, {
    connect: runner.connect,
    now,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const handle: SandboxHandle = { backend: 'nitro', tenantId: 'tenant-a', handle: TASK, address: '10.0.8.21', nonce };
  return { backend, runner, handle, sleeps };
}

const jobFor = (h: SandboxHandle, over: { timeoutMs?: number; maxOutputBytes?: number } = {}) =>
  buildJob({ runId: 'run-1', tenantId: h.tenantId, nonce: h.nonce, code: 'print(1)', timeoutMs: over.timeoutMs ?? 30000, maxOutputBytes: over.maxOutputBytes ?? 262144 });

describe('start', () => {
  test('RunTask carries the hash and the idempotency token, never the nonce, and the tenant tag', async () => {
    const nonce = newNonce();
    ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK }] });
    const { backend } = make(nonce);
    const handle = await backend.start('tenant-a', nonce, creds('tenant-a'));
    expect(handle).toEqual({ backend: 'nitro', tenantId: 'tenant-a', handle: TASK, nonce });
    expect(handle.address).toBeUndefined();

    const calls = ecsMock.commandCalls(RunTaskCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input).toMatchObject({
      cluster: CLUSTER,
      taskDefinition: TASK_DEF,
      count: 1,
      clientToken: startToken(nonce),
      tags: [{ key: 'TenantId', value: 'tenant-a' }],
      networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-1', 'subnet-2'], securityGroups: ['sg-task'], assignPublicIp: 'DISABLED' } },
      overrides: { containerOverrides: [{ name: 'runner', environment: [{ name: 'RUNNER_NONCE_HASH', value: nonceHash(nonce) }] }] },
    });
    expect(JSON.stringify(input)).not.toContain(nonce);
    // the override carries only the hash, so a reader of DescribeTasks learns no nonce
    expect(input.launchType).toBeUndefined();
    expect(input.overrides?.taskRoleArn).toBeUndefined();
  });

  test('the integration test hook adds the runner\'s fail-at-boot variable only when asked and only on a function that honours the hooks', async () => {
    const nonce = newNonce();
    ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK }] });
    const hooks = { ...ENV, RC_INTEG_OVERRIDES: '1' };
    const withHooks = make(nonce, undefined, hooks).backend;
    const plain = make(nonce).backend;
    const envOf = () => ecsMock.commandCalls(RunTaskCommand).at(-1)?.args[0].input.overrides?.containerOverrides?.[0].environment;
    const hashOnly = [{ name: 'RUNNER_NONCE_HASH', value: nonceHash(nonce) }];
    await withHooks.start('tenant-a', nonce, creds('tenant-a'), { failAtBoot: true });
    expect(envOf()).toEqual([...hashOnly, { name: 'RUNNER_FAIL_AT_BOOT', value: '1' }]);
    await withHooks.start('tenant-a', nonce, creds('tenant-a'), { failAtBoot: false });
    expect(envOf()).toEqual(hashOnly);
    await withHooks.start('tenant-a', nonce, creds('tenant-a'), {});
    await withHooks.start('tenant-a', nonce, creds('tenant-a'));
    expect(envOf()).toEqual(hashOnly);
    // a production function (hooks not set, or set to another value) never sends it, even when asked
    await plain.start('tenant-a', nonce, creds('tenant-a'), { failAtBoot: true });
    expect(envOf()).toEqual(hashOnly);
    await make(nonce, undefined, { ...ENV, RC_INTEG_OVERRIDES: 'true' }).backend.start('tenant-a', nonce, creds('tenant-a'), { failAtBoot: true });
    expect(envOf()).toEqual(hashOnly);
  });

  test('RunTask is signed with the tenant credentials, not the ambient ones', async () => {
    const nonce = newNonce();
    ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK }] });
    const { backend } = make(nonce);
    await backend.start('tenant-a', nonce, creds('tenant-a'));
    const client = ecsMock.commandCalls(RunTaskCommand)[0].thisValue as unknown as ECSClient;
    const c = await (client.config.credentials as () => Promise<{ accessKeyId: string; sessionToken: string }>)();
    expect(c.accessKeyId).toBe('AKIAEXAMPLE');
    expect(c.sessionToken).toBe('example-token');
  });

  test('a RunTask failure with no task throws with ECS reason', async () => {
    ecsMock.on(RunTaskCommand).resolves({ tasks: [], failures: [{ arn: 'x', reason: 'CAPACITY_PROVIDER_ERROR' }] });
    const nonce = newNonce();
    await expect(make(nonce).backend.start('tenant-a', nonce, creds('tenant-a'))).rejects.toThrow(/RunTask failed: CAPACITY_PROVIDER_ERROR/);
  });

  test('credentials of another tenant are refused before any call', async () => {
    const nonce = newNonce();
    await expect(make(nonce).backend.start('tenant-a', nonce, creds('tenant-b'))).rejects.toThrow(/another tenant/);
    expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0);
  });

  test('a missing environment variable is named', async () => {
    const nonce = newNonce();
    const env = { ...ENV, [NITRO_ENV.SECURITY_GROUP_ID]: undefined };
    await expect(make(nonce, undefined, env).backend.start('tenant-a', nonce, creds('tenant-a'))).rejects.toThrow(/NITRO_SECURITY_GROUP_ID is not set/);
  });

  test('the start cap is five minutes', () => {
    expect(make(newNonce()).backend.startCapMs).toBe(300_000);
  });
});

describe('ready', () => {
  test.each(['PROVISIONING', 'PENDING', 'ACTIVATING'])('%s is still starting and nothing is dialled', async (lastStatus) => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask({ lastStatus })] });
    const { backend, runner, handle } = make(nonce);
    expect(await backend.ready(handle, row)).toEqual({ state: 'starting', patch: {} });
    expect(runner.connects).toHaveLength(0);
  });

  test('RUNNING and a good /hello: ready, with the ENI address and the boot id', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask()] });
    const { backend, runner, handle } = make(nonce);
    const noAddress = { ...handle, address: undefined };
    expect(await backend.ready(noAddress, row)).toEqual({ state: 'ready', patch: { address: '10.0.8.21', bootId: BOOT_ID } });
    expect(runner.connects).toEqual([{ host: '10.0.8.21', port: 8443 }]);
    expect(runner.requests.map((r) => r.path)).toEqual(['/hello']);
    expect(runner.closed).toBe(1);
  });

  test('the address comes from DescribeTasks, never from the row (a recycled IP)', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask({}, '10.0.9.77')] });
    const { backend, runner, handle } = make(nonce);
    const stale = { ...row, address: '10.0.8.21' } as RegistryRow;
    expect(await backend.ready({ ...handle, address: '10.0.8.21' }, stale)).toMatchObject({ state: 'ready', patch: { address: '10.0.9.77' } });
    expect(runner.connects[0].host).toBe('10.0.9.77');
  });

  test('RUNNING but the runner is not listening yet: still starting, with the address', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask()] });
    const { backend, runner, handle } = make(nonce);
    runner.connectError = new RunnerConnectionError('connect failed: ECONNREFUSED');
    expect(await backend.ready(handle, row)).toEqual({ state: 'starting', patch: { address: '10.0.8.21' } });
  });

  test('RUNNING but no ENI address yet: still starting', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask({ attachments: [] })] });
    const { backend, runner, handle } = make(nonce);
    expect(await backend.ready(handle, row)).toEqual({ state: 'starting', patch: {} });
    expect(runner.connects).toHaveLength(0);
  });

  test.each<[HelloMode]>([['unavailable'], ['garbage']])('a /hello answer of %s is not a failed start', async (mode) => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask()] });
    const { backend, runner, handle } = make(nonce);
    runner.hello = mode;
    expect((await backend.ready(handle, row)).state).toBe('starting');
  });

  test.each<[HelloMode]>([['wrong_sandbox'], ['bad_proof'], ['other_fingerprint']])('a /hello that fails the identity check (%s) ends the start', async (mode) => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask()] });
    const { backend, runner, handle } = make(nonce);
    runner.hello = mode;
    expect((await backend.ready(handle, row)).state).toBe('ended');
  });

  test('a runner holding another nonce answers wrong_sandbox and the start has ended', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask()] });
    const { backend, runner, handle } = make(nonce);
    runner.heldNonce = newNonce();
    expect(await backend.ready(handle, row)).toEqual({ state: 'ended', reason: 'wrong_sandbox' });
  });

  test('a /hello timeout is still starting', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask()] });
    const { handle } = make(nonce);
    const slow = new NitroBackend(ENV, {
      connect: async () => ({ fingerprint: FP, close: () => undefined, post: async () => { throw new RunnerTimeoutError('x'); } }),
    });
    expect(await slow.ready(handle, row)).toEqual({ state: 'starting', patch: { address: '10.0.8.21' } });
  });

  test('a task STOPPED before any ready check is a failed start with its reason; the address is not dialled', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [eniTask({ lastStatus: 'STOPPED', desiredStatus: 'STOPPED', stoppedReason: 'Essential container in task exited', containers: [{ name: 'runner', exitCode: 1 }] })],
    });
    const { backend, runner, handle } = make(nonce);
    expect(await backend.ready(handle, row)).toEqual({ state: 'ended', reason: 'Essential container in task exited (runner exit code 1)' });
    expect(runner.connects).toHaveLength(0);
  });

  test('a task whose desired status is STOPPED is ended even while it still reports RUNNING', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask({ desiredStatus: 'STOPPED', stoppedReason: 'Task stopped by user' })] });
    const { backend, runner, handle } = make(nonce);
    expect(await backend.ready(handle, row)).toEqual({ state: 'ended', reason: 'Task stopped by user' });
    expect(runner.connects).toHaveLength(0);
  });

  test('a task ECS no longer knows is ended', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [], failures: [{ arn: TASK, reason: 'MISSING' }] });
    const { backend, handle } = make(nonce);
    expect(await backend.ready(handle, row)).toEqual({ state: 'ended', reason: 'task not found' });
  });

  test('a task ECS does not describe yet, a moment after its row was made, is still starting', async () => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [], failures: [{ arn: TASK, reason: 'MISSING' }] });
    const { backend, handle } = make(nonce, undefined, ENV, () => 1_000_000);
    const young = { version: 1, createdAt: 1_000_000 - 29_000 } as RegistryRow;
    const old = { version: 1, createdAt: 1_000_000 - 31_000 } as RegistryRow;
    expect(await backend.ready(handle, young)).toEqual({ state: 'starting', patch: {} });
    expect(await backend.ready(handle, old)).toEqual({ state: 'ended', reason: 'task not found' });
  });

  test.each(['DEACTIVATING', 'STOPPING', 'DEPROVISIONING'])('%s ends the start even while ECS still wants it RUNNING', async (lastStatus) => {
    const nonce = newNonce();
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask({ lastStatus, stoppedReason: 'Essential container exited' })] });
    const { backend, runner, handle } = make(nonce);
    expect(await backend.ready(handle, row)).toEqual({ state: 'ended', reason: 'Essential container exited' });
    expect(runner.connects).toHaveLength(0);
  });
});

describe('run', () => {
  test('proves the sandbox on the connection, then sends the job on the same connection', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    const job = jobFor(handle);
    const out = await backend.run(handle, job);
    expect(out.kind).toBe('result');
    if (out.kind === 'result') {
      expect(out.result.stdout).toBe('hi\n');
      expect(out.result.bootId).toBe(BOOT_ID);
    }
    expect(runner.connects).toEqual([{ host: '10.0.8.21', port: 8443 }]);
    expect(runner.requests.map((r) => r.path)).toEqual(['/hello', '/run']);
    expect(runner.requests[1].body).toEqual(JSON.parse(JSON.stringify(job)));
    expect(runner.closed).toBe(1);
  });

  test('waits at most timeoutMs plus five seconds, counted from the call', async () => {
    const nonce = newNonce();
    let t = 5_000_000;
    const runner = new FakeRunner(nonce);
    // 2 s pass while the connection opens
    const backend = new NitroBackend(ENV, {
      connect: async (h, p, to) => { t += 2000; return runner.connect(h, p, to); },
      now: () => t,
    });
    const handle: SandboxHandle = { backend: 'nitro', tenantId: 'tenant-a', handle: TASK, address: '10.0.8.21', nonce };
    await backend.run(handle, jobFor(handle, { timeoutMs: 10_000 }));
    expect(runner.requests.find((r) => r.path === '/run')?.timeoutMs).toBe(10_000 + 5000 - 2000);
    // the /hello is bounded too, and never by more than five seconds
    expect(runner.requests.find((r) => r.path === '/hello')?.timeoutMs).toBe(5000);
  });

  test('bounds the answer it reads by the output limit', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    await backend.run(handle, jobFor(handle, { maxOutputBytes: 1000 }));
    expect(runner.requests.find((r) => r.path === '/run')?.maxBytes).toBe(1000 * 6 + 65536);
  });

  test('a recycled address: the runner there holds another nonce, so no job bytes are sent', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    runner.heldNonce = newNonce();
    const out = await backend.run(handle, jobFor(handle));
    expect(out).toEqual({ kind: 'dead', reason: 'wrong_sandbox' });
    expect(runner.requests.map((r) => r.path)).toEqual(['/hello']);
    expect(JSON.stringify(runner.requests)).not.toContain('print(1)');
    expect(runner.closed).toBe(1);
  });

  test.each<[HelloMode, string]>([
    ['bad_proof', 'the /hello proof does not match'],
    ['other_fingerprint', 'the /hello proof does not match'],
    ['unavailable', 'unusable /hello answer (HTTP 503)'],
    ['garbage', 'unusable /hello answer (HTTP 200)'],
  ])('a /hello of %s is a dead handle and no job is sent', async (mode, reason) => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    runner.hello = mode;
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'dead', reason });
    expect(runner.requests.map((r) => r.path)).toEqual(['/hello']);
  });

  test('a stopped task (connection refused) is a dead handle', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    runner.connectError = new RunnerConnectionError('connect failed: ECONNREFUSED');
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'dead', reason: 'connect_failed: ECONNREFUSED' });
  });

  test('a connect timeout on a vanished instance is a dead handle', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    runner.connectError = new RunnerTimeoutError('connect timed out');
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'dead', reason: 'connect_timeout' });
  });

  test('a handle with no address is dead before any connection', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    expect(await backend.run({ ...handle, address: undefined }, jobFor(handle))).toEqual({ kind: 'dead', reason: 'no address recorded' });
    expect(runner.connects).toHaveLength(0);
  });

  test.each<[RunMode, string]>([['busy', 'busy'], ['dirty', 'dirty'], ['wrong_sandbox', 'wrong_sandbox'], ['tool_failed', 'tool_failed']])(
    'the runner refusal %s reaches the tool as a refusal', async (mode, error) => {
      const nonce = newNonce();
      const { backend, runner, handle } = make(nonce);
      runner.run = mode;
      const out = await backend.run(handle, jobFor(handle));
      expect(out).toMatchObject({ kind: 'refused', refusal: { v: 1, error } });
    });

  test('no answer by the deadline is no_answer', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    runner.run = 'timeout';
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'no_answer' });
    expect(runner.closed).toBe(1);
  });

  test('a connection lost after /hello succeeded is no_answer, never a dead handle (the job may have run)', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    runner.run = 'reset';
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'no_answer' });
    expect(runner.requests.map((r) => r.path)).toEqual(['/hello', '/run']);
  });

  test('an answer past the output limit is no_answer', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    runner.run = 'oversize';
    expect(await backend.run(handle, jobFor(handle))).toEqual({ kind: 'no_answer' });
  });

  test('a connect error reason is a code: the task address and port never reach the reason', async () => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    runner.connectError = new RunnerConnectionError('connect failed: connect ETIMEDOUT 10.0.12.34:8443');
    const out = await backend.run(handle, jobFor(handle));
    expect(out).toEqual({ kind: 'dead', reason: 'connect_failed: ETIMEDOUT' });
    expect(JSON.stringify(out)).not.toMatch(/10\.0\.12\.34|8443/);
  });

  test.each([
    ['a result missing a field', { v: 1, runId: 'run-1', exitCode: 0 }],
    ['a result of another protocol version', { v: 2, runId: 'run-1', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, timedOut: false, memoryExceeded: false, bootId: BOOT_ID, proof: 'x' }],
    ['a result with a non-integer exit code', { v: 1, runId: 'run-1', exitCode: 'zero', stdout: '', stderr: '', truncated: false, durationMs: 1, timedOut: false, memoryExceeded: false, bootId: BOOT_ID, proof: 'x' }],
    ['a refusal with an unknown code', { v: 1, error: 'teapot' }],
  ])('%s is a dead handle', async (_name, payload) => {
    const nonce = newNonce();
    const { handle } = make(nonce);
    const odd: Connect = async () => ({
      fingerprint: FP,
      close: () => undefined,
      post: async (path, body) => {
        if (path === '/hello') return { status: 200, body: JSON.stringify({ v: 1, bootId: BOOT_ID, certFingerprint: FP, proof: helloProof(nonce, JSON.parse(body).challenge, FP) }) };
        return { status: 200, body: JSON.stringify(payload) };
      },
    });
    const out = await new NitroBackend(ENV, { connect: odd }).run(handle, jobFor(handle));
    expect(out).toEqual({ kind: 'dead', reason: 'unusable runner answer (HTTP 200)' });
  });

  test.each<[RunMode, RegExp]>([
    ['bad_proof', /result proof/],
    ['other_run_id', /result proof/],
    ['garbage', /unusable runner answer \(HTTP 200\)/],
    ['http500', /unusable runner answer \(HTTP 500\)/],
  ])('an answer of %s is a dead handle, never a result', async (mode, reason) => {
    const nonce = newNonce();
    const { backend, runner, handle } = make(nonce);
    runner.run = mode;
    const out = await backend.run(handle, jobFor(handle));
    expect(out.kind).toBe('dead');
    if (out.kind === 'dead') expect(out.reason).toMatch(reason);
  });

  test('a job for another sandbox is a defect, not a dead handle', async () => {
    const nonce = newNonce();
    const { backend, handle } = make(nonce);
    const other = jobFor({ ...handle, nonce: newNonce() });
    await expect(backend.run(handle, other)).rejects.toThrow(/does not belong/);
    await expect(backend.run(handle, { ...jobFor(handle), tenantId: 'tenant-b' })).rejects.toThrow(/does not belong/);
  });
});

describe('stop', () => {
  test('StopTask with the tenant credentials on the tool path', async () => {
    const nonce = newNonce();
    ecsMock.on(StopTaskCommand).resolves({});
    const { backend, handle } = make(nonce);
    await backend.stop(handle, creds('tenant-a'));
    const calls = ecsMock.commandCalls(StopTaskCommand);
    expect(calls[0].args[0].input).toMatchObject({ cluster: CLUSTER, task: TASK });
    expect(calls[0].args[0].input.reason).not.toContain('tenant');
    const client = calls[0].thisValue as unknown as ECSClient;
    const c = await (client.config.credentials as () => Promise<{ accessKeyId: string }>)();
    expect(c.accessKeyId).toBe('AKIAEXAMPLE');
  });

  test('StopTask with the ambient role for the reaper, the drain and offboard', async () => {
    ecsMock.on(StopTaskCommand).resolves({});
    const { backend, handle } = make(newNonce());
    await backend.stop(handle);
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(1);
  });

  test('a task ECS no longer knows is already stopped', async () => {
    const err = Object.assign(new Error('The referenced task was not found.'), { name: 'InvalidParameterException' });
    ecsMock.on(StopTaskCommand).rejects(err);
    const { backend, handle } = make(newNonce());
    await expect(backend.stop(handle)).resolves.toBeUndefined();
  });

  test.each([
    ['AccessDeniedException', 'User is not authorized to perform: ecs:StopTask'],
    ['ClusterNotFoundException', 'Cluster not found.'],
  ])('%s is the caller\'s to handle', async (name, message) => {
    ecsMock.on(StopTaskCommand).rejects(Object.assign(new Error(message), { name }));
    const { backend, handle } = make(newNonce());
    await expect(backend.stop(handle)).rejects.toThrow(message);
  });

  describe('with the tenant credentials, where a task ECS has dropped has no tag for IAM to check', () => {
    const denied = () => Object.assign(new Error('not authorized to perform: ecs:StopTask'), { name: 'AccessDeniedException' });

    test.each([
      ['a task ECS no longer lists', { tasks: [], failures: [{ arn: TASK, reason: 'MISSING' }] }],
      ['a task that is STOPPED', { tasks: [eniTask({ lastStatus: 'STOPPED' })] }],
    ])('AccessDenied for %s is already stopped', async (_name, described) => {
      ecsMock.on(StopTaskCommand).rejects(denied());
      ecsMock.on(DescribeTasksCommand).resolves(described);
      const { backend, handle } = make(newNonce());
      await expect(backend.stop(handle, creds('tenant-a'))).resolves.toBeUndefined();
    });

    test('AccessDenied for a task that still runs (another tenant\'s) is the caller\'s error', async () => {
      ecsMock.on(StopTaskCommand).rejects(denied());
      ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask()] });
      const { backend, handle } = make(newNonce());
      await expect(backend.stop(handle, creds('tenant-a'))).rejects.toThrow(/not authorized/);
    });

    test('if the check of the task fails too, the access error is the one reported', async () => {
      ecsMock.on(StopTaskCommand).rejects(denied());
      ecsMock.on(DescribeTasksCommand).rejects(new Error('Rate exceeded'));
      const { backend, handle } = make(newNonce());
      await expect(backend.stop(handle, creds('tenant-a'))).rejects.toThrow(/not authorized/);
    });

    test('the ambient path does not second-guess an AccessDenied', async () => {
      ecsMock.on(StopTaskCommand).rejects(denied());
      ecsMock.on(DescribeTasksCommand).resolves({ tasks: [] });
      const { backend, handle } = make(newNonce());
      await expect(backend.stop(handle)).rejects.toThrow(/not authorized/);
      expect(ecsMock.commandCalls(DescribeTasksCommand)).toHaveLength(0);
    });
  });
});

describe('list, isAlive, stopReason', () => {
  const t = (n: number, over: Partial<Task> = {}): Task => ({
    taskArn: `arn:aws:ecs:eu-central-1:${ACCOUNT}:task/c1/t${n}`,
    lastStatus: 'RUNNING',
    desiredStatus: 'RUNNING',
    startedAt: new Date(1_700_000_000_000 + n),
    tags: [{ key: 'TenantId', value: `tenant-${n}` }],
    ...over,
  });

  async function collect(backend: NitroBackend) {
    const out = [];
    for await (const s of backend.list()) out.push(s);
    return out;
  }

  test('lists running and stopping tasks, with tenant, start time and live', async () => {
    ecsMock.on(ListTasksCommand, { desiredStatus: 'RUNNING' }).resolves({ taskArns: [t(1).taskArn!, t(2).taskArn!] });
    ecsMock.on(ListTasksCommand, { desiredStatus: 'STOPPED' }).resolves({ taskArns: [t(3).taskArn!, t(4).taskArn!, t(2).taskArn!] });
    ecsMock.on(DescribeTasksCommand).callsFake((input: { tasks: string[] }) => ({
      tasks: input.tasks.map((arn) => {
        const n = Number(arn.slice(arn.lastIndexOf('t') + 1));
        if (n === 3) return t(3, { desiredStatus: 'STOPPED', lastStatus: 'RUNNING' });
        if (n === 4) return t(4, { desiredStatus: 'STOPPED', lastStatus: 'STOPPED', startedAt: undefined });
        if (n === 2) return t(2, { tags: [] });
        return t(1);
      }),
    }));
    const { backend } = make(newNonce());
    const got = await collect(backend);
    expect(got).toEqual([
      { backend: 'nitro', handle: t(1).taskArn, tenantId: 'tenant-1', startedAt: 1_700_000_000_001, live: true },
      { backend: 'nitro', handle: t(2).taskArn, startedAt: 1_700_000_000_002, live: true },
      // desired STOPPED, still RUNNING for 45 to 78 s (S-7): a capacity provider delete must wait for it
      { backend: 'nitro', handle: t(3).taskArn, tenantId: 'tenant-3', startedAt: 1_700_000_000_003, live: true },
      { backend: 'nitro', handle: t(4).taskArn, tenantId: 'tenant-4', live: false },
    ]);
    // task 2 is on both lists and listed once, and every describe asks for tags
    expect(ecsMock.commandCalls(DescribeTasksCommand).every((c) => c.args[0].input.include?.includes('TAGS'))).toBe(true);
  });

  test('pages through ListTasks and describes in chunks of 100', async () => {
    const arns = Array.from({ length: 230 }, (_, i) => t(i).taskArn!);
    ecsMock.on(ListTasksCommand, { desiredStatus: 'RUNNING', nextToken: undefined }).resolves({ taskArns: arns.slice(0, 120), nextToken: 'p2' });
    ecsMock.on(ListTasksCommand, { desiredStatus: 'RUNNING', nextToken: 'p2' }).resolves({ taskArns: arns.slice(120) });
    ecsMock.on(ListTasksCommand, { desiredStatus: 'STOPPED' }).resolves({ taskArns: [] });
    ecsMock.on(DescribeTasksCommand).callsFake((input: { tasks: string[] }) => ({ tasks: input.tasks.map((a) => ({ taskArn: a, lastStatus: 'RUNNING' })) }));
    const got = await collect(make(newNonce()).backend);
    expect(got).toHaveLength(230);
    const sizes = ecsMock.commandCalls(DescribeTasksCommand).map((c) => c.args[0].input.tasks?.length);
    expect(sizes).toEqual([100, 20, 100, 10]);
  });

  test.each([
    ['RUNNING', 'RUNNING', true],
    ['PENDING', 'RUNNING', true],
    ['PROVISIONING', 'RUNNING', true],
    ['RUNNING', 'STOPPED', true],
    ['DEPROVISIONING', 'STOPPED', true],
    ['STOPPING', 'STOPPED', true],
    ['STOPPED', 'STOPPED', false],
  ])('isAlive(last %s, desired %s) is %s', async (lastStatus, desiredStatus, alive) => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [eniTask({ lastStatus, desiredStatus })] });
    const { backend, handle } = make(newNonce());
    expect(await backend.isAlive(handle)).toBe(alive);
  });

  test('a task ECS no longer knows is not alive, and has no stop facts', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [], failures: [{ arn: TASK, reason: 'MISSING' }] });
    const { backend, handle } = make(newNonce());
    expect(await backend.isAlive(handle)).toBe(false);
    expect(await backend.stopReason(handle)).toEqual({});
  });

  test('stopReason reads started, stopped and the reason', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [eniTask({ lastStatus: 'STOPPED', startedAt: new Date(1000), stoppedAt: new Date(9000), stoppedReason: 'Task stopped by user' })],
    });
    const { backend, handle } = make(newNonce());
    expect(await backend.stopReason(handle)).toEqual({ startedAt: 1000, stoppedAt: 9000, reason: 'Task stopped by user' });
  });
});

describe('stop facts', () => {
  const stopped = (container: { exitCode?: number; reason?: string }): Task => eniTask({
    lastStatus: 'STOPPED', stoppedReason: 'Essential container in task exited', containers: [{ name: 'runner', ...container }],
  });

  test('OutOfMemoryError with exit code 0 is not a runner crash (a job was killed, the runner exited 0)', () => {
    const task = stopped({ exitCode: 0, reason: 'OutOfMemoryError: Container killed due to memory usage' });
    expect(runnerCrashed(task)).toBe(false);
    expect(stopFacts(task).reason).toBe('Essential container in task exited');
  });

  test('a non-zero exit code is a crash, and the reason says so', () => {
    const task = stopped({ exitCode: 137, reason: 'OutOfMemoryError: Container killed due to memory usage' });
    expect(runnerCrashed(task)).toBe(true);
    expect(stopFacts(task).reason).toBe('Essential container in task exited (runner exit code 137: OutOfMemoryError: Container killed due to memory usage)');
  });

  test('no exit code (the container never started) is not a crash', () => {
    expect(runnerCrashed(stopped({}))).toBe(false);
  });

  test('the address is read from the ENI attachment, then from the container', () => {
    expect(taskAddress(eniTask())).toBe('10.0.8.21');
    expect(taskAddress({ containers: [{ networkInterfaces: [{ privateIpv4Address: '10.0.1.1' }] }] })).toBe('10.0.1.1');
    expect(taskAddress({})).toBeUndefined();
  });
});

describe('cleanup (the drain)', () => {
  const ci = (n: number) => `arn:aws:ecs:eu-central-1:${ACCOUNT}:container-instance/c1/ci${n}`;

  test('nothing registered: returns at once', async () => {
    ecsMock.on(ListContainerInstancesCommand).resolves({ containerInstanceArns: [] });
    await make(newNonce()).backend.cleanup(2_000_000);
    expect(ecsMock.commandCalls(DeregisterContainerInstanceCommand)).toHaveLength(0);
  });

  test('deregisters with force, waits for EC2 to show terminated, then checks the cluster is empty', async () => {
    let listed = 0;
    ecsMock.on(ListContainerInstancesCommand).callsFake(() => {
      listed += 1;
      // first pass: ACTIVE has two, DRAINING has none; the next pass finds none
      return { containerInstanceArns: listed === 1 ? [ci(1), ci(2)] : [] };
    });
    ecsMock.on(DescribeContainerInstancesCommand).resolves({
      containerInstances: [{ ec2InstanceId: 'i-0001' }, { ec2InstanceId: 'i-0002' }],
    });
    ecsMock.on(DeregisterContainerInstanceCommand).resolves({});
    let described = 0;
    ec2Mock.on(DescribeInstancesCommand).callsFake(() => {
      described += 1;
      return {
        Reservations: [{
          Instances: [
            { InstanceId: 'i-0001', State: { Name: 'terminated' } },
            { InstanceId: 'i-0002', State: { Name: described === 1 ? 'shutting-down' : 'terminated' } },
          ],
        }],
      };
    });
    const { backend, sleeps } = make(newNonce());
    await backend.cleanup(2_000_000);

    const dereg = ecsMock.commandCalls(DeregisterContainerInstanceCommand).map((c) => c.args[0].input);
    expect(dereg).toEqual([
      { cluster: CLUSTER, containerInstance: ci(1), force: true },
      { cluster: CLUSTER, containerInstance: ci(2), force: true },
    ]);
    expect(described).toBe(2);
    expect(sleeps).toEqual([5000]);
    expect(ecsMock.commandCalls(ListContainerInstancesCommand).map((c) => c.args[0].input.status)).toEqual(['ACTIVE', 'DRAINING', 'ACTIVE', 'DRAINING']);
  });

  test('a replacement instance that registers meanwhile is drained too', async () => {
    let pass = 0;
    ecsMock.on(ListContainerInstancesCommand, { status: 'ACTIVE' }).callsFake(() => {
      pass += 1;
      return { containerInstanceArns: pass <= 2 ? [ci(pass)] : [] };
    });
    ecsMock.on(ListContainerInstancesCommand, { status: 'DRAINING' }).resolves({ containerInstanceArns: [] });
    ecsMock.on(DescribeContainerInstancesCommand).resolves({ containerInstances: [{ ec2InstanceId: 'i-0001' }] });
    ecsMock.on(DeregisterContainerInstanceCommand).resolves({});
    ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-0001', State: { Name: 'terminated' } }] }] });
    await make(newNonce()).backend.cleanup(2_000_000);
    expect(ecsMock.commandCalls(DeregisterContainerInstanceCommand)).toHaveLength(2);
  });

  test('an instance EC2 has already forgotten counts as terminated, and the others still count', async () => {
    let listed = 0;
    ecsMock.on(ListContainerInstancesCommand).callsFake(() => ({ containerInstanceArns: ++listed === 1 ? [ci(1), ci(2)] : [] }));
    ecsMock.on(DescribeContainerInstancesCommand).resolves({ containerInstances: [{ ec2InstanceId: 'i-0001' }, { ec2InstanceId: 'i-0002' }] });
    ecsMock.on(DeregisterContainerInstanceCommand).resolves({});
    const notFound = () => Object.assign(new Error('The instance ID i-0001 does not exist'), { name: 'InvalidInstanceID.NotFound' });
    let secondShown = 0;
    ec2Mock.on(DescribeInstancesCommand).callsFake((input: { InstanceIds: string[] }) => {
      // EC2 fails a call that names an unknown id, as it does for the whole list
      if (input.InstanceIds.includes('i-0001')) throw notFound();
      secondShown += 1;
      return { Reservations: [{ Instances: [{ InstanceId: 'i-0002', State: { Name: secondShown === 1 ? 'shutting-down' : 'terminated' } }] }] };
    });
    const { backend, sleeps } = make(newNonce());
    await backend.cleanup(2_000_000);
    // i-0002 was still shutting down on the first look, so the drain waited for it
    expect(sleeps).toEqual([5000]);
    expect(secondShown).toBe(2);
  });

  test('a pass that finds no instance id waits before it asks ECS again', async () => {
    let listed = 0;
    ecsMock.on(ListContainerInstancesCommand).callsFake(() => ({ containerInstanceArns: ++listed === 1 ? [ci(1)] : [] }));
    ecsMock.on(DescribeContainerInstancesCommand).resolves({ containerInstances: [{}] });
    ecsMock.on(DeregisterContainerInstanceCommand).resolves({});
    const { backend, sleeps } = make(newNonce());
    await backend.cleanup(2_000_000);
    expect(sleeps).toEqual([5000]);
  });

  test('past the deadline with instances left it throws, and the count says how many', async () => {
    ecsMock.on(ListContainerInstancesCommand, { status: 'ACTIVE' }).resolves({ containerInstanceArns: [ci(1)] });
    ecsMock.on(ListContainerInstancesCommand, { status: 'DRAINING' }).resolves({ containerInstanceArns: [] });
    await expect(make(newNonce(), undefined, ENV, () => 3_000_000).backend.cleanup(2_000_000)).rejects.toThrow(/1 container instance\(s\) still registered/);
    expect(ecsMock.commandCalls(DeregisterContainerInstanceCommand)).toHaveLength(0);
  });

  test('an instance that does not terminate by the deadline throws', async () => {
    ecsMock.on(ListContainerInstancesCommand).resolves({ containerInstanceArns: [ci(1)] });
    ecsMock.on(DescribeContainerInstancesCommand).resolves({ containerInstances: [{ ec2InstanceId: 'i-0001' }] });
    ecsMock.on(DeregisterContainerInstanceCommand).resolves({});
    ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-0001', State: { Name: 'shutting-down' } }] }] });
    let t = 1_000_000;
    const backend = new NitroBackend(ENV, { connect: new FakeRunner('x').connect, now: () => t, sleep: async (ms) => { t += ms; } });
    await expect(backend.cleanup(1_000_000 + 12_000)).rejects.toThrow(/1 instance\(s\) not terminated/);
  });
});

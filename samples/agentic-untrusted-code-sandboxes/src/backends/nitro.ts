// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `nitro` backend: Nitro Sandboxes on ECS Managed Instances (spec §3.4, ADR-0004).
 *
 * Run-time side only; the CDK side is nitro.cdk.ts. A sandbox is one ECS
 * task. It is started with the tool tenant role (`RunTask` tagged with the
 * tenant, ADR-0014), addressed by the task's ENI private IP, and proved on
 * every call over TLS on port 8443 (ADR-0010, ADR-0018): `POST /hello`
 * answers `HMAC(nonce, challenge ‖ certFingerprint)`, the tool checks it
 * against the certificate of the connection it holds, and sends the job on
 * that same connection. Nothing is sent to an address that has not proved
 * the nonce, so a recycled IP gets no job bytes.
 *
 * The backend never reads or writes the registry (src/backend.ts): it
 * reports what it saw and the caller writes the row.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';
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
import {
  NO_ANSWER_MARGIN_MS,
  type ReadyResult,
  type RegistryRow,
  type RunJob,
  type RunOutcome,
  type SandboxBackend,
  type SandboxHandle,
  type SandboxSummary,
  type StartOptions,
  type StopFacts,
  type TenantCredentials,
} from '../backend';
import { BACKEND_ENV, TEST_HOOK_ENV } from '../env';
import {
  base64url,
  helloProof,
  isRefusal,
  nonceHash,
  NONCE_HASH_ENV,
  PROTOCOL_VERSION,
  proofMatches,
  resultProof,
  RUNNER_PORTS,
  startToken,
  type HelloResponse,
  type Refusal,
  type RunResult,
} from '../protocol';

/** Task tag the IAM conditions read (spec §3.6, ADR-0014). */
export const TENANT_TAG = 'TenantId';

/** Name of the runner container in the task definition; container overrides address it by this name. */
export const RUNNER_CONTAINER_NAME = 'runner';

/** Function environment `NitroBackendResources.environment()` sets and this class reads; the names are spelled in src/env.ts. */
export const NITRO_ENV = {
  CLUSTER_ARN: BACKEND_ENV.NITRO_CLUSTER_ARN,
  TASK_DEFINITION_ARN: BACKEND_ENV.NITRO_TASK_DEFINITION_ARN,
  CONTAINER_NAME: BACKEND_ENV.NITRO_CONTAINER_NAME,
  SUBNET_IDS: BACKEND_ENV.NITRO_SUBNET_IDS,
  SECURITY_GROUP_ID: BACKEND_ENV.NITRO_SECURITY_GROUP_ID,
} as const;

/** Start cap, spec §3.4 (measured 31-34 s from zero instances; the cap leaves room for a full instance launch). */
export const NITRO_START_CAP_MS = 300_000;

/** How long one readiness probe may spend on connecting and on `/hello`. The caller owns the wait loop. */
const PROBE_CONNECT_MS = 3000;
const PROBE_HELLO_MS = 3000;

/** Poll gap while the drain waits for EC2 to end an instance. */
const INSTANCE_POLL_MS = 5000;

/** A task that DescribeTasks reports as missing this soon after its row was made is read as not yet visible. */
const MISSING_GRACE_MS = 30_000;

/** Text ECS shows as `stoppedReason`; no tenant data. */
const STOP_REASON = 'Stopped by the untrusted code sandboxes';

/** Task states from which a task will not serve again (spec §4.1 "a start has failed"). */
const ENDING_STATUSES = new Set(['DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'STOPPED']);

/** One HTTP reply from the runner. */
export interface HttpReply {
  readonly status: number;
  readonly body: string;
}

/** The connection did not open or was lost. The sandbox cannot serve this call. */
export class RunnerConnectionError extends Error {}

/** The runner did not answer in time. */
export class RunnerTimeoutError extends Error {}

/** A TLS connection to one runner whose certificate fingerprint is known. */
export interface RunnerConnection {
  /** SHA-256 of the certificate the server presented, DER bytes, lowercase hex. */
  readonly fingerprint: string;
  /** POST a JSON body on this connection; throws `RunnerTimeoutError` or `RunnerConnectionError`. */
  post(path: string, body: string, timeoutMs: number, maxBytes: number): Promise<HttpReply>;
  close(): void;
}

export type Connect = (host: string, port: number, timeoutMs: number) => Promise<RunnerConnection>;

/** Replaceable pieces, for tests. */
export interface NitroDeps {
  readonly connect: Connect;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

class PinnedAgent extends http.Agent {
  public constructor(private readonly socket: tls.TLSSocket) {
    super({ keepAlive: true, maxSockets: 1 });
  }

  /**
   * Hands out the one checked socket. A closed socket (the runner answered
   * `Connection: close`, or a limit destroyed it) is an error through the
   * callback: a throw here would escape Node's agent code as an uncaught
   * exception. Never dials again, so a second connection cannot skip the check.
   */
  public createConnection(_options: http.ClientRequestArgs, cb?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    if (this.socket.destroyed) {
      cb?.(new RunnerConnectionError('connection closed'), this.socket);
      return undefined;
    }
    return this.socket;
  }
}

/**
 * Opens TLS to a runner and records the fingerprint of the self-signed
 * certificate it presents. Chain validation is off on purpose, and the
 * `/hello` proof is the check: the runner's key and certificate are made at
 * process start, so there is no chain to validate, and the proof binds the
 * nonce to this connection's fingerprint (ADR-0010, ADR-0047).
 * Every request goes through one keep-alive socket, so the job travels on
 * the connection that was checked.
 */
export const connectTls: Connect = (host, port, timeoutMs) => new Promise((resolve, reject) => {
  // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
  const socket = tls.connect({
    host,
    port,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
    ALPNProtocols: ['http/1.1'],
  });
  const timer = setTimeout(() => socket.destroy(new RunnerTimeoutError('connect timed out')), timeoutMs);
  const fail = (err: Error) => {
    clearTimeout(timer);
    socket.destroy();
    reject(err instanceof RunnerTimeoutError ? err : new RunnerConnectionError(`connect failed: ${err.message}`));
  };
  socket.once('error', fail);
  socket.once('secureConnect', () => {
    clearTimeout(timer);
    socket.removeListener('error', fail);
    socket.on('error', () => undefined);
    const der = socket.getPeerCertificate().raw;
    // shortcut: untested. A TLS 1.3 server with no certificate fails the handshake first, so this
    // is a guard for a stack that reports success without one.
    if (!der) {
      socket.destroy();
      reject(new RunnerConnectionError('the runner presented no certificate'));
      return;
    }
    const agent = new PinnedAgent(socket);
    const fingerprint = createHash('sha256').update(der).digest('hex');
    resolve({
      fingerprint,
      close: () => {
        agent.destroy();
        socket.destroy();
      },
      post: (path, body, postTimeoutMs, maxBytes) => new Promise<HttpReply>((res, rej) => {
        if (socket.destroyed) {
          rej(new RunnerConnectionError('connection closed'));
          return;
        }
        let settled = false;
        const done = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          fn();
        };
        const req = http.request({
          agent,
          host,
          port,
          method: 'POST',
          path,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Connection': 'keep-alive',
          },
        }, (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              done(() => rej(new RunnerConnectionError('the runner answer is larger than allowed')));
              socket.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => done(() => res({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })));
          response.on('error', (e) => done(() => rej(new RunnerConnectionError(`connection lost: ${e.message}`))));
          response.on('aborted', () => done(() => rej(new RunnerConnectionError('connection lost'))));
        });
        const deadline = setTimeout(() => {
          done(() => rej(new RunnerTimeoutError('the runner did not answer in time')));
          socket.destroy();
        }, postTimeoutMs);
        req.on('error', (e) => done(() => rej(new RunnerConnectionError(`request failed: ${e.message}`))));
        req.end(body);
      }),
    });
  });
});

interface NitroConfig {
  readonly clusterArn: string;
  readonly taskDefinitionArn: string;
  readonly containerName: string;
  readonly subnetIds: string[];
  readonly securityGroupId: string;
}

/** Task ENI private IPv4, from the attachment (set before `RUNNING`) or the container. */
export function taskAddress(task: Task): string | undefined {
  for (const a of task.attachments ?? []) {
    if (a.type !== 'ElasticNetworkInterface') continue;
    const ip = a.details?.find((d) => d.name === 'privateIPv4Address')?.value;
    if (ip) return ip;
  }
  return task.containers?.flatMap((c) => c.networkInterfaces ?? []).find((n) => n.privateIpv4Address)?.privateIpv4Address;
}

/**
 * Whether the runner itself crashed. After any kernel kill of a job, ECS
 * marks the stopped task's container `OutOfMemoryError` even when the runner
 * exited 0 (spec §3.5), so only a non-zero exit code means a crash.
 */
export function runnerCrashed(task: Task): boolean {
  const exit = task.containers?.find((c) => c.name === RUNNER_CONTAINER_NAME)?.exitCode ?? task.containers?.[0]?.exitCode;
  return exit !== undefined && exit !== 0;
}

/** Facts for the stop line (spec §3.8) and the text of a failed start. */
export function stopFacts(task: Task): StopFacts {
  const c = task.containers?.find((x) => x.name === RUNNER_CONTAINER_NAME) ?? task.containers?.[0];
  let reason = task.stoppedReason;
  if (runnerCrashed(task)) {
    reason = `${reason ?? 'task stopped'} (runner exit code ${String(c?.exitCode)}${c?.reason ? `: ${c.reason}` : ''})`;
  }
  return {
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt.getTime() }),
    ...(task.stoppedAt === undefined ? {} : { stoppedAt: task.stoppedAt.getTime() }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** ECS answers `InvalidParameterException: The referenced task was not found.` for a task it no longer knows. */
function isTaskMissing(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e.name === 'InvalidParameterException' && /task.*not found/i.test(e.message ?? '');
}

/**
 * A short reason for a failed connect or /hello: a code, never the error text, which can carry the
 * task's private address and port (they would reach the stop line and its Contributor Insights key).
 */
function connectionReason(stage: 'connect' | 'hello', err: unknown): string {
  if (err instanceof RunnerTimeoutError) return `${stage}_timeout`;
  const errno = /\b(E[A-Z0-9]{3,})\b/.exec((err as Error).message ?? '')?.[1];
  return errno === undefined ? `${stage}_failed` : `${stage}_failed: ${errno}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRefusal(body: unknown): Refusal | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (b.error !== 'wrong_sandbox' && b.error !== 'busy' && b.error !== 'dirty' && b.error !== 'tool_failed') return undefined;
  return {
    v: PROTOCOL_VERSION,
    error: b.error,
    ...(typeof b.bootId === 'string' ? { bootId: b.bootId } : {}),
  };
}

function asResult(body: unknown): RunResult | undefined {
  if (typeof body !== 'object' || body === null || isRefusal(body as RunResult)) return undefined;
  const b = body as Record<string, unknown>;
  const ok = b.v === PROTOCOL_VERSION && typeof b.runId === 'string' && Number.isInteger(b.exitCode)
    && typeof b.stdout === 'string' && typeof b.stderr === 'string' && typeof b.truncated === 'boolean'
    && typeof b.durationMs === 'number' && typeof b.timedOut === 'boolean' && typeof b.memoryExceeded === 'boolean'
    && typeof b.bootId === 'string' && /^[0-9a-f]{32}$/.test(b.bootId) && typeof b.proof === 'string';
  return ok ? (body as RunResult) : undefined;
}

type Handshake =
  | { readonly kind: 'ok'; readonly bootId: string }
  /** The peer answered but is not this sandbox: a refusal or a proof that does not match. */
  | { readonly kind: 'identity'; readonly reason: string }
  /** The peer is not serving yet, or answered with something unusable. */
  | { readonly kind: 'unavailable'; readonly reason: string };

export class NitroBackend implements SandboxBackend {
  public readonly name = 'nitro' as const;
  public readonly startCapMs = NITRO_START_CAP_MS;

  private readonly deps: NitroDeps;
  private ambientEcs?: ECSClient;
  private ambientEc2?: EC2Client;

  /** Reads its settings from the function environment the construct sets (BackendConstruct.environment). */
  public constructor(
    public readonly env: Readonly<Record<string, string | undefined>> = process.env,
    deps: Partial<NitroDeps> = {},
  ) {
    this.deps = {
      connect: deps.connect ?? connectTls,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: deps.now ?? (() => Date.now()),
    };
  }

  public async start(tenantId: string, nonce: string, creds: TenantCredentials, options?: StartOptions): Promise<SandboxHandle> {
    if (creds.tenantId !== tenantId) throw new Error('nitro: the credentials belong to another tenant');
    const cfg = this.config();
    const ecs = this.tenantEcs(creds);
    // The nonce itself never leaves the data channel: the start call carries its hash (ADR-0018)
    // and an idempotency token derived from it, so a retried start launches nothing new.
    let out;
    try {
      out = await ecs.send(new RunTaskCommand({
        cluster: cfg.clusterArn,
        taskDefinition: cfg.taskDefinitionArn,
        count: 1,
        clientToken: startToken(nonce),
        tags: [{ key: TENANT_TAG, value: tenantId }],
        networkConfiguration: {
          awsvpcConfiguration: { subnets: cfg.subnetIds, securityGroups: [cfg.securityGroupId], assignPublicIp: 'DISABLED' },
        },
        overrides: {
          containerOverrides: [{
            name: cfg.containerName,
            environment: [
              { name: NONCE_HASH_ENV, value: nonceHash(nonce) },
              // Test hook of the integration test (ADR-0058): sent only when the tool asks and this function
              // honours the hooks (RC_INTEG_OVERRIDES = 1), so a production deployment never sends it. The runner
              // exits at boot, which is a failed start.
              ...(options?.failAtBoot === true && this.env[TEST_HOOK_ENV.RC_INTEG_OVERRIDES] === '1'
                ? [{ name: TEST_HOOK_ENV.RUNNER_FAIL_AT_BOOT, value: '1' }]
                : []),
            ],
          }],
        },
      }));
    } finally {
      ecs.destroy();
    }
    const task = out.tasks?.[0];
    if (task?.taskArn === undefined) {
      const why = out.failures?.map((f) => f.reason).filter(Boolean).join(', ') || 'no task returned';
      throw new Error(`nitro: RunTask failed: ${why}`);
    }
    return { backend: 'nitro', tenantId, handle: task.taskArn, nonce };
  }

  public async ready(handle: SandboxHandle, row: RegistryRow): Promise<ReadyResult> {
    // DescribeTasks first, every probe: a stopped task's IP can be reused (S-7 did not rule it out),
    // so the address always comes from this task ARN's own ENI, never from the row.
    const task = await this.describeOne(handle.handle);
    if (task === undefined) {
      // ECS is eventually consistent: a task started a moment ago may not be describable yet.
      const young = this.deps.now() - row.createdAt < MISSING_GRACE_MS;
      return young ? { state: 'starting', patch: {} } : { state: 'ended', reason: 'task not found' };
    }
    const status = task.lastStatus ?? '';
    if (task.desiredStatus === 'STOPPED' || ENDING_STATUSES.has(status)) {
      return { state: 'ended', reason: stopFacts(task).reason ?? `task ${status.toLowerCase() || 'stopped'}` };
    }
    if (status !== 'RUNNING') return { state: 'starting', patch: {} };
    const address = taskAddress(task);
    if (address === undefined) return { state: 'starting', patch: {} };

    let conn: RunnerConnection;
    try {
      conn = await this.deps.connect(address, RUNNER_PORTS.tls, PROBE_CONNECT_MS);
    } catch {
      return { state: 'starting', patch: { address } };
    }
    try {
      const hs = await this.handshake(conn, handle, PROBE_HELLO_MS);
      if (hs.kind === 'ok') return { state: 'ready', patch: { address, bootId: hs.bootId } };
      if (hs.kind === 'identity') return { state: 'ended', reason: hs.reason };
      return { state: 'starting', patch: { address } };
    } catch (err) {
      // A runner that is not listening yet or drops the connection is still starting; anything else is a defect.
      if (err instanceof RunnerTimeoutError || err instanceof RunnerConnectionError) {
        return { state: 'starting', patch: { address } };
      }
      throw err;
    } finally {
      conn.close();
    }
  }

  public async run(handle: SandboxHandle, job: RunJob): Promise<RunOutcome> {
    if (job.nonce !== handle.nonce || job.tenantId !== handle.tenantId) {
      throw new Error('nitro: the job does not belong to this sandbox');
    }
    const deadline = this.deps.now() + job.timeoutMs + NO_ANSWER_MARGIN_MS;
    const left = () => Math.max(1, deadline - this.deps.now());
    if (handle.address === undefined) return { kind: 'dead', reason: 'no address recorded' };

    let conn: RunnerConnection;
    try {
      conn = await this.deps.connect(handle.address, RUNNER_PORTS.tls, Math.min(left(), 5000));
    } catch (err) {
      return { kind: 'dead', reason: connectionReason('connect', err) };
    }
    try {
      let hs: Handshake;
      try {
        hs = await this.handshake(conn, handle, Math.min(left(), 5000));
      } catch (err) {
        return { kind: 'dead', reason: connectionReason('hello', err) };
      }
      if (hs.kind !== 'ok') return { kind: 'dead', reason: hs.reason };

      // stdout and stderr are cut by bytes, then decoded and JSON-escaped: at most 6 bytes per input byte.
      const maxBytes = job.maxOutputBytes * 6 + 65536;
      let reply: HttpReply;
      try {
        reply = await conn.post('/run', JSON.stringify(job), left(), maxBytes);
      } catch {
        // /hello succeeded, so the job bytes may have reached the runner: a lost connection, an answer
        // past the limit or a timeout is no answer, never a dead handle, because a rerun in a fresh
        // sandbox would run the tenant's code twice (ADR-0047, ADR-0044).
        return { kind: 'no_answer' };
      }
      const body = parseJson(reply.body);
      const refusal = asRefusal(body);
      if (refusal !== undefined) return { kind: 'refused', refusal };
      const result = reply.status === 200 ? asResult(body) : undefined;
      if (result === undefined) return { kind: 'dead', reason: `unusable runner answer (HTTP ${reply.status})` };
      if (result.runId !== job.runId || !proofMatches(resultProof(job.nonce, job.runId), result.proof)) {
        return { kind: 'dead', reason: 'the result proof does not match' };
      }
      return { kind: 'result', result };
    } finally {
      conn.close();
    }
  }

  /**
   * With the tool tenant role's credentials `StopTask` is conditioned on the task's tag. ECS drops a
   * task from its history an hour after it stops; for such a task there is no tag to check, so IAM
   * most likely answers AccessDenied. A task ECS no longer lists, or lists as STOPPED, is already
   * stopped, so that answer is checked with the ambient role and is not an error. Any other task
   * keeps the error.
   */
  public async stop(handle: SandboxHandle, creds?: TenantCredentials): Promise<void> {
    const cfg = this.config();
    const ecs = creds === undefined ? this.ecs() : this.tenantEcs(creds);
    try {
      await ecs.send(new StopTaskCommand({ cluster: cfg.clusterArn, task: handle.handle, reason: STOP_REASON }));
    } catch (err) {
      // A task ECS no longer knows is already stopped; any other error is the caller's.
      if (isTaskMissing(err)) return;
      if (creds !== undefined && (err as { name?: string }).name === 'AccessDeniedException') {
        // If this look fails too, the access error is the one to report.
        const task = await this.describeOne(handle.handle).catch(() => 'unknown' as const);
        if (task === undefined || (task !== 'unknown' && task.lastStatus === 'STOPPED')) return;
      }
      throw err;
    } finally {
      if (creds !== undefined) ecs.destroy();
    }
  }

  /**
   * Every task of the sample's cluster. ECS lists a task as `desiredStatus`
   * STOPPED while it still takes 45 to 78 s to reach `lastStatus` STOPPED
   * (S-7), and a capacity provider cannot be deleted until then, so both
   * lists are read and `live` follows `lastStatus`.
   *
   * shortcut: the STOPPED list holds every task stopped in the last hour and each page is described
   * with its tags on every reaper run. Fine for hundreds of stops an hour; past a few thousand, keep
   * a `lastStatus` cache or react to ECS task state change events instead.
   */
  public async *list(): AsyncGenerator<SandboxSummary> {
    const cfg = this.config();
    const ecs = this.ecs();
    const seen = new Set<string>();
    for (const desiredStatus of ['RUNNING', 'STOPPED'] as const) {
      let nextToken: string | undefined;
      do {
        const page = await ecs.send(new ListTasksCommand({ cluster: cfg.clusterArn, desiredStatus, nextToken }));
        nextToken = page.nextToken;
        const arns = (page.taskArns ?? []).filter((a) => !seen.has(a));
        for (let i = 0; i < arns.length; i += 100) {
          const chunk = arns.slice(i, i + 100);
          const described = await ecs.send(new DescribeTasksCommand({ cluster: cfg.clusterArn, tasks: chunk, include: ['TAGS'] }));
          for (const task of described.tasks ?? []) {
            if (task.taskArn === undefined || seen.has(task.taskArn)) continue;
            seen.add(task.taskArn);
            const tenantId = task.tags?.find((t) => t.key === TENANT_TAG)?.value;
            yield {
              backend: 'nitro',
              handle: task.taskArn,
              ...(tenantId === undefined ? {} : { tenantId }),
              ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt.getTime() }),
              live: task.lastStatus !== 'STOPPED',
            };
          }
        }
      } while (nextToken !== undefined);
    }
  }

  /**
   * Alive until ECS reports the task `STOPPED`, a stopping task included: the same meaning as `live` in
   * `list()` (a task stays listed for 45 to 78 s after `StopTask`, and a caller that deleted its row
   * on a false answer would see the reaper stop the task again as an orphan). A task that ECS does not
   * list is not alive. Right after `start` ECS may not describe the new task yet; `ready` allows for
   * that, and a caller that checks a task it just started must as well.
   */
  public async isAlive(handle: SandboxHandle): Promise<boolean> {
    const task = await this.describeOne(handle.handle);
    return task !== undefined && task.lastStatus !== 'STOPPED';
  }

  public async stopReason(handle: SandboxHandle): Promise<StopFacts> {
    const task = await this.describeOne(handle.handle);
    return task === undefined ? {} : stopFacts(task);
  }

  /**
   * Drain only, once every task is STOPPED (spec §5.3): deregisters each
   * container instance with `force`, which on Managed Instances ends the
   * instance, and waits until EC2 shows each one terminated. Repeats until
   * the cluster lists none. `deadlineMs` is an absolute epoch time in ms.
   */
  public async cleanup(deadlineMs: number): Promise<void> {
    const cfg = this.config();
    const ecs = this.ecs();
    const ec2 = this.ec2();
    for (;;) {
      const arns: string[] = [];
      for (const status of ['ACTIVE', 'DRAINING'] as const) {
        let nextToken: string | undefined;
        do {
          const page = await ecs.send(new ListContainerInstancesCommand({ cluster: cfg.clusterArn, status, nextToken }));
          arns.push(...(page.containerInstanceArns ?? []));
          nextToken = page.nextToken;
        } while (nextToken !== undefined);
      }
      if (arns.length === 0) return;
      if (this.deps.now() >= deadlineMs) {
        throw new Error(`nitro: ${arns.length} container instance(s) still registered at the deadline`);
      }
      const instanceIds: string[] = [];
      for (let i = 0; i < arns.length; i += 100) {
        const described = await ecs.send(new DescribeContainerInstancesCommand({
          cluster: cfg.clusterArn,
          containerInstances: arns.slice(i, i + 100),
        }));
        for (const ci of described.containerInstances ?? []) {
          if (ci.ec2InstanceId !== undefined) instanceIds.push(ci.ec2InstanceId);
        }
      }
      for (const containerInstance of arns) {
        await ecs.send(new DeregisterContainerInstanceCommand({ cluster: cfg.clusterArn, containerInstance, force: true }));
      }
      await this.waitTerminated(ec2, instanceIds, deadlineMs);
      // A pass that found no instance id must not spin on ECS.
      if (instanceIds.length === 0) await this.deps.sleep(INSTANCE_POLL_MS);
    }
  }

  private async waitTerminated(ec2: EC2Client, instanceIds: string[], deadlineMs: number): Promise<void> {
    let pending = [...instanceIds];
    while (pending.length > 0) {
      let running: string[];
      try {
        running = await this.notTerminated(ec2, pending);
      } catch (err) {
        // EC2 forgets a terminated instance after a while, and then fails the whole call for that one id.
        // Ask id by id: an unknown id is a terminated one, and the others still count.
        if ((err as { name?: string }).name !== 'InvalidInstanceID.NotFound') throw err;
        running = [];
        for (const id of pending) {
          try {
            running.push(...await this.notTerminated(ec2, [id]));
          } catch (one) {
            if ((one as { name?: string }).name !== 'InvalidInstanceID.NotFound') throw one;
          }
        }
      }
      pending = running;
      if (pending.length === 0) return;
      if (this.deps.now() >= deadlineMs) {
        throw new Error(`nitro: ${pending.length} instance(s) not terminated at the deadline`);
      }
      await this.deps.sleep(INSTANCE_POLL_MS);
    }
  }

  /** The ids among `ids` that EC2 does not show as terminated. */
  private async notTerminated(ec2: EC2Client, ids: string[]): Promise<string[]> {
    const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: ids }));
    return (out.Reservations ?? []).flatMap((r) => r.Instances ?? [])
      .filter((i) => i.State?.Name !== 'terminated').map((i) => i.InstanceId ?? '').filter((id) => id !== '');
  }

  /** `POST /hello`: proves the peer holds the nonce, bound to the certificate of this connection. */
  private async handshake(conn: RunnerConnection, handle: SandboxHandle, timeoutMs: number): Promise<Handshake> {
    const challenge = base64url(randomBytes(32));
    const reply = await conn.post('/hello', JSON.stringify({ v: PROTOCOL_VERSION, nonce: handle.nonce, challenge }), timeoutMs, 4096);
    const body = parseJson(reply.body);
    const refusal = asRefusal(body);
    if (refusal !== undefined) {
      return refusal.error === 'wrong_sandbox'
        ? { kind: 'identity', reason: 'wrong_sandbox' }
        : { kind: 'unavailable', reason: refusal.error };
    }
    if (reply.status !== 200 || typeof body !== 'object' || body === null) {
      return { kind: 'unavailable', reason: `unusable /hello answer (HTTP ${reply.status})` };
    }
    const hello = body as Partial<HelloResponse>;
    if (hello.v !== PROTOCOL_VERSION || typeof hello.bootId !== 'string' || !/^[0-9a-f]{32}$/.test(hello.bootId)) {
      return { kind: 'unavailable', reason: 'unusable /hello answer' };
    }
    // The fingerprint the runner reports must be the one of the connection we hold, and the proof must cover it.
    if (hello.certFingerprint !== conn.fingerprint || !proofMatches(helloProof(handle.nonce, challenge, conn.fingerprint), hello.proof)) {
      return { kind: 'identity', reason: 'the /hello proof does not match' };
    }
    return { kind: 'ok', bootId: hello.bootId };
  }

  private async describeOne(taskArn: string): Promise<Task | undefined> {
    const cfg = this.config();
    const out = await this.ecs().send(new DescribeTasksCommand({ cluster: cfg.clusterArn, tasks: [taskArn] }));
    return out.tasks?.find((t) => t.taskArn === taskArn);
  }

  /** A client with the tool tenant role's credentials; the caller destroys it. */
  private tenantEcs(creds: TenantCredentials): ECSClient {
    return new ECSClient({
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        ...(creds.expiration === undefined ? {} : { expiration: creds.expiration }),
      },
    });
  }

  private ecs(): ECSClient {
    this.ambientEcs ??= new ECSClient({});
    return this.ambientEcs;
  }

  private ec2(): EC2Client {
    this.ambientEc2 ??= new EC2Client({});
    return this.ambientEc2;
  }

  private config(): NitroConfig {
    const need = (name: string): string => {
      const v = this.env[name];
      if (v === undefined || v === '') throw new Error(`nitro: ${name} is not set`);
      return v;
    };
    return {
      clusterArn: need(NITRO_ENV.CLUSTER_ARN),
      taskDefinitionArn: need(NITRO_ENV.TASK_DEFINITION_ARN),
      containerName: this.env[NITRO_ENV.CONTAINER_NAME] || RUNNER_CONTAINER_NAME,
      subnetIds: need(NITRO_ENV.SUBNET_IDS).split(',').filter((s) => s !== ''),
      securityGroupId: need(NITRO_ENV.SECURITY_GROUP_ID),
    };
  }
}

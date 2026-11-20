// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `agentcore` backend: AgentCore Runtime V2 sessions (spec §3.4, ADR-0009).
 *
 * One runtime serves every tenant. A tenant's sandbox is the runtime
 * session whose id is derived from the tenant id alone (ADR-0009). There is
 * no start call: the session comes into being on the first
 * `InvokeAgentRuntime`, whose job carries the nonce, the tenant id and
 * `jobAuth`, and the runner adopts the nonce only when the session id
 * matches (ADR-0018). Nothing in this file touches the registry; the caller
 * owns every row write (ADR-0025).
 *
 * The tool's `InvokeAgentRuntime` and `StopRuntimeSession` rights are scoped
 * to the runtime, not to a session, because neither action supports a
 * session-id condition (S-8). The session id is therefore derived by code,
 * and `run` and `stop` refuse a handle whose id is not the one this tenant
 * maps to (ADR-0050).
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  ResourceNotFoundException,
  RuntimeClientError,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type {
  ReadyResult, RegistryRow, RunJob, RunOutcome, SandboxBackend, SandboxHandle, SandboxSummary,
  StopFacts, TenantCredentials,
} from '../backend';
import { NO_ANSWER_MARGIN_MS } from '../backend';
import { BACKEND_ENV } from '../env';
import {
  decodeNonce, proofMatches, resultProof, sessionIdFor, TENANT_ID_PATTERN,
  type Refusal, type RefusalCode, type RunResult,
} from '../protocol';

/** Start cap in ms (spec §3.4: measured 2 to 2.5 s for a new session). */
export const AGENTCORE_START_CAP_MS = 30_000;

const REFUSAL_CODES: readonly RefusalCode[] = ['wrong_sandbox', 'busy', 'dirty', 'tool_failed'];

const BOOT_ID = /^[0-9a-f]{32}$/;

export class AgentcoreBackend implements SandboxBackend {
  public readonly name = 'agentcore' as const;
  public readonly startCapMs = AGENTCORE_START_CAP_MS;

  private client?: BedrockAgentCoreClient;

  /** Reads its settings from the function environment the construct sets (BackendConstruct.environment). */
  public constructor(public readonly env: Readonly<Record<string, string | undefined>> = process.env) {}

  /**
   * Makes the handle. No AWS call: the session starts on the first job
   * (spec §3.4). The nonce is checked here so a bad row fails at start, not
   * at the first job.
   */
  public async start(tenantId: string, nonce: string, _creds: TenantCredentials): Promise<SandboxHandle> {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error('agentcore backend: tenantId does not match the tenant id rule');
    }
    decodeNonce(nonce);
    return {
      backend: 'agentcore',
      tenantId,
      handle: sessionIdFor(tenantId),
      address: this.runtimeArn(),
      nonce,
    };
  }

  /**
   * Always ready (spec §3.4): no API reports a session before its first
   * job, and `bootId` arrives with each result. The row already holds the
   * runtime ARN from `start`, so the patch is empty.
   */
  public async ready(_handle: SandboxHandle, _row: RegistryRow): Promise<ReadyResult> {
    return { state: 'ready', patch: {} };
  }

  public async run(handle: SandboxHandle, job: RunJob): Promise<RunOutcome> {
    this.checkHandle(handle);
    if (job.tenantId !== handle.tenantId || job.nonce !== handle.nonce) {
      throw new Error('agentcore backend: the job does not belong to this handle');
    }
    const waitMs = job.timeoutMs + NO_ANSWER_MARGIN_MS;
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const noAnswer = new Promise<'no_answer'>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve('no_answer');
      }, waitMs);
    });
    const call = this.invoke(handle, job, abort.signal);
    // The race loser must not become an unhandled rejection.
    call.catch(() => undefined);
    try {
      const outcome = await Promise.race([call, noAnswer]);
      return outcome === 'no_answer' ? { kind: 'no_answer' } : outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends the session. A session that is already gone is a stop that has happened. */
  public async stop(handle: SandboxHandle, _creds?: TenantCredentials): Promise<void> {
    this.checkHandle(handle);
    try {
      await this.sdk().send(new StopRuntimeSessionCommand({
        agentRuntimeArn: this.runtimeArn(),
        runtimeSessionId: handle.handle,
      }));
    } catch (e) {
      if (e instanceof ResourceNotFoundException) return;
      throw e;
    }
  }

  /**
   * Empty: no AgentCore API lists a runtime's sessions (spec §4.1). A
   * session whose row was lost ends at `idleRuntimeSessionTimeout`, at
   * `maxLifetime`, or when the runtime is deleted, so the reaper's orphan
   * sweep has nothing to find here and the drain stops only sessions that
   * have a row (spec §5.3).
   */
  public list(): AsyncIterable<SandboxSummary> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) };
  }

  /** Always true (backend.ts): there is no call that says a session ended, so the next job finds out. */
  public async isAlive(_handle: SandboxHandle): Promise<boolean> {
    return true;
  }

  /**
   * No facts: the platform reports no start or stop time and no reason for
   * a session. The tool line takes its times from the registry row.
   */
  public async stopReason(_handle: SandboxHandle): Promise<StopFacts> {
    return {};
  }

  private runtimeArn(): string {
    const arn = this.env[BACKEND_ENV.AGENTCORE_RUNTIME_ARN];
    if (!arn) {
      throw new Error(`agentcore backend: ${BACKEND_ENV.AGENTCORE_RUNTIME_ARN} is not set`);
    }
    return arn;
  }

  private sdk(): BedrockAgentCoreClient {
    this.client ??= new BedrockAgentCoreClient({});
    return this.client;
  }

  /** The session id is derived by code (S-8), so a handle that names another session is a caller fault, never sent. */
  private checkHandle(handle: SandboxHandle): void {
    if (handle.backend !== 'agentcore' || handle.handle !== sessionIdFor(handle.tenantId)) {
      throw new Error('agentcore backend: the handle is not this tenant\'s session');
    }
  }

  private async invoke(handle: SandboxHandle, job: RunJob, signal: AbortSignal): Promise<RunOutcome> {
    let text: string;
    try {
      const out = await this.sdk().send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: this.runtimeArn(),
        runtimeSessionId: handle.handle,
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(JSON.stringify(job)),
      }), { abortSignal: signal });
      if (out.statusCode !== undefined && out.statusCode !== 200) {
        return dead(`http_${out.statusCode}`);
      }
      text = out.response ? await out.response.transformToString('utf-8') : '';
    } catch (e) {
      if (e instanceof ResourceNotFoundException) return dead('not_found');
      // The container answered with an error or the session cannot be reached: a dead handle (spec §4.1 step 3).
      if (e instanceof RuntimeClientError) return dead('runtime_client_error');
      throw e;
    }
    return this.verify(handle, job, text);
  }

  /** Reads the body as a refusal or a result, and checks the result proof (spec §3.4 identity check). */
  private verify(handle: SandboxHandle, job: RunJob, text: string): RunOutcome {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return dead('not_json');
    }
    if (typeof body !== 'object' || body === null) return dead('bad_response');
    const refusal = asRefusal(body);
    if (refusal) return { kind: 'refused', refusal };
    const result = asResult(body);
    if (!result) return dead('bad_response');
    if (result.runId !== job.runId || !proofMatches(resultProof(handle.nonce, job.runId), result.proof)) {
      return dead('identity_check_failed');
    }
    return { kind: 'result', result };
  }
}

function dead(reason: string): RunOutcome {
  return { kind: 'dead', reason };
}

function asRefusal(body: object): Refusal | undefined {
  const b = body as Record<string, unknown>;
  if (typeof b.error !== 'string' || b.v !== 1) return undefined;
  if (!REFUSAL_CODES.includes(b.error as RefusalCode)) return undefined;
  if (b.bootId !== undefined && (typeof b.bootId !== 'string' || !BOOT_ID.test(b.bootId))) return undefined;
  return { v: 1, error: b.error as RefusalCode, ...(b.bootId === undefined ? {} : { bootId: b.bootId }) };
}

function asResult(body: object): RunResult | undefined {
  const b = body as Record<string, unknown>;
  if (b.v !== 1 || typeof b.runId !== 'string' || typeof b.proof !== 'string') return undefined;
  if (!Number.isInteger(b.exitCode) || typeof b.stdout !== 'string' || typeof b.stderr !== 'string') return undefined;
  if (typeof b.truncated !== 'boolean' || typeof b.timedOut !== 'boolean' || typeof b.memoryExceeded !== 'boolean') return undefined;
  if (typeof b.durationMs !== 'number' || !Number.isFinite(b.durationMs)) return undefined;
  if (typeof b.bootId !== 'string' || !BOOT_ID.test(b.bootId)) return undefined;
  return {
    v: 1,
    runId: b.runId,
    exitCode: b.exitCode as number,
    stdout: b.stdout,
    stderr: b.stderr,
    truncated: b.truncated,
    durationMs: b.durationMs,
    timedOut: b.timedOut,
    memoryExceeded: b.memoryExceeded,
    bootId: b.bootId,
    proof: b.proof,
  };
}

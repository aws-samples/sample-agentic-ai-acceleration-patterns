// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * An in-memory SandboxBackend for unit tests of the tool, the reaper, the
 * drain and the offboard function (ADR-0025). It signs results with the
 * real protocol functions, so a test exercises the same proof checks a real
 * runner would pass. Scripted behaviour per call: `script`.
 */

import type {
  BackendName, ReadyResult, RegistryRow, RunJob, RunOutcome, SandboxBackend, SandboxHandle,
  SandboxSummary, StopFacts, TenantCredentials,
} from '../src/backend';
import { jobAuth, proofMatches, resultProof } from '../src/protocol';

export interface FakeSandbox {
  readonly handle: SandboxHandle;
  readonly startedAt: number;
  stoppedAt?: number;
  live: boolean;
  /** Probes left before `ready` reports ready. */
  startingProbes: number;
  bootId: string;
  busy: boolean;
}

export interface FakeScript {
  /** Make `start` throw. */
  failStart?: Error;
  /** Make the next `ready` report a failed start. */
  endBeforeReady?: string;
  /** Number of `starting` probes before ready. */
  startingProbes?: number;
  /** Override the next run outcome. */
  nextRun?: RunOutcome;
}

export class FakeBackend implements SandboxBackend {
  public readonly startCapMs = 20_000;
  public readonly sandboxes = new Map<string, FakeSandbox>();
  public readonly calls: string[] = [];
  public script: FakeScript = {};
  private seq = 0;

  public constructor(public readonly name: BackendName = 'microvm', public now: () => number = () => Date.now()) {}

  public async start(tenantId: string, nonce: string, creds: TenantCredentials): Promise<SandboxHandle> {
    this.calls.push(`start ${tenantId}`);
    if (creds.tenantId !== tenantId) throw new Error('credentials of another tenant');
    if (this.script.failStart) throw this.script.failStart;
    const handle: SandboxHandle = { backend: this.name, tenantId, handle: `fake-${++this.seq}`, nonce };
    this.sandboxes.set(handle.handle, {
      handle,
      startedAt: this.now(),
      live: true,
      busy: false,
      startingProbes: this.script.startingProbes ?? 0,
      bootId: `boot${this.seq}`.padEnd(32, '0'),
    });
    return handle;
  }

  public async ready(handle: SandboxHandle, _row: RegistryRow): Promise<ReadyResult> {
    this.calls.push(`ready ${handle.handle}`);
    const s = this.sandboxes.get(handle.handle);
    if (!s || !s.live) return { state: 'ended', reason: 'not found' };
    if (this.script.endBeforeReady) {
      const reason = this.script.endBeforeReady;
      this.script.endBeforeReady = undefined;
      s.live = false;
      s.stoppedAt = this.now();
      return { state: 'ended', reason };
    }
    if (s.startingProbes > 0) {
      s.startingProbes -= 1;
      return { state: 'starting', patch: {} };
    }
    return { state: 'ready', patch: { address: `addr-${handle.handle}`, bootId: s.bootId } };
  }

  public async run(handle: SandboxHandle, job: RunJob): Promise<RunOutcome> {
    this.calls.push(`run ${handle.handle}`);
    if (this.script.nextRun) {
      const r = this.script.nextRun;
      this.script.nextRun = undefined;
      return r;
    }
    const s = this.sandboxes.get(handle.handle);
    if (!s || !s.live) return { kind: 'dead', reason: 'not found' };
    if (s.busy) return { kind: 'refused', refusal: { v: 1, error: 'busy', bootId: s.bootId } };
    const input = job.input === undefined ? undefined : Buffer.from(job.input, 'base64');
    const expected = jobAuth(s.handle.nonce, job.runId, job.tenantId, job.code, input);
    if (job.nonce !== s.handle.nonce || job.tenantId !== s.handle.tenantId || !proofMatches(expected, job.jobAuth)) {
      return { kind: 'refused', refusal: { v: 1, error: 'wrong_sandbox' } };
    }
    return {
      kind: 'result',
      result: {
        v: 1,
        runId: job.runId,
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 1,
        timedOut: false,
        memoryExceeded: false,
        bootId: s.bootId,
        proof: resultProof(s.handle.nonce, job.runId),
      },
    };
  }

  public async stop(handle: SandboxHandle, _creds?: TenantCredentials): Promise<void> {
    this.calls.push(`stop ${handle.handle}`);
    const s = this.sandboxes.get(handle.handle);
    if (s && s.live) {
      s.live = false;
      s.stoppedAt = this.now();
    }
  }

  public async *list(): AsyncIterable<SandboxSummary> {
    for (const s of this.sandboxes.values()) {
      yield {
        backend: this.name,
        handle: s.handle.handle,
        tenantId: this.name === 'nitro' ? s.handle.tenantId : undefined,
        startedAt: s.startedAt,
        live: s.live,
      };
    }
  }

  public async isAlive(handle: SandboxHandle): Promise<boolean> {
    return this.sandboxes.get(handle.handle)?.live ?? false;
  }

  public async stopReason(handle: SandboxHandle): Promise<StopFacts> {
    const s = this.sandboxes.get(handle.handle);
    return s ? { startedAt: s.startedAt, stoppedAt: s.stoppedAt, reason: s.live ? undefined : 'stopped' } : {};
  }

  /** Test helper: end a sandbox as the platform would. */
  public kill(handle: string): void {
    const s = this.sandboxes.get(handle);
    if (s) {
      s.live = false;
      s.stoppedAt = this.now();
    }
  }
}

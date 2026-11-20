// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The run-time backend interface (spec §3.4, extended by ADR-0025 so the
 * tool, the reaper, the drain and the offboard function can be written
 * against it without the backends). Runs inside the Lambda functions: no
 * aws-cdk-lib import here. The CDK side of a backend is
 * `BackendConstruct` in backend-construct.ts.
 *
 * A backend never reads or writes the registry. It reports what it saw
 * (`ReadyResult.patch`, `SandboxSummary`, `StopFacts`) and the caller writes
 * the row with its own version condition (spec §4.1).
 */

import type { RunJob, RunResult, Refusal } from './protocol';

export type { RunJob, RunResult } from './protocol';

/** The three boundaries (spec §3.1). */
export type BackendName = 'microvm' | 'nitro' | 'agentcore';

export const BACKEND_NAMES: readonly BackendName[] = ['microvm', 'nitro', 'agentcore'];

/** Credentials of the tool tenant role, vended with the `TenantId` session tag (spec §3.2). */
export interface TenantCredentials {
  readonly tenantId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration?: Date;
}

/** Registry row states (spec §4.1). */
export type RowState = 'STARTING' | 'READY' | 'STOPPING' | 'FAILED';

/** One registry row, as the tool and the reaper read it (spec §4.1). */
export interface RegistryRow {
  readonly tenantId: string;
  readonly backend: BackendName;
  /** MicroVM id, task ARN, or AgentCore session id. Absent on a handle-less STARTING row. */
  readonly handle?: string;
  /** MicroVM endpoint, task private IP, or runtime ARN. */
  readonly address?: string;
  /** base64url, 32 bytes. */
  readonly nonce: string;
  readonly bootId?: string;
  readonly state: RowState;
  readonly retryAt?: number;
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  readonly leaseUntil?: number;
  readonly suspendedMs?: number;
  readonly expiresAt: number;
  /** Epoch seconds. */
  readonly ttlAt: number;
  readonly version: number;
}

/** What `start` returns and what `ready`, `run` and `stop` take. */
export interface SandboxHandle {
  readonly backend: BackendName;
  readonly tenantId: string;
  /** MicroVM id, task ARN, or AgentCore session id. */
  readonly handle: string;
  /** Known at start on `microvm` (endpoint) and `agentcore` (runtime ARN); on `nitro` once `ready` read it. */
  readonly address?: string;
  /** The row's nonce, base64url. */
  readonly nonce: string;
  /** The last bootId the tool recorded, if any. */
  readonly bootId?: string;
}

/** The outcome of one readiness probe (spec §3.4 Ready, §4.1 step 1). */
export type ReadyResult =
  | {
    readonly state: 'ready';
    /** Row fields the probe learnt; the caller writes them with its version condition. */
    readonly patch: { readonly address?: string; readonly bootId?: string };
  }
  | {
    /** Still starting: `nitro` PROVISIONING or PENDING, MicroVM not yet RUNNING, runner not answering yet. */
    readonly state: 'starting';
    readonly patch: { readonly address?: string };
  }
  | {
    /** The sandbox ended before its first successful ready or identity check: a failed start (spec §4.1). */
    readonly state: 'ended';
    /** `stoppedReason`, `stateReason`, or a backend text; goes in the tool line. */
    readonly reason: string;
  };

/** Outcome of one job call: a result, a refusal the runner sent, no answer in time, or a dead handle. */
export type RunOutcome =
  | { readonly kind: 'result'; readonly result: RunResult }
  | { readonly kind: 'refused'; readonly refusal: Refusal }
  /**
   * The runner did not answer by `job.timeoutMs` + {@link NO_ANSWER_MARGIN_MS}
   * (spec §4.1 step 5). The backend enforces that deadline; the tool then
   * sets the row STOPPING, stops the sandbox and returns `timedOut`.
   */
  | { readonly kind: 'no_answer' }
  /** Not found, connection refused, or a failed identity check (spec §4.1 step 3). */
  | { readonly kind: 'dead'; readonly reason: string };

/** Margin past the job's own timeout before `run` gives up waiting (spec §4.1 step 5). */
export const NO_ANSWER_MARGIN_MS = 5000;

/** One sandbox the backend can list, for the reaper's sweep and the drain (spec §4.1, §5.3). */
export interface SandboxSummary {
  readonly backend: BackendName;
  readonly handle: string;
  /** From the `TenantId` task tag on `nitro`; undefined on `microvm`, which takes no tags. */
  readonly tenantId?: string;
  /** Epoch ms, when the platform reports it. */
  readonly startedAt?: number;
  /** True while the sandbox can still serve or bill (running, suspended, pending). */
  readonly live: boolean;
}

/** Facts for the stop line (spec §3.8). */
export interface StopFacts {
  /** Epoch ms. */
  readonly startedAt?: number;
  /** Epoch ms: `terminatedAt` on `microvm`, `stoppedAt` on `nitro`. */
  readonly stoppedAt?: number;
  /** `stoppedReason` or `stateReason`, when the platform gives one. */
  readonly reason?: string;
}

/**
 * Test hook of the integration test (spec §8 `failed-start`, ADR-0058).
 * `failAtBoot` makes the runner of this one sandbox exit at boot: `nitro`
 * sets the runner's fail-at-boot variable in the container override,
 * `microvm` adds `"failAtBoot": true` to the `run` hook payload, `agentcore`
 * ignores it (its start makes no AWS call). Only the tool sets it, and only
 * for the one tenant the integration stack names (src/env.ts, the
 * integration test hooks).
 */
export interface StartOptions {
  readonly failAtBoot?: boolean;
}

export interface SandboxBackend {
  readonly name: BackendName;
  /** Start cap in ms (spec §3.4): `leaseUntil` = start + this. */
  readonly startCapMs: number;
  /** Creates a sandbox; never reuses. `nitro` starts with `creds`; the others with the tool role. */
  start(tenantId: string, nonce: string, creds: TenantCredentials, options?: StartOptions): Promise<SandboxHandle>;
  /** One readiness probe; no waiting loop (the caller owns `startWait`). */
  ready(handle: SandboxHandle, row: RegistryRow): Promise<ReadyResult>;
  /** Sends one signed job (spec §3.5), waits at most `job.timeoutMs` + NO_ANSWER_MARGIN_MS, and verifies the result proof. */
  run(handle: SandboxHandle, job: RunJob): Promise<RunOutcome>;
  /** Stops it. `creds` on the tool path (`nitro` StopTask is tag-conditioned); absent for the reaper, drain and offboard roles. */
  stop(handle: SandboxHandle, creds?: TenantCredentials): Promise<void>;
  /** Every sandbox of this deployment the platform lists (tasks tagged by the sample, MicroVMs of the image). Empty on `agentcore`. */
  list(): AsyncIterable<SandboxSummary>;
  /** Whether a sandbox whose row says STARTING or READY still exists (`GetMicrovm` on `microvm`, `DescribeTasks` on `nitro`; always true on `agentcore`). */
  isAlive(handle: SandboxHandle): Promise<boolean>;
  /** Facts for the stop line, read after a stop or when the platform ended it. */
  stopReason(handle: SandboxHandle): Promise<StopFacts>;
  /** Drain only, after every sandbox stopped (spec §5.3): `nitro` deregisters its container instances and waits. */
  cleanup?(deadlineMs: number): Promise<void>;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared test setup for the tool, the reaper, the drain and the offboard
 * function (ADR-0036): a clock that sleeps by advancing itself, a recording
 * backend, an object store that enforces the tenant's prefix, a log that
 * collects lines, and the in-memory DynamoDB.
 */

import { DynamoDouble } from './dynamo-double';
import { FakeBackend } from './fake-backend';
import type { RegistryRow, RunJob, RunOutcome, SandboxHandle, TenantCredentials } from '../src/backend';
import { REGISTRY, registryPk, registrySk } from '../src/env';
import { newNonce, resultProof } from '../src/protocol';
import type { ToolConfig } from '../src/tool/config';
import type { RunCodeDeps } from '../src/tool/deps';
import { Logger } from '../src/tool/log';
import { InputError, inputKey, outputKey, type ObjectStore } from '../src/tool/objects';
import { Registry } from '../src/tool/registry';

export class Clock {
  public constructor(public t = 1_700_000_000_000) {}
  public now = () => this.t;
  public sleep = async (ms: number) => {
    this.t += ms;
  };
}

/** A FakeBackend that records every job and every stop's credentials. */
export class RecordingBackend extends FakeBackend {
  public readonly jobs: RunJob[] = [];
  public readonly stops: Array<{ handle: string; creds?: TenantCredentials }> = [];

  public override async run(handle: SandboxHandle, job: RunJob): Promise<RunOutcome> {
    this.jobs.push(job);
    return super.run(handle, job);
  }

  public override async stop(handle: SandboxHandle, creds?: TenantCredentials): Promise<void> {
    this.stops.push({ handle: handle.handle, creds });
    return super.stop(handle, creds);
  }
}

/** A signed result for `script.nextRun`, with the proof the real runner would send. */
export function signedResult(nonce: string, runId: string, over: Partial<{
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  memoryExceeded: boolean;
  bootId: string;
  durationMs: number;
}> = {}): RunOutcome {
  return {
    kind: 'result',
    result: {
      v: 1,
      runId,
      exitCode: over.exitCode ?? 0,
      stdout: over.stdout ?? '',
      stderr: over.stderr ?? '',
      truncated: over.truncated ?? false,
      durationMs: over.durationMs ?? 1,
      timedOut: over.timedOut ?? false,
      memoryExceeded: over.memoryExceeded ?? false,
      bootId: over.bootId ?? 'b'.repeat(32),
      proof: resultProof(nonce, runId),
    },
  };
}

export class FakeObjects {
  public readonly objects = new Map<string, Uint8Array>();
  public readonly reads: string[] = [];
  public readonly writes: Array<{ key: string; body: string }> = [];

  /** An object store signed as one tenant: it may touch only that tenant's prefixes (the tool tenant role's policy). */
  public forTenant(tenantId: string, maxHeadBytes?: number): ObjectStore {
    return {
      readInput: async (t, name, maxBytes) => {
        if (t !== tenantId) throw new Error('credentials of another tenant');
        const key = inputKey(t, name);
        this.reads.push(key);
        const body = this.objects.get(key);
        if (body === undefined) throw new InputError('input_not_found');
        if (body.length > (maxHeadBytes ?? maxBytes)) throw new InputError('input_too_large');
        return body;
      },
      writeOutput: async (t, runId, body) => {
        if (t !== tenantId) throw new Error('credentials of another tenant');
        this.writes.push({ key: outputKey(t, runId), body });
      },
    };
  }
}

export const baseConfig: ToolConfig = {
  table: 'registry',
  bucket: 'inputs',
  backends: ['microvm'],
  defaultBackend: 'microvm',
  toolTenantRoleArn: 'arn:aws:iam::ACCOUNT:role/tool-tenant',
  runTimeoutMs: 30_000,
  startWaitMs: 15_000,
  maxOutputBytes: 262_144,
  maxInputBytes: 5_242_880,
  sandboxIdleMs: 900_000,
  sandboxMaxLifeMs: 8 * 3_600_000,
  perTenantMetrics: false,
};

export interface Harness {
  readonly clock: Clock;
  readonly db: DynamoDouble;
  readonly registry: Registry;
  readonly objects: FakeObjects;
  readonly lines: Array<Record<string, unknown>>;
  readonly backends: Map<'microvm' | 'nitro' | 'agentcore', RecordingBackend>;
  readonly deps: RunCodeDeps;
  readonly credsFor: string[];
  /** Log lines of one event name. */
  events(name: string): Array<Record<string, unknown>>;
}

export function harness(over: Partial<ToolConfig> = {}): Harness {
  const clock = new Clock();
  const db = new DynamoDouble();
  const registry = new Registry(db.client, 'registry');
  const objects = new FakeObjects();
  const lines: Array<Record<string, unknown>> = [];
  const config: ToolConfig = { ...baseConfig, ...over };
  const backends = new Map<'microvm' | 'nitro' | 'agentcore', RecordingBackend>();
  for (const name of config.backends) backends.set(name, new RecordingBackend(name, clock.now));
  const credsFor: string[] = [];
  const deps: RunCodeDeps = {
    config,
    backends,
    credentials: async (tenantId) => {
      credsFor.push(tenantId);
      return { tenantId, accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' };
    },
    registryFor: () => registry,
    objectsFor: (creds) => objects.forTenant(creds.tenantId),
    log: new Logger((l) => lines.push(JSON.parse(l)), config.perTenantMetrics),
    now: clock.now,
    sleep: clock.sleep,
    newRunId: (() => {
      let n = 0;
      return () => `run-${++n}`;
    })(),
    newNonce,
    pollMs: 500,
  };
  return { clock, db, registry, objects, lines, backends, deps, credsFor, events: (name) => lines.filter((l) => l.event === name) };
}

/** A registry item as the tool writes it, for seeding rows in a given state. */
export function rowItem(over: Partial<RegistryRow> & Pick<RegistryRow, 'tenantId' | 'backend' | 'state'>, now: number): Record<string, unknown> {
  const createdAt = over.createdAt ?? now;
  const expiresAt = over.expiresAt ?? createdAt + 8 * 3_600_000;
  const item: Record<string, unknown> = {
    [REGISTRY.PK]: registryPk(over.tenantId),
    [REGISTRY.SK]: registrySk(over.backend),
    [REGISTRY.NONCE]: over.nonce ?? newNonce(),
    [REGISTRY.STATE]: over.state,
    [REGISTRY.CREATED_AT]: createdAt,
    [REGISTRY.EXPIRES_AT]: expiresAt,
    [REGISTRY.TTL_AT]: Math.floor((expiresAt + 3_600_000) / 1000),
    [REGISTRY.VERSION]: over.version ?? 1,
  };
  const optional: Array<[string, unknown]> = [
    [REGISTRY.HANDLE, over.handle], [REGISTRY.ADDRESS, over.address], [REGISTRY.BOOT_ID, over.bootId], [REGISTRY.RETRY_AT, over.retryAt],
    [REGISTRY.LAST_USED_AT, over.lastUsedAt], [REGISTRY.LEASE_UNTIL, over.leaseUntil], [REGISTRY.SUSPENDED_MS, over.suspendedMs],
  ];
  for (const [k, v] of optional) if (v !== undefined) item[k] = v;
  return item;
}

/**
 * A sandbox the backend really holds, with a registry row that names it.
 * `over` sets row fields (a version, a lease, `lastUsedAt`, ...).
 */
export async function seedSandbox(
  h: Harness,
  state: RegistryRow['state'],
  over: Partial<RegistryRow> = {},
  backendName: 'microvm' | 'nitro' | 'agentcore' = 'microvm',
  tenantId = 'tenant-a',
): Promise<SandboxHandle> {
  const backend = h.backends.get(backendName)!;
  const nonce = over.nonce ?? 'A'.repeat(43);
  const handle = await backend.start(tenantId, nonce, { tenantId, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
  h.db.seed(rowItem({
    tenantId, backend: backendName, state, handle: handle.handle, nonce, createdAt: h.clock.t, leaseUntil: h.clock.t + 20_000, version: 5, ...over,
  }, h.clock.t));
  return handle;
}

/** Everything a reaper, drain or offboard function is built from. */
export function maintenanceDeps(h: Harness) {
  return { config: h.deps.config, backends: h.backends, registry: h.registry, log: h.deps.log, now: h.clock.now };
}

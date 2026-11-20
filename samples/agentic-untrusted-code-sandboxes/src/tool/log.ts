// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Structured lines (spec §3.8, ADR-0013, ADR-0033). Every line is one JSON
 * object written with `process.stdout.write`, so its fields stay at the top
 * level where Logs Insights and Contributor Insights read them
 * (`console.log` under the Lambda JSON log format would wrap the whole
 * string in a `message` field). A line never carries code, input, output,
 * a nonce or a proof, only sizes, ids and outcomes.
 */

import type { BackendName, StopFacts } from '../backend';

/** Contributor Insights and EMF key on these. */
export const LOG_EVENT = { run: 'run', sandboxStopped: 'sandbox_stopped' } as const;

/** CloudWatch namespace of the opt-in per-tenant metrics (`perTenantMetrics`). */
export const METRICS_NAMESPACE = 'UntrustedCodeSandboxes';

/** A platform's free-text reason is cut to this many characters before it reaches a line keyed for Contributor Insights. */
export const MAX_REASON_CHARS = 200;

export type LineWriter = (line: string) => void;

export const stdoutWriter: LineWriter = (line) => {
  process.stdout.write(line);
};

/** The per-call line (spec §3.8). */
export interface RunLine {
  readonly tenantId: string;
  readonly backend?: BackendName;
  readonly handle?: string;
  readonly runId?: string;
  readonly sandbox?: 'started' | 'reused';
  /** A tool error code, or `ok`. */
  readonly outcome: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly durationMs?: number;
  readonly startMs?: number;
  readonly inputBytes?: number;
  readonly outputBytes?: number;
  /** On a failed start: `stoppedReason`, `stateReason`, `start_cap` or an error name. */
  readonly stoppedReason?: string;
}

/** The one line per sandbox (spec §3.8). */
export interface StopLine {
  readonly tenantId: string;
  readonly backend: BackendName;
  readonly handle: string;
  readonly sandboxSeconds: number;
  /** Which writer moved the row: `tool`, `reaper`, `drain` or `offboard`. */
  readonly by: string;
  /** Why the writer stopped it: `idle`, `expired`, `overrun`, `dead`, `failed_start`, `gone`, `offboard`, `drain` or `orphan`. */
  readonly reason?: string;
  /** The platform's own reason (`stoppedReason`, `stateReason`), when it gave one, cut to {@link MAX_REASON_CHARS}. */
  readonly stoppedReason?: string;
  readonly orphan?: true;
  /** `microvm` only. */
  readonly runningSeconds?: number;
  readonly suspendedSeconds?: number;
  readonly estimated?: true;
}

export class Logger {
  public constructor(
    private readonly write: LineWriter = stdoutWriter,
    private readonly perTenantMetrics = false,
  ) {}

  /** One structured line. Undefined fields are dropped by JSON. */
  public line(event: string, fields: object): void {
    this.write(`${JSON.stringify({ event, ...fields })}\n`);
  }

  public run(line: RunLine): void {
    this.line(LOG_EVENT.run, { ...line, stoppedReason: line.stoppedReason?.slice(0, MAX_REASON_CHARS) });
    if (this.perTenantMetrics && line.backend !== undefined) {
      this.emf(line.tenantId, line.backend, {
        Runs: { unit: 'Count', value: 1 },
        Errors: { unit: 'Count', value: line.outcome === 'ok' ? 0 : 1 },
        ...(line.durationMs === undefined ? {} : { RunDuration: { unit: 'Milliseconds', value: line.durationMs } }),
      });
    }
  }

  public stop(line: StopLine): void {
    this.line(LOG_EVENT.sandboxStopped, line);
    if (this.perTenantMetrics && line.tenantId !== 'unknown') {
      this.emf(line.tenantId, line.backend, { SandboxSeconds: { unit: 'Seconds', value: line.sandboxSeconds } });
    }
  }

  private emf(tenantId: string, backend: BackendName, metrics: Record<string, { unit: string; value: number }>): void {
    this.write(`${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: METRICS_NAMESPACE,
          Dimensions: [['TenantId', 'Backend']],
          Metrics: Object.entries(metrics).map(([Name, m]) => ({ Name, Unit: m.unit })),
        }],
      },
      TenantId: tenantId,
      Backend: backend,
      ...Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, m.value])),
    })}\n`);
  }
}

/** What the writer of a stop line knows about the sandbox's row. */
export interface StopRowFacts {
  readonly tenantId: string;
  readonly backend: BackendName;
  readonly handle: string;
  readonly createdAt?: number;
  readonly lastUsedAt?: number;
  readonly suspendedMs?: number;
}

/**
 * Builds the stop line (spec §3.8). `sandboxSeconds` is `stoppedAt -
 * startedAt`, from the platform's facts where it gives them, else the row's
 * `createdAt` and the time of the stop. On `microvm` the line also carries the
 * estimated running and suspended split: the row's `suspendedMs` plus the final
 * gap `stoppedAt - lastUsedAt - sandboxIdle`, assuming the MicroVM suspends
 * exactly at `sandboxIdle`.
 */
export function buildStopLine(args: {
  readonly row: StopRowFacts;
  readonly facts: StopFacts;
  readonly now: number;
  readonly sandboxIdleMs: number;
  readonly by: string;
  readonly reason?: string;
  readonly orphan?: boolean;
}): StopLine {
  const { row, facts, now, sandboxIdleMs, by, orphan } = args;
  const startedAt = facts.startedAt ?? row.createdAt ?? now;
  const stoppedAt = facts.stoppedAt ?? now;
  const sandboxSeconds = Math.max(0, Math.round((stoppedAt - startedAt) / 1000));
  const base: StopLine = {
    tenantId: row.tenantId,
    backend: row.backend,
    handle: row.handle,
    sandboxSeconds,
    by,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
    ...(facts.reason === undefined ? {} : { stoppedReason: facts.reason.slice(0, MAX_REASON_CHARS) }),
    ...(orphan ? { orphan: true as const } : {}),
  };
  if (row.backend !== 'microvm') return base;
  const lastGap = row.lastUsedAt === undefined ? 0 : Math.max(0, stoppedAt - row.lastUsedAt - sandboxIdleMs);
  const suspendedSeconds = Math.min(sandboxSeconds, Math.round(((row.suspendedMs ?? 0) + lastGap) / 1000));
  return { ...base, runningSeconds: Math.max(0, sandboxSeconds - suspendedSeconds), suspendedSeconds, estimated: true };
}

/** The error's class name only: a message can carry a code fragment, an id or a tenant's data. */
export function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.]{1,64}$/.test(error.name) ? error.name : 'Error';
}

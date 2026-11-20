// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The run record: what the driver writes down while it runs, and prints at
 * the end. Assertions never throw; a failed check marks its step and the run
 * goes on, so the table shows every step (as agentic-runtime-isolation's
 * integration test does). Pure code with an injected clock, so a unit test
 * covers it.
 *
 * Nothing recorded may carry a token, a nonce, a credential, a proof, code,
 * input or output (scripts/CONVENTIONS.md); callers pass counts, statuses,
 * codes and booleans.
 */

import { type Backend } from './common';

export type Result = 'PASS' | 'FAIL' | 'SKIP';

export interface StepRecord {
  readonly key: string;
  readonly result: Result;
  /** The failed checks (FAIL), the skip reason (SKIP) or the evidence notes (PASS). */
  readonly evidence: string;
  readonly seconds: number;
}

export interface LatencySample {
  readonly backend: Backend;
  readonly kind: 'cold' | 'warm';
  readonly ms: number;
}

export interface TimedPhase {
  readonly name: string;
  readonly seconds: number;
}

export interface RunRecord {
  readonly startedAt: string;
  readonly region: string;
  readonly steps: readonly StepRecord[];
  readonly phases: readonly TimedPhase[];
  readonly latency: readonly LatencySample[];
}

export class Recorder {
  private readonly steps: StepRecord[] = [];
  private readonly phases: TimedPhase[] = [];
  private readonly samples: LatencySample[] = [];
  private current?: { key: string; started: number; failures: string[]; notes: string[] };

  public constructor(
    private readonly region: string,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  ) {}

  /** Starts a step (or one unit of it). A step left open is closed first, so a crash never loses it. */
  public begin(key: string): void {
    this.end();
    this.current = { key, started: this.now(), failures: [], notes: [] };
    this.log(`== step ${key}`);
  }

  /** Records a check. Never throws. */
  public check(message: string, ok: boolean): boolean {
    if (!ok && this.current) {
      this.current.failures.push(message);
      this.log(`  FAIL: ${message}`);
    }
    return ok;
  }

  public note(text: string): void {
    this.current?.notes.push(text);
    this.log(`  ${text}`);
  }

  /** A step that threw: recorded as a failure with the error class and message, then the run goes on. */
  public crashed(error: unknown): void {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.check(`step crashed: ${text.slice(0, 300)}`, false);
  }

  public end(): void {
    const c = this.current;
    if (!c) return;
    this.current = undefined;
    const seconds = Math.round((this.now() - c.started) / 1000);
    const failed = c.failures.length > 0;
    this.steps.push({
      key: c.key,
      result: failed ? 'FAIL' : 'PASS',
      evidence: failed ? c.failures.join('; ') : c.notes.join('; '),
      seconds,
    });
  }

  public skip(key: string, reason: string): void {
    this.end();
    this.steps.push({ key, result: 'SKIP', evidence: reason, seconds: 0 });
    this.log(`== step ${key}: SKIP (${reason})`);
  }

  /** Times a deploy or destroy phase (spec §8: the run records them). Records the time also when `fn` throws. */
  public async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    try {
      return await fn();
    } finally {
      this.phases.push({ name, seconds: Math.round((this.now() - t0) / 1000) });
    }
  }

  public latency(backend: Backend, kind: 'cold' | 'warm', ms: number): void {
    this.samples.push({ backend, kind, ms: Math.round(ms) });
  }

  public get failed(): boolean {
    this.end();
    return this.steps.some((s) => s.result === 'FAIL');
  }

  public get passed(): number {
    return this.steps.filter((s) => s.result === 'PASS').length;
  }

  public toJSON(startedAt: string): RunRecord {
    this.end();
    return { startedAt, region: this.region, steps: [...this.steps], phases: [...this.phases], latency: [...this.samples] };
  }
}

/** The p50 of the samples of one backend and kind, or undefined. */
export function median(samples: readonly LatencySample[], backend: Backend, kind: 'cold' | 'warm'): number | undefined {
  const v = samples.filter((s) => s.backend === backend && s.kind === kind).map((s) => s.ms).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  return v[Math.floor((v.length - 1) / 2)];
}

/** The table the driver prints and `integration-test.md` quotes: steps, then the timings and latencies. */
export function formatRecord(r: RunRecord): string {
  const rows = r.steps.map((s) => `| ${s.key} | ${s.result} | ${s.seconds} | ${s.evidence.replace(/\|/g, '/')} |`);
  const total = r.steps.length;
  const passed = r.steps.filter((s) => s.result === 'PASS').length;
  const skipped = r.steps.filter((s) => s.result === 'SKIP').length;
  const lines = [
    `Run ${r.startedAt}, Region ${r.region}: ${passed} of ${total} steps passed${skipped > 0 ? `, ${skipped} skipped` : ''}`,
    '',
    '| Step | Result | Seconds | Evidence |',
    '|---|---|---|---|',
    ...rows,
    '',
    '| Phase | Seconds |',
    '|---|---|',
    ...r.phases.map((p) => `| ${p.name} | ${p.seconds} |`),
  ];
  const backends = [...new Set(r.latency.map((s) => s.backend))];
  if (backends.length > 0) {
    lines.push('', '| Backend | Cold p50 (ms) | Warm p50 (ms) |', '|---|---|---|');
    for (const b of backends) lines.push(`| ${b} | ${median(r.latency, b, 'cold') ?? '-'} | ${median(r.latency, b, 'warm') ?? '-'} |`);
  }
  return lines.join('\n');
}

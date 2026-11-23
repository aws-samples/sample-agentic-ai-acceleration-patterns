// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isQuotaId } from './budget';

/**
 * The `StressRun` metrics (stress ADR-0022, docs/stress-dashboard.design.md §3.1): what the
 * runner, the driver host's relay and a slice publish into the platform account so a run can be
 * watched. The emitter has an allowlist of dimension names and of values for each name; any
 * other name or value is an error, so no tenant, user, agent, token, host name or address can
 * become a dimension. The metrics are a view: a failed publish is logged and never fails a run.
 */

export const NAMESPACE = 'StressRun';

/** The run dashboard's name, `<prefix>-run` (design §8). */
export const dashboardName = (prefix: string): string => `${prefix}-run`;

/** The k6 scenarios of a platform run: the relay and the unattributed count cover these only. */
export const K6_SCENARIOS: readonly string[] = ['PS-2', 'PS-3', 'PS-4', 'PS-6', 'PS-8'];

export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'none'] as const;
export const PHASES = ['deploy', 'destroy'] as const;

/** At most this many distinct `Reason` values a run publishes; the rest map to `other`. */
export const MAX_REASONS = 16;

const VALUE_RULES = {
  RunId: (v: string) => /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(v),
  Slice: (v: string) => /^[a-z][a-z0-9-]{0,63}$/.test(v),
  Scenario: (v: string) => /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(v),
  StatusClass: (v: string) => (STATUS_CLASSES as readonly string[]).includes(v),
  Phase: (v: string) => (PHASES as readonly string[]).includes(v),
  Account: (v: string) => v === 'platform' || /^cell-account-[1-9][0-9]*$/.test(v),
  Quota: (v: string) => isQuotaId(v),
  Reason: (v: string) => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(v),
} as const satisfies Record<string, (v: string) => boolean>;

export type DimensionName = keyof typeof VALUE_RULES;

/** The dimension names a metric may carry: the allowlist of the design's §3.1. */
export const DIMENSION_NAMES = Object.keys(VALUE_RULES) as DimensionName[];

export type Unit = 'Count' | 'Seconds' | 'Milliseconds';

interface MetricSpec {
  readonly unit: Unit;
  readonly dimensions: readonly DimensionName[];
  /** Published only by the host relay, as `Values` and `Counts` (at most 150 buckets a datum). */
  readonly histogram?: true;
}

export const METRICS = {
  ScenarioActive: { unit: 'Count', dimensions: ['RunId', 'Scenario'] },
  IsolationAssertions: { unit: 'Count', dimensions: ['RunId', 'Slice', 'Scenario'] },
  IsolationMismatches: { unit: 'Count', dimensions: ['RunId', 'Slice', 'Scenario'] },
  IsolationAssertionsFinal: { unit: 'Count', dimensions: ['RunId', 'Slice', 'Scenario'] },
  IsolationMismatchesFinal: { unit: 'Count', dimensions: ['RunId', 'Slice', 'Scenario'] },
  Requests: { unit: 'Count', dimensions: ['RunId', 'Scenario', 'StatusClass'] },
  RefusalsSeen: { unit: 'Count', dimensions: ['RunId', 'Scenario'] },
  RefusalsNamed: { unit: 'Count', dimensions: ['RunId', 'Scenario'] },
  RefusalsByReason: { unit: 'Count', dimensions: ['RunId', 'Scenario', 'Reason'] },
  RefusalsUnattributed: { unit: 'Count', dimensions: ['RunId', 'Slice', 'Scenario'] },
  ClientLatencyMs: { unit: 'Milliseconds', dimensions: ['RunId', 'Scenario'], histogram: true },
  OnboardReadySeconds: { unit: 'Seconds', dimensions: ['RunId'] },
  BuildsInFlight: { unit: 'Count', dimensions: ['RunId'] },
  RoutableSeconds: { unit: 'Seconds', dimensions: ['RunId'] },
  SuspendedSeconds: { unit: 'Seconds', dimensions: ['RunId'] },
  RemovedSeconds: { unit: 'Seconds', dimensions: ['RunId'] },
  LifecycleSeconds: { unit: 'Seconds', dimensions: ['RunId', 'Slice', 'Phase'] },
  QuotaPlannedDraw: { unit: 'Count', dimensions: ['RunId', 'Account', 'Quota'] },
  QuotaLimit: { unit: 'Count', dimensions: ['RunId', 'Account', 'Quota'] },
} as const satisfies Record<string, MetricSpec>;

export type MetricName = keyof typeof METRICS;

export function isMetricName(v: unknown): v is MetricName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(METRICS, v);
}

/** One data point, checked: the shape `PutMetricData` takes (see `toApi`). */
export interface Datum {
  readonly name: MetricName;
  readonly unit: Unit;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly value: number;
  readonly timestamp?: Date;
}

/**
 * Checks a metric name, its dimensions (exactly the metric's own set, each value inside its
 * rule) and its value; returns the datum or throws naming the problem. Never echoes a value
 * that failed a dimension rule (it could be an identifier that must not be logged).
 */
export function datum(name: string, value: number, dimensions: Readonly<Record<string, string>>, timestamp?: Date): Datum {
  if (!isMetricName(name)) throw new Error(`${name} is not a StressRun metric (${Object.keys(METRICS).join(', ')})`);
  const spec: MetricSpec = METRICS[name];
  if (spec.histogram) throw new Error(`${name} is a histogram that only the host relay publishes (stress/k6/relay.sh)`);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name}: the value must be a non-negative number`);
  return { name, unit: spec.unit, dimensions: checkedDimensions(name, spec, dimensions), value, ...(timestamp === undefined ? {} : { timestamp }) };
}

function checkedDimensions(name: string, spec: MetricSpec, dimensions: Readonly<Record<string, string>>): Record<string, string> {
  const given = Object.keys(dimensions);
  const unknown = given.filter((k) => !(DIMENSION_NAMES as string[]).includes(k));
  if (unknown.length > 0) throw new Error(`${name}: dimension ${unknown.join(', ')} is not allowed (allowed: ${DIMENSION_NAMES.join(', ')})`);
  const missing = spec.dimensions.filter((d) => !given.includes(d));
  const extra = given.filter((d) => !(spec.dimensions as readonly string[]).includes(d));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${name}: dimensions must be ${spec.dimensions.join(', ')}${missing.length > 0 ? ` (missing ${missing.join(', ')})` : ''}${extra.length > 0 ? ` (not for this metric: ${extra.join(', ')})` : ''}`);
  }
  for (const d of spec.dimensions) {
    if (!VALUE_RULES[d](dimensions[d])) throw new Error(`${name}: the value of ${d} is not one that dimension takes`);
  }
  return { ...dimensions };
}

/** Maps a refusal reason to at most `MAX_REASONS` distinct values; later ones become `other`. */
export class ReasonMapper {
  private readonly seen = new Set<string>();
  value(reason: string): string {
    const clean = reason.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
    if (!VALUE_RULES.Reason(clean)) return 'other';
    if (this.seen.has(clean)) return clean;
    if (this.seen.size < MAX_REASONS - 1) {
      this.seen.add(clean);
      return clean;
    }
    return 'other';
  }
}

/** The datum as the `PutMetricData` API (and the CLI's `--metric-data`) takes it. */
export function toApi(d: Datum): Record<string, unknown> {
  return {
    MetricName: d.name,
    Dimensions: Object.entries(d.dimensions).map(([Name, Value]) => ({ Name, Value })),
    ...(d.timestamp === undefined ? {} : { Timestamp: d.timestamp.toISOString() }),
    Value: d.value,
    Unit: d.unit,
  };
}

/** Publishes a batch of data points into `StressRun`. */
export type Publish = (data: readonly Datum[]) => Promise<void>;

/** The calls one `PutMetricData` takes: at most 1,000 data points (the API limit is 1,000, and 1 MB). */
const BATCH = 500;

/** A `Publish` that calls the AWS CLI, with the credentials and Region of the run's own environment. */
export function awsCliPublish(region: string, run: (args: readonly string[]) => Promise<void> = runAws): Publish {
  return async (data) => {
    for (let i = 0; i < data.length; i += BATCH) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-metrics-'));
      const file = path.join(dir, 'data.json');
      try {
        fs.writeFileSync(file, JSON.stringify(data.slice(i, i + BATCH).map(toApi)), { mode: 0o600 });
        await run(['cloudwatch', 'put-metric-data', '--region', region, '--namespace', NAMESPACE, '--metric-data', `file://${file}`]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

function runAws(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('aws', [...args], { timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error === null) resolve();
      else reject(new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${stderr.trim().split('\n')[0] ?? error.message}`));
    });
  });
}

/**
 * Sends data points one batch at a time, in the order given. A failed publish is logged (the
 * first line of the error, once per distinct message) and counted; it never throws, because
 * the metrics are a view and decide no pass criterion (ADR-0022).
 */
export class Emitter {
  private chain: Promise<void> = Promise.resolve();
  private readonly told = new Set<string>();
  failures = 0;

  constructor(
    private readonly publish: Publish,
    readonly runId: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Queues a batch; the returned promise settles when it has been sent or has failed. */
  send(data: readonly Datum[]): Promise<void> {
    if (data.length === 0) return this.chain;
    this.chain = this.chain.then(async () => {
      try {
        await this.publish(data);
      } catch (e) {
        this.failures += 1;
        const message = (e as Error).message;
        if (!this.told.has(message)) {
          this.told.add(message);
          this.log(`metrics: ${message}`);
        }
      }
    });
    return this.chain;
  }

  /** A datum for this run, checked. A bad datum is logged and dropped, like a failed publish. */
  make(name: MetricName, value: number, dimensions: Record<string, string>, timestamp?: Date): Datum | undefined {
    try {
      return datum(name, value, { RunId: this.runId, ...dimensions }, timestamp);
    } catch (e) {
      this.failures += 1;
      this.log(`metrics: ${(e as Error).message}`);
      return undefined;
    }
  }

  emit(name: MetricName, value: number, dimensions: Record<string, string> = {}, timestamp?: Date): Promise<void> {
    const d = this.make(name, value, dimensions, timestamp);
    return d === undefined ? this.chain : this.send([d]);
  }

  /** Waits for everything queued. */
  flush(): Promise<void> {
    return this.chain;
  }
}

/** The age past which the runner stamps a point with its publish time (design §3.1, the age rule). */
export const MAX_POINT_AGE_MS = 3 * 60 * 60 * 1000;

/** `end` as the point's timestamp, or `now` when `end` is more than three hours old. */
export function stampFor(end: Date, now: Date): Date {
  return now.getTime() - end.getTime() > MAX_POINT_AGE_MS ? now : end;
}

/**
 * `run.sh emit <metric> <value> [Dimension=value ...]`: one data point from a slice's script.
 * `RunId` is taken from `STRESS_RUN_ID` unless given. Without `STRESS_METRICS=1` (the runner sets
 * it when the run's metrics are on) it does nothing. A publish failure is a warning, exit 0; a
 * bad metric, value or dimension is exit 2, so a slice's mistake shows in its own verb.
 */
export async function emitFromCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  publish: Publish,
  warn: (line: string) => void,
): Promise<number> {
  if (env.STRESS_METRICS !== '1') return 0;
  const [name, rawValue, ...pairs] = args;
  if (name === undefined || rawValue === undefined) {
    warn('usage: run.sh emit <metric> <value> [Dimension=value ...]');
    return 2;
  }
  const dimensions: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) {
      warn('a dimension is written Name=value');
      return 2;
    }
    dimensions[pair.slice(0, at)] = pair.slice(at + 1);
  }
  if (dimensions.RunId === undefined && env.STRESS_RUN_ID !== undefined && isMetricName(name) && (METRICS[name].dimensions as readonly string[]).includes('RunId')) {
    dimensions.RunId = env.STRESS_RUN_ID;
  }
  let d: Datum;
  try {
    d = datum(name, Number(rawValue), dimensions);
  } catch (e) {
    warn((e as Error).message);
    return 2;
  }
  try {
    await publish([d]);
  } catch (e) {
    warn(`metrics: ${(e as Error).message}`);
  }
  return 0;
}

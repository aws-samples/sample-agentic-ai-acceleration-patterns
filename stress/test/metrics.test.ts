// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  awsCliPublish,
  datum,
  DIMENSION_NAMES,
  Emitter,
  emitFromCli,
  METRICS,
  type MetricName,
  REFUSAL_REASONS,
  stampFor,
  toApi,
} from '../src/metrics';

const RUN = '20261123T1200Z';

describe('the StressRun emitter (stress ADR-0022, design §3.1)', () => {
  it('names only the dimensions of the design, and no tenant, user, agent or token', () => {
    expect([...DIMENSION_NAMES].sort()).toEqual(['Account', 'Phase', 'Quota', 'Reason', 'RunId', 'Scenario', 'Slice', 'StatusClass']);
    for (const spec of Object.values(METRICS)) {
      for (const d of spec.dimensions) expect(DIMENSION_NAMES).toContain(d);
    }
  });

  it('refuses any dimension name outside the allowlist', () => {
    for (const bad of ['TenantId', 'tenant', 'User', 'AgentId', 'Token', 'Host', 'Address']) {
      expect(() => datum('ScenarioActive', 1, { RunId: RUN, Scenario: 'PS-2', [bad]: 'x' })).toThrow(/not allowed/);
    }
  });

  it('refuses a missing dimension, one the metric does not take, and a value outside its rule', () => {
    expect(() => datum('ScenarioActive', 1, { RunId: RUN })).toThrow(/missing Scenario/);
    expect(() => datum('ScenarioActive', 1, { RunId: RUN, Scenario: 'PS-2', Slice: 'x' })).toThrow(/not for this metric: Slice/);
    expect(() => datum('Requests', 1, { RunId: RUN, Scenario: 'PS-2', StatusClass: '404' })).toThrow(/StatusClass/);
    expect(() => datum('LifecycleSeconds', 1, { RunId: RUN, Slice: 'x', Phase: 'sideways' })).toThrow(/Phase/);
    expect(() => datum('QuotaLimit', 1, { RunId: RUN, Account: 'cell-account-0', Quota: 'lambda-concurrency' })).toThrow(/Account/);
    expect(() => datum('QuotaLimit', 1, { RunId: RUN, Account: 'platform', Quota: 'not-a-quota' })).toThrow(/Quota/);
  });

  it('does not echo a rejected value, which could be an identifier', () => {
    try {
      datum('ScenarioActive', 1, { RunId: RUN, Scenario: 'TENANT-01ABCDEF/secret' });
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret');
    }
  });

  it('refuses an unknown metric, a negative or non-finite value, and a histogram from the runner', () => {
    expect(() => datum('Nope', 1, {})).toThrow(/not a StressRun metric/);
    expect(() => datum('ScenarioActive', -1, { RunId: RUN, Scenario: 'PS-2' })).toThrow(/non-negative/);
    expect(() => datum('ScenarioActive', Number.NaN, { RunId: RUN, Scenario: 'PS-2' })).toThrow(/non-negative/);
    expect(() => datum('ClientLatencyMs', 1, { RunId: RUN, Scenario: 'PS-2' })).toThrow(/relay/);
  });

  it('builds the PutMetricData shape', () => {
    const at = new Date('2026-11-23T12:00:00.000Z');
    expect(toApi(datum('LifecycleSeconds', 12, { RunId: RUN, Slice: 'control-plane', Phase: 'deploy' }, at))).toEqual({
      MetricName: 'LifecycleSeconds',
      Dimensions: [{ Name: 'RunId', Value: RUN }, { Name: 'Slice', Value: 'control-plane' }, { Name: 'Phase', Value: 'deploy' }],
      Timestamp: '2026-11-23T12:00:00.000Z',
      Value: 12,
      Unit: 'Seconds',
    });
  });

  it('takes a refusal reason from a short fixed list, so a run cannot publish an unbounded number of series', () => {
    expect(REFUSAL_REASONS.length).toBeLessThanOrEqual(16);
    for (const reason of REFUSAL_REASONS) expect(datum('RefusalsByReason', 1, { RunId: RUN, Scenario: 'PS-2', Reason: reason }).dimensions.Reason).toBe(reason);
    for (const reason of ['http-418', 'reason-1', 'HTTP 429', '']) {
      expect(() => datum('RefusalsByReason', 1, { RunId: RUN, Scenario: 'PS-2', Reason: reason })).toThrow(/Reason/);
    }
  });

  it('stamps a point with its publish time once its own is over three hours old', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    const young = new Date('2026-11-23T10:00:00Z');
    expect(stampFor(young, now)).toBe(young);
    expect(stampFor(new Date('2026-11-23T08:59:00Z'), now)).toBe(now);
  });

  it('publishes in batches of at most 500 data points through the CLI, then removes its temporary file', async () => {
    const calls: { args: readonly string[]; body: unknown[] }[] = [];
    const fs = await import('node:fs');
    const publish = awsCliPublish('eu-central-1', async (args) => {
      const file = String(args[args.length - 1]).replace('file://', '');
      calls.push({ args, body: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[] });
    });
    const data = Array.from({ length: 1001 }, () => datum('BuildsInFlight', 1, { RunId: RUN }));
    await publish(data);
    expect(calls.map((c) => c.body.length)).toEqual([500, 500, 1]);
    expect(calls[0]!.args.slice(0, 6)).toEqual(['cloudwatch', 'put-metric-data', '--region', 'eu-central-1', '--namespace', 'StressRun']);
    expect(fs.existsSync(String(calls[0]!.args[calls[0]!.args.length - 1]).replace('file://', ''))).toBe(false);
  });

  it('logs a failed publish once and never throws, because the metrics are a view', async () => {
    const lines: string[] = [];
    const emitter = new Emitter(async () => Promise.reject(new Error('aws cloudwatch put-metric-data failed: no credentials')), RUN, (l) => lines.push(l));
    await emitter.emit('ScenarioActive', 1, { Scenario: 'PS-2' });
    await emitter.emit('ScenarioActive', 0, { Scenario: 'PS-2' });
    expect(emitter.failures).toBe(2);
    expect(lines).toEqual(['metrics: aws cloudwatch put-metric-data failed: no credentials']);
  });

  it('drops a bad datum with a log line and keeps sending', async () => {
    const sent: string[] = [];
    const lines: string[] = [];
    const emitter = new Emitter(async (d) => void sent.push(...d.map((x) => x.name)), RUN, (l) => lines.push(l));
    await emitter.emit('ScenarioActive', 1, { Scenario: 'bad scenario!' });
    await emitter.emit('BuildsInFlight', 3);
    expect(sent).toEqual(['BuildsInFlight']);
    expect(lines[0]).toMatch(/Scenario/);
  });
});

describe('run.sh emit', () => {
  const warn: string[] = [];
  const sent: { name: MetricName; dimensions: Record<string, string>; value: number }[] = [];
  const publish = async (d: readonly { name: MetricName; dimensions: Readonly<Record<string, string>>; value: number }[]): Promise<void> => {
    sent.push(...d.map((x) => ({ name: x.name, dimensions: { ...x.dimensions }, value: x.value })));
  };
  beforeEach(() => {
    warn.length = 0;
    sent.length = 0;
  });

  it('does nothing unless the run has its metrics on', async () => {
    expect(await emitFromCli(['BuildsInFlight', '3'], {}, publish, (l) => warn.push(l))).toBe(0);
    expect(sent).toEqual([]);
  });

  it('takes the run id from the environment and checks the dimensions', async () => {
    const env = { STRESS_METRICS: '1', STRESS_RUN_ID: RUN };
    expect(await emitFromCli(['OnboardReadySeconds', '12.5'], env, publish, (l) => warn.push(l))).toBe(0);
    expect(await emitFromCli(['RefusalsUnattributed', '0', 'Slice=control-plane', 'Scenario=PS-1'], env, publish, (l) => warn.push(l))).toBe(0);
    expect(sent).toEqual([
      { name: 'OnboardReadySeconds', dimensions: { RunId: RUN }, value: 12.5 },
      { name: 'RefusalsUnattributed', dimensions: { RunId: RUN, Slice: 'control-plane', Scenario: 'PS-1' }, value: 0 },
    ]);
    expect(await emitFromCli(['OnboardReadySeconds', '1', 'TenantId=x'], env, publish, (l) => warn.push(l))).toBe(2);
    expect(await emitFromCli(['OnboardReadySeconds'], env, publish, (l) => warn.push(l))).toBe(2);
    expect(await emitFromCli(['OnboardReadySeconds', '1', 'junk'], env, publish, (l) => warn.push(l))).toBe(2);
  });

  it('takes a plain decimal value only: an empty or hexadecimal one is not a zero or a sixteen', async () => {
    const env = { STRESS_METRICS: '1', STRESS_RUN_ID: RUN };
    for (const bad of ['', ' ', '0x10', '1e3', '-1', 'NaN', '1.']) {
      expect(await emitFromCli(['BuildsInFlight', bad], env, publish, (l) => warn.push(l))).toBe(2);
    }
    expect(sent).toEqual([]);
    expect(await emitFromCli(['BuildsInFlight', '12.5'], env, publish, (l) => warn.push(l))).toBe(0);
    expect(sent.map((d) => d.value)).toEqual([12.5]);
  });

  it('warns and exits 0 when the publish fails', async () => {
    const env = { STRESS_METRICS: '1', STRESS_RUN_ID: RUN };
    expect(await emitFromCli(['BuildsInFlight', '3'], env, async () => Promise.reject(new Error('throttled')), (l) => warn.push(l))).toBe(0);
    expect(warn).toEqual(['metrics: throttled']);
  });
});

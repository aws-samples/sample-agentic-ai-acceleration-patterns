// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RunDashboardStack } from '../dashboard/dashboard.cdk';
import { RunSinkStack } from '../dashboard/sink.cdk';
import { planFromFiles } from '../dashboard/plan';
import { imageProperties } from '../dashboard/snapshot';
import { type DashboardPlan, dashboardBody, RELAY_SLICE, widgetsFor } from '../dashboard/widgets';
import { DIMENSION_NAMES, METRICS } from '../src/metrics';

const RUN = '20261123T1200Z';
const CELL_A = '111111111111';
const CELL_B = '222222222222';

const platform: DashboardPlan = {
  runId: RUN,
  tier: 'small',
  commit: 'f368ad5aa1',
  region: 'eu-central-1',
  runs: [
    { slice: 'tenant-identity', scenario: 'PS-1' },
    { slice: 'control-plane', scenario: 'PS-1' },
    { slice: RELAY_SLICE, scenario: 'PS-2' },
    { slice: RELAY_SLICE, scenario: 'PS-3' },
    { slice: RELAY_SLICE, scenario: 'PS-4' },
    { slice: 'control-plane', scenario: 'PS-5' },
    { slice: RELAY_SLICE, scenario: 'PS-6' },
    { slice: 'tenant-front-door', scenario: 'PS-7' },
    { slice: RELAY_SLICE, scenario: 'PS-8' },
  ],
  cellAccounts: [CELL_A, CELL_B],
  quotas: ['platform:lambda-concurrency', 'platform:codebuild-linux-small', 'cell-account-1:lambda-concurrency', 'cell-account-1:kms-rsa-rps', 'cell-account-2:agentcore-active-sessions', 'platform:cognito-groups'],
};

/** Every metric row of a widget, as `[namespace, name, ...dimensions, options]`. */
function rows(properties: Record<string, unknown>): unknown[][] {
  return (properties.metrics as unknown[][]) ?? [];
}

describe('the run dashboard widgets (design §4)', () => {
  const all = widgetsFor(platform);

  it('has unique ids, and every expression id is unique inside its widget', () => {
    expect(new Set(all.map((w) => w.id)).size).toBe(all.length);
    for (const w of all.filter((x) => x.type === 'metric')) {
      const ids = rows(w.properties).flatMap((r) => {
        const last = r[r.length - 1] as { id?: string } | undefined;
        return typeof last === 'object' && last !== null && typeof last.id === 'string' ? [last.id] : [];
      });
      expect({ widget: w.id, duplicates: ids.length - new Set(ids).size }).toEqual({ widget: w.id, duplicates: 0 });
    }
  });

  it('names every StressRun series it draws with a metric and dimensions of the emitter, and searches none of them', () => {
    let named = 0;
    for (const w of all.filter((x) => x.type === 'metric')) {
      for (const r of rows(w.properties)) {
        if (r[0] !== 'StressRun') continue;
        named += 1;
        const name = r[1] as keyof typeof METRICS;
        expect(Object.keys(METRICS)).toContain(name);
        const dims = r.slice(2, -1) as string[];
        const keys = dims.filter((_, i) => i % 2 === 0);
        expect(keys).toEqual([...METRICS[name].dimensions]);
        for (const k of keys) expect(DIMENSION_NAMES).toContain(k);
        expect(dims[1]).toBe(RUN);
      }
      for (const r of rows(w.properties)) {
        const e = (r[0] as { expression?: string } | undefined)?.expression;
        if (typeof e === 'string' && e.includes('SEARCH(')) expect(e).not.toContain('StressRun');
      }
    }
    expect(named).toBeGreaterThan(150);
  });

  it('carries no tenant, user, agent or token dimension anywhere', () => {
    const text = JSON.stringify(dashboardBody(platform));
    expect(text).not.toMatch(/"(TenantId|Tenant|User|UserId|AgentId|Agent|Token|Host)"/);
  });

  it('keeps the body under the 100 KB CloudWatch limit and every widget on the 24 columns', () => {
    const body = dashboardBody(platform);
    expect(JSON.stringify(body).length).toBeLessThan(100_000);
    for (const w of body.widgets) {
      expect((w.x as number) + (w.width as number)).toBeLessThanOrEqual(24);
    }
  });

  it('reads a cell account only through its own metric rows, by account id', () => {
    const d = all.filter((w) => w.section === 'D' && w.type === 'metric' && w.id !== 'D6-reconcile');
    expect(d.length).toBe(12);
    for (const w of d) {
      for (const r of rows(w.properties)) {
        const options = r[r.length - 1] as { accountId?: string };
        expect([CELL_A, CELL_B]).toContain(options.accountId);
      }
    }
  });

  it('draws the edge from us-east-1 by search, with the compute line at 100 %', () => {
    const b1 = all.find((w) => w.id === 'B1-compute')!;
    expect(b1.properties.region).toBe('us-east-1');
    expect(JSON.stringify(b1.properties)).toContain('SEARCH(');
    expect(JSON.stringify(b1.properties.annotations)).toContain('100');
  });

  it('draws the PS-1 and PS-5 widgets only when the run has those scenarios', () => {
    const only = widgetsFor({ ...platform, runs: [{ slice: RELAY_SLICE, scenario: 'PS-2' }] });
    const ids = only.map((w) => w.id);
    expect(ids).not.toContain('A7-onboarding');
    expect(ids).not.toContain('A8-churn');
    expect(all.map((w) => w.id)).toEqual(expect.arrayContaining(['A7-onboarding', 'A8-churn']));
  });

  it('draws no k6 widget for a run with no k6 scenario, and no cell widget without cell accounts', () => {
    const none = widgetsFor({ ...platform, runs: [{ slice: 'control-plane', scenario: 'PS-1' }], cellAccounts: [] });
    expect(none.map((w) => w.id)).not.toEqual(expect.arrayContaining(['A4-requests']));
    expect(none.filter((w) => w.section === 'D')).toEqual([]);
  });

  it('shows the quota panels the run budgeted and says which quotas have no signal', () => {
    const e = all.filter((w) => w.section === 'E').map((w) => w.id);
    expect(e).toEqual(expect.arrayContaining(['E1-lambda-concurrency', 'E1-codebuild-linux-small', 'E1-kms-rsa-rps', 'E1-agentcore-active-sessions', 'E1-cognito-groups', 'E2-first', 'E2-note']));
  });

  it('gives each image the widget\'s own properties, a size and the run window', () => {
    const w = all.find((x) => x.id === 'A4-requests')!;
    const p = imageProperties(w, { ...platform, start: '2026-11-23T10:00:00Z', end: '2026-11-23T12:00:00Z' });
    expect(p).toMatchObject({ region: 'eu-central-1', width: 900, height: 320, start: '2026-11-23T10:00:00Z', end: '2026-11-23T12:00:00Z' });
    expect(p.metrics).toEqual(w.properties.metrics);
    expect(imageProperties(all.find((x) => x.id === 'B1-compute')!, platform).region).toBe('us-east-1');
  });
});

describe('the observability sink (design §8, §11)', () => {
  it('allows the cell accounts to link metrics, and nothing else', () => {
    const template = Template.fromStack(new RunSinkStack(new App(), 'StressRunSink', { cellAccountIds: [CELL_A, CELL_B], env: { account: '123456789012', region: 'eu-central-1' } }));
    expect(Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type)).toEqual(['AWS::Oam::Sink']);
    template.hasResourceProperties('AWS::Oam::Sink', {
      Name: 'StressRunSink',
      Policy: {
        Statement: [
          {
            Action: ['oam:CreateLink', 'oam:UpdateLink'],
            Condition: { 'ForAllValues:StringEquals': { 'oam:ResourceTypes': ['AWS::CloudWatch::Metric'] } },
            Effect: 'Allow',
            Principal: { AWS: [CELL_A, CELL_B] },
            Resource: '*',
          },
        ],
      },
    });
  });

  it('refuses no account and an account that is not 12 digits', () => {
    expect(() => new RunSinkStack(new App(), 'A', { cellAccountIds: [] })).toThrow(/12-digit/);
    expect(() => new RunSinkStack(new App(), 'B', { cellAccountIds: ['*'] })).toThrow(/12-digit/);
  });
});

describe('the run dashboard stack (design §8)', () => {
  it('holds one dashboard and nothing else', () => {
    const app = new App();
    const stack = new RunDashboardStack(app, 'StressDashboardTest', { prefix: 'Stress', plan: platform, env: { account: '123456789012', region: 'eu-central-1' } });
    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources as Record<string, { Type: string }>;
    expect(Object.values(resources).map((r) => r.Type)).toEqual(['AWS::CloudWatch::Dashboard']);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: 'Stress-run' });
    expect(template.toJSON().Outputs).toBeUndefined();
  });
});

describe('the plan the dashboard is built from', () => {
  const write = (name: string, doc: unknown): string => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-')), name);
    fs.writeFileSync(file, JSON.stringify(doc));
    return file;
  };
  const doc = { runId: RUN, tier: 'small', commit: 'f368ad5', region: 'eu-central-1', runs: [{ slice: 'control-plane', scenario: 'PS-1' }], quotas: ['platform:lambda-concurrency'] };

  it('reads the plan and the account ids of the cell accounts file, as many as the tier has', () => {
    const accounts = write('accounts.json', { accounts: [{ accountId: CELL_A, profile: 'x' }, { accountId: CELL_B }] });
    expect(planFromFiles(write('p.json', doc), accounts, {}).cellAccounts).toEqual([CELL_A]);
    expect(planFromFiles(write('p.json', { ...doc, tier: 'medium' }), accounts, {}).cellAccounts).toEqual([CELL_A, CELL_B]);
    expect(planFromFiles(write('p.json', doc), undefined, {}).cellAccounts).toEqual([]);
  });

  it('refuses a malformed value, because the plan ends up in a template and in CLI arguments', () => {
    expect(() => planFromFiles(write('p.json', { ...doc, runId: 'a b' }), undefined, {})).toThrow(/runId/);
    expect(() => planFromFiles(write('p.json', { ...doc, region: 'mars' }), undefined, {})).toThrow(/region/);
    expect(() => planFromFiles(write('p.json', { ...doc, runs: [{ slice: 'x y', scenario: 'PS-1' }] }), undefined, {})).toThrow(/runs/);
    expect(() => planFromFiles(write('p.json', { ...doc, quotas: ['bad'] }), undefined, {})).toThrow(/quotas/);
    expect(() => planFromFiles(write('p.json', { ...doc, start: 'never' }), undefined, {})).toThrow(/start/);
    expect(() => planFromFiles(write('p.json', doc), write('a.json', { accounts: [{ accountId: '12' }] }), {})).toThrow(/12 digits/);
    expect(() => planFromFiles(write('p.json', doc), undefined, { STRESS_FD_IDENTITY_REGION: 'x;y' })).toThrow(/Region/);
  });
});

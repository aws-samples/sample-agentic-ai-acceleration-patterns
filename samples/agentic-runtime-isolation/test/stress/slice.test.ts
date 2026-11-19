// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CELL_ACCOUNT, drawsOf } from './slice-cli';
import { STRESS_TIERS } from './tiers';
import { overdraws, parseDraws, sumDraws } from '../../../../stress/src/budget';
import { parseDeclaration } from '../../../../stress/src/slice';
import { TIERS } from '../../../../stress/src/tiers';

const STRESS_DIR = path.join(__dirname, '..', '..', 'scripts', 'stress');
const SLICE_SH = path.join(STRESS_DIR, 'slice.sh');
const declaration = parseDeclaration(fs.readFileSync(path.join(STRESS_DIR, 'slice.json'), 'utf8'), 'slice.json');
const hasJq = spawnSync('jq', ['--version']).status === 0;

/** The environment the runner gives a verb (stress/README.md), for one tier. */
function sliceEnv(tier: 'small' | 'medium' | 'large', extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    STRESS_TIER: tier,
    STRESS_TIER_JSON: JSON.stringify(TIERS[tier]),
    STRESS_RUN_ID: 'test-run',
    STRESS_PREFIX: 'StressTest',
    STRESS_HOME: path.join(os.tmpdir(), 'slice-test-home'),
    STRESS_MODE: 'slice',
    ...extra,
  };
}

describe('slice.json', () => {
  it('names the sample and its scenarios S1 to S7 on the quotas the budget draws on', () => {
    expect(declaration.name).toBe('agentic-runtime-isolation');
    expect(declaration.scenarios).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    expect(declaration.needs).toEqual([]);
  });

  it('has a k6 script for every scenario it declares, as slice.sh run maps them', () => {
    const script = fs.readFileSync(SLICE_SH, 'utf8');
    for (const scenario of declaration.scenarios) {
      const m = new RegExp(`^\\s*${scenario}\\) k6_file=(\\S+\\.js) ;;`, 'm').exec(script);
      expect(m).not.toBeNull();
      expect(fs.existsSync(path.join(STRESS_DIR, 'k6', m![1]))).toBe(true);
    }
  });

  it('is the scenario id every k6 script writes its record under', () => {
    for (const scenario of declaration.scenarios) {
      const files = fs.readdirSync(path.join(STRESS_DIR, 'k6')).filter((f) => new RegExp(`^${scenario.toLowerCase()}-.*\\.js$`).test(f));
      expect(files).toHaveLength(1);
      expect(fs.readFileSync(path.join(STRESS_DIR, 'k6', files[0]), 'utf8')).toContain(`summarize(data, '${scenario}')`);
    }
  });
});

describe('budget', () => {
  it.each(Object.keys(STRESS_TIERS) as ('small' | 'medium' | 'large')[])('draws only on declared quotas at %s, in the one cell account', (name) => {
    const draws = parseDraws('agentic-runtime-isolation', JSON.stringify({ draws: drawsOf(STRESS_TIERS[name]) }), TIERS[name].cellAccounts);
    expect(draws.length).toBeGreaterThan(0);
    for (const d of draws) {
      expect(declaration.quotas).toContain(d.quota);
      expect(d.account).toBe(CELL_ACCOUNT);
    }
    // Every declared quota has a draw: a quota nobody draws on is a declaration that lies.
    expect(new Set(draws.map((d) => d.quota))).toEqual(new Set(declaration.quotas));
  });

  it('fits the service defaults at small and medium', () => {
    for (const name of ['small', 'medium'] as const) {
      expect(overdraws(sumDraws(drawsOf(STRESS_TIERS[name])))).toEqual([]);
    }
  });

  it('asks for a raised Lambda concurrency quota at large (F-17)', () => {
    const over = overdraws(sumDraws(drawsOf(STRESS_TIERS.large)));
    expect(over.map((o) => o.quota)).toContain('lambda-concurrency');
    const lambda = drawsOf(STRESS_TIERS.large).find((d) => d.quota === 'lambda-concurrency')!;
    expect(lambda.amount).toBe(800 + 1000 + 100);
  });

  it('keeps the sessions the scenarios walk within the seeded tenants', () => {
    for (const name of ['small', 'medium', 'large'] as const) {
      const sessions = drawsOf(STRESS_TIERS[name]).find((d) => d.quota === 'agentcore-active-sessions')!;
      expect(sessions.amount).toBeLessThanOrEqual(STRESS_TIERS[name].tenantsSeeded);
    }
  });
});

describe('slice.sh', () => {
  it('prints the budget without credentials and with an empty HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-budget-'));
    try {
      const r = spawnSync('bash', [SLICE_SH, 'budget'], {
        env: { ...sliceEnv('small'), HOME: home, AWS_EC2_METADATA_DISABLED: 'true' },
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(r.status).toBe(0);
      const draws = parseDraws('agentic-runtime-isolation', r.stdout, 1);
      expect(draws).toEqual(drawsOf(STRESS_TIERS.small));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 150_000);

  it('refuses the platform mode for every verb but budget', () => {
    for (const verb of ['deploy', 'seed', 'run', 'collect', 'teardown']) {
      const r = spawnSync('bash', [SLICE_SH, verb, 'S1'], { env: sliceEnv('small', { STRESS_MODE: 'platform', AWS_REGION: 'eu-central-1' }), encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('control plane');
    }
  });

  it('refuses a prefix that could name an integration-test stack', () => {
    const r = spawnSync('bash', [SLICE_SH, 'deploy'], { env: sliceEnv('small', { STRESS_PREFIX: 'TenantIdentityX' }), encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('TenantIdentity');
  });

  it('refuses a missing runner variable and an unknown verb', () => {
    const missing = spawnSync('bash', [SLICE_SH, 'budget'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(missing.status).toBe(2);
    const unknown = spawnSync('bash', [SLICE_SH, 'restart'], { env: sliceEnv('small'), encoding: 'utf8' });
    expect(unknown.status).toBe(2);
  });
});

(hasJq ? describe : describe.skip)('attribute.jq (P-7)', () => {
  type Attribution = { byTenantReason: { tenant: string; reason: string; count: number }[]; unattributed: number };
  function attribute(seen: number, rows: object[], caps: Record<string, number> = {}): Attribution {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribute-'));
    try {
      const file = path.join(dir, 'rows.json');
      fs.writeFileSync(file, JSON.stringify(rows));
      const r = spawnSync('jq', ['-n', '-c', '--argjson', 'seen', String(seen), '--argjson', 'caps', JSON.stringify(caps), '--slurpfile', 'rows', file, '-f', path.join(STRESS_DIR, 'attribute.jq')], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('attributes every refusal a log line names a tenant for, by tenant and reason', () => {
    const out = attribute(7, [
      { tenantId: 'b', reason: 'tenant_limit', n: '5' },
      { tenantId: 'a', reason: 'tenant_limit', n: '1' },
      { tenantId: 'a', reason: 'entitlement', n: '1' },
    ]);
    expect(out.unattributed).toBe(0);
    expect(out.byTenantReason).toEqual([
      { tenant: 'a', reason: 'entitlement', count: 1 },
      { tenant: 'a', reason: 'tenant_limit', count: 1 },
      { tenant: 'b', reason: 'tenant_limit', count: 5 },
    ]);
  });

  it('leaves unattributed what the driver saw and no line with a tenant accounts for', () => {
    const out = attribute(10, [
      { tenantId: 'a', reason: 'tenant_limit', n: '6' },
      { reason: 'registry_unavailable', n: '3' },
      { tenantId: '', reason: 'unknown_backend', n: '2' },
    ]);
    expect(out.unattributed).toBe(4);
    expect(out.byTenantReason).toEqual([{ tenant: 'a', reason: 'tenant_limit', count: 6 }]);
  });

  it('never goes below zero when the logs hold more than the driver saw', () => {
    expect(attribute(2, [{ tenantId: 'a', reason: 'tenant_limit', n: '3' }]).unattributed).toBe(0);
  });

  it('names a refusal with no reason `unknown` and handles no rows at all', () => {
    expect(attribute(1, [{ tenantId: 'a', n: '1' }]).byTenantReason).toEqual([{ tenant: 'a', reason: 'unknown', count: 1 }]);
    expect(attribute(3, [])).toEqual({ byTenantReason: [], unattributed: 3 });
  });

  it("caps a tenant's 429 lines at the driver's 429 count for it, so its excess cannot hide another tenant's refusal", () => {
    // The driver saw 5 for a and 5 for b; the window caught 8 lines for a and only 2 for b.
    const rows = [
      { tenantId: 'a', reason: 'tenant_rate_limited', status: '429', n: '8' },
      { tenantId: 'b', reason: 'tenant_rate_limited', status: '429', n: '2' },
    ];
    const out = attribute(10, rows, { a: 5, b: 5 });
    expect(out.unattributed).toBe(3);
    // byTenantReason stays what was logged.
    expect(out.byTenantReason).toEqual([
      { tenant: 'a', reason: 'tenant_rate_limited', count: 8 },
      { tenant: 'b', reason: 'tenant_rate_limited', count: 2 },
    ]);
  });

  it('credits no 429 line for a tenant the driver counted no 429 for (fail closed)', () => {
    expect(attribute(3, [{ tenantId: 'a', reason: 'tenant_rate_limited', status: '429', n: '3' }]).unattributed).toBe(3);
  });

  it('credits lines with another status as logged', () => {
    const rows = [
      { tenantId: 'a', reason: 'entitlement_denied', status: '403', n: '2' },
      { tenantId: 'a', reason: 'tenant_rate_limited', status: '429', n: '4' },
    ];
    expect(attribute(6, rows, { a: 4 }).unattributed).toBe(0);
    expect(attribute(6, rows, { a: 1 }).unattributed).toBe(3);
  });
});

(hasJq ? describe : describe.skip)('noisy.jq (S3 noisy neighbour)', () => {
  function noisy(id: string, rows: object[]): { noisy429: number; others429: number; otherTenants: number; pass: boolean } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noisy-'));
    try {
      const file = path.join(dir, 'rows.json');
      fs.writeFileSync(file, JSON.stringify(rows));
      const r = spawnSync('jq', ['-n', '-c', '--arg', 'noisy', id, '--slurpfile', 'rows', file, '-f', path.join(STRESS_DIR, 'noisy.jq')], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const m1 = '2026-11-19 16:24:00.000';
  const m2 = '2026-11-19 16:25:00.000';

  it('passes when only the noisy tenant is refused', () => {
    expect(noisy('n', [{ tenantId: 'n', minute: m1, n: '149' }, { tenantId: 'n', minute: m2, n: '323' }]))
      .toEqual({ noisy429: 472, others429: 0, otherTenants: 0, pass: true });
  });

  it('fails when any other tenant got a 429 (the 2026-11-19 run)', () => {
    const out = noisy('n', [{ tenantId: 'n', minute: m1, n: '472' }, { tenantId: 's', minute: m2, n: '17' }]);
    expect(out).toEqual({ noisy429: 472, others429: 17, otherTenants: 1, pass: false });
  });

  it('counts untagged 429 lines against the others', () => {
    expect(noisy('n', [{ tenantId: 'n', minute: m1, n: '5' }, { minute: m1, n: '1' }]).pass).toBe(false);
  });

  it('fails when the noisy tenant is unknown or was never refused', () => {
    expect(noisy('', [{ tenantId: 'n', minute: m1, n: '5' }]).pass).toBe(false);
    expect(noisy('', [{ minute: m1, n: '5' }])).toEqual({ noisy429: 0, others429: 5, otherTenants: 1, pass: false });
    expect(noisy('n', []).pass).toBe(false);
  });
});

describe('window.sh (CloudWatch minutes, ADR-0052)', () => {
  const WINDOW_SH = path.join(STRESS_DIR, 'window.sh');
  function call(fn: string, ...args: number[]): number[] {
    const r = spawnSync('bash', ['-c', `source "$0"; ${fn} "$@"`, WINDOW_SH, ...args.map(String)], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    return r.stdout.trim().split(' ').map(Number);
  }
  const at = (hh: number, mm: number, ss: number) => Date.UTC(2026, 10, 19, hh, mm, ss) / 1000;

  it('runs from the start minute to one minute past the end minute (API Gateway stamps a minute late)', () => {
    // S3 of the 2026-11-19 run: 18:04:05 .. 18:06:42 holds its own 18:07 datapoints.
    expect(call('metric_window', at(18, 4, 5), at(18, 6, 42))).toEqual([at(18, 4, 0), at(18, 8, 0)]);
    expect(call('metric_window', at(18, 4, 0), at(18, 6, 0))).toEqual([at(18, 4, 0), at(18, 8, 0)]);
  });

  it('starts the next scenario 3 s past the previous metric window, on a fresh minute', () => {
    expect(call('start_at', at(18, 6, 42), at(18, 6, 50))).toEqual([at(18, 8, 3)]);
    expect(call('start_at', at(18, 6, 42), at(18, 9, 30))).toEqual([at(18, 10, 3)]);
    expect(call('start_at', at(18, 6, 42), at(18, 9, 2))).toEqual([at(18, 9, 2)]);
  });

  it('only waits for a fresh minute when there is no previous scenario', () => {
    expect(call('start_at', 0, at(18, 0, 2))).toEqual([at(18, 0, 2)]);
    expect(call('start_at', 0, at(18, 0, 20))).toEqual([at(18, 1, 3)]);
  });

  it('never lets two consecutive scenarios share a metric minute', () => {
    for (let end = at(18, 0, 0); end < at(18, 2, 0); end += 7) {
      const [, mend] = call('metric_window', at(17, 58, 0), end);
      const next = call('start_at', end, end + 1)[0];
      const [mstart] = call('metric_window', next, next + 60);
      expect(mstart).toBeGreaterThanOrEqual(mend);
    }
  });
});

(hasJq ? describe : describe.skip)('delivered.jq (S3 steady load)', () => {
  function delivered(summary: object): { sent: number; expected: number; behind: number; shortPct: number; pass: boolean } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivered-'));
    try {
      const file = path.join(dir, 'summary.json');
      fs.writeFileSync(file, JSON.stringify(summary));
      const r = spawnSync('jq', ['-c', '-f', path.join(STRESS_DIR, 'delivered.jq'), file], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const counters = (expected: number, sent: number, behind?: number) => ({
    metrics: {
      steady_expected: { values: { count: expected } },
      steady_sent: { values: { count: sent } },
      ...(behind === undefined ? {} : { 'iteration_skipped{reason:behind}': { values: { count: behind } } }),
    },
  });

  it('passes at 5 % short and fails just past it', () => {
    expect(delivered(counters(6000, 5700, 300))).toEqual({ sent: 5700, expected: 6000, behind: 300, shortPct: 5, pass: true });
    expect(delivered(counters(6000, 5699)).pass).toBe(false);
  });

  it('passes when the VUs sent more than expected (one request in the graceful stop)', () => {
    expect(delivered(counters(6000, 6012))).toEqual({ sent: 6012, expected: 6000, behind: 0, shortPct: 0, pass: true });
  });

  it('reads the summary-export layout too', () => {
    expect(delivered({ metrics: { steady_expected: { count: 100 }, steady_sent: { count: 99 } } }).pass).toBe(true);
  });

  it('fails closed on a summary without the counters', () => {
    expect(delivered({ metrics: {} })).toEqual({ sent: 0, expected: 0, behind: 0, shortPct: 100, pass: false });
    expect(delivered({ error: 'file withheld' }).pass).toBe(false);
  });
});

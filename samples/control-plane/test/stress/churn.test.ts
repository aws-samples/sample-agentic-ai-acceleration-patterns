// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CallResult, ControlPlaneApi } from './api';
import { ps5, type Timing } from './churn';
import { type Edge, edgeStateOf, liveEdge, parseEdgeInputs, probeToken, readEdgeInputs, signedPut } from './edge';
import { Recorder } from './recorder';
import type { ScenarioEnv } from './scenarios';
import { SCENARIOS } from './scenarios';
import { parseDeclaration } from '../../../../stress/src/slice';

jest.mock('./aws', () => ({ ...jest.requireActual('./aws'), sleep: () => Promise.resolve() }));

const ID = { runId: 'r', tier: 'small', mode: 'platform', slice: 'control-plane', commit: '0123456' };
const TENANTS = ['01HZX0000000000000000000A1', '01HZX0000000000000000000A2', '01HZX0000000000000000000A3'];

/**
 * A control plane, a registrar and an edge in one virtual clock. A route change reaches the
 * edge `delaySeconds` after the call that made it. `script` replaces the edge's answer when
 * a test needs one the world would not give.
 */
class World {
  now = 0;
  readonly created = new Map<string, number>();
  readonly deleted = new Map<string, number>();
  readonly route = new Map<string, { at: number; status: 'active' | 'suspended' }[]>();
  registrarStatus = 200;
  probes = 0;
  script?: (tenant: string, state: string, probes: number) => number | undefined;

  readonly edge: Edge = {
    probe: async (tenant) => {
      this.probes += 1;
      const state = this.state(tenant);
      return this.script?.(tenant, state, this.probes) ?? { unrouted: 403, suspended: 503, routed: 401 }[state]!;
    },
    setStatus: async (tenant, status) => {
      if (this.registrarStatus === 200) this.route.set(tenant, [...(this.route.get(tenant) ?? []), { at: this.now, status }]);
      return this.registrarStatus;
    },
  };

  readonly timing: Timing = {
    now: () => this.now,
    sleep: async (ms) => {
      this.now += ms;
    },
    pollMs: 2000,
    settleSeconds: 90,
    confirmations: 3,
  };

  recorder = new Recorder();
  /** Tenants that already have a deployment when the scenario starts. */
  seedDeployed: string[] = [];

  readonly delaySeconds: number;

  constructor(delaySeconds = 30) {
    this.delaySeconds = delaySeconds;
  }

  private visible<T extends { at: number }>(events: T[] | undefined): T | undefined {
    const seen = (events ?? []).filter((e) => this.now >= e.at + this.delaySeconds * 1000);
    return seen[seen.length - 1];
  }

  /** What the router does for the tenant now: 403 no entry, 503 suspended, 401 the ingress refusing the unsigned token. */
  state(tenant: string): string {
    const created = this.created.get(tenant);
    const deleted = this.deleted.get(tenant);
    if (created === undefined || this.now < created + this.delaySeconds * 1000) return 'unrouted';
    if (deleted !== undefined && this.now >= deleted + this.delaySeconds * 1000) return 'unrouted';
    return this.visible(this.route.get(tenant))?.status === 'suspended' ? 'suspended' : 'routed';
  }

  api(): ControlPlaneApi {
    const ok = (status: number, body: unknown = {}): CallResult => ({ status, body, seconds: 0.01 });
    return {
      call: async (hop: string, method: string, p: string, tenant: string, _body?: unknown, expected: readonly number[] = []) => {
        let r = ok(404);
        if (method === 'POST' && p.endsWith('/deployments')) {
          this.created.set(tenant, this.now);
          r = ok(202);
        } else if (method === 'DELETE') {
          this.deleted.set(tenant, this.now);
          r = ok(202);
        }
        this.recorder.observe(hop, r, tenant, expected.includes(r.status));
        return r;
      },
      listAll: async () => ({
        status: 200,
        items: [...this.created.keys()].filter((t) => !this.deleted.has(t)).map((t) => ({ tenantId: t, status: 'ACTIVE' })),
      }),
    } as unknown as ControlPlaneApi;
  }

  env(over: Partial<ScenarioEnv> = {}): ScenarioEnv {
    for (const t of this.seedDeployed) this.created.set(t, -1_000_000);
    return {
      api: this.api(),
      rec: this.recorder,
      applicationId: 'stress',
      platformAccount: '1',
      cellAccounts: [],
      region: 'eu-central-1',
      log: () => undefined,
      tier: { name: 'small', cellAccounts: 1, cells: 1, maxTenants: 25, tenantsSeeded: 20, onboarding: 'every-run', churnPerRun: over.manifest?.churn.length ?? 3, steadyRps: 10, usersPerActiveTenant: 2, scenarioSeconds: 60 },
      manifest: { version: 1, prefix: 'p', tier: 'small', commit: 'c', seeded: [], churn: TENANTS, extra: [] },
      buildLimit: 1,
      setBuildLimit: async () => 0,
      edge: this.edge,
      ...over,
    };
  }
}

const record = (w: World) => w.recorder.toRecord(ID, 'PS-5');

describe('PS-5 churn through the edge (spec §5.1, §7)', () => {
  it('creates, suspends, resumes and deletes each churn tenant and times each change from its call', async () => {
    const w = new World(30);
    await ps5(w.env(), w.timing);
    expect(w.recorder.findings).toEqual([]);
    const r = record(w);
    for (const hop of ['routable', 'suspended', 'resumed', 'removed']) {
      // The edge shows a change `delaySeconds` after the call; reads every 2 s, so within two polls of it.
      expect(r.latency[hop].p50).toBeGreaterThanOrEqual(30);
      expect(r.latency[hop].p50).toBeLessThanOrEqual(32);
      expect(r.latency[hop].p99).toBeGreaterThanOrEqual(r.latency[hop].p50);
    }
    // A suspended and a removed tenant are each read again after the edge has settled: P-1 holds.
    expect(r.isolation).toEqual({ assertions: TENANTS.length * 2 * 3, mismatches: 0 });
    // 403 before a route, 401 from the ingress once routed, 503 while suspended: all expected, none a refusal.
    const seen = (status: number): number => Object.entries(r.requests).filter(([k]) => k.startsWith(`${status}:`) && k.endsWith(':expected')).reduce((n, [, v]) => n + v, 0);
    expect(seen(403)).toBeGreaterThan(0);
    expect(seen(401)).toBeGreaterThan(0);
    expect(seen(503)).toBeGreaterThan(0);
    expect(r.refusals).toEqual({ byTenantReason: [], unattributed: 0 });
    expect(w.created.size).toBe(TENANTS.length);
    expect(w.deleted.size).toBe(TENANTS.length);
  });

  it('runs no more cycles at once than the build limit allows', async () => {
    const w = new World(4);
    await ps5(w.env({ buildLimit: 2 }), w.timing);
    expect(w.recorder.findings).toEqual([]);
    expect(record(w).quotas.platform['codebuild-linux-small']).toBe(2);
  });

  it('fails a removed tenant that the edge serves again once it has settled', async () => {
    const w = new World(10);
    // The first read after the delete shows 403; every later one is a stale point of presence still routing it.
    let afterDelete = 0;
    w.script = (tenant, state) => {
      if (state !== 'unrouted' || !w.deleted.has(tenant)) return undefined;
      afterDelete += 1;
      return afterDelete === 1 ? 403 : 401;
    };
    await ps5(w.env({ manifest: { version: 1, prefix: 'p', tier: 'small', commit: 'c', seeded: [], churn: [TENANTS[0]], extra: [] } }), w.timing);
    const r = record(w);
    expect(r.isolation.mismatches).toBe(3);
    expect(w.recorder.findings.filter((f) => /a removed tenant was answered as routed/.test(f))).toHaveLength(3);
  });

  it('fails a suspended tenant that is still served after the settle time', async () => {
    const w = new World(10);
    let n = 0;
    w.script = (_tenant, state) => {
      if (state !== 'suspended') return undefined;
      n += 1;
      return n === 1 ? 503 : 401;
    };
    await ps5(w.env({ manifest: { version: 1, prefix: 'p', tier: 'small', commit: 'c', seeded: [], churn: [TENANTS[0]], extra: [] } }), w.timing);
    expect(record(w).isolation.mismatches).toBe(3);
    expect(w.recorder.findings[0]).toMatch(/a suspended tenant was answered as routed/);
  });

  it('reports a change the edge never shows within its timeout, and stops that tenant', async () => {
    const w = new World(30);
    w.script = (_t, state) => (state === 'routed' ? 403 : undefined);
    await ps5(w.env({ manifest: { version: 1, prefix: 'p', tier: 'small', commit: 'c', seeded: [], churn: [TENANTS[0]], extra: [] } }), w.timing);
    expect(w.recorder.findings).toEqual([`tenant ${TENANTS[0]}: the edge did not show routed within 900 s (last answer: unrouted)`]);
    expect(record(w).latency.routable).toBeUndefined();
    expect(w.deleted.size).toBe(0);
  });

  it('stops with the cause when the edge answers 404: no agent ingress behind it', async () => {
    const w = new World(1);
    w.script = () => 404;
    await ps5(w.env({ manifest: { version: 1, prefix: 'p', tier: 'small', commit: 'c', seeded: [], churn: [TENANTS[0]], extra: [] } }), w.timing);
    expect(w.recorder.findings.join('\n')).toMatch(/the edge answered 404 for \/agents\/<backend>\/invocations: the front door has no agent ingress/);
  });

  it('reports a registrar that refuses the status change, and goes no further with that tenant', async () => {
    const w = new World(1);
    w.registrarStatus = 403;
    await ps5(w.env({ manifest: { version: 1, prefix: 'p', tier: 'small', commit: 'c', seeded: [], churn: [TENANTS[0]], extra: [] } }), w.timing);
    expect(w.recorder.findings).toEqual([`tenant ${TENANTS[0]}: UpdateTenantRouteStatus suspended: HTTP 403, expected 200`]);
    expect(w.deleted.size).toBe(0);
    expect(record(w).refusals.byTenantReason).toEqual([{ tenant: TENANTS[0], reason: 'forbidden', count: 1 }]);
  });

  it('skips a tenant that already has a deployment, and says so', async () => {
    const w = new World(1);
    w.seedDeployed = [TENANTS[1]];
    await ps5(w.env(), w.timing);
    expect(w.recorder.findings).toEqual([`tenant ${TENANTS[1]} already has a deployment: PS-5 times a create from nothing`]);
    expect([...w.created.keys()].filter((t) => w.deleted.has(t)).sort()).toEqual([TENANTS[0], TENANTS[2]]);
  });

  it('takes only the tier\'s churn count of the manifest\'s churn tenants', async () => {
    const w = new World(1);
    await ps5(w.env({ tier: { ...w.env().tier, churnPerRun: 1 } }), w.timing);
    expect(w.deleted.size).toBe(1);
  });

  const one = { version: 1 as const, prefix: 'p', tier: 'small', commit: 'c', seeded: [], churn: [TENANTS[0]], extra: [] };

  it('asserts again after a blip when the edge gives no answer once the tenant has settled', async () => {
    const w = new World(10);
    let firstSuspended: number | undefined;
    let blips = 1;
    w.script = (_t, state) => {
      if (state !== 'suspended') return undefined;
      firstSuspended ??= w.now;
      return w.now >= firstSuspended + 90_000 && blips-- > 0 ? 0 : undefined;
    };
    await ps5(w.env({ manifest: one }), w.timing);
    expect(w.recorder.findings).toEqual([]);
    expect(record(w).isolation).toEqual({ assertions: 6, mismatches: 0 });
  });

  it('reports no answer from the edge as a finding, never as a served tenant', async () => {
    const w = new World(10);
    let firstSuspended: number | undefined;
    w.script = (_t, state) => {
      if (state !== 'suspended') return undefined;
      firstSuspended ??= w.now;
      return w.now >= firstSuspended + 90_000 ? 0 : undefined;
    };
    await ps5(w.env({ manifest: one }), w.timing);
    expect(record(w).isolation.mismatches).toBe(0);
    expect(w.recorder.findings.filter((f) => /no answer from the edge when asserting the tenant is suspended/.test(f))).toHaveLength(3);
  });

  it('runs short and says so when the manifest holds fewer churn tenants than the tier churns', async () => {
    const w = new World(1);
    await ps5(w.env({ manifest: one, tier: { ...w.env().tier, churnPerRun: 3 } }), w.timing);
    expect(w.recorder.findings).toEqual(['churn tenants in the manifest: 1, the tier churns 3: PS-5 runs short']);
    expect(w.deleted.size).toBe(1);
  });

  it('names the cause when a cycle stops on an error', async () => {
    const w = new World(1);
    const api = { call: async () => { throw new Error('boom'); }, listAll: async () => ({ status: 200, items: [] }) } as unknown as ControlPlaneApi;
    await ps5(w.env({ manifest: one, api }), w.timing);
    expect(w.recorder.findings).toEqual([`tenant ${TENANTS[0]}: the churn cycle stopped (Error: boom)`]);
  });

  it('loads credentials before the first timed call', async () => {
    const w = new World(1);
    const order: string[] = [];
    const edge: Edge = {
      prepare: async () => {
        order.push('prepare');
      },
      probe: w.edge.probe,
      setStatus: async (t, s) => {
        order.push('setStatus');
        return w.edge.setStatus(t, s);
      },
    };
    await ps5(w.env({ manifest: one, edge }), w.timing);
    expect(order[0]).toBe('prepare');
    expect(order.filter((o) => o === 'prepare')).toHaveLength(1);
    expect(order.filter((o) => o === 'setStatus')).toHaveLength(2);
  });

  it('says what a registrar answer of 0 can mean', async () => {
    const w = new World(1);
    w.edge.setStatus = async () => 0;
    await ps5(w.env({ manifest: one }), w.timing);
    expect(w.recorder.findings.some((f) => /HTTP 0, expected 200 \(no answer, or no credentials for the registrar/.test(f))).toBe(true);
  });

  it('fails when there is no edge, naming the cause', async () => {
    const w = new World(1);
    await ps5(w.env({ edge: undefined }), w.timing);
    expect(w.recorder.findings).toEqual(['PS-5 has no edge: the tenant-front-door manifest was not read']);
    expect(w.created.size).toBe(0);
  });

  it('is registered as a scenario of the slice', () => {
    expect(SCENARIOS['PS-5']).toBeDefined();
  });
});

describe('the front door\'s manifest (stress/README.md, "Platform mode: manifests")', () => {
  const valid = { version: 1, edgeUrl: 'https://stress.example.com/', registrarUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/' };

  it('takes the edge and the registrar and defaults the agent backend', () => {
    expect(parseEdgeInputs(JSON.stringify(valid), 'f')).toEqual({ edgeUrl: 'https://stress.example.com', registrarUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod', agentBackend: 'default' });
    expect(parseEdgeInputs(JSON.stringify({ ...valid, agentBackend: 'a001' }), 'f').agentBackend).toBe('a001');
  });

  it('names the slice that writes it when it is missing', () => {
    expect(() => parseEdgeInputs(undefined, '/h/stress/tenant-front-door.json')).toThrow(/tenant-front-door slice writes; it is missing/);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
    try {
      expect(() => readEdgeInputs(home, 'stress')).toThrow(/tenant-front-door.json, which the tenant-front-door slice writes/);
      fs.mkdirSync(path.join(home, 'stress'));
      fs.writeFileSync(path.join(home, 'stress', 'tenant-front-door.json'), JSON.stringify(valid));
      expect(readEdgeInputs(home, 'stress').edgeUrl).toBe('https://stress.example.com');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['text that is not JSON', 'nope', /not JSON/],
    ['an array', '[]', /not a JSON object/],
    ['an edge URL with a path', JSON.stringify({ ...valid, edgeUrl: 'https://stress.example.com/prod' }), /edgeUrl must be an https origin/],
    ['an edge URL over http', JSON.stringify({ ...valid, edgeUrl: 'http://stress.example.com' }), /edgeUrl must be an https origin/],
    ['no edge URL', JSON.stringify({ registrarUrl: valid.registrarUrl }), /edgeUrl/],
    ['a registrar that is not an execute-api URL', JSON.stringify({ ...valid, registrarUrl: 'https://example.com/prod' }), /registrarUrl must be the registrar's execute-api URL/],
    ['no registrar', JSON.stringify({ edgeUrl: valid.edgeUrl }), /registrarUrl/],
    ['a bad backend name', JSON.stringify({ ...valid, agentBackend: 'A/b' }), /agentBackend/],
  ])('refuses %s', (_name, text, pattern) => {
    expect(() => parseEdgeInputs(text, 'f')).toThrow(pattern);
  });
});

describe('signedPut', () => {
  const creds = { accessKeyId: 'AKIATESTKEY0000', secretAccessKey: 'secret-test-value', sessionToken: 'session-test-value' };
  const fake = (script: string): { dir: string; curl: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecurl-'));
    const curl = path.join(dir, 'curl');
    fs.writeFileSync(curl, script, { mode: 0o755 });
    return { dir, curl };
  };

  it('gives curl the keys on stdin only, and returns the status curl printed', async () => {
    const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecurl-out-'));
    const { dir, curl } = fake(`#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir0}/args.txt"\ncat > "${dir0}/stdin.txt"\nprintf 200\n`);
    try {
      await expect(signedPut('https://abc.execute-api.us-east-1.amazonaws.com/prod/tenants/T/status', { status: 'suspended' }, 'us-east-1', creds, curl)).resolves.toBe(200);
      const args = fs.readFileSync(path.join(dir0, 'args.txt'), 'utf8');
      const stdin = fs.readFileSync(path.join(dir0, 'stdin.txt'), 'utf8');
      for (const secret of Object.values(creds)) {
        expect(args).not.toContain(secret);
        expect(stdin).toContain(secret);
      }
      expect(args).toContain('aws:amz:us-east-1:execute-api');
      expect(args).toContain('{"status":"suspended"}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dir0, { recursive: true, force: true });
    }
  });

  it('answers 0 when curl fails before it reads its config, without throwing', async () => {
    const { dir, curl } = fake('#!/usr/bin/env bash\nexit 2\n');
    try {
      await expect(signedPut('https://abc.execute-api.us-east-1.amazonaws.com/prod/x', {}, 'us-east-1', creds, curl)).resolves.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('liveEdge credentials', () => {
  const inputs = { edgeUrl: 'https://stress.example.com', registrarUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod', agentBackend: 'default' };
  const creds = { accessKeyId: 'AKIATESTKEY0000', secretAccessKey: 'secret-test-value' };

  function setup() {
    const clock = { t: 0 };
    const load = jest.fn(async () => ({ creds, expiresAt: clock.t + 10 * 60_000 }));
    const put = jest.fn(async () => 200);
    const edge = liveEdge(inputs, 'us-east-1', { load, put, now: () => clock.t });
    return { clock, load, put, edge };
  }

  it('loads once, reuses the credentials until a minute before they expire, then loads again', async () => {
    const { clock, load, put, edge } = setup();
    await edge.prepare?.();
    await edge.setStatus('T1', 'suspended');
    clock.t += 8 * 60_000;
    await edge.setStatus('T1', 'active');
    expect(load).toHaveBeenCalledTimes(1);
    clock.t += 90_000;
    await edge.setStatus('T2', 'suspended');
    expect(load).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(3);
    expect(put).toHaveBeenCalledWith('https://abc123.execute-api.us-east-1.amazonaws.com/prod/tenants/T1/status', { status: 'suspended' }, 'us-east-1', creds);
  });

  it('answers 0, without a call to the registrar, when there are no credentials', async () => {
    const put = jest.fn(async () => 200);
    const edge = liveEdge(inputs, 'us-east-1', { load: async () => undefined, put, now: Date.now });
    await expect(edge.setStatus('T1', 'suspended')).resolves.toBe(0);
    expect(put).not.toHaveBeenCalled();
  });
});

describe('what the edge says about a tenant', () => {
  it('reads the status: 403 no route, 503 suspended, no answer or 404 nothing, the rest an origin\'s', () => {
    expect([403, 503, 0, 404, 401, 200, 502].map(edgeStateOf)).toEqual(['unrouted', 'suspended', 'error', 'error', 'routed', 'routed', 'routed']);
  });

  it('builds an unsigned token whose payload names the tenant', () => {
    const [header, payload, signature] = probeToken('01HZX0000000000000000000A1').split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'none', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ tenant_id: '01HZX0000000000000000000A1' });
    expect(signature).toBe('');
  });
});

describe('slice.json', () => {
  const declaration = parseDeclaration(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'stress', 'slice.json'), 'utf8'), 'slice.json');

  it('needs tenant-identity, and PS-5 runs in platform mode only', () => {
    expect(declaration.needs).toEqual(['tenant-identity']);
    expect(declaration.scenarios).toEqual(['PS-1', 'PS-5', 'placement-race', 'read-rate', 'build-limit-scaling']);
    expect(declaration.platformOnly).toEqual(['PS-5']);
  });

  it('declares only scenarios the driver has', () => {
    for (const s of declaration.scenarios) expect(SCENARIOS[s]).toBeDefined();
  });
});

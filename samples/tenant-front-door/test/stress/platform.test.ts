// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { classify, EXPECT, meets } from './classify';
import {
  agentIngressOf,
  agentsOpen,
  ingressBaseUrl,
  needWarmUp,
  parseControlPlane,
  parseFrontDoor,
  parseIdentity,
  platformTenants,
  ps7Outputs,
} from './platform';
import { Recorder } from './recorder';
import { ingressCall } from './scenarios';
import { ingressTenantOf, Sink } from './sink';

const ROLE = 'arn:aws:iam::222222222222:role/CellAccountBase-IngressReader';
const WARM_UP = {
  tenantId: 'T1',
  cellId: 'CELL1',
  accountId: '222222222222',
  cellApiDomain: 'abc123.lambda-url.eu-west-2.on.aws',
  ingressReaderRoleArn: ROLE,
  ingressParameter: '/application-plane/shared/agent-runtime/StressCell-CELL1/ingress',
};
const CONTROL_PLANE = {
  seeded: ['T1', 'T2', 'T3', 'T4'],
  churn: ['T9'],
  identity: [
    { tenantId: 'T1', admin: { username: 'a1', email: 'a1@example.com' }, users: [] },
    { tenantId: 'T3', admin: { username: 'a3', email: 'a3@example.com' }, users: [] },
    { tenantId: 'T4', admin: { username: 'a4', email: 'a4@example.com' }, users: [] },
  ],
  warmUp: WARM_UP,
};
const FRONT_DOOR = { edgeUrl: 'https://tfd.example.com', registrarUrl: 'https://abc.execute-api.eu-west-2.amazonaws.com/prod/', appDomain: 'tfd.example.com', phase: 1 };

describe('the manifests of the other slices', () => {
  it('reads the identity API, and names the slice that writes a bad field', () => {
    expect(parseIdentity({ apiUrl: 'https://abc.execute-api.eu-central-1.amazonaws.com/prod/' }, 'identity.json').apiUrl).toContain('execute-api');
    expect(() => parseIdentity({ apiUrl: 'http://example.com' }, '/x/identity.json')).toThrow('/x/identity.json: apiUrl is missing or malformed (the tenant-identity slice writes it)');
    expect(() => parseIdentity([], 'identity.json')).toThrow('must be an object');
  });

  it('reads the front door manifest at phase one and phase two', () => {
    const one = parseFrontDoor(FRONT_DOOR, 'fd.json');
    expect(one).toEqual({ edgeUrl: 'https://tfd.example.com', appDomain: 'tfd.example.com', agentBackend: 'default', phase: 1, agentIngressUrl: undefined });
    const two = parseFrontDoor({ ...FRONT_DOOR, phase: 2, agentBackend: 'a001', agentIngressUrl: 'https://i.execute-api.eu-west-2.amazonaws.com/prod' }, 'fd.json');
    expect(two).toMatchObject({ phase: 2, agentBackend: 'a001', agentIngressUrl: 'https://i.execute-api.eu-west-2.amazonaws.com/prod' });
    expect(() => parseFrontDoor({ ...FRONT_DOOR, phase: 2 }, 'fd.json')).toThrow('phase 2 has no agentIngressUrl');
    expect(() => parseFrontDoor({ ...FRONT_DOOR, phase: 3 }, 'fd.json')).toThrow('phase must be 1 or 2');
    expect(() => parseFrontDoor({ ...FRONT_DOOR, edgeUrl: 'tfd.example.com/x' }, 'fd.json')).toThrow('edgeUrl is missing or malformed');
    expect(() => parseFrontDoor({ ...FRONT_DOOR, agentBackend: '../x' }, 'fd.json')).toThrow('agentBackend');
  });

  it('reads the control plane manifest and its warm-up record', () => {
    const cp = parseControlPlane(CONTROL_PLANE, 'cp.json');
    expect(cp.seeded).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(cp.identity.map((i) => i.adminUsername)).toEqual(['a1', 'a3', 'a4']);
    expect(needWarmUp(cp, 'cp.json')).toMatchObject({ cellId: 'CELL1', cellApiDomain: 'abc123.lambda-url.eu-west-2.on.aws' });
  });

  it('accepts a manifest from before the warm-up and says which step writes the record', () => {
    const cp = parseControlPlane({ seeded: ['T1'] }, 'cp.json');
    expect(cp.identity).toEqual([]);
    expect(() => needWarmUp(cp, 'cp.json')).toThrow('the control-plane step warm-up writes it');
  });

  it('refuses a malformed control plane manifest', () => {
    expect(() => parseControlPlane({ seeded: 'T1' }, 'cp.json')).toThrow('seeded must be an array');
    expect(() => parseControlPlane({ seeded: [], identity: [{ tenantId: 'T1' }] }, 'cp.json')).toThrow('admin');
    expect(() => parseControlPlane({ seeded: [], warmUp: { ...WARM_UP, ingressParameter: '/other/ingress' } }, 'cp.json')).toThrow('ingressParameter is missing or malformed');
    expect(() => parseControlPlane({ seeded: [], warmUp: { ...WARM_UP, accountId: '333333333333' } }, 'cp.json')).toThrow('not in the cell account 333333333333');
  });

  it('drives the seeded tenants that have an identity entry, in order, up to the limit', () => {
    const cp = parseControlPlane(CONTROL_PLANE, 'cp.json');
    expect(platformTenants(cp, 20).map((t) => [t.tenantId, t.username, t.kind])).toEqual([['T1', 'a1', 'active'], ['T3', 'a3', 'active'], ['T4', 'a4', 'active']]);
    expect(platformTenants(cp, 2).map((t) => t.tenantId)).toEqual(['T1', 'T3']);
    expect(platformTenants(parseControlPlane({ seeded: ['T1'] }, 'cp.json'), 20)).toEqual([]);
  });
});

describe('PS-7 outputs in platform mode', () => {
  const cp = parseControlPlane(CONTROL_PLANE, 'cp.json');

  it('names the app domain, the cell origin and the ingress', () => {
    const fd = parseFrontDoor({ ...FRONT_DOOR, phase: 2, agentIngressUrl: 'https://i.execute-api.eu-west-2.amazonaws.com/prod' }, 'fd.json');
    expect(ps7Outputs(fd, needWarmUp(cp, 'cp.json'), 'fd.json')).toEqual({
      appDomain: 'tfd.example.com',
      cellFunctionUrl: 'https://abc123.lambda-url.eu-west-2.on.aws/',
      agentIngress: { url: 'https://i.execute-api.eu-west-2.amazonaws.com/prod', backend: 'default' },
    });
  });

  it('refuses a front door still at phase one', () => {
    expect(() => ps7Outputs(parseFrontDoor(FRONT_DOOR, 'fd.json'), needWarmUp(cp, 'cp.json'), '/x/fd.json')).toThrow('/x/fd.json is at phase 1 with no agentIngressUrl: run the step phase-two first');
  });
});

describe('the agentIngress input of front-door phase two', () => {
  it('reads baseUrl from the parameter value', () => {
    expect(ingressBaseUrl('{"baseUrl":"https://i.execute-api.eu-west-2.amazonaws.com/prod/","other":1}')).toBe('https://i.execute-api.eu-west-2.amazonaws.com/prod/');
    expect(() => ingressBaseUrl('not json')).toThrow('not JSON');
    expect(() => ingressBaseUrl('{}')).toThrow('no baseUrl');
    expect(() => ingressBaseUrl('[]')).toThrow('no baseUrl');
  });

  it('keeps the host and the stage, and drops the trailing slash, so a second phase two sets the same input', () => {
    expect(agentIngressOf('https://i.execute-api.eu-west-2.amazonaws.com/prod/')).toBe('https://i.execute-api.eu-west-2.amazonaws.com/prod');
    expect(agentIngressOf('https://i.execute-api.eu-west-2.amazonaws.com/prod')).toBe('https://i.execute-api.eu-west-2.amazonaws.com/prod');
    expect(agentIngressOf('https://ingress.example.com/')).toBe('https://ingress.example.com');
    expect(agentIngressOf('https://I.Example.com/prod//')).toBe('https://i.example.com/prod');
  });

  it('refuses what the front door would refuse', () => {
    expect(() => agentIngressOf('http://i.example.com/prod')).toThrow('https');
    expect(() => agentIngressOf('https://user:pw@i.example.com/prod')).toThrow('credentials');
    expect(() => agentIngressOf('https://i.example.com/prod?x=1')).toThrow('query');
    expect(() => agentIngressOf('https://i.example.com:8443/prod')).toThrow('port');
    expect(() => agentIngressOf('https://i.example.com/a b/c')).toThrow('plain path');
    expect(() => agentIngressOf('https://localhost/prod')).toThrow('DNS host');
    expect(() => agentIngressOf('nonsense')).toThrow('not a URL');
  });

  it('tells the router\'s 403 for an unknown tenant from the 404 of a closed route', () => {
    expect(agentsOpen(403, '{"status":403}')).toBe(true);
    expect(agentsOpen(404, '{"status":404}')).toBe(false);
    expect(agentsOpen(403, '<html>Forbidden</html>')).toBe(false);
    expect(agentsOpen(403, '{"message":"Forbidden"}')).toBe(false);
    expect(agentsOpen(0, '')).toBe(false);
  });
});

describe('the ingress probes', () => {
  const sse = (tenant: string): string => `event: report\ndata: {"tokenTenant":"${tenant}","sessionPrefix":"x"}\n\nevent: usage\ndata: {}\n\n`;
  const answer = (status: number, body = '') => ({ status, headers: {}, body, ttfb: 0.1, total: 0.2 });

  it('sends the k6 probe\'s request: POST <ingress>/<backend>/invocations with a conversation id and the report prompt', () => {
    const call = ingressCall({ url: 'https://i.example.com/prod', backend: 'a001' }, '01KAF5M0000000000000000T01', 'Bearer tok');
    expect(call).toMatchObject({ url: 'https://i.example.com/prod/a001/invocations', method: 'POST', auth: 'Bearer tok' });
    const body = JSON.parse(call.body as string) as { conversationId: string; prompt: string };
    expect(body.prompt).toBe('report');
    expect(body.conversationId).toMatch(/^[A-Za-z0-9]{16,64}$/);
    expect(call.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('classifies the ingress\'s answers by status', () => {
    expect(classify('ingress-own-token', answer(200, sse('T1')))).toEqual({ served: true, known: true });
    expect(classify('ingress-own-token', answer(202))).toEqual({ served: true, known: true });
    expect(classify('ingress-forged-payload', answer(401, 'Unauthorized'))).toMatchObject({ served: false, reason: 'ingress-unauthorized', known: true });
    expect(classify('ingress-forged-payload', answer(403, 'forbidden:signature'))).toMatchObject({ reason: 'ingress-forbidden' });
    expect(classify('ingress-own-token', answer(429))).toMatchObject({ reason: 'ingress-rate-limited' });
    expect(classify('ingress-forged-payload', answer(400))).toMatchObject({ reason: 'ingress-refused', known: true });
    expect(classify('ingress-own-token', answer(502)).known).toBe(false);
    expect(classify('ingress-own-token', answer(0)).known).toBe(false);
  });

  it('must refuse the forged token with 401 or 403, and serve the own token', () => {
    expect(EXPECT['ingress-forged-payload'].served).toBe(false);
    expect(meets('ingress-forged-payload', classify('ingress-forged-payload', answer(403)))).toBe(true);
    expect(meets('ingress-forged-payload', classify('ingress-forged-payload', answer(200)))).toBe(false);
    expect(meets('ingress-forged-payload', classify('ingress-forged-payload', answer(400)))).toBe(false);
    expect(meets('ingress-own-token', classify('ingress-own-token', answer(200)))).toBe(true);
    expect(meets('ingress-own-token', classify('ingress-own-token', answer(403)))).toBe(false);
  });

  it('reads the tenant the ingress names from the first data line', () => {
    expect(ingressTenantOf(sse('T1'))).toBe('T1');
    expect(ingressTenantOf('no data here')).toBeUndefined();
    expect(ingressTenantOf('data: not json\n')).toBeUndefined();
    expect(ingressTenantOf('data: {"tokenTenant":7}\n')).toBeUndefined();
  });

  it('counts an assertion for a refused forged token, and a mismatch for a served one', () => {
    const rec = new Recorder();
    const sink = new Sink(rec);
    const forged = { kind: 'ingress-forged-payload' as const, tenant: 'T2' };
    sink.take(forged, answer(403, 'forbidden'));
    sink.take(forged, answer(200, sse('T2')));
    sink.flush();
    expect(rec.counts).toMatchObject({ assertions: 2, mismatches: 1, unattributed: 0 });
    expect(rec.failures.join()).toContain('ingress-forged-payload: answered 200');
    expect(sink.lines.map((l) => l.id)).toEqual(['', '']);
  });

  it('asserts the own token\'s answer names its tenant', () => {
    const rec = new Recorder();
    const sink = new Sink(rec);
    const own = { kind: 'ingress-own-token' as const, tenant: 'T1', expectIngress: 'T1' };
    sink.take(own, answer(200, sse('T1')));
    sink.take(own, answer(200, sse('T2')));
    sink.take(own, answer(200, 'data: garbage'));
    expect(rec.counts).toMatchObject({ assertions: 3, mismatches: 2 });
  });

  it('counts a refused own token as a refusal, not an assertion, and a 5xx as unattributed', () => {
    const rec = new Recorder();
    const sink = new Sink(rec);
    const own = { kind: 'ingress-own-token' as const, tenant: 'T1', expectIngress: 'T1' };
    sink.take(own, answer(429));
    sink.take(own, answer(502));
    const record = rec.build({ runId: 'r', tier: 'small', mode: 'platform', commit: 'abc' }, 'PS-7');
    expect(record.requests).toEqual({ '429:ingress-rate-limited': 1, '502': 1 });
    expect(record.refusals.unattributed).toBe(1);
    expect(record.mode).toBe('platform');
    expect(rec.counts.assertions).toBe(0);
  });
});

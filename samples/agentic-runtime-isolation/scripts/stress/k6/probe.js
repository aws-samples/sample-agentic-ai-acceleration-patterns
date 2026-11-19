// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// This sample's part of the k6 library (design/agentic-runtime-isolation.stress-test.md §5, §6,
// §8.3): the call to the ingress (`invoke`), the probes and their isolation assertions, the
// warm-up and the one-iteration step. Tokens, tiers, pacing, counters, the correlation header
// and the result record are the shared library's (stress/k6/lib.js, stress ADR-0007); the
// scenario files import everything from here.
//
// The shared library sits at stress/k6/ in the repository. On the driver host stress/driver/k6.sh copies
// both folders to the same relative paths under /opt/stress/repo/, so this import works there
// as it does in a checkout.

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';
import crypto from 'k6/crypto';
import {
  CONFIG,
  adopt as adoptShared,
  buildOptions as buildOptionsShared,
  correlate,
  countRefusal,
  countStatus,
  ensureToken,
  env,
  iterationSkipped,
  isolationCheck,
  ledger,
  loadManifest as loadManifestShared,
  loadTier as loadTierShared,
  pacing,
  RUN_ID,
  refreshIfNeeded,
  setupTokens as setupTokensShared,
  summarize as summarizeShared,
  timed,
  tokenDeferred,
  vu,
  warmSpacingMs,
} from '../../../../../stress/k6/lib.js';

export {
  loadManifest,
  plan,
  scenarioSeconds,
  setPacing,
  tokenMode,
  vusFor,
} from '../../../../../stress/k6/lib.js';

/** The slice name in every record: the sample folder, as slice.json names it. */
export const SLICE = 'agentic-runtime-isolation';

// -- this sample's configuration and metrics ------------------------------------

const SAMPLE = {
  sessionScope: env('SESSION_SCOPE', 'tenant'),
  agentSpread: env('AGENT_SPREAD', 'false') === 'true',
};

export const positiveControlFail = new Counter('positive_control_fail');
export const positiveControlOk = new Rate('positive_control_ok');
const toolRefused = new Counter('tool_refused');
const streamInterrupted = new Counter('stream_interrupted');
const readOtherUnexpected = new Counter('read_other_unexpected');

function agentNames(value) {
  if (Array.isArray(value) && value.length > 0) {
    return value.map(String);
  }
  const n = typeof value === 'number' && value > 0 ? value : 1;
  const names = ['default'];
  for (let i = 1; i < n; i++) {
    names.push(`a${String(i).padStart(3, '0')}`);
  }
  return names;
}

/**
 * The shared tier plus this sample's fields from STRESS_TIER_JSON (test/stress/tiers.ts):
 * `agents` (names; a count is expanded), `tenantLimitRpm` and `ingressReservedConcurrency`.
 */
export function loadTier() {
  const tier = loadTierShared();
  const raw = tier.raw;
  return Object.assign(tier, {
    agents: agentNames(raw.agents),
    tenantLimitRpm: raw.tenantLimitRpm || 60,
    ingressReservedConcurrency: raw.ingressReservedConcurrency,
  });
}

/**
 * Options common to every scenario file. One `tenant_429{tenant:<id>}` threshold per manifest
 * tenant makes k6 keep each tenant's 429 count in the summary; collect.sh caps each tenant's
 * logged 429 lines at it (attribute.jq, P-7).
 * shortcut: k6 matches every submetric on every 429 sample; past a few thousand tenants, move
 * the per-tenant count to the tenant_minute ledger instead.
 */
export function buildOptions(scenarios, p, mode) {
  const thresholds = { positive_control_fail: ['count==0'] };
  for (const t of loadManifestShared().tenants) {
    thresholds[`tenant_429{tenant:${t.tenantId}}`] = ['count>=0'];
  }
  return buildOptionsShared(scenarios, p, mode, thresholds);
}

/** handleSummary: SCENARIO is the plan's id (`S1` ... `S7`). */
export function summarize(data, scenario) {
  return summarizeShared(data, { slice: SLICE, scenario });
}

// -- tokens and conversations --------------------------------------------------

function cleanId(raw) {
  return String(raw).replace(/[^A-Za-z0-9]/g, '').slice(0, 20).padStart(4, '0');
}

/**
 * setup(): the shared token stage with this sample's entry fields. conversationId is per
 * tenant (`stress<run><tenant index>`), shared by the tenant's users: with session scope
 * `tenant` that is one Runtime session per tenant, which keeps a large run under the Runtime's
 * 2,500 active sessions. CONVERSATION_RUN_ID reuses an earlier run's conversations (S2: warm
 * microVMs behind a cold ingress).
 */
export function setupTokens(manifest, tier, opts = {}) {
  const convRun = cleanId(env('CONVERSATION_RUN_ID', RUN_ID));
  positiveControlFail.add(0);
  return setupTokensShared(
    manifest,
    tier,
    Object.assign({}, opts, {
      decorate: (entry) => ({
        conversationId: `stress${convRun}${String(entry.tenantIndex).padStart(6, '0')}`,
        agent: SAMPLE.agentSpread ? tier.agents[entry.tenantIndex % tier.agents.length] : 'default',
      }),
    }),
  );
}

/** This VU's entries of a pool; each owner of a tenant gets its own conversation suffix. */
export function adopt(data, pool, slots, filter, suffix) {
  return adoptShared(data, pool, slots, filter, suffix, (e, tag) => Object.assign({}, e, { conversationId: `${e.conversationId}${tag}` }));
}

// -- the endpoint ---------------------------------------------------------------

/** lib.sh backend_url: the ENDPOINT base (either published shape) plus /<agent>/invocations. */
function agentUrl(agent) {
  let base = String(env('ENDPOINT', '')).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) {
    throw new Error('ENDPOINT must be the https invocation URL (EndpointUrl output)');
  }
  base = base.replace(/\/invocations$/, '').replace(/\/default$/, '');
  return `${base}/${agent}/invocations`;
}

function requestIdOf(res) {
  for (const k of Object.keys(res.headers || {})) {
    if (k.toLowerCase() === 'x-amzn-requestid') {
      return res.headers[k];
    }
  }
  return null;
}

function dataLines(body) {
  return String(body || '')
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6));
}

/**
 * POST <ENDPOINT>/<agent>/invocations with the entry's bearer token and
 * {conversationId, prompt}, and a fresh correlation header. Returns {status, ttfb, total,
 * report, body, requestId, correlationId}; report is the first SSE `data:` JSON (lib.sh
 * report_json) or null.
 */
export function invoke(entry, prompt, tags = {}) {
  const stream = /^stream\s+(\d+)/.exec(prompt);
  const { id, headers } = correlate({ 'Authorization': `Bearer ${entry.access}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' });
  const res = http.post(agentUrl(entry.agent || 'default'), JSON.stringify({ conversationId: entry.conversationId, prompt }), {
    headers,
    tags: Object.assign({ name: 'invocations' }, tags),
    timeout: stream ? `${Number(stream[1]) + 60}s` : '60s',
    responseType: 'text',
  });
  let report = null;
  const first = dataLines(res.body)[0];
  if (first !== undefined) {
    try {
      report = JSON.parse(first);
    } catch (_) {
      report = null;
    }
  }
  return {
    status: res.status,
    ttfb: res.timings.waiting,
    total: res.timings.duration,
    report,
    body: res.body || '',
    requestId: requestIdOf(res),
    correlationId: id,
  };
}

// -- §6 assertions -------------------------------------------------------------

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

const prefixCache = {};

/** src/shared/session.ts sessionPrefix: base32(sha256(tenant | tenant|sub))[0:26]. */
function expectedPrefix(entry) {
  const input = SAMPLE.sessionScope === 'tenant' ? entry.tenantId : `${entry.tenantId}|${entry.sub}`;
  if (prefixCache[input] === undefined) {
    prefixCache[input] = base32(new Uint8Array(crypto.sha256(input, 'binary'))).slice(0, 26);
  }
  return prefixCache[input];
}

/** src/shared/tvm.ts roleSessionName: the assumed-role session of tenant A ends `/tenant-<A>`. */
function namesTenantSession(arn, tenantId) {
  const session = `tenant-${tenantId.replace(/[^\w+=,.@-]/g, '_')}`.slice(0, 64);
  return arn.endsWith(`/${session}`);
}

/** Field names of the report that do not belong to the entry's tenant, user and unit. */
function reportMismatches(report, entry) {
  const bad = [];
  const prefix = expectedPrefix(entry);
  if (report.tokenTenant !== entry.tenantId) bad.push('tokenTenant');
  if (entry.sub && report.tokenUser !== entry.sub) bad.push('tokenUser');
  if (report.sessionPrefix !== prefix) bad.push('sessionPrefix');
  if (report.unitId !== `s-${prefix}-${entry.conversationId}`) bad.push('unitId');
  if (report.transactionToken !== true) bad.push('transactionToken');
  if (report.credentials !== true) bad.push('credentials');
  if (typeof report.callerArn === 'string' && !report.callerArn.startsWith('error:') && !namesTenantSession(report.callerArn, entry.tenantId)) {
    bad.push('callerArn');
  }
  return bad;
}

function recordPositiveControlFail(entry, r, detail) {
  positiveControlFail.add(1);
  console.error(JSON.stringify({ kind: 'positive_control_fail', requestId: r.requestId || null, correlationId: r.correlationId, tenantA: entry.tenantId, probe: 'read-own', status: r.status, detail }));
}

function promptOf(kind, entry, opts) {
  switch (kind) {
    case 'report':
      return 'report';
    case 'read-own':
      return `read ${entry.tenantId}`;
    case 'read-other':
      return `read ${entry.otherTenantId}`;
    case 'tool':
      return opts.toolPrompt || 'tool t01/tool_001 {}';
    case 'stream':
      return `stream ${opts.streamSeconds || 10}`;
    default:
      throw new Error(`unknown probe ${kind}`);
  }
}

/**
 * One probe with its §6 assertions. KIND: report | read-own | read-other | tool | stream.
 * PHASE `warm` requests are asserted too but are not timed nor in the ledger.
 * P-1 (`isolationCheck`) makes one assertion per answered probe: a 200 is one assertion, a
 * mismatch when its report or tool payload does not parse. A refusal makes no assertion and
 * counts under `refusals`: a non-200, or a tool refused inside a 200 (stress ADR-0010).
 */
export function probe(entry, kind, opts = {}) {
  const phase = opts.phase || 'main';
  const r = invoke(entry, promptOf(kind, entry, opts), { probe: kind, phase });
  countStatus(r.status, entry.tenantId);
  if (phase !== 'warm') {
    timed(r.ttfb, r.total, { probe: kind });
    ledger(entry.tenantId, r.status);
  }
  if (r.status !== 200) {
    check(r, { 'status 200': () => false });
    return r;
  }
  const issuer = env('ISSUER');
  let report = r.report;
  if (kind === 'stream') {
    report = report && report.report ? report.report : null;
    const want = 1 + Math.ceil((opts.streamSeconds || 10) / 2);
    const complete = dataLines(r.body).length >= want && /^event: usage/m.test(r.body);
    if (!complete) {
      streamInterrupted.add(1);
    }
    check(r, { 'stream complete': () => complete });
  }
  if (kind === 'tool') {
    return toolAssertions(entry, r);
  }
  if (report === null || typeof report !== 'object') {
    // A 200 the ingress answered with no report proves nothing about isolation: P-1 counts it
    // as a mismatch, so a malformed answer cannot pass as neither a mismatch nor a refusal.
    isolationCheck(entry, kind, r.status, ['noReport'], r.requestId, r.correlationId);
    check(r, { 'report parsed': () => false });
    if (kind === 'read-own') {
      positiveControlOk.add(false);
      recordPositiveControlFail(entry, r, ['noReport']);
    }
    return r;
  }
  const bad = reportMismatches(report, entry);
  if (kind === 'read-own') {
    const read = report.read;
    const ok = !!read && read.result === 'ok' && !!read.item && read.item.PK === `TENANT#${entry.tenantId}`;
    positiveControlOk.add(ok);
    if (!ok) {
      recordPositiveControlFail(entry, r, [read ? `read.${read.result}:${read.error || 'item'}` : 'noRead']);
    }
    if (read && read.item && typeof read.item.PK === 'string' && read.item.PK !== `TENANT#${entry.tenantId}`) {
      bad.push('read.item');
    }
    check(r, { 'read-own ok': () => ok });
  }
  if (kind === 'read-other') {
    const read = report.read;
    if (read && read.result === 'ok') {
      bad.push('read.ok');
    }
    const denied = !!read && read.result === 'error' && read.error === 'AccessDeniedException';
    if (!denied && !(read && read.result === 'ok')) {
      readOtherUnexpected.add(1, { error: read ? String(read.error) : 'noRead' });
    }
    check(r, { 'read-other denied': () => denied });
  }
  isolationCheck(entry, kind, r.status, bad, r.requestId, r.correlationId);
  check(r, { 'isolation holds': () => bad.length === 0 });
  if (issuer) {
    check(report, { 'transaction token issuer': (x) => x.tokenIss === issuer });
  }
  return r;
}

/** The `tool` probe: the tool's own answer names tenant A and A's tenant role session. */
function toolAssertions(entry, r) {
  const event = r.report || {};
  const result = event.result;
  if (!result || result.error !== undefined || event.error !== undefined) {
    // A refusal inside a 200: no tenant answered, so no isolation assertion, but the record
    // counts it under `refusals` as it does a 4xx (stress ADR-0010).
    const status = String(result && result.status !== undefined ? result.status : 'error');
    toolRefused.add(1, { status });
    countRefusal(entry.tenantId, `tool-${status}`);
    check(r, { 'tool admitted': () => false });
    return r;
  }
  let payload = null;
  try {
    payload = JSON.parse(result.content[0].text);
  } catch (_) {
    payload = null;
  }
  const bad = [];
  if (!payload) {
    bad.push('noPayload');
  } else {
    if (payload.tenantId !== entry.tenantId) bad.push('tool.tenantId');
    if (typeof payload.callerArn === 'string' && !payload.callerArn.startsWith('error:') && !namesTenantSession(payload.callerArn, entry.tenantId)) {
      bad.push('tool.callerArn');
    }
  }
  // An admitted tool call whose payload does not parse is a mismatch (`noPayload`), as above.
  isolationCheck(entry, 'tool', r.status, bad, r.requestId, r.correlationId);
  check(r, { 'tool admitted': () => true, 'isolation holds': () => bad.length === 0 });
  return r;
}

/** §6: report 70 %, read <A> 20 %, read <B> 10 %. */
export function pickProbe() {
  const x = Math.random();
  return x < 0.7 ? 'report' : x < 0.9 ? 'read-own' : 'read-other';
}

// -- scenario helpers ---------------------------------------------------------

/**
 * The untimed warm-up scenario: one iteration per VU that issues (mode 'vu') or refreshes
 * every owned token at the paced rates and, with CONVERSATIONS, opens each owned conversation
 * with a `report` probe at WARM_RPS overall. Returns the scenario and when the next may start.
 */
export function warmupScenario(vus, p, mode, conversations) {
  const tenantsPerVu = Math.ceil(p.tenants / Math.min(vus, p.tenants));
  const tokenSeconds = mode === 'vu' ? p.entries / CONFIG.issueRps : p.entries / CONFIG.refreshRps;
  const warmSeconds = conversations ? p.tenants / CONFIG.warmRps + tenantsPerVu * 15 : 0;
  const seconds = Math.ceil(tokenSeconds + warmSeconds + vus / CONFIG.warmRps + 30);
  return {
    scenario: { executor: 'per-vu-iterations', vus, iterations: 1, maxDuration: `${seconds}s`, gracefulStop: '5s', exec: 'warmup', tags: { phase: 'warm' } },
    startTime: `${seconds + 5}s`,
  };
}

/** The warm-up iteration (see warmupScenario). */
export function warmAll(data, pool, slots, conversations, filter) {
  const owned = adopt(data, pool, slots, filter);
  sleep(((exec.vu.idInTest - 1) % pacing()) / CONFIG.warmRps);
  for (const entry of owned) {
    if (!ensureToken(entry)) {
      continue;
    }
    const key = `${entry.conversationId}|${entry.agent}`;
    if (conversations && !vu.warmed[key]) {
      const wait = vu.lastWarmMs + warmSpacingMs() - Date.now();
      if (wait > 0) {
        sleep(wait / 1000);
      }
      vu.lastWarmMs = Date.now();
      if (probe(entry, 'report', { phase: 'warm' }).status === 200) {
        vu.warmed[key] = true;
      }
    }
  }
}

/**
 * One timed iteration: the VU's next owned entry with a usable token (round robin, so a VU
 * walks its tenants in turn), its conversation opened once if WARM (paced, untimed), then
 * the probe KIND() names. ENSURE: issue a missing token here (paced), for a pool with no
 * warm-up of its own.
 */
export function step(data, opts) {
  const owned = adopt(data, opts.pool, opts.slots, opts.filter, opts.suffix);
  if (owned.length === 0) {
    iterationSkipped.add(1, { reason: 'unowned' });
    return;
  }
  vu.cursor = vu.cursor || {};
  for (let tries = 0; tries < owned.length; tries++) {
    const i = vu.cursor[opts.pool] || 0;
    vu.cursor[opts.pool] = i + 1;
    const entry = owned[i % owned.length];
    if (opts.ensure && !entry.refresh) {
      ensureToken(entry);
    }
    if (!refreshIfNeeded(entry)) {
      tokenDeferred.add(1);
      continue;
    }
    const key = `${entry.conversationId}|${entry.agent}`;
    if (opts.warm !== false && !vu.warmed[key]) {
      if (Date.now() - vu.lastWarmMs < warmSpacingMs()) {
        continue;
      }
      vu.lastWarmMs = Date.now();
      if (probe(entry, 'report', Object.assign({}, opts, { phase: 'warm' })).status === 200) {
        vu.warmed[key] = true;
      }
      return;
    }
    vu.warmed[key] = true;
    probe(entry, opts.kind(), opts);
    return;
  }
  iterationSkipped.add(1, { reason: 'no usable entry' });
}

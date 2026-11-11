// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// Shared k6 library for the stress scenarios (design/agentic-runtime-isolation.stress-test.md
// §5, §6, §8.3): identity tokens, token refresh, the probes and their isolation assertions,
// and the counters the pass table is computed from.
//
// Credentials. The k6 aws jslib does not read the instance metadata service. run.sh resolves
// the instance role's credentials on the host (`aws configure export-credentials --format env`,
// which reads IMDSv2 for it) and exports them before k6 starts, as:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION (REGION is also read)
// They sign IssueToken calls on tenant-identity's platform API (SigV4, execute-api) only.
//
// Hygiene (scripts/CONVENTIONS.md). Access tokens, refresh tokens and passwords live in VU
// memory only. Nothing here logs, tags or summarises them: request tags carry a fixed name,
// log lines carry tenant ids, request ids, statuses and field NAMES, never a value of a
// token, a header or a caller ARN (it holds the account id). handleSummary drops setup_data.
// Never run these scripts with --http-debug: it prints request headers.
//
// k6 limits that shape the pacing (there is no cross-VU rate limiter in k6):
// - Each tenant is owned by one VU slot: tenant i belongs to slot i % slots, slots =
//   min(VUs, tenants). Only the owning VU refreshes that tenant's tokens. When VUs outnumber
//   tenants, a tenant has several owners, each with its own conversation suffix (`g<k>`), so
//   no two VUs share a Runtime session; their extra refreshes are counted in the budget below.
// - Refresh pacing: every VU waits at least VUs / REFRESH_RPS seconds between two of its own
//   refreshes, so the whole test stays at or under REFRESH_RPS (17) exchanges a second
//   whatever the VU count. A token that cannot be refreshed in time is not sent (counted as
//   token_deferred); the iteration moves to the VU's next tenant.
// - Warm-up pacing: every VU waits at least VUs / WARM_RPS seconds between two new
//   conversations, and VU k starts (k-1) / WARM_RPS seconds in, so new conversations stay at
//   or under WARM_RPS (20) a second overall.
// - IssueToken pacing: setup() is one VU, paced at ISSUE_RPS (8). When the setup data would
//   not fit in memory (it is copied into every VU), tokens are issued by their owning VU
//   during the warm-up instead, each VU spaced VUs / ISSUE_RPS seconds (see tokenMode()).
// - VU state (tokens, warmed conversations, limiter clocks) persists across the scenarios of
//   one test because k6 reuses the same VU runtime; ownership uses exec.vu.idInTest.

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { SignatureV4, Endpoint } from 'https://jslib.k6.io/aws/0.14.0/signature.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

// -- configuration ------------------------------------------------------------

function env(name, fallback) {
  const v = __ENV[name];
  return v === undefined || v === '' ? fallback : v;
}

function positive(name, fallback) {
  const v = Number(env(name, fallback));
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return v;
}

export const CONFIG = {
  issueRps: positive('ISSUE_RPS', 8),
  refreshRps: positive('REFRESH_RPS', 17),
  refreshMarginS: positive('REFRESH_MARGIN_S', 90),
  warmRps: positive('WARM_RPS', 20),
  vuPerRps: positive('VU_PER_RPS', 1),
  memoryBudgetMb: positive('MEMORY_BUDGET_MB', 2048),
  refreshScope: env('REFRESH_SCOPE', 'app/use'),
  sessionScope: env('SESSION_SCOPE', 'tenant'),
  agentSpread: env('AGENT_SPREAD', 'false') === 'true',
};

// A token with less life than this is never sent (it could expire in flight).
const MIN_USABLE_S = 10;
// Bytes one entry costs in each VU (two tokens, UTF-16 in the JS runtime), for tokenMode().
const ENTRY_BYTES = 6 * 1024;

// -- metrics (§6, §8.3) -------------------------------------------------------

export const isolationMismatch = new Counter('isolation_mismatch');
export const positiveControlFail = new Counter('positive_control_fail');
export const positiveControlOk = new Rate('positive_control_ok');
export const tenant429 = new Counter('tenant_429');
export const ttfbMs = new Trend('ttfb_ms', true);
const tokenDeferred = new Counter('token_deferred');
const iterationSkipped = new Counter('iteration_skipped');
const refreshFail = new Counter('refresh_fail');
const issueTokenFail = new Counter('issue_token_fail');
const toolRefused = new Counter('tool_refused');
const streamInterrupted = new Counter('stream_interrupted');
const readOtherUnexpected = new Counter('read_other_unexpected');

const STATUS_CODES = [0, 200, 400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 504];
const statusCounters = {};
for (const code of STATUS_CODES) {
  statusCounters[code] = new Counter(`status_${code}`);
}
statusCounters.other = new Counter('status_other');

function countStatus(status, tenantId) {
  (statusCounters[status] || statusCounters.other).add(1);
  if (status === 429) {
    tenant429.add(1, { tenant: tenantId });
  }
}

// -- tier and manifest --------------------------------------------------------

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

/** The scale tier from __ENV.TIER (JSON, test/stress/tiers.ts). Fails on a missing field. */
export function loadTier() {
  const raw = env('TIER');
  if (!raw) {
    throw new Error('TIER is not set (the scale tier as JSON)');
  }
  const t = JSON.parse(raw);
  const pick = (...keys) => {
    for (const k of keys) {
      if (t[k] !== undefined && t[k] !== null) {
        return t[k];
      }
    }
    return undefined;
  };
  const need = (...keys) => {
    const v = pick(...keys);
    if (typeof v !== 'number' || !(v > 0)) {
      throw new Error(`TIER needs a positive number in one of: ${keys.join(', ')}`);
    }
    return v;
  };
  return {
    scale: String(pick('scale', 'name') || 'small'),
    tenantsActive: need('tenantsActive', 'activeTenants'),
    usersPerActiveTenant: need('usersPerActiveTenant', 'usersPerTenant'),
    steadyRps: need('steadyRps'),
    peakRps: need('peakRps'),
    // undefined: the §5 figure of each scenario
    scenarioSeconds: pick('scenarioSeconds', 'durationSeconds', 'lengthSeconds'),
    agents: agentNames(pick('agents', 'agentNames')),
    tenantLimitRpm: pick('tenantLimitRpm') || 60,
    ingressReservedConcurrency: pick('ingressReservedConcurrency'),
  };
}

/** The scenario length: the tier's, else the §5 figure. */
export function scenarioSeconds(tier, section5Seconds) {
  const v = Number(env('SCENARIO_SECONDS', tier.scenarioSeconds));
  return Number.isFinite(v) && v > 0 ? v : section5Seconds;
}

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The seed manifest from __ENV.MANIFEST (an absolute path; init context only).
 * Accepted shape: { scale, tenants: [{ tenantId, admin | adminUsername, users: [username...],
 * active? }] }; `admin` may be { username } and users may be [{ username }].
 */
export function loadManifest() {
  const path = env('MANIFEST');
  if (!path) {
    throw new Error('MANIFEST is not set (the path of the seed manifest)');
  }
  const m = JSON.parse(open(path));
  const list = Array.isArray(m) ? m : m.tenants;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('MANIFEST lists no tenants');
  }
  const username = (u) => (u && typeof u === 'object' ? u.username : u);
  const tenants = list.map((t) => {
    const tenantId = t.tenantId || t.id;
    if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) {
      throw new Error('MANIFEST has a tenant without a valid tenantId');
    }
    const admin = username(t.admin !== undefined ? t.admin : t.adminUsername);
    const users = (t.users || t.usernames || []).map(username).filter((u) => typeof u === 'string' && u !== admin);
    return { tenantId, usernames: [admin, ...users].filter((u) => typeof u === 'string' && u.length > 0), active: t.active };
  });
  return { scale: m.scale, tenants };
}

/** COUNT tenants: those marked active first, then the rest, in manifest order. */
function selectTenants(manifest, count) {
  const flagged = manifest.tenants.some((t) => typeof t.active === 'boolean');
  const ordered = flagged
    ? manifest.tenants.filter((t) => t.active === true).concat(manifest.tenants.filter((t) => t.active !== true))
    : manifest.tenants;
  return ordered.slice(0, count);
}

/**
 * What a scenario holds tokens for: TENANTS tenants with up to USERS users each. Computed at
 * init (options need it) and again in setup() from the same inputs.
 */
export function plan(manifest, tier, opts = {}) {
  const tenants = selectTenants(manifest, opts.tenants || tier.tenantsActive);
  const users = opts.usersPerTenant || tier.usersPerActiveTenant;
  const entries = tenants.reduce((n, t) => n + Math.min(users, t.usernames.length), 0);
  if (tenants.length < 2) {
    throw new Error('the manifest needs at least two tenants (the read-other probe)');
  }
  return { tenants: tenants.length, usersPerTenant: users, entries };
}

/**
 * Where tokens are issued: 'setup' (setup() holds them all and k6 copies them into every VU)
 * or 'vu' (each VU issues its own tenants' tokens during the warm-up). TOKENS_IN overrides.
 */
export function tokenMode(p, vus) {
  const forced = env('TOKENS_IN');
  if (forced === 'setup' || forced === 'vu') {
    return forced;
  }
  return (p.entries * vus * ENTRY_BYTES) / (1024 * 1024) > CONFIG.memoryBudgetMb ? 'vu' : 'setup';
}

// -- identity: IssueToken and the RFC 8693 exchange ---------------------------

function platformApi() {
  const raw = env('PLATFORM_API');
  const m = raw && /^(https:\/\/[^/]+)(\/.*)?$/.exec(raw);
  if (!m) {
    throw new Error('PLATFORM_API must be the https base URL of the tenant-identity API');
  }
  let path = m[2] || '/';
  if (!path.endsWith('/')) {
    path += '/';
  }
  return { origin: m[1], path, url: `${m[1]}${path}` };
}

function signer() {
  const region = env('AWS_REGION', env('REGION'));
  const accessKeyId = env('AWS_ACCESS_KEY_ID');
  const secretAccessKey = env('AWS_SECRET_ACCESS_KEY');
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set (run.sh exports the instance role credentials)');
  }
  const credentials = { accessKeyId, secretAccessKey };
  const sessionToken = env('AWS_SESSION_TOKEN');
  if (sessionToken) {
    credentials.sessionToken = sessionToken;
  }
  return new SignatureV4({ service: 'execute-api', region, credentials, uriEscapePath: true, applyChecksum: false });
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `Rt-Iso-<24 hex>!`, a fresh password per IssueToken call (lib.sh issue_token). */
function randomPassword() {
  return `Rt-Iso-${hex(crypto.randomBytes(12))}!`;
}

/** The payload of a JWT, decoded and NOT verified; for `exp` and `sub` only. */
function jwtPayload(token) {
  try {
    return JSON.parse(encoding.b64decode(token.split('.')[1], 'rawurl', 's'));
  } catch (_) {
    return {};
  }
}

function setTokens(entry, access, refresh) {
  const claims = jwtPayload(access);
  entry.access = access;
  if (refresh) {
    entry.refresh = refresh;
  }
  entry.exp = typeof claims.exp === 'number' ? claims.exp : 0;
  entry.sub = typeof claims.sub === 'string' ? claims.sub : null;
}

/** IssueToken (SigV4) for one user; true on success. Retries 429 and 5xx up to three times. */
function issueToken(sig, api, entry) {
  const path = `${api.path}platform/tenants/${encodeURIComponent(entry.tenantId)}/users/${encodeURIComponent(entry.username)}/token`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = JSON.stringify({ password: randomPassword() });
    const req = sig.sign(
      { method: 'POST', endpoint: new Endpoint(api.origin), path, headers: { 'content-type': 'application/json' }, body },
      { signingDate: new Date() },
    );
    const res = http.post(req.url, body, { headers: req.headers, tags: { name: 'IssueToken' }, responseType: 'text' });
    if (res.status === 200) {
      const j = res.json();
      setTokens(entry, j.accessToken, j.refreshToken);
      return true;
    }
    if (res.status !== 429 && res.status < 500) {
      issueTokenFail.add(1, { status: String(res.status) });
      return false;
    }
    sleep(Math.min(8, 2 ** attempt));
  }
  issueTokenFail.add(1, { status: 'retries' });
  return false;
}

function runIdOf() {
  const raw = String(env('RUN_ID', Date.now().toString(36))).replace(/[^A-Za-z0-9]/g, '');
  return raw.slice(0, 20).padStart(4, '0');
}

/**
 * The setup() stage. One entry per (tenant, user): {tenantId, username, sub, access, refresh,
 * exp, otherTenantId, conversationId, agent, tenantIndex}. Issues every token at ISSUE_RPS,
 * or, with mode 'vu', returns the entries without tokens for the owning VUs to issue.
 * conversationId is per tenant (`stress<run><tenant index>`), shared by the tenant's users:
 * with session scope `tenant` that is one Runtime session per tenant, which keeps a large run
 * under the Runtime's 2,500 active sessions. CONVERSATION_RUN_ID reuses an earlier run's
 * conversations (S2: warm microVMs behind a cold ingress).
 */
export function setupTokens(manifest, tier, opts = {}) {
  const tenants = selectTenants(manifest, opts.tenants || tier.tenantsActive);
  const users = opts.usersPerTenant || tier.usersPerActiveTenant;
  const mode = opts.mode || 'setup';
  const runId = runIdOf();
  const convRun = String(env('CONVERSATION_RUN_ID', runId)).replace(/[^A-Za-z0-9]/g, '').slice(0, 20).padStart(4, '0');
  const n = tenants.length;
  const entries = [];
  tenants.forEach((t, ti) => {
    t.usernames.slice(0, users).forEach((username, ui) => {
      entries.push({
        tenantIndex: ti,
        userIndex: ui,
        tenantId: t.tenantId,
        username,
        sub: null,
        access: null,
        refresh: null,
        exp: 0,
        otherTenantId: tenants[(ti + 1 + (ui % (n - 1))) % n].tenantId,
        conversationId: `stress${convRun}${String(ti).padStart(6, '0')}`,
        agent: CONFIG.agentSpread ? tier.agents[ti % tier.agents.length] : 'default',
      });
    });
  });
  // The counters exist in the summary even when nothing goes wrong.
  isolationMismatch.add(0);
  positiveControlFail.add(0);
  if (mode === 'vu') {
    console.log(`setup: ${entries.length} entries over ${n} tenants; tokens are issued by the owning VUs`);
    return { runId, mode, entries };
  }
  const sig = signer();
  const api = platformApi();
  const started = Date.now();
  let failed = 0;
  for (const entry of entries) {
    const t0 = Date.now();
    if (!issueToken(sig, api, entry)) {
      failed++;
    }
    const wait = 1 / CONFIG.issueRps - (Date.now() - t0) / 1000;
    if (wait > 0) {
      sleep(wait);
    }
  }
  const ok = entries.length - failed;
  console.log(`setup: issued ${ok} of ${entries.length} tokens over ${n} tenants in ${Math.round((Date.now() - started) / 1000)}s`);
  if (ok === 0) {
    exec.test.abort('setup: no token was issued');
  }
  return { runId, mode, entries };
}

// -- per-VU state and pacing ---------------------------------------------------

let pacingVus = 1;
const vu = { pools: {}, warmed: {}, lastRefreshMs: -Infinity, lastWarmMs: -Infinity, lastIssueMs: -Infinity, minute: null, ledger: {} };

/** Call at init with the test's total VU count: the per-VU spacings divide by it. */
export function setPacing(totalVus) {
  pacingVus = Math.max(1, totalVus);
}

const refreshSpacingMs = () => (1000 * pacingVus) / CONFIG.refreshRps;
const warmSpacingMs = () => (1000 * pacingVus) / CONFIG.warmRps;
const issueSpacingMs = () => (1000 * pacingVus) / CONFIG.issueRps;

/**
 * This VU's entries of a pool, copied once from the setup data. POOL names the copy, FILTER
 * picks the pool's entries, SLOTS is min(VUs of the scenario, tenants). SUFFIX(vuId, group)
 * may replace the conversation suffix (S3's noisy tenant uses one conversation per VU).
 */
export function adopt(data, pool, slots, filter, suffix) {
  if (vu.pools[pool]) {
    return vu.pools[pool];
  }
  const id = exec.vu.idInTest;
  const mine = data.entries.filter((e) => !filter || filter(e));
  const tenantIdx = Array.from(new Set(mine.map((e) => e.tenantIndex)));
  const s = Math.max(1, Math.min(slots, tenantIdx.length));
  const slot = (id - 1) % s;
  const group = Math.floor((id - 1) / s);
  const owned = new Set(tenantIdx.filter((_, i) => i % s === slot));
  const tag = suffix ? suffix(id, group) : group === 0 ? '' : `g${group}`;
  vu.pools[pool] = mine
    .filter((e) => owned.has(e.tenantIndex))
    .map((e) => Object.assign({}, e, { conversationId: `${e.conversationId}${tag}` }));
  return vu.pools[pool];
}

function exchangeForm(entry) {
  return {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: env('APP_CLIENT_ID', ''),
    subject_token: entry.refresh,
    subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
    resource: `urn:tenant-identity:tenant:${entry.tenantId}`,
    scope: CONFIG.refreshScope,
  };
}

function doRefresh(entry) {
  vu.lastRefreshMs = Date.now();
  const res = http.post(`${platformApi().url}oauth2/token`, exchangeForm(entry), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    tags: { name: 'TokenExchange' },
    responseType: 'text',
  });
  if (res.status === 200) {
    const j = res.json();
    if (j && typeof j.access_token === 'string') {
      setTokens(entry, j.access_token, null);
      return true;
    }
  }
  refreshFail.add(1, { status: String(res.status) });
  return false;
}

const lifeLeft = (entry) => entry.exp - Date.now() / 1000;

/**
 * Refreshes the access token through tenant-identity's RFC 8693 exchange (POST
 * <PLATFORM_API>oauth2/token, as lib.sh `narrow` does, scope REFRESH_SCOPE) when under
 * REFRESH_MARGIN_S remain, within this VU's share of REFRESH_RPS. True when the entry holds a
 * token that is safe to send now; false defers the entry.
 */
export function refreshIfNeeded(entry) {
  if (!entry.refresh) {
    return false;
  }
  if (lifeLeft(entry) >= CONFIG.refreshMarginS) {
    return true;
  }
  if (Date.now() - vu.lastRefreshMs >= refreshSpacingMs()) {
    doRefresh(entry);
  }
  return lifeLeft(entry) > MIN_USABLE_S;
}

/** Waits for this VU's next refresh (or issue) slot and makes the entry usable. Warm-up only. */
function ensureToken(entry) {
  if (!entry.refresh) {
    const wait = vu.lastIssueMs + issueSpacingMs() - Date.now();
    if (wait > 0) {
      sleep(wait / 1000);
    }
    vu.lastIssueMs = Date.now();
    vu.signer = vu.signer || signer();
    if (!issueToken(vu.signer, platformApi(), entry)) {
      return false;
    }
  }
  if (lifeLeft(entry) >= CONFIG.refreshMarginS) {
    return true;
  }
  const wait = vu.lastRefreshMs + refreshSpacingMs() - Date.now();
  if (wait > 0) {
    sleep(wait / 1000);
  }
  return doRefresh(entry) || lifeLeft(entry) > MIN_USABLE_S;
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
 * {conversationId, prompt}. Returns {status, ttfb, total, report, body, requestId}; report is
 * the first SSE `data:` JSON (lib.sh report_json) or null.
 */
export function invoke(entry, prompt, tags = {}) {
  const stream = /^stream\s+(\d+)/.exec(prompt);
  const res = http.post(agentUrl(entry.agent || 'default'), JSON.stringify({ conversationId: entry.conversationId, prompt }), {
    headers: { 'Authorization': `Bearer ${entry.access}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
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
  return { status: res.status, ttfb: res.timings.waiting, total: res.timings.duration, report, body: res.body || '', requestId: requestIdOf(res) };
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
  const input = CONFIG.sessionScope === 'tenant' ? entry.tenantId : `${entry.tenantId}|${entry.sub}`;
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

/** One JSON line on stderr per mismatch: request id, tenants, probe, status, field names. Never a token. */
export function recordMismatch(entry, probeKind, status, detail, requestId) {
  isolationMismatch.add(1, { probe: probeKind });
  console.error(JSON.stringify({ kind: 'isolation_mismatch', requestId: requestId || null, tenantA: entry.tenantId, tenantB: entry.otherTenantId, probe: probeKind, status, detail }));
}

function recordPositiveControlFail(entry, r, detail) {
  positiveControlFail.add(1);
  console.error(JSON.stringify({ kind: 'positive_control_fail', requestId: r.requestId || null, tenantA: entry.tenantId, probe: 'read-own', status: r.status, detail }));
}

/** Per-tenant sends and 429s per epoch minute, one stdout line each, for the 429 attribution join in collect.sh. */
function ledger(tenantId, status) {
  const minute = Math.floor(Date.now() / 60000);
  if (vu.minute !== null && minute !== vu.minute) {
    flushLedger();
  }
  vu.minute = minute;
  const row = vu.ledger[tenantId] || (vu.ledger[tenantId] = { sent: 0, r429: 0 });
  row.sent++;
  if (status === 429) {
    row.r429++;
  }
  // k6 has no per-VU end hook: in the last 1 % of a scenario, flush after every request so
  // the final minute is not lost (collect.sh sums lines by tenant and minute).
  if (exec.scenario.progress >= 0.99) {
    flushLedger();
  }
}

function flushLedger() {
  for (const tenantId of Object.keys(vu.ledger)) {
    const row = vu.ledger[tenantId];
    console.log(JSON.stringify({ kind: 'tenant_minute', epochMinute: vu.minute, tenantId, sent: row.sent, r429: row.r429 }));
  }
  vu.ledger = {};
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
 * PHASE `warm` requests are asserted too but are not timed in ttfb_ms nor in the ledger.
 */
export function probe(entry, kind, opts = {}) {
  const phase = opts.phase || 'main';
  const r = invoke(entry, promptOf(kind, entry, opts), { probe: kind, phase });
  countStatus(r.status, entry.tenantId);
  if (phase !== 'warm') {
    ttfbMs.add(r.ttfb, { probe: kind });
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
  if (bad.length > 0) {
    recordMismatch(entry, kind, r.status, bad, r.requestId);
  }
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
    toolRefused.add(1, { status: String(result && result.status !== undefined ? result.status : 'error') });
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
  if (payload && bad.length > 0) {
    recordMismatch(entry, 'tool', r.status, bad, r.requestId);
  }
  check(r, { 'tool admitted': () => true, 'isolation holds': () => bad.length === 0 });
  return r;
}

/** §6: report 70 %, read <A> 20 %, read <B> 10 %. */
export function pickProbe() {
  const x = Math.random();
  return x < 0.7 ? 'report' : x < 0.9 ? 'read-own' : 'read-other';
}

// -- scenario helpers ---------------------------------------------------------

/** VUs for an arrival rate whose requests each hold a VU about HOLD seconds. */
export function vusFor(rps, holdSeconds = 1) {
  return Math.max(2, Math.ceil(rps * holdSeconds * CONFIG.vuPerRps));
}

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
  sleep(((exec.vu.idInTest - 1) % pacingVus) / CONFIG.warmRps);
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

/** options common to every scenario file. */
export function buildOptions(scenarios, p, mode) {
  const setupSeconds = mode === 'setup' ? Math.ceil(p.entries / CONFIG.issueRps) * 2 + 120 : 120;
  return {
    scenarios,
    setupTimeout: `${setupSeconds}s`,
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    thresholds: {
      isolation_mismatch: ['count==0'],
      positive_control_fail: ['count==0'],
    },
  };
}

/** handleSummary: summary.json (SUMMARY_PATH) and the text summary; setup_data (tokens) is dropped. */
export function summarize(data) {
  const clean = Object.assign({}, data);
  delete clean.setup_data;
  let json = JSON.stringify(clean);
  if (/eyJ[A-Za-z0-9_-]{10,}/.test(json)) {
    json = JSON.stringify({ error: 'summary withheld: it held a JWT-shaped string' });
  }
  return {
    stdout: textSummary(clean, { indent: ' ', enableColors: false }),
    [env('SUMMARY_PATH', 'summary.json')]: json,
  };
}

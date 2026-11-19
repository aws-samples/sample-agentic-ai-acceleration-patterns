// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// The shared k6 library of the platform stress test (docs/stress-test.spec.md §3.1, §4.3,
// §6; stress ADR-0007, ADR-0008). It holds what every slice's scenarios need and nothing
// that knows a sample: the tier and the seed manifest, identity tokens (issue, refresh,
// per-VU ownership and pacing), the correlation header, the counters, and the result record.
// A slice's own module (samples/<name>/scripts/stress/k6/) imports this one by its
// repository-relative path and adds the calls and assertions of its sample.
//
// Environment the runner gives every verb (stress/README.md): STRESS_RUN_ID, STRESS_TIER_JSON
// (stress/src/tiers.ts, as JSON), STRESS_MODE (slice | platform), STRESS_RESULTS (the folder
// the record goes to), STRESS_COMMIT. STRESS_RESULTS unset means no record is written (a
// scenario run by hand); set, the other four are required.
//
// Credentials. The k6 aws jslib does not read the instance metadata service. The slice's run
// script resolves the instance role's credentials on the host (`aws configure export-credentials
// --format env`, which reads IMDSv2 for it) and exports them before k6 starts, as:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION (REGION is also read)
// They sign IssueToken calls on tenant-identity's platform API (SigV4, execute-api) only.
//
// Hygiene. Access tokens, refresh tokens and passwords live in VU memory only. Nothing here
// logs, tags or summarises them: request tags carry a fixed name, log lines carry tenant ids,
// request ids, correlation ids, statuses and field NAMES, never a value of a token, a header or
// a caller ARN (it holds the account id). summarize drops setup_data. Never run these scripts
// with --http-debug: it prints request headers.
//
// k6 limits that shape the pacing (there is no cross-VU rate limiter in k6):
// - Each tenant is owned by one VU slot: tenant i belongs to slot i % slots, slots =
//   min(VUs, tenants). Only the owning VU refreshes that tenant's tokens. When VUs outnumber
//   tenants, a tenant has several owners (group k), and the slice's retag hook gives each its
//   own suffix, so no two VUs share a session; their extra refreshes are counted in the budget.
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
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { SignatureV4, Endpoint } from 'https://jslib.k6.io/aws/0.14.0/signature.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { buildRecord } from './record.js';

// -- configuration ------------------------------------------------------------

export function env(name, fallback) {
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
};

// A token with less life than this is never sent (it could expire in flight).
const MIN_USABLE_S = 10;
// Bytes one entry costs in each VU (two tokens, UTF-16 in the JS runtime), for tokenMode().
const ENTRY_BYTES = 6 * 1024;

// -- metrics (spec §4.3, §6) ----------------------------------------------------

/** One count per isolation assertion (P-1): every request that is checked adds one. */
export const isolationAssertions = new Counter('isolation_assertions');
export const isolationMismatch = new Counter('isolation_mismatch');
export const tenant429 = new Counter('tenant_429');
/** Every 4xx and 5xx the driver saw: the refusals P-7 wants attributed. */
const refusalsSeen = new Counter('refusals_seen');
/** Client time per timed request, milliseconds: the record's `client` hop. */
export const clientMs = new Trend('client_ms', true);
/** Client time to first byte, milliseconds: the record's `client-ttfb` hop. */
export const ttfbMs = new Trend('ttfb_ms', true);
export const tokenDeferred = new Counter('token_deferred');
export const iterationSkipped = new Counter('iteration_skipped');
const refreshFail = new Counter('refresh_fail');
const issueTokenFail = new Counter('issue_token_fail');

const STATUS_CODES = [0, 200, 400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 504];
const statusCounters = {};
for (const code of STATUS_CODES) {
  statusCounters[code] = new Counter(`status_${code}`);
}
statusCounters.other = new Counter('status_other');

/** Counts one response by status; a 4xx or 5xx is also a refusal the run must attribute. */
export function countStatus(status, tenantId) {
  (statusCounters[status] || statusCounters.other).add(1);
  if (status >= 400) {
    refusalsSeen.add(1);
  }
  if (status === 429) {
    tenant429.add(1, { tenant: tenantId });
  }
}

/** The timings of one timed request, in the `client` and `client-ttfb` hops. */
export function timed(ttfb, total, tags) {
  ttfbMs.add(ttfb, tags);
  clientMs.add(total, tags);
}

// -- the correlation header (stress ADR-0005) -------------------------------------------

export const CORRELATION_HEADER = 'x-correlation-id';

let correlationSeq = 0;

function runIdOf() {
  const raw = String(env('STRESS_RUN_ID', env('RUN_ID', Date.now().toString(36)))).replace(/[^A-Za-z0-9]/g, '');
  return raw.slice(0, 20).padStart(4, '0');
}

/** The run's id as the correlation ids and session names carry it, fixed at init. */
export const RUN_ID = runIdOf();

/**
 * A fresh id per request: the run, the VU and a counter, at most 64 characters of
 * [A-Za-z0-9-], which is all a hop accepts. The hops log it and use it for nothing else.
 */
export function correlationId() {
  correlationSeq += 1;
  return `${RUN_ID}-${exec.vu.idInTest}-${correlationSeq.toString(36)}`;
}

/** {id, headers}: `headers` plus a fresh correlation header. */
export function correlate(headers = {}) {
  const id = correlationId();
  return { id, headers: Object.assign({}, headers, { [CORRELATION_HEADER]: id }) };
}

// -- tier and manifest --------------------------------------------------------

/**
 * The tier from __ENV.STRESS_TIER_JSON (stress/src/tiers.ts, as `run.sh tier <name>` prints
 * it). `raw` is the whole object, for the fields a slice adds. Fails on a missing field.
 */
export function loadTier() {
  const json = env('STRESS_TIER_JSON');
  if (!json) {
    throw new Error('STRESS_TIER_JSON is not set (the tier as JSON, stress/run.sh tier <name>)');
  }
  const t = JSON.parse(json);
  const need = (key) => {
    if (typeof t[key] !== 'number' || !(t[key] > 0)) {
      throw new Error(`STRESS_TIER_JSON needs a positive number in ${key}`);
    }
    return t[key];
  };
  const name = String(t.name || 'small');
  return {
    name,
    scale: name,
    tenantsActive: need('tenantsActive'),
    usersPerActiveTenant: need('usersPerActiveTenant'),
    steadyRps: need('steadyRps'),
    peakRps: need('peakRps'),
    // undefined: the figure of each scenario
    scenarioSeconds: typeof t.scenarioSeconds === 'number' ? t.scenarioSeconds : undefined,
    raw: t,
  };
}

/** The scenario length: the tier's, else the scenario's own figure. */
export function scenarioSeconds(tier, scenarioFigure) {
  const v = Number(env('SCENARIO_SECONDS', tier.scenarioSeconds));
  return Number.isFinite(v) && v > 0 ? v : scenarioFigure;
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
    throw new Error('AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set (the run script exports the instance role credentials)');
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

/** `Rt-Iso-<24 hex>!`, a fresh password per IssueToken call. */
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
    // The correlation header is added after signing: it is not a signed header.
    const res = http.post(req.url, body, { headers: correlate(req.headers).headers, tags: { name: 'IssueToken' }, responseType: 'text' });
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

/**
 * The setup() stage. One entry per (tenant, user): {tenantId, username, sub, access, refresh,
 * exp, otherTenantId, tenantIndex, userIndex} plus what DECORATE(entry, tenants) returns for
 * the slice's own fields (a session id, an agent). Issues every token at ISSUE_RPS, or, with
 * mode 'vu', returns the entries without tokens for the owning VUs to issue.
 */
export function setupTokens(manifest, tier, opts = {}) {
  const tenants = selectTenants(manifest, opts.tenants || tier.tenantsActive);
  const users = opts.usersPerTenant || tier.usersPerActiveTenant;
  const mode = opts.mode || 'setup';
  const decorate = opts.decorate || (() => ({}));
  const runId = RUN_ID;
  const n = tenants.length;
  const entries = [];
  tenants.forEach((t, ti) => {
    t.usernames.slice(0, users).forEach((username, ui) => {
      const entry = {
        tenantIndex: ti,
        userIndex: ui,
        tenantId: t.tenantId,
        username,
        sub: null,
        access: null,
        refresh: null,
        exp: 0,
        otherTenantId: tenants[(ti + 1 + (ui % (n - 1))) % n].tenantId,
      };
      entries.push(Object.assign(entry, decorate(entry, tenants)));
    });
  });
  // The counters exist in the summary even when nothing goes wrong.
  isolationMismatch.add(0);
  isolationAssertions.add(0);
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
/** Per-VU state; a slice's module keeps its own fields here too (warmed, cursor, ledger). */
export const vu = { pools: {}, warmed: {}, lastRefreshMs: -Infinity, lastWarmMs: -Infinity, lastIssueMs: -Infinity, minute: null, ledger: {} };

/** Call at init with the test's total VU count: the per-VU spacings divide by it. */
export function setPacing(totalVus) {
  pacingVus = Math.max(1, totalVus);
}

/** The total VU count given to setPacing. */
export function pacing() {
  return pacingVus;
}

const refreshSpacingMs = () => (1000 * pacingVus) / CONFIG.refreshRps;
export const warmSpacingMs = () => (1000 * pacingVus) / CONFIG.warmRps;
const issueSpacingMs = () => (1000 * pacingVus) / CONFIG.issueRps;

/**
 * This VU's entries of a pool, copied once from the setup data. POOL names the copy, FILTER
 * picks the pool's entries, SLOTS is min(VUs of the scenario, tenants). SUFFIX(vuId, group)
 * may replace the group tag (`g<k>` for group k > 0, else ''). RETAG(entry, tag) returns the
 * entry as this VU's copy for a group, so a slice gives each owner its own session; without
 * it the entry only gains `ownerTag`.
 */
export function adopt(data, pool, slots, filter, suffix, retag) {
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
    .map((e) => (retag ? retag(e, tag) : Object.assign({}, e, { ownerTag: tag })));
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
    headers: correlate({ 'Content-Type': 'application/x-www-form-urlencoded' }).headers,
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
 * <PLATFORM_API>oauth2/token, scope REFRESH_SCOPE) when under REFRESH_MARGIN_S remain, within
 * this VU's share of REFRESH_RPS. True when the entry holds a token that is safe to send now;
 * false defers the entry.
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
export function ensureToken(entry) {
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

// -- isolation assertions and the per-tenant ledger ------------------------------

/**
 * One isolation assertion (P-1): BAD lists the field names that did not belong to the entry's
 * tenant. A non-empty list is a mismatch: one JSON line on stderr (request id, correlation id,
 * tenants, probe, status, field names; never a token) and the isolation_mismatch count.
 */
export function isolationCheck(entry, probeKind, status, bad, requestId, correlationId) {
  isolationAssertions.add(1, { probe: probeKind });
  if (bad.length === 0) {
    return true;
  }
  isolationMismatch.add(1, { probe: probeKind });
  console.error(
    JSON.stringify({
      kind: 'isolation_mismatch',
      requestId: requestId || null,
      correlationId: correlationId || null,
      tenantA: entry.tenantId,
      tenantB: entry.otherTenantId,
      probe: probeKind,
      status,
      detail: bad,
    }),
  );
  return false;
}

/**
 * Per-tenant sends and 429s per epoch minute, one stdout line each: what a slice's `collect`
 * may join with the hops' logs to attribute a refusal to a tenant (P-7).
 */
export function ledger(tenantId, status) {
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
  // the final minute is not lost (collect sums lines by tenant and minute).
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

// -- scenario helpers ---------------------------------------------------------

/** VUs for an arrival rate whose requests each hold a VU about HOLD seconds. */
export function vusFor(rps, holdSeconds = 1) {
  return Math.max(2, Math.ceil(rps * holdSeconds * CONFIG.vuPerRps));
}

/** Options common to every scenario file; THRESHOLDS adds to the isolation threshold. */
export function buildOptions(scenarios, p, mode, thresholds = {}) {
  const setupSeconds = mode === 'setup' ? Math.ceil(p.entries / CONFIG.issueRps) * 2 + 120 : 120;
  return {
    scenarios,
    setupTimeout: `${setupSeconds}s`,
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    thresholds: Object.assign({ isolation_mismatch: ['count==0'] }, thresholds),
  };
}

// -- the summary and the result record ------------------------------------------

/**
 * handleSummary: summary.json (SUMMARY_PATH), the text summary, and, when STRESS_RESULTS is
 * set, the result record `<STRESS_RESULTS>/<slice>.<scenario>.json` (spec §4.3). REC names
 * the slice (the sample folder) and the scenario. setup_data (tokens) is dropped, and a file
 * that holds a JWT-shaped string is withheld.
 */
export function summarize(data, rec) {
  const clean = Object.assign({}, data);
  delete clean.setup_data;
  const files = {
    stdout: textSummary(clean, { indent: ' ', enableColors: false }),
    [env('SUMMARY_PATH', 'summary.json')]: withhold(JSON.stringify(clean)),
  };
  const dir = env('STRESS_RESULTS');
  if (dir !== undefined) {
    const need = (name) => {
      const v = env(name);
      if (v === undefined) {
        throw new Error(`STRESS_RESULTS is set, so ${name} must be too`);
      }
      return v;
    };
    const end = new Date();
    const ms = data.state && typeof data.state.testRunDurationMs === 'number' ? data.state.testRunDurationMs : 0;
    const record = buildRecord(data, {
      runId: need('STRESS_RUN_ID'),
      tier: String(JSON.parse(need('STRESS_TIER_JSON')).name || 'small'),
      slice: rec.slice,
      scenario: rec.scenario,
      mode: need('STRESS_MODE'),
      commits: { [rec.slice]: need('STRESS_COMMIT') },
      start: new Date(end.getTime() - ms),
      end,
    });
    files[`${dir}/${rec.slice}.${rec.scenario}.json`] = withhold(`${JSON.stringify(record, null, 2)}\n`);
  }
  return files;
}

function withhold(json) {
  return /eyJ[A-Za-z0-9_-]{10,}/.test(json) ? JSON.stringify({ error: 'file withheld: it held a JWT-shaped string' }) : json;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Tenant router, viewer request, cloudfront-js-2.0. Steps: spec §3.3; sign-in: §3.5.
import cf from 'cloudfront';
import crypto from 'crypto';

const APP = "__TFD_APP_DOMAIN__";
const HOST_MODE = "__TFD_ADDRESSING__" === 'host';
const CLAIM = "__TFD_TENANT_CLAIM__";
const AGENTS = "__TFD_AGENT_INGRESS__" === 'on';
const RESERVED = "__TFD_RESERVED_LABELS__".split(',');
const LOGIN = 'login.' + APP;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WWW = { 'www-authenticate': 'Bearer' };
const kvs = cf.kvs();
// §4.1 fields the router reads: s string, i non-negative integer, upper case optional.
const SHAPES = {
  tenant: 'c:s,dt:i,s:s,n:s', host: 't:s', cell: 'o:s',
  app: 'az:s,tk:s,cid:s,sc:s,lo:s,ex:S', signin: 'cur:s',
};

const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// A route table entry, or null for a missing key or a malformed value.
async function get(kind, key) {
  let o;
  try {
    o = JSON.parse(await kvs.get(key));
  } catch (e) {
    return null; // a missing key, or any store fault: fail closed
  }
  if (!isObj(o) || o.v !== 1) return null;
  const fields = SHAPES[kind].split(',');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i].split(':'), x = o[f[0]], t = f[1].toLowerCase();
    if (x === undefined && t !== f[1]) continue;
    if (t === 's' ? typeof x !== 'string' : !(typeof x === 'number' && x >= 0 && Math.floor(x) === x)) return null;
  }
  if (kind === 'tenant' && !/^(active|suspended)$/.test(o.s)) return null;
  if (kind === 'signin') {
    if (!isObj(o.k) || !own(o.k, o.cur)) return null;
    for (const kid in o.k) {
      if (!/^[a-z0-9]{1,8}$/.test(kid) || typeof o.k[kid] !== 'string' || Buffer.from(o.k[kid], 'base64').length !== 32) return null;
    }
  }
  return o;
}

function answer(code, extra, body) {
  const headers = { 'cache-control': { value: 'no-store' } };
  for (const k in extra) headers[k] = { value: extra[k] };
  const r = { statusCode: code, headers: headers };
  if (body) {
    headers['content-type'] = { value: body[0] === '<' ? 'text/html; charset=utf-8' : 'application/json' };
    r.body = { encoding: 'text', data: body };
  }
  return r;
}
const fail = (code, extra) => answer(code, extra, '{"status":' + code + '}');
const redirect = (url, extra) => answer(302, Object.assign({ location: url }, extra));

// A pooled host: one label under appDomain that is not reserved (step 2).
function isPooled(host) {
  const label = host.slice(0, -APP.length - 1);
  return host.endsWith('.' + APP) && /^[a-z0-9-]{1,63}$/.test(label) && RESERVED.indexOf(label) < 0;
}

function b64json(s) {
  try {
    const o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return isObj(o) ? o : null;
  } catch (e) {
    return null;
  }
}

// Step 5: the token and its lower-cased claim, or null. No signature check (ADR-0005).
function decodeClaim(auth) {
  const m = /^Bearer ([^.\s]+\.([^.\s]+)\.[^.\s]+)$/i.exec(auth);
  const p = m && b64json(m[2]);
  if (!p || p.tenants !== undefined || typeof p[CLAIM] !== 'string' || !p[CLAIM]) return null;
  return { token: m[1], tenant: p[CLAIM].toLowerCase() };
}

const sign = (key, data) => crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(data).digest('base64url');

// §3.5 state: base64url(payload) "." base64url(HMAC-SHA256), current key, 10 minutes.
function mintState(signin, host, nonce) {
  const p = { v: 1, kid: signin.cur, h: host };
  if (nonce) p.n = nonce;
  p.exp = Math.floor(Date.now() / 1000) + 600;
  const enc = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
  return enc + '.' + sign(signin.k[signin.cur], enc);
}

// The payload of an authentic state, signed with any listed kid, or null.
function checkState(signin, state) {
  const parts = state.split('.');
  const p = parts.length === 2 && b64json(parts[0]);
  if (!p || p.v !== 1 || typeof p.kid !== 'string' || typeof p.h !== 'string' || typeof p.exp !== 'number' ||
    !own(signin.k, p.kid)) return null;
  const mac = sign(signin.k[p.kid], parts[0]);
  let d = mac.length ^ parts[1].length;
  for (let i = 0; i < mac.length; i++) d |= mac.charCodeAt(i) ^ parts[1].charCodeAt(i);
  return d === 0 ? p : null;
}

// One non-empty query value; null when absent or repeated.
function one(q, name) {
  const x = q[name];
  return x && !(x.multiValue && x.multiValue.length > 1) && x.value ? x.value : null;
}
const fwd = (v) => v.replace(/[^\w.~%+-]/g, encodeURIComponent);

// Step 2: the sign-in host, host mode only.
async function signinHost(req) {
  const q = req.querystring, state = one(q, 'state'), code = one(q, 'code'), error = one(q, 'error');
  if (req.uri === '/logout') return answer(200, {}, '<!doctype html><title>Signed out</title><p>You are signed out.');
  if (req.uri !== '/callback' || !state || !code === !error) return fail(400);
  const signin = await get('signin', 'signin');
  const p = signin && checkState(signin, state);
  const he = p && isPooled(p.h) && await get('host', 'host#' + p.h);
  const te = he && ID.test(he.t) && await get('tenant', 'tenant#' + he.t);
  if (!te || te.s !== 'active') return fail(400);
  if (p.exp <= Date.now() / 1000 || typeof p.n !== 'string') return redirect('https://' + p.h + '/');
  const desc = one(q, 'error_description');
  return redirect('https://' + p.h + '/callback?state=' + fwd(state) + (code ? '&code=' + fwd(code) :
    '&error=' + fwd(error) + (desc ? '&error_description=' + fwd(desc) : '')));
}

async function handler(event) {
  const req = event.request, h = req.headers, uri = req.uri;
  // Step 1.
  for (const k in h) if (k.indexOf('x-tenant-') === 0) delete h[k];
  // Step 2.
  const host = (h.host ? h.host.value : '').toLowerCase();
  if (h.host) h.host.value = host;
  if (HOST_MODE && host === LOGIN) return signinHost(req);
  const pooled = isPooled(host);
  let tenant = null;
  const looked = HOST_MODE || host !== APP;
  if (looked) {
    const he = await get('host', 'host#' + host);
    if (!he) return fail(404);
    tenant = he.t;
    cf.logCustomData(ID.test(tenant) ? tenant : '-');
  }
  const hostTenant = tenant;
  // Step 3 (ADR-0019).
  const api = uri.startsWith('/api/'), agents = uri === '/agents' || uri.startsWith('/agents/');
  if (agents && !(AGENTS && /^\/agents\/[a-z0-9-]{1,32}\/invocations$/.test(uri))) return fail(404);
  const ss = uri === '/signin-state', config = uri === '/config.json';
  let te = null;
  if (api || agents || (HOST_MODE && ss) || (looked && config)) {
    // Step 4.
    const site = h['sec-fetch-site'];
    if ((api || agents || ss) && site && site.value !== 'same-origin' && site.value !== 'none') return fail(403);
    // Step 5.
    let token = null;
    const auth = h.authorization ? h.authorization.value : '';
    const tooLong = Buffer.byteLength(auth, 'utf8') > 8192;
    if (api || agents) {
      const c = tooLong ? null : decodeClaim(auth);
      if (!HOST_MODE) cf.logCustomData(c && ID.test(c.tenant) ? c.tenant : '-');
      if (!c) return fail(401, WWW);
      if (HOST_MODE && c.tenant !== hostTenant) return fail(403);
      tenant = c.tenant;
      token = c.token;
    } else if (tooLong) return fail(401, WWW);
    // Step 6.
    te = ID.test(tenant) && await get('tenant', 'tenant#' + tenant);
    if (!te) return fail(403);
    if (te.s === 'suspended') return fail(503, { 'retry-after': '300' });
    // Step 7: the cell with origin access control (S-3), or the agent ingress.
    if (api) {
      const ce = ID.test(te.c) && await get('cell', 'cell#' + te.c);
      if (!ce) return fail(503);
      cf.updateRequestOrigin({
        domainName: ce.o,
        originAccessControlConfig: { enabled: true, signingBehavior: 'always', signingProtocol: 'sigv4', originType: 'lambda' },
      });
      h['x-tenant-token'] = { value: token };
    }
    if (api || agents) {
      h['x-tenant-route'] = { value: tenant };
      if (agents) req.uri = uri.slice(7);
      return req;
    }
  }
  // Step 8.
  if (config) {
    const app = await get('app', 'app');
    if (!app) return fail(503);
    const c = { authorizeEndpoint: app.az, tokenEndpoint: app.tk, clientId: app.cid, scopes: app.sc };
    if (app.ex !== undefined) c.exchangeEndpoint = app.ex;
    if (te) {
      c.tenantId = tenant.toUpperCase();
      c.displayName = te.n;
      c.rev = te.dt;
      if (HOST_MODE) c.redirectUri = 'https://' + LOGIN + '/callback';
      if (!pooled) c.signInHost = HOST_MODE ? tenant + '.' + APP : APP;
    }
    return answer(200, {}, JSON.stringify(c));
  }
  if (uri === '/logout') {
    if (HOST_MODE && !pooled) return fail(400);
    const app = await get('app', 'app'), signin = HOST_MODE && await get('signin', 'signin');
    if (!app || (HOST_MODE && !signin)) return fail(503);
    const back = HOST_MODE ? '&response_type=code&scope=openid&redirect_uri=' + encodeURIComponent('https://' + LOGIN + '/callback') +
      '&state=' + mintState(signin, host) : '&logout_uri=' + encodeURIComponent('https://' + APP + '/');
    return redirect(app.lo + '?client_id=' + encodeURIComponent(app.cid) + back, { 'clear-site-data': '"storage", "cache"' });
  }
  if (ss) {
    if (!HOST_MODE) return fail(404);
    const nonce = one(req.querystring, 'nonce');
    if (!pooled || !nonce || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return fail(400);
    const signin = await get('signin', 'signin');
    return signin ? answer(200, {}, JSON.stringify({ state: mintState(signin, host, nonce) })) : fail(503);
  }
  if (uri.lastIndexOf('.') < uri.lastIndexOf('/')) req.uri = '/index.html';
  return req;
}

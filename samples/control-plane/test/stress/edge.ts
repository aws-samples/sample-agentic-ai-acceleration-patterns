// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What PS-5 (churn under load, docs/stress-test.spec.md §5.1) reads from the edge, which the
 * front door's slice owns: where the edge is, where its route registrar is, and how to ask
 * the edge what it does for a tenant. The control-plane slice never deploys either; it takes
 * their addresses from the front-door slice's manifest (stress/README.md, "Platform mode:
 * manifests") and fails with a clear message when they are not there.
 *
 * Asking the edge about a tenant needs no credential. The router reads the tenant from the
 * bearer token's payload without checking its signature (front-door spec §3.3 step 5) and
 * answers from its route table before any origin sees the request: 403 for a tenant with no
 * route entry, 503 for a suspended one, and anything else once the request goes on to the
 * origin, where the ingress refuses the unsigned token (an `api-gateway` ingress answers 403
 * with the body `forbidden`, so no model call, no cost). The router's 403 and the ingress's 403
 * differ in the body: the router's is `{"status":403}`, so the probe reads the body too. The
 * token this file builds carries no signature and names a tenant id; no verifier accepts it
 * (P-1). The probe reads a front door in `single` addressing mode, where the bearer token alone
 * names the tenant, and `edgeUrl`'s host is the front door's `appDomain`: in `host` mode, or on
 * any other host, the router looks the host up first and the probe reads 404 or 403 whatever
 * the tenant's state. The token names the tenant in the claim `tenant_id`, the front door's
 * default `tenantClaim`; a router that wants another claim answers 401, which PS-5 refuses.
 * An answer CloudFront generates itself (its `x-cache` header says `Error from cloudfront`: a
 * geographic restriction, a host the distribution does not serve) tells nothing about the
 * tenant either (`adr/0048-measure-tenant-churn-through-the-front-door-edge.md`).
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CallResult } from './api';
import { aws } from './aws';

export const FRONT_DOOR_FILE = 'tenant-front-door.json';

/** What the front-door slice publishes (`tenant-front-door.json`) that PS-5 reads. */
export interface EdgeInputs {
  /** The edge's https origin, no path: `https://<domain>`. */
  readonly edgeUrl: string;
  /** The route registrar's API base URL, the stage included, for `UpdateTenantRouteStatus`. */
  readonly registrarUrl: string;
  /** The agent backend the probe names in `/agents/<backend>/invocations`; default `default`. */
  readonly agentBackend: string;
}

const EDGE_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
const REGISTRAR_URL = /^https:\/\/[a-z0-9]+\.execute-api\.([a-z0-9-]+)\.amazonaws\.com(\/[A-Za-z0-9_.-]+)*$/;
const BACKEND = /^[a-z0-9-]{1,32}$/;

/**
 * Parses the text of the front-door manifest. `file` names it in errors, with the slice that
 * writes it, so a run that has not deployed the front door stops with the fix in the message.
 */
export function parseEdgeInputs(text: string | undefined, file: string): EdgeInputs {
  if (text === undefined) {
    throw new Error(`PS-5 reads ${file}, which the tenant-front-door slice writes; it is missing (run the platform with that slice)`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} (written by the tenant-front-door slice): not JSON`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} (written by the tenant-front-door slice): not a JSON object`);
  const edge = typeof doc.edgeUrl === 'string' ? doc.edgeUrl.replace(/\/$/, '') : '';
  if (!EDGE_URL.test(edge)) throw new Error(`${file} (written by the tenant-front-door slice): edgeUrl must be an https origin with no path`);
  const registrar = typeof doc.registrarUrl === 'string' ? doc.registrarUrl.replace(/\/$/, '') : '';
  if (!REGISTRAR_URL.test(registrar)) throw new Error(`${file} (written by the tenant-front-door slice): registrarUrl must be the registrar's execute-api URL`);
  const backend = doc.agentBackend ?? 'default';
  if (typeof backend !== 'string' || !BACKEND.test(backend)) throw new Error(`${file} (written by the tenant-front-door slice): agentBackend must match ${BACKEND}`);
  return { edgeUrl: edge, registrarUrl: registrar, agentBackend: backend };
}

/** Reads the front-door manifest of this run's prefix; throws, naming the file and its writer, when it is missing or malformed. */
export function readEdgeInputs(home: string, prefix: string): EdgeInputs {
  const file = path.join(home, prefix, FRONT_DOOR_FILE);
  return parseEdgeInputs(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, file);
}

/** What the edge does for one tenant, read from one answer. */
export type EdgeState = 'unrouted' | 'suspended' | 'routed' | 'error';

/**
 * One answer of the edge: the HTTP status (0: no answer), whether the router function wrote it,
 * and whether CloudFront generated it itself (its `x-cache` header says `Error from cloudfront`,
 * as for a geographic restriction or a host the distribution does not serve).
 */
export interface EdgeAnswer {
  readonly status: number;
  readonly router: boolean;
  readonly cloudfront: boolean;
}

/** The statuses the router writes on `/agents` in `single` mode (front-door router: 401, 403, 404, 503). */
export const ROUTER_STATUSES: readonly number[] = [401, 403, 404, 503];

/** The router writes its refusals as `{"status":<code>}` (front-door router, `fail`); no origin or CloudFront error page has that body. */
export const isRouterBody = (body: string, status: number): boolean => body.trim() === `{"status":${status}}`;

/**
 * A router 403: no route entry (never created, or removed). A router 503: suspended. No answer,
 * a 404 (the router's answer for `/agents` when no agent ingress is configured, or for a host it
 * does not know), an answer CloudFront generated itself, and a 503 the router did not write
 * (CloudFront's, when the router function fails) tell nothing about the tenant: `error`. Any
 * other answer, the ingress's own 403 included, means the request left the router for an
 * origin: `routed`. A router answer with another status is refused by the caller (`churn.ts`).
 */
export function edgeStateOf(answer: EdgeAnswer): EdgeState {
  const { status, router, cloudfront } = answer;
  if (status === 0 || status === 404 || cloudfront) return 'error';
  if (router && status === 403) return 'unrouted';
  if (status === 503) return router ? 'suspended' : 'error';
  return 'routed';
}

/**
 * A bearer token whose payload names `tenantId` and whose signature is not one. The router
 * refuses a token with an empty third segment (401 at step 5, before it looks the tenant up),
 * so the segment holds a fixed word; no verifier accepts it. Never sent anywhere but the edge.
 */
export function probeToken(tenantId: string): string {
  const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ tenant_id: tenantId })}.${Buffer.from('unsigned').toString('base64url')}`;
}

/** The edge as PS-5 uses it; the unit tests give it a fake. */
export interface Edge {
  /** Loads what `setStatus` needs (credentials) before the first timed call, so no hop includes it. */
  prepare?(): Promise<void>;
  /** The edge's answer to the tenant's probe request (status 0: no answer). */
  probe(tenantId: string): Promise<EdgeAnswer>;
  /** `UpdateTenantRouteStatus`: the registrar's HTTP status (0: no answer, or no credentials). */
  setStatus(tenantId: string, status: 'active' | 'suspended'): Promise<number>;
}

const elapsed = (started: bigint): number => Number(process.hrtime.bigint() - started) / 1e9;

interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** The caller's credentials as the AWS CLI resolves them, kept in memory only. */
async function loadCredentials(): Promise<{ creds: Credentials; expiresAt: number } | undefined> {
  try {
    const out = await aws(['configure', 'export-credentials', '--format', 'process']);
    if (typeof out.AccessKeyId !== 'string' || typeof out.SecretAccessKey !== 'string') return undefined;
    const expires = typeof out.Expiration === 'string' ? Date.parse(out.Expiration) : Number.NaN;
    return {
      creds: { accessKeyId: out.AccessKeyId, secretAccessKey: out.SecretAccessKey, sessionToken: typeof out.SessionToken === 'string' ? out.SessionToken : undefined },
      expiresAt: Number.isNaN(expires) ? Date.now() + 300_000 : expires,
    };
  } catch {
    return undefined;
  }
}

/** What `liveEdge` calls for credentials and for the signed PUT; the tests replace both. */
export interface EdgeDeps {
  readonly load: () => Promise<{ creds: Credentials; expiresAt: number } | undefined>;
  readonly put: (url: string, body: object, region: string, creds: Credentials) => Promise<number>;
  readonly now: () => number;
}

/** The edge and registrar at the addresses in `inputs`. */
export function liveEdge(inputs: EdgeInputs, region: string, deps: EdgeDeps = { load: loadCredentials, put: signedPut, now: Date.now }): Edge {
  let cached: { creds: Credentials; expiresAt: number } | undefined;
  const credentials = async (): Promise<Credentials | undefined> => {
    if (cached === undefined || cached.expiresAt - deps.now() < 60_000) cached = await deps.load();
    return cached?.creds;
  };
  return {
    async prepare() {
      await credentials();
    },
    async probe(tenantId) {
      try {
        const res = await fetch(`${inputs.edgeUrl}/agents/${inputs.agentBackend}/invocations`, {
          method: 'POST',
          headers: { 'authorization': `Bearer ${probeToken(tenantId)}`, 'content-type': 'application/json' },
          body: '{}',
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        });
        const cloudfront = /^error from cloudfront/i.test(res.headers.get('x-cache') ?? '');
        // Only the statuses the router writes need the body, which is a few bytes; any other
        // body (an origin's answer can be long) is never read.
        if (!ROUTER_STATUSES.includes(res.status)) {
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status, router: false, cloudfront };
        }
        return { status: res.status, router: isRouterBody(await res.text(), res.status), cloudfront };
      } catch {
        return { status: 0, router: false, cloudfront: false };
      }
    },
    async setStatus(tenantId, status) {
      const creds = await credentials();
      if (creds === undefined) return 0;
      const regionOfUrl = REGISTRAR_URL.exec(inputs.registrarUrl)?.[1] ?? region;
      return deps.put(`${inputs.registrarUrl}/tenants/${encodeURIComponent(tenantId)}/status`, { status }, regionOfUrl, creds);
    },
  };
}

/**
 * A SigV4-signed PUT to an API Gateway URL with the caller's own credentials (the registrar
 * allows its edge operator role). curl (7.75 or later, for `--aws-sigv4`) signs; the key pair
 * goes to it on stdin, never in argv, and only the HTTP status comes back (0: curl failed).
 */
export function signedPut(url: string, body: object, region: string, creds: Credentials, curl = 'curl'): Promise<number> {
  const config = `user = "${creds.accessKeyId}:${creds.secretAccessKey}"\n${creds.sessionToken === undefined ? '' : `header = "x-amz-security-token: ${creds.sessionToken}"\n`}`;
  return new Promise((resolve) => {
    const child = execFile(
      curl,
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '30', '-X', 'PUT', '--aws-sigv4', `aws:amz:${region}:execute-api`, '--config', '-', '-H', 'content-type: application/json', '--data-raw', JSON.stringify(body), url],
      (error, stdout) => resolve(error === null && /^\d{3}$/.test(stdout.trim()) ? Number(stdout.trim()) : 0),
    );
    // curl may exit before it reads the config (a flag it does not know): the callback answers 0.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(config);
  });
}

/** A probe or registrar answer as the recorder's call result. */
export const asCall = (status: number, started: bigint): CallResult => ({ status, body: undefined, seconds: elapsed(started) });

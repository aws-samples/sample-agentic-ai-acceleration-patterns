// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ps7Outputs } from './scenarios';
import type { Env, TenantEntry } from './state';

/**
 * The slice in platform mode (docs/stress-test.spec.md §3.5, stress ADR-0016,
 * ADR-0017): reads the manifests the other slices write in
 * `$STRESS_HOME/$STRESS_PREFIX/`, builds what PS-7 needs from them, and derives
 * the `agentIngress` input of front-door phase two. Everything here is pure or
 * a plain file read; the manifests hold ids and names only, never a token, a
 * password or a key.
 */

/** The folder the runner's manifests are in, beside the slice's own state directory. */
export const manifestDir = (env: Env): string => path.dirname(env.stateDir);

type Doc = Record<string, unknown>;

/** The JSON file another slice wrote, or an error that names the file and the slice. */
export function readManifest(file: string, producer: string): unknown {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: the ${producer} slice writes it; run that slice's set-up first`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    throw new Error(`${file} is not JSON`);
  }
}

function object(v: unknown, file: string, what: string): Doc {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${file}: ${what} must be an object`);
  return v as Doc;
}

function text(o: Doc, key: string, file: string, producer: string, pattern?: RegExp): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '' || (pattern !== undefined && !pattern.test(v))) {
    throw new Error(`${file}: ${key} is missing or malformed (the ${producer} slice writes it)`);
  }
  return v;
}

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const BACKEND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const API_URL = /^https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com(\/[A-Za-z0-9._~-]+)*\/?$/;

// ---------------------------------------------------------------------------
// tenant-identity: identity.json
// ---------------------------------------------------------------------------

/** The stress identity's platform API, where `IssueToken` is called. */
export function parseIdentity(doc: unknown, file: string): { readonly apiUrl: string } {
  return { apiUrl: text(object(doc, file, 'the manifest'), 'apiUrl', file, 'tenant-identity', API_URL) };
}

// ---------------------------------------------------------------------------
// tenant-front-door: tenant-front-door.json (this slice's own, phase one then two)
// ---------------------------------------------------------------------------

export interface FrontDoorManifest {
  readonly edgeUrl: string;
  readonly appDomain: string;
  readonly agentBackend: string;
  readonly phase: 1 | 2;
  /** The ingress base URL `agentIngress` was set to: present from phase two. */
  readonly agentIngressUrl?: string;
}

export function parseFrontDoor(doc: unknown, file: string): FrontDoorManifest {
  const o = object(doc, file, 'the manifest');
  const phase = o.phase;
  if (phase !== 1 && phase !== 2) throw new Error(`${file}: phase must be 1 or 2`);
  const backend = o.agentBackend === undefined ? 'default' : text(o, 'agentBackend', file, 'tenant-front-door', BACKEND);
  const ingress = o.agentIngressUrl === undefined ? undefined : text(o, 'agentIngressUrl', file, 'tenant-front-door', /^https:\/\/\S+[^/\s]$/);
  if (phase === 2 && ingress === undefined) throw new Error(`${file}: phase 2 has no agentIngressUrl`);
  return {
    edgeUrl: text(o, 'edgeUrl', file, 'tenant-front-door', HTTPS_ORIGIN),
    appDomain: text(o, 'appDomain', file, 'tenant-front-door', HOST),
    agentBackend: backend,
    phase,
    agentIngressUrl: ingress,
  };
}

// ---------------------------------------------------------------------------
// control-plane: control-plane.json
// ---------------------------------------------------------------------------

export interface IdentityEntry {
  readonly tenantId: string;
  readonly adminUsername: string;
}

export interface WarmUp {
  readonly accountId: string;
  readonly cellId: string;
  /** The cell API's Lambda function URL host, the origin PS-7 calls directly. */
  readonly cellApiDomain: string;
  readonly ingressReaderRoleArn: string;
  /** The SSM name, in the cell account, of the cell's ingress parameter. */
  readonly ingressParameter: string;
}

export interface ControlPlaneManifest {
  /** The steady set: tenants the control plane onboarded. */
  readonly seeded: readonly string[];
  /** The identity tenants the control-plane driver created for them (stress ADR-0017). */
  readonly identity: readonly IdentityEntry[];
  readonly warmUp?: WarmUp;
}

const ROLE_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/[\w+=,.@/-]+$/;
const INGRESS_PARAMETER = /^\/application-plane\/shared\/agent-runtime\/[\w./-]+\/ingress$/;

export function parseControlPlane(doc: unknown, file: string): ControlPlaneManifest {
  const o = object(doc, file, 'the manifest');
  const seeded = o.seeded;
  if (!Array.isArray(seeded) || !seeded.every((id) => typeof id === 'string' && id !== '')) {
    throw new Error(`${file}: seeded must be an array of tenant ids (the control-plane slice writes it)`);
  }
  const identity: IdentityEntry[] = [];
  if (o.identity !== undefined) {
    if (!Array.isArray(o.identity)) throw new Error(`${file}: identity must be an array (the control-plane slice writes it)`);
    for (const e of o.identity) {
      const entry = object(e, file, 'an identity entry');
      const admin = object(entry.admin, file, 'an identity entry\'s admin');
      identity.push({ tenantId: text(entry, 'tenantId', file, 'control-plane'), adminUsername: text(admin, 'username', file, 'control-plane') });
    }
  }
  let warmUp: WarmUp | undefined;
  if (o.warmUp !== undefined) {
    const w = object(o.warmUp, file, 'warmUp');
    const accountId = text(w, 'accountId', file, 'control-plane', /^\d{12}$/);
    const role = text(w, 'ingressReaderRoleArn', file, 'control-plane', ROLE_ARN);
    // The role is in the cell account: assuming one of another account would read another account's parameter.
    if (ROLE_ARN.exec(role)?.[1] !== accountId) throw new Error(`${file}: warmUp.ingressReaderRoleArn is not in the cell account ${accountId}`);
    warmUp = {
      accountId,
      cellId: text(w, 'cellId', file, 'control-plane'),
      cellApiDomain: text(w, 'cellApiDomain', file, 'control-plane', HOST),
      ingressReaderRoleArn: role,
      ingressParameter: text(w, 'ingressParameter', file, 'control-plane', INGRESS_PARAMETER),
    };
  }
  return { seeded: seeded as string[], identity, warmUp };
}

/** The warm-up record, or the error that says which step writes it. */
export function needWarmUp(cp: ControlPlaneManifest, file: string): WarmUp {
  if (cp.warmUp === undefined) throw new Error(`${file}: warmUp is missing: the control-plane step warm-up writes it, and runs before this one`);
  return cp.warmUp;
}

/**
 * The tenants PS-7 drives: the control plane's steady set that has an identity entry (a token can be issued for it),
 * at most `limit` of them, in the control plane's order. They are all `active`: the hooks wrote their routes.
 */
export function platformTenants(cp: ControlPlaneManifest, limit: number): TenantEntry[] {
  const admins = new Map(cp.identity.map((e) => [e.tenantId, e.adminUsername]));
  return cp.seeded
    .filter((id) => admins.has(id))
    .slice(0, limit)
    .map((id) => ({ tenantId: id, username: admins.get(id) as string, kind: 'active' as const, name: id }));
}

// ---------------------------------------------------------------------------
// What PS-7 reads, and the ingress
// ---------------------------------------------------------------------------

/**
 * PS-7's view of the deployment, from the manifests: the app domain, the cell API's function URL (called directly) and the ingress.
 * Phase one has no ingress, and PS-7 runs after PS-6, so a manifest still at phase one is a run that skipped `step phase-two`.
 */
export function ps7Outputs(fd: FrontDoorManifest, warmUp: WarmUp, file: string): Ps7Outputs {
  if (fd.agentIngressUrl === undefined) throw new Error(`${file} is at phase ${fd.phase} with no agentIngressUrl: run the step phase-two first`);
  return {
    appDomain: fd.appDomain,
    cellFunctionUrl: `https://${warmUp.cellApiDomain}/`,
    agentIngress: { url: fd.agentIngressUrl, backend: fd.agentBackend },
  };
}

/** The `baseUrl` of the ingress parameter's JSON value (`<baseUrl>/<backend>/invocations` serves a backend). */
export function ingressBaseUrl(parameterValue: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(parameterValue);
  } catch {
    throw new Error('the ingress parameter is not JSON');
  }
  const base = typeof doc === 'object' && doc !== null ? (doc as Doc).baseUrl : undefined;
  if (typeof base !== 'string' || base === '') throw new Error('the ingress parameter has no baseUrl');
  return base;
}

/**
 * The `agentIngress` input of the front door from the ingress base URL (front-door spec §3.6): `https://<host>[/<stage>]`, with no
 * credentials, query, fragment or port, and a plain path. The trailing slash API Gateway's URL carries is dropped, so the same ingress
 * gives the same input and a second phase two changes nothing. It is also the base the driver calls (`<it>/<backend>/invocations`).
 */
export function agentIngressOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('the ingress baseUrl is not a URL');
  }
  if (url.protocol !== 'https:') throw new Error('the ingress baseUrl must be an https URL');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.port !== '') {
    throw new Error('the ingress baseUrl must have no credentials, query, fragment or port');
  }
  if (!HOST.test(url.hostname) || !url.hostname.includes('.')) throw new Error('the ingress baseUrl must name a DNS host');
  const p = url.pathname.replace(/\/+$/, '');
  if (p !== '' && !/^(?:\/[A-Za-z0-9._~-]+)+$/.test(p)) throw new Error('the ingress baseUrl must have a plain path, for example https://<host>/prod');
  return `https://${url.hostname}${p}`;
}

/**
 * True when the edge now routes `/agents/*`: an unsigned token for a made-up tenant gets the router's own 403
 * (no route for that tenant), where before phase two the answer is the router's 404 (`agents-closed`).
 */
export function agentsOpen(status: number, body: string): boolean {
  if (status !== 403) return false;
  try {
    return (JSON.parse(body) as Doc).status === 403;
  } catch {
    return false;
  }
}

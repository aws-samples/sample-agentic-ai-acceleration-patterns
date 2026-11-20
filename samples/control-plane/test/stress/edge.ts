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
 * origin (the ingress refuses the unsigned token with 401, so no model call, no cost). The
 * token this file builds is unsigned and names a tenant id; no verifier accepts it (P-1).
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
    throw new Error(`${file}: not JSON`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file}: not a JSON object`);
  const edge = typeof doc.edgeUrl === 'string' ? doc.edgeUrl.replace(/\/$/, '') : '';
  if (!EDGE_URL.test(edge)) throw new Error(`${file}: edgeUrl must be an https origin with no path`);
  const registrar = typeof doc.registrarUrl === 'string' ? doc.registrarUrl.replace(/\/$/, '') : '';
  if (!REGISTRAR_URL.test(registrar)) throw new Error(`${file}: registrarUrl must be the registrar's execute-api URL`);
  const backend = doc.agentBackend ?? 'default';
  if (typeof backend !== 'string' || !BACKEND.test(backend)) throw new Error(`${file}: agentBackend must match ${BACKEND}`);
  return { edgeUrl: edge, registrarUrl: registrar, agentBackend: backend };
}

/** Reads the front-door manifest of this run's prefix, or undefined when it is not there. */
export function readEdgeInputs(home: string, prefix: string): EdgeInputs {
  const file = path.join(home, prefix, FRONT_DOOR_FILE);
  return parseEdgeInputs(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, file);
}

/** What the edge does for one tenant, read from one HTTP status. */
export type EdgeState = 'unrouted' | 'suspended' | 'routed' | 'error';

/**
 * 403: no route entry (never created, or removed). 503: suspended. 0 (no answer) and 404
 * (the router's answer for `/agents` when no agent ingress is configured) tell nothing about the
 * tenant: `error`. Any other status means the request left the router for an origin.
 */
export function edgeStateOf(status: number): EdgeState {
  if (status === 403) return 'unrouted';
  if (status === 503) return 'suspended';
  if (status === 0 || status === 404) return 'error';
  return 'routed';
}

/** An unsigned bearer token whose payload names `tenantId`. Never sent anywhere but the edge. */
export function probeToken(tenantId: string): string {
  const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ tenant_id: tenantId })}.`;
}

/** The edge as PS-5 uses it; the unit tests give it a fake. */
export interface Edge {
  /** The HTTP status the edge answers for the tenant's probe request (0: no answer). */
  probe(tenantId: string): Promise<number>;
  /** `UpdateTenantRouteStatus`: the registrar's HTTP status (0: no answer). */
  setStatus(tenantId: string, status: 'active' | 'suspended'): Promise<number>;
}

const elapsed = (started: bigint): number => Number(process.hrtime.bigint() - started) / 1e9;

/** The edge and registrar at the addresses in `inputs`. */
export function liveEdge(inputs: EdgeInputs, region: string): Edge {
  return {
    async probe(tenantId) {
      try {
        const res = await fetch(`${inputs.edgeUrl}/agents/${inputs.agentBackend}/invocations`, {
          method: 'POST',
          headers: { 'authorization': `Bearer ${probeToken(tenantId)}`, 'content-type': 'application/json' },
          body: '{}',
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        });
        await res.arrayBuffer();
        return res.status;
      } catch {
        return 0;
      }
    },
    async setStatus(tenantId, status) {
      const regionOfUrl = REGISTRAR_URL.exec(inputs.registrarUrl)?.[1] ?? region;
      return signedPut(`${inputs.registrarUrl}/tenants/${encodeURIComponent(tenantId)}/status`, { status }, regionOfUrl);
    },
  };
}

/**
 * A SigV4-signed PUT to an API Gateway URL with the caller's own credentials (the registrar
 * allows its edge operator role). curl signs; the key pair goes to it on stdin, never in argv,
 * and only the HTTP status comes back.
 */
export async function signedPut(url: string, body: object, region: string): Promise<number> {
  let creds: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
  try {
    creds = await aws(['configure', 'export-credentials', '--format', 'process']);
  } catch {
    return 0;
  }
  if (creds.AccessKeyId === undefined || creds.SecretAccessKey === undefined) return 0;
  const config = `user = "${creds.AccessKeyId}:${creds.SecretAccessKey}"\n${creds.SessionToken === undefined ? '' : `header = "x-amz-security-token: ${creds.SessionToken}"\n`}`;
  return new Promise((resolve) => {
    const child = execFile(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '30', '-X', 'PUT', '--aws-sigv4', `aws:amz:${region}:execute-api`, '--config', '-', '-H', 'content-type: application/json', '--data-raw', JSON.stringify(body), url],
      (error, stdout) => resolve(error === null && /^\d{3}$/.test(stdout.trim()) ? Number(stdout.trim()) : 0),
    );
    child.stdin?.end(config);
  });
}

/** A probe or registrar answer as the recorder's call result. */
export const asCall = (status: number, started: bigint): CallResult => ({ status, body: undefined, seconds: elapsed(started) });

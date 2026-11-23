// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane slice's manifest (spec §4.2): one file under `STRESS_HOME/<prefix>/`,
 * outside the repository, with the tenant ids the seed created and the tier and commit they
 * were created for. Ids and counts only: never a token, a password or a key. Written with
 * mode 0600 through a temporary file, so a crash never leaves half a manifest.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** A user of an identity tenant: ids and e-mail addresses only, never a password or a token. */
export interface IdentityUser {
  readonly username: string;
  readonly email: string;
}

/** The identity tenant of a control-plane tenant (stress ADR-0017): the admin and the further users. */
export interface IdentityEntry {
  readonly tenantId: string;
  readonly admin: IdentityUser;
  readonly users: IdentityUser[];
}

/** What the warm-up step (spec §3.5 step 5) learned about the first cell, for the front door's phase two and PS-7. */
export interface WarmUp {
  readonly tenantId: string;
  readonly cellId: string;
  readonly accountId: string;
  /** The cell API's Lambda function URL host, from the cell script. */
  readonly cellApiDomain: string;
  /** The cell account's ingress reader role, when the cell accounts file names one. */
  readonly ingressReaderRoleArn?: string;
  /** The name, in the cell account, of the parameter whose JSON holds the ingress `baseUrl`. */
  readonly ingressParameter: string;
}

export interface Manifest {
  readonly version: 1;
  readonly prefix: string;
  readonly tier: string;
  readonly commit: string;
  /** Tenants PS-1 onboards. */
  readonly seeded: readonly string[];
  /** Tenants the scenarios place in the free slots. */
  readonly churn: readonly string[];
  /** Tenants a placement race must refuse. */
  readonly extra: readonly string[];
  /** Identity tenants this driver created (platform run, stress ADR-0017); read by the runtime-isolation slice. */
  readonly identity?: readonly IdentityEntry[];
  /** The warm-up tenant and its cell (platform run). */
  readonly warmUp?: WarmUp;
}

export const manifestPath = (home: string, prefix: string): string => path.join(home, prefix, 'control-plane.json');

export function emptyManifest(prefix: string, tier: string, commit: string): Manifest {
  return { version: 1, prefix, tier, commit, seeded: [], churn: [], extra: [] };
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function parseManifest(text: string, file: string): Manifest {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${file}: not JSON`);
  }
  if (doc.version !== 1) throw new Error(`${file}: unknown version`);
  for (const k of ['prefix', 'tier', 'commit']) {
    if (typeof doc[k] !== 'string') throw new Error(`${file}: ${k} must be a string`);
  }
  for (const k of ['seeded', 'churn', 'extra']) {
    const v = doc[k];
    if (!Array.isArray(v) || !v.every((id) => typeof id === 'string' && ULID.test(id))) throw new Error(`${file}: ${k} must list tenant ids`);
  }
  if (doc.identity !== undefined) {
    const user = (u: unknown): boolean => typeof u === 'object' && u !== null && typeof (u as IdentityUser).username === 'string' && typeof (u as IdentityUser).email === 'string';
    const ok = Array.isArray(doc.identity) && doc.identity.every((e: IdentityEntry) => typeof e?.tenantId === 'string' && ULID.test(e.tenantId) && user(e.admin) && Array.isArray(e.users) && e.users.every(user));
    if (!ok) throw new Error(`${file}: identity must list tenant ids with an admin and users`);
  }
  if (doc.warmUp !== undefined) {
    const w = doc.warmUp as Record<string, unknown>;
    const named = (k: string): boolean => typeof w?.[k] === 'string' && w[k] !== '';
    const required = ['cellId', 'accountId', 'cellApiDomain', 'ingressParameter'].every(named);
    if (!(named('tenantId') && ULID.test(String(w.tenantId)) && required && (w.ingressReaderRoleArn === undefined || named('ingressReaderRoleArn')))) {
      throw new Error(`${file}: warmUp must name the tenant, the cell, its account, the cell API domain and the ingress parameter`);
    }
  }
  return doc as unknown as Manifest;
}

export function readManifest(file: string): Manifest | undefined {
  return fs.existsSync(file) ? parseManifest(fs.readFileSync(file, 'utf8'), file) : undefined;
}

export function writeManifest(file: string, m: Manifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Every tenant the manifest names. */
export const allTenants = (m: Manifest): string[] => [...m.seeded, ...m.churn, ...m.extra];

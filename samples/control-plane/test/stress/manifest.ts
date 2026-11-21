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

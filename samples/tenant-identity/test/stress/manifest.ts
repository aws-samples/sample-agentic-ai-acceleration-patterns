// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The slice's manifest (spec §4.2): `$STRESS_HOME/$STRESS_PREFIX/tenant-identity.json`,
 * outside the repository. It lists tenant ids, user names and e-mail addresses
 * (simulator addresses), the tier and the commit. Never a token, a password
 * or a key: a user's password exists only in the memory of the run that
 * issues tokens.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ManifestUser {
  readonly username: string;
  readonly email: string;
}

export interface ManifestTenant {
  readonly tenantId: string;
  readonly name: string;
  readonly admin: ManifestUser;
  readonly users: readonly ManifestUser[];
}

export interface Manifest {
  readonly version: 1;
  readonly prefix: string;
  readonly stack: string;
  readonly tier: string;
  readonly commit: string;
  /** The steady set `seed` made; a fixture at the `fixture` tiers. */
  readonly seeded: readonly ManifestTenant[];
  /**
   * Tenant ids a scenario created and has not yet deleted, written BEFORE the
   * create call so a killed run leaves a trail `teardown` can follow.
   */
  readonly transient: readonly string[];
}

export const FILE_NAME = 'tenant-identity.json';

export function manifestPath(home: string, prefix: string): string {
  return path.join(home, prefix, FILE_NAME);
}

export function emptyManifest(prefix: string, stack: string, tier: string, commit: string): Manifest {
  return { version: 1, prefix, stack, tier, commit, seeded: [], transient: [] };
}

export function readManifest(file: string): Manifest | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
  if (doc.version !== 1 || !Array.isArray(doc.seeded) || !Array.isArray(doc.transient)) {
    throw new Error(`${file}: not a tenant-identity stress manifest`);
  }
  return doc;
}

/** Writes through a temp file and a rename, mode 0600 in a 0700 folder. */
export function writeManifest(file: string, manifest: Manifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

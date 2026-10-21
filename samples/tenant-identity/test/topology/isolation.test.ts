// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { TOPOLOGIES } from '../../src/shared/constants';

/**
 * Spec P-1: the provisioner and tenant source are the only topology-specific
 * modules. Outside `src/topology/`, only the constants (which define the
 * names) and the CDK app (which picks resources, not behaviour) may name a
 * topology.
 */
const SRC = path.join(__dirname, '../../src');
const ALLOWED = new Set([
  'shared/constants.ts',
  'identity.cdk.ts',
  'main.ts',
]);

function sourceFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relPath = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) {
      return relPath === 'smithy' || relPath === 'topology' ? [] : sourceFiles(path.join(dir, entry.name), relPath);
    }
    return entry.name.endsWith('.ts') ? [relPath] : [];
  });
}

describe('P-1: topology is selected in src/topology only', () => {
  const files = sourceFiles(SRC).filter((f) => !ALLOWED.has(f));

  test('there are modules to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test.each(files)('%s names no topology', (file) => {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const topology of TOPOLOGIES) {
      expect(text).not.toContain(`'${topology}'`);
      expect(text).not.toContain(`"${topology}"`);
    }
  });
});

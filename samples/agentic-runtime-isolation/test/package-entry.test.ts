// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as entry from 'agentic-runtime-isolation';
import * as tools from 'agentic-runtime-isolation/tools';

/**
 * The package entry a `file:` consumer imports (agentic-untrusted-code-sandboxes
 * ADR-0017): `.` and `./tools` in package.json `exports` point at real files
 * that export what the consumer needs.
 */
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  main: string;
  types: string;
  exports: Record<string, string>;
  typesVersions: Record<string, Record<string, string[]>>;
};

describe('package entry', () => {
  it('maps main, types and the "." export to src/index.ts', () => {
    expect(pkg.main).toBe('src/index.ts');
    expect(pkg.types).toBe('src/index.ts');
    expect(pkg.exports['.']).toBe('./src/index.ts');
  });

  it('maps the "./tools" export, and its node10 types, to src/tools/context.ts', () => {
    expect(pkg.exports['./tools']).toBe('./src/tools/context.ts');
    expect(pkg.typesVersions['*'].tools).toEqual(['src/tools/context.ts']);
  });

  it('exports exactly ".", "./tools" and "./package.json"', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './package.json', './tools']);
  });

  it('points every export and the node10 types path at a file that exists', () => {
    for (const target of [...Object.values(pkg.exports), ...pkg.typesVersions['*'].tools]) {
      expect(fs.existsSync(path.join(root, target))).toBe(true);
    }
  });

  it('exports the constructs from the entry', () => {
    expect(typeof entry.ToolTarget).toBe('function');
    expect(typeof entry.SharedIngress).toBe('function');
  });

  it('exports the tool-side library from ./tools', () => {
    expect(typeof tools.toolHandler).toBe('function');
    expect(typeof tools.verifyToolContext).toBe('function');
    expect(typeof tools.withTenantCredentials).toBe('function');
    expect(typeof tools.ContextError).toBe('function');
  });

  it('exposes the same tool-side library through the entry', () => {
    expect(entry.toolHandler).toBe(tools.toolHandler);
  });
});

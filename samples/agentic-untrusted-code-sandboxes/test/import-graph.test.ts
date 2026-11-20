// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Spec §3.3, ADR-0017: nothing the core entry (src/index.ts) reaches imports
// agentic-runtime-isolation. Walks the relative import graph from the entry.

import * as fs from 'node:fs';
import * as path from 'node:path';

const src = path.resolve(__dirname, '..', 'src');
const PRODUCER = 'agentic-runtime-isolation';

function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]);
  return out;
}

function resolve(from: string, spec: string): string {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(`${path.relative(src, from)}: cannot resolve ${spec}`);
}

function reach(entry: string): { files: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of specifiers(fs.readFileSync(f, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(resolve(f, spec));
      else external.add(spec);
    }
  }
  return { files: [...seen], external: [...external] };
}

test('the core entry never reaches agentic-runtime-isolation', () => {
  const { files, external } = reach(path.join(src, 'index.ts'));
  expect(files.length).toBeGreaterThan(5);
  expect(files.some((f) => f.includes(`${path.sep}gateway${path.sep}`))).toBe(false);
  expect(external.filter((s) => s === PRODUCER || s.startsWith(`${PRODUCER}/`) || s.includes(`/${PRODUCER}/`))).toEqual([]);
});

test('the walk sees a producer import when one exists', () => {
  expect(specifiers(`import { toolHandler } from '${PRODUCER}/tools';`)).toEqual([`${PRODUCER}/tools`]);
});

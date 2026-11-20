// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Post-compile step (ADR-0017, ADR-0023): copy every src/**\/*.function.ts,
 * every module it imports through a relative path (transitively), and the
 * runner sources into lib/handlers/ at the same relative paths, so a
 * consumer that installs the package can bundle the Lambdas with esbuild.
 * Package imports (`@aws-sdk/...`) resolve from the consumer's node_modules.
 *
 * Run from the sample root: ts-node --project projenrc/tsconfig.json projenrc/copy-handlers.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const out = path.join(root, 'lib', 'handlers');

function walk(dir: string, keep: (p: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
      found.push(...walk(p, keep));
    } else if (keep(p)) {
      found.push(p);
    }
  }
  return found;
}

/** Relative import specifiers of a TypeScript module (static, dynamic and re-exports). */
export function relativeImports(source: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

function resolveModule(fromFile: string, spec: string): string {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')]) {
    if (candidate.endsWith('.ts') && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    if (candidate.endsWith('.json') && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${path.relative(root, fromFile)}: cannot resolve ${spec}`);
}

function closure(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    if (!file.startsWith(src + path.sep)) {
      throw new Error(`${path.relative(root, file)} is outside src/; a handler may import only modules under src/`);
    }
    seen.add(file);
    if (file.endsWith('.ts')) {
      for (const spec of relativeImports(fs.readFileSync(file, 'utf8'))) queue.push(resolveModule(file, spec));
    }
  }
  return [...seen].sort();
}

function copy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function main(): void {
  fs.rmSync(out, { recursive: true, force: true });
  const entries = walk(src, (p) => p.endsWith('.function.ts'));
  const files = closure(entries);
  for (const f of files) copy(f, path.join(out, path.relative(src, f)));
  const runnerDir = path.join(root, 'runner');
  const runnerFiles = walk(runnerDir, (p) => !p.endsWith('.pyc'));
  for (const f of runnerFiles) copy(f, path.join(out, 'runner', path.relative(runnerDir, f)));
  console.log(`copy-handlers: ${entries.length} entries, ${files.length} modules, ${runnerFiles.length} runner files -> lib/handlers/`);
}

if (require.main === module) main();

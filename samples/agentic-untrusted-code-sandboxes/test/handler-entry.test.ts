// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { HANDLER_TREE, HANDLERS, handlerEntry, runnerPath } from '../src/handler-entry';

const root = path.resolve(__dirname, '..');
const lib = path.join(root, 'lib');
const libHandlers = path.join(lib, HANDLER_TREE);

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

describe('handlerEntry from src/', () => {
  test.each(Object.entries(HANDLERS))('%s resolves under src/', (_name, rel) => {
    expect(handlerEntry(rel)).toBe(path.join(root, 'src', rel));
  });

  test('runnerPath resolves under runner/', () => {
    expect(runnerPath()).toBe(path.join(root, 'runner'));
    expect(runnerPath('runner.py')).toBe(path.join(root, 'runner', 'runner.py'));
  });

  test('refuses paths outside src/ and non-sources', () => {
    expect(() => handlerEntry('../package.json')).toThrow(/inside src/);
    expect(() => handlerEntry('/etc/passwd.ts')).toThrow(/inside src/);
    expect(() => handlerEntry('index.d.ts')).toThrow(/TypeScript source/);
    expect(() => handlerEntry('tool/run-code.function.js')).toThrow(/TypeScript source/);
    expect(() => handlerEntry('tool/missing.function.ts')).toThrow(/not found/);
    expect(() => runnerPath('../src')).toThrow(/inside runner/);
  });
});

// These run after `compile` and `post-compile` in `npx projen build`, which
// is the order projen's build task uses (compile, post-compile, test).
const compiled = fs.existsSync(path.join(lib, 'index.js'));
const describeCompiled = compiled ? describe : describe.skip;

describeCompiled('handlerEntry from lib/ (after compile)', () => {
  test.each(Object.entries(HANDLERS))('%s exists under lib/handlers/', (_name, rel) => {
    expect(handlerEntry(rel, lib)).toBe(path.join(libHandlers, rel));
  });

  test('the runner and the protocol vectors ship under lib/handlers/runner/', () => {
    expect(runnerPath('runner.py', lib)).toBe(path.join(libHandlers, 'runner', 'runner.py'));
    expect(fs.existsSync(path.join(libHandlers, 'runner', 'Dockerfile'))).toBe(true);
    expect(fs.existsSync(path.join(libHandlers, 'runner', 'microvm', 'Dockerfile'))).toBe(true);
    expect(fs.existsSync(path.join(libHandlers, 'runner', 'protocol', 'vectors.json'))).toBe(true);
  });

  test('every module a handler imports is copied with it', () => {
    for (const f of walk(libHandlers).filter((p) => p.endsWith('.ts'))) {
      const source = fs.readFileSync(f, 'utf8');
      for (const m of source.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(f), m[1]);
        const found = [`${target}.ts`, path.join(target, 'index.ts'), target].some((c) => fs.existsSync(c));
        expect({ file: path.relative(root, f), spec: m[1], found }).toEqual({ file: path.relative(root, f), spec: m[1], found: true });
      }
    }
  });

  test('no .ts other than .d.ts ships outside lib/handlers/ (no shadowing of compiled .js)', () => {
    const shadow = walk(lib)
      .filter((p) => !p.startsWith(libHandlers + path.sep))
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts'));
    expect(shadow).toEqual([]);
  });

  test('nothing under lib/ outside lib/handlers/ resolves into the handler tree', () => {
    const outside = walk(lib).filter((p) => !p.startsWith(libHandlers + path.sep) && p.endsWith('.js'));
    for (const f of outside) {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/require\(["'][^"']*handlers\//);
    }
  });
});

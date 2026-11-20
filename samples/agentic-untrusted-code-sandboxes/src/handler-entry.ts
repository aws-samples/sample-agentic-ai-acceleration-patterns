// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Where the constructs find the sources they build at synth (ADR-0017,
 * ADR-0023). In the repository the constructs run from src/ and read the
 * sources there. Installed from the package they run from lib/, and the
 * post-compile task (projenrc/copy-handlers.ts) has copied the same sources
 * to lib/handlers/ at the same relative paths, with the runner under
 * lib/handlers/runner/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Every Lambda entry the constructs name, relative to src/. The copy step and the package test read this list. */
export const HANDLERS = {
  runCode: 'tool/run-code.function.ts',
  reaper: 'reaper/reaper.function.ts',
  drain: 'drain/drain.function.ts',
  offboard: 'offboard/offboard.function.ts',
} as const;

/** Name of the handler tree under lib/. */
export const HANDLER_TREE = 'handlers';

/** Where this module runs from: 'src' in the repository, 'lib' from the package. */
function layout(moduleDir: string): { root: string; fromLib: boolean } {
  const fromLib = path.basename(moduleDir) === 'lib';
  return { root: path.resolve(moduleDir, '..'), fromLib };
}

function checked(p: string, what: string): string {
  if (!fs.existsSync(p)) {
    throw new Error(`${what} not found at ${p}; run \`npx projen compile\` so lib/${HANDLER_TREE}/ is populated`);
  }
  return p;
}

/**
 * Absolute path of a Lambda entry, given its path relative to src/
 * (for example `HANDLERS.runCode`). `moduleDir` is for tests only.
 */
export function handlerEntry(relativePath: string, moduleDir: string = __dirname): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error(`handlerEntry takes a path inside src/, got ${relativePath}`);
  }
  if (!relativePath.endsWith('.ts') || relativePath.endsWith('.d.ts')) {
    throw new Error(`handlerEntry takes a TypeScript source, got ${relativePath}`);
  }
  const { root, fromLib } = layout(moduleDir);
  const base = fromLib ? path.join(root, 'lib', HANDLER_TREE) : path.join(root, 'src');
  return checked(path.join(base, relativePath), `handler entry ${relativePath}`);
}

/**
 * Absolute path inside the runner sources (runner/ in the repository,
 * lib/handlers/runner/ in the package), for Docker and asset contexts.
 */
export function runnerPath(relativePath: string = '', moduleDir: string = __dirname): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error(`runnerPath takes a path inside runner/, got ${relativePath}`);
  }
  const { root, fromLib } = layout(moduleDir);
  const base = fromLib ? path.join(root, 'lib', HANDLER_TREE, 'runner') : path.join(root, 'runner');
  return checked(path.join(base, relativePath), `runner path ${relativePath || '.'}`);
}

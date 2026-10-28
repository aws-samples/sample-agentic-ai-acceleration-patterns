// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Bundles the echo agent (src/agent/app.ts) into a directory the construct's
 * `agent.codePath` prop accepts: one `app.js` with its dependencies inlined.
 * Used by the demo app and the integration test app at synth time; a
 * consumer brings their own agent directory and never calls this.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** The entry point the construct expects inside `agent.codePath`. */
export const AGENT_ENTRY_FILE = 'app.js';

export interface BundleAgentOptions {
  /** Output directory; a fresh temp directory by default. Asset hashes are content-based, so the location does not matter. */
  readonly outDir?: string;
  /** Entry file; the echo agent by default. */
  readonly entry?: string;
}

export function bundleAgent(options: BundleAgentOptions = {}): string {
  // Required lazily: esbuild is a dev dependency, present wherever a synth
  // runs but not something the construct's consumers must install.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-extraneous-dependencies
  const esbuild = require('esbuild') as typeof import('esbuild');
  const outDir = options.outDir ?? mkdtempSync(path.join(tmpdir(), 'runtime-isolation-agent-'));
  esbuild.buildSync({
    entryPoints: [options.entry ?? path.join(__dirname, 'app.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true, // smaller artifact for every new microVM to fetch and parse; the agent logs error names, not stacks
    sourcemap: false,
    outfile: path.join(outDir, AGENT_ENTRY_FILE),
    logLevel: 'warning',
  });
  return outDir;
}

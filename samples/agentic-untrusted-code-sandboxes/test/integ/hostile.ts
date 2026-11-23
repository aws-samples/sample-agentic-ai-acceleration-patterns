// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Loads the probe scripts of test/integ/hostile/ and builds the `code` of a
 * call: a `CONFIG = {...}` line, the shared prelude (`_lib.py`) and the
 * probe. The runner starts jobs with `python3 -I -S`, so a probe cannot
 * import a module of its own; the driver puts the pieces in one source text.
 * The script text is public sample code with synthetic names only.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export const HOSTILE_DIR = path.join(__dirname, 'hostile');

/** The probe scripts, by name (file `<name>.py`). */
export const PROBES = [
  'parse', 'marker', 'hostile_one_bad', 'limits', 'nocreds', 'noegress', 'runaway', 'dns', 'session_files',
] as const;
export type Probe = (typeof PROBES)[number];

/** The runner's limit on `code` is 64 KiB (spec §5.1). */
export const MAX_CODE_BYTES = 64 * 1024;

const cache = new Map<string, string>();

function source(file: string): string {
  let text = cache.get(file);
  if (text === undefined) {
    text = readFileSync(path.join(HOSTILE_DIR, file), 'utf8');
    cache.set(file, text);
  }
  return text;
}

/** Drops the license header comment lines at the top of a script. */
function stripHeader(text: string): string {
  return text.split('\n').filter((l, i) => !(i < 12 && l.startsWith('#'))).join('\n');
}

/** The `code` argument of `run_code` for one probe and its configuration. */
export function probeCode(probe: Probe, config: Record<string, unknown> = {}): string {
  const code = [`import json\nCONFIG = json.loads(${JSON.stringify(JSON.stringify(config))})`, stripHeader(source('_lib.py')), stripHeader(source(`${probe}.py`))].join('\n');
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) throw new Error(`probe ${probe} exceeds the code limit`);
  return code;
}

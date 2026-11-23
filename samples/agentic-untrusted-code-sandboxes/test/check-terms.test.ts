// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** scripts/check-terms.sh in a throwaway repository: an allowed phrase does not hide a banned word on its line. */

import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function runIn(text: string): number {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-terms-'));
  mkdirSync(path.join(dir, 'scripts'));
  copyFileSync(path.join(__dirname, '..', 'scripts', 'check-terms.sh'), path.join(dir, 'scripts', 'check-terms.sh'));
  writeFileSync(path.join(dir, 'doc.md'), text);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const env = { ...process.env, CHECK_TERMS_PRIVATE: '', CHECK_TERMS_REQUIRE_PRIVATE: '' };
  return spawnSync('bash', [path.join(dir, 'scripts', 'check-terms.sh')], { cwd: dir, env, encoding: 'utf8' }).status ?? -1;
}

describe('check-terms', () => {
  test('the allowed phrases alone pass', () => {
    expect(runIn('the customer ENI of the runtime, a customer-owned name\n')).toBe(0);
  });

  test('a banned word on the same line as an allowed phrase is found', () => {
    expect(runIn('the customer ENI that a customer pays for\n')).toBe(1);
    // Built from parts, so the standard's literal grep over the sample does not match this file.
    expect(runIn(`a customer-owned name for each end ${'us' + 'er'}\n`)).toBe(1);
  });

  test('a banned word on its own line is found', () => {
    expect(runIn(`a ${'Saa' + 'S'} vendor\n`)).toBe(1);
    expect(runIn(`an application ${'provid' + 'er'}\n`)).toBe(1);
  });
});

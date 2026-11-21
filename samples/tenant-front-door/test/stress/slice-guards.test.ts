// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The guards `slice.sh` applies before it deploys or destroys anything: the
 * prefix names the stacks that `teardown` destroys, and platform mode is not
 * this slice's. None of these runs reach AWS.
 */

const SLICE = path.join(__dirname, '..', '..', 'scripts', 'stress', 'slice.sh');

function slice(prefix: string, mode: string, ...args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SLICE, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      STRESS_TIER_JSON: '{}',
      STRESS_PREFIX: prefix,
      STRESS_HOME: '/nonexistent',
      STRESS_MODE: mode,
      STRESS_RUN_ID: 'guards',
    },
  });
  return { status: r.status, stderr: r.stderr };
}

const hasJq = spawnSync('jq', ['--version']).status === 0;

describe('slice.sh guards', () => {
  it.each(['TenantFrontDoor', 'tenantfrontdoor', 'TfdSmoke', 'tfdsmoke'])('refuses the prefix %s of stacks the run did not make', (prefix) => {
    const r = slice(prefix, 'slice', 'teardown');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('is the name of the front door');
  });

  it.each(['1abc', 'a-b', 'a_b', 'Abc', 'a'.repeat(29), ''])('refuses the prefix "%s"', (prefix) => {
    const r = slice(prefix, 'slice', 'teardown');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/STRESS_PREFIX (must be 1 to 28 lower-case letters|is not set)/);
  });

  (hasJq ? it : it.skip)('lets a good prefix through to the platform-mode refusal, which touches nothing', () => {
    const r = slice('goodprefix', 'platform', 'teardown');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('platform mode');
  });

  describe('the host record of a prefix (lib.sh check_record)', () => {
    const LIB = path.join(__dirname, '..', '..', 'scripts', 'stress', 'lib.sh');
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfd-record-'));
    });

    function check(record: Record<string, string>, account: string): { status: number | null; stderr: string } {
      const file = path.join(dir, 'context.json');
      fs.writeFileSync(file, JSON.stringify(record));
      const r = spawnSync('bash', ['-c', `source "${LIB}" && check_record "${file}" "${account}"`], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', STRESS_PREFIX: 'goodprefix', STRESS_HOME: dir, AWS_REGION: 'eu-west-2' },
      });
      return { status: r.status, stderr: r.stderr };
    }

    (hasJq ? it : it.skip)('accepts a record of this account and Region', () => {
      expect(check({ accountId: '111122223333', region: 'eu-west-2' }, '111122223333').status).toBe(0);
    });

    (hasJq ? it : it.skip)('refuses a record of another account, of another Region, or with neither', () => {
      expect(check({ accountId: '999988887777', region: 'eu-west-2' }, '111122223333').status).toBe(1);
      expect(check({ accountId: '111122223333', region: 'eu-central-1' }, '111122223333')).toMatchObject({ status: 1, stderr: expect.stringContaining('nothing was changed') });
      expect(check({}, '111122223333').status).toBe(1);
    });
  });

  (hasJq ? it : it.skip)('refuses an unknown scenario before it reaches AWS', () => {
    const r = slice('goodprefix', 'slice', 'run', 'nope');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown scenario nope');
  });
});

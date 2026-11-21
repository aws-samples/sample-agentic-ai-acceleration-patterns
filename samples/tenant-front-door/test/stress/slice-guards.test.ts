// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
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

  it.each(['1abc', 'a-b', 'a_b', 'a'.repeat(29), ''])('refuses the prefix "%s"', (prefix) => {
    const r = slice(prefix, 'slice', 'teardown');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/STRESS_PREFIX (must be 1 to 28 letters|is not set)|STRESS_PREFIX is not set/);
  });

  (hasJq ? it : it.skip)('lets a good prefix through to the platform-mode refusal, which touches nothing', () => {
    const r = slice('goodprefix', 'platform', 'teardown');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('platform mode');
  });

  (hasJq ? it : it.skip)('refuses an unknown scenario before it reaches AWS', () => {
    const r = slice('goodprefix', 'slice', 'run', 'nope');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown scenario nope');
  });
});

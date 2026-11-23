// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * scripts/stress/identity-manifest.sh, run as real bash with a stubbed `aws`: the manifest
 * `slice.sh deploy` writes for the slices that read the identity in platform mode.
 */

const SCRIPT = path.join(__dirname, '../../scripts/stress/identity-manifest.sh');
const IDENTITY = { region: 'eu-central-1', apiUrl: 'https://abc123.execute-api.eu-central-1.amazonaws.com/prod', appClientId: 'client123abc' };

describe('identity-manifest.sh', () => {
  let dir: string;
  let home: string;
  const file = (): string => path.join(home, 'StressTest', 'identity.json');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manifest-'));
    home = path.join(dir, 'home');
    fs.mkdirSync(path.join(dir, 'bin'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stubAws = (script: string): void => fs.writeFileSync(path.join(dir, 'bin', 'aws'), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
  const run = (verb: string) =>
    spawnSync('bash', [SCRIPT, verb], {
      env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, STRESS_HOME: home, STRESS_PREFIX: 'StressTest' },
      encoding: 'utf8',
    });
  const left = (): string[] => (fs.existsSync(path.dirname(file())) ? fs.readdirSync(path.dirname(file())) : []);

  it('writes the published identity to identity.json, readable by its owner only', () => {
    stubAws(`printf '%s' '${JSON.stringify(IDENTITY)}'`);
    const r = run('write');
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual(IDENTITY);
    expect((fs.statSync(file()).mode % 0o1000).toString(8)).toBe('600');
    expect(left()).toEqual(['identity.json']);
  });

  it('asks SSM for the parameter of its prefix', () => {
    stubAws(`printf '%s\\n' "$@" > "${dir}/args.txt"; printf '{}'`);
    run('write');
    expect(fs.readFileSync(path.join(dir, 'args.txt'), 'utf8')).toContain('/StressTest/identity');
  });

  it('keeps the manifest of an earlier deploy and leaves no temporary file when the read fails', () => {
    stubAws(`printf '%s' '${JSON.stringify(IDENTITY)}'`);
    expect(run('write').status).toBe(0);
    stubAws('echo "ThrottlingException" >&2; exit 254');
    const r = run('write');
    expect(r.status).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual(IDENTITY);
    expect(left()).toEqual(['identity.json']);
  });

  it('writes no manifest at all when the first read fails', () => {
    stubAws('exit 254');
    expect(run('write').status).not.toBe(0);
    expect(left()).toEqual([]);
  });

  it('removes the manifest, and is fine with none', () => {
    stubAws(`printf '%s' '${JSON.stringify(IDENTITY)}'`);
    run('write');
    expect(run('remove').status).toBe(0);
    expect(left()).toEqual([]);
    expect(run('remove').status).toBe(0);
  });

  it('refuses an unknown verb', () => {
    const r = run('bogus');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: identity-manifest.sh write|remove');
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const STRESS = path.resolve(__dirname, '..');

/**
 * Runs the real `driver/k6.sh` in a scratch repository whose `host.sh` is a stub that keeps the
 * script k6.sh would send to the host, and returns that script.
 */
function remoteScript(args: string[], env: Record<string, string>): { script: string; status: number | null; err: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k6sh-'));
  fs.mkdirSync(path.join(root, 'stress', 'driver'), { recursive: true });
  fs.copyFileSync(path.join(STRESS, 'driver', 'k6.sh'), path.join(root, 'stress', 'driver', 'k6.sh'));
  fs.cpSync(path.join(STRESS, 'k6'), path.join(root, 'stress', 'k6'), { recursive: true });
  const scriptDir = path.join(root, 'samples', 'x', 'scripts', 'stress', 'k6');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'probe.js'), '// a scenario\n');
  const captured = path.join(root, 'remote.sh');
  fs.writeFileSync(path.join(root, 'stress', 'driver', 'host.sh'), `#!/usr/bin/env bash\nprintf '%s' "$1" > ${JSON.stringify(captured)}\necho 'k6 exit=0'\n`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(root, 'stress', 'driver', 'k6.sh'), 'samples/x/scripts/stress/k6/probe.js', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, AWS_REGION: 'eu-central-1', STRESS_PREFIX: 'StressTest', STRESS_RESULTS: path.join(root, 'results'), ...env },
  });
  return { script: fs.existsSync(captured) ? fs.readFileSync(captured, 'utf8') : '', status: r.status, err: r.stderr };
}

const platform = { STRESS_MODE: 'platform', STRESS_METRICS: '1', STRESS_RUN_ID: 'r1' };

describe('driver/k6.sh and the relay (stress ADR-0022)', () => {
  it('starts the relay before k6 and stops it after, in a platform run with its metrics on', () => {
    const { script, status } = remoteScript(['RECORD_SCENARIO=PS-2'], { ...platform, K6_TIMEOUT: '900' });
    expect(status).toBe(0);
    const start = script.indexOf('relay.sh >/opt/stress/out/relay.log');
    const k6 = script.indexOf('k6 "$@"');
    const stop = script.indexOf('touch /opt/stress/out/relay.stop');
    expect(start).toBeGreaterThan(0);
    expect(k6).toBeGreaterThan(start);
    expect(stop).toBeGreaterThan(k6);
    expect(script).toContain('RELAY_MAX_S=1200 bash /opt/stress/repo/stress/k6/relay.sh');
    expect(script).toContain('export RECORD_SCENARIO=\'PS-2\'');
    expect(script).toContain('export STRESS_METRICS=\'1\'');
    expect(script).toMatch(/\[ "\$\{STRESS_METRICS:-\}" = 1 \] && \[ "\$\{STRESS_MODE:-\}" = platform \] && \[ -n "\$\{RECORD_SCENARIO:-\}" \]/);
    expect(script).toMatch(/trap '\[ -z "\$relay_pid" \] \|\| kill "\$relay_pid"/);
    expect(script).toContain('while kill -0 "$relay_pid"');
  });

  it('does not start the relay for `k6 inspect`', () => {
    const { script } = remoteScript(['RECORD_SCENARIO=PS-2'], { ...platform, K6_COMMAND: 'inspect' });
    expect(script).not.toContain('relay.sh');
    expect(script).not.toContain('relay.stop');
  });

  it('puts the switches in the host\'s environment only when the caller has them, so the relay can tell the run has no metrics', () => {
    const { script } = remoteScript(['RECORD_SCENARIO=PS-2'], { STRESS_MODE: 'platform', STRESS_RUN_ID: 'r1' });
    expect(script).not.toContain('export STRESS_METRICS');
    expect(script).toContain('export STRESS_MODE=\'platform\'');
  });

  it('mirrors the relay and the minute module to the host, and stays under the 60 KB guard', () => {
    const { script, status, err } = remoteScript(['RECORD_SCENARIO=PS-2'], platform);
    expect(status).toBe(0);
    expect(err).not.toContain('too large');
    expect(script.length).toBeLessThan(60_000);
    const encoded = /echo ([A-Za-z0-9+/=]+) \| base64 -d \| tar xz -C \/opt\/stress\/repo/.exec(script)![1]!;
    const listing = spawnSync('tar', ['tz'], { input: Buffer.from(encoded, 'base64'), encoding: 'utf8' }).stdout;
    expect(listing).toContain('stress/k6/relay.sh');
    expect(listing).toContain('stress/k6/minute.js');
    expect(listing).toContain('stress/k6/lib.js');
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * SigV4 credential hygiene for scripts/demo.sh (scripts/CONVENTIONS.md, log
 * hygiene). The platform() helper signs its calls with SigV4; the secret
 * access key must never reach curl's command line, where /proc/<pid>/cmdline
 * exposes it to any local user for the life of the call. The secret is handed
 * to curl only through a config read from stdin.
 *
 * The test extracts the real platform() definition from demo.sh and runs it
 * with curl stubbed to record its argv and stdin — no AWS, no network. A
 * recognisable but synthetic credential whose alphabet matches a real SigV4
 * secret (base64: letters, digits, + and /) exercises the config quoting the
 * same way a real one would.
 */
describe('demo.sh SigV4 credential hygiene', () => {
  const DEMO = join(__dirname, '..', '..', 'scripts', 'demo.sh');
  const FAKE_AK = 'SYNTHETIC_ACCESS_KEY';
  const FAKE_SK = 'wJalrXUtnFEMI/K7MDENG+bFExample/Secret=Key';
  const FAKE_ST = 'FwoGZXIvYXdzEExampleSessionToken==';
  const FAKE_BODY = '{"password":"Synthetic-Pass-1!"}';

  let work: string;
  let argv: string;
  let stdin: string;
  let request: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'demo-sigv4-'));

    // curl stub: record argv (first line) and stdin, then emit the http_code
    // demo.sh reads from `-w '%{http_code}'`.
    const curlStub = join(work, 'curl');
    writeFileSync(
      curlStub,
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >"${work}/argv"`,
        `cat >"${work}/stdin"`,
        "printf '200'",
        '',
      ].join('\n'),
    );
    chmodSync(curlStub, 0o755);

    // A harness that evals only platform() from demo.sh and calls it once,
    // with the curl stub ahead of the real one on PATH.
    const harness = join(work, 'run.sh');
    writeFileSync(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `PATH="${work}:$PATH"`,
        // Extract the platform() function body verbatim from demo.sh.
        `fn="$(awk '/^platform\\(\\) \\{/{p=1} p{print} p&&/^\\}/{exit}' "${DEMO}")"`,
        '[ -n "$fn" ] || { echo "could not extract platform() from demo.sh" >&2; exit 3; }',
        'eval "$fn"',
        `AK=${JSON.stringify(FAKE_AK)}`,
        `SK=${JSON.stringify(FAKE_SK)}`,
        `ST=${JSON.stringify(FAKE_ST)}`,
        'REGION="us-east-1"',
        'API_URL="https://example.invalid/"',
        `BODY_FILE="${work}/body"`,
        `REQUEST_FILE="${work}/request"`,
        `platform POST platform/tenants ${JSON.stringify(FAKE_BODY)} >/dev/null`,
        '',
      ].join('\n'),
    );
    chmodSync(harness, 0o755);

    execFileSync('bash', [harness], { stdio: 'pipe' });

    argv = readFileSync(join(work, 'argv'), 'utf8');
    stdin = existsSync(join(work, 'stdin')) ? readFileSync(join(work, 'stdin'), 'utf8') : '';
    request = readFileSync(join(work, 'request'), 'utf8');
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('never passes the secret access key on curl\'s command line', () => {
    expect(argv).not.toContain(FAKE_SK);
    // The old `--user "AK:SK"` form put the secret in argv; it must be gone.
    expect(argv).not.toContain('--user');
  });

  it('hands the SigV4 user to curl through a stdin config', () => {
    expect(argv).toContain('--config -');
    expect(stdin).toContain(`user = "${FAKE_AK}:${FAKE_SK}"`);
  });

  it('still requests SigV4 signing for execute-api', () => {
    expect(argv).toContain('--aws-sigv4 aws:amz:us-east-1:execute-api');
  });

  it('forwards the session token through the stdin config', () => {
    expect(argv).not.toContain(FAKE_ST);
    expect(stdin).toContain(`header = "x-amz-security-token: ${FAKE_ST}"`);
  });

  it('keeps the request body out of argv', () => {
    expect(argv).not.toContain(FAKE_BODY);
    expect(argv).toContain(`--data-binary @${work}/request`);
    expect(request).toBe(FAKE_BODY);
  });

  it('keeps bearer and refresh tokens out of curl arguments', () => {
    const source = readFileSync(DEMO, 'utf8');
    expect(source).not.toContain('-H "Authorization: Bearer ${token}"');
    expect(source).not.toContain('--data-urlencode "subject_token=$1"');
    expect(source).toContain('<<<"header = \\"Authorization: Bearer ${token}\\""');
    expect(source).toContain('--data-binary "@$REQUEST_FILE"');
  });
});

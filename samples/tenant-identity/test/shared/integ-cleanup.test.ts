// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Failed CloudFormation creates can leave the REST API shell behind. The
 * helpers live in scripts/integ-lib.sh, shared with integ-control-plane.sh;
 * integ.sh is what calls them after its destroy.
 */
describe('integ.sh failed-create cleanup', () => {
  const INTEG = join(__dirname, '..', '..', 'scripts', 'integ.sh');
  const INTEG_LIB = join(__dirname, '..', '..', 'scripts', 'integ-lib.sh');
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'integ-cleanup-'));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('finds and deletes every stack-named orphan REST API', () => {
    const aws = join(work, 'aws');
    writeFileSync(
      aws,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ "$*" == *"get-rest-apis"* ]]; then',
        '  [[ "$*" == *"TenantIdentity-a-api"* ]] && printf "id-a\\tTenantIdentity-a-api\\n"',
        '  [[ "$*" == *"TenantIdentity-b-api"* ]] && printf "id-b\\tTenantIdentity-b-api\\n"',
        'elif [[ "$*" == *"delete-rest-api"* ]]; then',
        `  printf '%s\\n' "$*" >>${JSON.stringify(join(work, 'deleted'))}`,
        'fi',
        '',
      ].join('\n'),
    );
    chmodSync(aws, 0o755);
    const sleep = join(work, 'sleep');
    writeFileSync(sleep, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(sleep, 0o755);

    const harness = join(work, 'run.sh');
    writeFileSync(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `PATH=${JSON.stringify(work)}:$PATH`,
        `INTEG_LIB=${JSON.stringify(INTEG_LIB)}`,
        'extract() { awk -v n="$1" \'$0 == n "() {" { p=1 } p { print } p && /^}/ { exit }\' "$INTEG_LIB"; }',
        'eval "$(extract leftover_rest_apis)"',
        'eval "$(extract delete_leftover_rest_apis)"',
        'STACKS=(TenantIdentity-a TenantIdentity-b)',
        'apis="$(leftover_rest_apis)"',
        '[[ "$apis" == *"id-a"* && "$apis" == *"id-b"* ]]',
        'delete_leftover_rest_apis "$apis"',
        '',
      ].join('\n'),
    );
    chmodSync(harness, 0o755);

    execFileSync('bash', [harness], { stdio: 'pipe' });
    const deleted = readFileSync(join(work, 'deleted'), 'utf8');
    expect(deleted).toContain('delete-rest-api --rest-api-id id-a');
    expect(deleted).toContain('delete-rest-api --rest-api-id id-b');
  });

  it('runs orphan cleanup after CDK destroy', () => {
    const source = readFileSync(INTEG, 'utf8');
    expect(source).toContain('apis="$(leftover_rest_apis || true)"');
    expect(source).toContain('delete_leftover_rest_apis "$apis" || status=1');
  });
});

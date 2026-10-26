// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allParams,
  argAfter,
  awsCommands,
  cellEnv,
  conflict,
  created,
  curlRequests,
  FIXTURE,
  IDENTITY_NS,
  notFound,
  PARKED_PARAM,
  runScript,
  RunResult,
  SCRIPTS_DIR,
  tenantActive,
  tenantEnv,
  TIERED_REFUSAL,
  userCreated,
} from './mount-harness';

/**
 * The control-plane mount scripts (ADR-0028), one test per branch of the
 * mounting spec §7, run as real bash with `aws` and `curl` stubbed (spec §10
 * "Unit tests"). Fixtures are synthetic: an example ULID, a simulator
 * address, an invented password.
 */

const API = FIXTURE.apiUrl; // ends with '/'
const GET_TENANT = `GET ${API}platform/tenants/${FIXTURE.tenantId}`;
const POST_TENANTS = `POST ${API}platform/tenants`;
const POST_USERS = `POST ${API}platform/tenants/${FIXTURE.tenantId}/users`;
const DELETE_TENANT = `DELETE ${API}platform/tenants/${FIXTURE.tenantId}`;
/** A real `set -x` / `set -ex` command at the start of a line (comments mentioning it are fine). */
const SET_X = /^\s*set\s+-[a-zA-Z]*x/m;

/** Every run of this file, for the cross-cutting hygiene checks at the end. */
const runs: RunResult[] = [];
function run(...args: Parameters<typeof runScript>): RunResult {
  const result = runScript(...args);
  runs.push(result);
  return result;
}

function putParameterCalls(result: RunResult) {
  return result.calls.filter((c) => c.tool === 'aws' && c.argv[0] === 'ssm' && c.argv[1] === 'put-parameter');
}

describe('scripts/control-plane layout', () => {
  const scripts = ['tenant/create.sh', 'tenant/update.sh', 'tenant/delete.sh', 'cell/create.sh', 'cell/update.sh', 'cell/delete.sh'];

  it.each(scripts)('%s is executable, uses set -euo pipefail and never set -x', (script) => {
    const path = join(SCRIPTS_DIR, script);
    expect(() => accessSync(path, constants.X_OK)).not.toThrow();
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('set -euo pipefail');
    expect(source).not.toMatch(SET_X);
  });

  it('lib.sh never uses set -x and signs through a stdin config', () => {
    const source = readFileSync(join(SCRIPTS_DIR, 'lib.sh'), 'utf8');
    expect(source).not.toMatch(SET_X);
    expect(source).toContain('--config -');
    expect(source).not.toContain('--user');
  });
});

describe('tenant/create.sh', () => {
  it('fails before any call when a required variable is missing', () => {
    for (const missing of ['TENANT_ID', 'TENANT_NAME', 'CELL_ID', 'OPERATION', 'ADMIN_EMAIL', 'OPERATOR_ID', 'AWS_REGION']) {
      const r = run('tenant/create.sh', { env: tenantEnv({ [missing]: undefined }), params: allParams() });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(missing);
      expect(r.calls).toHaveLength(0);
    }
  });

  it('step 1: exits 1 naming the missing apiUrl parameter, with no platform call', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams({ apiUrl: undefined }) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${IDENTITY_NS}/apiUrl`);
    expect(curlRequests(r)).toEqual([]);
  });

  it('step 1: exits 1 naming the missing topology parameter', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams({ topology: undefined }) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${IDENTITY_NS}/topology`);
    expect(curlRequests(r)).toEqual([]);
  });

  it('M-R-11: a missing adminPasswordKeyArn exits 1 before any write or platform call', () => {
    const r = run('tenant/create.sh', {
      env: tenantEnv(),
      params: allParams({ adminPasswordKeyArn: undefined }),
      curl: [notFound, created()],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${IDENTITY_NS}/adminPasswordKeyArn`);
    expect(curlRequests(r)).toEqual([]);
    expect(putParameterCalls(r)).toHaveLength(0);
  });

  it('M-R-7: refuses a tiered deployment with the spec text, before any platform call', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams({ topology: 'tiered' }) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(TIERED_REFUSAL);
    expect(curlRequests(r)).toEqual([]);
  });

  it('step 3: 200 PROVISIONING exits 1 without creating', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [tenantActive('PROVISIONING')] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PROVISIONING');
    expect(curlRequests(r)).toEqual([GET_TENANT]);
    expect(putParameterCalls(r)).toHaveLength(0);
  });

  it('step 3: 200 DELETING exits 1 with "tenant is being offboarded"', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [tenantActive('DELETING')] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('tenant is being offboarded');
    expect(curlRequests(r)).toEqual([GET_TENANT]);
  });

  it('step 3: an unexpected GetTenant status exits 1 naming the status', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [{ status: 503 }] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HTTP 503');
    expect(curlRequests(r)).toEqual([GET_TENANT]);
  });

  describe('step 4: 404 -> POST /platform/tenants', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [notFound, created()] });

    it('succeeds and makes no replay call after the create', () => {
      expect(r.status).toBe(0);
      expect(curlRequests(r)).toEqual([GET_TENANT, POST_TENANTS]);
    });

    it('sends exactly {tenantId, name, adminEmail} with the control-plane id (ADR-0029)', () => {
      const post = r.calls.filter((c) => c.tool === 'curl')[1];
      expect(JSON.parse(post.body ?? '')).toEqual({
        tenantId: FIXTURE.tenantId,
        name: FIXTURE.tenantName,
        adminEmail: FIXTURE.adminEmail,
      });
      expect(post.argv).toContain('Content-Type: application/json');
    });

    it('M-R-10: parks the password as the very next call after the 201', () => {
      const i = r.calls.findIndex((c) => c.tool === 'curl' && c.argv.includes('POST'));
      const next = r.calls[i + 1];
      expect(next.tool).toBe('aws');
      expect(next.argv.slice(0, 2)).toEqual(['ssm', 'put-parameter']);
      expect(r.calls.slice(i + 2)).toEqual([]); // and nothing after it
    });

    it('parks a SecureString under AdminPasswordKey at the spec path (ADR-0031, ADR-0033)', () => {
      const [put] = putParameterCalls(r);
      expect(argAfter(put.argv, '--type')).toBe('SecureString');
      expect(argAfter(put.argv, '--key-id')).toBe(FIXTURE.keyArn);
      expect(argAfter(put.argv, '--name')).toBe(PARKED_PARAM);
      expect(argAfter(put.argv, '--value')).toBe(FIXTURE.password);
      expect(put.argv).toContain('--overwrite');
    });

    it('logs the parameter name, the operator and the tenant id, never the value', () => {
      expect(r.stdout).toContain(PARKED_PARAM);
      expect(r.stdout).toContain(`tenant ${FIXTURE.tenantId}`);
      expect(r.stdout).toContain(`operator ${FIXTURE.operatorId}`);
      expect(r.stdout).toContain('GET platform/tenants/{tenantId} -> HTTP 404');
      expect(r.stdout).toContain('POST platform/tenants -> HTTP 201');
    });
  });

  it('step 4: a 201 with no temporary password exits 1 rather than parking nothing', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [notFound, created(null)] });
    expect(r.status).toBe(1);
    expect(putParameterCalls(r)).toHaveLength(0);
  });

  it('step 4: a failed park fails the build (never a silent success)', () => {
    const r = run('tenant/create.sh', {
      env: tenantEnv(),
      params: allParams(),
      curl: [notFound, created()],
      putParameterFails: true,
    });
    expect(r.status).not.toBe(0);
    expect(putParameterCalls(r)).toHaveLength(1);
  });

  it('step 4: 409 (a racing create won) re-reads once, then claims the first-admin slot', () => {
    const r = run('tenant/create.sh', {
      env: tenantEnv(),
      params: allParams(),
      curl: [notFound, conflict, tenantActive(), userCreated()],
    });
    expect(r.status).toBe(0);
    expect(curlRequests(r)).toEqual([GET_TENANT, POST_TENANTS, GET_TENANT, POST_USERS]);
    const [put] = putParameterCalls(r);
    expect(argAfter(put.argv, '--value')).toBe(FIXTURE.replayPassword);
  });

  it('step 4: 409 then still not ACTIVE exits 1 without a third read', () => {
    const r = run('tenant/create.sh', {
      env: tenantEnv(),
      params: allParams(),
      curl: [notFound, conflict, tenantActive('PROVISIONING')],
    });
    expect(r.status).toBe(1);
    expect(curlRequests(r)).toEqual([GET_TENANT, POST_TENANTS, GET_TENANT]);
    expect(putParameterCalls(r)).toHaveLength(0);
  });

  it('step 4: any other CreateTenant status exits 1', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [notFound, { status: 403 }] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HTTP 403');
    expect(curlRequests(r)).toEqual([GET_TENANT, POST_TENANTS]);
    expect(putParameterCalls(r)).toHaveLength(0);
  });

  describe('step 5 (M-R-6): replay against an ACTIVE tenant', () => {
    it('claims the first-admin slot with {email, firstAdmin: true} and parks on 201', () => {
      const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [tenantActive(), userCreated()] });
      expect(r.status).toBe(0);
      expect(curlRequests(r)).toEqual([GET_TENANT, POST_USERS]);
      const post = r.calls.filter((c) => c.tool === 'curl')[1];
      expect(JSON.parse(post.body ?? '')).toEqual({ email: FIXTURE.adminEmail, firstAdmin: true });
      const [put] = putParameterCalls(r);
      expect(argAfter(put.argv, '--value')).toBe(FIXTURE.replayPassword);
      expect(argAfter(put.argv, '--key-id')).toBe(FIXTURE.keyArn);
      expect(r.stdout).toContain('POST platform/tenants/{tenantId}/users -> HTTP 201');
    });

    it('409 (slot held) does nothing and never re-parks', () => {
      const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [tenantActive(), conflict] });
      expect(r.status).toBe(0);
      expect(curlRequests(r)).toEqual([GET_TENANT, POST_USERS]);
      expect(putParameterCalls(r)).toHaveLength(0);
      expect(r.stdout).toContain('already has its first admin');
    });

    it('201 without a temporary password (user already in the shared pool) parks nothing and succeeds', () => {
      const r = run('tenant/create.sh', {
        env: tenantEnv(),
        params: allParams(),
        curl: [tenantActive(), userCreated(null)],
      });
      expect(r.status).toBe(0);
      expect(putParameterCalls(r)).toHaveLength(0);
    });

    it('any other status exits 1', () => {
      const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [tenantActive(), { status: 500 }] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('HTTP 500');
      expect(putParameterCalls(r)).toHaveLength(0);
    });

    it('never reads the user list first: the slot decides (ADR-0032)', () => {
      const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [tenantActive(), conflict] });
      expect(curlRequests(r).some((q) => q.startsWith('GET') && q.endsWith('/users'))).toBe(false);
    });
  });

  describe('SigV4 signing (§3.3)', () => {
    const r = run('tenant/create.sh', { env: tenantEnv(), params: allParams(), curl: [tenantActive(), conflict] });
    const curls = r.calls.filter((c) => c.tool === 'curl');

    it('signs every call as the current role for execute-api in AWS_REGION', () => {
      for (const c of curls) {
        expect(argAfter(c.argv, '--aws-sigv4')).toBe(`aws:amz:${FIXTURE.region}:execute-api`);
        expect(argAfter(c.argv, '--config')).toBe('-');
      }
    });

    it('passes the credentials through the stdin config, never argv', () => {
      for (const c of curls) {
        expect(c.stdin).toContain(`user = "${FIXTURE.accessKeyId}:${FIXTURE.secretAccessKey}"`);
        expect(c.stdin).toContain(`header = "x-amz-security-token: ${FIXTURE.sessionToken}"`);
        expect(c.argv.join(' ')).not.toContain(FIXTURE.secretAccessKey);
        expect(c.argv.join(' ')).not.toContain(FIXTURE.sessionToken);
      }
    });

    it('reads credentials once per run through export-credentials', () => {
      expect(awsCommands(r).filter((c) => c === 'configure export-credentials')).toHaveLength(1);
    });
  });

  it('tolerates an apiUrl without a trailing slash', () => {
    const r = run('tenant/create.sh', {
      env: tenantEnv(),
      params: allParams({ apiUrl: API.replace(/\/$/, '') }),
      curl: [tenantActive(), conflict],
    });
    expect(r.status).toBe(0);
    expect(curlRequests(r)).toEqual([GET_TENANT, POST_USERS]);
  });
});

describe('tenant/update.sh (§7.2, reconcile only)', () => {
  const env = tenantEnv({ OPERATION: 'update', ADMIN_EMAIL: undefined });

  it('ACTIVE is success and makes exactly one GET', () => {
    const r = run('tenant/update.sh', { env, params: allParams(), curl: [tenantActive()] });
    expect(r.status).toBe(0);
    expect(curlRequests(r)).toEqual([GET_TENANT]);
    expect(r.stdout).toContain(`operator ${FIXTURE.operatorId}`);
    expect(r.stdout).toContain('is ACTIVE');
  });

  it.each(['PROVISIONING', 'DELETING'])('%s exits 1 naming the status and never creates', (status) => {
    const r = run('tenant/update.sh', { env, params: allParams(), curl: [tenantActive(status)] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(status);
    expect(curlRequests(r)).toEqual([GET_TENANT]);
  });

  it('404 exits 1 rather than silently re-onboarding', () => {
    const r = run('tenant/update.sh', { env, params: allParams(), curl: [notFound] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('404');
    expect(curlRequests(r)).toEqual([GET_TENANT]);
    expect(putParameterCalls(r)).toHaveLength(0);
  });

  it('any other status exits 1', () => {
    const r = run('tenant/update.sh', { env, params: allParams(), curl: [{ status: 500 }] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HTTP 500');
  });

  it('does not need ADMIN_EMAIL but needs the rest of §6.1', () => {
    const r = run('tenant/update.sh', { env: tenantEnv({ OPERATION: 'update', ADMIN_EMAIL: undefined, TENANT_NAME: undefined }), params: allParams() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TENANT_NAME');
    expect(r.calls).toHaveLength(0);
  });
});

describe('tenant/delete.sh (§7.3)', () => {
  const env = tenantEnv({ OPERATION: 'delete', ADMIN_EMAIL: undefined });
  const deleteParameterCalls = (r: RunResult) =>
    r.calls.filter((c) => c.tool === 'aws' && c.argv[1] === 'delete-parameter');

  it('204 then delete-parameter is success', () => {
    const r = run('tenant/delete.sh', { env, params: allParams(), curl: [{ status: 204 }], deleteParameter: 'ok' });
    expect(r.status).toBe(0);
    expect(curlRequests(r)).toEqual([DELETE_TENANT]);
    expect(argAfter(deleteParameterCalls(r)[0].argv, '--name')).toBe(PARKED_PARAM);
    expect(r.stdout).toContain('DELETE platform/tenants/{tenantId} -> HTTP 204');
    expect(r.stdout).toContain(`operator ${FIXTURE.operatorId}`);
  });

  it('404 (a CREATE_FAILED tenant that never reached identity) is success', () => {
    const r = run('tenant/delete.sh', { env, params: allParams(), curl: [notFound], deleteParameter: 'notfound' });
    expect(r.status).toBe(0);
    expect(deleteParameterCalls(r)).toHaveLength(1);
  });

  it('ParameterNotFound on the parked password is success', () => {
    const r = run('tenant/delete.sh', { env, params: allParams(), curl: [{ status: 204 }], deleteParameter: 'notfound' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to delete');
  });

  it('any other DeleteTenant status exits 1 before touching the parameter', () => {
    const r = run('tenant/delete.sh', { env, params: allParams(), curl: [{ status: 500 }], deleteParameter: 'ok' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HTTP 500');
    expect(deleteParameterCalls(r)).toHaveLength(0);
  });

  it('any other delete-parameter error exits 1 naming the parameter', () => {
    const r = run('tenant/delete.sh', { env, params: allParams(), curl: [{ status: 204 }], deleteParameter: 'error' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(PARKED_PARAM);
  });

  it('needs apiUrl', () => {
    const r = run('tenant/delete.sh', { env, params: {} });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${IDENTITY_NS}/apiUrl`);
    expect(curlRequests(r)).toEqual([]);
  });
});

describe('cell scripts (§7.4)', () => {
  it.each(['cell/create.sh', 'cell/update.sh'])('%s passes when apiUrl and topology are published and not tiered', (script) => {
    const r = run(script, { env: cellEnv(), params: allParams({ adminPasswordKeyArn: undefined }) });
    expect(r.status).toBe(0);
    expect(curlRequests(r)).toEqual([]);
    expect(awsCommands(r)).toEqual(['ssm get-parameter', 'ssm get-parameter']);
    expect(r.stdout).toContain(`cell ${FIXTURE.cellId}`);
    expect(r.stdout).toContain(`operator ${FIXTURE.operatorId}`);
  });

  it.each(['cell/create.sh', 'cell/update.sh'])('%s fails naming a missing apiUrl', (script) => {
    const r = run(script, { env: cellEnv(), params: { topology: 'shared-pool' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${IDENTITY_NS}/apiUrl`);
  });

  it.each(['cell/create.sh', 'cell/update.sh'])('%s fails naming a missing topology', (script) => {
    const r = run(script, { env: cellEnv(), params: { apiUrl: FIXTURE.apiUrl } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${IDENTITY_NS}/topology`);
  });

  it.each(['cell/create.sh', 'cell/update.sh'])('%s refuses tiered with the spec text (M-R-7)', (script) => {
    const r = run(script, { env: cellEnv(), params: { apiUrl: FIXTURE.apiUrl, topology: 'tiered' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(TIERED_REFUSAL);
  });

  it('cell/create.sh needs CELL_ID, OPERATION, OPERATOR_ID and AWS_REGION', () => {
    for (const missing of ['CELL_ID', 'OPERATION', 'OPERATOR_ID', 'AWS_REGION']) {
      const r = run('cell/create.sh', { env: cellEnv({ [missing]: undefined }), params: allParams() });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(missing);
      expect(r.calls).toHaveLength(0);
    }
  });

  it('cell/delete.sh is an explicit no-op: exit 0, no aws or curl call', () => {
    const r = run('cell/delete.sh', { env: cellEnv({ OPERATION: 'delete' }) });
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(r.stdout).toContain('No-op delete');
    expect(r.stdout).toContain(`cell ${FIXTURE.cellId}`);
  });
});

describe('hygiene across every run (M-P-5, scripts/CONVENTIONS.md)', () => {
  it('no stub ever received the password or the admin email on its command line, except --value to put-parameter', () => {
    expect(runs.length).toBeGreaterThan(20);
    for (const r of runs) {
      for (const c of r.calls) {
        const argv = c.argv.join(' ');
        expect(argv).not.toContain(FIXTURE.adminEmail);
        expect(argv).not.toContain(FIXTURE.secretAccessKey);
        expect(argv).not.toContain(FIXTURE.sessionToken);
        const isPark = c.tool === 'aws' && c.argv[1] === 'put-parameter';
        if (isPark) {
          // The password travels only here, to SSM, as --value.
          const withoutValue = c.argv.filter((a, i) => a !== '--value' && c.argv[i - 1] !== '--value').join(' ');
          expect(withoutValue).not.toContain(FIXTURE.password);
          expect(withoutValue).not.toContain(FIXTURE.replayPassword);
        } else {
          expect(argv).not.toContain(FIXTURE.password);
          expect(argv).not.toContain(FIXTURE.replayPassword);
        }
      }
    }
  });

  it('the admin email reaches curl only in the request body file, and credentials only on stdin', () => {
    const posts = runs.flatMap((r) => r.calls.filter((c) => c.tool === 'curl' && c.body !== undefined));
    expect(posts.length).toBeGreaterThan(0);
    for (const c of posts) {
      expect(c.stdin).not.toContain(FIXTURE.adminEmail);
      expect(c.body).toContain(FIXTURE.adminEmail);
      expect(argAfter(c.argv, '--data-binary')).toMatch(/^@\//);
    }
  });

  it('the printed log never contains a body, password, email or credential', () => {
    for (const r of runs) {
      expect(r.log).not.toContain(FIXTURE.password);
      expect(r.log).not.toContain(FIXTURE.replayPassword);
      expect(r.log).not.toContain(FIXTURE.adminEmail);
      expect(r.log).not.toContain(FIXTURE.secretAccessKey);
      expect(r.log).not.toContain(FIXTURE.sessionToken);
      expect(r.log).not.toContain(FIXTURE.accessKeyId);
      expect(r.log).not.toContain('"tenant"'); // no response body
      expect(r.log).not.toContain('temporaryPassword');
      expect(r.log).not.toContain(FIXTURE.apiUrl); // the log shows path templates, not URLs
    }
  });
});

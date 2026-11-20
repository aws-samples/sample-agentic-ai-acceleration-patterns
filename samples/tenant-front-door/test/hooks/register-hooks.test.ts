// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `scripts/register-hooks.sh` (spec §5.2; control-plane R-39, `PutHook`,
 * `GetHook`, `ListHooks`, `DeleteHook`), run with bash against a stub
 * `curl` (test/hooks/support.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SAMPLE_ROOT, ScriptHarness } from './support';
import { HOOK_POST, HOOK_POST_EVENTS, HOOK_PRE, HOOK_PRE_EVENTS, ROUTE_HOOK_SCRIPT } from '../../src/shared/contracts';

const SCRIPT = path.join(SAMPLE_ROOT, 'scripts', 'register-hooks.sh');
const API = 'https://cp.example.com/prod';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvcCJ9.c2lnbmF0dXJl';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = 'https://github.com/aws-samples/sample-agentic-ai-acceleration-patterns.git';

const env = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  CONTROL_PLANE_URL: API,
  CONTROL_PLANE_TOKEN: TOKEN,
  HOOK_SOURCE_VERSION: SHA,
  ...over,
});

function definition(phase: string, events: readonly string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    events: [...events].sort(),
    phase,
    source: { type: 'GITHUB', location: REPO, sourceVersion: SHA },
    script: ROUTE_HOOK_SCRIPT,
    timeoutMinutes: 10,
    ...over,
  };
}
const POST_DEF = definition('POST', HOOK_POST_EVENTS);
const PRE_DEF = definition('PRE', HOOK_PRE_EVENTS);
const summary = (hookId: string, def: Record<string, unknown>, revision = 1): Record<string, unknown> => ({
  hookId, ...def, revision, createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z',
});
const LIST_BOTH = { status: 200, body: { hooks: [summary('audit', definition('POST', ['TENANT_CREATE'])), summary(HOOK_POST, POST_DEF), summary(HOOK_PRE, PRE_DEF)] } };
const NOT_FOUND = { status: 404, body: { message: 'Hook not found' } };

let h: ScriptHarness;
beforeEach(() => {
  h = new ScriptHarness();
});
afterEach(() => h.cleanup());

describe('the script', () => {
  it('runs under set -euo pipefail and never traces (scripts/CONVENTIONS.md)', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toMatch(/^set -euo pipefail$/m);
    expect(source).not.toMatch(/set -[a-z]*x/);
    expect(() => fs.accessSync(SCRIPT, fs.constants.X_OK)).not.toThrow();
  });
});

describe('put', () => {
  it('puts the PRE hook, then the POST hook, pinned to the commit, then finds them with ListHooks', () => {
    h.curl(NOT_FOUND, { status: 200, body: { hook: summary(HOOK_PRE, PRE_DEF) } });
    h.curl(NOT_FOUND, { status: 200, body: { hook: summary(HOOK_POST, POST_DEF) } }, LIST_BOTH);
    const r = h.run(SCRIPT, env());
    expect(r.status).toBe(0);
    const calls = h.curlCalls();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/hooks/${HOOK_PRE}`,
      `PUT ${API}/hooks/${HOOK_PRE}`,
      `GET ${API}/hooks/${HOOK_POST}`,
      `PUT ${API}/hooks/${HOOK_POST}`,
      `GET ${API}/hooks`,
    ]);
    expect(JSON.parse(calls[1].data!)).toEqual(PRE_DEF);
    expect(JSON.parse(calls[3].data!)).toEqual(POST_DEF);
    expect(r.output).toContain(`ListHooks names ${HOOK_POST} (POST) and ${HOOK_PRE} (PRE)`);
  });

  it('leaves only the PRE hook when the second put fails, so no hook writes routes that none deletes', () => {
    h.curl(NOT_FOUND, { status: 200, body: { hook: summary(HOOK_PRE, PRE_DEF) } });
    h.curl(NOT_FOUND, { status: 409, body: { message: 'The control plane holds 5 global hooks; delete one first' } });
    const r = h.run(SCRIPT, env());
    expect(r.status).toBe(1);
    const puts = h.curlCalls().filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url)).toEqual([`${API}/hooks/${HOOK_PRE}`, `${API}/hooks/${HOOK_POST}`]);
    expect(r.output).toContain(`put ${HOOK_PRE}, revision 1`);
    expect(r.output).not.toContain(`put ${HOOK_POST}`);
    expect(r.output).toContain(`PutHook ${HOOK_POST}: HTTP 409`);
    expect(h.curlCalls()).toHaveLength(4);
  });

  it('sends the token on stdin, never on the command line or in the output', () => {
    h.curl(NOT_FOUND, { status: 200, body: { hook: summary(HOOK_POST, POST_DEF) } });
    h.curl(NOT_FOUND, { status: 200, body: { hook: summary(HOOK_PRE, PRE_DEF) } }, LIST_BOTH);
    const r = h.run(SCRIPT, env());
    for (const c of h.curlCalls()) {
      expect(c.config).toBe(`header = "Authorization: Bearer ${TOKEN}"\n`);
      expect(c.args).toEqual(expect.arrayContaining(['--config', '-']));
      expect(c.args.join(' ')).not.toContain(TOKEN);
    }
    expect(r.output).not.toContain(TOKEN);
    expect(h.leftovers()).toEqual([]);
  });

  it('leaves a hook registered with the same definition unchanged, so a rerun does not raise its revision', () => {
    h.curl(
      { status: 200, body: { hook: summary(HOOK_PRE, PRE_DEF, 2) } },
      { status: 200, body: { hook: summary(HOOK_POST, { ...POST_DEF, events: [...HOOK_POST_EVENTS].reverse() }, 3) } },
      LIST_BOTH,
    );
    const r = h.run(SCRIPT, env());
    expect(r.status).toBe(0);
    expect(h.curlCalls().map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    expect(r.output).toContain(`${HOOK_POST} is registered with this definition, unchanged`);
  });

  it('replaces a hook pinned to another commit', () => {
    const old = definition('POST', HOOK_POST_EVENTS, { source: { type: 'GITHUB', location: REPO, sourceVersion: 'f'.repeat(40) } });
    h.curl(
      { status: 200, body: { hook: summary(HOOK_PRE, PRE_DEF) } },
      { status: 200, body: { hook: summary(HOOK_POST, old) } },
      { status: 200, body: { hook: summary(HOOK_POST, POST_DEF, 2) } },
      LIST_BOTH,
    );
    const r = h.run(SCRIPT, env());
    expect(r.status).toBe(0);
    expect(h.curlCalls().map((c) => c.method)).toEqual(['GET', 'GET', 'PUT', 'GET']);
    expect(r.output).toContain(`put ${HOOK_POST}, revision 2`);
  });

  it('takes the source location, type and timeout from the environment', () => {
    h.curl(NOT_FOUND, { status: 200, body: { hook: {} } }, NOT_FOUND, { status: 200, body: { hook: {} } });
    h.run(SCRIPT, env({ HOOK_SOURCE_LOCATION: 'https://git.example.com/vendor/fork.git', HOOK_SOURCE_TYPE: 'GITLAB', HOOK_TIMEOUT_MINUTES: '15' }));
    expect(JSON.parse(h.curlCalls()[1].data!)).toEqual(definition('PRE', HOOK_PRE_EVENTS, {
      source: { type: 'GITLAB', location: 'https://git.example.com/vendor/fork.git', sourceVersion: SHA },
      timeoutMinutes: 15,
    }));
  });

  it('pins an S3 zip source to its object version (the integration test, spec §10 step 1)', () => {
    const version = 'Wq.8_uYv3+rk/0a-Zz1';
    h.curl(NOT_FOUND, { status: 200, body: { hook: {} } }, NOT_FOUND, { status: 200, body: { hook: {} } });
    h.run(SCRIPT, env({ HOOK_SOURCE_TYPE: 'S3', HOOK_SOURCE_LOCATION: 'tfd-integ-src-bucket/0a1b.zip', HOOK_SOURCE_VERSION: version }));
    expect(JSON.parse(h.curlCalls()[1].data!)).toEqual(definition('PRE', HOOK_PRE_EVENTS, {
      source: { type: 'S3', location: 'tfd-integ-src-bucket/0a1b.zip', sourceVersion: version },
    }));
  });

  it('follows ListHooks pages', () => {
    h.curl(
      { status: 200, body: { hook: summary(HOOK_PRE, PRE_DEF) } },
      { status: 200, body: { hook: summary(HOOK_POST, POST_DEF) } },
      { status: 200, body: { hooks: [summary(HOOK_POST, POST_DEF)], nextToken: 'a+b/c=' } },
      { status: 200, body: { hooks: [summary(HOOK_PRE, PRE_DEF)] } },
    );
    const r = h.run(SCRIPT, env());
    expect(r.status).toBe(0);
    expect(h.curlCalls()[3].url).toBe(`${API}/hooks?nextToken=a%2Bb%2Fc%3D`);
  });

  it('fails when ListHooks does not name both hooks with their phases', () => {
    h.curl(
      { status: 200, body: { hook: summary(HOOK_PRE, PRE_DEF) } },
      { status: 200, body: { hook: summary(HOOK_POST, POST_DEF) } },
      { status: 200, body: { hooks: [summary(HOOK_POST, POST_DEF), summary(HOOK_PRE, { ...PRE_DEF, phase: 'POST' })] } },
    );
    const r = h.run(SCRIPT, env());
    expect(r.status).toBe(1);
    expect(r.output).toContain('ListHooks does not name both hooks');
  });

  it('fails on a sixth hook, printing the control plane\'s answer', () => {
    h.curl(NOT_FOUND, { status: 409, body: { message: 'The control plane holds 5 global hooks; delete one first' } });
    const r = h.run(SCRIPT, env());
    expect(r.status).toBe(1);
    expect(r.output).toContain(`PutHook ${HOOK_PRE}: HTTP 409: {"message":"The control plane holds 5 global hooks; delete one first"}`);
    expect(h.curlCalls()).toHaveLength(2);
  });

  it('fails on a GetHook error other than 404', () => {
    h.curl({ status: 403, body: { message: 'Forbidden' } });
    const r = h.run(SCRIPT, env());
    expect(r.status).toBe(1);
    expect(r.output).toContain(`GetHook ${HOOK_PRE}: HTTP 403`);
  });

  it.each([
    ['no CONTROL_PLANE_URL', { CONTROL_PLANE_URL: undefined }, /set CONTROL_PLANE_URL/],
    ['an http URL', { CONTROL_PLANE_URL: 'http://cp.example.com' }, /not an https URL/],
    ['no token', { CONTROL_PLANE_TOKEN: undefined }, /set CONTROL_PLANE_TOKEN/],
    ['a token that would break the config line', { CONTROL_PLANE_TOKEN: 'abc"\nurl = "https://evil.example.com"' }, /not a bearer token/],
    ['no commit', { HOOK_SOURCE_VERSION: undefined }, /set HOOK_SOURCE_VERSION/],
    ['a branch for the commit', { HOOK_SOURCE_VERSION: 'main' }, /full commit SHA/],
    ['a short SHA', { HOOK_SOURCE_VERSION: '0123456' }, /full commit SHA/],
    ['a location with userinfo', { HOOK_SOURCE_LOCATION: 'https://user:token@github.com/x/y.git' }, /without userinfo/],
    ['an unknown source type', { HOOK_SOURCE_TYPE: 'NO_SOURCE' }, /git source type or S3/],
    ['an S3 source with no location', { HOOK_SOURCE_TYPE: 'S3' }, /set HOOK_SOURCE_LOCATION/],
    ['an S3 folder, which has no version', { HOOK_SOURCE_TYPE: 'S3', HOOK_SOURCE_LOCATION: 'tfd-integ-src/src/' }, /<bucket>\/<key>\.zip/],
    ['an S3 location that is a URL', { HOOK_SOURCE_TYPE: 'S3', HOOK_SOURCE_LOCATION: 'https://tfd-integ-src.s3.amazonaws.com/src.zip' }, /<bucket>\/<key>\.zip/],
    ['an S3 version id with a space', { HOOK_SOURCE_TYPE: 'S3', HOOK_SOURCE_LOCATION: 'tfd-integ-src/src.zip', HOOK_SOURCE_VERSION: 'a b' }, /object version id/],
    ['a timeout of 4 minutes', { HOOK_TIMEOUT_MINUTES: '4' }, /5 to 30/],
    ['a timeout of 31 minutes', { HOOK_TIMEOUT_MINUTES: '31' }, /5 to 30/],
  ])('refuses %s and calls nothing', (_name, over, error) => {
    const r = h.run(SCRIPT, env(over));
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(error);
    expect(r.output).not.toContain('evil.example.com');
    expect(h.curlCalls()).toEqual([]);
  });

  it('refuses an unknown argument', () => {
    const r = h.run(SCRIPT, env(), ['--force']);
    expect(r.status).toBe(1);
    expect(r.output).toContain('usage:');
  });
});

describe('--delete', () => {
  it('deletes both hooks and checks that ListHooks names neither, needing no commit', () => {
    h.curl({ status: 200, body: {} }, NOT_FOUND, { status: 200, body: { hooks: [summary('audit', definition('POST', ['TENANT_CREATE']))] } });
    const r = h.run(SCRIPT, env({ HOOK_SOURCE_VERSION: undefined }), ['--delete']);
    expect(r.status).toBe(0);
    expect(h.curlCalls().map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${API}/hooks/${HOOK_POST}`,
      `DELETE ${API}/hooks/${HOOK_PRE}`,
      `GET ${API}/hooks`,
    ]);
    expect(r.output).toContain(`${HOOK_PRE} was not registered`);
    expect(r.output).toContain('ListHooks names neither');
  });

  it('fails when ListHooks still names one', () => {
    h.curl({ status: 200, body: {} }, { status: 200, body: {} }, { status: 200, body: { hooks: [summary(HOOK_PRE, PRE_DEF)] } });
    const r = h.run(SCRIPT, env(), ['--delete']);
    expect(r.status).toBe(1);
    expect(r.output).toContain(`ListHooks still names ["${HOOK_PRE}"]`);
  });

  it('fails on a DeleteHook error', () => {
    h.curl({ status: 500, body: { message: 'internal' } });
    const r = h.run(SCRIPT, env(), ['--delete']);
    expect(r.status).toBe(1);
    expect(r.output).toContain(`DeleteHook ${HOOK_POST}: HTTP 500`);
  });
});

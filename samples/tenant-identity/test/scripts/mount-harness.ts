// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Harness for the control-plane mount scripts (scripts/control-plane/,
 * ADR-0028, mounting spec §7 and §10 "Unit tests"). Each script runs as a real
 * bash process with `aws` and `curl` replaced by stubs placed first on PATH.
 * No AWS, no network.
 *
 * The stubs record every invocation (argv, and for curl also the stdin config
 * and the request body file) in order, so a test can assert both what was
 * called and in which order (M-R-10: the park is the very next call after the
 * 201). Responses are scripted per test: SSM parameters as files, the curl
 * responses as a queue consumed one per call.
 */

export const SCRIPTS_DIR = join(__dirname, '..', '..', 'scripts', 'control-plane');

/** Synthetic fixtures. Alphabets match the real values (ULID, base64, ULID-ish password). */
export const FIXTURE = {
  tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  tenantName: 'Acme Example Ltd',
  cellId: 'cell-01',
  adminEmail: 'success+admin@simulator.amazonses.com',
  operatorId: 'operator-sub-0001',
  region: 'eu-west-1',
  apiUrl: 'https://abc123.execute-api.eu-west-1.amazonaws.com/prod/',
  keyArn: 'arn:aws:kms:eu-west-1:111122223333:key/11111111-2222-3333-4444-555555555555',
  accessKeyId: 'SYNTHETIC_ACCESS_KEY',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bFExample/Secret=Key',
  sessionToken: 'FwoGZXIvYXdzEExampleSessionToken==',
  password: 'Temp-Pass-Synthetic-9f3k!',
  replayPassword: 'Temp-Pass-Replay-7q2z!',
};

export const PARKED_PARAM = `/application-plane/tenants/${FIXTURE.tenantId}/identity/admin-temporary-password`;
export const IDENTITY_NS = '/application-plane/shared/identity';
export const TIERED_REFUSAL = 'tiered identity needs a per-tenant tier; not supported when mounted';

/** A scripted curl response: HTTP status and body (the body may be empty, as for a 204). */
export interface CurlResponse {
  readonly status: number;
  readonly body?: unknown;
}

export interface RunOptions {
  /** Env the control plane would pass (spec §6.1). Missing keys are left unset. */
  readonly env?: Record<string, string | undefined>;
  /** Shared identity parameters present in "SSM" (name under IDENTITY_NS -> value). */
  readonly params?: Record<string, string>;
  /** curl responses, consumed in call order. An unscripted call fails the stub. */
  readonly curl?: CurlResponse[];
  /** `aws ssm delete-parameter` outcome. */
  readonly deleteParameter?: 'ok' | 'notfound' | 'error';
  /** Make `aws ssm put-parameter` fail. */
  readonly putParameterFails?: boolean;
}

/** One recorded stub invocation. */
export interface Call {
  readonly tool: 'aws' | 'curl';
  readonly argv: string[];
  /** curl only: what arrived on stdin (the `--config -` text). */
  readonly stdin?: string;
  /** curl only: the contents of the `--data-binary @file` body, if any. */
  readonly body?: string;
}

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: Call[];
  /** stdout + stderr, for hygiene assertions. */
  readonly log: string;
}

const US = '\u001f'; // unit separator between argv items in the call log

/** Full §6.1 env for a tenant create, overridable per test. */
export function tenantEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    TENANT_ID: FIXTURE.tenantId,
    TENANT_NAME: FIXTURE.tenantName,
    CELL_ID: FIXTURE.cellId,
    OPERATION: 'create',
    ADMIN_EMAIL: FIXTURE.adminEmail,
    OPERATOR_ID: FIXTURE.operatorId,
    AWS_REGION: FIXTURE.region,
    ...overrides,
  };
}

/** Full env for a cell script. */
export function cellEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CELL_ID: FIXTURE.cellId,
    OPERATION: 'create',
    OPERATOR_ID: FIXTURE.operatorId,
    AWS_REGION: FIXTURE.region,
    ...overrides,
  };
}

/** All three shared parameters present. */
export function allParams(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    apiUrl: FIXTURE.apiUrl,
    topology: 'shared-pool',
    adminPasswordKeyArn: FIXTURE.keyArn,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

export const tenantActive = (status = 'ACTIVE'): CurlResponse => ({
  status: 200,
  body: { tenant: { tenantId: FIXTURE.tenantId, name: FIXTURE.tenantName, status, topology: 'shared-pool' } },
});
export const notFound: CurlResponse = { status: 404, body: { message: 'tenant not found' } };
export const conflict: CurlResponse = { status: 409, body: { message: 'conflict' } };
/** Pass `null` for a 201 that carries no temporaryPassword. */
export const created = (password: string | null = FIXTURE.password): CurlResponse => ({
  status: 201,
  body: {
    tenant: { tenantId: FIXTURE.tenantId, name: FIXTURE.tenantName, status: 'ACTIVE', topology: 'shared-pool' },
    admin: {
      user: { username: FIXTURE.adminEmail, email: FIXTURE.adminEmail, admin: true, status: 'FORCE_CHANGE_PASSWORD' },
      ...(password ? { temporaryPassword: password } : {}),
    },
  },
});
/** Pass `null` for a 201 that carries no temporaryPassword (user already in the pool). */
export const userCreated = (password: string | null = FIXTURE.replayPassword): CurlResponse => ({
  status: 201,
  body: {
    user: { username: FIXTURE.adminEmail, email: FIXTURE.adminEmail, admin: true, status: 'FORCE_CHANGE_PASSWORD' },
    ...(password ? { temporaryPassword: password } : {}),
  },
});

const AWS_STUB = `#!/usr/bin/env bash
# aws stub: records argv, answers from the fixture directory.
set -u
W="$STUB_WORK"
n="$(cat "$W/counter" 2>/dev/null || echo 0)"; echo $((n + 1)) >"$W/counter"
{ printf 'aws'; for a in "$@"; do printf '${US}%s' "$a"; done; printf '\\n'; } >"$W/calls/$(printf '%04d' "$n").aws"
case "$1 $2" in
  "configure export-credentials")
    printf '{"Version":1,"AccessKeyId":"%s","SecretAccessKey":"%s","SessionToken":"%s"}\\n' \\
      "${FIXTURE.accessKeyId}" "${FIXTURE.secretAccessKey}" "${FIXTURE.sessionToken}"
    ;;
  "ssm get-parameter")
    name=""; while [ $# -gt 0 ]; do [ "$1" = --name ] && name="$2"; shift; done
    f="$W/params/$(printf '%s' "$name" | tr '/' '_')"
    if [ -f "$f" ]; then cat "$f"; else
      echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: " >&2; exit 254; fi
    ;;
  "ssm put-parameter")
    if [ -f "$W/put-fails" ]; then echo "An error occurred (AccessDeniedException) when calling the PutParameter operation" >&2; exit 254; fi
    echo '{"Version": 1, "Tier": "Standard"}'
    ;;
  "ssm delete-parameter")
    case "$(cat "$W/delete-result" 2>/dev/null || echo ok)" in
      ok) ;;
      notfound) echo "An error occurred (ParameterNotFound) when calling the DeleteParameter operation: " >&2; exit 254 ;;
      *) echo "An error occurred (AccessDeniedException) when calling the DeleteParameter operation: " >&2; exit 254 ;;
    esac
    ;;
  *) echo "aws stub: unscripted command: $*" >&2; exit 99 ;;
esac
`;

const CURL_STUB = `#!/usr/bin/env bash
# curl stub: records argv, stdin and the --data-binary file; answers from the
# response queue; honours -w's %{http_code} the way the real curl does.
set -u
W="$STUB_WORK"
n="$(cat "$W/counter" 2>/dev/null || echo 0)"; echo $((n + 1)) >"$W/counter"
id="$(printf '%04d' "$n")"
{ printf 'curl'; for a in "$@"; do printf '${US}%s' "$a"; done; printf '\\n'; } >"$W/calls/$id.curl"
cat >"$W/calls/$id.stdin"
fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -w) fmt="$2"; shift ;;
    --data-binary) cp "\${2#@}" "$W/calls/$id.body" ;;
  esac
  shift
done
r="$(ls "$W/responses" | head -n 1)"
[ -n "$r" ] || { echo "curl stub: no scripted response left" >&2; exit 98; }
status="$(head -n 1 "$W/responses/$r")"
tail -n +2 "$W/responses/$r"
rm "$W/responses/$r"
printf '%s' "\${fmt//%\\{http_code\\}/$status}"
`;

/**
 * Run one mount script under the stubs. `script` is relative to
 * scripts/control-plane (e.g. 'tenant/create.sh').
 */
export function runScript(script: string, options: RunOptions = {}): RunResult {
  const work = mkdtempSync(join(tmpdir(), 'mount-scripts-'));
  for (const d of ['bin', 'calls', 'params', 'responses']) mkdirSync(join(work, d));

  writeFileSync(join(work, 'bin', 'aws'), AWS_STUB);
  writeFileSync(join(work, 'bin', 'curl'), CURL_STUB);
  chmodSync(join(work, 'bin', 'aws'), 0o755);
  chmodSync(join(work, 'bin', 'curl'), 0o755);

  for (const [name, value] of Object.entries(options.params ?? {})) {
    writeFileSync(join(work, 'params', `${IDENTITY_NS}/${name}`.replace(/\//g, '_')), value);
  }
  (options.curl ?? []).forEach((r, i) => {
    const body = r.body === undefined ? '' : JSON.stringify(r.body);
    writeFileSync(join(work, 'responses', String(i).padStart(4, '0')), `${r.status}\n${body}`);
  });
  if (options.deleteParameter) writeFileSync(join(work, 'delete-result'), options.deleteParameter);
  if (options.putParameterFails) writeFileSync(join(work, 'put-fails'), '');

  // Only the §6.1 variables plus what bash and the stubs need: no ambient AWS
  // configuration can leak in, and nothing but the stubs answers as aws/curl.
  const env: Record<string, string> = {
    PATH: `${join(work, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: work,
    TMPDIR: work,
    STUB_WORK: work,
  };
  for (const [k, v] of Object.entries(options.env ?? {})) if (v !== undefined) env[k] = v;

  const proc = spawnSync('bash', [join(SCRIPTS_DIR, script)], { env, encoding: 'utf8', cwd: work });

  const calls: Call[] = readdirSync(join(work, 'calls'))
    .filter((f) => f.endsWith('.aws') || f.endsWith('.curl'))
    .sort()
    .map((f) => {
      const [tool, ...argv] = readFileSync(join(work, 'calls', f), 'utf8').replace(/\n$/, '').split(US);
      const id = f.replace(/\.(aws|curl)$/, '');
      const call: Call = { tool: tool as 'aws' | 'curl', argv };
      if (tool === 'curl') {
        const stdinPath = join(work, 'calls', `${id}.stdin`);
        const bodyPath = join(work, 'calls', `${id}.body`);
        return {
          ...call,
          stdin: existsSync(stdinPath) ? readFileSync(stdinPath, 'utf8') : '',
          body: existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : undefined,
        };
      }
      return call;
    });

  return {
    status: proc.status ?? -1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    calls,
    log: `${proc.stdout ?? ''}${proc.stderr ?? ''}`,
  };
}

/** The curl calls of a run as "METHOD url". */
export function curlRequests(result: RunResult): string[] {
  return result.calls
    .filter((c) => c.tool === 'curl')
    .map((c) => `${c.argv[c.argv.indexOf('-X') + 1]} ${c.argv[c.argv.length - 1]}`);
}

/** The aws calls of a run as "service operation". */
export function awsCommands(result: RunResult): string[] {
  return result.calls.filter((c) => c.tool === 'aws').map((c) => `${c.argv[0]} ${c.argv[1]}`);
}

/** The value after `flag` in an argv, or undefined. */
export function argAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

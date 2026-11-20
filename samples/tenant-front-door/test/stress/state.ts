// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTier, type TierJson } from './plan';

/**
 * The environment the runner gives every verb (docs/stress-test.spec.md
 * §3.4) and the files the slice keeps in `$STRESS_HOME/$STRESS_PREFIX/
 * tenant-front-door/`: the stack outputs `deploy.sh` wrote, the tenant
 * manifest and one request log per scenario. Nothing there is a token, a
 * password or a key.
 */

export interface Env {
  readonly tier: TierJson;
  readonly runId: string;
  readonly prefix: string;
  readonly mode: string;
  readonly results: string;
  readonly commit: string;
  readonly region: string;
  readonly stateDir: string;
}

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
}

export function readEnv(): Env {
  return {
    tier: parseTier(process.env.STRESS_TIER_JSON),
    runId: need('STRESS_RUN_ID'),
    prefix: need('STRESS_PREFIX'),
    mode: need('STRESS_MODE'),
    results: process.env.STRESS_RESULTS ?? '',
    commit: process.env.STRESS_COMMIT ?? '',
    region: need('AWS_REGION'),
    stateDir: path.join(need('STRESS_HOME'), need('STRESS_PREFIX'), 'tenant-front-door'),
  };
}

/** What `deploy.sh` records about the deployed stacks. */
export interface Outputs {
  readonly region: string;
  readonly edgeRegion: string;
  readonly accountId: string;
  readonly appDomain: string;
  readonly applicationId: string;
  readonly registrarUrl: string;
  readonly cellId: string;
  readonly cellApiDomain: string;
  readonly cellFunctionUrl: string;
  readonly cellLogGroup: string;
  readonly edgeLogGroup: string;
  readonly routerFunction: string;
  readonly fixtureTable: string;
  readonly operatorRoleArn: string;
  readonly hookRoleArn: string;
  readonly identityApiUrl: string;
  readonly identityAppClientId: string;
}

export function readOutputs(env: Env): Outputs {
  const file = path.join(env.stateDir, 'outputs.json');
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: run deploy first`);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const o = {} as Record<string, string>;
  for (const k of ['region', 'edgeRegion', 'accountId', 'appDomain', 'applicationId', 'registrarUrl', 'cellId', 'cellApiDomain', 'cellFunctionUrl', 'cellLogGroup', 'edgeLogGroup', 'routerFunction', 'fixtureTable', 'operatorRoleArn', 'hookRoleArn', 'identityApiUrl', 'identityAppClientId']) {
    const v = doc[k];
    if (typeof v !== 'string' || v === '') throw new Error(`${file}: ${k} is missing`);
    o[k] = v;
  }
  return o as unknown as Outputs;
}

export type TenantKind = 'active' | 'write';

export interface TenantEntry {
  readonly tenantId: string;
  /** Empty until tenant-identity has confirmed the create: the manifest knows the tenant first, so no failure leaks one. */
  username: string;
  readonly kind: TenantKind;
  readonly name?: string;
  /** The tenant's namespace parameter is written. */
  ready?: boolean;
}

export interface Manifest {
  readonly version: 1;
  readonly tenants: readonly TenantEntry[];
}

export function manifestPath(env: Env): string {
  return path.join(env.stateDir, 'manifest.json');
}

export function readManifest(env: Env): Manifest {
  const file = manifestPath(env);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: run seed first`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
}

export function writeManifest(env: Env, m: Manifest): void {
  fs.mkdirSync(env.stateDir, { recursive: true, mode: 0o700 });
  const file = manifestPath(env);
  fs.writeFileSync(`${file}.new`, JSON.stringify(m), { mode: 0o600 });
  fs.renameSync(`${file}.new`, file);
}

/** One line per request of a scenario: what the join with the edge log reads. Ids and codes only. */
export interface RequestLine {
  /** The `x-amz-cf-id` response header: the edge log's `x-edge-request-id`. */
  readonly id: string;
  readonly kind: string;
  readonly tenant: string;
  readonly status: number;
  readonly reason?: string;
  /** Client seconds to the last byte. */
  readonly seconds: number;
  /** The tenant the client expects the edge log to name; `-` for none. */
  readonly edgeTenant: string;
  /** When the answer came, in epoch milliseconds: `collect` looks for a missing log line near it. */
  readonly at: number;
}

export function requestLogPath(env: Env, scenario: string): string {
  return path.join(env.stateDir, `requests.${scenario}.jsonl`);
}

export function writeRequestLog(env: Env, scenario: string, lines: readonly RequestLine[]): void {
  fs.mkdirSync(env.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(requestLogPath(env, scenario), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
}

export function readRequestLog(env: Env, scenario: string): RequestLine[] {
  const file = requestLogPath(env, scenario);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as RequestLine);
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What the driver remembers between its phases, and between a run and the
 * cleanup that follows an interruption: the stack, what it owned at deploy
 * time (physical ids, so the leftover check can look for exactly them), and
 * the account's Logs resource policies before the deploy (spec §3.9). Kept in
 * a file outside the repository, one per prefix and Region.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface OwnedResource {
  readonly type: string;
  readonly logicalId: string;
  readonly physicalId: string;
}

export interface RunState {
  readonly prefix: string;
  readonly region: string;
  readonly stackName: string;
  readonly startedAt: string;
  /** Set once the stack delete finished with nothing left, so the exit trap does not run it again. */
  readonly destroyed: boolean;
  /** Everything the stack owned at deploy time. */
  readonly resources: readonly OwnedResource[];
  /** Names of the account's Logs resource policies before the deploy, and a digest of each document. */
  readonly policyBaseline: Readonly<Record<string, string>>;
  /** The query-log group ARN of the firewall instance, known once the stack is up (spec §3.9). */
  readonly queryLogGroupArn?: string;
  /** Runtime and image names, for the log-group prefixes AgentCore and Lambda create after the deploy. */
  readonly runtimeNames: readonly string[];
  readonly imageNames: readonly string[];
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.INTEG_STATE_DIR || path.join(os.tmpdir(), 'untrusted-code-sandboxes-integ');
}

export function stateFile(prefix: string, region: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), `${prefix}-${region}.json`);
}

export function writeState(state: RunState, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(state.prefix, state.region, env), JSON.stringify(state, undefined, 2), { mode: 0o600 });
}

export function readState(prefix: string, region: string, env: NodeJS.ProcessEnv = process.env): RunState | undefined {
  const file = stateFile(prefix, region, env);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as RunState;
}

/** The same state with some fields replaced. */
export function withState(state: RunState, patch: Partial<RunState>): RunState {
  return { ...state, ...patch };
}

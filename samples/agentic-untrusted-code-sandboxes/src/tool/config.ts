// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** The function environment the construct sets (src/env.ts), read once and checked (ADR-0032). */

import { BACKEND_NAMES, type BackendName } from '../backend';
import { ENV } from '../env';

export interface ToolConfig {
  readonly table: string;
  readonly bucket: string;
  readonly backends: readonly BackendName[];
  readonly defaultBackend: BackendName;
  readonly toolTenantRoleArn: string;
  readonly runTimeoutMs: number;
  readonly startWaitMs: number;
  readonly maxOutputBytes: number;
  readonly maxInputBytes: number;
  readonly sandboxIdleMs: number;
  readonly sandboxMaxLifeMs: number;
  readonly perTenantMetrics: boolean;
}

/** Slack before a handle-less STARTING row counts as dead, besides `startWait`: the tool's own timeout (spec §3.3, §4.1). */
export const TOOL_TIMEOUT_PADDING_MS = 15_000;

/** The tool Lambda's timeout, 5 s + startWait + runTimeout + 10 s (spec §3.3). */
export function toolTimeoutMs(config: Pick<ToolConfig, 'startWaitMs' | 'runTimeoutMs'>): number {
  return TOOL_TIMEOUT_PADDING_MS + config.startWaitMs + config.runTimeoutMs;
}

/** A STARTING row with no handle older than this has a start that died before it recorded the handle (spec §4.1). */
export function handleLessStaleMs(config: Pick<ToolConfig, 'startWaitMs' | 'runTimeoutMs'>): number {
  return config.startWaitMs + toolTimeoutMs(config);
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const v = env[name];
  if (v === undefined || v === '') throw new Error(`environment variable ${name} is not set`);
  return v;
}

function whole(env: Readonly<Record<string, string | undefined>>, name: string): number {
  const v = Number(required(env, name));
  if (!Number.isInteger(v) || v < 0) throw new Error(`environment variable ${name} must be a whole number`);
  return v;
}

function backendName(value: string, name: string): BackendName {
  const found = BACKEND_NAMES.find((b) => b === value);
  if (found === undefined) throw new Error(`environment variable ${name} names an unknown backend`);
  return found;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): ToolConfig {
  const backends = required(env, ENV.BACKENDS).split(',').map((b) => backendName(b.trim(), ENV.BACKENDS));
  const defaultBackend = backendName(required(env, ENV.DEFAULT_BACKEND), ENV.DEFAULT_BACKEND);
  if (!backends.includes(defaultBackend)) throw new Error(`${ENV.DEFAULT_BACKEND} is not one of ${ENV.BACKENDS}`);
  return {
    table: required(env, ENV.REGISTRY_TABLE),
    bucket: required(env, ENV.INPUT_BUCKET),
    backends,
    defaultBackend,
    toolTenantRoleArn: required(env, ENV.TOOL_TENANT_ROLE_ARN),
    runTimeoutMs: whole(env, ENV.RUN_TIMEOUT_MS),
    startWaitMs: whole(env, ENV.START_WAIT_MS),
    maxOutputBytes: whole(env, ENV.MAX_OUTPUT_BYTES),
    maxInputBytes: whole(env, ENV.MAX_INPUT_BYTES),
    sandboxIdleMs: whole(env, ENV.SANDBOX_IDLE_MS),
    sandboxMaxLifeMs: whole(env, ENV.SANDBOX_MAX_LIFE_MS),
    perTenantMetrics: env[ENV.PER_TENANT_METRICS] === 'true',
  };
}

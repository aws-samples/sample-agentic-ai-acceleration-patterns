// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** Names and numbers shared by the integration app and its driver (spec §8). */

export type Backend = 'microvm' | 'nitro' | 'agentcore';
export const BACKENDS: readonly Backend[] = ['microvm', 'nitro', 'agentcore'];

/** The two construct instances of the integration stack (spec §8). */
export type Instance = 'run-code' | 'run-code-files';
export const INSTANCES: readonly Instance[] = ['run-code', 'run-code-files'];

/** Backends each instance enables. `run-code-files` is `agentcore` only, with session files on and the firewall off. */
export const INSTANCE_BACKENDS: Readonly<Record<Instance, readonly Backend[]>> = {
  'run-code': ['microvm', 'nitro', 'agentcore'],
  'run-code-files': ['agentcore'],
};

/** Whether each instance turns `dnsFirewall` on. */
export const INSTANCE_DNS_FIREWALL: Readonly<Record<Instance, boolean>> = {
  'run-code': true,
  'run-code-files': false,
};

/**
 * CloudWatch Logs resource policies the integration stack creates: one per
 * instance with `dnsFirewall` (query-log delivery) and one per `agentcore`
 * backend (usage-log delivery). The account allows 10 per Region (spec §3.9).
 */
export function logsPoliciesNeeded(): number {
  const instances = Object.keys(INSTANCE_BACKENDS) as Instance[];
  return instances.reduce((n, i) => n + (INSTANCE_DNS_FIREWALL[i] ? 1 : 0) + (INSTANCE_BACKENDS[i].includes('agentcore') ? 1 : 0), 0);
}

/** The `RunCodeToolTarget` name of each instance; the MCP tool name is `<target>___run_code`. */
export const TOOL_TARGET: Readonly<Record<Instance, string>> = {
  'run-code': 'run-code',
  'run-code-files': 'run-code-files',
};
export const TOOL_NAME = 'run_code';
export const TOOLS_GATEWAY = 'default';
export const MCP_VERSION = '2025-11-25';

/** The integration stack's settings (spec §8): a short idle time so idle, max-life and microvm-stop fit a run. */
export const SANDBOX_IDLE_MINUTES = 2;
/** shortcut: 20 s, below the 30 s default, so the steps that end on the time cap stay short; raise it with the cap steps. */
export const RUN_TIMEOUT_SECONDS = 20;
export const START_WAIT_SECONDS = 15;

/** Tenants of the run (spec §8 seed): A and B own invoices; C races, then is offboarded; D is cold-from-zero; E fails to start. */
export const TENANT = { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' } as const;

/** Names of the fixed environment knobs of the driver (integration-test.md, "How to run it"). */
export const ENV = {
  prefix: 'INTEG_PREFIX',
  concurrency: 'INTEG_DEPLOY_CONCURRENCY',
  region: 'AWS_REGION',
} as const;

export const DEFAULT_PREFIX = 'UntrustedCodeSandboxesInteg';
export const DEFAULT_DEPLOY_CONCURRENCY = 2;

/** The stack prefix: letters and digits, starting with a letter (as agentic-runtime-isolation's integration test). */
export function stackPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const prefix = env[ENV.prefix] || DEFAULT_PREFIX;
  if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(prefix)) {
    throw new Error(`${ENV.prefix} must be 1 to 40 letters and digits, starting with a letter`);
  }
  return prefix;
}

/** `INTEG_DEPLOY_CONCURRENCY`: a positive integer, default 2 (the API Gateway control-plane throttle). */
export function deployConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV.concurrency];
  if (raw === undefined || raw === '') return DEFAULT_DEPLOY_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${ENV.concurrency} must be a positive integer (got ${raw})`);
  return n;
}

/** The single Region of the run; the driver fails fast when it is unset (standard §5.2). */
export function runRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region = env[ENV.region];
  if (region === undefined || region === '') {
    throw new Error('Set AWS_REGION to the single Region to test in (for example export AWS_REGION=eu-central-1)');
  }
  return region;
}

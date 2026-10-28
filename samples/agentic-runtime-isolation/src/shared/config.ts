// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingress Lambdas' configuration: the construct writes it as environment
 * variables (src/shared-ingress.cdk.ts) and the handlers read it back
 * here, so the names and the encoding live in one file. Everything in it is
 * configuration a deployer chose; nothing is a secret.
 */

import type { IngressKind } from './metrics';
import type { SessionScope } from './session';

/** A backend name: lower-case letters, digits and hyphens, 1 to 32 characters (ADR-0024). */
export const BACKEND_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;

/** A 12-digit AWS account id. */
const ACCOUNT_ID_PATTERN = /^\d{12}$/;

/** Environment variable names. */
export const ENV = {
  INGRESS: 'RI_INGRESS',
  DISCOVERY_URL: 'RI_DISCOVERY_URL',
  ALLOWED_CLIENT_IDS: 'RI_ALLOWED_CLIENT_IDS',
  REQUIRED_SCOPES: 'RI_REQUIRED_SCOPES',
  SESSION_SCOPE: 'RI_SESSION_SCOPE',
  FORWARD_USER_TOKEN: 'RI_FORWARD_USER_TOKEN',
  REQUIRE_NARROWED_TOKEN: 'RI_REQUIRE_NARROWED_TOKEN',
  ALLOWED_SCOPES: 'RI_ALLOWED_SCOPES',
  TVM_ROLE_ARN: 'RI_TVM_ROLE_ARN',
  TVM_INCLUDE_USER_ID_TAG: 'RI_TVM_INCLUDE_USER_ID_TAG',
  TVM_CLAIM_TAGS: 'RI_TVM_CLAIM_TAGS',
  TVM_DURATION_SECONDS: 'RI_TVM_DURATION_SECONDS',
  TVM_CACHE_MAX_ENTRIES: 'RI_TVM_CACHE_MAX_ENTRIES',
  /** Per-tenant limits (ADR-0020): the shared counter table and the two limits. */
  LIMITS_TABLE: 'RI_LIMITS_TABLE',
  LIMIT_REQUESTS_PER_MINUTE: 'RI_LIMIT_REQUESTS_PER_MINUTE',
  LIMIT_OUTPUT_TOKENS_PER_MINUTE: 'RI_LIMIT_OUTPUT_TOKENS_PER_MINUTE',
  /** Per-tenant EMF metrics on (ADR-0021); off unless 'true'. */
  PER_TENANT_METRICS: 'RI_PER_TENANT_METRICS',
  /** Backend registry (ADR-0024): the SSM parameter prefix the ingress resolves `/{backend}/invocations` through, and the cache TTL. */
  REGISTRY_PREFIX: 'RI_REGISTRY_PREFIX',
  REGISTRY_TTL_SECONDS: 'RI_REGISTRY_TTL_SECONDS',
  /** The account the ingress runs in; a registry entry whose Runtime ARN names another account is refused. Unset skips the check. */
  REGISTRY_ACCOUNT: 'RI_REGISTRY_ACCOUNT',
  /** The backend served at the bare `/invocations` route (the one-agent form); unset when there is none. */
  DEFAULT_BACKEND: 'RI_DEFAULT_BACKEND',
} as const;

/** Environment variables the construct sets for the agent process (src/agent/app.ts reads them). */
export const AGENT_ENV = {
  /** The one model the execution role allows; the agent calls exactly this id (P-6, ADR-0017). */
  MODEL_ID: 'MODEL_ID',
  /** The demo's tenant-partitioned table for the `read <tenant>` probe (set by the demo stack, ADR-0012). */
  TABLE_NAME: 'TABLE_NAME',
} as const;

export interface DelegationConfig {
  readonly forwardUserToken: boolean;
  readonly requireNarrowedToken: boolean;
  readonly allowedScopes?: string[];
}

export interface TvmConfig {
  readonly roleArn: string;
  readonly includeUserIdTag: boolean;
  /** Tag key to claim name. */
  readonly claimTags: Record<string, string>;
  readonly durationSeconds: number;
  /** Bound on cached tag sets per ingress instance (ADR-0022); default 1000. */
  readonly cacheMaxEntries?: number;
}

export interface LimitsConfig {
  readonly tableName: string;
  readonly requestsPerMinute: number;
  readonly outputTokensPerMinute?: number;
}

/** The backend registry the ingress resolves routes through (ADR-0024). */
export interface RegistryConfig {
  /** SSM parameter prefix, with a trailing slash; entries live at `${prefix}backends/<name>`. */
  readonly prefix: string;
  /** Seconds an entry is served from the per-process cache before a refresh; default 60. */
  readonly ttlSeconds: number;
  /** The backend the bare `/invocations` route resolves to (the one-agent form); undefined when there is none. */
  readonly defaultBackend?: string;
  /** The Region the ingress runs in (`AWS_REGION`); an entry's Runtime ARN must match it and its partition. Undefined skips the check. */
  readonly region?: string;
  /** The account the ingress runs in (`RI_REGISTRY_ACCOUNT`); an entry's Runtime ARN must match it. Undefined skips the check. */
  readonly account?: string;
}

export interface IngressConfig {
  readonly ingress: IngressKind;
  readonly discoveryUrl: string;
  readonly allowedClientIds: string[];
  readonly requiredScopes?: string[];
  /** Set when the `session` module is on (ADR-0013). */
  readonly sessionScope?: SessionScope;
  readonly delegation: DelegationConfig;
  /** Set when the `tvm` module is on (ADR-0012). */
  readonly tvm?: TvmConfig;
  /** Set when per-tenant limits are on (ADR-0020). */
  readonly limits?: LimitsConfig;
  /** Emit per-tenant EMF metrics (ADR-0021). */
  readonly perTenantMetrics: boolean;
  /** The backend registry (ADR-0024). */
  readonly registry: RegistryConfig;
}

function positiveInteger(name: string, value: string | undefined, allowZero = false): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be a${allowZero ? ' non-negative' : ' positive'} integer`);
  }
  return n;
}

/**
 * True on the Lambda runtime (the runtime sets `AWS_LAMBDA_FUNCTION_NAME`),
 * false under jest. The handlers build their dependencies at module load
 * only on Lambda, so a missing or malformed variable fails the init phase
 * by design, naming the variable, instead of the first request (ADR-0023).
 */
export function isLambdaRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AWS_LAMBDA_FUNCTION_NAME !== undefined && env.AWS_LAMBDA_FUNCTION_NAME.length > 0;
}

/** Reads one required variable; a missing value fails at cold start, naming it. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function flag(value: string | undefined): boolean {
  return value === 'true';
}

/** Parses the ingress configuration from the environment. */
export function readIngressConfig(env: NodeJS.ProcessEnv = process.env): IngressConfig {
  const ingress = requireEnv(ENV.INGRESS, env);
  if (ingress !== 'api-gateway' && ingress !== 'agentcore-gateway') {
    throw new Error(`${ENV.INGRESS} must be api-gateway or agentcore-gateway`);
  }
  const sessionScope = env[ENV.SESSION_SCOPE];
  if (sessionScope !== undefined && sessionScope !== '' && sessionScope !== 'user' && sessionScope !== 'tenant') {
    throw new Error(`${ENV.SESSION_SCOPE} must be user or tenant`);
  }
  const tvmRoleArn = env[ENV.TVM_ROLE_ARN];
  let tvm: TvmConfig | undefined;
  if (tvmRoleArn !== undefined && tvmRoleArn.length > 0) {
    const rawTags = env[ENV.TVM_CLAIM_TAGS];
    const claimTags: Record<string, string> = rawTags ? (JSON.parse(rawTags) as Record<string, string>) : {};
    const duration = Number(env[ENV.TVM_DURATION_SECONDS] ?? '900');
    if (!Number.isInteger(duration) || duration < 900 || duration > 3600) {
      throw new Error(`${ENV.TVM_DURATION_SECONDS} must be an integer between 900 and 3600`);
    }
    tvm = {
      roleArn: tvmRoleArn,
      includeUserIdTag: flag(env[ENV.TVM_INCLUDE_USER_ID_TAG]),
      claimTags,
      durationSeconds: duration,
      cacheMaxEntries: positiveInteger(ENV.TVM_CACHE_MAX_ENTRIES, env[ENV.TVM_CACHE_MAX_ENTRIES]),
    };
  }
  const limitsTable = env[ENV.LIMITS_TABLE];
  let limits: LimitsConfig | undefined;
  if (limitsTable !== undefined && limitsTable.length > 0) {
    limits = {
      tableName: limitsTable,
      requestsPerMinute: positiveInteger(ENV.LIMIT_REQUESTS_PER_MINUTE, env[ENV.LIMIT_REQUESTS_PER_MINUTE], true) ?? 0,
      outputTokensPerMinute: positiveInteger(ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE, env[ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE]),
    };
  }
  return {
    ingress,
    discoveryUrl: requireEnv(ENV.DISCOVERY_URL, env),
    allowedClientIds: list(requireEnv(ENV.ALLOWED_CLIENT_IDS, env)) ?? [],
    requiredScopes: list(env[ENV.REQUIRED_SCOPES]),
    sessionScope: sessionScope === undefined || sessionScope === '' ? undefined : sessionScope,
    delegation: {
      forwardUserToken: flag(env[ENV.FORWARD_USER_TOKEN]),
      requireNarrowedToken: flag(env[ENV.REQUIRE_NARROWED_TOKEN]),
      allowedScopes: list(env[ENV.ALLOWED_SCOPES]),
    },
    tvm,
    limits,
    perTenantMetrics: flag(env[ENV.PER_TENANT_METRICS]),
    registry: readRegistryConfig(env),
  };
}

/**
 * The registry prefix must be an absolute SSM path ending in `/`; the default
 * backend, when set, must be a valid backend name; the account, when set,
 * must be a 12-digit id. The Region is the Lambda's own (`AWS_REGION`).
 */
export function readRegistryConfig(env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  const prefix = requireEnv(ENV.REGISTRY_PREFIX, env);
  if (!prefix.startsWith('/') || !prefix.endsWith('/')) {
    throw new Error(`${ENV.REGISTRY_PREFIX} must start and end with /`);
  }
  const defaultBackend = env[ENV.DEFAULT_BACKEND];
  if (defaultBackend !== undefined && defaultBackend !== '' && !BACKEND_NAME_PATTERN.test(defaultBackend)) {
    throw new Error(`${ENV.DEFAULT_BACKEND} must be 1 to 32 lower-case letters, digits and hyphens`);
  }
  const account = env[ENV.REGISTRY_ACCOUNT];
  if (account !== undefined && account !== '' && !ACCOUNT_ID_PATTERN.test(account)) {
    throw new Error(`${ENV.REGISTRY_ACCOUNT} must be a 12-digit AWS account id`);
  }
  const region = env.AWS_REGION;
  return {
    prefix,
    ttlSeconds: positiveInteger(ENV.REGISTRY_TTL_SECONDS, env[ENV.REGISTRY_TTL_SECONDS]) ?? 60,
    defaultBackend: defaultBackend === undefined || defaultBackend === '' ? undefined : defaultBackend,
    region: region === undefined || region === '' ? undefined : region,
    account: account === undefined || account === '' ? undefined : account,
  };
}

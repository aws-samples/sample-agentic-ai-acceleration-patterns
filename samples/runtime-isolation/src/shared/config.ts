// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingress Lambdas' configuration: the construct writes it as environment
 * variables (src/runtime-isolation.cdk.ts) and the handlers read it back
 * here, so the names and the encoding live in one file. Everything in it is
 * configuration a deployer chose; nothing is a secret.
 */

import type { IngressKind } from './metrics';
import type { SessionScope } from './session';

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
  /** Backend-specific: the AgentCore Runtime ARN the ingress invokes. */
  RUNTIME_ARN: 'RI_RUNTIME_ARN',
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
  };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `SharedIngress` (ADR-0024; spec §3, standard §4.5): the ingress alone. An
 * API Gateway REST API with response streaming, or an AgentCore Gateway with
 * a REQUEST interceptor (ADR-0003), serving `POST /{backend}/invocations`.
 * The ingress holds no Runtime ARN: it resolves the route's backend name
 * through the registry under `registryPrefix` (SSM Parameter Store, cached
 * per process for `registryTtl`), which each `AgentBackend` writes from its
 * own stack. Creating, changing or removing a backend never redeploys this
 * construct.
 *
 * Everything that is identical across backends lives here: the token check,
 * the product-wide scope floor (`requiredScopes`), the token vending machine
 * (always on, ADR-0018), the per-tenant limit (ADR-0020), the stage throttle,
 * the log drain (ADR-0019) and the published parameters. (v2) Also the
 * entitlement store (C-12, ADR-0030), the token signer and the issuer's
 * discovery routes (C-13, ADR-0037), the entitlement API (C-14) and, unless
 * `toolsGateway: false`, the tools gateways (C-15, ADR-0034, ADR-0041): one
 * named `default` unless `toolsGateways` names several. The
 * function that mints (the authoriser on `api-gateway`, the interceptor on
 * `agentcore-gateway`) is the only principal allowed `kms:Sign`.
 *
 * The construct creates none of its data dependencies: the issuer and, with
 * `tvm`, a data-bearing tenant role are props. It applies no cdk-nag aspect
 * and no App settings; it carries its own acknowledgments with reasons.
 */

import * as path from 'node:path';
import { Annotations, Duration, Lazy, Names, RemovalPolicy, Stack, Token, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { baseModelId, foundationModelArn, INVOKE_ACTION, isInferenceProfileId, modelResourceArns } from './backend/agentcore-runtime.cdk';
import type { BackendKind } from './backend/backend';
import { EntitlementApi } from './entitlements/entitlement-api.cdk';
import { ENV } from './shared/config';
import { EntitlementStore } from './shared/entitlement-store.cdk';
import { acknowledgeLambdaFindings, functionProps } from './shared/function.cdk';
import type { JwsAlgorithm } from './shared/jws';
import { LogDrain } from './shared/log-drain';
import type { IngressKind } from './shared/metrics';
import { DEFAULT_MINT_CACHE_MAX_ENTRIES, DEFAULT_TOOLS_GATEWAY, MAX_TRANSACTION_TTL_SECONDS, MIN_TRANSACTION_TTL_SECONDS, TOOLS_GATEWAY_NAME_PATTERN } from './shared/mint';
import { acknowledgeGranularFinding, nagFindingResource } from './shared/nag';
import { BACKEND_NAME_PATTERN, INGRESS_TAG_KEY, REGISTRY_BACKENDS_SEGMENT, ROUTE } from './shared/registry';
import { LONGEST_STREAM, MAX_DRAIN } from './shared/registry-entry.cdk';
import { CONVERSATION_ID_PATTERN, type SessionScope } from './shared/session';
import { TENANT_HEADER, TENANT_ID_PATTERN } from './shared/tenant';
import { signingKey, TokenSigner, WELL_KNOWN } from './shared/token-signer.cdk';
import { DEFAULT_CACHE_MAX_ENTRIES, TENANT_TAG_KEY, USER_TAG_KEY } from './shared/tvm';
import {
  DEFAULT_MAX_TOOLS_PER_GATEWAY,
  gatewayIdPart,
  MAX_TOOLS_PER_GATEWAY_LIMIT,
  type ResolvedToolsGateway,
  ToolsGateway,
} from './tools-gateway.cdk';

export { acknowledgeLambdaFindings, functionProps } from './shared/function.cdk';

// ---------------------------------------------------------------------------
// Props (spec §3.3)
// ---------------------------------------------------------------------------

/** The issuer whose access tokens the ingress accepts (spec §6.2.1). */
export interface IdentityProps {
  /** OIDC discovery URL of the issuer (`.../.well-known/openid-configuration`). */
  readonly discoveryUrl: string;
  /** `client_id` values accepted. Non-empty. */
  readonly allowedClientIds: string[];
  /**
   * (v2, R-1, ADR-0038) Accept identity tokens that carry `tenants`; the
   * request then names one with `X-Tenant-Id`. Default false: such a token
   * is refused as in v1.
   */
  readonly multiTenant?: boolean;
}

/** The `session` module (ADR-0013, ADR-0002): conversations persist in a claim-derived unit. */
export interface SessionProps {
  /** `'tenant'` hashes `tenant_id` only; `'user'` hashes `tenant_id|sub`. Default `'tenant'` (v2, ADR-0039). */
  readonly scope?: SessionScope;
}

/** The `tvm` module (P-8, ADR-0012, ADR-0018). The TVM is always on; this prop only customises it. */
export interface TvmProps {
  /**
   * A tenant role the ingress assumes that ALSO reaches tenant data. The
   * deployer owns its trust and ABAC policies (spec §6.1), and the construct
   * adds the one-model statement to it (ADR-0018). Unset: the construct
   * creates `TenantModelRole`, which may invoke only the backends' models.
   */
  readonly role?: iam.IRole;
  /** Add `UserId = sub` as a session tag. Default false. */
  readonly includeUserIdTag?: boolean;
  /** Extra session tags: tag key to claim name. A claim missing from the token fails the request with 403. `TenantId` and `UserId` are reserved. */
  readonly claimTags?: Record<string, string>;
  /** Credential lifetime, 900 to 3600. Default 900. */
  readonly durationSeconds?: number;
  /** Bound on cached credential sets per ingress instance (ADR-0022). Default 1000. */
  readonly cacheMaxEntries?: number;
}

/** Per-tenant limits, enforced fleet-wide at the ingress and shared by every backend behind it (ADR-0020, ADR-0024). */
export interface TenantLimitsProps {
  /** Requests one tenant may make per minute, across all backends. Default 60. `0` turns the request limit off. */
  readonly requestsPerMinute?: number;
  /** Model output tokens one tenant may use per minute. Unset: no token limit. `api-gateway` ingress only. */
  readonly outputTokensPerMinute?: number;
}

/** The API Gateway stage throttle, shared by all tenants and all backends (`api-gateway` ingress only). */
export interface StageThrottleProps {
  /** Steady-state requests per second for the whole stage. Default 50. */
  readonly rateLimit?: number;
  /** Burst for the whole stage. Default 25. */
  readonly burstLimit?: number;
}

/** (v2, ADR-0031, ADR-0036, ADR-0037) The transaction token the ingress mints. Always on. */
export interface TransactionTokenProps {
  /** `exp - iat`, 120 s to 900 s (the AgentCore Gateway refuses a token with 60 s or less left). Default 300 s. */
  readonly ttl?: Duration;
  /** Default `'RS256'`; `'ES256'` was accepted by the Gateway in spike V-8. */
  readonly algorithm?: JwsAlgorithm;
  /** Bump to rotate: a new key signs, the previous stays in the JWKS (spec §6.2.3). Default 1. */
  readonly keyGeneration?: number;
  /** Minted tokens kept per ingress instance, LRU. Default 1000. */
  readonly cacheMaxEntries?: number;
}

/** (v2, ADR-0030, ADR-0033) The entitlement store and API. Always on. */
export interface EntitlementsProps {
  /** Identity-token scope the tenant-admin operations require. Default `'entitlements/admin'`. */
  readonly adminScope?: string;
  /** Bound on `agents` in a tenant or plan row. Default 100. */
  readonly maxAgentsPerTenant?: number;
  /** Bound on `tools` in a tenant or plan row. Default 1000. */
  readonly maxToolsPerTenant?: number;
}

/**
 * (v2, ADR-0034, ADR-0041) One tools gateway. On by default as one gateway
 * named `default`; `toolsGateway: false` creates none; `toolsGateways`
 * names several.
 */
export interface ToolsGatewayOptions {
  /** One native bucket per `tenant_id`. Default `{ requestsPerSecond: 10 }`. */
  readonly tenantRateLimit?: { readonly requestsPerSecond: number };
  /** Named tenants with their own rate (requests per second), at most 1,000. */
  readonly tenantRateLimitOverrides?: Record<string, number>;
  /** Provisioned concurrency on the tools interceptor. Default 1; 0 turns it off. */
  readonly interceptorProvisionedConcurrency?: number;
  /** `exp` of the signed tenant context. Default 60 s; 10 s to 300 s. */
  readonly contextLifetime?: Duration;
  /**
   * (ADR-0041) Synth fails when the `ToolTarget`s on this gateway would
   * catalogue more tools: the Policy engine's 400 KB schema quota holds about
   * 330 one-field tools (V-16a). Default 300; 1 to 1,000.
   */
  readonly maxToolsPerGateway?: number;
  /**
   * (ADR-0041) A RESPONSE interceptor that trims each `tools/list` page to
   * the exact tools in `scope`. Default false: the list is filtered natively
   * at target grain.
   */
  readonly responseFilter?: boolean;
}

/** The registry prefix every ingress uses unless told otherwise; one per account and Region (standard §1.1, ADR-0024). */
export const DEFAULT_REGISTRY_PREFIX = '/application-plane/shared/agent-runtime/';
/** How long an ingress process serves a registry entry before refreshing it (ADR-0024). */
export const DEFAULT_REGISTRY_TTL = Duration.seconds(60);
/** The longest `registryTtl` (750 s): a drain plus the longest stream fits one registry-entry Lambda invocation. */
export const MAX_REGISTRY_TTL = MAX_DRAIN.minus(LONGEST_STREAM);
/** The conventional default backend name, and so the Gateway target name for the one-agent form (ADR-0024). */
export const GATEWAY_TARGET_NAME = 'default';
/** Default transaction-token life (spec §3.3). */
export const DEFAULT_TRANSACTION_TOKEN_TTL = Duration.seconds(300);
/** Default admin scope of the tenant-admin entitlement operations (spec §3.3). */
export const DEFAULT_ADMIN_SCOPE = 'entitlements/admin';
/**
 * The longest API Gateway authoriser cache (v2). The authoriser's Allow now
 * carries a minted token, so the cache must be shorter than the token's
 * reuse margin; v1's five minutes (ADR-0023) would hand out expired tokens.
 */
export const AUTHORIZER_CACHE_TTL = Duration.seconds(60);

export interface SharedIngressProps {
  readonly identity: IdentityProps;
  /** The isolating compute service every backend behind this ingress runs on (ADR-0011). Default `'agentcore-runtime'`. */
  readonly backend?: BackendKind;
  /** The ingress (ADR-0003). `'agentcore-gateway'` is valid only with the `'agentcore-runtime'` backend. */
  readonly ingress: IngressKind;
  /** Session mapping (ADR-0013). Unset: a fresh unit per request. */
  readonly session?: SessionProps;
  /** Scopes every identity token must carry (ADR-0005, AND): the application floor, for example `app/use`. */
  readonly requiredScopes?: string[];
  /**
   * Removed in v2 (ADR-0031): the agent receives a transaction token. Setting
   * it fails synth.
   * @deprecated
   */
  readonly delegation?: never;
  /** The TVM is always on (ADR-0018); this customises it. */
  readonly tvm?: TvmProps;
  /** Per-tenant limits (ADR-0020), on by default at 60 requests per tenant per minute. `false` turns them off. */
  readonly tenantLimits?: TenantLimitsProps | false;
  /** The shared stage throttle on the `api-gateway` ingress. Default 50 rps, burst 25. */
  readonly stageThrottle?: StageThrottleProps;
  /** Emit per-tenant CloudWatch metrics (EMF, ADR-0021). Default false (cost per tenant). */
  readonly perTenantMetrics?: boolean;
  /** The SSM parameter prefix of the registry and the published parameters (ADR-0024). Default `/application-plane/shared/agent-runtime/`. */
  readonly registryPrefix?: string;
  /**
   * Write the published interface (spec §6.4) under `registryPrefix`. Default true. `false`
   * writes none of it (the registry entries of backends and tool targets still appear); a
   * consumer then reads the construct's members or stack outputs. Several ingress stacks
   * deployed at once share Parameter Store's 3 writes per second per account (ADR-0042).
   */
  readonly publish?: boolean;
  /** Cache life of registry entries, plans and the tool catalogue (v2). Default 60 s; 1 s to 750 s. */
  readonly registryTtl?: Duration;
  /** The backend served at the bare `/invocations` route. `[a-z0-9-]{1,32}`. */
  readonly defaultBackend?: string;
  /** (v2) The transaction token. */
  readonly transactionToken?: TransactionTokenProps;
  /** (v2) The entitlement store and API. */
  readonly entitlements?: EntitlementsProps;
  /**
   * (v2) The tools gateway: shorthand for `toolsGateways: { default: ... }`.
   * Default on; `false` creates none. Not together with `toolsGateways`.
   */
  readonly toolsGateway?: ToolsGatewayOptions | false;
  /**
   * (v2, ADR-0041) Several tools gateways by name (`[a-z0-9-]{1,32}`), each
   * with its own Policy engine, interceptor and rate limits. A `ToolTarget`
   * names its gateway (default `default`). Not together with `toolsGateway`.
   */
  readonly toolsGateways?: Record<string, ToolsGatewayOptions>;
}

/** The props after defaults and validation; what the construct and its tests reason about. */
export interface ResolvedOptions {
  readonly backend: BackendKind;
  readonly ingress: IngressKind;
  readonly multiTenant: boolean;
  readonly sessionScope?: SessionScope;
  readonly requiredScopes?: string[];
  /** The TVM is always on (ADR-0018); `role` undefined means the construct's default model-only role. */
  readonly tvm: {
    readonly role?: iam.IRole;
    readonly includeUserIdTag: boolean;
    readonly claimTags: Record<string, string>;
    readonly durationSeconds: number;
    readonly cacheMaxEntries: number;
  };
  /** Undefined when per-tenant limits are off. */
  readonly tenantLimits?: { readonly requestsPerMinute: number; readonly outputTokensPerMinute?: number };
  readonly stageThrottle: { readonly rateLimit: number; readonly burstLimit: number };
  readonly perTenantMetrics: boolean;
  readonly registryPrefix: string;
  readonly publish: boolean;
  readonly registryTtlSeconds: number;
  readonly defaultBackend?: string;
  /** (v2) */
  readonly transactionToken: {
    readonly ttlSeconds: number;
    readonly algorithm: JwsAlgorithm;
    readonly keyGeneration: number;
    readonly cacheMaxEntries: number;
    /** A cached token is reused only while more than this is left (see `authorizerCacheTtlSeconds`). */
    readonly reuseMarginSeconds: number;
  };
  /**
   * (v2) The API Gateway authoriser cache: at most 60 s and at most
   * `ttl - LONGEST_STREAM`, so a token handed from the cache still outlives
   * a whole stream. The mint's reuse margin is this plus the longest stream.
   */
  readonly authorizerCacheTtlSeconds: number;
  /** (v2) */
  readonly entitlements: { readonly adminScope: string; readonly maxAgentsPerTenant: number; readonly maxToolsPerTenant: number };
  /** (v2, ADR-0041) The tools gateways by name; empty when `toolsGateway: false`. */
  readonly toolsGateways: Readonly<Record<string, ResolvedToolsGateway>>;
}

/** Validates one tools gateway's options (spec §3.3); `prop` names it in errors. */
function resolveToolsGateway(t: ToolsGatewayOptions, prop: string, fail: (prop: string, message: string) => never): ResolvedToolsGateway {
  const requestsPerSecond = t.tenantRateLimit?.requestsPerSecond ?? 10;
  if (!Number.isInteger(requestsPerSecond) || requestsPerSecond < 1) {
    fail(`${prop}.tenantRateLimit.requestsPerSecond`, `must be a positive integer (got ${String(requestsPerSecond)})`);
  }
  const overrides = t.tenantRateLimitOverrides ?? {};
  const entries = Object.entries(overrides);
  if (entries.length > 1000) {
    fail(`${prop}.tenantRateLimitOverrides`, `must name at most 1000 tenants (got ${entries.length})`);
  }
  for (const [tenantId, rate] of entries) {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      fail(`${prop}.tenantRateLimitOverrides`, `key '${tenantId}' must match ${TENANT_ID_PATTERN.source}`);
    }
    if (!Number.isInteger(rate) || rate < 1) {
      fail(`${prop}.tenantRateLimitOverrides`, `rate for '${tenantId}' must be a positive integer`);
    }
  }
  const pc = t.interceptorProvisionedConcurrency ?? 1;
  if (!Number.isInteger(pc) || pc < 0) {
    fail(`${prop}.interceptorProvisionedConcurrency`, `must be a non-negative integer (got ${String(pc)})`);
  }
  const contextLifetimeSeconds = (t.contextLifetime ?? Duration.seconds(60)).toSeconds();
  if (!Number.isInteger(contextLifetimeSeconds) || contextLifetimeSeconds < 10 || contextLifetimeSeconds > 300) {
    fail(`${prop}.contextLifetime`, `must be a whole number of seconds from 10 to 300 (got ${String(contextLifetimeSeconds)})`);
  }
  const maxToolsPerGateway = t.maxToolsPerGateway ?? DEFAULT_MAX_TOOLS_PER_GATEWAY;
  if (!Number.isInteger(maxToolsPerGateway) || maxToolsPerGateway < 1 || maxToolsPerGateway > MAX_TOOLS_PER_GATEWAY_LIMIT) {
    fail(`${prop}.maxToolsPerGateway`, `must be an integer from 1 to ${MAX_TOOLS_PER_GATEWAY_LIMIT} (got ${String(maxToolsPerGateway)})`);
  }
  return {
    requestsPerSecond,
    overrides,
    interceptorProvisionedConcurrency: pc,
    contextLifetimeSeconds,
    maxToolsPerGateway,
    responseFilter: t.responseFilter ?? false,
  };
}

/** IAM tag key shape (`[\p{L}\p{Z}\p{N}_.:/=+\-@]{1,128}`), restricted here to the plain subset. */
const TAG_KEY_PATTERN = /^[A-Za-z0-9_.:/=+\-@]{1,128}$/;

/** Validates props and applies defaults; throws an Error that names the prop (standard §4.5). */
export function resolveOptions(props: SharedIngressProps, construct = 'SharedIngress'): ResolvedOptions {
  const fail = (prop: string, message: string): never => {
    throw new Error(`${construct}: ${prop} ${message}`);
  };

  if (!Token.isUnresolved(props.identity.discoveryUrl)) {
    if (!/^https:\/\/.+\/\.well-known\/openid-configuration$/.test(props.identity.discoveryUrl)) {
      fail('identity.discoveryUrl', 'must be an https URL ending in /.well-known/openid-configuration');
    }
  }
  if (props.identity.allowedClientIds.length === 0 || props.identity.allowedClientIds.some((c) => c.length === 0)) {
    fail('identity.allowedClientIds', 'must be a non-empty list of non-empty client ids');
  }
  const multiTenant = props.identity.multiTenant ?? false;
  if (typeof multiTenant !== 'boolean') {
    fail('identity.multiTenant', 'must be a boolean');
  }

  const backend = props.backend ?? 'agentcore-runtime';
  if (backend !== 'agentcore-runtime') {
    fail('backend', `must be 'agentcore-runtime' (got ${String(backend)})`);
  }
  if (props.ingress !== 'api-gateway' && props.ingress !== 'agentcore-gateway') {
    fail('ingress', `must be 'api-gateway' or 'agentcore-gateway' (got ${String(props.ingress)})`);
  }

  if ((props as { delegation?: unknown }).delegation !== undefined) {
    fail('delegation', 'is removed in v2; the agent receives a transaction token (ADR-0031)');
  }

  let sessionScope: SessionScope | undefined;
  if (props.session !== undefined) {
    // v2, ADR-0039: tenant scope by default when session mapping is on.
    sessionScope = props.session.scope ?? 'tenant';
    if (sessionScope !== 'user' && sessionScope !== 'tenant') {
      fail('session.scope', `must be 'user' or 'tenant' (got ${String(sessionScope)})`);
    }
  }

  if (props.requiredScopes !== undefined) {
    if (props.requiredScopes.length === 0 || props.requiredScopes.some((s) => s.trim().length === 0 || /\s/.test(s))) {
      fail('requiredScopes', 'must be a non-empty list of scope strings without whitespace');
    }
  }

  // The TVM is always on (ADR-0018).
  const tvmProps = props.tvm ?? {};
  const durationSeconds = tvmProps.durationSeconds ?? 900;
  if (!Number.isInteger(durationSeconds) || durationSeconds < 900 || durationSeconds > 3600) {
    fail('tvm.durationSeconds', `must be an integer from 900 to 3600 (got ${String(durationSeconds)})`);
  }
  const claimTags = tvmProps.claimTags ?? {};
  for (const [key, claim] of Object.entries(claimTags)) {
    if (key === TENANT_TAG_KEY || key === USER_TAG_KEY) {
      fail('tvm.claimTags', `${key} is a reserved tag key`);
    }
    if (!TAG_KEY_PATTERN.test(key)) {
      fail('tvm.claimTags', `tag key '${key}' is not a valid tag key`);
    }
    if (typeof claim !== 'string' || claim.length === 0) {
      fail('tvm.claimTags', `tag key '${key}' must map to a claim name`);
    }
  }
  const cacheMaxEntries = tvmProps.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  if (!Number.isInteger(cacheMaxEntries) || cacheMaxEntries < 1) {
    fail('tvm.cacheMaxEntries', `must be a positive integer (got ${String(cacheMaxEntries)})`);
  }
  const tvm: ResolvedOptions['tvm'] = {
    role: tvmProps.role,
    includeUserIdTag: tvmProps.includeUserIdTag ?? false,
    claimTags,
    durationSeconds,
    cacheMaxEntries,
  };

  let tenantLimits: ResolvedOptions['tenantLimits'];
  if (props.tenantLimits !== false) {
    const requestsPerMinute = props.tenantLimits?.requestsPerMinute ?? 60;
    const outputTokensPerMinute = props.tenantLimits?.outputTokensPerMinute;
    if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 0) {
      fail('tenantLimits.requestsPerMinute', `must be a non-negative integer (got ${String(requestsPerMinute)})`);
    }
    if (outputTokensPerMinute !== undefined) {
      if (!Number.isInteger(outputTokensPerMinute) || outputTokensPerMinute < 1) {
        fail('tenantLimits.outputTokensPerMinute', `must be a positive integer (got ${String(outputTokensPerMinute)})`);
      }
      if (props.ingress !== 'api-gateway') {
        fail('tenantLimits.outputTokensPerMinute', "is valid only with the 'api-gateway' ingress (the interceptor never sees the response)");
      }
    }
    if (requestsPerMinute > 0 || outputTokensPerMinute !== undefined) {
      tenantLimits = { requestsPerMinute, outputTokensPerMinute };
    }
  }

  const rateLimit = props.stageThrottle?.rateLimit ?? 50;
  const burstLimit = props.stageThrottle?.burstLimit ?? 25;
  if (props.stageThrottle !== undefined && props.ingress !== 'api-gateway') {
    fail('stageThrottle', "is valid only with the 'api-gateway' ingress");
  }
  if (!(rateLimit > 0) || !Number.isInteger(burstLimit) || burstLimit < 1) {
    fail('stageThrottle', 'rateLimit must be > 0 and burstLimit a positive integer');
  }

  const registryPrefix = props.registryPrefix ?? DEFAULT_REGISTRY_PREFIX;
  if (!registryPrefix.startsWith('/') || !registryPrefix.endsWith('/')) {
    fail('registryPrefix', `must start and end with / (got ${registryPrefix})`);
  }
  const registryTtlSeconds = (props.registryTtl ?? DEFAULT_REGISTRY_TTL).toSeconds();
  if (!Number.isInteger(registryTtlSeconds) || registryTtlSeconds < 1 || registryTtlSeconds > MAX_REGISTRY_TTL.toSeconds()) {
    fail('registryTtl', `must be a whole number of seconds from 1 to ${MAX_REGISTRY_TTL.toSeconds()} (got ${String(registryTtlSeconds)})`);
  }
  if (props.defaultBackend !== undefined && !BACKEND_NAME_PATTERN.test(props.defaultBackend)) {
    fail('defaultBackend', `must match ${BACKEND_NAME_PATTERN.source} (got ${props.defaultBackend})`);
  }

  // v2: the transaction token (spec §3.3).
  const txn = props.transactionToken ?? {};
  const ttlSeconds = (txn.ttl ?? DEFAULT_TRANSACTION_TOKEN_TTL).toSeconds();
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TRANSACTION_TTL_SECONDS || ttlSeconds > MAX_TRANSACTION_TTL_SECONDS) {
    fail('transactionToken.ttl', `must be a whole number of seconds from ${MIN_TRANSACTION_TTL_SECONDS} to ${MAX_TRANSACTION_TTL_SECONDS} (got ${String(ttlSeconds)})`);
  }
  const algorithm = txn.algorithm ?? 'RS256';
  if (algorithm !== 'RS256' && algorithm !== 'ES256') {
    fail('transactionToken.algorithm', `must be 'RS256' or 'ES256' (got ${String(algorithm)})`);
  }
  const keyGeneration = txn.keyGeneration ?? 1;
  if (!Number.isInteger(keyGeneration) || keyGeneration < 1) {
    fail('transactionToken.keyGeneration', `must be a positive integer (got ${String(keyGeneration)})`);
  }
  const mintCacheMaxEntries = txn.cacheMaxEntries ?? DEFAULT_MINT_CACHE_MAX_ENTRIES;
  if (!Number.isInteger(mintCacheMaxEntries) || mintCacheMaxEntries < 1) {
    fail('transactionToken.cacheMaxEntries', `must be a positive integer (got ${String(mintCacheMaxEntries)})`);
  }
  const streamSeconds = LONGEST_STREAM.toSeconds();
  const authorizerCacheTtlSeconds =
    props.ingress === 'api-gateway' ? Math.min(AUTHORIZER_CACHE_TTL.toSeconds(), Math.max(0, ttlSeconds - streamSeconds)) : 0;
  const reuseMarginSeconds = authorizerCacheTtlSeconds + streamSeconds;

  // v2: entitlements (spec §3.3).
  const adminScope = props.entitlements?.adminScope ?? DEFAULT_ADMIN_SCOPE;
  if (adminScope.length === 0 || /\s/.test(adminScope)) {
    fail('entitlements.adminScope', 'must be a scope string without whitespace');
  }
  const maxAgentsPerTenant = props.entitlements?.maxAgentsPerTenant ?? 1000;
  if (!Number.isInteger(maxAgentsPerTenant) || maxAgentsPerTenant < 1 || maxAgentsPerTenant > 1000) {
    fail('entitlements.maxAgentsPerTenant', `must be an integer from 1 to 1000 (got ${String(maxAgentsPerTenant)})`);
  }
  const maxToolsPerTenant = props.entitlements?.maxToolsPerTenant ?? 1000;
  if (!Number.isInteger(maxToolsPerTenant) || maxToolsPerTenant < 1 || maxToolsPerTenant > 1000) {
    fail('entitlements.maxToolsPerTenant', `must be an integer from 1 to 1000 (got ${String(maxToolsPerTenant)})`);
  }

  // v2: the tools gateways (spec §3.3, ADR-0041). `toolsGateway` is shorthand for `{ default: ... }`.
  const toolsGateways: Record<string, ResolvedToolsGateway> = {};
  if (props.toolsGateways !== undefined) {
    if (props.toolsGateway !== undefined) {
      fail('toolsGateway', 'and toolsGateways must not both be set; toolsGateway is shorthand for toolsGateways: { default: ... } (ADR-0041)');
    }
    const named = Object.entries(props.toolsGateways);
    if (named.length === 0) {
      fail('toolsGateways', 'must name at least one gateway; use toolsGateway: false for none');
    }
    for (const [name, t] of named) {
      if (!TOOLS_GATEWAY_NAME_PATTERN.test(name)) {
        fail('toolsGateways', `name '${name}' must match ${TOOLS_GATEWAY_NAME_PATTERN.source}`);
      }
      toolsGateways[name] = resolveToolsGateway(t ?? {}, `toolsGateways.${name}`, fail);
    }
  } else if (props.toolsGateway !== false) {
    toolsGateways[DEFAULT_TOOLS_GATEWAY] = resolveToolsGateway(props.toolsGateway ?? {}, 'toolsGateway', fail);
  }

  return {
    backend,
    ingress: props.ingress,
    multiTenant,
    sessionScope,
    requiredScopes: props.requiredScopes,
    tvm,
    tenantLimits,
    stageThrottle: { rateLimit, burstLimit },
    perTenantMetrics: props.perTenantMetrics ?? false,
    registryPrefix,
    publish: props.publish ?? true,
    registryTtlSeconds,
    defaultBackend: props.defaultBackend,
    transactionToken: { ttlSeconds, algorithm, keyGeneration, cacheMaxEntries: mintCacheMaxEntries, reuseMarginSeconds },
    authorizerCacheTtlSeconds,
    entitlements: { adminScope, maxAgentsPerTenant, maxToolsPerTenant },
    toolsGateways,
  };
}

// ---------------------------------------------------------------------------
// The construct
// ---------------------------------------------------------------------------

/** API Gateway stage name; part of `endpointUrl` on the `api-gateway` ingress and of the issuer API's URL. */
export const STAGE_NAME = 'prod';
/** Spike V-5: the integration timeout caps the stream; two minutes, not the 29 s default. */
export const INTEGRATION_TIMEOUT = Duration.minutes(2);

/** The tools gateway values a `ToolTarget` in another stack needs (published parameters). */
export interface ToolsGatewayRef {
  /** (ADR-0041) The gateway's name. Default `default`. */
  readonly name?: string;
  readonly gatewayIdentifier: string;
  readonly gatewayUrl?: string;
  readonly gatewayRoleArn: string;
  readonly policyEngineId: string;
  readonly contextKeyId: string;
}

/**
 * What `AgentBackend` and `ToolTarget` need from an ingress in another stack
 * (ADR-0024): the values `SharedIngress` publishes under its registry
 * prefix. Build one with `SharedIngress.fromParameters`.
 */
export interface SharedIngressRef {
  /** The registry prefix the ingress resolves routes through. */
  readonly registryPrefix: string;
  /** The ingress base URL. Optional. */
  readonly endpointUrl?: string;
  /** The one principal every Runtime behind this ingress trusts (P-1). */
  readonly ingressRoleArn: string;
  /** The `ri:ingress` tag value the ingress role's invoke grant is conditioned on. */
  readonly ingressId: string;
  /** Which ingress: on `'agentcore-gateway'` the backend also creates a Gateway target. */
  readonly ingress: IngressKind;
  /** The Gateway identifier; required with the `'agentcore-gateway'` ingress. */
  readonly gatewayIdentifier?: string;
  /** The tenant role every model call is signed by (ADR-0018). */
  readonly tenantRoleArn: string;
  /** (v2) The transaction-token issuer, for the agent's environment. */
  readonly issuer?: string;
  /** (v2) The entitlement store table, for the name reservations (ADR-0035). */
  readonly entitlementsTableName?: string;
  /** (v2) The `default` tools gateway; undefined when the ingress has none. */
  readonly tools?: ToolsGatewayRef;
  /** (v2, ADR-0041) Every tools gateway by name; `default` is also `tools`. */
  readonly toolsGateways?: Readonly<Record<string, ToolsGatewayRef>>;
}

/** What each ingress variant hands back to the constructor. */
interface IngressWiring {
  endpointUrl: string;
  /** The one principal every Runtime trusts (P-1). */
  ingressRole: iam.IRole;
  /** The role that validates the token and assumes the tenant role. */
  tvmCallerRole: iam.IRole;
  /** The roles that resolve routes through the registry. */
  registryReaders: iam.IRole[];
  /** The drain between this variant's writers and its log groups (ADR-0019). */
  logDrain: LogDrain;
  /** (v2) The one function that mints the transaction token. */
  minter: NodejsFunction;
  /** (v2) The REST API that serves the issuer's routes and the entitlement API. */
  issuerApi: apigateway.RestApi;
  /** (v2) `<baseUrl>`: the issuer. */
  issuer: string;
  /** (v2) Every function that needs `RI_ISSUER` (the identity-token verifiers refuse it). */
  verifiers: NodejsFunction[];
}

export class SharedIngress extends Construct {
  /**
   * Reads another stack's ingress from its published parameters (ADR-0024).
   * `ingress` must be given, and (v2) which tools gateways the ingress has
   * (`toolsGateway: false` for none, `toolsGateways` for their names,
   * default `['default']`): both decide at synth which parameters exist.
   */
  static fromParameters(
    scope: Construct,
    id: string,
    registryPrefix: string,
    ingress: IngressKind,
    options: { readonly toolsGateway?: boolean; readonly toolsGateways?: readonly string[] } = {},
  ): SharedIngressRef {
    const holder = new Construct(scope, id);
    const read = (name: string) => ssm.StringParameter.valueForStringParameter(holder, `${registryPrefix}${name}`);
    const names = options.toolsGateway === false ? [] : [...(options.toolsGateways ?? [DEFAULT_TOOLS_GATEWAY])];
    for (const name of names) {
      if (!TOOLS_GATEWAY_NAME_PATTERN.test(name)) {
        throw new Error(`SharedIngress.fromParameters: toolsGateways name '${name}' must match ${TOOLS_GATEWAY_NAME_PATTERN.source}`);
      }
    }
    const contextKeyId = names.length > 0 ? read(PUBLISHED.toolContextKeyId) : undefined;
    const toolsGateways: Record<string, ToolsGatewayRef> = {};
    for (const name of names) {
      toolsGateways[name] = {
        name,
        gatewayIdentifier: read(toolsGatewayParameter(name, 'identifier')),
        gatewayUrl: read(toolsGatewayParameter(name, 'url')),
        gatewayRoleArn: read(toolsGatewayParameter(name, 'roleArn')),
        policyEngineId: read(toolsGatewayParameter(name, 'policyEngineId')),
        contextKeyId: contextKeyId!,
      };
    }
    return {
      registryPrefix,
      ingress,
      endpointUrl: read(PUBLISHED.baseUrl),
      ingressRoleArn: read(PUBLISHED.ingressRoleArn),
      ingressId: read(PUBLISHED.ingressId),
      tenantRoleArn: read(PUBLISHED.tenantRoleArn),
      gatewayIdentifier: ingress === 'agentcore-gateway' ? read(PUBLISHED.gatewayIdentifier) : undefined,
      issuer: read(PUBLISHED.issuer),
      entitlementsTableName: read(PUBLISHED.entitlementsTableName),
      tools: toolsGateways[DEFAULT_TOOLS_GATEWAY],
      toolsGateways: names.length > 0 ? toolsGateways : undefined,
    };
  }

  /** The ingress base URL, without a route: `https://.../prod` or the Gateway URL. See `urlFor`. */
  readonly endpointUrl: string;
  /** The one principal every backend trusts (P-1): the integration Lambda's role, or the Gateway's role. */
  readonly ingressRole: iam.IRole;
  /** The role that validates the token and assumes the tenant role: the integration Lambda or the interceptor. */
  readonly tvmCallerRole: iam.IRole;
  /** The tenant role every model call is signed by (ADR-0018). */
  readonly tenantRole: iam.IRole;
  /** The resolved options, for consumers and tests. */
  readonly options: ResolvedOptions;
  /** The per-tenant usage counters (ADR-0020); undefined when `tenantLimits` is `false`. */
  readonly limitsTable?: dynamodb.TableV2;
  /** The registry prefix (ADR-0024). */
  readonly registryPrefix: string;
  /** This ingress's `ri:ingress` tag value (ADR-0024). */
  readonly ingressId: string;
  /** The Gateway identifier (`agentcore-gateway` only), for `AgentBackend` targets. */
  readonly gatewayIdentifier?: string;
  /** The log drain (ADR-0019) between this ingress's writers and its log groups. */
  readonly logDrain: LogDrain;
  /** (v2, ADR-0037) The transaction-token issuer: `<baseUrl>` of the REST API that serves the discovery routes. */
  readonly issuer: string;
  /** (v2) `<issuer>/.well-known/jwks.json`. */
  readonly jwksUrl: string;
  /** (v2, C-13) */
  readonly tokenSigner: TokenSigner;
  /** (v2, C-12) */
  readonly entitlementStore: EntitlementStore;
  /** (v2, C-14) `<baseUrl>/entitlements`. */
  readonly entitlementsApiUrl: string;
  /** (v2, C-15, ADR-0041) Every tools gateway by name; empty with `toolsGateway: false`. */
  readonly toolsGateways: Readonly<Record<string, ToolsGateway>>;
  /** (v2) The `default` tools gateway, when there is one. */
  readonly toolsGateway?: ToolsGateway;
  /** (v2) Aliases of the `default` gateway's values. */
  readonly toolsGatewayUrl?: string;
  readonly toolsGatewayIdentifier?: string;
  readonly toolsGatewayRole?: iam.IRole;
  /**
   * (v2, M-68) The one key that signs tool contexts, for every gateway of
   * this ingress; undefined with no gateway.
   */
  readonly toolContextKey?: kms.Key;

  private readonly grantedModels = new Set<string>();

  constructor(scope: Construct, id: string, props: SharedIngressProps) {
    super(scope, id);
    const options = resolveOptions(props);
    this.options = options;
    this.registryPrefix = options.registryPrefix;
    this.ingressId = Names.uniqueResourceName(this, { maxLength: 48, separator: '-' }).toLowerCase();

    const tenantRoleArn = options.tvm.role?.roleArn ?? Lazy.string({ produce: () => this.tenantRole.roleArn });

    if (options.tenantLimits !== undefined) {
      this.limitsTable = new dynamodb.TableV2(this, 'TenantLimits', {
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        timeToLiveAttribute: 'expiresAt',
        removalPolicy: RemovalPolicy.DESTROY, // counters only, gone within minutes anyway
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      });
    }
    // v2, C-12: the entitlement store, created before the functions that read it.
    this.entitlementStore = new EntitlementStore(this, 'Entitlements', {
      maxAgentsPerTenant: options.entitlements.maxAgentsPerTenant,
      maxToolsPerTenant: options.entitlements.maxToolsPerTenant,
    });
    const environment = ingressEnvironment(props, options, tenantRoleArn, this.limitsTable?.tableName, Stack.of(this).account);

    if (options.perTenantMetrics) {
      Annotations.of(this).addWarningV2(
        'runtime-isolation:per-tenant-metrics-cost',
        'perTenantMetrics is on: each tenant adds about 9 CloudWatch custom metrics per ingress, billed monthly (10,000 tenants is about 90,000 metrics). The ingress log carries the same figures with the tenantId; prefer Logs Insights or Contributor Insights at scale (ADR-0021).',
      );
    }

    const wiring = options.ingress === 'api-gateway' ? this.apiGatewayIngress(props, options, environment) : this.agentCoreGatewayIngress(props, options, environment);
    this.endpointUrl = wiring.endpointUrl;
    this.ingressRole = wiring.ingressRole;
    this.tvmCallerRole = wiring.tvmCallerRole;
    this.logDrain = wiring.logDrain;
    this.issuer = wiring.issuer;
    this.jwksUrl = `${this.issuer}/${WELL_KNOWN.segment}/${WELL_KNOWN.jwks}`;
    this.entitlementsApiUrl = `${this.issuer}/entitlements`;

    this.grantInvokeTaggedRuntimes(this.ingressRole);
    for (const reader of wiring.registryReaders) {
      this.grantReadRegistry(reader);
    }

    // v2, C-13: the signing key, Sign for the minting function alone (M-40).
    this.tokenSigner = new TokenSigner(this, 'TokenSigner', {
      algorithm: options.transactionToken.algorithm,
      keyGeneration: options.transactionToken.keyGeneration,
      signer: wiring.minter.role!,
    });
    this.tokenSigner.addDiscoveryRoutes(wiring.issuerApi, this.issuer);
    for (const fn of wiring.verifiers) {
      fn.addEnvironment(ENV.ISSUER, this.issuer);
    }
    const mintEnv: Record<string, string> = {
      [ENV.TXN_KEY_ID]: this.tokenSigner.keyId,
      [ENV.TXN_ALGORITHM]: options.transactionToken.algorithm,
      [ENV.TXN_TTL_SECONDS]: String(options.transactionToken.ttlSeconds),
      [ENV.TXN_REUSE_MARGIN_SECONDS]: String(options.transactionToken.reuseMarginSeconds),
      [ENV.TXN_CACHE_MAX_ENTRIES]: String(options.transactionToken.cacheMaxEntries),
      [ENV.INGRESS_ROLE_ARN]: this.ingressRole.roleArn,
      [ENV.ENTITLEMENTS_TABLE]: this.entitlementStore.tableName,
    };
    for (const [key, value] of Object.entries(mintEnv)) {
      wiring.minter.addEnvironment(key, value);
    }
    // M-44: the minting role reads the store and never writes it.
    this.entitlementStore.grantIngressRead(wiring.minter.role!);

    // v2, C-14: the entitlement API on the issuer's REST API.
    new EntitlementApi(this, 'EntitlementApi', {
      api: wiring.issuerApi,
      store: this.entitlementStore,
      discoveryUrl: props.identity.discoveryUrl,
      allowedClientIds: props.identity.allowedClientIds,
      multiTenant: options.multiTenant,
      adminScope: options.entitlements.adminScope,
      issuer: this.issuer,
      logDrain: this.logDrain,
    });

    // v2, C-15, ADR-0041: the tools gateways, after the discovery routes are deployed (the service fetches them).
    // One ToolContextKey for every gateway, not one each: a tool function verifies `_ri_ctx`
    // with one public key (`RI_CONTEXT_KEY_ID`) and one published `toolContextKeyId`, whichever
    // gateway its target is on; a context is bound to its tool, argsHash, txn and a 60 s exp,
    // and a tool lives on one gateway, so a per-gateway key would add keys without narrowing
    // what a stolen context could reach. Each interceptor gets its own Sign statement (M-68).
    const gateways: Record<string, ToolsGateway> = {};
    const names = Object.keys(options.toolsGateways);
    if (names.length > 0) {
      this.toolContextKey = signingKey(this, 'ToolContextKey', kms.KeySpec.RSA_2048, 'runtime-isolation tool context signing key, shared by the tools gateways (ADR-0034, ADR-0041)', {
        delegatePublicKey: true, // the tool library in another stack reads the public half through IAM (M-68)
      });
    }
    for (const name of names) {
      gateways[name] = new ToolsGateway(this, name === DEFAULT_TOOLS_GATEWAY ? 'ToolsGateway' : `ToolsGateway${gatewayIdPart(name)}`, {
        name,
        issuer: this.issuer,
        ingressRoleArn: this.ingressRole.roleArn,
        options: options.toolsGateways[name],
        contextKey: this.toolContextKey!,
        issuerReady: wiring.issuerApi.deploymentStage,
      });
    }
    this.toolsGateways = gateways;
    this.toolsGateway = gateways[DEFAULT_TOOLS_GATEWAY];
    if (this.toolsGateway !== undefined) {
      this.toolsGatewayUrl = this.toolsGateway.gatewayUrl;
      this.toolsGatewayIdentifier = this.toolsGateway.gatewayIdentifier;
      this.toolsGatewayRole = this.toolsGateway.gatewayRole;
    }

    if (this.limitsTable !== undefined) {
      this.tvmCallerRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'CountTenantUsage',
          actions: ['dynamodb:UpdateItem'],
          resources: [this.limitsTable.tableArn],
        }),
      );
    }

    this.tenantRole = options.tvm.role ?? this.defaultTenantRole(options);
    this.tvmCallerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeTenantRole',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.tenantRole.roleArn],
      }),
    );

    if (options.publish) {
      this.publish(options);
    }
  }

  /** The invocation URL of one backend behind this ingress (spec §5): `${endpointUrl}/${backend}/invocations`. */
  urlFor(backend: string): string {
    if (!Token.isUnresolved(backend) && !BACKEND_NAME_PATTERN.test(backend)) {
      throw new Error(`SharedIngress.urlFor: backend must match ${BACKEND_NAME_PATTERN.source} (got ${backend})`);
    }
    return `${this.endpointUrl}/${backend}/${ROUTE}`;
  }

  /** (v2, ADR-0041) The tools gateway named `name`, or undefined. */
  toolsGatewayNamed(name: string): ToolsGateway | undefined {
    return Object.prototype.hasOwnProperty.call(this.toolsGateways, name) ? this.toolsGateways[name] : undefined;
  }

  /**
   * Adds the one-model statement for `modelId` to the tenant role (ADR-0018).
   * Idempotent per model id.
   */
  grantModel(modelId: string): void {
    if (this.grantedModels.has(modelId)) {
      return;
    }
    this.grantedModels.add(modelId);
    const sid = this.grantedModels.size === 1 ? 'OneModel' : `OneModel${this.grantedModels.size}`;
    addModelStatement(this, this.tenantRole, modelId, sid);
  }

  /**
   * ADR-0024: the ingress role may invoke any Runtime of this account and
   * Region that carries `ri:ingress = <ingressId>`. The Runtime's resource
   * policy (P-1, ADR-0001) remains the hard gate.
   */
  private grantInvokeTaggedRuntimes(role: iam.IRole): void {
    const stack = Stack.of(this);
    const runtimes = `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:runtime/*`;
    const endpoints = `${runtimes}/runtime-endpoint/*`;
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeTaggedRuntimes',
        actions: [INVOKE_ACTION],
        resources: [runtimes, endpoints],
        conditions: { StringEquals: { [`aws:ResourceTag/${INGRESS_TAG_KEY}`]: this.ingressId } },
      }),
    );
    const reason =
      'InvokeAgentRuntime on the Runtime ARN pattern and its endpoint form, conditioned on the ri:ingress tag this ingress alone sets through AgentBackend; backends register without an ingress deploy, so the grant cannot be a list. Each Runtime resource policy still names this one role (P-1, ADR-0001, ADR-0024).';
    acknowledgeGranularFinding(role, `AwsSolutions-IAM5[Resource::${nagFindingResource(this, runtimes)}]`, reason);
    acknowledgeGranularFinding(role, `AwsSolutions-IAM5[Resource::${nagFindingResource(this, endpoints)}]`, reason);
  }

  /** ADR-0024: a route resolver may read registry entries under the prefix, and nothing else in Parameter Store. */
  private grantReadRegistry(role: iam.IRole): void {
    const stack = Stack.of(this);
    const entries = `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${this.registryPrefix}${REGISTRY_BACKENDS_SEGMENT}*`;
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadBackendRegistry',
        actions: ['ssm:GetParameter'],
        resources: [entries],
      }),
    );
    acknowledgeGranularFinding(
      role,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, entries)}]`,
      'The ingress resolves backend names it learns at request time, so it reads any entry under its registry prefix and nothing outside it; backends write their own entry from their own role (ADR-0024).',
    );
  }

  /** The published interface (spec §6.4, standard §1.1), under the registry prefix. */
  private publish(options: ResolvedOptions): void {
    const put = (id: string, name: string, value: string, description: string) =>
      new ssm.StringParameter(this, id, {
        parameterName: `${this.registryPrefix}${name}`,
        simpleName: false,
        stringValue: value,
        description: `runtime-isolation: ${description}`,
      });
    const defaultBackendUrl =
      options.defaultBackend === undefined
        ? this.endpointUrl
        : options.ingress === 'api-gateway'
          ? `${this.endpointUrl}/${ROUTE}`
          : this.urlFor(options.defaultBackend);
    put('EndpointUrlParameter', PUBLISHED.endpointUrl, defaultBackendUrl, 'the invocation URL (POST, bearer token): the default backend when one is set, else the ingress base URL');
    put('BaseUrlParameter', PUBLISHED.baseUrl, this.endpointUrl, 'the ingress base URL; a backend is at <url>/<backend>/invocations');
    put('IngressRoleArnParameter', PUBLISHED.ingressRoleArn, this.ingressRole.roleArn, 'the one principal every Runtime behind this ingress trusts (P-1)');
    put('IngressIdParameter', PUBLISHED.ingressId, this.ingressId, 'the ri:ingress tag value a Runtime must carry (ADR-0024)');
    put('IngressParameter', PUBLISHED.ingress, options.ingress, 'the deployed ingress (api-gateway or agentcore-gateway)');
    put('TenantRoleArnParameter', PUBLISHED.tenantRoleArn, this.tenantRole.roleArn, 'the tenant role every model call is signed by (ADR-0018)');
    if (this.gatewayIdentifier !== undefined) {
      put('GatewayIdentifierParameter', PUBLISHED.gatewayIdentifier, this.gatewayIdentifier, 'the AgentCore Gateway a backend adds its target to (ADR-0010)');
    }
    // v2 (spec §6.4)
    put('IssuerParameter', PUBLISHED.issuer, this.issuer, 'the transaction-token issuer URL (ADR-0037)');
    put('JwksUrlParameter', PUBLISHED.jwksUrl, this.jwksUrl, 'the transaction-token JWKS URL (ADR-0037)');
    put('EntitlementsTableNameParameter', PUBLISHED.entitlementsTableName, this.entitlementStore.tableName, 'the entitlement store table, for name reservations (ADR-0035)');
    put('EntitlementsApiUrlParameter', PUBLISHED.entitlementsApiUrl, this.entitlementsApiUrl, 'the entitlement API base URL (ADR-0030)');
    // ADR-0041: tools-gateways/<name>/{url,identifier,roleArn,policyEngineId} per gateway.
    for (const [name, gw] of Object.entries(this.toolsGateways)) {
      const part = gatewayIdPart(name);
      put(`ToolsGateway${part}UrlParameter`, toolsGatewayParameter(name, 'url'), gw.gatewayUrl, `the tools gateway ${name} MCP endpoint (ADR-0041)`);
      put(`ToolsGateway${part}IdentifierParameter`, toolsGatewayParameter(name, 'identifier'), gw.gatewayIdentifier, `the tools gateway ${name} id, for ToolTarget (ADR-0041)`);
      put(`ToolsGateway${part}RoleArnParameter`, toolsGatewayParameter(name, 'roleArn'), gw.gatewayRole.roleArn, `the tools gateway ${name} role a tool function trusts (ADR-0041)`);
      put(`ToolsGateway${part}PolicyEngineIdParameter`, toolsGatewayParameter(name, 'policyEngineId'), gw.policyEngine.attrPolicyEngineId, `the tools gateway ${name} policy engine, for ToolTarget policies (ADR-0041)`);
    }
    if (this.toolContextKey !== undefined) {
      put('ToolContextKeyIdParameter', PUBLISHED.toolContextKeyId, this.toolContextKey.keyId, 'the key that signs tool contexts for every tools gateway; tools read its public half (ADR-0034, ADR-0041)');
    }
    // The pre-ADR-0041 names, kept as aliases of the `default` gateway.
    if (this.toolsGateway !== undefined) {
      put('ToolsGatewayUrlParameter', PUBLISHED.toolsGatewayUrl, this.toolsGateway.gatewayUrl, 'alias of tools-gateways/default/url: the default tools gateway MCP endpoint (ADR-0034)');
      put('ToolsGatewayIdentifierParameter', PUBLISHED.toolsGatewayIdentifier, this.toolsGateway.gatewayIdentifier, 'alias of tools-gateways/default/identifier (ADR-0034)');
      put('ToolsGatewayRoleArnParameter', PUBLISHED.toolsGatewayRoleArn, this.toolsGateway.gatewayRole.roleArn, 'alias of tools-gateways/default/roleArn (ADR-0034)');
      put('ToolsPolicyEngineIdParameter', PUBLISHED.toolsPolicyEngineId, this.toolsGateway.policyEngine.attrPolicyEngineId, 'alias of tools-gateways/default/policyEngineId (ADR-0040)');
    }
  }

  /** The default tenant role (ADR-0018): trusted by `tvmCallerRole` only, `TenantId` tag required; model statements only. */
  private defaultTenantRole(options: ResolvedOptions): iam.Role {
    const tagKeys = [TENANT_TAG_KEY];
    if (options.tvm.includeUserIdTag) {
      tagKeys.push(USER_TAG_KEY);
    }
    tagKeys.push(...Object.keys(options.tvm.claimTags));
    return new iam.Role(this, 'TenantModelRole', {
      description: 'Default tenant role (ADR-0018): assumable only by tvmCallerRole with a TenantId session tag; may invoke only the backends\' models',
      assumedBy: new iam.ArnPrincipal(this.tvmCallerRole.roleArn)
        .withConditions({
          'StringLike': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: '?*' },
          'ForAllValues:StringEquals': { 'aws:TagKeys': tagKeys },
        })
        .withSessionTags(),
      maxSessionDuration: Duration.hours(1),
    });
  }

  /** A stage access log and the cdk-nag acknowledgments every REST API of this construct shares. */
  private restApi(id: string, description: string, deployOptions: Partial<apigateway.StageOptions>, accessLogs: logs.LogGroup): apigateway.RestApi {
    const api = new apigateway.RestApi(this, id, {
      restApiName: `${Names.uniqueResourceName(this, { maxLength: 40, separator: '-' })}-${id.toLowerCase()}`,
      description,
      // The account-level API Gateway CloudWatch role must already exist (README prerequisites).
      cloudWatchRole: false,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: STAGE_NAME,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: apigateway.AccessLogField.contextRequestId(),
            ip: apigateway.AccessLogField.contextIdentitySourceIp(),
            requestTime: apigateway.AccessLogField.contextRequestTime(),
            httpMethod: apigateway.AccessLogField.contextHttpMethod(),
            resourcePath: apigateway.AccessLogField.contextResourcePath(),
            status: apigateway.AccessLogField.contextStatus(),
            protocol: apigateway.AccessLogField.contextProtocol(),
            responseLength: apigateway.AccessLogField.contextResponseLength(),
            responseLatency: apigateway.AccessLogField.contextResponseLatency(),
            principalId: apigateway.AccessLogField.contextAuthorizerPrincipalId(),
            tenantId: apigateway.AccessLogField.contextAuthorizer('tenantId'),
          }),
        ),
        // P-9, M-12, M-67: data trace logs request headers, which would record a bearer token.
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        tracingEnabled: true,
        metricsEnabled: true,
        ...deployOptions,
      },
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG3',
      reason: 'WAFv2 association is production hardening (README checklist, ADR-0014): every route is authorised (Lambda authoriser, IAM or in-function token verification) or public by design (ADR-0037), and the stage is throttled.',
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-COG4',
      reason: 'The routes use a custom Lambda authoriser, IAM, or in-function verification by the shared verifier rather than a Cognito authoriser, so the construct accepts any OIDC issuer that meets the token contract (ADR-0004).',
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG4',
      reason: 'Every route is authorised: the custom Lambda authoriser (P-3, ADR-0001), IAM (vendor entitlement operations, ADR-0030), the tenant-admin function\'s own verification (ADR-0033), or public by design (discovery and JWKS, ADR-0037).',
    });
    const executionLogs = new logs.LogGroup(this, `${id}ExecutionLogs`, {
      logGroupName: `API-Gateway-Execution-Logs_${api.restApiId}/${STAGE_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    void executionLogs;
    return api;
  }

  // -------------------------------------------------------------------------
  // Ingress A: API Gateway REST API, Lambda authoriser, streaming Lambda proxy
  // -------------------------------------------------------------------------
  private apiGatewayIngress(props: SharedIngressProps, options: ResolvedOptions, environment: Record<string, string>): IngressWiring {
    const authorizerFn = new NodejsFunction(this, 'AuthorizerFunction', {
      ...functionProps(this, 'AuthorizerLogs', Duration.seconds(10)),
      entry: path.join(__dirname, 'ingress', 'api-gateway-authorizer.function.ts'),
      description: 'runtime-isolation: verifies the identity token, selects the tenant, resolves the backend, applies the grant rule and mints the transaction token (P-3, P-11, P-14)',
      memorySize: 512,
      environment,
    });
    acknowledgeLambdaFindings(authorizerFn);

    const ingressFn = new NodejsFunction(this, 'IngressFunction', {
      ...functionProps(this, 'IngressLogs', INTEGRATION_TIMEOUT.plus(Duration.seconds(30))),
      entry: path.join(__dirname, 'ingress', 'api-gateway-ingress.function.ts'),
      description: 'runtime-isolation: chooses the unit from validated claims, forwards the transaction token and relays the backend stream (P-2, P-5)',
      memorySize: 512,
      environment,
    });
    acknowledgeLambdaFindings(ingressFn);

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const api = this.restApi(
      'Api',
      'runtime-isolation ingress: POST /{backend}/invocations, bearer token verified by a Lambda authoriser (ADR-0024); issuer routes (ADR-0037); entitlement API (ADR-0030)',
      { throttlingRateLimit: options.stageThrottle.rateLimit, throttlingBurstLimit: options.stageThrottle.burstLimit },
      accessLogs,
    );

    const identitySources = [apigateway.IdentitySource.header('Authorization'), apigateway.IdentitySource.context('path')];
    if (options.multiTenant) {
      // The cached Allow is for one tenant; a second tenant of the same token must not reuse it (M-53).
      identitySources.push(apigateway.IdentitySource.header(TENANT_HEADER));
    }
    const authorizer = new apigateway.RequestAuthorizer(this, 'Authorizer', {
      handler: authorizerFn,
      identitySources,
      // (v2) at most 60 s and at most ttl - longest stream: the Allow carries a minted token.
      resultsCacheTtl: Duration.seconds(options.authorizerCacheTtlSeconds),
    });
    // spec §5.1: the Deny's fixed reason code, when the authoriser set one.
    api.addGatewayResponse('AccessDenied', {
      type: apigateway.ResponseType.ACCESS_DENIED,
      statusCode: '403',
      templates: {
        'application/json': '#if($context.authorizer.reason != "")forbidden: $context.authorizer.reason#{else}forbidden#end',
      },
    });

    const bodyModel = api.addModel('InvokeModel', {
      contentType: 'application/json',
      modelName: 'InvokeAgentRequest',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        additionalProperties: false,
        required: options.sessionScope !== undefined ? ['prompt', 'conversationId'] : ['prompt'],
        properties: {
          prompt: { type: apigateway.JsonSchemaType.STRING },
          ...(options.sessionScope !== undefined
            ? { conversationId: { type: apigateway.JsonSchemaType.STRING, pattern: CONVERSATION_ID_PATTERN.source } }
            : {}),
        },
      },
    });
    const validator = api.addRequestValidator('BodyValidator', {
      requestValidatorName: 'body',
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    const integration = () =>
      new apigateway.LambdaIntegration(ingressFn, {
        proxy: true,
        responseTransferMode: apigateway.ResponseTransferMode.STREAM,
        timeout: INTEGRATION_TIMEOUT,
      });
    const methodOptions: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      requestValidator: validator,
      requestModels: { 'application/json': bodyModel },
    };
    api.root
      .addResource('{backend}')
      .addResource(ROUTE)
      .addMethod('POST', integration(), { ...methodOptions, requestParameters: { 'method.request.path.backend': true } });
    if (options.defaultBackend !== undefined) {
      api.root.addResource(ROUTE).addMethod('POST', integration(), methodOptions);
    }

    const executionLogs = this.node.findChild('ApiExecutionLogs') as logs.LogGroup;
    const drain = new LogDrain(this, 'LogDrain');
    for (const group of [accessLogs, executionLogs, authorizerFn.logGroup, ingressFn.logGroup]) {
      drain.protect(group);
    }
    drain.writer(api.deploymentStage);

    const stack = Stack.of(this);
    // The stage name as a literal, not `deploymentStage.stageName`: the issuer
    // URL is rendered into the discovery route, and a Ref to the stage there
    // would make the deployment depend on itself.
    const endpointUrl = `https://${api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}/${STAGE_NAME}`;
    return {
      endpointUrl,
      ingressRole: ingressFn.role!,
      tvmCallerRole: ingressFn.role!,
      registryReaders: [authorizerFn.role!, ingressFn.role!],
      logDrain: drain,
      minter: authorizerFn,
      issuerApi: api,
      issuer: endpointUrl,
      verifiers: [authorizerFn, ingressFn],
    };
  }

  // -------------------------------------------------------------------------
  // Ingress B: AgentCore Gateway with a REQUEST interceptor; targets come from AgentBackend
  // -------------------------------------------------------------------------
  private agentCoreGatewayIngress(
    props: SharedIngressProps,
    options: ResolvedOptions,
    environment: Record<string, string>,
  ): IngressWiring {
    const interceptorFn = new NodejsFunction(this, 'InterceptorFunction', {
      ...functionProps(this, 'InterceptorLogs', Duration.seconds(10)),
      entry: path.join(__dirname, 'ingress', 'gateway-interceptor.function.ts'),
      description: 'runtime-isolation: Gateway REQUEST interceptor; selects the tenant, mints the transaction token, builds the unit id (P-2, P-14)',
      memorySize: 512,
      environment,
    });
    acknowledgeLambdaFindings(interceptorFn);

    const stack = Stack.of(this);
    const gatewayName = `${Names.uniqueResourceName(this, { maxLength: 40, separator: '-' })}-gw`.toLowerCase();
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:gateway/${gatewayName}-*` },
        },
      }),
      description: 'AgentCore Gateway role: the one principal every Runtime behind this ingress trusts (ADR-0001, ADR-0024)',
    });
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeInterceptor',
        actions: ['lambda:InvokeFunction'],
        resources: [interceptorFn.functionArn],
      }),
    );

    const gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: gatewayName,
      description: 'runtime-isolation ingress: CUSTOM_JWT inbound, REQUEST interceptor, one Runtime target per backend (ADR-0024)',
      roleArn: gatewayRole.roleArn,
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: props.identity.discoveryUrl,
          allowedClients: props.identity.allowedClientIds,
          // ADR-0005: CUSTOM_JWT's allowedScopes is ANY-OF; the interceptor enforces the floor again (AND).
          ...(options.requiredScopes !== undefined ? { allowedScopes: options.requiredScopes } : {}),
        },
      },
      interceptorConfigurations: [
        {
          interceptor: { lambda: { arn: interceptorFn.functionArn } },
          interceptionPoints: ['REQUEST'],
          // The Authorization, session and (v2) X-Tenant-Id headers (spike V-3).
          inputConfiguration: { passRequestHeaders: true },
        },
      ],
    });
    gateway.node.addDependency(gatewayRole);
    (this as { gatewayIdentifier?: string }).gatewayIdentifier = gateway.attrGatewayIdentifier;

    // v2, C-13/C-14: a small REST API for the issuer routes and the entitlement API.
    const accessLogs = new logs.LogGroup(this, 'IssuerAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const issuerApi = this.restApi(
      'IssuerApi',
      'runtime-isolation issuer: OIDC discovery and JWKS (ADR-0037) and the entitlement API (ADR-0030) beside the AgentCore Gateway ingress',
      { throttlingRateLimit: 50, throttlingBurstLimit: 25 },
      accessLogs,
    );
    // AwsSolutions-APIG2: the only bodies on this API are the entitlement operations, validated by the Smithy SSDK.
    Validations.of(issuerApi).acknowledge({
      id: 'AwsSolutions-APIG2',
      reason: 'The entitlement operations validate their bodies in the Smithy-generated server SDK (model constraints, ValidationException); the discovery routes take no input (ADR-0030, ADR-0037).',
    });

    const drain = new LogDrain(this, 'LogDrain');
    drain.protect(interceptorFn.logGroup);
    drain.protect(accessLogs);
    drain.protect(this.node.findChild('IssuerApiExecutionLogs') as logs.LogGroup);
    drain.writer(gateway);
    drain.writer(issuerApi.deploymentStage);

    const issuer = `https://${issuerApi.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}/${STAGE_NAME}`;
    return {
      endpointUrl: gateway.attrGatewayUrl,
      ingressRole: gatewayRole,
      tvmCallerRole: interceptorFn.role!,
      registryReaders: [interceptorFn.role!],
      logDrain: drain,
      minter: interceptorFn,
      issuerApi,
      issuer,
      verifiers: [interceptorFn],
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The names under the registry prefix that `SharedIngress` publishes (spec §6.4). */
export const PUBLISHED = {
  endpointUrl: 'endpointUrl',
  baseUrl: 'baseUrl',
  ingressRoleArn: 'ingressRoleArn',
  ingressId: 'ingressId',
  ingress: 'ingress',
  tenantRoleArn: 'tenantRoleArn',
  gatewayIdentifier: 'gatewayIdentifier',
  /** (v2) */
  issuer: 'issuer',
  jwksUrl: 'jwksUrl',
  entitlementsTableName: 'entitlementsTableName',
  entitlementsApiUrl: 'entitlementsApiUrl',
  toolsGatewayUrl: 'toolsGatewayUrl',
  toolsGatewayIdentifier: 'toolsGatewayIdentifier',
  /** (v2, not yet in spec §6.4) what a ToolTarget in another stack needs. */
  toolsGatewayRoleArn: 'toolsGatewayRoleArn',
  toolsPolicyEngineId: 'toolsPolicyEngineId',
  toolContextKeyId: 'toolContextKeyId',
} as const;

/** (ADR-0041) The segment of the per-gateway published values: `tools-gateways/<name>/<field>`. */
export const TOOLS_GATEWAYS_SEGMENT = 'tools-gateways/';

/** The per-gateway published values (ADR-0041). */
export type ToolsGatewayParameterField = 'url' | 'identifier' | 'roleArn' | 'policyEngineId';
/** Every per-gateway field, in publishing order. */
export const TOOLS_GATEWAY_PARAMETER_FIELDS: readonly ToolsGatewayParameterField[] = ['url', 'identifier', 'roleArn', 'policyEngineId'];

/** The published name of one tools gateway value, under the registry prefix: `tools-gateways/<name>/<field>`. */
export function toolsGatewayParameter(name: string, field: ToolsGatewayParameterField): string {
  return `${TOOLS_GATEWAYS_SEGMENT}${name}/${field}`;
}

/** Adds one model statement to a tenant role (ADR-0018). */
export function addModelStatement(scope: Construct, role: iam.IRole, modelId: string, sid: string): void {
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: modelResourceArns(modelId),
    }),
  );
  if (isInferenceProfileId(modelId)) {
    acknowledgeGranularFinding(
      role,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(scope, foundationModelArn('*', baseModelId(modelId)))}]`,
      'A cross-Region inference profile routes the call to the model in any Region of its set, so the foundation-model ARN names one model with a Region wildcard; the profile ARN itself is exact (ADR-0018, ADR-0028).',
    );
  }
}

/** The ingress Lambdas' environment (src/shared/config.ts): every option, backend-neutral; no Runtime ARN (ADR-0024). */
function ingressEnvironment(
  props: SharedIngressProps,
  options: ResolvedOptions,
  tenantRoleArn: string,
  limitsTableName: string | undefined,
  registryAccount: string,
): Record<string, string> {
  const env: Record<string, string> = {
    [ENV.INGRESS]: options.ingress,
    [ENV.DISCOVERY_URL]: props.identity.discoveryUrl,
    [ENV.ALLOWED_CLIENT_IDS]: props.identity.allowedClientIds.join(','),
    [ENV.MULTI_TENANT]: String(options.multiTenant),
  };
  if (options.requiredScopes !== undefined) {
    env[ENV.REQUIRED_SCOPES] = options.requiredScopes.join(',');
  }
  if (options.sessionScope !== undefined) {
    env[ENV.SESSION_SCOPE] = options.sessionScope;
  }
  env[ENV.TVM_ROLE_ARN] = tenantRoleArn;
  env[ENV.TVM_INCLUDE_USER_ID_TAG] = String(options.tvm.includeUserIdTag);
  env[ENV.TVM_CLAIM_TAGS] = JSON.stringify(options.tvm.claimTags);
  env[ENV.TVM_DURATION_SECONDS] = String(options.tvm.durationSeconds);
  env[ENV.TVM_CACHE_MAX_ENTRIES] = String(options.tvm.cacheMaxEntries);
  if (options.tenantLimits !== undefined && limitsTableName !== undefined) {
    env[ENV.LIMITS_TABLE] = limitsTableName;
    env[ENV.LIMIT_REQUESTS_PER_MINUTE] = String(options.tenantLimits.requestsPerMinute);
    if (options.tenantLimits.outputTokensPerMinute !== undefined) {
      env[ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE] = String(options.tenantLimits.outputTokensPerMinute);
    }
  }
  env[ENV.PER_TENANT_METRICS] = String(options.perTenantMetrics);
  env[ENV.REGISTRY_PREFIX] = options.registryPrefix;
  env[ENV.REGISTRY_TTL_SECONDS] = String(options.registryTtlSeconds);
  env[ENV.REGISTRY_ACCOUNT] = registryAccount;
  if (options.defaultBackend !== undefined) {
    env[ENV.DEFAULT_BACKEND] = options.defaultBackend;
  }
  return env;
}

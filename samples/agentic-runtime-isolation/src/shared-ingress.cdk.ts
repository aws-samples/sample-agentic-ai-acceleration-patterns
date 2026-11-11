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
 * the log drain (ADR-0019) and the published parameter (ADR-0042). (v2) Also the
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
import { Annotations, CfnResource, Duration, Lazy, Names, RemovalPolicy, Stack, Token, Validations } from 'aws-cdk-lib';
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
import {
  DEFAULT_MINT_CACHE_MAX_ENTRIES,
  DEFAULT_TOOLS_GATEWAY,
  MAX_DELEGATION_DEPTH,
  MAX_TRANSACTION_TTL_SECONDS,
  MIN_TRANSACTION_TTL_SECONDS,
  TOOLS_GATEWAY_NAME_PATTERN,
} from './shared/mint';
import { acknowledgeGranularFinding, nagFindingResource } from './shared/nag';
import { BACKEND_NAME_PATTERN, DELEGATION_ROUTE, INGRESS_TAG_KEY, REGISTRY_BACKENDS_SEGMENT, ROUTE } from './shared/registry';
import { LONGEST_STREAM, MAX_DRAIN } from './shared/registry-entry.cdk';
import { CONVERSATION_ID_PATTERN, type SessionScope } from './shared/session';
import { TENANT_HEADER, TENANT_ID_PATTERN } from './shared/tenant';
import { KEY_SPEC, signingKey, TokenSigner, WELL_KNOWN } from './shared/token-signer.cdk';
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
  /** Bound on `agents` in a tenant or plan row. Default 1000. */
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
<<<<<<< HEAD
/** Authoriser cache misses one reserved concurrency unit serves per second (a call is about 50 ms; ADR-0049). */
const AUTHORIZER_CALLS_PER_UNIT_SECOND = 20;
=======
/**
 * Authoriser cache misses one reserved concurrency unit serves per second in
 * a burst (ADR-0049). A warm call is about 20 ms, but a refresh burst lands
 * on a fleet that has to grow for it, and a new instance pays its init
 * (discovery, JWKS, the first DynamoDB and KMS calls): the burst minute's
 * p99 was 900 ms in the 2026-11-11 stress run. One unit therefore serves
 * about one miss a second while the burst lasts, not twenty.
 */
const AUTHORIZER_CALLS_PER_UNIT_SECOND = 1;
>>>>>>> 0f092ce (Agentic runtime isolation: ADR-0048 amended, the authoriser reserve is sized for cold-start bursts (F-17); large-tier S1/S6 rerun results)

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
  /**
   * The shared stage throttle on the `api-gateway` ingress. Default 50 rps,
   * burst 25, and a synth warning when left unset: the stage is one bucket
   * for every tenant and every refusal, and the per-tenant limit runs behind
   * it, so size it to tenants x `tenantLimits.requestsPerMinute` / 60 (scale
   * review 2026-11-05).
   */
  readonly stageThrottle?: StageThrottleProps;
  /**
   * Reserved concurrency for the `api-gateway` integration Lambda, which is
   * held for the whole stream (up to 2 minutes). Unset, it draws on the
   * account pool with the authoriser, the tools interceptors and every tool
   * function, and a burst of long streams starves them (scale review
   * 2026-11-05). Concurrency needed is about rps x average stream seconds.
   * Reserving here takes from the account pool the authoriser draws on:
   * set `authorizerReservedConcurrency` with it (ADR-0049).
   */
  readonly ingressReservedConcurrency?: number;
  /**
   * Reserved concurrency for the `api-gateway` REQUEST authoriser (ADR-0049).
   * Its peak is not a share of the request rate but the token-refresh
   * burst: every live access token misses the authoriser cache once per
   * refresh, and clients that took their tokens together refresh together.
   * The burst lands on a fleet that must grow for it, so each call costs a
   * cold start (about 900 ms at p99), not the warm 20 ms: size it at the
   * live tokens that may refresh in one second, which is the whole live set
   * when they were issued together (1,000 tokens: 1,000), or live tokens /
   * 60 x 2 when their refresh times are spread. Too small a value caps the
   * authoriser at exactly the point it was meant to protect (the 2026-11-11
   * run at 34 for 1,000 tokens threw 369 throttles). A throttled authoriser
   * is a bare 500 from API Gateway, with no tenant and no reason (stress
   * test 2026-11-10 and 2026-11-11, F-12, F-16, F-17).
   */
  readonly authorizerReservedConcurrency?: number;
  /**
   * The key that signs tool contexts (`_ri_ctx`) for every tools gateway.
   * `algorithm` default `RS256`; `ES256` moves the one `kms:Sign` per
   * admitted `tools/call` onto the KMS ECC request quota, separate from the
   * RSA quota the transaction-token mint shares (scale review 2026-11-05).
   */
  readonly toolContextKey?: { readonly algorithm?: JwsAlgorithm };
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
  /**
   * (ADR-0049, spec §3.7) Delegation between agents: creates
   * `POST /{backend}/delegations` on the `api-gateway` ingress, whose bearer
   * is a transaction token this ingress minted, and sets `RI_DELEGATION_URL`
   * on every agent. `maxDepth` (1 to 3) is the number of agents a transaction
   * may pass through after the one the user called. Unset: no route. Not
   * with the `agentcore-gateway` ingress, and not with `tvm.claimTags` (a
   * replacement token carries no identity claims).
   */
  readonly agentDelegation?: AgentDelegationProps;
}

/** (ADR-0049) See `SharedIngressProps.agentDelegation`. */
export interface AgentDelegationProps {
  readonly maxDepth: 1 | 2 | 3;
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
  readonly stageThrottle: { readonly rateLimit: number; readonly burstLimit: number; readonly explicit: boolean };
  readonly ingressReservedConcurrency?: number;
  readonly authorizerReservedConcurrency?: number;
  readonly toolContextAlgorithm: JwsAlgorithm;
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
  /** (ADR-0049) The delegation route's depth bound; undefined when there is no route. */
  readonly delegationMaxDepth?: number;
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
  const ingressReservedConcurrency = props.ingressReservedConcurrency;
  if (ingressReservedConcurrency !== undefined) {
    if (props.ingress !== 'api-gateway') {
      fail('ingressReservedConcurrency', "is valid only with the 'api-gateway' ingress");
    }
    if (!Number.isInteger(ingressReservedConcurrency) || ingressReservedConcurrency < 1) {
      fail('ingressReservedConcurrency', `must be a positive integer (got ${String(ingressReservedConcurrency)})`);
    }
  }
  const authorizerReservedConcurrency = props.authorizerReservedConcurrency;
  if (authorizerReservedConcurrency !== undefined) {
    if (props.ingress !== 'api-gateway') {
      fail('authorizerReservedConcurrency', "is valid only with the 'api-gateway' ingress");
    }
    if (!Number.isInteger(authorizerReservedConcurrency) || authorizerReservedConcurrency < 1) {
      fail('authorizerReservedConcurrency', `must be a positive integer (got ${String(authorizerReservedConcurrency)})`);
    }
  }
  const toolContextAlgorithm = props.toolContextKey?.algorithm ?? 'RS256';
  if (toolContextAlgorithm !== 'RS256' && toolContextAlgorithm !== 'ES256') {
    fail('toolContextKey.algorithm', `must be 'RS256' or 'ES256' (got ${String(toolContextAlgorithm)})`);
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

  // ADR-0049: the delegation route lives on the api-gateway ingress; its bearer carries tenant and user only.
  const delegationMaxDepth = props.agentDelegation?.maxDepth;
  if (delegationMaxDepth !== undefined) {
    if (!Number.isInteger(delegationMaxDepth) || delegationMaxDepth < 1 || delegationMaxDepth > MAX_DELEGATION_DEPTH) {
      fail('agentDelegation.maxDepth', `must be an integer from 1 to ${MAX_DELEGATION_DEPTH} (got ${String(delegationMaxDepth)})`);
    }
    if (props.ingress !== 'api-gateway') {
      fail('agentDelegation', "is valid only with the 'api-gateway' ingress: the Gateway authoriser reads one issuer (ADR-0049)");
    }
    if (tvm !== undefined && Object.keys(tvm.claimTags).length > 0) {
      fail('agentDelegation', 'cannot be combined with tvm.claimTags: a replacement token carries the tenant and the user, no identity claims (ADR-0049)');
    }
  }
  return {
    backend,
    ingress: props.ingress,
    multiTenant,
    sessionScope,
    requiredScopes: props.requiredScopes,
    tvm,
    tenantLimits,
    stageThrottle: { rateLimit, burstLimit, explicit: props.stageThrottle !== undefined },
    ingressReservedConcurrency,
    authorizerReservedConcurrency,
    toolContextAlgorithm,
    perTenantMetrics: props.perTenantMetrics ?? false,
    registryPrefix,
    publish: props.publish ?? true,
    registryTtlSeconds,
    defaultBackend: props.defaultBackend,
    transactionToken: { ttlSeconds, algorithm, keyGeneration, cacheMaxEntries: mintCacheMaxEntries, reuseMarginSeconds },
    authorizerCacheTtlSeconds,
    entitlements: { adminScope, maxAgentsPerTenant, maxToolsPerTenant },
    toolsGateways,
    ...(delegationMaxDepth === undefined ? {} : { delegationMaxDepth }),
  };
}

// ---------------------------------------------------------------------------
// The construct
// ---------------------------------------------------------------------------

/** API Gateway stage name; part of `endpointUrl` on the `api-gateway` ingress and of the issuer API's URL. */
export const STAGE_NAME = 'prod';
/** Spike V-5: the integration timeout caps the stream; two minutes, not the 29 s default. */
export const INTEGRATION_TIMEOUT = Duration.minutes(2);

/** The tools gateway values a `ToolTarget` in another stack needs (the published document, ADR-0042). */
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
 * prefix, one JSON document (ADR-0042). Build one with `SharedIngress.fromParameters`.
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
  /** (ADR-0049) The `api-gateway` base URL an agent delegates through (`<url>/<agent>/delegations`); undefined without the route. */
  readonly delegationUrl?: string;
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
   * Reads another stack's ingress from its one published parameter,
   * `<registryPrefix>ingress` (ADR-0024, ADR-0042): a JSON `PublishedIngress`
   * document. CloudFormation cannot parse JSON at deploy time, so this is a
   * synth-time context lookup (`ssm.StringParameter.valueFromLookup`, like
   * `Vpc.fromLookup`): synth needs AWS credentials for the ingress's account
   * and Region, the consuming stack needs `env: { account, region }`, and the
   * value is cached in `cdk.context.json`. After the ingress is replaced (or
   * its values change), run `cdk context --reset <key>` (the key is
   * `ssm:account=<account>:parameterName=<registryPrefix>ingress:region=<region>`)
   * so the next synth reads it again.
   *
   * `ingress`, when given, must match the document's. (v2) Which tools
   * gateways the ref carries: none with `toolsGateway: false`, the named ones
   * with `toolsGateways` (each must be in the document), else every gateway
   * the document lists. On the first synth, before the context provider has
   * run, CDK hands back a `dummy-value-for-` placeholder; the ref is then
   * built from placeholder values (gateways `toolsGateways ?? ['default']`)
   * so the synth succeeds and the toolkit can fill the context in.
   */
  static fromParameters(
    scope: Construct,
    id: string,
    registryPrefix: string,
    ingress?: IngressKind,
    options: { readonly toolsGateway?: boolean; readonly toolsGateways?: readonly string[] } = {},
  ): SharedIngressRef {
    const holder = new Construct(scope, id);
    const stack = Stack.of(holder);
    const parameterName = `${registryPrefix}${PUBLISHED.ingress}`;
    const where = `SharedIngress.fromParameters(${parameterName})`;
    for (const name of options.toolsGateways ?? []) {
      if (!TOOLS_GATEWAY_NAME_PATTERN.test(name)) {
        throw new Error(`SharedIngress.fromParameters: toolsGateways name '${name}' must match ${TOOLS_GATEWAY_NAME_PATTERN.source}`);
      }
    }
    if (Token.isUnresolved(stack.account) || Token.isUnresolved(stack.region)) {
      throw new Error(
        `${where}: the parameter is read at synth (ADR-0042), so stack ${stack.node.path} needs env: { account, region }; it has none`,
      );
    }
    const value = ssm.StringParameter.valueFromLookup(holder, parameterName);
    if (value.startsWith(LOOKUP_PLACEHOLDER_PREFIX)) {
      return placeholderRef(stack, registryPrefix, ingress ?? 'api-gateway', options);
    }
    let doc: PublishedIngress;
    try {
      doc = JSON.parse(value) as PublishedIngress;
    } catch {
      throw new Error(`${where}: the value is not JSON; is the ingress stack older than ADR-0042?`);
    }
    if (doc === null || typeof doc !== 'object' || doc.version !== PUBLISHED_INGRESS_VERSION) {
      throw new Error(
        `${where}: version ${String((doc as { version?: unknown } | null)?.version)}, expected ${PUBLISHED_INGRESS_VERSION} (ADR-0042); redeploy the ingress stack or run cdk context --reset`,
      );
    }
    if (ingress !== undefined && ingress !== doc.ingress) {
      throw new Error(`${where}: the ingress is '${doc.ingress}', not '${ingress}'`);
    }
    const shape = publishedIngressProblem(doc, stack.account);
    if (shape !== undefined) {
      throw new Error(`${where}: ${shape}`);
    }
    const published = doc.toolsGateways ?? {};
    const available = Object.keys(published);
    const names = options.toolsGateway === false ? [] : [...(options.toolsGateways ?? available)];
    const missing = names.filter((n) => !(n in published));
    if (missing.length > 0) {
      throw new Error(`${where}: no tools gateway ${missing.join(', ')}; the ingress publishes [${available.join(', ')}]`);
    }
    if (names.length > 0 && doc.toolContextKeyId === undefined) {
      throw new Error(`${where}: the document has tools gateways but no toolContextKeyId`);
    }
    const toolsGateways: Record<string, ToolsGatewayRef> = {};
    for (const name of names) {
      const gw = published[name];
      toolsGateways[name] = {
        name,
        gatewayIdentifier: gw.identifier,
        gatewayUrl: gw.url,
        gatewayRoleArn: gw.roleArn,
        policyEngineId: gw.policyEngineId,
        contextKeyId: doc.toolContextKeyId!,
      };
    }
    return {
      registryPrefix,
      ingress: doc.ingress,
      endpointUrl: doc.baseUrl,
      ingressRoleArn: doc.ingressRoleArn,
      ingressId: doc.ingressId,
      tenantRoleArn: doc.tenantRoleArn,
      gatewayIdentifier: doc.ingress === 'agentcore-gateway' ? doc.gatewayIdentifier : undefined,
      issuer: doc.issuer,
      entitlementsTableName: doc.entitlementsTableName,
      tools: toolsGateways[DEFAULT_TOOLS_GATEWAY],
      toolsGateways: names.length > 0 ? toolsGateways : undefined,
      ...(doc.delegationUrl === undefined ? {} : { delegationUrl: doc.delegationUrl }),
    };
  }

  /** The ingress base URL, without a route: `https://.../prod` or the Gateway URL. See `urlFor`. */
  readonly endpointUrl: string;
  /** (ADR-0049) The base URL agents delegate through; undefined without `agentDelegation`. */
  readonly delegationUrl?: string;
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
        'perTenantMetrics is on: each tenant adds up to 9 x (1 + agents) CloudWatch custom metrics per ingress, billed monthly: the 9 metric names on [TenantId, Ingress] and again on [TenantId, Ingress, Backend] for each agent backend the tenant calls (10,000 tenants on one agent is about 180,000 metrics). The ingress log carries the same figures with the tenantId; prefer Logs Insights or Contributor Insights at scale (ADR-0021).',
      );
    }

    if (options.ingress === 'api-gateway' && !options.stageThrottle.explicit) {
      Annotations.of(this).addWarningV2(
        'runtime-isolation:stage-throttle-default',
        `stageThrottle is unset: the api-gateway stage is one bucket of ${options.stageThrottle.rateLimit} rps (burst ${options.stageThrottle.burstLimit}) shared by every tenant, every agent and every refusal, and the per-tenant limit runs behind it, so one tenant at the stage rate starves the rest. Set stageThrottle.rateLimit to at least tenants x tenantLimits.requestsPerMinute / 60, and put a per-tenant WAF rate rule in front for an edge limit (scale review 2026-11-05).`,
      );
    }
    if (options.ingress === 'api-gateway') {
      // ADR-0049: the stage throttle is the one refusal that names a tenant
      // and a reason before any Lambda runs. Above either Lambda's reserve,
      // API Gateway answers a throttled Lambda with a bare 500 instead.
      const over: string[] = [];
      if (options.ingressReservedConcurrency !== undefined && options.stageThrottle.rateLimit > options.ingressReservedConcurrency) {
        over.push(`ingressReservedConcurrency ${options.ingressReservedConcurrency} (a stream holds its instance for at least a second, so the integration Lambda admits at most that many requests a second)`);
      }
      if (
        options.authorizerReservedConcurrency !== undefined
        && options.stageThrottle.rateLimit > options.authorizerReservedConcurrency * AUTHORIZER_CALLS_PER_UNIT_SECOND
      ) {
        over.push(
          `authorizerReservedConcurrency ${options.authorizerReservedConcurrency} x ${AUTHORIZER_CALLS_PER_UNIT_SECOND} `
          + `(a refresh burst lands on cold instances at about 900 ms a call, so one reserved unit serves about ${AUTHORIZER_CALLS_PER_UNIT_SECOND} cache miss a second while it lasts)`,
        );
      }
      if (options.ingressReservedConcurrency !== undefined && options.authorizerReservedConcurrency === undefined) {
        Annotations.of(this).addWarningV2(
          'runtime-isolation:authorizer-unreserved',
<<<<<<< HEAD
          `ingressReservedConcurrency is set (${options.ingressReservedConcurrency}) and authorizerReservedConcurrency is not: the reserve is taken from the account pool the authoriser draws on, and the authoriser's peak is the token-refresh burst (every live access token misses its cache once per refresh), not a share of the request rate. Set authorizerReservedConcurrency to about live tokens / 60 x 2, or a refresh burst answers with bare 500s (ADR-0049).`,
=======
          `ingressReservedConcurrency is set (${options.ingressReservedConcurrency}) and authorizerReservedConcurrency is not: the reserve is taken from the account pool the authoriser draws on, and the authoriser's peak is the token-refresh burst (every live access token misses its cache once per refresh), not a share of the request rate. Set authorizerReservedConcurrency to the live tokens that may refresh in one second (the whole live set when they were issued together), or a refresh burst answers with bare 500s (ADR-0049).`,
>>>>>>> 0f092ce (Agentic runtime isolation: ADR-0048 amended, the authoriser reserve is sized for cold-start bursts (F-17); large-tier S1/S6 rerun results)
        );
      }
      if (over.length > 0) {
        Annotations.of(this).addWarningV2(
          'runtime-isolation:stage-throttle-above-concurrency',
          `stageThrottle.rateLimit ${options.stageThrottle.rateLimit} rps is above ${over.join(' and above ')}: past that point API Gateway answers a throttled Lambda with a bare 500 that names no tenant and no reason, where the stage throttle would have answered 429 with both. Lower stageThrottle.rateLimit or raise the reserve (ADR-0049).`,
        );
      }
    }
    if (options.sessionScope === 'tenant') {
      Annotations.of(this).addWarningV2(
        'runtime-isolation:shared-session-scope',
        "session.scope is 'tenant' (the default when session is set, ADR-0039): every user of a tenant who sends the same client-chosen conversationId resumes the same Runtime session and whatever state the agent kept there. The agent MUST read the token from each request and keep no per-user state in the session, or the deployer sets session.scope: 'user' (T-23, T-81).",
      );
    }
    const wiring = options.ingress === 'api-gateway' ? this.apiGatewayIngress(props, options, environment) : this.agentCoreGatewayIngress(props, options, environment);
    this.endpointUrl = wiring.endpointUrl;
    // ADR-0049: on api-gateway the delegation route shares the base URL; agents append /<agent>/delegations.
    this.delegationUrl = options.delegationMaxDepth === undefined ? undefined : wiring.endpointUrl;
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
      if (fn !== wiring.minter) {
        // M-82: the function that verifies the forwarded token holds the JWKS
        // itself, updated in the same deployment as the minter's key id, and
        // is updated BEFORE the minter so no token arrives with a kid it lacks.
        fn.addEnvironment(ENV.TXN_JWKS, this.tokenSigner.jwks);
        (wiring.minter.node.defaultChild as CfnResource).addDependency(fn.node.defaultChild as CfnResource);
      }
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
      this.toolContextKey = signingKey(this, 'ToolContextKey', KEY_SPEC[options.toolContextAlgorithm], 'runtime-isolation tool context signing key, shared by the tools gateways (ADR-0034, ADR-0041)', {
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
        contextAlgorithm: options.toolContextAlgorithm,
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

  /**
   * The published interface (spec §6.4, standard §1.1, ADR-0042): ONE
   * parameter, `<registryPrefix>ingress`, holding the `PublishedIngress`
   * JSON document. Parameter Store allows 3 PutParameter / DeleteParameter
   * per second per account and Region, so one parameter per value (20-26 a
   * stack) throttled stacks deployed or destroyed together.
   * The construct id stays `IngressParameter` (the pre-ADR-0042 parameter of
   * the same name), so an update rewrites the value in place instead of a
   * replacement colliding with its own fixed name.
   */
  private publish(options: ResolvedOptions): void {
    const defaultBackendUrl =
      options.defaultBackend === undefined
        ? this.endpointUrl
        : options.ingress === 'api-gateway'
          ? `${this.endpointUrl}/${ROUTE}`
          : this.urlFor(options.defaultBackend);
    const toolsGateways: Record<string, PublishedToolsGateway> = {};
    for (const [name, gw] of Object.entries(this.toolsGateways)) {
      toolsGateways[name] = {
        url: gw.gatewayUrl,
        identifier: gw.gatewayIdentifier,
        roleArn: gw.gatewayRole.roleArn,
        policyEngineId: gw.policyEngine.attrPolicyEngineId,
      };
    }
    const doc: PublishedIngress = {
      version: PUBLISHED_INGRESS_VERSION,
      ingress: options.ingress,
      endpointUrl: defaultBackendUrl,
      baseUrl: this.endpointUrl,
      ingressRoleArn: this.ingressRole.roleArn,
      ingressId: this.ingressId,
      tenantRoleArn: this.tenantRole.roleArn,
      ...(this.gatewayIdentifier !== undefined ? { gatewayIdentifier: this.gatewayIdentifier } : {}),
      issuer: this.issuer,
      jwksUrl: this.jwksUrl,
      entitlementsTableName: this.entitlementStore.tableName,
      entitlementsApiUrl: this.entitlementsApiUrl,
      ...(this.toolContextKey !== undefined ? { toolContextKeyId: this.toolContextKey.keyId } : {}),
      toolsGateways,
      ...(this.delegationUrl === undefined ? {} : { delegationUrl: this.delegationUrl }),
    };
    new ssm.StringParameter(this, 'IngressParameter', {
      parameterName: `${this.registryPrefix}${PUBLISHED.ingress}`,
      simpleName: false,
      // Standard up to 4 KB, advanced up to 8 KB: roughly 15-20 tools gateways (ADR-0042).
      tier: ssm.ParameterTier.INTELLIGENT_TIERING,
      stringValue: Stack.of(this).toJsonString(doc),
      description: 'runtime-isolation: the published ingress interface, one JSON document (spec §6.4, ADR-0042)',
    });
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
      reservedConcurrentExecutions: options.authorizerReservedConcurrency,
    });
    acknowledgeLambdaFindings(authorizerFn);

    const ingressFn = new NodejsFunction(this, 'IngressFunction', {
      ...functionProps(this, 'IngressLogs', INTEGRATION_TIMEOUT.plus(Duration.seconds(30))),
      entry: path.join(__dirname, 'ingress', 'api-gateway-ingress.function.ts'),
      description: 'runtime-isolation: chooses the unit from validated claims, forwards the transaction token and relays the backend stream (P-2, P-5)',
      memorySize: 512,
      environment,
      reservedConcurrentExecutions: options.ingressReservedConcurrency,
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
    // spec §5.1: the Deny's fixed reason code, when the authoriser set one. A gateway
    // response template substitutes $context variables and evaluates no VTL directive
    // (integration run 17, 2026-11-09: an #if rendered as literal text), so the authoriser
    // writes the whole suffix (': <reason>') and the template appends it; without a public
    // reason the context has no suffix and the body is the bare text.
    api.addGatewayResponse('AccessDenied', {
      type: apigateway.ResponseType.ACCESS_DENIED,
      statusCode: '403',
      templates: {
        'application/json': 'forbidden$context.authorizer.reasonSuffix',
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
    const backendResource = api.root.addResource('{backend}');
    backendResource
      .addResource(ROUTE)
      .addMethod('POST', integration(), { ...methodOptions, requestParameters: { 'method.request.path.backend': true } });
    if (options.defaultBackend !== undefined) {
      api.root.addResource(ROUTE).addMethod('POST', integration(), methodOptions);
    }
    // ADR-0049: the delegation route, same authoriser and integration; the
    // functions tell the routes apart by path, and the authoriser's cache key
    // (`context.path`) keeps a caller's Allow per target route.
    if (options.delegationMaxDepth !== undefined) {
      backendResource
        .addResource(DELEGATION_ROUTE)
        .addMethod('POST', integration(), { ...methodOptions, requestParameters: { 'method.request.path.backend': true } });
      for (const fn of [authorizerFn, ingressFn]) {
        fn.addEnvironment(ENV.DELEGATION_MAX_DEPTH, String(options.delegationMaxDepth));
        fn.addEnvironment(ENV.INGRESS_ROLE_ARN, ingressFn.role!.roleArn);
      }
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

/** The names under the registry prefix that `SharedIngress` publishes (spec §6.4, ADR-0042): one JSON document. */
export const PUBLISHED = {
  ingress: 'ingress',
} as const;

/** (ADR-0042) The `version` of the `PublishedIngress` document. */
export const PUBLISHED_INGRESS_VERSION = 2;

/** CDK's first-synth value of a context lookup, before the context provider has run. */
const LOOKUP_PLACEHOLDER_PREFIX = 'dummy-value-for-';

/** (ADR-0041, ADR-0042) One tools gateway in the `PublishedIngress` document. */
export interface PublishedToolsGateway {
  /** The gateway's MCP endpoint. */
  readonly url: string;
  /** The gateway id, for `ToolTarget`. */
  readonly identifier: string;
  /** The gateway role a tool function trusts. */
  readonly roleArn: string;
  /** The gateway's policy engine, for `ToolTarget` policies. */
  readonly policyEngineId: string;
}

/**
 * (ADR-0042) The published interface: the JSON document `SharedIngress`
 * writes to `<registryPrefix>ingress` and `SharedIngress.fromParameters`
 * reads at synth.
 */
const PUBLISHED_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PUBLISHED_TABLE_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
const PUBLISHED_ROLE_ARN_PATTERN = /^arn:(aws|aws-cn|aws-us-gov):iam::(\d{12}):role\/[\w+=,.@/-]{1,512}$/;

/**
 * Why a published document is not one `SharedIngress` wrote, or undefined
 * (2026-11-04 security review). Its values land in resource policies (the
 * Runtime trusts `ingressRoleArn`; every tool function trusts a gateway's
 * `roleArn`), in `formatArn` and in Cedar text, so each is held to a shape
 * before use, and every role must belong to the consuming stack's account.
 */
export function publishedIngressProblem(doc: PublishedIngress, account: string): string | undefined {
  const https = (name: string, value: unknown): string | undefined =>
    typeof value === 'string' && /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(value) ? undefined : `${name} is not an https URL`;
  const roleArn = (name: string, value: unknown): string | undefined => {
    const m = typeof value === 'string' ? PUBLISHED_ROLE_ARN_PATTERN.exec(value) : null;
    if (m === null) {
      return `${name} is not an IAM role ARN`;
    }
    return m[2] === account ? undefined : `${name} belongs to account ${m[2]}, not this stack's ${account}`;
  };
  const id = (name: string, value: unknown): string | undefined =>
    typeof value === 'string' && PUBLISHED_ID_PATTERN.test(value) ? undefined : `${name} is not an identifier`;
  const problems = [
    https('baseUrl', doc.baseUrl),
    https('endpointUrl', doc.endpointUrl),
    https('issuer', doc.issuer),
    https('jwksUrl', doc.jwksUrl),
    https('entitlementsApiUrl', doc.entitlementsApiUrl),
    roleArn('ingressRoleArn', doc.ingressRoleArn),
    roleArn('tenantRoleArn', doc.tenantRoleArn),
    id('ingressId', doc.ingressId),
    typeof doc.entitlementsTableName === 'string' && PUBLISHED_TABLE_PATTERN.test(doc.entitlementsTableName) ? undefined : 'entitlementsTableName is not a table name',
    doc.gatewayIdentifier === undefined ? undefined : id('gatewayIdentifier', doc.gatewayIdentifier),
    doc.toolContextKeyId === undefined ? undefined : id('toolContextKeyId', doc.toolContextKeyId),
    ...Object.entries(doc.toolsGateways ?? {}).flatMap(([name, gw]) => [
      id(`toolsGateways.${name}`, name),
      https(`toolsGateways.${name}.url`, gw?.url),
      id(`toolsGateways.${name}.identifier`, gw?.identifier),
      roleArn(`toolsGateways.${name}.roleArn`, gw?.roleArn),
      id(`toolsGateways.${name}.policyEngineId`, gw?.policyEngineId),
    ]),
  ].filter((p): p is string => p !== undefined);
  return problems.length === 0 ? undefined : `the published document is not one SharedIngress wrote: ${problems.join('; ')}`;
}

export interface PublishedIngress {
  /** Always `2` (ADR-0042); before it the parameter held only the ingress kind. */
  readonly version: 2;
  /** The deployed ingress. */
  readonly ingress: IngressKind;
  /** The invocation URL (POST, bearer token): the default backend when one is set, else the ingress base URL. */
  readonly endpointUrl: string;
  /** The ingress base URL; a backend is at `<baseUrl>/<backend>/invocations`. */
  readonly baseUrl: string;
  /** The one principal every Runtime behind this ingress trusts (P-1). */
  readonly ingressRoleArn: string;
  /** The `ri:ingress` tag value a Runtime must carry (ADR-0024). */
  readonly ingressId: string;
  /** The tenant role every model call is signed by (ADR-0018). */
  readonly tenantRoleArn: string;
  /** The AgentCore Gateway a backend adds its target to (`agentcore-gateway` only, ADR-0010). */
  readonly gatewayIdentifier?: string;
  /** The transaction-token issuer URL (ADR-0037). */
  readonly issuer: string;
  /** The transaction-token JWKS URL (ADR-0037). */
  readonly jwksUrl: string;
  /** The entitlement store table, for name reservations (ADR-0035). */
  readonly entitlementsTableName: string;
  /** The entitlement API base URL (ADR-0030). */
  readonly entitlementsApiUrl: string;
  /** The key that signs tool contexts for every tools gateway; absent with no gateway (ADR-0034, ADR-0041). */
  readonly toolContextKeyId?: string;
  /** Every tools gateway by name (ADR-0041); empty with `toolsGateway: false`. */
  readonly toolsGateways: Readonly<Record<string, PublishedToolsGateway>>;
  /** (ADR-0049) The base URL of the delegation route; absent without `agentDelegation`. */
  readonly delegationUrl?: string;
}

/** The first-synth ref (ADR-0042): placeholder values of the right shape, so the synth that triggers the lookup succeeds. */
function placeholderRef(
  stack: Stack,
  registryPrefix: string,
  ingress: IngressKind,
  options: { readonly toolsGateway?: boolean; readonly toolsGateways?: readonly string[] },
): SharedIngressRef {
  const dummy = (what: string) => `${LOOKUP_PLACEHOLDER_PREFIX}${what}`;
  const roleArn = (what: string) => stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: dummy(what) });
  const names = options.toolsGateway === false ? [] : [...(options.toolsGateways ?? [DEFAULT_TOOLS_GATEWAY])];
  const toolsGateways: Record<string, ToolsGatewayRef> = {};
  for (const name of names) {
    toolsGateways[name] = {
      name,
      gatewayIdentifier: dummy(`${name}-gateway`),
      gatewayUrl: `https://${dummy(name)}.example.com/mcp`,
      gatewayRoleArn: roleArn(`${name}-gateway-role`),
      policyEngineId: dummy(`${name}-policy-engine`),
      contextKeyId: dummy('tool-context-key'),
    };
  }
  return {
    registryPrefix,
    ingress,
    endpointUrl: `https://${dummy('ingress')}.example.com`,
    ingressRoleArn: roleArn('ingress-role'),
    ingressId: dummy('ingress-id'),
    tenantRoleArn: roleArn('tenant-role'),
    gatewayIdentifier: ingress === 'agentcore-gateway' ? dummy('gateway') : undefined,
    issuer: `https://${dummy('issuer')}.example.com`,
    entitlementsTableName: dummy('entitlements'),
    tools: toolsGateways[DEFAULT_TOOLS_GATEWAY],
    toolsGateways: names.length > 0 ? toolsGateways : undefined,
  };
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

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
 * the log drain (ADR-0019) and the published parameters. The ingress role's
 * invoke grant is a Runtime ARN pattern conditioned on the `ri:ingress` tag
 * that `AgentBackend` sets at creation; the Runtime's own resource policy
 * remains the hard gate (P-1, ADR-0001).
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
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { baseModelId, foundationModelArn, INVOKE_ACTION, isInferenceProfileId, modelResourceArns } from './backend/agentcore-runtime.cdk';
import type { BackendKind } from './backend/backend';
import { ENV } from './shared/config';
import { LogDrain } from './shared/log-drain';
import type { IngressKind } from './shared/metrics';
import { acknowledgeGranularFinding, nagFindingResource } from './shared/nag';
import { BACKEND_NAME_PATTERN, INGRESS_TAG_KEY, REGISTRY_BACKENDS_SEGMENT, ROUTE } from './shared/registry';
import { CONVERSATION_ID_PATTERN, type SessionScope } from './shared/session';
import { DEFAULT_CACHE_MAX_ENTRIES, TENANT_TAG_KEY, USER_TAG_KEY } from './shared/tvm';

// ---------------------------------------------------------------------------
// Props (spec §3.3)
// ---------------------------------------------------------------------------

/** The issuer whose access tokens the ingress accepts (spec §6.2). */
export interface IdentityProps {
  /** OIDC discovery URL of the issuer (`.../.well-known/openid-configuration`). */
  readonly discoveryUrl: string;
  /** `client_id` values accepted. Non-empty. */
  readonly allowedClientIds: string[];
}

/** The `session` module (ADR-0013, ADR-0002): conversations persist in a claim-derived unit. */
export interface SessionProps {
  /** `'user'` hashes `tenant_id|sub`; `'tenant'` hashes `tenant_id` only. Default `'user'`. */
  readonly scope?: SessionScope;
}

/** The `delegation` module (P-5, ADR-0006, ADR-0007). */
export interface DelegationProps {
  /** Forward the user's token to the agent in the backend's user-token transport. Default false. */
  readonly forwardUserToken?: boolean;
  /** Refuse a token whose scopes are not a subset of `allowedScopes`. Only valid with `forwardUserToken`. Default false. */
  readonly requireNarrowedToken?: boolean;
  /** The scopes a forwarded token may carry. Required with `requireNarrowedToken`. */
  readonly allowedScopes?: string[];
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
  /**
   * Bound on cached credential sets per ingress instance (ADR-0022): least
   * recently used evicted first. One entry is one tag set: one per tenant,
   * or one per user with `includeUserIdTag`. Default 1000.
   */
  readonly cacheMaxEntries?: number;
}

/** Per-tenant limits, enforced fleet-wide at the ingress and shared by every backend behind it (ADR-0020, ADR-0024). */
export interface TenantLimitsProps {
  /** Requests one tenant may make per minute, across all backends. Default 60. `0` turns the request limit off. */
  readonly requestsPerMinute?: number;
  /**
   * Model output tokens one tenant may use per minute. Unset: no token limit.
   * `api-gateway` ingress only: the AgentCore Gateway interceptor never sees
   * the response, so it cannot count tokens.
   */
  readonly outputTokensPerMinute?: number;
}

/** The API Gateway stage throttle, shared by all tenants and all backends (`api-gateway` ingress only). */
export interface StageThrottleProps {
  /** Steady-state requests per second for the whole stage. Default 50. */
  readonly rateLimit?: number;
  /** Burst for the whole stage. Default 25. */
  readonly burstLimit?: number;
}

/** The registry prefix every ingress uses unless told otherwise; one per account and Region (standard §1.1, ADR-0024). */
export const DEFAULT_REGISTRY_PREFIX = '/application-plane/shared/agent-runtime/';
/** How long an ingress process serves a registry entry before refreshing it (ADR-0024). */
export const DEFAULT_REGISTRY_TTL = Duration.seconds(60);
/** The conventional default backend name, and so the Gateway target name for the one-agent form (ADR-0024). */
export const GATEWAY_TARGET_NAME = 'agent';

export interface SharedIngressProps {
  readonly identity: IdentityProps;
  /** The isolating compute service every backend behind this ingress runs on (ADR-0011). Default `'agentcore-runtime'`. */
  readonly backend?: BackendKind;
  /** The ingress (ADR-0003). `'agentcore-gateway'` is valid only with the `'agentcore-runtime'` backend. */
  readonly ingress: IngressKind;
  /** Session mapping (ADR-0013). Unset: a fresh unit per request. */
  readonly session?: SessionProps;
  /**
   * Scopes every token must carry, whatever the backend (ADR-0005): the
   * product floor. Each backend may require more (`AgentBackend.requiredScopes`).
   * Unset: no ingress-wide scope check.
   */
  readonly requiredScopes?: string[];
  readonly delegation?: DelegationProps;
  /**
   * The TVM is always on (ADR-0018). Unset: the construct creates a
   * model-only `TenantModelRole`. Set: customise the TVM, and optionally
   * supply a role that also reaches tenant data. One tenant role serves
   * every backend (ADR-0024).
   */
  readonly tvm?: TvmProps;
  /**
   * Per-tenant limits (ADR-0020), on by default at 60 requests per tenant per
   * minute, so one tenant cannot use the shared stage, Runtimes and model
   * quota for all. Pass `false` to turn them off.
   */
  readonly tenantLimits?: TenantLimitsProps | false;
  /** The shared stage throttle on the `api-gateway` ingress. Default 50 rps, burst 25. */
  readonly stageThrottle?: StageThrottleProps;
  /**
   * Emit per-tenant CloudWatch metrics (EMF, ADR-0021). Default false.
   * COST: about 9 custom metrics per tenant per ingress (10,000 tenants is
   * about 90,000 metrics, billed monthly per metric). Without it the ingress
   * log carries the same figures per request with the tenantId, for Logs
   * Insights and Contributor Insights.
   */
  readonly perTenantMetrics?: boolean;
  /**
   * The SSM parameter prefix of the backend registry and of this ingress's
   * published parameters (ADR-0024). Must start and end with `/`. Default
   * `/application-plane/shared/agent-runtime/`; the default is one per
   * account and Region, so a second ingress in the same account must set
   * its own.
   */
  readonly registryPrefix?: string;
  /** How long an ingress process serves a registry entry before refreshing it. Default 60 seconds (ADR-0024). */
  readonly registryTtl?: Duration;
  /**
   * The backend served at the bare `/invocations` route, so a deployment of
   * one backend keeps today's URL (`IsolatedRuntime` sets it). Must match
   * `[a-z0-9-]{1,32}`. Unset: only `/{backend}/invocations` exists.
   */
  readonly defaultBackend?: string;
}

/** The props after defaults and validation; what the construct and its tests reason about. */
export interface ResolvedOptions {
  readonly backend: BackendKind;
  readonly ingress: IngressKind;
  readonly sessionScope?: SessionScope;
  readonly requiredScopes?: string[];
  readonly forwardUserToken: boolean;
  readonly requireNarrowedToken: boolean;
  readonly allowedScopes?: string[];
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
  /** The registry (ADR-0024). */
  readonly registryPrefix: string;
  readonly registryTtlSeconds: number;
  readonly defaultBackend?: string;
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

  const backend = props.backend ?? 'agentcore-runtime';
  if (backend !== 'agentcore-runtime') {
    fail('backend', `must be 'agentcore-runtime' (got ${String(backend)})`);
  }
  if (props.ingress !== 'api-gateway' && props.ingress !== 'agentcore-gateway') {
    fail('ingress', `must be 'api-gateway' or 'agentcore-gateway' (got ${String(props.ingress)})`);
  }
  if (props.ingress === 'agentcore-gateway' && backend !== 'agentcore-runtime') {
    fail('ingress', "'agentcore-gateway' is valid only with the 'agentcore-runtime' backend");
  }

  let sessionScope: SessionScope | undefined;
  if (props.session !== undefined) {
    sessionScope = props.session.scope ?? 'user';
    if (sessionScope !== 'user' && sessionScope !== 'tenant') {
      fail('session.scope', `must be 'user' or 'tenant' (got ${String(sessionScope)})`);
    }
  }

  if (props.requiredScopes !== undefined) {
    if (props.requiredScopes.length === 0 || props.requiredScopes.some((s) => s.trim().length === 0 || /\s/.test(s))) {
      fail('requiredScopes', 'must be a non-empty list of scope strings without whitespace');
    }
  }

  const forwardUserToken = props.delegation?.forwardUserToken ?? false;
  const requireNarrowedToken = props.delegation?.requireNarrowedToken ?? false;
  const allowedScopes = props.delegation?.allowedScopes;
  if (requireNarrowedToken && !forwardUserToken) {
    fail('delegation.requireNarrowedToken', 'is valid only with delegation.forwardUserToken');
  }
  if (requireNarrowedToken && (allowedScopes === undefined || allowedScopes.length === 0)) {
    fail('delegation.allowedScopes', 'is required with delegation.requireNarrowedToken');
  }
  if (!requireNarrowedToken && allowedScopes !== undefined) {
    fail('delegation.allowedScopes', 'is only meaningful with delegation.requireNarrowedToken');
  }
  if (allowedScopes?.some((s) => s.trim().length === 0 || /\s/.test(s))) {
    fail('delegation.allowedScopes', 'must contain scope strings without whitespace');
  }

  // The TVM is always on (ADR-0018). `props.tvm` only customises it; its
  // absence is the default model-only role, not an off switch.
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

  // The registry (ADR-0024). A token inside the prefix (a stack name) is
  // allowed; the two slashes around it must be literal.
  const registryPrefix = props.registryPrefix ?? DEFAULT_REGISTRY_PREFIX;
  if (!registryPrefix.startsWith('/') || !registryPrefix.endsWith('/')) {
    fail('registryPrefix', `must start and end with / (got ${registryPrefix})`);
  }
  const registryTtlSeconds = (props.registryTtl ?? DEFAULT_REGISTRY_TTL).toSeconds();
  if (!Number.isInteger(registryTtlSeconds) || registryTtlSeconds < 1) {
    fail('registryTtl', 'must be a whole number of seconds, at least one');
  }
  if (props.defaultBackend !== undefined && !BACKEND_NAME_PATTERN.test(props.defaultBackend)) {
    fail('defaultBackend', `must match ${BACKEND_NAME_PATTERN.source} (got ${props.defaultBackend})`);
  }

  return {
    backend,
    ingress: props.ingress,
    sessionScope,
    requiredScopes: props.requiredScopes,
    forwardUserToken,
    requireNarrowedToken,
    allowedScopes,
    tvm,
    tenantLimits,
    stageThrottle: { rateLimit, burstLimit },
    perTenantMetrics: props.perTenantMetrics ?? false,
    registryPrefix,
    registryTtlSeconds,
    defaultBackend: props.defaultBackend,
  };
}

// ---------------------------------------------------------------------------
// The construct
// ---------------------------------------------------------------------------

/** API Gateway stage name; part of `endpointUrl` on the `api-gateway` ingress. */
export const STAGE_NAME = 'prod';
/** Spike V-5: the integration timeout caps the stream; two minutes, not the 29 s default. */
export const INTEGRATION_TIMEOUT = Duration.minutes(2);
/** How long API Gateway caches an authoriser result per `Authorization` header and request path (ADR-0015, ADR-0023, ADR-0024). */
export const AUTHORIZER_CACHE_TTL = Duration.minutes(5);

/**
 * What `AgentBackend` needs from an ingress in another stack (ADR-0024):
 * the values `SharedIngress` publishes under its registry prefix. Build one
 * with `SharedIngress.fromParameters`, or by hand from the same parameters.
 */
export interface SharedIngressRef {
  /** The registry prefix the ingress resolves routes through; the backend writes `${registryPrefix}backends/<name>`. */
  readonly registryPrefix: string;
  /** The ingress base URL, so the backend can state its own `endpointUrl`. Optional. */
  readonly endpointUrl?: string;
  /** The one principal every Runtime behind this ingress trusts (P-1). */
  readonly ingressRoleArn: string;
  /** The `ri:ingress` tag value the ingress role's invoke grant is conditioned on. */
  readonly ingressId: string;
  /** Which ingress: on `'agentcore-gateway'` the backend also creates a Gateway target. */
  readonly ingress: IngressKind;
  /** The Gateway identifier; required with the `'agentcore-gateway'` ingress. */
  readonly gatewayIdentifier?: string;
  /** The tenant role every model call is signed by; the backend adds its one-model statement to it (ADR-0018). */
  readonly tenantRoleArn: string;
  /**
   * Whether the ingress forwards the user's token (`delegation.forwardUserToken`),
   * so the Runtime admits that header (ADR-0006). Not a published parameter:
   * the header allowlist is decided at synth. Default false.
   */
  readonly forwardUserToken?: boolean;
}

export class SharedIngress extends Construct {
  /**
   * Reads another stack's ingress from its published parameters (ADR-0024).
   * `ingress` must be given: which parameters exist and whether a Gateway
   * target is created are decided at synth, before a parameter can be read.
   */
  static fromParameters(
    scope: Construct,
    id: string,
    registryPrefix: string,
    ingress: IngressKind,
    options: { readonly forwardUserToken?: boolean } = {},
  ): SharedIngressRef {
    const holder = new Construct(scope, id);
    const read = (name: string) => ssm.StringParameter.valueForStringParameter(holder, `${registryPrefix}${name}`);
    return {
      registryPrefix,
      ingress,
      endpointUrl: read(PUBLISHED.baseUrl),
      ingressRoleArn: read(PUBLISHED.ingressRoleArn),
      ingressId: read(PUBLISHED.ingressId),
      tenantRoleArn: read(PUBLISHED.tenantRoleArn),
      gatewayIdentifier: ingress === 'agentcore-gateway' ? read(PUBLISHED.gatewayIdentifier) : undefined,
      forwardUserToken: options.forwardUserToken,
    };
  }

  /** The ingress base URL, without a route: `https://.../prod` or the Gateway URL. See `urlFor`. */
  readonly endpointUrl: string;
  /** The one principal every backend trusts (P-1): the integration Lambda's role, or the Gateway's role. */
  readonly ingressRole: iam.IRole;
  /** The role that validates the token and assumes the tenant role: the integration Lambda or the interceptor. */
  readonly tvmCallerRole: iam.IRole;
  /** The tenant role every model call is signed by (ADR-0018): the deployer's role, or the construct's default `TenantModelRole`. */
  readonly tenantRole: iam.IRole;
  /** The resolved options, for consumers and tests. */
  readonly options: ResolvedOptions;
  /** The per-tenant usage counters (ADR-0020); undefined when `tenantLimits` is `false`. */
  readonly limitsTable?: dynamodb.TableV2;
  /** The registry prefix (ADR-0024); entries live at `${registryPrefix}backends/<name>`. */
  readonly registryPrefix: string;
  /**
   * This ingress's identity: the `ri:ingress` tag value a Runtime must carry
   * for the ingress role's invoke grant to apply (ADR-0024). Stable across
   * deploys of the same construct path; lower case; at most 48 characters.
   */
  readonly ingressId: string;
  /** The Gateway identifier (`agentcore-gateway` only), for `AgentBackend` targets. */
  readonly gatewayIdentifier?: string;

  private readonly grantedModels = new Set<string>();

  constructor(scope: Construct, id: string, props: SharedIngressProps) {
    super(scope, id);
    const options = resolveOptions(props);
    this.options = options;
    this.registryPrefix = options.registryPrefix;
    this.ingressId = Names.uniqueResourceName(this, { maxLength: 48, separator: '-' }).toLowerCase();

    // The tenant-role ARN the ingress assumes. The default role is created
    // after the ingress (it trusts tvmCallerRole), so resolve its ARN lazily.
    const tenantRoleArn = options.tvm.role?.roleArn ?? Lazy.string({ produce: () => this.tenantRole.roleArn });

    // Per-tenant limits (ADR-0020): one fixed-window counter per tenant per
    // minute, shared by every ingress instance and every backend (ADR-0024).
    if (options.tenantLimits !== undefined) {
      this.limitsTable = new dynamodb.TableV2(this, 'TenantLimits', {
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        timeToLiveAttribute: 'expiresAt',
        removalPolicy: RemovalPolicy.DESTROY, // counters only, gone within minutes anyway
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      });
    }
    const environment = ingressEnvironment(props, options, tenantRoleArn, this.limitsTable?.tableName);

    if (options.perTenantMetrics) {
      Annotations.of(this).addWarningV2(
        'runtime-isolation:per-tenant-metrics-cost',
        'perTenantMetrics is on: each tenant adds about 9 CloudWatch custom metrics per ingress, billed monthly (10,000 tenants is about 90,000 metrics). The ingress log carries the same figures with the tenantId; prefer Logs Insights or Contributor Insights at scale (ADR-0021).',
      );
    }

    let registryReaders: iam.IRole[];
    if (options.ingress === 'api-gateway') {
      const api = this.apiGatewayIngress(props, options, environment);
      this.endpointUrl = api.endpointUrl;
      this.ingressRole = api.ingressRole;
      this.tvmCallerRole = api.tvmCallerRole;
      registryReaders = api.registryReaders;
    } else {
      const gw = this.agentCoreGatewayIngress(props, options, environment);
      this.endpointUrl = gw.endpointUrl;
      this.ingressRole = gw.ingressRole;
      this.tvmCallerRole = gw.tvmCallerRole;
      this.gatewayIdentifier = gw.gatewayIdentifier;
      registryReaders = gw.registryReaders;
    }

    this.grantInvokeTaggedRuntimes(this.ingressRole);
    for (const reader of registryReaders) {
      this.grantReadRegistry(reader);
    }

    // ADR-0020: the token-validating role counts requests and tokens, and
    // may do nothing else with the table.
    if (this.limitsTable !== undefined) {
      this.tvmCallerRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'CountTenantUsage',
          actions: ['dynamodb:UpdateItem'],
          resources: [this.limitsTable.tableArn],
        }),
      );
    }

    // The TVM is always on (ADR-0018). When the deployer supplies a role it
    // owns (and may use for tenant data), use it; otherwise create a
    // model-only `TenantModelRole` trusted by tvmCallerRole alone, built
    // AFTER tvmCallerRole exists so its trust names exactly that principal.
    // The model statements are added per backend (`grantModel`).
    this.tenantRole = options.tvm.role ?? this.defaultTenantRole(options);

    // P-8 (ADR-0012): only the token-validating role may assume the tenant
    // role. For a deployer-supplied role the trust policy must name
    // tvmCallerRole and require the TenantId request tag (spec §6.1); the
    // default role's trust does that by construction.
    this.tvmCallerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeTenantRole',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.tenantRole.roleArn],
      }),
    );

    this.publish(options);
  }

  /** The invocation URL of one backend behind this ingress (spec §5): `${endpointUrl}/${backend}/invocations`. */
  urlFor(backend: string): string {
    if (!Token.isUnresolved(backend) && !BACKEND_NAME_PATTERN.test(backend)) {
      throw new Error(`SharedIngress.urlFor: backend must match ${BACKEND_NAME_PATTERN.source} (got ${backend})`);
    }
    return `${this.endpointUrl}/${backend}/${ROUTE}`;
  }

  /**
   * Adds the one-model statement for `modelId` to the tenant role
   * (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` on
   * `modelResourceArns(modelId)`), with the inference-profile Region-wildcard
   * acknowledgment where the id is a cross-Region profile (ADR-0018, was the
   * execution role's `OneModel` under ADR-0008). Idempotent per model id, so
   * several backends on one model add one statement. An imported role (no
   * `addToPrincipalPolicy` effect) must already carry it; the README says so.
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
   * Region that carries `ri:ingress = <ingressId>`, which `AgentBackend` sets
   * in `CfnRuntime.tags` at creation. Backends come and go without an
   * ingress deploy, so the grant is a pattern plus a tag condition, not a
   * list. The Service Authorization Reference lists `aws:ResourceTag` for
   * `InvokeAgentRuntime` on `runtime` and `runtime-endpoint`; a tag given at
   * creation is copied to the DEFAULT endpoint, and a role with this exact
   * grant reached a tagged Runtime and was refused on an untagged one
   * (sandbox test, eu-central-1, 2026-10-28). The Runtime's resource policy
   * (P-1, ADR-0001) remains the hard gate if the condition were ever not
   * honoured.
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
    // No slash between `parameter` and the name: the name's own leading slash is it.
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
   * The published interface (spec §6.4, standard §1.1), under the registry
   * prefix: what `AgentBackend` in another stack needs
   * (`SharedIngress.fromParameters`) and what a client needs to call.
   */
  private publish(options: ResolvedOptions): void {
    const put = (id: string, name: string, value: string, description: string) =>
      new ssm.StringParameter(this, id, {
        parameterName: `${this.registryPrefix}${name}`,
        // The prefix starts with `/`, so the name is never simple; said
        // explicitly because a prefix may carry a token (a stack name).
        simpleName: false,
        stringValue: value,
        description: `runtime-isolation: ${description}`,
      });
    // `endpointUrl` keeps its spec §6.4 meaning for the one-backend wrapper and
    // the scripts that POST to it: with a default backend it is that backend's
    // invocation URL (the bare `/invocations` route on api-gateway, the target
    // route on the Gateway); without one, the base URL. `baseUrl` is always the base.
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
  }

  /**
   * The default tenant role (ADR-0018): trusted by `tvmCallerRole` only,
   * requiring a non-empty `TenantId` request tag and `aws:TagKeys` pinned to
   * the configured tag set, with `sts:TagSession` and a one-hour maximum
   * session (role chaining caps there). It carries only the model statements
   * (added per backend via `grantModel`), no data permission.
   */
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

  // -------------------------------------------------------------------------
  // Ingress A: API Gateway REST API, Lambda authoriser, streaming Lambda proxy
  // -------------------------------------------------------------------------
  private apiGatewayIngress(
    props: SharedIngressProps,
    options: ResolvedOptions,
    environment: Record<string, string>,
  ): { endpointUrl: string; ingressRole: iam.IRole; tvmCallerRole: iam.IRole; registryReaders: iam.IRole[] } {
    const authorizerFn = new NodejsFunction(this, 'AuthorizerFunction', {
      ...functionProps(this, 'AuthorizerLogs', Duration.seconds(10)),
      entry: path.join(__dirname, 'ingress', 'api-gateway-authorizer.function.ts'),
      description: 'runtime-isolation: verifies the bearer token, resolves the backend and returns both as authoriser context (P-3, P-9, ADR-0024)',
      environment,
    });
    acknowledgeLambdaFindings(authorizerFn);

    // The integration Lambda runs for the whole stream (ADR-0009), so its
    // timeout exceeds the integration timeout that caps the stream (V-5).
    const ingressFn = new NodejsFunction(this, 'IngressFunction', {
      ...functionProps(this, 'IngressLogs', INTEGRATION_TIMEOUT.plus(Duration.seconds(30))),
      entry: path.join(__dirname, 'ingress', 'api-gateway-ingress.function.ts'),
      description: 'runtime-isolation: chooses the unit from validated claims and relays the backend stream (P-2)',
      memorySize: 512,
      environment,
    });
    acknowledgeLambdaFindings(ingressFn);

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });

    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${Names.uniqueResourceName(this, { maxLength: 48, separator: '-' })}-ingress`,
      description: 'runtime-isolation ingress: POST /{backend}/invocations, bearer token verified by a Lambda authoriser (ADR-0024)',
      // The account-level API Gateway CloudWatch role is one setting per
      // account and Region, retained on destroy; the account must already
      // have one (README prerequisites, as in tenant-identity ADR-0019).
      cloudWatchRole: false,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: STAGE_NAME,
        // P-9: who called and for which tenant. The authoriser puts the
        // verified tenantId in its context; the access log records it as a
        // field. dataTraceEnabled stays off: data trace logs request
        // headers, which would record the bearer token (spike V-7).
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
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        tracingEnabled: true,
        metricsEnabled: true,
        // Shared by every tenant and every backend (ADR-0020, ADR-0024): the
        // per-tenant limit sits in front of it, so one tenant cannot use the
        // whole stage.
        throttlingRateLimit: options.stageThrottle.rateLimit,
        throttlingBurstLimit: options.stageThrottle.burstLimit,
      },
    });

    const authorizer = new apigateway.RequestAuthorizer(this, 'Authorizer', {
      handler: authorizerFn,
      // ADR-0024: the result names the resolved backend and its scope check,
      // so the cache key must include the route. API Gateway accepts
      // `context.*` variables as REQUEST identity sources; `context.path` is
      // the request path (`/prod/billing/invocations`), where
      // `context.resourcePath` would be the template (`/{backend}/invocations`)
      // and a path parameter is not an accepted identity source.
      identitySources: [apigateway.IdentitySource.header('Authorization'), apigateway.IdentitySource.context('path')],
      // Cached per Authorization header value and path for five minutes
      // (ADR-0015, amended by ADR-0023 and ADR-0024): the same token on the
      // same route re-verifies here at most once in five minutes. The cache
      // never extends a token's life: the integration Lambda re-verifies it,
      // including `exp`, before any invoke, so a token is refused there the
      // moment it expires.
      resultsCacheTtl: AUTHORIZER_CACHE_TTL,
    });

    // Request validation (AwsSolutions-APIG2): the body shape is enforced at
    // the gateway, before the streaming Lambda runs. With `session` the
    // conversationId is required and patterned; without it, it is refused.
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

    // One resource for every backend (ADR-0024): the name is a path
    // parameter the authoriser resolves through the registry. An unknown
    // name reaches the authoriser and is refused there (404), not by API
    // Gateway.
    api.root
      .addResource('{backend}')
      .addResource(ROUTE)
      .addMethod('POST', integration(), { ...methodOptions, requestParameters: { 'method.request.path.backend': true } });
    // The bare route of the one-backend deployment (today's URL): the same
    // authoriser and Lambda resolve it to `defaultBackend`.
    if (options.defaultBackend !== undefined) {
      api.root.addResource(ROUTE).addMethod('POST', integration(), methodOptions);
    }

    // ADR-0019: teardown leaves no log group. API Gateway creates the
    // execution log group itself (outside the stack) and delivers access and
    // execution logs a few seconds late, so a deleted group comes back with
    // no retention. The construct owns the execution group by its fixed name,
    // and one drain waits between the stage (the writer, which also invokes
    // both functions) and every log group on this path.
    const executionLogs = new logs.LogGroup(this, 'ApiExecutionLogs', {
      logGroupName: `API-Gateway-Execution-Logs_${api.restApiId}/${STAGE_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const drain = new LogDrain(this, 'LogDrain');
    for (const group of [accessLogs, executionLogs, authorizerFn.logGroup, ingressFn.logGroup]) {
      drain.protect(group);
    }
    drain.writer(api.deploymentStage);

    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG3',
      reason:
        'WAFv2 association is production hardening (README checklist, ADR-0014): the route is behind a Lambda authoriser that verifies every token, and the stage is throttled.',
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-COG4',
      reason:
        'The route uses a custom Lambda authoriser (the shared verifier) rather than a Cognito authoriser so the construct accepts any OIDC issuer that meets the token contract (ADR-0004).',
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG4',
      reason: 'POST /{backend}/invocations is authorised by the custom Lambda authoriser (P-3, ADR-0001); cdk-nag reads the CUSTOM type without a Cognito pool as unauthorised.',
    });

    const stack = Stack.of(this);
    return {
      // `api.url` ends in a slash; the base URL does not, so `urlFor` can join.
      endpointUrl: `https://${api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}/${api.deploymentStage.stageName}`,
      ingressRole: ingressFn.role!,
      tvmCallerRole: ingressFn.role!,
      // Both resolve the route: the authoriser decides, the integration Lambda re-reads the entry before the invoke.
      registryReaders: [authorizerFn.role!, ingressFn.role!],
    };
  }

  // -------------------------------------------------------------------------
  // Ingress B: AgentCore Gateway with a REQUEST interceptor; targets come from AgentBackend
  // -------------------------------------------------------------------------
  private agentCoreGatewayIngress(
    props: SharedIngressProps,
    options: ResolvedOptions,
    environment: Record<string, string>,
  ): { endpointUrl: string; ingressRole: iam.IRole; tvmCallerRole: iam.IRole; gatewayIdentifier: string; registryReaders: iam.IRole[] } {
    const interceptorFn = new NodejsFunction(this, 'InterceptorFunction', {
      ...functionProps(this, 'InterceptorLogs', Duration.seconds(10)),
      entry: path.join(__dirname, 'ingress', 'gateway-interceptor.function.ts'),
      description: 'runtime-isolation: Gateway REQUEST interceptor; builds the unit id and overwrites the session header (P-2)',
      environment,
    });
    acknowledgeLambdaFindings(interceptorFn);

    const stack = Stack.of(this);
    // Gateway names match ^([0-9a-zA-Z][-]?){1,48}$. The service lowercases
    // the name in the gateway id, and so in the ARN the role's aws:SourceArn
    // condition compares case-sensitively: a mixed-case name makes the Gateway
    // unable to assume its role (first integ run, 2026-10-27). Lowercase here.
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
    // The one function, by exact ARN (grantInvoke would add a `:*` version wildcard).
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
          // ADR-0005: the service checks the product floor before the
          // interceptor runs; the interceptor enforces AND, plus the target's
          // own scopes from the registry (ADR-0024).
          ...(options.requiredScopes !== undefined ? { allowedScopes: options.requiredScopes } : {}),
        },
      },
      interceptorConfigurations: [
        {
          interceptor: { lambda: { arn: interceptorFn.functionArn } },
          interceptionPoints: ['REQUEST'],
          // The interceptor needs the Authorization header (to re-verify the
          // token) and the session header (to overwrite it): spike V-3.
          inputConfiguration: { passRequestHeaders: true },
        },
      ],
    });
    gateway.node.addDependency(gatewayRole);

    // ADR-0019: the Gateway invokes the interceptor; its late logs must land
    // before the interceptor's log group is deleted.
    const drain = new LogDrain(this, 'LogDrain');
    drain.protect(interceptorFn.logGroup);
    drain.writer(gateway);

    return {
      endpointUrl: gateway.attrGatewayUrl,
      ingressRole: gatewayRole,
      tvmCallerRole: interceptorFn.role!,
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      registryReaders: [interceptorFn.role!],
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The names under the registry prefix that `SharedIngress` publishes (spec §6.4). */
export const PUBLISHED = {
  /** The invocation URL (spec §6.4): the default backend's when `defaultBackend` is set (today's meaning), else the base URL. */
  endpointUrl: 'endpointUrl',
  /** The ingress base URL; a backend is at `<baseUrl>/<backend>/invocations`. */
  baseUrl: 'baseUrl',
  ingressRoleArn: 'ingressRoleArn',
  ingressId: 'ingressId',
  ingress: 'ingress',
  tenantRoleArn: 'tenantRoleArn',
  gatewayIdentifier: 'gatewayIdentifier',
} as const;

/**
 * Adds one model statement to a tenant role (ADR-0018): both invoke actions
 * on exactly the ARN forms this one model id needs, and the Region-wildcard
 * acknowledgment where the id is a cross-Region inference profile. Shared by
 * `SharedIngress.grantModel` and `AgentBackend` on an imported ingress.
 */
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
      'A cross-Region inference profile routes the call to the model in any Region of its set, so the foundation-model ARN names one model with a Region wildcard; the profile ARN itself is exact (ADR-0018).',
    );
  }
}

/** The ingress Lambdas' environment (src/shared/config.ts): every option, backend-neutral; no Runtime ARN (ADR-0024). */
function ingressEnvironment(
  props: SharedIngressProps,
  options: ResolvedOptions,
  tenantRoleArn: string,
  limitsTableName: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    [ENV.INGRESS]: options.ingress,
    [ENV.DISCOVERY_URL]: props.identity.discoveryUrl,
    [ENV.ALLOWED_CLIENT_IDS]: props.identity.allowedClientIds.join(','),
    [ENV.FORWARD_USER_TOKEN]: String(options.forwardUserToken),
    [ENV.REQUIRE_NARROWED_TOKEN]: String(options.requireNarrowedToken),
  };
  if (options.requiredScopes !== undefined) {
    env[ENV.REQUIRED_SCOPES] = options.requiredScopes.join(',');
  }
  if (options.sessionScope !== undefined) {
    env[ENV.SESSION_SCOPE] = options.sessionScope;
  }
  if (options.allowedScopes !== undefined) {
    env[ENV.ALLOWED_SCOPES] = options.allowedScopes.join(',');
  }
  // The TVM is always on (ADR-0018), so these are always set.
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
  // The registry (ADR-0024): the ingress resolves `/{backend}/invocations` here.
  env[ENV.REGISTRY_PREFIX] = options.registryPrefix;
  env[ENV.REGISTRY_TTL_SECONDS] = String(options.registryTtlSeconds);
  if (options.defaultBackend !== undefined) {
    env[ENV.DEFAULT_BACKEND] = options.defaultBackend;
  }
  return env;
}

/** Shared NodejsFunction properties: runtime, arch, tracing, JSON logs, bundling, log group. */
export function functionProps(scope: Construct, logGroupId: string, timeout: Duration): Omit<NodejsFunctionProps, 'entry'> {
  return {
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 256,
    timeout,
    tracing: lambda.Tracing.ACTIVE,
    logGroup: new logs.LogGroup(scope, logGroupId, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    }),
    // The logger writes one JSON object per line; the JSON format passes it
    // through as fields (P-9). EMF records bypass console (src/shared/metrics.ts).
    loggingFormat: lambda.LoggingFormat.JSON,
    bundling: {
      minify: true,
      // No source maps: the logger writes error names only, never stacks, and
      // NODE_OPTIONS=--enable-source-maps is not set, so a map is only
      // artifact weight on every cold start.
      sourceMap: false,
      // Bundle the SDK clients so the artifact pins the versions the sample
      // was tested against.
      externalModules: [],
    },
  };
}

/** Acknowledges the two findings every NodejsFunction here raises, with the same reasons. */
export function acknowledgeLambdaFindings(fn: NodejsFunction): void {
  acknowledgeGranularFinding(
    fn,
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    'AWSLambdaBasicExecutionRole is the logs-only managed policy NodejsFunction attaches; a scoped replacement adds boilerplate for no change in access (ADR-0014).',
  );
  acknowledgeGranularFinding(
    fn,
    'AwsSolutions-IAM5[Resource::*]',
    "Active X-Ray tracing grants xray:PutTraceSegments/PutTelemetryRecords, which the X-Ray API accepts only on '*' (no resource ARN). Not over-breadth (ADR-0014).",
  );
}

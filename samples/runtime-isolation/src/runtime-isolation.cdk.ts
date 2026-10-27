// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `IsolatedRuntime` (spec §3, standard §4.5): a backend that trusts exactly
 * one ingress, which maps the validated caller to an isolated compute unit.
 * The ingress is a deploy-time choice (ADR-0003): an API Gateway REST API
 * with response streaming, or an AgentCore Gateway with a Runtime target.
 * Session mapping, scope checks and delegation are optional modules, off by
 * default (P-4).
 *
 * The token vending machine is always on (ADR-0018): every model call is
 * signed by a tenant role carrying the verified `TenantId`, so AWS attributes
 * model cost to the IAM principal per tenant (CUR 2.0). `tvm` stays an
 * optional prop, but only to let the deployer supply a role that also reaches
 * tenant data; unset, the construct creates `TenantModelRole`, which may
 * invoke only the one model. The agent holds no shared model permission: the
 * execution role has no `bedrock:Invoke*` (ADR-0008 amended by ADR-0018).
 *
 * The construct creates none of its data dependencies: the issuer, the agent
 * code and, with `tvm`, a data-bearing tenant role are props. It applies no
 * cdk-nag aspect and no App settings; it carries its own acknowledgments with
 * reasons.
 */

import * as path from 'node:path';
import { Duration, Lazy, Names, RemovalPolicy, Stack, Token, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AgentCoreRuntimeBackend, baseModelId, foundationModelArn, isInferenceProfileId, modelResourceArns } from './backend/agentcore-runtime.cdk';
import type { BackendKind } from './backend/backend';
import type { IBackend } from './backend/backend.cdk';
import { ENV } from './shared/config';
import { LogDrain } from './shared/log-drain';
import type { IngressKind } from './shared/metrics';
import { acknowledgeGranularFinding, nagFindingResource } from './shared/nag';
import { CONVERSATION_ID_PATTERN, type SessionScope } from './shared/session';
import { TENANT_TAG_KEY, USER_TAG_KEY } from './shared/tvm';

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

/** The agent the backend runs. */
export interface AgentProps {
  /** Directory with the agent's `app.js` (a Node HTTP server on port 8080), uploaded as the Runtime's code. */
  readonly codePath: string;
  /** The one Bedrock model id the execution role may invoke (P-6). */
  readonly modelId: string;
  /**
   * Environment variables for the agent process (the demo passes its table
   * name). Configuration only; never a secret.
   */
  readonly environment?: Record<string, string>;
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
   * creates `TenantModelRole`, which may invoke only the one model.
   */
  readonly role?: iam.IRole;
  /** Add `UserId = sub` as a session tag. Default false. */
  readonly includeUserIdTag?: boolean;
  /** Extra session tags: tag key to claim name. A claim missing from the token fails the request with 403. `TenantId` and `UserId` are reserved. */
  readonly claimTags?: Record<string, string>;
  /** Credential lifetime, 900 to 3600. Default 900. */
  readonly durationSeconds?: number;
}

export interface IsolatedRuntimeProps {
  readonly identity: IdentityProps;
  readonly agent: AgentProps;
  /** The isolating compute service (ADR-0011). Default `'agentcore-runtime'`. */
  readonly backend?: BackendKind;
  /** The ingress (ADR-0003). `'agentcore-gateway'` is valid only with the `'agentcore-runtime'` backend. */
  readonly ingress: IngressKind;
  /** Session mapping (ADR-0013). Unset: a fresh unit per request. */
  readonly session?: SessionProps;
  /** Scopes the token must all carry (ADR-0005). Unset: no scope check. */
  readonly requiredScopes?: string[];
  readonly delegation?: DelegationProps;
  /**
   * The TVM is always on (ADR-0018). Unset: the construct creates a
   * model-only `TenantModelRole`. Set: customise the TVM, and optionally
   * supply a role that also reaches tenant data.
   */
  readonly tvm?: TvmProps;
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
  };
}

/** IAM tag key shape (`[\p{L}\p{Z}\p{N}_.:/=+\-@]{1,128}`), restricted here to the plain subset. */
const TAG_KEY_PATTERN = /^[A-Za-z0-9_.:/=+\-@]{1,128}$/;

/** Validates props and applies defaults; throws an Error that names the prop (standard §4.5). */
export function resolveOptions(props: IsolatedRuntimeProps): ResolvedOptions {
  const fail = (prop: string, message: string): never => {
    throw new Error(`IsolatedRuntime: ${prop} ${message}`);
  };

  if (!Token.isUnresolved(props.identity.discoveryUrl)) {
    if (!/^https:\/\/.+\/\.well-known\/openid-configuration$/.test(props.identity.discoveryUrl)) {
      fail('identity.discoveryUrl', 'must be an https URL ending in /.well-known/openid-configuration');
    }
  }
  if (props.identity.allowedClientIds.length === 0 || props.identity.allowedClientIds.some((c) => c.length === 0)) {
    fail('identity.allowedClientIds', 'must be a non-empty list of non-empty client ids');
  }
  if (props.agent.codePath.length === 0) {
    fail('agent.codePath', 'must be a directory path');
  }
  if (props.agent.modelId.length === 0) {
    fail('agent.modelId', 'must be a Bedrock model id');
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
  const tvm: ResolvedOptions['tvm'] = {
    role: tvmProps.role,
    includeUserIdTag: tvmProps.includeUserIdTag ?? false,
    claimTags,
    durationSeconds,
  };

  return {
    backend,
    ingress: props.ingress,
    sessionScope,
    requiredScopes: props.requiredScopes,
    forwardUserToken,
    requireNarrowedToken,
    allowedScopes,
    tvm,
  };
}

// ---------------------------------------------------------------------------
// The construct
// ---------------------------------------------------------------------------

/** API Gateway stage name; part of `endpointUrl` on the `api-gateway` ingress. */
export const STAGE_NAME = 'prod';
/** The one route on both ingresses (spec §5). */
export const ROUTE = 'invocations';
/** Spike V-5: the integration timeout caps the stream; two minutes, not the 29 s default. */
export const INTEGRATION_TIMEOUT = Duration.minutes(2);
/** The Gateway target name; part of `endpointUrl` on the `agentcore-gateway` ingress. */
export const GATEWAY_TARGET_NAME = 'agent';

export class IsolatedRuntime extends Construct {
  /** The ingress invocation URL (spec §5). */
  readonly endpointUrl: string;
  /** The backend's resource ARN (for `agentcore-runtime`, the Runtime ARN). */
  readonly runtimeArn: string;
  /** The one principal the backend trusts (P-1): the integration Lambda's role, or the Gateway's role. */
  readonly ingressRole: iam.IRole;
  /** The agent's execution role (P-6). */
  readonly executionRole: iam.IRole;
  /** The role that validates the token and, with `tvm`, assumes the tenant role: the integration Lambda or the interceptor. */
  readonly tvmCallerRole: iam.IRole;
  /** The tenant role every model call is signed by (ADR-0018): the deployer's role, or the construct's default `TenantModelRole`. */
  readonly tenantRole: iam.IRole;
  /** The resolved options, for consumers and tests. */
  readonly options: ResolvedOptions;

  constructor(scope: Construct, id: string, props: IsolatedRuntimeProps) {
    super(scope, id);
    const options = resolveOptions(props);
    this.options = options;

    const backend: IBackend & AgentCoreRuntimeBackend = new AgentCoreRuntimeBackend(this, 'Backend', {
      codePath: props.agent.codePath,
      modelId: props.agent.modelId,
      environment: props.agent.environment,
      transports: { forwardUserToken: options.forwardUserToken, tenantCredentials: true },
    });
    this.runtimeArn = backend.resourceArn;
    this.executionRole = backend.executionRole;

    // The tenant-role ARN the ingress assumes. The default role is created
    // after the ingress (it trusts tvmCallerRole), so resolve its ARN lazily.
    const tenantRoleArn = options.tvm.role?.roleArn ?? Lazy.string({ produce: () => this.tenantRole.roleArn });
    const environment = ingressEnvironment(props, options, tenantRoleArn);

    if (options.ingress === 'api-gateway') {
      const api = this.apiGatewayIngress(props, options, environment, backend);
      this.endpointUrl = api.endpointUrl;
      this.ingressRole = api.ingressRole;
      this.tvmCallerRole = api.tvmCallerRole;
    } else {
      const gw = this.agentCoreGatewayIngress(props, options, environment, backend);
      this.endpointUrl = gw.endpointUrl;
      this.ingressRole = gw.ingressRole;
      this.tvmCallerRole = gw.tvmCallerRole;
    }

    backend.bindIngress(this.ingressRole);

    // The TVM is always on (ADR-0018). When the deployer supplies a role it
    // owns (and may use for tenant data), use it; otherwise create a
    // model-only `TenantModelRole` trusted by tvmCallerRole alone, built
    // AFTER tvmCallerRole exists so its trust names exactly that principal.
    this.tenantRole = options.tvm.role ?? this.defaultTenantRole(options);

    // Always add the one-model statement to the tenant role (default or the
    // deployer's): every model call is signed by a principal carrying the
    // verified TenantId, so AWS attributes model cost per tenant (ADR-0018).
    // Same ARNs and inference-profile acknowledgment as the old execution-role
    // OneModel statement (ADR-0008 amended).
    this.grantModel(this.tenantRole, props.agent.modelId);

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
  }

  /**
   * The default tenant role (ADR-0018): trusted by `tvmCallerRole` only,
   * requiring a non-empty `TenantId` request tag and `aws:TagKeys` pinned to
   * the configured tag set, with `sts:TagSession` and a one-hour maximum
   * session (role chaining caps there). It carries only the model statement
   * (added by the caller via `grantModel`), no data permission.
   */
  private defaultTenantRole(options: ResolvedOptions): iam.Role {
    const tagKeys = [TENANT_TAG_KEY];
    if (options.tvm.includeUserIdTag) {
      tagKeys.push(USER_TAG_KEY);
    }
    tagKeys.push(...Object.keys(options.tvm.claimTags));
    return new iam.Role(this, 'TenantModelRole', {
      description: 'Default tenant role (ADR-0018): assumable only by tvmCallerRole with a TenantId session tag; may invoke only the one model',
      assumedBy: new iam.ArnPrincipal(this.tvmCallerRole.roleArn)
        .withConditions({
          'StringLike': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: '?*' },
          'ForAllValues:StringEquals': { 'aws:TagKeys': tagKeys },
        })
        .withSessionTags(),
      maxSessionDuration: Duration.hours(1),
    });
  }

  /**
   * Adds the one-model statement (`bedrock:InvokeModel`,
   * `bedrock:InvokeModelWithResponseStream` on `modelResourceArns(modelId)`)
   * to a tenant role, with the inference-profile Region-wildcard
   * acknowledgment where the id is a cross-Region profile (ADR-0018, was the
   * execution role's `OneModel` under ADR-0008). An imported role (no
   * `addToPrincipalPolicy` effect) must already carry it; the README says so.
   */
  private grantModel(role: iam.IRole, modelId: string): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'OneModel',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: modelResourceArns(modelId),
      }),
    );
    if (isInferenceProfileId(modelId)) {
      acknowledgeGranularFinding(
        role,
        `AwsSolutions-IAM5[Resource::${nagFindingResource(this, foundationModelArn('*', baseModelId(modelId)))}]`,
        'A cross-Region inference profile routes the call to the model in any Region of its set, so the foundation-model ARN names one model with a Region wildcard; the profile ARN itself is exact (ADR-0018).',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Ingress A: API Gateway REST API, Lambda authoriser, streaming Lambda proxy
  // -------------------------------------------------------------------------
  private apiGatewayIngress(
    props: IsolatedRuntimeProps,
    options: ResolvedOptions,
    environment: Record<string, string>,
    backend: IBackend,
  ): { endpointUrl: string; ingressRole: iam.IRole; tvmCallerRole: iam.IRole } {
    const authorizerFn = new NodejsFunction(this, 'AuthorizerFunction', {
      ...functionProps(this, 'AuthorizerLogs', Duration.seconds(10)),
      entry: path.join(__dirname, 'ingress', 'api-gateway-authorizer.function.ts'),
      description: 'runtime-isolation: verifies the bearer token and returns the tenant as authoriser context (P-3, P-9)',
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
      environment: { ...environment, ...backend.ingressEnvironment },
    });
    acknowledgeLambdaFindings(ingressFn);

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });

    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${Names.uniqueResourceName(this, { maxLength: 48, separator: '-' })}-ingress`,
      description: 'runtime-isolation ingress: POST /invocations, bearer token verified by a Lambda authoriser',
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
        throttlingRateLimit: 50,
        throttlingBurstLimit: 25,
      },
    });

    const authorizer = new apigateway.RequestAuthorizer(this, 'Authorizer', {
      handler: authorizerFn,
      identitySources: [apigateway.IdentitySource.header('Authorization')],
      // Cached per Authorization header value: the same token re-verifies at
      // most once a minute, and a token is refused at most a minute after
      // it expires.
      // 60 s cache keyed on the Authorization header; the integration Lambda
      // re-verifies the token before any invoke (ADR-0015).
      resultsCacheTtl: Duration.minutes(1),
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

    api.root.addResource(ROUTE).addMethod(
      'POST',
      new apigateway.LambdaIntegration(ingressFn, {
        proxy: true,
        responseTransferMode: apigateway.ResponseTransferMode.STREAM,
        timeout: INTEGRATION_TIMEOUT,
      }),
      {
        authorizer,
        authorizationType: apigateway.AuthorizationType.CUSTOM,
        requestValidatorOptions: { requestValidatorName: 'body', validateRequestBody: true, validateRequestParameters: true },
        requestModels: { 'application/json': bodyModel },
      },
    );

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
      reason: 'POST /invocations is authorised by the custom Lambda authoriser (P-3, ADR-0001); cdk-nag reads the CUSTOM type without a Cognito pool as unauthorised.',
    });

    return {
      endpointUrl: `${api.url}${ROUTE}`,
      ingressRole: ingressFn.role!,
      tvmCallerRole: ingressFn.role!,
    };
  }

  // -------------------------------------------------------------------------
  // Ingress B: AgentCore Gateway with a REQUEST interceptor and a Runtime target
  // -------------------------------------------------------------------------
  private agentCoreGatewayIngress(
    props: IsolatedRuntimeProps,
    options: ResolvedOptions,
    environment: Record<string, string>,
    backend: AgentCoreRuntimeBackend,
  ): { endpointUrl: string; ingressRole: iam.IRole; tvmCallerRole: iam.IRole } {
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
      description: 'AgentCore Gateway role: the one principal the Runtime trusts (ADR-0001)',
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
      description: 'runtime-isolation ingress: CUSTOM_JWT inbound, REQUEST interceptor, Runtime target',
      roleArn: gatewayRole.roleArn,
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: props.identity.discoveryUrl,
          allowedClients: props.identity.allowedClientIds,
          // ADR-0005: the service checks scopes before the interceptor runs; the interceptor enforces AND.
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

    backend.addGatewayTarget(gateway, GATEWAY_TARGET_NAME);

    // ADR-0019: the Gateway invokes the interceptor; its late logs must land
    // before the interceptor's log group is deleted.
    const drain = new LogDrain(this, 'LogDrain');
    drain.protect(interceptorFn.logGroup);
    drain.writer(gateway);

    return {
      endpointUrl: `${gateway.attrGatewayUrl}/${GATEWAY_TARGET_NAME}/${ROUTE}`,
      ingressRole: gatewayRole,
      tvmCallerRole: interceptorFn.role!,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The ingress Lambdas' environment (src/shared/config.ts): every option, backend-neutral. */
function ingressEnvironment(props: IsolatedRuntimeProps, options: ResolvedOptions, tenantRoleArn: string): Record<string, string> {
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
  return env;
}

/** Shared NodejsFunction properties: runtime, arch, tracing, JSON logs, bundling, log group. */
function functionProps(scope: Construct, logGroupId: string, timeout: Duration): Omit<NodejsFunctionProps, 'entry'> {
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
      sourceMap: true,
      // Bundle the SDK clients so the artifact pins the versions the sample
      // was tested against.
      externalModules: [],
    },
  };
}

/** Acknowledges the two findings every NodejsFunction here raises, with the same reasons. */
function acknowledgeLambdaFindings(fn: NodejsFunction): void {
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

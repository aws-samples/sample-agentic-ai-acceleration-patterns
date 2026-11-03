// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `ToolsGateway` (spec C-15, §3.6, §5.4; ADR-0034, ADR-0040, ADR-0041): one
 * named AgentCore Gateway that tools sit behind. `SharedIngress` creates one
 * per entry of `toolsGateways` (`toolsGateway` is shorthand for one named
 * `default`), unless `toolsGateway: false`. Several gateways exist because a
 * Policy engine's Cedar schema is capped at 400 KB, about 330 tools
 * (V-16a); each gateway has its own engine and holds at most
 * `maxToolsPerGateway` catalogued tools.
 *
 * - Inbound: `CUSTOM_JWT` whose `discoveryUrl` is the ingress issuer's own
 *   discovery URL, `allowedAudience: ['tools-gateway:<name>']`, no
 *   `allowedClients` (the transaction token has no `client_id`). An
 *   identity token fails on `iss`; a token minted for another gateway fails
 *   on `aud`.
 * - A REQUEST interceptor (src/tools/interceptor.function.ts) with
 *   provisioned concurrency, the first wall and the per-tool wall (it runs
 *   before Policy, V-11; Policy holds one star permit per target, ADR-0041).
 * - With `responseFilter`, a RESPONSE interceptor
 *   (src/tools/response-filter.function.ts) that trims `tools/list` pages to
 *   the exact tools in `scope`.
 * - AgentCore Policy in `ENFORCE` mode, default deny, one engine per
 *   gateway; `ToolTarget` writes one Cedar star permit per target, one at a
 *   time (V-14).
 * - The `ToolContextKey` is shared by every gateway of the ingress and passed
 *   in (see `SharedIngress`); this construct adds `kms:Sign` for its own
 *   interceptor to the key policy (M-56, M-68).
 * - Native per-tenant rate limits keyed on `$.context.jwt.tenant_id`, per
 *   gateway (fairness, not isolation: fail-open by design, M-60).
 * - MCP `supportedVersions` includes `2025-11-25` (V-15a: URL elicitation).
 * - Application-log delivery is OFF: no delivery source is created
 *   (ADR-0040; V-13 found those logs hold request and response bodies).
 *
 * CloudFormation coverage in aws-cdk-lib 2.274.0: `CfnGateway`,
 * `CfnGatewayTarget`, `CfnPolicyEngine`, `CfnPolicy` and
 * `CfnGatewayRateLimit` all exist. Policies still go through a custom
 * resource (src/tools/tool-policy.function.ts) for the retry and the
 * delete-then-wait ordering ADR-0040 requires.
 */

import * as path from 'node:path';
import { CustomResource, Duration, Names, Stack } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct, type IConstruct } from 'constructs';
import { customResourceFunction } from './shared/custom-resource.cdk';
import { acknowledgeLambdaFindings, functionProps } from './shared/function.cdk';
import { LogDrain } from './shared/log-drain';
import { toolsGatewayAudience } from './shared/mint';
import { acknowledgeGranularFinding, nagFindingResource } from './shared/nag';
import { TOOLS_ENV } from './tools/interceptor.function';

/** The quota on targets per Gateway (V-14: the 101st is `ServiceQuotaExceededException`). */
export const MAX_TOOL_TARGETS = 100;

/** Default and bounds of `maxToolsPerGateway` (spec §3.3, ADR-0041; the engine holds about 330 one-field tools, V-16a). */
export const DEFAULT_MAX_TOOLS_PER_GATEWAY = 300;
export const MAX_TOOLS_PER_GATEWAY_LIMIT = 1000;

/** MCP protocol versions the tools gateway lists (V-15a needs `2025-11-25`). */
export const MCP_SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/**
 * The JWT path the per-tenant rate limit is keyed on (spec §3.6): the
 * documented `$.context.jwt.<claim>` dimension, read from the token the
 * Gateway's authoriser validated, with `*` as the per-tenant default entry
 * (AgentCore developer guide, "Rate limit dimensions").
 */
export const TENANT_RATE_LIMIT_DIMENSION = '$.context.jwt.tenant_id';

/**
 * The actions the Gateway execution role needs to use its Policy engine
 * (AgentCore developer guide, "AgentCore Gateway and Policy in AgentCore IAM
 * Permissions"): `GetPolicyEngine` on the engine, `AuthorizeAction` (a
 * `tools/call`) and `PartiallyAuthorizeActions` (the `tools/list` filter)
 * on the engine and the gateway. `GetWorkloadAccessToken` is needed only for
 * temporal policies with IAM inbound auth, which this gateway does not use.
 */
export const POLICY_ENGINE_READ_ACTIONS = ['bedrock-agentcore:GetPolicyEngine'] as const;
export const POLICY_AUTHORIZE_ACTIONS = ['bedrock-agentcore:AuthorizeAction', 'bedrock-agentcore:PartiallyAuthorizeActions'] as const;

/**
 * The per-tenant rate limit entries (spec §3.6, M-60): one `*` entry at the
 * default rate, which gives every tenant its own bucket, and one entry per
 * named override, each `requests` per `second`.
 */
export function tenantRateLimitEntries(
  requestsPerSecond: number,
  overrides: Readonly<Record<string, number>>,
): agentcore.CfnGatewayRateLimit.LimitEntryProperty[] {
  return [
    { dimensions: { [TENANT_RATE_LIMIT_DIMENSION]: '*' }, requests: [{ period: 'second', rate: requestsPerSecond }] },
    ...Object.entries(overrides).map(([tenantId, rate]) => ({
      dimensions: { [TENANT_RATE_LIMIT_DIMENSION]: tenantId },
      requests: [{ period: 'second', rate }],
    })),
  ];
}

/** One tools gateway's settings after defaults and validation (spec §3.3). */
export interface ResolvedToolsGateway {
  readonly requestsPerSecond: number;
  readonly overrides: Readonly<Record<string, number>>;
  readonly interceptorProvisionedConcurrency: number;
  readonly contextLifetimeSeconds: number;
  /** (ADR-0041) Synth fails when the gateway's ToolTargets would catalogue more tools. */
  readonly maxToolsPerGateway: number;
  /** (ADR-0041) A RESPONSE interceptor trims `tools/list` to the exact tools in `scope`. */
  readonly responseFilter: boolean;
}

export interface ToolsGatewayProps {
  /** The gateway's name, `[a-z0-9-]{1,32}`: its audience is `tools-gateway:<name>` (ADR-0041). */
  readonly name: string;
  /** The ingress issuer, `<baseUrl>`; `CUSTOM_JWT` reads `<issuer>/.well-known/openid-configuration`. */
  readonly issuer: string;
  /** The published ingress role ARN, the `act.sub` the interceptor requires (M-43). */
  readonly ingressRoleArn: string;
  readonly options: ResolvedToolsGateway;
  /** The ingress's one tool-context signing key, shared by every gateway (M-68). */
  readonly contextKey: kms.Key;
  /**
   * Something the Gateway must be created after: the issuer's deployed
   * discovery routes, which the service fetches at create time.
   */
  readonly issuerReady?: IConstruct;
}

/** PascalCase of a gateway name, for logical ids and statement ids. */
export function gatewayIdPart(name: string): string {
  return name
    .split('-')
    .filter((p) => p.length > 0)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

export class ToolsGateway extends Construct {
  /** The gateway's name (ADR-0041). */
  readonly name: string;
  readonly gateway: agentcore.CfnGateway;
  /** The MCP endpoint (`.../mcp`). */
  readonly gatewayUrl: string;
  readonly gatewayIdentifier: string;
  readonly gatewayArn: string;
  /** The Gateway's physical name; its id and its workload identity are `<physicalName>-<suffix>`. */
  readonly physicalName: string;
  /** The Gateway's role: invokes the interceptors and the registered tool functions only (M-61). */
  readonly gatewayRole: iam.Role;
  readonly policyEngine: agentcore.CfnPolicyEngine;
  /** The key that signs tenant contexts (C-15, M-68); the ingress's, shared by every gateway. */
  readonly contextKey: kms.Key;
  readonly interceptor: NodejsFunction;
  /** The RESPONSE interceptor; undefined unless `responseFilter`. */
  readonly responseFilter?: NodejsFunction;
  /** The handler behind every same-stack `ToolTarget`'s policy resource. */
  readonly policyFunction: NodejsFunction;
  readonly logDrain: LogDrain;
  readonly maxToolsPerGateway: number;

  private targets = 0;
  private tools = 0;
  private lastPolicy?: CustomResource;

  constructor(scope: Construct, id: string, props: ToolsGatewayProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const o = props.options;
    this.name = props.name;
    this.maxToolsPerGateway = o.maxToolsPerGateway;
    this.contextKey = props.contextKey;

    const verifierEnv = {
      [TOOLS_ENV.ISSUER]: props.issuer,
      [TOOLS_ENV.INGRESS_ROLE_ARN]: props.ingressRoleArn,
      [TOOLS_ENV.GATEWAY_NAME]: props.name,
    };
    this.interceptor = new NodejsFunction(this, 'InterceptorFunction', {
      ...functionProps(this, 'InterceptorLogs', Duration.seconds(10)),
      entry: path.join(__dirname, 'tools', 'interceptor.function.ts'),
      description: `runtime-isolation: tools gateway ${props.name} REQUEST interceptor; verifies the transaction token, signs the tenant context (ADR-0034, ADR-0041)`,
      memorySize: 512,
      environment: {
        ...verifierEnv,
        [TOOLS_ENV.CONTEXT_KEY_ID]: this.contextKey.keyId,
        [TOOLS_ENV.CONTEXT_LIFETIME_SECONDS]: String(o.contextLifetimeSeconds),
      },
    });
    acknowledgeLambdaFindings(this.interceptor);
    // M-68: kms:Sign on the shared context key for this gateway's interceptor, in the key policy.
    this.contextKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: `SignToolContexts${gatewayIdPart(props.name)}`,
        principals: [this.interceptor.grantPrincipal],
        actions: ['kms:Sign'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:SigningAlgorithm': 'RSASSA_PKCS1_V1_5_SHA_256' } },
      }),
    );
    const live = new lambda.Alias(this, 'InterceptorLive', {
      aliasName: 'live',
      version: this.interceptor.currentVersion,
      provisionedConcurrentExecutions: o.interceptorProvisionedConcurrency > 0 ? o.interceptorProvisionedConcurrency : undefined,
    });

    // Gateway names match ^([0-9a-zA-Z][-]?){1,48}$ and are lowercased in the ARN (ADR-0027).
    const gatewayName = `${Names.uniqueResourceName(this, { maxLength: 40, separator: '-' })}-tools`.toLowerCase();
    this.physicalName = gatewayName;
    this.gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:gateway/${gatewayName}-*` },
        },
      }),
      description: `Tools gateway ${props.name} role: invokes the interceptors and the registered tool functions only (ADR-0034, M-61)`,
    });
    const interceptorArns = [live.functionArn];

    const interceptorConfigurations: agentcore.CfnGateway.GatewayInterceptorConfigurationProperty[] = [
      {
        interceptor: { lambda: { arn: live.functionArn } },
        interceptionPoints: ['REQUEST'],
        // The interceptor re-verifies the bearer token (spec §3.6).
        inputConfiguration: { passRequestHeaders: true },
      },
    ];
    if (o.responseFilter) {
      this.responseFilter = new NodejsFunction(this, 'ResponseFilterFunction', {
        ...functionProps(this, 'ResponseFilterLogs', Duration.seconds(10)),
        entry: path.join(__dirname, 'tools', 'response-filter.function.ts'),
        description: `runtime-isolation: tools gateway ${props.name} RESPONSE interceptor; trims tools/list to the tools in scope, fail-closed (ADR-0041)`,
        memorySize: 512,
        environment: verifierEnv,
      });
      acknowledgeLambdaFindings(this.responseFilter);
      interceptorArns.push(this.responseFilter.functionArn);
      interceptorConfigurations.push({
        interceptor: { lambda: { arn: this.responseFilter.functionArn } },
        interceptionPoints: ['RESPONSE'],
        // The filter verifies the bearer token from the request headers (documented for
        // passRequestHeaders; integ step 24 confirms it on a deployed Gateway).
        inputConfiguration: { passRequestHeaders: true },
      });
    }
    this.gatewayRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'InvokeInterceptors', actions: ['lambda:InvokeFunction'], resources: interceptorArns }),
    );

    // Names: [A-Za-z][A-Za-z0-9_]* (the spike's engine name had no hyphen).
    const engineName = `${Names.uniqueResourceName(this, { maxLength: 40, separator: '', allowedSpecialCharacters: '' })}Tools`;
    this.policyEngine = new agentcore.CfnPolicyEngine(this, 'PolicyEngine', {
      name: engineName,
      description: `runtime-isolation tools gateway ${props.name}: one Cedar star permit per tool target on the scope claim (ADR-0034, ADR-0041)`,
    });
    // The three documented Policy actions, on this one engine and this one gateway (M-58).
    // The gateway's own ARN would make the role's policy depend on the gateway, which
    // depends on the role; its id is `<name>-<suffix>`, so the name pattern the trust
    // policy uses names it.
    const ownGatewayArn = `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:gateway/${gatewayName}-*`;
    this.gatewayRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'ReadPolicyEngine', actions: [...POLICY_ENGINE_READ_ACTIONS], resources: [this.policyEngine.attrPolicyEngineArn] }),
    );
    this.gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AuthorizeWithPolicyEngine',
        actions: [...POLICY_AUTHORIZE_ACTIONS],
        resources: [this.policyEngine.attrPolicyEngineArn, ownGatewayArn],
      }),
    );
    acknowledgeGranularFinding(
      this.gatewayRole,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, ownGatewayArn)}]`,
      'The gateway this role belongs to, named by its name pattern: its id carries a service suffix and its ARN cannot be referenced without a cycle (ADR-0034, M-58).',
    );

    this.gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: gatewayName,
      description: `runtime-isolation tools gateway ${props.name}: CUSTOM_JWT on the ingress issuer, REQUEST interceptor, Policy on scope (ADR-0034, ADR-0041)`,
      roleArn: this.gatewayRole.roleArn,
      protocolType: 'MCP',
      protocolConfiguration: { mcp: { supportedVersions: MCP_SUPPORTED_VERSIONS } },
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: `${props.issuer}/.well-known/openid-configuration`,
          allowedAudience: [toolsGatewayAudience(props.name)],
        },
      },
      interceptorConfigurations,
      policyEngineConfiguration: { arn: this.policyEngine.attrPolicyEngineArn, mode: 'ENFORCE' },
    });
    this.gateway.node.addDependency(this.gatewayRole);
    if (props.issuerReady !== undefined) {
      this.gateway.node.addDependency(props.issuerReady);
    }
    this.gatewayUrl = this.gateway.attrGatewayUrl;
    this.gatewayIdentifier = this.gateway.attrGatewayIdentifier;
    this.gatewayArn = this.gateway.attrGatewayArn;

    // M-60: per-tenant fairness, per gateway (ADR-0041), as the documented L1 resource.
    new agentcore.CfnGatewayRateLimit(this, 'TenantRateLimit', {
      gatewayIdentifier: this.gatewayIdentifier,
      description: `runtime-isolation: requests per second per tenant on tools gateway ${props.name} (fairness only, fail-open by design; M-60)`,
      dimensionKeys: [TENANT_RATE_LIMIT_DIMENSION],
      entries: tenantRateLimitEntries(o.requestsPerSecond, o.overrides),
    });

    this.policyFunction = customResourceFunction(
      this,
      'PolicyFunction',
      path.join(__dirname, 'tools', 'tool-policy.function.ts'),
      `runtime-isolation: one Cedar policy (star permit) per tool target on tools gateway ${props.name}; sequential create, delete-then-wait (ADR-0040, ADR-0041)`,
      Duration.minutes(15),
    );
    grantPolicyWrites(this.policyFunction, this.policyEngine.attrPolicyEngineArn, this.gatewayArn);

    // ADR-0019: the Gateway invokes the interceptors; their late logs land before the groups go.
    this.logDrain = new LogDrain(this, 'LogDrain');
    this.logDrain.protect(this.interceptor.logGroup);
    if (this.responseFilter !== undefined) {
      this.logDrain.protect(this.responseFilter.logGroup);
    }
    this.logDrain.writer(this.gateway);

    // ADR-0040, V-14: at most 100 targets per tools gateway; the ones this app can see are counted.
    this.node.addValidation({
      validate: () =>
        this.targets > MAX_TOOL_TARGETS
          ? [`SharedIngress: tools gateway '${props.name}' holds at most ${MAX_TOOL_TARGETS} ToolTargets (got ${this.targets}; ADR-0040)`]
          : [],
    });
  }

  /**
   * (ADR-0041) Counts a target's catalogued tools against
   * `maxToolsPerGateway`; returns the problem instead of counting when they
   * would not fit.
   */
  reserveTools(target: string, count: number): string | undefined {
    if (this.tools + count > this.maxToolsPerGateway) {
      return `would bring tools gateway '${this.name}' to ${this.tools + count} catalogued tools with target '${target}', over maxToolsPerGateway ${this.maxToolsPerGateway} (ADR-0041)`;
    }
    this.tools += count;
    return undefined;
  }

  /**
   * Counts a target against the per-Gateway quota and chains its policy
   * resource after the previous one, so policies are written one at a time
   * (V-14; still needed with one policy per target, the engine serialises
   * writes across targets).
   */
  registerTarget(policy: CustomResource): void {
    this.targets += 1;
    if (this.lastPolicy !== undefined) {
      policy.node.addDependency(this.lastPolicy);
    }
    this.lastPolicy = policy;
  }

  /** Targets registered so far in this app. */
  get targetCount(): number {
    return this.targets;
  }

  /** Catalogued tools of the same-app targets registered so far. */
  get toolCount(): number {
    return this.tools;
  }

  /** Lets the Gateway role invoke one tool function, by exact ARN (M-61). */
  allowInvoke(fn: lambda.IFunction): void {
    this.gatewayRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [fn.functionArn] }));
  }
}

/**
 * The policy custom resource's role (ADR-0040): policy CRUD on one engine,
 * plus what `CreatePolicy` and `UpdatePolicy` need on the gateway the
 * policy names: `InvokeGateway` (the service validates the Cedar actions
 * against the gateway as that action, else the policy ends `CREATE_FAILED`
 * "Insufficient permissions to call gateway") and the permission-only
 * `ManageResourceScopedPolicy` (a policy whose resource is one gateway ARN).
 */
export function grantPolicyWrites(fn: NodejsFunction, policyEngineArn: string, gatewayArn: string): void {
  const resources = [policyEngineArn, `${policyEngineArn}/policy/*`];
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'OneEnginePolicies',
      actions: ['bedrock-agentcore:CreatePolicy', 'bedrock-agentcore:GetPolicy', 'bedrock-agentcore:UpdatePolicy', 'bedrock-agentcore:DeletePolicy'],
      resources,
    }),
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'ValidatePoliciesOnOneGateway',
      // CreatePolicy reads the gateway with the caller's identity (CloudTrail: GetGateway AccessDenied, integ 2026-11-03).
      actions: ['bedrock-agentcore:GetGateway', 'bedrock-agentcore:InvokeGateway', 'bedrock-agentcore:ManageResourceScopedPolicy'],
      resources: [gatewayArn],
    }),
  );
  acknowledgeGranularFinding(
    fn,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(fn, resources[1])}]`,
    'Policy ids are minted by the service at create time, so the grant is the policies of this one engine (ADR-0040, M-58).',
  );
}

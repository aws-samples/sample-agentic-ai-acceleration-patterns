// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `ToolsGateway` (spec C-15, §3.6, §5.4; ADR-0034, ADR-0040): the one shared
 * AgentCore Gateway every tool sits behind, created by `SharedIngress`
 * unless `toolsGateway: false`.
 *
 * - Inbound: `CUSTOM_JWT` whose `discoveryUrl` is the ingress issuer's own
 *   discovery URL, `allowedAudience: ['tools-gateway']`, no `allowedClients`
 *   (the transaction token has no `client_id`). An identity token fails on
 *   `iss`.
 * - A REQUEST interceptor (src/tools/interceptor.function.ts) with
 *   provisioned concurrency, the first wall (it runs before Policy, V-11).
 * - AgentCore Policy in `ENFORCE` mode, default deny; `ToolTarget` writes one
 *   Cedar policy per target, one at a time (V-14).
 * - `ToolContextKey`, a second KMS key, `kms:Sign` for the interceptor alone;
 *   never in the ingress JWKS (M-56, M-68).
 * - Native per-tenant rate limits keyed on `$.context.jwt.tenant_id`
 *   (fairness, not isolation: fail-open by design, M-60).
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
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct, type IConstruct } from 'constructs';
import { customResourceFunction } from './shared/custom-resource.cdk';
import { acknowledgeLambdaFindings, functionProps } from './shared/function.cdk';
import { LogDrain } from './shared/log-drain';
import { TOOLS_GATEWAY_AUDIENCE } from './shared/mint';
import { acknowledgeGranularFinding, nagFindingResource } from './shared/nag';
import { signingKey } from './shared/token-signer.cdk';
import { TOOLS_ENV } from './tools/interceptor.function';

/** The quota on targets per Gateway (V-14: the 101st is `ServiceQuotaExceededException`). */
export const MAX_TOOL_TARGETS = 100;

/** MCP protocol versions the tools gateway lists (V-15a needs `2025-11-25`). */
export const MCP_SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** The JWT path the per-tenant rate limit is keyed on (spec §3.6). */
export const TENANT_RATE_LIMIT_DIMENSION = '$.context.jwt.tenant_id';

/** The tools gateway's settings after defaults and validation (spec §3.3). */
export interface ResolvedToolsGateway {
  readonly requestsPerSecond: number;
  readonly overrides: Readonly<Record<string, number>>;
  readonly interceptorProvisionedConcurrency: number;
  readonly contextLifetimeSeconds: number;
}

export interface ToolsGatewayProps {
  /** The ingress issuer, `<baseUrl>`; `CUSTOM_JWT` reads `<issuer>/.well-known/openid-configuration`. */
  readonly issuer: string;
  /** The published ingress role ARN, the `act.sub` the interceptor requires (M-43). */
  readonly ingressRoleArn: string;
  readonly options: ResolvedToolsGateway;
  /**
   * Something the Gateway must be created after: the issuer's deployed
   * discovery routes, which the service fetches at create time.
   */
  readonly issuerReady?: IConstruct;
}

export class ToolsGateway extends Construct {
  readonly gateway: agentcore.CfnGateway;
  /** The MCP endpoint (`.../mcp`). */
  readonly gatewayUrl: string;
  readonly gatewayIdentifier: string;
  readonly gatewayArn: string;
  /** The Gateway's role: invokes the interceptor and the registered tool functions only (M-61). */
  readonly gatewayRole: iam.Role;
  readonly policyEngine: agentcore.CfnPolicyEngine;
  /** The key that signs tenant contexts (C-15, M-68). */
  readonly contextKey: kms.Key;
  readonly interceptor: NodejsFunction;
  /** The handler behind every same-stack `ToolTarget`'s policy resource. */
  readonly policyFunction: NodejsFunction;
  readonly logDrain: LogDrain;

  private targets = 0;
  private lastPolicy?: CustomResource;

  constructor(scope: Construct, id: string, props: ToolsGatewayProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const o = props.options;

    this.contextKey = signingKey(this, 'ToolContextKey', kms.KeySpec.RSA_2048, 'runtime-isolation tool context signing key (ADR-0034)', {
      delegatePublicKey: true, // the tool library in another stack reads the public half through IAM (M-68)
    });

    this.interceptor = new NodejsFunction(this, 'InterceptorFunction', {
      ...functionProps(this, 'InterceptorLogs', Duration.seconds(10)),
      entry: path.join(__dirname, 'tools', 'interceptor.function.ts'),
      description: 'runtime-isolation: tools gateway REQUEST interceptor; verifies the transaction token, signs the tenant context (ADR-0034)',
      memorySize: 512,
      environment: {
        [TOOLS_ENV.ISSUER]: props.issuer,
        [TOOLS_ENV.INGRESS_ROLE_ARN]: props.ingressRoleArn,
        [TOOLS_ENV.CONTEXT_KEY_ID]: this.contextKey.keyId,
        [TOOLS_ENV.CONTEXT_LIFETIME_SECONDS]: String(o.contextLifetimeSeconds),
      },
    });
    acknowledgeLambdaFindings(this.interceptor);
    // M-68: kms:Sign on the context key for the interceptor alone, in the key policy.
    this.contextKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'SignToolContexts',
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
    this.gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:gateway/${gatewayName}-*` },
        },
      }),
      description: 'Tools gateway role: invokes the interceptor and the registered tool functions only (ADR-0034, M-61)',
    });
    this.gatewayRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'InvokeInterceptor', actions: ['lambda:InvokeFunction'], resources: [live.functionArn] }),
    );

    // Names: [A-Za-z][A-Za-z0-9_]* (the spike's engine name had no hyphen).
    const engineName = `${Names.uniqueResourceName(this, { maxLength: 40, separator: '', allowedSpecialCharacters: '' })}Tools`;
    this.policyEngine = new agentcore.CfnPolicyEngine(this, 'PolicyEngine', {
      name: engineName,
      description: 'runtime-isolation tools gateway: one Cedar policy per tool target on the scope claim (ADR-0034)',
    });
    // TODO(v2): narrow to the exact actions the Gateway calls on its policy engine once a deploy shows them (the spike granted bedrock-agentcore:*).
    const engineResources = [this.policyEngine.attrPolicyEngineArn, `${this.policyEngine.attrPolicyEngineArn}/*`];
    this.gatewayRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'EvaluatePolicies', actions: ['bedrock-agentcore:*'], resources: engineResources }),
    );
    acknowledgeGranularFinding(
      this.gatewayRole,
      'AwsSolutions-IAM5[Action::bedrock-agentcore:*]',
      'The Gateway evaluates its own policy engine; the action set it needs is not documented yet, so the grant is every action on this one engine and its policies, nothing else (ADR-0034, M-58).',
    );
    acknowledgeGranularFinding(
      this.gatewayRole,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, `${this.policyEngine.attrPolicyEngineArn}/*`)}]`,
      'The policies of this one engine; ToolTargets add and remove them without a gateway deploy (ADR-0034, M-58).',
    );

    this.gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: gatewayName,
      description: 'runtime-isolation tools gateway: CUSTOM_JWT on the ingress issuer, REQUEST interceptor, Policy on scope (ADR-0034)',
      roleArn: this.gatewayRole.roleArn,
      protocolType: 'MCP',
      protocolConfiguration: { mcp: { supportedVersions: MCP_SUPPORTED_VERSIONS } },
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: `${props.issuer}/.well-known/openid-configuration`,
          allowedAudience: [TOOLS_GATEWAY_AUDIENCE],
        },
      },
      interceptorConfigurations: [
        {
          interceptor: { lambda: { arn: live.functionArn } },
          interceptionPoints: ['REQUEST'],
          // The interceptor re-verifies the bearer token (spec §3.6).
          inputConfiguration: { passRequestHeaders: true },
        },
      ],
      policyEngineConfiguration: { arn: this.policyEngine.attrPolicyEngineArn, mode: 'ENFORCE' },
    });
    this.gateway.node.addDependency(this.gatewayRole);
    if (props.issuerReady !== undefined) {
      this.gateway.node.addDependency(props.issuerReady);
    }
    this.gatewayUrl = this.gateway.attrGatewayUrl;
    this.gatewayIdentifier = this.gateway.attrGatewayIdentifier;
    this.gatewayArn = this.gateway.attrGatewayArn;

    // M-60: per-tenant fairness. TODO(v2): confirm the dimension key syntax and the '*' default entry against a deployed Gateway.
    new agentcore.CfnGatewayRateLimit(this, 'TenantRateLimit', {
      gatewayIdentifier: this.gatewayIdentifier,
      description: 'runtime-isolation: requests per second per tenant (fairness only, fail-open by design; M-60)',
      dimensionKeys: [TENANT_RATE_LIMIT_DIMENSION],
      entries: [
        { dimensions: { [TENANT_RATE_LIMIT_DIMENSION]: '*' }, requests: [{ period: 'second', rate: o.requestsPerSecond }] },
        ...Object.entries(o.overrides).map(([tenantId, rate]) => ({
          dimensions: { [TENANT_RATE_LIMIT_DIMENSION]: tenantId },
          requests: [{ period: 'second', rate }],
        })),
      ],
    });

    this.policyFunction = customResourceFunction(
      this,
      'PolicyFunction',
      path.join(__dirname, 'tools', 'tool-policy.function.ts'),
      'runtime-isolation: one Cedar policy per tool target; sequential create, delete-then-wait (ADR-0040)',
      Duration.minutes(15),
    );
    grantPolicyWrites(this.policyFunction, this.policyEngine.attrPolicyEngineArn);

    // ADR-0019: the Gateway invokes the interceptor; its late logs land before the group goes.
    this.logDrain = new LogDrain(this, 'LogDrain');
    this.logDrain.protect(this.interceptor.logGroup);
    this.logDrain.writer(this.gateway);

  }

  /**
   * Counts a target against the per-Gateway quota and chains its policy
   * resource after the previous one, so policies are written one at a time
   * (V-14).
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

  /** Lets the Gateway role invoke one tool function, by exact ARN (M-61). */
  allowInvoke(fn: lambda.IFunction): void {
    this.gatewayRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [fn.functionArn] }));
  }
}

/** The policy custom resource's role: policy CRUD on one engine (ADR-0040). */
export function grantPolicyWrites(fn: NodejsFunction, policyEngineArn: string): void {
  const resources = [policyEngineArn, `${policyEngineArn}/policy/*`];
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'OneEnginePolicies',
      actions: ['bedrock-agentcore:CreatePolicy', 'bedrock-agentcore:GetPolicy', 'bedrock-agentcore:UpdatePolicy', 'bedrock-agentcore:DeletePolicy'],
      resources,
    }),
  );
  acknowledgeGranularFinding(
    fn,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(fn, resources[1])}]`,
    'Policy ids are minted by the service at create time, so the grant is the policies of this one engine (ADR-0040, M-58).',
  );
}

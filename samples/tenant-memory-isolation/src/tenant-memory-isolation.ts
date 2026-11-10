// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `TenantMemoryIsolation` (spec §3, §6; standard §4.5): one pooled
 * AgentCore Memory resource that tenants reach only through an AgentCore
 * Gateway. The Gateway authenticates the caller's access token
 * (`CUSTOM_JWT`), AgentCore Policy in `ENFORCE` mode compares each request
 * with the token's tenant and session claims (src/policies.ts), the native
 * `agentcore-memory` connector calls Memory as the Gateway execution role,
 * and a Memory resource policy denies every data operation to every other
 * principal (src/fence.ts).
 *
 * The construct takes its issuer as props and creates none: any OIDC issuer
 * whose access tokens carry the repository's token contract (ARCHITECTURE.md
 * §2.1) fits.
 */

import { CfnResource, Names, RemovalPolicy, Stack, Token } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { fencePolicy } from './fence';
import { AGENT_OPERATIONS, type ClaimNames, DEFAULT_CLAIMS, eventWritePolicy, sharedRecallPolicy, TARGET_NAME } from './policies';

/** The issuer the Gateway trusts (spec §6.1). */
export interface MemoryIssuer {
  /** The issuer's OIDC discovery URL (`https://.../.well-known/openid-configuration`). */
  readonly discoveryUrl: string;
  /** App clients whose access tokens are accepted (`client_id`). Give this, `allowedAudience`, or both. */
  readonly allowedClients?: string[];
  /** Audiences accepted (`aud`), for issuers whose access tokens carry no `client_id`. */
  readonly allowedAudience?: string[];
}

/** Which claims carry the tenant and the session (ADR-0009). */
export interface MemoryClaims {
  /** The tenant claim. Default `tenant_id`. */
  readonly tenant?: string;
  /** The claim a write's `sessionId` must equal. Default `sub`: one conversation history per user. */
  readonly session?: string;
  /**
   * The required `token_use` value. Default `access`, so an ID token is
   * refused. Set `false` only for an issuer that emits no `token_use` and
   * binds its access tokens with `allowedAudience`.
   */
  readonly tokenUse?: string | false;
}

export interface TenantMemoryIsolationProps {
  readonly issuer: MemoryIssuer;
  readonly claims?: MemoryClaims;
  /** Days short-term events are kept, 7 to 365. Default 30. */
  readonly eventExpiryDays?: number;
  /** Requests per second each tenant may make through the Gateway (fairness, M-11). Default 25. */
  readonly tenantRequestsPerSecond?: number;
  /** Retention of the Memory application log group (per-tenant extraction telemetry). Default one month. */
  readonly logRetention?: logs.RetentionDays;
}

/** Defaults and bounds (spec §6.1). */
export const DEFAULT_EVENT_EXPIRY_DAYS = 30;
export const DEFAULT_TENANT_REQUESTS_PER_SECOND = 25;
export const MEMORY_STRATEGY_NAME = 'TenantFacts';
/** The strategy's namespace template: each tenant's facts live in the namespace that equals its tenant id (ADR-0009). */
export const NAMESPACE_TEMPLATE = '{actorId}';

const CLAIM_NAME = /^[A-Za-z0-9_:.-]{1,64}$/;

function fail(prop: string, problem: string): never {
  throw new Error(`TenantMemoryIsolation: ${prop} ${problem}`);
}

/** Validates props and applies defaults (standard §4.5: fail at synth, naming the prop). */
export function resolveClaims(props: TenantMemoryIsolationProps): ClaimNames {
  const { issuer } = props;
  if (!Token.isUnresolved(issuer.discoveryUrl) && !/^https:\/\/[^\s/]+\/.*\.well-known\/openid-configuration$/.test(issuer.discoveryUrl)) {
    fail('issuer.discoveryUrl', 'must be an https OIDC discovery URL ending in /.well-known/openid-configuration');
  }
  if ((issuer.allowedClients?.length ?? 0) === 0 && (issuer.allowedAudience?.length ?? 0) === 0) {
    fail('issuer', 'needs allowedClients or allowedAudience: a token from any client of the issuer must not be accepted');
  }
  const tenant = props.claims?.tenant ?? DEFAULT_CLAIMS.tenant;
  const session = props.claims?.session ?? DEFAULT_CLAIMS.session;
  for (const [prop, value] of [['claims.tenant', tenant], ['claims.session', session]] as const) {
    if (!CLAIM_NAME.test(value)) {
      fail(prop, 'must be a claim name of letters, digits, and _:.-');
    }
  }
  if (tenant === session) {
    fail('claims.session', 'must differ from claims.tenant: the session must name less than the whole tenant');
  }
  const tokenUse = props.claims?.tokenUse === false ? undefined : (props.claims?.tokenUse ?? DEFAULT_CLAIMS.tokenUse);
  if (props.claims?.tokenUse === false && (issuer.allowedAudience?.length ?? 0) === 0) {
    fail('claims.tokenUse', 'may be false only with issuer.allowedAudience, which then tells access tokens apart');
  }
  const expiry = props.eventExpiryDays ?? DEFAULT_EVENT_EXPIRY_DAYS;
  if (!Number.isInteger(expiry) || expiry < 7 || expiry > 365) {
    fail('eventExpiryDays', `must be an integer from 7 to 365 (got ${expiry})`);
  }
  const rate = props.tenantRequestsPerSecond ?? DEFAULT_TENANT_REQUESTS_PER_SECOND;
  if (!Number.isInteger(rate) || rate < 1 || rate > 10_000) {
    fail('tenantRequestsPerSecond', `must be an integer from 1 to 10000 (got ${rate})`);
  }
  return { tenant, session, tokenUse };
}

export class TenantMemoryIsolation extends Construct {
  /** The claims the policies read, after defaults. */
  readonly claims: ClaimNames;
  readonly memory: agentcore.CfnMemory;
  readonly memoryId: string;
  readonly memoryArn: string;
  readonly gateway: agentcore.CfnGateway;
  readonly gatewayId: string;
  readonly gatewayArn: string;
  /** The Gateway URL as the service returns it. Memory calls go to `<origin>/<targetName>/memories/...`. */
  readonly gatewayUrl: string;
  /** The connector target name, the first path segment of every Memory call. */
  readonly targetName = TARGET_NAME;
  /** The only principal the Memory resource policy admits (ADR-0004). */
  readonly gatewayRole: iam.Role;
  readonly policyEngine: agentcore.CfnPolicyEngine;
  readonly policyEngineArn: string;
  /** Memory application logs: extraction and consolidation, keyed by actor and namespace, which are the tenant id (§4.4). */
  readonly applicationLogs: logs.LogGroup;

  constructor(scope: Construct, id: string, props: TenantMemoryIsolationProps) {
    super(scope, id);
    this.claims = resolveClaims(props);
    const stack = Stack.of(this);
    const arn = (resource: string) => `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:${resource}`;

    // --- Memory: one pooled resource, one semantic strategy keyed by tenant ---
    this.memory = new agentcore.CfnMemory(this, 'Memory', {
      name: Names.uniqueResourceName(this, { maxLength: 48, separator: '', allowedSpecialCharacters: '' }).replace(/^[^A-Za-z]+/, 'M'),
      description: 'Tenant memory isolation: pooled Memory reached only through the tenant memory Gateway (ADR-0004)',
      eventExpiryDuration: props.eventExpiryDays ?? DEFAULT_EVENT_EXPIRY_DAYS,
      memoryStrategies: [
        {
          semanticMemoryStrategy: {
            name: MEMORY_STRATEGY_NAME,
            description: 'Facts shared by every agent of one tenant, in the namespace equal to the tenant id (ADR-0009)',
            namespaceTemplates: [NAMESPACE_TEMPLATE],
          },
        },
      ],
    });
    this.memory.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.memoryId = this.memory.attrMemoryId;
    this.memoryArn = this.memory.attrMemoryArn;

    // --- Policy engine ---
    const engineName = `${Names.uniqueResourceName(this, { maxLength: 30, separator: '', allowedSpecialCharacters: '' }).replace(/^[^A-Za-z]+/, 'P')}Memory`;
    this.policyEngine = new agentcore.CfnPolicyEngine(this, 'PolicyEngine', {
      name: engineName,
      description: 'Tenant memory isolation: Cedar policies on the tenant and session claims (ADR-0001)',
    });
    this.policyEngine.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.policyEngineArn = this.policyEngine.attrPolicyEngineArn;

    // --- Gateway execution role ---
    // The Gateway's name is fixed here, and its id is `<name>-<10 characters>`,
    // so the role's trust and Policy grants name exactly this Gateway from the
    // first deploy: there is no wider bootstrap window (ADR-0011, M-4).
    const gatewayName = `${Names.uniqueResourceName(this, { maxLength: 40, separator: '-' })}-memory`.toLowerCase();
    const ownGatewayArn = arn(`gateway/${gatewayName}-${'?'.repeat(10)}`);
    this.gatewayRole = new iam.Role(this, 'GatewayRole', {
      description: 'Tenant memory Gateway execution role: the only principal the Memory resource policy admits (ADR-0004)',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': [ownGatewayArn, this.policyEngineArn] },
        },
      }),
    });
    this.gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentMemoryOperations',
        actions: AGENT_OPERATIONS.map((name) => `bedrock-agentcore:${name}`),
        resources: [this.memoryArn],
      }),
    );
    this.gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ValidateMemoryTarget',
        actions: ['bedrock-agentcore:GetMemory'],
        resources: [this.memoryArn],
      }),
    );
    this.gatewayRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'ReadPolicyEngine', actions: ['bedrock-agentcore:GetPolicyEngine'], resources: [this.policyEngineArn] }),
    );
    this.gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AuthorizeWithPolicyEngine',
        actions: ['bedrock-agentcore:AuthorizeAction', 'bedrock-agentcore:PartiallyAuthorizeActions'],
        resources: [this.policyEngineArn, ownGatewayArn],
      }),
    );

    // --- Gateway: CUSTOM_JWT, no MCP protocol type (ADR-0006), Policy ENFORCE ---
    this.gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: gatewayName,
      description: 'Tenant memory isolation: native Memory connector, Cedar on tenant claims (ADR-0001)',
      roleArn: this.gatewayRole.roleArn,
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: props.issuer.discoveryUrl,
          allowedClients: props.issuer.allowedClients,
          allowedAudience: props.issuer.allowedAudience,
        },
      },
      policyEngineConfiguration: { arn: this.policyEngineArn, mode: 'ENFORCE' },
    });
    this.gateway.applyRemovalPolicy(RemovalPolicy.DESTROY);
    // The service validates the role and its Policy grants when it creates the Gateway.
    this.gateway.node.addDependency(this.gatewayRole);
    this.gatewayId = this.gateway.attrGatewayIdentifier;
    this.gatewayArn = this.gateway.attrGatewayArn;
    this.gatewayUrl = this.gateway.attrGatewayUrl;

    const target = new agentcore.CfnGatewayTarget(this, 'MemoryTarget', {
      gatewayIdentifier: this.gatewayId,
      name: TARGET_NAME,
      description: 'Native agentcore-memory connector for the pooled tenant Memory',
      targetConfiguration: {
        http: { connector: { source: { connectorId: 'agentcore-memory' }, parameters: { memoryId: this.memoryId } } },
      },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
    target.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // --- Cedar policies: written after the target (Policy validates actions against it),
    // one at a time (the engine serialises writes), deleted before the target ---
    const policyName = (suffix: string) => `${engineName}_${suffix}`;
    let previous: CfnResource = target;
    for (const [key, statement] of [
      ['events', eventWritePolicy(this.gatewayArn, this.claims)],
      ['recall', sharedRecallPolicy(this.gatewayArn, this.claims)],
    ] as const) {
      const policy = new agentcore.CfnPolicy(this, `${key === 'events' ? 'EventWrite' : 'SharedRecall'}Policy`, {
        name: policyName(key),
        policyEngineId: this.policyEngine.attrPolicyEngineId,
        description: key === 'events' ? 'CreateEvent for the token tenant and session only' : 'Exact-namespace recall for the token tenant only',
        definition: { cedar: { statement } },
        validationMode: 'FAIL_ON_ANY_FINDINGS',
      });
      policy.applyRemovalPolicy(RemovalPolicy.DESTROY);
      policy.addResourceDependency(previous);
      previous = policy;
    }

    // --- Resource fence (ADR-0004, ADR-0007) ---
    const fence = new agentcore.CfnResourcePolicy(this, 'MemoryFence', {
      resourceArn: this.memoryArn,
      policy: Stack.of(this).toJsonString(fencePolicy(this.memoryArn, this.gatewayRole.roleArn)),
    });
    fence.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // --- Per-tenant fairness at the Gateway (M-11) ---
    new agentcore.CfnGatewayRateLimit(this, 'TenantRateLimit', {
      gatewayIdentifier: this.gatewayId,
      description: 'Requests per second per tenant (fairness, not isolation)',
      dimensionKeys: [`$.context.jwt.${this.claims.tenant}`],
      entries: [
        {
          dimensions: { [`$.context.jwt.${this.claims.tenant}`]: '*' },
          requests: [{ period: 'second', rate: props.tenantRequestsPerSecond ?? DEFAULT_TENANT_REQUESTS_PER_SECOND }],
        },
      ],
    }).addResourceDependency(target);

    // --- Per-tenant telemetry: Memory application logs carry actor_id and namespace,
    // which are the tenant id in this design (§4.4, ADR-0012) ---
    this.applicationLogs = new logs.LogGroup(this, 'MemoryApplicationLogs', {
      logGroupName: `/aws/vendedlogs/bedrock-agentcore/memory/APPLICATION_LOGS/${Names.uniqueResourceName(this, { maxLength: 64 })}`,
      retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const source = new logs.CfnDeliverySource(this, 'MemoryLogSource', {
      name: `${Names.uniqueResourceName(this, { maxLength: 40, separator: '-' })}-memory-logs`,
      resourceArn: this.memoryArn,
      logType: 'APPLICATION_LOGS',
    });
    const destination = new logs.CfnDeliveryDestination(this, 'MemoryLogDestination', {
      name: `${Names.uniqueResourceName(this, { maxLength: 40, separator: '-' })}-memory-logs`,
      destinationResourceArn: this.applicationLogs.logGroupArn,
    });
    const delivery = new logs.CfnDelivery(this, 'MemoryLogDelivery', {
      deliverySourceName: source.ref,
      deliveryDestinationArn: destination.attrArn,
    });
    delivery.addResourceDependency(source);
    delivery.addResourceDependency(destination);

    for (const [ruleId, field, workflow] of [
      ['TopTenantsByExtraction', '$.actor_id', 'extraction'],
      ['TopTenantsByConsolidation', '$.namespace', 'consolidation'],
    ] as const) {
      new cloudwatch.CfnInsightRule(this, ruleId, {
        ruleName: `${this.node.addr.slice(0, 12)}-memory-${workflow}`,
        ruleState: 'ENABLED',
        ruleBody: stack.toJsonString({
          Schema: { Name: 'CloudWatchLogRule', Version: 1 },
          LogGroupNames: [this.applicationLogs.logGroupName],
          LogFormat: 'JSON',
          Contribution: { Keys: [field], Filters: [{ Match: field, IsPresent: true }] },
          AggregateOn: 'Count',
        }),
      }).node.addDependency(this.applicationLogs);
    }
  }
}

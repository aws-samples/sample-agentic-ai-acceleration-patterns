// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The stress ingress stack (stress-test plan §8.3, row 1): the identity
 * lookup as `RuntimeIsolationDemoStack` does it, a demo table and a tenant
 * role (the demo's `tvm` branch), one `SharedIngress` sized by the tier
 * (§3.1, §8.2), the `default` agent, one `ToolTarget` per tier target over
 * the stress tool, spread over the tier's tools gateways round-robin, and at
 * `small` the second agent `a001`. The registry prefix is stack-scoped, so
 * the account-wide one stays free; the agents stacks read the published
 * document under it.
 */

import * as path from 'node:path';
import { CfnOutput, CfnRule, Duration, Fn, Lazy, RemovalPolicy, Stack, StackProps, Token } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { stressTools } from './stress-tool.function';
import { agentNames, gatewayOf, type StressTier, targetNames } from './tiers';
import { AgentBackend, type AgentProps } from '../../src/agent-backend.cdk';
import { defaultModelId, IDENTITY_PARAMETERS, PLACEHOLDER, TABLE_PARTITION_KEY, TENANT_KEY_PREFIX } from '../../src/demo.cdk';
import { AGENT_ENV } from '../../src/shared/config';
import { acknowledgeLambdaFindings, functionProps } from '../../src/shared/function.cdk';
import { ROUTE } from '../../src/shared/registry';
import { TENANT_TAG_KEY } from '../../src/shared/tvm';
import { DEFAULT_REGISTRY_PREFIX, GATEWAY_TARGET_NAME, SharedIngress, STAGE_NAME } from '../../src/shared-ingress.cdk';
import { ToolTarget } from '../../src/tool-target.cdk';
import { gatewayIdPart } from '../../src/tools-gateway.cdk';

/** The owner marker of every stress stack's name reservations (ADR-0035). */
export const STRESS_OWNER = 'RuntimeIsolationStress';

/** The stack-scoped registry prefix of a stress ingress stack named `stackName` (§8.3). */
export function stressRegistryPrefix(stackName: string): string {
  return `${DEFAULT_REGISTRY_PREFIX}${stackName}/`;
}

/** The PascalCase id part of a target or agent name (`t01` -> `T01`). */
export function namePart(name: string): string {
  return gatewayIdPart(name);
}

export interface StressIngressStackProps extends StackProps {
  readonly tier: StressTier;
  /** Directory with the bundled agent (`app.js`); see src/agent/bundle.ts. */
  readonly agentCodePath: string;
  /** Build-only: synthesise with placeholders instead of tenant-identity's parameters; a CloudFormation rule refuses the deploy. */
  readonly identityParameterPlaceholders?: boolean;
  /** The owner marker of the reservations. Default `STRESS_OWNER`. */
  readonly owner?: string;
}

export class StressIngressStack extends Stack {
  readonly ingress: SharedIngress;
  readonly registryPrefix: string;
  readonly table: dynamodb.TableV2;
  readonly tenantRole: iam.Role;
  readonly agents: AgentBackend[] = [];
  readonly targets: ToolTarget[] = [];
  readonly toolFunctions: NodejsFunction[] = [];
  /** The tool tenant role of `t01` (P-15). */
  readonly toolTenantRole: iam.Role;

  constructor(scope: Construct, id: string, props: StressIngressStackProps) {
    super(scope, id, props);
    const tier = props.tier;
    const owner = props.owner ?? STRESS_OWNER;

    // The issuer (ADR-0004), as the demo stack reads it.
    let userPoolId: string;
    let appClientId: string;
    if (props.identityParameterPlaceholders === true) {
      userPoolId = PLACEHOLDER.userPoolId;
      appClientId = PLACEHOLDER.appClientId;
      new CfnRule(this, 'RefusePlaceholderDeployment', {
        assertions: [
          {
            assert: Fn.conditionEquals('build-placeholder', 'deployable'),
            assertDescription:
              'This template was synthesised with identityParameterPlaceholders (build only). Synthesise without it so the stack reads /application-plane/shared/identity/* from tenant-identity.',
          },
        ],
      });
    } else {
      userPoolId = ssm.StringParameter.valueForStringParameter(this, IDENTITY_PARAMETERS.userPoolId);
      appClientId = ssm.StringParameter.valueForStringParameter(this, IDENTITY_PARAMETERS.appClientId);
    }
    const discoveryUrl = `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;

    // A literal, stack-scoped prefix: the agents stacks look the published
    // document up by name at synth, so it cannot be the AWS::StackName token.
    this.registryPrefix = stressRegistryPrefix(this.stackName);

    // The demo's tvm branch: a tenant-partitioned table and the data-bearing
    // tenant role, trusted by the construct's tvmCallerRole (ADR-0016).
    this.table = new dynamodb.TableV2(this, 'DemoTable', {
      partitionKey: { name: TABLE_PARTITION_KEY, type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY, // test stack
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    let callerRoleArn: string | undefined;
    const caller = new iam.ArnPrincipal(Lazy.string({ produce: () => callerRoleArn! }));
    this.tenantRole = new iam.Role(this, 'TenantRole', {
      description: 'Stress tenant role (spec §6.1): assumable only by tvmCallerRole with a TenantId session tag; ABAC on the demo table',
      assumedBy: caller
        .withConditions({
          'StringLike': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: '?*' },
          'ForAllValues:StringEquals': { 'aws:TagKeys': [TENANT_TAG_KEY] },
        })
        .withSessionTags(),
      maxSessionDuration: Duration.hours(1),
    });
    this.tenantRole.addToPolicy(ownPartitionOnly('OwnTenantPartitionOnly', ['dynamodb:GetItem', 'dynamodb:Query'], this.table));

    const toolsGateways = Object.fromEntries(tier.toolsGateways.map((name) => [name, name === 'finance' ? { responseFilter: true } : {}]));
    this.ingress = new SharedIngress(this, 'SharedIngress', {
      identity: { discoveryUrl, allowedClientIds: [appClientId] },
      ingress: 'api-gateway',
      registryPrefix: this.registryPrefix,
      publish: true,
      session: { scope: 'tenant' },
      tvm: { role: this.tenantRole },
      stageThrottle: { rateLimit: tier.stageThrottle.rateLimit, burstLimit: tier.stageThrottle.burstLimit },
      ingressReservedConcurrency: tier.ingressReservedConcurrency,
      defaultBackend: GATEWAY_TARGET_NAME,
      toolsGateways,
    });
    callerRoleArn = this.ingress.tvmCallerRole.roleArn;

    // One stress tool target per tier target (§8.3); t01 has its own TVM.
    const targets = targetNames(tier);
    let toolTenantRole: iam.Role | undefined;
    targets.forEach((name, i) => {
      const part = namePart(name);
      const fn = new NodejsFunction(this, `Target${part}Function`, {
        ...functionProps(this, `Target${part}Logs`, Duration.seconds(10)),
        entry: path.join(__dirname, 'stress-tool.function.ts'),
        description: `runtime-isolation STRESS TEST ONLY: tool target ${name}, reports the calling tenant`,
      });
      acknowledgeLambdaFindings(fn);
      let role: iam.Role | undefined;
      if (i === 0) {
        role = new iam.Role(this, `Target${part}TenantRole`, {
          description: `Tool tenant role of ${name} (spec §6.1, P-15): assumable only by the tool function with a TenantId session tag`,
          assumedBy: new iam.ArnPrincipal(fn.role!.roleArn)
            .withConditions({
              'StringLike': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: '?*' },
              'ForAllValues:StringEquals': { 'aws:TagKeys': [TENANT_TAG_KEY] },
            })
            .withSessionTags(),
          maxSessionDuration: Duration.hours(1),
        });
        role.addToPolicy(ownPartitionOnly('OwnTenantItemOnly', ['dynamodb:GetItem'], this.table));
        toolTenantRole = role;
      }
      this.toolFunctions.push(fn);
      this.targets.push(
        new ToolTarget(this, `Target${part}`, {
          name,
          ingress: this.ingress,
          gateway: gatewayOf(tier, i),
          kind: 'lambda',
          function: fn,
          tools: stressTools(tier.toolsPerTarget),
          owner,
          tvm: role === undefined ? undefined : { role },
        }),
      );
    });
    this.toolTenantRole = toolTenantRole!;

    // The default agent may use every target; at small, a001 sits here too.
    const modelId = defaultModelId(Token.isUnresolved(this.region) ? undefined : this.region);
    const agent: AgentProps = { codePath: props.agentCodePath, modelId, environment: { [AGENT_ENV.TABLE_NAME]: this.table.tableName } };
    this.agents.push(
      new AgentBackend(this, 'AgentBackend', {
        name: GATEWAY_TARGET_NAME,
        ingress: this.ingress,
        agent,
        needs: [`${GATEWAY_TARGET_NAME}/chat`],
        tools: targets.map((t) => `${t}/*`),
        owner,
      }),
    );
    if (tier.agentStacks === 0) {
      for (const name of agentNames(tier).slice(1)) {
        this.agents.push(
          new AgentBackend(this, `Agent${namePart(name)}`, {
            name,
            ingress: this.ingress,
            agent,
            needs: [`${name}/chat`],
            tools: [`${targets[0]}/*`],
            owner,
          }),
        );
      }
    }

    // What the scripts and k6 reach directly (§8.3).
    const api = this.ingress.node.findChild('Api') as apigateway.RestApi;
    const ingressLogs = this.ingress.node.findChild('IngressLogs') as logs.LogGroup;
    const authorizerFn = this.ingress.node.findChild('AuthorizerFunction') as NodejsFunction;
    const ingressFn = this.ingress.node.findChild('IngressFunction') as NodejsFunction;
    new CfnOutput(this, 'EndpointUrl', { value: `${this.ingress.endpointUrl}/${ROUTE}` });
    new CfnOutput(this, 'EntitlementsApiUrl', { value: this.ingress.entitlementsApiUrl });
    new CfnOutput(this, 'EntitlementsTableName', { value: this.ingress.entitlementStore.tableName });
    new CfnOutput(this, 'DemoTableName', { value: this.table.tableName });
    new CfnOutput(this, 'Issuer', { value: this.ingress.issuer });
    new CfnOutput(this, 'RegistryPrefix', { value: this.registryPrefix });
    new CfnOutput(this, 'RestApiId', { value: api.restApiId });
    new CfnOutput(this, 'StageName', { value: STAGE_NAME });
    new CfnOutput(this, 'IngressLogGroupName', { value: ingressLogs.logGroupName });
    new CfnOutput(this, 'AuthorizerFunctionName', { value: authorizerFn.functionName });
    new CfnOutput(this, 'IngressFunctionName', { value: ingressFn.functionName });
    const interceptors: string[] = [];
    for (const [name, gateway] of Object.entries(this.ingress.toolsGateways)) {
      const part = gatewayIdPart(name);
      new CfnOutput(this, `ToolsGatewayUrl${part}`, { value: gateway.gatewayUrl });
      new CfnOutput(this, `PolicyEngineId${part}`, { value: gateway.policyEngine.attrPolicyEngineId });
      interceptors.push(gateway.interceptor.functionName);
      if (gateway.responseFilter !== undefined) {
        interceptors.push(gateway.responseFilter.functionName);
      }
    }
    for (const target of this.targets) {
      new CfnOutput(this, `PolicySecondsToActive${namePart(target.name)}`, { value: target.policySecondsToActive });
    }
    new CfnOutput(this, 'InterceptorFunctionNames', { value: Fn.join(',', interceptors) });
  }
}

/** ABAC (P-8): `actions` on the calling tenant's partition of `table` only. */
function ownPartitionOnly(sid: string, actions: string[], table: dynamodb.TableV2): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid,
    actions,
    resources: [table.tableArn],
    conditions: {
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`${TENANT_KEY_PREFIX}\${aws:PrincipalTag/${TENANT_TAG_KEY}}`] },
    },
  });
}

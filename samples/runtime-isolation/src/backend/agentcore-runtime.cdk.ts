// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `agentcore-runtime` backend, CDK side (spec C-1, §3.4; ADR-0001,
 * ADR-0008, ADR-0010, ADR-0011). One AgentCore Runtime with IAM (SigV4)
 * inbound authorisation, an execution role that can invoke one model and
 * write logs and nothing tenant-scoped, a resource policy that names one
 * ingress principal, and a request-header allowlist that carries the
 * user-token and credential headers only when the matching option is on.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Aws, Names, Stack } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { RUNTIME_HEADERS } from './agentcore-runtime.transport';
import type { BackendTransportOptions, IBackend } from './backend.cdk';
import { ENV } from '../shared/config';
import { acknowledgeGranularFinding, nagFindingResource } from '../shared/nag';

/** The entry file the Runtime starts inside `codePath`. */
export const AGENT_ENTRY_POINT = 'app.js';

/** The Runtime actions the policy denies to everyone (ADR-0001): everything but the one invoke call. */
export const INVOKE_ACTION = 'bedrock-agentcore:InvokeAgentRuntime';

export interface AgentCoreRuntimeBackendProps {
  /** Directory with `app.js` (a Node HTTP server on port 8080). Uploaded as the Runtime's code. */
  readonly codePath: string;
  /** The one Bedrock model id the execution role may invoke (P-6). */
  readonly modelId: string;
  /** Environment variables for the agent process. */
  readonly environment?: Record<string, string>;
  readonly transports: BackendTransportOptions;
}

export class AgentCoreRuntimeBackend extends Construct implements IBackend {
  readonly resourceArn: string;
  readonly executionRole: iam.Role;
  readonly ingressEnvironment: Record<string, string>;
  /** The L1, for the Gateway target helper and for tests. */
  readonly runtime: agentcore.CfnRuntime;
  private bound = false;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeBackendProps) {
    super(scope, id);

    if (!fs.existsSync(path.join(props.codePath, AGENT_ENTRY_POINT))) {
      throw new Error(`agent.codePath: ${props.codePath} must contain ${AGENT_ENTRY_POINT}`);
    }
    const code = new s3assets.Asset(this, 'AgentCode', { path: props.codePath });

    // The execution role (ADR-0008): the Runtime service assumes it for this
    // account only. It may read its own code, write its own log group,
    // trace, and invoke the one model. No data permission: the TVM supplies
    // tenant data access with credentials vended from the token (ADR-0012).
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` },
        },
      }),
      description: 'AgentCore Runtime execution role: model invocation, logs and traces only (ADR-0008)',
    });
    // The one code object, by exact key: no bucket-wide read.
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCode',
        actions: ['s3:GetObject'],
        resources: [code.bucket.arnForObjects(code.s3ObjectKey)],
      }),
    );
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeLogs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups'],
        resources: [
          `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*`,
          `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
        ],
      }),
    );
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OneModel',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [`arn:${Aws.PARTITION}:bedrock:${Aws.REGION}::foundation-model/${props.modelId}`],
      }),
    );
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Traces',
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
        resources: ['*'],
      }),
    );
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      }),
    );
    const logGroupArn = `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*`;
    const logReason =
      'The Runtime names its own log group under /aws/bedrock-agentcore/runtimes/ at run time, so the prefix is the narrowest grantable resource; it is the only prefix the Runtime writes (ADR-0008).';
    acknowledgeGranularFinding(this.executionRole, `AwsSolutions-IAM5[Resource::${nagFindingResource(this, logGroupArn)}]`, logReason);
    acknowledgeGranularFinding(this.executionRole, `AwsSolutions-IAM5[Resource::${nagFindingResource(this, `${logGroupArn}:log-stream:*`)}]`, logReason);
    acknowledgeGranularFinding(
      this.executionRole,
      'AwsSolutions-IAM5[Resource::*]',
      'xray:PutTraceSegments/PutTelemetryRecords/GetSampling* and cloudwatch:PutMetricData take no resource ARN; PutMetricData is pinned to the bedrock-agentcore namespace by condition. No data permission at all (ADR-0008).',
    );

    // Headers the Runtime admits from the ingress (ADR-0006, ADR-0012). A
    // header that is not listed never reaches the agent, so a client cannot
    // inject one either. Empty when neither option is on.
    const allowlist: string[] = [];
    if (props.transports.forwardUserToken) {
      allowlist.push(RUNTIME_HEADERS.USER_TOKEN);
    }
    if (props.transports.tenantCredentials) {
      allowlist.push(RUNTIME_HEADERS.TENANT_CREDENTIALS);
    }

    // No authorizerConfiguration: inbound authorisation is IAM (SigV4), so
    // the resource policy below is the gate (ADR-0001).
    this.runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: `ri_${Names.uniqueResourceName(this, { maxLength: 44, allowedSpecialCharacters: '_' })}`,
      description: 'runtime-isolation sample: SigV4 inbound, one ingress principal (ADR-0001)',
      roleArn: this.executionRole.roleArn,
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } },
          entryPoint: [AGENT_ENTRY_POINT],
          runtime: 'NODE_22',
        },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      requestHeaderConfiguration: allowlist.length > 0 ? { requestHeaderAllowlist: allowlist } : undefined,
      environmentVariables: props.environment,
    });
    this.runtime.node.addDependency(this.executionRole);
    this.resourceArn = this.runtime.attrAgentRuntimeArn;
    this.ingressEnvironment = { [ENV.RUNTIME_ARN]: this.resourceArn };
  }

  /**
   * P-1 (ADR-0001, spike V-1): the resource policy allows `InvokeAgentRuntime`
   * for the ingress role and denies every `bedrock-agentcore:*` action on
   * the Runtime to any other principal, which covers `InvokeAgentRuntimeForUser`
   * and the WebSocket and command variants this sample does not use. The
   * identity grant on the ingress role completes the pair.
   */
  bindIngress(ingressRole: iam.IRole): void {
    if (this.bound) {
      throw new Error('AgentCoreRuntimeBackend.bindIngress: the backend trusts exactly one ingress (ADR-0003)');
    }
    this.bound = true;
    const stack = Stack.of(this);
    ingressRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeRuntime',
        actions: [INVOKE_ACTION],
        resources: [this.resourceArn, `${this.resourceArn}/*`],
      }),
    );
    acknowledgeGranularFinding(
      ingressRole,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, `${this.resourceArn}/*`)}]`,
      'InvokeAgentRuntime is authorised on the Runtime ARN and its endpoint qualifier (<arn>/*), the two resource forms the action accepts; both name this one Runtime (ADR-0001).',
    );
    new agentcore.CfnResourcePolicy(this, 'ResourcePolicy', {
      resourceArn: this.resourceArn,
      policy: stack.toJsonString({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'IngressOnly',
            Effect: 'Allow',
            Principal: { AWS: ingressRole.roleArn },
            Action: INVOKE_ACTION,
            Resource: this.resourceArn,
          },
          {
            Sid: 'DenyOthers',
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Action: 'bedrock-agentcore:*',
            Resource: this.resourceArn,
            Condition: { ArnNotEquals: { 'aws:PrincipalArn': ingressRole.roleArn } },
          },
        ],
      }),
    });
  }

  /**
   * A Gateway target that points at this Runtime (spec C-3b; ADR-0010). The
   * CDK L1 lacks `TargetConfiguration.Http.AgentcoreRuntime` (aws-cdk#37999),
   * so the typed `connector` placeholder is deleted and the Runtime block is
   * written with raw overrides. A unit test asserts the emitted keys, so a
   * casing error fails the build, not the deploy (spike V-2).
   */
  addGatewayTarget(gateway: agentcore.CfnGateway, name: string): agentcore.CfnGatewayTarget {
    const target = new agentcore.CfnGatewayTarget(this, 'GatewayTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name,
      description: 'AgentCore Runtime target (ADR-0010 raw override)',
      targetConfiguration: { http: { connector: { source: { connectorId: 'placeholder-removed-by-override' } } } },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
    target.addPropertyDeletionOverride('TargetConfiguration.Http.Connector');
    target.addPropertyOverride('TargetConfiguration.Http.AgentcoreRuntime', {
      Arn: this.resourceArn,
      Qualifier: 'DEFAULT',
    });
    return target;
  }
}

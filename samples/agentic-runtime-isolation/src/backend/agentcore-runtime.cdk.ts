// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `agentcore-runtime` backend, CDK side (spec C-1, §3.4; ADR-0001,
 * ADR-0008, ADR-0010, ADR-0011, ADR-0018). One AgentCore Runtime with IAM
 * (SigV4) inbound authorisation, an execution role that can write logs and
 * traces and read its own code and nothing else (no model, no tenant data:
 * the agent uses the vended tenant credentials for both, ADR-0018), a
 * resource policy that names one ingress principal, the `ri:ingress` tag
 * the ingress role's invoke grant is conditioned on (ADR-0024), and a
 * request-header allowlist that carries the credential header and (v2,
 * ADR-0031) the transaction-token header, never the v1 user-token header.
 * A custom resource puts a data protection policy on the Runtime's log group
 * that masks any header value an agent might log (T-18, M-12).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Aws, CustomResource, Names, Stack, Token } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { RUNTIME_HEADERS } from './agentcore-runtime.transport';
import type { BackendTransportOptions, IBackend } from './backend.cdk';
import { AGENT_ENV } from '../shared/config';
import { customResourceFunction } from '../shared/custom-resource.cdk';
import { acknowledgeGranularFinding, nagFindingResource } from '../shared/nag';

/** The entry file the Runtime starts inside `codePath`. */
export const AGENT_ENTRY_POINT = 'app.js';

/** The Runtime actions the policy denies to everyone (ADR-0001): everything but the one invoke call. */
export const INVOKE_ACTION = 'bedrock-agentcore:InvokeAgentRuntime';

/**
 * Cross-Region inference profile ids carry a geo prefix (`eu.`, `us.`,
 * `apac.`, `global.`, ...) before the foundation model id. Such a call is
 * authorised on the profile ARN (account-scoped) AND on the foundation-model
 * ARN in the Regions the profile routes to; a plain model id needs the
 * foundation-model ARN in this Region only. An unresolved token is treated as
 * a plain id (the demo passes a literal).
 */
const INFERENCE_PROFILE_PREFIX = /^(us|eu|apac|global|us-gov|jp|au|ca)\./;

export function isInferenceProfileId(modelId: string): boolean {
  return !Token.isUnresolved(modelId) && INFERENCE_PROFILE_PREFIX.test(modelId);
}

/** The foundation model id behind an inference profile id (`eu.amazon.nova-lite-v1:0` -> `amazon.nova-lite-v1:0`). */
export function baseModelId(modelId: string): string {
  return modelId.replace(INFERENCE_PROFILE_PREFIX, '');
}

/** The foundation-model ARN form (`eu.amazon.nova-lite-v1:0` -> `arn:...:bedrock:<region>::foundation-model/amazon.nova-lite-v1:0`). */
export function foundationModelArn(region: string, modelId: string): string {
  return `arn:${Aws.PARTITION}:bedrock:${region}::foundation-model/${modelId}`;
}

/** The resources the `OneModel` statement names: exactly the ARN forms this one model id needs, no wildcard on the model. */
export function modelResourceArns(modelId: string): string[] {
  if (!isInferenceProfileId(modelId)) {
    return [foundationModelArn(Aws.REGION, modelId)];
  }
  return [
    `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/${modelId}`,
    foundationModelArn('*', baseModelId(modelId)),
  ];
}

export interface AgentCoreRuntimeBackendProps {
  /** Directory with `app.js` (a Node HTTP server on port 8080). Uploaded as the Runtime's code. */
  readonly codePath: string;
  /** The one Bedrock model id the agent calls; the tenant role, not the execution role, may invoke it (P-6, ADR-0018). */
  readonly modelId: string;
  /** Environment variables for the agent process. */
  readonly environment?: Record<string, string>;
  readonly transports: BackendTransportOptions;
  /**
   * Tags on the Runtime, given at creation so the service copies them to the
   * DEFAULT endpoint (checked 2026-10-28). `AgentBackend` sets
   * `ri:ingress = <ingressId>`, the condition on the ingress role's invoke
   * grant (ADR-0024).
   */
  readonly tags?: Record<string, string>;
}

/** The endpoint the Runtime logs under; the only one this sample creates. */
const RUNTIME_ENDPOINT = 'DEFAULT';

/**
 * What the data protection policy masks (T-18, M-12). Each pattern covers a
 * WHOLE value: a masked prefix alone would leave the rest decodable.
 * - a JWT: three base64url segments starting with `eyJ` (`{"` encoded), so
 *   the transaction token, or any identity token, in any log line;
 * - the credential header: base64 of `{"accessKeyId":"...` as the ingress
 *   encodes it (`encodeCredentials`, JSON key order of `VendedCredentials`);
 * - the decoded credential object, field by field: the secret access key
 *   (40 base64 characters) and the session token, each led by its field
 *   name so the match is a whole value, in the three spellings a Node
 *   process produces: `JSON.stringify` (`"secretAccessKey":"..."`), the same
 *   nested in a JSON log line (`\"secretAccessKey\":\"...`), and
 *   `console.log` of an object (`secretAccessKey: '...'`). The managed
 *   `AwsSecretKey` identifier is kept beside them for the CLI and SDK
 *   spellings it knows (`aws_secret_access_key`, `secret key`, ...); it needs
 *   one of those keywords nearby and the object forms have none.
 * Three CloudWatch Logs regex rules, all probed 2026-11-06 with
 * `PutDataProtectionPolicy` in the sandbox account:
 * - a custom identifier's regex is capped at 200 characters;
 * - an open-ended `{n,}` quantifier is accepted but never matches;
 * - a large explicit bound is refused as "Regexes in Custom Data
 *   Identifiers are too complex": `eyJ[A-Za-z0-9_-]{1,200}` and three
 *   `{1,50}` segments are rejected, `{1,100}` is accepted, while `+` is
 *   accepted and matches. So the two values whose length is not known
 *   (a JWT segment, the base64 credential header) use `+`, and the two
 *   whose length is (a 40-character secret access key, a session token)
 *   use a `{m,n}` bound, which the engine takes behind a longer literal
 *   prefix. The bound also sets how long the service takes to compile the
 *   policy: `{16,4096}` took about 5 s per PutDataProtectionPolicy and
 *   half the calls came back HttpTimeoutException from the service itself
 *   (integration run 2026-11-06, every Runtime group failed); `{16,2048}`
 *   takes about 2 s and `{16,1024}` about 1 s. 2048 covers an STS session
 *   token (about 1,000 to 1,600 characters with session tags).
 * The integration test (step `mask`) writes probe lines into a Runtime
 * group and reads them back masked and with `--unmask`, so the patterns are
 * proven on CloudWatch's engine every run, not only in the JS one the unit
 * tests use.
 */
export const MASKED_PATTERNS = {
  JWT: 'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
  CREDENTIAL_HEADER: 'eyJhY2Nlc3NLZXlJZCI6[A-Za-z0-9+/=]+',
  SECRET_ACCESS_KEY_FIELD: 'secretAccessKey\\\\?["\']?\\s*:\\s*\\\\?["\'][A-Za-z0-9/+=]{40}',
  SESSION_TOKEN_FIELD: 'sessionToken\\\\?["\']?\\s*:\\s*\\\\?["\'][A-Za-z0-9/+=]{16,2048}',
} as const;

/**
 * The data protection policy for the Runtime log group (T-18, M-12), in the
 * CloudWatch Logs document form: an Audit statement and a Deidentify
 * statement over the same identifiers, plus the custom identifiers. Masking
 * applies at ingest; `logs:Unmask` reads the original.
 */
export function runtimeLogDataProtectionPolicy(): Record<string, unknown> {
  const identifiers = [
    `arn:${Aws.PARTITION}:dataprotection::aws:data-identifier/AwsSecretKey`,
    'JsonWebToken',
    'TenantCredentialsHeader',
    'SecretAccessKeyField',
    'SessionTokenField',
  ];
  return {
    Name: 'RuntimeIsolationHeaderValues',
    Description: 'Masks a JWT, the tenant credential header or a decoded credential field an agent might log (T-18, M-12)',
    Version: '2021-06-01',
    Configuration: {
      CustomDataIdentifier: [
        { Name: 'JsonWebToken', Regex: MASKED_PATTERNS.JWT },
        { Name: 'TenantCredentialsHeader', Regex: MASKED_PATTERNS.CREDENTIAL_HEADER },
        { Name: 'SecretAccessKeyField', Regex: MASKED_PATTERNS.SECRET_ACCESS_KEY_FIELD },
        { Name: 'SessionTokenField', Regex: MASKED_PATTERNS.SESSION_TOKEN_FIELD },
      ],
    },
    Statement: [
      { Sid: 'audit-policy', DataIdentifier: identifiers, Operation: { Audit: { FindingsDestination: {} } } },
      { Sid: 'redact-policy', DataIdentifier: identifiers, Operation: { Deidentify: { MaskConfig: {} } } },
    ],
  };
}

export class AgentCoreRuntimeBackend extends Construct implements IBackend {
  readonly resourceArn: string;
  readonly executionRole: iam.Role;
  /** The L1, for the Gateway target helper and for tests. */
  readonly runtime: agentcore.CfnRuntime;
  /** The Runtime's own log group name, `/aws/bedrock-agentcore/runtimes/<id>-DEFAULT`, settled by `logGroupResource` (T-18). */
  readonly logGroupName: string;
  /** The custom resource that puts retention and the data protection policy on that group (T-18, M-12). */
  readonly logGroupResource: CustomResource;
  /** The resource policy written by `bindIngress`; undefined until then. */
  resourcePolicy?: agentcore.CfnResourcePolicy;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeBackendProps) {
    super(scope, id);

    if (!fs.existsSync(path.join(props.codePath, AGENT_ENTRY_POINT))) {
      throw new Error(`agent.codePath: ${props.codePath} must contain ${AGENT_ENTRY_POINT}`);
    }
    const code = new s3assets.Asset(this, 'AgentCode', { path: props.codePath });

    // The execution role (ADR-0008, amended by ADR-0018): the Runtime service
    // assumes it for this account only. It may read its own code, write its
    // own log group and trace. No model access and no data permission: the
    // agent invokes the model AND reaches tenant data with the credentials
    // vended from the token (ADR-0012, ADR-0018), so a compromised agent holds
    // no shared permission of any kind.
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` },
        },
      }),
      description: 'AgentCore Runtime execution role: logs and traces only; no model and no data (ADR-0008, ADR-0018)',
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
    // Model invocation is NOT granted here (ADR-0008 amended by ADR-0018):
    // the agent signs every model call with the vended tenant credentials, so
    // AWS attributes model cost per tenant and a compromised agent holds no
    // shared model permission. The one-model statement lives on the tenant
    // role (`SharedIngress.grantModel` in src/shared-ingress.cdk.ts, or the
    // backend stack's own policy in src/agent-backend.cdk.ts). The execution
    // role keeps code, logs, traces and metrics only.
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

    // Headers the Runtime admits from the ingress (ADR-0012; v2, ADR-0031).
    // A header that is not listed never reaches the agent, so a client
    // cannot inject one either.
    const allowlist: string[] = [];
    if (props.transports.transactionToken) {
      allowlist.push(RUNTIME_HEADERS.TRANSACTION_TOKEN);
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
      environmentVariables: { [AGENT_ENV.MODEL_ID]: props.modelId, ...props.environment },
      tags: props.tags,
    });
    this.runtime.node.addDependency(this.executionRole);
    this.resourceArn = this.runtime.attrAgentRuntimeArn;

    // The Runtime logs to `/aws/bedrock-agentcore/runtimes/<id>-DEFAULT`, a
    // group the SERVICE creates at CreateAgentRuntime, so the stack cannot
    // own it as an AWS::Logs::LogGroup (AlreadyExists, integration run
    // 2026-11-06). A custom resource that runs after the Runtime settles the
    // group instead: a retention and a data protection policy (T-18, M-12).
    // CloudWatch Logs then masks at ingest any JWT, any credential header and
    // a decoded credential's secret fields, so an agent that goes rogue and logs a header
    // value hands it only to a reader who also holds `logs:Unmask`. A wall
    // behind the agent code, which never logs a header value. Audit findings
    // land in the `LogEventsWithFindings` metric (AWS/Logs), so a deployer
    // can alarm on the first hit. On delete the resource removes the group;
    // the Runtime goes after it (the name references its id), so a line
    // written in between recreates the group outside the stack. It cannot
    // join the LogDrain (ADR-0019) without a dependency cycle; the
    // integration test deletes such a leftover and the README says to check
    // (ADR-0047).
    this.logGroupName = `/aws/bedrock-agentcore/runtimes/${this.runtime.attrAgentRuntimeId}-${RUNTIME_ENDPOINT}`;
    const logGroupFn = customResourceFunction(
      this,
      'LogGroupFunction',
      path.join(__dirname, 'runtime-log-group.function.ts'),
      'runtime-isolation: retention and data protection policy on the Runtime log group the service created (T-18, M-12)',
    );
    // The Runtime prefix, not the one name: when the Runtime is replaced,
    // CloudFormation deletes the OLD group through the new resource's role,
    // which would hold only the new name. Same resource as the execution
    // role's log statement, same reason.
    logGroupFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeLogGroups',
        actions: ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:PutDataProtectionPolicy'],
        resources: [logGroupArn],
      }),
    );
    acknowledgeGranularFinding(logGroupFn, `AwsSolutions-IAM5[Resource::${nagFindingResource(this, logGroupArn)}]`, logReason);
    this.logGroupResource = new CustomResource(this, 'LogGroup', {
      serviceToken: logGroupFn.functionArn,
      resourceType: 'Custom::RuntimeIsolationRuntimeLogGroup',
      properties: {
        LogGroupName: this.logGroupName,
        RetentionInDays: logs.RetentionDays.ONE_MONTH,
        DataProtectionPolicy: Stack.of(this).toJsonString(runtimeLogDataProtectionPolicy()),
      },
    });
    this.logGroupResource.node.addDependency(this.runtime);
  }

  /**
   * P-1 (ADR-0001, spike V-1): the resource policy allows `InvokeAgentRuntime`
   * for the ingress role and denies every `bedrock-agentcore:*` action on
   * the Runtime to any other principal, which covers `InvokeAgentRuntimeForUser`
   * and the WebSocket and command variants this sample does not use. The
   * identity half of the pair lives on the ingress: a tag-conditioned grant
   * over the Runtime ARN pattern (`SharedIngress`, ADR-0024), so the ingress
   * role is passed by ARN and may belong to another stack. Called once.
   *
   * Both statements name the Runtime ARN alone. `PutResourcePolicy` requires
   * every statement to carry exactly one `Resource`, equal to the ARN the
   * policy is attached to (`<arn>/*` is refused with a ValidationException,
   * seen 2026-10-28). The ingress invokes by Runtime ARN, so this one
   * resource is the one the gate must cover; the endpoint form in the
   * ingress grant (ADR-0024) is the identity half only.
   */
  bindIngress(ingressRoleArn: string): agentcore.CfnResourcePolicy {
    if (this.resourcePolicy !== undefined) {
      throw new Error('AgentCoreRuntimeBackend.bindIngress: the backend trusts exactly one ingress (ADR-0003)');
    }
    const stack = Stack.of(this);
    this.resourcePolicy = new agentcore.CfnResourcePolicy(this, 'ResourcePolicy', {
      resourceArn: this.resourceArn,
      policy: stack.toJsonString({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'IngressOnly',
            Effect: 'Allow',
            Principal: { AWS: ingressRoleArn },
            Action: INVOKE_ACTION,
            Resource: this.resourceArn,
          },
          {
            Sid: 'DenyOthers',
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Action: 'bedrock-agentcore:*',
            Resource: this.resourceArn,
            Condition: { ArnNotEquals: { 'aws:PrincipalArn': ingressRoleArn } },
          },
        ],
      }),
    });
    return this.resourcePolicy;
  }

  /**
   * A Gateway target that points at this Runtime (spec C-3b; ADR-0010). The
   * CDK L1 lacks `TargetConfiguration.Http.AgentcoreRuntime` (aws-cdk#37999),
   * so the typed `connector` placeholder is deleted and the Runtime block is
   * written with raw overrides. A unit test asserts the emitted keys, so a
   * casing error fails the build, not the deploy (spike V-2). The Gateway is
   * named by identifier so a backend stack can add a target to an ingress
   * stack's Gateway (ADR-0024); the target name is the backend name.
   */
  addGatewayTarget(gatewayIdentifier: string, name: string): agentcore.CfnGatewayTarget {
    const target = new agentcore.CfnGatewayTarget(this, 'GatewayTarget', {
      gatewayIdentifier,
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

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, Stack, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';
import { baseModelId, isInferenceProfileId } from '../src/backend/agentcore-runtime.cdk';
import { RUNTIME_HEADERS } from '../src/backend/agentcore-runtime.transport';
import { GATEWAY_TARGET_NAME, IsolatedRuntime, IsolatedRuntimeProps, resolveOptions, ROUTE, STAGE_NAME } from '../src/index';
import { ENV } from '../src/shared/config';

/**
 * The construct synthesised in a bare stack, once per option combination the
 * specification promises (standard §4.5, §5.1). Assertions cover what the
 * threat model relies on: the one-principal resource policy, the header
 * allowlist per option, the data-free execution role, DESTROY removal
 * policies, the stage's logging settings and the TVM grant.
 */

const FIXTURE_AGENT = path.join(__dirname, 'fixtures', 'agent');
const DISCOVERY_URL = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00/.well-known/openid-configuration';

type Ingress = IsolatedRuntimeProps['ingress'];
const INGRESSES: Ingress[] = ['api-gateway', 'agentcore-gateway'];

interface Synth {
  template: Template;
  stack: Stack;
  construct: IsolatedRuntime;
  tenantRole: iam.Role;
}

/** Synthesises the construct in a bare stack; NodejsFunction bundling is skipped (template shape, not bundle contents). */
function synth(props: Partial<IsolatedRuntimeProps> & { ingress: Ingress }, withNag = false): Synth {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  if (withNag) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  }
  const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
  const tenantRole = new iam.Role(stack, 'TenantRole', { assumedBy: new iam.AccountRootPrincipal() });
  const construct = new IsolatedRuntime(stack, 'IsolatedRuntime', {
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'] },
    agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' },
    ...props,
    tvm: props.tvm === undefined ? undefined : { ...props.tvm, role: tenantRole },
  });
  return { template: Template.fromStack(stack), stack, construct, tenantRole };
}

/** Every statement of every AWS::IAM::Policy attached to a role whose logical id contains `rolePrefix`. */
function statementsForRole(template: Template, rolePrefix: string): any[] {
  const out: any[] = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy')) as any[]) {
    const roles: any[] = policy.Properties.Roles ?? [];
    if (roles.some((r) => JSON.stringify(r).includes(rolePrefix))) {
      out.push(...policy.Properties.PolicyDocument.Statement);
    }
  }
  return out;
}

function runtimeLogicalId(template: Template): string {
  return Object.keys(template.findResources('AWS::BedrockAgentCore::Runtime'))[0];
}

function resourcePolicy(template: Template): { Statement: any[] } {
  const policy = Object.values(template.findResources('AWS::BedrockAgentCore::ResourcePolicy'))[0] as any;
  // The policy is a Fn::Join of JSON fragments and references; stitch the
  // fragments with placeholders so the document parses.
  const parts = policy.Properties.Policy['Fn::Join'][1] as unknown[];
  const text = parts.map((p) => (typeof p === 'string' ? p : `<<${JSON.stringify(p)}>>`)).join('');
  return JSON.parse(text.replace(/"<<(.*?)>>"/g, (_m, inner) => JSON.stringify(inner)));
}

function lambdaEnv(template: Template, functionDescriptionContains: string): Record<string, unknown> {
  const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
  const fn = fns.find((f) => String(f.Properties.Description ?? '').includes(functionDescriptionContains));
  expect(fn).toBeDefined();
  return fn.Properties.Environment.Variables;
}

// ---------------------------------------------------------------------------
// Props validation (standard §4.5: fail at synth, name the prop)
// ---------------------------------------------------------------------------
describe('resolveOptions', () => {
  const valid: IsolatedRuntimeProps = {
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] },
    agent: { codePath: FIXTURE_AGENT, modelId: 'm' },
    ingress: 'api-gateway',
  };

  it('applies secure defaults: every optional module off, TVM always on with the default role, backend agentcore-runtime', () => {
    expect(resolveOptions(valid)).toEqual({
      backend: 'agentcore-runtime',
      ingress: 'api-gateway',
      sessionScope: undefined,
      requiredScopes: undefined,
      forwardUserToken: false,
      requireNarrowedToken: false,
      allowedScopes: undefined,
      tvm: { role: undefined, includeUserIdTag: false, claimTags: {}, durationSeconds: 900, cacheMaxEntries: 1000 },
      tenantLimits: { requestsPerMinute: 60, outputTokensPerMinute: undefined },
      stageThrottle: { rateLimit: 50, burstLimit: 25 },
      perTenantMetrics: false,
    });
  });

  it('tenantLimits: false and requestsPerMinute 0 without a token limit both turn the limits off', () => {
    expect(resolveOptions({ ...valid, tenantLimits: false }).tenantLimits).toBeUndefined();
    expect(resolveOptions({ ...valid, tenantLimits: { requestsPerMinute: 0 } }).tenantLimits).toBeUndefined();
    expect(resolveOptions({ ...valid, tenantLimits: { requestsPerMinute: 0, outputTokensPerMinute: 100 } }).tenantLimits).toEqual({
      requestsPerMinute: 0,
      outputTokensPerMinute: 100,
    });
  });

  it("session defaults to scope 'user' when set", () => {
    expect(resolveOptions({ ...valid, session: {} }).sessionScope).toBe('user');
    expect(resolveOptions({ ...valid, session: { scope: 'tenant' } }).sessionScope).toBe('tenant');
  });

  it.each<[string, Partial<IsolatedRuntimeProps>, RegExp]>([
    ['identity.discoveryUrl', { identity: { discoveryUrl: 'http://issuer/.well-known/openid-configuration', allowedClientIds: ['c'] } }, /identity\.discoveryUrl/],
    ['identity.discoveryUrl shape', { identity: { discoveryUrl: 'https://issuer/', allowedClientIds: ['c'] } }, /identity\.discoveryUrl/],
    ['identity.allowedClientIds empty', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: [] } }, /identity\.allowedClientIds/],
    ['identity.allowedClientIds blank', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: [''] } }, /identity\.allowedClientIds/],
    ['agent.codePath', { agent: { codePath: '', modelId: 'm' } }, /agent\.codePath/],
    ['agent.modelId', { agent: { codePath: FIXTURE_AGENT, modelId: '' } }, /agent\.modelId/],
    ['backend', { backend: 'lambda' as any }, /backend/],
    ['ingress', { ingress: 'alb' as any }, /ingress/],
    ['session.scope', { session: { scope: 'global' as any } }, /session\.scope/],
    ['requiredScopes empty', { requiredScopes: [] }, /requiredScopes/],
    ['requiredScopes whitespace', { requiredScopes: ['a b'] }, /requiredScopes/],
    ['delegation.requireNarrowedToken without forward', { delegation: { requireNarrowedToken: true, allowedScopes: ['x'] } }, /delegation\.requireNarrowedToken/],
    ['delegation.allowedScopes missing', { delegation: { forwardUserToken: true, requireNarrowedToken: true } }, /delegation\.allowedScopes/],
    ['delegation.allowedScopes without narrowing', { delegation: { forwardUserToken: true, allowedScopes: ['x'] } }, /delegation\.allowedScopes/],
    ['tenantLimits.requestsPerMinute negative', { tenantLimits: { requestsPerMinute: -1 } }, /tenantLimits\.requestsPerMinute/],
    ['tenantLimits.outputTokensPerMinute zero', { tenantLimits: { outputTokensPerMinute: 0 } }, /tenantLimits\.outputTokensPerMinute/],
    ['tenantLimits.outputTokensPerMinute on agentcore-gateway', { ingress: 'agentcore-gateway', tenantLimits: { outputTokensPerMinute: 100 } }, /tenantLimits\.outputTokensPerMinute/],
    ['stageThrottle on agentcore-gateway', { ingress: 'agentcore-gateway', stageThrottle: { rateLimit: 10 } }, /stageThrottle/],
    ['stageThrottle zero rate', { stageThrottle: { rateLimit: 0 } }, /stageThrottle/],
    ['stageThrottle fractional burst', { stageThrottle: { burstLimit: 1.5 } }, /stageThrottle/],
    ['tvm.cacheMaxEntries zero', { tvm: { role: {} as iam.IRole, cacheMaxEntries: 0 } }, /tvm\.cacheMaxEntries/],
    ['tvm.durationSeconds low', { tvm: { role: {} as iam.IRole, durationSeconds: 899 } }, /tvm\.durationSeconds/],
    ['tvm.durationSeconds high', { tvm: { role: {} as iam.IRole, durationSeconds: 3601 } }, /tvm\.durationSeconds/],
    ['tvm.durationSeconds fraction', { tvm: { role: {} as iam.IRole, durationSeconds: 900.5 } }, /tvm\.durationSeconds/],
    ['tvm.claimTags reserved TenantId', { tvm: { role: {} as iam.IRole, claimTags: { TenantId: 'x' } } }, /tvm\.claimTags.*reserved/],
    ['tvm.claimTags reserved UserId', { tvm: { role: {} as iam.IRole, claimTags: { UserId: 'x' } } }, /tvm\.claimTags.*reserved/],
    ['tvm.claimTags bad key', { tvm: { role: {} as iam.IRole, claimTags: { 'bad key!': 'x' } } }, /tvm\.claimTags/],
    ['tvm.claimTags empty claim', { tvm: { role: {} as iam.IRole, claimTags: { Tier: '' } } }, /tvm\.claimTags/],
  ])('fails naming %s', (_name, override, pattern) => {
    expect(() => resolveOptions({ ...valid, ...override })).toThrow(pattern);
  });

  it('accepts a tokenised discovery URL (resolved at deploy)', () => {
    const app = new App();
    const stack = new Stack(app, 'S');
    const token = `https://cognito-idp.${stack.region}.amazonaws.com/${stack.account}/.well-known/openid-configuration`;
    expect(() => resolveOptions({ ...valid, identity: { discoveryUrl: token, allowedClientIds: ['c'] } })).not.toThrow();
  });

  it('fails when the agent directory lacks app.js', () => {
    expect(() => synth({ ingress: 'api-gateway', agent: { codePath: __dirname, modelId: 'm' } })).toThrow(/agent\.codePath.*app\.js/);
  });
});

// ---------------------------------------------------------------------------
// Both ingresses, defaults (every module off)
// ---------------------------------------------------------------------------
describe.each(INGRESSES)('IsolatedRuntime defaults, ingress=%s', (ingress) => {
  const { template, construct } = synth({ ingress });

  it('creates one Runtime with IAM inbound auth (no authorizer), PUBLIC network, HTTP protocol, NODE_22 code from the asset', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AuthorizerConfiguration: Match.absent(),
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      ProtocolConfiguration: 'HTTP',
      AgentRuntimeArtifact: { CodeConfiguration: Match.objectLike({ EntryPoint: ['app.js'], Runtime: 'NODE_22' }) },
    });
  });

  it('the Runtime always admits the credential header (the TVM is always on, ADR-0018) and no user-token header without forwarding', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      RequestHeaderConfiguration: { RequestHeaderAllowlist: [RUNTIME_HEADERS.TENANT_CREDENTIALS] },
    });
  });

  it('the resource policy allows InvokeAgentRuntime for the ingress principal only and denies everything to everyone else (P-1, ADR-0001)', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::ResourcePolicy', 1);
    const policy = resourcePolicy(template);
    expect(policy.Statement).toHaveLength(2);
    const [allow, deny] = policy.Statement;
    expect(allow.Sid).toBe('IngressOnly');
    expect(allow.Effect).toBe('Allow');
    expect(allow.Action).toBe('bedrock-agentcore:InvokeAgentRuntime');
    expect(deny.Sid).toBe('DenyOthers');
    expect(deny.Effect).toBe('Deny');
    expect(deny.Principal).toEqual({ AWS: '*' });
    expect(deny.Action).toBe('bedrock-agentcore:*');
    // The same principal appears in the Allow and in the ArnNotEquals condition, and it is the ingress role.
    const ingressRef = JSON.stringify(Stack.of(construct).resolve(construct.ingressRole.roleArn));
    expect(JSON.stringify(allow.Principal.AWS)).toBe(JSON.stringify(ingressRef));
    expect(JSON.stringify(deny.Condition.ArnNotEquals['aws:PrincipalArn'])).toBe(JSON.stringify(ingressRef));
    // Neither statement names another principal.
    expect(JSON.stringify(policy)).not.toContain('ExecutionRole');
  });

  it('the ingress role holds the invoke grant and the execution role does not (P-1, P-6)', () => {
    const roleId = Stack.of(construct).resolve(construct.ingressRole.roleArn)['Fn::GetAtt'][0] as string;
    const ingressStatements = statementsForRole(template, roleId);
    expect(ingressStatements.some((s) => s.Sid === 'InvokeRuntime' && s.Action === 'bedrock-agentcore:InvokeAgentRuntime')).toBe(true);
    const execStatements = statementsForRole(template, 'IsolatedRuntimeBackendExecutionRole');
    expect(JSON.stringify(execStatements)).not.toContain('bedrock-agentcore:');
  });

  it('the execution role holds its code object, its log prefix and traces, and NO model and no data permission (P-6, ADR-0008 amended by ADR-0018)', () => {
    const statements = statementsForRole(template, 'IsolatedRuntimeBackendExecutionRole');
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])) as string[];
    expect(actions).toEqual(
      expect.arrayContaining(['s3:GetObject', 'logs:PutLogEvents', 'xray:PutTraceSegments', 'cloudwatch:PutMetricData']),
    );
    for (const forbidden of ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'dynamodb:', 'sts:AssumeRole', 'sts:TagSession', 's3:PutObject', 's3:ListBucket', 'secretsmanager:', 'bedrock-agentcore:']) {
      expect(actions.some((a) => a.startsWith(forbidden) || a === forbidden)).toBe(false);
    }
    expect(statements.find((s) => s.Sid === 'OneModel')).toBeUndefined();
    // The trust is the Runtime service for this account only.
    template.hasResourceProperties('AWS::IAM::Role', {
      Description: Match.stringLikeRegexp('execution role'),
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Condition: Match.objectLike({ StringEquals: { 'aws:SourceAccount': Match.anyValue() } }),
          }),
        ],
      },
    });
  });

  it('the default TenantModelRole carries the one-model statement and nothing else, trusted by tvmCallerRole only (ADR-0018)', () => {
    const callerId = Stack.of(construct).resolve(construct.tvmCallerRole.roleArn)['Fn::GetAtt'][0] as string;
    const statements = statementsForRole(template, 'IsolatedRuntimeTenantModelRole');
    const model = statements.find((s) => s.Sid === 'OneModel');
    expect(model).toBeDefined();
    expect(model.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(JSON.stringify(model.Resource)).toContain('foundation-model/amazon.nova-lite-v1:0');
    // No data permission on the default role.
    for (const s of statements) {
      expect(JSON.stringify(s.Action)).not.toContain('dynamodb:');
    }
    // Trust: tvmCallerRole only, TenantId request tag, TagKeys pinned, TagSession.
    const role = Object.values(template.findResources('AWS::IAM::Role', { Properties: { Description: Match.stringLikeRegexp('Default tenant role') } }))[0] as any;
    const [trust] = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust.Action).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(trust.Principal).toEqual({ AWS: Stack.of(construct).resolve(construct.tvmCallerRole.roleArn) });
    expect(trust.Condition).toEqual({
      'StringLike': { 'aws:RequestTag/TenantId': '?*' },
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['TenantId'] },
    });
    expect(role.Properties.MaxSessionDuration).toBe(3600);
    // tvmCallerRole may assume it.
    const grant = statementsForRole(template, callerId).find((s) => s.Sid === 'AssumeTenantRole');
    expect(grant.Action).toEqual(['sts:AssumeRole', 'sts:TagSession']);
  });

  it('every log group has a retention and a DESTROY (Delete) removal policy (standard §4.3)', () => {
    const groups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(groups).length).toBeGreaterThanOrEqual(ingress === 'api-gateway' ? 3 : 1);
    for (const group of Object.values(groups) as any[]) {
      expect(group.Properties.RetentionInDays).toBe(30);
      expect(group.DeletionPolicy).toBe('Delete');
      expect(group.UpdateReplacePolicy).toBe('Delete');
    }
  });

  it('no resource is retained on delete', () => {
    for (const [id, resource] of Object.entries(template.toJSON().Resources) as [string, any][]) {
      expect({ id, policy: resource.DeletionPolicy }).not.toEqual({ id, policy: 'Retain' });
    }
  });

  it('the ingress Lambdas carry every option as environment, with the optional modules off and the TVM on', () => {
    const env = lambdaEnv(template, ingress === 'api-gateway' ? 'chooses the unit' : 'interceptor');
    expect(env).toMatchObject({
      [ENV.INGRESS]: ingress,
      [ENV.DISCOVERY_URL]: DISCOVERY_URL,
      [ENV.ALLOWED_CLIENT_IDS]: 'client-one',
      [ENV.FORWARD_USER_TOKEN]: 'false',
      [ENV.REQUIRE_NARROWED_TOKEN]: 'false',
      // The TVM is always on (ADR-0018): the default role's ARN and its defaults.
      [ENV.TVM_INCLUDE_USER_ID_TAG]: 'false',
      [ENV.TVM_CLAIM_TAGS]: '{}',
      [ENV.TVM_DURATION_SECONDS]: '900',
    });
    expect(env[ENV.TVM_ROLE_ARN]).toBeDefined();
    for (const absent of [ENV.SESSION_SCOPE, ENV.REQUIRED_SCOPES, ENV.ALLOWED_SCOPES]) {
      expect(env).not.toHaveProperty(absent);
    }
  });

  it('Lambdas use Node 24 on arm64 with JSON logs, tracing and explicit log groups', () => {
    // The log-drain waiter is excluded: it is traced by nothing and writes nothing (ADR-0019).
    const fns = (Object.values(template.findResources('AWS::Lambda::Function')) as any[]).filter(
      (f) => !String(f.Properties.Description ?? '').startsWith('Waits on stack delete'),
    );
    expect(fns.length).toBeGreaterThan(0);
    for (const fn of fns) {
      expect(fn.Properties.Runtime).toBe('nodejs24.x');
      expect(fn.Properties.Architectures).toEqual(['arm64']);
      expect(fn.Properties.LoggingConfig).toMatchObject({ LogFormat: 'JSON', LogGroup: { Ref: expect.any(String) } });
      expect(fn.Properties.TracingConfig).toEqual({ Mode: 'Active' });
    }
  });

  it('exposes the read-only properties (spec §6.4)', () => {
    expect(construct.endpointUrl).toBeDefined();
    expect(construct.runtimeArn).toBeDefined();
    expect(construct.ingressRole).toBeDefined();
    expect(construct.executionRole).toBeDefined();
    expect(construct.tvmCallerRole).toBeDefined();
    expect(construct.tenantRole).toBeDefined();
    expect(construct.options.ingress).toBe(ingress);
  });

  it('passes cdk-nag AwsSolutionsChecks with the construct\'s own acknowledgments (standard §4.5)', () => {
    expect(() => synth({ ingress }, true).template.toJSON()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Ingress A specifics
// ---------------------------------------------------------------------------
describe('api-gateway ingress', () => {
  const { template, construct } = synth({ ingress: 'api-gateway' });

  it('the stage logs at INFO with data trace OFF, JSON access logs with a tenantId field, tracing and metrics on (P-9, spike V-7)', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: STAGE_NAME,
      TracingEnabled: true,
      MethodSettings: [
        Match.objectLike({ DataTraceEnabled: false, LoggingLevel: 'INFO', MetricsEnabled: true, HttpMethod: '*', ResourcePath: '/*' }),
      ],
      AccessLogSetting: Match.objectLike({
        Format: Match.stringLikeRegexp('"tenantId":"\\$context\\.authorizer\\.tenantId"'),
      }),
    });
    const stage = Object.values(template.findResources('AWS::ApiGateway::Stage'))[0] as any;
    expect(stage.Properties.AccessLogSetting.Format).toContain('"principalId":"$context.authorizer.principalId"');
    expect(stage.Properties.AccessLogSetting.Format).not.toContain('$input');
  });

  it('the one route is POST /invocations behind the custom Lambda authoriser with request validation', () => {
    template.resourceCountIs('AWS::ApiGateway::Method', 1);
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: ROUTE });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'CUSTOM',
      AuthorizerId: Match.anyValue(),
      RequestValidatorId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'REQUEST',
      IdentitySource: 'method.request.header.Authorization',
      AuthorizerResultTtlInSeconds: 300,
    });
    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', { ValidateRequestBody: true });
  });

  it('the integration streams with a two-minute timeout (spike V-5) and the Lambda outlives it', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      Integration: Match.objectLike({ Type: 'AWS_PROXY', ResponseTransferMode: 'STREAM', TimeoutInMillis: 120_000 }),
    });
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    const ingressFn = fns.find((f) => String(f.Properties.Description).includes('chooses the unit'));
    expect(ingressFn.Properties.Timeout).toBe(150);
  });

  it('session off: the body model allows prompt only (conversationId refused at the gateway)', () => {
    template.hasResourceProperties('AWS::ApiGateway::Model', {
      Schema: Match.objectLike({ required: ['prompt'], additionalProperties: false, properties: { prompt: { type: 'string' } } }),
    });
  });

  it('endpointUrl is the stage URL plus the route; ingressRole and tvmCallerRole are the integration Lambda role', () => {
    const url = Stack.of(construct).resolve(construct.endpointUrl);
    expect(JSON.stringify(url)).toContain(`/${ROUTE}"`);
    expect(JSON.stringify(url)).toContain(`Stage${STAGE_NAME}`);
    expect(construct.ingressRole).toBe(construct.tvmCallerRole);
    expect(JSON.stringify(Stack.of(construct).resolve(construct.ingressRole.roleArn))).toContain('IngressFunctionServiceRole');
  });

  it('creates no Gateway resources', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 0);
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 0);
  });

  it('session on: the body model requires a patterned conversationId', () => {
    synth({ ingress: 'api-gateway', session: {} }).template.hasResourceProperties('AWS::ApiGateway::Model', {
      Schema: Match.objectLike({
        required: ['prompt', 'conversationId'],
        properties: { prompt: { type: 'string' }, conversationId: { type: 'string', pattern: '^[A-Za-z0-9]{16,64}$' } },
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Ingress B specifics
// ---------------------------------------------------------------------------
describe('agentcore-gateway ingress', () => {
  const { template, construct } = synth({ ingress: 'agentcore-gateway' });

  it('the Gateway name is lowercase and the role trust names it exactly, since the service lowercases the gateway id in its ARN', () => {
    const gateway = Object.values(template.findResources('AWS::BedrockAgentCore::Gateway'))[0] as any;
    const name: string = gateway.Properties.Name;
    expect(name).toBe(name.toLowerCase());
    const [, role] = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) => id.includes('GatewayRole')) as [string, any];
    const sourceArn = JSON.stringify(role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.ArnLike['aws:SourceArn']);
    expect(sourceArn).toContain(`:gateway/${name}-*`);
  });

  it('the Gateway uses CUSTOM_JWT on the issuer with the allowed clients and a REQUEST interceptor that sees headers (spike V-3)', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerType: 'CUSTOM_JWT',
      AuthorizerConfiguration: { CustomJWTAuthorizer: { DiscoveryUrl: DISCOVERY_URL, AllowedClients: ['client-one'], AllowedScopes: Match.absent() } },
      InterceptorConfigurations: [
        Match.objectLike({ InterceptionPoints: ['REQUEST'], InputConfiguration: { PassRequestHeaders: true } }),
      ],
      ExceptionLevel: Match.absent(),
    });
  });

  it('the Runtime target is declared through the raw override with the exact CloudFormation keys (ADR-0010, spike V-2)', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1);
    const target = Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget'))[0] as any;
    expect(target.Properties.Name).toBe(GATEWAY_TARGET_NAME);
    expect(target.Properties.TargetConfiguration).toEqual({
      Http: {
        AgentcoreRuntime: {
          Arn: { 'Fn::GetAtt': [runtimeLogicalId(template), 'AgentRuntimeArn'] },
          Qualifier: 'DEFAULT',
        },
      },
    });
    expect(target.Properties.TargetConfiguration.Http).not.toHaveProperty('Connector');
    expect(target.Properties.CredentialProviderConfigurations).toEqual([{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }]);
  });

  it('the Gateway role is the ingress principal, trusted by the service for this account and this gateway only, and may invoke the interceptor by exact ARN', () => {
    expect(JSON.stringify(Stack.of(construct).resolve(construct.ingressRole.roleArn))).toContain('GatewayRole');
    template.hasResourceProperties('AWS::IAM::Role', {
      Description: Match.stringLikeRegexp('Gateway role'),
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Condition: { StringEquals: { 'aws:SourceAccount': Match.anyValue() }, ArnLike: { 'aws:SourceArn': Match.anyValue() } },
          }),
        ],
      },
    });
    const statements = statementsForRole(template, 'GatewayRole');
    const invoke = statements.find((s) => s.Sid === 'InvokeInterceptor');
    expect(invoke.Action).toBe('lambda:InvokeFunction');
    expect(JSON.stringify(invoke.Resource)).not.toContain(':*');
  });

  it('tvmCallerRole is the interceptor role, distinct from the ingress role', () => {
    expect(construct.tvmCallerRole).not.toBe(construct.ingressRole);
    expect(JSON.stringify(Stack.of(construct).resolve(construct.tvmCallerRole.roleArn))).toContain('InterceptorFunctionServiceRole');
  });

  it('endpointUrl is the Gateway URL plus /<target>/invocations', () => {
    const url = Stack.of(construct).resolve(construct.endpointUrl);
    expect(JSON.stringify(url)).toContain(`/${GATEWAY_TARGET_NAME}/${ROUTE}`);
    expect(JSON.stringify(url)).toContain('GatewayUrl');
  });

  it('creates no API Gateway resources', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
  });

  it('requiredScopes are also set as the Gateway authoriser allowedScopes (ADR-0005)', () => {
    synth({ ingress: 'agentcore-gateway', requiredScopes: ['tenant-api/read'] }).template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerConfiguration: { CustomJWTAuthorizer: Match.objectLike({ AllowedScopes: ['tenant-api/read'] }) },
    });
  });
});

// ---------------------------------------------------------------------------
// Option combinations, both ingresses
// ---------------------------------------------------------------------------
describe.each(INGRESSES)('options, ingress=%s', (ingress) => {
  const fnDescription = ingress === 'api-gateway' ? 'chooses the unit' : 'interceptor';

  it('session: scope reaches the Lambdas', () => {
    expect(lambdaEnv(synth({ ingress, session: { scope: 'tenant' } }).template, fnDescription)[ENV.SESSION_SCOPE]).toBe('tenant');
    expect(lambdaEnv(synth({ ingress, session: {} }).template, fnDescription)[ENV.SESSION_SCOPE]).toBe('user');
  });

  it('requiredScopes reach the Lambdas', () => {
    expect(lambdaEnv(synth({ ingress, requiredScopes: ['a', 'b'] }).template, fnDescription)[ENV.REQUIRED_SCOPES]).toBe('a,b');
  });

  it('delegation.forwardUserToken adds the user-token header alongside the always-on credential header (ADR-0006, ADR-0018)', () => {
    const { template } = synth({ ingress, delegation: { forwardUserToken: true } });
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      RequestHeaderConfiguration: { RequestHeaderAllowlist: [RUNTIME_HEADERS.USER_TOKEN, RUNTIME_HEADERS.TENANT_CREDENTIALS] },
    });
    expect(lambdaEnv(template, fnDescription)[ENV.FORWARD_USER_TOKEN]).toBe('true');
  });

  it('delegation.requireNarrowedToken passes the allowed scopes', () => {
    const env = lambdaEnv(
      synth({ ingress, delegation: { forwardUserToken: true, requireNarrowedToken: true, allowedScopes: ['tenant-api/read'] } }).template,
      fnDescription,
    );
    expect(env[ENV.REQUIRE_NARROWED_TOKEN]).toBe('true');
    expect(env[ENV.ALLOWED_SCOPES]).toBe('tenant-api/read');
  });

  it('tvm puts only the credential header on the allowlist and grants AssumeRole+TagSession on the tenant role to tvmCallerRole only (ADR-0012)', () => {
    const { template, construct, tenantRole } = synth({ ingress, tvm: { role: {} as iam.IRole, includeUserIdTag: true, claimTags: { Tier: 'custom:tier' }, durationSeconds: 1800 } });
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      RequestHeaderConfiguration: { RequestHeaderAllowlist: [RUNTIME_HEADERS.TENANT_CREDENTIALS] },
    });
    const callerId = Stack.of(construct).resolve(construct.tvmCallerRole.roleArn)['Fn::GetAtt'][0] as string;
    const grant = statementsForRole(template, callerId).find((s) => s.Sid === 'AssumeTenantRole');
    expect(grant.Action).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(grant.Resource).toEqual(Stack.of(construct).resolve(tenantRole.roleArn));
    // Only one role holds the grant.
    const all = JSON.stringify(template.toJSON());
    expect(all.split('AssumeTenantRole').length - 1).toBe(1);
    // The execution role still has nothing tenant-scoped, and no model.
    expect(JSON.stringify(statementsForRole(template, 'IsolatedRuntimeBackendExecutionRole'))).not.toContain('sts:');
    expect(JSON.stringify(statementsForRole(template, 'IsolatedRuntimeBackendExecutionRole'))).not.toContain('bedrock:Invoke');
    // The construct adds the one-model statement to the DEPLOYER's role (ADR-0018), and creates no default role.
    const deployerId = Stack.of(construct).resolve(tenantRole.roleArn)['Fn::GetAtt'][0] as string;
    const model = statementsForRole(template, deployerId).find((s) => s.Sid === 'OneModel');
    expect(model.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(construct.tenantRole).toBe(tenantRole);
    expect(JSON.stringify(template.toJSON())).not.toContain('TenantModelRole');
    const env = lambdaEnv(template, fnDescription);
    expect(env[ENV.TVM_ROLE_ARN]).toEqual(Stack.of(construct).resolve(tenantRole.roleArn));
    expect(env[ENV.TVM_INCLUDE_USER_ID_TAG]).toBe('true');
    expect(env[ENV.TVM_CLAIM_TAGS]).toBe('{"Tier":"custom:tier"}');
    expect(env[ENV.TVM_DURATION_SECONDS]).toBe('1800');
  });

  it('tvm defaults: UserId off, 900 s, no claim tags', () => {
    const env = lambdaEnv(synth({ ingress, tvm: { role: {} as iam.IRole } }).template, fnDescription);
    expect(env[ENV.TVM_INCLUDE_USER_ID_TAG]).toBe('false');
    expect(env[ENV.TVM_CLAIM_TAGS]).toBe('{}');
    expect(env[ENV.TVM_DURATION_SECONDS]).toBe('900');
  });

  it('forwarding and tvm together: both headers, in that order', () => {
    synth({ ingress, delegation: { forwardUserToken: true }, tvm: { role: {} as iam.IRole } }).template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      RequestHeaderConfiguration: { RequestHeaderAllowlist: [RUNTIME_HEADERS.USER_TOKEN, RUNTIME_HEADERS.TENANT_CREDENTIALS] },
    });
  });

  it('every module on passes cdk-nag', () => {
    expect(() =>
      synth(
        {
          ingress,
          session: {},
          requiredScopes: ['tenant-api/read'],
          delegation: { forwardUserToken: true, requireNarrowedToken: true, allowedScopes: ['tenant-api/read'] },
          tvm: { role: {} as iam.IRole, includeUserIdTag: true },
        },
        true,
      ).template.toJSON(),
    ).not.toThrow();
  });

  it('agent.environment reaches the Runtime, alongside MODEL_ID (the one model the agent calls, P-6)', () => {
    synth({ ingress, agent: { codePath: FIXTURE_AGENT, modelId: 'm', environment: { TABLE_NAME: 'demo' } } }).template.hasResourceProperties(
      'AWS::BedrockAgentCore::Runtime',
      { EnvironmentVariables: { TABLE_NAME: 'demo', MODEL_ID: 'm' } },
    );
    synth({ ingress }).template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: { MODEL_ID: 'amazon.nova-lite-v1:0' },
    });
  });
});

describe('the tenant role model grant (ADR-0018, was the execution role under ADR-0008)', () => {
  const oneModel = (t: Template) => statementsForRole(t, 'IsolatedRuntimeTenantModelRole').find((s) => s.Sid === 'OneModel');
  const resolved = (s: unknown) => JSON.stringify(s);

  it('a plain model id: both invoke actions on the foundation-model ARN in this Region, and nothing else; the execution role has no model', () => {
    const { template } = synth({ ingress: 'api-gateway' });
    const statement = oneModel(template);
    expect(statement.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    expect(resources).toHaveLength(1);
    expect(resolved(resources[0])).toContain(':bedrock:');
    expect(resolved(resources[0])).toContain('::foundation-model/amazon.nova-lite-v1:0');
    expect(resolved(resources[0])).not.toContain('inference-profile');
    expect(resolved(resources[0])).not.toContain('*');
    // The execution role touches no Bedrock at all (ADR-0008 amended).
    const exec = statementsForRole(template, 'IsolatedRuntimeBackendExecutionRole');
    expect(resolved(exec)).not.toContain('bedrock:Invoke');
    expect(exec.find((s: any) => s.Sid === 'OneModel')).toBeUndefined();
  });

  it('a cross-Region inference profile id: the account-scoped profile ARN plus the base model in any Region, no wildcard on the model', () => {
    const { template } = synth({ ingress: 'api-gateway', agent: { codePath: FIXTURE_AGENT, modelId: 'eu.amazon.nova-lite-v1:0' } }, true);
    const statement = oneModel(template);
    expect(statement.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(statement.Resource).toHaveLength(2);
    const [profile, model] = statement.Resource.map(resolved);
    expect(profile).toContain(':inference-profile/eu.amazon.nova-lite-v1:0');
    expect(profile).toContain('AWS::AccountId');
    expect(model).toContain(':bedrock:*::foundation-model/amazon.nova-lite-v1:0');
    expect(model).not.toContain('foundation-model/*');
    // The agent is told the profile id as given.
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', { EnvironmentVariables: { MODEL_ID: 'eu.amazon.nova-lite-v1:0' } });
    // cdk-nag passes with the Region-wildcard acknowledgment.
    expect(() => template.toJSON()).not.toThrow();
  });

  it('isInferenceProfileId and baseModelId recognise the geo prefixes only', () => {
    expect(isInferenceProfileId('amazon.nova-lite-v1:0')).toBe(false);
    expect(isInferenceProfileId('anthropic.claude-3-5-haiku-20241022-v1:0')).toBe(false);
    for (const prefix of ['us', 'eu', 'apac', 'global', 'us-gov', 'jp', 'au', 'ca']) {
      expect(isInferenceProfileId(`${prefix}.amazon.nova-lite-v1:0`)).toBe(true);
      expect(baseModelId(`${prefix}.amazon.nova-lite-v1:0`)).toBe('amazon.nova-lite-v1:0');
    }
    expect(baseModelId('amazon.nova-lite-v1:0')).toBe('amazon.nova-lite-v1:0');
  });
});

// ---------------------------------------------------------------------------
// Per-tenant limits, stage throttle and the per-tenant metrics opt-in
// (ADR-0020, ADR-0021, ADR-0022)
// ---------------------------------------------------------------------------
describe.each(INGRESSES)('per-tenant limits, ingress=%s (ADR-0020)', (ingress) => {
  const fnDescription = ingress === 'api-gateway' ? 'chooses the unit' : 'interceptor';
  const { template, construct } = synth({ ingress });

  it('by default creates one TenantLimits table with a TTL on expiresAt, PITR and DeletionPolicy Delete', () => {
    const tables = template.findResources('AWS::DynamoDB::GlobalTable');
    expect(Object.keys(tables)).toHaveLength(1);
    const [id, table] = Object.entries(tables)[0] as [string, any];
    expect(id).toContain('TenantLimits');
    expect(table.DeletionPolicy).toBe('Delete');
    expect(table.UpdateReplacePolicy).toBe('Delete');
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: 'PK', KeyType: 'HASH' }]);
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'expiresAt', Enabled: true });
    expect(table.Properties.Replicas[0].PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(construct.limitsTable).toBeDefined();
  });

  it('writes the table name and the limits to the ingress environment, metrics off and the cache bound', () => {
    const env = lambdaEnv(template, fnDescription);
    expect(env[ENV.LIMITS_TABLE]).toEqual(Stack.of(construct).resolve(construct.limitsTable!.tableName));
    expect(env[ENV.LIMIT_REQUESTS_PER_MINUTE]).toBe('60');
    expect(env).not.toHaveProperty(ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE);
    expect(env[ENV.PER_TENANT_METRICS]).toBe('false');
    expect(env[ENV.TVM_CACHE_MAX_ENTRIES]).toBe('1000');
  });

  it('tvmCallerRole has dynamodb:UpdateItem on exactly that table, and no other DynamoDB action', () => {
    const callerId = Stack.of(construct).resolve(construct.tvmCallerRole.roleArn)['Fn::GetAtt'][0] as string;
    const statements = statementsForRole(template, callerId);
    const count = statements.filter((s) => JSON.stringify(s.Action).includes('dynamodb:'));
    expect(count).toHaveLength(1);
    expect(count[0].Sid).toBe('CountTenantUsage');
    expect(count[0].Action).toBe('dynamodb:UpdateItem');
    expect(count[0].Resource).toEqual(Stack.of(construct).resolve(construct.limitsTable!.tableArn));
  });

  it('tenantLimits: false creates no table and sets no limits environment', () => {
    const off = synth({ ingress, tenantLimits: false });
    off.template.resourceCountIs('AWS::DynamoDB::GlobalTable', 0);
    expect(off.construct.limitsTable).toBeUndefined();
    const env = lambdaEnv(off.template, fnDescription);
    for (const name of [ENV.LIMITS_TABLE, ENV.LIMIT_REQUESTS_PER_MINUTE, ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(JSON.stringify(off.template.toJSON())).not.toContain('dynamodb:UpdateItem');
  });

  it('tvm.cacheMaxEntries reaches the environment', () => {
    expect(lambdaEnv(synth({ ingress, tvm: { cacheMaxEntries: 50 } }).template, fnDescription)[ENV.TVM_CACHE_MAX_ENTRIES]).toBe('50');
  });

  it('perTenantMetrics: true adds the cost warning and sets the flag; false (default) adds no warning', () => {
    const on = synth({ ingress, perTenantMetrics: true });
    Annotations.fromStack(on.stack).hasWarning('*', Match.stringLikeRegexp('perTenantMetrics is on.*custom metrics per ingress'));
    Annotations.fromStack(on.stack).hasWarning('*', Match.stringLikeRegexp('runtime-isolation:per-tenant-metrics-cost'));
    expect(lambdaEnv(on.template, fnDescription)[ENV.PER_TENANT_METRICS]).toBe('true');
    Annotations.fromStack(synth({ ingress, perTenantMetrics: false }).stack).hasNoWarning('*', Match.stringLikeRegexp('perTenantMetrics'));
    Annotations.fromStack(synth({ ingress }).stack).hasNoWarning('*', Match.stringLikeRegexp('perTenantMetrics'));
  });
});

describe('per-tenant limits and stage throttle, api-gateway only', () => {
  it('outputTokensPerMinute reaches the integration Lambda environment', () => {
    const { template } = synth({ ingress: 'api-gateway', tenantLimits: { requestsPerMinute: 30, outputTokensPerMinute: 5000 } });
    const env = lambdaEnv(template, 'chooses the unit');
    expect(env[ENV.LIMIT_REQUESTS_PER_MINUTE]).toBe('30');
    expect(env[ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE]).toBe('5000');
  });

  it('outputTokensPerMinute with agentcore-gateway throws naming tenantLimits.outputTokensPerMinute', () => {
    expect(() => synth({ ingress: 'agentcore-gateway', tenantLimits: { outputTokensPerMinute: 5000 } })).toThrow(/tenantLimits\.outputTokensPerMinute/);
  });

  it('the stage throttle defaults to 50/25 and stageThrottle overrides it', () => {
    synth({ ingress: 'api-gateway' }).template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: [Match.objectLike({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 25 })],
    });
    synth({ ingress: 'api-gateway', stageThrottle: { rateLimit: 200, burstLimit: 100 } }).template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: [Match.objectLike({ ThrottlingRateLimit: 200, ThrottlingBurstLimit: 100 })],
    });
  });

  it('stageThrottle with agentcore-gateway throws naming stageThrottle', () => {
    expect(() => synth({ ingress: 'agentcore-gateway', stageThrottle: { rateLimit: 10, burstLimit: 5 } })).toThrow(/stageThrottle/);
  });
});

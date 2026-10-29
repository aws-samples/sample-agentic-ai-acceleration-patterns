// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, CfnOutput, Duration, Stack, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';
import { baseModelId, isInferenceProfileId } from '../src/backend/agentcore-runtime.cdk';
import { RUNTIME_HEADERS } from '../src/backend/agentcore-runtime.transport';
import {
  AgentBackend,
  type AgentProps,
  DEFAULT_REGISTRY_PREFIX,
  GATEWAY_TARGET_NAME,
  IDENTITY_API_PARAMETERS,
  type IdentityApiProps,
  INGRESS_TAG_KEY,
  MAX_REGISTRY_TTL,
  PUBLISHED,
  RegistryEntryResource,
  registryParameterName,
  resolveOptions,
  ROUTE,
  ScopeRegistration,
  SharedIngress,
  type SharedIngressProps,
  SharedIngressRef,
  STAGE_NAME,
} from '../src/index';
import { ENV } from '../src/shared/config';

/**
 * The construct synthesised in a bare stack, once per option combination the
 * specification promises (standard §4.5, §5.1). Assertions cover what the
 * threat model relies on: the one-principal resource policy, the header
 * allowlist per option, the data-free execution role, DESTROY removal
 * policies, the stage's logging settings, the TVM grant and, since ADR-0024,
 * the tag-conditioned invoke grant, the registry read grant and the
 * registry entry.
 */

const FIXTURE_AGENT = path.join(__dirname, 'fixtures', 'agent');
const DISCOVERY_URL = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00/.well-known/openid-configuration';
/** The identity API given by value, so a synth test needs no SSM lookup (the demo does the same with `identityParameterPlaceholders`). */
const IDENTITY_API: IdentityApiProps = { apiUrl: 'https://identity.example.com/prod/', platformInvokePolicyArn: 'arn:aws:iam::111122223333:policy/PlatformInvoke' };
/** The default backend's one scope (ADR-0025). */
const DEFAULT_SCOPES = [`${GATEWAY_TARGET_NAME}/chat`];
const agentOf = (modelId = 'm'): AgentProps => ({ codePath: FIXTURE_AGENT, modelId });

type DemoProps = Omit<SharedIngressProps, 'defaultBackend'> & { agent: AgentProps; backendName?: string };
type Ingress = DemoProps['ingress'];
const INGRESSES: Ingress[] = ['api-gateway', 'agentcore-gateway'];

interface Synth {
  template: Template;
  stack: Stack;
  construct: {
    endpointUrl: string;
    runtimeArn: string;
    executionRole: iam.IRole;
    ingress: SharedIngress;
    backend: AgentBackend;
    options: SharedIngress['options'];
    ingressRole: iam.IRole;
    tvmCallerRole: iam.IRole;
    tenantRole: iam.IRole;
    limitsTable: SharedIngress['limitsTable'];
  };
  tenantRole: iam.Role;
}

/** Synthesises the construct in a bare stack; NodejsFunction bundling is skipped (template shape, not bundle contents). */
function synth(props: Partial<DemoProps> & { ingress: Ingress }, withNag = false): Synth {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  if (withNag) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  }
  const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
  const tenantRole = new iam.Role(stack, 'TenantRole', { assumedBy: new iam.AccountRootPrincipal() });
  const merged = {
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'] },
    agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' },
    ...props,
    tvm: props.tvm === undefined ? undefined : { ...props.tvm, role: tenantRole },
  } as DemoProps;
  const { agent, backendName, ...rest } = merged;
  const bn = backendName ?? GATEWAY_TARGET_NAME;
  const ingress = new SharedIngress(stack, 'Ingress', { ...rest, defaultBackend: bn });
  const backend = new AgentBackend(stack, 'Backend', { name: bn, ingress, agent, scopes: [`${bn}/chat`], identityApi: IDENTITY_API });
  const endpointUrl = rest.ingress === 'api-gateway' ? `${ingress.endpointUrl}/${ROUTE}` : ingress.urlFor(bn);
  const construct = {
    endpointUrl,
    runtimeArn: backend.runtimeArn,
    executionRole: backend.executionRole,
    ingress,
    backend,
    options: ingress.options,
    ingressRole: ingress.ingressRole,
    tvmCallerRole: ingress.tvmCallerRole,
    tenantRole: ingress.tenantRole,
    limitsTable: ingress.limitsTable,
  };
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
  // fragments with placeholders so the document parses. A reference with a
  // literal tail (`<arn>/*`) stays one string: the placeholder plus the tail.
  const parts = policy.Properties.Policy['Fn::Join'][1] as unknown[];
  const text = parts.map((p) => (typeof p === 'string' ? p : `<<${JSON.stringify(p)}>>`)).join('');
  return JSON.parse(text.replace(/"<<(.*?)>>([^"]*)"/g, (_m, inner, tail) => JSON.stringify(inner + tail)));
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
  const valid: DemoProps = {
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] },
    agent: { codePath: FIXTURE_AGENT, modelId: 'm' },
    ingress: 'api-gateway',
  };

  it('applies secure defaults: every optional module off, TVM always on with the default role, backend agentcore-runtime, the default registry (ADR-0024)', () => {
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
      registryPrefix: DEFAULT_REGISTRY_PREFIX,
      registryTtlSeconds: 60,
      defaultBackend: undefined,
    });
  });

  it('registryPrefix must start and end with /, registryTtl be whole seconds from 1 to 750, defaultBackend a backend name', () => {
    expect(() => resolveOptions({ ...valid, registryPrefix: 'application-plane/' })).toThrow(/registryPrefix/);
    expect(() => resolveOptions({ ...valid, registryPrefix: '/application-plane' })).toThrow(/registryPrefix/);
    expect(() => resolveOptions({ ...valid, registryTtl: Duration.seconds(0) })).toThrow(/registryTtl/);
    // The entry drains TTL + 120 s inside one Lambda invocation (+ 30 s slack), which must stay under 900 s.
    expect(MAX_REGISTRY_TTL.toSeconds()).toBe(750);
    expect(() => resolveOptions({ ...valid, registryTtl: Duration.seconds(751) })).toThrow(/SharedIngress: registryTtl must be .* 1 to 750 \(got 751\)/);
    expect(() => resolveOptions({ ...valid, registryTtl: Duration.minutes(15) })).toThrow(/registryTtl/);
    expect(resolveOptions({ ...valid, registryTtl: Duration.seconds(750) }).registryTtlSeconds).toBe(750);
    expect(() => resolveOptions({ ...valid, defaultBackend: 'Billing' } as any)).toThrow(/defaultBackend/);
    expect(resolveOptions({ ...valid, registryPrefix: '/custom/', registryTtl: Duration.seconds(5) })).toMatchObject({ registryPrefix: '/custom/', registryTtlSeconds: 5 });
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

  it.each<[string, Partial<DemoProps>, RegExp]>([
    ['identity.discoveryUrl', { identity: { discoveryUrl: 'http://issuer/.well-known/openid-configuration', allowedClientIds: ['c'] } }, /identity\.discoveryUrl/],
    ['identity.discoveryUrl shape', { identity: { discoveryUrl: 'https://issuer/', allowedClientIds: ['c'] } }, /identity\.discoveryUrl/],
    ['identity.allowedClientIds empty', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: [] } }, /identity\.allowedClientIds/],
    ['identity.allowedClientIds blank', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: [''] } }, /identity\.allowedClientIds/],
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

  it('the backend names agent.codePath, agent.modelId and backendName on a bad value', () => {
    expect(() => synth({ ingress: 'api-gateway', agent: { codePath: '', modelId: 'm' } })).toThrow(/agent\.codePath/);
    expect(() => synth({ ingress: 'api-gateway', agent: { codePath: FIXTURE_AGENT, modelId: '' } })).toThrow(/agent\.modelId/);
    expect(() => synth({ ingress: 'api-gateway', backendName: 'Agent' })).toThrow(/must match/);
  });
});

// ---------------------------------------------------------------------------
// Both ingresses, defaults (every module off)
// ---------------------------------------------------------------------------
describe.each(INGRESSES)('one-backend defaults, ingress=%s', (ingress) => {
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

  it('the resource policy allows InvokeAgentRuntime for the ingress principal only and denies everything to everyone else, on the Runtime ARN (P-1, ADR-0001, ADR-0024)', () => {
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
    // Both statements name the Runtime ARN alone: PutResourcePolicy requires exactly one
    // Resource per statement, equal to the attached ARN (`<arn>/*` is refused).
    const runtimeArnRef = JSON.stringify(Stack.of(construct.ingress).resolve(construct.runtimeArn));
    for (const statement of [allow, deny]) {
      expect(statement.Resource).toBe(runtimeArnRef);
    }
    // The same principal appears in the Allow and in the ArnNotEquals condition, and it is the ingress role.
    const ingressRef = JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingressRole.roleArn));
    expect(JSON.stringify(allow.Principal.AWS)).toBe(JSON.stringify(ingressRef));
    expect(JSON.stringify(deny.Condition.ArnNotEquals['aws:PrincipalArn'])).toBe(JSON.stringify(ingressRef));
    // Neither statement names another principal.
    expect(JSON.stringify(policy)).not.toContain('ExecutionRole');
  });

  it('the ingress role may invoke only Runtimes tagged ri:ingress = ingressId, on the runtime/* and endpoint patterns; the execution role has no invoke (P-1, P-6, ADR-0024)', () => {
    const roleId = Stack.of(construct.ingress).resolve(construct.ingressRole.roleArn)['Fn::GetAtt'][0] as string;
    const grant = statementsForRole(template, roleId).find((s) => s.Sid === 'InvokeTaggedRuntimes');
    expect(grant.Action).toBe('bedrock-agentcore:InvokeAgentRuntime');
    const resources = grant.Resource.map((r: unknown) => JSON.stringify(r));
    expect(resources).toHaveLength(2);
    expect(resources[0]).toContain(':bedrock-agentcore:');
    expect(resources[0]).toContain(':runtime/*"');
    expect(resources[1]).toContain(':runtime/*/runtime-endpoint/*"');
    expect(grant.Condition).toEqual({ StringEquals: { [`aws:ResourceTag/${INGRESS_TAG_KEY}`]: construct.ingress.ingressId } });
    // No per-Runtime grant remains (the old InvokeRuntime statement).
    expect(JSON.stringify(template.toJSON())).not.toContain('"InvokeRuntime"');
    const execStatements = statementsForRole(template, 'BackendRuntimeExecutionRole');
    expect(JSON.stringify(execStatements)).not.toContain('bedrock-agentcore:');
  });

  it('the Runtime carries the ri:ingress tag at creation, equal to ingressId, which is lower case and at most 48 characters (ADR-0024)', () => {
    const { ingressId } = construct.ingress;
    expect(ingressId).toBe(ingressId.toLowerCase());
    expect(ingressId.length).toBeLessThanOrEqual(48);
    expect(ingressId.length).toBeGreaterThan(0);
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', { Tags: { [INGRESS_TAG_KEY]: ingressId } });
  });

  it('the route resolvers may read registry entries under the prefix and nothing else in Parameter Store (ADR-0024)', () => {
    const readers = ingress === 'api-gateway' ? ['AuthorizerFunctionServiceRole', 'IngressFunctionServiceRole'] : ['InterceptorFunctionServiceRole'];
    for (const reader of readers) {
      const statement = statementsForRole(template, reader).find((s) => s.Sid === 'ReadBackendRegistry');
      expect(statement).toBeDefined();
      expect(statement.Action).toBe('ssm:GetParameter');
      const resource = JSON.stringify(statement.Resource);
      expect(resource).toContain(':ssm:');
      expect(resource).toContain(`:parameter${DEFAULT_REGISTRY_PREFIX}backends/*"`);
    }
    // No ingress role may write the registry: the only Put/Delete grant is the registry-entry writer's.
    const writers = (Object.values(template.findResources('AWS::IAM::Policy')) as any[]).filter((p) =>
      JSON.stringify(p.Properties.PolicyDocument).includes('ssm:PutParameter'),
    );
    expect(writers).toHaveLength(1);
    expect(JSON.stringify(writers[0].Properties.Roles)).toContain('RegistryEntryFunctionServiceRole');
  });

  it('writes one registry entry for the default backend through a custom resource that drains before removal (ADR-0024)', () => {
    const entries = Object.values(template.findResources('Custom::RuntimeIsolationRegistryEntry')) as any[];
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.Properties.ParameterName).toBe(registryParameterName(DEFAULT_REGISTRY_PREFIX, GATEWAY_TARGET_NAME));
    expect(entry.Properties.RuntimeArn).toEqual({ 'Fn::GetAtt': [runtimeLogicalId(template), 'AgentRuntimeArn'] });
    expect(entry.Properties.Scopes).toEqual(DEFAULT_SCOPES);
    expect(entry.Properties.DrainSeconds).toBe(180);
    // Written after the Runtime, its resource policy (and the target), and the scope registration (ADR-0025).
    const deps: string[] = entry.DependsOn ?? [];
    expect(deps).toContain(runtimeLogicalId(template));
    expect(deps.some((d) => d.includes('ResourcePolicy'))).toBe(true);
    expect(deps.some((d) => d.includes('BackendScopes'))).toBe(true);
    if (ingress === 'agentcore-gateway') {
      expect(deps.some((d) => d.includes('GatewayTarget'))).toBe(true);
    }
    expect(construct.backend.registryParameterName).toBe(`${DEFAULT_REGISTRY_PREFIX}backends/${GATEWAY_TARGET_NAME}`);
    // Its role may put, get and delete exactly that parameter.
    const own = statementsForRole(template, 'RegistryEntryFunctionServiceRole').find((s) => s.Sid === 'OwnRegistryEntry');
    expect(own.Action).toEqual(['ssm:PutParameter', 'ssm:GetParameter', 'ssm:DeleteParameter']);
    expect(JSON.stringify(own.Resource)).toContain(`:parameter${DEFAULT_REGISTRY_PREFIX}backends/${GATEWAY_TARGET_NAME}"`);
    // The drain waits the whole delete.
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    const writer = fns.find((f) => String(f.Properties.Description).includes('registry entry'));
    expect(writer.Properties.Timeout).toBe(210);
  });

  it('publishes endpointUrl, baseUrl, ingressRoleArn, ingressId, ingress and tenantRoleArn under the prefix (ADR-0024)', () => {
    const params = Object.values(template.findResources('AWS::SSM::Parameter')) as any[];
    const names = params.map((p) => p.Properties.Name as string).sort();
    const expected: string[] = [
      PUBLISHED.endpointUrl,
      PUBLISHED.baseUrl,
      PUBLISHED.ingressRoleArn,
      PUBLISHED.ingressId,
      PUBLISHED.ingress,
      PUBLISHED.tenantRoleArn,
    ];
    const expectedNames = expected
      .concat(ingress === 'agentcore-gateway' ? [PUBLISHED.gatewayIdentifier] : [])
      .map((n) => `${DEFAULT_REGISTRY_PREFIX}${n}`)
      .sort();
    expect(names).toEqual(expectedNames);
    const byName = (n: string) => params.find((p) => p.Properties.Name === `${DEFAULT_REGISTRY_PREFIX}${n}`).Properties.Value;
    expect(byName(PUBLISHED.ingress)).toBe(ingress);
    // endpointUrl keeps the spec §6.4 meaning (the default backend's invocation URL, what the scripts POST to); baseUrl is the base.
    expect(byName(PUBLISHED.endpointUrl)).toEqual(Stack.of(construct.ingress).resolve(construct.endpointUrl));
    expect(byName(PUBLISHED.baseUrl)).toEqual(Stack.of(construct.ingress).resolve(construct.ingress.endpointUrl));
    expect(byName(PUBLISHED.ingressId)).toBe(construct.ingress.ingressId);
    expect(byName(PUBLISHED.ingressRoleArn)).toEqual(Stack.of(construct.ingress).resolve(construct.ingressRole.roleArn));
    expect(byName(PUBLISHED.tenantRoleArn)).toEqual(Stack.of(construct.ingress).resolve(construct.tenantRole.roleArn));
  });

  it('the execution role holds its code object, its log prefix and traces, and NO model and no data permission (P-6, ADR-0008 amended by ADR-0018)', () => {
    const statements = statementsForRole(template, 'BackendRuntimeExecutionRole');
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
    const callerId = Stack.of(construct.ingress).resolve(construct.tvmCallerRole.roleArn)['Fn::GetAtt'][0] as string;
    const statements = statementsForRole(template, 'TenantModelRole');
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
    expect(trust.Principal).toEqual({ AWS: Stack.of(construct.ingress).resolve(construct.tvmCallerRole.roleArn) });
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
    // The registry (ADR-0024) replaces the Runtime ARN: no Lambda knows a backend.
    expect(env[ENV.REGISTRY_PREFIX]).toBe(DEFAULT_REGISTRY_PREFIX);
    expect(env[ENV.REGISTRY_TTL_SECONDS]).toBe('60');
    expect(env[ENV.DEFAULT_BACKEND]).toBe(GATEWAY_TARGET_NAME);
    // The registry's account, so a resolver refuses an entry naming another account's Runtime; the Region is AWS_REGION.
    expect(ENV.REGISTRY_ACCOUNT).toBe('RI_REGISTRY_ACCOUNT');
    expect(env[ENV.REGISTRY_ACCOUNT]).toBe('111122223333');
    expect(env).not.toHaveProperty('RI_REGISTRY_REGION');
    expect(env).not.toHaveProperty('RI_RUNTIME_ARN');
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function')) as any[]) {
      expect(JSON.stringify(fn.Properties.Environment ?? {})).not.toContain('AgentRuntimeArn');
    }
  });

  it('Lambdas use Node 24 on arm64 with JSON logs and explicit log groups; the request-path ones trace', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    expect(fns.length).toBeGreaterThan(0);
    for (const fn of fns) {
      expect(fn.Properties.Runtime).toBe('nodejs24.x');
      expect(fn.Properties.Architectures).toEqual(['arm64']);
      expect(fn.Properties.LoggingConfig).toMatchObject({ LogFormat: 'JSON', LogGroup: { Ref: expect.any(String) } });
    }
    // The log-drain waiter, the registry-entry writer and the scope registration run on stack operations, not requests: no tracing, and quiet logs (ADR-0019).
    const quiet = fns.filter((f) => /Waits on stack delete|registry entry|registers backend/.test(String(f.Properties.Description ?? '')));
    expect(quiet).toHaveLength(3);
    for (const fn of fns) {
      if (quiet.includes(fn)) {
        expect(fn.Properties.LoggingConfig.SystemLogLevel).toBe('WARN');
      } else {
        expect(fn.Properties.TracingConfig).toEqual({ Mode: 'Active' });
      }
    }
  });

  it('exposes the read-only properties (spec §6.4), and the ingress and backend it wraps (ADR-0024)', () => {
    expect(construct.endpointUrl).toBeDefined();
    expect(construct.runtimeArn).toBeDefined();
    expect(construct.ingressRole).toBeDefined();
    expect(construct.executionRole).toBeDefined();
    expect(construct.tvmCallerRole).toBeDefined();
    expect(construct.tenantRole).toBeDefined();
    expect(construct.options.ingress).toBe(ingress);
    expect(construct.ingress).toBeInstanceOf(SharedIngress);
    expect(construct.backend).toBeInstanceOf(AgentBackend);
    expect(construct.ingressRole).toBe(construct.ingress.ingressRole);
    expect(construct.tenantRole).toBe(construct.ingress.tenantRole);
    expect(construct.runtimeArn).toBe(construct.backend.runtimeArn);
    expect(construct.options).toBe(construct.ingress.options);
    expect(construct.options.defaultBackend).toBe(GATEWAY_TARGET_NAME);
    expect(construct.backend.endpointUrl).toBe(construct.ingress.urlFor(GATEWAY_TARGET_NAME));
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

  it('the routes are POST /{backend}/invocations and, for the default backend, POST /invocations, both behind the custom Lambda authoriser with request validation (ADR-0024)', () => {
    template.resourceCountIs('AWS::ApiGateway::Method', 2);
    template.resourceCountIs('AWS::ApiGateway::RequestValidator', 1);
    const resources = Object.values(template.findResources('AWS::ApiGateway::Resource')) as any[];
    expect(resources.map((r) => r.Properties.PathPart).sort()).toEqual(['{backend}', ROUTE, ROUTE].sort());
    const backendResource = resources.find((r) => r.Properties.PathPart === '{backend}');
    expect(backendResource.Properties.ParentId['Fn::GetAtt'][1]).toBe('RootResourceId');
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method')) as any[];
    for (const method of methods) {
      expect(method.Properties).toMatchObject({ HttpMethod: 'POST', AuthorizationType: 'CUSTOM' });
      expect(method.Properties.AuthorizerId).toBeDefined();
      expect(method.Properties.RequestValidatorId).toBeDefined();
      expect(method.Properties.RequestModels['application/json']).toEqual({ Ref: expect.stringContaining('InvokeModel') });
    }
    const parameterised = methods.find((m) => m.Properties.RequestParameters !== undefined);
    expect(parameterised.Properties.RequestParameters).toEqual({ 'method.request.path.backend': true });
    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', { ValidateRequestBody: true, ValidateRequestParameters: true });
  });

  it('the authoriser result is cached per Authorization header AND request path, so a result for one backend is never reused for another (ADR-0024)', () => {
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'REQUEST',
      IdentitySource: 'method.request.header.Authorization,context.path',
      AuthorizerResultTtlInSeconds: 300,
    });
  });

  it('a SharedIngress without defaultBackend has only the /{backend}/invocations route', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
    new SharedIngress(stack, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress: 'api-gateway' });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::ApiGateway::Method', 1);
    expect((Object.values(t.findResources('AWS::ApiGateway::Resource')) as any[]).map((r) => r.Properties.PathPart).sort()).toEqual(['{backend}', ROUTE].sort());
    expect(lambdaEnv(t, 'chooses the unit')).not.toHaveProperty(ENV.DEFAULT_BACKEND);
    t.resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
    t.resourceCountIs('Custom::RuntimeIsolationRegistryEntry', 0);
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

  it('endpointUrl is the stage URL plus the bare route; urlFor adds the backend; ingressRole and tvmCallerRole are the integration Lambda role', () => {
    const url = JSON.stringify(Stack.of(construct.ingress).resolve(construct.endpointUrl));
    expect(url).toContain(`/${ROUTE}"`);
    expect(url).not.toContain(`/${GATEWAY_TARGET_NAME}/${ROUTE}`);
    expect(url).toContain(`Stage${STAGE_NAME}`);
    const base = JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingress.endpointUrl));
    expect(base).not.toContain(ROUTE);
    expect(base).toContain('.execute-api.');
    expect(JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingress.urlFor('billing')))).toContain(`/billing/${ROUTE}"`);
    expect(() => construct.ingress.urlFor('Billing')).toThrow(/backend/);
    expect(construct.ingressRole).toBe(construct.tvmCallerRole);
    expect(JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingressRole.roleArn))).toContain('IngressFunctionServiceRole');
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

  it('the Runtime target is created by AgentBackend, named after the backend, through the raw override with the exact CloudFormation keys (ADR-0010, ADR-0024, spike V-2)', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1);
    const [id, target] = Object.entries(template.findResources('AWS::BedrockAgentCore::GatewayTarget'))[0] as [string, any];
    expect(id).toContain('Backend');
    expect(target.Properties.Name).toBe(GATEWAY_TARGET_NAME);
    expect(target.Properties.GatewayIdentifier).toEqual({ 'Fn::GetAtt': [Object.keys(template.findResources('AWS::BedrockAgentCore::Gateway'))[0], 'GatewayIdentifier'] });
    expect(construct.ingress.gatewayIdentifier).toBeDefined();
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
    expect(JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingressRole.roleArn))).toContain('GatewayRole');
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
    expect(JSON.stringify(Stack.of(construct.ingress).resolve(construct.tvmCallerRole.roleArn))).toContain('InterceptorFunctionServiceRole');
  });

  it('endpointUrl is the Gateway URL plus /<target>/invocations; the ingress base URL is the Gateway URL', () => {
    const url = Stack.of(construct.ingress).resolve(construct.endpointUrl);
    expect(JSON.stringify(url)).toContain(`/${GATEWAY_TARGET_NAME}/${ROUTE}`);
    expect(JSON.stringify(url)).toContain('GatewayUrl');
    expect(construct.endpointUrl).toBe(construct.ingress.urlFor(GATEWAY_TARGET_NAME));
    expect(JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingress.endpointUrl))).not.toContain(ROUTE);
  });

  it('publishes the Gateway identifier so a backend stack can add its target (ADR-0024)', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `${DEFAULT_REGISTRY_PREFIX}${PUBLISHED.gatewayIdentifier}`,
      Value: { 'Fn::GetAtt': [Object.keys(template.findResources('AWS::BedrockAgentCore::Gateway'))[0], 'GatewayIdentifier'] },
    });
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
    const callerId = Stack.of(construct.ingress).resolve(construct.tvmCallerRole.roleArn)['Fn::GetAtt'][0] as string;
    const grant = statementsForRole(template, callerId).find((s) => s.Sid === 'AssumeTenantRole');
    expect(grant.Action).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(grant.Resource).toEqual(Stack.of(construct.ingress).resolve(tenantRole.roleArn));
    // Only one role holds the grant.
    const all = JSON.stringify(template.toJSON());
    expect(all.split('AssumeTenantRole').length - 1).toBe(1);
    // The execution role still has nothing tenant-scoped, and no model.
    expect(JSON.stringify(statementsForRole(template, 'BackendRuntimeExecutionRole'))).not.toContain('sts:');
    expect(JSON.stringify(statementsForRole(template, 'BackendRuntimeExecutionRole'))).not.toContain('bedrock:Invoke');
    // The construct adds the one-model statement to the DEPLOYER's role (ADR-0018), and creates no default role.
    const deployerId = Stack.of(construct.ingress).resolve(tenantRole.roleArn)['Fn::GetAtt'][0] as string;
    const model = statementsForRole(template, deployerId).find((s) => s.Sid === 'OneModel');
    expect(model.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(construct.tenantRole).toBe(tenantRole);
    expect(JSON.stringify(template.toJSON())).not.toContain('TenantModelRole');
    const env = lambdaEnv(template, fnDescription);
    expect(env[ENV.TVM_ROLE_ARN]).toEqual(Stack.of(construct.ingress).resolve(tenantRole.roleArn));
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
  const oneModel = (t: Template) => statementsForRole(t, 'TenantModelRole').find((s) => s.Sid === 'OneModel');
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
    const exec = statementsForRole(template, 'BackendRuntimeExecutionRole');
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
    expect(env[ENV.LIMITS_TABLE]).toEqual(Stack.of(construct.ingress).resolve(construct.limitsTable!.tableName));
    expect(env[ENV.LIMIT_REQUESTS_PER_MINUTE]).toBe('60');
    expect(env).not.toHaveProperty(ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE);
    expect(env[ENV.PER_TENANT_METRICS]).toBe('false');
    expect(env[ENV.TVM_CACHE_MAX_ENTRIES]).toBe('1000');
  });

  it('tvmCallerRole has dynamodb:UpdateItem on exactly that table, and no other DynamoDB action', () => {
    const callerId = Stack.of(construct.ingress).resolve(construct.tvmCallerRole.roleArn)['Fn::GetAtt'][0] as string;
    const statements = statementsForRole(template, callerId);
    const count = statements.filter((s) => JSON.stringify(s.Action).includes('dynamodb:'));
    expect(count).toHaveLength(1);
    expect(count[0].Sid).toBe('CountTenantUsage');
    expect(count[0].Action).toBe('dynamodb:UpdateItem');
    expect(count[0].Resource).toEqual(Stack.of(construct.ingress).resolve(construct.limitsTable!.tableArn));
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

// ---------------------------------------------------------------------------
// Several backends behind one ingress (ADR-0024)
// ---------------------------------------------------------------------------
describe.each(INGRESSES)('SharedIngress with several AgentBackends, ingress=%s (ADR-0024)', (ingress) => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
  const shared = new SharedIngress(stack, 'Ingress', {
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'] },
    ingress,
    requiredScopes: ['platform/active'],
    registryPrefix: '/acme/agents/',
    registryTtl: Duration.seconds(30),
  });
  const support = new AgentBackend(stack, 'Support', { name: 'support', ingress: shared, agent: agentOf('eu.amazon.nova-lite-v1:0'), scopes: ['support/chat'], identityApi: IDENTITY_API });
  const billing = new AgentBackend(stack, 'Billing', {
    name: 'billing',
    ingress: shared,
    agent: agentOf('eu.amazon.nova-lite-v1:0'),
    scopes: ['billing/read', 'billing/invoke'],
    identityApi: IDENTITY_API,
  });
  const template = Template.fromStack(stack);

  it('creates two Runtimes, each tagged for the ingress, with a resource policy naming the one ingress role, and (Gateway) a target per backend', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2);
    template.resourceCountIs('AWS::BedrockAgentCore::ResourcePolicy', 2);
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', ingress === 'agentcore-gateway' ? 2 : 0);
    for (const runtime of Object.values(template.findResources('AWS::BedrockAgentCore::Runtime')) as any[]) {
      expect(runtime.Properties.Tags).toEqual({ [INGRESS_TAG_KEY]: shared.ingressId });
    }
    const ingressRef = JSON.stringify(stack.resolve(shared.ingressRole.roleArn));
    for (const policy of Object.values(template.findResources('AWS::BedrockAgentCore::ResourcePolicy')) as any[]) {
      expect(JSON.stringify(policy.Properties.Policy)).toContain(ingressRef.slice(1, -1));
    }
    if (ingress === 'agentcore-gateway') {
      const names = (Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget')) as any[]).map((t) => t.Properties.Name).sort();
      expect(names).toEqual(['billing', 'support']);
    }
  });

  it('writes one registry entry per backend under the custom prefix, with the backend\'s scopes and a drain of TTL + 120 s', () => {
    const entries = Object.values(template.findResources('Custom::RuntimeIsolationRegistryEntry')) as any[];
    expect(entries.map((e) => e.Properties.ParameterName).sort()).toEqual(['/acme/agents/backends/billing', '/acme/agents/backends/support']);
    const billingEntry = entries.find((e) => e.Properties.ParameterName.endsWith('/billing'));
    expect(billingEntry.Properties.Scopes).toEqual(['billing/read', 'billing/invoke']);
    expect(billingEntry.Properties.DrainSeconds).toBe(150);
    expect(billing.scopes).toEqual(['billing/read', 'billing/invoke']);
    expect(support.registryParameterName).toBe(registryParameterName('/acme/agents/', 'support'));
    expect(billing.endpointUrl).toBe(shared.urlFor('billing'));
    expect(lambdaEnv(template, ingress === 'api-gateway' ? 'chooses the unit' : 'interceptor')).toMatchObject({
      [ENV.REGISTRY_PREFIX]: '/acme/agents/',
      [ENV.REGISTRY_TTL_SECONDS]: '30',
      [ENV.REQUIRED_SCOPES]: 'platform/active',
    });
    // The read grant follows the prefix.
    expect(JSON.stringify(template.toJSON())).toContain(':parameter/acme/agents/backends/*"');
  });

  it('registers each backend\'s scopes with the identity API through a custom resource the entry depends on (ADR-0025)', () => {
    const registrations = Object.values(template.findResources('Custom::RuntimeIsolationScopeRegistration')) as any[];
    expect(registrations.map((r) => r.Properties.Backend).sort()).toEqual(['billing', 'support']);
    const billingReg = registrations.find((r) => r.Properties.Backend === 'billing');
    expect(billingReg.Properties).toMatchObject({ ApiUrl: IDENTITY_API.apiUrl, Scopes: ['billing/read', 'billing/invoke'] });
    // The entry waits for the registration, so the route never names a scope the issuer does not know.
    const resources = template.toJSON().Resources as Record<string, any>;
    const [regId] = Object.entries(resources).find(([, r]) => r.Type === 'Custom::RuntimeIsolationScopeRegistration' && r.Properties.Backend === 'billing')!;
    const [, billingEntry] = Object.entries(resources).find(([, r]) => r.Type === 'Custom::RuntimeIsolationRegistryEntry' && String(r.Properties.ParameterName).endsWith('/billing'))!;
    expect(billingEntry.DependsOn).toContain(regId);
    // The registration function's role carries the published PlatformInvokePolicy and nothing of the registry.
    const fn = (Object.values(template.findResources('AWS::Lambda::Function')) as any[]).find((f) => String(f.Properties.Description).includes("registers backend billing's scopes"));
    expect(fn).toBeDefined();
    const roleId = fn.Properties.Role['Fn::GetAtt'][0];
    expect(JSON.stringify(resources[roleId].Properties.ManagedPolicyArns)).toContain(IDENTITY_API.platformInvokePolicyArn);
    const roleStatements = statementsForRole(template, roleId);
    expect(roleStatements.some((s) => JSON.stringify(s).includes('ssm:'))).toBe(false);
    // The role grants no execute-api route of its own: the only Allow into /platform/* is the managed policy...
    expect(roleStatements.some((s) => s.Effect === 'Allow' && JSON.stringify(s.Action).includes('execute-api'))).toBe(false);
    expect(JSON.stringify(roleStatements).includes('/platform/tenants')).toBe(true);
    // ...and an explicit Deny takes the tenant routes back out of it (T-41), leaving `/platform/scopes*` alone.
    const deny = roleStatements.find((s) => s.Sid === 'DenyPlatformTenantRoutes');
    expect(deny).toMatchObject({ Effect: 'Deny', Action: 'execute-api:Invoke' });
    const denied = JSON.stringify(deny.Resource);
    expect(denied).toContain(':execute-api:');
    expect(denied).toContain(':*/*/*/platform/tenants*');
    expect(roleStatements.filter((s) => s.Effect === 'Allow' && JSON.stringify(s).includes('/platform/tenants'))).toHaveLength(0);
    expect(resources[roleId].Properties.ManagedPolicyArns).toHaveLength(2); // AWSLambdaBasicExecutionRole and PlatformInvokePolicy, nothing else
    expect(billing.scopeRegistration.scopes).toEqual(['billing/read', 'billing/invoke']);
    // Its log group is behind the ingress drain too.
    const [drain] = Object.keys(template.findResources('AWS::CloudFormation::CustomResource'));
    const scopeLogGroups = Object.keys(template.findResources('AWS::Logs::LogGroup')).filter((id) => id.includes('ScopesLogs'));
    expect(scopeLogGroups).toHaveLength(2);
    for (const group of scopeLogGroups) {
      expect(resources[drain].DependsOn).toContain(group);
    }
    expect(billingReg.DependsOn).toContain(drain);
  });

  it('refuses a scope list that is empty, repeats a name, is ill-formed or is owned by another name, naming the prop (ADR-0025)', () => {
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other');
    const sharedOther = new SharedIngress(other, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress: 'api-gateway' });
    const make = (id: string, scopes: string[]) => () => new AgentBackend(other, id, { name: 'ok', ingress: sharedOther, agent: agentOf(), scopes, identityApi: IDENTITY_API });
    expect(make('Empty', [])).toThrow(/AgentBackend: scopes must name at least one scope/);
    expect(make('Dup', ['ok/read', 'ok/read'])).toThrow(/AgentBackend: scopes must not repeat a scope/);
    expect(make('Space', ['ok/re ad'])).toThrow(/AgentBackend: scopes 'ok\/re ad' must match/);
    expect(make('Upper', ['ok/Read'])).toThrow(/AgentBackend: scopes 'ok\/Read' must match/);
    expect(make('NoSlash', ['okread'])).toThrow(/AgentBackend: scopes 'okread' must match/);
    expect(make('TwoSlashes', ['ok/read/all'])).toThrow(/AgentBackend: scopes 'ok\/read\/all' must match/);
    expect(make('Foreign', ['ok/read', 'billing/read'])).toThrow(/AgentBackend: scopes 'billing\/read' must be owned by this backend: ok\/<action>/);
    expect(make('Reserved', ['tenant-admin/users'])).toThrow(/must be owned by this backend/);
    expect(make('Long', [`ok/${'a'.repeat(126)}`])).toThrow(/AgentBackend: scopes 'ok\/a+' must match/);
    expect(() => new AgentBackend(other, 'Missing', { name: 'ok', ingress: sharedOther, agent: agentOf(), identityApi: IDENTITY_API } as any)).toThrow(/AgentBackend: scopes must name at least one scope/);
    // ScopeRegistration on its own applies the same rule.
    expect(() => new ScopeRegistration(other, 'Reg', { backend: 'ok', scopes: ['other/x'], identityApi: IDENTITY_API })).toThrow(/ScopeRegistration: scopes 'other\/x' must be owned/);
    // The longest accepted name: 128 characters.
    new AgentBackend(other, 'Max', { name: 'ok', ingress: sharedOther, agent: agentOf(), scopes: [`ok/${'a'.repeat(125)}`], identityApi: IDENTITY_API });
  });

  it('without identityApi the registration reads apiUrl and platformInvokePolicyArn from the published parameters at deploy time (ADR-0025)', () => {
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other', { env: { account: '111122223333', region: 'eu-central-1' } });
    const sharedOther = new SharedIngress(other, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress: 'api-gateway' });
    new AgentBackend(other, 'One', { name: 'one', ingress: sharedOther, agent: agentOf(), scopes: ['one/chat'] });
    new AgentBackend(other, 'Two', { name: 'two', ingress: sharedOther, agent: agentOf(), scopes: ['two/chat'] });
    const t = Template.fromStack(other);
    const params = Object.values(t.toJSON().Parameters as Record<string, any>).filter(
      (p) => p.Type === 'AWS::SSM::Parameter::Value<String>' && String(p.Default).startsWith('/application-plane/'),
    );
    // One template parameter per name per stack, shared by both backends.
    expect(params.map((p) => p.Default).sort()).toEqual([IDENTITY_API_PARAMETERS.apiUrl, IDENTITY_API_PARAMETERS.platformInvokePolicyArn].sort());
    const regs = Object.values(t.findResources('Custom::RuntimeIsolationScopeRegistration')) as any[];
    expect(regs).toHaveLength(2);
    for (const reg of regs) {
      expect(reg.Properties.ApiUrl).toEqual({ Ref: expect.stringMatching(/^SsmParameterValue/) });
    }
  });

  it('grantModel is idempotent per model id: two backends on one model add one statement to the tenant role; a second model adds a second', () => {
    const statements = statementsForRole(template, 'TenantModelRole').filter((s) => String(s.Sid).startsWith('OneModel'));
    expect(statements).toHaveLength(1);
    expect(statements[0].Sid).toBe('OneModel');
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other', { env: { account: '111122223333', region: 'eu-central-1' } });
    const two = new SharedIngress(other, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress });
    two.grantModel('amazon.nova-lite-v1:0');
    two.grantModel('amazon.nova-micro-v1:0');
    two.grantModel('amazon.nova-micro-v1:0');
    const after = statementsForRole(Template.fromStack(other), 'TenantModelRole').filter((s) => String(s.Sid).startsWith('OneModel'));
    expect(after.map((s) => s.Sid).sort()).toEqual(['OneModel', 'OneModel2']);
    expect(JSON.stringify(after.find((s) => s.Sid === 'OneModel2').Resource)).toContain('amazon.nova-micro-v1:0');
  });

  it('refuses a bad backend name, a duplicate scope shape and a Gateway ref without an identifier, naming the prop', () => {
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other');
    const sharedOther = new SharedIngress(other, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress: 'api-gateway' });
    expect(() => new AgentBackend(other, 'Bad', { name: 'Billing', ingress: sharedOther, agent: agentOf(), scopes: ['billing/read'], identityApi: IDENTITY_API })).toThrow(/AgentBackend: name/);
    const ref: SharedIngressRef = { registryPrefix: '/p/', ingressRoleArn: 'arn:aws:iam::111122223333:role/x', ingressId: 'x', ingress: 'agentcore-gateway', tenantRoleArn: 'arn:aws:iam::111122223333:role/t' };
    expect(() => new AgentBackend(other, 'Bad3', { name: 'ok', ingress: ref, agent: agentOf(), scopes: ['ok/chat'], identityApi: IDENTITY_API })).toThrow(/gatewayIdentifier/);
  });

  it('refuses a SharedIngress instance from another stack: it must be imported with fromParameters (ADR-0024)', () => {
    const otherApp = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const backendStack = new Stack(otherApp, 'BackendStack', { env: { account: '111122223333', region: 'eu-central-1' } });
    expect(() => new AgentBackend(backendStack, 'Foreign', { name: 'foreign', ingress: shared, agent: agentOf(), scopes: ['foreign/chat'], identityApi: IDENTITY_API })).toThrow(
      /AgentBackend: ingress a SharedIngress from another stack must be imported with SharedIngress\.fromParameters/,
    );
    // Nothing of the backend reached the ingress's stack either.
    expect(JSON.stringify(template.toJSON())).not.toContain('Foreign');
  });

  it('a RegistryEntryResource drain above 870 s (TTL 750 s + 120 s) is refused at synth, so the handler timeout stays under Lambda\'s 15 minutes', () => {
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other', { env: { account: '111122223333', region: 'eu-central-1' } });
    const base = { registryPrefix: '/p/', backend: 'b', runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/x', scopes: ['b/x'] };
    expect(() => new RegistryEntryResource(other, 'TooLong', { ...base, drain: Duration.seconds(871) })).toThrow(/RegistryEntryResource: drain must be from 1 to 870 seconds \(got 871\)/);
    expect(() => new RegistryEntryResource(other, 'Zero', { ...base, drain: Duration.seconds(0) })).toThrow(/RegistryEntryResource: drain/);
    new RegistryEntryResource(other, 'Max', { ...base, drain: Duration.seconds(870) });
    const fns = Object.values(Template.fromStack(other).findResources('AWS::Lambda::Function')) as any[];
    expect(fns.find((f) => String(f.Properties.Description).includes('registry entry')).Properties.Timeout).toBe(900);
  });

  it('every registry entry sits behind the ingress log drain: entry -> drain -> its log group (ADR-0019)', () => {
    // (The scope registrations are checked the same way in the ADR-0025 test above.)
    const resources = template.toJSON().Resources as Record<string, any>;
    const [drain] = Object.keys(template.findResources('AWS::CloudFormation::CustomResource'));
    const drainDeps: string[] = resources[drain].DependsOn ?? [];
    const entryLogGroups = Object.keys(template.findResources('AWS::Logs::LogGroup')).filter((id) => id.includes('RegistryEntryLogs'));
    expect(entryLogGroups).toHaveLength(2);
    for (const group of entryLogGroups) {
      expect(drainDeps).toContain(group);
    }
    for (const [id, entry] of Object.entries(template.findResources('Custom::RuntimeIsolationRegistryEntry'))) {
      expect((entry as any).DependsOn ?? []).toContain(drain);
      expect(resources[id]).toBeDefined();
    }
    // Only the ingress's drain exists: no backend adds a second one in the ingress's stack.
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });

  it('passes cdk-nag with every new finding acknowledged', () => {
    expect(() => template.toJSON()).not.toThrow();
  });
});

describe.each(INGRESSES)('AgentBackend in its own stack from SharedIngress.fromParameters, ingress=%s (ADR-0024)', (ingress) => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  const stack = new Stack(app, 'BackendStack', { env: { account: '111122223333', region: 'eu-central-1' } });
  const ref = SharedIngress.fromParameters(stack, 'Ingress', DEFAULT_REGISTRY_PREFIX, ingress, { forwardUserToken: true });
  const backend = new AgentBackend(stack, 'Billing', {
    name: 'billing',
    ingress: ref,
    agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' },
    scopes: ['billing/read', 'billing/invoke'],
  });
  // What a backend stack does with the URL (and what keeps the endpointUrl parameter referenced).
  new CfnOutput(stack, 'BillingEndpointUrl', { value: backend.endpointUrl! });
  const template = Template.fromStack(stack);

  it('reads the published parameters: baseUrl, ingressRoleArn, ingressId, tenantRoleArn and, on the Gateway, gatewayIdentifier; plus the identity API for the scopes (ADR-0025)', () => {
    const all = Object.values(template.toJSON().Parameters as Record<string, any>).filter((p) => p.Type === 'AWS::SSM::Parameter::Value<String>');
    const params = all.filter((p) => String(p.Default).startsWith(DEFAULT_REGISTRY_PREFIX));
    const expected: string[] = [PUBLISHED.baseUrl, PUBLISHED.ingressRoleArn, PUBLISHED.ingressId, PUBLISHED.tenantRoleArn];
    const expectedNames = expected
      .concat(ingress === 'agentcore-gateway' ? [PUBLISHED.gatewayIdentifier] : [])
      .map((n) => `${DEFAULT_REGISTRY_PREFIX}${n}`)
      .sort();
    expect(params.map((p) => p.Default).sort()).toEqual(expectedNames);
    const identityApi = [IDENTITY_API_PARAMETERS.apiUrl, IDENTITY_API_PARAMETERS.platformInvokePolicyArn];
    expect(all.map((p) => p.Default)).toEqual(expect.arrayContaining(identityApi));
    expect(ref.ingress).toBe(ingress);
  });

  it('creates the Runtime tagged with the read ingressId, the resource policy on the read role ARN, the target on the read Gateway, and the entry under the prefix', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::ResourcePolicy', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', ingress === 'agentcore-gateway' ? 1 : 0);
    const runtime = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'))[0] as any;
    expect(runtime.Properties.Tags).toEqual({ [INGRESS_TAG_KEY]: stack.resolve(ref.ingressId) });
    // forwardUserToken from the ref decides the header allowlist.
    expect(runtime.Properties.RequestHeaderConfiguration.RequestHeaderAllowlist).toEqual([
      RUNTIME_HEADERS.USER_TOKEN,
      RUNTIME_HEADERS.TENANT_CREDENTIALS,
    ]);
    expect(JSON.stringify(resourcePolicy(template))).toContain(JSON.stringify(JSON.stringify(stack.resolve(ref.ingressRoleArn))).slice(1, -1));
    template.hasResourceProperties('Custom::RuntimeIsolationRegistryEntry', {
      ParameterName: `${DEFAULT_REGISTRY_PREFIX}backends/billing`,
      Scopes: ['billing/read', 'billing/invoke'],
      DrainSeconds: 180,
    });
    template.hasResourceProperties('Custom::RuntimeIsolationScopeRegistration', { Backend: 'billing', Scopes: ['billing/read', 'billing/invoke'] });
    expect(backend.registryParameterName).toBe(`${DEFAULT_REGISTRY_PREFIX}backends/billing`);
    expect(JSON.stringify(stack.resolve(backend.endpointUrl))).toContain(`/billing/${ROUTE}`);
  });

  it('owns a log drain of its own, since the ingress\'s is in another stack: entry -> drain -> the handler log group (ADR-0019)', () => {
    const resources = template.toJSON().Resources as Record<string, any>;
    const drains = Object.keys(template.findResources('AWS::CloudFormation::CustomResource'));
    expect(drains).toHaveLength(1);
    const [drain] = drains;
    expect(drain).toContain('BillingLogDrain');
    const [entryLogGroup] = Object.keys(template.findResources('AWS::Logs::LogGroup')).filter((id) => id.includes('RegistryEntryLogs'));
    expect(resources[drain].DependsOn).toContain(entryLogGroup);
    const [scopesLogGroup] = Object.keys(template.findResources('AWS::Logs::LogGroup')).filter((id) => id.includes('ScopesLogs'));
    expect(resources[drain].DependsOn).toContain(scopesLogGroup);
    const [entry] = Object.values(template.findResources('Custom::RuntimeIsolationRegistryEntry')) as any[];
    expect(entry.DependsOn).toContain(drain);
    const [registration] = Object.values(template.findResources('Custom::RuntimeIsolationScopeRegistration')) as any[];
    expect(registration.DependsOn).toContain(drain);
    for (const group of Object.values(template.findResources('AWS::Logs::LogGroup')) as any[]) {
      expect(group.DeletionPolicy).toBe('Delete');
    }
  });

  it('adds the one-model statement to the imported tenant role through a policy of this stack (ADR-0018)', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
    const model = policies.find((p) => JSON.stringify(p.Properties.PolicyDocument).includes('"OneModel"'));
    expect(model).toBeDefined();
    const statement = model.Properties.PolicyDocument.Statement.find((s: any) => s.Sid === 'OneModel');
    expect(statement.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(JSON.stringify(statement.Resource)).toContain('foundation-model/amazon.nova-lite-v1:0');
    // Attached by the role NAME parsed from the ARN parameter, not to a role of this stack.
    expect(JSON.stringify(model.Properties.Roles)).toContain('Fn::Select');
    expect(JSON.stringify(template.toJSON())).not.toContain('TenantModelRole');
  });

  it('passes cdk-nag', () => {
    expect(() => template.toJSON()).not.toThrow();
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, CfnOutput, Duration, Stack, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';
import { publishedIngress, seedPublishedIngress, TEST_ENV } from './published-ingress';
import { baseModelId, isInferenceProfileId } from '../src/backend/agentcore-runtime.cdk';
import { encodeCredentials, RUNTIME_HEADERS } from '../src/backend/agentcore-runtime.transport';
import {
  AgentBackend,
  OWNER_MAX_LENGTH,
  ownerProblem,
  type AgentProps,
  DEFAULT_REGISTRY_PREFIX,
  GATEWAY_TARGET_NAME,
  INGRESS_TAG_KEY,
  MAX_REGISTRY_TTL,
  PUBLISHED,
  RegistryEntryResource,
  registryParameterName,
  resolveOptions,
  ROUTE,
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
/** The default backend's one need (ADR-0032). */
const DEFAULT_NEEDS = [`${GATEWAY_TARGET_NAME}/chat`];
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
  const backend = new AgentBackend(stack, 'Backend', { name: bn, ingress, agent, needs: [`${bn}/chat`] });
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
      multiTenant: false,
      sessionScope: undefined,
      requiredScopes: undefined,
      tvm: { role: undefined, includeUserIdTag: false, claimTags: {}, durationSeconds: 900, cacheMaxEntries: 1000 },
      tenantLimits: { requestsPerMinute: 60, outputTokensPerMinute: undefined },
      stageThrottle: { rateLimit: 50, burstLimit: 25, explicit: false },
      ingressReservedConcurrency: undefined,
      toolContextAlgorithm: 'RS256',
      perTenantMetrics: false,
      registryPrefix: DEFAULT_REGISTRY_PREFIX,
      publish: true,
      registryTtlSeconds: 60,
      defaultBackend: undefined,
      // always-on transaction token and entitlements, tools gateway on by default.
      transactionToken: { ttlSeconds: 300, algorithm: 'RS256', keyGeneration: 1, cacheMaxEntries: 1000, reuseMarginSeconds: 180 },
      authorizerCacheTtlSeconds: 60,
      entitlements: { adminScope: 'entitlements/admin', maxAgentsPerTenant: 1000, maxToolsPerTenant: 1000 },
      toolsGateways: {
        default: {
          requestsPerSecond: 10,
          overrides: {},
          interceptorProvisionedConcurrency: 1,
          contextLifetimeSeconds: 60,
          maxToolsPerGateway: 300,
          responseFilter: false,
        },
      },
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

  it("session defaults to scope 'tenant' when set (ADR-0039)", () => {
    expect(resolveOptions({ ...valid, session: {} }).sessionScope).toBe('tenant');
    expect(resolveOptions({ ...valid, session: { scope: 'user' } }).sessionScope).toBe('user');
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
    ['delegation', { delegation: { forwardUserToken: true } as never }, /SharedIngress: delegation is not a prop; the agent receives a transaction token \(ADR-0031\)/],
    ['transactionToken.ttl low', { transactionToken: { ttl: Duration.seconds(59) } }, /transactionToken\.ttl/],
    ['transactionToken.ttl high', { transactionToken: { ttl: Duration.seconds(901) } }, /transactionToken\.ttl/],
    ['transactionToken.algorithm', { transactionToken: { algorithm: 'HS256' as any } }, /transactionToken\.algorithm/],
    ['transactionToken.keyGeneration', { transactionToken: { keyGeneration: 0 } }, /transactionToken\.keyGeneration/],
    ['transactionToken.cacheMaxEntries', { transactionToken: { cacheMaxEntries: 0 } }, /transactionToken\.cacheMaxEntries/],
    ['entitlements.adminScope', { entitlements: { adminScope: 'a b' } }, /entitlements\.adminScope/],
    ['entitlements.maxAgentsPerTenant', { entitlements: { maxAgentsPerTenant: 1001 } }, /entitlements\.maxAgentsPerTenant/],
    ['entitlements.maxToolsPerTenant', { entitlements: { maxToolsPerTenant: 0 } }, /entitlements\.maxToolsPerTenant/],
    ['identity.multiTenant', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'], multiTenant: 'yes' as any } }, /identity\.multiTenant/],
    ['toolsGateway.tenantRateLimit', { toolsGateway: { tenantRateLimit: { requestsPerSecond: 0 } } }, /toolsGateway\.tenantRateLimit\.requestsPerSecond/],
    ['toolsGateway.tenantRateLimitOverrides key', { toolsGateway: { tenantRateLimitOverrides: { 'bad tenant': 5 } } }, /toolsGateway\.tenantRateLimitOverrides/],
    ['toolsGateway.tenantRateLimitOverrides rate', { toolsGateway: { tenantRateLimitOverrides: { 'tenant-a': 0 } } }, /toolsGateway\.tenantRateLimitOverrides/],
    ['toolsGateway.interceptorProvisionedConcurrency', { toolsGateway: { interceptorProvisionedConcurrency: -1 } }, /toolsGateway\.interceptorProvisionedConcurrency/],
    ['toolsGateway.contextLifetime', { toolsGateway: { contextLifetime: Duration.seconds(301) } }, /toolsGateway\.contextLifetime/],
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

  it('the Runtime always admits the transaction-token and credential headers and nothing else (C-1, ADR-0031)', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      RequestHeaderConfiguration: { RequestHeaderAllowlist: [RUNTIME_HEADERS.TRANSACTION_TOKEN, RUNTIME_HEADERS.TENANT_CREDENTIALS] },
    });
    expect(JSON.stringify(template.toJSON())).not.toContain('Custom-User-Token');
  });

  it('a custom resource settles the service-created Runtime log group: retention and a data protection policy that masks a JWT, the credential header and the decoded credential fields (T-18, M-12, ADR-0047)', () => {
    // Not an AWS::Logs::LogGroup: the service creates the group at CreateAgentRuntime (AlreadyExists otherwise).
    for (const group of Object.values(template.findResources('AWS::Logs::LogGroup')) as any[]) {
      expect(JSON.stringify(group.Properties.LogGroupName ?? '')).not.toContain('/aws/bedrock-agentcore/runtimes/');
    }
    const [resource] = Object.values(template.findResources('Custom::RuntimeIsolationRuntimeLogGroup')) as any[];
    expect(resource).toBeDefined();
    expect(resource.DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/^BackendRuntime[0-9A-F]+$/)]));
    const name = JSON.stringify(resource.Properties.LogGroupName);
    expect(name).toContain('/aws/bedrock-agentcore/runtimes/');
    expect(name).toContain('-DEFAULT');
    expect(name).toContain('AgentRuntimeId');
    expect(resource.Properties.RetentionInDays).toBe(30);
    // toJsonString: a Fn::Join whose only non-string part is the partition Ref.
    const parts = Stack.of(construct.ingress).resolve(resource.Properties.DataProtectionPolicy)['Fn::Join'][1] as unknown[];
    const policy = JSON.parse(parts.map((part) => (typeof part === 'string' ? part : 'aws')).join(''));
    expect(policy.Version).toBe('2021-06-01');
    expect(policy.Statement).toHaveLength(2);
    const identifiers = policy.Statement[0].DataIdentifier as string[];
    expect(identifiers).toEqual(policy.Statement[1].DataIdentifier);
    expect(JSON.stringify(identifiers)).toContain(':dataprotection::aws:data-identifier/AwsSecretKey');
    expect(identifiers).toContain('JsonWebToken');
    expect(identifiers).toContain('TenantCredentialsHeader');
    expect(identifiers).toContain('SecretAccessKeyField');
    expect(identifiers).toContain('SessionTokenField');
    expect(policy.Statement[0].Operation).toEqual({ Audit: { FindingsDestination: {} } });
    expect(policy.Statement[1].Operation).toEqual({ Deidentify: { MaskConfig: {} } });
    // Each custom pattern covers a whole value, as the ingress emits it, within the 200-character cap.
    const patterns = Object.fromEntries(policy.Configuration.CustomDataIdentifier.map((c: any) => [c.Name, new RegExp(c.Regex)]));
    const token = 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImsxIn0.eyJ0ZW5hbnRfaWQiOiJBIn0.MEUCIQDx_-abc'; // gitleaks:allow
    expect(token.replace(patterns.JsonWebToken, '*')).toBe('*');
    const header = encodeCredentials({ accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 's', sessionToken: 't', expiration: '2026-01-01T00:00:00Z' });
    expect(header.replace(patterns.TenantCredentialsHeader, '*')).toBe('*');
    // The decoded object in the three spellings a Node process produces; each secret value is inside one match, the access key id and expiration stay.
    const object = { accessKeyId: 'ASIAEXAMPLEEXAMPLE12', secretAccessKey: 'a'.repeat(40), sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLEtoken', expiration: '2026-01-01T00:00:00Z' };
    const spellings = [
      JSON.stringify(object),
      JSON.stringify({ level: 'INFO', message: JSON.stringify(object) }),
      "{ accessKeyId: 'ASIAEXAMPLEEXAMPLE12', secretAccessKey: '" + 'a'.repeat(40) + "', sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLEtoken' }",
    ];
    for (const line of spellings) {
      const masked = line.replace(patterns.SecretAccessKeyField, '*').replace(patterns.SessionTokenField, '*');
      expect(masked).not.toContain('a'.repeat(40));
      expect(masked).not.toContain('IQoJb3JpZ2luX2VjEXAMPLEtoken');
      expect(masked).toContain('ASIAEXAMPLEEXAMPLE12');
    }
    // No open-ended `{n,}`: CloudWatch Logs accepts it but never matches it (probed 2026-11-06). `+` is the
    // accepted form for a value of unknown length; a large explicit bound after a short literal is refused as
    // "too complex" (`eyJ[A-Za-z0-9_-]{1,200}`, probed the same day). Forbidden here: `{n,}`, and `*` after a
    // class or group (a value repeat); `\s*` around the colon stays and is proven matching by integ step `mask`.
    for (const c of policy.Configuration.CustomDataIdentifier) {
      expect(c.Regex).not.toMatch(/\{\d+,\}/);
      expect(c.Regex).not.toMatch(/[\])]\*/);
    }
    // Ordinary log content is left alone: a short base64 word, a session prefix, a timestamp, a tenant id.
    const plain = 'request served tenantId=01JC0000000000000000000000 prefix=a1b2c3d4 blob=Zm9vYmFyYmF6cXV4 at 2026-11-06T10:00:00Z';
    for (const pattern of Object.values(patterns) as RegExp[]) {
      expect(plain.replace(pattern, '*')).toBe(plain);
    }
    for (const c of policy.Configuration.CustomDataIdentifier) {
      expect(c.Regex.length).toBeLessThanOrEqual(200);
    }
    // The function may touch Runtime log groups (the prefix, so a replaced Runtime's old group can still be deleted) and nothing else in Logs.
    const fnRole = Object.keys(template.findResources('AWS::IAM::Role')).find((id) => id.includes('RuntimeLogGroupFunctionServiceRole'));
    expect(fnRole).toBeDefined();
    const own = statementsForRole(template, fnRole!).find((s) => s.Sid === 'RuntimeLogGroups');
    expect(own.Action).toEqual(['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:PutDataProtectionPolicy']);
    expect(JSON.stringify(own.Resource)).toContain(':log-group:/aws/bedrock-agentcore/runtimes/*"');
    expect(JSON.stringify(own.Resource)).not.toContain('log-stream');
    expect(JSON.stringify(statementsForRole(template, fnRole!))).not.toContain('logs:Unmask');
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
    expect(entry.Properties.Needs).toEqual(DEFAULT_NEEDS);
    expect(entry.Properties.Tools).toEqual([]);
    expect(entry.Properties.Scopes).toBeUndefined();
    expect(entry.Properties.DrainSeconds).toBe(180);
    // Written after the Runtime, its resource policy (and the target), and the NAME# reservation (ADR-0035).
    const deps: string[] = entry.DependsOn ?? [];
    expect(deps).toContain(runtimeLogicalId(template));
    expect(deps.some((d) => d.includes('ResourcePolicy'))).toBe(true);
    expect(deps.some((d) => d.includes('BackendNameReservation'))).toBe(true);
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

  it('publishes ONE JSON parameter, <prefix>ingress, with every published value (ADR-0024, ADR-0042)', () => {
    const params = Object.values(template.findResources('AWS::SSM::Parameter')) as any[];
    expect(params.map((p) => p.Properties.Name)).toEqual([`${DEFAULT_REGISTRY_PREFIX}${PUBLISHED.ingress}`]);
    const [param] = params;
    expect(param.Properties.Tier).toBe('Intelligent-Tiering');
    const join = param.Properties.Value['Fn::Join'];
    expect(join).toBeDefined();
    const literal = (join[1] as unknown[]).filter((x) => typeof x === 'string').join('');
    expect(literal).toContain('"version":2');
    expect(literal).toContain(`"ingress":"${ingress}"`);
    for (const key of ['endpointUrl', 'baseUrl', 'ingressRoleArn', 'ingressId', 'tenantRoleArn', 'issuer', 'jwksUrl', 'entitlementsTableName', 'entitlementsApiUrl', 'toolContextKeyId', 'toolsGateways']) {
      expect(literal).toContain(`"${key}":`);
    }
    expect(literal).toContain('"default":{"url":');
    for (const key of ['identifier', 'roleArn', 'policyEngineId']) {
      expect(literal).toContain(`"${key}":`);
    }
    expect(literal.includes('"gatewayIdentifier":')).toBe(ingress === 'agentcore-gateway');
    // The pre-ADR-0042 aliases are gone.
    expect(literal).not.toContain('toolsGatewayUrl');
    // endpointUrl keeps the spec §6.4 meaning (the default backend's invocation URL); baseUrl is the base.
    const resolved = JSON.stringify(param.Properties.Value);
    expect(resolved).toContain(JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingressRole.roleArn)));
    expect(literal).toContain(`"ingressId":"${construct.ingress.ingressId}"`);
  });

  it('publish: false writes no published parameter (ADR-0042)', () => {
    const { template: quiet } = synth({ ingress, publish: false });
    const names = (Object.values(quiet.findResources('AWS::SSM::Parameter')) as any[]).map((p) => JSON.stringify(p.Properties.Name));
    expect(names.filter((n) => !n.includes('backends/') && !n.includes('tools/'))).toEqual([]);
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
      [ENV.MULTI_TENANT]: 'false',
      // The TVM is always on (ADR-0018): the default role's ARN and its defaults.
      [ENV.TVM_INCLUDE_USER_ID_TAG]: 'false',
      [ENV.TVM_CLAIM_TAGS]: '{}',
      [ENV.TVM_DURATION_SECONDS]: '900',
    });
    expect(env[ENV.TVM_ROLE_ARN]).toBeDefined();
    for (const absent of [ENV.SESSION_SCOPE, ENV.REQUIRED_SCOPES, 'RI_FORWARD_USER_TOKEN', 'RI_ALLOWED_SCOPES']) {
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
    // The custom-resource handlers run on stack operations, not requests: no tracing, and quiet logs (ADR-0019).
    const quiet = fns.filter((f) => f.Properties.LoggingConfig.SystemLogLevel === 'WARN');
    const descriptions = quiet.map((f) => String(f.Properties.Description));
    for (const job of ['Waits on stack delete', 'registry entry', 'owner-marked', 'JWKS', 'Cedar policy']) {
      expect(descriptions.some((d) => d.includes(job))).toBe(true);
    }
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
    template.resourceCountIs('AWS::ApiGateway::RequestValidator', 1);
    const resources = Object.values(template.findResources('AWS::ApiGateway::Resource')) as any[];
    expect(resources.filter((r) => [ROUTE, '{backend}'].includes(r.Properties.PathPart)).map((r) => r.Properties.PathPart).sort()).toEqual(['{backend}', ROUTE, ROUTE].sort());
    const backendResource = resources.find((r) => r.Properties.PathPart === '{backend}');
    expect(backendResource.Properties.ParentId['Fn::GetAtt'][1]).toBe('RootResourceId');
    const methods = (Object.values(template.findResources('AWS::ApiGateway::Method')) as any[]).filter((m) => m.Properties.HttpMethod === 'POST');
    expect(methods).toHaveLength(2);
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
      // at most 60 s, so a cached Allow's token still outlives a stream (AUTHORIZER_CACHE_TTL).
      AuthorizerResultTtlInSeconds: 60,
    });
  });

  it('a SharedIngress without defaultBackend has only the /{backend}/invocations route', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
    new SharedIngress(stack, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress: 'api-gateway' });
    const t = Template.fromStack(stack);
    expect((Object.values(t.findResources('AWS::ApiGateway::Method')) as any[]).filter((m) => m.Properties.HttpMethod === 'POST')).toHaveLength(1);
    expect(
      (Object.values(t.findResources('AWS::ApiGateway::Resource')) as any[])
        .map((r) => r.Properties.PathPart)
        .filter((p) => [ROUTE, '{backend}'].includes(p))
        .sort(),
    ).toEqual(['{backend}', ROUTE].sort());
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
    expect(url).toContain(`/${STAGE_NAME}/`);
    const base = JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingress.endpointUrl));
    expect(base).not.toContain(ROUTE);
    expect(base).toContain('.execute-api.');
    expect(JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingress.urlFor('billing')))).toContain(`/billing/${ROUTE}"`);
    expect(() => construct.ingress.urlFor('Billing')).toThrow(/backend/);
    expect(construct.ingressRole).toBe(construct.tvmCallerRole);
    expect(JSON.stringify(Stack.of(construct.ingress).resolve(construct.ingressRole.roleArn))).toContain('IngressFunctionServiceRole');
  });

  it('creates no ingress Gateway: the one AgentCore Gateway is the tools gateway (MCP, CUSTOM_JWT on the ingress issuer)', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { ProtocolType: 'MCP' });
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

  it('publishes the Gateway identifier in the document so a backend stack can add its target (ADR-0024, ADR-0042)', () => {
    const [param] = Object.values(template.findResources('AWS::SSM::Parameter')) as any[];
    expect(param.Properties.Name).toBe(`${DEFAULT_REGISTRY_PREFIX}${PUBLISHED.ingress}`);
    const gatewayId = Object.keys(template.findResources('AWS::BedrockAgentCore::Gateway'))[0];
    expect(JSON.stringify(param.Properties.Value)).toContain(`{"Fn::GetAtt":["${gatewayId}","GatewayIdentifier"]}`);
    const literal = (param.Properties.Value['Fn::Join'][1] as unknown[]).filter((x) => typeof x === 'string').join('');
    expect(literal).toContain('"gatewayIdentifier":"');
  });

  it('creates one small REST API only: the issuer routes and the entitlement API (C-13, C-14)', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 0);
    const parts = (Object.values(template.findResources('AWS::ApiGateway::Resource')) as any[]).map((r) => r.Properties.PathPart);
    expect(parts).toEqual(expect.arrayContaining(['.well-known', 'jwks.json', 'openid-configuration', 'entitlements']));
    expect(parts).not.toContain(ROUTE);
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
    // ADR-0039: tenant scope by default when session mapping is on.
    expect(lambdaEnv(synth({ ingress, session: {} }).template, fnDescription)[ENV.SESSION_SCOPE]).toBe('tenant');
    expect(lambdaEnv(synth({ ingress, session: { scope: 'user' } }).template, fnDescription)[ENV.SESSION_SCOPE]).toBe('user');
  });

  it('requiredScopes reach the Lambdas', () => {
    expect(lambdaEnv(synth({ ingress, requiredScopes: ['a', 'b'] }).template, fnDescription)[ENV.REQUIRED_SCOPES]).toBe('a,b');
  });

  it('tvm keeps the two headers on the allowlist and grants AssumeRole+TagSession on the tenant role to tvmCallerRole only (ADR-0012)', () => {
    const { template, construct, tenantRole } = synth({ ingress, tvm: { role: {} as iam.IRole, includeUserIdTag: true, claimTags: { Tier: 'custom:tier' }, durationSeconds: 1800 } });
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      RequestHeaderConfiguration: { RequestHeaderAllowlist: [RUNTIME_HEADERS.TRANSACTION_TOKEN, RUNTIME_HEADERS.TENANT_CREDENTIALS] },
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

  it('every module on passes cdk-nag', () => {
    expect(() =>
      synth(
        {
          ingress,
          requiredScopes: ['tenant-api/read'],
          identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'], multiTenant: true },
          session: { scope: 'user' },
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
    const tables = Object.entries(template.findResources('AWS::DynamoDB::GlobalTable')).filter(([id]) => !id.includes('Entitlements'));
    expect(tables).toHaveLength(1);
    const [id, table] = tables[0] as [string, any];
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
    const count = statements.filter((s) => JSON.stringify(s.Action).includes('dynamodb:') && s.Sid !== 'ReadEntitlements');
    expect(count).toHaveLength(1);
    expect(count[0].Sid).toBe('CountTenantUsage');
    expect(count[0].Action).toBe('dynamodb:UpdateItem');
    expect(count[0].Resource).toEqual(Stack.of(construct.ingress).resolve(construct.limitsTable!.tableArn));
  });

  it('tenantLimits: false creates no table and sets no limits environment', () => {
    const off = synth({ ingress, tenantLimits: false });
    // Only the entitlement store remains (C-12).
    off.template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    expect(off.construct.limitsTable).toBeUndefined();
    const env = lambdaEnv(off.template, fnDescription);
    for (const name of [ENV.LIMITS_TABLE, ENV.LIMIT_REQUESTS_PER_MINUTE, ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(JSON.stringify(off.template.toJSON())).not.toContain('CountTenantUsage');
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
  const support = new AgentBackend(stack, 'Support', { name: 'support', ingress: shared, agent: agentOf('eu.amazon.nova-lite-v1:0'), needs: ['support/chat'] });
  const billing = new AgentBackend(stack, 'Billing', {
    name: 'billing',
    ingress: shared,
    agent: agentOf('eu.amazon.nova-lite-v1:0'),
    needs: ['billing/read', 'billing/invoke'],
    tools: ['invoices/*', 'crm/get_account'],
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

  it('writes one registry entry per backend under the custom prefix, with the backend\'s needs and tools and a drain of TTL + 120 s', () => {
    const entries = Object.values(template.findResources('Custom::RuntimeIsolationRegistryEntry')) as any[];
    expect(entries.map((e) => e.Properties.ParameterName).sort()).toEqual(['/acme/agents/backends/billing', '/acme/agents/backends/support']);
    const billingEntry = entries.find((e) => e.Properties.ParameterName.endsWith('/billing'));
    expect(billingEntry.Properties.Needs).toEqual(['billing/read', 'billing/invoke']);
    expect(billingEntry.Properties.Tools).toEqual(['invoices/*', 'crm/get_account']);
    expect(billingEntry.Properties.DrainSeconds).toBe(150);
    expect(billing.needs).toEqual(['billing/read', 'billing/invoke']);
    expect(billing.tools).toEqual(['invoices/*', 'crm/get_account']);
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

  it('refuses a bad backend name and a Gateway ref without an identifier, naming the prop', () => {
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other');
    const sharedOther = new SharedIngress(other, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress: 'api-gateway' });
    expect(() => new AgentBackend(other, 'Bad', { name: 'Billing', ingress: sharedOther, agent: agentOf(), needs: ['billing/read'] })).toThrow(/AgentBackend: name/);
    const ref: SharedIngressRef = {
      registryPrefix: '/p/',
      ingressRoleArn: 'arn:aws:iam::111122223333:role/x',
      ingressId: 'x',
      ingress: 'agentcore-gateway',
      tenantRoleArn: 'arn:aws:iam::111122223333:role/t',
      entitlementsTableName: 'table',
    };
    expect(() => new AgentBackend(other, 'Bad3', { name: 'ok', ingress: ref, agent: agentOf(), needs: ['ok/chat'] })).toThrow(/gatewayIdentifier/);
  });

  it('needs: required, non-empty, owned by the backend, no duplicates; tools: <target>/<tool> or <target>/*, at most 64 (ADR-0032)', () => {
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other');
    const sharedOther = new SharedIngress(other, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress: 'api-gateway' });
    let n = 0;
    const make = (needs: string[], tools?: string[]) => () => new AgentBackend(other, `B${n++}`, { name: 'ok', ingress: sharedOther, agent: agentOf(), needs, tools });
    expect(make([])).toThrow(/AgentBackend: needs must name at least one need/);
    expect(make(['ok/read', 'ok/read'])).toThrow(/AgentBackend: needs must not repeat a need/);
    expect(make(['ok/Read'])).toThrow(/AgentBackend: needs 'ok\/Read' must match/);
    expect(make(['billing/read'])).toThrow(/AgentBackend: needs 'billing\/read' must be owned by this backend/);
    expect(make(['ok/read'], ['crm'])).toThrow(/AgentBackend: tools 'crm' must match/);
    expect(make(['ok/read'], ['crm/Get'])).toThrow(/AgentBackend: tools 'crm\/Get' must match/);
    expect(make(['ok/read'], ['crm/*', 'crm/*'])).toThrow(/AgentBackend: tools must not repeat a tool/);
    expect(make(['ok/read'], Array.from({ length: 65 }, (_, i) => `t${i}/x`))).toThrow(/AgentBackend: tools must list at most 64 tools/);
    expect(() => new AgentBackend(other, 'Missing', { name: 'ok', ingress: sharedOther, agent: agentOf() } as any)).toThrow(/AgentBackend: needs/);
    expect(() => new AgentBackend(other, 'V1', { name: 'ok', ingress: sharedOther, agent: agentOf(), scopes: ['ok/x'] } as any)).toThrow(/AgentBackend: scopes is not a prop: name the agent's own actions in needs/);
    expect(() => new AgentBackend(other, 'V1b', { name: 'ok', ingress: sharedOther, agent: agentOf(), needs: ['ok/x'], identityApi: {} } as any)).toThrow(/AgentBackend: identityApi is not a prop/);
    make(['ok/read'], ['crm/*', 'crm/get_account', 'my-target/do_it'])();
  });

  it('owner: refused when empty, over 200 characters or carrying # (ADR-0035)', () => {
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other');
    const sharedOther = new SharedIngress(other, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress: 'api-gateway' });
    const make = (id: string, owner: string) => () => new AgentBackend(other, id, { name: id.toLowerCase(), ingress: sharedOther, agent: agentOf(), needs: [`${id.toLowerCase()}/chat`], owner });
    expect(make('Empty', '')).toThrow(/AgentBackend: owner must be a non-empty string/);
    expect(make('Long', 'x'.repeat(OWNER_MAX_LENGTH + 1))).toThrow(/AgentBackend: owner must be at most 200 characters/);
    expect(make('Hash', 'a#b')).toThrow(/AgentBackend: owner must not contain '#'/);
    expect(ownerProblem(undefined)).toBeUndefined();
    make('Shared', 'shared-owner')();
    Template.fromStack(other).hasResourceProperties('Custom::RuntimeIsolationOwnedRows', {
      Owner: 'shared-owner',
      Rows: [{ PK: 'NAME#shared', SK: '#NAME', attributes: { kind: 'agent' } }],
    });
  });

  it('toolsGateway: false plus a backend with tools fails synth (P-4, ADR-0034)', () => {
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other');
    const noTools = new SharedIngress(other, 'Ingress', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['c'] }, ingress: 'api-gateway', toolsGateway: false });
    expect(() => new AgentBackend(other, 'T', { name: 't', ingress: noTools, agent: agentOf(), needs: ['t/x'], tools: ['crm/*'] })).toThrow(
      /AgentBackend: tools needs an ingress with a tools gateway/,
    );
    new AgentBackend(other, 'U', { name: 'u', ingress: noTools, agent: agentOf(), needs: ['u/x'] });
    Template.fromStack(other).resourceCountIs('AWS::BedrockAgentCore::Gateway', 0);
  });

  it('refuses a SharedIngress instance from another stack: it must be imported with fromParameters (ADR-0024)', () => {
    const otherApp = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const backendStack = new Stack(otherApp, 'BackendStack', { env: { account: '111122223333', region: 'eu-central-1' } });
    expect(() => new AgentBackend(backendStack, 'Foreign', { name: 'foreign', ingress: shared, agent: agentOf(), needs: ['foreign/chat'] })).toThrow(
      /AgentBackend: ingress a SharedIngress from another stack must be imported with SharedIngress\.fromParameters/,
    );
    // Nothing of the backend reached the ingress's stack either.
    expect(JSON.stringify(template.toJSON())).not.toContain('Foreign');
  });

  it('a RegistryEntryResource drain above 870 s (TTL 750 s + 120 s) is refused at synth, so the handler timeout stays under Lambda\'s 15 minutes', () => {
    const other = new Stack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Other', { env: { account: '111122223333', region: 'eu-central-1' } });
    const base = { registryPrefix: '/p/', backend: 'b', runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/x', needs: ['b/x'], tools: [] };
    expect(() => new RegistryEntryResource(other, 'TooLong', { ...base, drain: Duration.seconds(871) })).toThrow(/RegistryEntryResource: drain must be from 1 to 870 seconds \(got 871\)/);
    expect(() => new RegistryEntryResource(other, 'Zero', { ...base, drain: Duration.seconds(0) })).toThrow(/RegistryEntryResource: drain/);
    new RegistryEntryResource(other, 'Max', { ...base, drain: Duration.seconds(870) });
    const fns = Object.values(Template.fromStack(other).findResources('AWS::Lambda::Function')) as any[];
    expect(fns.find((f) => String(f.Properties.Description).includes('registry entry')).Properties.Timeout).toBe(900);
  });

  it('every registry entry sits behind the ingress log drain: entry -> drain -> its log group (ADR-0019)', () => {
    // (The scope registrations are checked the same way in the ADR-0025 test above.)
    const resources = template.toJSON().Resources as Record<string, any>;
    const [drain] = Object.keys(template.findResources('AWS::CloudFormation::CustomResource')).filter((id) => !id.includes('ToolsGateway'));
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
    // Only the ingress's drain and the tools gateway's: no backend adds one in the ingress's stack.
    expect(Object.keys(template.findResources('AWS::CloudFormation::CustomResource')).every((id) => id.includes('LogDrain'))).toBe(true);
  });

  it('passes cdk-nag with every new finding acknowledged', () => {
    expect(() => template.toJSON()).not.toThrow();
  });
});

describe.each(INGRESSES)('AgentBackend in its own stack from SharedIngress.fromParameters, ingress=%s (ADR-0024, ADR-0042)', (ingress) => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  const doc = publishedIngress(ingress);
  seedPublishedIngress(app, doc);
  const stack = new Stack(app, 'BackendStack', { env: TEST_ENV });
  const ref = SharedIngress.fromParameters(stack, 'Ingress', DEFAULT_REGISTRY_PREFIX, ingress);
  const backend = new AgentBackend(stack, 'Billing', {
    name: 'billing',
    ingress: ref,
    agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' },
    needs: ['billing/read', 'billing/invoke'],
    tools: ['invoices/*'],
  });
  // What a backend stack does with the URL (and what keeps the endpointUrl parameter referenced).
  new CfnOutput(stack, 'BillingEndpointUrl', { value: backend.endpointUrl! });
  const template = Template.fromStack(stack);

  it('reads the one published document at synth: no deploy-time parameter, every value from the document (ADR-0042)', () => {
    const all = Object.values((template.toJSON().Parameters ?? {}) as Record<string, any>).filter((p) => String(p.Type).startsWith('AWS::SSM::Parameter::Value'));
    expect(all.filter((p) => String(p.Default).startsWith(DEFAULT_REGISTRY_PREFIX))).toEqual([]);
    expect(all.map((p) => p.Default).some((d) => String(d).includes('/identity/'))).toBe(false);
    expect(ref.ingress).toBe(ingress);
    expect(ref.endpointUrl).toBe(doc.baseUrl);
    expect(ref.ingressRoleArn).toBe(doc.ingressRoleArn);
    expect(ref.ingressId).toBe(doc.ingressId);
    expect(ref.tenantRoleArn).toBe(doc.tenantRoleArn);
    expect(ref.issuer).toBe(doc.issuer);
    expect(ref.entitlementsTableName).toBe(doc.entitlementsTableName);
    expect(ref.gatewayIdentifier).toBe(ingress === 'agentcore-gateway' ? doc.gatewayIdentifier : undefined);
    expect(ref.tools).toEqual({
      name: 'default',
      gatewayIdentifier: doc.toolsGateways.default.identifier,
      gatewayUrl: doc.toolsGateways.default.url,
      gatewayRoleArn: doc.toolsGateways.default.roleArn,
      policyEngineId: doc.toolsGateways.default.policyEngineId,
      contextKeyId: doc.toolContextKeyId,
    });
  });

  it('creates the Runtime tagged with the read ingressId, the resource policy on the read role ARN, the target on the read Gateway, and the entry under the prefix', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::ResourcePolicy', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', ingress === 'agentcore-gateway' ? 1 : 0);
    const runtime = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'))[0] as any;
    expect(runtime.Properties.Tags).toEqual({ [INGRESS_TAG_KEY]: stack.resolve(ref.ingressId) });
    expect(runtime.Properties.RequestHeaderConfiguration.RequestHeaderAllowlist).toEqual([
      RUNTIME_HEADERS.TRANSACTION_TOKEN,
      RUNTIME_HEADERS.TENANT_CREDENTIALS,
    ]);
    expect(JSON.stringify(resourcePolicy(template))).toContain(JSON.stringify(ref.ingressRoleArn));
    template.hasResourceProperties('Custom::RuntimeIsolationRegistryEntry', {
      ParameterName: `${DEFAULT_REGISTRY_PREFIX}backends/billing`,
      Needs: ['billing/read', 'billing/invoke'],
      Tools: ['invoices/*'],
      DrainSeconds: 180,
    });
    template.hasResourceProperties('Custom::RuntimeIsolationOwnedRows', { Rows: [{ PK: 'NAME#billing', SK: '#NAME', attributes: { kind: 'agent' } }] });
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
    const [reservationLogGroup] = Object.keys(template.findResources('AWS::Logs::LogGroup')).filter((id) => id.includes('NameReservationLogs'));
    expect(resources[drain].DependsOn).toContain(reservationLogGroup);
    const [entry] = Object.values(template.findResources('Custom::RuntimeIsolationRegistryEntry')) as any[];
    expect(entry.DependsOn).toContain(drain);
    const [reservation] = Object.values(template.findResources('Custom::RuntimeIsolationOwnedRows')) as any[];
    expect(reservation.DependsOn).toContain(drain);
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
    // Attached by the role NAME parsed from the published ARN, not to a role of this stack.
    expect(model.Properties.Roles).toEqual(['ri-tenant-model-role']);
    expect(JSON.stringify(template.toJSON())).not.toContain('TenantModelRole');
  });

  it('passes cdk-nag', () => {
    expect(() => template.toJSON()).not.toThrow();
  });
});

describe('AgentBackend from a ref: the one-model statement on the imported tenant role (ADR-0018, F-10)', () => {
  const build = (modelIds: string[]) => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    seedPublishedIngress(app, publishedIngress('api-gateway'));
    const stack = new Stack(app, 'Agents', { env: TEST_ENV });
    const ref = SharedIngress.fromParameters(stack, 'Ingress', DEFAULT_REGISTRY_PREFIX, 'api-gateway');
    modelIds.forEach((modelId, i) =>
      new AgentBackend(stack, `A${i}`, { name: `a${i}`, ingress: ref, agent: agentOf(modelId), needs: [`a${i}/chat`] }),
    );
    const policies = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy')) as any[];
    return policies.flatMap((p) => p.Properties.PolicyDocument.Statement).filter((s: any) => s.Sid === 'OneModel');
  };

  it('twenty backends on one model add ONE inline policy to the role, not twenty (IAM caps a role at 10,240 bytes of inline policy)', () => {
    const one = build(Array.from({ length: 20 }, () => 'amazon.nova-lite-v1:0'));
    expect(one).toHaveLength(1);
    expect(one[0].Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
  });

  it('the policy name carries the stack, so two agents stacks on one ingress do not fight over one inline policy', () => {
    const names = (stackName: string) => {
      const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
      seedPublishedIngress(app, publishedIngress('api-gateway'));
      const stack = new Stack(app, stackName, { env: TEST_ENV });
      const ref = SharedIngress.fromParameters(stack, 'Ingress', DEFAULT_REGISTRY_PREFIX, 'api-gateway');
      new AgentBackend(stack, 'A', { name: 'a', ingress: ref, agent: agentOf('amazon.nova-lite-v1:0'), needs: ['a/chat'] });
      return (Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy')) as any[])
        .filter((p) => JSON.stringify(p.Properties.PolicyDocument).includes('"OneModel"'))
        .map((p) => p.Properties.PolicyName);
    };
    const [one] = names('AgentsOne');
    const [two] = names('AgentsTwo');
    expect(one).toMatch(/OneModel$/);
    expect(one).not.toEqual(two);
  });

  it('a second model in the same stack adds a second statement', () => {
    const two = build(['amazon.nova-lite-v1:0', 'amazon.nova-micro-v1:0', 'amazon.nova-lite-v1:0']);
    expect(two).toHaveLength(2);
    expect(JSON.stringify(two.map((s: any) => s.Resource))).toContain('nova-micro');
  });

  it('two ingress refs in one stack with the same model each get their own grant: the second tenant role is not left without InvokeModel', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const otherPrefix = '/application-plane/other/agent-runtime/';
    const otherRole = `arn:aws:iam::${TEST_ENV.account}:role/ri-other-tenant-model-role`;
    seedPublishedIngress(app, publishedIngress('api-gateway'));
    seedPublishedIngress(app, { ...publishedIngress('api-gateway'), tenantRoleArn: otherRole }, otherPrefix);
    const stack = new Stack(app, 'Agents', { env: TEST_ENV });
    const one = SharedIngress.fromParameters(stack, 'IngressOne', DEFAULT_REGISTRY_PREFIX, 'api-gateway');
    const two = SharedIngress.fromParameters(stack, 'IngressTwo', otherPrefix, 'api-gateway');
    new AgentBackend(stack, 'A1', { name: 'a1', ingress: one, agent: agentOf('amazon.nova-lite-v1:0'), needs: ['a1/chat'] });
    new AgentBackend(stack, 'A2', { name: 'a2', ingress: two, agent: agentOf('amazon.nova-lite-v1:0'), needs: ['a2/chat'] });
    new AgentBackend(stack, 'A3', { name: 'a3', ingress: two, agent: agentOf('amazon.nova-lite-v1:0'), needs: ['a3/chat'] });
    const policies = (Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy')) as any[]).filter((p) =>
      JSON.stringify(p.Properties.PolicyDocument).includes('"OneModel"'),
    );
    expect(policies).toHaveLength(2);
    const roles = policies.map((p) => JSON.stringify(p.Properties.Roles));
    expect(roles.some((r) => r.includes('ri-tenant-model-role'))).toBe(true);
    expect(roles.some((r) => r.includes('ri-other-tenant-model-role'))).toBe(true);
    expect(new Set(policies.map((p) => p.Properties.PolicyName)).size).toBe(2);
  });
});

describe('SharedIngress.fromParameters: the synth-time lookup (ADR-0042)', () => {
  const fresh = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });

  it('without the context yet (first synth) returns placeholder values of the right shape and records the missing lookup', () => {
    const app = fresh();
    const stack = new Stack(app, 'Consumer', { env: TEST_ENV });
    const ref = SharedIngress.fromParameters(stack, 'Ingress', DEFAULT_REGISTRY_PREFIX, 'agentcore-gateway', { toolsGateways: ['default', 'finance'] });
    expect(ref.ingress).toBe('agentcore-gateway');
    expect(ref.ingressId).toMatch(/^dummy-value-for-/);
    expect(ref.gatewayIdentifier).toMatch(/^dummy-value-for-/);
    expect(stack.resolve(ref.ingressRoleArn)).toBeDefined();
    expect(Object.keys(ref.toolsGateways!).sort()).toEqual(['default', 'finance']);
    expect(ref.tools).toBe(ref.toolsGateways!.default);
    expect(() => app.synth()).not.toThrow();
    const missing = app.synth().manifest.missing ?? [];
    expect(missing.map((m) => m.key)).toContain(`ssm:account=111122223333:parameterName=${DEFAULT_REGISTRY_PREFIX}ingress:region=eu-central-1`);
    const none = SharedIngress.fromParameters(new Stack(fresh(), 'C2', { env: TEST_ENV }), 'Ingress', DEFAULT_REGISTRY_PREFIX, undefined, { toolsGateway: false });
    expect(none.ingress).toBe('api-gateway');
    expect(none.toolsGateways).toBeUndefined();
    expect(none.tools).toBeUndefined();
  });

  it('needs env: { account, region } on the consuming stack', () => {
    expect(() => SharedIngress.fromParameters(new Stack(fresh(), 'NoEnv'), 'Ingress', DEFAULT_REGISTRY_PREFIX)).toThrow(/needs env: \{ account, region \}/);
  });

  it('refuses a document of another version, naming the parameter', () => {
    const app = fresh();
    seedPublishedIngress(app, { ...publishedIngress('api-gateway'), version: 1 });
    expect(() => SharedIngress.fromParameters(new Stack(app, 'C', { env: TEST_ENV }), 'Ingress', DEFAULT_REGISTRY_PREFIX)).toThrow(
      /SharedIngress\.fromParameters\(\/application-plane\/shared\/agent-runtime\/ingress\): version 1, expected 2/,
    );
    const legacy = fresh();
    legacy.node.setContext(`ssm:account=111122223333:parameterName=${DEFAULT_REGISTRY_PREFIX}ingress:region=eu-central-1`, 'api-gateway');
    expect(() => SharedIngress.fromParameters(new Stack(legacy, 'C', { env: TEST_ENV }), 'Ingress', DEFAULT_REGISTRY_PREFIX)).toThrow(/is not JSON/);
  });

  it('refuses a document whose values are not the shapes SharedIngress writes, or whose roles are in another account (security review 2026-11-04)', () => {
    const broken = (patch: Record<string, unknown>) => {
      const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
      seedPublishedIngress(app, { ...publishedIngress('api-gateway'), ...patch });
      const stack = new Stack(app, 'S', { env: TEST_ENV });
      return () => SharedIngress.fromParameters(stack, 'Ingress', DEFAULT_REGISTRY_PREFIX);
    };
    expect(broken({ ingressRoleArn: 'arn:aws:iam::999988887777:role/evil' })).toThrow(/ingressRoleArn belongs to account 999988887777, not this stack's 111122223333/);
    expect(broken({ ingressRoleArn: 'not-an-arn' })).toThrow(/ingressRoleArn is not an IAM role ARN/);
    expect(broken({ issuer: 'http://plain.example.com' })).toThrow(/issuer is not an https URL/);
    expect(broken({ entitlementsTableName: 'x' })).toThrow(/entitlementsTableName is not a table name/);
    expect(broken({ toolContextKeyId: 'a"b' })).toThrow(/toolContextKeyId is not an identifier/);
    const doc = publishedIngress('api-gateway');
    expect(broken({ toolsGateways: { default: { ...doc.toolsGateways.default, roleArn: 'arn:aws:iam::999988887777:role/gw' } } })).toThrow(/toolsGateways\.default\.roleArn belongs to account 999988887777/);
    expect(broken({ toolsGateways: { default: { ...doc.toolsGateways.default, identifier: 'id with spaces' } } })).toThrow(/toolsGateways\.default\.identifier is not an identifier/);
  });

  it('refuses an ingress argument the document contradicts; without one it takes the document\'s', () => {
    const app = fresh();
    seedPublishedIngress(app, publishedIngress('agentcore-gateway'));
    expect(() => SharedIngress.fromParameters(new Stack(app, 'C', { env: TEST_ENV }), 'Ingress', DEFAULT_REGISTRY_PREFIX, 'api-gateway')).toThrow(
      /the ingress is 'agentcore-gateway', not 'api-gateway'/,
    );
    const ref = SharedIngress.fromParameters(new Stack(app, 'D', { env: TEST_ENV }), 'Ingress', DEFAULT_REGISTRY_PREFIX);
    expect(ref.ingress).toBe('agentcore-gateway');
    expect(ref.gatewayIdentifier).toBe('ri-gateway-abc123');
  });

  it('refuses a tools gateway the document lacks, listing the ones it has; defaults to every published gateway', () => {
    const app = fresh();
    seedPublishedIngress(app, publishedIngress('api-gateway', ['default', 'finance']));
    expect(() => SharedIngress.fromParameters(new Stack(app, 'C', { env: TEST_ENV }), 'Ingress', DEFAULT_REGISTRY_PREFIX, 'api-gateway', { toolsGateways: ['default', 'hr'] })).toThrow(
      /no tools gateway hr; the ingress publishes \[default, finance\]/,
    );
    const all = SharedIngress.fromParameters(new Stack(app, 'D', { env: TEST_ENV }), 'Ingress', DEFAULT_REGISTRY_PREFIX);
    expect(Object.keys(all.toolsGateways!).sort()).toEqual(['default', 'finance']);
    expect(() => SharedIngress.fromParameters(new Stack(app, 'E', { env: TEST_ENV }), 'Ingress', DEFAULT_REGISTRY_PREFIX, undefined, { toolsGateways: ['Bad Name'] })).toThrow(
      /toolsGateways name 'Bad Name' must match/,
    );
  });

  it('toolsGateway: false returns no gateway even when the document has some', () => {
    const app = fresh();
    seedPublishedIngress(app, publishedIngress('api-gateway', ['default', 'finance']));
    const ref = SharedIngress.fromParameters(new Stack(app, 'C', { env: TEST_ENV }), 'Ingress', DEFAULT_REGISTRY_PREFIX, 'api-gateway', { toolsGateway: false });
    expect(ref.toolsGateways).toBeUndefined();
    expect(ref.tools).toBeUndefined();
    expect(ref.issuer).toBe(publishedIngress('api-gateway').issuer);
  });
});

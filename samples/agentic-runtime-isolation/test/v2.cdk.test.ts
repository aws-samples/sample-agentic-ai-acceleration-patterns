// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { publishedIngress, seedPublishedIngress, TEST_ENV } from './published-ingress';
import { AgentBackend, GATEWAY_TARGET_NAME, PUBLISHED, SharedIngress, type SharedIngressProps } from '../src/index';
import { cedarPolicyFor } from '../src/shared/cedar';
import { gatewayPhysicalNameOf, policyName, ToolTarget, type ToolDefinition } from '../src/tool-target.cdk';
import { MAX_TOOL_TARGETS } from '../src/tools-gateway.cdk';

/**
 * The v2 template shape (spec §3.3, §3.5, §3.6, §6.2; ADR-0030 to ADR-0040):
 * the entitlement store, the signing keys and their key policies, the public
 * discovery routes, the tools gateway, its interceptor, its rate limits and
 * the per-target policies.
 */

const FIXTURE_AGENT = path.join(__dirname, 'fixtures', 'agent');
const DISCOVERY_URL = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00/.well-known/openid-configuration';
type Ingress = SharedIngressProps['ingress'];

interface Built {
  readonly stack: Stack;
  readonly ingress: SharedIngress;
  readonly template: () => Template;
}

function build(ingress: Ingress, props: Partial<SharedIngressProps> = {}, targets = 1): Built {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
  const shared = new SharedIngress(stack, 'Ingress', {
    ingress,
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'] },
    defaultBackend: GATEWAY_TARGET_NAME,
    ...props,
  } as SharedIngressProps);
  const toolsOn = props.toolsGateway !== false && props.toolsGateways === undefined;
  new AgentBackend(stack, 'Backend', {
    name: GATEWAY_TARGET_NAME,
    ingress: shared,
    agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' },
    needs: [`${GATEWAY_TARGET_NAME}/chat`],
    tools: toolsOn ? ['crm/*'] : [],
  });
  if (toolsOn) {
    for (let i = 0; i < targets; i++) {
      new ToolTarget(stack, `Target${i}`, {
        name: i === 0 ? 'crm' : `t${i}`,
        ingress: shared,
        kind: 'lambda',
        function: toolFunction(stack, `Fn${i}`),
        tools: [{ name: 'get_account', description: 'Reads one account', inputSchema: { type: 'object' } }],
      });
    }
  }
  return { stack, ingress: shared, template: () => Template.fromStack(stack) };
}

function toolFunction(stack: Stack, id: string): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'),
  });
}

function resources(template: Template, type: string): [string, any][] {
  return Object.entries(template.findResources(type));
}

/** The logical id of the Lambda function whose description contains `text`, and its role's logical id. */
function functionAndRole(template: Template, text: string): { id: string; role: string; fn: any } {
  const [id, fn] = resources(template, 'AWS::Lambda::Function').find(([, f]) => String(f.Properties.Description ?? '').includes(text))!;
  return { id, role: fn.Properties.Role['Fn::GetAtt'][0], fn };
}

function signStatements(key: any): any[] {
  return key.Properties.KeyPolicy.Statement.filter((s: any) => [s.Action].flat().includes('kms:Sign'));
}

describe.each(['api-gateway', 'agentcore-gateway'] as const)('v2 template, ingress=%s', (ingress) => {
  const built = build(ingress);
  const template = built.template();
  // The authoriser (api-gateway) or the ingress interceptor (agentcore-gateway) mints.
  const minter = 'mints the transaction token';

  it('the entitlement store is a PK/SK table with PITR on and a Delete policy (ADR-0030)', () => {
    const tables = resources(template, 'AWS::DynamoDB::GlobalTable').filter(([, t]) => t.Properties.KeySchema.length === 2);
    expect(tables).toHaveLength(1);
    const [, table] = tables[0];
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ]);
    expect(table.Properties.Replicas[0].PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(table.DeletionPolicy).toBe('Delete');
  });

  it('two SIGN_VERIFY RSA_2048 keys: the transaction-token key and the tool-context key, both DESTROY (ADR-0037)', () => {
    const keys = resources(template, 'AWS::KMS::Key');
    expect(keys).toHaveLength(2);
    for (const [, key] of keys) {
      expect(key.Properties.KeySpec).toBe('RSA_2048');
      expect(key.Properties.KeyUsage).toBe('SIGN_VERIFY');
      expect(key.DeletionPolicy).toBe('Delete');
    }
  });

  it('kms:Sign on the transaction-token key is granted to the minter only, for its one algorithm; the account root gets no Sign', () => {
    const [, key] = resources(template, 'AWS::KMS::Key').find(([id]) => id.includes('TokenSigner'))!;
    const signs = signStatements(key);
    expect(signs).toHaveLength(1);
    const mintFn = functionAndRole(template, minter);
    expect(signs[0].Principal).toEqual({ AWS: { 'Fn::GetAtt': [mintFn.role, 'Arn'] } });
    expect(signs[0].Condition).toEqual({ StringEquals: { 'kms:SigningAlgorithm': 'RSASSA_PKCS1_V1_5_SHA_256' } });
    const root = key.Properties.KeyPolicy.Statement.find((s: any) => s.Sid === 'KeyAdministration');
    expect(root.Action).not.toContain('kms:Sign');
    expect(root.Action).not.toContain('kms:GetPublicKey');
    // No IAM policy grants Sign anywhere else.
    const iamSigns = resources(template, 'AWS::IAM::Policy').flatMap(([, p]) => p.Properties.PolicyDocument.Statement).filter((s: any) => [s.Action].flat().includes('kms:Sign'));
    expect(iamSigns).toHaveLength(0);
  });

  it('kms:Sign on the tool-context key is granted to the tools interceptor only', () => {
    const [, key] = resources(template, 'AWS::KMS::Key').find(([id]) => id.includes('ToolContextKey'))!;
    const signs = signStatements(key);
    expect(signs).toHaveLength(1);
    const interceptor = functionAndRole(template, 'tools gateway default REQUEST interceptor');
    expect(signs[0].Principal).toEqual({ AWS: { 'Fn::GetAtt': [interceptor.role, 'Arn'] } });
  });

  it.each(['TokenSigner', 'ToolContextKey'])('the %s key policy: no Create*/CreateGrant/Put* wildcard in any Allow, CreateGrant denied to everyone, Sign only to its minter', (which) => {
    const [, key] = resources(template, 'AWS::KMS::Key').find(([id]) => id.includes(which))!;
    const statements: any[] = key.Properties.KeyPolicy.Statement;
    const allows = statements.filter((s) => s.Effect === 'Allow');
    for (const s of allows) {
      const actions = [s.Action].flat();
      expect(actions.filter((a: string) => a.startsWith('kms:Create'))).toEqual([]);
      expect(actions).not.toContain('kms:Put*');
      expect(actions).not.toContain('kms:*');
    }
    const admin = statements.find((s) => s.Sid === 'KeyAdministration');
    expect(admin.Action).toContain('kms:PutKeyPolicy');
    expect(admin.Action).not.toContain('kms:Sign');
    const deny = statements.find((s) => s.Sid === 'DenyGrants');
    expect(deny).toEqual({ Sid: 'DenyGrants', Effect: 'Deny', Principal: { AWS: '*' }, Action: 'kms:CreateGrant', Resource: '*' });
    const signs = signStatements(key);
    expect(signs).toHaveLength(1);
    expect(signs[0].Sid).toMatch(/^Sign/);
    expect(signs[0].Effect).toBe('Allow');
  });

  it('the two discovery routes are public GETs on a MOCK integration, with no authoriser (spec §5.2)', () => {
    const methods = resources(template, 'AWS::ApiGateway::Method').filter(([id]) => id.includes('wellknown'));
    expect(methods).toHaveLength(2);
    for (const [, method] of methods) {
      expect(method.Properties.HttpMethod).toBe('GET');
      expect(method.Properties.AuthorizationType).toBe('NONE');
      expect(method.Properties.AuthorizerId).toBeUndefined();
      expect(method.Properties.Integration.Type).toBe('MOCK');
    }
    template.resourceCountIs('Custom::RuntimeIsolationJwks', 1);
  });

  it('the tools gateway: CUSTOM_JWT on the ingress issuer with audience tools-gateway:default, MCP 2025-11-25, REQUEST interceptor, Policy ENFORCE (ADR-0034, ADR-0041)', () => {
    const [, gateway] = resources(template, 'AWS::BedrockAgentCore::Gateway').find(([id]) => id.includes('ToolsGateway'))!;
    const p = gateway.Properties;
    expect(p.AuthorizerType).toBe('CUSTOM_JWT');
    expect(p.AuthorizerConfiguration.CustomJWTAuthorizer.AllowedAudience).toEqual(['tools-gateway:default']);
    expect(JSON.stringify(p.AuthorizerConfiguration.CustomJWTAuthorizer.DiscoveryUrl)).toContain('/.well-known/openid-configuration');
    expect(JSON.stringify(p.AuthorizerConfiguration.CustomJWTAuthorizer.DiscoveryUrl)).not.toContain('cognito-idp');
    expect(p.ProtocolType).toBe('MCP');
    expect(p.ProtocolConfiguration.Mcp.SupportedVersions).toContain('2025-11-25');
    expect(p.InterceptorConfigurations).toHaveLength(1);
    expect(p.InterceptorConfigurations[0].InterceptionPoints).toEqual(['REQUEST']);
    expect(p.PolicyEngineConfiguration.Mode).toBe('ENFORCE');
  });

  it('the tools interceptor knows the issuer, the context key and the context lifetime, and runs on a provisioned alias', () => {
    const { id, fn } = functionAndRole(template, 'tools gateway default REQUEST interceptor');
    expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual(['RI_CONTEXT_ALGORITHM', 'RI_CONTEXT_KEY_ID', 'RI_CONTEXT_LIFETIME_SECONDS', 'RI_INGRESS_ROLE_ARN', 'RI_ISSUER', 'RI_TOOLS_GATEWAY_NAME']);
    expect(fn.Properties.Environment.Variables.RI_CONTEXT_ALGORITHM).toBe('RS256');
    expect(fn.Properties.Environment.Variables.RI_CONTEXT_LIFETIME_SECONDS).toBe('60');
    expect(fn.Properties.Environment.Variables.RI_TOOLS_GATEWAY_NAME).toBe('default');
    const [, alias] = resources(template, 'AWS::Lambda::Alias').find(([, a]) => a.Properties.FunctionName.Ref === id)!;
    expect(alias.Properties.ProvisionedConcurrencyConfig).toEqual({ ProvisionedConcurrentExecutions: 1 });
  });

  it('one native rate-limit bucket per tenant_id, 10 rps by default (M-60, ADR-0039)', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayRateLimit', {
      DimensionKeys: ['$.context.jwt.tenant_id'],
      Entries: [{ Dimensions: { '$.context.jwt.tenant_id': '*' }, Requests: [{ Period: 'second', Rate: 10 }] }],
    });
  });

  it('each ToolTarget policy depends on its own target (and Policy validates with FAIL_ON_ANY_FINDINGS)', () => {
    const [, policy] = resources(template, 'Custom::RuntimeIsolationToolPolicy')[0];
    const [targetId] = resources(template, 'AWS::BedrockAgentCore::GatewayTarget').find(([id]) => id.startsWith('Target0'))!;
    expect(policy.DependsOn).toContain(targetId);
    expect(policy.Properties.Name).toMatch(/^crm_target_[0-9a-f]{8}$/);
    expect(policy.Properties.ValidationMode).toBe('FAIL_ON_ANY_FINDINGS');
  });

  it('the policy is the one star permit of the target, on its gateway ARN (ADR-0041)', () => {
    const [, policy] = resources(template, 'Custom::RuntimeIsolationToolPolicy')[0];
    const [gatewayId] = resources(template, 'AWS::BedrockAgentCore::Gateway').find(([id]) => id.includes('ToolsGateway'))!;
    const expected = built.stack.resolve(cedarPolicyFor('crm', built.ingress.toolsGateway!.gatewayArn));
    expect(policy.Properties.Statement).toEqual(expected);
    expect(JSON.stringify(policy.Properties.Statement)).toContain(gatewayId);
    expect(JSON.stringify(policy.Properties.Statement)).not.toContain('___');
  });

  it('the entitlement API: vendor routes are AWS_IAM on the vendor function, tenant-admin routes NONE on the tenant-admin function (spec §5.3, ADR-0033)', () => {
    const vendorFn = functionAndRole(template, 'entitlement API, vendor side').id;
    const adminFn = functionAndRole(template, 'entitlement API, tenant-admin side').id;
    const pathOf = new Map(resources(template, 'AWS::ApiGateway::Resource').map(([id, r]) => [id, r.Properties.PathPart as string]));
    const methods = resources(template, 'AWS::ApiGateway::Method').filter(([id]) => id.includes('entitlements'));
    const byPart = (part: string) => methods.filter(([, m]) => pathOf.get(m.Properties.ResourceId.Ref) === part);
    const vendorRoutes = [...byPart('{tenantId}'), ...byPart('plans'), ...byPart('{planName}')];
    const adminRoutes = [...byPart('users'), ...byPart('cut')];
    expect(vendorRoutes).toHaveLength(7);
    expect(adminRoutes).toHaveLength(4);
    expect(vendorRoutes.length + adminRoutes.length).toBe(methods.length);
    for (const [, m] of vendorRoutes) {
      expect(m.Properties.AuthorizationType).toBe('AWS_IAM');
      expect(JSON.stringify(m.Properties.Integration.Uri)).toContain(vendorFn);
    }
    for (const [, m] of adminRoutes) {
      expect(m.Properties.AuthorizationType).toBe('NONE');
      expect(JSON.stringify(m.Properties.Integration.Uri)).toContain(adminFn);
    }
  });

  it('TenantAdminRole: assumable only by the tenant-admin function with a TenantId session tag, and writes only its own tenant partition (ADR-0033, M-45)', () => {
    const adminFn = functionAndRole(template, 'entitlement API, tenant-admin side');
    const [roleId, role] = resources(template, 'AWS::IAM::Role').find(([id]) => id.includes('TenantAdminRole'))!;
    const trust = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0].Principal).toEqual({ AWS: { 'Fn::GetAtt': [adminFn.role, 'Arn'] } });
    expect([trust[0].Action].flat().sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(trust[0].Condition).toEqual({
      'StringLike': { 'aws:RequestTag/TenantId': '?*' },
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['TenantId'] },
    });
    const statements = resources(template, 'AWS::IAM::Policy')
      .filter(([, p]) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
    const own = statements.find((st: any) => st.Sid === 'OwnTenantPartitionOnly');
    expect(own.Action.sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
    expect(own.Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/TenantId}'] } });
    // Writes name only the cut row's attributes and the tenant row's version: a handler defect cannot SET agents or tools on #SUB.
    const write = statements.find((st: any) => st.Sid === 'OwnTenantCutAttributesOnly');
    expect(write.Action.sort()).toEqual(['dynamodb:ConditionCheckItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
    expect(write.Condition).toEqual({
      'ForAllValues:StringEquals': {
        'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/TenantId}'],
        'dynamodb:Attributes': ['PK', 'SK', 'cutAgents', 'cutTools', 'updatedBy', 'updatedAt', 'version'],
      },
      'StringEqualsIfExists': { 'dynamodb:ReturnValues': ['NONE', 'UPDATED_OLD', 'UPDATED_NEW'] },
    });
    for (const attr of ['agents', 'tools', 'plan', 'status']) {
      expect(write.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']).not.toContain(attr);
    }
    for (const st of statements) {
      expect(st.Condition?.['ForAllValues:StringEquals']?.['dynamodb:LeadingKeys'] ?? null).not.toBeNull();
    }
    // The function itself may assume the role and tag the session, nothing broader.
    const assume = resources(template, 'AWS::IAM::Policy')
      .filter(([, p]) => p.Properties.Roles.some((r: any) => r.Ref === adminFn.role))
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement)
      .find((st: any) => st.Sid === 'AssumeTenantAdminRole');
    expect(assume.Resource).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
  });

  it('no RESPONSE interceptor unless responseFilter is on (ADR-0041)', () => {
    expect(resources(template, 'AWS::Lambda::Function').some(([, f]) => String(f.Properties.Description).includes('RESPONSE interceptor'))).toBe(false);
  });
});

describe('v2 options', () => {
  it('identity.multiTenant on api-gateway: X-Tenant-Id is an authoriser identity source (M-53); off, it is not', () => {
    const sourcesOf = (multiTenant: boolean): string[] => {
      const template = build('api-gateway', { identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'], multiTenant } }).template();
      const authorizers = resources(template, 'AWS::ApiGateway::Authorizer');
      expect(authorizers).toHaveLength(1);
      return String(authorizers[0][1].Properties.IdentitySource).split(',');
    };
    expect(sourcesOf(true)).toEqual(['method.request.header.Authorization', 'context.path', 'method.request.header.X-Tenant-Id']);
    expect(sourcesOf(false)).toEqual(['method.request.header.Authorization', 'context.path']);
  });

  it('toolContextKey.algorithm ES256: an ECC context key, ECDSA Sign for the interceptor, RI_CONTEXT_ALGORITHM ES256 (scale review 2026-11-05)', () => {
    const { template } = build('api-gateway', { toolContextKey: { algorithm: 'ES256' } });
    const keys = resources(template(), 'AWS::KMS::Key').filter(([, k]) => String(k.Properties.Description).includes('tool context'));
    expect(keys).toHaveLength(1);
    expect(keys[0][1].Properties.KeySpec).toBe('ECC_NIST_P256');
    const sign = keys[0][1].Properties.KeyPolicy.Statement.find((s: any) => String(s.Sid).startsWith('SignToolContexts'));
    expect(sign.Condition).toEqual({ StringEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' } });
    const { fn } = functionAndRole(template(), 'tools gateway default REQUEST interceptor');
    expect(fn.Properties.Environment.Variables.RI_CONTEXT_ALGORITHM).toBe('ES256');
    expect(() => build('api-gateway', { toolContextKey: { algorithm: 'HS256' as never } })).toThrow(/toolContextKey\.algorithm/);
  });

  it('the integration function holds the JWKS document (M-82) and is updated before the authoriser, so a rotation never hands it a kid it lacks', () => {
    const { template } = build('api-gateway');
    const t = template();
    const { id: ingressId, fn: ingress } = functionAndRole(t, 'relays the backend stream');
    const { fn: authorizer } = functionAndRole(t, 'verifies the identity');
    const jwksEnv = ingress.Properties.Environment.Variables.RI_TXN_JWKS;
    expect(jwksEnv['Fn::GetAtt'][0]).toMatch(/TokenSignerJwks/);
    expect(jwksEnv['Fn::GetAtt'][1]).toBe('Jwks');
    expect(authorizer.Properties.Environment.Variables.RI_TXN_JWKS).toBeUndefined();
    expect([authorizer.DependsOn].flat()).toContain(ingressId);
  });

  it('ingressReservedConcurrency caps the streaming integration Lambda; api-gateway only (scale review 2026-11-05)', () => {
    const { template } = build('api-gateway', { ingressReservedConcurrency: 200, authorizerReservedConcurrency: 20 });
    const { fn } = functionAndRole(template(), 'relays the backend stream');
    expect(fn.Properties.ReservedConcurrentExecutions).toBe(200);
    expect(() => build('agentcore-gateway', { ingressReservedConcurrency: 200 })).toThrow(/ingressReservedConcurrency/);
    expect(() => build('api-gateway', { ingressReservedConcurrency: 0 })).toThrow(/ingressReservedConcurrency/);
  });

  describe('authorizerReservedConcurrency and the stage throttle (ADR-0049)', () => {
    const unreserved = Match.stringLikeRegexp('runtime-isolation:authorizer-unreserved');
    const above = Match.stringLikeRegexp('runtime-isolation:stage-throttle-above-concurrency');
    const fit = { ingressReservedConcurrency: 800, authorizerReservedConcurrency: 1000, stageThrottle: { rateLimit: 500, burstLimit: 250 } };

    it('reserves concurrency for the authoriser; api-gateway only; a positive integer', () => {
      const { template } = build('api-gateway', fit);
      const { fn } = functionAndRole(template(), 'mints the transaction token');
      expect(fn.Properties.ReservedConcurrentExecutions).toBe(1000);
      expect(() => build('agentcore-gateway', { authorizerReservedConcurrency: 10 })).toThrow(/authorizerReservedConcurrency/);
      expect(() => build('api-gateway', { authorizerReservedConcurrency: 1.5 })).toThrow(/authorizerReservedConcurrency/);
    });

    it('warns when the ingress Lambda is reserved and the authoriser is not (the reserve starves it)', () => {
      Annotations.fromStack(build('api-gateway', { ingressReservedConcurrency: 800, stageThrottle: { rateLimit: 500, burstLimit: 250 } }).stack).hasWarning('*', unreserved);
      Annotations.fromStack(build('api-gateway', fit).stack).hasNoWarning('*', unreserved);
      Annotations.fromStack(build('api-gateway').stack).hasNoWarning('*', unreserved);
    });

    it('warns when stageThrottle.rateLimit is above either reserve, naming the bare-500 consequence', () => {
      const over = build('api-gateway', { ingressReservedConcurrency: 200, authorizerReservedConcurrency: 10, stageThrottle: { rateLimit: 300, burstLimit: 150 } }).stack;
      Annotations.fromStack(over).hasWarning('*', Match.stringLikeRegexp('ingressReservedConcurrency 200'));
      Annotations.fromStack(over).hasWarning('*', Match.stringLikeRegexp('authorizerReservedConcurrency 10 x 1'));
      Annotations.fromStack(over).hasWarning('*', Match.stringLikeRegexp('bare 500'));
      Annotations.fromStack(build('api-gateway', fit).stack).hasNoWarning('*', above);
      Annotations.fromStack(build('api-gateway', { stageThrottle: { rateLimit: 5000, burstLimit: 2500 } }).stack).hasNoWarning('*', above);
    });
  });

  it('warns when stageThrottle is left at its shared default and when session.scope resolves to tenant (scale and security reviews)', () => {
    const throttle = Match.stringLikeRegexp('runtime-isolation:stage-throttle-default');
    const shared = Match.stringLikeRegexp('runtime-isolation:shared-session-scope');
    Annotations.fromStack(build('api-gateway').stack).hasWarning('*', throttle);
    Annotations.fromStack(build('api-gateway', { stageThrottle: { rateLimit: 500, burstLimit: 250 } }).stack).hasNoWarning('*', throttle);
    Annotations.fromStack(build('agentcore-gateway').stack).hasNoWarning('*', throttle);
    Annotations.fromStack(build('api-gateway', { session: {} }).stack).hasWarning('*', shared);
    Annotations.fromStack(build('api-gateway', { session: { scope: 'user' } }).stack).hasNoWarning('*', shared);
    Annotations.fromStack(build('api-gateway').stack).hasNoWarning('*', shared);
  });

  it('ES256 makes ECC_NIST_P256 keys signed with ECDSA_SHA_256', () => {
    const template = build('api-gateway', { transactionToken: { algorithm: 'ES256' } }).template();
    const [, key] = resources(template, 'AWS::KMS::Key').find(([id]) => id.includes('TokenSigner'))!;
    expect(key.Properties.KeySpec).toBe('ECC_NIST_P256');
    expect(signStatements(key)[0].Condition).toEqual({ StringEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' } });
  });

  it('keyGeneration 2 keeps the previous key for the JWKS and grants Sign only on the newer one (spec §6.2.3)', () => {
    const template = build('api-gateway', { transactionToken: { keyGeneration: 2 } }).template();
    const keys = resources(template, 'AWS::KMS::Key').filter(([id]) => id.includes('TokenSigner'));
    expect(keys).toHaveLength(2);
    const withSign = keys.filter(([, k]) => signStatements(k).length > 0);
    expect(withSign).toHaveLength(1);
    expect(withSign[0][0]).toMatch(/SigningKey2/);
  });

  it('ttl outside 120 to 900 s fails synth', () => {
    expect(() => build('api-gateway', { transactionToken: { ttl: Duration.seconds(60) } })).toThrow(/transactionToken.ttl/);
    expect(() => build('api-gateway', { transactionToken: { ttl: Duration.seconds(901) } })).toThrow(/transactionToken.ttl/);
  });

  it('tenantRateLimitOverrides add one entry per named tenant beside the * default', () => {
    const template = build('api-gateway', { toolsGateway: { tenantRateLimit: { requestsPerSecond: 5 }, tenantRateLimitOverrides: { 't-big': 50 } } }).template();
    const [, limit] = resources(template, 'AWS::BedrockAgentCore::GatewayRateLimit')[0];
    expect(limit.Properties.Entries).toEqual(
      expect.arrayContaining([
        { Dimensions: { '$.context.jwt.tenant_id': '*' }, Requests: [{ Period: 'second', Rate: 5 }] },
        { Dimensions: { '$.context.jwt.tenant_id': 't-big' }, Requests: [{ Period: 'second', Rate: 50 }] },
      ]),
    );
  });

  it('toolsGateway: false creates no tools gateway, policy engine or tool-context key', () => {
    const template = build('api-gateway', { toolsGateway: false }).template();
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 0);
    template.resourceCountIs('AWS::BedrockAgentCore::PolicyEngine', 0);
    template.resourceCountIs('AWS::KMS::Key', 1);
  });

  it('toolsGateway: false plus a backend with tools fails synth (P-4, ADR-0034)', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
    const shared = new SharedIngress(stack, 'Ingress', {
      ingress: 'api-gateway',
      identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'] },
      defaultBackend: GATEWAY_TARGET_NAME,
      toolsGateway: false,
    });
    expect(
      () =>
        new AgentBackend(stack, 'Backend', {
          name: GATEWAY_TARGET_NAME,
          ingress: shared,
          agent: { codePath: FIXTURE_AGENT, modelId: 'm' },
          needs: ['default/chat'],
          tools: ['crm/*'],
        }),
    ).toThrow(/AgentBackend: tools needs an ingress with a tools gateway/);
    expect(
      () => new ToolTarget(stack, 'T', { name: 'crm', ingress: shared, kind: 'lambda', function: toolFunction(stack, 'F'), tools: [{ name: 'x', description: 'x', inputSchema: {} }] }),
    ).toThrow(/ToolTarget: ingress has toolsGateway: false/);
  });

  it('policies are created one after another: each DependsOn the previous one (the policy engine serialises writes)', () => {
    const template = build('api-gateway', {}, 3).template();
    const policies = resources(template, 'Custom::RuntimeIsolationToolPolicy');
    expect(policies).toHaveLength(3);
    const ids = policies.map(([id]) => id);
    for (let i = 1; i < policies.length; i++) {
      expect(policies[i][1].DependsOn).toContain(ids[i - 1]);
    }
  });

  it(`more than ${MAX_TOOL_TARGETS} ToolTargets fail validation (ADR-0040)`, () => {
    const built = build('api-gateway', {}, MAX_TOOL_TARGETS + 1);
    expect(() => built.template()).toThrow(/tools gateway 'default' holds at most 100 ToolTargets/);
  }, 60_000);

  it('an AgentBackend and a ToolTarget of one app cannot share a name, in either order (ADR-0035)', () => {
    const { stack, ingress } = build('api-gateway'); // holds agent `default` and target `crm`
    expect(
      () => new ToolTarget(stack, 'Clash', { name: GATEWAY_TARGET_NAME, ingress, kind: 'lambda', function: toolFunction(stack, 'ClashFn'), tools: [{ name: 'x', description: 'x', inputSchema: {} }] }),
    ).toThrow(/name 'default' is already declared in this app as an agent; an agent and a tool target cannot share a name/);
    expect(
      () => new AgentBackend(stack, 'Crm', { name: 'crm', ingress, agent: { codePath: FIXTURE_AGENT, modelId: 'm' }, needs: ['crm/chat'], tools: [] }),
    ).toThrow(/name 'crm' is already declared in this app as a tool target/);
  });

  describe('agentDelegation (ADR-0049)', () => {
    const pathParts = (t: Template) => (Object.values(t.findResources('AWS::ApiGateway::Resource')) as any[]).map((r) => r.Properties.PathPart).sort();
    const envOf = (t: Template, text: string) => functionAndRole(t, text).fn.Properties.Environment.Variables;

    it('off by default: no delegations resource, no RI_DELEGATION_MAX_DEPTH, no RI_DELEGATION_URL on the agent, nothing in the published document', () => {
      const t = build('api-gateway').template();
      expect(pathParts(t)).not.toContain('delegations');
      expect(envOf(t, 'verifies the identity').RI_DELEGATION_MAX_DEPTH).toBeUndefined();
      expect(envOf(t, 'relays the backend stream').RI_DELEGATION_MAX_DEPTH).toBeUndefined();
      const runtime = (Object.values(t.findResources('AWS::BedrockAgentCore::Runtime')) as any[])[0];
      expect(runtime.Properties.EnvironmentVariables.RI_DELEGATION_URL).toBeUndefined();
      const doc = JSON.stringify((Object.values(t.findResources('AWS::SSM::Parameter')) as any[]).find((p) => JSON.stringify(p.Properties.Name).includes(PUBLISHED.ingress)).Properties.Value);
      expect(doc).not.toContain('delegationUrl');
    });

    it('on: a /{backend}/delegations POST with the same authoriser; depth and the ingress role on both functions; the agent gets RI_DELEGATION_URL; the document publishes delegationUrl', () => {
      const { ingress, template } = build('api-gateway', { agentDelegation: { maxDepth: 2 } });
      const t = template();
      expect(pathParts(t).filter((p) => p === 'delegations')).toHaveLength(1);
      const methods = (Object.values(t.findResources('AWS::ApiGateway::Method')) as any[]).filter((m) => m.Properties.HttpMethod === 'POST' && m.Properties.AuthorizationType === 'CUSTOM');
      expect(methods).toHaveLength(3); // /invocations, /{backend}/invocations, /{backend}/delegations
      const authorizerEnv = envOf(t, 'verifies the identity');
      const ingressEnv = envOf(t, 'relays the backend stream');
      expect(authorizerEnv.RI_DELEGATION_MAX_DEPTH).toBe('2');
      expect(ingressEnv.RI_DELEGATION_MAX_DEPTH).toBe('2');
      expect(ingressEnv.RI_INGRESS_ROLE_ARN).toEqual(authorizerEnv.RI_INGRESS_ROLE_ARN);
      expect(ingress.delegationUrl).toBe(ingress.endpointUrl);
      const runtime = (Object.values(t.findResources('AWS::BedrockAgentCore::Runtime')) as any[])[0];
      expect(runtime.Properties.EnvironmentVariables.RI_DELEGATION_URL).toBeDefined();
      const doc = JSON.stringify((Object.values(t.findResources('AWS::SSM::Parameter')) as any[]).find((p) => JSON.stringify(p.Properties.Name).includes(PUBLISHED.ingress)).Properties.Value);
      expect(doc).toContain('delegationUrl');
    });

    it('fails synth on agentcore-gateway, outside 1 to 3, and with tvm.claimTags', () => {
      expect(() => build('agentcore-gateway', { agentDelegation: { maxDepth: 1 } })).toThrow(/agentDelegation is valid only with the 'api-gateway' ingress/);
      expect(() => build('api-gateway', { agentDelegation: { maxDepth: 4 as never } })).toThrow(/agentDelegation.maxDepth must be an integer from 1 to 3/);
      expect(() => build('api-gateway', { agentDelegation: { maxDepth: 0 as never } })).toThrow(/agentDelegation.maxDepth/);
      expect(() =>
        build('api-gateway', {
          agentDelegation: { maxDepth: 1 },
          tvm: { role: iam.Role.fromRoleArn(new Stack(new App(), 'R'), 'Role', 'arn:aws:iam::111122223333:role/Tenant'), claimTags: { Dept: 'custom:dept' } } as never,
        }),
      ).toThrow(/cannot be combined with tvm.claimTags/);
    });

    it('AgentBackend.delegatesTo: shape checked, needs the route, written to the registry entry, warns on a name not in this app', () => {
      const { stack, ingress } = build('api-gateway', { agentDelegation: { maxDepth: 1 } });
      const backend = (props: Record<string, unknown>) =>
        new AgentBackend(stack, `B${Math.random().toString(36).slice(2, 8)}`, {
          name: 'planner',
          ingress,
          agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' },
          needs: ['planner/chat'],
          ...props,
        } as never);
      expect(() => backend({ delegatesTo: ['planner'] })).toThrow(/delegatesTo must not name this agent itself/);
      expect(() => backend({ delegatesTo: ['Bad Name'] })).toThrow(/delegatesTo 'Bad Name' must match/);
      expect(() => backend({ name: 'delegations' })).toThrow(/name must not be the route word 'delegations'/);
      expect(() => backend({ name: 'invocations' })).toThrow(/name must not be the route word 'invocations'/);
      backend({ name: 'planner', delegatesTo: [GATEWAY_TARGET_NAME, 'elsewhere'] });
      const t = Template.fromStack(stack);
      const entry = (Object.values(t.findResources('Custom::RuntimeIsolationRegistryEntry')) as any[]).find((r) => r.Properties.ParameterName && JSON.stringify(r.Properties.ParameterName).includes('planner'));
      expect(entry.Properties.DelegatesTo).toEqual([GATEWAY_TARGET_NAME, 'elsewhere']);
      Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('delegatesTo names elsewhere not found in this app'));
    });

    it('AgentBackend.delegatesTo without the route fails synth', () => {
      const { stack, ingress } = build('api-gateway');
      expect(
        () =>
          new AgentBackend(stack, 'Planner', {
            name: 'planner',
            ingress,
            agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' },
            needs: ['planner/chat'],
            delegatesTo: [GATEWAY_TARGET_NAME],
          }),
      ).toThrow(/delegatesTo needs an ingress with agentDelegation/);
    });

    it('fromParameters carries delegationUrl when the document has it, and an imported backend receives RI_DELEGATION_URL', () => {
      const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
      const doc = { ...publishedIngress('api-gateway'), delegationUrl: 'https://abc.execute-api.eu-central-1.amazonaws.com/prod' };
      seedPublishedIngress(app, doc);
      const stack = new Stack(app, 'Consumer', { env: TEST_ENV });
      const ref = SharedIngress.fromParameters(stack, 'Ref', doc.ingressRoleArn.split(':')[4] === TEST_ENV.account ? '/application-plane/shared/agent-runtime/' : '/x/', 'api-gateway');
      expect(ref.delegationUrl).toBe(doc.delegationUrl);
      new AgentBackend(stack, 'Imported', {
        name: 'planner',
        ingress: ref,
        agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' },
        needs: ['planner/chat'],
        delegatesTo: [GATEWAY_TARGET_NAME],
      });
      const runtime = (Object.values(Template.fromStack(stack).findResources('AWS::BedrockAgentCore::Runtime')) as any[])[0];
      expect(runtime.Properties.EnvironmentVariables.RI_DELEGATION_URL).toBe(doc.delegationUrl);
    });
  });

  it('a ToolTarget of an unknown kind, or with a bad name, fails synth (the kinds are in test/tool-target.cdk.test.ts)', () => {
    const { stack, ingress } = build('api-gateway');
    expect(() => new ToolTarget(stack, 'K', { name: 'k', ingress, kind: 'grpc' as never })).toThrow(/ToolTarget: kind must be/);
    expect(() => new ToolTarget(stack, 'Bad', { name: 'Bad', ingress, kind: 'lambda' })).toThrow(/ToolTarget: name must match/);
  });
});

/** ADR-0041: several tools gateways, each with its own Policy engine, audience, interceptor and limits. */
function tools(n: number, prefix = 'tool'): ToolDefinition[] {
  return Array.from({ length: n }, (_, i) => ({ name: `${prefix}_${i}`, description: `tool ${i}`, inputSchema: { type: 'object' } }));
}

function twoGateways(props: Partial<SharedIngressProps> = {}) {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
  const ingress = new SharedIngress(stack, 'Ingress', {
    ingress: 'api-gateway',
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'] },
    defaultBackend: GATEWAY_TARGET_NAME,
    toolsGateways: { default: {}, finance: { responseFilter: true, maxToolsPerGateway: 5 } },
    ...props,
  });
  return { app, stack, ingress };
}

describe('several tools gateways (ADR-0041)', () => {
  const { stack, ingress } = twoGateways();
  new AgentBackend(stack, 'Default', { name: 'default', ingress, agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' }, needs: ['default/chat'], tools: ['crm/*'] });
  new AgentBackend(stack, 'Billing', { name: 'billing', ingress, agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' }, needs: ['billing/chat'], tools: ['invoices/*'] });
  const crm = new ToolTarget(stack, 'Crm', { name: 'crm', ingress, kind: 'lambda', function: toolFunction(stack, 'CrmFn'), tools: tools(3) });
  const invoices = new ToolTarget(stack, 'Invoices', { name: 'invoices', ingress, gateway: 'finance', kind: 'lambda', function: toolFunction(stack, 'InvFn'), tools: tools(2) });
  const template = Template.fromStack(stack);
  const gateways = resources(template, 'AWS::BedrockAgentCore::Gateway');
  const byAudience = (aud: string) => gateways.find(([, g]) => g.Properties.AuthorizerConfiguration.CustomJWTAuthorizer.AllowedAudience[0] === aud)!;

  it('synthesises two gateways, each with its own audience and its own Policy engine', () => {
    expect(gateways).toHaveLength(2);
    expect(gateways.map(([, g]) => g.Properties.AuthorizerConfiguration.CustomJWTAuthorizer.AllowedAudience).sort()).toEqual([
      ['tools-gateway:default'],
      ['tools-gateway:finance'],
    ]);
    template.resourceCountIs('AWS::BedrockAgentCore::PolicyEngine', 2);
    const engines = gateways.map(([, g]) => JSON.stringify(g.Properties.PolicyEngineConfiguration.Arn));
    expect(new Set(engines).size).toBe(2);
    expect(Object.keys(ingress.toolsGateways).sort()).toEqual(['default', 'finance']);
    expect(ingress.toolsGateway).toBe(ingress.toolsGateways.default);
  });

  it('the RESPONSE interceptor is on finance only, and verifies with its own gateway name', () => {
    const [, def] = byAudience('tools-gateway:default');
    const [, fin] = byAudience('tools-gateway:finance');
    expect(def.Properties.InterceptorConfigurations.map((c: any) => c.InterceptionPoints)).toEqual([['REQUEST']]);
    expect(fin.Properties.InterceptorConfigurations.map((c: any) => c.InterceptionPoints)).toEqual([['REQUEST'], ['RESPONSE']]);
    expect(fin.Properties.InterceptorConfigurations[1].InputConfiguration).toEqual({ PassRequestHeaders: true });
    const filters = resources(template, 'AWS::Lambda::Function').filter(([, f]) => String(f.Properties.Description).includes('RESPONSE interceptor'));
    expect(filters).toHaveLength(1);
    expect(filters[0][1].Properties.Environment.Variables.RI_TOOLS_GATEWAY_NAME).toBe('finance');
    expect(Object.keys(filters[0][1].Properties.Environment.Variables)).not.toContain('RI_CONTEXT_KEY_ID');
  });

  it('one shared tool-context key with one Sign statement per gateway interceptor', () => {
    const keys = resources(template, 'AWS::KMS::Key').filter(([id]) => id.includes('ToolContextKey'));
    expect(keys).toHaveLength(1);
    const signs = signStatements(keys[0][1]);
    expect(signs.map((s) => s.Sid).sort()).toEqual(['SignToolContextsDefault', 'SignToolContextsFinance']);
    const interceptors = resources(template, 'AWS::Lambda::Function').filter(([, f]) => String(f.Properties.Description).includes('REQUEST interceptor'));
    expect(interceptors).toHaveLength(2);
  });

  it('one rate limit per gateway', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayRateLimit', 2);
  });

  it('one policy custom resource per target, each on its own gateway\'s engine, each the target\'s star permit', () => {
    const policies = resources(template, 'Custom::RuntimeIsolationToolPolicy');
    expect(policies).toHaveLength(2);
    const crmPolicy = policies.find(([, p]) => String(p.Properties.Name).startsWith('crm_target_'))![1];
    const invPolicy = policies.find(([, p]) => String(p.Properties.Name).startsWith('invoices_target_'))![1];
    expect(crmPolicy.Properties.PolicyEngineId).toEqual(stack.resolve(ingress.toolsGateways.default.policyEngine.attrPolicyEngineId));
    expect(invPolicy.Properties.PolicyEngineId).toEqual(stack.resolve(ingress.toolsGateways.finance.policyEngine.attrPolicyEngineId));
    expect(invPolicy.Properties.Statement).toEqual(stack.resolve(cedarPolicyFor('invoices', ingress.toolsGateways.finance.gatewayArn)));
    // The two targets are on different gateways: their policies are not chained.
    expect(invPolicy.DependsOn ?? []).not.toContain(policies.find(([, p]) => String(p.Properties.Name).startsWith('crm_target_'))![0]);
  });

  it('the catalogue rows and the registry pointer carry the gateway', () => {
    expect(invoices.gateway).toBe('finance');
    expect(crm.gateway).toBe('default');
    const rows = resources(template, 'Custom::RuntimeIsolationOwnedRows').map(([, r]) => r.Properties.Rows).flat();
    expect(rows.filter((r: any) => r.PK === 'TOOL#invoices').map((r: any) => r.attributes.gateway)).toEqual(['finance', 'finance']);
    expect(rows.filter((r: any) => r.PK === 'TOOL#crm').map((r: any) => r.attributes.gateway)).toEqual(['default', 'default', 'default']);
    const pointer = resources(template, 'AWS::SSM::Parameter').find(([, p]) => JSON.stringify(p.Properties.Name).includes('tools/invoices'))![1];
    expect(JSON.stringify(pointer.Properties.Value)).toContain('\\"gateway\\":\\"finance\\"');
  });

  it('publishes both gateways inside the one ingress document, with one context key id and no aliases (ADR-0041, ADR-0042)', () => {
    const published = resources(template, 'AWS::SSM::Parameter').filter(([, p]) => p.Properties.Name === `/application-plane/shared/agent-runtime/${PUBLISHED.ingress}`);
    expect(published).toHaveLength(1);
    const literal = (published[0][1].Properties.Value['Fn::Join'][1] as unknown[]).filter((x) => typeof x === 'string').join('');
    for (const gw of ['default', 'finance']) {
      expect(literal).toContain(`"${gw}":{"url":`);
    }
    expect(literal.match(/"toolContextKeyId":/g)).toHaveLength(1);
    expect(literal).not.toContain('toolsGatewayUrl');
  });

  it('the agent gets RI_TOOLS_GATEWAY_URLS with every gateway by name', () => {
    const runtime = resources(template, 'AWS::BedrockAgentCore::Runtime')[0][1];
    const urls = JSON.stringify(runtime.Properties.EnvironmentVariables.RI_TOOLS_GATEWAY_URLS);
    expect(urls).toContain('default');
    expect(urls).toContain('finance');
    expect(runtime.Properties.EnvironmentVariables.RI_TOOLS_GATEWAY_URL).toBeDefined();
  });

  it('passes the default-gateway resolution: a ToolTarget without gateway is on default', () => {
    expect(ingress.toolsGateways.default.targetCount).toBe(1);
    expect(ingress.toolsGateways.finance.targetCount).toBe(1);
    expect(ingress.toolsGateways.finance.toolCount).toBe(2);
  });
});

describe('several tools gateways: synth errors (ADR-0041)', () => {
  it('a ToolTarget on an unknown gateway fails synth, naming the gateways that exist', () => {
    const { stack, ingress } = twoGateways();
    expect(() => new ToolTarget(stack, 'X', { name: 'x', ingress, gateway: 'nope', kind: 'lambda', function: toolFunction(stack, 'F'), tools: tools(1) })).toThrow(
      /ToolTarget: gateway 'nope' is not a tools gateway of the ingress \(it has 'default', 'finance'/,
    );
    expect(() => new ToolTarget(stack, 'Y', { name: 'y', ingress, gateway: 'Bad Name', kind: 'lambda', function: toolFunction(stack, 'G'), tools: tools(1) })).toThrow(
      /ToolTarget: gateway must match/,
    );
  });

  it('maxToolsPerGateway exceeded by the ToolTargets on that gateway fails synth; reaching it does not', () => {
    const { stack, ingress } = twoGateways();
    new ToolTarget(stack, 'A', { name: 'a', ingress, gateway: 'finance', kind: 'lambda', function: toolFunction(stack, 'FA'), tools: tools(3) });
    new ToolTarget(stack, 'B', { name: 'b', ingress, gateway: 'finance', kind: 'lambda', function: toolFunction(stack, 'FB'), tools: tools(2) });
    expect(() => new ToolTarget(stack, 'C', { name: 'c', ingress, gateway: 'finance', kind: 'lambda', function: toolFunction(stack, 'FC'), tools: tools(1) })).toThrow(
      /ToolTarget: tools would bring tools gateway 'finance' to 6 catalogued tools with target 'c', over maxToolsPerGateway 5/,
    );
    // The other gateway keeps its own budget (default 300).
    expect(() => new ToolTarget(stack, 'D', { name: 'd', ingress, kind: 'lambda', function: toolFunction(stack, 'FD'), tools: tools(300) })).not.toThrow();
    expect(() => new ToolTarget(stack, 'E', { name: 'e', ingress, kind: 'lambda', function: toolFunction(stack, 'FE'), tools: tools(1) })).toThrow(/over maxToolsPerGateway 300/);
  });

  it('toolsGateway and toolsGateways together fail synth naming both; names and bounds are checked', () => {
    expect(() => twoGateways({ toolsGateway: {} })).toThrow(/SharedIngress: toolsGateway and toolsGateways must not both be set/);
    expect(() => twoGateways({ toolsGateways: { Bad_Name: {} } })).toThrow(/toolsGateways name 'Bad_Name' must match/);
    expect(() => twoGateways({ toolsGateways: { ['x'.repeat(33)]: {} } })).toThrow(/toolsGateways name/);
    expect(() => twoGateways({ toolsGateways: {} })).toThrow(/toolsGateways must name at least one gateway/);
    expect(() => twoGateways({ toolsGateways: { finance: { maxToolsPerGateway: 0 } } })).toThrow(/toolsGateways\.finance\.maxToolsPerGateway must be an integer from 1 to 1000/);
    expect(() => twoGateways({ toolsGateways: { finance: { maxToolsPerGateway: 1001 } } })).toThrow(/toolsGateways\.finance\.maxToolsPerGateway/);
    expect(() => twoGateways({ toolsGateways: { finance: { tenantRateLimit: { requestsPerSecond: 0 } } } })).toThrow(/toolsGateways\.finance\.tenantRateLimit/);
    expect(() => build('api-gateway', { toolsGateway: { maxToolsPerGateway: 1.5 } })).toThrow(/toolsGateway\.maxToolsPerGateway/);
  });

  it('without a gateway named default there is no toolsGateway alias and a ToolTarget must name its gateway', () => {
    const { stack, ingress } = twoGateways({ toolsGateways: { finance: {} } });
    expect(ingress.toolsGateway).toBeUndefined();
    expect(ingress.toolsGatewayUrl).toBeUndefined();
    expect(() => new ToolTarget(stack, 'X', { name: 'x', ingress, kind: 'lambda', function: toolFunction(stack, 'F'), tools: tools(1) })).toThrow(/gateway 'default' is not a tools gateway/);
    new ToolTarget(stack, 'Y', { name: 'y', ingress, gateway: 'finance', kind: 'lambda', function: toolFunction(stack, 'G'), tools: tools(1) });
    const [published] = resources(Template.fromStack(stack), 'AWS::SSM::Parameter').filter(([, p]) => p.Properties.Name === `/application-plane/shared/agent-runtime/${PUBLISHED.ingress}`);
    const literal = (published[1].Properties.Value['Fn::Join'][1] as unknown[]).filter((x) => typeof x === 'string').join('');
    expect(literal).toContain('"finance":{"url":');
    expect(literal).not.toContain('"default":{');
  });

  it('a ToolTarget in another stack names its gateway through SharedIngress.fromParameters({ toolsGateways })', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const doc = publishedIngress('api-gateway', ['default', 'finance']);
    seedPublishedIngress(app, doc);
    const stack = new Stack(app, 'Tools', { env: TEST_ENV });
    const ref = SharedIngress.fromParameters(stack, 'Ingress', '/application-plane/shared/agent-runtime/', 'api-gateway', { toolsGateways: ['default', 'finance'] });
    expect(Object.keys(ref.toolsGateways!).sort()).toEqual(['default', 'finance']);
    expect(ref.tools).toBe(ref.toolsGateways!.default);
    const target = new ToolTarget(stack, 'Inv', { name: 'invoices', ingress: ref, gateway: 'finance', kind: 'lambda', function: toolFunction(stack, 'F'), tools: tools(1) });
    expect(target.gateway).toBe('finance');
    expect(() => new ToolTarget(stack, 'X', { name: 'x', ingress: ref, gateway: 'hr', kind: 'lambda', function: toolFunction(stack, 'G'), tools: tools(1) })).toThrow(
      /gateway 'hr' is not a tools gateway of the ingress reference/,
    );
    const text = JSON.stringify(Template.fromStack(stack).toJSON());
    expect(text).toContain(doc.toolsGateways.finance.policyEngineId);
  });

  it('a ToolTarget in another stack with outbound OAuth grants GetWorkloadAccessToken on ITS gateway\'s workload identities, not every gateway\'s', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const doc = publishedIngress('api-gateway', ['default', 'finance']);
    seedPublishedIngress(app, doc);
    const stack = new Stack(app, 'Tools', { env: TEST_ENV });
    const ref = SharedIngress.fromParameters(stack, 'Ingress', '/application-plane/shared/agent-runtime/', 'api-gateway', { toolsGateways: ['default', 'finance'] });
    new ToolTarget(stack, 'Crm', {
      name: 'crm',
      ingress: ref,
      gateway: 'finance',
      kind: 'openApi',
      spec: { inlinePayload: JSON.stringify({ openapi: '3.0.1', info: { title: 'crm', version: '1' }, paths: { '/a': { get: { operationId: 'get_account' } } } }) },
      outboundAuth: {
        oauth: {
          providerArn: `arn:aws:bedrock-agentcore:${TEST_ENV.region}:${TEST_ENV.account}:token-vault/default/oauth2credentialprovider/crm`,
          secretArn: `arn:aws:secretsmanager:${TEST_ENV.region}:${TEST_ENV.account}:secret:crm-AbCdEf`,
          scopes: ['crm.read'],
          grant: 'OBO',
        },
      },
      tools: [{ name: 'get_account', description: 'Reads one account' }],
    });
    const statements = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const grant = statements.find((st: any) => [st.Action].flat().includes('bedrock-agentcore:GetWorkloadAccessToken'));
    const identities = JSON.stringify(grant.Resource);
    // `gw-finance-abc123` -> identities `gw-finance-*`; never the `*-*` of every gateway.
    expect(identities).toContain('/workload-identity/gw-finance-*');
    expect(identities).not.toContain('/workload-identity/*');
    expect(gatewayPhysicalNameOf('gw-finance-abc123')).toBe('gw-finance');
    expect(gatewayPhysicalNameOf('ri_x_tools-AbC123xYz0')).toBe('ri_x_tools');
    expect(() => gatewayPhysicalNameOf('nodash')).toThrow(/not <name>-<suffix>/);
    expect(() => gatewayPhysicalNameOf('trailing-')).toThrow(/not <name>-<suffix>/);
  });
});

describe('policyName (CreatePolicy names are unique within the account and Region)', () => {
  it('differs per stack, construct path and gateway; same input, same name', () => {
    const a = policyName('crm', 'StackA/StackA/Crm/default');
    expect(a).toMatch(/^crm_target_[0-9a-f]{8}$/);
    expect(policyName('crm', 'StackA/StackA/Crm/default')).toBe(a);
    expect(policyName('crm', 'StackB/StackB/Crm/default')).not.toBe(a);
    expect(policyName('crm', 'StackA/StackA/Crm/finance')).not.toBe(a);
  });

  it('a 32-character target name gives a valid name of at most 48 characters', () => {
    const name = policyName('a'.repeat(16) + '-' + 'b'.repeat(15), 'owner');
    expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(name.length).toBeLessThanOrEqual(48);
  });
});

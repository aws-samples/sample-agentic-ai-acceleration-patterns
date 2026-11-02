// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AgentBackend, GATEWAY_TARGET_NAME, SharedIngress, type SharedIngressProps } from '../src/index';
import { ToolTarget } from '../src/tool-target.cdk';
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
  const toolsOn = props.toolsGateway !== false;
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
    const interceptor = functionAndRole(template, 'tools gateway REQUEST interceptor');
    expect(signs[0].Principal).toEqual({ AWS: { 'Fn::GetAtt': [interceptor.role, 'Arn'] } });
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

  it('the tools gateway: CUSTOM_JWT on the ingress issuer with audience tools-gateway, MCP 2025-11-25, REQUEST interceptor, Policy ENFORCE (ADR-0034)', () => {
    const [, gateway] = resources(template, 'AWS::BedrockAgentCore::Gateway').find(([id]) => id.includes('ToolsGateway'))!;
    const p = gateway.Properties;
    expect(p.AuthorizerType).toBe('CUSTOM_JWT');
    expect(p.AuthorizerConfiguration.CustomJWTAuthorizer.AllowedAudience).toEqual(['tools-gateway']);
    expect(JSON.stringify(p.AuthorizerConfiguration.CustomJWTAuthorizer.DiscoveryUrl)).toContain('/.well-known/openid-configuration');
    expect(JSON.stringify(p.AuthorizerConfiguration.CustomJWTAuthorizer.DiscoveryUrl)).not.toContain('cognito-idp');
    expect(p.ProtocolType).toBe('MCP');
    expect(p.ProtocolConfiguration.Mcp.SupportedVersions).toContain('2025-11-25');
    expect(p.InterceptorConfigurations).toHaveLength(1);
    expect(p.InterceptorConfigurations[0].InterceptionPoints).toEqual(['REQUEST']);
    expect(p.PolicyEngineConfiguration.Mode).toBe('ENFORCE');
  });

  it('the tools interceptor knows the issuer, the context key and the context lifetime, and runs on a provisioned alias', () => {
    const { id, fn } = functionAndRole(template, 'tools gateway REQUEST interceptor');
    expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual(['RI_CONTEXT_KEY_ID', 'RI_CONTEXT_LIFETIME_SECONDS', 'RI_INGRESS_ROLE_ARN', 'RI_ISSUER']);
    expect(fn.Properties.Environment.Variables.RI_CONTEXT_LIFETIME_SECONDS).toBe('60');
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
    expect(policy.Properties.Name).toBe('crm_target');
    expect(policy.Properties.ValidationMode).toBe('FAIL_ON_ANY_FINDINGS');
  });
});

describe('v2 options', () => {
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

  it('ttl outside 60 to 900 s fails synth', () => {
    expect(() => build('api-gateway', { transactionToken: { ttl: Duration.seconds(30) } })).toThrow(/transactionToken.ttl/);
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
    expect(() => built.template()).toThrow(/toolsGateway holds at most 100 ToolTargets/);
  }, 60_000);

  it('ToolTarget kinds other than lambda fail synth (TODO(v2))', () => {
    const { stack, ingress } = build('api-gateway');
    for (const kind of ['openApi', 'smithy', 'mcpServer'] as const) {
      expect(() => new ToolTarget(stack, `K${kind}`, { name: 'k', ingress, kind })).toThrow(/is not built yet \(TODO\(v2\)\)/);
    }
    expect(() => new ToolTarget(stack, 'Bad', { name: 'Bad', ingress, kind: 'lambda' })).toThrow(/ToolTarget: name must match/);
  });
});

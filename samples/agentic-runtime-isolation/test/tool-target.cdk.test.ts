// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { GATEWAY_TARGET_NAME, SharedIngress } from '../src/index';
import {
  credentialProviderConfigurations,
  enforcesIsolation,
  FILTERED_ISOLATION_WARNING,
  openApiOperationIds,
  type OutboundAuth,
  ToolTarget,
  type ToolTargetProps,
} from '../src/tool-target.cdk';
import { POLICY_AUTHORIZE_ACTIONS, POLICY_ENGINE_READ_ACTIONS, tenantRateLimitEntries } from '../src/tools-gateway.cdk';

/**
 * `ToolTarget` kinds (spec §3.5): the target configuration and the outbound
 * credential per kind, the Gateway role's grants, and the filtered-isolation
 * warning for a non-Lambda target without a per-user grant (ADR-0034, V-10).
 */
const DISCOVERY_URL = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00/.well-known/openid-configuration';
const OAUTH_PROVIDER = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:token-vault/default/oauth2credentialprovider/crm-idp';
const KEY_PROVIDER = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:token-vault/default/apikeycredentialprovider/weather';
const SECRET = 'arn:aws:secretsmanager:eu-central-1:111122223333:secret:provider-AbCdEf';
const OPENAPI = JSON.stringify({
  openapi: '3.0.1',
  info: { title: 'crm', version: '1' },
  paths: { '/accounts/{id}': { get: { operationId: 'get_account' } }, '/cases': { get: { operationId: 'list_cases' } } },
});
const TOOLS = [
  { name: 'get_account', description: 'Reads one account' },
  { name: 'list_cases', description: 'Lists cases' },
];

function setup() {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
  const ingress = new SharedIngress(stack, 'Ingress', {
    ingress: 'api-gateway',
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'] },
    defaultBackend: GATEWAY_TARGET_NAME,
  });
  return { stack, ingress };
}

function target(props: Partial<ToolTargetProps> & Pick<ToolTargetProps, 'kind'>) {
  const { stack, ingress } = setup();
  const t = new ToolTarget(stack, 'Target', { name: 'ext', ingress, tools: TOOLS, ...props } as ToolTargetProps);
  return { stack, t, template: Template.fromStack(stack) };
}

function gatewayTarget(template: Template): any {
  return Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget'))[0].Properties;
}

function gatewayRoleStatements(template: Template): any[] {
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((p: any) =>
    JSON.stringify(p.Properties.Roles ?? []).includes('ToolsGatewayGatewayRole'),
  );
  return policies.flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

const oauth = (grant: '3LO' | 'OBO' | 'M2M'): OutboundAuth => ({ oauth: { providerArn: OAUTH_PROVIDER, secretArn: SECRET, scopes: ['crm.read'], grant } });

describe('ToolTarget kind openApi', () => {
  it('3LO: mcp.openApiSchema inline, an OAUTH provider with AUTHORIZATION_CODE, enforced isolation, no warning', () => {
    const { stack, t, template } = target({ kind: 'openApi', spec: { inlinePayload: OPENAPI }, outboundAuth: oauth('3LO') });
    const props = gatewayTarget(template);
    expect(props.TargetConfiguration).toEqual({ Mcp: { OpenApiSchema: { InlinePayload: OPENAPI } } });
    expect(props.CredentialProviderConfigurations).toEqual([
      { CredentialProviderType: 'OAUTH', CredentialProvider: { OauthCredentialProvider: { ProviderArn: OAUTH_PROVIDER, Scopes: ['crm.read'], GrantType: 'AUTHORIZATION_CODE' } } },
    ]);
    expect(t.isolation).toBe('enforced');
    Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('filtered isolation'));
    // No Lambda: no invoke grant, no context-key env.
    expect(JSON.stringify(gatewayRoleStatements(template))).not.toContain('lambda:InvokeFunction"],"Effect":"Allow","Resource":{"Fn::GetAtt":["Target');
  });

  it('the Gateway role reads the workload token, the provider token and the provider secret, nothing wider', () => {
    const { template } = target({ kind: 'openApi', spec: { inlinePayload: OPENAPI }, outboundAuth: oauth('OBO') });
    const statements = gatewayRoleStatements(template);
    const actionsOf = (a: string) => statements.find((s) => [s.Action].flat().includes(a));
    expect(actionsOf('bedrock-agentcore:GetResourceOauth2Token').Resource).toBe(OAUTH_PROVIDER);
    expect(actionsOf('secretsmanager:GetSecretValue').Resource).toBe(SECRET);
    expect(JSON.stringify(actionsOf('bedrock-agentcore:GetWorkloadAccessToken').Resource)).toContain('workload-identity-directory/default/workload-identity/');
    expect(gatewayTarget(template).CredentialProviderConfigurations[0].CredentialProvider.OauthCredentialProvider.GrantType).toBe('TOKEN_EXCHANGE');
  });

  it('M2M or an API key is filtered isolation: synth warns runtime-isolation:filtered-isolation naming the target', () => {
    for (const outboundAuth of [oauth('M2M'), { apiKey: { providerArn: KEY_PROVIDER, secretArn: SECRET, location: 'HEADER', name: 'x-api-key' } } as OutboundAuth]) {
      const { stack, t } = target({ kind: 'openApi', spec: { inlinePayload: OPENAPI }, outboundAuth });
      expect(t.isolation).toBe('filtered');
      const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp("ToolTarget 'ext' \\(openApi\\) has filtered isolation"));
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings[0].entry.data)).toContain(FILTERED_ISOLATION_WARNING);
    }
  });

  it('an API key: API_KEY provider with location, parameter name and prefix', () => {
    const auth: OutboundAuth = { apiKey: { providerArn: KEY_PROVIDER, secretArn: SECRET, location: 'QUERY_PARAMETER', name: 'key', prefix: 'Key' } };
    expect(credentialProviderConfigurations('openApi', auth)).toEqual([
      {
        credentialProviderType: 'API_KEY',
        credentialProvider: { apiKeyCredentialProvider: { providerArn: KEY_PROVIDER, credentialLocation: 'QUERY_PARAMETER', credentialParameterName: 'key', credentialPrefix: 'Key' } },
      },
    ]);
  });

  it('an S3 spec: mcp.openApiSchema.s3 and s3:GetObject on that object for the Gateway role', () => {
    const { template } = target({ kind: 'openApi', spec: { s3Uri: 's3://specs-bucket/crm/openapi.json' }, outboundAuth: oauth('3LO') });
    expect(gatewayTarget(template).TargetConfiguration.Mcp.OpenApiSchema).toEqual({ S3: { Uri: 's3://specs-bucket/crm/openapi.json' } });
    const s3 = gatewayRoleStatements(template).find((s) => s.Action === 's3:GetObject');
    expect(JSON.stringify(s3.Resource)).toContain(':s3:::specs-bucket/crm/openapi.json');
  });

  it('refuses a tool that is not an operationId, no spec, two spec sources, no outbound auth, and SigV4 without a service', () => {
    expect(() => target({ kind: 'openApi', spec: { inlinePayload: OPENAPI }, outboundAuth: oauth('3LO'), tools: [{ name: 'void_case', description: 'x' }] })).toThrow(
      /tools name 'void_case' is not an operationId/,
    );
    expect(() => target({ kind: 'openApi', outboundAuth: oauth('3LO') })).toThrow(/ToolTarget: spec is required/);
    expect(() => target({ kind: 'openApi', spec: { inlinePayload: OPENAPI, s3Uri: 's3://b-b/k' }, outboundAuth: oauth('3LO') })).toThrow(/exactly one of inlinePayload and s3Uri/);
    expect(() => target({ kind: 'openApi', spec: { inlinePayload: OPENAPI } })).toThrow(/outboundAuth is required with kind 'openApi'/);
    expect(() => target({ kind: 'openApi', spec: { inlinePayload: OPENAPI }, outboundAuth: { gatewayIamRole: {} } })).toThrow(/gatewayIamRole.service/);
    expect(() => target({ kind: 'openApi', spec: { inlinePayload: OPENAPI }, outboundAuth: { ...oauth('3LO'), apiKey: {} } as never })).toThrow(/exactly one of/);
  });
});

describe('ToolTarget kind smithy', () => {
  it('mcp.smithyModel with GATEWAY_IAM_ROLE and no SigV4 provider; filtered (vendor-shared role)', () => {
    const model = JSON.stringify({ smithy: '2.0', shapes: {} });
    const { stack, t, template } = target({ kind: 'smithy', spec: { inlinePayload: model }, outboundAuth: { gatewayIamRole: {} } });
    const props = gatewayTarget(template);
    expect(props.TargetConfiguration).toEqual({ Mcp: { SmithyModel: { InlinePayload: model } } });
    expect(props.CredentialProviderConfigurations).toEqual([{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }]);
    expect(t.isolation).toBe('filtered');
    expect(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp("'ext' \\(smithy\\) has filtered isolation"))).toHaveLength(1);
  });

  it('accepts only an M2M OAuth grant, refuses an API key and a SigV4 service', () => {
    const model = JSON.stringify({ smithy: '2.0', shapes: {} });
    expect(() => target({ kind: 'smithy', spec: { inlinePayload: model }, outboundAuth: oauth('3LO') })).toThrow(/oauth.grant must be 'M2M' with kind 'smithy'/);
    expect(() =>
      target({ kind: 'smithy', spec: { inlinePayload: model }, outboundAuth: { apiKey: { providerArn: KEY_PROVIDER, secretArn: SECRET, location: 'HEADER', name: 'k' } } }),
    ).toThrow(/apiKey is not supported with kind 'smithy'/);
    expect(() => target({ kind: 'smithy', spec: { inlinePayload: model }, outboundAuth: { gatewayIamRole: { service: 'dynamodb' } } })).toThrow(/takes no service/);
    expect(() => target({ kind: 'smithy', spec: { inlinePayload: model }, outboundAuth: oauth('M2M') })).not.toThrow();
  });
});

describe('ToolTarget kind mcpServer', () => {
  it('mcp.mcpServer at the endpoint; OBO is enforced', () => {
    const { t, template } = target({ kind: 'mcpServer', endpoint: 'https://mcp.example.com/mcp', outboundAuth: oauth('OBO') });
    expect(gatewayTarget(template).TargetConfiguration).toEqual({ Mcp: { McpServer: { Endpoint: 'https://mcp.example.com/mcp' } } });
    expect(t.isolation).toBe('enforced');
  });

  it('SigV4 with the Gateway role carries an iamCredentialProvider; filtered', () => {
    const { stack, template } = target({ kind: 'mcpServer', endpoint: 'https://mcp.example.com/mcp', outboundAuth: { gatewayIamRole: { service: 'bedrock-agentcore', region: 'eu-west-1' } } });
    expect(gatewayTarget(template).CredentialProviderConfigurations).toEqual([
      { CredentialProviderType: 'GATEWAY_IAM_ROLE', CredentialProvider: { IamCredentialProvider: { Service: 'bedrock-agentcore', Region: 'eu-west-1' } } },
    ]);
    expect(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp("'ext' \\(mcpServer\\) has filtered isolation"))).toHaveLength(1);
  });

  it('refuses a missing or non-https endpoint, and the props of other kinds', () => {
    expect(() => target({ kind: 'mcpServer', outboundAuth: oauth('OBO') })).toThrow(/endpoint must be the MCP server's https URL/);
    expect(() => target({ kind: 'mcpServer', endpoint: 'http://mcp.example.com', outboundAuth: oauth('OBO') })).toThrow(/endpoint must be/);
    expect(() => target({ kind: 'mcpServer', endpoint: 'https://mcp.example.com', outboundAuth: oauth('OBO'), spec: { inlinePayload: '{}' } })).toThrow(/spec is for kinds/);
    const { stack } = setup();
    const fn = new lambda.Function(stack, 'F', { runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('x') });
    expect(() => target({ kind: 'mcpServer', endpoint: 'https://m.example.com', outboundAuth: oauth('OBO'), function: fn })).toThrow(/function is for kind 'lambda' only/);
  });
});

describe('ToolTarget kind lambda', () => {
  it('needs an inputSchema per tool and accepts no outbound auth but the Gateway role', () => {
    const { stack, ingress } = setup();
    const fn = new lambda.Function(stack, 'F', { runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('x') });
    expect(() => new ToolTarget(stack, 'A', { name: 'a', ingress, kind: 'lambda', function: fn, tools: TOOLS })).toThrow(/needs an inputSchema with kind 'lambda'/);
    expect(() => new ToolTarget(stack, 'B', { name: 'b', ingress, kind: 'lambda', function: fn, tools: [{ ...TOOLS[0], inputSchema: {} }], outboundAuth: oauth('3LO') })).toThrow(
      /oauth is not supported with kind 'lambda'/,
    );
    const ok = new ToolTarget(stack, 'C', { name: 'c', ingress, kind: 'lambda', function: fn, tools: [{ ...TOOLS[0], inputSchema: {} }] });
    expect(ok.isolation).toBe('enforced');
    expect(enforcesIsolation('lambda', undefined)).toBe(true);
  });

  it('every kind writes the gateway count row and passes the deploy-time bound to its reservation (ADR-0041)', () => {
    const { template } = target({ kind: 'openApi', spec: { inlinePayload: OPENAPI }, outboundAuth: oauth('3LO') });
    const [reservation] = Object.values(template.findResources('Custom::RuntimeIsolationOwnedRows')) as any[];
    expect(reservation.Properties.GatewayLimit).toEqual({ Gateway: 'default', Target: 'ext', Tools: '2', MaxTools: '300', MaxTargets: '100' });
    expect(reservation.Properties.Rows).toEqual(expect.arrayContaining([{ PK: 'GATEWAY#default', SK: 'TARGET#ext', attributes: { tools: '2' } }]));
  });
});

describe('openApiOperationIds', () => {
  it('reads the operation ids of a JSON document; anything else is unknown', () => {
    expect([...openApiOperationIds(OPENAPI)!].sort()).toEqual(['get_account', 'list_cases']);
    expect(openApiOperationIds('openapi: 3.0.1')).toBeUndefined();
  });
});

describe('tools gateway role and rate limit (spec §3.6, M-58, M-60)', () => {
  it('the Gateway role holds the three documented Policy actions, not bedrock-agentcore:*', () => {
    const { template } = target({ kind: 'mcpServer', endpoint: 'https://mcp.example.com/mcp', outboundAuth: oauth('OBO') });
    const statements = gatewayRoleStatements(template);
    const read = statements.find((s) => s.Sid === 'ReadPolicyEngine');
    const authorize = statements.find((s) => s.Sid === 'AuthorizeWithPolicyEngine');
    expect(read.Action).toEqual(POLICY_ENGINE_READ_ACTIONS[0]);
    expect(authorize.Action).toEqual([...POLICY_AUTHORIZE_ACTIONS]);
    expect(authorize.Resource).toHaveLength(2);
    expect(JSON.stringify(authorize.Resource[1])).toContain(':gateway/');
    expect(JSON.stringify(statements)).not.toContain('bedrock-agentcore:*');
  });

  it('the policy writer may GetGateway, InvokeGateway, ListGatewayTargets and ManageResourceScopedPolicy on its gateway only (CreatePolicy validation)', () => {
    const { template } = target({ kind: 'mcpServer', endpoint: 'https://mcp.example.com/mcp', outboundAuth: oauth('OBO') });
    const statement = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .find((s: any) => s.Sid === 'ValidatePoliciesOnOneGateway');
    expect(statement.Action).toEqual([
      'bedrock-agentcore:GetGateway',
      'bedrock-agentcore:InvokeGateway',
      'bedrock-agentcore:ListGatewayTargets',
      'bedrock-agentcore:ManageResourceScopedPolicy',
    ]);
    expect(JSON.stringify(statement.Resource)).toContain('GatewayArn');
  });

  it('rate-limit entries: the documented $.context.jwt.tenant_id dimension, a * default, one entry per override, per second', () => {
    expect(tenantRateLimitEntries(10, { 't-big': 50 })).toEqual([
      { dimensions: { '$.context.jwt.tenant_id': '*' }, requests: [{ period: 'second', rate: 10 }] },
      { dimensions: { '$.context.jwt.tenant_id': 't-big' }, requests: [{ period: 'second', rate: 50 }] },
    ]);
  });
});

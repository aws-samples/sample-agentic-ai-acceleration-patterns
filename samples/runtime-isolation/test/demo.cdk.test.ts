// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import {
  AGENT_RUNTIME_PARAMETERS,
  dashboardName,
  DEFAULT_MODEL_ID,
  DemoContext,
  IDENTITY_PARAMETERS,
  meteredCostMetrics,
  parseDemoContext,
  PLACEHOLDER,
  RuntimeIsolationDemoStack,
  tenantSearchExpression,
} from '../src/demo.cdk';
import { COST_METRIC_NAMES } from '../src/shared/metrics';

/** The thin demo stack (spec C-4, §6.4): consumes tenant-identity's parameters, publishes its own, wires the TVM demo. */
const FIXTURE_AGENT = path.join(__dirname, 'fixtures', 'agent');

const context = (overrides: Partial<DemoContext> = {}): DemoContext => ({
  ingress: 'api-gateway',
  forwardUserToken: false,
  requireNarrowedToken: false,
  tvm: false,
  includeUserIdTag: false,
  modelId: DEFAULT_MODEL_ID,
  identityParameterPlaceholders: false,
  ...overrides,
});

function synth(ctx: DemoContext, publishParameters?: boolean, withNag = false): { template: Template; stack: RuntimeIsolationDemoStack } {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  if (withNag) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  }
  const stack = new RuntimeIsolationDemoStack(app, `RuntimeIsolation-${ctx.ingress}`, {
    context: ctx,
    agentCodePath: FIXTURE_AGENT,
    publishParameters,
    env: { account: '111122223333', region: 'eu-central-1' },
  });
  return { template: Template.fromStack(stack), stack };
}

/** A template string that may be an Fn::Join of literals and refs, as one string (refs become their logical id). */
function flatten(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const join = (value as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
  if (join !== undefined) {
    return join[1].map((part) => (typeof part === 'string' ? part : JSON.stringify(part).replace(/"/g, ''))).join(join[0]);
  }
  return JSON.stringify(value);
}

describe('parseDemoContext (fail-fast, standard §4.3)', () => {
  const read = (values: Record<string, unknown>) => (key: string) => values[key];

  it('requires ingress and names it', () => {
    expect(() => parseDemoContext(read({}))).toThrow(/'ingress' is required/);
    expect(() => parseDemoContext(read({ ingress: 'alb' }))).toThrow(/'ingress'/);
  });

  it('defaults every module off', () => {
    expect(parseDemoContext(read({ ingress: 'agentcore-gateway' }))).toEqual(context({ ingress: 'agentcore-gateway' }));
  });

  it('parses every option', () => {
    expect(
      parseDemoContext(
        read({
          ingress: 'api-gateway',
          session: 'tenant',
          requiredScopes: 'tenant-api/read, tenant-api/write',
          forwardUserToken: 'true',
          requireNarrowedToken: true,
          allowedScopes: 'tenant-api/read',
          tvm: 'true',
          includeUserIdTag: 'true',
          modelId: 'amazon.nova-micro-v1:0',
          identityParameterPlaceholders: 'true',
        }),
      ),
    ).toEqual({
      ingress: 'api-gateway',
      sessionScope: 'tenant',
      requiredScopes: ['tenant-api/read', 'tenant-api/write'],
      forwardUserToken: true,
      requireNarrowedToken: true,
      allowedScopes: ['tenant-api/read'],
      tvm: true,
      includeUserIdTag: true,
      modelId: 'amazon.nova-micro-v1:0',
      identityParameterPlaceholders: true,
    });
  });

  it('session accepts user, tenant, off; refuses anything else by name', () => {
    expect(parseDemoContext(read({ ingress: 'api-gateway', session: 'off' })).sessionScope).toBeUndefined();
    expect(parseDemoContext(read({ ingress: 'api-gateway', session: 'user' })).sessionScope).toBe('user');
    expect(() => parseDemoContext(read({ ingress: 'api-gateway', session: 'global' }))).toThrow(/'session'/);
  });

  it('flags must be true or false', () => {
    expect(() => parseDemoContext(read({ ingress: 'api-gateway', tvm: 'yes' }))).toThrow(/'tvm'/);
    expect(() => parseDemoContext(read({ ingress: 'api-gateway', modelId: '' }))).toThrow(/'modelId'/);
  });
});

describe('RuntimeIsolationDemoStack', () => {
  it('reads tenant-identity\'s parameters at deploy time and builds the discovery URL from them (ADR-0004)', () => {
    const { template } = synth(context());
    const params = template.toJSON().Parameters as Record<string, any>;
    const ssmParams = Object.values(params).filter((p) => p.Type === 'AWS::SSM::Parameter::Value<String>');
    expect(ssmParams.map((p) => p.Default)).toEqual(expect.arrayContaining([IDENTITY_PARAMETERS.userPoolId, IDENTITY_PARAMETERS.appClientId]));
    const text = JSON.stringify(template.toJSON());
    expect(text).toContain('cognito-idp.');
    expect(text).toContain('/.well-known/openid-configuration');
    expect(text).not.toContain(PLACEHOLDER.userPoolId);
    expect(template.toJSON().Rules).not.toHaveProperty('RefusePlaceholderDeployment');
  });

  it('with placeholders: no SSM lookups, and a CloudFormation rule that refuses the deployment (standard §4.3)', () => {
    const { template } = synth(context({ identityParameterPlaceholders: true }));
    const params = Object.values((template.toJSON().Parameters ?? {}) as Record<string, any>);
    expect(params.filter((p) => String(p.Default).startsWith('/application-plane/'))).toHaveLength(0);
    expect(JSON.stringify(template.toJSON())).toContain(PLACEHOLDER.userPoolId);
    expect(JSON.stringify(template.toJSON())).toContain(PLACEHOLDER.appClientId);
    const rule = template.toJSON().Rules.RefusePlaceholderDeployment;
    expect(rule.Assertions[0].Assert).toEqual({ 'Fn::Equals': ['build-placeholder', 'deployable'] });
  });

  it('publishes the three parameters under /application-plane/shared/agent-runtime/ (spec §6.4)', () => {
    const { template } = synth(context({ ingress: 'agentcore-gateway' }));
    template.resourceCountIs('AWS::SSM::Parameter', 3);
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: AGENT_RUNTIME_PARAMETERS.endpointUrl, Type: 'String' });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: AGENT_RUNTIME_PARAMETERS.runtimeArn, Type: 'String' });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: AGENT_RUNTIME_PARAMETERS.ingress, Value: 'agentcore-gateway' });
  });

  it('publishParameters=false writes none', () => {
    synth(context(), false).template.resourceCountIs('AWS::SSM::Parameter', 0);
  });

  it('api-gateway: Contributor Insights rules on the access log keyed by tenantId (P-9) and on the ingress EMF log by TenantId (P-10)', () => {
    const { template } = synth(context());
    template.resourceCountIs('AWS::CloudWatch::InsightRule', 4);
    const rules = Object.values(template.findResources('AWS::CloudWatch::InsightRule')) as any[];
    const bodies = rules.map((r) => ({ name: r.Properties.RuleName as string, body: JSON.parse(flatten(r.Properties.RuleBody)) }));
    const access = bodies.filter((b) => b.body.Contribution.Keys[0] === '$.tenantId');
    expect(access).toHaveLength(2);
    for (const rule of access) {
      expect(rule.body.AggregateOn).toBe('Count');
      expect(rule.body.LogGroupNames[0]).toContain('ApiAccessLogs');
    }
    // The cost rules read the ingress Lambda's log group (where the EMF records are) and SUM the metric field.
    const cost = bodies.filter((b) => b.body.Contribution.Keys[0] === '$.TenantId');
    expect(cost.map((c) => c.body.Contribution.ValueOf).sort()).toEqual(['$.BackendInvokeSeconds', '$.ModelOutputTokens']);
    for (const rule of cost) {
      expect(rule.body.AggregateOn).toBe('Sum');
      expect(rule.body.LogGroupNames[0]).toContain('IngressLogs');
      expect(rule.body.Contribution.Filters).toEqual([{ Match: rule.body.Contribution.ValueOf, IsPresent: true }]);
    }
    expect(cost.map((c) => c.name).sort()).toEqual([
      'RuntimeIsolation-api-gateway-top-tenants-backend-seconds',
      'RuntimeIsolation-api-gateway-top-tenants-output-tokens',
    ]);
    synth(context({ ingress: 'agentcore-gateway' })).template.resourceCountIs('AWS::CloudWatch::InsightRule', 0);
  });

  describe('cost dashboard (P-10, ADR-0017)', () => {
    const dashboardOf = (template: Template) => {
      const [resource] = Object.values(template.findResources('AWS::CloudWatch::Dashboard')) as any[];
      const body = JSON.parse(flatten(resource.Properties.DashboardBody));
      const graphs = (body.widgets as any[]).filter((w) => w.type === 'metric');
      const texts = (body.widgets as any[]).filter((w) => w.type === 'text').map((w) => w.properties.markdown as string);
      return { resource, graphs, texts };
    };

    it('api-gateway: RuntimeIsolation-api-gateway with one SEARCH widget per cost metric over the TenantId dimension', () => {
      const { template } = synth(context());
      template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: dashboardName('api-gateway') });
      const { graphs, texts } = dashboardOf(template);
      expect(COST_METRIC_NAMES).toEqual(['Requests', 'IngressDurationMs', 'BackendInvokeSeconds', 'ModelInputTokens', 'ModelOutputTokens', 'StreamedBytes']);
      expect(graphs.map((g) => g.properties.title)).toEqual(COST_METRIC_NAMES.map((n) => `${n} by tenant`));
      for (const [i, name] of COST_METRIC_NAMES.entries()) {
        const [[metric]] = graphs[i].properties.metrics;
        expect(metric.expression).toBe(tenantSearchExpression(name, 'api-gateway'));
        expect(metric.expression).toContain('{RuntimeIsolation,TenantId,Ingress}');
        expect(metric.expression).toContain(`MetricName="${name}"`);
        expect(metric.expression).toContain('Ingress="api-gateway"');
        expect(graphs[i].properties.stat).toBe('Sum');
      }
      expect(texts.join('\n')).toContain('Cost per tenant');
      expect(texts.join('\n')).not.toContain('Not metered on this ingress');
    });

    it('agentcore-gateway: the two request-side widgets and a note on the four the interceptor cannot meter', () => {
      const { template } = synth(context({ ingress: 'agentcore-gateway' }));
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: dashboardName('agentcore-gateway') });
      const { graphs, texts } = dashboardOf(template);
      expect(meteredCostMetrics('agentcore-gateway')).toEqual(['Requests', 'IngressDurationMs']);
      expect(graphs.map((g) => g.properties.title)).toEqual(['Requests by tenant', 'IngressDurationMs by tenant']);
      expect(graphs[0].properties.metrics[0][0].expression).toContain('Ingress="agentcore-gateway"');
      const note = texts.find((t) => t.includes('Not metered on this ingress'))!;
      expect(note).toBeDefined();
      for (const absent of ['BackendInvokeSeconds', 'ModelInputTokens', 'ModelOutputTokens', 'StreamedBytes']) {
        expect(note).toContain(absent);
      }
      expect(note).toContain('ADR-0009');
    });

    it('the dashboard is not retained on delete', () => {
      const { resource } = dashboardOf(synth(context()).template);
      expect(resource.DeletionPolicy).not.toBe('Retain');
    });
  });

  it('without tvm (no demo tenant data): no table, no demo TenantRole, but the construct\'s default model-only role and a TenantRoleArn output', () => {
    const { template, stack } = synth(context());
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 0);
    expect(stack.table).toBeUndefined();
    expect(stack.tenantRole).toBeUndefined();
    // The demo stack creates no data-bearing TenantRole of its own (only the construct's default model role exists).
    const roleDescriptions = (Object.values(template.findResources('AWS::IAM::Role')) as any[]).map((r) => String(r.Properties.Description ?? ''));
    expect(roleDescriptions.some((d) => d.includes('ABAC on the demo table'))).toBe(false);
    // The construct's default role is present and model-only (ADR-0018).
    const role = Object.values(template.findResources('AWS::IAM::Role', { Properties: { Description: Match.stringLikeRegexp('Default tenant role') } }))[0] as any;
    expect(role).toBeDefined();
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
    const model = policies.flatMap((p) => p.Properties.PolicyDocument.Statement).find((s: any) => s.Sid === 'OneModel');
    expect(model.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    // TenantRoleArn is always output; DemoTableName is not, with no demo table.
    const outputs = Object.keys(template.toJSON().Outputs);
    expect(outputs).toContain('TenantRoleArn');
    expect(outputs).not.toContain('DemoTableName');
  });

  describe.each(['api-gateway', 'agentcore-gateway'] as const)('tvm on, ingress=%s', (ingress) => {
    const { template, stack } = synth(context({ ingress, tvm: true }));

    it('creates the demo table with DESTROY and PITR', () => {
      template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
      template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
      template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }],
        Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
      });
    });

    it('the tenant role trusts only tvmCallerRole, requires the TenantId request tag and pins the tag keys (spec §6.1)', () => {
      const role = Object.values(template.findResources('AWS::IAM::Role', { Properties: { Description: Match.stringLikeRegexp('Tenant role') } }))[0] as any;
      const statements = role.Properties.AssumeRolePolicyDocument.Statement;
      expect(statements).toHaveLength(1);
      const [trust] = statements;
      expect(trust.Action).toEqual(['sts:AssumeRole', 'sts:TagSession']);
      expect(trust.Principal).toEqual({ AWS: stack.resolve(stack.runtime.tvmCallerRole.roleArn) });
      expect(trust.Condition).toEqual({
        'StringLike': { 'aws:RequestTag/TenantId': '?*' },
        'ForAllValues:StringEquals': { 'aws:TagKeys': ['TenantId'] },
      });
      expect(role.Properties.MaxSessionDuration).toBe(3600);
    });

    it('the tenant role reads only its own partition: dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/TenantId} (P-8)', () => {
      const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
      const abac = policies.flatMap((p) => p.Properties.PolicyDocument.Statement).find((s: any) => s.Sid === 'OwnTenantPartitionOnly');
      expect(abac.Action).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
      expect(abac.Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/TenantId}'] } });
      expect(abac.Resource).toEqual(stack.resolve(stack.table!.tableArn));
    });

    it('the agent learns the table name and the model id through its environment; the execution role still has no table access', () => {
      template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
        EnvironmentVariables: { TABLE_NAME: stack.resolve(stack.table!.tableName), MODEL_ID: DEFAULT_MODEL_ID },
      });
      const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
      const exec = policies.filter((p) => JSON.stringify(p.Properties.Roles).includes('ExecutionRole'));
      expect(JSON.stringify(exec)).not.toContain('dynamodb');
    });

    it('with includeUserIdTag the tag keys are TenantId and UserId', () => {
      const t = synth(context({ ingress, tvm: true, includeUserIdTag: true })).template;
      const role = Object.values(t.findResources('AWS::IAM::Role', { Properties: { Description: Match.stringLikeRegexp('Tenant role') } }))[0] as any;
      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual(['TenantId', 'UserId']);
    });

    it('outputs name the tenant role and the table', () => {
      const outputs = Object.keys(template.toJSON().Outputs);
      expect(outputs).toEqual(expect.arrayContaining(['EndpointUrl', 'RuntimeArn', 'Ingress', 'IngressRoleArn', 'TvmCallerRoleArn', 'TenantRoleArn', 'DemoTableName']));
    });
  });

  it.each(['api-gateway', 'agentcore-gateway'] as const)('passes cdk-nag with every option on, ingress=%s', (ingress) => {
    expect(() =>
      synth(
        context({
          ingress,
          sessionScope: 'user',
          requiredScopes: ['tenant-api/read'],
          forwardUserToken: true,
          requireNarrowedToken: true,
          allowedScopes: ['tenant-api/read'],
          tvm: true,
          includeUserIdTag: true,
          identityParameterPlaceholders: true,
        }),
        true,
        true,
      ).template.toJSON(),
    ).not.toThrow();
  });
});

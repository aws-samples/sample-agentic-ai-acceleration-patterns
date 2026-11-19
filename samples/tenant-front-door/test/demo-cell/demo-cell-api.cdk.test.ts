// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Stack, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CellRouteAccess } from '../../src/demo-cell/cell-route-access.cdk';
import { DemoCellApi, type DemoCellApiProps } from '../../src/demo-cell/demo-cell-api.cdk';
import { CELL_API_ENV } from '../../src/demo-cell/env';
import { paramCellCopy } from '../../src/shared/contracts';

const DISTRIBUTION_ARN = 'arn:aws:cloudfront::111122223333:distribution/E2EXAMPLE1234';
const BASE: DemoCellApiProps = {
  issuer: { issuer: 'https://issuer.example.com/pool', jwksUrl: 'https://issuer.example.com/pool/.well-known/jwks.json', clientIds: ['spa-client'] },
  applicationId: 'demo',
  cellId: 'cell-a',
};

function synth(props: Partial<DemoCellApiProps> = {}, withNag = false): { template: Template; api: DemoCellApi; stack: Stack } {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  if (withNag) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  }
  const stack = new Stack(app, 'Cell', { env: { account: '444455556666', region: 'eu-central-1' } });
  const api = new DemoCellApi(stack, 'CellApi', { ...BASE, ...props });
  return { template: Template.fromStack(stack), api, stack };
}

function permissions(template: Template): Record<string, any> {
  return template.findResources('AWS::Lambda::Permission');
}

describe('DemoCellApi: function URL (spec §3.1 Cell API origin, ADR-0011)', () => {
  test('has AuthType AWS_IAM and no public access', () => {
    const { template } = synth({ distributionArn: DISTRIBUTION_ARN });
    template.resourceCountIs('AWS::Lambda::Url', 1);
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
    for (const p of Object.values(permissions(template))) {
      expect(p.Properties.Principal).toBe('cloudfront.amazonaws.com');
      expect(p.Properties.SourceArn).toBeDefined();
      expect(p.Properties.FunctionUrlAuthType ?? 'AWS_IAM').toBe('AWS_IAM');
    }
    expect(Object.keys(permissions(template))).toHaveLength(2);
  });

  test('apiDomain is the function URL host, for the frontDoorApiDomain output (§5.2)', () => {
    const { api, stack } = synth({ distributionArn: DISTRIBUTION_ARN });
    expect(stack.resolve(api.apiDomain)).toEqual({
      'Fn::Select': [2, { 'Fn::Split': ['/', { 'Fn::GetAtt': [expect.stringMatching(/^CellApiFunctionFunctionUrl/), 'FunctionUrl'] }] }],
    });
  });

  test('the function gets the issuer, the claim, the application, the cell and the limit in its environment', () => {
    const { template } = synth({ distributionArn: DISTRIBUTION_ARN, tenantClaim: 'custom:tenant' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Environment: {
        Variables: {
          [CELL_API_ENV.issuer]: BASE.issuer.issuer,
          [CELL_API_ENV.jwksUrl]: BASE.issuer.jwksUrl,
          [CELL_API_ENV.allowedClientIds]: 'spa-client',
          [CELL_API_ENV.tenantClaim]: 'custom:tenant',
          [CELL_API_ENV.applicationId]: 'demo',
          [CELL_API_ENV.cellId]: 'cell-a',
          [CELL_API_ENV.tenantRequestsPer5Min]: '2000',
          [CELL_API_ENV.limitTable]: Match.anyValue(),
        },
      },
    });
  });

  test('tenantClaim defaults to tenant_id (§3.6)', () => {
    const { template } = synth({ distributionArn: DISTRIBUTION_ARN });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ [CELL_API_ENV.tenantClaim]: 'tenant_id' }) },
    });
  });
});

describe('CellRouteAccess (spec §5.2, ADR-0011, spike S-3)', () => {
  test('grants cloudfront.amazonaws.com InvokeFunctionUrl and InvokeFunction, both conditioned on the distribution ARN', () => {
    const { template } = synth({ distributionArn: DISTRIBUTION_ARN });
    const fn = { 'Fn::GetAtt': [Match.stringLikeRegexp('^CellApiFunction'), 'Arn'] };
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: 'cloudfront.amazonaws.com',
      SourceArn: DISTRIBUTION_ARN,
      FunctionUrlAuthType: 'AWS_IAM',
      FunctionName: fn,
    });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'cloudfront.amazonaws.com',
      SourceArn: DISTRIBUTION_ARN,
      InvokedViaFunctionUrl: true,
      FunctionName: fn,
    });
  });

  test('reads the ARN from the cell-account copy parameter when no distributionArn is given (§6.4)', () => {
    const { template } = synth();
    const params = template.toJSON().Parameters as Record<string, { Type: string; Default: string }>;
    const [name] = Object.entries(params).find(([, p]) => p.Default === paramCellCopy('demo')) ?? [];
    expect(name).toBeDefined();
    expect(params[name!].Type).toBe('AWS::SSM::Parameter::Value<String>');
    const sourceArns = Object.values(permissions(template)).map((p) => p.Properties.SourceArn);
    expect(sourceArns).toEqual([
      { 'Fn::Select': [3, { 'Fn::Split': ['"', { Ref: name }] }] },
      { 'Fn::Select': [3, { 'Fn::Split': ['"', { Ref: name }] }] },
    ]);
  });

  test('the field it selects is distributionArn in the CellCopyParameter JSON', () => {
    const value = JSON.stringify({ distributionArn: DISTRIBUTION_ARN });
    expect(value.split('"')[3]).toBe(DISTRIBUTION_ARN);
  });

  test('refuses a literal that is not a distribution ARN, and a construct with neither source', () => {
    const stack = new Stack(new App());
    const fn = lambda.Function.fromFunctionArn(stack, 'Fn', 'arn:aws:lambda:eu-central-1:444455556666:function:cell');
    const tenantArn = 'arn:aws:cloudfront::111122223333:distribution-tenant/dt_1';
    expect(() => new CellRouteAccess(stack, 'A', { function: fn, distributionArn: tenantArn })).toThrow(/distributionArn/);
    expect(() => new CellRouteAccess(stack, 'B', { function: fn })).toThrow(/set distributionArn, or applicationId/);
    expect(() => new CellRouteAccess(stack, 'C', { function: fn, applicationId: 'a/b' })).toThrow(/applicationId/);
    const ok = new CellRouteAccess(stack, 'D', { function: fn, distributionArn: DISTRIBUTION_ARN });
    expect(ok.distributionArn).toBe(DISTRIBUTION_ARN);
  });
});

describe('DemoCellApi: per-tenant rate table (spec §3.6, ADR-0009)', () => {
  test('has PITR, a TTL and the tenant-partitioned key', () => {
    const { template } = synth({ distributionArn: DISTRIBUTION_ARN });
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
  });

  test('a limit of 0 creates no table and sets no table variable', () => {
    const { template, api } = synth({ distributionArn: DISTRIBUTION_ARN, tenantRequestsPer5Min: 0 });
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 0);
    expect(api.limitTable).toBeUndefined();
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0] as any;
    expect(fn.Properties.Environment.Variables[CELL_API_ENV.limitTable]).toBeUndefined();
    expect(fn.Properties.Environment.Variables[CELL_API_ENV.tenantRequestsPer5Min]).toBe('0');
  });
});

describe('DemoCellApi: the function role (spec §3.5, standard §4.3)', () => {
  function statements(template: Template): any[] {
    return Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  }

  test('reads only the tenant namespaces of its application, updates only the counter table, writes only its log group', () => {
    const { template } = synth({ distributionArn: DISTRIBUTION_ARN });
    const all = statements(template);
    const actions = all.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])).sort();
    expect(actions).toEqual(['dynamodb:UpdateItem', 'logs:CreateLogStream', 'logs:PutLogEvents', 'ssm:GetParametersByPath']);
    const ssmStatement = all.find((s) => s.Action === 'ssm:GetParametersByPath');
    expect(ssmStatement.Resource).toEqual({
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:eu-central-1:444455556666:parameter/application-plane/tenants/*/demo']],
    });
    const ddb = all.find((s) => s.Action === 'dynamodb:UpdateItem');
    expect(JSON.stringify(ddb.Resource)).toContain('CellApiTenantLimits');
    template.resourceCountIs('AWS::IAM::Role', 1);
    template.hasResourceProperties('AWS::IAM::Role', { ManagedPolicyArns: Match.absent() });
  });

  test('the log group is the function\'s own, with retention and DESTROY', () => {
    const { template } = synth({ distributionArn: DISTRIBUTION_ARN });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete', Properties: { RetentionInDays: 30 } });
  });
});

describe('DemoCellApi: props validation (standard §4.5)', () => {
  test.each([
    [{ applicationId: 'a/b' }, /applicationId/],
    [{ cellId: '' }, /cellId/],
    [{ issuer: { ...BASE.issuer, issuer: 'http://issuer.example.com' } }, /issuer.issuer must be an https URL/],
    [{ issuer: { ...BASE.issuer, jwksUrl: 'not a url' } }, /issuer.jwksUrl must be an https URL/],
    [{ issuer: { ...BASE.issuer, clientIds: [] } }, /clientIds/],
    [{ issuer: { ...BASE.issuer, clientIds: ['a,b'] } }, /clientIds/],
    [{ tenantClaim: 'bad claim' }, /tenantClaim/],
    [{ tenantRequestsPer5Min: -1 }, /tenantRequestsPer5Min/],
    [{ tenantRequestsPer5Min: 1.5 }, /tenantRequestsPer5Min/],
  ] as [Partial<DemoCellApiProps>, RegExp][])('refuses %j', (props, message) => {
    expect(() => synth({ distributionArn: DISTRIBUTION_ARN, ...props })).toThrow(message);
  });
});

describe('DemoCellApi: cdk-nag (standard §4.3)', () => {
  test('synthesises under AwsSolutionsChecks with no unacknowledged finding, in both ARN sources', () => {
    expect(() => synth({ distributionArn: DISTRIBUTION_ARN }, true)).not.toThrow();
    expect(() => synth({}, true)).not.toThrow();
  });

  test('also in an environment-agnostic stack, where the finding id holds the Region and account as intrinsics', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
    const stack = new Stack(app, 'Agnostic');
    new DemoCellApi(stack, 'CellApi', { ...BASE, distributionArn: DISTRIBUTION_ARN });
    expect(() => app.synth()).not.toThrow();
  });
});

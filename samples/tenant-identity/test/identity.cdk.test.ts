// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { TenantIdentityStack } from '../src/identity.cdk';
import { Topology } from '../src/shared/constants';
import { mergeOpenApi, patchIntegrations } from '../src/shared/openapi';

// Skip NodejsFunction esbuild bundling in unit tests - assertions target
// infrastructure shape, not bundle contents. (Other workers' entry files may
// not exist yet; bundling is irrelevant to these template assertions.)
function synth(topology: Topology, publishSharedParameters?: boolean): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TenantIdentityStack(app, `TenantIdentity-${topology}`, {
    topology,
    publishSharedParameters,
    env: { account: '123456789012', region: 'eu-central-1' },
  });
  return Template.fromStack(stack);
}

const TOPOLOGIES: Topology[] = ['pool-per-tenant', 'shared-pool', 'shared-pool-multi-tenant'];

// ---------------------------------------------------------------------------
// Helpers to inspect IAM policies by the actions they grant.
// ---------------------------------------------------------------------------

/** Every policy statement across all AWS::IAM::Policy resources in the template. */
function allPolicyStatements(template: Template): any[] {
  const policies = template.findResources('AWS::IAM::Policy');
  const statements: any[] = [];
  for (const policy of Object.values(policies) as any[]) {
    for (const s of policy.Properties.PolicyDocument.Statement) {
      statements.push(s);
    }
  }
  return statements;
}

/** The DefaultPolicy statements for a function whose logical id starts with `prefix`. */
function policyStatementsForRole(template: Template, rolePrefix: string): any[] {
  const policies = template.findResources('AWS::IAM::Policy');
  const statements: any[] = [];
  for (const policy of Object.values(policies) as any[]) {
    const roles: any[] = policy.Properties.Roles ?? [];
    const refsRole = roles.some((r) => JSON.stringify(r).includes(rolePrefix));
    if (refsRole) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        statements.push(s);
      }
    }
  }
  return statements;
}

function actionsOf(statement: any): string[] {
  const a = statement.Action;
  return Array.isArray(a) ? a : [a];
}

// ===========================================================================
// mergeOpenApi / patchIntegrations unit tests (src/shared/openapi.ts)
// ===========================================================================

describe('mergeOpenApi (R-1)', () => {
  const platform = {
    'openapi': '3.0.2',
    'info': { title: 'p' },
    'paths': {
      '/platform/tenants': {
        get: { 'operationId': 'ListTenants', 'x-amazon-apigateway-integration': { uri: 'PLACEHOLDER' } },
      },
    },
    'components': { schemas: { Tenant: { type: 'object' } }, securitySchemes: { 'aws.auth.sigv4': { type: 'apiKey' } } },
    'security': [{ 'aws.auth.sigv4': [] }],
    'x-amazon-apigateway-request-validator': 'full',
    'x-amazon-apigateway-request-validators': { full: { validateRequestBody: true } },
  };
  const token = {
    'openapi': '3.0.2',
    'info': { title: 't' },
    'paths': {
      '/oauth2/token': {
        post: {
          'operationId': 'ExchangeToken',
          'security': [],
          'x-amazon-apigateway-request-validator': 'params-only',
          'x-amazon-apigateway-integration': { uri: 'PLACEHOLDER' },
        },
      },
    },
    'components': { schemas: { OAuthError: { type: 'object' } } },
    'x-amazon-apigateway-binary-media-types': ['application/x-www-form-urlencoded'],
    'x-amazon-apigateway-request-validators': { 'params-only': { validateRequestParameters: true } },
  };

  test('pushes top-level security onto operations that lack their own', () => {
    const merged = mergeOpenApi([platform, token]) as any;
    // Platform op had no security -> gets the doc default.
    expect(merged.paths['/platform/tenants'].get.security).toEqual([{ 'aws.auth.sigv4': [] }]);
    // The merged document has no ambiguous global default.
    expect(merged.security).toBeUndefined();
    expect(merged['x-amazon-apigateway-request-validator']).toBeUndefined();
  });

  test('leaves an operation that declares its own security (token op security: [])', () => {
    const merged = mergeOpenApi([platform, token]) as any;
    expect(merged.paths['/oauth2/token'].post.security).toEqual([]);
    expect(merged.paths['/oauth2/token'].post['x-amazon-apigateway-request-validator']).toBe('params-only');
  });

  test('unions schemas, security schemes, binary media types and request validators', () => {
    const merged = mergeOpenApi([platform, token]) as any;
    expect(Object.keys(merged.components.schemas).sort()).toEqual(['OAuthError', 'Tenant']);
    expect(merged.components.securitySchemes['aws.auth.sigv4']).toBeDefined();
    expect(merged['x-amazon-apigateway-binary-media-types']).toContain('application/x-www-form-urlencoded');
    expect(Object.keys(merged['x-amazon-apigateway-request-validators']).sort()).toEqual(['full', 'params-only']);
  });

  test('throws on a duplicate path + method', () => {
    expect(() => mergeOpenApi([platform, platform])).toThrow(/duplicate operation GET \/platform\/tenants/);
  });

  test('throws when the same schema name has different content', () => {
    const conflicting = {
      ...token,
      components: { schemas: { Tenant: { type: 'string' } } },
    };
    expect(() => mergeOpenApi([platform, conflicting])).toThrow(/schema 'Tenant' defined differently/);
  });
});

describe('patchIntegrations (R-1)', () => {
  const mapping = {
    platformFnArn: 'arn:aws:lambda:eu-central-1:111:function:platform',
    tenantFnArn: 'arn:aws:lambda:eu-central-1:111:function:tenant',
    tokenFnArn: 'arn:aws:lambda:eu-central-1:111:function:token',
    authorizerFnArn: 'arn:aws:lambda:eu-central-1:111:function:authz',
    partition: 'aws',
    region: 'eu-central-1',
  };
  const doc = {
    paths: {
      '/platform/tenants': { get: { 'x-amazon-apigateway-integration': { uri: 'PLACEHOLDER' } } },
      '/tenant/users': { get: { 'x-amazon-apigateway-integration': { uri: 'PLACEHOLDER' } } },
      '/oauth2/token': { post: { 'x-amazon-apigateway-integration': { uri: 'PLACEHOLDER' } } },
    },
    components: {
      securitySchemes: {
        'tenant-authorizer': { 'x-amazon-apigateway-authorizer': { authorizerUri: 'PLACEHOLDER' } },
      },
    },
  };

  test('maps each path prefix to its function and the authoriser, leaving no PLACEHOLDER', () => {
    const patched = patchIntegrations(doc, mapping) as any;
    expect(patched.paths['/platform/tenants'].get['x-amazon-apigateway-integration'].uri).toContain('function:platform');
    expect(patched.paths['/tenant/users'].get['x-amazon-apigateway-integration'].uri).toContain('function:tenant');
    expect(patched.paths['/oauth2/token'].post['x-amazon-apigateway-integration'].uri).toContain('function:token');
    expect(
      patched.components.securitySchemes['tenant-authorizer']['x-amazon-apigateway-authorizer'].authorizerUri,
    ).toContain('function:authz');
    expect(JSON.stringify(patched)).not.toContain('PLACEHOLDER');
  });

  test('does not mutate the input document', () => {
    const copy = JSON.parse(JSON.stringify(doc));
    patchIntegrations(doc, mapping);
    expect(doc).toEqual(copy);
  });

  test('throws for a path with no mapped function', () => {
    const bad = { paths: { '/nope': { get: { 'x-amazon-apigateway-integration': { uri: 'PLACEHOLDER' } } } } };
    expect(() => patchIntegrations(bad, mapping)).toThrow(/no function mapped/);
  });
});

// ===========================================================================
// TenantIdentityStack - synthesised for all three topologies
// ===========================================================================

describe('TenantIdentityStack - role asymmetry (P-8)', () => {
  test.each(TOPOLOGIES)('trigger role has only the three registry reads, no cognito-idp (R-14) [%s]', (topology) => {
    const template = synth(topology);
    const statements = policyStatementsForRole(template, 'TriggerFunctionServiceRole');
    const actions = statements.flatMap(actionsOf);
    // No cognito-idp action anywhere on the trigger role (M-8).
    expect(actions.some((a) => a.startsWith('cognito-idp:'))).toBe(false);
    // Exactly the three read actions on DynamoDB.
    const dynamo = actions.filter((a) => a.startsWith('dynamodb:')).sort();
    expect(dynamo).toEqual(['dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:Query']);
  });

  test.each(TOPOLOGIES)('token role holds no cognito-idp or dynamodb action (R-7) [%s]', (topology) => {
    const template = synth(topology);
    const statements = policyStatementsForRole(template, 'TokenFunctionServiceRole');
    const actions = statements.flatMap(actionsOf);
    expect(actions.some((a) => a.startsWith('cognito-idp:'))).toBe(false);
    expect(actions.some((a) => a.startsWith('dynamodb:'))).toBe(false);
  });

  test.each(TOPOLOGIES)('authoriser role reads the registry only, no cognito-idp (R-9) [%s]', (topology) => {
    const template = synth(topology);
    const statements = policyStatementsForRole(template, 'AuthorizerFunctionServiceRole');
    const actions = statements.flatMap(actionsOf);
    expect(actions.some((a) => a.startsWith('cognito-idp:'))).toBe(false);
    const dynamo = actions.filter((a) => a.startsWith('dynamodb:')).sort();
    expect(dynamo).toEqual(['dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:Query']);
  });

  test.each(TOPOLOGIES)('tenant-user role holds no pool or group lifecycle action (R-8) [%s]', (topology) => {
    const template = synth(topology);
    const statements = policyStatementsForRole(template, 'TenantUsersFunctionServiceRole');
    const actions = statements.flatMap(actionsOf);
    for (const forbidden of [
      'cognito-idp:CreateUserPool',
      'cognito-idp:DeleteUserPool',
      'cognito-idp:CreateGroup',
      'cognito-idp:DeleteGroup',
    ]) {
      expect(actions).not.toContain(forbidden);
    }
  });

  test.each(TOPOLOGIES)('tenant-user role holds no test-aid sign-in action (P-8, M-17) [%s]', (topology) => {
    const template = synth(topology);
    const actions = policyStatementsForRole(template, 'TenantUsersFunctionServiceRole').flatMap(actionsOf);
    expect(actions).not.toContain('cognito-idp:AdminSetUserPassword');
    expect(actions).not.toContain('cognito-idp:AdminInitiateAuth');
    // The platform role keeps them for IssueToken/RefreshToken (ADR-0006).
    const platform = policyStatementsForRole(template, 'PlatformFunctionServiceRole').flatMap(actionsOf);
    expect(platform).toContain('cognito-idp:AdminSetUserPassword');
    expect(platform).toContain('cognito-idp:AdminInitiateAuth');
  });

  test('platform pool-per-tenant: CreateUserPool with the RequestTag condition and tagged per-pool actions (N-3)', () => {
    const template = synth('pool-per-tenant');
    const statements = policyStatementsForRole(template, 'PlatformFunctionServiceRole');

    const createPool = statements.find((s) => actionsOf(s).includes('cognito-idp:CreateUserPool'));
    expect(createPool).toBeDefined();
    expect(createPool.Resource).toBe('*');
    expect(createPool.Condition.StringEquals['aws:RequestTag/sample']).toBe('tenant-identity');
    expect(createPool.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual(['sample']);

    // Per-pool + pool-lifecycle actions scoped to userpool/* with ResourceTag.
    const perPool = statements.find(
      (s) =>
        actionsOf(s).includes('cognito-idp:DeleteUserPool') &&
        s.Condition?.StringEquals?.['aws:ResourceTag/sample'] === 'tenant-identity',
    );
    expect(perPool).toBeDefined();
    expect(JSON.stringify(perPool.Resource)).toContain('userpool/*');
  });

  test('shared-pool platform role is scoped to the single stack pool ARN (N-3)', () => {
    const template = synth('shared-pool');
    const statements = policyStatementsForRole(template, 'PlatformFunctionServiceRole');
    const cognitoStmt = statements.find((s) => actionsOf(s).includes('cognito-idp:AdminCreateUser'));
    expect(cognitoStmt).toBeDefined();
    // Not a userpool/* wildcard: it references the stack pool resource.
    expect(JSON.stringify(cognitoStmt.Resource)).toContain('UserPool');
    // Shared platform role has no CreateUserPool.
    expect(statements.flatMap(actionsOf)).not.toContain('cognito-idp:CreateUserPool');
  });

  test('pool-per-tenant grants Cognito permission to invoke the trigger (§7.1)', () => {
    const template = synth('pool-per-tenant');
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'cognito-idp.amazonaws.com',
      SourceAccount: '123456789012',
    });
  });
});

describe('TenantIdentityStack - registry table (R-3, N-2, §4.2)', () => {
  test.each(TOPOLOGIES)('PITR on, GSI byUserPoolId incl. tenantId, DeletionPolicy Delete [%s]', (topology) => {
    const template = synth(topology);
    template.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'byUserPoolId',
            Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['tenantId'] },
          }),
        ]),
        Replicas: Match.arrayWith([
          Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }),
        ]),
      }),
    });
  });
});

describe('TenantIdentityStack - shared user pool (R-4, R-5, N-1, N-8, §7.2)', () => {
  test('shared-pool has the immutable custom attribute, not in WriteAttributes (P-3)', () => {
    const template = synth('shared-pool');
    const pools = template.findResources('AWS::Cognito::UserPool');
    const pool = Object.values(pools)[0] as any;
    const schema: any[] = pool.Properties.Schema;
    const tenantAttr = schema.find((a) => a.Name === 'tenantId');
    expect(tenantAttr).toBeDefined();
    expect(tenantAttr.Mutable).toBe(false);
    expect(tenantAttr.StringAttributeConstraints).toEqual({ MaxLength: '26', MinLength: '26' });

    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const client = Object.values(clients)[0] as any;
    expect(client.Properties.WriteAttributes ?? []).not.toContain('custom:tenantId');
    // Writable attributes are email only.
    expect(client.Properties.WriteAttributes).toEqual(['email']);
  });

  test.each(['shared-pool', 'shared-pool-multi-tenant'] as Topology[])(
    'pool signs in by e-mail, so the Cognito username is the sub (R-13) [%s]',
    (topology) => {
      // R-13 compares the canonical username to the token's `sub`. That only
      // holds while e-mail is a username attribute (Username = sub UUID).
      const template = synth(topology);
      const pool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0] as any;
      expect(pool.Properties.UsernameAttributes).toEqual(['email']);
      expect(pool.Properties.AliasAttributes).toBeUndefined();
    },
  );

  test.each(['shared-pool', 'shared-pool-multi-tenant'] as Topology[])(
    'app client leaves refresh token rotation off (R-5, ADR-0009) [%s]',
    (topology) => {
      const template = synth(topology);
      const client = Object.values(template.findResources('AWS::Cognito::UserPoolClient'))[0] as any;
      const feature = client.Properties.RefreshTokenRotation?.Feature;
      expect(feature === undefined || feature === 'DISABLED').toBe(true);
    },
  );

  test.each(['shared-pool', 'shared-pool-multi-tenant'] as Topology[])(
    'pool: V2_0 trigger, Essentials plan, deletion protection INACTIVE, self sign-up off, sample tag [%s]',
    (topology) => {
      const template = synth(topology);
      const pools = template.findResources('AWS::Cognito::UserPool');
      const pool = Object.values(pools)[0] as any;
      expect(pool.Properties.UserPoolTier).toBe('ESSENTIALS');
      expect(pool.Properties.DeletionProtection).toBe('INACTIVE');
      expect(pool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(true);
      expect(JSON.stringify(pool.Properties.UserPoolTags)).toContain('tenant-identity');
      // Lambda trigger config uses the V2 payload.
      expect(pool.Properties.LambdaConfig.PreTokenGenerationConfig.LambdaVersion).toBe('V2_0');
    },
  );

  test.each(['shared-pool', 'shared-pool-multi-tenant'] as Topology[])(
    'app client: 5-min access/id tokens, 1-day refresh, no secret, no OAuth [%s]',
    (topology) => {
      const template = synth(topology);
      const clients = template.findResources('AWS::Cognito::UserPoolClient');
      const client = Object.values(clients)[0] as any;
      expect(client.Properties.AccessTokenValidity).toBe(5);
      expect(client.Properties.IdTokenValidity).toBe(5);
      expect(client.Properties.RefreshTokenValidity).toBe(1440); // 1 day in minutes
      expect(client.Properties.TokenValidityUnits).toMatchObject({
        AccessToken: 'minutes',
        IdToken: 'minutes',
        RefreshToken: 'minutes',
      });
      expect(client.Properties.GenerateSecret ?? false).toBe(false);
      expect(client.Properties.AllowedOAuthFlows ?? []).toEqual([]);
      expect(client.Properties.ExplicitAuthFlows).toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
      expect(client.Properties.EnableTokenRevocation).toBe(true);
      expect(client.Properties.PreventUserExistenceErrors).toBe('ENABLED');
    },
  );

  test('pool-per-tenant creates zero user pools at deploy time (R-5)', () => {
    const template = synth('pool-per-tenant');
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
  });
});

describe('TenantIdentityStack - API Gateway (R-1, §3.2, N-5..N-7)', () => {
  test.each(TOPOLOGIES)('REST API built from merged OpenAPI, no PLACEHOLDER, five paths [%s]', (topology) => {
    const template = synth(topology);
    const apis = template.findResources('AWS::ApiGateway::RestApi');
    const api = Object.values(apis)[0] as any;
    const body = api.Properties.Body;
    expect(JSON.stringify(body)).not.toContain('PLACEHOLDER');
    expect(Object.keys(body.paths).sort()).toEqual([
      '/oauth2/token',
      '/platform/tenants',
      '/platform/tenants/{tenantId}',
      '/platform/tenants/{tenantId}/users',
      '/platform/tenants/{tenantId}/users/{username}',
      '/platform/tenants/{tenantId}/users/{username}/membership',
      '/platform/tenants/{tenantId}/users/{username}/token',
      '/platform/tenants/{tenantId}/users/{username}/token/refresh',
      '/tenant/users',
      '/tenant/users/{username}',
    ]);
  });

  test.each(TOPOLOGIES)('token route has no authoriser; platform uses AWS_IAM; tenant uses the custom authoriser TTL 0 [%s]', (topology) => {
    const template = synth(topology);
    const api = Object.values(template.findResources('AWS::ApiGateway::RestApi'))[0] as any;
    const body = api.Properties.Body;

    // Token op: security [] (no authoriser).
    expect(body.paths['/oauth2/token'].post.security).toEqual([]);
    // Platform op: SigV4 scheme.
    expect(body.paths['/platform/tenants'].get.security).toEqual([{ 'aws.auth.sigv4': [] }]);
    // Tenant op: the custom authoriser.
    expect(body.paths['/tenant/users'].get.security).toEqual([{ 'tenant-authorizer': [] }]);
    // Authoriser caching off.
    const authorizer = body.components.securitySchemes['tenant-authorizer']['x-amazon-apigateway-authorizer'];
    expect(authorizer.type).toBe('token');
    expect(authorizer.authorizerResultTtlInSeconds).toBe(0);
  });

  test.each(TOPOLOGIES)('per-route throttling settings are present (N-5/N-6/N-7) [%s]', (topology) => {
    const template = synth(topology);
    const stage = Object.values(template.findResources('AWS::ApiGateway::Stage'))[0] as any;
    const methodSettings: any[] = stage.Properties.MethodSettings;
    // CloudFormation renders the resource path as '/' + the path with each
    // '/' replaced by '~1' (e.g. /platform/tenants -> /~1platform~1tenants).
    const encode = (p: string) => '/' + p.replace(/\//g, '~1');
    const find = (resourcePath: string, httpMethod: string) =>
      methodSettings.find((m) => m.ResourcePath === encode(resourcePath) && m.HttpMethod === httpMethod);

    // N-5: /platform 10/20.
    const platform = find('/platform/tenants', 'GET');
    expect(platform).toBeDefined();
    expect(platform.ThrottlingRateLimit).toBe(10);
    expect(platform.ThrottlingBurstLimit).toBe(20);
    // N-6: /oauth2/token POST 20/40.
    const token = find('/oauth2/token', 'POST');
    expect(token.ThrottlingRateLimit).toBe(20);
    expect(token.ThrottlingBurstLimit).toBe(40);
    // N-7: /tenant 10/20.
    const tenant = find('/tenant/users', 'GET');
    expect(tenant.ThrottlingRateLimit).toBe(10);
    expect(tenant.ThrottlingBurstLimit).toBe(20);
  });

  test.each(TOPOLOGIES)('access log format carries caller identity + authoriser principal (N-4) [%s]', (topology) => {
    const template = synth(topology);
    const stage = Object.values(template.findResources('AWS::ApiGateway::Stage'))[0] as any;
    const format = JSON.parse(stage.Properties.AccessLogSetting.Format);
    expect(format.callerArn).toBe('$context.identity.userArn');
    expect(format.principalId).toBe('$context.authorizer.principalId');
    expect(stage.Properties.TracingEnabled).toBe(true);
    expect(stage.Properties.MethodSettings.some((m: any) => m.LoggingLevel === 'INFO')).toBe(true);
  });

  test.each(TOPOLOGIES)('resource policy allows the account on /platform and any principal on token/tenant routes [%s]', (topology) => {
    const template = synth(topology);
    const api = Object.values(template.findResources('AWS::ApiGateway::RestApi'))[0] as any;
    const policyJson = JSON.stringify(api.Properties.Policy);
    expect(policyJson).toContain('execute-api:/prod/*/platform/*');
    expect(policyJson).toContain('execute-api:/prod/*/tenant/*');
    expect(policyJson).toContain('execute-api:/prod/POST/oauth2/token');
  });

  test.each(TOPOLOGIES)('a 4XX alarm with no actions exists [%s]', (topology) => {
    const template = synth(topology);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApiGateway',
      MetricName: '4XXError',
      Threshold: 50,
    });
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    for (const alarm of alarms as any[]) {
      expect(alarm.Properties.AlarmActions ?? []).toEqual([]);
    }
  });
});

describe('TenantIdentityStack - discovery parameters + outputs (R-6, §6.3)', () => {
  test.each(TOPOLOGIES)('publishes topology and apiUrl for every topology [%s]', (topology) => {
    const template = synth(topology);
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/application-plane/shared/identity/topology' });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/application-plane/shared/identity/apiUrl' });
    template.hasOutput('ApiUrl', {});
    template.hasOutput('Topology', {});
    template.hasOutput('RegistryTableName', {});
  });

  test('shared-pool* publishes userPoolId + appClientId and the UserPoolId/AppClientId outputs', () => {
    for (const topology of ['shared-pool', 'shared-pool-multi-tenant'] as Topology[]) {
      const template = synth(topology);
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/application-plane/shared/identity/userPoolId' });
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/application-plane/shared/identity/appClientId' });
      template.hasOutput('UserPoolId', {});
      template.hasOutput('AppClientId', {});
    }
  });

  test('pool-per-tenant publishes no pool identifiers at the shared level (§6.3)', () => {
    const template = synth('pool-per-tenant');
    const params = Object.values(template.findResources('AWS::SSM::Parameter')) as any[];
    const names = params.map((p) => p.Properties.Name);
    expect(names).not.toContain('/application-plane/shared/identity/userPoolId');
    expect(names).not.toContain('/application-plane/shared/identity/appClientId');
    expect(() => template.hasOutput('UserPoolId', {})).toThrow();
  });
});

describe('TenantIdentityStack - parameter publishing switch (ADR-0017)', () => {
  test.each(TOPOLOGIES)('publishSharedParameters=false creates no SSM parameter [%s]', (topology) => {
    synth(topology, false).resourceCountIs('AWS::SSM::Parameter', 0);
  });
});

describe('TenantIdentityStack - log groups bounded (teardown, §6.2)', () => {
  test.each(TOPOLOGIES)('every log group has 30-day retention and Delete removal [%s]', (topology) => {
    const template = synth(topology);
    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup'));
    // Five function log groups + API access logs.
    expect(logGroups.length).toBeGreaterThanOrEqual(6);
    for (const lg of logGroups as any[]) {
      expect(lg.Properties.RetentionInDays).toBe(30);
      expect(lg.DeletionPolicy).toBe('Delete');
    }
  });
});

describe('TenantIdentityStack - cdk-nag (sample-standard §4.3)', () => {
  // A synth that succeeds under the AwsSolutionsChecks plugin (applied in
  // src/main.ts) proves there are no UNACKNOWLEDGED errors. Here we assert
  // the stack produces no nag ERROR annotations for any topology; the plugin
  // itself runs in main.test.ts via the real app.
  test.each(TOPOLOGIES)('synthesises with no unsuppressed cdk-nag findings [%s]', (topology) => {
    // Re-synth with the AwsSolutionsChecks aspect, as main.ts does, and read
    // annotations off the assembly.
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
    const stack = new TenantIdentityStack(app, `TenantIdentity-${topology}`, {
      topology,
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    const assembly = app.synth();
    const messages = assembly.getStackArtifact(stack.artifactId).messages;
    const errors = messages.filter(
      (m: any) => m.level === 'error' && /AwsSolutions-/.test(JSON.stringify(m.entry?.data ?? '')),
    );
    const detail = errors.map((e: any) => e.entry.data).join('\n');
    expect({ topology, errors: detail }).toEqual({ topology, errors: '' });
  });
});

describe('TenantIdentityStack - teardown leaves no log group (ADR-0019)', () => {
  test.each(TOPOLOGIES)('creates no account-wide API Gateway CloudWatch role [%s]', (topology) => {
    const template = synth(topology);
    template.resourceCountIs('AWS::ApiGateway::Account', 0);
    const roles = Object.values(template.findResources('AWS::IAM::Role')) as any[];
    const managed = roles.flatMap((r) => JSON.stringify(r.Properties.ManagedPolicyArns ?? []));
    expect(managed.join()).not.toContain('AmazonAPIGatewayPushToCloudWatchLogs');
  });

  test.each(TOPOLOGIES)('owns the execution log group, with retention and Delete [%s]', (topology) => {
    const template = synth(topology);
    const groups = template.findResources('AWS::Logs::LogGroup', {
      Properties: { LogGroupName: { 'Fn::Join': ['', ['API-Gateway-Execution-Logs_', { Ref: Match.anyValue() }, '/prod']] } },
    });
    expect(Object.keys(groups)).toHaveLength(1);
    const [group] = Object.values(groups) as any[];
    expect(group.DeletionPolicy).toBe('Delete');
    expect(group.Properties.RetentionInDays).toBe(30);
  });

  test.each(TOPOLOGIES)('every log group is deleted after a drain, and every writer before it [%s]', (topology) => {
    const template = synth(topology);
    const resources = template.toJSON().Resources as Record<string, any>;
    const drains = Object.entries(resources)
      .filter(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && r.Properties.DelaySeconds !== undefined)
      .map(([id]) => id);
    expect(drains).toHaveLength(2);
    const dependsOn = (id: string): string[] => [resources[id].DependsOn ?? []].flat();

    // Log groups: each is a dependency of some drain (deleted after it).
    for (const [id, r] of Object.entries(resources)) {
      if (r.Type === 'AWS::Logs::LogGroup') {
        expect(drains.some((d) => dependsOn(d).includes(id))).toBe(true);
      }
    }
    // Writers: every function except the drains' own waiters, and the stage,
    // depend on a drain (deleted before it).
    const waiters = new Set(drains.map((d) => resources[d].Properties.ServiceToken['Fn::GetAtt'][0]));
    for (const [id, r] of Object.entries(resources)) {
      const writer = (r.Type === 'AWS::Lambda::Function' && !waiters.has(id)) || r.Type === 'AWS::ApiGateway::Stage';
      if (writer) {
        expect(dependsOn(id).some((d) => drains.includes(d))).toBe(true);
      }
    }
  });

  test.each(TOPOLOGIES)('the drain waiter has no permissions, so it cannot create a log group [%s]', (topology) => {
    const template = synth(topology);
    const resources = template.toJSON().Resources as Record<string, any>;
    const waiterRoles = Object.entries(resources)
      .filter(([id, r]) => r.Type === 'AWS::IAM::Role' && id.includes('LogDrain'))
      .map(([id]) => id);
    expect(waiterRoles).toHaveLength(2);
    for (const roleId of waiterRoles) {
      expect(resources[roleId].Properties.ManagedPolicyArns ?? []).toEqual([]);
      const attached = Object.values(resources).filter(
        (r: any) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes(roleId),
      );
      expect(attached).toEqual([]);
    }
  });

  test.each(TOPOLOGIES)('the drain waiters write no logs: system WARN, application ERROR [%s]', (topology) => {
    const template = synth(topology);
    const resources = template.toJSON().Resources as Record<string, any>;
    const waiters = Object.entries(resources).filter(
      ([id, r]) => r.Type === 'AWS::Lambda::Function' && id.includes('LogDrain'),
    );
    expect(waiters).toHaveLength(2);
    for (const [, fn] of waiters) {
      expect(fn.Properties.LoggingConfig).toEqual({
        LogFormat: 'JSON',
        SystemLogLevel: 'WARN',
        ApplicationLogLevel: 'ERROR',
      });
    }
  });
});

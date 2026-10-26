// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DRAIN_SHARED_POOL_ACTIONS, TENANT_USER_ACTIONS, TenantIdentityStack } from '../src/identity.cdk';
import { Deployment, Topology } from '../src/shared/constants';
import { mergeOpenApi, patchIntegrations, requireApiKey } from '../src/shared/openapi';

// Skip NodejsFunction esbuild bundling in unit tests - assertions target
// infrastructure shape, not bundle contents. (Other workers' entry files may
// not exist yet; bundling is irrelevant to these template assertions.)
function synth(topology: Deployment, publishSharedParameters?: boolean): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TenantIdentityStack(app, `TenantIdentity-${topology}`, {
    topology,
    publishSharedParameters,
    env: { account: '123456789012', region: 'eu-central-1' },
  });
  return Template.fromStack(stack);
}

/** The three single topologies (ADR-0001). */
const TOPOLOGIES: Topology[] = ['pool-per-tenant', 'shared-pool', 'shared-pool-multi-tenant'];
/** Every deployment: the three topologies plus `tiered` (ADR-0027). */
const DEPLOYMENTS: Deployment[] = [...TOPOLOGIES, 'tiered'];
/** The deployments with a stack-created shared pool (tiered: the standard tier's). */
const SHARED_POOL_DEPLOYMENTS: Deployment[] = ['shared-pool', 'shared-pool-multi-tenant', 'tiered'];
/** The deployments that create pools at run time (tiered: the premium tier's). */
const PER_TENANT_POOL_DEPLOYMENTS: Deployment[] = ['pool-per-tenant', 'tiered'];

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

describe('requireApiKey (ADR-0025)', () => {
  const doc = {
    paths: {
      '/platform/tenants': { get: { security: [{ 'aws.auth.sigv4': [] }] } },
      '/oauth2/token': { post: { security: [] } },
      '/tenant/users': {
        get: { security: [{ 'tenant-authorizer': [] }] },
        post: { security: [{ 'tenant-authorizer': [] }] },
        parameters: [],
      },
      '/tenant/users/{username}': { delete: {} },
    },
    components: { securitySchemes: { 'tenant-authorizer': { type: 'apiKey' } } },
  };

  test('adds the key to every /tenant operation, AND-ed with the authoriser', () => {
    const out = requireApiKey(doc, '/tenant') as any;
    expect(out.paths['/tenant/users'].get.security).toEqual([{ 'tenant-authorizer': [], 'api_key': [] }]);
    expect(out.paths['/tenant/users'].post.security).toEqual([{ 'tenant-authorizer': [], 'api_key': [] }]);
    // An operation with no requirement gets one with the key only.
    expect(out.paths['/tenant/users/{username}'].delete.security).toEqual([{ api_key: [] }]);
    // Non-method keys are left alone.
    expect(out.paths['/tenant/users'].parameters).toEqual([]);
  });

  test('leaves /platform and the token route alone', () => {
    const out = requireApiKey(doc, '/tenant') as any;
    expect(out.paths['/platform/tenants'].get.security).toEqual([{ 'aws.auth.sigv4': [] }]);
    expect(out.paths['/oauth2/token'].post.security).toEqual([]);
  });

  test('sets the key source to AUTHORIZER and defines the api_key scheme', () => {
    const out = requireApiKey(doc, '/tenant') as any;
    expect(out['x-amazon-apigateway-api-key-source']).toBe('AUTHORIZER');
    expect(out.components.securitySchemes.api_key).toEqual({ type: 'apiKey', name: 'x-api-key', in: 'header' });
    expect(out.components.securitySchemes['tenant-authorizer']).toBeDefined();
  });

  test('creates components when the document has none', () => {
    const out = requireApiKey({ paths: { '/tenant/x': { get: {} } } }, '/tenant') as any;
    expect(out.components.securitySchemes.api_key).toBeDefined();
  });

  test('does not mutate the input, and throws when no operation matches', () => {
    const copy = JSON.parse(JSON.stringify(doc));
    requireApiKey(doc, '/tenant');
    expect(doc).toEqual(copy);
    expect(() => requireApiKey(doc, '/nope')).toThrow(/no operation under '\/nope'/);
  });
});

// ===========================================================================
// TenantIdentityStack - synthesised for all three topologies
// ===========================================================================

describe('TenantIdentityStack - role asymmetry (P-8)', () => {
  test.each(DEPLOYMENTS)('trigger role has only the three registry reads, no cognito-idp (R-14) [%s]', (topology) => {
    const template = synth(topology);
    const statements = policyStatementsForRole(template, 'TriggerFunctionServiceRole');
    const actions = statements.flatMap(actionsOf);
    // No cognito-idp action anywhere on the trigger role (M-8).
    expect(actions.some((a) => a.startsWith('cognito-idp:'))).toBe(false);
    // Exactly the three read actions on DynamoDB.
    const dynamo = actions.filter((a) => a.startsWith('dynamodb:')).sort();
    expect(dynamo).toEqual(['dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:Query']);
  });

  test.each(DEPLOYMENTS)('token role holds no cognito-idp or dynamodb action (R-7) [%s]', (topology) => {
    const template = synth(topology);
    const statements = policyStatementsForRole(template, 'TokenFunctionServiceRole');
    const actions = statements.flatMap(actionsOf);
    expect(actions.some((a) => a.startsWith('cognito-idp:'))).toBe(false);
    expect(actions.some((a) => a.startsWith('dynamodb:'))).toBe(false);
  });

  test.each(DEPLOYMENTS)('authoriser role reads the registry with GetItem + Query only, no BatchGetItem, no cognito-idp (R-9) [%s]', (topology) => {
    const template = synth(topology);
    const statements = policyStatementsForRole(template, 'AuthorizerFunctionServiceRole');
    const actions = statements.flatMap(actionsOf);
    expect(actions.some((a) => a.startsWith('cognito-idp:'))).toBe(false);
    // registry.get + registry.getByUserPoolId; the authoriser never batch-reads.
    const dynamo = actions.filter((a) => a.startsWith('dynamodb:')).sort();
    expect(dynamo).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
  });

  test.each(DEPLOYMENTS)('tenant-user role holds no pool or group lifecycle action (R-8) [%s]', (topology) => {
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

  test.each(DEPLOYMENTS)('tenant-user role holds no test-aid sign-in action (P-8, M-17) [%s]', (topology) => {
    const template = synth(topology);
    const actions = policyStatementsForRole(template, 'TenantUsersFunctionServiceRole').flatMap(actionsOf);
    expect(actions).not.toContain('cognito-idp:AdminSetUserPassword');
    expect(actions).not.toContain('cognito-idp:AdminInitiateAuth');
    // The platform role keeps them for IssueToken/RefreshToken (ADR-0006).
    const platform = policyStatementsForRole(template, 'PlatformFunctionServiceRole').flatMap(actionsOf);
    expect(platform).toContain('cognito-idp:AdminSetUserPassword');
    expect(platform).toContain('cognito-idp:AdminInitiateAuth');
  });

  // Every statement on Resource '*' is pinned per role. The cdk-nag IAM5
  // acknowledgement for '*' is per role, not per action, so a future '*'
  // action would otherwise pass review silently.
  const XRAY = ['xray:PutTelemetryRecords', 'xray:PutTraceSegments'];
  test.each(DEPLOYMENTS)('the only Resource "*" actions are X-Ray, plus CreateUserPool on a platform role that creates pools [%s]', (topology) => {
    const template = synth(topology);
    const roles: Record<string, string[]> = {
      TriggerFunctionServiceRole: XRAY,
      TokenFunctionServiceRole: XRAY,
      AuthorizerFunctionServiceRole: XRAY,
      TenantUsersFunctionServiceRole: XRAY,
      TenantDrainFunctionServiceRole: XRAY,
      PlatformFunctionServiceRole:
        PER_TENANT_POOL_DEPLOYMENTS.includes(topology) ? [...XRAY, 'cognito-idp:CreateUserPool'].sort() : XRAY,
    };
    for (const [role, expected] of Object.entries(roles)) {
      const star = policyStatementsForRole(template, role)
        .filter((s) => s.Resource === '*' || (Array.isArray(s.Resource) && s.Resource.includes('*')))
        .flatMap(actionsOf)
        .sort();
      expect({ role, star }).toEqual({ role, star: expected });
    }
  });

  test.each(DEPLOYMENTS)('drain role: registry writes and delete-side Cognito only, no create or sign-in action (ADR-0022) [%s]', (topology) => {
    const template = synth(topology);
    const actions = policyStatementsForRole(template, 'TenantDrainFunctionServiceRole').flatMap(actionsOf);
    for (const forbidden of [
      'cognito-idp:CreateUserPool',
      'cognito-idp:CreateUserPoolClient',
      'cognito-idp:CreateGroup',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminSetUserPassword',
      'cognito-idp:AdminInitiateAuth',
      'cognito-idp:TagResource',
      'dynamodb:PutItem',
    ]) {
      expect(actions).not.toContain(forbidden);
    }
    expect(actions).toContain('dynamodb:Scan');
    expect(actions).toContain('dynamodb:DeleteItem');
    const cognito = actions.filter((a) => a.startsWith('cognito-idp:')).sort();
    const perTenantPools = PER_TENANT_POOL_DEPLOYMENTS.includes(topology);
    const sharedPool = SHARED_POOL_DEPLOYMENTS.includes(topology);
    // DeleteUserPool on this stack's runtime pools, where there are any.
    expect(cognito.includes('cognito-idp:DeleteUserPool')).toBe(perTenantPools);
    if (perTenantPools) {
      const stmt = policyStatementsForRole(template, 'TenantDrainFunctionServiceRole').find((s) =>
        actionsOf(s).includes('cognito-idp:DeleteUserPool'),
      );
      expect(JSON.stringify(stmt.Condition)).toContain('tenant-identity:stack');
    }
    // The shared pool's offboarding actions, where there is a shared pool.
    const expected = [
      ...(perTenantPools ? ['cognito-idp:DeleteUserPool'] : []),
      ...(sharedPool ? DRAIN_SHARED_POOL_ACTIONS : []),
    ].sort();
    expect(cognito).toEqual(expected);
  });

  test('platform pool-per-tenant: CreateUserPool with the RequestTag condition and tagged per-pool actions (N-3)', () => {
    const template = synth('pool-per-tenant');
    const statements = policyStatementsForRole(template, 'PlatformFunctionServiceRole');

    const createPool = statements.find((s) => actionsOf(s).includes('cognito-idp:CreateUserPool'));
    expect(createPool).toBeDefined();
    expect(createPool.Resource).toBe('*');
    expect(createPool.Condition.StringEquals['aws:RequestTag/sample']).toBe('tenant-identity');
    expect(createPool.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual([
      'sample',
      'tenant-identity:stack',
      'tenant-identity:tenant',
    ]);
    expect(createPool.Condition.StringEquals['aws:RequestTag/tenant-identity:stack']).toBe('TenantIdentity-pool-per-tenant');
    // ADR-0026: a tenant tag is required, shaped like a 26-character ULID.
    expect(createPool.Condition.StringLike['aws:RequestTag/tenant-identity:tenant']).toBe('?'.repeat(26));

    // Per-pool + pool-lifecycle actions scoped to userpool/* with ResourceTag.
    const perPool = statements.find(
      (s) =>
        actionsOf(s).includes('cognito-idp:DeleteUserPool') &&
        s.Condition?.StringEquals?.['aws:ResourceTag/sample'] === 'tenant-identity',
    );
    expect(perPool).toBeDefined();
    expect(JSON.stringify(perPool.Resource)).toContain('userpool/*');
    // The stack tag keeps this stack's roles off other stacks' pools.
    expect(perPool.Condition.StringEquals['aws:ResourceTag/tenant-identity:stack']).toBe('TenantIdentity-pool-per-tenant');
  });

  test('pool-per-tenant: every ResourceTag-scoped cognito statement names the stack (N-3)', () => {
    const template = synth('pool-per-tenant');
    for (const role of ['PlatformFunctionServiceRole', 'TenantScopedRole']) {
      const scoped = policyStatementsForRole(template, role).filter((s) => s.Condition?.StringEquals?.['aws:ResourceTag/sample']);
      expect(scoped.length).toBeGreaterThan(0);
      for (const s of scoped) {
        expect(s.Condition.StringEquals['aws:ResourceTag/tenant-identity:stack']).toBe('TenantIdentity-pool-per-tenant');
      }
    }
  });

  test('platform pool-per-tenant: STACK_NAME is set for the pool tag', () => {
    const template = synth('pool-per-tenant');
    const fns = template.findResources('AWS::Lambda::Function');
    const [, platform] = Object.entries(fns).find(([id]) => id.startsWith('PlatformFunction'))!;
    expect((platform as any).Properties.Environment.Variables.STACK_NAME).toBe('TenantIdentity-pool-per-tenant');
  });

  test('platform pool-per-tenant: TagResource only for the sample tag key and value (N-3)', () => {
    const template = synth('pool-per-tenant');
    const statements = policyStatementsForRole(template, 'PlatformFunctionServiceRole');
    const tag = statements.find((s) => actionsOf(s).includes('cognito-idp:TagResource'));
    expect(tag).toBeDefined();
    expect(tag.Condition.StringEquals['aws:RequestTag/sample']).toBe('tenant-identity');
    expect(tag.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual([
      'sample',
      'tenant-identity:stack',
      'tenant-identity:tenant',
    ]);
    expect(tag.Condition.StringLike['aws:RequestTag/tenant-identity:tenant']).toBe('?'.repeat(26));
  });

  test('platform pool-per-tenant: TagResource only on an untagged pool or one of this stack (N-3, T-7)', () => {
    // StringEqualsIfExists: a pool that already carries the sample/stack tags
    // must carry this stack's values, so another stack's pool cannot be tagged
    // into this role's ResourceTag rights. Not Null: CreateUserPool's implicit
    // TagResource fails a Null guard (integ 2026-10-22).
    const template = synth('pool-per-tenant');
    const statements = policyStatementsForRole(template, 'PlatformFunctionServiceRole');
    const tag = statements.find((s) => actionsOf(s).includes('cognito-idp:TagResource'));
    expect(tag.Condition.Null).toBeUndefined();
    expect(tag.Condition.StringEqualsIfExists).toEqual({
      'aws:ResourceTag/sample': 'tenant-identity',
      'aws:ResourceTag/tenant-identity:stack': 'TenantIdentity-pool-per-tenant',
    });
    expect(tag.Condition.StringEquals['aws:RequestTag/tenant-identity:stack']).toBe('TenantIdentity-pool-per-tenant');
  });

  test.each(DEPLOYMENTS)('no role holds cognito-idp:DescribeUserPool - nothing in src/ calls it [%s]', (topology) => {
    const template = synth(topology);
    expect(allPolicyStatements(template).flatMap(actionsOf)).not.toContain('cognito-idp:DescribeUserPool');
  });

  test('pool-per-tenant platform role acknowledges IAM5[Resource::*] once, with both wildcard actions in one reason', () => {
    // cdk-nag keeps the first reason per finding id when it writes template
    // metadata, so two acknowledgments would silently drop one. The merged
    // reason must name both '*' actions.
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));
    const stack = new TenantIdentityStack(app, 'TenantIdentity-pool-per-tenant', {
      topology: 'pool-per-tenant',
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    const template = Template.fromStack(stack);
    const [policy] = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith('PlatformFunctionServiceRoleDefaultPolicy'))
      .map(([, r]) => r as any);
    const rules: { id: string; reason: string }[] = policy.Metadata.cdk_nag.rules_to_suppress;
    const star = rules.filter((r) => r.id === 'AwsSolutions-IAM5[Resource::*]');
    expect(star).toHaveLength(1);
    expect(star[0].reason).toContain('xray:PutTraceSegments');
    expect(star[0].reason).toContain('cognito-idp:CreateUserPool');
  });

  test.each(DEPLOYMENTS)('every IAM policy with a \'*\' resource carries a cfn_nag W12 reason [%s]', (topology) => {
    const template = synth(topology);
    const wildcard = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([, r]) =>
      (r as any).Properties.PolicyDocument.Statement.some((s: any) =>
        (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).includes('*')),
    );
    expect(wildcard.length).toBeGreaterThan(0);
    for (const [id, r] of wildcard) {
      const rules: { id: string; reason: string }[] = (r as any).Metadata?.cfn_nag?.rules_to_suppress ?? [];
      const w12 = rules.filter((x) => x.id === 'W12');
      expect({ id, count: w12.length }).toEqual({ id, count: 1 });
      expect(w12[0].reason).toContain('xray:PutTraceSegments');
    }
  });

  test.each(DEPLOYMENTS)('timeouts: platform 28 s (under API Gateway\'s 29 s), trigger 5 s (Cognito\'s trigger limit) [%s]', (topology) => {
    const template = synth(topology);
    const fns = Object.entries(template.findResources('AWS::Lambda::Function'));
    const timeoutOf = (prefix: string) =>
      (fns.find(([id]) => id.startsWith(prefix) && !id.includes('ServiceRole'))![1] as any).Properties.Timeout;
    expect(timeoutOf('PlatformFunction')).toBe(28);
    expect(timeoutOf('TriggerFunction')).toBe(5);
  });

  test.each(DEPLOYMENTS)('the drain function has its own CKV_AWS_116 reason (async CloudFormation invoke) [%s]', (topology) => {
    const template = synth(topology);
    const [drain] = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([id]) => id.startsWith('TenantDrainFunction') && !id.includes('ServiceRole'))
      .map(([, r]) => r as any);
    const skip = (drain.Metadata.checkov.skip as { id: string; comment: string }[]).find((s) => s.id === 'CKV_AWS_116');
    expect(skip?.comment).toMatch(/CloudFormation/);
    expect(skip?.comment).toMatch(/idempotent/);
  });

  // ADR-0027: both parse the deployment at cold start and would fail without it.
  test.each(['TokenFunction', 'AuthorizerFunction'])('%s gets the deployment as TOPOLOGY', (fn) => {
    const template = synth('pool-per-tenant');
    const fns = template.findResources('AWS::Lambda::Function');
    const match = Object.entries(fns).find(([id]) => id.startsWith(fn) && !id.includes('ServiceRole'));
    expect(match).toBeDefined();
    const vars = (match![1] as any).Properties.Environment?.Variables ?? {};
    expect(vars.TOPOLOGY).toBe('pool-per-tenant');
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
  test.each(DEPLOYMENTS)('PITR on, GSI byUserPoolId incl. tenantId, DeletionPolicy Delete [%s]', (topology) => {
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
  test.each(DEPLOYMENTS)('DynamoDB-owned key, with the checkov CKV_AWS_119 skip citing T-24 [%s]', (topology) => {
    const template = synth(topology);
    const [table] = Object.values(template.findResources('AWS::DynamoDB::GlobalTable')) as any[];
    expect(table.Properties.SSESpecification?.SSEEnabled ?? false).toBe(false);
    const skip = (table.Metadata.checkov.skip as { id: string; comment: string }[]).find((s) => s.id === 'CKV_AWS_119');
    expect(skip?.comment).toMatch(/T-24/);
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
  });

  test.each(SHARED_POOL_DEPLOYMENTS)(
    'e-mail is immutable at the pool; no self-service recovery (R-17, T-27) [%s]',
    (topology) => {
      const template = synth(topology);
      const pool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0] as any;
      // The guard lives in the pool schema. An empty client WriteAttributes
      // would mean "all standard attributes" (integration-verified), so the
      // client list is not the control and is left unset.
      const email = (pool.Properties.Schema as any[]).find((a) => a.Name === 'email');
      expect(email).toMatchObject({ Required: true, Mutable: false });
      const client = Object.values(template.findResources('AWS::Cognito::UserPoolClient'))[0] as any;
      expect(client.Properties.WriteAttributes).toBeUndefined();
      expect(client.Properties.ReadAttributes).toEqual(['email']);
      expect(pool.Properties.AccountRecoverySetting).toEqual({
        RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }],
      });
    },
  );

  test.each(SHARED_POOL_DEPLOYMENTS)(
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

  test.each(SHARED_POOL_DEPLOYMENTS)(
    'app client leaves refresh token rotation off (R-5, ADR-0009) [%s]',
    (topology) => {
      const template = synth(topology);
      const client = Object.values(template.findResources('AWS::Cognito::UserPoolClient'))[0] as any;
      const feature = client.Properties.RefreshTokenRotation?.Feature;
      expect(feature === undefined || feature === 'DISABLED').toBe(true);
    },
  );

  test.each(SHARED_POOL_DEPLOYMENTS)(
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

  test.each(SHARED_POOL_DEPLOYMENTS)(
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
  test.each(DEPLOYMENTS)('REST API built from merged OpenAPI, no PLACEHOLDER, five paths [%s]', (topology) => {
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

  test.each(DEPLOYMENTS)('token route has no authoriser; platform uses AWS_IAM; tenant uses the custom authoriser TTL 0 [%s]', (topology) => {
    const template = synth(topology);
    const api = Object.values(template.findResources('AWS::ApiGateway::RestApi'))[0] as any;
    const body = api.Properties.Body;

    // Token op: security [] (no authoriser).
    expect(body.paths['/oauth2/token'].post.security).toEqual([]);
    // Platform op: SigV4 scheme.
    expect(body.paths['/platform/tenants'].get.security).toEqual([{ 'aws.auth.sigv4': [] }]);
    // Tenant op: the custom authoriser AND an API key (ADR-0025).
    expect(body.paths['/tenant/users'].get.security).toEqual([{ 'tenant-authorizer': [], 'api_key': [] }]);
    // Authoriser caching off.
    const authorizer = body.components.securitySchemes['tenant-authorizer']['x-amazon-apigateway-authorizer'];
    expect(authorizer.type).toBe('token');
    expect(authorizer.authorizerResultTtlInSeconds).toBe(0);
  });

  test.each(DEPLOYMENTS)('per-route throttling settings are present (N-5/N-6/N-7) [%s]', (topology) => {
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
    // N-7: /tenant shared 50/100, above every per-tenant plan (T-31).
    const tenant = find('/tenant/users', 'GET');
    expect(tenant.ThrottlingRateLimit).toBe(50);
    expect(tenant.ThrottlingBurstLimit).toBe(100);
    const plans = Object.values(template.findResources('AWS::ApiGateway::UsagePlan')) as any[];
    const standard = plans.find((p) => p.Properties.UsagePlanName === `TenantIdentity-${topology}-tenant`);
    expect(standard.Properties.Throttle).toEqual({ RateLimit: 10, BurstLimit: 20 });
    for (const plan of plans) {
      expect(tenant.ThrottlingRateLimit).toBeGreaterThan(plan.Properties.Throttle.RateLimit);
      expect(tenant.ThrottlingBurstLimit).toBeGreaterThan(plan.Properties.Throttle.BurstLimit);
    }
  });

  test.each(DEPLOYMENTS)('access log format carries caller identity + authoriser principal (N-4) [%s]', (topology) => {
    const template = synth(topology);
    const stage = Object.values(template.findResources('AWS::ApiGateway::Stage'))[0] as any;
    const format = JSON.parse(stage.Properties.AccessLogSetting.Format);
    expect(format.callerArn).toBe('$context.identity.userArn');
    expect(format.principalId).toBe('$context.authorizer.principalId');
    // The per-tenant dimension (the authoriser returns context.tenantId on Allow).
    expect(format.tenantId).toBe('$context.authorizer.tenantId');
    expect(stage.Properties.TracingEnabled).toBe(true);
    expect(stage.Properties.MethodSettings.some((m: any) => m.LoggingLevel === 'INFO')).toBe(true);
  });

  test.each(DEPLOYMENTS)('resource policy paths use the deployed stage name [%s]', (topology) => {
    const template = synth(topology);
    const api = Object.values(template.findResources('AWS::ApiGateway::RestApi'))[0] as any;
    const stage = Object.values(template.findResources('AWS::ApiGateway::Stage'))[0] as any;
    const resources: string[] = api.Properties.Policy.Statement.flatMap((s: any) => [s.Resource].flat());
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      expect(r.startsWith(`execute-api:/${stage.Properties.StageName}/`)).toBe(true);
    }
  });

  test.each(DEPLOYMENTS)('resource policy allows the account on /platform and any principal on token/tenant routes [%s]', (topology) => {
    const template = synth(topology);
    const api = Object.values(template.findResources('AWS::ApiGateway::RestApi'))[0] as any;
    const policyJson = JSON.stringify(api.Properties.Policy);
    expect(policyJson).toContain('execute-api:/prod/*/platform/*');
    expect(policyJson).toContain('execute-api:/prod/*/tenant/*');
    expect(policyJson).toContain('execute-api:/prod/POST/oauth2/token');
  });

  test.each(DEPLOYMENTS)('4XX and 5XX alarms notify the encrypted alarm topic [%s]', (topology) => {
    const template = synth(topology);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApiGateway',
      MetricName: '4XXError',
      Threshold: 50,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApiGateway',
      MetricName: '5XXError',
      Threshold: 5,
    });
    const topics = template.findResources('AWS::SNS::Topic');
    expect(Object.keys(topics)).toHaveLength(1);
    const [topicId, topic] = Object.entries(topics)[0] as [string, any];
    expect(topic.Properties.KmsMasterKeyId).toBeDefined();
    const topicRef = { Ref: topicId };
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toHaveLength(2);
    for (const alarm of alarms as any[]) {
      expect(alarm.Properties.AlarmActions).toEqual([topicRef]);
      expect(alarm.Properties.OKActions).toEqual([topicRef]);
    }
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      KeyPolicy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudWatchAlarmsToPublish',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
          }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
          Match.objectLike({
            Sid: 'AllowCloudWatchAlarmsToPublish',
            Effect: 'Allow',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Action: 'sns:Publish',
          }),
        ]),
      }),
    });
  });
});

describe('TenantIdentityStack - per-tenant Contributor Insights (N-4)', () => {
  // RuleBody carries the log group name as a Ref, so CloudFormation renders
  // it as an Fn::Join. Re-join it with each Ref replaced by its logical id,
  // which makes the body parsable and LogGroupNames assertable.
  function renderBody(ruleBody: any): string {
    if (typeof ruleBody === 'string') {
      return ruleBody;
    }
    const [delimiter, parts] = ruleBody['Fn::Join'] as [string, any[]];
    return parts.map((p) => (typeof p === 'string' ? p : String(p.Ref))).join(delimiter);
  }
  function rules(template: Template): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [id, r] of Object.entries(template.findResources('AWS::CloudWatch::InsightRule'))) {
      out[id] = { ...(r as any).Properties, body: JSON.parse(renderBody((r as any).Properties.RuleBody)) };
    }
    return out;
  }
  const byId = (template: Template, prefix: string) => {
    const match = Object.entries(rules(template)).find(([id]) => id.startsWith(prefix));
    expect(match).toBeDefined();
    return match![1];
  };

  test.each(DEPLOYMENTS)('four enabled CloudWatchLogRule v1 JSON rules, names prefixed with the stack name [%s]', (topology) => {
    const template = synth(topology);
    const all = Object.values(rules(template));
    expect(all).toHaveLength(4);
    const names = all.map((r) => r.RuleName).sort();
    expect(names).toEqual([
      `TenantIdentity-${topology}-tenant-errors`,
      `TenantIdentity-${topology}-tenant-requests`,
      `TenantIdentity-${topology}-tenant-tokens`,
      `TenantIdentity-${topology}-token-refusals`,
    ]);
    for (const r of all) {
      expect(r.RuleState).toBe('ENABLED');
      expect(r.body.Schema).toEqual({ Name: 'CloudWatchLogRule', Version: 1 });
      expect(r.body.LogFormat).toBe('JSON');
      expect(r.body.AggregateOn).toBe('Count');
      expect(r.body.LogGroupNames).toHaveLength(1);
    }
  });

  test.each(DEPLOYMENTS)('the two API rules read the access log group and key on tenantId, excluding "-" [%s]', (topology) => {
    const template = synth(topology);
    const accessLogs = Object.keys(template.findResources('AWS::Logs::LogGroup')).find((id) => id.startsWith('ApiAccessLogs'))!;
    for (const prefix of ['TenantRequestsRule', 'TenantErrorsRule']) {
      const rule = byId(template, prefix);
      expect(rule.body.LogGroupNames).toEqual([accessLogs]);
      expect(rule.body.Contribution.Keys[0]).toBe('$.tenantId');
      expect(rule.body.Contribution.Filters).toEqual(
        expect.arrayContaining([
          { Match: '$.tenantId', IsPresent: true },
          { Match: '$.tenantId', NotIn: ['-'] },
        ]),
      );
    }
    const errors = byId(template, 'TenantErrorsRule');
    expect(errors.body.Contribution.Keys).toEqual(['$.tenantId', '$.status']);
    // status is a string in the access log, so >= 400 is a prefix match.
    expect(errors.body.Contribution.Filters).toContainEqual({ Match: '$.status', StartsWith: ['4', '5'] });
  });

  test.each(DEPLOYMENTS)('the two trigger rules read the trigger log group: tokens by tenantId, refusals by rule [%s]', (topology) => {
    const template = synth(topology);
    const triggerLogs = Object.keys(template.findResources('AWS::Logs::LogGroup')).find((id) => id.startsWith('TriggerFunctionLogs'))!;
    const tokens = byId(template, 'TenantTokensRule');
    expect(tokens.body.LogGroupNames).toEqual([triggerLogs]);
    expect(tokens.body.Contribution.Keys).toEqual(['$.tenantId']);
    expect(tokens.body.Contribution.Filters).toEqual([{ Match: '$.message', In: ['pre-token-generation issued'] }]);
    const refusals = byId(template, 'TokenRefusalsRule');
    expect(refusals.body.LogGroupNames).toEqual([triggerLogs]);
    expect(refusals.body.Contribution.Keys).toEqual(['$.rule']);
    expect(refusals.body.Contribution.Filters).toEqual([{ Match: '$.message', StartsWith: ['pre-token-generation refused'] }]);
  });

  test.each(DEPLOYMENTS)('functions log in Lambda JSON format, so each line is the logger\'s JSON object [%s]', (topology) => {
    const template = synth(topology);
    const fns = Object.entries(template.findResources('AWS::Lambda::Function')).filter(([id]) => !id.includes('LogDrain'));
    expect(fns).toHaveLength(6);
    for (const [, fn] of fns) {
      expect((fn as any).Properties.LoggingConfig.LogFormat).toBe('JSON');
    }
  });
});

describe('TenantIdentityStack - discovery parameters + outputs (R-6, §6.3)', () => {
  test.each(DEPLOYMENTS)('publishes topology and apiUrl for every topology [%s]', (topology) => {
    const template = synth(topology);
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/application-plane/shared/identity/topology' });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/application-plane/shared/identity/apiUrl' });
    template.hasOutput('ApiUrl', {});
    template.hasOutput('Topology', {});
    template.hasOutput('RegistryTableName', {});
  });

  test('every deployment with a shared pool publishes userPoolId + appClientId and the UserPoolId/AppClientId outputs', () => {
    for (const topology of SHARED_POOL_DEPLOYMENTS) {
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
  test.each(DEPLOYMENTS)('publishSharedParameters=false creates no SSM parameter [%s]', (topology) => {
    synth(topology, false).resourceCountIs('AWS::SSM::Parameter', 0);
  });
});

// ===========================================================================
// Control-plane mount: AdminPasswordKey (ADR-0033) + PlatformInvokePolicy (ADR-0030)
// ===========================================================================

/** Renders an Fn::Join / Ref / Fn::GetAtt resource the way the finding ids do: `<LogicalId>` placeholders. */
function renderArn(value: any): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value['Fn::Join'] !== undefined) {
    const [delimiter, parts] = value['Fn::Join'] as [string, any[]];
    return parts.map(renderArn).join(delimiter);
  }
  if (value['Fn::GetAtt'] !== undefined) {
    return `<${value['Fn::GetAtt'][0]}.${value['Fn::GetAtt'][1]}>`;
  }
  return `<${value.Ref}>`;
}

describe('TenantIdentityStack - control-plane mount (ADR-0030, ADR-0033)', () => {
  const PARAM_KEY = '/application-plane/shared/identity/adminPasswordKeyArn';
  const PARAM_POLICY = '/application-plane/shared/identity/platformInvokePolicyArn';

  /** The one managed policy, the one admin-password key and its alias. */
  function mount(template: Template) {
    const policies = Object.entries(template.findResources('AWS::IAM::ManagedPolicy'));
    expect(policies).toHaveLength(1);
    const [policyId, policy] = policies[0] as [string, any];
    const keys = Object.entries(template.findResources('AWS::KMS::Key')).filter(([id]) => id.startsWith('AdminPasswordKey'));
    expect(keys).toHaveLength(1);
    const [keyId, key] = keys[0] as [string, any];
    const aliases = Object.values(template.findResources('AWS::KMS::Alias')) as any[];
    expect(aliases).toHaveLength(1);
    return { policyId, policy, keyId, key, alias: aliases[0] };
  }

  test.each(DEPLOYMENTS)('the key: symmetric, rotation on, the fixed alias, the default key policy only, scheduled for deletion in 7 days [%s]', (topology) => {
    const template = synth(topology);
    const { keyId, key, alias } = mount(template);
    expect(key.Properties.EnableKeyRotation).toBe(true);
    // Symmetric encryption is the KMS default: no KeySpec / KeyUsage override.
    expect(key.Properties.KeySpec).toBeUndefined();
    expect(key.Properties.KeyUsage).toBeUndefined();
    // §6.5: the account root and nothing else, so IAM identity policies decide.
    const statements: any[] = key.Properties.KeyPolicy.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe('kms:*');
    expect(statements[0].Effect).toBe('Allow');
    expect(renderArn(statements[0].Principal.AWS)).toBe('arn:<AWS::Partition>:iam::123456789012:root');
    // ADR-0019 teardown stance: a key is only ever scheduled for deletion.
    expect(key.DeletionPolicy).toBe('Delete');
    expect(key.Properties.PendingWindowInDays).toBe(7);
    expect(alias.Properties.AliasName).toBe('alias/application-plane/identity/admin-password');
    expect(alias.Properties.TargetKeyId).toEqual({ 'Fn::GetAtt': [keyId, 'Arn'] });
  });

  test.each(DEPLOYMENTS)('the policy: exactly the two §6.3 statements, built from the deployed API id and stage [%s]', (topology) => {
    const template = synth(topology);
    const { policy, keyId } = mount(template);
    const [apiId] = Object.keys(template.findResources('AWS::ApiGateway::RestApi'));
    const stage = Object.values(template.findResources('AWS::ApiGateway::Stage'))[0] as any;
    const statements: any[] = policy.Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(2);

    const [invoke, encrypt] = statements;
    expect(invoke.Effect).toBe('Allow');
    expect(invoke.Action).toBe('execute-api:Invoke');
    expect(invoke.Condition).toBeUndefined();
    const prefix = `arn:<AWS::Partition>:execute-api:eu-central-1:123456789012:<${apiId}>/${stage.Properties.StageName}`;
    expect(invoke.Resource.map(renderArn)).toEqual([
      `${prefix}/POST/platform/tenants`,
      `${prefix}/GET/platform/tenants/*`,
      `${prefix}/DELETE/platform/tenants/*`,
      `${prefix}/POST/platform/tenants/*/users`,
    ]);

    expect(encrypt.Effect).toBe('Allow');
    expect(actionsOf(encrypt).sort()).toEqual(['kms:Encrypt', 'kms:GenerateDataKey']);
    expect(encrypt.Resource).toEqual({ 'Fn::GetAtt': [keyId, 'Arn'] });
    expect(encrypt.Condition).toEqual({ StringEquals: { 'kms:ViaService': 'ssm.eu-central-1.amazonaws.com' } });
  });

  test.each(DEPLOYMENTS)('M-R-4: no Decrypt, and no ListTenants, IssueToken, RefreshToken, user-update or membership route [%s]', (topology) => {
    const template = synth(topology);
    const { policy } = mount(template);
    const statements: any[] = policy.Properties.PolicyDocument.Statement;
    const actions = statements.flatMap(actionsOf);
    expect(actions).not.toContain('kms:Decrypt');
    expect(actions.some((a) => a.includes('*'))).toBe(false);
    const routes: string[] = statements
      .filter((s) => actionsOf(s).includes('execute-api:Invoke'))
      .flatMap((s) => [s.Resource].flat().map(renderArn))
      .map((arn) => arn.slice(arn.indexOf('/prod/') + '/prod'.length));
    expect(routes).toHaveLength(4);
    // ListTenants is GET on the collection; the GET grant is on /platform/tenants/*.
    expect(routes).not.toContain('/GET/platform/tenants');
    for (const route of routes) {
      // IssueToken, RefreshToken, memberships, UpdateUser (PUT/PATCH), and
      // nothing below .../users (the per-user routes).
      expect(route).not.toMatch(/\/token/);
      expect(route).not.toMatch(/\/membership/);
      expect(route).not.toMatch(/^\/(PUT|PATCH|\*)\//);
      expect(route).not.toMatch(/\/users\//);
    }
    // The stage name is never a wildcard: the grant names the one deployed stage.
    for (const s of statements.filter((st) => actionsOf(st).includes('execute-api:Invoke'))) {
      for (const arn of [s.Resource].flat().map(renderArn)) {
        expect(arn).toMatch(/>\/prod\//);
      }
    }
  });

  test.each(DEPLOYMENTS)('nothing in the stack holds kms:Decrypt on the admin-password key (§6.4) [%s]', (topology) => {
    const template = synth(topology);
    const { keyId } = mount(template);
    const statements = allPolicyStatements(template);
    const touching = statements.filter((s) => JSON.stringify(s.Resource).includes(keyId));
    expect(touching).toEqual([]);
  });

  test.each(DEPLOYMENTS)('publishes both ARNs at the fixed parameter names [%s]', (topology) => {
    const template = synth(topology);
    const { policyId, keyId } = mount(template);
    const params = Object.values(template.findResources('AWS::SSM::Parameter')) as any[];
    const byName = Object.fromEntries(params.map((p) => [p.Properties.Name, p.Properties]));
    expect(byName[PARAM_KEY].Type).toBe('String');
    expect(byName[PARAM_KEY].Value).toEqual({ 'Fn::GetAtt': [keyId, 'Arn'] });
    expect(byName[PARAM_POLICY].Type).toBe('String');
    expect(byName[PARAM_POLICY].Value).toEqual({ Ref: policyId });
  });

  test.each(DEPLOYMENTS)('publishSharedParameters=false: no key, no alias, no policy, no parameter (ADR-0017: one owner per account) [%s]', (topology) => {
    const template = synth(topology, false);
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
    template.resourceCountIs('AWS::KMS::Alias', 0);
    // The alarm topic key (M-31) stays; it carries no fixed name.
    const keys = Object.keys(template.findResources('AWS::KMS::Key'));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^AlarmTopicKey/);
    template.resourceCountIs('AWS::SSM::Parameter', 0);
  });

  test('every wildcard route ARN is acknowledged for cdk-nag IAM5 with the threat-model row, once each', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));
    const stack = new TenantIdentityStack(app, 'TenantIdentity-shared-pool', {
      topology: 'shared-pool',
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    const template = Template.fromStack(stack);
    const { policy } = mount(template);
    const rules: { id: string; reason: string }[] = policy.Metadata.cdk_nag.rules_to_suppress;
    const iam5 = rules.filter((r) => r.id.startsWith('AwsSolutions-IAM5['));
    expect(iam5.map((r) => r.id.replace(/^.*\/prod\//, '').replace(/\]$/, '')).sort()).toEqual([
      'DELETE/platform/tenants/*',
      'GET/platform/tenants/*',
      'POST/platform/tenants/*/users',
    ]);
    for (const r of iam5) {
      expect(r.reason).toContain('T-34');
      expect(r.reason).toContain('threat-model.md');
    }
    // No blanket acknowledgment: the exact-route one above is the only kind.
    expect(rules.some((r) => r.id === 'AwsSolutions-IAM5')).toBe(false);
    expect(rules.some((r) => r.id === 'AwsSolutions-IAM5[Resource::*]')).toBe(false);
  });
});

describe('TenantIdentityStack - log groups bounded (teardown, §6.2)', () => {
  test.each(DEPLOYMENTS)('every log group has 30-day retention and Delete removal [%s]', (topology) => {
    const template = synth(topology);
    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup'));
    // Six function log groups + API access logs.
    expect(logGroups.length).toBeGreaterThanOrEqual(7);
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
  test.each(DEPLOYMENTS)('synthesises with no unsuppressed cdk-nag findings [%s]', (topology) => {
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

describe('TenantIdentityStack - teardown drains tenants (ADR-0022)', () => {
  test.each(DEPLOYMENTS)('one Custom::TenantDrain, served by the drain function, deleted before the registry table [%s]', (topology) => {
    const template = synth(topology);
    const resources = template.toJSON().Resources as Record<string, any>;
    const drains = Object.entries(resources).filter(([, r]) => r.Type === 'Custom::TenantDrain');
    expect(drains).toHaveLength(1);
    const [, drain] = drains[0];
    expect(drain.Properties.ServiceToken['Fn::GetAtt'][0]).toMatch(/^TenantDrainFunction/);
    const dependsOn: string[] = [drain.DependsOn ?? []].flat();
    const tables = Object.keys(resources).filter((id) => resources[id].Type === 'AWS::DynamoDB::GlobalTable');
    expect(tables).toHaveLength(1);
    expect(dependsOn).toContain(tables[0]);
    // Shared pools: the drain also runs before the pool and its client go.
    for (const id of Object.keys(resources).filter((k) =>
      ['AWS::Cognito::UserPool', 'AWS::Cognito::UserPoolClient'].includes(resources[k].Type),
    )) {
      expect(dependsOn).toContain(id);
    }
  });

  test.each(DEPLOYMENTS)('the drain function has the platform environment and a 14-minute timeout [%s]', (topology) => {
    const template = synth(topology);
    const [fn] = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([id]) => id.startsWith('TenantDrainFunction'))
      .map(([, r]) => r as any);
    expect(fn).toBeDefined();
    expect(fn.Properties.Timeout).toBe(840);
    const vars = fn.Properties.Environment.Variables;
    expect(vars.TOPOLOGY).toBe(topology);
    expect(vars.TABLE_NAME).toBeDefined();
    if (topology === 'pool-per-tenant') {
      expect(vars.USER_POOL_ID).toBeUndefined();
    } else {
      expect(vars.USER_POOL_ID).toBeDefined();
      expect(vars.APP_CLIENT_ID).toBeDefined();
    }
  });
});

describe('TenantIdentityStack - teardown leaves no log group (ADR-0024)', () => {
  test.each(DEPLOYMENTS)('creates no account-wide API Gateway CloudWatch role [%s]', (topology) => {
    const template = synth(topology);
    template.resourceCountIs('AWS::ApiGateway::Account', 0);
    const roles = Object.values(template.findResources('AWS::IAM::Role')) as any[];
    const managed = roles.flatMap((r) => JSON.stringify(r.Properties.ManagedPolicyArns ?? []));
    expect(managed.join()).not.toContain('AmazonAPIGatewayPushToCloudWatchLogs');
  });

  test.each(DEPLOYMENTS)('owns the execution log group, with retention and Delete [%s]', (topology) => {
    const template = synth(topology);
    const groups = template.findResources('AWS::Logs::LogGroup', {
      Properties: { LogGroupName: { 'Fn::Join': ['', ['API-Gateway-Execution-Logs_', { Ref: Match.anyValue() }, '/prod']] } },
    });
    expect(Object.keys(groups)).toHaveLength(1);
    const [group] = Object.values(groups) as any[];
    expect(group.DeletionPolicy).toBe('Delete');
    expect(group.Properties.RetentionInDays).toBe(30);
  });

  test.each(DEPLOYMENTS)('one drain: every log group is deleted after it, every writer before it [%s]', (topology) => {
    const template = synth(topology);
    const resources = template.toJSON().Resources as Record<string, any>;
    const drains = Object.entries(resources)
      .filter(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && r.Properties.DelaySeconds !== undefined)
      .map(([id]) => id);
    expect(drains).toHaveLength(1);
    const [drain] = drains;
    const dependsOn = (id: string): string[] => [resources[id].DependsOn ?? []].flat();

    // Log groups: each is a dependency of the drain (deleted after it).
    for (const [id, r] of Object.entries(resources)) {
      // The waiter's own group is exempt: nothing ever writes to it.
      if (r.Type === 'AWS::Logs::LogGroup' && !id.includes('LogDrainLogs')) {
        expect(dependsOn(drain)).toContain(id);
      }
    }
    // Writers: what invokes a function or writes the API logs depends on the
    // drain (deleted before it): the stage and TenantDrain.
    const writerTypes = new Set(['AWS::ApiGateway::Stage', 'Custom::TenantDrain']);
    const writers = Object.entries(resources).filter(([, r]) => writerTypes.has(r.Type));
    expect(writers).toHaveLength(2);
    for (const [id] of writers) {
      expect(dependsOn(id)).toContain(drain);
    }
    // The functions and the shared pool are not writers: either depending on
    // the drain would make a cycle through the execution log group, and the
    // functions would wait for the drain on create.
    for (const [id, r] of Object.entries(resources)) {
      if (r.Type === 'AWS::Lambda::Function' || r.Type === 'AWS::Cognito::UserPool') {
        expect(dependsOn(id)).not.toContain(drain);
      }
    }
  });

  test.each(DEPLOYMENTS)('no log group is retained, even with useCdkManagedLogGroup on [%s]', (topology) => {
    // With this feature flag on (as in a reader's app that enables the
    // recommended flags), any function without an explicit log group gets a
    // retained one.
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [], '@aws-cdk/aws-lambda:useCdkManagedLogGroup': true } });
    const stack = new TenantIdentityStack(app, `TenantIdentity-${topology}`, {
      topology,
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    const groups = Object.values(Template.fromStack(stack).findResources('AWS::Logs::LogGroup')) as any[];
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.DeletionPolicy).toBe('Delete');
    }
  });

  test.each(DEPLOYMENTS)('the drain waiter has no permissions, so it cannot create a log group [%s]', (topology) => {
    const template = synth(topology);
    const resources = template.toJSON().Resources as Record<string, any>;
    const waiterRoles = Object.entries(resources)
      .filter(([id, r]) => r.Type === 'AWS::IAM::Role' && id.includes('LogDrain'))
      .map(([id]) => id);
    expect(waiterRoles).toHaveLength(1);
    for (const roleId of waiterRoles) {
      expect(resources[roleId].Properties.ManagedPolicyArns ?? []).toEqual([]);
      const attached = Object.values(resources).filter(
        (r: any) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes(roleId),
      );
      expect(attached).toEqual([]);
    }
  });

  test.each(DEPLOYMENTS)('the drain waiters write no logs: system WARN, application ERROR [%s]', (topology) => {
    const template = synth(topology);
    const resources = template.toJSON().Resources as Record<string, any>;
    const waiters = Object.entries(resources).filter(
      ([id, r]) => r.Type === 'AWS::Lambda::Function' && id.includes('LogDrain'),
    );
    expect(waiters).toHaveLength(1);
    for (const [, fn] of waiters) {
      expect(fn.Properties.LoggingConfig).toMatchObject({
        LogFormat: 'JSON',
        SystemLogLevel: 'WARN',
        ApplicationLogLevel: 'ERROR',
      });
    }
  });
});

// ===========================================================================
// ADR-0025: per-tenant throttling on /tenant/*
// ===========================================================================

/** Every statement of every role whose logical id starts with `prefix`, apigateway actions only. */
function apigatewayActions(template: Template, rolePrefix: string): any[] {
  return policyStatementsForRole(template, rolePrefix).filter((s) => actionsOf(s).some((a) => a.startsWith('apigateway:')));
}

describe('TenantIdentityStack - per-tenant usage plan (ADR-0025)', () => {
  test.each(DEPLOYMENTS)('API key source AUTHORIZER; a key is required on every /tenant method and on no other [%s]', (topology) => {
    const template = synth(topology);
    const body = (Object.values(template.findResources('AWS::ApiGateway::RestApi'))[0] as any).Properties.Body;
    expect(body['x-amazon-apigateway-api-key-source']).toBe('AUTHORIZER');
    expect(body.components.securitySchemes.api_key).toEqual({ type: 'apiKey', name: 'x-api-key', in: 'header' });
    let tenantOps = 0;
    for (const [pathKey, item] of Object.entries(body.paths as Record<string, any>)) {
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        if (!['get', 'put', 'post', 'delete', 'patch'].includes(method)) {
          continue;
        }
        const keyed = ((op.security ?? []) as any[]).some((r) => r.api_key !== undefined);
        expect({ op: `${method} ${pathKey}`, keyed }).toEqual({ op: `${method} ${pathKey}`, keyed: pathKey.startsWith('/tenant') });
        if (pathKey.startsWith('/tenant')) {
          tenantOps++;
          // The authoriser still runs: the key is AND-ed, not an alternative.
          expect(op.security).toEqual([{ 'tenant-authorizer': [], 'api_key': [] }]);
        }
      }
    }
    expect(tenantOps).toBe(5);
  });

  test.each(TOPOLOGIES)('a single topology: one usage plan on the stage, throttled at the /tenant values (N-7) [%s]', (topology) => {
    const template = synth(topology);
    template.resourceCountIs('AWS::ApiGateway::UsagePlan', 1);
    const plan = Object.values(template.findResources('AWS::ApiGateway::UsagePlan'))[0] as any;
    expect(plan.Properties.UsagePlanName).toBe(`TenantIdentity-${topology}-tenant`);
    expect(plan.Properties.Throttle).toEqual({ RateLimit: 10, BurstLimit: 20 });
    expect(plan.Properties.Quota).toBeUndefined();
    expect(plan.Properties.ApiStages).toHaveLength(1);
    const [apiStage] = plan.Properties.ApiStages;
    const [apiId] = Object.keys(template.findResources('AWS::ApiGateway::RestApi'));
    const [stageId] = Object.keys(template.findResources('AWS::ApiGateway::Stage'));
    expect(apiStage.ApiId).toEqual({ Ref: apiId });
    expect(apiStage.Stage).toEqual({ Ref: stageId });
    // No key is created at deploy time: CreateTenant creates one per tenant.
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 0);
    template.resourceCountIs('AWS::ApiGateway::UsagePlanKey', 0);
  });

  test.each(DEPLOYMENTS)('platform role: create/delete keys, find the plan, add keys to THIS plan only [%s]', (topology) => {
    const template = synth(topology);
    const statements = apigatewayActions(template, 'PlatformFunctionServiceRole');
    const render = (s: any) => JSON.stringify(s.Resource);
    const byAction = (action: string) => statements.filter((s) => actionsOf(s).includes(action)).map(render);
    expect(statements.flatMap(actionsOf).sort()).toEqual(['apigateway:DELETE', 'apigateway:GET', 'apigateway:POST', 'apigateway:POST', 'apigateway:PUT']);
    // Tag-on-create is authorised as PUT on the key's /tags ARN, same conditions.
    const tagPut = statements.find((st) => actionsOf(st).includes('apigateway:PUT'));
    expect(render(tagPut)).toContain('/tags/arn%3A');
    expect(render(tagPut)).toContain('%2Fapikeys%2F*');
    expect(tagPut.Condition['ForAllValues:StringEquals']).toEqual({ 'aws:TagKeys': ['tenant-identity:stack'] });
    expect(tagPut.Condition.StringEqualsIfExists).toEqual({ 'aws:ResourceTag/tenant-identity:stack': `TenantIdentity-${topology}` });
    expect(byAction('apigateway:DELETE')).toEqual([expect.stringContaining('::/apikeys/*')]);
    const stackName = `TenantIdentity-${topology}`;
    // T-7: delete only keys this stack tagged; create only keys with that tag and no other tag key.
    const del = statements.find((st) => actionsOf(st).includes('apigateway:DELETE'));
    expect(del.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/tenant-identity:stack': stackName } });
    const createKey = statements.find((st) => actionsOf(st).includes('apigateway:POST') && render(st).includes('::/apikeys"'));
    expect(createKey.Condition).toEqual({
      'StringEquals': { 'aws:RequestTag/tenant-identity:stack': stackName },
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['tenant-identity:stack'] },
    });
    expect(byAction('apigateway:GET')).toEqual([expect.stringContaining('::/usageplans"')]);
    const posts = byAction('apigateway:POST');
    expect(posts.some((r) => r.includes('::/apikeys"'))).toBe(true);
    const [planId] = Object.keys(template.findResources('AWS::ApiGateway::UsagePlan'));
    expect(posts.some((r) => r.includes(`"Ref":"${planId}"`) && r.includes('/keys'))).toBe(true);
    // The plan-specific statement lives outside the default policy (no cycle).
    const policies = template.findResources('AWS::IAM::Policy');
    const [owner] = Object.entries(policies).filter(([, p]) => JSON.stringify(p).includes(`"Ref":"${planId}"`));
    expect(owner[0]).toMatch(/^PlatformFunctionUsagePlanKeyPolicy/);
    // The function finds the plan by name.
    const [, fn] = Object.entries(template.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('PlatformFunction'))!;
    expect((fn as any).Properties.Environment.Variables.TENANT_USAGE_PLAN_NAME).toBe(`TenantIdentity-${topology}-tenant`);
    expect((fn as any).Properties.Environment.Variables.STACK_NAME).toBe(stackName);
  });

  test.each(DEPLOYMENTS)('drain role: DeleteApiKey only; no other role holds an apigateway action [%s]', (topology) => {
    const template = synth(topology);
    const drain = apigatewayActions(template, 'TenantDrainFunctionServiceRole');
    expect(drain.flatMap(actionsOf)).toEqual(['apigateway:DELETE']);
    expect(JSON.stringify(drain[0].Resource)).toContain('::/apikeys/*');
    expect(drain[0].Condition).toEqual({ StringEquals: { 'aws:ResourceTag/tenant-identity:stack': `TenantIdentity-${topology}` } });
    for (const role of ['TriggerFunctionServiceRole', 'TokenFunctionServiceRole', 'AuthorizerFunctionServiceRole', 'TenantUsersFunctionServiceRole']) {
      expect({ role, actions: apigatewayActions(template, role).flatMap(actionsOf) }).toEqual({ role, actions: [] });
    }
  });

  test.each(DEPLOYMENTS)('the tenant drain runs before every usage plan is deleted (ADR-0022) [%s]', (topology) => {
    const template = synth(topology);
    const resources = template.toJSON().Resources as Record<string, any>;
    const [, drain] = Object.entries(resources).find(([, r]) => r.Type === 'Custom::TenantDrain')!;
    const planIds = Object.keys(template.findResources('AWS::ApiGateway::UsagePlan'));
    expect(planIds.length).toBeGreaterThan(0);
    for (const planId of planIds) {
      expect([drain.DependsOn ?? []].flat()).toContain(planId);
    }
  });

  test.each(DEPLOYMENTS)('publishes the usage plan id for the e2e scenario [%s]', (topology) => {
    const template = synth(topology);
    expect(Object.keys(template.findOutputs('TenantUsagePlanId'))).toEqual(['TenantUsagePlanId']);
  });
});

// ===========================================================================
// ADR-0026: IAM-enforced tenant boundary (pool-per-tenant)
// ===========================================================================

describe('TenantIdentityStack - tenant-scoped role (ADR-0026)', () => {
  function scopedRole(template: Template): [string, any] {
    const roles = Object.entries(template.findResources('AWS::IAM::Role')).filter(([id]) => id.startsWith('TenantScopedRole'));
    expect(roles).toHaveLength(1);
    return roles[0];
  }

  test('trust: only the tenant-user function role, AssumeRole + TagSession, exactly one ULID-shaped TenantId tag', () => {
    const template = synth('pool-per-tenant');
    const [, role] = scopedRole(template);
    const statements = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    const [trust] = statements;
    expect(trust.Effect).toBe('Allow');
    expect([trust.Action].flat().sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    // The principal is the tenant-user function's role, nothing else.
    expect(Object.keys(trust.Principal)).toEqual(['AWS']);
    expect(JSON.stringify(trust.Principal.AWS)).toMatch(/TenantUsersFunctionServiceRole[0-9A-F]+","Arn"/);
    expect(trust.Condition).toEqual({
      'StringLike': { 'aws:RequestTag/TenantId': '?'.repeat(26) },
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['TenantId'] },
    });
  });

  test('permissions: the tenant-user actions on userpool/*, only where the pool\'s tenant tag equals the session tag', () => {
    const template = synth('pool-per-tenant');
    const statements = policyStatementsForRole(template, 'TenantScopedRole');
    expect(statements).toHaveLength(1);
    const [allow] = statements;
    expect(actionsOf(allow).sort()).toEqual([...TENANT_USER_ACTIONS].sort());
    expect(JSON.stringify(allow.Resource)).toContain(':userpool/*');
    expect(allow.Condition).toEqual({
      StringEquals: {
        'aws:ResourceTag/sample': 'tenant-identity',
        'aws:ResourceTag/tenant-identity:stack': 'TenantIdentity-pool-per-tenant',
        'aws:ResourceTag/tenant-identity:tenant': '${aws:PrincipalTag/TenantId}',
      },
    });
    // No sign-in and no lifecycle action (R-8, P-8).
    for (const forbidden of ['cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminInitiateAuth', 'cognito-idp:DeleteUserPool', 'cognito-idp:CreateGroup']) {
      expect(actionsOf(allow)).not.toContain(forbidden);
    }
  });

  test('the tenant-user base role holds no cognito-idp action, only AssumeRole + TagSession on the scoped role', () => {
    const template = synth('pool-per-tenant');
    const [roleId] = scopedRole(template);
    const statements = policyStatementsForRole(template, 'TenantUsersFunctionServiceRole');
    const actions = statements.flatMap(actionsOf);
    expect(actions.some((a) => a.startsWith('cognito-idp:'))).toBe(false);
    const sts = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('sts:')));
    expect(sts).toHaveLength(1);
    expect(actionsOf(sts[0]).sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(sts[0].Resource).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
    const [, fn] = Object.entries(template.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('TenantUsersFunction'))!;
    expect((fn as any).Properties.Environment.Variables.TENANT_SCOPED_ROLE_ARN).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
  });

  test('the platform role may tag a new pool with its tenant (ADR-0026)', () => {
    const template = synth('pool-per-tenant');
    const tag = policyStatementsForRole(template, 'PlatformFunctionServiceRole').find((s) => actionsOf(s).includes('cognito-idp:TagResource'));
    expect(tag.Condition.StringLike['aws:RequestTag/tenant-identity:tenant']).toBe('?'.repeat(26));
  });

  test.each(['shared-pool', 'shared-pool-multi-tenant'] as Deployment[])('shared pools: no scoped role; IAM cannot scope users inside one pool [%s]', (topology) => {
    const template = synth(topology);
    expect(Object.keys(template.findResources('AWS::IAM::Role')).filter((id) => id.startsWith('TenantScopedRole'))).toEqual([]);
    const statements = policyStatementsForRole(template, 'TenantUsersFunctionServiceRole');
    const actions = statements.flatMap(actionsOf);
    expect(actions.some((a) => a.startsWith('sts:'))).toBe(false);
    expect(actions.filter((a) => a.startsWith('cognito-idp:')).sort()).toEqual([...TENANT_USER_ACTIONS].sort());
    const [, fn] = Object.entries(template.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('TenantUsersFunction'))!;
    expect((fn as any).Properties.Environment.Variables.TENANT_SCOPED_ROLE_ARN).toBeUndefined();
    expect(Object.keys(template.findOutputs('TenantScopedRoleArn'))).toEqual([]);
  });
});

// ===========================================================================
// ADR-0027: tiered deployment - both halves in one stack
// ===========================================================================

describe('TenantIdentityStack - tiered (ADR-0027)', () => {
  const template = synth('tiered');
  const fnById = (prefix: string) =>
    Object.entries(template.findResources('AWS::Lambda::Function')).find(
      ([id]) => id.startsWith(prefix) && !id.includes('ServiceRole'),
    )![1] as any;

  test('exactly one stack pool, with the shared-pool tenantId custom attribute (standard tier = shared-pool)', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    const pool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0] as any;
    const tenantAttr = (pool.Properties.Schema as any[]).find((a) => a.Name === 'tenantId');
    expect(tenantAttr).toMatchObject({ Mutable: false, StringAttributeConstraints: { MaxLength: '26', MinLength: '26' } });
    expect(pool.Properties.LambdaConfig.PreTokenGenerationConfig.LambdaVersion).toBe('V2_0');
  });

  test('platform role: CreateUserPool with the tag conditions AND the shared pool ARN grants', () => {
    const statements = policyStatementsForRole(template, 'PlatformFunctionServiceRole');
    // Premium half: pool creation, tag-conditioned (N-3, ADR-0026).
    const createPool = statements.find((s) => actionsOf(s).includes('cognito-idp:CreateUserPool'));
    expect(createPool.Resource).toBe('*');
    expect(createPool.Condition.StringEquals['aws:RequestTag/tenant-identity:stack']).toBe('TenantIdentity-tiered');
    expect(createPool.Condition.StringLike['aws:RequestTag/tenant-identity:tenant']).toBe('?'.repeat(26));
    const perPool = statements.find((s) => actionsOf(s).includes('cognito-idp:DeleteUserPool'));
    expect(JSON.stringify(perPool.Resource)).toContain('userpool/*');
    expect(perPool.Condition.StringEquals['aws:ResourceTag/tenant-identity:stack']).toBe('TenantIdentity-tiered');
    // Standard half: per-pool user + group actions on the one stack pool.
    const [poolId] = Object.keys(template.findResources('AWS::Cognito::UserPool'));
    const shared = statements.find(
      (s) => actionsOf(s).includes('cognito-idp:AdminCreateUser') && JSON.stringify(s.Resource).includes(poolId),
    );
    expect(shared).toBeDefined();
    expect(shared.Condition).toBeUndefined();
    expect(actionsOf(shared)).toContain('cognito-idp:CreateGroup');
    // The trigger is attached by the stack to the shared pool and by the
    // platform function to every premium pool (§7.1).
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'cognito-idp.amazonaws.com',
      SourceAccount: '123456789012',
    });
    expect(fnById('PlatformFunction').Properties.Environment.Variables.TRIGGER_FUNCTION_ARN).toBeDefined();
  });

  test('two usage plans on the same stage: standard 10/20, premium 25/50, both under the /tenant ceiling (T-31)', () => {
    template.resourceCountIs('AWS::ApiGateway::UsagePlan', 2);
    const plans = Object.values(template.findResources('AWS::ApiGateway::UsagePlan')) as any[];
    const byName = Object.fromEntries(plans.map((p) => [p.Properties.UsagePlanName, p.Properties]));
    expect(byName['TenantIdentity-tiered-tenant'].Throttle).toEqual({ RateLimit: 10, BurstLimit: 20 });
    expect(byName['TenantIdentity-tiered-tenant-premium'].Throttle).toEqual({ RateLimit: 25, BurstLimit: 50 });
    const [stageId] = Object.keys(template.findResources('AWS::ApiGateway::Stage'));
    for (const plan of plans) {
      expect(plan.Properties.ApiStages).toHaveLength(1);
      expect(plan.Properties.ApiStages[0]).toMatchObject({ ApiId: { Ref: expect.any(String) }, Stage: { Ref: stageId } });
      expect(plan.Properties.Throttle.RateLimit).toBeLessThan(50);
      expect(plan.Properties.Throttle.BurstLimit).toBeLessThan(100);
    }
    expect(Object.keys(template.findOutputs('PremiumUsagePlanId'))).toEqual(['PremiumUsagePlanId']);
  });

  test('platform function knows both plan names and may add keys to both plans, outside its default policy', () => {
    const vars = fnById('PlatformFunction').Properties.Environment.Variables;
    expect(vars.TENANT_USAGE_PLAN_NAME).toBe('TenantIdentity-tiered-tenant');
    expect(vars.PREMIUM_USAGE_PLAN_NAME).toBe('TenantIdentity-tiered-tenant-premium');
    const planIds = Object.keys(template.findResources('AWS::ApiGateway::UsagePlan'));
    expect(planIds).toHaveLength(2);
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'));
    const keyPolicies = policies.filter(([id]) => id.startsWith('PlatformFunctionUsagePlanKeyPolicy'));
    expect(keyPolicies).toHaveLength(1);
    const [[, keyPolicy]] = keyPolicies;
    const rendered = JSON.stringify(keyPolicy);
    for (const planId of planIds) {
      expect(rendered).toContain(`"Ref":"${planId}"`);
      // Nowhere else: the default policy must not reference a plan (cycle).
      const others = policies.filter(
        ([id, p]) => !id.startsWith('PlatformFunctionUsagePlanKeyPolicy') && JSON.stringify(p).includes(`"Ref":"${planId}"`),
      );
      expect(others).toEqual([]);
    }
    const statements = (keyPolicy as any).Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(actionsOf(statements[0])).toEqual(['apigateway:POST']);
    expect(JSON.stringify(statements[0].Resource)).toContain('/keys');
  });

  test('tenant-user role: the shared pool grant (standard, T-18 code wall) AND the scoped role (premium, ADR-0026)', () => {
    const statements = policyStatementsForRole(template, 'TenantUsersFunctionServiceRole');
    const [poolId] = Object.keys(template.findResources('AWS::Cognito::UserPool'));
    const cognito = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('cognito-idp:')));
    expect(cognito).toHaveLength(1);
    expect(actionsOf(cognito[0]).sort()).toEqual([...TENANT_USER_ACTIONS].sort());
    expect(JSON.stringify(cognito[0].Resource)).toContain(poolId);
    // Never userpool/*: premium pools are reached only through the scoped role.
    expect(JSON.stringify(cognito[0].Resource)).not.toContain('userpool/*');
    const [roleId] = Object.keys(template.findResources('AWS::IAM::Role')).filter((id) => id.startsWith('TenantScopedRole'));
    expect(roleId).toBeDefined();
    const sts = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('sts:')));
    expect(sts).toHaveLength(1);
    expect(actionsOf(sts[0]).sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(sts[0].Resource).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
    const vars = fnById('TenantUsersFunction').Properties.Environment.Variables;
    expect(vars.TENANT_SCOPED_ROLE_ARN).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
    expect(vars.USER_POOL_ID).toBeDefined();
    expect(vars.APP_CLIENT_ID).toBeDefined();
    expect(vars.TOPOLOGY).toBe('tiered');
    expect(Object.keys(template.findOutputs('TenantScopedRoleArn'))).toEqual(['TenantScopedRoleArn']);
    // The scoped role's permissions name this stack (N-3).
    const [allow] = policyStatementsForRole(template, 'TenantScopedRole');
    expect(allow.Condition.StringEquals['aws:ResourceTag/tenant-identity:stack']).toBe('TenantIdentity-tiered');
  });

  test('every function that reads TOPOLOGY gets the deployment value, tiered', () => {
    for (const prefix of ['TriggerFunction', 'PlatformFunction', 'TenantUsersFunction', 'TenantDrainFunction', 'TokenFunction', 'AuthorizerFunction']) {
      expect(fnById(prefix).Properties.Environment.Variables.TOPOLOGY).toBe('tiered');
    }
  });

  test('shared parameters: topology=tiered plus the standard tier\'s pool and client', () => {
    const params = Object.values(template.findResources('AWS::SSM::Parameter')) as any[];
    const byName = Object.fromEntries(params.map((p) => [p.Properties.Name, p.Properties.Value]));
    expect(byName['/application-plane/shared/identity/topology']).toBe('tiered');
    const [poolId] = Object.keys(template.findResources('AWS::Cognito::UserPool'));
    const [clientId] = Object.keys(template.findResources('AWS::Cognito::UserPoolClient'));
    expect(byName['/application-plane/shared/identity/userPoolId']).toEqual({ Ref: poolId });
    expect(byName['/application-plane/shared/identity/appClientId']).toEqual({ Ref: clientId });
    template.hasOutput('UserPoolId', {});
    template.hasOutput('AppClientId', {});
  });

  test('the drain runs before the shared pool, its client, and both plans go (ADR-0022)', () => {
    const resources = template.toJSON().Resources as Record<string, any>;
    const [, drain] = Object.entries(resources).find(([, r]) => r.Type === 'Custom::TenantDrain')!;
    const dependsOn: string[] = [drain.DependsOn ?? []].flat();
    for (const type of ['AWS::Cognito::UserPool', 'AWS::Cognito::UserPoolClient', 'AWS::ApiGateway::UsagePlan', 'AWS::DynamoDB::GlobalTable']) {
      for (const id of Object.keys(template.findResources(type))) {
        expect(dependsOn).toContain(id);
      }
    }
  });
});

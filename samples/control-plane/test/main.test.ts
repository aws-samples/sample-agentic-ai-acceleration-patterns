// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import { App, Environment, Token } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { buildEnvironment, evaluateJsonata } from './workflow-jsonata';
import { CellAccountStack, CellAccountStackProps, TRUST_POLICY_DEFAULT_QUOTA } from '../src/cell-account/cell-account.cdk';
import { isFullCommitSha, sourcePinningWarning } from '../src/shared/service-config';
import {
  TenantStack,
  TenantStackProps,
  validateCellBuildManagedPolicyArns,
  validateTenantBuildManagedPolicyArns,
} from '../src/tenant/tenant.cdk';
import { validateConcurrentBuildLimit } from '../src/tenant/validation';

// The session tag conditions written out with literal key lists, so the
// trust tests do not compare the template to the function that built it
// (ADR-0051). `transitive` adds the TagSession statement's
// `sts:TransitiveTagKeys` conditions.
function literalTagConditions(kind: 'cell' | 'tenant', transitive: boolean): any {
  const keys = kind === 'cell' ? ['CellId'] : ['CellId', 'TenantId', 'ApplicationId'];
  const present = Object.fromEntries(keys.map((key) => [`aws:RequestTag/${key}`, 'false']));
  return transitive
    ? {
      'Null': { ...present, 'sts:TransitiveTagKeys': 'false' },
      'ForAllValues:StringEquals': { 'aws:TagKeys': keys, 'sts:TransitiveTagKeys': keys },
    }
    : { 'Null': present, 'ForAllValues:StringEquals': { 'aws:TagKeys': keys } };
}

// Skip NodejsFunction esbuild bundling in unit tests - assertions target
// infrastructure shape, not bundle contents.
function synth(extraProps: Partial<TenantStackProps> = {}, env?: Environment): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TenantStack(app, 'test', {
    vendorIdpIssuerUrl: 'https://idp.example.com',
    vendorIdpAudience: 'control-plane',
    env,
    ...extraProps,
  });
  return Template.fromStack(stack);
}

describe('TenantStack', () => {
  const template = synth();

  test('control plane table has PITR enabled and three GSIs (§4.7)', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([
        Match.objectLike({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      ]),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'GSI1' }),
        Match.objectLike({ IndexName: 'GSI2' }),
        Match.objectLike({
          IndexName: 'GSI3',
          KeySchema: [
            { AttributeName: 'GSI3PK', KeyType: 'HASH' },
            { AttributeName: 'GSI3SK', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
    const table = Object.values(template.findResources('AWS::DynamoDB::GlobalTable'))[0] as any;
    expect(table.Properties.GlobalSecondaryIndexes).toHaveLength(3);
  });

  test('provisioning state machine and the four shared CodeBuild projects exist', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    // One project for cell builds, one for tenant builds (ADR-002, ADR-012),
    // one for global hooks, one for application hooks (R-41, ADR-044).
    template.resourceCountIs('AWS::CodeBuild::Project', 4);
  });

  test('state machine may start and poll builds on the shared projects only', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['codebuild:StartBuild', 'codebuild:StopBuild', 'codebuild:BatchGetBuilds'],
          }),
        ]),
      },
    });
  });

  test('API is created from the OpenAPI spec with patched integrations', () => {
    const apis = template.findResources('AWS::ApiGateway::RestApi');
    const api = Object.values(apis)[0] as any;
    const body = api.Properties.Body;
    // All PLACEHOLDER URIs were patched at synth time
    expect(JSON.stringify(body)).not.toContain('PLACEHOLDER');
    // Token authorizer present
    const authorizer =
      body.components.securitySchemes['vendor-authorizer']['x-amazon-apigateway-authorizer'];
    expect(authorizer.type).toBe('token');
    // All twenty-six operations (§5) across thirteen paths exist
    expect(Object.keys(body.paths).sort()).toEqual([
      '/accounts',
      '/accounts/{accountId}',
      '/applications',
      '/applications/{applicationId}',
      '/cells',
      '/cells/{cellId}',
      '/deployments',
      '/hooks',
      '/hooks/{hookId}',
      '/tenants',
      '/tenants/{tenantId}',
      '/tenants/{tenantId}/deployments',
      '/tenants/{tenantId}/deployments/{applicationId}',
    ]);
    const operations = Object.values(body.paths).flatMap((path: any) =>
      Object.keys(path).filter((method) => method !== 'parameters'));
    expect(operations).toHaveLength(26);
  });

  test('API handler receives the three index names and no CELL_DEFINITION (ADR-032)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GSI1_NAME: 'GSI1',
          GSI2_NAME: 'GSI2',
          GSI3_NAME: 'GSI3',
        }),
      },
    });
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    for (const fn of fns) {
      expect(fn.Properties.Environment?.Variables?.CELL_DEFINITION).toBeUndefined();
    }
  });

  test('authorizer receives the vendor IdP configuration and the role allowlist (M13)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          VENDOR_IDP_ISSUER_URL: 'https://idp.example.com',
          VENDOR_IDP_AUDIENCE: 'control-plane',
          ALLOWED_ROLES: 'operator',
          READER_ROLES: '',
          VENDOR_IDP_CLIENT_IDS: '',
          VENDOR_IDP_REQUIRED_SCOPE: '',
        },
      },
    });
  });

  test('role lists reach the authorizer as comma-separated values (R-36)', () => {
    const t = synth({ allowedRoles: ['operator', 'cp:admin'], readerRoles: ['control-plane:reader'] });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ALLOWED_ROLES: 'operator,cp:admin',
          READER_ROLES: 'control-plane:reader',
        }),
      },
    });
  });

  test.each([
    [{ allowedRoles: [] }, /allowedRoles must name at least one role/],
    [{ readerRoles: ['operator'] }, /"operator" is in both allowedRoles and readerRoles/],
    [{ readerRoles: ['a,b'] }, /readerRoles\[0\] "a,b" does not match/],
    [{ allowedRoles: ['has space'] }, /allowedRoles\[0\] "has space" does not match/],
  ])('invalid role lists fail synth (R-36): %j', (props, message) => {
    expect(() => synth(props as Partial<TenantStackProps>)).toThrow(message);
  });

  test('client ids reach the authorizer as a comma-separated value (R-38, M27)', () => {
    const t = synth({ vendorIdpClientIds: ['abc123client', 'ci+bot'] });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ VENDOR_IDP_CLIENT_IDS: 'abc123client,ci+bot' }),
      },
    });
  });

  test.each([
    [{ vendorIdpClientIds: ['a,b'] }, /vendorIdpClientIds\[0\] "a,b" does not match/],
    [{ vendorIdpClientIds: [''] }, /vendorIdpClientIds\[0\] "" does not match/],
    [{ vendorIdpClientIds: ['dup', 'dup'] }, /vendorIdpClientIds lists "dup" twice/],
    [{ vendorIdpClientIds: 'abc' }, /vendorIdpClientIds must be an array of strings/],
    [{ vendorIdpClientIds: [Token.asString({ Ref: 'Client' }), 'a b'] }, /vendorIdpClientIds\[1\] "a b" does not match/],
  ])('invalid client ids fail synth (R-38): %j', (props, message) => {
    expect(() => synth(props as unknown as Partial<TenantStackProps>)).toThrow(message);
  });

  test('a required scope reaches the authorizer (R-38, M27)', () => {
    const t = synth({ vendorIdpClientIds: ['abc123client'], vendorIdpRequiredScope: 'control-plane/read' });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ VENDOR_IDP_REQUIRED_SCOPE: 'control-plane/read' }),
      },
    });
  });

  test.each([
    [{ vendorIdpRequiredScope: 'control-plane/read' }, /needs at least one vendorIdpClientIds entry/],
    [{ vendorIdpClientIds: ['abc'], vendorIdpRequiredScope: 'a b' }, /vendorIdpRequiredScope "a b" does not match/],
    [{ vendorIdpClientIds: ['abc'], vendorIdpRequiredScope: '' }, /vendorIdpRequiredScope "" does not match/],
    [{ vendorIdpClientIds: ['abc'], vendorIdpRequiredScope: Token.asString({ Ref: 'Scope' }) }, /must be a literal string, not a CDK token/],
  ])('an invalid required scope fails synth (R-38): %j', (props, message) => {
    expect(() => synth(props as Partial<TenantStackProps>)).toThrow(message);
  });

  test('one client id token listed twice fails synth (R-38)', () => {
    // A construct attribute returns the same token string on every read.
    const clientId = Token.asString({ Ref: 'Client' });
    expect(() => synth({ vendorIdpClientIds: [clientId, clientId] })).toThrow(/vendorIdpClientIds lists .* twice/);
  });

  test('no demo shared parameter by default; one per demoApplicationIds entry (ADR-034)', () => {
    const names = (t: Template) =>
      (Object.values(t.findResources('AWS::SSM::Parameter')) as any[])
        .map((p) => p.Properties.Name)
        .filter((name) => name !== '/control-plane/tenant-api-url')
        .sort();
    expect(names(template)).toEqual([]);
    expect(names(synth({ demoApplicationIds: ['app-x', 'app-y'] }))).toEqual([
      '/application-plane/applications/app-x/shared/base-domain',
      '/application-plane/applications/app-y/shared/base-domain',
    ]);
  });

  test('API url is published to SSM for discovery', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/control-plane/tenant-api-url',
    });
  });

  test('access logging attributes every request to the authorizer principal (T9 / M12)', () => {
    const stages = template.findResources('AWS::ApiGateway::Stage');
    const stage = Object.values(stages)[0] as any;
    const accessLog = stage.Properties.AccessLogSetting;
    expect(accessLog.DestinationArn).toBeDefined();
    const format = JSON.parse(accessLog.Format);
    // The operator identity — the verified JWT sub — is the audit chain's
    // first link, present on Allow AND Deny.
    expect(format.operatorId).toBe('$context.authorizer.principalId');
    // M26: the grant the caller held, so a reader's calls are told apart.
    expect(format.grant).toBe('$context.authorizer.grant');
    // The minimum attribution fields.
    expect(format.requestId).toBe('$context.requestId');
    expect(format.ip).toBe('$context.identity.sourceIp');
    expect(format.requestTime).toBe('$context.requestTime');
    expect(format.httpMethod).toBe('$context.httpMethod');
    expect(format.resourcePath).toBe('$context.resourcePath');
    expect(format.status).toBe('$context.status');
  });

  test('every CodeBuild project caps concurrent builds at 5 by default (T16 / M17)', () => {
    const projects = Object.values(template.findResources('AWS::CodeBuild::Project'));
    expect(projects).toHaveLength(4);
    for (const project of projects as any[]) {
      expect(project.Properties.ConcurrentBuildLimit).toBe(5);
    }
  });

  test('surge, client-error and skipped-hook alarms exist without actions (T16 / M17, T42)', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    // State machine execution surge — the CreateTenant amplification signature.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/States',
      MetricName: 'ExecutionsStarted',
      Statistic: 'Sum',
      Period: 300,
      Threshold: 20,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    // API 4XX — probing / leaked-token signature at the edge.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApiGateway',
      MetricName: '4XXError',
      Period: 300,
      Threshold: 50,
    });
  });

  test('every log group has bounded retention (T13 / M15)', () => {
    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup'));
    // API access logs, state machine logs, two CodeBuild project logs, two
    // Lambda function logs — none may default to never-expire.
    expect(logGroups.length).toBeGreaterThanOrEqual(6);
    for (const logGroup of logGroups as any[]) {
      expect(logGroup.Properties.RetentionInDays).toBe(30);
    }
  });

  test('the workflow forwards the operator identity and the source pin to CodeBuild (M12 / M10)', () => {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const definition = JSON.stringify(
      (Object.values(machines)[0] as any).Properties.DefinitionString,
    );
    // M12 (T10): OPERATOR_ID rides every build's environment overrides.
    expect(definition).toContain('OPERATOR_ID');
    expect(definition).toContain('$states.input.operatorId');
    // M10 (T5): a non-empty stamped pin becomes the SourceVersion override;
    // the pinned/unpinned split means the empty string is never sent.
    expect(definition).toContain('SourceVersion');
    expect(definition).toContain('$states.input.sourceVersion');
  });
});

// Supply-chain pinning validation (threat model T5, mitigation M10):
// warn-and-allow — a full commit SHA is silent, everything else warns.
describe('source pinning (T5 / M10)', () => {
  const fullSha = '4f0c9e1b2a3d4c5e6f708192a3b4c5d6e7f80912';

  test('isFullCommitSha accepts a full 40-char commit SHA only', () => {
    expect(isFullCommitSha(fullSha)).toBe(true);
    expect(isFullCommitSha(fullSha.toUpperCase())).toBe(true);
    expect(isFullCommitSha(fullSha.slice(0, 7))).toBe(false); // short SHA is resolvable, not pinned
    expect(isFullCommitSha('main')).toBe(false);
    expect(isFullCommitSha('v1.2.3')).toBe(false);
    expect(isFullCommitSha('')).toBe(false);
    expect(isFullCommitSha(undefined)).toBe(false);
    expect(isFullCommitSha(`${fullSha}0`)).toBe(false); // 41 chars
    expect(isFullCommitSha('z'.repeat(40))).toBe(false); // not hex
  });

  test('a full commit SHA is accepted silently', () => {
    expect(sourcePinningWarning({ location: 'https://github.com/acme/provisioning.git', sourceVersion: fullSha }))
      .toBeUndefined();
  });

  test('a branch or tag ref warns about the supply-chain risk', () => {
    for (const mutableRef of ['main', 'release/2026-09', 'v1.2.3']) {
      const warning = sourcePinningWarning({ location: 'https://...', sourceVersion: mutableRef });
      expect(warning).toContain(mutableRef);
      expect(warning).toContain('mutable ref');
      expect(warning).toMatch(/T5/);
      expect(warning).toMatch(/commit SHA/);
    }
  });

  test('an absent sourceVersion warns that builds fetch the default branch HEAD', () => {
    for (const source of [
      { location: 'https://...' },
      { location: 'https://...', sourceVersion: '' },
      { location: 'https://...', sourceVersion: '   ' },
      undefined,
    ]) {
      const warning = sourcePinningWarning(source);
      expect(warning).toContain('default branch HEAD');
      expect(warning).toMatch(/T5/);
    }
  });
});

// ---------------------------------------------------------------------------
// Template helpers for the provisioning workflow and the two build roles.
// ---------------------------------------------------------------------------

/** The two CodeBuild projects, told apart by their description. */
function buildProjects(template: Template): { cell: any; tenant: any } {
  const projects = Object.values(template.findResources('AWS::CodeBuild::Project')) as any[];
  const byDescription = (prefix: string) =>
    projects.find((p) => String(p.Properties.Description).startsWith(prefix));
  return { cell: byDescription('Cell provisioning'), tenant: byDescription('Tenant provisioning') };
}

/** The IAM role resource behind a CodeBuild project's ServiceRole GetAtt. */
function serviceRole(template: Template, project: any): any {
  const [logicalId] = project.Properties.ServiceRole['Fn::GetAtt'];
  return template.findResources('AWS::IAM::Role')[logicalId];
}

/**
 * The state machine definition as an object. The DefinitionString is an
 * Fn::Join of literal fragments and intrinsics (project names, table name);
 * each intrinsic sits inside a JSON string value, so a placeholder keeps
 * the document parseable.
 */
function stateMachineDefinition(template: Template): Record<string, any> {
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0] as any;
  const definition = machine.Properties.DefinitionString;
  const text = typeof definition === 'string'
    ? definition
    : (definition['Fn::Join'][1] as unknown[]).map((part) => (typeof part === 'string' ? part : 'INTRINSIC')).join('');
  return JSON.parse(text);
}

/** Every `codebuild:startBuild.sync` task in the definition, keyed by state name. */
function startBuildTasks(definition: Record<string, any>): Record<string, any> {
  const tasks: Record<string, any> = {};
  const walk = (states: Record<string, any>) => {
    for (const [name, state] of Object.entries(states ?? {})) {
      if (state.Type === 'Task' && String(state.Resource).endsWith('codebuild:startBuild.sync')) {
        tasks[name] = state;
      }
      for (const branch of state.Branches ?? []) {
        walk(branch.States);
      }
    }
  };
  walk(definition.States);
  return tasks;
}

// ---------------------------------------------------------------------------
// ADR-022: deployer-supplied managed policies on the tenant build role.
// ---------------------------------------------------------------------------
describe('tenantBuildManagedPolicyArns (ADR-022)', () => {
  const account = '123456789012';
  const env: Environment = { account, region: 'eu-central-1' };
  const policyA = `arn:aws:iam::${account}:policy/PlatformInvokePolicy`;
  const policyB = `arn:aws:iam::${account}:policy/with/a/path/Second`;

  test('every given ARN is attached to the home account tenant provisioning role and to nothing else (ADR-025)', () => {
    const template = synth({ tenantBuildManagedPolicyArns: [policyA, policyB] }, env);
    const roles = template.findResources('AWS::IAM::Role');
    const byName = (name: string) =>
      Object.values(roles).find((role: any) => role.Properties.RoleName === name) as any;
    const tenantRole = byName('control-plane-tenant-provisioning');
    const cellRole = byName('control-plane-cell-provisioning');
    const { cell, tenant } = buildProjects(template);

    expect(tenantRole.Properties.ManagedPolicyArns).toEqual([policyA, policyB]);
    // Cell provisioning gets none (the ADR is explicit about the tenant role only).
    expect(cellRole.Properties.ManagedPolicyArns).toBeUndefined();
    // The build roles never carry them: they only assume, and tag a session for, the pair (ADR-025, ADR-0051).
    expect(serviceRole(template, tenant).Properties.ManagedPolicyArns).toBeUndefined();
    expect(serviceRole(template, cell).Properties.ManagedPolicyArns).toBeUndefined();
    // No other role in the stack picks them up.
    const rolesWithPolicyA = Object.values(template.findResources('AWS::IAM::Role'))
      .filter((role: any) => JSON.stringify(role.Properties.ManagedPolicyArns ?? []).includes(policyA));
    expect(rolesWithPolicyA).toHaveLength(1);
    // The SSM namespace grants are unchanged: the attachment widens, never replaces.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Sid: 'ManageTenantNamespace' })]),
      },
    });
  });

  test('no managed policy is attached when the input is omitted or empty', () => {
    for (const template of [synth({}, env), synth({ tenantBuildManagedPolicyArns: [] }, env)]) {
      const { tenant } = buildProjects(template);
      expect(serviceRole(template, tenant).Properties.ManagedPolicyArns).toBeUndefined();
    }
  });

  test('synth fails with a clear error for a bad ARN, wrong partition, wrong account, or non-policy IAM ARN', () => {
    const cases: Array<[string, RegExp]> = [
      ['not-an-arn', /not a customer-managed IAM policy ARN/],
      [`arn:aws-cn:iam::${account}:policy/P`, /partition 'aws-cn'; this stack deploys to 'aws'/],
      ['arn:aws:iam::210987654321:policy/P', /account 210987654321; this stack deploys to 123456789012/],
      [`arn:aws:iam::${account}:role/NotAPolicy`, /not a customer-managed IAM policy ARN/],
      // AWS managed policies live in the pseudo-account 'aws' - never this account.
      ['arn:aws:iam::aws:policy/AdministratorAccess', /not a customer-managed IAM policy ARN/],
      [`arn:aws:kms:eu-central-1:${account}:key/abc`, /not a customer-managed IAM policy ARN/],
      // Malformed policy paths: empty segments or a trailing slash with no name.
      [`arn:aws:iam::${account}:policy//`, /not a customer-managed IAM policy ARN/],
      [`arn:aws:iam::${account}:policy/foo/`, /not a customer-managed IAM policy ARN/],
      [`arn:aws:iam::${account}:policy/a//b`, /not a customer-managed IAM policy ARN/],
    ];
    for (const [arn, message] of cases) {
      expect(() => synth({ tenantBuildManagedPolicyArns: [arn] }, env)).toThrow(message);
      expect(() => synth({ tenantBuildManagedPolicyArns: [arn] }, env)).toThrow(/ADR-022/);
    }
  });

  test('every problem is reported at once, and a non-array input is rejected', () => {
    expect(() => synth({ tenantBuildManagedPolicyArns: ['bad', 'arn:aws:iam::210987654321:policy/P'] }, env))
      .toThrow(/\[0\] "bad".*\n.*\[1\] arn:aws:iam::210987654321:policy\/P is in account/);
    expect(() => validateTenantBuildManagedPolicyArns('arn:aws:iam::123456789012:policy/P', { partition: 'aws', account }))
      .toThrow(/must be an array of strings/);
    expect(() => validateTenantBuildManagedPolicyArns([42], { partition: 'aws', account }))
      .toThrow(/\[0\] 42 is not a customer-managed IAM policy ARN/);
  });

  test('an environment-agnostic stack rejects a non-empty list (the account check needs a resolved env)', () => {
    // No env: partition and account are tokens, so the cross-account check
    // cannot run; synth fails rather than deferring that check to IAM at deploy.
    expect(() => synth({ tenantBuildManagedPolicyArns: [policyA] }))
      .toThrow(/region \(partition\) and account must be resolved at synth time/);
    expect(() => synth({ tenantBuildManagedPolicyArns: [policyA] }))
      .toThrow(/CDK_DEFAULT_ACCOUNT/);
    // Region only: the partition resolves (aws) while the account stays a token.
    expect(() => synth({ tenantBuildManagedPolicyArns: [policyA] }, { region: 'eu-central-1' }))
      .toThrow(/the stack's account must be resolved at synth time/);
    // An omitted or empty list never needs the env.
    for (const template of [synth({}), synth({ tenantBuildManagedPolicyArns: [] })]) {
      const { tenant } = buildProjects(template);
      expect(serviceRole(template, tenant).Properties.ManagedPolicyArns).toBeUndefined();
    }
    // The pure function reports the same problem for a token identity.
    expect(() => validateTenantBuildManagedPolicyArns([policyA], { partition: 'aws', account: '${Token[AWS.AccountId.0]}' }))
      .toThrow(/account must be resolved at synth time/);
  });
});

// ---------------------------------------------------------------------------
// ADR-0047: deployer-supplied managed policies on the cell provisioning role.
// ---------------------------------------------------------------------------
describe('cellBuildManagedPolicyArns (ADR-0047)', () => {
  const account = '123456789012';
  const env: Environment = { account, region: 'eu-central-1' };
  const cellPolicy = `arn:aws:iam::${account}:policy/CellBootstrapAssume`;
  const tenantPolicy = `arn:aws:iam::${account}:policy/PlatformInvokePolicy`;

  test('each list attaches to its own role in the home account, and to nothing else', () => {
    const template = synth(
      { cellBuildManagedPolicyArns: [cellPolicy], tenantBuildManagedPolicyArns: [tenantPolicy] },
      env,
    );
    const roles = Object.values(template.findResources('AWS::IAM::Role')) as any[];
    const byName = (name: string) => roles.find((role) => role.Properties.RoleName === name);
    expect(byName('control-plane-cell-provisioning').Properties.ManagedPolicyArns).toEqual([cellPolicy]);
    expect(byName('control-plane-tenant-provisioning').Properties.ManagedPolicyArns).toEqual([tenantPolicy]);
    const withCellPolicy = roles.filter((role) => JSON.stringify(role.Properties.ManagedPolicyArns ?? []).includes(cellPolicy));
    expect(withCellPolicy).toHaveLength(1);
    const { cell, tenant } = buildProjects(template);
    expect(serviceRole(template, cell).Properties.ManagedPolicyArns).toBeUndefined();
    expect(serviceRole(template, tenant).Properties.ManagedPolicyArns).toBeUndefined();
  });

  test('a bad ARN fails synth naming the input and the ADR; an environment-agnostic stack rejects a non-empty list', () => {
    expect(() => synth({ cellBuildManagedPolicyArns: ['arn:aws:iam::210987654321:policy/P'] }, env))
      .toThrow(/Invalid cellBuildManagedPolicyArns deployment input \(ADR-0047\)[\s\S]*is in account 210987654321/);
    expect(() => synth({ cellBuildManagedPolicyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'] }, env))
      .toThrow(/not a customer-managed IAM policy ARN/);
    expect(() => synth({ cellBuildManagedPolicyArns: [cellPolicy] }))
      .toThrow(/must be resolved at synth time/);
    expect(() => validateCellBuildManagedPolicyArns('x', { partition: 'aws', account }))
      .toThrow(/must be an array of strings/);
  });

  test('the account role pair stack attaches the cell list to its cell role in THIS account', () => {
    const app = new App();
    const stack = new CellAccountStack(app, 'cell-account', {
      controlPlaneAccountId: '999999999999',
      cellBuildManagedPolicyArns: ['arn:aws:iam::222222222222:policy/CellBootstrapAssume'],
      env: { account: '222222222222', region: 'eu-central-1' },
    });
    const roles = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Role')) as any[];
    const cellRole = roles.find((r) => r.Properties.RoleName === 'control-plane-cell-provisioning');
    const tenantRole = roles.find((r) => r.Properties.RoleName === 'control-plane-tenant-provisioning');
    expect(cellRole.Properties.ManagedPolicyArns).toEqual(['arn:aws:iam::222222222222:policy/CellBootstrapAssume']);
    expect(tenantRole.Properties.ManagedPolicyArns).toBeUndefined();
    expect(() => new CellAccountStack(new App(), 'cell-account', {
      controlPlaneAccountId: '999999999999',
      cellBuildManagedPolicyArns: ['arn:aws:iam::333333333333:policy/Elsewhere'],
      env: { account: '222222222222', region: 'eu-central-1' },
    })).toThrow(/cellBuildManagedPolicyArns[\s\S]*is in account 333333333333/);
  });
});

// ---------------------------------------------------------------------------
// ADR-0046: the concurrent build limit is a prop.
// ---------------------------------------------------------------------------
describe('concurrentBuildLimit (ADR-0046)', () => {
  function synthStack(limit?: number): TenantStack {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    return new TenantStack(app, 'test', {
      vendorIdpIssuerUrl: 'https://idp.example.com',
      vendorIdpAudience: 'control-plane',
      concurrentBuildLimit: limit,
    });
  }
  const limits = (stack: TenantStack) =>
    (Object.values(Template.fromStack(stack).findResources('AWS::CodeBuild::Project')) as any[])
      .map((project) => project.Properties.ConcurrentBuildLimit);
  const warnings = (stack: TenantStack) =>
    Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('concurrentBuildLimit'));

  test('the value applies to every CodeBuild project, the two hook projects included', () => {
    expect(limits(synthStack(50))).toEqual([50, 50, 50, 50]);
    expect(limits(synthStack(1))).toEqual([1, 1, 1, 1]);
    expect(limits(synthStack(100))).toEqual([100, 100, 100, 100]);
  });

  test('above 20 the synth warns, naming T16 and the CodeBuild quota; at 20 or below it does not', () => {
    const above = warnings(synthStack(21));
    expect(above).toHaveLength(1);
    expect(JSON.stringify(above[0].entry.data)).toMatch(/T16/);
    expect(JSON.stringify(above[0].entry.data)).toMatch(/BUILD_GENERAL1_SMALL builds must be at least 84/);
    expect(JSON.stringify(above[0].entry.data)).toMatch(/each of the 4 CodeBuild projects/);
    expect(warnings(synthStack(20))).toHaveLength(0);
    expect(warnings(synthStack())).toHaveLength(0);
  });

  test('a value outside 1 to 100, a fraction, a non-number or a token fails synth', () => {
    for (const bad of [0, -1, 101, 2.5, Number.NaN]) {
      expect(() => synthStack(bad)).toThrow(/Invalid concurrentBuildLimit .* \(ADR-0046\): expected an integer from 1 to 100/);
    }
    expect(() => validateConcurrentBuildLimit('50')).toThrow(/Invalid concurrentBuildLimit "50"/);
    expect(() => validateConcurrentBuildLimit(Token.asNumber({ resolve: () => 10 }))).toThrow(/not a CDK token/);
    expect(() => synthStack(Number.POSITIVE_INFINITY)).toThrow(/Invalid concurrentBuildLimit Infinity/);
    expect(validateConcurrentBuildLimit(undefined)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ADR-023: TENANT_NAME reaches every tenant build and no cell build.
// ---------------------------------------------------------------------------
describe('TENANT_NAME in the tenant script environment (ADR-023)', () => {
  const template = synth();
  const definition = stateMachineDefinition(template);
  const tasks = startBuildTasks(definition);
  const envOf = (task: any) => buildEnvironment(task);

  test('both tenant build variants carry TENANT_NAME from the stored record, beside TENANT_ID and OPERATION', async () => {
    for (const name of ['RunTenantBuild', 'RunTenantBuildPinned']) {
      const environment = await envOf(tasks[name]);
      expect(environment.TENANT_NAME).toBe('$.tenantBuild.tenantName');
      expect(environment.TENANT_ID).toBe('$.tenantId');
      // ADR-032/037: the deployment's application rides every tenant build.
      expect(environment.APPLICATION_ID).toBe('$.applicationId');
      expect(environment.ADMIN_EMAIL).toBe('$.tenantBuild.adminEmail');
      expect(environment.OPERATOR_ID).toBe('$.operatorId');
      // One shared task serves create, update and delete: the operation is
      // itself an environment variable, so TENANT_NAME rides all three.
      expect(environment.OPERATION).toBe('$.tenantBuild.operation');
    }
  });

  test('the shared tenant task is the only path for every tenant operation', () => {
    // The success router splits on operation AFTER the build; the build task
    // itself is operation-agnostic, so there is no per-operation task that
    // could omit the variable.
    const router = definition.States.TenantBuildSucceeded;
    expect(router.Type).toBe('Choice');
    const operations = router.Choices.map((c: any) => c.StringEquals).sort();
    expect(operations).toEqual(['delete', 'update']);
    expect(router.Default).toBe('SetTenantActiveAfterCreate');
    const tenantTasks = Object.keys(tasks).filter((name) => name.startsWith('RunTenantBuild'));
    expect(tenantTasks.sort()).toEqual(['RunTenantBuild', 'RunTenantBuildPinned']);
  });

  test('cell builds do not receive TENANT_NAME (or any tenant variable)', async () => {
    for (const name of ['RunCellBuild', 'RunCellBuildPinned']) {
      const environment = await envOf(tasks[name]);
      expect(environment.TENANT_NAME).toBeUndefined();
      expect(environment.TENANT_ID).toBeUndefined();
      expect(environment.ADMIN_EMAIL).toBeUndefined();
      // ADR-032: the cell's application rides every cell build.
      expect(environment.APPLICATION_ID).toBe('$.applicationId');
      expect(Object.keys(environment).sort()).toEqual([
        'APPLICATION_ID',
        'CELL_ACCOUNT_ID',
        'CELL_ID',
        'OPERATION',
        'OPERATOR_ID',
        'OPERATOR_SESSION_NAME',
        'PROVISIONING_EXTERNAL_ID',
        'PROVISIONING_ROLE_ARN',
        'SCRIPT_PATH',
      ]);
    }
    // Exactly four startBuild tasks exist: two per project.
    expect(Object.keys(tasks).sort()).toEqual(['RunCellBuild', 'RunCellBuildPinned', 'RunTenantBuild', 'RunTenantBuildPinned']);
  });
});

// ---------------------------------------------------------------------------
// Multi-account cells (ADR-024, ADR-025, ADR-027)
// ---------------------------------------------------------------------------

describe('build roles and the home account role pair (ADR-025)', () => {
  const template = synth();
  const roles = Object.values(template.findResources('AWS::IAM::Role')) as any[];
  const byName = (name: string) => roles.find((role) => role.Properties.RoleName === name);
  const policyFor = (roleLogicalId: string) =>
    (Object.values(template.findResources('AWS::IAM::Policy')) as any[]).find((policy) =>
      JSON.stringify(policy.Properties.Roles).includes(roleLogicalId));
  const logicalIdOf = (name: string) =>
    Object.entries(template.findResources('AWS::IAM::Role')).find(
      ([, role]: [string, any]) => role.Properties.RoleName === name,
    )![0];

  test('the five fleet roles exist with their physical names', () => {
    for (const name of [
      'control-plane-api',
      'control-plane-cell-build',
      'control-plane-tenant-build',
      'control-plane-cell-provisioning',
      'control-plane-tenant-provisioning',
    ]) {
      expect(byName(name)).toBeDefined();
    }
  });

  test('each build role may ONLY assume, and tag a session for, its half of the pair, by name, in any account (N-8); no SSM grant', () => {
    for (const kind of ['cell', 'tenant']) {
      const policy = policyFor(logicalIdOf(`control-plane-${kind}-build`));
      const statements = policy.Properties.PolicyDocument.Statement as any[];
      const assume = statements.find((s) => s.Sid === 'AssumeProvisioningRole');
      expect(assume.Action).toBe('sts:AssumeRole');
      expect(JSON.stringify(assume.Resource)).toContain(`:iam::*:role/control-plane-${kind}-provisioning`);
      expect(JSON.stringify(statements)).not.toContain('ssm:');
    }
    // The CodeBuild projects run under exactly those roles.
    const { cell, tenant } = buildProjects(template);
    expect(serviceRole(template, cell).Properties.RoleName).toBe('control-plane-cell-build');
    expect(serviceRole(template, tenant).Properties.RoleName).toBe('control-plane-tenant-build');
  });

  test('the home pair trusts the API role untagged and the matching build role only with its session tags (aws:PrincipalArn, ADR-0051)', () => {
    for (const kind of ['cell', 'tenant'] as const) {
      const role = byName(`control-plane-${kind}-provisioning`);
      const [api, assume, tag, ...rest] = role.Properties.AssumeRolePolicyDocument.Statement;
      expect(rest).toEqual([]);
      for (const statement of [api, assume, tag]) {
        expect(JSON.stringify(statement.Principal.AWS)).toContain(':root');
        // No external id on the home account unless asked for.
        expect(statement.Condition.StringEquals).toBeUndefined();
      }
      expect(api.Action).toBe('sts:AssumeRole');
      expect(Object.keys(api.Condition)).toEqual(['ArnEquals']);
      expect(JSON.stringify(api.Condition.ArnEquals['aws:PrincipalArn'])).toContain(':role/control-plane-api');
      expect(assume.Action).toBe('sts:AssumeRole');
      expect(tag.Action).toBe('sts:TagSession');
      for (const build of [assume, tag]) {
        const principals = JSON.stringify(build.Condition.ArnEquals['aws:PrincipalArn']);
        expect(principals).toContain(`:role/control-plane-${kind}-build`);
        // Never the other half's build role, nor the API role.
        expect(principals).not.toContain(`:role/control-plane-${kind === 'cell' ? 'tenant' : 'cell'}-build`);
        expect(principals).not.toContain('-api');
      }
      expect(assume.Condition.Null).toEqual(literalTagConditions(kind, false).Null);
      expect(assume.Condition['ForAllValues:StringEquals']).toEqual(literalTagConditions(kind, false)['ForAllValues:StringEquals']);
      expect(tag.Condition.Null).toEqual(literalTagConditions(kind, true).Null);
      expect(tag.Condition['ForAllValues:StringEquals']).toEqual(literalTagConditions(kind, true)['ForAllValues:StringEquals']);
    }
  });

  test('each build role may pass only its half\'s session tags to the pair, in any account (ADR-0051)', () => {
    for (const kind of ['cell', 'tenant'] as const) {
      const statements = policyFor(logicalIdOf(`control-plane-${kind}-build`)).Properties.PolicyDocument.Statement as any[];
      const tag = statements.find((s) => s.Sid === 'TagProvisioningSession');
      expect(tag.Action).toBe('sts:TagSession');
      expect(JSON.stringify(tag.Resource)).toContain(`:iam::*:role/control-plane-${kind}-provisioning`);
      expect(tag.Condition).toEqual(literalTagConditions(kind, true));
    }
    // The API role passes no tags: its probe stays AssumeRole only (ADR-027).
    const apiStatements = policyFor(logicalIdOf('control-plane-api')).Properties.PolicyDocument.Statement as any[];
    expect(JSON.stringify(apiStatements)).not.toContain('sts:TagSession');
  });

  test('the R-41 deny on the home pair blocks no STS or SSM action, so tagged builds and their own namespaces still work there (ADR-0051)', () => {
    const deny = (Object.values(template.findResources('AWS::IAM::Policy')) as any[]).find((p) =>
      (p.Properties.PolicyDocument.Statement as any[]).every((s) => s.Effect === 'Deny'));
    const attachedTo = JSON.stringify(deny.Properties.Roles);
    expect(attachedTo).toContain(logicalIdOf('control-plane-cell-provisioning'));
    expect(attachedTo).toContain(logicalIdOf('control-plane-tenant-provisioning'));
    const actions = (deny.Properties.PolicyDocument.Statement as any[]).flatMap((s) => [s.Action].flat());
    expect(actions.filter((a: string) => a.startsWith('sts:') || a.startsWith('ssm:'))).toEqual([]);
  });

  test('the home pair\'s own cell and deployment namespaces are named by the session tags (ADR-0051)', () => {
    const resources = (kind: string, sid: string) =>
      JSON.stringify((policyFor(logicalIdOf(`control-plane-${kind}-provisioning`)).Properties.PolicyDocument.Statement as any[])
        .find((s) => s.Sid === sid).Resource);
    for (const [kind, sid] of [['cell', 'ManageCellNamespace'], ['tenant', 'ReadCellNamespace']]) {
      expect(resources(kind, sid)).toContain('parameter/application-plane/cells/${aws:PrincipalTag/CellId}"');
      expect(resources(kind, sid)).toContain('parameter/application-plane/cells/${aws:PrincipalTag/CellId}/*"');
      expect(resources(kind, sid)).not.toContain('cells/*');
    }
    const tenants = resources('tenant', 'ManageTenantNamespace');
    expect(tenants).toContain('parameter/application-plane/tenants/${aws:PrincipalTag/TenantId}/${aws:PrincipalTag/ApplicationId}"');
    expect(tenants).toContain('parameter/application-plane/tenants/${aws:PrincipalTag/TenantId}/${aws:PrincipalTag/ApplicationId}/*"');
    expect(tenants).not.toContain('tenants/*');
  });

  test('the home pair carries the §6.2 asymmetry: the cell role manages its cell namespace, the tenant role reads its cell\'s and manages its deployment\'s', () => {
    const statements = (kind: string) =>
      policyFor(logicalIdOf(`control-plane-${kind}-provisioning`)).Properties.PolicyDocument.Statement as any[];
    const sids = (kind: string) => statements(kind).map((s) => s.Sid).sort();
    expect(sids('cell')).toEqual(['ManageCellNamespace', 'ReadSharedResources']);
    expect(sids('tenant')).toEqual(['ManageTenantNamespace', 'ReadCellNamespace', 'ReadSharedResources']);
  });

  test('both halves read both shared namespaces, /application-plane/shared/* and /application-plane/applications/* (§6.2, ADR-034, ADR-038)', () => {
    for (const kind of ['cell', 'tenant']) {
      const shared = (policyFor(logicalIdOf(`control-plane-${kind}-provisioning`)).Properties.PolicyDocument.Statement as any[])
        .find((s) => s.Sid === 'ReadSharedResources');
      const resources = JSON.stringify(shared.Resource);
      expect(resources).toContain('parameter/application-plane/shared/*');
      expect(resources).toContain('parameter/application-plane/applications/*');
      expect(resources).not.toContain('parameter/application-plane/cells');
    }
  });

  test('a custom fleetName renames all seven roles (hook roles included, R-41); an invalid one fails synth', () => {
    const custom = synth({ fleetName: 'fleet-b' });
    const names = (Object.values(custom.findResources('AWS::IAM::Role')) as any[])
      .map((role) => role.Properties.RoleName)
      .filter((name) => typeof name === 'string')
      .sort();
    expect(names).toEqual([
      'fleet-b-api',
      'fleet-b-app-hook',
      'fleet-b-cell-build',
      'fleet-b-cell-provisioning',
      'fleet-b-global-hook',
      'fleet-b-tenant-build',
      'fleet-b-tenant-provisioning',
    ]);
    expect(() => synth({ fleetName: 'Fleet_B' })).toThrow(/Invalid fleetName/);
  });

  test('the API function may assume the pair for the PutAccount probe and receives FLEET_NAME (ADR-027)', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    const apiFn = fns.find((fn) => fn.Properties.Environment?.Variables?.GSI3_NAME !== undefined);
    expect(apiFn.Properties.Environment.Variables.FLEET_NAME).toBe('control-plane');
    const [roleLogicalId] = apiFn.Properties.Role['Fn::GetAtt'];
    expect(template.findResources('AWS::IAM::Role')[roleLogicalId].Properties.RoleName).toBe('control-plane-api');
    const statements = policyFor(roleLogicalId).Properties.PolicyDocument.Statement as any[];
    const probe = statements.find((s) => s.Sid === 'ProbeAccountHandshake');
    expect(probe.Action).toBe('sts:AssumeRole');
    expect(JSON.stringify(probe.Resource)).toContain(':iam::*:role/control-plane-cell-provisioning');
    expect(JSON.stringify(probe.Resource)).toContain(':iam::*:role/control-plane-tenant-provisioning');
  });
});

describe('the workflow assumes the account role before every script and releases the account slot on cell delete', () => {
  const template = synth();
  const definition = stateMachineDefinition(template);
  const tasks = startBuildTasks(definition);
  const envOf = (task: any) => buildEnvironment(task);

  test('the inline buildspec assumes PROVISIONING_ROLE_ARN with the external id and operator session, then runs the script (M21)', () => {
    for (const task of Object.values(tasks)) {
      const buildspec: string = task.Arguments.BuildspecOverride;
      expect(buildspec).toContain('shell: bash');
      expect(buildspec).toContain('aws sts assume-role --role-arn "$PROVISIONING_ROLE_ARN"');
      expect(buildspec).toContain('--role-session-name "$OPERATOR_SESSION_NAME"');
      expect(buildspec).toContain('--external-id "$PROVISIONING_EXTERNAL_ID"');
      // No `${...}` anywhere: CloudFormation's validator reads it as Fn::Sub.
      expect(buildspec).not.toContain('${');
      expect(buildspec).toContain('export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN');
      // The script runs as a child process; the outputs check follows it (R-43).
      expect(buildspec).toContain('bash "$SCRIPT_PATH"\n');
      // Credentials are read into shell variables, never echoed or passed as build env.
      expect(buildspec).not.toMatch(/echo .*AWS_SECRET/);
      expect(buildspec).not.toContain('set -x');
    }
  });

  /**
   * The arguments the buildspec's own `aws sts assume-role` line passes after
   * the role ARN and session name, run in bash with the given build
   * environment against a stub `aws` that prints its argv. It runs the real
   * assume-role line, so a line that drops `"$@"` fails (ADR-0051).
   */
  const assumeRoleArguments = (buildspec: string, env: Record<string, string>): string[] => {
    const lines = buildspec.split('\n').map((l) => l.trim());
    const from = lines.indexOf('set --');
    const to = lines.findIndex((l) => l.startsWith('CREDENTIALS=$(aws sts assume-role'));
    const stub = 'aws() { printf \'%s\\n\' "$@"; }';
    const run = spawnSync('bash', ['-c', `set -euo pipefail\n${stub}\n${lines.slice(from, to + 1).join('\n')}\nprintf '%s\\n' "$CREDENTIALS"`], {
      env: { PATH: process.env.PATH ?? '', PROVISIONING_ROLE_ARN: 'arn:aws:iam::222222222222:role/p', OPERATOR_SESSION_NAME: 'op', ...env },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    // Command substitution strips the trailing newline and printf adds one
    // back, so every line but the last is one argument, empty ones included.
    const argv = run.stdout.split('\n').slice(0, -1);
    expect(argv.slice(0, 6)).toEqual(['sts', 'assume-role', '--role-arn', 'arn:aws:iam::222222222222:role/p', '--role-session-name', 'op']);
    expect(argv).toContain('--query');
    return argv.slice(6, argv.indexOf('--query'));
  };
  const ids = { CELL_ID: '01KCELL0000000000000000001', TENANT_ID: '01KTENANT00000000000000001', APPLICATION_ID: 'app-x' };

  test('a cell build tags its session with exactly CellId, transitive, from CELL_ID (ADR-0051)', () => {
    for (const name of ['RunCellBuild', 'RunCellBuildPinned']) {
      const buildspec: string = tasks[name].Arguments.BuildspecOverride;
      expect(assumeRoleArguments(buildspec, { ...ids, PROVISIONING_EXTERNAL_ID: '' })).toEqual([
        '--tags', `Key=CellId,Value=${ids.CELL_ID}`, '--transitive-tag-keys', 'CellId',
      ]);
      // With an external id, in the same argument array.
      expect(assumeRoleArguments(buildspec, { ...ids, PROVISIONING_EXTERNAL_ID: 'ext-1' })).toEqual([
        '--external-id', 'ext-1', '--tags', `Key=CellId,Value=${ids.CELL_ID}`, '--transitive-tag-keys', 'CellId',
      ]);
      expect(buildspec).not.toContain('TenantId');
    }
  });

  test('a tenant build tags its session with CellId, TenantId and ApplicationId, all transitive, from the service variables (ADR-0051)', () => {
    for (const name of ['RunTenantBuild', 'RunTenantBuildPinned']) {
      const buildspec: string = tasks[name].Arguments.BuildspecOverride;
      expect(assumeRoleArguments(buildspec, { ...ids, PROVISIONING_EXTERNAL_ID: '' })).toEqual([
        '--tags',
        `Key=CellId,Value=${ids.CELL_ID}`,
        `Key=TenantId,Value=${ids.TENANT_ID}`,
        `Key=ApplicationId,Value=${ids.APPLICATION_ID}`,
        '--transitive-tag-keys', 'CellId', 'TenantId', 'ApplicationId',
      ]);
      // A value with a space stays one argument: the values are quoted.
      expect(assumeRoleArguments(buildspec, { ...ids, TENANT_ID: 'a b', PROVISIONING_EXTERNAL_ID: '' })).toContain('Key=TenantId,Value=a b');
      // The values come from the three service-resolved variables only, never a PARAM_ variable (R-32).
      expect(buildspec).not.toMatch(/Value=\$PARAM_/);
    }
  });

  test('the two halves\' buildspecs differ only in the session tag line, and the build env carries the tag variables', async () => {
    const cell = (tasks.RunCellBuild.Arguments.BuildspecOverride as string).split('\n');
    const tenant = (tasks.RunTenantBuild.Arguments.BuildspecOverride as string).split('\n');
    expect(cell).toHaveLength(tenant.length);
    expect(cell.filter((line, i) => line !== tenant[i]).map((l) => l.trim().split(' --tags')[0])).toEqual(['set -- "$@"']);
    expect(await envOf(tasks.RunCellBuild)).toMatchObject({ CELL_ID: '$.cellId' });
    expect(await envOf(tasks.RunTenantBuild)).toMatchObject({ CELL_ID: '$.cellId', TENANT_ID: '$.tenantId', APPLICATION_ID: '$.applicationId' });
  });

  test('the buildspec fails closed on empty credentials and hides the BUILD role credential source from the script (T29, M24)', () => {
    for (const task of Object.values(tasks)) {
      const buildspec: string = task.Arguments.BuildspecOverride;
      const lines = buildspec.split('\n').map((l) => l.trim());
      const check = lines.indexOf('if [ -z "$AWS_SESSION_TOKEN" ]; then');
      const exportLine = lines.indexOf('export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN');
      const unsetContainer = lines.indexOf(
        'unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_AUTHORIZATION_TOKEN',
      );
      const run = lines.findIndex((l) => l === 'bash "$SCRIPT_PATH"');
      expect(check).toBeGreaterThan(-1);
      expect(lines[check + 2]).toBe('exit 1');
      expect(check).toBeLessThan(exportLine);
      expect(unsetContainer).toBeGreaterThan(exportLine);
      expect(unsetContainer).toBeLessThan(run);
      expect(lines.indexOf('unset CREDENTIALS PROVISIONING_EXTERNAL_ID')).toBeLessThan(run);
    }
  });

  test('cell builds assume the cell role; tenant builds the tenant role; both get the account id', async () => {
    for (const name of ['RunCellBuild', 'RunCellBuildPinned']) {
      expect(await envOf(tasks[name])).toMatchObject({
        CELL_ACCOUNT_ID: '$.accountId',
        PROVISIONING_ROLE_ARN: '$.cellRoleArn',
        PROVISIONING_EXTERNAL_ID: '$.externalId',
        OPERATOR_SESSION_NAME: '$.sessionName',
      });
    }
    for (const name of ['RunTenantBuild', 'RunTenantBuildPinned']) {
      expect(await envOf(tasks[name])).toMatchObject({
        CELL_ACCOUNT_ID: '$.accountId',
        PROVISIONING_ROLE_ARN: '$.tenantRoleArn',
      });
    }
  });

  test('the terminal cell delete is one transaction: cell DeleteItem + account and application cellCount decrements (§8.2, ADR-024, ADR-032)', () => {
    const remove = definition.States.RemoveCellRecord;
    expect(remove.Resource).toBe('arn:aws:states:::aws-sdk:dynamodb:transactWriteItems');
    expect(remove.Parameters.TransactItems).toHaveLength(3);
    const [del, account, application] = remove.Parameters.TransactItems;
    expect(del.Delete.Key.PK['S.$']).toBe("States.Format('CELL#{}', $.cellId)");
    expect(del.Delete.ConditionExpression).toBe('attribute_exists(PK) AND #status = :deleting AND tenantCount = :zero');
    expect(account.Update.Key.PK['S.$']).toBe("States.Format('ACCOUNT#{}', $.accountId)");
    expect(application.Update.Key.PK['S.$']).toBe("States.Format('APPLICATION#{}', $.applicationId)");
    for (const upd of [account, application]) {
      expect(upd.Update.Key.SK).toEqual({ S: 'META' });
      expect(upd.Update.UpdateExpression).toBe('SET cellCount = cellCount - :one, updatedAt = :now');
      expect(upd.Update.ConditionExpression).toBe('attribute_exists(PK) AND cellCount > :zero');
    }
    expect(remove.Parameters['ClientRequestToken.$']).toContain('cell-delete');
    // Absence-is-success read on cancellation, as for the deployment delete.
    expect(remove.Catch[0].Next).toBe('GetCellRecord');
  });

  test('the terminal deployment delete is one transaction: deployment DeleteItem + cell tenantCount + tenant deploymentCount decrements (§8.2, ADR-037)', () => {
    const remove = definition.States.DeleteDeploymentRecord;
    expect(remove.Resource).toBe('arn:aws:states:::aws-sdk:dynamodb:transactWriteItems');
    expect(remove.Parameters.TransactItems).toHaveLength(3);
    const [del, cell, tenant] = remove.Parameters.TransactItems;
    expect(del.Delete.Key).toEqual({
      PK: { 'S.$': "States.Format('TENANT#{}', $.tenantId)" },
      SK: { 'S.$': "States.Format('DEPLOYMENT#{}', $.applicationId)" },
    });
    expect(del.Delete.ConditionExpression).toBe('attribute_exists(PK) AND #status = :deleting');
    expect(cell.Update.Key.PK['S.$']).toBe("States.Format('CELL#{}', $.cellId)");
    expect(cell.Update.UpdateExpression).toBe('SET tenantCount = tenantCount - :one, updatedAt = :now');
    expect(cell.Update.ConditionExpression).toBe('attribute_exists(PK) AND tenantCount > :zero');
    expect(tenant.Update.Key).toEqual({
      PK: { 'S.$': "States.Format('TENANT#{}', $.tenantId)" },
      SK: { S: 'META' },
    });
    expect(tenant.Update.UpdateExpression).toBe('SET deploymentCount = deploymentCount - :one, updatedAt = :now');
    expect(tenant.Update.ConditionExpression).toBe('attribute_exists(PK) AND deploymentCount > :zero');
    expect(remove.Parameters['ClientRequestToken.$']).toContain('deployment-delete');
    expect(definition.States.DeleteTenantRecord).toBeUndefined();
  });

  test('exactly two transactional writers decrement a counter: deployment delete and cell delete (P-6)', () => {
    const transactions = Object.entries(definition.States).filter(
      ([, state]: [string, any]) => String(state.Resource).endsWith('transactWriteItems'),
    );
    const decrements = transactions.filter(([, state]: [string, any]) =>
      JSON.stringify(state.Parameters).includes('Count - :one'));
    expect(decrements.map(([name]) => name).sort()).toEqual(['DeleteDeploymentRecord', 'RemoveCellRecord']);
    // Nothing in the workflow increments a counter: placement owns the claims (§7.1).
    expect(JSON.stringify(definition)).not.toContain('Count + :one');
  });
});

describe('CellAccountStack (spec R-25, ADR-025)', () => {
  const controlPlaneAccountId = '999999999999';

  function synthAccountStack(extra: Partial<CellAccountStackProps> = {}): Template {
    const app = new App();
    const stack = new CellAccountStack(app, 'account-b', {
      controlPlaneAccountId,
      env: { account: '222222222222', region: 'eu-central-1' },
      ...extra,
    });
    return Template.fromStack(stack);
  }

  /** The tenant half's trust as IAM stores it: compact JSON with the partition resolved. */
  function tenantTrustChars(externalId: string, fleetName?: string, region = 'eu-central-1'): { chars: number; warned: boolean } {
    const stack = new CellAccountStack(new App(), 'account-b', {
      controlPlaneAccountId,
      env: { account: '222222222222', region },
      externalId,
      ...(fleetName ? { fleetName } : {}),
    });
    const partition = region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
    const roles = Template.fromStack(stack).findResources('AWS::IAM::Role') as Record<string, any>;
    const tenant = Object.values(roles).find((r) => r.Properties.RoleName.endsWith('-tenant-provisioning'));
    const resolve = (v: any): any => {
      if (Array.isArray(v)) return v.map(resolve);
      if (v && typeof v === 'object') {
        if (v.Ref === 'AWS::Partition') return partition;
        if (v['Fn::Join']) return (v['Fn::Join'][1] as any[]).map(resolve).join(v['Fn::Join'][0]);
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
      }
      return v;
    };
    const chars = JSON.stringify(resolve(tenant.Properties.AssumeRolePolicyDocument)).length;
    const warned = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('trust policy size')).length > 0;
    return { chars, warned };
  }

  test('warns at synth exactly when the external id pushes the tenant trust over the 2,048-character quota', () => {
    const cases: Array<[number, string | undefined, string | undefined]> = [
      [300, undefined, undefined], [400, undefined, undefined], [421, undefined, undefined], [422, undefined, undefined],
      [430, undefined, undefined], [410, 'f'.repeat(32), undefined], [401, undefined, 'us-gov-west-1'], [402, undefined, 'us-gov-west-1'],
    ];
    for (const [length, fleetName, region] of cases) {
      const { chars, warned } = tenantTrustChars('x'.repeat(length), fleetName, region);
      expect([length, fleetName, region, warned]).toEqual([length, fleetName, region, chars > TRUST_POLICY_DEFAULT_QUOTA]);
    }
  });

  test('installs the pair trusting the control plane account narrowed to the API role and the build roles, with the external id on both', () => {
    const template = synthAccountStack({ externalId: 'customer-handshake-1' });
    const roles = Object.values(template.findResources('AWS::IAM::Role')) as any[];
    expect(roles.map((r) => r.Properties.RoleName).sort()).toEqual([
      'control-plane-cell-provisioning',
      'control-plane-tenant-provisioning',
    ]);
    for (const role of roles) {
      const kind = role.Properties.RoleName === 'control-plane-cell-provisioning' ? 'cell' : 'tenant';
      const statements = role.Properties.AssumeRolePolicyDocument.Statement as any[];
      expect(statements).toEqual([
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${controlPlaneAccountId}:root`]] } },
          Condition: {
            ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${controlPlaneAccountId}:role/control-plane-api` },
            StringEquals: { 'sts:ExternalId': 'customer-handshake-1' },
          },
        },
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${controlPlaneAccountId}:root`]] } },
          Condition: {
            'ArnEquals': { 'aws:PrincipalArn': `arn:aws:iam::${controlPlaneAccountId}:role/control-plane-${kind}-build` },
            'Null': kind === 'cell'
              ? { 'aws:RequestTag/CellId': 'false' }
              : {
                'aws:RequestTag/CellId': 'false',
                'aws:RequestTag/TenantId': 'false',
                'aws:RequestTag/ApplicationId': 'false',
              },
            'ForAllValues:StringEquals': kind === 'cell'
              ? { 'aws:TagKeys': ['CellId'] }
              : { 'aws:TagKeys': ['CellId', 'TenantId', 'ApplicationId'] },
            'StringEquals': { 'sts:ExternalId': 'customer-handshake-1' },
          },
        },
        {
          // No external id here: STS evaluates it on AssumeRole only (ADR-0051).
          Action: 'sts:TagSession',
          Effect: 'Allow',
          Principal: { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${controlPlaneAccountId}:root`]] } },
          Condition: {
            'ArnEquals': { 'aws:PrincipalArn': `arn:aws:iam::${controlPlaneAccountId}:role/control-plane-${kind}-build` },
            'Null': kind === 'cell'
              ? { 'aws:RequestTag/CellId': 'false', 'sts:TransitiveTagKeys': 'false' }
              : {
                'aws:RequestTag/CellId': 'false',
                'aws:RequestTag/TenantId': 'false',
                'aws:RequestTag/ApplicationId': 'false',
                'sts:TransitiveTagKeys': 'false',
              },
            'ForAllValues:StringEquals': kind === 'cell'
              ? { 'aws:TagKeys': ['CellId'], 'sts:TransitiveTagKeys': ['CellId'] }
              : {
                'aws:TagKeys': ['CellId', 'TenantId', 'ApplicationId'],
                'sts:TransitiveTagKeys': ['CellId', 'TenantId', 'ApplicationId'],
              },
          },
        },
      ]);
    }
  });

  test('without an external id the trust has no sts:ExternalId condition', () => {
    const template = synthAccountStack();
    for (const role of Object.values(template.findResources('AWS::IAM::Role')) as any[]) {
      const statements = role.Properties.AssumeRolePolicyDocument.Statement as any[];
      expect(statements).toHaveLength(3);
      for (const statement of statements) expect(statement.Condition.StringEquals).toBeUndefined();
    }
  });

  test('an external id STS would refuse fails synth (ADR-029)', () => {
    expect(() => synthAccountStack({ externalId: 'has space' })).toThrow(/Invalid externalId/);
    expect(() => synthAccountStack({ externalId: 'x' })).toThrow(/Invalid externalId/);
  });

  test('the pair carries only the §6.2 namespace grants; managed policies attach to the tenant role in THIS account', () => {
    const policy = 'arn:aws:iam::222222222222:policy/CustomerPlatformInvoke';
    const template = synthAccountStack({ tenantBuildManagedPolicyArns: [policy] });
    const roles = Object.values(template.findResources('AWS::IAM::Role')) as any[];
    const tenantRole = roles.find((r) => r.Properties.RoleName === 'control-plane-tenant-provisioning');
    const cellRole = roles.find((r) => r.Properties.RoleName === 'control-plane-cell-provisioning');
    expect(tenantRole.Properties.ManagedPolicyArns).toEqual([policy]);
    expect(cellRole.Properties.ManagedPolicyArns).toBeUndefined();
    const statements = (Object.values(template.findResources('AWS::IAM::Policy')) as any[])
      .flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
    expect(statements.map((s) => s.Sid).sort()).toEqual([
      'ManageCellNamespace',
      'ManageTenantNamespace',
      'ReadCellNamespace',
      'ReadSharedResources',
      'ReadSharedResources',
    ]);
    // Every grant is an SSM namespace in this account; nothing else.
    expect(statements.every((s) => JSON.stringify(s.Action).split('"').filter((a) => a.includes(':')).every((a) => a.startsWith('ssm:')))).toBe(true);
  });

  test('a policy ARN in another account fails synth; so does a malformed control plane account id', () => {
    expect(() =>
      synthAccountStack({ tenantBuildManagedPolicyArns: ['arn:aws:iam::333333333333:policy/Elsewhere'] }),
    ).toThrow(/is in account 333333333333/);
    expect(() => synthAccountStack({ controlPlaneAccountId: '12' })).toThrow(/Invalid controlPlaneAccountId/);
  });

  test('installs only the two roles by default; the demo shared parameter is opt-in, one per application (ADR-034)', () => {
    expect(Object.keys(synthAccountStack().findResources('AWS::SSM::Parameter'))).toHaveLength(0);
    const names = (Object.values(
      synthAccountStack({ demoApplicationIds: ['app-x', 'app-y'] }).findResources('AWS::SSM::Parameter'),
    ) as any[])
      .map((p) => p.Properties.Name)
      .sort();
    expect(names).toEqual([
      '/application-plane/applications/app-x/shared/base-domain',
      '/application-plane/applications/app-y/shared/base-domain',
    ]);
  });
});

// ---------------------------------------------------------------------------
// ADR-039 / ADR-040: PARAM_<NAME> in the build environment, and the payload
// budget of §8.1 on the success and failure paths of every build task.
// ---------------------------------------------------------------------------
describe('parameters in the workflow (ADR-039, ADR-040, spec §6.1, §8.1)', () => {
  const template = synth();
  const definition = stateMachineDefinition(template);
  const tasks = startBuildTasks(definition);
  const tenantTasks = ['RunTenantBuild', 'RunTenantBuildPinned'];
  const cellTasks = ['RunCellBuild', 'RunCellBuildPinned'];

  test('a tenant build gets one PARAM_<NAME> per entry of the deployment set, after the fixed variables', async () => {
    for (const name of tenantTasks) {
      const environment = await buildEnvironment(tasks[name], {
        path: '$.tenantBuild.parameters',
        values: { ALLOWED_EMAIL_DOMAIN: 'example.com', LOG_LEVEL: 'info' },
      });
      expect(environment.PARAM_ALLOWED_EMAIL_DOMAIN).toBe('example.com');
      expect(environment.PARAM_LOG_LEVEL).toBe('info');
      // The prefix keeps a declared name off the contract's own variables.
      expect(environment.TENANT_ID).toBe('$.tenantId');
    }
  });

  test('a cell build gets the cell set only; a tenant build the deployment set only (§6.1)', async () => {
    for (const name of cellTasks) {
      const field: string = tasks[name].Arguments.EnvironmentVariablesOverride;
      expect(field).toContain('$each($states.input.cellBuild.parameters');
      expect(field).not.toContain('tenantBuild.parameters');
      const environment = await buildEnvironment(tasks[name], {
        path: '$.cellBuild.parameters',
        values: { CELL_SIZE: 'small' },
      });
      expect(Object.keys(environment).filter((k) => k.startsWith('PARAM_'))).toEqual(['PARAM_CELL_SIZE']);
    }
    for (const name of tenantTasks) {
      const field: string = tasks[name].Arguments.EnvironmentVariablesOverride;
      expect(field).toContain('$each($states.input.tenantBuild.parameters');
      expect(field).not.toContain('cellBuild.parameters');
    }
  });

  test('an empty set adds no variable: a name with no value and no default is absent, never empty (R-32)', async () => {
    for (const name of [...tenantTasks, ...cellTasks]) {
      const environment = await buildEnvironment(tasks[name]);
      expect(Object.keys(environment).filter((k) => k.startsWith('PARAM_'))).toEqual([]);
    }
  });

  test('build tasks are JSONata states whose Output keeps the input plus only the build ARN and status (ResultSelector role)', async () => {
    const results: Record<string, string> = {
      RunTenantBuild: 'tenantBuildResult',
      RunTenantBuildPinned: 'tenantBuildResult',
      RunCellBuild: 'cellBuildResult',
      RunCellBuildPinned: 'cellBuildResult',
    };
    for (const [name, field] of Object.entries(results)) {
      const task = tasks[name];
      expect(task.QueryLanguage).toBe('JSONata');
      expect(task.ResultPath).toBeUndefined();
      expect(task.ResultSelector).toBeUndefined();
      const output = await evaluateJsonata(task.Output, {
        input: { tenantId: 'T', tenantBuild: { parameters: { A: 'x' } } },
        result: {
          Build: {
            Arn: 'arn:aws:codebuild:eu-central-1:111111111111:build/p:1',
            BuildStatus: 'SUCCEEDED',
            Environment: { EnvironmentVariables: [{ Name: 'PARAM_A', Value: 'x' }] },
            ExportedEnvironmentVariables: [{ Name: 'SCRIPT_OUTPUTS', Value: '{}' }],
          },
        },
      });
      expect(output).toEqual({
        tenantId: 'T',
        tenantBuild: { parameters: { A: 'x' } },
        scriptOutputsRaw: '{}',
        [field]: { Build: { Arn: 'arn:aws:codebuild:eu-central-1:111111111111:build/p:1', BuildStatus: 'SUCCEEDED' } },
      });
    }
    // The terminal writes still read the ARN where they always did.
    expect(JSON.stringify(definition.States.SetTenantActiveAfterCreate)).toContain('$.tenantBuildResult.Build.Arn');
    expect(JSON.stringify(definition.States.SetCellActiveAfterCreate)).toContain('$.cellBuildResult.Build.Arn');
  });

  test('a build task\'s Catch keeps only the error name and the build ARN and status, never the raw Cause', async () => {
    const cause = { Build: { Arn: 'arn:b', BuildStatus: 'FAILED', Environment: { EnvironmentVariables: [{ Name: 'PARAM_A', Value: 'secret-shaped' }] } } };
    for (const name of [...tenantTasks, ...cellTasks]) {
      // One Catch: the outputs guard runs in the state after the task (R-43).
      expect(tasks[name].Catch).toHaveLength(1);
      const catcher = tasks[name].Catch[0];
      expect(catcher.ErrorEquals).toEqual(['States.ALL']);
      expect(catcher.ResultPath).toBeUndefined();
      expect(catcher.Next).toBe(name.startsWith('RunTenant') ? 'TenantBuildFailureShape' : 'CellBuildFailureShape');
      const states = (errorOutput: unknown) => ({ input: { cellId: 'C' }, errorOutput });

      // Wrapped and bare Build layouts both yield the evidence.
      const wrapped = await evaluateJsonata(catcher.Output, states({ Error: 'States.TaskFailed', Cause: JSON.stringify(cause) }));
      expect(wrapped).toEqual({
        cellId: 'C',
        error: { Error: 'States.TaskFailed' },
        failure: { buildArn: 'arn:b', buildStatus: 'FAILED' },
      });
      expect(JSON.stringify(wrapped)).not.toContain('secret-shaped');
      const bare = await evaluateJsonata(catcher.Output, states({ Error: 'States.TaskFailed', Cause: JSON.stringify(cause.Build) }));
      expect(bare.failure).toEqual({ buildArn: 'arn:b', buildStatus: 'FAILED' });

      // A Cause that is not valid JSON (cut off mid-environment, as a long
      // Build JSON can be) still yields the evidence and never fails the catcher.
      const full = JSON.stringify({
        Build: { ...cause.Build, Environment: { EnvironmentVariables: [{ Name: 'PARAM_A', Value: 'x'.repeat(40_000) }] } },
      });
      const truncated = await evaluateJsonata(catcher.Output, states({ Error: 'States.TaskFailed', Cause: full.slice(0, 32_768) }));
      expect(truncated.failure).toEqual({ buildArn: 'arn:b', buildStatus: 'FAILED' });
      expect(JSON.stringify(truncated)).not.toContain('xxxx');

      // A value cannot forge the pair: its quotes are escaped in the Cause.
      const forged = JSON.stringify({ Build: { Environment: { EnvironmentVariables: [{ Name: 'PARAM_A', Value: '"Arn":"arn:evil","BuildStatus":"SUCCEEDED"' }] } } });
      expect(await evaluateJsonata(catcher.Output, states({ Error: 'States.TaskFailed', Cause: forged }))).toEqual({
        cellId: 'C',
        error: { Error: 'States.TaskFailed' },
      });

      // A timeout, a null Cause or an unexpected shape keeps the error name only.
      for (const errorOutput of [
        { Error: 'States.Timeout', Cause: 'Task timed out' },
        { Error: 'States.TaskFailed', Cause: null },
        { Error: 'States.TaskFailed', Cause: '{"unexpected":true}' },
        { Error: 'States.TaskFailed', Cause: 'not JSON at all' },
        { Error: 'States.TaskFailed', Cause: '{"Build": {"Arn": "arn:b", "Bui' },
        { Error: 'States.TaskFailed' },
      ]) {
        expect(await evaluateJsonata(catcher.Output, states(errorOutput))).toEqual({
          cellId: 'C',
          error: { Error: errorOutput.Error },
        });
      }
    }
  });

  test('the failure Choice routes on the reduced evidence: with it the write names the build, without it the generic write runs', () => {
    const tenant = definition.States.TenantBuildFailureShape;
    expect(tenant.Type).toBe('Choice');
    expect(JSON.stringify(tenant.Choices)).toContain('$.failure.buildArn');
    // Choices[0] is the refused start (ADR-0049, test/tenant/build-slot-wait.test.ts).
    expect(tenant.Choices[1].Next).toBe('FailTenantWithBuild');
    expect(tenant.Default).toBe('FailTenant');
    const cell = definition.States.CellBuildFailureShape;
    expect(cell.Choices[1].Next).toBe('CellFailureHasTenantWithBuild');
    expect(cell.Default).toBe('CellFailureHasTenant');
    // The parse-in-state chain is gone: nothing re-materialises the Cause.
    expect(JSON.stringify(definition)).not.toContain('StringToJson');
    expect(JSON.stringify(definition)).not.toContain('$.error.Cause');
  });

  test('no terminal write touches the parameters map (R-21)', () => {
    expect(JSON.stringify(definition)).not.toMatch(/#parameters|SET parameters|parameters =/);
  });

  test('the definition holds no ${ sequence, which CloudFormation would read as Fn::Sub', () => {
    expect(JSON.stringify(definition)).not.toContain('${');
  });
});

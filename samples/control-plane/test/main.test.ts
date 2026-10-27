// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Environment } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { isFullCommitSha, sourcePinningWarning } from '../src/shared/service-config';
import {
  CellDefinition,
  TenantStack,
  TenantStackProps,
  validateTenantBuildManagedPolicyArns,
} from '../src/tenant/tenant.cdk';

const cellDefinition: CellDefinition = {
  source: { type: 'GITHUB', location: 'https://github.com/acme/provisioning.git' },
  cellScripts: {
    create: 'scripts/sample-cell/create.sh',
    update: 'scripts/sample-cell/update.sh',
    delete: 'scripts/sample-cell/delete.sh',
  },
  tenantScripts: {
    create: 'scripts/sample-tenant/create.sh',
    update: 'scripts/sample-tenant/update.sh',
    delete: 'scripts/sample-tenant/delete.sh',
  },
  maxTenants: 10,
};

// Skip NodejsFunction esbuild bundling in unit tests - assertions target
// infrastructure shape, not bundle contents.
function synth(extraProps: Partial<TenantStackProps> = {}, env?: Environment): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TenantStack(app, 'test', {
    vendorIdpIssuerUrl: 'https://idp.example.com',
    vendorIdpAudience: 'control-plane',
    cellDefinition,
    env,
    ...extraProps,
  });
  return Template.fromStack(stack);
}

describe('TenantStack', () => {
  const template = synth();

  test('control plane table has PITR enabled and both GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([
        Match.objectLike({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      ]),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'GSI1' }),
        Match.objectLike({ IndexName: 'GSI2' }),
      ]),
    });
  });

  test('provisioning state machine and the two shared CodeBuild projects exist', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    // One project for cell builds, one for tenant builds (ADR-002, ADR-012).
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
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
    // All eleven operations across five paths exist
    expect(Object.keys(body.paths).sort()).toEqual([
      '/cells',
      '/cells/{cellId}',
      '/tenants',
      '/tenants/{tenantId}',
      '/tenants/{tenantId}/resource',
    ]);
  });

  test('API handler receives the cellDefinition and workflow wiring', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CELL_DEFINITION: JSON.stringify(cellDefinition),
          GSI1_NAME: 'GSI1',
          GSI2_NAME: 'GSI2',
        }),
      },
    });
  });

  test('authorizer receives the vendor IdP configuration and the role allowlist (M13)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          VENDOR_IDP_ISSUER_URL: 'https://idp.example.com',
          VENDOR_IDP_AUDIENCE: 'control-plane',
          ALLOWED_ROLES: 'operator',
        },
      },
    });
  });

  test('synth fails on an invalid cellDefinition (§10)', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    expect(
      () =>
        new TenantStack(app, 'invalid', {
          vendorIdpIssuerUrl: 'https://idp.example.com',
          vendorIdpAudience: 'control-plane',
          cellDefinition: { ...cellDefinition, maxTenants: 0 },
        }),
    ).toThrow(/maxTenants/);
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
    // The minimum attribution fields.
    expect(format.requestId).toBe('$context.requestId');
    expect(format.ip).toBe('$context.identity.sourceIp');
    expect(format.requestTime).toBe('$context.requestTime');
    expect(format.httpMethod).toBe('$context.httpMethod');
    expect(format.resourcePath).toBe('$context.resourcePath');
    expect(format.status).toBe('$context.status');
  });

  test('both CodeBuild projects cap concurrent builds (T16 / M17)', () => {
    const projects = Object.values(template.findResources('AWS::CodeBuild::Project'));
    expect(projects).toHaveLength(2);
    for (const project of projects as any[]) {
      expect(project.Properties.ConcurrentBuildLimit).toBe(5);
    }
  });

  test('surge and client-error alarms exist without actions (T16 / M17)', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
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
    expect(definition).toContain('$.operatorId');
    // M10 (T5): a non-empty stamped pin becomes the SourceVersion override;
    // the pinned/unpinned split means the empty string is never sent.
    expect(definition).toContain('SourceVersion');
    expect(definition).toContain('$.sourceVersion');
  });

  test('an extra source.sourceVersion is carried through to the CELL_DEFINITION env var', () => {
    // The pinned ref is part of the stamped definition: it must survive the
    // context -> stack -> Lambda env pass-through untouched (T5 / M10).
    const pinned = {
      ...cellDefinition,
      source: { ...cellDefinition.source, sourceVersion: 'a'.repeat(40) },
    } as CellDefinition;
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new TenantStack(app, 'pinned', {
      vendorIdpIssuerUrl: 'https://idp.example.com',
      vendorIdpAudience: 'control-plane',
      cellDefinition: pinned,
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CELL_DEFINITION: JSON.stringify(pinned),
        }),
      },
    });
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
      if (state.Type === 'Task' && String(state.Resource).includes('codebuild:startBuild')) {
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

  test('every given ARN is attached to the tenant build role and to nothing else', () => {
    const template = synth({ tenantBuildManagedPolicyArns: [policyA, policyB] }, env);
    const { cell, tenant } = buildProjects(template);
    const tenantRole = serviceRole(template, tenant);
    const cellRole = serviceRole(template, cell);

    expect(tenantRole.Properties.ManagedPolicyArns).toEqual([policyA, policyB]);
    // Cell builds get none (the ADR is explicit about the tenant role only).
    expect(cellRole.Properties.ManagedPolicyArns).toBeUndefined();
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
// ADR-023: TENANT_NAME reaches every tenant build and no cell build.
// ---------------------------------------------------------------------------
describe('TENANT_NAME in the tenant script environment (ADR-023)', () => {
  const template = synth();
  const definition = stateMachineDefinition(template);
  const tasks = startBuildTasks(definition);
  const envOf = (task: any): Record<string, string> =>
    Object.fromEntries(
      task.Parameters.EnvironmentVariablesOverride.map((v: any) => [v.Name, v['Value.$']]),
    );

  test('both tenant build variants carry TENANT_NAME from the stored record, beside TENANT_ID and OPERATION', () => {
    for (const name of ['RunTenantBuild', 'RunTenantBuildPinned']) {
      const environment = envOf(tasks[name]);
      expect(environment.TENANT_NAME).toBe('$.tenantBuild.tenantName');
      expect(environment.TENANT_ID).toBe('$.tenantId');
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

  test('cell builds do not receive TENANT_NAME (or any tenant variable)', () => {
    for (const name of ['RunCellBuild', 'RunCellBuildPinned']) {
      const environment = envOf(tasks[name]);
      expect(environment.TENANT_NAME).toBeUndefined();
      expect(environment.TENANT_ID).toBeUndefined();
      expect(environment.ADMIN_EMAIL).toBeUndefined();
      expect(Object.keys(environment).sort()).toEqual(['CELL_ID', 'OPERATION', 'OPERATOR_ID', 'SCRIPT_PATH']);
    }
    // Exactly four startBuild tasks exist: two per project.
    expect(Object.keys(tasks).sort()).toEqual(['RunCellBuild', 'RunCellBuildPinned', 'RunTenantBuild', 'RunTenantBuildPinned']);
  });
});

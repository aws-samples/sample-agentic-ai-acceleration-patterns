// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Environment } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  buildProjectArn,
  buildRoleArn,
  apiRoleArn,
  hookRoleArn,
  provisioningRoleArn,
  workflowArn,
  workflowExecutionArnPattern,
} from '../../src/shared/fleet';
import {
  DENIED_APIGATEWAY_ACTIONS,
  DENIED_CODEBUILD_ACTIONS,
  DENIED_DYNAMODB_WRITES,
  DENIED_IAM_ROLE_WRITES,
  DENIED_LAMBDA_API_ACTIONS,
  DENIED_LAMBDA_WRITES,
} from '../../src/tenant/control-plane-deny';
import { validateHookManagedPolicyArns } from '../../src/tenant/hook.infra-validation';
import { TenantStack, TenantStackProps } from '../../src/tenant/tenant.cdk';

// Infrastructure of vendor hooks (spec R-41, §3.3, §10 unit assertions, ADR-044):
// the two hook roles, the build roles' trust, the explicit deny.

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const ENV: Environment = { account: ACCOUNT, region: REGION };
const FLEET = 'control-plane';
const GLOBAL_POLICY = `arn:aws:iam::${ACCOUNT}:policy/GlobalHookPolicy`;
const APP_POLICY = `arn:aws:iam::${ACCOUNT}:policy/AppHookPolicy`;

function synth(extra: Partial<TenantStackProps> = {}, env: Environment | null = ENV): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TenantStack(app, 'test', {
    vendorIdpIssuerUrl: 'https://idp.example.com',
    vendorIdpAudience: 'control-plane',
    env: env ?? undefined,
    ...extra,
  });
  return Template.fromStack(stack);
}

/** A template value as a plain string: `Fn::Join` flattened, pseudo-parameters as in ENV, other references as `<LogicalId[.Attribute]>`. */
function render(value: any): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value['Fn::Join'] !== undefined) {
    const [delimiter, parts] = value['Fn::Join'] as [string, any[]];
    return parts.map(render).join(delimiter);
  }
  if (value['Fn::GetAtt'] !== undefined) {
    return `<${(value['Fn::GetAtt'] as string[]).join('.')}>`;
  }
  if (value.Ref !== undefined) {
    const pseudo: Record<string, string> = {
      'AWS::Partition': 'aws',
      'AWS::Region': REGION,
      'AWS::AccountId': ACCOUNT,
    };
    return pseudo[value.Ref as string] ?? `<${value.Ref}>`;
  }
  throw new Error(`cannot render ${JSON.stringify(value)}`);
}

const asArray = (value: any): any[] => (Array.isArray(value) ? value : [value]);

type Resources = Record<string, any>;

function roleByName(template: Template, name: string): [string, any] {
  const found = Object.entries(template.findResources('AWS::IAM::Role') as Resources)
    .find(([, role]) => role.Properties.RoleName === name);
  if (found === undefined) {
    throw new Error(`no role named ${name}`);
  }
  return found;
}

/** The one standalone deny policy: the policy named `<fleet>-control-plane-deny`. */
function denyPolicy(template: Template): [string, any] {
  const found = Object.entries(template.findResources('AWS::IAM::Policy') as Resources)
    .filter(([, policy]) => policy.Properties.PolicyName === `${FLEET}-control-plane-deny`);
  expect(found).toHaveLength(1);
  return found[0];
}

/** Every `[action, resource]` of the Deny statements, as rendered strings. */
function deniedPairs(template: Template): Map<string, Set<string>> {
  const [, policy] = denyPolicy(template);
  const byAction = new Map<string, Set<string>>();
  for (const statement of asArray(policy.Properties.PolicyDocument.Statement)) {
    expect(statement.Effect).toBe('Deny');
    for (const action of asArray(statement.Action)) {
      const resources = byAction.get(action) ?? new Set<string>();
      asArray(statement.Resource).forEach((resource) => resources.add(render(resource)));
      byAction.set(action, resources);
    }
  }
  return byAction;
}

/** Allow statements of every IAM policy in the template, with the role ids each attaches to. */
function allowStatements(template: Template): Array<{ roles: string[]; statement: any }> {
  const inlineAndManaged = (Object.values(template.findResources('AWS::IAM::Policy') as Resources))
    .flatMap((policy) => asArray(policy.Properties.PolicyDocument.Statement)
      .map((statement) => ({ roles: asArray(policy.Properties.Roles).map((r) => r.Ref as string), statement })));
  const onRoles = Object.entries(template.findResources('AWS::IAM::Role') as Resources)
    .flatMap(([id, role]) => asArray(role.Properties.Policies ?? [])
      .flatMap((policy: any) => asArray(policy.PolicyDocument.Statement).map((statement) => ({ roles: [id], statement }))));
  return [...inlineAndManaged, ...onRoles].filter(({ statement }) => statement.Effect === 'Allow');
}

const grants = (statement: any, action: string): boolean =>
  asArray(statement.Action).some((a: string) => a === action || a === '*' || (a.endsWith('*') && action.startsWith(a.slice(0, -1))));

describe('hook roles (spec R-41, H-7)', () => {
  const template = synth({ globalHookManagedPolicyArns: [GLOBAL_POLICY], appHookManagedPolicyArns: [APP_POLICY] });

  test.each(['global-hook', 'app-hook'] as const)('%s trusts CodeBuild only, on its own project\'s computed ARN', (kind) => {
    const [, role] = roleByName(template, `${FLEET}-${kind}`);
    const statements = asArray(role.Properties.AssumeRolePolicyDocument.Statement);
    expect(statements).toHaveLength(1);
    const [statement] = statements;
    expect(statement.Effect).toBe('Allow');
    expect(statement.Action).toBe('sts:AssumeRole');
    expect(statement.Principal).toEqual({ Service: 'codebuild.amazonaws.com' });
    expect(Object.keys(statement.Condition)).toEqual(['ArnEquals']);
    expect(Object.keys(statement.Condition.ArnEquals)).toEqual(['aws:SourceArn']);
    expect(render(statement.Condition.ArnEquals['aws:SourceArn']))
      .toBe(buildProjectArn('aws', REGION, ACCOUNT, FLEET, kind));
  });

  test('the trust names no resource: the project ARN is computed, never a reference (no cycle)', () => {
    for (const kind of ['global-hook', 'app-hook']) {
      const [, role] = roleByName(template, `${FLEET}-${kind}`);
      expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).not.toContain('Fn::GetAtt');
      expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).not.toContain('"Ref":"Provisioning');
    }
  });

  test('each hook role carries only its own list of managed policies, and the other roles none', () => {
    expect(roleByName(template, `${FLEET}-global-hook`)[1].Properties.ManagedPolicyArns).toEqual([GLOBAL_POLICY]);
    expect(roleByName(template, `${FLEET}-app-hook`)[1].Properties.ManagedPolicyArns).toEqual([APP_POLICY]);
    const withPolicy = Object.values(template.findResources('AWS::IAM::Role') as Resources)
      .filter((role) => /(Global|App)HookPolicy/.test(JSON.stringify(role.Properties.ManagedPolicyArns ?? [])));
    expect(withPolicy).toHaveLength(2);
  });

  test('with no input a hook role has no managed policy', () => {
    const plain = synth();
    for (const kind of ['global-hook', 'app-hook']) {
      expect(roleByName(plain, `${FLEET}-${kind}`)[1].Properties.ManagedPolicyArns).toBeUndefined();
    }
  });

  test('neither the pair nor any role grants sts:AssumeRole on or to a hook role', () => {
    for (const kind of ['cell', 'tenant']) {
      const [, pair] = roleByName(template, `${FLEET}-${kind}-provisioning`);
      expect(JSON.stringify(pair.Properties.AssumeRolePolicyDocument)).not.toContain('-hook');
    }
    // The only AssumeRole grants are the build roles' and the API role's, on the pair's role name in any account.
    for (const { statement } of allowStatements(template).filter(({ statement: s }) => grants(s, 'sts:AssumeRole'))) {
      for (const resource of asArray(statement.Resource).map(render)) {
        expect(resource).toMatch(/:iam::\*:role\/control-plane-(cell|tenant)-provisioning$/);
      }
    }
  });

  test('no role holds iam:PassRole on a hook role (the workflow role included)', () => {
    for (const { statement } of allowStatements(template).filter(({ statement: s }) => grants(s, 'iam:PassRole'))) {
      throw new Error(`unexpected Allow of iam:PassRole: ${JSON.stringify(statement)}`);
    }
  });

  test('no build role, hook role or API role holds codebuild:StartBuild on a hook project; none starts an execution but the API role', () => {
    const hookProjects = (['global-hook', 'app-hook'] as const).map((kind) => buildProjectArn('aws', REGION, ACCOUNT, FLEET, kind));
    const roleId = (name: string) => roleByName(template, name)[0];
    const barred = [`${FLEET}-cell-build`, `${FLEET}-tenant-build`, `${FLEET}-global-hook`, `${FLEET}-app-hook`, `${FLEET}-api`].map(roleId);
    for (const { roles, statement } of allowStatements(template)) {
      if (grants(statement, 'codebuild:StartBuild') && roles.some((id) => barred.includes(id))) {
        for (const resource of asArray(statement.Resource).map(render)) {
          expect(hookProjects).not.toContain(resource);
          expect(resource).not.toBe('*');
        }
      }
    }
  });

  test('only the API role holds states:StartExecution on the workflow', () => {
    const holders = allowStatements(template).filter(({ statement }) => grants(statement, 'states:StartExecution'));
    expect(holders.length).toBeGreaterThan(0);
    const apiId = roleByName(template, `${FLEET}-api`)[0];
    for (const { roles } of holders) {
      expect(roles).toEqual([apiId]);
    }
    // No build or hook role holds it, by any statement.
    for (const name of ['cell-build', 'tenant-build', 'global-hook', 'app-hook']) {
      const id = roleByName(template, `${FLEET}-${name}`)[0];
      expect(holders.filter(({ roles }) => roles.includes(id))).toEqual([]);
    }
  });

  test('only the API role holds states:DescribeExecution, and only on the workflow\'s own executions (spec R-51, N-10)', () => {
    const holders = allowStatements(template).filter(({ statement }) => grants(statement, 'states:DescribeExecution'));
    expect(holders.length).toBeGreaterThan(0);
    const apiId = roleByName(template, `${FLEET}-api`)[0];
    for (const { statement, roles } of holders) {
      expect(roles).toEqual([apiId]);
      const resources = ([] as unknown[]).concat(statement.Resource);
      for (const resource of resources) {
        const text = JSON.stringify(resource);
        expect(text).toContain(`:execution:${FLEET}-workflow:*`);
      }
    }
  });
});

describe('build roles trust CodeBuild only on their own project (spec R-41, H-7)', () => {
  const template = synth();

  test.each([['cell', 'cell-build'], ['tenant', 'tenant-build']] as const)('%s build role', (kind, project) => {
    const [, role] = roleByName(template, `${FLEET}-${kind}-build`);
    const [statement] = asArray(role.Properties.AssumeRolePolicyDocument.Statement);
    expect(asArray(role.Properties.AssumeRolePolicyDocument.Statement)).toHaveLength(1);
    expect(statement.Principal).toEqual({ Service: 'codebuild.amazonaws.com' });
    expect(statement.Condition).toEqual({
      ArnEquals: { 'aws:SourceArn': expect.anything() },
    });
    expect(render(statement.Condition.ArnEquals['aws:SourceArn'])).toBe(buildProjectArn('aws', REGION, ACCOUNT, FLEET, project));
  });

  test('a custom fleet name moves every computed ARN', () => {
    const custom = synth({ fleetName: 'fleet-b' });
    const [, role] = roleByName(custom, 'fleet-b-global-hook');
    expect(render(asArray(role.Properties.AssumeRolePolicyDocument.Statement)[0].Condition.ArnEquals['aws:SourceArn']))
      .toBe(buildProjectArn('aws', REGION, ACCOUNT, 'fleet-b', 'global-hook'));
  });
});

describe('the standalone deny (spec R-41, M30, T41)', () => {
  const template = synth({ tenantBuildManagedPolicyArns: [`arn:aws:iam::${ACCOUNT}:policy/Tenant`] });
  const [denyId, deny] = denyPolicy(template);
  const pairs = deniedPairs(template);

  const partition = 'aws';
  const cellBuild = buildRoleArn(partition, ACCOUNT, FLEET, 'cell');
  const tenantBuild = buildRoleArn(partition, ACCOUNT, FLEET, 'tenant');
  const api = apiRoleArn(partition, ACCOUNT, FLEET);
  const globalHook = hookRoleArn(partition, ACCOUNT, FLEET, 'global-hook');
  const appHook = hookRoleArn(partition, ACCOUNT, FLEET, 'app-hook');
  const homeCell = provisioningRoleArn(partition, ACCOUNT, FLEET, 'cell');
  const homeTenant = provisioningRoleArn(partition, ACCOUNT, FLEET, 'tenant');
  const projects = (['cell-build', 'tenant-build', 'global-hook', 'app-hook'] as const)
    .map((kind) => buildProjectArn(partition, REGION, ACCOUNT, FLEET, kind));
  const workflow = workflowArn(partition, REGION, ACCOUNT, FLEET);

  // The CDK-named things, by attribute: found from the resources that own them.
  const resources = template.findResources('AWS::Lambda::Function') as Resources;
  const functionId = (variable: string) =>
    Object.entries(resources).find(([, fn]) => fn.Properties.Environment?.Variables?.[variable] !== undefined)![0];
  const apiFn = `<${functionId('GSI3_NAME')}.Arn>`;
  const authorizerFn = `<${functionId('VENDOR_IDP_ISSUER_URL')}.Arn>`;
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine') as Resources)[0];
  const workflowRole = render(machine.Properties.RoleArn);
  const authorizerRole = `<${(Object.values(resources).find((fn) => fn.Properties.Environment?.Variables?.VENDOR_IDP_ISSUER_URL !== undefined)!
    .Properties.Role['Fn::GetAtt'] as string[])[0]}.Arn>`;
  const cloudWatchRole = (() => {
    const [id] = Object.entries(template.findResources('AWS::IAM::Role') as Resources)
      .find(([, role]) => JSON.stringify(role.Properties.ManagedPolicyArns ?? []).includes('AmazonAPIGatewayPushToCloudWatchLogs'))!;
    return `<${id}.Arn>`;
  })();
  const restApiId = Object.keys(template.findResources('AWS::ApiGateway::RestApi'))[0];
  const restApi = `arn:aws:apigateway:${REGION}::/restapis/<${restApiId}>`;
  const table = `<${Object.keys(template.findResources('AWS::DynamoDB::GlobalTable'))[0]}.Arn>`;

  const expectDenied = (actions: readonly string[], expected: string[]) => {
    for (const action of actions) {
      expect([...(pairs.get(action) ?? [])].sort()).toEqual([...expected].sort());
    }
  };
  const bothForms = (arn: string) => [arn, `${arn}:*`];

  test('is one AWS::IAM::Policy with Deny statements only, and nothing depends on it', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy') as Resources)
      .filter((policy) => policy.Properties.PolicyName === `${FLEET}-control-plane-deny`);
    expect(policies).toHaveLength(1);
    for (const statement of asArray(deny.Properties.PolicyDocument.Statement)) {
      expect(statement.Effect).toBe('Deny');
    }
    // No reference to it and no DependsOn on it, anywhere in the template.
    const rest = JSON.stringify(
      Object.fromEntries(Object.entries(template.toJSON().Resources as Resources).filter(([id]) => id !== denyId)),
    );
    expect(rest).not.toContain(`"${denyId}"`);
    // Its Outputs and the rest of the template do not name it either.
    expect(JSON.stringify(template.toJSON().Outputs)).not.toContain(denyId);
  });

  test('attaches to the six roles and no other', () => {
    const attached = asArray(deny.Properties.Roles).map((role) => role.Ref).sort();
    const six = [
      `${FLEET}-cell-build`, `${FLEET}-tenant-build`, `${FLEET}-cell-provisioning`,
      `${FLEET}-tenant-provisioning`, `${FLEET}-global-hook`, `${FLEET}-app-hook`,
    ].map((name) => roleByName(template, name)[0]).sort();
    expect(attached).toEqual(six);
    // The workflow, API, authorizer and API Gateway CloudWatch roles carry none.
    for (const unnamed of [`${FLEET}-api`]) {
      expect(attached).not.toContain(roleByName(template, unnamed)[0]);
    }
    expect(attached).toHaveLength(6);
    expect(Object.keys(template.findResources('AWS::IAM::Role'))).toHaveLength(10);
  });

  test('iam:PassRole on the two build roles, the workflow role, the API role and the two hook roles', () => {
    expectDenied(['iam:PassRole'], [cellBuild, tenantBuild, workflowRole, api, globalHook, appHook]);
  });

  test('the seven IAM role writes on all ten roles, named by computed ARN or by attribute', () => {
    expectDenied(DENIED_IAM_ROLE_WRITES, [
      cellBuild, tenantBuild, homeCell, homeTenant, globalHook, appHook, api,
      workflowRole, authorizerRole, cloudWatchRole,
    ]);
    expect(DENIED_IAM_ROLE_WRITES).toHaveLength(7);
  });

  test('the six CodeBuild actions on all four projects', () => {
    expect(DENIED_CODEBUILD_ACTIONS).toHaveLength(6);
    expectDenied(DENIED_CODEBUILD_ACTIONS, projects);
  });

  test('states:StartExecution and UpdateStateMachine on the state machine ARN, RedriveExecution on the execution ARN', () => {
    expectDenied(['states:StartExecution', 'states:UpdateStateMachine'], [workflow]);
    expectDenied(['states:RedriveExecution'], [workflowExecutionArnPattern(partition, REGION, ACCOUNT, FLEET)]);
    expect(workflowExecutionArnPattern(partition, REGION, ACCOUNT, FLEET)).toBe(`arn:aws:states:${REGION}:${ACCOUNT}:execution:${FLEET}-workflow:*`);
  });

  test('the six Lambda writes on the API and authorizer functions, each unqualified and qualified', () => {
    expect(DENIED_LAMBDA_WRITES).toHaveLength(6);
    expectDenied(DENIED_LAMBDA_WRITES, [...bothForms(apiFn), ...bothForms(authorizerFn)]);
  });

  test('InvokeFunction, InvokeAsync, AddPermission and RemovePermission on the API function only, each unqualified and qualified', () => {
    expect(DENIED_LAMBDA_API_ACTIONS).toHaveLength(4);
    expectDenied(DENIED_LAMBDA_API_ACTIONS, bothForms(apiFn));
    expect(pairs.get('lambda:InvokeAsync')).toBeDefined();
  });

  test('the four API Gateway writes on the REST API and its sub-resources', () => {
    expect(DENIED_APIGATEWAY_ACTIONS).toHaveLength(4);
    expectDenied(DENIED_APIGATEWAY_ACTIONS, [restApi, `${restApi}/*`]);
  });

  test('the seven table writes on the table', () => {
    expect(DENIED_DYNAMODB_WRITES).toHaveLength(7);
    expectDenied(DENIED_DYNAMODB_WRITES, [table]);
  });

  test('denies exactly the listed actions, nothing more', () => {
    const listed = new Set<string>([
      'iam:PassRole', ...DENIED_IAM_ROLE_WRITES, ...DENIED_CODEBUILD_ACTIONS,
      'states:StartExecution', 'states:UpdateStateMachine', 'states:RedriveExecution',
      ...DENIED_LAMBDA_WRITES, ...DENIED_LAMBDA_API_ACTIONS, ...DENIED_APIGATEWAY_ACTIONS, ...DENIED_DYNAMODB_WRITES,
    ]);
    expect(new Set(pairs.keys())).toEqual(listed);
  });

  test('every physical name in the deny is a computed ARN, never a reference to a resource', () => {
    // Role, project and workflow ARNs with a fleet-derived name contain no GetAtt or Ref to a logical id.
    const all = [...pairs.values()].flatMap((set) => [...set]);
    for (const arn of [cellBuild, tenantBuild, homeCell, homeTenant, globalHook, appHook, api, ...projects, workflow]) {
      expect(all).toContain(arn);
    }
    const statements = JSON.stringify(deny.Properties.PolicyDocument);
    for (const name of ['cell-build', 'tenant-build', 'global-hook', 'app-hook']) {
      expect(statements).toContain(`project/${FLEET}-${name}`);
    }
    expect(statements).toContain(`stateMachine:${FLEET}-workflow`);
    expect(statements).toContain(`execution:${FLEET}-workflow:*`);
  });

  test('the deny fits the 10,240-character budget of a role\'s inline policies with room for the roles\' own', () => {
    // Rendered with the synth account and Region, whitespace stripped (IAM does not count it).
    const rendered = JSON.stringify(asArray(deny.Properties.PolicyDocument.Statement).map((statement) => ({
      ...statement,
      Resource: asArray(statement.Resource).map(render),
    })));
    expect(rendered.length).toBeLessThan(6500);
  });

  test('the stack outputs the API function name for the deny\'s integration test (spec §10)', () => {
    const outputs = template.toJSON().Outputs;
    expect(Object.keys(outputs)).toEqual(expect.arrayContaining(['ApiFunctionName', 'StateMachineArn']));
  });
});

describe('hook policy inputs (spec §3.3, R-41)', () => {
  const identity = { partition: 'aws', account: ACCOUNT };

  test('accept the two lists, or none', () => {
    expect(validateHookManagedPolicyArns([GLOBAL_POLICY], [APP_POLICY], identity)).toEqual({ global: [GLOBAL_POLICY], app: [APP_POLICY] });
    expect(validateHookManagedPolicyArns(undefined, undefined, identity)).toEqual({ global: [], app: [] });
  });

  test.each([
    ['globalHookManagedPolicyArns', (arns: string[]) => ({ globalHookManagedPolicyArns: arns })],
    ['appHookManagedPolicyArns', (arns: string[]) => ({ appHookManagedPolicyArns: arns })],
  ])('%s fails synth for a bad ARN, wrong partition or wrong account, naming the input', (name, props) => {
    const cases: Array<[string, RegExp]> = [
      ['not-an-arn', /not a customer-managed IAM policy ARN/],
      [`arn:aws-cn:iam::${ACCOUNT}:policy/P`, /partition 'aws-cn'; this stack deploys to 'aws'/],
      ['arn:aws:iam::210987654321:policy/P', /account 210987654321; this stack deploys to 123456789012/],
      ['arn:aws:iam::aws:policy/AdministratorAccess', /not a customer-managed IAM policy ARN/],
    ];
    for (const [arn, message] of cases) {
      expect(() => synth(props([arn]))).toThrow(message);
      expect(() => synth(props([arn]))).toThrow(new RegExp(`Invalid ${name} deployment input \\(spec R-41, ADR-044\\)`));
    }
  });

  test('an ARN in both lists fails synth, whatever its position', () => {
    expect(() => synth({ globalHookManagedPolicyArns: [GLOBAL_POLICY, APP_POLICY], appHookManagedPolicyArns: [APP_POLICY] }))
      .toThrow(new RegExp(`${APP_POLICY} is in both globalHookManagedPolicyArns and appHookManagedPolicyArns`));
  });

  test('a non-array input is rejected', () => {
    expect(() => validateHookManagedPolicyArns(GLOBAL_POLICY, undefined, identity)).toThrow(/globalHookManagedPolicyArns.*must be an array of strings/s);
    expect(() => validateHookManagedPolicyArns(undefined, {}, identity)).toThrow(/appHookManagedPolicyArns.*must be an array of strings/s);
  });

  test('an environment-agnostic stack rejects a non-empty list, and accepts an omitted one', () => {
    expect(() => synth({ appHookManagedPolicyArns: [APP_POLICY] }, null)).toThrow(/must be resolved at synth time/);
    expect(() => synth({}, null)).not.toThrow();
  });
});

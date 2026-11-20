// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, CfnResource, Stack, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ACCOUNT_BASE_TAG, CellAccountBaseStack, CellPoliciesStack, IDENTITY_PARAMETERS } from '../application/cell-account.cdk';
import { applyCellRolePath, cellSynthContext, CellRolePath } from '../application/cell-path';
import {
  API_GATEWAY_ACCOUNT_WRITE_ACTIONS,
  CELL_PASSED_TO_SERVICES,
  CELL_QUALIFIER,
  CELL_SERVICE_LINKED_ROLE_SERVICES,
  cellPolicyNames,
  IDENTITY_WRITE_ACTIONS,
  PARAMETER_WRITE_ACTIONS,
  RESOURCE_POLICY_WRITE_ACTIONS,
  ROLE_WRITE_ACTIONS,
} from '../application/cell-policies';
import { CellBoundaryProbeStack, CellWorkloadProbeStack, PROBE_DECOY_POLICY, PROBE_ROLES, PROBE_TAG } from '../application/cell-probe.cdk';

const NAMES = cellPolicyNames();
const CELL_ROLES = 'arn:<AWS::Partition>:iam::<AWS::AccountId>:role/cell/*';
const WORKLOAD_BOUNDARY = 'arn:<AWS::Partition>:iam::<AWS::AccountId>:policy/cell-workload-boundary';
const ASSETS = 'arn:<AWS::Partition>:s3:::cdk-cell-assets-<AWS::AccountId>-<AWS::Region>';
const OWNER_PARAMETERS = [
  'arn:<AWS::Partition>:ssm:*:<AWS::AccountId>:parameter/application-plane/shared/identity/*',
  'arn:<AWS::Partition>:ssm:*:<AWS::AccountId>:parameter/cdk-bootstrap/cell/*',
];
const API_ACCOUNT = 'arn:<AWS::Partition>:apigateway:*::/account';
const PUBLIC_URL_DENY = {
  Sid: 'DenyPublicFunctionUrls',
  Effect: 'Deny',
  Action: ['lambda:CreateFunctionUrlConfig', 'lambda:UpdateFunctionUrlConfig', 'lambda:AddPermission'],
  Resource: '*',
  Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'NONE' } },
};

/** Renders intrinsics the way the tests compare them: `Fn::Join` flattened, `Ref` of a pseudo parameter as `<AWS::...>`. */
function render(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(render);
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  if (obj['Fn::Join'] !== undefined) {
    const [d, items] = obj['Fn::Join'] as [string, unknown[]];
    return items.map((i) => String(render(i))).join(d);
  }
  if (typeof obj.Ref === 'string' && Object.keys(obj).length === 1) return `<${obj.Ref}>`;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, render(v)]));
}

const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function policiesTemplate(names = NAMES): { template: Template; json: any } {
  const app = new App();
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  const stack = new CellPoliciesStack(app, 'CellPolicies', { names });
  const template = Template.fromStack(stack);
  return { template, json: render(template.toJSON()) };
}

function managedPolicy(json: any, name: string): { statements: any[]; sid: (s: string) => any } {
  const found = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::IAM::ManagedPolicy' && r.Properties.ManagedPolicyName === name) as any[];
  expect(found).toHaveLength(1);
  const statements = found[0].Properties.PolicyDocument.Statement as any[];
  return {
    statements,
    sid: (s: string) => {
      const st = statements.filter((x) => x.Sid === s);
      expect(st).toHaveLength(1);
      return st[0];
    },
  };
}

describe('cellPolicyNames', () => {
  it('uses the spec names by default', () => {
    expect(NAMES).toEqual({
      execution: 'cell-execution-policy',
      boundary: 'cell-permissions-boundary',
      workloadBoundary: 'cell-workload-boundary',
      build: 'cell-build-policy',
    });
  });
  it('takes a short suffix and refuses anything else', () => {
    expect(cellPolicyNames('-v2').boundary).toBe('cell-permissions-boundary-v2');
    for (const bad of ['v2', '-', '-V2', '-a/b', `-${'a'.repeat(17)}`]) {
      expect(() => cellPolicyNames(bad)).toThrow(/suffix/);
    }
  });
});

describe('CellPoliciesStack (spec §8 decision 7, ADR-0006, ADR-0011)', () => {
  const { json } = policiesTemplate();

  it('passes cdk-nag, holds the four managed policies and nothing else, with no CDK bootstrap dependency', () => {
    expect(Object.values(json.Resources).map((r: any) => r.Type)).toEqual(Array(4).fill('AWS::IAM::ManagedPolicy'));
    // Legacy synthesizer: no bootstrap version parameter or rule.
    expect(json.Parameters?.BootstrapVersion).toBeUndefined();
    expect(json.Rules?.CheckBootstrapVersion).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/\d{12}/);
  });

  it('is tagged as an account-base stack', () => {
    const app = new App();
    const stack = new CellPoliciesStack(app, 'CellPolicies', { names: NAMES });
    expect(stack.tags.tagValues()).toEqual({ [ACCOUNT_BASE_TAG.key]: ACCOUNT_BASE_TAG.value });
  });

  describe('the execution policy', () => {
    const p = managedPolicy(json, 'cell-execution-policy');

    it('writes roles on role/cell/* only, and sets no boundary but the workload boundary', () => {
      const st = p.sid('CellRoles');
      expect(st.Effect).toBe('Allow');
      expect(st.Resource).toBe(CELL_ROLES);
      expect(list(st.Action)).toEqual(ROLE_WRITE_ACTIONS.filter((a) => a !== 'iam:CreateRole' && a !== 'iam:PutRolePermissionsBoundary'));
      expect(p.sid('CellRolesWithTheWorkloadBoundary')).toEqual({
        Sid: 'CellRolesWithTheWorkloadBoundary',
        Effect: 'Allow',
        Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        Resource: CELL_ROLES,
        Condition: { StringEquals: { 'iam:PermissionsBoundary': WORKLOAD_BOUNDARY } },
      });
    });

    it('passes /cell/ roles to Lambda and AgentCore only', () => {
      const st = p.sid('CellPassRole');
      expect(st).toEqual({
        Sid: 'CellPassRole',
        Effect: 'Allow',
        Action: 'iam:PassRole',
        Resource: CELL_ROLES,
        Condition: { StringEquals: { 'iam:PassedToService': [...CELL_PASSED_TO_SERVICES] } },
      });
      expect(CELL_PASSED_TO_SERVICES).toEqual(['lambda.amazonaws.com', 'bedrock-agentcore.amazonaws.com']);
    });

    it('creates the two service-linked roles only, under role/aws-service-role/', () => {
      expect(p.sid('CellServiceLinkedRoles')).toEqual({
        Sid: 'CellServiceLinkedRoles',
        Effect: 'Allow',
        Action: 'iam:CreateServiceLinkedRole',
        Resource: 'arn:<AWS::Partition>:iam::<AWS::AccountId>:role/aws-service-role/*',
        Condition: { StringEquals: { 'iam:AWSServiceName': ['ops.apigateway.amazonaws.com', 'runtime-identity.bedrock-agentcore.amazonaws.com'] } },
      });
    });

    it('allows no IAM action on * but reads, and reads the cell asset bucket only', () => {
      for (const st of p.statements) {
        if (list(st.Resource).includes('*')) {
          expect(list(st.Action).filter((a: any) => String(a).startsWith('iam:'))).toEqual(['iam:Get*', 'iam:List*']);
          expect(list(st.Action)).not.toContain('sts:AssumeRole');
        }
      }
      expect(p.sid('CellAssets').Resource).toEqual([ASSETS, `${ASSETS}/*`]);
      expect(p.statements.every((s) => s.Effect === 'Allow')).toBe(true);
    });
  });

  describe('the permissions boundary', () => {
    const p = managedPolicy(json, 'cell-permissions-boundary');

    it('allows role writes and PassRole on role/cell/* only, and assumes no role', () => {
      const st = p.sid('CellRoles');
      expect(st.Resource).toBe(CELL_ROLES);
      expect(list(st.Action)).toEqual([...ROLE_WRITE_ACTIONS]);
      for (const allow of p.statements.filter((x) => x.Effect === 'Allow')) {
        expect(list(allow.Action)).not.toContain('sts:AssumeRole');
      }
      expect(p.sid('CellPassRole').Condition).toEqual({ StringEquals: { 'iam:PassedToService': [...CELL_PASSED_TO_SERVICES] } });
    });

    it('denies a role without the workload boundary (ADR-0011)', () => {
      expect(p.sid('DenyRoleWithoutTheWorkloadBoundary')).toEqual({
        Sid: 'DenyRoleWithoutTheWorkloadBoundary',
        Effect: 'Deny',
        Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        Resource: '*',
        Condition: { StringNotEquals: { 'iam:PermissionsBoundary': WORKLOAD_BOUNDARY } },
      });
    });

    it('denies every role write, PassRole and AssumeRole outside role/cell/*', () => {
      const st = p.sid('DenyIamOutsideCell');
      expect(st.Effect).toBe('Deny');
      expect(st.NotResource).toBe(CELL_ROLES);
      expect(list(st.Action)).toEqual([...ROLE_WRITE_ACTIONS, 'iam:PassRole', 'sts:AssumeRole']);
    });

    it('denies PassRole to any other service', () => {
      expect(p.sid('DenyPassRoleToOtherServices')).toEqual({
        Sid: 'DenyPassRoleToOtherServices',
        Effect: 'Deny',
        Action: 'iam:PassRole',
        Resource: '*',
        Condition: { StringNotEquals: { 'iam:PassedToService': [...CELL_PASSED_TO_SERVICES] } },
      });
    });

    it('denies other service-linked roles, boundary removal, users, keys and policy writes', () => {
      expect(p.sid('DenyOtherServiceLinkedRoles')).toEqual({
        Sid: 'DenyOtherServiceLinkedRoles',
        Effect: 'Deny',
        Action: 'iam:CreateServiceLinkedRole',
        Resource: '*',
        Condition: { StringNotEquals: { 'iam:AWSServiceName': [...CELL_SERVICE_LINKED_ROLE_SERVICES] } },
      });
      const st = p.sid('DenyBoundaryRemovalAndIdentityWrites');
      expect(st.Effect).toBe('Deny');
      expect(st.Resource).toBe('*');
      expect(list(st.Action)).toEqual([...IDENTITY_WRITE_ACTIONS]);
    });

    it("denies writes to the owner's parameters and the API Gateway account setting", () => {
      expect(p.sid('DenyOwnerParameterWrites')).toEqual({ Sid: 'DenyOwnerParameterWrites', Effect: 'Deny', Action: [...PARAMETER_WRITE_ACTIONS], Resource: OWNER_PARAMETERS });
      expect(p.sid('DenyApiGatewayAccountSettings')).toEqual({
        Sid: 'DenyApiGatewayAccountSettings',
        Effect: 'Deny',
        Action: [...API_GATEWAY_ACCOUNT_WRITE_ACTIONS],
        Resource: API_ACCOUNT,
      });
    });

    it('allows the deploy-time services only: no run-time call and no IAM write on *', () => {
      const services = list(p.sid('CellServices').Action);
      expect(services).toContain('application-autoscaling:*');
      for (const a of ['execute-api:*', 'bedrock:InvokeModel', 'bedrock:ConverseStream', 'sts:TagSession', 'sts:GetCallerIdentity', 'xray:*']) {
        expect(services).not.toContain(a);
      }
      expect(services.filter((a: any) => String(a).startsWith('iam:'))).toEqual(['iam:Get*', 'iam:List*']);
    });

    it('denies public function URLs', () => {
      expect(p.sid('DenyPublicFunctionUrls')).toEqual(PUBLIC_URL_DENY);
    });
  });

  describe('the workload boundary (ADR-0011)', () => {
    const p = managedPolicy(json, 'cell-workload-boundary');

    it('denies every IAM action and allows none', () => {
      expect(p.sid('DenyIam')).toEqual({ Sid: 'DenyIam', Effect: 'Deny', Action: 'iam:*', Resource: '*' });
      for (const st of p.statements.filter((s) => s.Effect === 'Allow')) {
        expect(list(st.Action).some((a: any) => String(a).startsWith('iam:'))).toBe(false);
      }
    });

    it('allows AssumeRole on role/cell/* only', () => {
      expect(p.sid('WorkloadAssumeCellRoles')).toEqual({ Sid: 'WorkloadAssumeCellRoles', Effect: 'Allow', Action: 'sts:AssumeRole', Resource: CELL_ROLES });
      expect(p.sid('DenyAssumeOutsideCell')).toEqual({ Sid: 'DenyAssumeOutsideCell', Effect: 'Deny', Action: 'sts:AssumeRole', NotResource: CELL_ROLES });
      expect(list(p.sid('WorkloadServices').Action)).not.toContain('sts:AssumeRole');
    });

    it('keeps the run-time services, drops API Gateway and Application Auto Scaling, and keeps the owner denies', () => {
      const services = list(p.sid('WorkloadServices').Action);
      for (const a of ['bedrock-agentcore:*', 'bedrock:InvokeModel', 'dynamodb:*', 'execute-api:*', 'kms:*', 'lambda:*', 'logs:*', 'ssm:*', 'sts:TagSession', 'xray:*', 'cloudwatch:*']) {
        expect(services).toContain(a);
      }
      expect(services).not.toContain('apigateway:*');
      expect(services).not.toContain('application-autoscaling:*');
      expect(p.sid('WorkloadAssets').Resource).toEqual([ASSETS, `${ASSETS}/*`]);
      expect(p.sid('DenyOwnerParameterWrites').Resource).toEqual(OWNER_PARAMETERS);
      expect(p.sid('DenyApiGatewayAccountSettings').Resource).toBe(API_ACCOUNT);
    });

    it('denies resource-policy and sharing writes, and public function URLs', () => {
      const st = p.sid('DenyResourcePolicyWrites');
      expect(st.Effect).toBe('Deny');
      expect(st.Resource).toBe('*');
      expect(list(st.Action)).toEqual([...RESOURCE_POLICY_WRITE_ACTIONS]);
      for (const a of ['lambda:AddPermission', 'lambda:CreateFunctionUrlConfig', 'kms:PutKeyPolicy', 'kms:CreateGrant', 'logs:PutResourcePolicy', 'logs:PutSubscriptionFilter', 'dynamodb:PutResourcePolicy', 'bedrock-agentcore:PutResourcePolicy']) {
        expect(list(st.Action)).toContain(a);
      }
      expect(p.sid('DenyPublicFunctionUrls')).toEqual(PUBLIC_URL_DENY);
    });
  });

  describe('the build policy (control-plane ADR-0047)', () => {
    const p = managedPolicy(json, 'cell-build-policy');

    it('assumes the deploy and publishing cell bootstrap roles only, never the lookup role', () => {
      expect(p.statements).toEqual([
        {
          Sid: 'AssumeCellBootstrapRoles',
          Effect: 'Allow',
          Action: 'sts:AssumeRole',
          Resource: ['deploy', 'file-publishing', 'image-publishing'].map(
            (r) => `arn:<AWS::Partition>:iam::<AWS::AccountId>:role/cdk-${CELL_QUALIFIER}-${r}-role-<AWS::AccountId>-<AWS::Region>`,
          ),
        },
      ]);
      expect(JSON.stringify(p.statements)).not.toContain('lookup');
    });
  });

  it('follows the suffix in every name and in the boundary condition', () => {
    const names = cellPolicyNames('-v2');
    const { json: j } = policiesTemplate(names);
    for (const n of Object.values(names)) managedPolicy(j, n);
    expect(managedPolicy(j, names.boundary).sid('DenyRoleWithoutTheWorkloadBoundary').Condition).toEqual({
      StringNotEquals: { 'iam:PermissionsBoundary': `${WORKLOAD_BOUNDARY}-v2` },
    });
  });
});

describe('CellAccountBaseStack (spec §3.7, CP-4)', () => {
  function base(props: { userPoolId?: string; appClientId?: string } = {}): any {
    const app = new App();
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
    return render(Template.fromStack(new CellAccountBaseStack(app, 'CellAccountBase', props)).toJSON());
  }

  it('sets the API Gateway logs role on / with no boundary, and writes no parameter without identity inputs', () => {
    const json = base();
    const roles = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::IAM::Role') as any[];
    expect(roles).toHaveLength(1);
    expect(roles[0].Properties.Path).toBeUndefined();
    expect(roles[0].Properties.PermissionsBoundary).toBeUndefined();
    expect(roles[0].Properties.AssumeRolePolicyDocument.Statement[0].Principal).toEqual({ Service: 'apigateway.amazonaws.com' });
    const account = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::ApiGateway::Account') as any[];
    expect(account).toHaveLength(1);
    expect(Object.values(json.Resources).some((r: any) => r.Type === 'AWS::SSM::Parameter')).toBe(false);
    expect(json.Parameters?.BootstrapVersion).toBeUndefined();
  });

  it('writes both identity parameters when given both', () => {
    const json = base({ userPoolId: 'eu-central-1_example', appClientId: 'exampleclient' });
    const params = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::SSM::Parameter').map((r: any) => [r.Properties.Name, r.Properties.Value]);
    expect(params).toEqual([
      [IDENTITY_PARAMETERS.userPoolId, 'eu-central-1_example'],
      [IDENTITY_PARAMETERS.appClientId, 'exampleclient'],
    ]);
  });

  it('refuses one identity input without the other', () => {
    expect(() => new CellAccountBaseStack(new App(), 'B', { userPoolId: 'x' })).toThrow(/both/);
    expect(() => new CellAccountBaseStack(new App(), 'C', { appClientId: 'x' })).toThrow(/both/);
  });
});

describe('the /cell/ path aspect and the cell synth context', () => {
  it('puts CfnRole and raw AWS::IAM::Role resources on /cell/, overriding a path, and leaves other resources alone', () => {
    const app = new App();
    const stack = new Stack(app, 'S');
    new iam.Role(stack, 'A', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), path: '/other/' });
    new CfnResource(stack, 'Raw', {
      type: 'AWS::IAM::Role',
      properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] } },
    });
    new CfnResource(stack, 'Topic', { type: 'AWS::SNS::Topic', properties: {} });
    applyCellRolePath(stack);
    const json = Template.fromStack(stack).toJSON();
    const paths = Object.values(json.Resources).map((r: any) => [r.Type, r.Properties?.Path]);
    expect(paths).toEqual([
      ['AWS::IAM::Role', '/cell/'],
      ['AWS::IAM::Role', '/cell/'],
      ['AWS::SNS::Topic', undefined],
    ]);
    expect(new CellRolePath('/x/')).toBeInstanceOf(CellRolePath);
  });

  it('gives the qualifier and the workload boundary as an object', () => {
    expect(cellSynthContext(NAMES)).toEqual({
      '@aws-cdk/core:bootstrapQualifier': 'cell',
      '@aws-cdk/core:permissionsBoundary': { name: 'cell-workload-boundary' },
    });
  });
});

describe('the probe stacks', () => {
  it('CellWorkloadProbe: every role on /cell/ under the workload boundary, through the cell bootstrap', () => {
    const app = new App({ context: cellSynthContext(NAMES) });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
    const json = render(Template.fromStack(new CellWorkloadProbeStack(app, 'CellWorkloadProbe')).toJSON()) as any;
    const roles = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::IAM::Role') as any[];
    expect(roles.map((r) => r.Properties.RoleName).sort()).toEqual([PROBE_ROLES.target, PROBE_ROLES.tenant, PROBE_ROLES.workload].sort());
    for (const r of roles) {
      expect(r.Properties.Path).toBe('/cell/');
      expect(r.Properties.PermissionsBoundary).toBe(WORKLOAD_BOUNDARY);
    }
    expect(JSON.stringify(json.Parameters?.BootstrapVersion)).toContain('/cdk-bootstrap/cell/version');
  });

  it('CellBoundaryProbe: one /cell/ role under the cell permissions boundary, a decoy role on / and a decoy policy, an owner stack', () => {
    const app = new App();
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
    const stack = new CellBoundaryProbeStack(app, 'CellBoundaryProbe', { names: NAMES });
    const json = render(Template.fromStack(stack).toJSON()) as any;
    const roles = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::IAM::Role') as any[];
    expect(roles).toHaveLength(2);
    const probe = roles.find((r) => r.Properties.RoleName === PROBE_ROLES.boundary);
    expect(probe.Properties).toMatchObject({
      Path: '/cell/',
      PermissionsBoundary: 'arn:<AWS::Partition>:iam::<AWS::AccountId>:policy/cell-permissions-boundary',
    });
    const decoy = roles.find((r) => r.Properties.RoleName === PROBE_ROLES.decoy);
    expect(decoy.Properties.Path).toBeUndefined();
    expect(decoy.Properties.PermissionsBoundary).toBeUndefined();
    expect(decoy.Properties.Policies).toBeUndefined();
    expect(decoy.Properties.ManagedPolicyArns).toBeUndefined();
    expect(decoy.Properties.AssumeRolePolicyDocument.Statement[0].Condition).toEqual({
      ArnLike: { 'aws:PrincipalArn': 'arn:<AWS::Partition>:iam::<AWS::AccountId>:role/cell/cell-policy-probe*' },
    });
    const policies = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::IAM::ManagedPolicy') as any[];
    expect(policies.map((x) => x.Properties.ManagedPolicyName)).toEqual([PROBE_DECOY_POLICY]);
    expect(policies[0].Properties.Roles).toBeUndefined();
    const table = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::DynamoDB::GlobalTable') as any[];
    expect(table.map((t) => t.Properties.TableName)).toEqual(['cell-policy-probe-decoy']);
    expect(Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::KMS::Key')).toHaveLength(1);
    expect(json.Parameters?.BootstrapVersion).toBeUndefined();
    expect(stack.tags.tagValues()).toEqual({ [PROBE_TAG.key]: PROBE_TAG.value });
  });
});

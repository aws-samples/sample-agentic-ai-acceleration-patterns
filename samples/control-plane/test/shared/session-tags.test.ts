// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CellAccountStack } from '../../src/cell-account/cell-account.cdk';

/**
 * ADR-0051 on the synthesised role pair: which AssumeRole requests its trust
 * admits, and which parameters its own SSM grants reach for a given session.
 *
 * shortcut: the evaluator below models only the IAM condition operators and
 * policy variables the pair uses (ArnEquals, StringEquals, Null,
 * ForAllValues:StringEquals, `${aws:PrincipalTag/...}`, `*`). It shows the
 * policy says what ADR-0051 means; the integration test shows IAM agrees.
 */

const CP = '999999999999';
const ACCOUNT = '222222222222';
const REGION = 'eu-central-1';
const ROOT = `arn:aws:iam::${CP}:root`;
const API = `arn:aws:iam::${CP}:role/control-plane-api`;
const buildRole = (kind: string) => `arn:aws:iam::${CP}:role/control-plane-${kind}-build`;

function synth(externalId?: string): Template {
  const app = new App();
  return Template.fromStack(new CellAccountStack(app, 'account-b', {
    controlPlaneAccountId: CP,
    externalId,
    env: { account: ACCOUNT, region: REGION },
  }));
}

/** Resolves the CloudFormation intrinsics this template uses into a plain string. */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  const v = value as Record<string, any>;
  if (v['Fn::Join'] !== undefined) return (v['Fn::Join'][1] as unknown[]).map(render).join(v['Fn::Join'][0]);
  const refs: Record<string, string> = { 'AWS::Partition': 'aws', 'AWS::AccountId': ACCOUNT, 'AWS::Region': REGION };
  if (v.Ref !== undefined && refs[v.Ref] !== undefined) return refs[v.Ref];
  throw new Error(`cannot render ${JSON.stringify(value)}`);
}

const list = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(render) : [render(v)]);

interface AssumeRequest {
  readonly principalArn: string;
  readonly actions: string[];
  readonly tags?: Record<string, string>;
  readonly transitive?: string[];
  readonly externalId?: string;
}

/**
 * The request context value of a condition key for one action, or undefined
 * when the request does not carry it. STS has no `sts:ExternalId` in the
 * `sts:TagSession` context: a TagSession statement that required it refused
 * every tagged request in the integration test.
 */
function contextValue(request: AssumeRequest, key: string, action: string): string[] | undefined {
  if (key === 'aws:PrincipalArn') return [request.principalArn];
  if (key === 'sts:ExternalId') return request.externalId === undefined || action === 'sts:TagSession' ? undefined : [request.externalId];
  const tagKeys = Object.keys(request.tags ?? {});
  if (key === 'aws:TagKeys') return tagKeys.length === 0 ? undefined : tagKeys;
  if (key === 'sts:TransitiveTagKeys') return (request.transitive ?? []).length === 0 ? undefined : request.transitive;
  if (key.startsWith('aws:RequestTag/')) {
    const value = request.tags?.[key.slice('aws:RequestTag/'.length)];
    return value === undefined ? undefined : [value];
  }
  throw new Error(`unmodelled condition key ${key}`);
}

function conditionHolds(operator: string, key: string, expected: string[], request: AssumeRequest, action: string): boolean {
  const actual = contextValue(request, key, action);
  switch (operator) {
    case 'Null': return (actual === undefined) === (expected[0] === 'true');
    case 'ArnEquals':
    case 'StringEquals': return actual !== undefined && actual.length === 1 && expected.includes(actual[0]);
    // True for a missing key: that is why the trust pairs it with Null.
    case 'ForAllValues:StringEquals': return (actual ?? []).every((a) => expected.includes(a));
    default: throw new Error(`unmodelled operator ${operator}`);
  }
}

/** Whether a trust policy admits the request: one Allow statement must name every action and hold every condition. */
function trustAdmits(trust: any, request: AssumeRequest): boolean {
  return request.actions.every((action) => (trust.Statement as any[]).some((st) =>
    st.Effect === 'Allow' &&
    list(st.Action).includes(action) &&
    render(st.Principal.AWS) === ROOT &&
    Object.entries(st.Condition ?? {}).every(([op, keys]) =>
      Object.entries(keys as Record<string, unknown>).every(([key, value]) => conditionHolds(op, key, list(value), request, action)))));
}

/** The actions an AssumeRole request is authorised for: `sts:TagSession` too when it passes tags. */
const assume = (principalArn: string, tags?: Record<string, string>, transitive?: string[], externalId?: string): AssumeRequest => ({
  principalArn,
  actions: tags === undefined && transitive === undefined ? ['sts:AssumeRole'] : ['sts:AssumeRole', 'sts:TagSession'],
  tags,
  transitive,
  externalId,
});

const roleNamed = (template: Template, name: string): any =>
  (Object.values(template.findResources('AWS::IAM::Role')) as any[]).find((r) => r.Properties.RoleName === name);

const CELL_TAGS = { CellId: 'c1' };
const TENANT_TAGS = { CellId: 'c1', TenantId: 't1', ApplicationId: 'app-x' };

describe('the role pair trust admits a build only with its session tags, the API role only without (ADR-0051)', () => {
  const template = synth();
  const cellTrust = roleNamed(template, 'control-plane-cell-provisioning').Properties.AssumeRolePolicyDocument;
  const tenantTrust = roleNamed(template, 'control-plane-tenant-provisioning').Properties.AssumeRolePolicyDocument;

  test('a cell build with exactly CellId, transitive, is admitted', () => {
    expect(trustAdmits(cellTrust, assume(buildRole('cell'), CELL_TAGS, ['CellId']))).toBe(true);
  });

  test('a cell build that is untagged, not transitive, or passes another key is refused', () => {
    expect(trustAdmits(cellTrust, assume(buildRole('cell')))).toBe(false);
    expect(trustAdmits(cellTrust, assume(buildRole('cell'), CELL_TAGS))).toBe(false);
    expect(trustAdmits(cellTrust, assume(buildRole('cell'), { ...CELL_TAGS, TenantId: 't1' }, ['CellId']))).toBe(false);
    expect(trustAdmits(cellTrust, assume(buildRole('cell'), CELL_TAGS, ['CellId', 'Other']))).toBe(false);
    // A tenant build's tags do not open the cell role, nor does the tenant build role.
    expect(trustAdmits(cellTrust, assume(buildRole('tenant'), CELL_TAGS, ['CellId']))).toBe(false);
  });

  test('a tenant build with the three tags, transitive, is admitted', () => {
    expect(trustAdmits(tenantTrust, assume(buildRole('tenant'), TENANT_TAGS, ['CellId', 'TenantId', 'ApplicationId']))).toBe(true);
  });

  test('a tenant build with the three tags and only CellId transitive is admitted (the residual of threat model M35)', () => {
    expect(trustAdmits(tenantTrust, assume(buildRole('tenant'), TENANT_TAGS, ['CellId']))).toBe(true);
  });

  test('a tenant build missing a tag, untagged, or passing an extra key is refused', () => {
    for (const missing of Object.keys(TENANT_TAGS)) {
      const tags = Object.fromEntries(Object.entries(TENANT_TAGS).filter(([k]) => k !== missing));
      expect(trustAdmits(tenantTrust, assume(buildRole('tenant'), tags, Object.keys(tags)))).toBe(false);
    }
    expect(trustAdmits(tenantTrust, assume(buildRole('tenant')))).toBe(false);
    expect(trustAdmits(tenantTrust, assume(buildRole('tenant'), { ...TENANT_TAGS, Owner: 'x' }, ['CellId']))).toBe(false);
    expect(trustAdmits(tenantTrust, assume(buildRole('cell'), TENANT_TAGS, ['CellId']))).toBe(false);
  });

  test('the API role is admitted untagged, as before, and refused when it passes tags', () => {
    for (const trust of [cellTrust, tenantTrust]) {
      expect(trustAdmits(trust, assume(API))).toBe(true);
      expect(trustAdmits(trust, assume(API, CELL_TAGS, ['CellId']))).toBe(false);
    }
  });

  test('with an external id, both paths of both halves need it', () => {
    const withExternalId = synth('ext-12345');
    const halves = [
      ['cell', CELL_TAGS, ['CellId']],
      ['tenant', TENANT_TAGS, ['CellId', 'TenantId', 'ApplicationId']],
    ] as const;
    for (const [kind, tags, transitive] of halves) {
      const withId = roleNamed(withExternalId, `control-plane-${kind}-provisioning`).Properties.AssumeRolePolicyDocument;
      expect(trustAdmits(withId, assume(buildRole(kind), tags, [...transitive], 'ext-12345'))).toBe(true);
      expect(trustAdmits(withId, assume(buildRole(kind), tags, [...transitive]))).toBe(false);
      expect(trustAdmits(withId, assume(API, undefined, undefined, 'ext-12345'))).toBe(true);
      expect(trustAdmits(withId, assume(API))).toBe(false);
    }
  });
});

describe('the pair\'s own SSM grants reach only the session\'s own cell and deployment (ADR-0051)', () => {
  const template = synth();
  const policyOf = (roleName: string): any[] => {
    const [logicalId] = Object.entries(template.findResources('AWS::IAM::Role')).find(([, r]: [string, any]) => r.Properties.RoleName === roleName)!;
    const policy = (Object.values(template.findResources('AWS::IAM::Policy')) as any[])
      .find((p) => (p.Properties.Roles as any[]).some((r) => r.Ref === logicalId));
    return policy.Properties.PolicyDocument.Statement;
  };

  /** Whether an Allow statement grants the action on the parameter for a session with these principal tags. */
  const allows = (statements: any[], tags: Record<string, string>, action: string, parameter: string): boolean => {
    const arn = `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${parameter}`;
    return statements.some((st) => st.Effect === 'Allow' && list(st.Action).includes(action) && list(st.Resource).some((pattern) => {
      let missing = false;
      const resolved = pattern.replace(/\$\{aws:PrincipalTag\/([A-Za-z]+)\}/g, (_m, key: string) => {
        if (tags[key] === undefined) missing = true;
        return tags[key] ?? '';
      });
      // IAM drops a statement resource whose policy variable has no value.
      if (missing) return false;
      const regex = new RegExp(`^${resolved.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return regex.test(arn);
    }));
  };

  const cell = policyOf('control-plane-cell-provisioning');
  const tenant = policyOf('control-plane-tenant-provisioning');

  test('cell 1\'s role writes and lists its own cell namespace and cannot write cell 2\'s', () => {
    expect(allows(cell, CELL_TAGS, 'ssm:PutParameter', '/application-plane/cells/c1/shared-endpoint')).toBe(true);
    expect(allows(cell, CELL_TAGS, 'ssm:GetParametersByPath', '/application-plane/cells/c1')).toBe(true);
    expect(allows(cell, CELL_TAGS, 'ssm:PutParameter', '/application-plane/cells/c2/shared-endpoint')).toBe(false);
    expect(allows(cell, CELL_TAGS, 'ssm:DeleteParameter', '/application-plane/cells/c2/shared-endpoint')).toBe(false);
    expect(allows(cell, CELL_TAGS, 'ssm:PutParameter', '/application-plane/cells/c10/shared-endpoint')).toBe(false);
    expect(allows(cell, CELL_TAGS, 'ssm:PutParameter', '/application-plane/tenants/t1/app-x')).toBe(false);
  });

  test('an untagged session reaches no cell or tenant parameter, but still reads the shared namespaces', () => {
    expect(allows(cell, {}, 'ssm:PutParameter', '/application-plane/cells/c1/shared-endpoint')).toBe(false);
    expect(allows(tenant, {}, 'ssm:GetParameter', '/application-plane/cells/c1/shared-endpoint')).toBe(false);
    expect(allows(tenant, {}, 'ssm:PutParameter', '/application-plane/tenants/t1/app-x')).toBe(false);
    expect(allows(cell, {}, 'ssm:GetParameter', '/application-plane/shared/x')).toBe(true);
    expect(allows(tenant, {}, 'ssm:GetParameter', '/application-plane/applications/app-x/shared/base-domain')).toBe(true);
  });

  test('a tenant build reads only its own cell and writes only its own deployment', () => {
    expect(allows(tenant, TENANT_TAGS, 'ssm:GetParameter', '/application-plane/cells/c1/shared-endpoint')).toBe(true);
    expect(allows(tenant, TENANT_TAGS, 'ssm:GetParameter', '/application-plane/cells/c2/shared-endpoint')).toBe(false);
    expect(allows(tenant, TENANT_TAGS, 'ssm:PutParameter', '/application-plane/cells/c1/shared-endpoint')).toBe(false);
    expect(allows(tenant, TENANT_TAGS, 'ssm:PutParameter', '/application-plane/tenants/t1/app-x')).toBe(true);
    expect(allows(tenant, TENANT_TAGS, 'ssm:PutParameter', '/application-plane/tenants/t1/app-x/state')).toBe(true);
    expect(allows(tenant, TENANT_TAGS, 'ssm:PutParameter', '/application-plane/tenants/t1/app-y')).toBe(false);
    expect(allows(tenant, TENANT_TAGS, 'ssm:PutParameter', '/application-plane/tenants/t2/app-x')).toBe(false);
    expect(allows(tenant, TENANT_TAGS, 'ssm:DeleteParameter', '/application-plane/tenants/t2/app-x')).toBe(false);
  });
});

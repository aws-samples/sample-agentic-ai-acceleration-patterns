// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// The account check's own expectations, so the template and the check cannot drift apart.
// eslint-disable-next-line import/no-relative-packages
import { PAIR_INLINE, PAIR_INLINE_ACTIONS, PAIR_POLICY, pairTrustProblems } from '../../samples/control-plane/test/stress/account-check';

/**
 * Synthesises `application/role-pair-app.ts` as `deploy-role-pair.sh` does and pins the
 * template: two roles on `/` with no boundary, each trusting only the platform account,
 * narrowed to the fleet's build role and API role, each with exactly its owner policy and
 * its SSM default policy (spec §3.7, stress ADR-0012). The app runs control-plane's own
 * stack, so it needs that sample's `npm ci`; without it the suite is skipped and says so.
 */

const STRESS = path.resolve(__dirname, '..');
const CONTROL_PLANE = path.resolve(STRESS, '..', 'samples', 'control-plane');
const installed = fs.existsSync(path.join(CONTROL_PLANE, 'node_modules', 'aws-cdk-lib'));
const CP = '111111111111';
const CELL = '222222222222';
const FLEET = 'stresstest';

function synth(): any {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'role-pair-'));
  try {
    execFileSync(path.join(STRESS, 'node_modules', '.bin', 'ts-node'), ['--transpile-only', path.join(STRESS, 'application', 'role-pair-app.ts')], {
      cwd: STRESS,
      env: {
        ...process.env,
        CDK_OUTDIR: out,
        CDK_DEFAULT_ACCOUNT: CELL,
        CDK_DEFAULT_REGION: 'eu-central-1',
        STRESS_FLEET_NAME: FLEET,
        CONTROL_PLANE_ACCOUNT_ID: CP,
        CELL_POLICY_SUFFIX: '-v2',
      },
      stdio: 'pipe',
    });
    return JSON.parse(fs.readFileSync(path.join(out, `${FLEET}-cell-account.template.json`), 'utf8'));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

(installed ? describe : describe.skip)('the role pair template (role-pair-app.ts)', () => {
  if (!installed) {
    // eslint-disable-next-line no-console
    console.warn('skipped: run npm ci in samples/control-plane to synthesise the role pair');
  }
  const template = installed ? synth() : { Resources: {} };
  const resources = Object.values(template.Resources) as any[];
  const roles = resources.filter((r) => r.Type === 'AWS::IAM::Role');
  const byName = (n: string) => roles.find((r) => r.Properties.RoleName === n);

  it('holds the two roles and their default policies, nothing else, with no CDK bootstrap dependency', () => {
    expect(resources.map((r) => r.Type).filter((t) => t !== 'AWS::CDK::Metadata').sort()).toEqual(['AWS::IAM::Policy', 'AWS::IAM::Policy', 'AWS::IAM::Role', 'AWS::IAM::Role']);
    expect(template.Parameters?.BootstrapVersion).toBeUndefined();
    expect(roles.map((r) => r.Properties.RoleName).sort()).toEqual([`${FLEET}-cell-provisioning`, `${FLEET}-tenant-provisioning`]);
  });

  it.each([
    ['cell', `${PAIR_POLICY.cell}-v2`],
    ['tenant', `${PAIR_POLICY.tenant}-v2`],
  ])('puts the %s role on / without a boundary, trusted by the platform account\'s build and API roles only, with %s', (kind, policy) => {
    const role = byName(`${FLEET}-${kind}-provisioning`);
    expect(role.Properties.Path).toBeUndefined();
    expect(role.Properties.PermissionsBoundary).toBeUndefined();
    expect(role.Properties.ManagedPolicyArns).toEqual([`arn:aws:iam::${CELL}:policy/${policy}`]);
    // Control-plane ADR-0051: the API role untagged; the build role only with its session tags.
    const keys = kind === 'cell' ? ['CellId'] : ['CellId', 'TenantId', 'ApplicationId'];
    const principal = { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${CP}:root`]] } };
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Action: 'sts:AssumeRole',
        Effect: 'Allow',
        Principal: principal,
        Condition: { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${CP}:role/${FLEET}-api` } },
      },
      {
        Action: 'sts:AssumeRole',
        Effect: 'Allow',
        Principal: principal,
        Condition: {
          'ArnEquals': { 'aws:PrincipalArn': `arn:aws:iam::${CP}:role/${FLEET}-${kind}-build` },
          'Null': Object.fromEntries(keys.map((k) => [`aws:RequestTag/${k}`, 'false'])),
          'ForAllValues:StringEquals': { 'aws:TagKeys': keys },
        },
      },
      {
        Action: 'sts:TagSession',
        Effect: 'Allow',
        Principal: principal,
        Condition: {
          'ArnEquals': { 'aws:PrincipalArn': `arn:aws:iam::${CP}:role/${FLEET}-${kind}-build` },
          'Null': { ...Object.fromEntries(keys.map((k) => [`aws:RequestTag/${k}`, 'false'])), 'sts:TransitiveTagKeys': 'false' },
          'ForAllValues:StringEquals': { 'aws:TagKeys': keys, 'sts:TransitiveTagKeys': keys },
        },
      },
    ]);
  });

  it.each(['cell', 'tenant'] as const)('writes a %s trust the account check accepts', (half) => {
    const trust = JSON.parse(JSON.stringify(byName(`${FLEET}-${half}-provisioning`).Properties.AssumeRolePolicyDocument)
      .replace(/\{"Fn::Join":\["",\["arn:",\{"Ref":"AWS::Partition"\},":iam::(\d{12}):root"\]\]\}/g, '"arn:aws:iam::$1:root"'));
    const role = { name: `${FLEET}-${half}-provisioning`, path: '/', arn: `arn:aws:iam::${CELL}:role/${FLEET}-${half}-provisioning`, trust };
    const state = { accountId: CELL, partition: 'aws', stacks: [], roles: [], pair: {} };
    expect(pairTrustProblems(half, role, state, { fleet: FLEET, accountBaseStackArns: [], platformAccountId: CP })).toEqual([]);
  });

  it('gives each half the default policy the account check expects: its name, its SSM actions and its parameter resources', () => {
    const policies = resources.filter((r) => r.Type === 'AWS::IAM::Policy');
    expect(policies).toHaveLength(2);
    for (const half of ['cell', 'tenant'] as const) {
      const role = Object.entries(template.Resources).find(([, r]: [string, any]) => r.Properties?.RoleName === `${FLEET}-${half}-provisioning`)![0];
      const mine = policies.filter((p) => (p.Properties.Roles as any[]).some((r) => r.Ref === role));
      expect(mine).toHaveLength(1);
      // CloudFormation names the inline policy by PolicyName, which the check matches.
      expect(mine[0].Properties.PolicyName).toMatch(PAIR_INLINE[half]);
      for (const st of mine[0].Properties.PolicyDocument.Statement as any[]) {
        expect(st.Effect).toBe('Allow');
        expect(st.NotAction).toBeUndefined();
        expect(st.NotResource).toBeUndefined();
        for (const a of [st.Action].flat()) expect(PAIR_INLINE_ACTIONS).toContain(a);
        for (const r of [st.Resource].flat()) {
          // arn:<partition>:ssm:<region>:<account>:parameter/application-plane/...
          expect(r['Fn::Join']).toBeDefined();
          const parts = r['Fn::Join'][1] as any[];
          expect(parts[0]).toBe('arn:');
          expect(parts[1]).toEqual({ Ref: 'AWS::Partition' });
          const rendered = parts.map((x) => (typeof x === 'string' ? x : x.Ref === 'AWS::AccountId' ? CELL : `<${x.Ref}>`)).join('');
          expect(rendered).toMatch(new RegExp(`^arn:<AWS::Partition>:ssm:[^:]+:${CELL}:parameter/application-plane/`));
        }
      }
    }
  });
});

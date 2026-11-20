// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
    ['cell', 'cell-build-policy-v2'],
    ['tenant', 'cell-tenant-build-policy-v2'],
  ])('puts the %s role on / without a boundary, trusted by the platform account\'s build and API roles only, with %s', (kind, policy) => {
    const role = byName(`${FLEET}-${kind}-provisioning`);
    expect(role.Properties.Path).toBeUndefined();
    expect(role.Properties.PermissionsBoundary).toBeUndefined();
    expect(role.Properties.ManagedPolicyArns).toEqual([`arn:aws:iam::${CELL}:policy/${policy}`]);
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Action: 'sts:AssumeRole',
        Effect: 'Allow',
        Principal: { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${CP}:root`]] } },
        Condition: {
          ArnEquals: {
            'aws:PrincipalArn': [`arn:aws:iam::${CP}:role/${FLEET}-${kind}-build`, `arn:aws:iam::${CP}:role/${FLEET}-api`],
          },
        },
      },
    ]);
  });

  it('gives the default policies SSM namespace actions only', () => {
    for (const p of resources.filter((r) => r.Type === 'AWS::IAM::Policy')) {
      const actions = (p.Properties.PolicyDocument.Statement as any[]).flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
      expect(actions.every((a: string) => a.startsWith('ssm:'))).toBe(true);
    }
  });
});

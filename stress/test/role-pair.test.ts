// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { cellAppContext, cellStackName, CELL_TAG } from '../application/cell-stack';
import { fleetNameOf, rolePairProps, rolePairRoleNames, rolePairStackName } from '../application/role-pair';

const CP = '111111111111';
const CELL = '222222222222';

describe('the role pair (spec §3.7, stress ADR-0012)', () => {
  it('attaches cell-build-policy to the cell role and cell-tenant-build-policy to the tenant role, with the suffix', () => {
    expect(rolePairProps({ fleetName: 'stressw5', controlPlaneAccountId: CP, cellAccountId: CELL, policySuffix: '-w10' })).toEqual({
      stackName: 'stressw5-cell-account',
      fleetName: 'stressw5',
      controlPlaneAccountId: CP,
      cellBuildManagedPolicyArns: [`arn:aws:iam::${CELL}:policy/cell-build-policy-w10`],
      tenantBuildManagedPolicyArns: [`arn:aws:iam::${CELL}:policy/cell-tenant-build-policy-w10`],
    });
    expect(rolePairStackName('f')).toBe('f-cell-account');
    expect(rolePairRoleNames('f')).toEqual(['f-cell-provisioning', 'f-tenant-provisioning']);
  });

  it('refuses the platform account as a cell account, a bad fleet name, account id, partition or suffix', () => {
    expect(() => rolePairProps({ fleetName: 'f', controlPlaneAccountId: CP, cellAccountId: CP })).toThrow(/platform account/);
    expect(() => rolePairProps({ fleetName: 'F', controlPlaneAccountId: CP, cellAccountId: CELL })).toThrow(/fleetName/);
    expect(() => rolePairProps({ fleetName: 'f', controlPlaneAccountId: '1', cellAccountId: CELL })).toThrow(/controlPlaneAccountId/);
    expect(() => rolePairProps({ fleetName: 'f', controlPlaneAccountId: CP, cellAccountId: CELL, partition: 'x' })).toThrow(/partition/);
    expect(() => rolePairProps({ fleetName: 'f', controlPlaneAccountId: CP, cellAccountId: CELL, policySuffix: 'v2' })).toThrow(/suffix/);
  });

  it('derives the fleet from the prefix in lower case', () => {
    expect(fleetNameOf('StressW5')).toBe('stressw5');
    expect(() => fleetNameOf(`S${'a'.repeat(32)}`)).toThrow(/fleet name/);
  });
});

describe('the cell stack (spec §3.3)', () => {
  it('is named after the cell and deploys the api-gateway ingress with the TVM and no account-wide parameters', () => {
    expect(cellStackName('01KAAAAAAAAAAAAAAAAAAAAAAA')).toBe('StressCell-01KAAAAAAAAAAAAAAAAAAAAAAA');
    expect(cellAppContext('S')).toEqual({ ingress: 'api-gateway', tvm: 'true', publishParameters: 'false', owner: 'S' });
    expect(CELL_TAG).toEqual({ key: 'stress:part', value: 'cell' });
  });
  it('refuses anything but a ULID, so the id never reaches a stack name unchecked', () => {
    for (const bad of ['', 'x', '01kaaaaaaaaaaaaaaaaaaaaaaa', '01KAAAAAAAAAAAAAAAAAAAAAA!', '01KAAAAAAAAAAAAAAAAAAAAAAAA']) {
      expect(() => cellStackName(bad)).toThrow(/ULID/);
    }
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { emitterFromCallerArn, emitterKey, emitterRoleName, emitterRolePattern } from '../src/shared/identity';

const CELL = '01JD0000000000000000000000';
const ACCOUNT = '111122223333';

describe('emitter identity (spec §3.2, ADR-0001)', () => {
  test('an assumed emitter role is reduced to its account, role and cell', () => {
    const caller = emitterFromCallerArn(`arn:aws:sts::${ACCOUNT}:assumed-role/demo-ue-${CELL}/emitter-session`, 'demo');
    expect(caller).toEqual({
      partition: 'aws',
      accountId: ACCOUNT,
      roleName: `demo-ue-${CELL}`,
      roleArn: `arn:aws:iam::${ACCOUNT}:role/demo-ue-${CELL}`,
      cellId: CELL,
    });
    expect(emitterKey(caller!.accountId, caller!.roleName)).toEqual({ PK: `EMITTER#${ACCOUNT}#demo-ue-${CELL}`, SK: 'META' });
  });

  test.each([
    ['an IAM user', `arn:aws:iam::${ACCOUNT}:user/alice`],
    ['the account root', `arn:aws:iam::${ACCOUNT}:root`],
    ['a federated user', `arn:aws:sts::${ACCOUNT}:federated-user/alice`],
    ['a role of another fleet', `arn:aws:sts::${ACCOUNT}:assumed-role/other-ue-${CELL}/s1`],
    ['a role without a cell id', `arn:aws:sts::${ACCOUNT}:assumed-role/demo-ue-not-a-cell/s1`],
    ['a role named like the pattern with a lowercase id', `arn:aws:sts::${ACCOUNT}:assumed-role/demo-ue-${CELL.toLowerCase()}/s1`],
    ['no caller', undefined],
  ])('%s is refused', (_label, arn) => {
    expect(emitterFromCallerArn(arn, 'demo')).toBeUndefined();
  });

  test('the role name stays within the IAM limit for the longest fleet name', () => {
    const fleet = 'a'.repeat(32);
    expect(emitterRoleName(fleet, CELL).length).toBe(62);
    expect(() => emitterRoleName('Bad_Fleet', CELL)).toThrow(/outside/);
    expect(() => emitterRoleName('demo', 'x')).toThrow(/ULID/);
    expect(emitterRolePattern('demo')).toBe('arn:aws:iam::*:role/demo-ue-*');
  });
});

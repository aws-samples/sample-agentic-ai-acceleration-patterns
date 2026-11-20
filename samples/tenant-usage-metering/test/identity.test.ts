// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { emitterFromCallerArn, emitterKey, emitterRoleName, emitterRolePattern } from '../src/shared/identity';

const EMITTER_ID = '01JD0000000000000000000000';
const ACCOUNT = '111122223333';

describe('emitter identity (spec §3.2, ADR-0001)', () => {
  test('an assumed emitter role is reduced to its account, role and emitter id', () => {
    const caller = emitterFromCallerArn(`arn:aws:sts::${ACCOUNT}:assumed-role/demo-ue-${EMITTER_ID}/emitter-session`, 'demo');
    expect(caller).toEqual({
      partition: 'aws',
      accountId: ACCOUNT,
      roleName: `demo-ue-${EMITTER_ID}`,
      roleArn: `arn:aws:iam::${ACCOUNT}:role/demo-ue-${EMITTER_ID}`,
      emitterId: EMITTER_ID,
    });
    expect(emitterKey(caller!.accountId, caller!.roleName)).toEqual({ PK: `ROLE#${ACCOUNT}#demo-ue-${EMITTER_ID}`, SK: 'META' });
  });

  test.each([
    ['an IAM user', `arn:aws:iam::${ACCOUNT}:user/alice`],
    ['the account root', `arn:aws:iam::${ACCOUNT}:root`],
    ['a federated user', `arn:aws:sts::${ACCOUNT}:federated-user/alice`],
    ['a role of another fleet', `arn:aws:sts::${ACCOUNT}:assumed-role/other-ue-${EMITTER_ID}/s1`],
    ['a role without an emitter id', `arn:aws:sts::${ACCOUNT}:assumed-role/demo-ue-not-an-emitter/s1`],
    ['a role named like the pattern with a lowercase id', `arn:aws:sts::${ACCOUNT}:assumed-role/demo-ue-${EMITTER_ID.toLowerCase()}/s1`],
    ['no caller', undefined],
  ])('%s is refused', (_label, arn) => {
    expect(emitterFromCallerArn(arn, 'demo')).toBeUndefined();
  });

  test('the role name stays within the IAM limit for the longest fleet name', () => {
    const fleet = 'a'.repeat(32);
    expect(emitterRoleName(fleet, EMITTER_ID).length).toBe(62);
    expect(() => emitterRoleName('Bad_Fleet', EMITTER_ID)).toThrow(/outside/);
    expect(() => emitterRoleName('demo', 'x')).toThrow(/ULID/);
    expect(emitterRolePattern('demo', 'aws')).toBe('arn:aws:iam::*:role/demo-ue-*');
    expect(emitterRolePattern('demo', 'aws-cn')).toBe('arn:aws-cn:iam::*:role/demo-ue-*');
    // The pattern and the run-time check agree in another partition.
    const caller = emitterFromCallerArn(`arn:aws-cn:sts::111122223333:assumed-role/${emitterRoleName('demo', EMITTER_ID)}/s1`, 'demo');
    expect(caller?.roleArn).toMatch(/^arn:aws-cn:iam::111122223333:role\/demo-ue-/);
  });
});

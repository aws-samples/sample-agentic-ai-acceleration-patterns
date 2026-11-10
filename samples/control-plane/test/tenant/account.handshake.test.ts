// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { PROBE_SESSION_POLICY, stsHandshakeProbe } from '../../src/tenant/account.handshake';

const stsMock = mockClient(STSClient);

describe('stsHandshakeProbe (R-26, ADR-027, ADR-028)', () => {
  const probe = stsHandshakeProbe(new STSClient({}), 'aws', 'control-plane');

  beforeEach(() => stsMock.reset());

  const CELL_ROLE = 'arn:aws:iam::222222222222:role/control-plane-cell-provisioning';
  const TENANT_ROLE = 'arn:aws:iam::222222222222:role/control-plane-tenant-provisioning';

  const accessDenied = (): Error => {
    const denied = new Error('User is not authorized to perform: sts:AssumeRole');
    denied.name = 'AccessDenied';
    return denied;
  };

  /** A pair that enforces the external id: admits the call with it, refuses the call without it. */
  const enforcingPair = (): void => {
    stsMock.on(AssumeRoleCommand).callsFake((input) =>
      input.ExternalId === undefined ? Promise.reject(accessDenied()) : Promise.resolve({}),
    );
  };

  test('assumes both halves of the pair with the external id, then proves each refuses the call without it (ADR-030); 15-minute session and deny-all session policy on every call', async () => {
    enforcingPair();

    const refusals = await probe({ accountId: '222222222222', externalId: 'ext-1', operatorId: 'auth0|op-1' });

    expect(refusals).toEqual([]);
    const calls = stsMock.commandCalls(AssumeRoleCommand).map((c) => c.args[0].input);
    expect(calls.map((c) => [c.RoleArn, c.ExternalId])).toEqual([
      [CELL_ROLE, 'ext-1'],
      [CELL_ROLE, undefined],
      [TENANT_ROLE, 'ext-1'],
      [TENANT_ROLE, undefined],
    ]);
    for (const call of calls) {
      expect(call.DurationSeconds).toBe(900);
      expect(call.RoleSessionName).toBe('auth0-op-1'); // M23: made STS-safe
      expect(call.Policy).toBe(PROBE_SESSION_POLICY);
    }
    expect(JSON.parse(PROBE_SESSION_POLICY).Statement).toEqual([{ Effect: 'Deny', Action: '*', Resource: '*' }]);
  });

  test('without an external id, probes each half once and omits ExternalId', async () => {
    stsMock.on(AssumeRoleCommand).resolves({});
    const refusals = await probe({ accountId: '111111111111', operatorId: 'op-1' });
    expect(refusals).toEqual([]);
    const calls = stsMock.commandCalls(AssumeRoleCommand).map((c) => c.args[0].input);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.ExternalId).toBeUndefined();
    }
  });

  test('reports each half that refuses the external id with the STS error, skips its negative check, and still probes the other', async () => {
    stsMock.on(AssumeRoleCommand).callsFake((input) =>
      input.RoleArn === CELL_ROLE || input.ExternalId === undefined ? Promise.reject(accessDenied()) : Promise.resolve({}),
    );

    const refusals = await probe({ accountId: '222222222222', externalId: 'ext-1', operatorId: 'op-1' });

    expect(refusals).toEqual([
      {
        kind: 'cell',
        roleArn: CELL_ROLE,
        reason: 'could not be assumed (AccessDenied: User is not authorized to perform: sts:AssumeRole)',
      },
    ]);
    // cell: positive only (refused); tenant: positive + negative.
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(3);
  });

  test('a half that admits the call WITHOUT the external id is a refusal: the pair does not enforce it (ADR-030)', async () => {
    // Cell role enforces; tenant role was installed without an externalId
    // and admits both calls.
    stsMock.on(AssumeRoleCommand).callsFake((input) =>
      input.RoleArn === CELL_ROLE && input.ExternalId === undefined ? Promise.reject(accessDenied()) : Promise.resolve({}),
    );

    const refusals = await probe({ accountId: '222222222222', externalId: 'ext-1', operatorId: 'op-1' });

    expect(refusals).toEqual([
      {
        kind: 'tenant',
        roleArn: TENANT_ROLE,
        reason: 'does not require the external id (its trust policy has no sts:ExternalId condition; redeploy the pair with externalId)',
      },
    ]);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(4);
  });

  test('an STS failure that is not AccessDenied is HandshakeUnavailableError, not a refusal', async () => {
    const throttled = new Error('Rate exceeded');
    throttled.name = 'Throttling';
    stsMock.on(AssumeRoleCommand).rejects(throttled);

    await expect(probe({ accountId: '222222222222', externalId: 'ext-1', operatorId: 'op-1' })).rejects.toMatchObject({
      name: 'HandshakeUnavailableError',
      roleArn: CELL_ROLE,
      message: `Handshake probe of ${CELL_ROLE} failed: Throttling: Rate exceeded`,
    });
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });
});

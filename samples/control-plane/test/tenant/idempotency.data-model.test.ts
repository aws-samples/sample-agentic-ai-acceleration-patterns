// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createHash } from 'node:crypto';
import {
  IdempotencyDataModel,
  IdempotencyRecord,
  createDeploymentRequestHash,
  idempotencyKey,
} from '../../src/tenant/idempotency.data-model';

describe('idempotencyKey', () => {
  test('builds the IDEMPOTENCY#<token> / META composite key', () => {
    expect(idempotencyKey('tok-1')).toEqual({ PK: 'IDEMPOTENCY#tok-1', SK: 'META' });
  });
});

describe('createDeploymentRequestHash (ADR-017, §7.3)', () => {
  const base = {
    tenantId: '01TENANT',
    applicationId: 'app-x',
    adminEmail: 'success@simulator.amazonses.com',
  };

  test('is deterministic for identical parameters', () => {
    expect(createDeploymentRequestHash(base)).toBe(createDeploymentRequestHash({ ...base }));
  });

  test('covers tenantId, applicationId, adminEmail and accountId', () => {
    const hash = createDeploymentRequestHash(base);
    expect(createDeploymentRequestHash({ ...base, tenantId: '01OTHER' })).not.toBe(hash);
    expect(createDeploymentRequestHash({ ...base, applicationId: 'app-y' })).not.toBe(hash);
    expect(
      createDeploymentRequestHash({ ...base, adminEmail: 'success+2@simulator.amazonses.com' }),
    ).not.toBe(hash);
    expect(createDeploymentRequestHash({ ...base, accountId: '111111111111' })).not.toBe(hash);
  });

  test('an absent and an empty parameter map hash exactly as a request did before parameters existed (§7.3)', () => {
    // The pre-change hash: SHA-256 of the four-element positional array.
    const preChange = createHash('sha256')
      .update(JSON.stringify([base.tenantId, base.applicationId, base.adminEmail, null]), 'utf8')
      .digest('hex');
    expect(createDeploymentRequestHash(base)).toBe(preChange);
    expect(createDeploymentRequestHash({ ...base, parameters: {} })).toBe(preChange);
  });

  test('parameter values are part of the identity, name-sorted so key order does not matter (ADR-039)', () => {
    const hash = createDeploymentRequestHash({ ...base, parameters: { A: '1', B: '2' } });
    expect(createDeploymentRequestHash({ ...base, parameters: { B: '2', A: '1' } })).toBe(hash);
    expect(createDeploymentRequestHash({ ...base, parameters: { A: '1', B: '3' } })).not.toBe(hash);
    expect(createDeploymentRequestHash({ ...base, parameters: { A: '1' } })).not.toBe(hash);
    expect(createDeploymentRequestHash(base)).not.toBe(hash);
  });

  test('two target accounts with otherwise identical parameters hash differently', () => {
    expect(createDeploymentRequestHash({ ...base, accountId: '111111111111' })).not.toBe(
      createDeploymentRequestHash({ ...base, accountId: '222222222222' }),
    );
  });

  test('an absent accountId hashes differently from an empty string', () => {
    expect(createDeploymentRequestHash(base)).not.toBe(
      createDeploymentRequestHash({ ...base, accountId: '' }),
    );
  });

  test('positional form: shifting a value between fields changes the hash', () => {
    expect(createDeploymentRequestHash({ ...base, tenantId: 'a', applicationId: 'b' })).not.toBe(
      createDeploymentRequestHash({ ...base, tenantId: 'b', applicationId: 'a' }),
    );
  });
});

describe('IdempotencyDataModel', () => {
  const model = new IdempotencyDataModel();
  const record: IdempotencyRecord = {
    clientToken: 'tok-1',
    tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    applicationId: 'app-x',
    requestHash: 'abc123',
    createdAt: new Date('2026-09-07T12:00:00.000Z'),
    expiresAt: 1757203200,
  };

  test('toItem produces the keyed item with an epoch-seconds TTL attribute and no index keys', () => {
    expect(model.toItem(record)).toEqual({
      PK: 'IDEMPOTENCY#tok-1',
      SK: 'META',
      clientToken: 'tok-1',
      tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      applicationId: 'app-x',
      requestHash: 'abc123',
      createdAt: '2026-09-07T12:00:00.000Z',
      expiresAt: 1757203200,
    });
  });

  test('round-trips through toItem/fromItem', () => {
    expect(model.fromItem(model.toItem(record))).toEqual(record);
  });
});

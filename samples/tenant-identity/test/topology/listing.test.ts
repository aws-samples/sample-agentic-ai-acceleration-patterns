// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ListUsersCommand, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import 'aws-sdk-client-mock-jest';
import { AnyMock, cognitoError, cognitoMock } from './helpers';
import { InvalidInputError } from '../../src/shared/errors';
import { decodeScopeList } from '../../src/shared/scopes';
import { listUsersInGroup, listUsersInPool } from '../../src/topology/listing';

/**
 * spec §5.1 ListUsers: a caller-supplied nextToken that Cognito rejects is
 * the caller's input, a 400 with fixed text (N-4), never a 500.
 */

const POOL = 'eu-central-1_pool';
const ADMIN_GROUP = 'admin-t1';
const TENANT_GROUP = 't-t1';

let cognito: AnyMock;
beforeEach(() => {
  cognito = cognitoMock();
});

describe('listUsersInPool (pool-per-tenant)', () => {
  it('passes the caller token as PaginationToken and returns the next one', async () => {
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'u1' }], PaginationToken: 'p3' });
    const page = await listUsersInPool(cognito, POOL, ADMIN_GROUP, decodeScopeList, 'p2');
    expect(cognito.commandCalls(ListUsersCommand)[0].args[0].input.PaginationToken).toBe('p2');
    expect(page.nextToken).toBe('p3');
  });

  it('a rejected caller nextToken -> InvalidInputError("Invalid nextToken")', async () => {
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
    cognito.on(ListUsersCommand).rejects(cognitoError('InvalidParameterException', 'cognito detail'));
    await expect(listUsersInPool(cognito, POOL, ADMIN_GROUP, decodeScopeList, 'garbage')).rejects.toEqual(
      new InvalidInputError('Invalid nextToken'),
    );
  });

  it('InvalidParameterException without a caller token stays a server fault', async () => {
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
    cognito.on(ListUsersCommand).rejects(cognitoError('InvalidParameterException'));
    await expect(listUsersInPool(cognito, POOL, ADMIN_GROUP, decodeScopeList)).rejects.not.toBeInstanceOf(InvalidInputError);
  });
});

describe('listing carries the custom:scopes grant (ADR-0036)', () => {
  it('each view reads custom:scopes through the given grant reader; absent stays undefined', async () => {
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
    cognito.on(ListUsersCommand).resolves({
      Users: [
        { Username: 'cut', Attributes: [{ Name: 'custom:scopes', Value: 'sample/read' }] },
        { Username: 'all' },
      ],
    });
    const page = await listUsersInPool(cognito, POOL, ADMIN_GROUP, decodeScopeList);
    expect(page.items.map((u) => u.grantedScopes)).toEqual([['sample/read'], undefined]);
  });
});

describe('listUsersInGroup (shared-pool*)', () => {
  it('passes the caller token as NextToken on the tenant group read', async () => {
    cognito.on(ListUsersInGroupCommand).callsFake((input: AnyMock) =>
      input.GroupName === ADMIN_GROUP ? { Users: [] } : { Users: [{ Username: 'u1' }], NextToken: 'n3' },
    );
    const page = await listUsersInGroup(cognito, POOL, TENANT_GROUP, ADMIN_GROUP, decodeScopeList, 'n2');
    const tenantCall = cognito
      .commandCalls(ListUsersInGroupCommand)
      .find((c: AnyMock) => c.args[0].input.GroupName === TENANT_GROUP);
    expect(tenantCall.args[0].input.NextToken).toBe('n2');
    expect(page.nextToken).toBe('n3');
  });

  it('a rejected caller nextToken -> InvalidInputError("Invalid nextToken")', async () => {
    cognito.on(ListUsersInGroupCommand).callsFake((input: AnyMock) => {
      if (input.GroupName === ADMIN_GROUP) {
        return { Users: [] };
      }
      throw cognitoError('InvalidParameterException', 'cognito detail');
    });
    await expect(listUsersInGroup(cognito, POOL, TENANT_GROUP, ADMIN_GROUP, decodeScopeList, 'garbage')).rejects.toEqual(
      new InvalidInputError('Invalid nextToken'),
    );
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { cognitoError } from './helpers';
import { InvalidInputError, NotFoundError } from '../../src/shared/errors';
import { adminPasswordSignIn, emailFilter, findUserByEmail } from '../../src/topology/cognito-users';

describe('emailFilter (ListUsers attribute filter)', () => {
  it('quotes a plain address', () => {
    expect(emailFilter('a@example.com')).toBe('email = "a@example.com"');
  });

  it('escapes a double quote', () => {
    expect(emailFilter('a"b@example.com')).toBe('email = "a\\"b@example.com"');
  });

  it('escapes a backslash before the quote, so the value cannot end early', () => {
    // a\"b -> a\\\"b : the backslash and the quote are both escaped.
    expect(emailFilter('a\\"b@example.com')).toBe('email = "a\\\\\\"b@example.com"');
  });
});

// Loosely-typed Cognito mock: the pinned @smithy/types diverges from the
// SDK's resolved version, so the command generics do not unify. `any` at the
// mock boundary keeps the suite readable (see test/topology/helpers.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cognitoMock: any = mockClient(CognitoIdentityProviderClient as any);

describe('findUserByEmail verified-only (R-17 (T-27), T-27)', () => {
  beforeEach(() => cognitoMock.reset());

  const client = cognitoMock as unknown as CognitoIdentityProviderClient;

  it('returns a user whose email_verified is "true"', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: 'email_verified', Value: 'true' }] }],
    });
    const user = await findUserByEmail(client, 'pool', 'u1@example.com');
    expect(user?.Username).toBe('u1');
  });

  it('ignores a user whose email_verified is "false" (self-written, unconfirmed)', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: 'email_verified', Value: 'false' }] }],
    });
    expect(await findUserByEmail(client, 'pool', 'u1@example.com')).toBeUndefined();
  });

  it('ignores a user with no email_verified attribute', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@example.com' }] }],
    });
    expect(await findUserByEmail(client, 'pool', 'u1@example.com')).toBeUndefined();
  });

  it('returns undefined when no user matches', async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
    expect(await findUserByEmail(client, 'pool', 'nobody@example.com')).toBeUndefined();
  });
});

describe('adminPasswordSignIn password rejection (ADR-0006, N-4)', () => {
  beforeEach(() => cognitoMock.reset());

  const client = cognitoMock as unknown as CognitoIdentityProviderClient;

  it.each(['InvalidPasswordException', 'InvalidParameterException'])(
    '%s from AdminSetUserPassword -> InvalidInputError with fixed text, never Cognito\'s message',
    async (name) => {
      cognitoMock.on(AdminSetUserPasswordCommand).rejects(cognitoError(name, 'Password did not conform with policy: secret detail'));
      const call = adminPasswordSignIn(client, 'pool', 'client', 'u1', 'weak');
      await expect(call).rejects.toBeInstanceOf(InvalidInputError);
      await expect(adminPasswordSignIn(client, 'pool', 'client', 'u1', 'weak')).rejects.toThrow('Password does not meet the pool policy');
      expect(cognitoMock.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
    },
  );

  it('UserNotFoundException from AdminSetUserPassword -> NotFoundError', async () => {
    cognitoMock.on(AdminSetUserPasswordCommand).rejects(cognitoError('UserNotFoundException'));
    await expect(adminPasswordSignIn(client, 'pool', 'client', 'u1', 'pw')).rejects.toBeInstanceOf(NotFoundError);
  });
});

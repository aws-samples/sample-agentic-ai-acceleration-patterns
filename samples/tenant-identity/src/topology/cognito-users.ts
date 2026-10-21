// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared Cognito user operations used by the three provisioners: temporary
 * password generation, user lookup by e-mail, group membership reads,
 * UserView mapping, and the test-aid auth flows (ADR-0006).
 *
 * Every function here maps Cognito errors to the sample's domain errors
 * (src/shared/errors.ts) so the messages that reach a caller never echo
 * Cognito's own text (N-4, N-6). The temporary password is generated here,
 * returned to the caller once, and never logged.
 */

import { randomInt } from 'crypto';
import {
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminListGroupsForUserCommand,
  AdminSetUserPasswordCommand,
  AttributeType,
  type CognitoIdentityProviderClient,
  GroupType,
  ListUsersCommand,
  UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { UserView } from './provisioner';
import { ConflictError, NotFoundError } from '../shared/errors';

/** Cognito exception names the provisioners branch on. */
export const COGNITO = {
  userNotFound: 'UserNotFoundException',
  usernameExists: 'UsernameExistsException',
  groupExists: 'GroupExistsException',
  resourceNotFound: 'ResourceNotFoundException',
  notAuthorized: 'NotAuthorizedException',
  userNotConfirmed: 'UserNotConfirmedException',
  userLambdaValidation: 'UserLambdaValidationException',
} as const;

/** True when a thrown value is the named Cognito exception. */
export function isCognitoError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*-_=+';
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

/**
 * A temporary password that satisfies Cognito's default policy (>= 8 chars,
 * upper, lower, digit, symbol). 20 chars with one of each guaranteed, the
 * rest from the full set, shuffled. crypto.randomInt is the entropy source;
 * the value is returned to the caller once and MUST NOT be logged.
 */
export function generateTemporaryPassword(): string {
  const chars = [
    UPPER[randomInt(UPPER.length)],
    LOWER[randomInt(LOWER.length)],
    DIGIT[randomInt(DIGIT.length)],
    SYMBOL[randomInt(SYMBOL.length)],
  ];
  while (chars.length < 20) {
    chars.push(ALL[randomInt(ALL.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** A Cognito attribute filter escapes embedded double quotes (ListUsers). */
export function emailFilter(email: string): string {
  return `email = "${email.replace(/"/g, '\\"')}"`;
}

/** The value of a user attribute, or undefined. */
export function attr(attributes: AttributeType[] | undefined, name: string): string | undefined {
  return attributes?.find((a) => a.Name === name)?.Value;
}

/** Maps a Cognito user to the sample's UserView. `admin` is computed by the caller. */
export function toUserView(user: UserType, admin: boolean): UserView {
  return {
    username: user.Username ?? '',
    email: attr(user.Attributes, 'email') ?? '',
    admin,
    status: user.UserStatus ?? 'UNKNOWN',
    createdAt: user.UserCreateDate ?? new Date(0),
  };
}

/** Normalises the AdminGetUser response (which differs from ListUsers) to a UserView. */
export function adminGetUserToView(
  username: string,
  attributes: AttributeType[] | undefined,
  status: string | undefined,
  createdAt: Date | undefined,
  admin: boolean,
): UserView {
  return {
    username,
    email: attr(attributes, 'email') ?? '',
    admin,
    status: status ?? 'UNKNOWN',
    createdAt: createdAt ?? new Date(0),
  };
}

/** Finds a user in the pool by e-mail (ListUsers filter), or undefined. */
export async function findUserByEmail(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
): Promise<UserType | undefined> {
  const result = await cognito.send(
    new ListUsersCommand({ UserPoolId: userPoolId, Filter: emailFilter(email), Limit: 1 }),
  );
  return result.Users?.[0];
}

/** All group names a user belongs to (paginated). */
export async function listGroupsForUser(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  username: string,
): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const result = await cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username, NextToken: nextToken }),
    );
    for (const group of (result.Groups ?? []) as GroupType[]) {
      if (group.GroupName !== undefined) {
        names.push(group.GroupName);
      }
    }
    nextToken = result.NextToken;
  } while (nextToken !== undefined);
  return names;
}

/** AdminGetUser, mapping UserNotFoundException to NotFoundError (R-12). */
export async function adminGetUser(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  username: string,
): Promise<{ attributes: AttributeType[] | undefined; status: string | undefined; createdAt: Date | undefined }> {
  try {
    const result = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
    return { attributes: result.UserAttributes, status: result.UserStatus, createdAt: result.UserCreateDate };
  } catch (error) {
    if (isCognitoError(error, COGNITO.userNotFound)) {
      throw new NotFoundError('User not found in tenant');
    }
    throw error;
  }
}

interface AuthResultShape {
  AccessToken?: string;
  IdToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
}

/**
 * The test-aid sign-in flow (ADR-0006): set a permanent password, then
 * ADMIN_USER_PASSWORD_AUTH. Auth failures and trigger refusals map to
 * ConflictError with fixed text, never Cognito's message (N-4).
 */
export async function adminPasswordSignIn(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  appClientId: string,
  username: string,
  password: string,
): Promise<{ accessToken: string; idToken: string; refreshToken?: string; expiresIn: number }> {
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }),
  );
  try {
    const result = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: userPoolId,
        ClientId: appClientId,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }),
    );
    return readAuthResult(result.AuthenticationResult);
  } catch (error) {
    throw mapAuthError(error);
  }
}

/** The test-aid refresh flow (ADR-0006): REFRESH_TOKEN_AUTH. */
export async function adminRefresh(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  appClientId: string,
  refreshToken: string,
): Promise<{ accessToken: string; idToken: string; refreshToken?: string; expiresIn: number }> {
  try {
    const result = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: userPoolId,
        ClientId: appClientId,
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    );
    return readAuthResult(result.AuthenticationResult);
  } catch (error) {
    throw mapAuthError(error);
  }
}

function readAuthResult(result: AuthResultShape | undefined): {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expiresIn: number;
} {
  if (result?.AccessToken === undefined || result.IdToken === undefined) {
    // No tokens and no exception: the user is in a challenge state we do not
    // drive (MFA, NEW_PASSWORD_REQUIRED). Treat as a refusal, fixed text.
    throw new ConflictError('Token issuance refused');
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn ?? 0,
  };
}

/**
 * Maps a Cognito auth failure to ConflictError with fixed text. A trigger
 * refusal (UserLambdaValidationException, raised when the pre-token trigger
 * throws for a DELETING/absent tenant) and an auth failure
 * (NotAuthorizedException, UserNotConfirmedException) both become
 * ConflictError. The message never echoes Cognito's (N-4, P-2).
 */
export function mapAuthError(error: unknown): Error {
  if (
    isCognitoError(error, COGNITO.userLambdaValidation) ||
    isCognitoError(error, COGNITO.notAuthorized) ||
    isCognitoError(error, COGNITO.userNotConfirmed)
  ) {
    return new ConflictError('Token issuance refused');
  }
  if (isCognitoError(error, COGNITO.userNotFound)) {
    return new NotFoundError('User not found in tenant');
  }
  return error instanceof Error ? error : new Error('Token issuance failed');
}

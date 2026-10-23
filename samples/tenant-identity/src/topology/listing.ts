// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * User listing for the three topologies (spec §5.1 ListUsers). Cognito
 * pagination tokens pass straight through (PaginationToken for ListUsers,
 * NextToken for ListUsersInGroup / AdminListGroupsForUser); the sample never
 * re-encodes them. A token Cognito rejects (InvalidParameterException) is the
 * caller's input: InvalidInputError (400) with fixed text, never Cognito's
 * message (N-4), as the registry does for ListTenants. The `admin` flag is
 * computed per page from a single ListUsersInGroup on `admin-<id>`, which is
 * cheaper than one AdminListGroupsForUser per user (documented choice).
 */

import {
  type CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { COGNITO, isCognitoError, toUserView } from './cognito-users';
import type { UserView } from './provisioner';
import { InvalidInputError } from '../shared/errors';
import type { Page } from '../shared/registry';

/** Cognito's maximum page size for the user-listing APIs. */
const PAGE_LIMIT = 60;

/** The set of usernames in a group, across one page is not enough: read all. */
async function adminUsernames(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  adminGroup: string,
): Promise<Set<string>> {
  const usernames = new Set<string>();
  let token: string | undefined;
  do {
    const result = await cognito.send(
      new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: adminGroup, Limit: PAGE_LIMIT, NextToken: token }),
    );
    for (const user of (result.Users ?? []) as UserType[]) {
      if (user.Username !== undefined) {
        usernames.add(user.Username);
      }
    }
    token = result.NextToken;
  } while (token !== undefined);
  return usernames;
}

/**
 * Runs the page read that carries the caller's token. Only when the caller
 * supplied one is InvalidParameterException theirs to fix; without a token it
 * stays a server fault.
 */
async function withCallerToken<T>(nextToken: string | undefined, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (nextToken !== undefined && isCognitoError(error, COGNITO.invalidParameter)) {
      throw new InvalidInputError('Invalid nextToken');
    }
    throw error;
  }
}

/** pool-per-tenant: ListUsers on the tenant's own pool. */
export async function listUsersInPool(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  adminGroup: string,
  nextToken?: string,
): Promise<Page<UserView>> {
  const admins = await adminUsernames(cognito, userPoolId, adminGroup);
  const result = await withCallerToken(nextToken, () =>
    cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Limit: PAGE_LIMIT, PaginationToken: nextToken })),
  );
  const items = ((result.Users ?? []) as UserType[]).map((u) => toUserView(u, admins.has(u.Username ?? '')));
  return { items, nextToken: result.PaginationToken };
}

/** shared-pool*: ListUsersInGroup on `t-<id>`, admin computed per page. */
export async function listUsersInGroup(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  tenantGroup: string,
  adminGroup: string,
  nextToken?: string,
): Promise<Page<UserView>> {
  const admins = await adminUsernames(cognito, userPoolId, adminGroup);
  const result = await withCallerToken(nextToken, () =>
    cognito.send(
      new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: tenantGroup, Limit: PAGE_LIMIT, NextToken: nextToken }),
    ),
  );
  const items = ((result.Users ?? []) as UserType[]).map((u) => toUserView(u, admins.has(u.Username ?? '')));
  return { items, nextToken: result.NextToken };
}

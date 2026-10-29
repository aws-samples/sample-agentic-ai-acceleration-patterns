// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * shared-pool-multi-tenant provisioner (spec §7.3). One pool; tenants are
 * groups `t-<id>`, and a user may belong to several. The token's `tenants`
 * claim is built by the trigger from the user's `t-*` groups. Membership
 * operations are first-class here: a user joins or leaves a tenant by group
 * membership, and is deleted only when their last `t-*` group is removed
 * (P-4). `admin-<id>` is the per-tenant admin role (ADR-0015).
 */

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminRemoveUserFromGroupCommand,
  type CognitoIdentityProviderClient,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListUsersInGroupCommand,
  UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  adminGetUser,
  adminGetUserToView,
  adminPasswordSignIn,
  adminRefresh,
  attr,
  COGNITO,
  findUserByEmail,
  generateTemporaryPassword,
  isCognitoError,
  listGroupsForUser,
  writeScopesAttribute,
} from './cognito-users';
import type { ProvisionerDeps } from './index';
import { listUsersInGroup } from './listing';
import type { NewUserResult, Provisioner, ProvisionedTenant, TokenSet, UserView } from './provisioner';
import {
  adminGroupName,
  SCOPES_ATTRIBUTE,
  TENANT_GROUP_PATTERN,
  tenantGroupName,
  type Topology,
} from '../shared/constants';
import { ConflictError, NotFoundError } from '../shared/errors';
import { Page } from '../shared/registry';
import type { TenantRecord } from '../shared/registry';
import { decodeScopeMapEntry, encodeScopeMap } from '../shared/scopes';

/**
 * ADR-0036: one person belongs to several tenants here, so `custom:scopes`
 * is a JSON object keyed by tenant id; this reads the one key a view is for.
 */
function grantsFor(tenantId: string): (value: string | undefined) => readonly string[] | undefined {
  return (value) => decodeScopeMapEntry(value, tenantId);
}

const PAGE_LIMIT = 60;

export class SharedPoolMultiTenantProvisioner implements Provisioner {
  readonly topology: Topology = 'shared-pool-multi-tenant';

  private readonly cognito: CognitoIdentityProviderClient;
  private readonly userPoolId: string;
  private readonly appClientId: string;

  constructor(deps: ProvisionerDeps) {
    if (deps.sharedPool === undefined) {
      throw new Error('shared-pool-multi-tenant requires sharedPool in deps');
    }
    this.cognito = deps.cognito;
    this.userPoolId = deps.sharedPool.userPoolId;
    this.appClientId = deps.sharedPool.appClientId;
  }

  async provisionTenant(tenantId: string, name: string): Promise<ProvisionedTenant> {
    await this.createGroupIdempotent(tenantGroupName(tenantId), name);
    await this.createGroupIdempotent(adminGroupName(tenantId));
    return { groupName: tenantGroupName(tenantId) };
  }

  async deprovisionTenant(tenant: TenantRecord): Promise<void> {
    const group = tenantGroupName(tenant.tenantId);
    for (const username of await this.usersInGroup(group)) {
      const tenantGroups = (await listGroupsForUser(this.cognito, this.userPoolId, username)).filter((g) =>
        TENANT_GROUP_PATTERN.test(g),
      );
      if (tenantGroups.length <= 1) {
        // This tenant is the user's only tenant: delete the user.
        await this.deleteUserRaw(username);
      } else {
        await this.removeFromGroup(username, group);
        await this.removeFromGroup(username, adminGroupName(tenant.tenantId));
      }
    }
    await this.deleteGroupIdempotent(group);
    await this.deleteGroupIdempotent(adminGroupName(tenant.tenantId));
  }

  async assertEmailAvailable(_email: string): Promise<void> {
    // No-op: an existing e-mail user is reused for a new tenant (spec §7.3).
  }

  async createUser(tenant: TenantRecord, email: string, admin: boolean): Promise<NewUserResult> {
    // Reuse an existing e-mail user (no temporary password), else create one.
    const existing = await findUserByEmail(this.cognito, this.userPoolId, email);
    let username: string;
    let temporaryPassword: string | undefined;
    let created: UserType | undefined;
    if (existing !== undefined) {
      username = existing.Username ?? email;
    } else {
      temporaryPassword = generateTemporaryPassword();
      let result;
      try {
        result = await this.cognito.send(
          new AdminCreateUserCommand({
            UserPoolId: this.userPoolId,
            Username: email,
            TemporaryPassword: temporaryPassword,
            MessageAction: 'SUPPRESS',
            UserAttributes: [
              { Name: 'email', Value: email },
              { Name: 'email_verified', Value: 'true' },
            ],
          }),
        );
      } catch (error) {
        // An unverified user holds the address (findUserByEmail ignores them,
        // R-17): a conflict, never a membership for the squatter.
        if (isCognitoError(error, COGNITO.usernameExists)) {
          throw new ConflictError('E-mail already exists');
        }
        throw error;
      }
      created = result.User;
      username = created?.Username ?? email;
    }
    await this.addToGroup(username, tenantGroupName(tenant.tenantId));
    if (admin) {
      await this.addToGroup(username, adminGroupName(tenant.tenantId));
    }
    // A reused user may already be an admin of this tenant (admin=false does
    // not remove them), so report the actual `admin-<id>` membership, not the
    // input flag. A new user holds only the groups just added.
    const isAdmin =
      existing !== undefined
        ? (await listGroupsForUser(this.cognito, this.userPoolId, username)).includes(adminGroupName(tenant.tenantId))
        : admin;
    const source = created ?? existing;
    return {
      user: adminGetUserToView(
        username,
        source?.Attributes,
        source?.UserStatus,
        source?.UserCreateDate,
        isAdmin,
        grantsFor(tenant.tenantId),
      ),
      temporaryPassword,
    };
  }

  async assertMember(tenant: TenantRecord, username: string): Promise<void> {
    // R-12: the user must be in group t-<tenantId>.
    const groups = await this.safeListGroups(username);
    if (!groups.includes(tenantGroupName(tenant.tenantId))) {
      throw new NotFoundError('User not found in tenant');
    }
  }

  async getUser(tenant: TenantRecord, username: string): Promise<UserView> {
    const groups = await this.safeListGroups(username);
    if (!groups.includes(tenantGroupName(tenant.tenantId))) {
      throw new NotFoundError('User not found in tenant');
    }
    const user = await adminGetUser(this.cognito, this.userPoolId, username);
    return adminGetUserToView(
      user.username,
      user.attributes,
      user.status,
      user.createdAt,
      groups.includes(adminGroupName(tenant.tenantId)),
      grantsFor(tenant.tenantId),
    );
  }

  async listUsers(tenant: TenantRecord, nextToken?: string): Promise<Page<UserView>> {
    return listUsersInGroup(
      this.cognito,
      this.userPoolId,
      tenantGroupName(tenant.tenantId),
      adminGroupName(tenant.tenantId),
      grantsFor(tenant.tenantId),
      nextToken,
    );
  }

  async setScopes(tenant: TenantRecord, username: string, scopes: readonly string[]): Promise<UserView> {
    // ADR-0036: replace this tenant's key in the JSON object and leave the
    // user's other tenants' grants as they are. Read-modify-write on one
    // attribute: two admins of different tenants cutting the same person at
    // the same instant can lose one write; the loser's cut is re-applied by
    // repeating it (the attribute shows what is held). R-12 first.
    await this.assertMember(tenant, username);
    const current = await adminGetUser(this.cognito, this.userPoolId, username);
    const encoded = encodeScopeMap(attr(current.attributes, SCOPES_ATTRIBUTE), tenant.tenantId, scopes);
    await writeScopesAttribute(this.cognito, this.userPoolId, username, encoded);
    return this.getUser(tenant, username);
  }

  async setAdmin(tenant: TenantRecord, username: string, admin: boolean): Promise<UserView> {
    await this.assertMember(tenant, username);
    const group = adminGroupName(tenant.tenantId);
    if (admin) {
      await this.addToGroup(username, group);
    } else {
      await this.removeFromGroup(username, group);
    }
    return this.getUser(tenant, username);
  }

  async deleteUser(tenant: TenantRecord, username: string): Promise<void> {
    await this.assertMember(tenant, username);
    await this.removeFromGroup(username, tenantGroupName(tenant.tenantId));
    await this.removeFromGroup(username, adminGroupName(tenant.tenantId));
    await this.deleteIfNoTenantGroups(username);
  }

  async createMembership(tenant: TenantRecord, username: string): Promise<void> {
    // The user must already exist (NotFoundError if not); idempotent add.
    await adminGetUser(this.cognito, this.userPoolId, username);
    await this.addToGroup(username, tenantGroupName(tenant.tenantId));
  }

  async deleteMembership(tenant: TenantRecord, username: string): Promise<void> {
    await this.assertMember(tenant, username);
    const tenantGroups = (await listGroupsForUser(this.cognito, this.userPoolId, username)).filter((g) =>
      TENANT_GROUP_PATTERN.test(g),
    );
    if (tenantGroups.length <= 1) {
      // Removing the user's only tenant: refuse (use DeleteUser). Spec §5.1.
      throw new ConflictError('Cannot remove the user from their last tenant');
    }
    await this.removeFromGroup(username, tenantGroupName(tenant.tenantId));
    await this.removeFromGroup(username, adminGroupName(tenant.tenantId));
    // Race: a concurrent DeleteMembership/deleteUser on the user's other
    // tenant may have passed its own "not the last tenant" check at the same
    // time, leaving the user in no `t-*` group. Re-list after the removal and
    // delete the orphan, exactly as deleteUser does (P-4, spec §7.3).
    await this.deleteIfNoTenantGroups(username);
  }

  async issueToken(tenant: TenantRecord, username: string, password: string): Promise<TokenSet> {
    await this.assertMember(tenant, username);
    return adminPasswordSignIn(this.cognito, this.userPoolId, this.appClientId, username, password);
  }

  async refreshToken(tenant: TenantRecord, username: string, refreshToken: string): Promise<TokenSet> {
    await this.assertMember(tenant, username);
    return adminRefresh(this.cognito, this.userPoolId, this.appClientId, refreshToken);
  }

  /** Deletes the Cognito user when no `t-*` group remains (P-4). */
  private async deleteIfNoTenantGroups(username: string): Promise<void> {
    const remaining = (await this.safeListGroups(username)).filter((g) => TENANT_GROUP_PATTERN.test(g));
    if (remaining.length === 0) {
      await this.deleteUserRaw(username);
    }
  }

  private async safeListGroups(username: string): Promise<string[]> {
    try {
      return await listGroupsForUser(this.cognito, this.userPoolId, username);
    } catch (error) {
      if (isCognitoError(error, COGNITO.userNotFound)) {
        return [];
      }
      throw error;
    }
  }

  private async createGroupIdempotent(groupName: string, description?: string): Promise<void> {
    try {
      await this.cognito.send(
        new CreateGroupCommand({ UserPoolId: this.userPoolId, GroupName: groupName, Description: description }),
      );
    } catch (error) {
      if (!isCognitoError(error, COGNITO.groupExists)) {
        throw error;
      }
    }
  }

  private async deleteGroupIdempotent(groupName: string): Promise<void> {
    try {
      await this.cognito.send(new DeleteGroupCommand({ UserPoolId: this.userPoolId, GroupName: groupName }));
    } catch (error) {
      if (!isCognitoError(error, COGNITO.resourceNotFound)) {
        throw error;
      }
    }
  }

  private async addToGroup(username: string, groupName: string): Promise<void> {
    await this.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: groupName }));
  }

  private async removeFromGroup(username: string, groupName: string): Promise<void> {
    try {
      await this.cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: groupName }));
    } catch (error) {
      if (!isCognitoError(error, COGNITO.userNotFound) && !isCognitoError(error, COGNITO.resourceNotFound)) {
        throw error;
      }
    }
  }

  private async deleteUserRaw(username: string): Promise<void> {
    try {
      await this.cognito.send(new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: username }));
    } catch (error) {
      if (!isCognitoError(error, COGNITO.userNotFound)) {
        throw error;
      }
    }
  }

  private async usersInGroup(groupName: string): Promise<string[]> {
    const names: string[] = [];
    let token: string | undefined;
    do {
      const result = await this.cognito.send(
        new ListUsersInGroupCommand({ UserPoolId: this.userPoolId, GroupName: groupName, Limit: PAGE_LIMIT, NextToken: token }),
      );
      for (const user of (result.Users ?? []) as UserType[]) {
        if (user.Username !== undefined) {
          names.push(user.Username);
        }
      }
      token = result.NextToken;
    } while (token !== undefined);
    return names;
  }
}

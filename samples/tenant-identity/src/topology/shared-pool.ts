// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * shared-pool provisioner (spec §7.2). One pool for every tenant; the tenant
 * is an immutable custom attribute `custom:tenantId`. A person exists in at
 * most one tenant, because e-mail is the pool-unique username. Groups `t-<id>`
 * (for listing) and `admin-<id>` (the admin role) are created per tenant, but
 * the token's tenant claim comes from the attribute, not the group (P-3).
 * Membership operations have no meaning here (P-4).
 */

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminRemoveUserFromGroupCommand,
  type CognitoIdentityProviderClient,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  adminGetUser,
  type AdminUser,
  adminGetUserToView,
  adminPasswordSignIn,
  adminRefresh,
  attr,
  COGNITO,
  findUserByEmail,
  generateTemporaryPassword,
  isCognitoError,
  listGroupsForUser,
} from './cognito-users';
import type { ProvisionerDeps } from './index';
import { listUsersInGroup } from './listing';
import type { NewUserResult, Provisioner, ProvisionedTenant, TokenSet, UserView } from './provisioner';
import {
  adminGroupName,
  TENANT_ATTRIBUTE,
  tenantGroupName,
  type Topology,
} from '../shared/constants';
import { ConflictError, NotFoundError, UnsupportedInTopologyError } from '../shared/errors';
import { Page } from '../shared/registry';
import type { TenantRecord } from '../shared/registry';

const PAGE_LIMIT = 60;

export class SharedPoolProvisioner implements Provisioner {
  readonly topology: Topology = 'shared-pool';

  private readonly cognito: CognitoIdentityProviderClient;
  private readonly userPoolId: string;
  private readonly appClientId: string;

  constructor(deps: ProvisionerDeps) {
    if (deps.sharedPool === undefined) {
      throw new Error('shared-pool requires sharedPool in deps');
    }
    this.cognito = deps.cognito;
    this.userPoolId = deps.sharedPool.userPoolId;
    this.appClientId = deps.sharedPool.appClientId;
  }

  async provisionTenant(tenantId: string, _name: string): Promise<ProvisionedTenant> {
    await this.createGroupIdempotent(tenantGroupName(tenantId));
    await this.createGroupIdempotent(adminGroupName(tenantId));
    return {}; // No per-tenant pool; the attribute carries the tenant.
  }

  async deprovisionTenant(tenant: TenantRecord): Promise<void> {
    // Delete every user of the tenant, then the groups. Rely on the group,
    // and also scan ListUsers pages comparing custom:tenantId, to catch users
    // that are missing from the group (a partial earlier failure). Documented.
    const seen = new Set<string>();
    for (const username of await this.usersInGroup(tenantGroupName(tenant.tenantId))) {
      seen.add(username);
      await this.deleteUserRaw(username);
    }
    for (const username of await this.usersByAttribute(tenant.tenantId)) {
      if (!seen.has(username)) {
        await this.deleteUserRaw(username);
      }
    }
    await this.deleteGroupIdempotent(tenantGroupName(tenant.tenantId));
    await this.deleteGroupIdempotent(adminGroupName(tenant.tenantId));
  }

  async assertEmailAvailable(email: string): Promise<void> {
    // spec §5.1, §7.2: the e-mail is pool-unique, so a taken one would make
    // CreateTenant's admin step 409 after the tenant is ACTIVE. Checked
    // before the registry write; createUser still re-checks (and catches
    // UsernameExists for unverified holders, R-17), so a race stays a 409.
    const existing = await findUserByEmail(this.cognito, this.userPoolId, email);
    if (existing !== undefined) {
      throw new ConflictError('E-mail already exists');
    }
  }

  async createUser(tenant: TenantRecord, email: string, admin: boolean): Promise<NewUserResult> {
    // Any e-mail already present in the shared pool is a conflict: one person
    // is one tenant here, and moving tenants is delete + create (spec §7.2,
    // §5.3). Same-tenant re-create is also 409 (documented choice).
    await this.assertEmailAvailable(email);
    const temporaryPassword = generateTemporaryPassword();
    let created;
    try {
      created = await this.cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          TemporaryPassword: temporaryPassword,
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
            { Name: TENANT_ATTRIBUTE, Value: tenant.tenantId },
          ],
        }),
      );
    } catch (error) {
      // An unverified user holds the address (findUserByEmail ignores them,
      // R-17): still a conflict, never a 500.
      if (isCognitoError(error, COGNITO.usernameExists)) {
        throw new ConflictError('E-mail already exists');
      }
      throw error;
    }
    const username = created.User?.Username ?? email;
    await this.cognito.send(
      new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: tenantGroupName(tenant.tenantId) }),
    );
    if (admin) {
      await this.cognito.send(
        new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: adminGroupName(tenant.tenantId) }),
      );
    }
    return {
      user: adminGetUserToView(username, created.User?.Attributes, created.User?.UserStatus, created.User?.UserCreateDate, admin),
      temporaryPassword,
    };
  }

  async assertMember(tenant: TenantRecord, username: string): Promise<void> {
    await this.member(tenant, username);
  }

  async getUser(tenant: TenantRecord, username: string): Promise<UserView> {
    // One AdminGetUser serves both the R-12 check and the view.
    const user = await this.member(tenant, username);
    const groups = await listGroupsForUser(this.cognito, this.userPoolId, username);
    return adminGetUserToView(user.username, user.attributes, user.status, user.createdAt, groups.includes(adminGroupName(tenant.tenantId)));
  }

  async listUsers(tenant: TenantRecord, nextToken?: string): Promise<Page<UserView>> {
    return listUsersInGroup(this.cognito, this.userPoolId, tenantGroupName(tenant.tenantId), adminGroupName(tenant.tenantId), nextToken);
  }

  async setAdmin(tenant: TenantRecord, username: string, admin: boolean): Promise<UserView> {
    await this.assertMember(tenant, username);
    const group = adminGroupName(tenant.tenantId);
    if (admin) {
      await this.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: group }));
    } else {
      await this.cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: group }));
    }
    return this.getUser(tenant, username);
  }

  async deleteUser(tenant: TenantRecord, username: string): Promise<void> {
    await this.assertMember(tenant, username);
    await this.deleteUserRaw(username);
  }

  async createMembership(tenant: TenantRecord, _username: string): Promise<void> {
    throw new UnsupportedInTopologyError('createMembership', this.topology);
  }

  async deleteMembership(tenant: TenantRecord, _username: string): Promise<void> {
    throw new UnsupportedInTopologyError('deleteMembership', this.topology);
  }

  async issueToken(tenant: TenantRecord, username: string, password: string): Promise<TokenSet> {
    await this.assertMember(tenant, username);
    return adminPasswordSignIn(this.cognito, this.userPoolId, this.appClientId, username, password);
  }

  async refreshToken(tenant: TenantRecord, username: string, refreshToken: string): Promise<TokenSet> {
    await this.assertMember(tenant, username);
    return adminRefresh(this.cognito, this.userPoolId, this.appClientId, refreshToken);
  }

  /**
   * R-12: custom:tenantId must equal the path's tenant. Returns the
   * AdminGetUser result so callers need not read the user again.
   */
  private async member(tenant: TenantRecord, username: string): Promise<AdminUser> {
    const user = await adminGetUser(this.cognito, this.userPoolId, username);
    if (attr(user.attributes, TENANT_ATTRIBUTE) !== tenant.tenantId) {
      throw new NotFoundError('User not found in tenant');
    }
    return user;
  }

  private async createGroupIdempotent(groupName: string): Promise<void> {
    try {
      await this.cognito.send(new CreateGroupCommand({ UserPoolId: this.userPoolId, GroupName: groupName }));
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

  private async usersByAttribute(tenantId: string): Promise<string[]> {
    // ListUsers cannot filter on a custom attribute, so scan and compare.
    const names: string[] = [];
    let token: string | undefined;
    do {
      const result = await this.cognito.send(
        new ListUsersCommand({ UserPoolId: this.userPoolId, Limit: PAGE_LIMIT, PaginationToken: token }),
      );
      for (const user of (result.Users ?? []) as UserType[]) {
        if (user.Username !== undefined && attr(user.Attributes, TENANT_ATTRIBUTE) === tenantId) {
          names.push(user.Username);
        }
      }
      token = result.PaginationToken;
    } while (token !== undefined);
    return names;
  }
}

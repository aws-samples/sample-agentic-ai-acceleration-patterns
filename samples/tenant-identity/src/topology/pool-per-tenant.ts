// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * pool-per-tenant provisioner (spec §7.1). Each tenant owns a user pool: the
 * token's issuer *is* the tenant. Onboarding creates the pool, one app
 * client, the pre-token-generation trigger attachment, and the admin group;
 * offboarding deletes the pool, which removes every user and the issuer at
 * once (spec §1.3 "Offboarding"). Membership operations have no meaning here
 * and fail with UnsupportedInTopologyError (P-4).
 */

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminRemoveUserFromGroupCommand,
  type CognitoIdentityProviderClient,
  CreateGroupCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  adminGetUser,
  adminGetUserToView,
  adminPasswordSignIn,
  adminRefresh,
  COGNITO,
  generateTemporaryPassword,
  isCognitoError,
  listGroupsForUser,
  toUserView,
} from './cognito-users';
import type { ProvisionerDeps } from './index';
import { listUsersInPool } from './listing';
import type { NewUserResult, Provisioner, ProvisionedTenant, TokenSet, UserView } from './provisioner';
import {
  ACCESS_TOKEN_MINUTES,
  adminGroupName,
  ID_TOKEN_MINUTES,
  issuerFor,
  REFRESH_TOKEN_DAYS,
  SAMPLE_TAG_KEY,
  SAMPLE_TAG_VALUE,
  STACK_TAG_KEY,
  TENANT_POOL_NAME_PREFIX,
  TENANT_TAG_KEY,
  type Topology,
} from '../shared/constants';
import { ConflictError, UnsupportedInTopologyError } from '../shared/errors';
import { Page } from '../shared/registry';
import type { TenantRecord } from '../shared/registry';

export class PoolPerTenantProvisioner implements Provisioner {
  readonly topology: Topology = 'pool-per-tenant';

  private readonly cognito: CognitoIdentityProviderClient;
  private readonly region: string;
  /**
   * Only onboarding needs it, so it is checked there. The tenant-user
   * function never onboards and is not given it (P-8).
   */
  private readonly triggerFunctionArn: string | undefined;
  private readonly stackName: string | undefined;

  constructor(deps: ProvisionerDeps) {
    this.cognito = deps.cognito;
    this.region = deps.region;
    this.triggerFunctionArn = deps.triggerFunctionArn;
    this.stackName = deps.stackName;
  }

  async provisionTenant(tenantId: string, _name: string): Promise<ProvisionedTenant> {
    if (this.triggerFunctionArn === undefined) {
      // Deployment wiring bug: only the platform function onboards tenants.
      throw new Error('pool-per-tenant onboarding requires triggerFunctionArn');
    }
    if (this.stackName === undefined) {
      // The IAM conditions require the stack tag; a pool without it would be
      // created and then unreachable by this stack's roles.
      throw new Error('pool-per-tenant onboarding requires stackName');
    }
    const triggerArn = this.triggerFunctionArn;
    const pool = await this.cognito.send(
      new CreateUserPoolCommand({
        PoolName: `${TENANT_POOL_NAME_PREFIX}${tenantId}`,
        UserPoolTier: 'ESSENTIALS',
        UsernameAttributes: ['email'],
        AutoVerifiedAttributes: ['email'],
        // E-mail is immutable (R-17, T-27): the same schema as the stack's
        // shared pool. Required so AdminCreateUser always sets it.
        Schema: [{ Name: 'email', AttributeDataType: 'String', Required: true, Mutable: false }],
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        DeletionProtection: 'INACTIVE',
        AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }] },
        // Same rules as the stack-owned shared pool (identity.cdk.ts).
        Policies: {
          PasswordPolicy: {
            MinimumLength: 12,
            RequireLowercase: true,
            RequireUppercase: true,
            RequireNumbers: true,
            RequireSymbols: true,
            TemporaryPasswordValidityDays: 1,
          },
        },
        // The tenant tag is what the tenant-scoped role matches its session
        // tag against (ADR-0026); the tenant id is known before the pool.
        UserPoolTags: {
          [SAMPLE_TAG_KEY]: SAMPLE_TAG_VALUE,
          [STACK_TAG_KEY]: this.stackName,
          [TENANT_TAG_KEY]: tenantId,
        },
        LambdaConfig: {
          PreTokenGenerationConfig: { LambdaVersion: 'V2_0', LambdaArn: triggerArn },
        },
      }),
    );
    const userPoolId = pool.UserPool?.Id;
    if (userPoolId === undefined) {
      throw new Error('Cognito did not return a user pool id');
    }

    try {
      const client = await this.cognito.send(
        new CreateUserPoolClientCommand({
          UserPoolId: userPoolId,
          ClientName: 'tenant-identity',
          GenerateSecret: false,
          ExplicitAuthFlows: ['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
          AccessTokenValidity: ACCESS_TOKEN_MINUTES,
          IdTokenValidity: ID_TOKEN_MINUTES,
          RefreshTokenValidity: REFRESH_TOKEN_DAYS,
          TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
          EnableTokenRevocation: true,
          PreventUserExistenceErrors: 'ENABLED',
          ReadAttributes: ['email'],
          // No WriteAttributes: Cognito reads an empty list as "all standard
          // attributes". The guard against a user rewriting their e-mail
          // (R-17, T-27) is the pool's immutable `email` schema above.
        }),
      );
      const appClientId = client.UserPoolClient?.ClientId;
      if (appClientId === undefined) {
        throw new Error('Cognito did not return an app client id');
      }

      await this.cognito.send(
        new CreateGroupCommand({ UserPoolId: userPoolId, GroupName: adminGroupName(tenantId) }),
      );

      return { userPoolId, appClientId, issuer: issuerFor(this.region, userPoolId) };
    } catch (error) {
      // A later step failed: remove the half-built pool (best effort) and rethrow.
      await this.cognito.send(new DeleteUserPoolCommand({ UserPoolId: userPoolId })).catch(() => undefined);
      throw error;
    }
  }

  async deprovisionTenant(tenant: TenantRecord): Promise<void> {
    const userPoolId = tenant.userPoolId;
    if (userPoolId === undefined) {
      return; // Nothing was provisioned; idempotent.
    }
    try {
      await this.cognito.send(new DeleteUserPoolCommand({ UserPoolId: userPoolId }));
    } catch (error) {
      if (isCognitoError(error, COGNITO.resourceNotFound)) {
        return; // Already gone; idempotent (P-4).
      }
      throw error;
    }
  }

  async assertEmailAvailable(_email: string): Promise<void> {
    // No-op: a new tenant gets a new, empty pool, so every e-mail is free.
  }

  async createUser(tenant: TenantRecord, email: string, admin: boolean): Promise<NewUserResult> {
    const userPoolId = this.poolId(tenant);
    const temporaryPassword = generateTemporaryPassword();
    let created;
    try {
      created = await this.cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
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
      if (isCognitoError(error, COGNITO.usernameExists)) {
        throw new ConflictError('User already exists');
      }
      throw error;
    }
    const username = created.User?.Username ?? email;
    if (admin) {
      await this.cognito.send(
        new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: adminGroupName(tenant.tenantId) }),
      );
    }
    return {
      user: toUserView(created.User ?? { Username: username }, admin),
      temporaryPassword,
    };
  }

  async assertMember(tenant: TenantRecord, username: string): Promise<void> {
    // R-12: in pool-per-tenant, membership is existence in the tenant's pool.
    await adminGetUser(this.cognito, this.poolId(tenant), username);
  }

  async getUser(tenant: TenantRecord, username: string): Promise<UserView> {
    const userPoolId = this.poolId(tenant);
    const user = await adminGetUser(this.cognito, userPoolId, username);
    const groups = await listGroupsForUser(this.cognito, userPoolId, username);
    return adminGetUserToView(user.username, user.attributes, user.status, user.createdAt, groups.includes(adminGroupName(tenant.tenantId)));
  }

  async listUsers(tenant: TenantRecord, nextToken?: string): Promise<Page<UserView>> {
    const userPoolId = this.poolId(tenant);
    return listUsersInPool(this.cognito, userPoolId, adminGroupName(tenant.tenantId), nextToken);
  }

  async setAdmin(tenant: TenantRecord, username: string, admin: boolean): Promise<UserView> {
    await this.assertMember(tenant, username);
    const userPoolId = this.poolId(tenant);
    const group = adminGroupName(tenant.tenantId);
    if (admin) {
      await this.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: group }));
    } else {
      await this.cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: group }));
    }
    return this.getUser(tenant, username);
  }

  async deleteUser(tenant: TenantRecord, username: string): Promise<void> {
    await this.assertMember(tenant, username);
    await this.cognito.send(new AdminDeleteUserCommand({ UserPoolId: this.poolId(tenant), Username: username }));
  }

  async createMembership(tenant: TenantRecord, _username: string): Promise<void> {
    throw new UnsupportedInTopologyError('createMembership', this.topology);
  }

  async deleteMembership(tenant: TenantRecord, _username: string): Promise<void> {
    throw new UnsupportedInTopologyError('deleteMembership', this.topology);
  }

  async issueToken(tenant: TenantRecord, username: string, password: string): Promise<TokenSet> {
    await this.assertMember(tenant, username);
    return adminPasswordSignIn(this.cognito, this.poolId(tenant), this.clientId(tenant), username, password);
  }

  async refreshToken(tenant: TenantRecord, username: string, refreshToken: string): Promise<TokenSet> {
    await this.assertMember(tenant, username);
    return adminRefresh(this.cognito, this.poolId(tenant), this.clientId(tenant), refreshToken);
  }

  /**
   * A record without pool fields is a PROVISIONING tenant (ADR-0021): its
   * pool is not built or not yet recorded. That is a state conflict (409),
   * not a server fault.
   */
  private poolId(tenant: TenantRecord): string {
    if (tenant.userPoolId === undefined) {
      throw new ConflictError(`Tenant ${tenant.tenantId} has no user pool yet`);
    }
    return tenant.userPoolId;
  }

  private clientId(tenant: TenantRecord): string {
    if (tenant.appClientId === undefined) {
      throw new ConflictError(`Tenant ${tenant.tenantId} has no app client yet`);
    }
    return tenant.appClientId;
  }
}

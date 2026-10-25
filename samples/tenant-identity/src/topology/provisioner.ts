// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import type { Topology } from '../shared/constants';
import type { Page, RegistryReader, TenantRecord } from '../shared/registry';

/**
 * The strategy interface of spec P-1. Everything topology-specific lives in
 * `src/topology/`: one provisioner per topology for the two doors (platform
 * and tenant API), and one tenant source per topology for the trigger. No
 * other module branches on the topology (unit-tested).
 */

/** What onboarding created in Cognito, stored on the registry item. */
export interface ProvisionedTenant {
  /** pool-per-tenant only. */
  readonly userPoolId?: string;
  readonly appClientId?: string;
  readonly issuer?: string;
  /** shared-pool-multi-tenant only: `t-<tenantId>`. */
  readonly groupName?: string;
}

/** A user as seen through one tenant (spec §5.1 User). */
export interface UserView {
  readonly username: string;
  readonly email: string;
  /** Membership of `admin-<tenantId>`. */
  readonly admin: boolean;
  /** Cognito's UserStatus. */
  readonly status: string;
  readonly createdAt: Date;
}

export interface NewUserResult {
  readonly user: UserView;
  /** Only when a new Cognito user was created. Never logged. */
  readonly temporaryPassword?: string;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly idToken: string;
  /** Absent on refresh. */
  readonly refreshToken?: string;
  readonly expiresIn: number;
}

/**
 * Cognito-side operations for one topology. Every per-user method except
 * `createUser` and `createMembership` first checks that the user belongs to
 * the tenant (R-12) and throws NotFoundError if not, changing nothing.
 *
 * Errors: NotFoundError (404), ConflictError (409),
 * UnsupportedInTopologyError (400), InvalidInputError (400) from
 * `src/shared/errors.ts`. Anything else is a 500.
 *
 * The `tenant` argument is the registry record; callers check its status.
 */
export interface Provisioner {
  readonly topology: Topology;

  /** Creates what the tenant owns in Cognito: pool+client+trigger (1) or groups. */
  provisionTenant(tenantId: string, name: string): Promise<ProvisionedTenant>;

  /** Removes everything provisionTenant and the tenant's users created. Idempotent. */
  deprovisionTenant(tenant: TenantRecord): Promise<void>;

  /**
   * Pre-flight for CreateTenant's admin step (spec §5.1): throws ConflictError
   * when `createUser` would certainly refuse this e-mail for a brand-new
   * tenant. CreateTenant calls it BEFORE the registry write, so a taken
   * e-mail never leaves an ACTIVE tenant with no admin. shared-pool: the
   * e-mail is pool-unique (one person, one tenant). The other topologies
   * accept any e-mail for a new tenant, so this is a no-op there.
   */
  assertEmailAvailable(email: string): Promise<void>;

  /** Creates the user (or, in topology 3, reuses an existing one) and adds them to the tenant. */
  createUser(tenant: TenantRecord, email: string, admin: boolean): Promise<NewUserResult>;

  /** R-12 check only. Throws NotFoundError when the user is not in the tenant. */
  assertMember(tenant: TenantRecord, username: string): Promise<void>;

  getUser(tenant: TenantRecord, username: string): Promise<UserView>;

  listUsers(tenant: TenantRecord, nextToken?: string): Promise<Page<UserView>>;

  /** Adds the user to, or removes them from, `admin-<tenantId>`. */
  setAdmin(tenant: TenantRecord, username: string, admin: boolean): Promise<UserView>;

  /** 1, 2: delete the Cognito user. 3: leave the tenant; delete the user if no `t-*` group remains. */
  deleteUser(tenant: TenantRecord, username: string): Promise<void>;

  /** 3 only (idempotent); 1, 2 throw UnsupportedInTopologyError. */
  createMembership(tenant: TenantRecord, username: string): Promise<void>;

  /** 3 only; ConflictError on the user's last tenant. 1, 2 throw UnsupportedInTopologyError. */
  deleteMembership(tenant: TenantRecord, username: string): Promise<void>;

  /** Test aid (ADR-0006): permanent password, then ADMIN_USER_PASSWORD_AUTH. */
  issueToken(tenant: TenantRecord, username: string, password: string): Promise<TokenSet>;

  /** Test aid (ADR-0006): REFRESH_TOKEN_AUTH. */
  refreshToken(tenant: TenantRecord, username: string, refreshToken: string): Promise<TokenSet>;
}

/**
 * The trigger's view of a topology (spec §8 "Tenant lookup"). Reads the
 * event and the registry only: the trigger role holds no Cognito action
 * (R-14).
 */
export interface TenantSource {
  readonly topology: Topology;
  /**
   * `single`: the token names exactly this tenant (1, 2); the record is
   * undefined when the registry has no such tenant.
   * `multi`: every tenant the user's `t-*` groups name (3); missing tenants
   * are omitted.
   * Throws when the event cannot be mapped at all (1: unknown pool).
   */
  resolve(event: PreTokenGenerationV2TriggerEvent, registry: RegistryReader): Promise<ResolvedTenants>;
}

export type ResolvedTenants =
  | { readonly kind: 'single'; readonly tenantId: string; readonly record: TenantRecord | undefined }
  | { readonly kind: 'multi'; readonly records: readonly TenantRecord[] };

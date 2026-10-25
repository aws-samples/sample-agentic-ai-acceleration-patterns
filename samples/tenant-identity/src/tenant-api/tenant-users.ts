// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { Topology } from '../shared/constants';
import { ConflictError, InvalidInputError, NotFoundError, UnsupportedInTopologyError } from '../shared/errors';
import { errorName, log } from '../shared/logger';
import type { RegistryReader, TenantRecord } from '../shared/registry';
import {
  ConflictError as ModeledConflictError,
  InternalServerError,
  ResourceNotFoundError,
  ValidationError,
} from '../smithy/tenant/typescript-ssdk-codegen/src/models/errors';
import type {
  CreateTenantUserOutput,
  DeleteTenantUserOutput,
  GetTenantUserOutput,
  ListTenantUsersOutput,
  UpdateTenantUserOutput,
  User,
} from '../smithy/tenant/typescript-ssdk-codegen/src/models/models_0';
import type { TenantServiceService } from '../smithy/tenant/typescript-ssdk-codegen/src/server/TenantServiceService';
import type { Provisioner, UserView } from '../topology/provisioner';

/**
 * The tenant admin's door (spec §5.2, ADR-0014). The implementation of the
 * generated `TenantServiceService`. The tenant comes ONLY from the verified
 * token, carried in the caller context by the authoriser (P-11, R-9): no
 * operation here reads a tenant from the path, body, or query. Every
 * operation runs the same provisioner method as its platform twin, so the
 * R-12 membership check lives in one place (ADR-0013).
 *
 * The caller cannot demote or delete themselves (R-13), so a tenant always
 * keeps at least one admin through this door; only the vendor can remove the
 * last (P-11).
 *
 * A narrowed tenant token lives for up to 5 minutes (ADR-0014), so a caller
 * whose admin group was removed — or who was deleted from the tenant — can
 * still present a valid token until it expires. R-16 (T-26): every mutation
 * (Create/Update/Delete) re-checks the caller's admin group against Cognito
 * via `requireCallerAdmin` after `loadTenant` and before any write, so a
 * stale token cannot mutate. Reads (Get/List) deliberately keep only the
 * R-12 membership check and do NOT re-verify admin — the accepted residual
 * is that a just-demoted caller may still read for the token's lifetime.
 *
 * Extending R-13: UpdateTenantUser refuses ANY self-update (not only
 * self-demotion), so a caller cannot self-promote or otherwise rewrite their
 * own admin flag; the admin flag of the caller is changed by another admin
 * only.
 */

/** What the authoriser puts in the context (the only tenant source, P-11). */
export interface TenantCallerContext {
  readonly tenantId: string;
  readonly sub: string;
  /** The generated handler attaches bookkeeping; keep the object extensible. */
  readonly [key: string]: unknown;
}

function toUser(view: UserView): User {
  return {
    username: view.username,
    email: view.email,
    admin: view.admin,
    status: view.status,
    createdAt: view.createdAt,
  };
}

/**
 * Maps a domain error to the Smithy error of §5.3, exactly as the platform
 * service does. An unknown error becomes a 500 with a fixed message: it never
 * echoes the underlying message, which could carry input or a Cognito string
 * (N-6, N-7).
 */
function toModeledError(error: unknown): never {
  if (error instanceof NotFoundError) {
    throw new ResourceNotFoundError({ message: error.message });
  }
  if (error instanceof ConflictError) {
    throw new ModeledConflictError({ message: error.message });
  }
  if (error instanceof UnsupportedInTopologyError) {
    throw new ValidationError({ message: error.message, reason: 'UnsupportedInTopology' });
  }
  if (error instanceof InvalidInputError) {
    throw new ValidationError({ message: error.message, reason: 'InvalidInput' });
  }
  // Re-throw the errors the model already owns; everything else is a 500.
  if (
    error instanceof ResourceNotFoundError ||
    error instanceof ModeledConflictError ||
    error instanceof ValidationError
  ) {
    throw error;
  }
  throw new InternalServerError({ message: 'Internal server error' });
}

/**
 * The provisioner for one tenant, resolved per request from the registry row
 * the service has already read (ADR-0027: the row's `topology` picks the
 * strategy, so a `tiered` deployment serves standard and premium tenants
 * from one function). The function passes a factory that also chooses the
 * credentials: a single Cognito client on the function's own role for shared
 * pools, or one signing with that tenant's scoped credentials for
 * pool-per-tenant (ADR-0026).
 */
export type ProvisionerFor = (tenantId: string, topology: Topology) => Provisioner;

export class TenantUsersService implements TenantServiceService<TenantCallerContext> {
  private readonly provisionerFor: ProvisionerFor;

  constructor(
    private readonly registry: RegistryReader,
    provisioner: Provisioner | ProvisionerFor,
  ) {
    this.provisionerFor = typeof provisioner === 'function' ? provisioner : () => provisioner;
  }

  /**
   * Loads the tenant from the context's id and refuses a missing tenant (404)
   * or, for a mutation, any tenant that is not ACTIVE (409): DELETING is
   * being torn down and PROVISIONING is not built yet (P-2, ADR-0021). The
   * authoriser already refuses a non-ACTIVE tenant; this is defence in
   * depth, inside the function.
   */
  private async loadTenant(context: TenantCallerContext, mutating: boolean): Promise<TenantRecord> {
    const tenant = await this.registry.get(context.tenantId);
    if (tenant === undefined) {
      throw new NotFoundError(`Tenant ${context.tenantId} not found`);
    }
    if (mutating && tenant.status !== 'ACTIVE') {
      throw new ConflictError(`Tenant ${context.tenantId} is ${tenant.status}`);
    }
    return tenant;
  }

  /**
   * R-16 (T-26): re-checks the caller's admin group against Cognito before a
   * mutation, so a narrowed token (ADR-0014, up to 5 min) cannot mutate after
   * the caller was demoted or removed. `getUser(tenant, sub)` resolves the
   * caller's own record: a NotFoundError means the caller is no longer a user
   * of the tenant, `admin === false` means no longer an admin. Both are 409s
   * (the token is valid but the caller's standing changed, so a retry with a
   * fresh token is the fix). Call after loadTenant and before any write.
   */
  private async requireCallerAdmin(provisioner: Provisioner, tenant: TenantRecord, sub: string): Promise<void> {
    let caller: UserView;
    try {
      caller = await provisioner.getUser(tenant, sub);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ConflictError('Caller is no longer a user of the tenant');
      }
      throw error;
    }
    if (caller.admin === false) {
      throw new ConflictError('Caller is no longer an admin of the tenant');
    }
  }

  /**
   * Resolves the path's `{username}` (which may be an e-mail, per the model)
   * to the user's Cognito username and compares it to the caller's `sub`.
   * This runs the R-12 membership check first (via `getUser`), then enforces
   * R-13 on the real username, so passing an e-mail cannot evade the
   * self-mutation guard. Throws NotFoundError (404) when the user is not in
   * the tenant.
   */
  private async resolveTarget(
    provisioner: Provisioner,
    tenant: TenantRecord,
    username: string,
    sub: string,
  ): Promise<{ username: string; isSelf: boolean }> {
    const user = await provisioner.getUser(tenant, username);
    return { username: user.username, isSelf: user.username === sub };
  }

  async CreateTenantUser(
    input: { email?: string; admin?: boolean },
    context: TenantCallerContext,
  ): Promise<CreateTenantUserOutput> {
    log.info('tenant user operation', { tenantId: context.tenantId, sub: context.sub, operation: 'CreateTenantUser' });
    try {
      const tenant = await this.loadTenant(context, true);
      const provisioner = this.provisionerFor(tenant.tenantId, tenant.topology);
      // R-16 (T-26): re-check the caller's admin group before any write.
      await this.requireCallerAdmin(provisioner, tenant, context.sub);
      const result = await provisioner.createUser(tenant, input.email!, input.admin ?? false);
      return { user: toUser(result.user), temporaryPassword: result.temporaryPassword };
    } catch (error) {
      log.warn('tenant user operation failed', {
        tenantId: context.tenantId,
        operation: 'CreateTenantUser',
        error: errorName(error),
      });
      return toModeledError(error);
    }
  }

  async GetTenantUser(
    input: { username?: string },
    context: TenantCallerContext,
  ): Promise<GetTenantUserOutput> {
    log.info('tenant user operation', { tenantId: context.tenantId, sub: context.sub, operation: 'GetTenantUser' });
    try {
      const tenant = await this.loadTenant(context, false);
      const provisioner = this.provisionerFor(tenant.tenantId, tenant.topology);
      // getUser runs the R-12 membership check and 404s a non-member.
      const user = await provisioner.getUser(tenant, input.username!);
      return { user: toUser(user) };
    } catch (error) {
      log.warn('tenant user operation failed', {
        tenantId: context.tenantId,
        operation: 'GetTenantUser',
        error: errorName(error),
      });
      return toModeledError(error);
    }
  }

  async ListTenantUsers(
    input: { nextToken?: string },
    context: TenantCallerContext,
  ): Promise<ListTenantUsersOutput> {
    log.info('tenant user operation', { tenantId: context.tenantId, sub: context.sub, operation: 'ListTenantUsers' });
    try {
      const tenant = await this.loadTenant(context, false);
      const provisioner = this.provisionerFor(tenant.tenantId, tenant.topology);
      const page = await provisioner.listUsers(tenant, input.nextToken);
      return { users: page.items.map(toUser), nextToken: page.nextToken };
    } catch (error) {
      log.warn('tenant user operation failed', {
        tenantId: context.tenantId,
        operation: 'ListTenantUsers',
        error: errorName(error),
      });
      return toModeledError(error);
    }
  }

  async UpdateTenantUser(
    input: { username?: string; admin?: boolean },
    context: TenantCallerContext,
  ): Promise<UpdateTenantUserOutput> {
    log.info('tenant user operation', { tenantId: context.tenantId, sub: context.sub, operation: 'UpdateTenantUser' });
    try {
      const tenant = await this.loadTenant(context, true);
      const provisioner = this.provisionerFor(tenant.tenantId, tenant.topology);
      // R-16 (T-26): re-check the caller's admin group before any write.
      await this.requireCallerAdmin(provisioner, tenant, context.sub);
      // R-12 (membership) then R-13 (self-mutation): resolve the path username
      // to the real username and refuse a self-update before any write.
      const target = await this.resolveTarget(provisioner, tenant, input.username!, context.sub);
      // Extends R-13: refuse ANY self-update of the admin flag, not only
      // self-demotion — a caller cannot self-promote or otherwise rewrite
      // their own admin flag; only another admin can change it.
      if (target.isSelf) {
        throw new ConflictError('A tenant admin cannot change their own admin flag');
      }
      // The provisioner re-checks membership (R-12) inside setAdmin. That is
      // one extra Cognito read, kept so the provisioner never trusts its caller.
      const user = await provisioner.setAdmin(tenant, target.username, input.admin!);
      return { user: toUser(user) };
    } catch (error) {
      log.warn('tenant user operation failed', {
        tenantId: context.tenantId,
        operation: 'UpdateTenantUser',
        error: errorName(error),
      });
      return toModeledError(error);
    }
  }

  async DeleteTenantUser(
    input: { username?: string },
    context: TenantCallerContext,
  ): Promise<DeleteTenantUserOutput> {
    log.info('tenant user operation', { tenantId: context.tenantId, sub: context.sub, operation: 'DeleteTenantUser' });
    try {
      const tenant = await this.loadTenant(context, true);
      const provisioner = this.provisionerFor(tenant.tenantId, tenant.topology);
      // R-16 (T-26): re-check the caller's admin group before any write.
      await this.requireCallerAdmin(provisioner, tenant, context.sub);
      // R-12 (membership) then R-13 (self-delete): resolve the path username
      // to the real username and refuse a self-deletion before any write.
      const target = await this.resolveTarget(provisioner, tenant, input.username!, context.sub);
      if (target.isSelf) {
        throw new ConflictError('A tenant admin cannot delete themselves');
      }
      await provisioner.deleteUser(tenant, target.username);
      return {};
    } catch (error) {
      log.warn('tenant user operation failed', {
        tenantId: context.tenantId,
        operation: 'DeleteTenantUser',
        error: errorName(error),
      });
      return toModeledError(error);
    }
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

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

export class TenantUsersService implements TenantServiceService<TenantCallerContext> {
  constructor(
    private readonly registry: RegistryReader,
    private readonly provisioner: Provisioner,
  ) {}

  /**
   * Loads the tenant from the context's id and refuses a missing tenant (404)
   * or, for a mutation, a DELETING one (409). The authoriser already refuses a
   * non-ACTIVE tenant; this is defence in depth, inside the function (P-2).
   */
  private async loadTenant(context: TenantCallerContext, mutating: boolean): Promise<TenantRecord> {
    const tenant = await this.registry.get(context.tenantId);
    if (tenant === undefined) {
      throw new NotFoundError(`Tenant ${context.tenantId} not found`);
    }
    if (mutating && tenant.status === 'DELETING') {
      throw new ConflictError(`Tenant ${context.tenantId} is being deleted`);
    }
    return tenant;
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
    tenant: TenantRecord,
    username: string,
    sub: string,
  ): Promise<{ username: string; isSelf: boolean }> {
    const user = await this.provisioner.getUser(tenant, username);
    return { username: user.username, isSelf: user.username === sub };
  }

  async CreateTenantUser(
    input: { email?: string; admin?: boolean },
    context: TenantCallerContext,
  ): Promise<CreateTenantUserOutput> {
    log.info('tenant user operation', { tenantId: context.tenantId, sub: context.sub, operation: 'CreateTenantUser' });
    try {
      const tenant = await this.loadTenant(context, true);
      const result = await this.provisioner.createUser(tenant, input.email!, input.admin ?? false);
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
      // getUser runs the R-12 membership check and 404s a non-member.
      const user = await this.provisioner.getUser(tenant, input.username!);
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
      const page = await this.provisioner.listUsers(tenant, input.nextToken);
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
      // R-12 (membership) then R-13 (self-demote): resolve the path username
      // to the real username and refuse a self-demotion before any write.
      const target = await this.resolveTarget(tenant, input.username!, context.sub);
      if (target.isSelf && input.admin === false) {
        throw new ConflictError('A tenant admin cannot demote themselves');
      }
      // The provisioner re-checks membership (R-12) inside setAdmin. That is
      // one extra Cognito read, kept so the provisioner never trusts its caller.
      const user = await this.provisioner.setAdmin(tenant, target.username, input.admin!);
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
      // R-12 (membership) then R-13 (self-delete): resolve the path username
      // to the real username and refuse a self-deletion before any write.
      const target = await this.resolveTarget(tenant, input.username!, context.sub);
      if (target.isSelf) {
        throw new ConflictError('A tenant admin cannot delete themselves');
      }
      await this.provisioner.deleteUser(tenant, target.username);
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

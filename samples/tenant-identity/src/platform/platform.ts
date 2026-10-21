// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ulid } from 'ulid';
import type { Topology } from '../shared/constants';
import {
  ConflictError as DomainConflictError,
  InvalidInputError,
  NotFoundError,
  UnsupportedInTopologyError,
} from '../shared/errors';
import { errorName, log } from '../shared/logger';
import type { Registry, TenantRecord } from '../shared/registry';
import {
  ConflictError,
  CreateMembershipServerInput,
  CreateMembershipServerOutput,
  CreateTenantServerInput,
  CreateTenantServerOutput,
  CreateUserServerInput,
  CreateUserServerOutput,
  DeleteMembershipServerInput,
  DeleteMembershipServerOutput,
  DeleteTenantServerInput,
  DeleteTenantServerOutput,
  DeleteUserServerInput,
  DeleteUserServerOutput,
  GetTenantServerInput,
  GetTenantServerOutput,
  GetUserServerInput,
  GetUserServerOutput,
  InternalServerError,
  IssueTokenServerInput,
  IssueTokenServerOutput,
  ListTenantsServerInput,
  ListTenantsServerOutput,
  ListUsersServerInput,
  ListUsersServerOutput,
  PlatformServiceService,
  RefreshTokenServerInput,
  RefreshTokenServerOutput,
  ResourceNotFoundError,
  Tenant,
  UpdateUserServerInput,
  UpdateUserServerOutput,
  User,
  ValidationError,
} from '../smithy/platform/typescript-ssdk-codegen/src';
import type { Provisioner, UserView } from '../topology/provisioner';

/**
 * The per-request context the platform function builds from the API Gateway
 * event. The only field is the IAM caller ARN, carried for audit logs (N-4,
 * ADR-0005); the platform service reads tenant identity from the path, never
 * from the context.
 */
export interface PlatformContext {
  /** The IAM principal that SigV4-signed the request (audit only). */
  readonly callerArn?: string;
}

/** Dependencies injected at cold start (and in tests). */
export interface PlatformServiceDeps {
  readonly registry: Registry;
  readonly provisioner: Provisioner;
  readonly topology: Topology;
  /** Overridable so tests get deterministic ids. */
  readonly newTenantId?: () => string;
  /** Overridable so tests get deterministic timestamps. */
  readonly now?: () => Date;
}

/**
 * The vendor's door (spec §5.1). Implements the Smithy-generated
 * `PlatformServiceService` interface; every operation returns its final state
 * (synchronous, ADR-0004). It owns the registry writes for tenants and
 * delegates everything Cognito-side to the topology's provisioner (P-1).
 * Tenant status gates every mutation: a `DELETING` tenant answers 409 to
 * writes and the token test-aids, and reads still return it (P-2, R-11).
 */
export class PlatformService implements PlatformServiceService<PlatformContext> {
  private readonly registry: Registry;
  private readonly provisioner: Provisioner;
  private readonly topology: Topology;
  private readonly newTenantId: () => string;
  private readonly now: () => Date;

  constructor(deps: PlatformServiceDeps) {
    this.registry = deps.registry;
    this.provisioner = deps.provisioner;
    this.topology = deps.topology;
    this.newTenantId = deps.newTenantId ?? ulid;
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------
  // Tenant lifecycle
  // -------------------------------------------------------------------

  CreateTenant = async (
    input: CreateTenantServerInput,
    _context: PlatformContext,
  ): Promise<CreateTenantServerOutput> => {
    const name = requireField(input.name, 'name');
    const adminEmail = requireField(input.adminEmail, 'adminEmail');
    const tenantId = this.newTenantId();
    log.info('CreateTenant', { operation: 'CreateTenant', tenantId });

    return this.mapErrors('CreateTenant', tenantId, async () => {
      // Provision Cognito first. A failure here is before the registry write,
      // so the provisioner cleans up its own half-built state (spec §5.1).
      const provisioned = await this.provisioner.provisionTenant(tenantId, name);
      const timestamp = this.now().toISOString();
      const record: TenantRecord = {
        tenantId,
        name,
        status: 'ACTIVE',
        topology: this.topology,
        ...provisioned,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // R-10: only tenant fields reach the registry — never user data.
      try {
        await this.registry.create(record);
      } catch (error) {
        // Cognito is provisioned but the registry write failed: undo the
        // provisioning so no untracked pool or group is left (spec §5.1).
        // A clean-up failure is logged and the original error still surfaces.
        try {
          await this.provisioner.deprovisionTenant(record);
        } catch (cleanup) {
          log.error('CreateTenant clean-up failed', { operation: 'CreateTenant', tenantId, error: errorName(cleanup) });
        }
        throw error;
      }

      // The tenant is now ACTIVE. If the admin step fails the tenant stays
      // ACTIVE with no admin and the error surfaces; the vendor retries with
      // CreateUser (spec §5.1).
      const admin = await this.provisioner.createUser(record, adminEmail, true);
      return {
        tenant: toTenant(record),
        admin: { user: toUser(admin.user), temporaryPassword: admin.temporaryPassword },
      };
    });
  };

  GetTenant = async (
    input: GetTenantServerInput,
    _context: PlatformContext,
  ): Promise<GetTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    // Reads are allowed on a DELETING tenant and return it (P-2).
    const record = await this.loadTenant(tenantId);
    return { tenant: toTenant(record) };
  };

  ListTenants = async (
    input: ListTenantsServerInput,
    _context: PlatformContext,
  ): Promise<ListTenantsServerOutput> => {
    return this.mapErrors('ListTenants', undefined, async () => {
      const page = await this.registry.list(input.nextToken);
      return { tenants: page.items.map(toTenant), nextToken: page.nextToken };
    });
  };

  DeleteTenant = async (
    input: DeleteTenantServerInput,
    _context: PlatformContext,
  ): Promise<DeleteTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    log.info('DeleteTenant', { operation: 'DeleteTenant', tenantId });
    return this.mapErrors('DeleteTenant', tenantId, async () => {
      // R-11: flip to DELETING FIRST, so the trigger stops issuing tokens for
      // the tenant at once, before any Cognito clean-up. NotFound -> 404.
      // Idempotent and re-runnable against an already DELETING tenant.
      const deleting = await this.registry.markDeleting(tenantId);
      await this.provisioner.deprovisionTenant(deleting);
      // Remove the registry item only after clean-up succeeds (R-11).
      await this.registry.delete(tenantId);
      return {};
    });
  };

  // -------------------------------------------------------------------
  // User lifecycle (within a tenant)
  // -------------------------------------------------------------------

  CreateUser = async (
    input: CreateUserServerInput,
    _context: PlatformContext,
  ): Promise<CreateUserServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const email = requireField(input.email, 'email');
    log.info('CreateUser', { operation: 'CreateUser', tenantId });
    return this.mapErrors('CreateUser', tenantId, async () => {
      const tenant = await this.loadActiveTenant(tenantId);
      const result = await this.provisioner.createUser(tenant, email, input.admin ?? false);
      return { user: toUser(result.user), temporaryPassword: result.temporaryPassword };
    });
  };

  GetUser = async (
    input: GetUserServerInput,
    _context: PlatformContext,
  ): Promise<GetUserServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const username = requireField(input.username, 'username');
    return this.mapErrors('GetUser', tenantId, async () => {
      // Read: allowed on DELETING. The provisioner runs the R-12 check.
      const tenant = await this.loadTenant(tenantId);
      const user = await this.provisioner.getUser(tenant, username);
      return { user: toUser(user) };
    });
  };

  ListUsers = async (
    input: ListUsersServerInput,
    _context: PlatformContext,
  ): Promise<ListUsersServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    return this.mapErrors('ListUsers', tenantId, async () => {
      // Read: allowed on DELETING.
      const tenant = await this.loadTenant(tenantId);
      const page = await this.provisioner.listUsers(tenant, input.nextToken);
      return { users: page.items.map(toUser), nextToken: page.nextToken };
    });
  };

  UpdateUser = async (
    input: UpdateUserServerInput,
    _context: PlatformContext,
  ): Promise<UpdateUserServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const username = requireField(input.username, 'username');
    const admin = requireField(input.admin, 'admin');
    log.info('UpdateUser', { operation: 'UpdateUser', tenantId });
    return this.mapErrors('UpdateUser', tenantId, async () => {
      const tenant = await this.loadActiveTenant(tenantId);
      const user = await this.provisioner.setAdmin(tenant, username, admin);
      return { user: toUser(user) };
    });
  };

  DeleteUser = async (
    input: DeleteUserServerInput,
    _context: PlatformContext,
  ): Promise<DeleteUserServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const username = requireField(input.username, 'username');
    log.info('DeleteUser', { operation: 'DeleteUser', tenantId });
    return this.mapErrors('DeleteUser', tenantId, async () => {
      const tenant = await this.loadActiveTenant(tenantId);
      await this.provisioner.deleteUser(tenant, username);
      return {};
    });
  };

  // -------------------------------------------------------------------
  // Membership (shared-pool-multi-tenant only; others 400)
  // -------------------------------------------------------------------

  CreateMembership = async (
    input: CreateMembershipServerInput,
    _context: PlatformContext,
  ): Promise<CreateMembershipServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const username = requireField(input.username, 'username');
    log.info('CreateMembership', { operation: 'CreateMembership', tenantId });
    return this.mapErrors('CreateMembership', tenantId, async () => {
      const tenant = await this.loadActiveTenant(tenantId);
      await this.provisioner.createMembership(tenant, username);
      return {};
    });
  };

  DeleteMembership = async (
    input: DeleteMembershipServerInput,
    _context: PlatformContext,
  ): Promise<DeleteMembershipServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const username = requireField(input.username, 'username');
    log.info('DeleteMembership', { operation: 'DeleteMembership', tenantId });
    return this.mapErrors('DeleteMembership', tenantId, async () => {
      const tenant = await this.loadActiveTenant(tenantId);
      await this.provisioner.deleteMembership(tenant, username);
      return {};
    });
  };

  // -------------------------------------------------------------------
  // Token test aids (ADR-0006)
  // -------------------------------------------------------------------

  IssueToken = async (
    input: IssueTokenServerInput,
    _context: PlatformContext,
  ): Promise<IssueTokenServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const username = requireField(input.username, 'username');
    const password = requireField(input.password, 'password');
    // Never log the password.
    log.info('IssueToken', { operation: 'IssueToken', tenantId });
    return this.mapErrors('IssueToken', tenantId, async () => {
      const tenant = await this.loadActiveTenant(tenantId);
      const tokens = await this.provisioner.issueToken(tenant, username, password);
      return {
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        refreshToken: requireField(tokens.refreshToken, 'refreshToken'),
        expiresIn: tokens.expiresIn,
      };
    });
  };

  RefreshToken = async (
    input: RefreshTokenServerInput,
    _context: PlatformContext,
  ): Promise<RefreshTokenServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const username = requireField(input.username, 'username');
    const refreshToken = requireField(input.refreshToken, 'refreshToken');
    // Never log the token.
    log.info('RefreshToken', { operation: 'RefreshToken', tenantId });
    return this.mapErrors('RefreshToken', tenantId, async () => {
      const tenant = await this.loadActiveTenant(tenantId);
      const tokens = await this.provisioner.refreshToken(tenant, username, refreshToken);
      return {
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        expiresIn: tokens.expiresIn,
      };
    });
  };

  // -------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------

  /** Reads a tenant or throws the modelled 404. Reads see DELETING tenants. */
  private async loadTenant(tenantId: string): Promise<TenantRecord> {
    const record = await this.registry.get(tenantId);
    if (record === undefined) {
      throw new ResourceNotFoundError({ message: `Tenant ${tenantId} not found` });
    }
    return record;
  }

  /**
   * Reads a tenant for a mutation (and the token test aids). A `DELETING`
   * tenant answers 409: no write or token-issuance may name a tenant whose
   * offboarding has started (P-2, spec §5.3). Unknown tenant -> 404.
   */
  private async loadActiveTenant(tenantId: string): Promise<TenantRecord> {
    const record = await this.loadTenant(tenantId);
    if (record.status === 'DELETING') {
      throw new ConflictError({ message: `Tenant ${tenantId} is DELETING` });
    }
    return record;
  }

  /**
   * Runs the operation body and maps domain errors to the Smithy errors of
   * spec §5.3. Anything unmodelled becomes a 500 with a fixed message; only
   * the error's class name is logged, never its message (N-4, N-6).
   */
  private async mapErrors<T>(operation: string, tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        error instanceof ConflictError ||
        error instanceof ValidationError ||
        error instanceof InternalServerError
      ) {
        // Already a modelled Smithy error (e.g. requireField's 500).
        throw error;
      }
      if (error instanceof NotFoundError) {
        throw new ResourceNotFoundError({ message: error.message });
      }
      if (error instanceof DomainConflictError) {
        throw new ConflictError({ message: error.message });
      }
      if (error instanceof UnsupportedInTopologyError) {
        throw new ValidationError({ message: error.message, reason: 'UnsupportedInTopology' });
      }
      if (error instanceof InvalidInputError) {
        throw new ValidationError({ message: error.message, reason: 'InvalidInput' });
      }
      // Unknown: do not leak the message (N-6). Log the class name only.
      log.error('Platform operation failed', {
        operation,
        tenantId,
        errorName: errorName(error),
      });
      throw new InternalServerError({ message: 'Internal server error' });
    }
  }
}

/** Projects a registry record to the Smithy Tenant shape (dates as Date). */
function toTenant(record: TenantRecord): Tenant {
  return {
    tenantId: record.tenantId,
    name: record.name,
    status: record.status,
    topology: record.topology,
    userPoolId: record.userPoolId,
    appClientId: record.appClientId,
    issuer: record.issuer,
    groupName: record.groupName,
    // The generated IsoTimestamp member is typed as a Date; the protocol
    // serialiser formats it as ISO 8601 on the wire (spec §4.1).
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

/** Projects a provisioner UserView to the Smithy User shape. */
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
 * Narrows a Smithy-optional input field. Required fields are enforced by the
 * generated validators before the operation runs; absence here is a framework
 * bug, not a client error (mirrors the control-plane pattern).
 */
function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new InternalServerError({ message: `Validated input missing required field '${name}'` });
  }
  return value;
}

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
import type { TenantApiKey, TenantApiKeys } from '../shared/tenant-api-keys';
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
  /** The per-tenant API Gateway keys for `/tenant/*` throttling (ADR-0025). */
  readonly apiKeys: TenantApiKeys;
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
 * Tenant status gates every mutation: only an `ACTIVE` tenant accepts writes
 * and the token test-aids. A `PROVISIONING` tenant (built registry-first,
 * ADR-0021) and a `DELETING` tenant both answer 409, and reads still return them
 * (P-2, R-11, ADR-0021).
 */
export class PlatformService implements PlatformServiceService<PlatformContext> {
  private readonly registry: Registry;
  private readonly provisioner: Provisioner;
  private readonly apiKeys: TenantApiKeys;
  private readonly topology: Topology;
  private readonly newTenantId: () => string;
  private readonly now: () => Date;

  constructor(deps: PlatformServiceDeps) {
    this.registry = deps.registry;
    this.provisioner = deps.provisioner;
    this.apiKeys = deps.apiKeys;
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
      // spec §5.1: refuse an admin e-mail the topology would reject (shared
      // pool: already in the pool) BEFORE anything is written. Otherwise the
      // admin step 409s after the tenant is ACTIVE, leaving an adminless
      // tenant whose id the vendor never sees. Nothing exists yet to clean up.
      await this.provisioner.assertEmailAvailable(adminEmail);

      // ADR-0021: write the registry row FIRST, as PROVISIONING, then provision
      // Cognito, then flip to ACTIVE (spec §5.1, ADR-0021 'registry row before
      // provisioning'). A Lambda timeout at any point leaves a tracked row the
      // registry lists, never an orphan pool or group that nothing references.
      const timestamp = this.now().toISOString();
      const record: TenantRecord = {
        tenantId,
        name,
        status: 'PROVISIONING',
        topology: this.topology,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // R-10: only tenant fields reach the registry — never user data. No
      // pool/group fields yet; they are written by activate() once Cognito is
      // built.
      await this.registry.create(record);

      // Provision Cognito. On failure the provisioner undoes its own half-built
      // state; we also delete the PROVISIONING row so a retry starts clean. A
      // delete failure is logged and swallowed; the provisioning error surfaces.
      let provisioned;
      try {
        provisioned = await this.provisioner.provisionTenant(tenantId, name);
      } catch (error) {
        try {
          await this.registry.delete(tenantId);
        } catch (cleanup) {
          log.error('CreateTenant row clean-up failed', {
            operation: 'CreateTenant',
            tenantId,
            error: errorName(cleanup),
          });
        }
        throw error;
      }

      // ADR-0025: the tenant's API key, part of the provision step. The key
      // module deletes its own half-built key; here we undo the Cognito half
      // and the row (best effort, logged), as for a provisioning failure.
      let apiKey: TenantApiKey;
      try {
        apiKey = await this.apiKeys.create(tenantId);
      } catch (error) {
        try {
          await this.provisioner.deprovisionTenant({ ...record, ...provisioned });
        } catch (cleanup) {
          log.error('CreateTenant deprovision clean-up failed', {
            operation: 'CreateTenant',
            tenantId,
            error: errorName(cleanup),
          });
        }
        try {
          await this.registry.delete(tenantId);
        } catch (cleanup) {
          log.error('CreateTenant row clean-up failed', {
            operation: 'CreateTenant',
            tenantId,
            error: errorName(cleanup),
          });
        }
        throw error;
      }

      // Flip PROVISIONING -> ACTIVE, writing the provisioned Cognito fields and
      // the API key in the same conditional update (spec §5.1). On failure,
      // delete the key, deprovision the Cognito half we just built and delete
      // the row (all best-effort, logged) so nothing untracked is left behind.
      let active: TenantRecord;
      try {
        active = await this.registry.activate(tenantId, { ...provisioned, ...apiKey });
      } catch (error) {
        try {
          await this.apiKeys.delete(apiKey.apiKeyId);
        } catch (cleanup) {
          log.error('CreateTenant API key clean-up failed', {
            operation: 'CreateTenant',
            tenantId,
            error: errorName(cleanup),
          });
        }
        try {
          await this.provisioner.deprovisionTenant({ ...record, ...provisioned });
        } catch (cleanup) {
          log.error('CreateTenant deprovision clean-up failed', {
            operation: 'CreateTenant',
            tenantId,
            error: errorName(cleanup),
          });
        }
        try {
          await this.registry.delete(tenantId);
        } catch (cleanup) {
          log.error('CreateTenant row clean-up failed', {
            operation: 'CreateTenant',
            tenantId,
            error: errorName(cleanup),
          });
        }
        throw error;
      }

      // The tenant is now ACTIVE. If the admin step fails the tenant stays
      // ACTIVE with no admin and the error surfaces; the vendor retries with
      // CreateUser (spec §5.1).
      const admin = await this.provisioner.createUser(active, adminEmail, true);
      return {
        tenant: toTenant(active),
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
      // ADR-0025: the tenant's API key, idempotent. The authoriser already
      // refuses the DELETING tenant, so the key is unused from here on.
      await this.apiKeys.delete(deleting.apiKeyId);
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
      // Read: allowed on DELETING, refused on PROVISIONING (P-2, ADR-0021).
      // The provisioner runs the R-12 check.
      const tenant = await this.loadReadableTenant(tenantId);
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
      // Read: allowed on DELETING, refused on PROVISIONING (P-2, ADR-0021).
      const tenant = await this.loadReadableTenant(tenantId);
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
   * Reads a tenant for a Cognito-side read (GetUser, ListUsers). DELETING is
   * readable (P-2); a PROVISIONING tenant has no Cognito half recorded yet,
   * so there is nothing to read: 409, not a 500 from the provisioner
   * (ADR-0021, spec §5.3). Unknown tenant -> 404.
   */
  private async loadReadableTenant(tenantId: string): Promise<TenantRecord> {
    const record = await this.loadTenant(tenantId);
    if (record.status === 'PROVISIONING') {
      throw new ConflictError({ message: `Tenant ${tenantId} is ${record.status}` });
    }
    return record;
  }

  /**
   * Reads a tenant for a mutation (and the token test aids). Only an `ACTIVE`
   * tenant may be written to or named in token issuance: a `PROVISIONING`
   * tenant is not yet built and a `DELETING` tenant is being torn down, so
   * both answer 409 (P-2, ADR-0021, spec §5.3). Unknown tenant -> 404.
   */
  private async loadActiveTenant(tenantId: string): Promise<TenantRecord> {
    const record = await this.loadTenant(tenantId);
    if (record.status !== 'ACTIVE') {
      throw new ConflictError({ message: `Tenant ${tenantId} is ${record.status}` });
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

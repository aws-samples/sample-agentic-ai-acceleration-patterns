// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ulid } from 'ulid';
import { type Deployment, TIER_TOPOLOGY, TIERED, tierOf, type Topology } from '../shared/constants';
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
import type { ProvisionersFor } from '../topology';
import type { NewUserResult, Provisioner, UserView } from '../topology/provisioner';

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
  /**
   * The strategy for a tenant's topology (ADR-0027). Resolved per request
   * from the registry row, never once from the deployment: in `tiered` the
   * two tiers run different strategies in one runtime.
   */
  readonly provisioners: ProvisionersFor;
  /** The per-tenant API Gateway keys for `/tenant/*` throttling (ADR-0025). */
  readonly apiKeys: TenantApiKeys;
  /** What the stack deploys (P-7): one topology, or `tiered` (ADR-0027). */
  readonly deployment: Deployment;
  /** Overridable so tests get deterministic ids. */
  readonly newTenantId?: () => string;
  /** Overridable so tests get deterministic timestamps. */
  readonly now?: () => Date;
}

/**
 * The vendor's door (spec §5.1). Implements the Smithy-generated
 * `PlatformServiceService` interface; every operation returns its final state
 * (synchronous, ADR-0004). It owns the registry writes for tenants and
 * delegates everything Cognito-side to the tenant's provisioner (P-1), picked
 * by the topology on the tenant's registry row (ADR-0027).
 * Tenant status gates every mutation: only an `ACTIVE` tenant accepts writes
 * and the token test-aids. A `PROVISIONING` tenant (built registry-first,
 * ADR-0021) and a `DELETING` tenant both answer 409, and reads still return them
 * (P-2, R-11, ADR-0021).
 */
export class PlatformService implements PlatformServiceService<PlatformContext> {
  private readonly registry: Registry;
  private readonly provisioners: ProvisionersFor;
  private readonly apiKeys: TenantApiKeys;
  private readonly deployment: Deployment;
  private readonly newTenantId: () => string;
  private readonly now: () => Date;

  constructor(deps: PlatformServiceDeps) {
    this.registry = deps.registry;
    this.provisioners = deps.provisioners;
    this.apiKeys = deps.apiKeys;
    this.deployment = deps.deployment;
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
    // ADR-0029: an upstream control plane may supply the id so one tenant has
    // one id across planes (mounting spec M-P-1). The model types it TenantId,
    // so a bad id was already a 400 (M-R-3); an existing one fails the
    // conditional registry write below with 409 and changes nothing (M-R-2).
    const callerSuppliedId = input.tenantId !== undefined;
    const tenantId = input.tenantId ?? this.newTenantId();
    log.info('CreateTenant', { operation: 'CreateTenant', tenantId, callerSuppliedId });

    return this.mapErrors('CreateTenant', tenantId, async () => {
      // ADR-0027: the tenant's topology. In `tiered` it is the chosen tier's;
      // the tier is explicit, never inferred or defaulted (P-7 as amended).
      // Anywhere else it is the deployment's one topology and `tier` has no
      // meaning (P-4). Both refusals are 400s before anything is written.
      const topology = this.topologyFor(input.tier);
      const provisioner = this.provisioners(topology);

      // spec §5.1: refuse an admin e-mail the topology would reject (shared
      // pool: already in the pool) BEFORE anything is written. Otherwise the
      // admin step 409s after the tenant is ACTIVE, leaving an adminless
      // tenant whose id the vendor never sees. Nothing exists yet to clean up.
      await provisioner.assertEmailAvailable(adminEmail);

      // ADR-0021: write the registry row FIRST, as PROVISIONING, then provision
      // Cognito, then flip to ACTIVE (spec §5.1, ADR-0021 'registry row before
      // provisioning'). A Lambda timeout at any point leaves a tracked row the
      // registry lists, never an orphan pool or group that nothing references.
      const timestamp = this.now().toISOString();
      const record: TenantRecord = {
        tenantId,
        name,
        status: 'PROVISIONING',
        topology,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // R-10: only tenant fields reach the registry — never user data. No
      // pool/group fields yet; they are written by activate() once Cognito is
      // built. The write's attribute_not_exists(PK) condition holds for a
      // caller-supplied id too: a replay against an existing tenant is a 409
      // here, before Cognito is touched (ADR-0029, M-R-2).
      await this.registry.create(record);

      // Provision Cognito. On failure the provisioner undoes its own half-built
      // state; we also delete the PROVISIONING row so a retry starts clean. A
      // delete failure is logged and swallowed; the provisioning error surfaces.
      let provisioned;
      try {
        provisioned = await provisioner.provisionTenant(tenantId, name);
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

      // ADR-0025: the tenant's API key, part of the provision step, in its
      // tier's usage plan (ADR-0027; no tier outside `tiered`). The key
      // module deletes its own half-built key; here we undo the Cognito half
      // and the row (best effort, logged), as for a provisioning failure.
      let apiKey: TenantApiKey;
      try {
        apiKey = await this.apiKeys.create(tenantId, tierOf(topology, this.deployment));
      } catch (error) {
        try {
          await provisioner.deprovisionTenant({ ...record, ...provisioned });
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

      // Flip PROVISIONING -> ACTIVE, writing the provisioned Cognito fields,
      // the API key AND the first-admin slot in the same conditional update
      // (spec §5.1, ADR-0032). Claiming the slot here, not in a second write
      // after activation, means there is no instant at which the row is
      // ACTIVE with an empty slot: a concurrent `CreateUser {firstAdmin:
      // true}` on this id is a 409 from its claim, and CreateTenant can
      // never lose its own tenant's slot to it. On failure, delete the key,
      // deprovision the Cognito half we just built and delete the row (all
      // best-effort, logged) so nothing untracked is left behind.
      let active: TenantRecord;
      try {
        active = await this.registry.activate(tenantId, { ...provisioned, ...apiKey, firstAdminEmail: adminEmail });
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
          await provisioner.deprovisionTenant({ ...record, ...provisioned });
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

      // The tenant is now ACTIVE and its first-admin slot already holds the
      // admin's e-mail (claimed by activate above, ADR-0032, M-R-9), so only
      // the Cognito half of the first-admin path runs here. If the step
      // fails the slot is released, the tenant stays ACTIVE with no admin and
      // the error surfaces; the vendor retries with CreateUser {firstAdmin:
      // true} (spec §5.1, mounting spec M-R-6).
      const admin = await this.createUserForHeldSlot(provisioner, active, adminEmail, 'CreateTenant');
      return {
        tenant: this.toTenant(active),
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
    return { tenant: this.toTenant(record) };
  };

  ListTenants = async (
    input: ListTenantsServerInput,
    _context: PlatformContext,
  ): Promise<ListTenantsServerOutput> => {
    return this.mapErrors('ListTenants', undefined, async () => {
      const page = await this.registry.list(input.nextToken);
      return { tenants: page.items.map((record) => this.toTenant(record)), nextToken: page.nextToken };
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
      await this.provisioners(deleting.topology).deprovisionTenant(deleting);
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
    const firstAdmin = input.firstAdmin === true;
    log.info('CreateUser', { operation: 'CreateUser', tenantId, firstAdmin });
    return this.mapErrors('CreateUser', tenantId, async () => {
      const tenant = await this.loadActiveTenant(tenantId);
      const provisioner = this.provisioners(tenant.topology);
      // ADR-0032: `firstAdmin` claims the tenant's single slot first (409 if
      // held) and implies admin. A plain `admin: true` is unchanged: a tenant
      // may have many admins; it has one first admin.
      const result = firstAdmin
        ? await this.createFirstAdmin(provisioner, tenant, email)
        : await provisioner.createUser(tenant, email, input.admin ?? false);
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
      const user = await this.provisioners(tenant.topology).getUser(tenant, username);
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
      const page = await this.provisioners(tenant.topology).listUsers(tenant, input.nextToken);
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
      const user = await this.provisioners(tenant.topology).setAdmin(tenant, username, admin);
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
      const provisioner = this.provisioners(tenant.topology);
      // ADR-0032 (M-R-9): find out BEFORE the delete whether the user holds
      // the first-admin slot; afterwards there is no user left to ask.
      const slot = await this.firstAdminSlotHeldBy(provisioner, tenant, username, 'DeleteUser');
      await provisioner.deleteUser(tenant, username);
      if (slot !== undefined) {
        // Released only after Cognito confirms the delete, so a failed delete
        // never frees a slot whose holder still exists. If this write fails
        // the user is gone and the slot stale; the next DeleteUser of the
        // holder's e-mail takes the stale-slot path in firstAdminSlotHeldBy.
        await this.registry.releaseFirstAdmin(tenantId, slot);
        log.info('first-admin slot released', { operation: 'DeleteUser', tenantId });
      }
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
      await this.provisioners(tenant.topology).createMembership(tenant, username);
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
      const provisioner = this.provisioners(tenant.topology);
      // ADR-0032 (M-R-9): leaving the tenant through a membership removal
      // ends the first admin's tenure exactly as DeleteUser does, so the
      // slot is handled the same way: read before, release after. (An
      // `UpdateUser {admin: false}` of the holder does NOT release it: the
      // user is still in the tenant, and a free slot while they exist would
      // allow the second first admin §6.4 forbids. The slot follows the
      // user's presence in the tenant, not their admin flag.)
      const slot = await this.firstAdminSlotHeldBy(provisioner, tenant, username, 'DeleteMembership');
      await provisioner.deleteMembership(tenant, username);
      if (slot !== undefined) {
        await this.registry.releaseFirstAdmin(tenantId, slot);
        log.info('first-admin slot released', { operation: 'DeleteMembership', tenantId });
      }
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
      const tokens = await this.provisioners(tenant.topology).issueToken(tenant, username, password);
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
      const tokens = await this.provisioners(tenant.topology).refreshToken(tenant, username, refreshToken);
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

  /**
   * The first-admin path for CreateUser (ADR-0032, mounting spec M-R-8).
   * Claim the tenant's slot with one conditional write, THEN create the
   * Cognito user as an admin. The slot, not a read, decides: two racing
   * calls get one 201 and one 409 whatever order Cognito sees them in
   * (control-plane P-5). A failed claim changes nothing. CreateTenant
   * skips the claim: its slot is written by `activate` in the same update
   * that makes the row ACTIVE, and it joins at `createUserForHeldSlot`.
   */
  private async createFirstAdmin(provisioner: Provisioner, tenant: TenantRecord, email: string): Promise<NewUserResult> {
    await this.registry.claimFirstAdmin(tenant.tenantId, email);
    return this.createUserForHeldSlot(provisioner, tenant, email, 'CreateUser');
  }

  /**
   * The Cognito half of the first-admin path, entered with the slot already
   * held by `email`. If Cognito refuses, the slot is released with a
   * conditional write on the same e-mail and the original error surfaces; a
   * release failure is logged and the original error still surfaces (the
   * next claim of this e-mail is a 409 the vendor clears with DeleteUser,
   * M-R-9).
   *
   * After Cognito succeeds the claim is re-asserted (`confirmFirstAdmin`).
   * While Cognito ran, a DeleteUser naming this very e-mail found no such
   * user yet, took it for a stale slot and released it (firstAdminSlotHeldBy);
   * a second `firstAdmin` call could then claim the empty slot, and the
   * tenant would end up with two first admins. The confirm write puts the
   * slot back when it is empty or still ours, and when another e-mail holds
   * it the user just created is undone (`deleteUser`: in topology 3 this
   * leaves the tenant and deletes the user only if no tenant remains) and a
   * 409 surfaces. Any other confirm failure (DynamoDB unavailable) is
   * rethrown as it is: the user exists and the slot is, barring that race,
   * still ours, so deleting the user would strand the slot.
   */
  private async createUserForHeldSlot(
    provisioner: Provisioner,
    tenant: TenantRecord,
    email: string,
    operation: 'CreateUser' | 'CreateTenant',
  ): Promise<NewUserResult> {
    let created: NewUserResult;
    try {
      created = await provisioner.createUser(tenant, email, true);
    } catch (error) {
      try {
        await this.registry.releaseFirstAdmin(tenant.tenantId, email);
      } catch (cleanup) {
        log.error('first-admin slot release failed', {
          operation,
          tenantId: tenant.tenantId,
          error: errorName(cleanup),
        });
      }
      throw error;
    }
    try {
      await this.registry.confirmFirstAdmin(tenant.tenantId, email);
    } catch (error) {
      if (error instanceof DomainConflictError || error instanceof NotFoundError) {
        log.info('first-admin slot lost while Cognito ran; undoing the user', { operation, tenantId: tenant.tenantId });
        try {
          await provisioner.deleteUser(tenant, created.user.username);
        } catch (cleanup) {
          log.error('first-admin user undo failed', {
            operation,
            tenantId: tenant.tenantId,
            error: errorName(cleanup),
          });
        }
      }
      throw error;
    }
    return created;
  }

  /**
   * Whether `username` (a Cognito username or an e-mail, per the model) is
   * the tenant's first admin; returns the slot value to release, or
   * undefined. Nothing is read when no slot is held, so DeleteUser on a
   * tenant without one is unchanged. The slot holds the admin's E-MAIL (in
   * pool-per-tenant the Cognito username is a UUID), so the user is
   * resolved through the provisioner (R-12 check included) and compared on
   * `UserView.email`, never on the name the caller passed.
   *
   * Stale slot: if the holder is already gone from Cognito (deleted through
   * the tenant admin's door, which cannot write the registry, M-14) a
   * DeleteUser or DeleteMembership naming the holder's E-MAIL releases the
   * slot and still answers 404, so the vendor can replace a lost first
   * admin (M-R-9) without the registry ever being edited by hand. Naming
   * the gone holder's UUID username is a plain 404 and keeps the slot: with
   * no user left there is nothing to map the UUID back to the e-mail.
   */
  private async firstAdminSlotHeldBy(
    provisioner: Provisioner,
    tenant: TenantRecord,
    username: string,
    operation: 'DeleteUser' | 'DeleteMembership',
  ): Promise<string | undefined> {
    const holder = tenant.firstAdminEmail;
    if (holder === undefined) {
      return undefined;
    }
    let user: UserView;
    try {
      user = await provisioner.getUser(tenant, username);
    } catch (error) {
      if (error instanceof NotFoundError && username === holder) {
        await this.registry.releaseFirstAdmin(tenant.tenantId, holder);
        log.info('stale first-admin slot released', { operation, tenantId: tenant.tenantId });
      }
      throw error;
    }
    return user.email === holder ? holder : undefined;
  }

  /**
   * The topology a new tenant runs on (ADR-0027). `tiered`: the tier is
   * required and names it; the error is a 400 with a fixed message, so the
   * vendor learns the field, not a 500. Any single topology: `tier` has no
   * meaning and is refused as UnsupportedInTopology (P-4), so a vendor who
   * sends it against the wrong stack finds out rather than being silently
   * given the only tier there is.
   */
  private topologyFor(tier: CreateTenantServerInput['tier']): Topology {
    if (this.deployment === TIERED) {
      if (tier === undefined) {
        throw new InvalidInputError('tier is required in a tiered deployment');
      }
      return TIER_TOPOLOGY[tier];
    }
    if (tier !== undefined) {
      throw new ValidationError({
        message: 'tier is only accepted in a tiered deployment',
        reason: 'UnsupportedInTopology',
      });
    }
    return this.deployment;
  }

  /**
   * Projects a registry record to the Smithy Tenant shape (dates as Date).
   * Field by field on purpose: the row's API key (ADR-0025) and first-admin
   * slot (ADR-0032) are tenant facts the registry holds and the API never
   * returns (mounting spec §10 step 4).
   */
  private toTenant(record: TenantRecord): Tenant {
    // ADR-0027: `tier` only in a `tiered` deployment, derived from the row's
    // topology (the tier is never stored twice). Omitted elsewhere.
    const tier = tierOf(record.topology, this.deployment);
    return {
      tenantId: record.tenantId,
      name: record.name,
      status: record.status,
      topology: record.topology,
      ...(tier === undefined ? {} : { tier }),
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

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { ulid } from 'ulid';
import {
  ACCOUNT_EMPTY_CONDITION,
  AccountItem,
  AccountRecord,
  accountKey,
  listAccountsQuery,
  putAccountUpdate,
} from './account.data-model';
import { HandshakeProbe, HandshakeRefusal, HandshakeUnavailableError } from './account.handshake';
import {
  CellItem,
  CellRecord,
  cellKey,
  deleteCellTransition,
  listCellsByAccountQuery,
  listCellsQuery,
} from './cell.data-model';
import {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyDataModel,
  IdempotencyItem,
  IdempotencyRecord,
  createTenantRequestHash,
  idempotencyKey,
} from './idempotency.data-model';
import {
  TenantItem,
  TenantRecord,
  listTenantsByCellQuery,
  listTenantsQuery,
  tenantKey,
} from './tenant.data-model';
import { provisioningRoleArn, sessionNameFor } from '../shared/fleet';
import {
  AccountFullError,
  ConditionFailedError,
  DuplicateTokenError,
  DynamoDBRepository,
  GsiQuery,
  PlacementRaceLostError,
  PlacementTransactions,
  RecordGoneError,
  StaleTransitionError,
} from '../shared/repository';
import { CallerContext, ServiceConfig } from '../shared/service-config';
import {
  AccountOwner,
  AccountSummary,
  CellSummary,
  ConflictError,
  CreateTenantServerInput,
  CreateTenantServerOutput,
  DeleteAccountServerInput,
  DeleteAccountServerOutput,
  DeleteCellServerInput,
  DeleteCellServerOutput,
  DeleteTenantServerInput,
  DeleteTenantServerOutput,
  GetAccountServerInput,
  GetAccountServerOutput,
  GetCellServerInput,
  GetCellServerOutput,
  GetResourceServerInput,
  GetResourceServerOutput,
  GetTenantServerInput,
  GetTenantServerOutput,
  InsufficientCapacityError,
  InternalServerError,
  LifecycleStatus,
  ListAccountsServerInput,
  ListAccountsServerOutput,
  ListCellsServerInput,
  ListCellsServerOutput,
  ListTenantsServerInput,
  ListTenantsServerOutput,
  PutAccountServerInput,
  PutAccountServerOutput,
  ResourceNotFoundError,
  ValidationException,
  ScriptLocations,
  SourceDefinition,
  TenantServiceService,
  TenantSummary,
  UpdateCellServerInput,
  UpdateCellServerOutput,
  UpdateResourceServerInput,
  UpdateResourceServerOutput,
  UpdateTenantServerInput,
  UpdateTenantServerOutput,
} from '../smithy/source/typescript-ssdk-codegen/src';

/** Provisioning workflow operations (mirrors the lifecycle scripts). */
export type ProvisioningOperation = 'create' | 'update' | 'delete';

type FailedLifecycleStatus = 'CREATE_FAILED' | 'UPDATE_FAILED' | 'DELETE_FAILED';
type InFlightLifecycleStatus = 'CREATING' | 'UPDATING' | 'DELETING';

/** One optional build phase of the workflow input (§7). */
interface BuildPhaseInput {
  readonly operation: ProvisioningOperation;
  readonly scriptPath: string;
  readonly failedStatus: FailedLifecycleStatus;
}

/**
 * The tenant build phase. `tenantName` is the name stored on the tenant
 * record, present on every operation and forwarded as `TENANT_NAME`
 * (ADR-023); `adminEmail` is always present (empty string for non-create).
 */
interface TenantBuildPhaseInput extends BuildPhaseInput {
  readonly tenantName: string;
  readonly adminEmail: string;
}

/**
 * Resolved Step Functions execution input (ADR-011): the service
 * resolves sources, script paths, and failure statuses; the workflow rereads
 * no mutable records. `cellBuild`/`tenantBuild` are each optional — the
 * combination encodes the trigger (§7).
 */
interface ProvisioningWorkflowInput {
  readonly sourceType: string;
  readonly sourceLocation: string;
  /** The account the cell lives in (ADR-024) — the cell-delete transaction releases its slot. */
  readonly accountId: string;
  /** The account's external id, or '' when none; presented on AssumeRole (ADR-025). */
  readonly externalId: string;
  /** The provisioning role pair in that account, resolved by name (R-20, ADR-025). */
  readonly cellRoleArn: string;
  readonly tenantRoleArn: string;
  /** The STS-safe operator session name (M23). */
  readonly sessionName: string;
  /**
   * The stamped supply-chain pin (T5/M10) — always present; the empty
   * string means unpinned. A non-empty value becomes the CodeBuild
   * `SourceVersion` override on every build of this execution.
   */
  readonly sourceVersion: string;
  /**
   * The initiating operator (verified JWT `sub` from the authorizer
   * context) — audit propagation into the application plane (T10/M12).
   * Always present; forwarded to every build as `OPERATOR_ID`.
   */
  readonly operatorId: string;
  readonly cellId: string;
  readonly cellBuild?: BuildPhaseInput;
  readonly tenantId?: string;
  readonly tenantBuild?: TenantBuildPhaseInput;
}

/**
 * The stamped provisioning source: the Smithy-modelled shape plus the
 * optional supply-chain pin (T5/M10). `sourceVersion` is deployment
 * configuration, never an API input — the Smithy contract is unchanged; the
 * pin rides along in the CellDefinition env JSON and the stamped cell
 * record, and maps to the CodeBuild StartBuild `sourceVersion` parameter.
 */
export type StampedSourceDefinition = SourceDefinition & {
  readonly sourceVersion?: string;
};

/**
 * The deployment-configured CellDefinition (§10, ADR-012), stamped onto each
 * new cell record at creation. Supplied to the Lambda as the
 * `CELL_DEFINITION` env JSON (validated at synth time) and parsed once at
 * cold start.
 */
export interface CellDefinition {
  readonly source: StampedSourceDefinition;
  readonly cellScripts: ScriptLocations;
  readonly tenantScripts: ScriptLocations;
  readonly maxTenants: number;
}

/**
 * Parses (and fail-fast validates) the `CELL_DEFINITION` env JSON at cold
 * start. Synthesis already validates the deployment input (§10) — a failure
 * here indicates deployment drift, never a client error.
 */
export function parseCellDefinition(json: string): CellDefinition {
  const parsed = JSON.parse(json) as CellDefinition;
  const missing: string[] = [];
  if (!parsed?.source?.type || !parsed?.source?.location) {
    missing.push('source');
  }
  for (const scriptSet of ['cellScripts', 'tenantScripts'] as const) {
    for (const operation of ['create', 'update', 'delete'] as const) {
      if (!parsed?.[scriptSet]?.[operation]) {
        missing.push(`${scriptSet}.${operation}`);
      }
    }
  }
  if (!Number.isInteger(parsed?.maxTenants) || parsed.maxTenants < 1) {
    missing.push('maxTenants');
  }
  if (missing.length > 0) {
    throw new Error(`Invalid CELL_DEFINITION environment variable — missing/invalid: ${missing.join(', ')}`);
  }
  return parsed;
}

/** Static configuration for the tenant service — built once at cold start. */
export interface TenantServiceConfig extends ServiceConfig {
  /** Repository over tenant items in the control plane table. */
  readonly tenantRepository: DynamoDBRepository<TenantRecord, TenantItem>;
  /** Repository over cell items in the same table. */
  readonly cellRepository: DynamoDBRepository<CellRecord, CellItem>;
  /** Repository over CreateTenant idempotency records (ADR-017). */
  readonly idempotencyRepository: DynamoDBRepository<IdempotencyRecord, IdempotencyItem>;
  /** The placement/compensation transaction shapes (workstream B, §6). */
  readonly placement: PlacementTransactions<CellRecord, CellItem, TenantRecord, TenantItem>;
  /** Repository over account items in the same table (ADR-024). */
  readonly accountRepository: DynamoDBRepository<AccountRecord, AccountItem>;
  /** The deployment-configured CellDefinition, parsed once at cold start (§10). */
  readonly cellDefinition: CellDefinition;
  /** Names the provisioning role pair in every account (§3.3, ADR-025). */
  readonly fleetName: string;
  /** The deployment's partition, for role ARNs. */
  readonly partition: string;
  /** The PutAccount handshake probe (ADR-027); injectable for tests. */
  readonly handshake: HandshakeProbe;
  /** ARN of the provisioning Step Functions state machine. */
  readonly stateMachineArn: string;
  /** Step Functions client (shared across invocations). */
  readonly sfnClient: SFNClient;
}

/** Statuses during which no lifecycle mutation may start. */
const IN_FLIGHT: LifecycleStatus[] = ['CREATING', 'UPDATING', 'DELETING'];

/**
 * Tenant statuses from which DeleteTenant may transition to DELETING (§5):
 * ACTIVE and every *_FAILED state — regardless of cell status, because the
 * delete script is the cleanup path.
 */
const TENANT_DELETABLE_STATUSES: readonly LifecycleStatus[] = [
  'ACTIVE',
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
];

/** Statuses from which an update (re-apply) build may start, for both entity types (§5). */
const UPDATABLE_STATUSES: readonly LifecycleStatus[] = ['ACTIVE', 'UPDATE_FAILED'];

/**
 * The placement candidate budget (§6): at most this many claim attempts
 * before falling through to new-cell creation. Keeps CreateTenant inside the
 * synchronous API Gateway window; its miss case over-provisions, never fails
 * an onboard.
 */
const MAX_CLAIM_ATTEMPTS = 5;

/** A best-effort compensation write for a rejected StartExecution (ADR-011, §6). */
type Compensation = (reason: string) => Promise<unknown>;

/**
 * §7 step 0 — the resolved placement target: the eligible accounts in
 * placement order, the same accounts by id (the eligibility filter for
 * candidate cells), the candidate-cell query, and whether the request named
 * an account (shapes the capacity error).
 */
interface PlacementTarget {
  readonly accounts: readonly AccountRecord[];
  readonly accountsById: ReadonlyMap<string, AccountRecord>;
  readonly candidateQuery: GsiQuery;
  readonly targeted: boolean;
}

/** A tenant placed into an existing cell, with the account that hosts it. */
interface PlacementResult {
  readonly cell: CellRecord;
  readonly tenant: TenantRecord;
  readonly account: AccountRecord;
}

/**
 * No existing cell was claimed. `budgetExhausted` is true when every one of
 * the {@link MAX_CLAIM_ATTEMPTS} claims lost a race on a candidate cell —
 * the cell read as ACTIVE with room, and the conditional claim then failed
 * because another request took the slot or an operator moved the cell out
 * of ACTIVE — and false when no candidate was eligible at all. The
 * candidates were read moments ago, so the miss is worth a retry; it is
 * not proof that capacity still exists.
 */
interface PlacementMiss {
  readonly budgetExhausted: boolean;
}

/** The R-24 refusal for a `PutAccount` that names another owner. */
function ownerImmutableError(accountId: string): ConflictError {
  return new ConflictError({
    message: `Account ${accountId} is already registered with a different owner; owner is immutable (delete and re-register an empty account to change it)`,
  });
}

/** Converts idempotency records to their transact-item form (ADR-017). */
const idempotencyDataModel = new IdempotencyDataModel();

/**
 * The cell-based control plane tenant service. Implements the
 * Smithy-generated `TenantServiceService` interface (all fifteen operations).
 * Receives static config in the constructor (cold start) and an immutable
 * `CallerContext` per operation — it never sees the raw event or a JWT
 * (context separation).
 */
export class TenantService implements TenantServiceService<CallerContext> {
  constructor(private readonly config: TenantServiceConfig) {}

  // -------------------------------------------------------------------
  // Tenant operations
  // -------------------------------------------------------------------

  CreateTenant = async (
    input: CreateTenantServerInput,
    context: CallerContext,
  ): Promise<CreateTenantServerOutput> => {
    const name = requireField(input.name, 'name');
    // adminEmail is pass-through: workflow input only, never persisted (ADR-004).
    const adminEmail = requireField(input.adminEmail, 'adminEmail');
    const now = new Date();
    const tenantId = ulid();

    // Optional idempotency (ADR-017): the item joins the placement
    // transaction, conditional on attribute_not_exists(PK). Its cancelled
    // condition marks the request as a replay of an earlier CreateTenant.
    const clientToken = input.clientToken;
    const requestHash =
      clientToken === undefined
        ? undefined
        : createTenantRequestHash({ name, description: input.description, adminEmail, accountId: input.accountId });
    const idempotencyItem =
      clientToken === undefined || requestHash === undefined
        ? undefined
        : idempotencyDataModel.toItem({
          clientToken,
          tenantId,
          requestHash,
          createdAt: now,
          expiresAt: Math.floor(now.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
        });

    const makeTenant = (cellId: string): TenantRecord => ({
      tenantId,
      name,
      description: input.description,
      cellId,
      status: 'CREATING',
      createdAt: now,
      updatedAt: now,
    });

    // §7 step 0 — TARGET: which accounts may host a new cell and which
    // existing cells are candidates. A named account is the only eligible
    // one (any owner; 404 if unregistered); otherwise vendor-owned accounts,
    // oldest registered first — tenant-owned accounts are never eligible
    // without a target (ADR-024).
    const target = await this.resolvePlacementTarget(input.accountId);

    // §7 steps 1–2: candidate scan + bounded claim loop against existing cells.
    let placed: PlacementResult | PlacementMiss;
    try {
      placed = await this.placeIntoExistingCell(target, makeTenant, now.toISOString(), idempotencyItem);
    } catch (error) {
      return this.replayOrRethrow(error, clientToken, requestHash);
    }

    let tenant: TenantRecord;
    let workflowInput: ProvisioningWorkflowInput;
    let compensate: Compensation;

    if ('cell' in placed) {
      // Existing cell: tenant create build only. Compensation is a single
      // CAS moving the tenant CREATING → CREATE_FAILED (§7.4).
      tenant = placed.tenant;
      workflowInput = {
        ...this.workflowSource(placed.cell),
        ...this.workflowAccount(placed.account, context),
        cellId: placed.cell.cellId,
        tenantId,
        tenantBuild: {
          operation: 'create',
          scriptPath: requireField(placed.cell.tenantScripts.create, 'cell.tenantScripts.create'),
          failedStatus: 'CREATE_FAILED',
          tenantName: tenant.name,
          adminEmail,
        },
      };
      compensate = this.tenantCompensation(tenantId, 'CREATING', 'CREATE_FAILED');
    } else {
      // §7 step 3 — no candidate claimed (none found or budget exhausted):
      // for each eligible account in order, one transaction claims a cell
      // slot on the account and creates the cell (CREATING, tenant slot
      // pre-claimed, accountId set, definition stamped) together with the
      // tenant. Every account refusing → InsufficientCapacityError (R-28),
      // unless the claim budget was spent on cells that still had room: then
      // capacity exists and the failure is a retryable ConflictError, not
      // the terminal "raise maxCells" (ADR-031).
      let created;
      try {
        created = await this.createCellInEligibleAccount(target, makeTenant, now, idempotencyItem);
      } catch (error) {
        const failure =
          placed.budgetExhausted && error instanceof InsufficientCapacityError
            ? new ConflictError({
              message:
                  `Tenant placement lost ${MAX_CLAIM_ATTEMPTS} claim races on candidate cells and no eligible account`
                  + ' has a free cell slot; nothing was written. Retry the request (spec R-18, ADR-031).',
            })
            : error;
        return this.replayOrRethrow(failure, clientToken, requestHash);
      }
      const { cell, account } = created;
      tenant = created.tenant;
      workflowInput = {
        ...this.workflowSource(cell),
        ...this.workflowAccount(account, context),
        cellId: cell.cellId,
        cellBuild: {
          operation: 'create',
          scriptPath: requireField(cell.cellScripts.create, 'cellDefinition.cellScripts.create'),
          failedStatus: 'CREATE_FAILED',
        },
        tenantId,
        tenantBuild: {
          operation: 'create',
          scriptPath: requireField(cell.tenantScripts.create, 'cellDefinition.tenantScripts.create'),
          failedStatus: 'CREATE_FAILED',
          tenantName: tenant.name,
          adminEmail,
        },
      };
      // New-cell compensation is the paired transaction: BOTH records move
      // CREATING → CREATE_FAILED so compensation cannot leave only one
      // record recoverable (§7.4). The account's cell slot stays held by the
      // CREATE_FAILED cell until DeleteCell releases it.
      compensate = (reason) =>
        this.config.placement.failCreatingCellAndTenant({
          cellKey: cellKey(cell.cellId),
          tenantKey: tenantKey(tenantId),
          statusReason: reason,
          updatedAt: new Date().toISOString(),
        });
    }

    await this.startWorkflow(`${tenantId}-create-${Date.now()}`, workflowInput, compensate);
    return { tenant: toSummary(tenant) };
  };

  GetTenant = async (
    input: GetTenantServerInput,
    _context: CallerContext,
  ): Promise<GetTenantServerOutput> => {
    const tenant = await this.getTenantOrThrow(requireField(input.tenantId, 'tenantId'));
    return { tenant: toSummary(tenant) };
  };

  UpdateTenant = async (
    input: UpdateTenantServerInput,
    _context: CallerContext,
  ): Promise<UpdateTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');

    // Metadata only (field-ownership write, ADR-011): the update cannot
    // touch workflow-owned lifecycle fields. No state guard (§5).
    const setExpressions = ['#updatedAt = :updatedAt'];
    const expressionAttributeNames: Record<string, string> = {
      '#updatedAt': 'updatedAt',
    };
    const expressionAttributeValues: Record<string, unknown> = {
      ':updatedAt': new Date().toISOString(),
    };
    if (input.name !== undefined) {
      setExpressions.push('#name = :name');
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = input.name;
    }
    if (input.description !== undefined) {
      setExpressions.push('#description = :description');
      expressionAttributeNames['#description'] = 'description';
      expressionAttributeValues[':description'] = input.description;
    }

    try {
      const updated = await this.config.tenantRepository.updateExisting(tenantKey(tenantId), {
        updateExpression: `SET ${setExpressions.join(', ')}`,
        expressionAttributeNames,
        expressionAttributeValues,
      });
      return { tenant: toSummary(updated) };
    } catch (error) {
      if (error instanceof RecordGoneError) {
        // The metadata write lost a race with a concurrent delete — 404, not
        // an unmodelled 500 (§7).
        throw new ResourceNotFoundError({ message: `Tenant ${tenantId} not found` });
      }
      throw error;
    }
  };

  DeleteTenant = async (
    input: DeleteTenantServerInput,
    context: CallerContext,
  ): Promise<DeleteTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const existing = await this.getTenantOrThrow(tenantId);

    if (IN_FLIGHT.includes(existing.status)) {
      throw new ConflictError({
        message: `Tenant ${tenantId} is ${existing.status}; wait for the operation to finish`,
      });
    }

    // Delete is allowed regardless of cell status (§5) — the cell and
    // account records are read only to resolve the stamped source, the
    // tenant delete script, and the provisioning role to assume.
    const cell = await this.getCellForTenant(existing);
    const account = await this.getAccountForCell(cell);

    const deleting = await this.transitionTenant(tenantId, TENANT_DELETABLE_STATUSES, 'DELETING');
    await this.startWorkflow(
      `${tenantId}-delete-${Date.now()}`,
      {
        ...this.workflowSource(cell),
        ...this.workflowAccount(account, context),
        cellId: existing.cellId,
        tenantId,
        tenantBuild: {
          operation: 'delete',
          scriptPath: requireField(cell.tenantScripts.delete, 'cell.tenantScripts.delete'),
          failedStatus: 'DELETE_FAILED',
          tenantName: existing.name,
          adminEmail: '',
        },
      },
      this.tenantCompensation(tenantId, 'DELETING', 'DELETE_FAILED'),
    );
    return { tenant: toSummary(deleting) };
  };

  ListTenants = async (
    input: ListTenantsServerInput,
    _context: CallerContext,
  ): Promise<ListTenantsServerOutput> => {
    // Unfiltered listing uses GSI-2's static partition; the ?cellId= filter
    // uses the tenant items' GSI-1 partition. An unknown cellId naturally
    // yields an empty page — the filter is a query predicate, not a
    // resource lookup (§5).
    const query =
      input.cellId === undefined ? listTenantsQuery() : listTenantsByCellQuery(input.cellId);
    const page = await this.config.tenantRepository.queryIndex(
      query,
      input.maxResults,
      input.nextToken,
    );
    return {
      tenants: page.items.map(toSummary),
      nextToken: page.nextToken,
    };
  };

  GetResource = async (
    input: GetResourceServerInput,
    _context: CallerContext,
  ): Promise<GetResourceServerOutput> => {
    const tenant = await this.getTenantOrThrow(requireField(input.tenantId, 'tenantId'));
    // The tenant deployment's effective definition is the cell's stamped
    // definition (ADR-012) — resolved here, never stored on the tenant.
    const cell = await this.getCellForTenant(tenant);
    return {
      source: cell.source,
      scripts: cell.tenantScripts,
      status: tenant.status,
      statusReason: tenant.statusReason,
      lastBuildId: tenant.lastBuildId,
      cellId: tenant.cellId,
      accountId: cell.accountId,
    };
  };

  UpdateResource = async (
    input: UpdateResourceServerInput,
    context: CallerContext,
  ): Promise<UpdateResourceServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const existing = await this.getTenantOrThrow(tenantId);

    // Allowed from ACTIVE and UPDATE_FAILED only. From CREATE_FAILED the
    // remediation is delete + recreate — the create script never completed.
    if (!UPDATABLE_STATUSES.includes(existing.status)) {
      throw new ConflictError({
        message: `Tenant ${tenantId} is ${existing.status}; the deployment can be re-applied from ACTIVE or UPDATE_FAILED`,
      });
    }

    // Cross-entity guard (§5): no tenant builds against a shared deployment
    // that is mid-change. This read-then-act check is the documented
    // tolerated one-directional guard — an overlap can fail a build but
    // never corrupts control plane state.
    const cell = await this.getCellForTenant(existing);
    if (cell.status !== 'ACTIVE') {
      throw new ConflictError({
        message: `Cell ${cell.cellId} is ${cell.status}; the tenant deployment can be re-applied only while its cell is ACTIVE`,
      });
    }

    const account = await this.getAccountForCell(cell);
    const updating = await this.transitionTenant(tenantId, UPDATABLE_STATUSES, 'UPDATING');
    await this.startWorkflow(
      `${tenantId}-update-${Date.now()}`,
      {
        ...this.workflowSource(cell),
        ...this.workflowAccount(account, context),
        cellId: existing.cellId,
        tenantId,
        tenantBuild: {
          operation: 'update',
          scriptPath: requireField(cell.tenantScripts.update, 'cell.tenantScripts.update'),
          failedStatus: 'UPDATE_FAILED',
          tenantName: existing.name,
          adminEmail: '',
        },
      },
      this.tenantCompensation(tenantId, 'UPDATING', 'UPDATE_FAILED'),
    );
    return { tenant: toSummary(updating) };
  };

  // -------------------------------------------------------------------
  // Cell operations
  // -------------------------------------------------------------------

  GetCell = async (
    input: GetCellServerInput,
    _context: CallerContext,
  ): Promise<GetCellServerOutput> => {
    const cell = await this.getCellOrThrow(requireField(input.cellId, 'cellId'));
    return { cell: toCellSummary(cell) };
  };

  ListCells = async (
    input: ListCellsServerInput,
    _context: CallerContext,
  ): Promise<ListCellsServerOutput> => {
    // Unfiltered listing uses GSI-1's static CELL partition; the ?accountId=
    // filter uses the cell items' GSI-2 ACCOUNT#<id> partition. An unknown
    // accountId yields an empty page — a query predicate, not a lookup (§5).
    const query =
      input.accountId === undefined ? listCellsQuery() : listCellsByAccountQuery(input.accountId);
    const page = await this.config.cellRepository.queryIndex(
      query,
      input.maxResults,
      input.nextToken,
    );
    return {
      cells: page.items.map(toCellSummary),
      nextToken: page.nextToken,
    };
  };

  UpdateCell = async (
    input: UpdateCellServerInput,
    context: CallerContext,
  ): Promise<UpdateCellServerOutput> => {
    const cellId = requireField(input.cellId, 'cellId');
    const existing = await this.getCellOrThrow(cellId);

    // Allowed from ACTIVE/UPDATE_FAILED; 409 if in-flight or CREATE_FAILED —
    // re-running the update script against a half-created shared deployment
    // would break the create/update script contract (§5). Remediation for a
    // failed cell create is tenant delete + cell delete.
    if (!UPDATABLE_STATUSES.includes(existing.status)) {
      throw new ConflictError({
        message: `Cell ${cellId} is ${existing.status}; the shared deployment can be re-applied from ACTIVE or UPDATE_FAILED`,
      });
    }

    const account = await this.getAccountForCell(existing);
    const updating = await this.transitionCell(cellId, UPDATABLE_STATUSES, 'UPDATING');
    await this.startWorkflow(
      `${cellId}-cell-update-${Date.now()}`,
      {
        ...this.workflowSource(existing),
        ...this.workflowAccount(account, context),
        cellId,
        cellBuild: {
          operation: 'update',
          scriptPath: requireField(existing.cellScripts.update, 'cell.cellScripts.update'),
          failedStatus: 'UPDATE_FAILED',
        },
      },
      this.cellCompensation(cellId, 'UPDATING', 'UPDATE_FAILED'),
    );
    return { cell: toCellSummary(updating) };
  };

  DeleteCell = async (
    input: DeleteCellServerInput,
    context: CallerContext,
  ): Promise<DeleteCellServerOutput> => {
    const cellId = requireField(input.cellId, 'cellId');
    const existing = await this.getCellOrThrow(cellId);
    const account = await this.getAccountForCell(existing);

    // ADR-014: the emptiness check and the DELETING transition are ONE
    // atomic conditional UpdateItem (status IN {ACTIVE, *_FAILED} AND
    // tenantCount = 0) — a read-then-write would let a concurrent placement
    // claim a slot before DELETING lands. Condition failure maps to the 409.
    let deleting: CellRecord;
    try {
      deleting = await this.config.cellRepository.transitionStatus(
        cellKey(cellId),
        deleteCellTransition(new Date().toISOString()),
      );
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw new ConflictError({
          message: `Cell ${cellId} cannot be deleted — it is occupied, in-flight, or was modified concurrently`,
        });
      }
      throw error;
    }

    await this.startWorkflow(
      `${cellId}-cell-delete-${Date.now()}`,
      {
        ...this.workflowSource(existing),
        ...this.workflowAccount(account, context),
        cellId,
        cellBuild: {
          operation: 'delete',
          scriptPath: requireField(existing.cellScripts.delete, 'cell.cellScripts.delete'),
          failedStatus: 'DELETE_FAILED',
        },
      },
      this.cellCompensation(cellId, 'DELETING', 'DELETE_FAILED'),
    );
    return { cell: toCellSummary(deleting) };
  };

  // -------------------------------------------------------------------
  // Account operations (§5.3, ADR-024, ADR-027)
  // -------------------------------------------------------------------

  PutAccount = async (
    input: PutAccountServerInput,
    context: CallerContext,
  ): Promise<PutAccountServerOutput> => {
    const accountId = requireField(input.accountId, 'accountId');
    const owner = requireField(input.owner, 'owner');
    const maxCells = requireField(input.maxCells, 'maxCells');

    // §6.4 (ADR-029): a tenant-owned account is a third party handing the
    // control plane a role, so its pair MUST carry an external id. Checked
    // before the probe so a missing value gets the plain message without
    // an STS round trip; the probe then verifies the pair enforces the
    // value (ADR-030). Vendor-owned accounts sit inside the vendor's own
    // trust and may omit it.
    if (owner === 'TENANT' && input.externalId === undefined) {
      throw new ValidationException({
        message:
          `Account ${accountId}: externalId is required when owner is TENANT. Install the ${this.config.fleetName} role pair`
          + ' in that account with an externalId and pass the same value here (spec §6.4, ADR-029).',
      });
    }

    // Owner is immutable (R-24). A re-registration with another owner is
    // refused from the stored record before any STS traffic, so a
    // misdirected PutAccount costs no probe; the conditional write below
    // still carries the same check for the race between this read and the
    // write.
    const existing = await this.config.accountRepository.get(accountKey(accountId));
    if (existing !== undefined && existing.owner !== owner) {
      throw ownerImmutableError(accountId);
    }

    // R-26 (ADR-027, ADR-030): verify the handshake BEFORE writing — assume
    // both halves of the pair with the supplied external id, prove the pair
    // refuses the call without it, and discard the credentials. The
    // operator is present now and can act on the error; the first build is
    // not the place to find out. A probe that STS could not answer is a
    // 500, not a refusal: the pair may be fine and the operator retries.
    let refusals: HandshakeRefusal[];
    try {
      refusals = await this.config.handshake({
        accountId,
        externalId: input.externalId,
        operatorId: context.operatorId,
      });
    } catch (error) {
      if (error instanceof HandshakeUnavailableError) {
        throw new InternalServerError({
          message: `Account ${accountId}: ${error.message}. The handshake could not be verified; retry.`,
        });
      }
      throw error;
    }
    if (refusals.length > 0) {
      throw new ValidationException({
        message:
          `Account ${accountId} is not ready: ${refusals
            .map((r) => `${r.roleArn} ${r.reason}`)
            .join('; ')}. Install the ${this.config.fleetName} role pair in that account`
          + (input.externalId === undefined ? '' : ' with the same externalId')
          + ' and retry (spec §6.4).',
      });
    }

    // One conditional create-or-replace write (R-24): owner is immutable,
    // cellCount is never touched, policy fields are replaced.
    try {
      const account = await this.config.accountRepository.update(
        accountKey(accountId),
        putAccountUpdate({
          accountId,
          owner,
          maxCells,
          externalId: input.externalId,
          now: new Date().toISOString(),
        }),
      );
      return { account: toAccountSummary(account) };
    } catch (error) {
      if (error instanceof ConditionFailedError) {
        throw ownerImmutableError(accountId);
      }
      throw error;
    }
  };

  GetAccount = async (
    input: GetAccountServerInput,
    _context: CallerContext,
  ): Promise<GetAccountServerOutput> => {
    const account = await this.getAccountOrThrow(requireField(input.accountId, 'accountId'));
    return { account: toAccountSummary(account) };
  };

  ListAccounts = async (
    input: ListAccountsServerInput,
    _context: CallerContext,
  ): Promise<ListAccountsServerOutput> => {
    const page = await this.config.accountRepository.queryIndex(
      listAccountsQuery(),
      input.maxResults,
      input.nextToken,
    );
    return {
      accounts: page.items.map(toAccountSummary),
      nextToken: page.nextToken,
    };
  };

  DeleteAccount = async (
    input: DeleteAccountServerInput,
    _context: CallerContext,
  ): Promise<DeleteAccountServerOutput> => {
    const accountId = requireField(input.accountId, 'accountId');
    const existing = await this.getAccountOrThrow(accountId);

    // Empty accounts only (P-10): ONE conditional delete on cellCount = 0 —
    // the counterpart of the cell-slot claim (ADR-024). A read-then-delete
    // would let a concurrent new-cell placement claim a slot in between;
    // the condition rejects that as the 409.
    try {
      await this.config.accountRepository.delete(accountKey(accountId), ACCOUNT_EMPTY_CONDITION);
    } catch (error) {
      if (error instanceof ConditionFailedError) {
        throw new ConflictError({
          message: `Account ${accountId} cannot be deregistered — it still holds cells (delete them first) or was modified concurrently`,
        });
      }
      throw error;
    }
    return { account: toAccountSummary(existing) };
  };

  // -------------------------------------------------------------------
  // Placement (§7)
  // -------------------------------------------------------------------

  /**
   * §7 step 0 — TARGET. With an `accountId`: that one registered account
   * (404 otherwise), any owner, and its cells as candidates. Without: every
   * vendor-owned account, oldest registered first, and all cells in those
   * accounts as candidates. The account records are read once here and
   * carried through: the workflow input needs the account's external id,
   * and the account map is what excludes tenant-owned cells from an
   * untargeted scan.
   */
  private async resolvePlacementTarget(accountId: string | undefined): Promise<PlacementTarget> {
    if (accountId !== undefined) {
      const account = await this.config.accountRepository.get(accountKey(accountId));
      if (account === undefined) {
        throw new ResourceNotFoundError({
          message: `Account ${accountId} is not registered; register it with PutAccount first`,
        });
      }
      return {
        accounts: [account],
        accountsById: new Map([[accountId, account]]),
        candidateQuery: listCellsByAccountQuery(accountId),
        targeted: true,
      };
    }
    const vendorAccounts: AccountRecord[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.config.accountRepository.queryIndex(listAccountsQuery(), undefined, nextToken);
      nextToken = page.nextToken;
      vendorAccounts.push(...page.items.filter((account) => account.owner === AccountOwner.VENDOR));
    } while (nextToken !== undefined);
    vendorAccounts.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return {
      accounts: vendorAccounts,
      accountsById: new Map(vendorAccounts.map((account) => [account.accountId, account])),
      candidateQuery: listCellsQuery(),
      targeted: false,
    };
  }

  /**
   * §7 steps 1–2: nominate candidates from the index (eventually consistent
   * — never a guard; the conditional claim on the base table decides),
   * filter client-side for ACTIVE with free capacity in an eligible
   * account, and attempt at most {@link MAX_CLAIM_ATTEMPTS} claims, oldest
   * first. A lost race moves to the next candidate; an ambiguous outcome
   * fails the request — the same tenant is never retargeted. Returns a
   * {@link PlacementMiss} when no candidate was claimed (fall through to
   * new-cell creation), saying whether the miss was "no candidate" or
   * "budget spent on cells that still have room" — the caller needs the
   * difference to report a full fleet correctly (ADR-031).
   */
  private async placeIntoExistingCell(
    target: PlacementTarget,
    makeTenant: (cellId: string) => TenantRecord,
    updatedAt: string,
    idempotencyItem?: IdempotencyItem,
  ): Promise<PlacementResult | PlacementMiss> {
    let attempts = 0;
    let nextToken: string | undefined;
    do {
      const page = await this.config.cellRepository.queryIndex(
        target.candidateQuery,
        undefined,
        nextToken,
      );
      nextToken = page.nextToken;
      for (const cell of page.items) {
        // Client-side filter (§7 step 1): placement requires the cell ACTIVE
        // with free capacity — the same condition the claim re-checks — in
        // an eligible account (a tenant-owned account's cells are skipped by
        // an untargeted scan).
        const account = target.accountsById.get(cell.accountId);
        if (account === undefined || cell.status !== 'ACTIVE' || cell.tenantCount >= cell.maxTenants) {
          continue;
        }
        const tenant = makeTenant(cell.cellId);
        attempts += 1;
        try {
          await this.config.placement.placeTenantInCell({
            cellKey: cellKey(cell.cellId),
            tenant,
            updatedAt,
            clientRequestToken: ulid(),
            idempotencyItem,
          });
          return { cell, tenant, account };
        } catch (error) {
          if (error instanceof PlacementRaceLostError) {
            if (attempts >= MAX_CLAIM_ATTEMPTS) {
              // Candidate budget exhausted while capacity exists: fall
              // through to new-cell creation — over-provisioning rather
              // than a failed onboard (R-18). The caller learns that the
              // miss was the budget, not an empty fleet.
              return { budgetExhausted: true };
            }
            continue;
          }
          if (error instanceof DuplicateTokenError) {
            // Replay of an earlier CreateTenant — handled by the caller
            // (ADR-017), never converted to a 500.
            throw error;
          }
          // AmbiguousTransactionError (or anything else): the outcome is
          // unknown — fail the request; NEVER retarget this tenant (§6).
          throw new InternalServerError({
            message: `Tenant placement failed ambiguously: ${errorMessage(error)}`,
          });
        }
      }
    } while (nextToken !== undefined);
    return { budgetExhausted: false };
  }

  /**
   * §7 step 3: for each eligible account in order, one transaction claims a
   * cell slot on the account (`cellCount < maxCells`) and creates the cell
   * and the tenant. A refused account condition means the account is full
   * (or gone): try the next. When every eligible account refuses — or there
   * is none — the request fails with `InsufficientCapacityError` and
   * nothing was written (R-28, ADR-026). A duplicate idempotency token
   * propagates for the caller to replay; anything else is ambiguous.
   */
  private async createCellInEligibleAccount(
    target: PlacementTarget,
    makeTenant: (cellId: string) => TenantRecord,
    now: Date,
    idempotencyItem?: IdempotencyItem,
  ): Promise<{ cell: CellRecord; tenant: TenantRecord; account: AccountRecord }> {
    const definition = this.config.cellDefinition;
    for (const account of target.accounts) {
      const cell: CellRecord = {
        cellId: ulid(),
        accountId: account.accountId,
        status: 'CREATING',
        maxTenants: definition.maxTenants,
        tenantCount: 1,
        source: definition.source,
        cellScripts: definition.cellScripts,
        tenantScripts: definition.tenantScripts,
        createdAt: now,
        updatedAt: now,
      };
      const tenant = makeTenant(cell.cellId);
      try {
        await this.config.placement.createCellWithTenant({
          accountKey: accountKey(account.accountId),
          cell,
          tenant,
          updatedAt: now.toISOString(),
          clientRequestToken: ulid(),
          idempotencyItem,
        });
        return { cell, tenant, account };
      } catch (error) {
        if (error instanceof AccountFullError) {
          continue;
        }
        if (error instanceof DuplicateTokenError) {
          throw error;
        }
        // Any other new-cell transaction failure is ambiguous: fail the
        // request, never retarget the same tenant (§7).
        throw new InternalServerError({
          message: `Tenant placement failed ambiguously: ${errorMessage(error)}`,
        });
      }
    }
    throw new InsufficientCapacityError({
      message: target.targeted
        ? `Account ${target.accounts[0].accountId} has no free cell slot (cellCount = maxCells); raise maxCells with PutAccount or free a cell`
        : target.accounts.length === 0
          ? 'No vendor-owned account is registered; register one with PutAccount, or name a tenant-owned account in CreateTenant'
          : `Every vendor-owned account is full (${target.accounts.map((a) => `${a.accountId} ${a.cellCount}/${a.maxCells}`).join(', ')}); raise maxCells or register another account`,
    });
  }

  /**
   * ADR-017: replays the original CreateTenant outcome for a duplicate
   * `clientToken`, or rethrows when the error is not a replay. The
   * idempotency record is authoritative regardless of its `expiresAt` —
   * DynamoDB TTL is garbage collection, not semantics.
   */
  private async replayOrRethrow(
    error: unknown,
    clientToken: string | undefined,
    requestHash: string | undefined,
  ): Promise<CreateTenantServerOutput> {
    if (
      !(error instanceof DuplicateTokenError) ||
      clientToken === undefined ||
      requestHash === undefined
    ) {
      throw error;
    }
    const record = await this.config.idempotencyRepository.get(idempotencyKey(clientToken));
    if (record === undefined) {
      // The transaction saw the record but the read did not: TTL garbage
      // collection raced the replay. A retry (same or new token) onboards
      // a new tenant — surface the conflict rather than guessing.
      throw new ConflictError({
        message: 'clientToken was already used, but its idempotency record has expired — verify via ListTenants before retrying',
      });
    }
    if (record.requestHash !== requestHash) {
      throw new ConflictError({
        message: 'clientToken was already used with different request parameters',
      });
    }
    const tenant = await this.config.tenantRepository.get(tenantKey(record.tenantId));
    if (tenant === undefined) {
      throw new ConflictError({
        message: `clientToken was already used to onboard tenant ${record.tenantId}, which no longer exists — retry with a new token`,
      });
    }
    // The original outcome, whatever its current lifecycle status — a
    // CREATING tenant is polled as normal, a CREATE_FAILED one surfaces
    // the original failure.
    return { tenant: toSummary(tenant) };
  }

  // -------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------

  /** Reads a tenant or throws the modelled 404. */
  private async getTenantOrThrow(tenantId: string): Promise<TenantRecord> {
    const tenant = await this.config.tenantRepository.get(tenantKey(tenantId));
    if (tenant === undefined) {
      throw new ResourceNotFoundError({ message: `Tenant ${tenantId} not found` });
    }
    return tenant;
  }

  /** Reads a cell or throws the modelled 404. */
  private async getCellOrThrow(cellId: string): Promise<CellRecord> {
    const cell = await this.config.cellRepository.get(cellKey(cellId));
    if (cell === undefined) {
      throw new ResourceNotFoundError({ message: `Cell ${cellId} not found` });
    }
    return cell;
  }

  /** Reads an account or throws the modelled 404. */
  private async getAccountOrThrow(accountId: string): Promise<AccountRecord> {
    const account = await this.config.accountRepository.get(accountKey(accountId));
    if (account === undefined) {
      throw new ResourceNotFoundError({ message: `Account ${accountId} is not registered` });
    }
    return account;
  }

  /**
   * Resolves the account a cell lives in. Cell slot lifetime = cell record
   * lifetime and `DeleteAccount` refuses while `cellCount > 0` (ADR-024), so
   * a cell referencing a missing account is an invariant violation — an
   * internal error, never a client 404.
   */
  private async getAccountForCell(cell: CellRecord): Promise<AccountRecord> {
    const account = await this.config.accountRepository.get(accountKey(cell.accountId));
    if (account === undefined) {
      throw new InternalServerError({
        message: `Cell ${cell.cellId} references unregistered account ${cell.accountId}`,
      });
    }
    return account;
  }

  /**
   * Resolves the cell a tenant is placed in. Slot lifetime = tenant record
   * lifetime (ADR-013), so a tenant referencing a missing cell is an
   * invariant violation — an internal error, never a client 404.
   */
  private async getCellForTenant(tenant: TenantRecord): Promise<CellRecord> {
    const cell = await this.config.cellRepository.get(cellKey(tenant.cellId));
    if (cell === undefined) {
      throw new InternalServerError({
        message: `Tenant ${tenant.tenantId} references missing cell ${tenant.cellId}`,
      });
    }
    return cell;
  }

  /**
   * Compare-and-set tenant lifecycle transition on the operation's accepted
   * status set (§5). A stale transition (record concurrently mutated or
   * gone) maps to the 409.
   */
  private async transitionTenant(
    tenantId: string,
    fromAnyOf: readonly LifecycleStatus[],
    to: InFlightLifecycleStatus,
  ): Promise<TenantRecord> {
    try {
      return await this.config.tenantRepository.transitionStatus(tenantKey(tenantId), {
        fromAnyOf,
        to,
        updatedAt: new Date().toISOString(),
        removeFields: ['statusReason'],
      });
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw new ConflictError({
          message: `Tenant ${tenantId} was modified concurrently; re-read and retry`,
        });
      }
      throw error;
    }
  }

  /** Compare-and-set cell lifecycle transition — same discipline as the tenant's. */
  private async transitionCell(
    cellId: string,
    fromAnyOf: readonly LifecycleStatus[],
    to: InFlightLifecycleStatus,
  ): Promise<CellRecord> {
    try {
      return await this.config.cellRepository.transitionStatus(cellKey(cellId), {
        fromAnyOf,
        to,
        updatedAt: new Date().toISOString(),
        removeFields: ['statusReason'],
      });
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw new ConflictError({
          message: `Cell ${cellId} was modified concurrently; re-read and retry`,
        });
      }
      throw error;
    }
  }

  /** Single-CAS tenant compensation: in-flight status → the matching *_FAILED (§6). */
  private tenantCompensation(
    tenantId: string,
    inFlight: InFlightLifecycleStatus,
    failed: FailedLifecycleStatus,
  ): Compensation {
    return (reason) =>
      this.config.tenantRepository.transitionStatus(tenantKey(tenantId), {
        fromAnyOf: [inFlight],
        to: failed,
        updatedAt: new Date().toISOString(),
        setFields: { statusReason: reason },
      });
  }

  /** Single-CAS cell compensation: in-flight status → the matching *_FAILED (§6). */
  private cellCompensation(
    cellId: string,
    inFlight: InFlightLifecycleStatus,
    failed: FailedLifecycleStatus,
  ): Compensation {
    return (reason) =>
      this.config.cellRepository.transitionStatus(cellKey(cellId), {
        fromAnyOf: [inFlight],
        to: failed,
        updatedAt: new Date().toISOString(),
        setFields: { statusReason: reason },
      });
  }

  /**
   * Resolves the workflow's source fields from a cell's stamped definition.
   * `sourceVersion` is the stamped supply-chain pin (T5/M10) — the empty
   * string means unpinned, and the workflow's source-pin Choice then skips
   * the CodeBuild `SourceVersion` override (input contract, §7).
   */
  private workflowSource(
    cell: CellRecord,
  ): { sourceType: string; sourceLocation: string; sourceVersion: string } {
    const source: StampedSourceDefinition = cell.source;
    return {
      sourceType: requireField(source.type, 'cell.source.type'),
      sourceLocation: requireField(source.location, 'cell.source.location'),
      sourceVersion: source.sourceVersion ?? '',
    };
  }

  /**
   * Resolves the workflow's per-account fields (R-20, ADR-025): the account
   * id, its external id ('' when none — the buildspec then omits
   * `--external-id`), both provisioning role ARNs derived by name, the
   * operator id (M12), and the STS-safe session name (M23). All resolved at
   * accept time; the workflow rereads no record.
   */
  private workflowAccount(
    account: AccountRecord,
    context: CallerContext,
  ): Pick<
      ProvisioningWorkflowInput,
    'accountId' | 'externalId' | 'cellRoleArn' | 'tenantRoleArn' | 'operatorId' | 'sessionName'
    > {
    const { partition, fleetName } = this.config;
    return {
      accountId: account.accountId,
      externalId: account.externalId ?? '',
      cellRoleArn: provisioningRoleArn(partition, account.accountId, fleetName, 'cell'),
      tenantRoleArn: provisioningRoleArn(partition, account.accountId, fleetName, 'tenant'),
      operatorId: context.operatorId,
      sessionName: sessionNameFor(context.operatorId),
    };
  }

  /**
   * Starts provisioning; a rejected start is compensated exactly for the
   * in-flight state the operation created (§6). Compensation is best-effort
   * (ADR-011) — its own failure must not mask the original start failure.
   */
  private async startWorkflow(
    name: string,
    input: ProvisioningWorkflowInput,
    compensate: Compensation,
  ): Promise<void> {
    try {
      await this.config.sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn: this.config.stateMachineArn,
          // One execution per entity + operation attempt; timestamp keeps retries unique.
          name,
          input: JSON.stringify(input),
        }),
      );
    } catch (error) {
      const reason = `Failed to start provisioning workflow: ${errorMessage(error)}`;
      try {
        await compensate(reason);
      } catch {
        // Best-effort (ADR-011): surface the original start failure below.
      }
      throw error;
    }
  }
}

/** Projects the tenant domain record to the API summary (including its placement). */
function toSummary(record: TenantRecord): TenantSummary {
  return {
    tenantId: record.tenantId,
    name: record.name,
    description: record.description,
    cellId: record.cellId,
    status: record.status,
    statusReason: record.statusReason,
    lastBuildId: record.lastBuildId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Projects the account record to the API summary. The external id is never
 * returned (N-10) — only whether one is configured.
 */
function toAccountSummary(record: AccountRecord): AccountSummary {
  return {
    accountId: record.accountId,
    owner: record.owner,
    maxCells: record.maxCells,
    cellCount: record.cellCount,
    externalIdConfigured: record.externalId !== undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Projects the cell domain record to the API summary (stamped definition included). */
function toCellSummary(record: CellRecord): CellSummary {
  return {
    cellId: record.cellId,
    accountId: record.accountId,
    status: record.status,
    maxTenants: record.maxTenants,
    tenantCount: record.tenantCount,
    source: record.source,
    cellScripts: record.cellScripts,
    tenantScripts: record.tenantScripts,
    lastBuildId: record.lastBuildId,
    statusReason: record.statusReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
}

/**
 * Narrows a Smithy-optional input field. Required fields are enforced by the
 * generated validators before the operation runs - absence here is a
 * framework bug, not a client error.
 */
function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new InternalServerError({ message: `Validated input missing required field '${name}'` });
  }
  return value;
}

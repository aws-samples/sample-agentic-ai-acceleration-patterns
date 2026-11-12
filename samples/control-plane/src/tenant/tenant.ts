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
  APPLICATION_EMPTY_CONDITION,
  ApplicationItem,
  ApplicationRecord,
  applicationKey,
  DEFAULT_PLACEMENT_STRATEGY,
  listApplicationsQuery,
  putApplicationUpdate,
} from './application.data-model';
import {
  CellItem,
  CellRecord,
  cellKey,
  deleteCellTransition,
  listCellsByAccountQuery,
  listCellsByApplicationQuery,
  listCellsQuery,
} from './cell.data-model';
import {
  DeploymentItem,
  DeploymentRecord,
  deploymentKey,
  listDeploymentsByApplicationQuery,
  listDeploymentsByCellQuery,
  listDeploymentsByTenantQuery,
  listDeploymentsQuery,
} from './deployment.data-model';
import {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyDataModel,
  IdempotencyItem,
  IdempotencyRecord,
  createDeploymentRequestHash,
  idempotencyKey,
} from './idempotency.data-model';
import {
  TENANT_EMPTY_CONDITION,
  TENANT_NOT_EXISTS_CONDITION,
  TenantItem,
  TenantRecord,
  listTenantsQuery,
  tenantKey,
} from './tenant.data-model';
import { provisioningRoleArn, sessionNameFor } from '../shared/fleet';
import {
  AccountFullError,
  ApplicationGoneError,
  ConditionFailedError,
  DeploymentExistsError,
  DuplicateTokenError,
  DynamoDBRepository,
  GsiQuery,
  PlacementRaceLostError,
  PlacementTransactions,
  RecordGoneError,
  StaleTransitionError,
  TenantGoneError,
} from '../shared/repository';
import { CallerContext, ServiceConfig, sourcePinningWarning } from '../shared/service-config';
import {
  AccountOwner,
  AccountSummary,
  ApplicationSummary,
  CellSummary,
  ConflictError,
  CreateDeploymentServerInput,
  CreateDeploymentServerOutput,
  CreateTenantServerInput,
  CreateTenantServerOutput,
  DeleteAccountServerInput,
  DeleteAccountServerOutput,
  DeleteApplicationServerInput,
  DeleteApplicationServerOutput,
  DeleteCellServerInput,
  DeleteCellServerOutput,
  DeleteDeploymentServerInput,
  DeleteDeploymentServerOutput,
  DeleteTenantServerInput,
  DeleteTenantServerOutput,
  DeploymentSummary,
  GetAccountServerInput,
  GetAccountServerOutput,
  GetApplicationServerInput,
  GetApplicationServerOutput,
  GetCellServerInput,
  GetCellServerOutput,
  GetDeploymentServerInput,
  GetDeploymentServerOutput,
  GetTenantServerInput,
  GetTenantServerOutput,
  InsufficientCapacityError,
  InternalServerError,
  LifecycleStatus,
  ListAccountsServerInput,
  ListAccountsServerOutput,
  ListApplicationsServerInput,
  ListApplicationsServerOutput,
  ListCellsServerInput,
  ListCellsServerOutput,
  ListDeploymentsServerInput,
  ListDeploymentsServerOutput,
  ListTenantsServerInput,
  ListTenantsServerOutput,
  PlacementStrategy,
  PutAccountServerInput,
  PutAccountServerOutput,
  PutApplicationServerInput,
  PutApplicationServerOutput,
  ResourceNotFoundError,
  TenantServiceService,
  TenantSummary,
  UpdateCellServerInput,
  UpdateCellServerOutput,
  UpdateDeploymentServerInput,
  UpdateDeploymentServerOutput,
  UpdateTenantServerInput,
  UpdateTenantServerOutput,
  ValidationException,
} from '../smithy/source/typescript-ssdk-codegen/src';

/** Provisioning workflow operations (mirrors the lifecycle scripts). */
export type ProvisioningOperation = 'create' | 'update' | 'delete';

type FailedLifecycleStatus = 'CREATE_FAILED' | 'UPDATE_FAILED' | 'DELETE_FAILED';
type InFlightLifecycleStatus = 'CREATING' | 'UPDATING' | 'DELETING';

/** One optional build phase of the workflow input (§8). */
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
 * Resolved Step Functions execution input (ADR-011, spec R-20): the service
 * resolves sources, script paths, failure statuses and every id; the
 * workflow rereads no mutable records. `cellBuild`/`tenantBuild` are each
 * optional — the combination encodes the trigger (§8).
 */
interface ProvisioningWorkflowInput {
  readonly sourceType: string;
  readonly sourceLocation: string;
  /** The application the cell serves (ADR-032) — the cell-delete transaction releases its count. */
  readonly applicationId: string;
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
  /** The deployment's tenant — with `applicationId` it keys the deployment record (ADR-037). */
  readonly tenantId?: string;
  readonly tenantBuild?: TenantBuildPhaseInput;
}

/** Static configuration for the tenant service — built once at cold start. */
export interface TenantServiceConfig extends ServiceConfig {
  /** Repository over tenant items in the control plane table. */
  readonly tenantRepository: DynamoDBRepository<TenantRecord, TenantItem>;
  /** Repository over deployment items in the same table (ADR-037). */
  readonly deploymentRepository: DynamoDBRepository<DeploymentRecord, DeploymentItem>;
  /** Repository over cell items in the same table. */
  readonly cellRepository: DynamoDBRepository<CellRecord, CellItem>;
  /** Repository over CreateDeployment idempotency records (ADR-017). */
  readonly idempotencyRepository: DynamoDBRepository<IdempotencyRecord, IdempotencyItem>;
  /** The placement/compensation transaction shapes (§7). */
  readonly placement: PlacementTransactions<CellRecord, CellItem, DeploymentRecord, DeploymentItem>;
  /** Repository over account items in the same table (ADR-024). */
  readonly accountRepository: DynamoDBRepository<AccountRecord, AccountItem>;
  /** Repository over application items in the same table (ADR-032). */
  readonly applicationRepository: DynamoDBRepository<ApplicationRecord, ApplicationItem>;
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
  /**
   * Where the PutApplication supply-chain warning goes (ADR-020, ADR-032);
   * defaults to `console.warn`. Injectable for tests.
   */
  readonly warn?: (message: string) => void;
}

/** Statuses during which no lifecycle mutation may start. */
const IN_FLIGHT: LifecycleStatus[] = ['CREATING', 'UPDATING', 'DELETING'];

/**
 * Deployment statuses from which DeleteDeployment may transition to DELETING
 * (§5.2): ACTIVE and every *_FAILED state — regardless of cell status,
 * because the delete script is the cleanup path.
 */
const DEPLOYMENT_DELETABLE_STATUSES: readonly LifecycleStatus[] = [
  'ACTIVE',
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
];

/** Statuses from which an update (re-apply) build may start, for both entity types (§5). */
const UPDATABLE_STATUSES: readonly LifecycleStatus[] = ['ACTIVE', 'UPDATE_FAILED'];

/**
 * The placement candidate budget (§7, R-18): at most this many claim
 * attempts before falling through to new-cell creation. Keeps
 * CreateDeployment inside the synchronous API Gateway window; its miss case
 * over-provisions, never fails a placement.
 */
const MAX_CLAIM_ATTEMPTS = 5;

/** A best-effort compensation write for a rejected StartExecution (ADR-011, §7.4). */
type Compensation = (reason: string) => Promise<unknown>;

/**
 * §7 step 0 — the resolved placement target: the application being
 * deployed, the eligible accounts in placement order, the same accounts by
 * id (the eligibility filter for candidate cells), the candidate-cell query,
 * and whether the request named an account (shapes the capacity error).
 */
interface PlacementTarget {
  readonly application: ApplicationRecord;
  readonly accounts: readonly AccountRecord[];
  readonly accountsById: ReadonlyMap<string, AccountRecord>;
  readonly candidateQuery: GsiQuery;
  readonly targeted: boolean;
}

/** A deployment placed into an existing cell, with the account that hosts it. */
interface PlacementResult {
  readonly cell: CellRecord;
  readonly deployment: DeploymentRecord;
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
 * The cell-based control plane service. Implements the Smithy-generated
 * `TenantServiceService` interface (all twenty-two operations). Receives
 * static config in the constructor (cold start) and an immutable
 * `CallerContext` per operation — it never sees the raw event or a JWT
 * (context separation).
 */
export class TenantService implements TenantServiceService<CallerContext> {
  constructor(private readonly config: TenantServiceConfig) {}

  // -------------------------------------------------------------------
  // Tenant operations (§5.1) — all synchronous; a tenant is the customer
  // -------------------------------------------------------------------

  CreateTenant = async (
    input: CreateTenantServerInput,
    _context: CallerContext,
  ): Promise<CreateTenantServerOutput> => {
    const now = new Date();
    const tenant: TenantRecord = {
      tenantId: ulid(),
      name: requireField(input.name, 'name'),
      description: input.description,
      deploymentCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.config.tenantRepository.put(tenant, TENANT_NOT_EXISTS_CONDITION);
    } catch (error) {
      if (error instanceof ConditionFailedError) {
        // A fresh ULID collided — negligible, and the client retry mints
        // another. Never a client error.
        throw new InternalServerError({ message: `Tenant id ${tenant.tenantId} already exists; retry` });
      }
      throw error;
    }
    return { tenant: toTenantSummary(tenant) };
  };

  GetTenant = async (
    input: GetTenantServerInput,
    _context: CallerContext,
  ): Promise<GetTenantServerOutput> => {
    const tenant = await this.getTenantOrThrow(requireField(input.tenantId, 'tenantId'));
    return { tenant: toTenantSummary(tenant) };
  };

  UpdateTenant = async (
    input: UpdateTenantServerInput,
    _context: CallerContext,
  ): Promise<UpdateTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');

    // Metadata only (field-ownership write, ADR-011, R-21): the update never
    // touches `deploymentCount`, which the two counter paths own.
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
      return { tenant: toTenantSummary(updated) };
    } catch (error) {
      if (error instanceof RecordGoneError) {
        // The metadata write lost a race with a concurrent delete — 404, not
        // an unmodelled 500 (R-14).
        throw new ResourceNotFoundError({ message: `Tenant ${tenantId} not found` });
      }
      throw error;
    }
  };

  DeleteTenant = async (
    input: DeleteTenantServerInput,
    _context: CallerContext,
  ): Promise<DeleteTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const existing = await this.getTenantOrThrow(tenantId);

    // Empty tenants only (P-10): ONE conditional delete on
    // deploymentCount = 0 — the counterpart of the deployment claim
    // (ADR-037). A read-then-delete would let a concurrent CreateDeployment
    // claim the count in between; the condition rejects that as the 409.
    try {
      await this.config.tenantRepository.delete(tenantKey(tenantId), TENANT_EMPTY_CONDITION);
    } catch (error) {
      if (error instanceof ConditionFailedError) {
        throw new ConflictError({
          message: `Tenant ${tenantId} cannot be deleted — it still has deployments (delete them first with DeleteDeployment) or was modified concurrently`,
        });
      }
      throw error;
    }
    return { tenant: toTenantSummary(existing) };
  };

  ListTenants = async (
    input: ListTenantsServerInput,
    _context: CallerContext,
  ): Promise<ListTenantsServerOutput> => {
    const page = await this.config.tenantRepository.queryIndex(
      listTenantsQuery(),
      input.maxResults,
      input.nextToken,
    );
    return {
      tenants: page.items.map(toTenantSummary),
      nextToken: page.nextToken,
    };
  };

  // -------------------------------------------------------------------
  // Deployment operations (§5.2, ADR-037)
  // -------------------------------------------------------------------

  CreateDeployment = async (
    input: CreateDeploymentServerInput,
    context: CallerContext,
  ): Promise<CreateDeploymentServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const applicationId = requireField(input.applicationId, 'applicationId');
    // adminEmail is pass-through: workflow input only, never persisted (ADR-004).
    const adminEmail = requireField(input.adminEmail, 'adminEmail');
    const now = new Date();

    const clientToken = input.clientToken;
    const requestHash =
      clientToken === undefined
        ? undefined
        : createDeploymentRequestHash({ tenantId, applicationId, adminEmail, accountId: input.accountId });

    // A replay is recognised before anything else (§7.3): a token already
    // on record returns the original outcome even when the fleet has
    // changed since — an account narrowed or filled in between must not
    // turn the retry into a 400 or a capacity error. The read only
    // nominates; a token that lands between this read and the transaction
    // still cancels the transaction and is classified there (P-5).
    if (clientToken !== undefined && requestHash !== undefined) {
      const seen = await this.config.idempotencyRepository.get(idempotencyKey(clientToken));
      if (seen !== undefined) {
        return this.replayOrRethrow(
          new DuplicateTokenError('clientToken was already used by an earlier CreateDeployment'),
          clientToken,
          requestHash,
          tenantId,
          applicationId,
          seen,
        );
      }
    }

    // §7 step 0 — the tenant and the application must exist (404 otherwise).
    // The application record read here is the stamp for a new cell; the
    // tenant's name is forwarded to the build (ADR-023). Both existence
    // checks are repeated inside the transaction as conditions, so a delete
    // in between is still a 404 and never a phantom count.
    const tenant = await this.getTenantOrThrow(tenantId);
    const application = await this.getApplicationOrThrow(applicationId);

    // Optional idempotency (ADR-017): the item joins the placement
    // transaction, conditional on attribute_not_exists(PK). Its cancelled
    // condition marks the request as a replay of an earlier CreateDeployment.
    const idempotencyItem =
      clientToken === undefined || requestHash === undefined
        ? undefined
        : idempotencyDataModel.toItem({
          clientToken,
          tenantId,
          applicationId,
          requestHash,
          createdAt: now,
          expiresAt: Math.floor(now.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
        });

    const makeDeployment = (cellId: string): DeploymentRecord => ({
      tenantId,
      applicationId,
      cellId,
      status: 'CREATING',
      createdAt: now,
      updatedAt: now,
    });

    // §7 step 0 — TARGET: which accounts may host a new cell and which
    // existing cells are candidates. A named account is the only eligible
    // one (any owner; 404 if unregistered; 400 if it does not admit the
    // application); otherwise the vendor-owned accounts that admit the
    // application, dedicated before shared, ordered by the application's
    // placement strategy inside each group (ADR-033, ADR-035, ADR-036).
    const target = await this.resolvePlacementTarget(application, input.accountId);

    // §7 steps 1–2: candidate scan + bounded claim loop against existing cells.
    let placed: PlacementResult | PlacementMiss;
    try {
      placed = await this.placeIntoExistingCell(target, makeDeployment, now.toISOString(), idempotencyItem);
    } catch (error) {
      return this.replayOrRethrow(error, clientToken, requestHash, tenantId, applicationId);
    }

    let deployment: DeploymentRecord;
    let workflowInput: ProvisioningWorkflowInput;
    let compensate: Compensation;

    if ('cell' in placed) {
      // Existing cell: tenant create build only. Compensation is a single
      // CAS moving the deployment CREATING → CREATE_FAILED (§7.4).
      deployment = placed.deployment;
      workflowInput = {
        ...this.workflowCell(placed.cell),
        ...this.workflowAccount(placed.account, context),
        tenantId,
        tenantBuild: {
          operation: 'create',
          scriptPath: requireField(placed.cell.tenantScripts.create, 'cell.tenantScripts.create'),
          failedStatus: 'CREATE_FAILED',
          tenantName: tenant.name,
          adminEmail,
        },
      };
      compensate = this.deploymentCompensation(tenantId, applicationId, 'CREATING', 'CREATE_FAILED');
    } else {
      // §7 step 3 — no candidate claimed (none found or budget exhausted):
      // for each eligible account in order, one transaction claims a cell
      // slot on the account, counts the cell on the application, creates
      // the cell (CREATING, deployment slot pre-claimed, definition stamped
      // from the application record), counts the deployment on the tenant
      // and creates the deployment. Every account refusing →
      // InsufficientCapacityError (R-28), unless the claim budget was spent
      // on candidate cells: the fleet was changing under the request, so
      // the failure is a retryable ConflictError, not the terminal "raise
      // maxCells" (ADR-031).
      let created;
      try {
        created = await this.createCellInEligibleAccount(target, makeDeployment, now, idempotencyItem);
      } catch (error) {
        const failure =
          placed.budgetExhausted && error instanceof InsufficientCapacityError
            ? new ConflictError({
              message:
                  `Placement lost ${MAX_CLAIM_ATTEMPTS} claim races on candidate cells and no eligible account`
                  + ' has a free cell slot; nothing was written. Retry the request (spec R-18, ADR-031).',
            })
            : error;
        return this.replayOrRethrow(failure, clientToken, requestHash, tenantId, applicationId);
      }
      const { cell, account } = created;
      deployment = created.deployment;
      workflowInput = {
        ...this.workflowCell(cell),
        ...this.workflowAccount(account, context),
        cellBuild: {
          operation: 'create',
          scriptPath: requireField(cell.cellScripts.create, 'application.cellScripts.create'),
          failedStatus: 'CREATE_FAILED',
        },
        tenantId,
        tenantBuild: {
          operation: 'create',
          scriptPath: requireField(cell.tenantScripts.create, 'application.tenantScripts.create'),
          failedStatus: 'CREATE_FAILED',
          tenantName: tenant.name,
          adminEmail,
        },
      };
      // New-cell compensation is the paired transaction: BOTH records move
      // CREATING → CREATE_FAILED so compensation cannot leave only one
      // record recoverable (§7.4). Every counter stays held by the
      // CREATE_FAILED records until the remediation path releases it.
      compensate = (reason) =>
        this.config.placement.failCreatingCellAndDeployment({
          cellKey: cellKey(cell.cellId),
          deploymentKey: deploymentKey(tenantId, applicationId),
          statusReason: reason,
          updatedAt: new Date().toISOString(),
        });
    }

    // One execution per deployment + operation attempt; the timestamp keeps
    // retries unique. The verb is one letter so the name stays under Step
    // Functions' 80-character cap at a 32-character applicationId
    // (26 + 1 + 32 + 3 + 13 = 75).
    await this.startWorkflow(`${tenantId}-${applicationId}-c-${Date.now()}`, workflowInput, compensate);
    return { deployment: toDeploymentSummary(deployment) };
  };

  GetDeployment = async (
    input: GetDeploymentServerInput,
    _context: CallerContext,
  ): Promise<GetDeploymentServerOutput> => {
    const deployment = await this.getDeploymentOrThrow(
      requireField(input.tenantId, 'tenantId'),
      requireField(input.applicationId, 'applicationId'),
    );
    // The deployment's effective definition is the cell's stamped
    // definition (P-4) — resolved here, never stored on the deployment.
    const cell = await this.getCellForDeployment(deployment);
    return {
      deployment: toDeploymentSummary(deployment),
      source: cell.source,
      scripts: cell.tenantScripts,
      accountId: cell.accountId,
    };
  };

  UpdateDeployment = async (
    input: UpdateDeploymentServerInput,
    context: CallerContext,
  ): Promise<UpdateDeploymentServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const applicationId = requireField(input.applicationId, 'applicationId');
    const existing = await this.getDeploymentOrThrow(tenantId, applicationId);

    // Allowed from ACTIVE and UPDATE_FAILED only. From CREATE_FAILED the
    // remediation is delete + recreate — the create script never completed.
    if (!UPDATABLE_STATUSES.includes(existing.status)) {
      throw new ConflictError({
        message: `Deployment ${tenantId}/${applicationId} is ${existing.status}; it can be re-applied from ACTIVE or UPDATE_FAILED`,
      });
    }

    // Cross-entity guard (R-13): no tenant builds against a shared
    // deployment that is mid-change. This read-then-act check is the
    // documented tolerated one-directional guard — an overlap can fail a
    // build but never corrupts control plane state.
    const cell = await this.getCellForDeployment(existing);
    if (cell.status !== 'ACTIVE') {
      throw new ConflictError({
        message: `Cell ${cell.cellId} is ${cell.status}; the deployment can be re-applied only while its cell is ACTIVE`,
      });
    }

    const account = await this.getAccountForCell(cell);
    const tenant = await this.getTenantForDeployment(existing);
    const updating = await this.transitionDeployment(tenantId, applicationId, UPDATABLE_STATUSES, 'UPDATING');
    await this.startWorkflow(
      `${tenantId}-${applicationId}-u-${Date.now()}`,
      {
        ...this.workflowCell(cell),
        ...this.workflowAccount(account, context),
        tenantId,
        tenantBuild: {
          operation: 'update',
          scriptPath: requireField(cell.tenantScripts.update, 'cell.tenantScripts.update'),
          failedStatus: 'UPDATE_FAILED',
          tenantName: tenant.name,
          adminEmail: '',
        },
      },
      this.deploymentCompensation(tenantId, applicationId, 'UPDATING', 'UPDATE_FAILED'),
    );
    return { deployment: toDeploymentSummary(updating) };
  };

  DeleteDeployment = async (
    input: DeleteDeploymentServerInput,
    context: CallerContext,
  ): Promise<DeleteDeploymentServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const applicationId = requireField(input.applicationId, 'applicationId');
    const existing = await this.getDeploymentOrThrow(tenantId, applicationId);

    if (IN_FLIGHT.includes(existing.status)) {
      throw new ConflictError({
        message: `Deployment ${tenantId}/${applicationId} is ${existing.status}; wait for the operation to finish`,
      });
    }

    // Delete is allowed regardless of cell status (P-9) — the cell, account
    // and tenant records are read only to resolve the stamped source, the
    // tenant delete script, the provisioning role to assume and the tenant
    // name the script receives.
    const cell = await this.getCellForDeployment(existing);
    const account = await this.getAccountForCell(cell);
    const tenant = await this.getTenantForDeployment(existing);

    const deleting = await this.transitionDeployment(
      tenantId,
      applicationId,
      DEPLOYMENT_DELETABLE_STATUSES,
      'DELETING',
    );
    await this.startWorkflow(
      `${tenantId}-${applicationId}-d-${Date.now()}`,
      {
        ...this.workflowCell(cell),
        ...this.workflowAccount(account, context),
        tenantId,
        tenantBuild: {
          operation: 'delete',
          scriptPath: requireField(cell.tenantScripts.delete, 'cell.tenantScripts.delete'),
          failedStatus: 'DELETE_FAILED',
          tenantName: tenant.name,
          adminEmail: '',
        },
      },
      this.deploymentCompensation(tenantId, applicationId, 'DELETING', 'DELETE_FAILED'),
    );
    return { deployment: toDeploymentSummary(deleting) };
  };

  ListDeployments = async (
    input: ListDeploymentsServerInput,
    _context: CallerContext,
  ): Promise<ListDeploymentsServerOutput> => {
    // At most one filter (§5.2); each is a partition-pinned query (R-10). An
    // unknown id naturally yields an empty page — the filter is a query
    // predicate, not a resource lookup.
    requireAtMostOneFilter({
      tenantId: input.tenantId,
      cellId: input.cellId,
      applicationId: input.applicationId,
    });
    const repository = this.config.deploymentRepository;
    let page;
    if (input.tenantId !== undefined) {
      // A tenant's deployments share its base-table partition (§4.7).
      page = await repository.queryPartition(
        listDeploymentsByTenantQuery(input.tenantId),
        input.maxResults,
        input.nextToken,
      );
    } else {
      const query =
        input.cellId !== undefined
          ? listDeploymentsByCellQuery(input.cellId)
          : input.applicationId !== undefined
            ? listDeploymentsByApplicationQuery(input.applicationId)
            : listDeploymentsQuery();
      page = await repository.queryIndex(query, input.maxResults, input.nextToken);
    }
    return {
      deployments: page.items.map(toDeploymentSummary),
      nextToken: page.nextToken,
    };
  };

  // -------------------------------------------------------------------
  // Cell operations (§5.3)
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
    // Unfiltered listing uses GSI-1's static CELL partition; ?accountId=
    // uses the cells' GSI-2 ACCOUNT#<id> partition and ?applicationId= their
    // GSI-3 APPLICATION#<id> partition (§4.7). At most one filter (§5.3).
    requireAtMostOneFilter({ accountId: input.accountId, applicationId: input.applicationId });
    const query =
      input.accountId !== undefined
        ? listCellsByAccountQuery(input.accountId)
        : input.applicationId !== undefined
          ? listCellsByApplicationQuery(input.applicationId)
          : listCellsQuery();
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
    // would break the create/update script contract (§5.3). Remediation for
    // a failed cell create is deployment delete + cell delete.
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
        ...this.workflowCell(existing),
        ...this.workflowAccount(account, context),
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
        ...this.workflowCell(existing),
        ...this.workflowAccount(account, context),
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
  // Account operations (§5.4, ADR-024, ADR-027, ADR-033)
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

    // ADR-033: an allowlist names registered applications only (404
    // otherwise). An empty list would admit nothing — omit the field to
    // make the account shared.
    const applicationIds = input.applicationIds;
    if (applicationIds !== undefined) {
      if (applicationIds.length === 0) {
        throw new ValidationException({
          message: `Account ${accountId}: applicationIds must name at least one application, or be omitted to admit every application (ADR-033)`,
        });
      }
      for (const applicationId of applicationIds) {
        await this.getApplicationOrThrow(applicationId);
      }
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
          applicationIds,
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
  // Application operations (§5.5, ADR-032, ADR-036)
  // -------------------------------------------------------------------

  PutApplication = async (
    input: PutApplicationServerInput,
    _context: CallerContext,
  ): Promise<PutApplicationServerOutput> => {
    const applicationId = requireField(input.applicationId, 'applicationId');
    const source = requireField(input.source, 'source');
    const cellScripts = requireField(input.cellScripts, 'cellScripts');
    const tenantScripts = requireField(input.tenantScripts, 'tenantScripts');
    const maxTenants = requireField(input.maxTenants, 'maxTenants');
    // The generated validators have already enforced the definition's shape
    // (every script path non-empty, maxTenants >= 1, the id's charset) —
    // what remains is the supply-chain check, warn-and-allow (ADR-020): the
    // source is fetched fresh on every build, so an unpinned ref is logged
    // at registration, when the operator is present.
    const pinningWarning = sourcePinningWarning(source);
    if (pinningWarning !== undefined) {
      (this.config.warn ?? console.warn)(`PutApplication ${applicationId}: ${pinningWarning}`);
    }

    // One create-or-replace write (R-29): the definition and the strategy
    // are replaced, cellCount is never touched. Cells already stamped keep
    // their definition (P-4).
    const application = await this.config.applicationRepository.update(
      applicationKey(applicationId),
      putApplicationUpdate({
        applicationId,
        source: {
          type: requireField(source.type, 'source.type'),
          location: requireField(source.location, 'source.location'),
          sourceVersion: source.sourceVersion,
        },
        cellScripts: {
          create: requireField(cellScripts.create, 'cellScripts.create'),
          update: requireField(cellScripts.update, 'cellScripts.update'),
          delete: requireField(cellScripts.delete, 'cellScripts.delete'),
        },
        tenantScripts: {
          create: requireField(tenantScripts.create, 'tenantScripts.create'),
          update: requireField(tenantScripts.update, 'tenantScripts.update'),
          delete: requireField(tenantScripts.delete, 'tenantScripts.delete'),
        },
        maxTenants,
        placementStrategy: input.placementStrategy ?? DEFAULT_PLACEMENT_STRATEGY,
        now: new Date().toISOString(),
      }),
    );
    return { application: toApplicationSummary(application) };
  };

  GetApplication = async (
    input: GetApplicationServerInput,
    _context: CallerContext,
  ): Promise<GetApplicationServerOutput> => {
    const application = await this.getApplicationOrThrow(requireField(input.applicationId, 'applicationId'));
    return { application: toApplicationSummary(application) };
  };

  ListApplications = async (
    input: ListApplicationsServerInput,
    _context: CallerContext,
  ): Promise<ListApplicationsServerOutput> => {
    const page = await this.config.applicationRepository.queryIndex(
      listApplicationsQuery(),
      input.maxResults,
      input.nextToken,
    );
    return {
      applications: page.items.map(toApplicationSummary),
      nextToken: page.nextToken,
    };
  };

  DeleteApplication = async (
    input: DeleteApplicationServerInput,
    _context: CallerContext,
  ): Promise<DeleteApplicationServerOutput> => {
    const applicationId = requireField(input.applicationId, 'applicationId');
    const existing = await this.getApplicationOrThrow(applicationId);

    // Empty applications only (P-10): ONE conditional delete on
    // cellCount = 0 — the counterpart of the application's cell-count claim
    // (ADR-032). Accounts naming the application in their allowlist are left
    // alone: the id is inert once nothing can be placed for it (ADR-033).
    try {
      await this.config.applicationRepository.delete(applicationKey(applicationId), APPLICATION_EMPTY_CONDITION);
    } catch (error) {
      if (error instanceof ConditionFailedError) {
        throw new ConflictError({
          message: `Application ${applicationId} cannot be deregistered — it still has cells (delete them first) or was modified concurrently`,
        });
      }
      throw error;
    }
    return { application: toApplicationSummary(existing) };
  };

  // -------------------------------------------------------------------
  // Placement (§7)
  // -------------------------------------------------------------------

  /**
   * §7 step 0 — TARGET. With an `accountId`: that one registered account
   * (404 otherwise), any owner, which MUST admit the application (400
   * otherwise, ADR-033), and its cells as candidates. Without: every
   * vendor-owned account that admits the application — dedicated accounts
   * before shared ones (ADR-035), ordered inside each group by the
   * application's placement strategy (ADR-036) — and the application's
   * cells as candidates. The account records are read once here and
   * carried through: the workflow input needs the account's external id,
   * and the account map is what excludes ineligible accounts' cells from a
   * scan.
   */
  private async resolvePlacementTarget(
    application: ApplicationRecord,
    accountId: string | undefined,
  ): Promise<PlacementTarget> {
    const applicationId = application.applicationId;
    if (accountId !== undefined) {
      const account = await this.config.accountRepository.get(accountKey(accountId));
      if (account === undefined) {
        throw new ResourceNotFoundError({
          message: `Account ${accountId} is not registered; register it with PutAccount first`,
        });
      }
      if (!admits(account, applicationId)) {
        // The request names a wrong account, not a full one — a 400, not a
        // capacity error (ADR-033).
        throw new ValidationException({
          message:
            `Account ${accountId} does not admit application ${applicationId} (applicationIds = [${(account.applicationIds ?? []).join(', ')}]);`
            + ' name an account that admits it, or re-register the account with PutAccount',
        });
      }
      return {
        application,
        accounts: [account],
        accountsById: new Map([[accountId, account]]),
        candidateQuery: listCellsByAccountQuery(accountId),
        targeted: true,
      };
    }
    const eligible: AccountRecord[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.config.accountRepository.queryIndex(listAccountsQuery(), undefined, nextToken);
      nextToken = page.nextToken;
      eligible.push(
        ...page.items.filter((account) => account.owner === AccountOwner.VENDOR && admits(account, applicationId)),
      );
    } while (nextToken !== undefined);
    eligible.sort(accountOrder(application.placementStrategy));
    return {
      application,
      accounts: eligible,
      accountsById: new Map(eligible.map((account) => [account.accountId, account])),
      candidateQuery: listCellsByApplicationQuery(applicationId),
      targeted: false,
    };
  }

  /**
   * §7 steps 1–2: nominate candidates from the index (eventually consistent
   * — never a guard; the conditional claim on the base table decides),
   * filter client-side for the application's ACTIVE cells with free
   * capacity in an eligible account, and attempt at most
   * {@link MAX_CLAIM_ATTEMPTS} claims, oldest first. A lost race moves to
   * the next candidate; an ambiguous outcome fails the request — the same
   * deployment is never retargeted. Returns a {@link PlacementMiss} when no
   * candidate was claimed (fall through to new-cell creation), saying
   * whether the miss was "no candidate" or "budget spent on cells that
   * still have room" — the caller needs the difference to report a full
   * fleet correctly (ADR-031).
   */
  private async placeIntoExistingCell(
    target: PlacementTarget,
    makeDeployment: (cellId: string) => DeploymentRecord,
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
        // Client-side filter (§7 step 1): placement requires a cell of THIS
        // application (a targeted scan sees every application's cells in
        // the account), ACTIVE with free capacity — the same condition the
        // claim re-checks — in an eligible account.
        const account = target.accountsById.get(cell.accountId);
        if (
          account === undefined ||
          cell.applicationId !== target.application.applicationId ||
          cell.status !== 'ACTIVE' ||
          cell.tenantCount >= cell.maxTenants
        ) {
          continue;
        }
        const deployment = makeDeployment(cell.cellId);
        attempts += 1;
        try {
          await this.config.placement.placeDeploymentInCell({
            cellKey: cellKey(cell.cellId),
            tenantKey: tenantKey(deployment.tenantId),
            deployment,
            updatedAt,
            clientRequestToken: ulid(),
            idempotencyItem,
          });
          return { cell, deployment, account };
        } catch (error) {
          if (error instanceof PlacementRaceLostError) {
            if (attempts >= MAX_CLAIM_ATTEMPTS) {
              // Candidate budget exhausted on cells that read as ACTIVE
              // with room: fall through to new-cell creation —
              // over-provisioning rather than a failed placement (R-18).
              // The caller learns that the miss was the budget, not an
              // empty fleet.
              return { budgetExhausted: true };
            }
            continue;
          }
          // Classified cancellations (ADR-017, ADR-037) propagate for the
          // caller to map; never converted to a 500.
          if (
            error instanceof DuplicateTokenError ||
            error instanceof DeploymentExistsError ||
            error instanceof TenantGoneError
          ) {
            throw error;
          }
          // AmbiguousTransactionError (or anything else): the outcome is
          // unknown — fail the request; NEVER retarget this deployment (§7).
          throw new InternalServerError({
            message: `Deployment placement failed ambiguously: ${errorMessage(error)}`,
          });
        }
      }
    } while (nextToken !== undefined);
    return { budgetExhausted: false };
  }

  /**
   * §7 step 3: for each eligible account in order, one transaction claims a
   * cell slot on the account (`cellCount < maxCells`), counts the cell on
   * the application, and creates the cell (stamped from the application
   * record) and the deployment while counting it on the tenant. A refused
   * account condition means the account is full (or gone): try the next.
   * When every eligible account refuses — or there is none — the request
   * fails with `InsufficientCapacityError` and nothing was written (R-28,
   * ADR-026). Classified cancellations propagate for the caller; anything
   * else is ambiguous.
   */
  private async createCellInEligibleAccount(
    target: PlacementTarget,
    makeDeployment: (cellId: string) => DeploymentRecord,
    now: Date,
    idempotencyItem?: IdempotencyItem,
  ): Promise<{ cell: CellRecord; deployment: DeploymentRecord; account: AccountRecord }> {
    const { application } = target;
    for (const account of target.accounts) {
      const cell: CellRecord = {
        cellId: ulid(),
        applicationId: application.applicationId,
        accountId: account.accountId,
        status: 'CREATING',
        maxTenants: application.maxTenants,
        tenantCount: 1,
        source: application.source,
        cellScripts: application.cellScripts,
        tenantScripts: application.tenantScripts,
        createdAt: now,
        updatedAt: now,
      };
      const deployment = makeDeployment(cell.cellId);
      try {
        await this.config.placement.createCellWithDeployment({
          accountKey: accountKey(account.accountId),
          applicationKey: applicationKey(application.applicationId),
          cell,
          tenantKey: tenantKey(deployment.tenantId),
          deployment,
          updatedAt: now.toISOString(),
          clientRequestToken: ulid(),
          idempotencyItem,
        });
        return { cell, deployment, account };
      } catch (error) {
        if (error instanceof AccountFullError) {
          continue;
        }
        if (
          error instanceof DuplicateTokenError ||
          error instanceof DeploymentExistsError ||
          error instanceof TenantGoneError ||
          error instanceof ApplicationGoneError
        ) {
          throw error;
        }
        // Any other new-cell transaction failure is ambiguous: fail the
        // request, never retarget the same deployment (§7).
        throw new InternalServerError({
          message: `Deployment placement failed ambiguously: ${errorMessage(error)}`,
        });
      }
    }
    const applicationId = application.applicationId;
    throw new InsufficientCapacityError({
      message: target.targeted
        ? `Account ${target.accounts[0].accountId} has no free cell slot (cellCount = maxCells); raise maxCells with PutAccount or free a cell`
        : target.accounts.length === 0
          ? `No vendor-owned account admits application ${applicationId}; register one with PutAccount (or add ${applicationId} to an account's applicationIds), or name a tenant-owned account in CreateDeployment`
          : `Every vendor-owned account admitting application ${applicationId} is full (${target.accounts.map((a) => `${a.accountId} ${a.cellCount}/${a.maxCells}`).join(', ')}); raise maxCells or register another account`,
    });
  }

  /**
   * Maps the classified placement cancellations (§7.1 outcomes): a duplicate
   * `clientToken` replays the original CreateDeployment outcome (ADR-017),
   * an existing deployment is the 409, a vanished tenant or application the
   * 404; anything else is rethrown. The idempotency record is authoritative
   * regardless of its `expiresAt` — DynamoDB TTL is garbage collection, not
   * semantics.
   */
  private async replayOrRethrow(
    error: unknown,
    clientToken: string | undefined,
    requestHash: string | undefined,
    tenantId: string,
    applicationId: string,
    seen?: IdempotencyRecord,
  ): Promise<CreateDeploymentServerOutput> {
    if (error instanceof DeploymentExistsError) {
      throw new ConflictError({
        message: `Tenant ${tenantId} already has a deployment of application ${applicationId}; re-apply it with UpdateDeployment or delete it first`,
      });
    }
    if (error instanceof TenantGoneError) {
      throw new ResourceNotFoundError({ message: `Tenant ${tenantId} not found` });
    }
    if (error instanceof ApplicationGoneError) {
      throw new ResourceNotFoundError({ message: `Application ${applicationId} is not registered` });
    }
    if (
      !(error instanceof DuplicateTokenError) ||
      clientToken === undefined ||
      requestHash === undefined
    ) {
      throw error;
    }
    // The record read before placement is reused; a transaction-time
    // duplicate reads it now.
    const record = seen ?? (await this.config.idempotencyRepository.get(idempotencyKey(clientToken)));
    if (record === undefined) {
      // The transaction saw the record but the read did not: TTL garbage
      // collection raced the replay. Surface the conflict rather than
      // guessing.
      throw new ConflictError({
        message: 'clientToken was already used, but its idempotency record has expired — verify via ListDeployments before retrying',
      });
    }
    if (record.requestHash !== requestHash) {
      throw new ConflictError({
        message: 'clientToken was already used with different request parameters',
      });
    }
    const deployment = await this.config.deploymentRepository.get(
      deploymentKey(record.tenantId, record.applicationId),
    );
    if (deployment === undefined) {
      throw new ConflictError({
        message: `clientToken was already used to create deployment ${record.tenantId}/${record.applicationId}, which no longer exists — retry with a new token`,
      });
    }
    // The original outcome, whatever its current lifecycle status — a
    // CREATING deployment is polled as normal, a CREATE_FAILED one surfaces
    // the original failure.
    return { deployment: toDeploymentSummary(deployment) };
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

  /** Reads a deployment or throws the modelled 404. */
  private async getDeploymentOrThrow(tenantId: string, applicationId: string): Promise<DeploymentRecord> {
    const deployment = await this.config.deploymentRepository.get(deploymentKey(tenantId, applicationId));
    if (deployment === undefined) {
      throw new ResourceNotFoundError({
        message: `Tenant ${tenantId} has no deployment of application ${applicationId}`,
      });
    }
    return deployment;
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

  /** Reads an application or throws the modelled 404. */
  private async getApplicationOrThrow(applicationId: string): Promise<ApplicationRecord> {
    const application = await this.config.applicationRepository.get(applicationKey(applicationId));
    if (application === undefined) {
      throw new ResourceNotFoundError({
        message: `Application ${applicationId} is not registered; register it with PutApplication first`,
      });
    }
    return application;
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
   * Resolves the cell a deployment is placed in. Slot lifetime = deployment
   * record lifetime (ADR-013), so a deployment referencing a missing cell is
   * an invariant violation — an internal error, never a client 404.
   */
  private async getCellForDeployment(deployment: DeploymentRecord): Promise<CellRecord> {
    const cell = await this.config.cellRepository.get(cellKey(deployment.cellId));
    if (cell === undefined) {
      throw new InternalServerError({
        message: `Deployment ${deployment.tenantId}/${deployment.applicationId} references missing cell ${deployment.cellId}`,
      });
    }
    return cell;
  }

  /**
   * Resolves a deployment's tenant. `DeleteTenant` refuses while
   * `deploymentCount > 0` (ADR-037), so a deployment whose tenant is missing
   * is an invariant violation — an internal error, never a client 404.
   */
  private async getTenantForDeployment(deployment: DeploymentRecord): Promise<TenantRecord> {
    const tenant = await this.config.tenantRepository.get(tenantKey(deployment.tenantId));
    if (tenant === undefined) {
      throw new InternalServerError({
        message: `Deployment ${deployment.tenantId}/${deployment.applicationId} references missing tenant ${deployment.tenantId}`,
      });
    }
    return tenant;
  }

  /**
   * Compare-and-set deployment lifecycle transition on the operation's
   * accepted status set (R-12). A stale transition (record concurrently
   * mutated or gone) maps to the 409.
   */
  private async transitionDeployment(
    tenantId: string,
    applicationId: string,
    fromAnyOf: readonly LifecycleStatus[],
    to: InFlightLifecycleStatus,
  ): Promise<DeploymentRecord> {
    try {
      return await this.config.deploymentRepository.transitionStatus(deploymentKey(tenantId, applicationId), {
        fromAnyOf,
        to,
        updatedAt: new Date().toISOString(),
        removeFields: ['statusReason'],
      });
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw new ConflictError({
          message: `Deployment ${tenantId}/${applicationId} was modified concurrently; re-read and retry`,
        });
      }
      throw error;
    }
  }

  /** Compare-and-set cell lifecycle transition — same discipline as the deployment's. */
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

  /** Single-CAS deployment compensation: in-flight status → the matching *_FAILED (§7.4). */
  private deploymentCompensation(
    tenantId: string,
    applicationId: string,
    inFlight: InFlightLifecycleStatus,
    failed: FailedLifecycleStatus,
  ): Compensation {
    return (reason) =>
      this.config.deploymentRepository.transitionStatus(deploymentKey(tenantId, applicationId), {
        fromAnyOf: [inFlight],
        to: failed,
        updatedAt: new Date().toISOString(),
        setFields: { statusReason: reason },
      });
  }

  /** Single-CAS cell compensation: in-flight status → the matching *_FAILED (§7.4). */
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
   * Resolves the workflow's cell-derived fields (R-20): the source from the
   * cell's stamped definition — never from the application record — plus
   * the cell and application ids. `sourceVersion` is the stamped
   * supply-chain pin (T5/M10) — the empty string means unpinned, and the
   * workflow's source-pin Choice then skips the CodeBuild `SourceVersion`
   * override (input contract, §8).
   */
  private workflowCell(
    cell: CellRecord,
  ): Pick<ProvisioningWorkflowInput, 'sourceType' | 'sourceLocation' | 'sourceVersion' | 'cellId' | 'applicationId'> {
    return {
      sourceType: requireField(cell.source.type, 'cell.source.type'),
      sourceLocation: requireField(cell.source.location, 'cell.source.location'),
      sourceVersion: cell.source.sourceVersion ?? '',
      cellId: cell.cellId,
      applicationId: cell.applicationId,
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
   * in-flight state the operation created (§7.4). Compensation is
   * best-effort (ADR-011) — its own failure must not mask the original
   * start failure.
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

/** Whether an account admits an application: shared (no allowlist) or named in it (ADR-033). */
function admits(account: AccountRecord, applicationId: string): boolean {
  return account.applicationIds === undefined || account.applicationIds.includes(applicationId);
}

/**
 * The §7.1 step-3 account order: dedicated accounts (an allowlist is
 * present) before shared ones (ADR-035); inside each group `FILL` takes the
 * oldest registered first and `ROUND_ROBIN` the one with the fewest cells
 * first, ties oldest first (ADR-036). Both read `cellCount` as nominated —
 * the account's conditional claim is the guard.
 */
function accountOrder(strategy: PlacementStrategy): (a: AccountRecord, b: AccountRecord) => number {
  return (a, b) => {
    const groupA = a.applicationIds === undefined ? 1 : 0;
    const groupB = b.applicationIds === undefined ? 1 : 0;
    if (groupA !== groupB) {
      return groupA - groupB;
    }
    if (strategy === PlacementStrategy.ROUND_ROBIN && a.cellCount !== b.cellCount) {
      return a.cellCount - b.cellCount;
    }
    return a.createdAt.getTime() - b.createdAt.getTime();
  };
}

/** The list-filter rule (§5.2, §5.3): a filter is a partition; two filters are a 400. */
function requireAtMostOneFilter(filters: Record<string, string | undefined>): void {
  const given = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
  if (given.length > 1) {
    throw new ValidationException({
      message: `At most one filter per request; got ${given.join(' and ')}`,
    });
  }
}

/** Projects the tenant domain record to the API summary. */
function toTenantSummary(record: TenantRecord): TenantSummary {
  return {
    tenantId: record.tenantId,
    name: record.name,
    description: record.description,
    deploymentCount: record.deploymentCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Projects the deployment domain record to the API summary (including its placement). */
function toDeploymentSummary(record: DeploymentRecord): DeploymentSummary {
  return {
    tenantId: record.tenantId,
    applicationId: record.applicationId,
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
    applicationIds: record.applicationIds === undefined ? undefined : [...record.applicationIds],
    maxCells: record.maxCells,
    cellCount: record.cellCount,
    externalIdConfigured: record.externalId !== undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Projects the application record to the API summary. */
function toApplicationSummary(record: ApplicationRecord): ApplicationSummary {
  return {
    applicationId: record.applicationId,
    source: record.source,
    cellScripts: record.cellScripts,
    tenantScripts: record.tenantScripts,
    maxTenants: record.maxTenants,
    placementStrategy: record.placementStrategy,
    cellCount: record.cellCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Projects the cell domain record to the API summary (stamped definition included). */
function toCellSummary(record: CellRecord): CellSummary {
  return {
    cellId: record.cellId,
    applicationId: record.applicationId,
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

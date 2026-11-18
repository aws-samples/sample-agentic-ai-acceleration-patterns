// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { randomBytes } from 'crypto';
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { ulid } from 'ulid';
import {
  AccountItem,
  AccountPending,
  AccountRecord,
  accountKey,
  listAccountsQuery,
  putAccountUpdate,
  PutAccountPath,
} from './account.data-model';
import { HandshakeProbe, HandshakeRefusal, HandshakeUnavailableError } from './account.handshake';
import {
  ApplicationItem,
  ApplicationPending,
  ApplicationRecord,
  applicationKey,
  DEFAULT_PLACEMENT_STRATEGY,
  listApplicationsQuery,
  putApplicationUpdate,
  PutApplicationPath,
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
import { HookItem, hookCounterKey, hookKey, listHooksQuery, replaceHookUpdate } from './hook.data-model';
import {
  GlobalHookRecord,
  HookDefinition,
  HookExecutionInput,
  LastGlobalHookEntry,
  MAX_GLOBAL_HOOKS,
} from './hook.types';
import {
  hookPinningWarning,
  resolveHooks,
  validateApplicationDefinition,
  validateApplicationHooks,
  validateHookDefinition,
} from './hooks';
import {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyDataModel,
  IdempotencyItem,
  IdempotencyRecord,
  createDeploymentRequestHash,
  idempotencyKey,
} from './idempotency.data-model';
import {
  mergeCellParameters,
  mergeDeploymentParameters,
  ParameterValues,
  parametersAsReadCondition,
  resolveParameters,
  StoredCellParameterDeclaration,
  StoredParameterDeclaration,
  validateCreateParameters,
  validateDeclarations,
} from './parameters';
import {
  isLive,
  newOperationId,
  RecordEvent,
  RecordEventInput,
  recordEventEnvironment,
  RecordEventSubject,
  RecordEventWorkflowInput,
  recordCommit,
  RecordPending,
  RecordType,
  recordTypeOf,
} from './record-event.types';
import {
  compensateRecordTransition,
  deleteRecordTransition,
  freshInsertDeleteCondition,
  operationIdAsRead,
  RECORD_DELETABLE_STATUSES,
  RECORD_FAILED_STATUS,
  RECORD_UPDATABLE_STATUSES,
  RecordInFlightStatus,
  stageRecordTransition,
} from './record-writes';
import {
  TENANT_NOT_EXISTS_CONDITION,
  TenantItem,
  TenantPending,
  TenantRecord,
  listTenantsQuery,
  tenantKey,
} from './tenant.data-model';
import { provisioningRoleArn, sessionNameFor } from '../shared/fleet';
import { HookExistsError, HookGoneError, HookLimitError, HookTransactions } from '../shared/hook-transactions';
import {
  AccountFullError,
  AccountNotLiveError,
  AmbiguousTransactionError,
  ApplicationGoneError,
  ApplicationNotLiveError,
  ConditionFailedError,
  DeploymentExistsError,
  DuplicateTokenError,
  DynamoDBRepository,
  GsiQuery,
  ItemKey,
  PlacementRaceLostError,
  PlacementTransactions,
  RecordGoneError,
  StaleTransitionError,
  TenantGoneError,
  TenantNotLiveError,
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
  DeleteHookServerInput,
  DeleteHookServerOutput,
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
  GetHookServerInput,
  GetHookServerOutput,
  HookDefinition as ApiHookDefinition,
  HookSummary,
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
  ListHooksServerInput,
  ListHooksServerOutput,
  LastGlobalHook,
  ListTenantsServerInput,
  ListTenantsServerOutput,
  PlacementStrategy,
  PutAccountServerInput,
  PutAccountServerOutput,
  PutApplicationServerInput,
  PutApplicationServerOutput,
  PutHookServerInput,
  PutHookServerOutput,
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

/**
 * One optional build phase of the workflow input (§8). `parameters` is the
 * phase's resolved parameter set (R-32 for a tenant build, R-34 for a cell
 * build): the stored values plus the defaults of declared names without
 * one. The workflow passes each entry as `PARAM_<NAME>` and never re-reads
 * a record for it (R-20). Always present; `{}` when there is none.
 */
interface BuildPhaseInput {
  readonly operation: ProvisioningOperation;
  readonly scriptPath: string;
  readonly failedStatus: FailedLifecycleStatus;
  readonly parameters: ParameterValues;
  /**
   * The hooks of this build's event (spec R-40, R-45), resolved before the
   * operation's first write and already in run order. Always present, with
   * empty lists when no hook applies; the workflow runs it as given.
   */
  readonly hooks: HookExecutionInput;
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
  /** Repository over global hook items in the same table (ADR-044). */
  readonly hookRepository: DynamoDBRepository<GlobalHookRecord, HookItem>;
  /** The two transactions that touch the hook counter (P-6, R-39). */
  readonly hookTransactions: HookTransactions<GlobalHookRecord, HookItem>;
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
   * The Step Functions client of a record event's `StartExecution` (R-51), built with
   * `maxAttempts: 1`: with no SDK retry, a pre-creation error answers the one attempt
   * there was, so it is a definite refusal. `DescribeExecution` stays on `sfnClient`.
   */
  readonly recordStartClient: SFNClient;
  /**
   * Where the PutApplication and PutHook supply-chain warnings go (ADR-020, ADR-032, ADR-044);
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
 * `TenantServiceService` interface (all twenty-six operations). Receives
 * static config in the constructor (cold start) and an immutable
 * `CallerContext` per operation — it never sees the raw event or a JWT
 * (context separation).
 */
export class TenantService implements TenantServiceService<CallerContext> {
  constructor(private readonly config: TenantServiceConfig) {}

  // -------------------------------------------------------------------
  // Tenant operations (§5.1) — a tenant is the customer. The mutations run
  // no build but are asynchronous, so that hooks on tenant events can gate
  // them (§8.4, ADR-045).
  // -------------------------------------------------------------------

  CreateTenant = async (
    input: CreateTenantServerInput,
    context: CallerContext,
  ): Promise<CreateTenantServerOutput> => {
    const name = requireField(input.name, 'name');
    // R-40, R-48: the global hooks are read before the insert, so a failed
    // read is a 500 with nothing written.
    const globalHooks = await this.readGlobalHooks();
    const tenantId = ulid();
    const operationId = this.newOperationId(tenantId, 'TENANT_CREATE');
    const now = new Date();
    const tenant: TenantRecord = {
      tenantId,
      name,
      ...(input.description === undefined ? {} : { description: input.description }),
      deploymentCount: 0,
      // Not live until TENANT_CREATE's post hooks pass (R-47, R-50).
      status: LifecycleStatus.CREATING,
      operationId,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.config.tenantRepository.put(tenant, TENANT_NOT_EXISTS_CONDITION);
    } catch (error) {
      if (error instanceof ConditionFailedError) {
        // A fresh ULID collided — negligible, and the client retry mints
        // another. Never a client error.
        throw new InternalServerError({ message: `Tenant id ${tenantId} already exists; retry` });
      }
      throw error;
    }
    const accepted = await this.acceptRecordEvent({
      what: `Tenant ${tenantId}`,
      repository: this.config.tenantRepository,
      written: tenant,
      freshInsert: true,
      input: this.recordEventInput({
        event: 'TENANT_CREATE',
        recordId: tenantId,
        key: tenantKey(tenantId),
        operationId,
        globalHooks,
        subject: { recordType: 'TENANT', tenantId, tenantName: name },
        context,
      }),
    });
    return { tenant: toTenantSummary(accepted) };
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
    context: CallerContext,
  ): Promise<UpdateTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const what = `Tenant ${tenantId}`;
    const existing = await this.getTenantOrThrow(tenantId, { consistentRead: true });
    // R-48: from ACTIVE or UPDATE_FAILED only; in flight is a 409 with the
    // retry hint, CREATE_FAILED, DELETING or DELETE_FAILED one without (R-14).
    if (!RECORD_UPDATABLE_STATUSES.includes(existing.status)) {
      throw updateConflict(what, existing.status);
    }
    // Metadata only (R-21): `pending` holds the merged name and description
    // the commit makes live; an omitted field keeps its stored value. Never
    // `deploymentCount`, which the two counter paths own.
    const description = input.description ?? existing.description;
    const pending: TenantPending = {
      name: input.name ?? existing.name,
      ...(description === undefined ? {} : { description }),
    };
    const globalHooks = await this.readGlobalHooks();
    const operationId = this.newOperationId(tenantId, 'TENANT_UPDATE');
    let updating: TenantRecord;
    try {
      // ONE conditional write stages the values and moves the tenant to
      // UPDATING (R-48). The live name and description are not touched. The
      // operationId as read keeps the merge from landing on a record another
      // update has since committed.
      updating = await this.config.tenantRepository.transitionStatus(
        tenantKey(tenantId),
        stageRecordTransition({
          pending,
          operationId,
          updatedAt: new Date().toISOString(),
          extraCondition: operationIdAsRead(existing.operationId),
        }),
      );
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw staleUpdateFailure(what, error.current as TenantRecord | undefined);
      }
      throw error;
    }
    const accepted = await this.acceptRecordEvent({
      what,
      repository: this.config.tenantRepository,
      written: updating,
      freshInsert: false,
      input: this.recordEventInput({
        event: 'TENANT_UPDATE',
        recordId: tenantId,
        key: tenantKey(tenantId),
        operationId,
        globalHooks,
        subject: { recordType: 'TENANT', tenantId, tenantName: pending.name },
        pending,
        context,
      }),
    });
    return { tenant: toTenantSummary(accepted) };
  };

  DeleteTenant = async (
    input: DeleteTenantServerInput,
    context: CallerContext,
  ): Promise<DeleteTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const what = `Tenant ${tenantId}`;
    await this.getTenantOrThrow(tenantId);
    const globalHooks = await this.readGlobalHooks();
    const operationId = this.newOperationId(tenantId, 'TENANT_DELETE');

    // Empty tenants only (P-10, R-49): ONE conditional write moves the
    // tenant to DELETING on deploymentCount = 0 — the counterpart of the
    // deployment claim, which needs a live tenant (§7.1). The workflow runs
    // the TENANT_DELETE pre hooks, deletes the record, then the post hooks.
    const deleting = await this.moveRecordToDeleting(
      this.config.tenantRepository,
      'TENANT',
      tenantKey(tenantId),
      what,
      operationId,
      'it still has deployments (delete them first with DeleteDeployment)',
    );
    const accepted = await this.acceptRecordEvent({
      what,
      repository: this.config.tenantRepository,
      written: deleting,
      freshInsert: false,
      input: this.recordEventInput({
        event: 'TENANT_DELETE',
        recordId: tenantId,
        key: tenantKey(tenantId),
        operationId,
        globalHooks,
        subject: { recordType: 'TENANT', tenantId, tenantName: deleting.name },
        context,
      }),
    });
    return { tenant: toTenantSummary(accepted) };
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
        : createDeploymentRequestHash({
          tenantId,
          applicationId,
          adminEmail,
          accountId: input.accountId,
          parameters: input.parameters,
        });

    // A replay is recognised before anything else (§7.3): a token already
    // on record returns the original outcome even when the fleet has
    // changed since — an account narrowed or filled in between, or a
    // parameter made required, must not turn the retry into a 400 or a
    // capacity error. The read only
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
    // R-13: the tenant and the application must be live (R-47); the
    // placement transaction repeats the check as a condition.
    if (!isLive(tenant.status)) {
      throw notLiveConflict(`Tenant ${tenantId}`, tenant.status);
    }
    const application = await this.getApplicationOrThrow(applicationId);
    if (!isLive(application.status)) {
      throw notLiveConflict(`Application ${applicationId}`, application.status);
    }

    // R-33: the values are checked against the declarations just read -
    // after the replay read, before placement - and stored as supplied
    // (never a default). A 400 here writes nothing.
    const parameters = validateCreateParameters(input.parameters, application.parameters, application.cellParameters);

    // R-40, §7.1 step 0: the global hooks are read before the first write,
    // so a failed read is a 500 with nothing written. The application hooks
    // need no read: a new cell is stamped from the application record read
    // above, an existing one holds its own stamp.
    const globalHooks = await this.readGlobalHooks();

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
      parameters,
      createdAt: now,
      updatedAt: now,
    });
    // R-32: the tenant build's set is resolved at accept time from the
    // values just validated and the declarations they were validated
    // against.
    const tenantParameters = resolveParameters(parameters, application.parameters);

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
          parameters: tenantParameters,
          hooks: resolveHooks('DEPLOYMENT_CREATE', placed.cell.hooks, globalHooks),
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
          // R-34: a new cell has no values of its own - the defaults.
          parameters: resolveParameters(cell.parameters, application.cellParameters),
          // R-45: the cell event runs first, post hooks included, before the
          // deployment event's pre hooks start.
          hooks: resolveHooks('CELL_CREATE', cell.hooks, globalHooks),
        },
        tenantId,
        tenantBuild: {
          operation: 'create',
          scriptPath: requireField(cell.tenantScripts.create, 'application.tenantScripts.create'),
          failedStatus: 'CREATE_FAILED',
          parameters: tenantParameters,
          hooks: resolveHooks('DEPLOYMENT_CREATE', cell.hooks, globalHooks),
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
      // The application hooks stamped on the cell (R-31, §5.2).
      hooks: (cell.hooks ?? []).map(toApiHookDefinition),
      accountId: cell.accountId,
      // The supplied values only; defaults are not merged in (§5.2).
      parameters: { ...(deployment.parameters ?? {}) },
    };
  };

  UpdateDeployment = async (
    input: UpdateDeploymentServerInput,
    context: CallerContext,
  ): Promise<UpdateDeploymentServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const applicationId = requireField(input.applicationId, 'applicationId');
    const what = `Deployment ${tenantId}/${applicationId}`;
    const existing = await this.getDeploymentOrThrow(tenantId, applicationId);

    // R-33: the body is validated against the application's current
    // declarations, on the record just read and before the status check,
    // so a request that is both invalid and in flight is a 400 with
    // nothing written. The merge keeps every stored value it does not name.
    const application = await this.getApplicationForRecord(applicationId, what);
    const merged = mergeDeploymentParameters({
      stored: existing.parameters,
      set: input.parameters,
      remove: input.removeParameters,
      declarations: application.parameters,
      cellDeclarations: application.cellParameters,
    });

    // Allowed from ACTIVE and UPDATE_FAILED only. From CREATE_FAILED the
    // remediation is delete + recreate — the create script never completed.
    if (!UPDATABLE_STATUSES.includes(existing.status)) {
      throw updateConflict(what, existing.status);
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
    // R-40: read before the transitional write, so a failed read leaves
    // the record in its current status.
    const globalHooks = await this.readGlobalHooks();
    const updating = (await this.mergeTransition(
      this.config.deploymentRepository,
      deploymentKey(tenantId, applicationId),
      what,
      existing.parameters,
      merged,
    )) as DeploymentRecord;
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
          parameters: resolveParameters(merged, application.parameters),
          hooks: resolveHooks('DEPLOYMENT_UPDATE', cell.hooks, globalHooks),
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
    // R-32, P-9: cleanup runs with what is stored, never validated against
    // the current declarations; the application supplies defaults only.
    const declarations = (await this.config.applicationRepository.get(applicationKey(applicationId)))?.parameters;
    // R-40: read before the transitional write.
    const globalHooks = await this.readGlobalHooks();

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
          parameters: resolveParameters(existing.parameters, declarations),
          hooks: resolveHooks('DEPLOYMENT_DELETE', cell.hooks, globalHooks),
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
    // The operator-set values only; defaults are not merged in (§5.3).
    return { cell: toCellSummary(cell), parameters: { ...(cell.parameters ?? {}) } };
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
    const what = `Cell ${cellId}`;
    const existing = await this.getCellOrThrow(cellId);

    // R-34: validated against the application's current cellParameters
    // before the status check, then merged exactly as R-33 merges a
    // deployment's values.
    const application = await this.getApplicationForRecord(existing.applicationId, what);
    const merged = mergeCellParameters({
      stored: existing.parameters,
      set: input.parameters,
      remove: input.removeParameters,
      cellDeclarations: application.cellParameters,
      declarations: application.parameters,
    });

    // Allowed from ACTIVE/UPDATE_FAILED; 409 if in-flight or CREATE_FAILED —
    // re-running the update script against a half-created shared deployment
    // would break the create/update script contract (§5.3). Remediation for
    // a failed cell create is deployment delete + cell delete.
    if (!UPDATABLE_STATUSES.includes(existing.status)) {
      throw updateConflict(what, existing.status);
    }

    const account = await this.getAccountForCell(existing);
    // R-40: read before the transitional write.
    const globalHooks = await this.readGlobalHooks();
    // The map, not updatedAt, guards the write: placements and deployment
    // deletes write the cell's counter and updatedAt while it is ACTIVE and
    // must not fail an UpdateCell that has nothing to do with them (R-34).
    const updating = (await this.mergeTransition(
      this.config.cellRepository,
      cellKey(cellId),
      what,
      existing.parameters,
      merged,
    )) as CellRecord;
    await this.startWorkflow(
      `${cellId}-cell-update-${Date.now()}`,
      {
        ...this.workflowCell(existing),
        ...this.workflowAccount(account, context),
        cellBuild: {
          operation: 'update',
          scriptPath: requireField(existing.cellScripts.update, 'cell.cellScripts.update'),
          failedStatus: 'UPDATE_FAILED',
          parameters: resolveParameters(merged, application.cellParameters),
          hooks: resolveHooks('CELL_UPDATE', existing.hooks, globalHooks),
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
    // R-34: never validated; the application supplies defaults only.
    const cellDeclarations = (await this.config.applicationRepository.get(applicationKey(existing.applicationId)))
      ?.cellParameters;
    // R-40: read before the transitional write.
    const globalHooks = await this.readGlobalHooks();

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
          parameters: resolveParameters(existing.parameters, cellDeclarations),
          hooks: resolveHooks('CELL_DELETE', existing.hooks, globalHooks),
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
    const what = `Account ${accountId}`;

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
    // otherwise), each at most once, at most 100 of them (R-42 bounds
    // ACCOUNT_APPLICATION_IDS by it). An empty list would admit nothing —
    // omit the field to make the account shared. The generated validators
    // enforce the length and uniqueness too; this is defence in depth.
    const applicationIds = input.applicationIds;
    if (applicationIds !== undefined) {
      if (applicationIds.length === 0 || applicationIds.length > MAX_ACCOUNT_APPLICATION_IDS) {
        throw new ValidationException({
          message: `Account ${accountId}: applicationIds must name 1 to ${MAX_ACCOUNT_APPLICATION_IDS} applications, or be omitted to admit every application (ADR-033)`,
        });
      }
      if (new Set(applicationIds).size !== applicationIds.length) {
        throw new ValidationException({ message: `Account ${accountId}: applicationIds names an application twice` });
      }
      for (const applicationId of applicationIds) {
        await this.getApplicationOrThrow(applicationId);
      }
    }

    // The path comes from a strongly consistent read (R-48). Owner is
    // immutable (R-24), and a status that admits no put is a 409: both are
    // refused from the stored record before any STS traffic, so a
    // misdirected PutAccount costs no probe. The conditional write carries
    // the same checks for the race between this read and the write.
    const key = accountKey(accountId);
    let current = await this.config.accountRepository.get(key, { consistentRead: true });
    const request = { owner, maxCells, applicationIds };
    putAccountPath(what, current, request);

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

    const now = () => new Date().toISOString();
    const write = { accountId, owner, maxCells, applicationIds, externalId: input.externalId };
    let path = putAccountPath(what, current, request);
    if (path === 'ROTATE') {
      // R-48: a rotation on an UPDATING account writes externalId alone,
      // starts no execution and runs no hook, so a security rotation never
      // waits on a gate. A lost condition (the event ended, or another
      // began) reads the record once more and takes the path its new
      // status selects, without a second probe: the probe has passed.
      try {
        const rotated = await this.config.accountRepository.update(
          key,
          putAccountUpdate({ ...write, path, operationId: current?.operationId, now: now() }),
          { returnCurrentOnFailure: true },
        );
        return { account: toAccountSummary(rotated) };
      } catch (error) {
        if (!(error instanceof StaleTransitionError)) {
          throw error;
        }
        const failed = error.current as AccountRecord | undefined;
        if (failed !== undefined && failed.owner !== owner) {
          throw ownerImmutableError(accountId);
        }
      }
      current = await this.config.accountRepository.get(key, { consistentRead: true });
      path = putAccountPath(what, current, request);
      if (path === 'ROTATE') {
        try {
          const rotated = await this.config.accountRepository.update(
            key,
            putAccountUpdate({ ...write, path, operationId: current?.operationId, now: now() }),
            { returnCurrentOnFailure: true },
          );
          return { account: toAccountSummary(rotated) };
        } catch (error) {
          if (error instanceof StaleTransitionError) {
            throw putAccountFailure(accountId, owner, error.current as AccountRecord | undefined);
          }
          throw error;
        }
      }
    }

    // R-40: read after the probe, before the first write.
    const globalHooks = await this.readGlobalHooks();
    const event: RecordEvent = path === 'REPLACE' ? 'ACCOUNT_UPDATE' : 'ACCOUNT_CREATE';
    const operationId = this.newOperationId(accountId, event);
    let written: AccountRecord;
    try {
      // ONE conditional write (R-24, R-48): a create or a re-put writes the
      // policy fields into the record (CREATING); a replace writes
      // externalId into the record at once and stages maxCells and
      // applicationIds in pending (UPDATING). cellCount is never touched.
      written = await this.config.accountRepository.update(
        key,
        putAccountUpdate({ ...write, path, operationId, now: now() }),
        { returnCurrentOnFailure: true },
      );
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw putAccountFailure(accountId, owner, error.current as AccountRecord | undefined);
      }
      throw error;
    }
    const pending: AccountPending | undefined = path === 'REPLACE'
      ? { maxCells, ...(applicationIds === undefined ? {} : { applicationIds: [...applicationIds] }) }
      : undefined;
    const accepted = await this.acceptRecordEvent({
      what,
      repository: this.config.accountRepository,
      written,
      freshInsert: path === 'CREATE',
      input: this.recordEventInput({
        event,
        recordId: accountId,
        key,
        operationId,
        globalHooks,
        // The values being written: the request's (R-42).
        subject: { recordType: 'ACCOUNT', accountId, owner, applicationIds },
        pending,
        context,
      }),
    });
    return { account: toAccountSummary(accepted) };
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
    context: CallerContext,
  ): Promise<DeleteAccountServerOutput> => {
    const accountId = requireField(input.accountId, 'accountId');
    const what = `Account ${accountId}`;
    await this.getAccountOrThrow(accountId);
    const globalHooks = await this.readGlobalHooks();
    const operationId = this.newOperationId(accountId, 'ACCOUNT_DELETE');

    // Empty accounts only (P-10, R-49): ONE conditional write moves the
    // account to DELETING on cellCount = 0 — the counterpart of the
    // cell-slot claim, which needs a live account (§7.1). The account's
    // roles stay installed; removing them is the owner's act.
    const deleting = await this.moveRecordToDeleting(
      this.config.accountRepository,
      'ACCOUNT',
      accountKey(accountId),
      what,
      operationId,
      'it still holds cells (delete them first)',
    );
    const accepted = await this.acceptRecordEvent({
      what,
      repository: this.config.accountRepository,
      written: deleting,
      freshInsert: false,
      input: this.recordEventInput({
        event: 'ACCOUNT_DELETE',
        recordId: accountId,
        key: accountKey(accountId),
        operationId,
        globalHooks,
        // The stored values (R-42).
        subject: { recordType: 'ACCOUNT', accountId, owner: deleting.owner, applicationIds: deleting.applicationIds },
        context,
      }),
    });
    return { account: toAccountSummary(accepted) };
  };

  // -------------------------------------------------------------------
  // Application operations (§5.5, ADR-032, ADR-036)
  // -------------------------------------------------------------------

  PutApplication = async (
    input: PutApplicationServerInput,
    context: CallerContext,
  ): Promise<PutApplicationServerOutput> => {
    const applicationId = requireField(input.applicationId, 'applicationId');
    const source = requireField(input.source, 'source');
    const cellScripts = requireField(input.cellScripts, 'cellScripts');
    const tenantScripts = requireField(input.tenantScripts, 'tenantScripts');
    const maxTenants = requireField(input.maxTenants, 'maxTenants');
    const what = `Application ${applicationId}`;
    const sourceDefinition = {
      type: requireField(source.type, 'source.type'),
      location: requireField(source.location, 'source.location'),
      ...(source.sourceVersion === undefined ? {} : { sourceVersion: source.sourceVersion }),
    };
    const cellScriptPaths = {
      create: requireField(cellScripts.create, 'cellScripts.create'),
      update: requireField(cellScripts.update, 'cellScripts.update'),
      delete: requireField(cellScripts.delete, 'cellScripts.delete'),
    };
    const tenantScriptPaths = {
      create: requireField(tenantScripts.create, 'tenantScripts.create'),
      update: requireField(tenantScripts.update, 'tenantScripts.update'),
      delete: requireField(tenantScripts.delete, 'tenantScripts.delete'),
    };

    // §4.1, R-39 (ADR-044): the source and every script path are held to the
    // hook charsets, and each hook definition to R-39, before any read. A
    // list that is not sent stays undefined: it is kept (R-29).
    validateApplicationDefinition(applicationId, sourceDefinition, {
      cellScripts: cellScriptPaths,
      tenantScripts: tenantScriptPaths,
    });
    const hooks = validateApplicationHooks(input.hooks, applicationId);

    // The path comes from a strongly consistent read (R-48): no record, a
    // create; CREATE_FAILED, a re-put; a live record, a replace staged in
    // pending; CREATING, UPDATING, DELETING or DELETE_FAILED, a 409. A list
    // the request does not send is kept (R-29, §5.5): the "one name in one
    // list" check runs against the kept list, and the write is conditioned
    // on it being unchanged. On a new application an absent list declares
    // none.
    const key = applicationKey(applicationId);
    const current = await this.config.applicationRepository.get(key, { consistentRead: true });
    // Validation first, so a request that is both invalid and in flight is
    // a 400 (R-48); then the path, whose refusal is the 409.
    const declarations = validateDeclarations({
      parameters: input.parameters,
      cellParameters: input.cellParameters,
      keptParameters: current?.parameters,
      keptCellParameters: current?.cellParameters,
    });
    const path = putApplicationPath(what, current);

    // The generated validators have already enforced the definition's shape
    // (every script path non-empty, maxTenants >= 1, the id's charset) —
    // what remains is the supply-chain check, warn-and-allow (ADR-020): the
    // source is fetched fresh on every build, so an unpinned ref is logged
    // at registration, when the operator is present.
    const pinningWarning = sourcePinningWarning(source);
    if (pinningWarning !== undefined) {
      (this.config.warn ?? console.warn)(`PutApplication ${applicationId}: ${pinningWarning}`);
    }
    for (const hook of hooks ?? []) {
      const hookWarning = hookPinningWarning(hook);
      if (hookWarning !== undefined) {
        (this.config.warn ?? console.warn)(`PutApplication ${applicationId}: ${hookWarning}`);
      }
    }

    // The values the write makes live (create, re-put) or stages (replace):
    // the definition and the strategy always, each list only when sent.
    const values: ApplicationPending = {
      source: sourceDefinition,
      cellScripts: cellScriptPaths,
      tenantScripts: tenantScriptPaths,
      maxTenants,
      placementStrategy: input.placementStrategy ?? DEFAULT_PLACEMENT_STRATEGY,
      ...(declarations.parameters === undefined ? {} : { parameters: declarations.parameters }),
      ...(declarations.cellParameters === undefined ? {} : { cellParameters: declarations.cellParameters }),
      ...(hooks === undefined ? {} : { hooks }),
    };
    // R-40: read before the write.
    const globalHooks = await this.readGlobalHooks();
    const event: RecordEvent = path === 'REPLACE' ? 'APPLICATION_UPDATE' : 'APPLICATION_CREATE';
    const operationId = this.newOperationId(applicationId, event);

    // ONE conditional write on every path (R-29, R-48), cellCount never
    // touched. Cells already stamped keep their definition (P-4).
    let written: ApplicationRecord;
    try {
      written = await this.config.applicationRepository.update(
        key,
        putApplicationUpdate({ path, applicationId, operationId, values, read: current, now: new Date().toISOString() }),
        { returnCurrentOnFailure: true },
      );
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw putApplicationFailure(what, error.current as ApplicationRecord | undefined);
      }
      throw error;
    }
    const accepted = await this.acceptRecordEvent({
      what,
      repository: this.config.applicationRepository,
      written,
      freshInsert: path === 'CREATE',
      input: this.recordEventInput({
        event,
        recordId: applicationId,
        key,
        operationId,
        // R-40: the hooks of the definition being written — the request's
        // when it sent them, the stored list otherwise.
        applicationHooks: hooks ?? current?.hooks,
        globalHooks,
        subject: { recordType: 'APPLICATION', applicationId },
        pending: path === 'REPLACE' ? values : undefined,
        context,
      }),
    });
    return { application: toApplicationSummary(accepted) };
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
    context: CallerContext,
  ): Promise<DeleteApplicationServerOutput> => {
    const applicationId = requireField(input.applicationId, 'applicationId');
    const what = `Application ${applicationId}`;
    await this.getApplicationOrThrow(applicationId);
    const globalHooks = await this.readGlobalHooks();
    const operationId = this.newOperationId(applicationId, 'APPLICATION_DELETE');

    // Empty applications only (P-10, R-49): ONE conditional write moves the
    // application to DELETING on cellCount = 0 — the counterpart of the
    // cell-slot claim, which needs a live application (§7.1). Accounts
    // naming the application in their allowlist are left alone: the id is
    // inert once nothing can be placed for it (ADR-033).
    const deleting = await this.moveRecordToDeleting(
      this.config.applicationRepository,
      'APPLICATION',
      applicationKey(applicationId),
      what,
      operationId,
      'it still has cells (delete them first)',
    );
    const accepted = await this.acceptRecordEvent({
      what,
      repository: this.config.applicationRepository,
      written: deleting,
      freshInsert: false,
      input: this.recordEventInput({
        event: 'APPLICATION_DELETE',
        recordId: applicationId,
        key: applicationKey(applicationId),
        operationId,
        // R-40: the stored list, as the DELETING write left it.
        applicationHooks: deleting.hooks,
        globalHooks,
        subject: { recordType: 'APPLICATION', applicationId },
        context,
      }),
    });
    return { application: toApplicationSummary(accepted) };
  };

  // -------------------------------------------------------------------
  // Hook operations (§5.5, §4.8, ADR-044) - global hooks, operator-only writes
  // -------------------------------------------------------------------

  PutHook = async (
    input: PutHookServerInput,
    _context: CallerContext,
  ): Promise<PutHookServerOutput> => {
    const hookId = requireField(input.hookId, 'hookId');
    // R-39: the whole definition is validated before anything is read or
    // written (400). The timeout is stored resolved.
    const definition = validateHookDefinition({ ...input, hookId }, `Hook ${hookId}`);
    const pinningWarning = hookPinningWarning(definition);
    if (pinningWarning !== undefined) {
      (this.config.warn ?? console.warn)(`PutHook ${hookId}: ${pinningWarning}`);
    }

    // R-39: the path - create or replace - is chosen from a strongly
    // consistent read; the writes below decide (P-5).
    const key = hookKey(hookId);
    const existing = await this.config.hookRepository.get(key, { consistentRead: true });
    const now = new Date();
    if (existing === undefined) {
      const hook: GlobalHookRecord = { ...definition, revision: 1, createdAt: now, updatedAt: now };
      try {
        // ONE transaction: the hook inserted and hookCount claimed (P-6).
        await this.config.hookTransactions.createHook({
          hook,
          counterKey: hookCounterKey(),
          maxHooks: MAX_GLOBAL_HOOKS,
          updatedAt: now.toISOString(),
        });
      } catch (error) {
        throw mapHookWriteError(hookId, error);
      }
      return { hook: toHookSummary(hook) };
    }
    try {
      // ONE update conditioned on the hook's existence: revision + 1. The
      // counter is untouched.
      const replaced = await this.config.hookRepository.updateExisting(key, replaceHookUpdate(definition, now.toISOString()));
      return { hook: toHookSummary(replaced) };
    } catch (error) {
      throw mapHookWriteError(hookId, error);
    }
  };

  GetHook = async (
    input: GetHookServerInput,
    _context: CallerContext,
  ): Promise<GetHookServerOutput> => {
    return { hook: toHookSummary(await this.getHookOrThrow(requireField(input.hookId, 'hookId'))) };
  };

  ListHooks = async (
    input: ListHooksServerInput,
    _context: CallerContext,
  ): Promise<ListHooksServerOutput> => {
    // Pinned to the static HOOK partition (R-10); hookId order is the order
    // global hooks run in (R-45).
    const page = await this.config.hookRepository.queryPartition(
      listHooksQuery(),
      input.maxResults,
      input.nextToken,
    );
    return { hooks: page.items.map(toHookSummary), nextToken: page.nextToken };
  };

  DeleteHook = async (
    input: DeleteHookServerInput,
    _context: CallerContext,
  ): Promise<DeleteHookServerOutput> => {
    const hookId = requireField(input.hookId, 'hookId');
    const existing = await this.getHookOrThrow(hookId);
    try {
      // ONE transaction: the hook deleted (it must exist) and hookCount
      // released (it must be above zero) (P-6, R-39). No guard on
      // executions in flight: each runs the snapshot it was accepted with.
      await this.config.hookTransactions.deleteHook({
        hookKey: hookKey(hookId),
        counterKey: hookCounterKey(),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof HookGoneError) {
        throw new ResourceNotFoundError({ message: `Hook ${hookId} is not registered` });
      }
      if (error instanceof AmbiguousTransactionError) {
        throw new InternalServerError({ message: `Hook ${hookId}: the delete could not be confirmed (${errorMessage(error)})` });
      }
      throw error;
    }
    return { hook: toHookSummary(existing) };
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
      if (!isLive(account.status)) {
        throw notLiveConflict(`Account ${accountId}`, account.status);
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
        ...page.items.filter((account) =>
          account.owner === AccountOwner.VENDOR && isLive(account.status) && admits(account, applicationId)),
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
            error instanceof TenantGoneError ||
            error instanceof TenantNotLiveError
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
        // R-40, P-4: the application's hook list at this moment, immutable
        // for the cell's lifetime.
        hooks: application.hooks ?? [],
        // R-34, §7.1 step 3: no request supplies cell values at birth; the
        // cell starts on the defaults, resolved per build.
        parameters: {},
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
        if (error instanceof AccountNotLiveError) {
          // §7.1: a targeted account refused for its status, not its
          // capacity, is a ConflictError, never InsufficientCapacityError.
          if (target.targeted) {
            throw notLiveConflict(`Account ${account.accountId}`, error.status);
          }
          continue;
        }
        if (
          error instanceof DuplicateTokenError ||
          error instanceof DeploymentExistsError ||
          error instanceof TenantGoneError ||
          error instanceof TenantNotLiveError ||
          error instanceof ApplicationGoneError ||
          error instanceof ApplicationNotLiveError
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
    if (error instanceof TenantNotLiveError) {
      throw notLiveConflict(`Tenant ${tenantId}`, error.status);
    }
    if (error instanceof ApplicationNotLiveError) {
      throw notLiveConflict(`Application ${applicationId}`, error.status);
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
  // Record events (§8.4, R-48 to R-51, ADR-045)
  // -------------------------------------------------------------------

  /**
   * The `operationId` of a newly accepted record operation and the name of
   * its execution (R-51): the record id, the event and the accept time in
   * milliseconds, plus 8 random hex characters so two operations accepted
   * in the same millisecond on two hosts never share a name.
   */
  private newOperationId(recordId: string, event: RecordEvent): string {
    return newOperationId(recordId, event, Date.now(), randomBytes(4).toString('hex'));
  }

  /**
   * The execution input of one record event (R-50, §8.1): the hooks in run
   * order (application hooks only for an application event, R-40), the
   * event-level hook environment (R-42) and the commit's field names,
   * decided now, never the values.
   */
  private recordEventInput(params: {
    readonly event: RecordEvent;
    readonly recordId: string;
    readonly key: ItemKey;
    readonly operationId: string;
    readonly applicationHooks?: readonly HookDefinition[];
    readonly globalHooks: readonly GlobalHookRecord[];
    readonly subject: RecordEventSubject;
    readonly pending?: RecordPending;
    readonly context: CallerContext;
  }): RecordEventInput {
    const { event, operationId } = params;
    return {
      event,
      recordType: recordTypeOf(event),
      recordId: params.recordId,
      key: params.key,
      operationId,
      hooks: resolveHooks(event, params.applicationHooks, params.globalHooks),
      environment: recordEventEnvironment({
        event,
        subject: params.subject,
        operatorId: params.context.operatorId,
        operationId,
      }),
      commit: recordCommit(event, params.pending),
    };
  }

  /**
   * R-49: the ONE conditional write that moves an application, a tenant or
   * an account to `DELETING`, conditioned on a deletable status and its
   * count still 0, storing the operation's `operationId`. A failure is
   * classified from the item that failed it (`ALL_OLD`, R-14): no item is
   * the 404; an in-flight record a 409 with the retry hint; an occupied or
   * `DELETING` one a 409 without it.
   */
  private async moveRecordToDeleting<TRecord extends { readonly status: LifecycleStatus }>(
    repository: RecordRepository<TRecord>,
    recordType: RecordType,
    key: ItemKey,
    what: string,
    operationId: string,
    occupied: string,
  ): Promise<TRecord> {
    try {
      return await repository.transitionStatus(key, deleteRecordTransition(recordType, operationId, new Date().toISOString()));
    } catch (error) {
      if (!(error instanceof StaleTransitionError)) {
        throw error;
      }
      const failed = error.current as (TRecord & Record<string, unknown>) | undefined;
      if (failed === undefined) {
        throw new ResourceNotFoundError({ message: `${what} no longer exists` });
      }
      if (failed.status === 'CREATING' || failed.status === 'UPDATING') {
        throw new ConflictError({ message: `${what} is ${failed.status}; ${RETRY_HINT} once it has finished` });
      }
      if (RECORD_DELETABLE_STATUSES.includes(failed.status)) {
        throw new ConflictError({ message: `${what} cannot be deleted: ${occupied}` });
      }
      throw new ConflictError({ message: `${what} is ${failed.status}; it is already being deleted` });
    }
  }

  /**
   * Starts the execution of an accepted record operation and, when the
   * start did not go through, compensates the exact in-flight state (R-51).
   * Returns the record to answer 202 with: the one the operation wrote when
   * the start went through, or the one a compensation found the execution
   * had already moved on. Every other outcome is a 500, with the record
   * compensated:
   *
   * - a fresh insert whose start was refused is deleted again (conditioned
   *   on `CREATING`, the `operationId` and a count of 0);
   * - a fresh insert whose start is unknown, and every re-put, goes to
   *   `CREATE_FAILED`, never deleted: an execution may be running its
   *   create hooks, and only the record's delete runs the delete hooks;
   * - `UPDATING` goes to `UPDATE_FAILED` with `pending` removed (only while
   *   `pending` exists), `DELETING` to `DELETE_FAILED`.
   *
   * A compensation whose condition fails reads the record once: the same
   * `operationId` in a status the execution writes (`ACTIVE` or the
   * matching `*_FAILED`), or `UPDATING` without `pending` (committed, post
   * hooks running), or the record gone after a delete, means the execution
   * ran, and the request answers 202 with the record as read (the
   * `DELETING` record for a delete).
   */
  private async acceptRecordEvent<TRecord extends RecordEventRecord>(params: {
    readonly what: string;
    readonly repository: RecordRepository<TRecord>;
    /** The record as the operation's conditional write left it. */
    readonly written: TRecord;
    /** The write inserted a record where none was (not a re-put). */
    readonly freshInsert: boolean;
    readonly input: RecordEventInput;
  }): Promise<TRecord> {
    const { what, repository, written, input } = params;
    const outcome = await this.startRecordWorkflow(input.operationId, { recordEvent: input });
    if (outcome.kind === 'STARTED') {
      return written;
    }
    const inFlight = written.status as RecordInFlightStatus;
    const reason =
      `${input.event}: the workflow start ${outcome.kind === 'REFUSED' ? 'was refused' : 'had an unknown outcome'}`
      + ` (${errorMessage(outcome.error)})`;
    const deleteFresh = params.freshInsert && outcome.kind === 'REFUSED';
    try {
      if (deleteFresh) {
        await repository.delete(input.key, freshInsertDeleteCondition(input.recordType, input.operationId));
      } else {
        await repository.transitionStatus(
          input.key,
          compensateRecordTransition({
            inFlight,
            operationId: input.operationId,
            statusReason: reason,
            updatedAt: new Date().toISOString(),
          }),
        );
      }
    } catch (error) {
      if (!(error instanceof ConditionFailedError)) {
        // The residual of §7.4 (T47): the record stays in flight.
        throw new InternalServerError({
          message: `${what}: ${reason}, and its compensation failed too (${errorMessage(error)}); the record stays ${inFlight}`,
        });
      }
      const read = await repository.get(input.key, { consistentRead: true });
      if (read === undefined ? inFlight === 'DELETING' : executionRan(read, input.operationId, inFlight)) {
        return read ?? written;
      }
      throw new InternalServerError({ message: `${what}: ${reason}; the record changed meanwhile and was left as it is` });
    }
    throw new InternalServerError({
      message: deleteFresh
        ? `${what}: ${reason}; nothing was kept, ${RETRY_HINT}`
        : `${what}: ${reason}; the record is ${RECORD_FAILED_STATUS[inFlight]}`,
    });
  }

  /**
   * Starts a record event's execution under its `operationId` and says
   * whether the start went through (R-51). `REFUSED` only when this call
   * itself answered with an error Step Functions raises before it creates
   * an execution. The call goes through `recordStartClient`, which makes
   * one attempt, so the error answers that attempt (an error after an SDK
   * retry would prove nothing about the earlier one). `STARTED` when the call
   * succeeded, or answered `ExecutionAlreadyExists` (only this operation
   * starts executions under this name and input), or when the outcome was
   * unknown and `DescribeExecution` finds the execution or a retry under
   * the same name answers with it. Everything else is `UNKNOWN`:
   * `DescribeExecution` is eventually consistent, so a miss proves nothing.
   */
  private async startRecordWorkflow(name: string, input: RecordEventWorkflowInput): Promise<StartOutcome> {
    const start = () =>
      this.config.recordStartClient.send(
        new StartExecutionCommand({
          stateMachineArn: this.config.stateMachineArn,
          name,
          input: JSON.stringify(input),
        }),
      );
    let unknown: unknown;
    try {
      await start();
      return { kind: 'STARTED' };
    } catch (error) {
      if (isExecutionAlreadyExists(error)) {
        return { kind: 'STARTED' };
      }
      if (isStartRefusal(error)) {
        return { kind: 'REFUSED', error };
      }
      unknown = error;
    }
    try {
      await this.config.sfnClient.send(
        new DescribeExecutionCommand({ executionArn: executionArnOf(this.config.stateMachineArn, name) }),
      );
      return { kind: 'STARTED' };
    } catch {
      // ExecutionDoesNotExist or a failed call: proves nothing.
    }
    try {
      // The same name and input: Step Functions answers with the running
      // execution, or ExecutionAlreadyExists once it has closed.
      await start();
      return { kind: 'STARTED' };
    } catch (error) {
      if (isExecutionAlreadyExists(error)) {
        return { kind: 'STARTED' };
      }
    }
    return { kind: 'UNKNOWN', error: unknown };
  }

  // -------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------

  /** Reads a tenant or throws the modelled 404. */
  private async getTenantOrThrow(
    tenantId: string,
    options?: { readonly consistentRead?: boolean },
  ): Promise<TenantRecord> {
    const tenant = await this.config.tenantRepository.get(tenantKey(tenantId), options);
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

  /** Reads a global hook (strongly consistent) or throws the modelled 404. */
  private async getHookOrThrow(hookId: string): Promise<GlobalHookRecord> {
    const hook = await this.config.hookRepository.get(hookKey(hookId), { consistentRead: true });
    if (hook === undefined) {
      throw new ResourceNotFoundError({ message: `Hook ${hookId} is not registered` });
    }
    return hook;
  }

  /**
   * Reads every global hook in one strongly consistent query of the `HOOK`
   * partition (R-40, §4.7), in `hookId` order. Runs before the operation's
   * first write: a failed read is a 500 with nothing written, never a
   * record left in flight with no execution. At most five hooks exist, so
   * one page holds them; the loop is a guard, not a scan.
   */
  private async readGlobalHooks(): Promise<GlobalHookRecord[]> {
    const hooks: GlobalHookRecord[] = [];
    try {
      let nextToken: string | undefined;
      do {
        const page = await this.config.hookRepository.queryPartition(listHooksQuery(), undefined, nextToken);
        hooks.push(...page.items);
        nextToken = page.nextToken;
      } while (nextToken !== undefined);
    } catch (error) {
      throw new InternalServerError({
        message: `The global hooks could not be read, so the operation was not started and nothing was written; ${RETRY_HINT} (${errorMessage(error)})`,
      });
    }
    return hooks;
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

  /**
   * The `UPDATING` transition of `UpdateDeployment` and `UpdateCell` that
   * carries the parameter merge (R-33, R-34): ONE conditional `UpdateItem`
   * writing the whole merged map (`SET #parameters = :parameters`, never a
   * per-name path, which is invalid on a record with no map yet), guarded
   * by the status AND by the map being exactly as read. A failure is
   * classified from the item DynamoDB returns with it (`ALL_OLD`, R-14).
   * The cell-`ACTIVE` guard of `UpdateDeployment` stays a read before this
   * write (R-13); the cell is never a member of it.
   */
  private async mergeTransition<TRecord extends { readonly status: LifecycleStatus }>(
    repository: DynamoDBRepository<TRecord, DeploymentItem> | DynamoDBRepository<TRecord, CellItem>,
    key: ItemKey,
    what: string,
    read: ParameterValues | undefined,
    merged: ParameterValues,
  ): Promise<TRecord> {
    try {
      return await repository.transitionStatus(key, {
        fromAnyOf: UPDATABLE_STATUSES,
        to: 'UPDATING',
        updatedAt: new Date().toISOString(),
        setFields: { parameters: merged },
        removeFields: ['statusReason'],
        extraCondition: parametersAsReadCondition(read),
        returnCurrentOnFailure: true,
      });
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw mergeFailure(what, error.current as { readonly status: LifecycleStatus } | undefined);
      }
      throw error;
    }
  }

  /**
   * Reads the application a deployment or cell belongs to, for its
   * declarations. Both hold a count on the application (`DeleteApplication`
   * refuses while `cellCount > 0`), so a missing application is an
   * invariant violation — an internal error, never a client 404.
   */
  private async getApplicationForRecord(applicationId: string, what: string): Promise<ApplicationRecord> {
    const application = await this.config.applicationRepository.get(applicationKey(applicationId));
    if (application === undefined) {
      throw new InternalServerError({ message: `${what} references unregistered application ${applicationId}` });
    }
    return application;
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

/** Projects the tenant domain record to the API summary, its status and any staged update included (§5.1). */
function toTenantSummary(record: TenantRecord): TenantSummary {
  return {
    tenantId: record.tenantId,
    name: record.name,
    description: record.description,
    deploymentCount: record.deploymentCount,
    status: record.status,
    statusReason: record.statusReason,
    lastGlobalHooks: (record.lastGlobalHooks ?? []).map(toLastGlobalHook),
    operationId: record.operationId,
    pending: record.pending === undefined
      ? undefined
      : { name: record.pending.name, description: record.pending.description },
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
    lastGlobalHooks: (record.lastGlobalHooks ?? []).map(toLastGlobalHook),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Projects the account record to the API summary. The external id is never
 * returned (N-10) — only whether one is configured; `pending` holds
 * `maxCells` and `applicationIds` only (§5.4).
 */
function toAccountSummary(record: AccountRecord): AccountSummary {
  return {
    accountId: record.accountId,
    owner: record.owner,
    applicationIds: record.applicationIds === undefined ? undefined : [...record.applicationIds],
    maxCells: record.maxCells,
    cellCount: record.cellCount,
    externalIdConfigured: record.externalId !== undefined,
    status: record.status,
    statusReason: record.statusReason,
    lastGlobalHooks: (record.lastGlobalHooks ?? []).map(toLastGlobalHook),
    operationId: record.operationId,
    pending: record.pending === undefined
      ? undefined
      : {
        maxCells: record.pending.maxCells,
        applicationIds: record.pending.applicationIds === undefined ? undefined : [...record.pending.applicationIds],
      },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Projects the application record to the API summary, its status and any staged replace included (§5.5). */
function toApplicationSummary(record: ApplicationRecord): ApplicationSummary {
  const { pending } = record;
  return {
    applicationId: record.applicationId,
    source: record.source,
    cellScripts: record.cellScripts,
    tenantScripts: record.tenantScripts,
    maxTenants: record.maxTenants,
    placementStrategy: record.placementStrategy,
    parameters: toApiParameterDeclarations(record.parameters ?? []),
    cellParameters: toApiCellParameterDeclarations(record.cellParameters ?? []),
    hooks: (record.hooks ?? []).map(toApiHookDefinition),
    cellCount: record.cellCount,
    status: record.status,
    statusReason: record.statusReason,
    lastGlobalHooks: (record.lastGlobalHooks ?? []).map(toLastGlobalHook),
    operationId: record.operationId,
    pending: pending === undefined
      ? undefined
      : {
        source: pending.source,
        cellScripts: pending.cellScripts,
        tenantScripts: pending.tenantScripts,
        maxTenants: pending.maxTenants,
        placementStrategy: pending.placementStrategy,
        parameters: pending.parameters === undefined ? undefined : toApiParameterDeclarations(pending.parameters),
        cellParameters: pending.cellParameters === undefined ? undefined : toApiCellParameterDeclarations(pending.cellParameters),
        hooks: pending.hooks?.map(toApiHookDefinition),
      },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toApiParameterDeclarations(declarations: readonly StoredParameterDeclaration[]) {
  return declarations.map((declaration) => ({
    name: declaration.name,
    required: declaration.required,
    default: declaration.default,
    description: declaration.description,
  }));
}

function toApiCellParameterDeclarations(declarations: readonly StoredCellParameterDeclaration[]) {
  return declarations.map((declaration) => ({
    name: declaration.name,
    default: declaration.default,
    description: declaration.description,
  }));
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
    hooks: (record.hooks ?? []).map(toApiHookDefinition),
    lastBuildId: record.lastBuildId,
    lastGlobalHooks: (record.lastGlobalHooks ?? []).map(toLastGlobalHook),
    statusReason: record.statusReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Projects a stored hook definition (global or stamped) to the API shape; the timeout is always resolved. */
function toApiHookDefinition(hook: HookDefinition): ApiHookDefinition {
  return {
    hookId: hook.hookId,
    events: [...hook.events],
    phase: hook.phase,
    source: {
      type: hook.source.type,
      location: hook.source.location,
      sourceVersion: hook.source.sourceVersion,
    },
    script: hook.script,
    timeoutMinutes: hook.timeoutMinutes,
  };
}

/** Projects the global hook record to the API summary. */
function toHookSummary(record: GlobalHookRecord): HookSummary {
  return {
    hookId: record.hookId,
    events: [...record.events],
    phase: record.phase,
    source: toApiHookDefinition(record).source,
    script: record.script,
    timeoutMinutes: record.timeoutMinutes,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Projects one `lastGlobalHooks` entry (R-40); the two ref fields only when set. */
function toLastGlobalHook(entry: LastGlobalHookEntry): LastGlobalHook {
  return {
    hookId: entry.hookId,
    phase: entry.phase,
    revision: entry.revision,
    sourceVersion: entry.sourceVersion,
    resolvedSourceVersion: entry.resolvedSourceVersion,
  };
}

/**
 * Maps a failed `PutHook` write to its 409 (R-39, R-14): a create that met a
 * new hook, or a replace that met a delete, lost a race with the same hook
 * and a retry succeeds; a create the counter refuses has the remedy
 * `DeleteHook`, so its message carries no retry hint.
 */
function mapHookWriteError(hookId: string, error: unknown): unknown {
  if (error instanceof HookExistsError) {
    return new ConflictError({
      message: `Hook ${hookId} was created by a concurrent request; ${RETRY_HINT} to replace it`,
    });
  }
  if (error instanceof RecordGoneError) {
    return new ConflictError({
      message: `Hook ${hookId} was deleted by a concurrent request; ${RETRY_HINT} to create it again`,
    });
  }
  if (error instanceof HookLimitError) {
    return new ConflictError({
      message: `${MAX_GLOBAL_HOOKS} global hooks are registered, the maximum; delete one with DeleteHook before registering another`,
    });
  }
  if (error instanceof AmbiguousTransactionError) {
    return new InternalServerError({ message: `Hook ${hookId}: the write could not be confirmed (${errorMessage(error)})` });
  }
  return error;
}

/**
 * The retry hint of a 409 (R-14). The ConflictError shape carries only a
 * message, so the hint is this phrase in it: present when a retry can
 * succeed, absent when the remedy is a delete.
 */
const RETRY_HINT = 'retry the request';

/**
 * The 409 for an update (re-apply) refused by the record's status. In
 * flight (`CREATING`, `UPDATING`) it ends in a state the update admits, so
 * the message carries the retry hint; from `CREATE_FAILED`,
 * `DELETE_FAILED` or `DELETING` a retry cannot succeed and the remedy is a
 * delete (R-14).
 */
function updateConflict(what: string, status: LifecycleStatus): ConflictError {
  if (status === 'CREATING' || status === 'UPDATING') {
    return new ConflictError({ message: `${what} is ${status}; ${RETRY_HINT} once it has finished` });
  }
  return new ConflictError({
    message: `${what} is ${status}; it can be re-applied from ACTIVE or UPDATE_FAILED only, so a retry cannot succeed and the remedy is a delete`,
  });
}

/**
 * Classifies a failed parameter-merge write from the item that failed it
 * (`ALL_OLD`, R-14): no item means the record was deleted (404); a status
 * the update admits means the stored map changed since the read (409,
 * retry); any other status is {@link updateConflict}.
 */
function mergeFailure(what: string, current: { readonly status: LifecycleStatus } | undefined): Error {
  if (current === undefined) {
    return new ResourceNotFoundError({ message: `${what} no longer exists` });
  }
  if (UPDATABLE_STATUSES.includes(current.status)) {
    return new ConflictError({
      message: `${what}: its parameter values changed after this request read them; re-read and ${RETRY_HINT}`,
    });
  }
  return updateConflict(what, current.status);
}

/** The most applications an account's allowlist may name (§4.5): it bounds `ACCOUNT_APPLICATION_IDS` (R-42). */
const MAX_ACCOUNT_APPLICATION_IDS = 100;

/** A record whose operations run record events (§8.4): application, tenant or account. */
interface RecordEventRecord {
  readonly status: LifecycleStatus;
  readonly operationId?: string;
  readonly pending?: unknown;
}

/** The repository of an application, a tenant or an account. */
type RecordRepository<TRecord> =
  | DynamoDBRepository<TRecord, TenantItem>
  | DynamoDBRepository<TRecord, AccountItem>
  | DynamoDBRepository<TRecord, ApplicationItem>;

/** What a record event's workflow start came to (R-51). */
type StartOutcome =
  | { readonly kind: 'STARTED' }
  | { readonly kind: 'REFUSED' | 'UNKNOWN'; readonly error: unknown };

/**
 * The errors Step Functions answers `StartExecution` with before it creates
 * an execution (R-51): validation, throttling, limit, access and
 * missing-state-machine errors. Never `ExecutionAlreadyExists`, which means
 * an execution under the name exists.
 */
const START_REFUSALS: ReadonlySet<string> = new Set([
  'ValidationException',
  'InvalidArn',
  'InvalidName',
  'InvalidExecutionInput',
  'ExecutionLimitExceeded',
  'StateMachineDoesNotExist',
  'StateMachineDeleting',
  'ThrottlingException',
  'AccessDeniedException',
  'KmsAccessDeniedException',
  'KmsInvalidStateException',
  'KmsThrottlingException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'ExpiredTokenException',
]);

/**
 * Whether a failed `StartExecution` was refused before an execution existed
 * (R-51): a pre-creation error on the call's only attempt. `recordStartClient`
 * makes one attempt; the attempt count still guards a client that retried,
 * because after a retried attempt the earlier one's outcome is unknown and
 * the same error proves nothing.
 */
function isStartRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || !START_REFUSALS.has(error.name)) {
    return false;
  }
  const attempts = (error as { $metadata?: { attempts?: number } }).$metadata?.attempts;
  return attempts === undefined || attempts <= 1;
}

function isExecutionAlreadyExists(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExecutionAlreadyExists';
}

/** The ARN of the execution named `name` of the state machine `stateMachineArn`. */
function executionArnOf(stateMachineArn: string, name: string): string {
  return `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;
}

/**
 * Whether a record read after a failed compensation shows that the
 * operation's execution ran (R-51): its `operationId` in `ACTIVE` or the
 * in-flight status's `*_FAILED` status, or `UPDATING` without `pending`
 * (the commit landed and the post hooks are running).
 */
function executionRan(record: RecordEventRecord, operationId: string, inFlight: RecordInFlightStatus): boolean {
  if (record.operationId !== operationId) {
    return false;
  }
  return record.status === 'ACTIVE'
    || record.status === RECORD_FAILED_STATUS[inFlight]
    || (inFlight === 'UPDATING' && record.status === 'UPDATING' && record.pending === undefined);
}

/**
 * The 409 for a deployment claim on a tenant, an application or an account
 * that is not live (R-13, R-14): a retry hint only when it is `CREATING`,
 * which ends live; from `CREATE_FAILED`, `DELETING` or `DELETE_FAILED` a
 * retry cannot succeed and the remedy is the record's own (§5.6).
 */
function notLiveConflict(what: string, status: LifecycleStatus | undefined): ConflictError {
  if (status === 'CREATING') {
    return new ConflictError({ message: `${what} is CREATING; poll it to ACTIVE, then ${RETRY_HINT}` });
  }
  return new ConflictError({
    message: status === undefined
      ? `${what} was deleted meanwhile; a retry cannot succeed`
      : `${what} is ${status}, not live; a retry cannot succeed, the remedy is the record's own (spec §5.6)`,
  });
}

/**
 * The path of a `PutApplication` from the record it read (R-48): none, a
 * create; `CREATE_FAILED`, a re-put; live, a replace; any other status a
 * 409, with the retry hint while `CREATING` or `UPDATING` (R-14).
 */
function putApplicationPath(what: string, current: ApplicationRecord | undefined): PutApplicationPath {
  if (current === undefined) {
    return 'CREATE';
  }
  if (current.status === 'CREATE_FAILED') {
    return 'RE_PUT';
  }
  if (RECORD_UPDATABLE_STATUSES.includes(current.status)) {
    return 'REPLACE';
  }
  throw putConflict(what, current.status);
}

/** The 409 for a put on a record in flight or being deleted (R-48, R-14). */
function putConflict(what: string, status: LifecycleStatus): ConflictError {
  if (status === 'CREATING' || status === 'UPDATING') {
    return new ConflictError({ message: `${what} is ${status}; ${RETRY_HINT} once it has finished` });
  }
  return new ConflictError({
    message: `${what} is ${status}; it cannot be put until the delete is finished, and a retry cannot succeed`,
  });
}

/**
 * Classifies a failed `PutApplication` write from the item that failed it
 * (`ALL_OLD`, R-14): no item means the record was deleted in between, and a
 * `CREATE_FAILED` or live item that a kept list changed under; both are
 * 409s with the retry hint (the retry is a create, a re-put or a replace
 * that succeeds). Any other status is {@link putConflict}.
 */
function putApplicationFailure(what: string, failed: ApplicationRecord | undefined): ConflictError {
  if (failed === undefined || failed.status === 'CREATE_FAILED' || RECORD_UPDATABLE_STATUSES.includes(failed.status)) {
    return new ConflictError({
      message: `${what} changed after this request read it (a parameter declaration list it keeps, its status, or another accepted put); re-read and ${RETRY_HINT}`,
    });
  }
  return putConflict(what, failed.status);
}

/**
 * The path of a `PutAccount` from the record it read (R-48): another
 * `owner` is the 409 of R-24 on every path but the create; none, a create;
 * `CREATE_FAILED`, a re-put; live, a replace; `UPDATING`, a rotation, whose
 * `maxCells` and `applicationIds` MUST equal the change in flight
 * (`pending`, or the live fields once the commit removed it), 409
 * otherwise; `CREATING`, `DELETING` or `DELETE_FAILED`, a 409.
 */
function putAccountPath(
  what: string,
  current: AccountRecord | undefined,
  request: { readonly owner: AccountOwner; readonly maxCells: number; readonly applicationIds?: readonly string[] },
): PutAccountPath {
  if (current === undefined) {
    return 'CREATE';
  }
  if (current.owner !== request.owner) {
    throw ownerImmutableError(current.accountId);
  }
  if (current.status === 'CREATE_FAILED') {
    return 'RE_PUT';
  }
  if (RECORD_UPDATABLE_STATUSES.includes(current.status)) {
    return 'REPLACE';
  }
  if (current.status === 'UPDATING') {
    const inFlight = current.pending ?? current;
    if (inFlight.maxCells !== request.maxCells || !sameIds(inFlight.applicationIds, request.applicationIds)) {
      throw new ConflictError({
        message:
          `${what} is UPDATING with maxCells = ${inFlight.maxCells} and applicationIds = [${(inFlight.applicationIds ?? []).join(', ')}];`
          + ` while it is in flight a PutAccount may only rotate the externalId with those values. ${RETRY_HINT} once it has finished`,
      });
    }
    return 'ROTATE';
  }
  throw putConflict(what, current.status);
}

/** Whether two allowlists admit the same applications; absent (shared) equals only absent. */
function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/**
 * Classifies a failed `PutAccount` write from the item that failed it
 * (`ALL_OLD`, R-14): an item holding another `owner`, whatever its status,
 * is the owner-change 409 without a hint; no item, or a `CREATE_FAILED` or
 * live item, a 409 with the retry hint (the retry is a create, a re-put or
 * a replace that succeeds); any other status is {@link putConflict}.
 */
function putAccountFailure(accountId: string, owner: AccountOwner, failed: AccountRecord | undefined): ConflictError {
  if (failed !== undefined && failed.owner !== owner) {
    return ownerImmutableError(accountId);
  }
  if (failed === undefined || failed.status === 'CREATE_FAILED' || RECORD_UPDATABLE_STATUSES.includes(failed.status)) {
    return new ConflictError({
      message: `Account ${accountId} changed after this request read it; re-read and ${RETRY_HINT}`,
    });
  }
  return putConflict(`Account ${accountId}`, failed.status);
}

/**
 * Classifies a failed `UpdateTenant` staging write from `ALL_OLD` (R-14):
 * no item, the 404; an updatable status, another operation was accepted in
 * between (409, retry); any other status is {@link updateConflict}.
 */
function staleUpdateFailure(what: string, failed: { readonly status: LifecycleStatus } | undefined): Error {
  if (failed === undefined) {
    return new ResourceNotFoundError({ message: `${what} no longer exists` });
  }
  if (RECORD_UPDATABLE_STATUSES.includes(failed.status)) {
    return new ConflictError({ message: `${what} changed after this request read it; re-read and ${RETRY_HINT}` });
  }
  return updateConflict(what, failed.status);
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

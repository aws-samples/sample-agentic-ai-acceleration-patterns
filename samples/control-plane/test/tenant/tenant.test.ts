// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AccountFullError,
  AmbiguousTransactionError,
  ApplicationGoneError,
  ConditionFailedError,
  DeploymentExistsError,
  DuplicateTokenError,
  DynamoDBRepository,
  PlacementRaceLostError,
  PlacementTransactions,
  RecordGoneError,
  StaleTransitionError,
  TenantGoneError,
} from '../../src/shared/repository';
import { CallerContext } from '../../src/shared/service-config';
import {
  ConflictError,
  InsufficientCapacityError,
  InternalServerError,
  PutApplicationInput,
  ResourceNotFoundError,
  SourceDefinition,
  ValidationException,
} from '../../src/smithy/source/typescript-ssdk-codegen/src';
import { AccountItem, AccountRecord } from '../../src/tenant/account.data-model';
import { HandshakeProbe, HandshakeUnavailableError } from '../../src/tenant/account.handshake';
import { ApplicationItem, ApplicationRecord } from '../../src/tenant/application.data-model';
import { CellItem, CellRecord } from '../../src/tenant/cell.data-model';
import { DeploymentItem, DeploymentRecord } from '../../src/tenant/deployment.data-model';
import {
  IdempotencyItem,
  IdempotencyRecord,
  createDeploymentRequestHash,
} from '../../src/tenant/idempotency.data-model';
import { TenantService } from '../../src/tenant/tenant';
import { TenantItem, TenantRecord } from '../../src/tenant/tenant.data-model';

const sfnMock = mockClient(SFNClient);
const context: CallerContext = { operatorId: 'op-1', role: 'operator' };

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CELL_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const OTHER_CELL_ID = '01BX5ZZKBKACTAV9WEVGEMMVS0';
const APP_ID = 'app-x';
const OTHER_APP_ID = 'app-y';
/** The vendor-owned home account every fixture cell lives in (synthetic). */
const ACCOUNT_ID = '111111111111';
/** A second, tenant-owned account (synthetic). */
const TENANT_ACCOUNT_ID = '222222222222';
const FLEET = 'control-plane';
const CELL_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${FLEET}-cell-provisioning`;
const TENANT_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${FLEET}-tenant-provisioning`;
const ADMIN_EMAIL = 'success@simulator.amazonses.com';

/** The application's CURRENT definition — deliberately distinct from the cell stamp below (ADR-032). */
const applicationSource: SourceDefinition = {
  type: 'GITHUB',
  location: 'https://github.com/acme/application.git',
};
const applicationCellScripts = {
  create: 'app/cell/create.sh',
  update: 'app/cell/update.sh',
  delete: 'app/cell/delete.sh',
};
const applicationTenantScripts = {
  create: 'app/tenant/create.sh',
  update: 'app/tenant/update.sh',
  delete: 'app/tenant/delete.sh',
};

/** Stamped values on the cell record — distinct from the application to prove resolution (P-4). */
const stampedSource: SourceDefinition = { type: 'GITHUB', location: 'https://github.com/acme/stamped.git' };
const stampedCellScripts = {
  create: 'stamped/cell/create.sh',
  update: 'stamped/cell/update.sh',
  delete: 'stamped/cell/delete.sh',
};
const stampedTenantScripts = {
  create: 'stamped/tenant/create.sh',
  update: 'stamped/tenant/update.sh',
  delete: 'stamped/tenant/delete.sh',
};

function applicationRecord(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    applicationId: APP_ID,
    source: applicationSource,
    cellScripts: applicationCellScripts,
    tenantScripts: applicationTenantScripts,
    maxTenants: 4,
    placementStrategy: 'FILL',
    cellCount: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function accountRecord(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    accountId: ACCOUNT_ID,
    owner: 'VENDOR',
    maxCells: 2,
    cellCount: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function cellRecord(overrides: Partial<CellRecord> = {}): CellRecord {
  return {
    cellId: CELL_ID,
    applicationId: APP_ID,
    accountId: ACCOUNT_ID,
    status: 'ACTIVE',
    maxTenants: 5,
    tenantCount: 1,
    source: stampedSource,
    cellScripts: stampedCellScripts,
    tenantScripts: stampedTenantScripts,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function tenantRecord(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    tenantId: TENANT_ID,
    name: 'acme',
    deploymentCount: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function deploymentRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    tenantId: TENANT_ID,
    applicationId: APP_ID,
    cellId: CELL_ID,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

type TenantRepo = DynamoDBRepository<TenantRecord, TenantItem>;
type DeploymentRepo = DynamoDBRepository<DeploymentRecord, DeploymentItem>;
type CellRepo = DynamoDBRepository<CellRecord, CellItem>;
type IdempotencyRepo = DynamoDBRepository<IdempotencyRecord, IdempotencyItem>;
type AccountRepo = DynamoDBRepository<AccountRecord, AccountItem>;
type ApplicationRepo = DynamoDBRepository<ApplicationRecord, ApplicationItem>;
type Placement = PlacementTransactions<CellRecord, CellItem, DeploymentRecord, DeploymentItem>;

interface Mocks {
  /** Merged over a default `get` returning {@link tenantRecord}. */
  tenantRepo?: Partial<TenantRepo>;
  deploymentRepo?: Partial<DeploymentRepo>;
  cellRepo?: Partial<CellRepo>;
  idempotencyRepo?: Partial<IdempotencyRepo>;
  /** Merged over a default `get` returning no record (no replay). */
  /** Merged over one registered, shared, vendor-owned account (ACCOUNT_ID) with a free cell slot. */
  accountRepo?: Partial<AccountRepo>;
  /** Merged over a default `get` returning {@link applicationRecord}. */
  applicationRepo?: Partial<ApplicationRepo>;
  placement?: Partial<Placement>;
  /** Defaults to a passing handshake. */
  handshake?: HandshakeProbe;
  warn?: (message: string) => void;
}

/** One-page listing result. */
function page<T>(...items: T[]) {
  return jest.fn().mockResolvedValue({ items, nextToken: undefined });
}
const accountPage = (...accounts: AccountRecord[]) => page(...accounts);
const cellPage = (...cells: CellRecord[]) => page(...cells);

function makeService(mocks: Mocks = {}) {
  return new TenantService({
    tenantRepository: {
      get: jest.fn().mockResolvedValue(tenantRecord()),
      ...mocks.tenantRepo,
    } as TenantRepo,
    deploymentRepository: (mocks.deploymentRepo ?? {}) as DeploymentRepo,
    cellRepository: (mocks.cellRepo ?? {}) as CellRepo,
    idempotencyRepository: ({ get: jest.fn().mockResolvedValue(undefined), ...mocks.idempotencyRepo }) as IdempotencyRepo,
    accountRepository: {
      get: jest.fn().mockResolvedValue(accountRecord()),
      queryIndex: accountPage(accountRecord()),
      ...mocks.accountRepo,
    } as AccountRepo,
    applicationRepository: {
      get: jest.fn().mockResolvedValue(applicationRecord()),
      ...mocks.applicationRepo,
    } as ApplicationRepo,
    placement: (mocks.placement ?? {}) as Placement,
    fleetName: FLEET,
    partition: 'aws',
    handshake: mocks.handshake ?? jest.fn().mockResolvedValue([]),
    stateMachineArn: `arn:aws:states:eu-central-1:${ACCOUNT_ID}:stateMachine:provisioning`,
    sfnClient: new SFNClient({}),
    warn: mocks.warn ?? jest.fn(),
  });
}

function startedWorkflowInput(call = 0) {
  return JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[call].args[0].input.input!);
}

function startedExecutionName(call = 0) {
  return sfnMock.commandCalls(StartExecutionCommand)[call].args[0].input.name!;
}

/** The per-account workflow fields every execution carries (R-20, ADR-025) — the home account, no external id. */
const accountInput = {
  accountId: ACCOUNT_ID,
  externalId: '',
  cellRoleArn: CELL_ROLE_ARN,
  tenantRoleArn: TENANT_ROLE_ARN,
  sessionName: 'op-1',
};

const createInput = { tenantId: TENANT_ID, applicationId: APP_ID, adminEmail: ADMIN_EMAIL };

beforeEach(() => {
  sfnMock.reset();
  sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:...:exec' });
});

// ---------------------------------------------------------------------------
// Tenants: synchronous customer records (§5.1, ADR-037)
// ---------------------------------------------------------------------------

describe('CreateTenant (§5.1)', () => {
  test('inserts the record with deploymentCount 0 under the not-exists guard; nothing provisioned', async () => {
    const put = jest.fn().mockResolvedValue(undefined);
    const service = makeService({ tenantRepo: { put } });

    const output = await service.CreateTenant({ name: 'acme', description: 'first' }, context);

    expect(put).toHaveBeenCalledTimes(1);
    const [record, condition] = put.mock.calls[0];
    expect(record).toMatchObject({ name: 'acme', description: 'first', deploymentCount: 0 });
    expect(record.tenantId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(condition).toEqual({ conditionExpression: 'attribute_not_exists(PK)' });
    expect(output.tenant).toMatchObject({ tenantId: record.tenantId, name: 'acme', deploymentCount: 0 });
    // A tenant has no status and runs no build (§4.3).
    expect(output.tenant).not.toHaveProperty('status');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('a ULID collision (condition failure) is a 500 asking for a retry', async () => {
    const service = makeService({
      tenantRepo: { put: jest.fn().mockRejectedValue(new ConditionFailedError('exists')) },
    });
    await expect(service.CreateTenant({ name: 'acme' }, context)).rejects.toBeInstanceOf(InternalServerError);
  });
});

describe('GetTenant', () => {
  test('returns the record with its deploymentCount', async () => {
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ deploymentCount: 2 })) },
    });
    const output = await service.GetTenant({ tenantId: TENANT_ID }, context);
    expect(output.tenant).toMatchObject({ tenantId: TENANT_ID, name: 'acme', deploymentCount: 2 });
  });

  test('throws the modelled 404 for a missing tenant', async () => {
    const service = makeService({ tenantRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.GetTenant({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});

describe('UpdateTenant', () => {
  test('updates only metadata via the existence-guarded write — never deploymentCount (R-21), no workflow', async () => {
    const updateExisting = jest
      .fn()
      .mockResolvedValue(tenantRecord({ name: 'renamed', description: 'new' }));
    const service = makeService({ tenantRepo: { updateExisting } });

    const output = await service.UpdateTenant(
      { tenantId: TENANT_ID, name: 'renamed', description: 'new' },
      context,
    );

    expect(output.tenant).toMatchObject({ name: 'renamed', description: 'new' });
    const [key, update] = updateExisting.mock.calls[0];
    expect(key).toEqual({ PK: `TENANT#${TENANT_ID}`, SK: 'META' });
    expect(update.updateExpression).toBe(
      'SET #updatedAt = :updatedAt, #name = :name, #description = :description',
    );
    expect(Object.values(update.expressionAttributeNames).sort()).toEqual([
      'description',
      'name',
      'updatedAt',
    ]);
    expect(JSON.stringify(update)).not.toContain('deploymentCount');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('omitted fields are left as they are', async () => {
    const updateExisting = jest.fn().mockResolvedValue(tenantRecord());
    const service = makeService({ tenantRepo: { updateExisting } });
    await service.UpdateTenant({ tenantId: TENANT_ID, description: 'only this' }, context);
    expect(updateExisting.mock.calls[0][1].updateExpression).toBe(
      'SET #updatedAt = :updatedAt, #description = :description',
    );
  });

  test('maps a concurrent-delete condition failure to 404, not 500 (R-14)', async () => {
    const service = makeService({
      tenantRepo: { updateExisting: jest.fn().mockRejectedValue(new RecordGoneError('gone')) },
    });
    await expect(
      service.UpdateTenant({ tenantId: TENANT_ID, name: 'x' }, context),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe('DeleteTenant (empty tenants only, P-10)', () => {
  test('is one conditional delete on deploymentCount = 0 and returns the deleted record', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ deploymentCount: 0 })), delete: del },
    });

    const output = await service.DeleteTenant({ tenantId: TENANT_ID }, context);

    expect(del).toHaveBeenCalledWith(
      { PK: `TENANT#${TENANT_ID}`, SK: 'META' },
      {
        conditionExpression: 'attribute_exists(PK) AND #deploymentCount = :zero',
        expressionAttributeNames: { '#deploymentCount': 'deploymentCount' },
        expressionAttributeValues: { ':zero': 0 },
      },
    );
    expect(output.tenant).toMatchObject({ tenantId: TENANT_ID, deploymentCount: 0 });
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('an occupied tenant (condition failure) is a 409', async () => {
    const service = makeService({
      tenantRepo: { delete: jest.fn().mockRejectedValue(new ConditionFailedError('occupied')) },
    });
    await expect(service.DeleteTenant({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test('a missing tenant is a 404 and nothing is deleted', async () => {
    const del = jest.fn();
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(undefined), delete: del },
    });
    await expect(service.DeleteTenant({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    expect(del).not.toHaveBeenCalled();
  });
});

describe('ListTenants', () => {
  test('queries the static GSI-2 TENANT partition with pagination pass-through', async () => {
    const queryIndex = jest.fn().mockResolvedValue({ items: [tenantRecord()], nextToken: 'token-1' });
    const service = makeService({ tenantRepo: { queryIndex } });

    const output = await service.ListTenants({ maxResults: 10, nextToken: 'token-0' }, context);

    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI2', partitionKey: { name: 'GSI2PK', value: 'TENANT' } },
      10,
      'token-0',
    );
    expect(output.tenants).toHaveLength(1);
    expect(output.nextToken).toBe('token-1');
  });
});

// ---------------------------------------------------------------------------
// CreateDeployment: placement (§7.1)
// ---------------------------------------------------------------------------

describe('CreateDeployment placement into an existing cell (§7.1 steps 0-2)', () => {
  test('claims a slot in an ACTIVE cell of the application and starts a tenant-only create build', async () => {
    const placeDeploymentInCell = jest.fn().mockResolvedValue(undefined);
    const cellQuery = cellPage(cellRecord());
    const service = makeService({
      cellRepo: { queryIndex: cellQuery },
      placement: { placeDeploymentInCell },
    });

    const output = await service.CreateDeployment(createInput, context);

    expect(output.deployment).toMatchObject({
      tenantId: TENANT_ID,
      applicationId: APP_ID,
      cellId: CELL_ID,
      status: 'CREATING',
    });
    // Untargeted candidates: the application's own GSI-3 partition, cells only.
    expect(cellQuery.mock.calls[0][0]).toEqual({
      indexName: 'GSI3',
      partitionKey: { name: 'GSI3PK', value: `APPLICATION#${APP_ID}` },
      sortKeyPrefix: 'CELL#',
    });

    // The claim is atomic: cell slot + tenant count + deployment insert in one transaction.
    const claim = placeDeploymentInCell.mock.calls[0][0];
    expect(claim.cellKey).toEqual({ PK: `CELL#${CELL_ID}`, SK: 'META' });
    expect(claim.tenantKey).toEqual({ PK: `TENANT#${TENANT_ID}`, SK: 'META' });
    expect(claim.deployment).toMatchObject({
      tenantId: TENANT_ID,
      applicationId: APP_ID,
      cellId: CELL_ID,
      status: 'CREATING',
    });
    expect(claim.idempotencyItem).toBeUndefined();
    // adminEmail is workflow input only, never persisted (R-8).
    expect(JSON.stringify(claim.deployment)).not.toContain('adminEmail');

    // Existing cell: tenantBuild create only, resolved from the STAMPED definition (R-20).
    expect(startedWorkflowInput()).toEqual({
      sourceType: 'GITHUB',
      sourceLocation: 'https://github.com/acme/stamped.git',
      sourceVersion: '', // unpinned stamped source (T5/M10)
      operatorId: 'op-1', // the initiating operator (T10/M12)
      ...accountInput,
      applicationId: APP_ID,
      cellId: CELL_ID,
      tenantId: TENANT_ID,
      tenantBuild: {
        operation: 'create',
        scriptPath: 'stamped/tenant/create.sh',
        failedStatus: 'CREATE_FAILED',
        tenantName: 'acme', // from the tenant record (ADR-023)
        adminEmail: ADMIN_EMAIL,
      },
    });
    expect(startedExecutionName()).toMatch(new RegExp(`^${TENANT_ID}-${APP_ID}-c-\\d+$`));
  });

  test('the execution name stays within Step Functions\' 80-character cap at the longest applicationId', async () => {
    const longId = 'a'.repeat(32);
    const placeDeploymentInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ applicationId: longId })) },
      cellRepo: { queryIndex: cellPage(cellRecord({ applicationId: longId })) },
      placement: { placeDeploymentInCell },
    });
    await service.CreateDeployment({ ...createInput, applicationId: longId }, context);
    expect(startedExecutionName().length).toBeLessThanOrEqual(80);
  });

  test('filters non-ACTIVE, full and foreign-application cells from the candidate scan client-side', async () => {
    const placeDeploymentInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: {
        queryIndex: cellPage(
          cellRecord({ cellId: OTHER_CELL_ID, status: 'CREATING' }),
          cellRecord({ cellId: OTHER_CELL_ID, tenantCount: 5, maxTenants: 5 }),
          cellRecord({ cellId: OTHER_CELL_ID, applicationId: OTHER_APP_ID, tenantCount: 0 }),
          cellRecord(), // the only eligible candidate
        ),
      },
      placement: { placeDeploymentInCell },
    });

    const output = await service.CreateDeployment(createInput, context);

    expect(placeDeploymentInCell).toHaveBeenCalledTimes(1);
    expect(output.deployment?.cellId).toBe(CELL_ID);
  });

  test('a lost race moves to the next candidate', async () => {
    const placeDeploymentInCell = jest
      .fn()
      .mockRejectedValueOnce(new PlacementRaceLostError('lost'))
      .mockResolvedValueOnce(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord(), cellRecord({ cellId: OTHER_CELL_ID })) },
      placement: { placeDeploymentInCell },
    });

    const output = await service.CreateDeployment(createInput, context);

    expect(placeDeploymentInCell).toHaveBeenCalledTimes(2);
    expect(placeDeploymentInCell.mock.calls[1][0].deployment.cellId).toBe(OTHER_CELL_ID);
    expect(output.deployment?.cellId).toBe(OTHER_CELL_ID);
    expect(startedWorkflowInput().cellId).toBe(OTHER_CELL_ID);
  });

  test('exhausting the 5-attempt budget falls through to new-cell creation, not an error (R-18)', async () => {
    const candidates = Array.from({ length: 7 }, (_, i) =>
      cellRecord({ cellId: `01BX5ZZKBKACTAV9WEVGEMMV${(i + 10).toString(36).toUpperCase()}` }),
    );
    const placeDeploymentInCell = jest.fn().mockRejectedValue(new PlacementRaceLostError('lost'));
    const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(...candidates) },
      placement: { placeDeploymentInCell, createCellWithDeployment },
    });

    const output = await service.CreateDeployment(createInput, context);

    expect(placeDeploymentInCell).toHaveBeenCalledTimes(5);
    expect(createCellWithDeployment).toHaveBeenCalledTimes(1);
    expect(output.deployment?.status).toBe('CREATING');
  });

  test('an ambiguous claim outcome fails with 500 and never retargets', async () => {
    const placeDeploymentInCell = jest
      .fn()
      .mockRejectedValue(new AmbiguousTransactionError('unknown outcome'));
    const createCellWithDeployment = jest.fn();
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord(), cellRecord({ cellId: OTHER_CELL_ID })) },
      placement: { placeDeploymentInCell, createCellWithDeployment },
    });

    await expect(service.CreateDeployment(createInput, context)).rejects.toBeInstanceOf(
      InternalServerError,
    );
    expect(placeDeploymentInCell).toHaveBeenCalledTimes(1);
    expect(createCellWithDeployment).not.toHaveBeenCalled();
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });
});

describe('CreateDeployment into a new cell (§7.1 step 3, ADR-032)', () => {
  test('no eligible candidate creates a cell stamped from the application record', async () => {
    const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });

    const output = await service.CreateDeployment(createInput, context);

    const params = createCellWithDeployment.mock.calls[0][0];
    expect(params.accountKey).toEqual({ PK: `ACCOUNT#${ACCOUNT_ID}`, SK: 'META' });
    expect(params.applicationKey).toEqual({ PK: `APPLICATION#${APP_ID}`, SK: 'META' });
    expect(params.tenantKey).toEqual({ PK: `TENANT#${TENANT_ID}`, SK: 'META' });
    // New cell: CREATING, slot pre-claimed, definition stamped from the application.
    expect(params.cell).toMatchObject({
      applicationId: APP_ID,
      accountId: ACCOUNT_ID,
      status: 'CREATING',
      tenantCount: 1,
      maxTenants: 4,
      source: applicationSource,
      cellScripts: applicationCellScripts,
      tenantScripts: applicationTenantScripts,
    });
    expect(params.deployment).toMatchObject({
      tenantId: TENANT_ID,
      applicationId: APP_ID,
      cellId: params.cell.cellId,
      status: 'CREATING',
    });
    expect(output.deployment?.cellId).toBe(params.cell.cellId);

    // New cell: cell create build precedes the tenant create build.
    expect(startedWorkflowInput()).toEqual({
      sourceType: 'GITHUB',
      sourceLocation: 'https://github.com/acme/application.git',
      sourceVersion: '',
      operatorId: 'op-1',
      ...accountInput,
      applicationId: APP_ID,
      cellId: params.cell.cellId,
      cellBuild: {
        operation: 'create',
        scriptPath: 'app/cell/create.sh',
        failedStatus: 'CREATE_FAILED',
      },
      tenantId: TENANT_ID,
      tenantBuild: {
        operation: 'create',
        scriptPath: 'app/tenant/create.sh',
        failedStatus: 'CREATE_FAILED',
        tenantName: 'acme',
        adminEmail: ADMIN_EMAIL,
      },
    });
  });

  test('an ambiguous new-cell transaction fails with 500', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: {
        createCellWithDeployment: jest
          .fn()
          .mockRejectedValue(new AmbiguousTransactionError('unknown outcome')),
      },
    });
    await expect(service.CreateDeployment(createInput, context)).rejects.toBeInstanceOf(
      InternalServerError,
    );
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });
});

describe('CreateDeployment step 0 lookups and classified outcomes (§7.1, R-14)', () => {
  test('an unknown tenant is a 404 before anything is read or written for placement', async () => {
    const cellQuery = jest.fn();
    const appGet = jest.fn();
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(undefined) },
      applicationRepo: { get: appGet },
      cellRepo: { queryIndex: cellQuery },
    });
    await expect(service.CreateDeployment(createInput, context)).rejects.toMatchObject({
      name: 'ResourceNotFoundError',
      message: expect.stringContaining(TENANT_ID),
    });
    expect(appGet).not.toHaveBeenCalled();
    expect(cellQuery).not.toHaveBeenCalled();
  });

  test('an unregistered application is a 404 before placement', async () => {
    const cellQuery = jest.fn();
    const service = makeService({
      applicationRepo: { get: jest.fn().mockResolvedValue(undefined) },
      cellRepo: { queryIndex: cellQuery },
    });
    await expect(service.CreateDeployment(createInput, context)).rejects.toMatchObject({
      name: 'ResourceNotFoundError',
      message: expect.stringContaining(APP_ID),
    });
    expect(cellQuery).not.toHaveBeenCalled();
  });

  test('the application lookup uses the requested application id', async () => {
    const appGet = jest.fn().mockResolvedValue(applicationRecord({ applicationId: OTHER_APP_ID }));
    const service = makeService({
      applicationRepo: { get: appGet },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment: jest.fn().mockResolvedValue(undefined) },
    });
    await service.CreateDeployment({ ...createInput, applicationId: OTHER_APP_ID }, context);
    expect(appGet).toHaveBeenCalledWith({ PK: `APPLICATION#${OTHER_APP_ID}`, SK: 'META' });
  });

  test.each([
    ['existing cell', 'placeDeploymentInCell'],
    ['new cell', 'createCellWithDeployment'],
  ] as const)('a second deployment of the same application is a 409 ConflictError (%s path)', async (_, path) => {
    const fails = jest.fn().mockRejectedValue(new DeploymentExistsError('exists'));
    const service = makeService({
      cellRepo: { queryIndex: path === 'placeDeploymentInCell' ? cellPage(cellRecord()) : cellPage() },
      placement: { [path]: fails },
    });
    await expect(service.CreateDeployment(createInput, context)).rejects.toMatchObject({
      name: 'ConflictError',
      message: expect.stringContaining('already has a deployment'),
    });
    expect(fails).toHaveBeenCalledTimes(1); // never retargeted
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test.each([
    ['existing cell', 'placeDeploymentInCell'],
    ['new cell', 'createCellWithDeployment'],
  ] as const)('a tenant deleted between step 0 and the transaction is a 404 (%s path)', async (_, path) => {
    const service = makeService({
      cellRepo: { queryIndex: path === 'placeDeploymentInCell' ? cellPage(cellRecord()) : cellPage() },
      placement: { [path]: jest.fn().mockRejectedValue(new TenantGoneError('gone')) },
    });
    await expect(service.CreateDeployment(createInput, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test('an application deleted between step 0 and the new-cell transaction is a 404', async () => {
    const createCellWithDeployment = jest.fn().mockRejectedValue(new ApplicationGoneError('gone'));
    const service = makeService({
      accountRepo: {
        queryIndex: accountPage(accountRecord(), accountRecord({ accountId: '333333333333' })),
      },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });
    await expect(service.CreateDeployment(createInput, context)).rejects.toMatchObject({
      name: 'ResourceNotFoundError',
      message: expect.stringContaining(APP_ID),
    });
    expect(createCellWithDeployment).toHaveBeenCalledTimes(1); // stop, never the next account
  });
});

describe('CreateDeployment compensation (§7.4 R-19)', () => {
  test('existing-cell placement: a rejected start compensates with a single deployment CAS', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('Step Functions unavailable'));
    const transitionStatus = jest.fn().mockResolvedValue(deploymentRecord({ status: 'CREATE_FAILED' }));
    const failCreatingCellAndDeployment = jest.fn();
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      deploymentRepo: { transitionStatus },
      placement: {
        placeDeploymentInCell: jest.fn().mockResolvedValue(undefined),
        failCreatingCellAndDeployment,
      },
    });

    await expect(service.CreateDeployment(createInput, context)).rejects.toThrow(
      'Step Functions unavailable',
    );

    expect(transitionStatus).toHaveBeenCalledTimes(1);
    expect(transitionStatus.mock.calls[0][0]).toEqual({ PK: `TENANT#${TENANT_ID}`, SK: `DEPLOYMENT#${APP_ID}` });
    expect(transitionStatus.mock.calls[0][1]).toMatchObject({
      fromAnyOf: ['CREATING'],
      to: 'CREATE_FAILED',
      setFields: { statusReason: expect.stringContaining('Failed to start provisioning workflow') },
    });
    expect(failCreatingCellAndDeployment).not.toHaveBeenCalled();
  });

  test('new-cell placement: a rejected start compensates BOTH records with the paired transaction', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const failCreatingCellAndDeployment = jest.fn().mockResolvedValue(undefined);
    const transitionStatus = jest.fn();
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      deploymentRepo: { transitionStatus },
      placement: {
        createCellWithDeployment: jest.fn().mockResolvedValue(undefined),
        failCreatingCellAndDeployment,
      },
    });

    await expect(service.CreateDeployment(createInput, context)).rejects.toThrow('start rejected');

    expect(failCreatingCellAndDeployment).toHaveBeenCalledTimes(1);
    const compensation = failCreatingCellAndDeployment.mock.calls[0][0];
    expect(compensation.cellKey.PK).toMatch(/^CELL#/);
    expect(compensation.deploymentKey).toEqual({ PK: `TENANT#${TENANT_ID}`, SK: `DEPLOYMENT#${APP_ID}` });
    expect(compensation.statusReason).toContain('Failed to start provisioning workflow');
    expect(transitionStatus).not.toHaveBeenCalled();
  });

  test('a failing compensation never masks the original start error', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      deploymentRepo: { transitionStatus: jest.fn().mockRejectedValue(new StaleTransitionError('raced')) },
      placement: { placeDeploymentInCell: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.CreateDeployment(createInput, context)).rejects.toThrow('start rejected');
  });
});

// ---------------------------------------------------------------------------
// Account eligibility and order (§7.1 step 0/3, ADR-024, ADR-033, ADR-035, ADR-036)
// ---------------------------------------------------------------------------

describe('CreateDeployment across accounts', () => {
  const tenantAccount = accountRecord({
    accountId: TENANT_ACCOUNT_ID,
    owner: 'TENANT',
    maxCells: 1,
    cellCount: 0,
    externalId: 'customer-handshake-1',
    createdAt: new Date('2026-02-01T00:00:00Z'),
  });

  test('untargeted placement considers vendor-owned accounts only, oldest registered first', async () => {
    const olderVendor = accountRecord({
      accountId: '333333333333',
      cellCount: 0,
      createdAt: new Date('2025-12-01T00:00:00Z'),
    });
    const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      // Listing order differs from registration order on purpose.
      accountRepo: { queryIndex: accountPage(accountRecord(), tenantAccount, olderVendor) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });

    await service.CreateDeployment(createInput, context);

    expect(createCellWithDeployment).toHaveBeenCalledTimes(1);
    expect(createCellWithDeployment.mock.calls[0][0]).toMatchObject({
      accountKey: { PK: 'ACCOUNT#333333333333', SK: 'META' },
      cell: expect.objectContaining({ accountId: '333333333333', status: 'CREATING', tenantCount: 1 }),
    });
    expect(startedWorkflowInput()).toMatchObject({
      accountId: '333333333333',
      cellRoleArn: 'arn:aws:iam::333333333333:role/control-plane-cell-provisioning',
      tenantRoleArn: 'arn:aws:iam::333333333333:role/control-plane-tenant-provisioning',
      externalId: '',
    });
  });

  test('a vendor account dedicated to another application is never eligible (ADR-033)', async () => {
    const createCellWithDeployment = jest.fn().mockRejectedValue(new AccountFullError('full'));
    const otherAppOnly = accountRecord({
      accountId: '333333333333',
      cellCount: 0,
      applicationIds: [OTHER_APP_ID],
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const service = makeService({
      accountRepo: { queryIndex: accountPage(otherAppOnly, accountRecord({ cellCount: 2 })) },
      cellRepo: { queryIndex: cellPage(cellRecord({ accountId: '333333333333', tenantCount: 0 })) },
      placement: { createCellWithDeployment, placeDeploymentInCell: jest.fn() },
    });

    await expect(service.CreateDeployment(createInput, context)).rejects.toBeInstanceOf(
      InsufficientCapacityError,
    );
    expect(createCellWithDeployment).toHaveBeenCalledTimes(1);
    expect(createCellWithDeployment.mock.calls[0][0].accountKey.PK).toBe(`ACCOUNT#${ACCOUNT_ID}`);
  });

  test('dedicated before shared: a shared account registered earlier loses to a dedicated one (ADR-035)', async () => {
    const sharedOlder = accountRecord({
      accountId: '333333333333',
      cellCount: 0,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const dedicatedNewer = accountRecord({
      accountId: '444444444444',
      cellCount: 0,
      applicationIds: [APP_ID, OTHER_APP_ID],
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      accountRepo: { queryIndex: accountPage(sharedOlder, dedicatedNewer) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });

    await service.CreateDeployment(createInput, context);

    expect(createCellWithDeployment.mock.calls[0][0].accountKey).toEqual({
      PK: 'ACCOUNT#444444444444',
      SK: 'META',
    });
  });

  test('a full dedicated account falls back to the shared one', async () => {
    const shared = accountRecord({ accountId: '333333333333', cellCount: 0 });
    const dedicated = accountRecord({ accountId: '444444444444', cellCount: 2, applicationIds: [APP_ID] });
    const createCellWithDeployment = jest
      .fn()
      .mockRejectedValueOnce(new AccountFullError('full'))
      .mockResolvedValueOnce(undefined);
    const service = makeService({
      accountRepo: { queryIndex: accountPage(shared, dedicated) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });

    await service.CreateDeployment(createInput, context);

    expect(createCellWithDeployment.mock.calls.map((call) => call[0].accountKey.PK)).toEqual([
      'ACCOUNT#444444444444',
      'ACCOUNT#333333333333',
    ]);
  });

  test('reuse before create: a cell with room in a shared account is reused before a dedicated account gets a new cell (ADR-035)', async () => {
    const dedicated = accountRecord({ accountId: '444444444444', cellCount: 0, applicationIds: [APP_ID] });
    const placeDeploymentInCell = jest.fn().mockResolvedValue(undefined);
    const createCellWithDeployment = jest.fn();
    const service = makeService({
      accountRepo: { queryIndex: accountPage(accountRecord(), dedicated) },
      cellRepo: { queryIndex: cellPage(cellRecord()) }, // in the shared ACCOUNT_ID
      placement: { placeDeploymentInCell, createCellWithDeployment },
    });

    await service.CreateDeployment(createInput, context);

    expect(placeDeploymentInCell).toHaveBeenCalledTimes(1);
    expect(createCellWithDeployment).not.toHaveBeenCalled();
  });

  describe('placement strategy across two shared accounts at 1/2 and 0/2 (ADR-036)', () => {
    const first = accountRecord({
      accountId: '333333333333',
      cellCount: 1,
      maxCells: 2,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const second = accountRecord({
      accountId: '444444444444',
      cellCount: 0,
      maxCells: 2,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    async function placeWith(strategy: 'FILL' | 'ROUND_ROBIN', applicationId: string): Promise<string> {
      const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
      const service = makeService({
        applicationRepo: {
          get: jest.fn().mockResolvedValue(applicationRecord({ applicationId, placementStrategy: strategy })),
        },
        accountRepo: { queryIndex: accountPage(second, first) },
        cellRepo: { queryIndex: cellPage() },
        placement: { createCellWithDeployment },
      });
      await service.CreateDeployment({ ...createInput, applicationId }, context);
      return createCellWithDeployment.mock.calls[0][0].accountKey.PK;
    }

    test('FILL creates the next cell in the first (oldest) account', async () => {
      expect(await placeWith('FILL', APP_ID)).toBe('ACCOUNT#333333333333');
    });

    test('ROUND_ROBIN creates the next cell in the account with the fewest cells', async () => {
      expect(await placeWith('ROUND_ROBIN', OTHER_APP_ID)).toBe('ACCOUNT#444444444444');
    });

    test('ROUND_ROBIN breaks a cellCount tie by registration order', async () => {
      const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
      const service = makeService({
        applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ placementStrategy: 'ROUND_ROBIN' })) },
        accountRepo: { queryIndex: accountPage(second, { ...first, cellCount: 0 }) },
        cellRepo: { queryIndex: cellPage() },
        placement: { createCellWithDeployment },
      });
      await service.CreateDeployment(createInput, context);
      expect(createCellWithDeployment.mock.calls[0][0].accountKey.PK).toBe('ACCOUNT#333333333333');
    });

    test('ROUND_ROBIN still puts a dedicated account before a less-occupied shared one', async () => {
      const dedicated = accountRecord({ accountId: '555555555555', cellCount: 1, applicationIds: [APP_ID] });
      const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
      const service = makeService({
        applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ placementStrategy: 'ROUND_ROBIN' })) },
        accountRepo: { queryIndex: accountPage(second, dedicated) },
        cellRepo: { queryIndex: cellPage() },
        placement: { createCellWithDeployment },
      });
      await service.CreateDeployment(createInput, context);
      expect(createCellWithDeployment.mock.calls[0][0].accountKey.PK).toBe('ACCOUNT#555555555555');
    });
  });

  test('an untargeted scan skips ACTIVE cells with capacity that live in a tenant-owned account', async () => {
    const placeDeploymentInCell = jest.fn().mockResolvedValue(undefined);
    const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      accountRepo: { queryIndex: accountPage(accountRecord({ cellCount: 0 }), tenantAccount) },
      cellRepo: { queryIndex: cellPage(cellRecord({ accountId: TENANT_ACCOUNT_ID, tenantCount: 0 })) },
      placement: { placeDeploymentInCell, createCellWithDeployment },
    });

    await service.CreateDeployment(createInput, context);

    expect(placeDeploymentInCell).not.toHaveBeenCalled();
    expect(createCellWithDeployment.mock.calls[0][0]).toMatchObject({
      accountKey: { PK: `ACCOUNT#${ACCOUNT_ID}`, SK: 'META' },
    });
  });

  test('a full account refuses the claim and placement moves to the next eligible account', async () => {
    const createCellWithDeployment = jest
      .fn()
      .mockRejectedValueOnce(new AccountFullError('full'))
      .mockResolvedValueOnce(undefined);
    const second = accountRecord({ accountId: '444444444444', cellCount: 0, createdAt: new Date('2026-03-01T00:00:00Z') });
    const service = makeService({
      accountRepo: { queryIndex: accountPage(accountRecord({ cellCount: 2 }), second) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });

    const output = await service.CreateDeployment(createInput, context);

    expect(createCellWithDeployment).toHaveBeenCalledTimes(2);
    expect(createCellWithDeployment.mock.calls[1][0].accountKey).toEqual({ PK: 'ACCOUNT#444444444444', SK: 'META' });
    expect(output.deployment!.status).toBe('CREATING');
  });

  test('every eligible account full → InsufficientCapacityError, nothing started (R-28, ADR-026)', async () => {
    const createCellWithDeployment = jest.fn().mockRejectedValue(new AccountFullError('full'));
    const service = makeService({
      accountRepo: { queryIndex: accountPage(accountRecord({ cellCount: 2 }), tenantAccount) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });

    await expect(service.CreateDeployment(createInput, context)).rejects.toMatchObject({
      name: 'InsufficientCapacityError',
      message: expect.stringContaining(`${ACCOUNT_ID} 2/2`),
    });
    expect(createCellWithDeployment).toHaveBeenCalledTimes(1); // the tenant-owned account was never tried
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('claim budget spent on cells with room, then every account full → retryable ConflictError (R-18, ADR-031)', async () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      cellRecord({ cellId: `01BX5ZZKBKACTAV9WEVGEMMV${(i + 10).toString(36).toUpperCase()}` }),
    );
    const placeDeploymentInCell = jest.fn().mockRejectedValue(new PlacementRaceLostError('lost'));
    const createCellWithDeployment = jest.fn().mockRejectedValue(new AccountFullError('full'));
    const service = makeService({
      accountRepo: { queryIndex: accountPage(accountRecord({ cellCount: 2 })) },
      cellRepo: { queryIndex: cellPage(...candidates) },
      placement: { placeDeploymentInCell, createCellWithDeployment },
    });

    await expect(service.CreateDeployment(createInput, context)).rejects.toMatchObject({
      name: 'ConflictError',
      message: expect.stringContaining('Retry the request'),
    });
    expect(placeDeploymentInCell).toHaveBeenCalledTimes(5);
    expect(createCellWithDeployment).toHaveBeenCalledTimes(1);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('no vendor-owned account admits the application → InsufficientCapacityError naming the remedy', async () => {
    const createCellWithDeployment = jest.fn();
    const service = makeService({
      accountRepo: {
        queryIndex: accountPage(tenantAccount, accountRecord({ accountId: '333333333333', applicationIds: [OTHER_APP_ID] })),
      },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });
    await expect(service.CreateDeployment(createInput, context)).rejects.toMatchObject({
      name: 'InsufficientCapacityError',
      message: expect.stringContaining(`No vendor-owned account admits application ${APP_ID}`),
    });
    expect(createCellWithDeployment).not.toHaveBeenCalled();
  });

  test('the account scan pages until exhausted', async () => {
    const queryIndex = jest
      .fn()
      .mockResolvedValueOnce({ items: [accountRecord({ cellCount: 2 })], nextToken: 'next' })
      .mockResolvedValueOnce({ items: [accountRecord({ accountId: '333333333333', cellCount: 0 })], nextToken: undefined });
    const createCellWithDeployment = jest
      .fn()
      .mockRejectedValueOnce(new AccountFullError('full'))
      .mockResolvedValueOnce(undefined);
    const service = makeService({
      accountRepo: { queryIndex },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });
    await service.CreateDeployment(createInput, context);
    expect(queryIndex).toHaveBeenCalledTimes(2);
    expect(queryIndex.mock.calls[0][0]).toEqual({ indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'ACCOUNT' } });
    expect(queryIndex.mock.calls[1][2]).toBe('next');
    expect(createCellWithDeployment).toHaveBeenCalledTimes(2);
  });

  describe('targeted placement (accountId given)', () => {
    test('places into the named account only — the way into a tenant-owned account', async () => {
      const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
      const accountRepo = {
        get: jest.fn().mockResolvedValue(tenantAccount),
        queryIndex: jest.fn(),
      };
      const cellQuery = cellPage();
      const service = makeService({
        accountRepo,
        cellRepo: { queryIndex: cellQuery },
        placement: { createCellWithDeployment },
      });

      await service.CreateDeployment({ ...createInput, accountId: TENANT_ACCOUNT_ID }, context);

      expect(accountRepo.get).toHaveBeenCalledWith({ PK: `ACCOUNT#${TENANT_ACCOUNT_ID}`, SK: 'META' });
      expect(accountRepo.queryIndex).not.toHaveBeenCalled(); // no account scan for a targeted request
      // The candidate scan is the account's own GSI-2 partition.
      expect(cellQuery.mock.calls[0][0]).toEqual({
        indexName: 'GSI2',
        partitionKey: { name: 'GSI2PK', value: `ACCOUNT#${TENANT_ACCOUNT_ID}` },
      });
      expect(createCellWithDeployment.mock.calls[0][0].accountKey).toEqual({
        PK: `ACCOUNT#${TENANT_ACCOUNT_ID}`,
        SK: 'META',
      });
      // The account's external id and roles ride the execution input (R-20, ADR-025).
      expect(startedWorkflowInput()).toMatchObject({
        accountId: TENANT_ACCOUNT_ID,
        externalId: 'customer-handshake-1',
        cellRoleArn: `arn:aws:iam::${TENANT_ACCOUNT_ID}:role/control-plane-cell-provisioning`,
        tenantRoleArn: `arn:aws:iam::${TENANT_ACCOUNT_ID}:role/control-plane-tenant-provisioning`,
        sessionName: 'op-1',
      });
    });

    test('reuses an existing cell of the application in that account before creating one', async () => {
      const placeDeploymentInCell = jest.fn().mockResolvedValue(undefined);
      const createCellWithDeployment = jest.fn();
      const service = makeService({
        accountRepo: { get: jest.fn().mockResolvedValue(tenantAccount) },
        cellRepo: {
          queryIndex: cellPage(
            // Another application's cell in the same account is never a candidate.
            cellRecord({ cellId: OTHER_CELL_ID, accountId: TENANT_ACCOUNT_ID, applicationId: OTHER_APP_ID, tenantCount: 0 }),
            cellRecord({ accountId: TENANT_ACCOUNT_ID, tenantCount: 0 }),
          ),
        },
        placement: { placeDeploymentInCell, createCellWithDeployment },
      });

      const output = await service.CreateDeployment({ ...createInput, accountId: TENANT_ACCOUNT_ID }, context);

      expect(placeDeploymentInCell).toHaveBeenCalledTimes(1);
      expect(createCellWithDeployment).not.toHaveBeenCalled();
      expect(output.deployment!.cellId).toBe(CELL_ID);
    });

    test('an account that does not admit the application is a 400 and nothing is written (ADR-033)', async () => {
      const cellQuery = jest.fn();
      const placeDeploymentInCell = jest.fn();
      const createCellWithDeployment = jest.fn();
      const service = makeService({
        accountRepo: { get: jest.fn().mockResolvedValue({ ...tenantAccount, applicationIds: [OTHER_APP_ID] }) },
        cellRepo: { queryIndex: cellQuery },
        placement: { placeDeploymentInCell, createCellWithDeployment },
      });
      await expect(
        service.CreateDeployment({ ...createInput, accountId: TENANT_ACCOUNT_ID }, context),
      ).rejects.toMatchObject({
        name: 'ValidationException',
        message: expect.stringContaining(`does not admit application ${APP_ID}`),
      });
      expect(cellQuery).not.toHaveBeenCalled();
      expect(placeDeploymentInCell).not.toHaveBeenCalled();
      expect(createCellWithDeployment).not.toHaveBeenCalled();
      expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
    });

    test('an account that admits the application in its allowlist is eligible when targeted', async () => {
      const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
      const service = makeService({
        accountRepo: { get: jest.fn().mockResolvedValue({ ...tenantAccount, applicationIds: [APP_ID] }) },
        cellRepo: { queryIndex: cellPage() },
        placement: { createCellWithDeployment },
      });
      await service.CreateDeployment({ ...createInput, accountId: TENANT_ACCOUNT_ID }, context);
      expect(createCellWithDeployment).toHaveBeenCalledTimes(1);
    });

    test('a full named account → InsufficientCapacityError naming the account', async () => {
      const service = makeService({
        accountRepo: { get: jest.fn().mockResolvedValue({ ...tenantAccount, cellCount: 1 }) },
        cellRepo: { queryIndex: cellPage() },
        placement: { createCellWithDeployment: jest.fn().mockRejectedValue(new AccountFullError('full')) },
      });
      await expect(
        service.CreateDeployment({ ...createInput, accountId: TENANT_ACCOUNT_ID }, context),
      ).rejects.toMatchObject({
        name: 'InsufficientCapacityError',
        message: expect.stringContaining(TENANT_ACCOUNT_ID),
      });
    });

    test('an unregistered account is a 404, not a capacity error', async () => {
      const service = makeService({
        accountRepo: { get: jest.fn().mockResolvedValue(undefined) },
        cellRepo: { queryIndex: jest.fn() },
      });
      await expect(
        service.CreateDeployment({ ...createInput, accountId: '555555555555' }, context),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  test('the STS session name is the operator id made STS-safe (M23)', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeDeploymentInCell: jest.fn().mockResolvedValue(undefined) },
    });
    await service.CreateDeployment(createInput, { operatorId: 'auth0|user 42', role: 'operator' });
    expect(startedWorkflowInput()).toMatchObject({ operatorId: 'auth0|user 42', sessionName: 'auth0-user-42' });
  });
});

// ---------------------------------------------------------------------------
// CreateDeployment idempotency (ADR-017, §7.3)
// ---------------------------------------------------------------------------

describe('CreateDeployment idempotency (ADR-017, §7.3)', () => {
  const CLIENT_TOKEN = 'retry-token-1';
  const tokenInput = { ...createInput, clientToken: CLIENT_TOKEN };
  const requestHash = createDeploymentRequestHash({
    tenantId: TENANT_ID,
    applicationId: APP_ID,
    adminEmail: ADMIN_EMAIL,
  });

  function idempotencyRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
    return {
      clientToken: CLIENT_TOKEN,
      tenantId: TENANT_ID,
      applicationId: APP_ID,
      requestHash,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: 1757203200,
      ...overrides,
    };
  }

  test('a clientToken adds the idempotency item to the existing-cell claim', async () => {
    const placeDeploymentInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeDeploymentInCell },
    });

    await service.CreateDeployment(tokenInput, context);

    const item = placeDeploymentInCell.mock.calls[0][0].idempotencyItem;
    expect(item).toMatchObject({
      PK: `IDEMPOTENCY#${CLIENT_TOKEN}`,
      SK: 'META',
      clientToken: CLIENT_TOKEN,
      tenantId: TENANT_ID,
      applicationId: APP_ID,
      requestHash,
    });
    // TTL garbage collection: ≥ 24h from creation, epoch seconds.
    expect(item.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 23 * 3600);
  });

  test('a clientToken adds the idempotency item to the new-cell transaction', async () => {
    const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithDeployment },
    });

    await service.CreateDeployment(tokenInput, context);

    expect(createCellWithDeployment.mock.calls[0][0].idempotencyItem).toMatchObject({
      PK: `IDEMPOTENCY#${CLIENT_TOKEN}`,
      requestHash,
    });
  });

  test('the request hash covers tenantId, applicationId and accountId', async () => {
    const placeDeploymentInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      accountRepo: { get: jest.fn().mockResolvedValue(accountRecord()) },
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeDeploymentInCell },
    });
    await service.CreateDeployment({ ...tokenInput, accountId: ACCOUNT_ID }, context);
    expect(placeDeploymentInCell.mock.calls[0][0].idempotencyItem.requestHash).toBe(
      createDeploymentRequestHash({
        tenantId: TENANT_ID,
        applicationId: APP_ID,
        adminEmail: ADMIN_EMAIL,
        accountId: ACCOUNT_ID,
      }),
    );
    expect(placeDeploymentInCell.mock.calls[0][0].idempotencyItem.requestHash).not.toBe(requestHash);
  });

  test('without a clientToken no idempotency item is written', async () => {
    const placeDeploymentInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeDeploymentInCell },
    });
    await service.CreateDeployment(createInput, context);
    expect(placeDeploymentInCell.mock.calls[0][0].idempotencyItem).toBeUndefined();
  });

  test('a replay with matching parameters returns the original deployment — no new deployment, no workflow', async () => {
    const original = deploymentRecord({ status: 'CREATING', cellId: OTHER_CELL_ID });
    const deploymentGet = jest.fn().mockResolvedValue(original);
    const idempotencyGet = jest.fn().mockResolvedValue(idempotencyRecord());
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeDeploymentInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: idempotencyGet },
      deploymentRepo: { get: deploymentGet },
    });

    const output = await service.CreateDeployment(tokenInput, context);

    expect(idempotencyGet).toHaveBeenCalledWith({ PK: `IDEMPOTENCY#${CLIENT_TOKEN}`, SK: 'META' });
    expect(deploymentGet).toHaveBeenCalledWith({ PK: `TENANT#${TENANT_ID}`, SK: `DEPLOYMENT#${APP_ID}` });
    // The ORIGINAL deployment, whatever its current status.
    expect(output.deployment).toMatchObject({
      tenantId: TENANT_ID,
      applicationId: APP_ID,
      cellId: OTHER_CELL_ID,
      status: 'CREATING',
    });
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('a replay via the new-cell path also returns the original deployment, even beside a full account', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      // The repository classifies the token first when the account claim also failed.
      placement: { createCellWithDeployment: jest.fn().mockRejectedValue(new DuplicateTokenError('dup')) },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord()) },
    });
    const output = await service.CreateDeployment(tokenInput, context);
    expect(output.deployment).toMatchObject({ tenantId: TENANT_ID, applicationId: APP_ID, status: 'ACTIVE' });
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('a known token replays before placement runs — a fleet that filled or narrowed since cannot turn the retry into a 400 or a capacity error (§7.3)', async () => {
    const placeDeploymentInCell = jest.fn();
    const createCellWithDeployment = jest.fn();
    const service = makeService({
      // No eligible account at all: an untokened request would be InsufficientCapacityError.
      accountRepo: { queryIndex: accountPage() },
      cellRepo: { queryIndex: cellPage() },
      placement: { placeDeploymentInCell, createCellWithDeployment },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord()) },
    });
    const output = await service.CreateDeployment(tokenInput, context);
    expect(output.deployment).toMatchObject({ tenantId: TENANT_ID, applicationId: APP_ID });
    expect(placeDeploymentInCell).not.toHaveBeenCalled();
    expect(createCellWithDeployment).not.toHaveBeenCalled();
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('token reuse with different parameters is a 409', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeDeploymentInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('dup')) },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord({ requestHash: 'other' })) },
    });
    await expect(service.CreateDeployment(tokenInput, context)).rejects.toMatchObject({
      name: 'ConflictError',
      message: expect.stringContaining('different request parameters'),
    });
  });

  test('the same token for a different application is a 409, not a replay (§7.3)', async () => {
    const deploymentGet = jest.fn();
    const service = makeService({
      applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ applicationId: OTHER_APP_ID })) },
      cellRepo: { queryIndex: cellPage(cellRecord({ applicationId: OTHER_APP_ID })) },
      placement: { placeDeploymentInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('dup')) },
      // The record was written by the APP_ID request.
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      deploymentRepo: { get: deploymentGet },
    });
    await expect(
      service.CreateDeployment({ ...tokenInput, applicationId: OTHER_APP_ID }, context),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(deploymentGet).not.toHaveBeenCalled();
  });

  test('the same token with a different target accountId is a 409, not a replay of the first placement', async () => {
    const service = makeService({
      accountRepo: { get: jest.fn().mockResolvedValue(accountRecord()) },
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeDeploymentInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('dup')) },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
    });
    await expect(
      service.CreateDeployment({ ...tokenInput, accountId: ACCOUNT_ID }, context),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('a replay whose deployment was since deleted is a 409, not a silent re-create', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeDeploymentInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('dup')) },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      deploymentRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.CreateDeployment(tokenInput, context)).rejects.toMatchObject({
      name: 'ConflictError',
      message: expect.stringContaining('no longer exists'),
    });
  });

  test('a duplicate whose record was TTL-collected mid-flight is a 409', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeDeploymentInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('dup')) },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.CreateDeployment(tokenInput, context)).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// GetDeployment / UpdateDeployment / DeleteDeployment / ListDeployments (§5.2)
// ---------------------------------------------------------------------------

describe('GetDeployment', () => {
  test('returns the deployment plus the effective definition and account resolved from its cell', async () => {
    const deploymentGet = jest.fn().mockResolvedValue(deploymentRecord({ lastBuildId: 'arn:build/1' }));
    const service = makeService({
      deploymentRepo: { get: deploymentGet },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });

    const output = await service.GetDeployment({ tenantId: TENANT_ID, applicationId: APP_ID }, context);

    expect(deploymentGet).toHaveBeenCalledWith({ PK: `TENANT#${TENANT_ID}`, SK: `DEPLOYMENT#${APP_ID}` });
    expect(output.deployment).toMatchObject({
      tenantId: TENANT_ID,
      applicationId: APP_ID,
      cellId: CELL_ID,
      status: 'ACTIVE',
      lastBuildId: 'arn:build/1',
    });
    // The cell's stamp, never the application's current definition (P-4).
    expect(output.source).toEqual(stampedSource);
    expect(output.scripts).toEqual(stampedTenantScripts);
    expect(output.accountId).toBe(ACCOUNT_ID);
  });

  test('throws the modelled 404 for a missing deployment', async () => {
    const service = makeService({ deploymentRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(
      service.GetDeployment({ tenantId: TENANT_ID, applicationId: APP_ID }, context),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test('a deployment referencing a missing cell is an invariant violation (500)', async () => {
    const service = makeService({
      deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord()) },
      cellRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(
      service.GetDeployment({ tenantId: TENANT_ID, applicationId: APP_ID }, context),
    ).rejects.toBeInstanceOf(InternalServerError);
  });
});

describe('UpdateDeployment', () => {
  const key = { tenantId: TENANT_ID, applicationId: APP_ID };

  test.each(['CREATING', 'UPDATING', 'DELETING', 'CREATE_FAILED', 'DELETE_FAILED'] as const)(
    'rejects with 409 when the deployment is %s',
    async (status) => {
      const service = makeService({
        deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord({ status })) },
      });
      await expect(service.UpdateDeployment(key, context)).rejects.toBeInstanceOf(ConflictError);
    },
  );

  test.each(['CREATING', 'UPDATING', 'DELETING', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'] as const)(
    'rejects with 409 when the cell is %s (cross-entity guard, R-13)',
    async (cellStatus) => {
      const transitionStatus = jest.fn();
      const service = makeService({
        deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord()), transitionStatus },
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status: cellStatus })) },
      });
      await expect(service.UpdateDeployment(key, context)).rejects.toBeInstanceOf(ConflictError);
      // Guarded before any transition — no state was touched.
      expect(transitionStatus).not.toHaveBeenCalled();
    },
  );

  test.each(['ACTIVE', 'UPDATE_FAILED'] as const)(
    'transitions and starts the tenant update build from %s when the cell is ACTIVE',
    async (status) => {
      const transitionStatus = jest.fn().mockResolvedValue(deploymentRecord({ status: 'UPDATING' }));
      const service = makeService({
        deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord({ status })), transitionStatus },
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
      });

      const output = await service.UpdateDeployment(key, context);

      expect(output.deployment?.status).toBe('UPDATING');
      expect(transitionStatus.mock.calls[0][0]).toEqual({ PK: `TENANT#${TENANT_ID}`, SK: `DEPLOYMENT#${APP_ID}` });
      expect(transitionStatus.mock.calls[0][1]).toMatchObject({
        fromAnyOf: ['ACTIVE', 'UPDATE_FAILED'],
        to: 'UPDATING',
        removeFields: ['statusReason'],
      });
      expect(startedWorkflowInput()).toEqual({
        sourceType: 'GITHUB',
        sourceLocation: 'https://github.com/acme/stamped.git',
        sourceVersion: '',
        operatorId: 'op-1',
        ...accountInput,
        applicationId: APP_ID,
        cellId: CELL_ID,
        tenantId: TENANT_ID,
        tenantBuild: {
          operation: 'update',
          scriptPath: 'stamped/tenant/update.sh',
          failedStatus: 'UPDATE_FAILED',
          tenantName: 'acme', // from the tenant record (ADR-023)
          adminEmail: '',
        },
      });
      expect(startedExecutionName()).toMatch(new RegExp(`^${TENANT_ID}-${APP_ID}-u-\\d+$`));
    },
  );

  test('compensates a rejected workflow start UPDATING → UPDATE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(deploymentRecord({ status: 'UPDATING' }))
      .mockResolvedValueOnce(deploymentRecord({ status: 'UPDATE_FAILED' }));
    const service = makeService({
      deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord()), transitionStatus },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });

    await expect(service.UpdateDeployment(key, context)).rejects.toThrow('start rejected');

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['UPDATING'],
      to: 'UPDATE_FAILED',
    });
  });

  test('a deployment whose tenant record is missing is an invariant violation (500)', async () => {
    const transitionStatus = jest.fn();
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(undefined) },
      deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord()), transitionStatus },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });
    await expect(service.UpdateDeployment(key, context)).rejects.toBeInstanceOf(InternalServerError);
    expect(transitionStatus).not.toHaveBeenCalled();
  });
});

describe('DeleteDeployment', () => {
  const key = { tenantId: TENANT_ID, applicationId: APP_ID };

  test.each(['CREATING', 'UPDATING', 'DELETING'] as const)(
    'rejects with 409 while in-flight (%s)',
    async (status) => {
      const service = makeService({
        deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord({ status })) },
      });
      await expect(service.DeleteDeployment(key, context)).rejects.toBeInstanceOf(ConflictError);
    },
  );

  test.each(['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'] as const)(
    'transitions on the accepted set and starts the tenant delete build from %s',
    async (status) => {
      const transitionStatus = jest.fn().mockResolvedValue(deploymentRecord({ status: 'DELETING' }));
      const service = makeService({
        deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord({ status })), transitionStatus },
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
      });

      const output = await service.DeleteDeployment(key, context);

      expect(output.deployment?.status).toBe('DELETING');
      expect(transitionStatus.mock.calls[0][1]).toMatchObject({
        fromAnyOf: ['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
        to: 'DELETING',
      });
      expect(startedWorkflowInput()).toEqual({
        sourceType: 'GITHUB',
        sourceLocation: 'https://github.com/acme/stamped.git',
        sourceVersion: '',
        operatorId: 'op-1',
        ...accountInput,
        applicationId: APP_ID,
        cellId: CELL_ID,
        tenantId: TENANT_ID,
        tenantBuild: {
          operation: 'delete',
          scriptPath: 'stamped/tenant/delete.sh',
          failedStatus: 'DELETE_FAILED',
          tenantName: 'acme', // from the tenant record (ADR-023)
          adminEmail: '',
        },
      });
      expect(startedExecutionName()).toMatch(new RegExp(`^${TENANT_ID}-${APP_ID}-d-\\d+$`));
    },
  );

  test('is allowed regardless of cell status — cleanup must always be reachable (P-9)', async () => {
    const transitionStatus = jest.fn().mockResolvedValue(deploymentRecord({ status: 'DELETING' }));
    const service = makeService({
      deploymentRepo: {
        get: jest.fn().mockResolvedValue(deploymentRecord({ status: 'CREATE_FAILED' })),
        transitionStatus,
      },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status: 'CREATE_FAILED' })) },
    });

    const output = await service.DeleteDeployment(key, context);
    expect(output.deployment?.status).toBe('DELETING');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(1);
  });

  test('compensates a rejected workflow start DELETING → DELETE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(deploymentRecord({ status: 'DELETING' }))
      .mockResolvedValueOnce(deploymentRecord({ status: 'DELETE_FAILED' }));
    const service = makeService({
      deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord()), transitionStatus },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });

    await expect(service.DeleteDeployment(key, context)).rejects.toThrow('start rejected');

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['DELETING'],
      to: 'DELETE_FAILED',
    });
  });

  test('maps a stale transition to 409', async () => {
    const service = makeService({
      deploymentRepo: {
        get: jest.fn().mockResolvedValue(deploymentRecord()),
        transitionStatus: jest.fn().mockRejectedValue(new StaleTransitionError('raced')),
      },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });
    await expect(service.DeleteDeployment(key, context)).rejects.toBeInstanceOf(ConflictError);
  });

  test('throws the modelled 404 for a missing deployment', async () => {
    const service = makeService({ deploymentRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.DeleteDeployment(key, context)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe('ListDeployments (§5.2, R-10)', () => {
  function listService() {
    const queryIndex = jest.fn().mockResolvedValue({ items: [deploymentRecord()], nextToken: 'token-1' });
    const queryPartition = jest.fn().mockResolvedValue({ items: [deploymentRecord()], nextToken: undefined });
    return { queryIndex, queryPartition, service: makeService({ deploymentRepo: { queryIndex, queryPartition } }) };
  }

  test('unfiltered: the static GSI-2 DEPLOYMENT partition, with pagination pass-through', async () => {
    const { queryIndex, service } = listService();
    const output = await service.ListDeployments({ maxResults: 10, nextToken: 'token-0' }, context);
    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI2', partitionKey: { name: 'GSI2PK', value: 'DEPLOYMENT' } },
      10,
      'token-0',
    );
    expect(output.deployments).toEqual([
      expect.objectContaining({ tenantId: TENANT_ID, applicationId: APP_ID, cellId: CELL_ID }),
    ]);
    expect(output.nextToken).toBe('token-1');
  });

  test('?tenantId= is a base-table query of the tenant partition — no index', async () => {
    const { queryIndex, queryPartition, service } = listService();
    await service.ListDeployments({ tenantId: TENANT_ID, maxResults: 5 }, context);
    expect(queryPartition).toHaveBeenCalledWith(
      { partitionKey: `TENANT#${TENANT_ID}`, sortKeyPrefix: 'DEPLOYMENT#' },
      5,
      undefined,
    );
    expect(queryIndex).not.toHaveBeenCalled();
  });

  test('?cellId= is the GSI-1 cell partition', async () => {
    const { queryIndex, service } = listService();
    await service.ListDeployments({ cellId: CELL_ID }, context);
    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: `CELL#${CELL_ID}` } },
      undefined,
      undefined,
    );
  });

  test('?applicationId= is the GSI-3 application partition, deployments only', async () => {
    const { queryIndex, service } = listService();
    await service.ListDeployments({ applicationId: APP_ID }, context);
    expect(queryIndex).toHaveBeenCalledWith(
      {
        indexName: 'GSI3',
        partitionKey: { name: 'GSI3PK', value: `APPLICATION#${APP_ID}` },
        sortKeyPrefix: 'DEPLOYMENT#',
      },
      undefined,
      undefined,
    );
  });

  test.each([
    { tenantId: TENANT_ID, cellId: CELL_ID },
    { tenantId: TENANT_ID, applicationId: APP_ID },
    { cellId: CELL_ID, applicationId: APP_ID },
  ])('two filters at once are a 400 and nothing is queried (%o)', async (filters) => {
    const { queryIndex, queryPartition, service } = listService();
    await expect(service.ListDeployments(filters, context)).rejects.toBeInstanceOf(ValidationException);
    expect(queryIndex).not.toHaveBeenCalled();
    expect(queryPartition).not.toHaveBeenCalled();
  });

  test('an unknown filter value yields an empty page, not a 404', async () => {
    const service = makeService({
      deploymentRepo: { queryIndex: jest.fn().mockResolvedValue({ items: [], nextToken: undefined }) },
    });
    await expect(service.ListDeployments({ cellId: OTHER_CELL_ID }, context)).resolves.toEqual({
      deployments: [],
      nextToken: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Cells (§5.3)
// ---------------------------------------------------------------------------

describe('GetCell', () => {
  test('returns the full cell record including application, account and stamped definition', async () => {
    const service = makeService({
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 3 })) },
    });
    const output = await service.GetCell({ cellId: CELL_ID }, context);
    expect(output.cell).toMatchObject({ tenantCount: 3, applicationId: APP_ID, accountId: ACCOUNT_ID });
    expect(output.cell?.source).toEqual(stampedSource);
    expect(output.cell?.cellScripts).toEqual(stampedCellScripts);
    expect(output.cell?.tenantScripts).toEqual(stampedTenantScripts);
  });

  test('throws the modelled 404 for a missing cell', async () => {
    const service = makeService({ cellRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.GetCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});

describe('ListCells', () => {
  test('unfiltered: the static GSI-1 CELL partition with pagination pass-through', async () => {
    const queryIndex = jest.fn().mockResolvedValue({ items: [cellRecord()], nextToken: 'token-1' });
    const service = makeService({ cellRepo: { queryIndex } });

    const output = await service.ListCells({ maxResults: 20, nextToken: 'token-0' }, context);

    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'CELL' } },
      20,
      'token-0',
    );
    expect(output.cells).toEqual([expect.objectContaining({ applicationId: APP_ID, accountId: ACCOUNT_ID })]);
    expect(output.nextToken).toBe('token-1');
  });

  test('?accountId= is the GSI-2 account partition', async () => {
    const queryIndex = cellPage(cellRecord());
    const service = makeService({ cellRepo: { queryIndex } });
    await service.ListCells({ accountId: ACCOUNT_ID }, context);
    expect(queryIndex.mock.calls[0][0]).toEqual({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', value: `ACCOUNT#${ACCOUNT_ID}` },
    });
  });

  test('?applicationId= is the GSI-3 application partition, cells only', async () => {
    const queryIndex = cellPage(cellRecord());
    const service = makeService({ cellRepo: { queryIndex } });
    await service.ListCells({ applicationId: APP_ID }, context);
    expect(queryIndex.mock.calls[0][0]).toEqual({
      indexName: 'GSI3',
      partitionKey: { name: 'GSI3PK', value: `APPLICATION#${APP_ID}` },
      sortKeyPrefix: 'CELL#',
    });
  });

  test('two filters at once are a 400', async () => {
    const queryIndex = jest.fn();
    const service = makeService({ cellRepo: { queryIndex } });
    await expect(
      service.ListCells({ accountId: ACCOUNT_ID, applicationId: APP_ID }, context),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(queryIndex).not.toHaveBeenCalled();
  });

  test('an unknown accountId yields an empty page, not a 404', async () => {
    const service = makeService({ cellRepo: { queryIndex: cellPage() } });
    await expect(service.ListCells({ accountId: '555555555555' }, context)).resolves.toEqual({
      cells: [],
      nextToken: undefined,
    });
  });
});

describe('UpdateCell', () => {
  test.each(['CREATING', 'UPDATING', 'DELETING', 'CREATE_FAILED', 'DELETE_FAILED'] as const)(
    'rejects with 409 from %s',
    async (status) => {
      const service = makeService({
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status })) },
      });
      await expect(service.UpdateCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(
        ConflictError,
      );
    },
  );

  test.each(['ACTIVE', 'UPDATE_FAILED'] as const)(
    'transitions and starts a cell-only update build from %s',
    async (status) => {
      const transitionStatus = jest.fn().mockResolvedValue(cellRecord({ status: 'UPDATING' }));
      const service = makeService({
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status })), transitionStatus },
      });

      const output = await service.UpdateCell({ cellId: CELL_ID }, context);

      expect(output.cell?.status).toBe('UPDATING');
      expect(transitionStatus.mock.calls[0][1]).toMatchObject({
        fromAnyOf: ['ACTIVE', 'UPDATE_FAILED'],
        to: 'UPDATING',
      });
      expect(startedWorkflowInput()).toEqual({
        sourceType: 'GITHUB',
        sourceLocation: 'https://github.com/acme/stamped.git',
        sourceVersion: '',
        operatorId: 'op-1',
        ...accountInput,
        applicationId: APP_ID, // the cell's application (ADR-032)
        cellId: CELL_ID,
        cellBuild: {
          operation: 'update',
          scriptPath: 'stamped/cell/update.sh',
          failedStatus: 'UPDATE_FAILED',
        },
      });
    },
  );

  test('compensates a rejected workflow start UPDATING → UPDATE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(cellRecord({ status: 'UPDATING' }))
      .mockResolvedValueOnce(cellRecord({ status: 'UPDATE_FAILED' }));
    const service = makeService({
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()), transitionStatus },
    });

    await expect(service.UpdateCell({ cellId: CELL_ID }, context)).rejects.toThrow('start rejected');

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['UPDATING'],
      to: 'UPDATE_FAILED',
    });
  });

  test('a cell whose account record is missing is an invariant violation (500), never a 404', async () => {
    const service = makeService({
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
      accountRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.UpdateCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(InternalServerError);
  });
});

describe('DeleteCell', () => {
  test('sets DELETING via the single atomic emptiness-guarded transition (ADR-014)', async () => {
    const transitionStatus = jest
      .fn()
      .mockResolvedValue(cellRecord({ status: 'DELETING', tenantCount: 0 }));
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 0 })),
        transitionStatus,
      },
    });

    const output = await service.DeleteCell({ cellId: CELL_ID }, context);

    expect(output.cell?.status).toBe('DELETING');
    const transition = transitionStatus.mock.calls[0][1];
    expect(transition).toMatchObject({
      fromAnyOf: ['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
      to: 'DELETING',
    });
    expect(transition.extraCondition.conditionExpression).toBe('#tenantCount = :zero');
    // applicationId rides the input so the workflow releases the application's slot (§8.2).
    expect(startedWorkflowInput()).toEqual({
      sourceType: 'GITHUB',
      sourceLocation: 'https://github.com/acme/stamped.git',
      sourceVersion: '',
      operatorId: 'op-1',
      ...accountInput,
      applicationId: APP_ID,
      cellId: CELL_ID,
      cellBuild: {
        operation: 'delete',
        scriptPath: 'stamped/cell/delete.sh',
        failedStatus: 'DELETE_FAILED',
      },
    });
  });

  test('condition failure (occupied or in-flight) maps to 409', async () => {
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 2 })),
        transitionStatus: jest.fn().mockRejectedValue(new StaleTransitionError('occupied')),
      },
    });
    await expect(service.DeleteCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('throws the modelled 404 for a missing cell', async () => {
    const service = makeService({ cellRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.DeleteCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test('compensates a rejected workflow start DELETING → DELETE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(cellRecord({ status: 'DELETING', tenantCount: 0 }))
      .mockResolvedValueOnce(cellRecord({ status: 'DELETE_FAILED', tenantCount: 0 }));
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 0 })),
        transitionStatus,
      },
    });

    await expect(service.DeleteCell({ cellId: CELL_ID }, context)).rejects.toThrow('start rejected');

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['DELETING'],
      to: 'DELETE_FAILED',
    });
  });

  test('resolves the cell account and its external id into the execution input (R-20, ADR-025)', async () => {
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 0, accountId: TENANT_ACCOUNT_ID })),
        transitionStatus: jest.fn().mockResolvedValue(cellRecord({ status: 'DELETING', tenantCount: 0, accountId: TENANT_ACCOUNT_ID })),
      },
      accountRepo: {
        get: jest.fn().mockResolvedValue(accountRecord({ accountId: TENANT_ACCOUNT_ID, owner: 'TENANT', externalId: 'ext-9' })),
      },
    });
    await service.DeleteCell({ cellId: CELL_ID }, context);
    expect(startedWorkflowInput()).toMatchObject({
      accountId: TENANT_ACCOUNT_ID,
      externalId: 'ext-9',
      cellRoleArn: `arn:aws:iam::${TENANT_ACCOUNT_ID}:role/control-plane-cell-provisioning`,
    });
  });
});

describe('operator propagation and source pinning (M12 / M10)', () => {
  test('a stamped source pin and a different operator flow into the workflow input', async () => {
    const sha = '4f0c9e1b2a3d4c5e6f708192a3b4c5d6e7f80912';
    const pinnedSource: SourceDefinition = { ...stampedSource, sourceVersion: sha };
    const transitionStatus = jest.fn().mockResolvedValue(cellRecord({ status: 'UPDATING' }));
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ source: pinnedSource })),
        transitionStatus,
      },
    });

    await service.UpdateCell({ cellId: CELL_ID }, { operatorId: 'op-2', role: 'operator' });

    expect(startedWorkflowInput().sourceVersion).toBe(sha);
    expect(startedWorkflowInput().operatorId).toBe('op-2');
  });
});

// ---------------------------------------------------------------------------
// Accounts (§5.4, ADR-024, ADR-027, ADR-033)
// ---------------------------------------------------------------------------

describe('PutAccount (§5.4, ADR-027)', () => {
  const putInput = { accountId: TENANT_ACCOUNT_ID, owner: 'TENANT' as const, maxCells: 1, externalId: 'ext-1' };
  /** The account is not registered yet, so the owner check reads nothing. */
  const unregistered = () => jest.fn().mockResolvedValue(undefined);

  test('probes both roles with the external id, then writes the create-or-replace update', async () => {
    const handshake = jest.fn().mockResolvedValue([]);
    const update = jest.fn().mockResolvedValue(accountRecord({ ...putInput, cellCount: 0 }));
    const service = makeService({ handshake, accountRepo: { get: unregistered(), update } });

    const output = await service.PutAccount(putInput, context);

    expect(handshake).toHaveBeenCalledWith({ accountId: TENANT_ACCOUNT_ID, externalId: 'ext-1', operatorId: 'op-1' });
    const [key, write] = update.mock.calls[0];
    expect(key).toEqual({ PK: `ACCOUNT#${TENANT_ACCOUNT_ID}`, SK: 'META' });
    expect(write.conditionExpression).toBe('attribute_not_exists(PK) OR #owner = :owner');
    // R-24: the counter is only ever initialised, never written.
    expect(write.updateExpression).toContain('#cellCount = if_not_exists(#cellCount, :zero)');
    expect(write.updateExpression).not.toMatch(/#cellCount = :|#cellCount \+/);
    // An absent applicationIds makes the account shared.
    expect(write.updateExpression).toMatch(/REMOVE #applicationIds$/);
    // The external id is never returned (N-10) — only that one is set.
    expect(output.account).toMatchObject({ accountId: TENANT_ACCOUNT_ID, owner: 'TENANT', externalIdConfigured: true });
    expect(output.account).not.toHaveProperty('externalId');
  });

  test('a dedicated account: every applicationIds entry is looked up, then SET on the record (ADR-033)', async () => {
    const appGet = jest.fn().mockResolvedValue(applicationRecord());
    const update = jest.fn().mockResolvedValue(accountRecord({ applicationIds: [APP_ID, OTHER_APP_ID] }));
    const service = makeService({ applicationRepo: { get: appGet }, accountRepo: { update } });

    const output = await service.PutAccount(
      { accountId: ACCOUNT_ID, owner: 'VENDOR', maxCells: 2, applicationIds: [APP_ID, OTHER_APP_ID] },
      context,
    );

    expect(appGet.mock.calls.map((call) => call[0])).toEqual([
      { PK: `APPLICATION#${APP_ID}`, SK: 'META' },
      { PK: `APPLICATION#${OTHER_APP_ID}`, SK: 'META' },
    ]);
    const write = update.mock.calls[0][1];
    expect(write.updateExpression).toContain('#applicationIds = :applicationIds');
    expect(write.expressionAttributeValues[':applicationIds']).toEqual([APP_ID, OTHER_APP_ID]);
    expect(output.account?.applicationIds).toEqual([APP_ID, OTHER_APP_ID]);
  });

  test('an unregistered application in applicationIds is a 404 before the handshake and nothing is written', async () => {
    const handshake = jest.fn().mockResolvedValue([]);
    const update = jest.fn();
    const service = makeService({
      handshake,
      applicationRepo: {
        get: jest.fn().mockImplementation(async (key: { PK: string }) =>
          key.PK === `APPLICATION#${APP_ID}` ? applicationRecord() : undefined),
      },
      accountRepo: { update },
    });
    await expect(
      service.PutAccount({ ...putInput, applicationIds: [APP_ID, 'app-missing'] }, context),
    ).rejects.toMatchObject({ name: 'ResourceNotFoundError', message: expect.stringContaining('app-missing') });
    expect(handshake).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('an empty applicationIds list is a 400 — omit it to admit every application', async () => {
    const handshake = jest.fn();
    const update = jest.fn();
    const service = makeService({ handshake, accountRepo: { update } });
    await expect(service.PutAccount({ ...putInput, applicationIds: [] }, context)).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(handshake).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('a refused handshake is a 400 naming the role and the reason, and nothing is written (R-26)', async () => {
    const update = jest.fn();
    const service = makeService({
      handshake: jest.fn().mockResolvedValue([
        {
          kind: 'tenant',
          roleArn: 'arn:aws:iam::222222222222:role/control-plane-tenant-provisioning',
          reason: 'could not be assumed (AccessDenied: not authorized)',
        },
        {
          kind: 'cell',
          roleArn: 'arn:aws:iam::222222222222:role/control-plane-cell-provisioning',
          reason: 'does not require the external id (its trust policy has no sts:ExternalId condition; redeploy the pair with externalId)',
        },
      ]),
      accountRepo: { get: unregistered(), update },
    });
    await expect(service.PutAccount(putInput, context)).rejects.toMatchObject({
      name: 'ValidationException',
      message: expect.stringMatching(
        /control-plane-tenant-provisioning could not be assumed \(AccessDenied: not authorized\); .*control-plane-cell-provisioning does not require the external id/,
      ),
    });
    expect(update).not.toHaveBeenCalled();
  });

  test('a probe STS could not answer is a 500 asking for a retry, not a refusal, and nothing is written', async () => {
    const update = jest.fn();
    const service = makeService({
      handshake: jest.fn().mockRejectedValue(
        new HandshakeUnavailableError('arn:aws:iam::222222222222:role/control-plane-cell-provisioning', Object.assign(new Error('Rate exceeded'), { name: 'Throttling' })),
      ),
      accountRepo: { get: unregistered(), update },
    });
    await expect(service.PutAccount(putInput, context)).rejects.toMatchObject({
      name: 'InternalServerError',
      message: expect.stringMatching(/Throttling: Rate exceeded.*retry/),
    });
    expect(update).not.toHaveBeenCalled();
  });

  test('a tenant-owned account without an externalId is a 400 before the probe runs (§6.4, ADR-029)', async () => {
    const handshake = jest.fn().mockResolvedValue([]);
    const update = jest.fn();
    const service = makeService({ handshake, accountRepo: { get: unregistered(), update } });
    await expect(
      service.PutAccount({ accountId: TENANT_ACCOUNT_ID, owner: 'TENANT', maxCells: 1 }, context),
    ).rejects.toMatchObject({ name: 'ValidationException', message: expect.stringContaining('externalId is required') });
    expect(handshake).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('a vendor-owned account may omit the externalId', async () => {
    const handshake = jest.fn().mockResolvedValue([]);
    const update = jest.fn().mockResolvedValue(accountRecord({ cellCount: 0 }));
    const service = makeService({ handshake, accountRepo: { get: unregistered(), update } });
    const output = await service.PutAccount({ accountId: ACCOUNT_ID, owner: 'VENDOR', maxCells: 2 }, context);
    expect(handshake).toHaveBeenCalledWith({ accountId: ACCOUNT_ID, externalId: undefined, operatorId: 'op-1' });
    expect(output.account).toMatchObject({ accountId: ACCOUNT_ID, owner: 'VENDOR' });
    expect(output.account?.applicationIds).toBeUndefined();
  });

  test('an owner change on a registered account is a 409 from the stored record, before any probe (R-24)', async () => {
    const handshake = jest.fn().mockResolvedValue([]);
    const update = jest.fn();
    const service = makeService({
      handshake,
      accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ accountId: TENANT_ACCOUNT_ID, owner: 'TENANT' })), update },
    });
    await expect(service.PutAccount({ ...putInput, owner: 'VENDOR' }, context)).rejects.toMatchObject({
      name: 'ConflictError',
      message: expect.stringContaining('owner is immutable'),
    });
    expect(handshake).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('an owner change that lands between the read and the write is still a 409 (the conditional write)', async () => {
    const service = makeService({
      accountRepo: {
        get: unregistered(),
        update: jest.fn().mockRejectedValue(new ConditionFailedError('owner')),
      },
    });
    await expect(service.PutAccount({ ...putInput, owner: 'VENDOR' }, context)).rejects.toBeInstanceOf(ConflictError);
  });

  test('re-registering with the same owner probes and replaces the policy fields', async () => {
    const handshake = jest.fn().mockResolvedValue([]);
    const update = jest.fn().mockResolvedValue(accountRecord({ ...putInput, maxCells: 3, cellCount: 1 }));
    const service = makeService({
      handshake,
      accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ ...putInput, cellCount: 1 })), update },
    });
    const output = await service.PutAccount({ ...putInput, maxCells: 3 }, context);
    expect(handshake).toHaveBeenCalledTimes(1);
    expect(output.account).toMatchObject({ accountId: TENANT_ACCOUNT_ID, owner: 'TENANT', maxCells: 3, cellCount: 1 });
  });
});

describe('GetAccount / ListAccounts / DeleteAccount (§5.4)', () => {
  test('GetAccount returns the record without the external id value; 404 when unregistered', async () => {
    const service = makeService({
      accountRepo: {
        get: jest
          .fn()
          .mockResolvedValueOnce(accountRecord({ externalId: 'secret-ish', applicationIds: [APP_ID] }))
          .mockResolvedValueOnce(undefined),
      },
    });
    const output = await service.GetAccount({ accountId: ACCOUNT_ID }, context);
    expect(output.account).toMatchObject({
      accountId: ACCOUNT_ID,
      cellCount: 1,
      maxCells: 2,
      applicationIds: [APP_ID],
      externalIdConfigured: true,
    });
    expect(JSON.stringify(output)).not.toContain('secret-ish');
    await expect(service.GetAccount({ accountId: ACCOUNT_ID }, context)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test('ListAccounts pages the static GSI-1 ACCOUNT partition', async () => {
    const queryIndex = jest.fn().mockResolvedValue({ items: [accountRecord()], nextToken: 'next' });
    const service = makeService({ accountRepo: { queryIndex } });
    const output = await service.ListAccounts({ maxResults: 10, nextToken: 'prev' }, context);
    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'ACCOUNT' } },
      10,
      'prev',
    );
    expect(output).toMatchObject({ accounts: [{ accountId: ACCOUNT_ID }], nextToken: 'next' });
  });

  test('DeleteAccount is one conditional delete on cellCount = 0; condition failure is a 409', async () => {
    const del = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ConditionFailedError('occupied'));
    const service = makeService({
      accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ cellCount: 0 })), delete: del },
    });
    await expect(service.DeleteAccount({ accountId: ACCOUNT_ID }, context)).resolves.toMatchObject({
      account: { accountId: ACCOUNT_ID },
    });
    expect(del).toHaveBeenCalledWith(
      { PK: `ACCOUNT#${ACCOUNT_ID}`, SK: 'META' },
      expect.objectContaining({ conditionExpression: 'attribute_exists(PK) AND #cellCount = :zero' }),
    );
    await expect(service.DeleteAccount({ accountId: ACCOUNT_ID }, context)).rejects.toBeInstanceOf(ConflictError);
  });

  test('DeleteAccount of an unregistered account is a 404', async () => {
    const service = makeService({ accountRepo: { get: jest.fn().mockResolvedValue(undefined), delete: jest.fn() } });
    await expect(service.DeleteAccount({ accountId: '555555555555' }, context)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Applications (§5.5, ADR-032, ADR-036)
// ---------------------------------------------------------------------------

describe('PutApplication (§5.5, R-29)', () => {
  const putInput = {
    applicationId: APP_ID,
    source: applicationSource,
    cellScripts: applicationCellScripts,
    tenantScripts: applicationTenantScripts,
    maxTenants: 4,
  };

  test('writes the definition and the default FILL strategy, never cellCount, and runs no build', async () => {
    const update = jest.fn().mockResolvedValue(applicationRecord({ cellCount: 0 }));
    const service = makeService({ applicationRepo: { update } });

    const output = await service.PutApplication(putInput, context);

    const [key, write] = update.mock.calls[0];
    expect(key).toEqual({ PK: `APPLICATION#${APP_ID}`, SK: 'META' });
    expect(write.expressionAttributeValues).toMatchObject({
      ':applicationId': APP_ID,
      ':source': { type: 'GITHUB', location: 'https://github.com/acme/application.git' },
      ':cellScripts': applicationCellScripts,
      ':tenantScripts': applicationTenantScripts,
      ':maxTenants': 4,
      ':placementStrategy': 'FILL',
    });
    expect(write.updateExpression).toContain('#cellCount = if_not_exists(#cellCount, :zero)');
    expect(write.updateExpression).not.toMatch(/#cellCount = :|#cellCount \+/);
    expect(output.application).toMatchObject({ applicationId: APP_ID, placementStrategy: 'FILL', cellCount: 0 });
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('an explicit placementStrategy is written as given (ADR-036)', async () => {
    const update = jest.fn().mockResolvedValue(applicationRecord({ placementStrategy: 'ROUND_ROBIN' }));
    const service = makeService({ applicationRepo: { update } });
    await service.PutApplication({ ...putInput, placementStrategy: 'ROUND_ROBIN' }, context);
    expect(update.mock.calls[0][1].expressionAttributeValues[':placementStrategy']).toBe('ROUND_ROBIN');
  });

  test('an unpinned source is accepted with a warning naming the application (ADR-020, M10)', async () => {
    const warn = jest.fn();
    const update = jest.fn().mockResolvedValue(applicationRecord());
    const service = makeService({ warn, applicationRepo: { update } });
    await service.PutApplication(putInput, context);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(new RegExp(`^PutApplication ${APP_ID}: `));
    expect(warn.mock.calls[0][0]).toContain('default branch HEAD');
    expect(update).toHaveBeenCalledTimes(1);
  });

  test('a source pinned to a full commit SHA is accepted silently and the pin is stored', async () => {
    const warn = jest.fn();
    const sha = '4f0c9e1b2a3d4c5e6f708192a3b4c5d6e7f80912';
    const update = jest.fn().mockResolvedValue(applicationRecord());
    const service = makeService({ warn, applicationRepo: { update } });
    await service.PutApplication({ ...putInput, source: { ...applicationSource, sourceVersion: sha } }, context);
    expect(warn).not.toHaveBeenCalled();
    expect(update.mock.calls[0][1].expressionAttributeValues[':source']).toEqual({
      ...applicationSource,
      sourceVersion: sha,
    });
  });

  test('the generated SSDK validation rejects an invalid definition before the handler (400, §5.5)', () => {
    const failures = (input: Partial<PutApplicationInput>) =>
      PutApplicationInput.validate({ ...putInput, ...input } as PutApplicationInput).map((f) => f.path);
    expect(failures({})).toEqual([]);
    expect(failures({ tenantScripts: { create: 'c.sh', update: 'u.sh', delete: undefined } })).toEqual([
      '/tenantScripts/delete',
    ]);
    expect(failures({ applicationId: 'App_X' })).toEqual(['/applicationId']);
    expect(failures({ applicationId: 'a'.repeat(33) })).toEqual(['/applicationId']);
    expect(failures({ maxTenants: 0 })).toEqual(['/maxTenants']);
  });

  test('a missing script path that bypassed validation is refused before any write (defence in depth)', async () => {
    const update = jest.fn();
    const service = makeService({ applicationRepo: { update } });
    await expect(
      service.PutApplication(
        { ...putInput, tenantScripts: { create: 'c.sh', update: 'u.sh', delete: undefined } },
        context,
      ),
    ).rejects.toBeInstanceOf(InternalServerError);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('GetApplication / ListApplications / DeleteApplication (§5.5)', () => {
  test('GetApplication returns the definition, strategy and cellCount; 404 when unregistered', async () => {
    const service = makeService({
      applicationRepo: {
        get: jest.fn().mockResolvedValueOnce(applicationRecord({ cellCount: 2 })).mockResolvedValueOnce(undefined),
      },
    });
    const output = await service.GetApplication({ applicationId: APP_ID }, context);
    expect(output.application).toMatchObject({
      applicationId: APP_ID,
      source: applicationSource,
      maxTenants: 4,
      placementStrategy: 'FILL',
      cellCount: 2,
    });
    await expect(service.GetApplication({ applicationId: APP_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test('ListApplications pages the static GSI-1 APPLICATION partition', async () => {
    const queryIndex = jest.fn().mockResolvedValue({ items: [applicationRecord()], nextToken: 'next' });
    const service = makeService({ applicationRepo: { queryIndex } });
    const output = await service.ListApplications({ maxResults: 10, nextToken: 'prev' }, context);
    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'APPLICATION' } },
      10,
      'prev',
    );
    expect(output).toMatchObject({ applications: [{ applicationId: APP_ID }], nextToken: 'next' });
  });

  test('DeleteApplication is one conditional delete on cellCount = 0; condition failure is a 409', async () => {
    const del = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ConditionFailedError('occupied'));
    const service = makeService({
      applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ cellCount: 0 })), delete: del },
    });
    await expect(service.DeleteApplication({ applicationId: APP_ID }, context)).resolves.toMatchObject({
      application: { applicationId: APP_ID },
    });
    expect(del).toHaveBeenCalledWith(
      { PK: `APPLICATION#${APP_ID}`, SK: 'META' },
      {
        conditionExpression: 'attribute_exists(PK) AND #cellCount = :zero',
        expressionAttributeNames: { '#cellCount': 'cellCount' },
        expressionAttributeValues: { ':zero': 0 },
      },
    );
    await expect(service.DeleteApplication({ applicationId: APP_ID }, context)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test('DeleteApplication of an unregistered application is a 404', async () => {
    const del = jest.fn();
    const service = makeService({ applicationRepo: { get: jest.fn().mockResolvedValue(undefined), delete: del } });
    await expect(service.DeleteApplication({ applicationId: 'app-missing' }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    expect(del).not.toHaveBeenCalled();
  });
});

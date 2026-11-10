// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AccountFullError,
  AmbiguousTransactionError,
  ConditionFailedError,
  DuplicateTokenError,
  DynamoDBRepository,
  PlacementRaceLostError,
  PlacementTransactions,
  RecordGoneError,
  StaleTransitionError,
} from '../../src/shared/repository';
import { CallerContext } from '../../src/shared/service-config';
import {
  ConflictError,
  InsufficientCapacityError,
  InternalServerError,
  ResourceNotFoundError,
} from '../../src/smithy/source/typescript-ssdk-codegen/src';
import { AccountItem, AccountRecord } from '../../src/tenant/account.data-model';
import { HandshakeProbe, HandshakeUnavailableError } from '../../src/tenant/account.handshake';
import { CellItem, CellRecord } from '../../src/tenant/cell.data-model';
import {
  IdempotencyItem,
  IdempotencyRecord,
  createTenantRequestHash,
} from '../../src/tenant/idempotency.data-model';
import { CellDefinition, StampedSourceDefinition, TenantService } from '../../src/tenant/tenant';
import { TenantItem, TenantRecord } from '../../src/tenant/tenant.data-model';

const sfnMock = mockClient(SFNClient);
const context: CallerContext = { operatorId: 'op-1', role: 'operator' };

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CELL_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const OTHER_CELL_ID = '01BX5ZZKBKACTAV9WEVGEMMVS0';
/** The vendor-owned home account every fixture cell lives in (synthetic). */
const ACCOUNT_ID = '111111111111';
/** A second, tenant-owned account (synthetic). */
const TENANT_ACCOUNT_ID = '222222222222';
const FLEET = 'control-plane';
const CELL_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${FLEET}-cell-provisioning`;
const TENANT_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${FLEET}-tenant-provisioning`;

/** The deployment-configured definition — deliberately distinct from the stamped fixtures below. */
const cellDefinition: CellDefinition = {
  source: { type: 'GITHUB', location: 'https://github.com/acme/deployment-config.git' },
  cellScripts: {
    create: 'scripts/sample-cell/create.sh',
    update: 'scripts/sample-cell/update.sh',
    delete: 'scripts/sample-cell/delete.sh',
  },
  tenantScripts: {
    create: 'scripts/sample-tenant/create.sh',
    update: 'scripts/sample-tenant/update.sh',
    delete: 'scripts/sample-tenant/delete.sh',
  },
  maxTenants: 5,
};

/** Stamped values on the cell record — distinct from the deployment config to prove resolution. */
const stampedSource = { type: 'GITHUB' as const, location: 'https://github.com/acme/stamped.git' };
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
    cellId: CELL_ID,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

type TenantRepo = DynamoDBRepository<TenantRecord, TenantItem>;
type CellRepo = DynamoDBRepository<CellRecord, CellItem>;
type IdempotencyRepo = DynamoDBRepository<IdempotencyRecord, IdempotencyItem>;
type AccountRepo = DynamoDBRepository<AccountRecord, AccountItem>;
type Placement = PlacementTransactions<CellRecord, CellItem, TenantRecord, TenantItem>;

interface Mocks {
  tenantRepo?: Partial<TenantRepo>;
  cellRepo?: Partial<CellRepo>;
  idempotencyRepo?: Partial<IdempotencyRepo>;
  /** Defaults to one registered vendor-owned account (ACCOUNT_ID) with a free cell slot. */
  accountRepo?: Partial<AccountRepo>;
  placement?: Partial<Placement>;
  /** Defaults to a passing handshake. */
  handshake?: HandshakeProbe;
}

/** One-page account listing result. */
function accountPage(...accounts: AccountRecord[]) {
  return jest.fn().mockResolvedValue({ items: accounts, nextToken: undefined });
}

function makeService(mocks: Mocks = {}) {
  const defaultAccountRepo: Partial<AccountRepo> = {
    get: jest.fn().mockResolvedValue(accountRecord()),
    queryIndex: accountPage(accountRecord()),
  };
  return new TenantService({
    tenantRepository: (mocks.tenantRepo ?? {}) as TenantRepo,
    cellRepository: (mocks.cellRepo ?? {}) as CellRepo,
    idempotencyRepository: (mocks.idempotencyRepo ?? {}) as IdempotencyRepo,
    accountRepository: (mocks.accountRepo ?? defaultAccountRepo) as AccountRepo,
    placement: (mocks.placement ?? {}) as Placement,
    cellDefinition,
    fleetName: FLEET,
    partition: 'aws',
    handshake: mocks.handshake ?? jest.fn().mockResolvedValue([]),
    stateMachineArn: 'arn:aws:states:eu-central-1:123456789012:stateMachine:provisioning',
    sfnClient: new SFNClient({}),
  });
}

/** One-page candidate scan result. */
function cellPage(...cells: CellRecord[]) {
  return jest.fn().mockResolvedValue({ items: cells, nextToken: undefined });
}

function startedWorkflowInput(call = 0) {
  return JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[call].args[0].input.input!);
}

/** The per-account workflow fields every execution carries (R-20, ADR-025) — the home account, no external id. */
const accountInput = {
  accountId: ACCOUNT_ID,
  externalId: '',
  cellRoleArn: CELL_ROLE_ARN,
  tenantRoleArn: TENANT_ROLE_ARN,
  sessionName: 'op-1',
};

beforeEach(() => {
  sfnMock.reset();
  sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:...:exec' });
});

describe('CreateTenant placement (§6)', () => {
  test('claims a slot in an existing ACTIVE cell and starts a tenant-only create build', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeTenantInCell },
    });

    const output = await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    expect(output.tenant?.status).toBe('CREATING');
    expect(output.tenant?.cellId).toBe(CELL_ID);

    // The claim is atomic: cell slot + tenant record in one transaction.
    const claim = placeTenantInCell.mock.calls[0][0];
    expect(claim.cellKey).toEqual({ PK: `CELL#${CELL_ID}`, SK: 'META' });
    expect(claim.tenant.status).toBe('CREATING');
    expect(claim.tenant.cellId).toBe(CELL_ID);
    // adminEmail is workflow input only, never persisted (ADR-004).
    expect(JSON.stringify(claim.tenant)).not.toContain('adminEmail');

    // Existing cell: tenantBuild create only, resolved from the STAMPED definition.
    expect(startedWorkflowInput()).toEqual({
      sourceType: 'GITHUB',
      sourceLocation: 'https://github.com/acme/stamped.git',
      sourceVersion: '', // unpinned stamped source (T5/M10)
      operatorId: 'op-1', // the initiating operator (T10/M12)
      ...accountInput,
      cellId: CELL_ID,
      tenantId: output.tenant?.tenantId,
      tenantBuild: {
        operation: 'create',
        scriptPath: 'stamped/tenant/create.sh',
        failedStatus: 'CREATE_FAILED',
        tenantName: 'acme', // every operation (ADR-023)
        adminEmail: 'success@simulator.amazonses.com',
      },
    });
  });

  test('filters non-ACTIVE and full cells from the candidate scan client-side', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: {
        queryIndex: cellPage(
          cellRecord({ cellId: OTHER_CELL_ID, status: 'CREATING' }),
          cellRecord({ cellId: OTHER_CELL_ID, status: 'ACTIVE', tenantCount: 5, maxTenants: 5 }),
          cellRecord(), // the only eligible candidate
        ),
      },
      placement: { placeTenantInCell },
    });

    const output = await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    expect(placeTenantInCell).toHaveBeenCalledTimes(1);
    expect(output.tenant?.cellId).toBe(CELL_ID);
  });

  test('a lost race moves to the next candidate', async () => {
    const placeTenantInCell = jest
      .fn()
      .mockRejectedValueOnce(new PlacementRaceLostError('lost'))
      .mockResolvedValueOnce(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord(), cellRecord({ cellId: OTHER_CELL_ID })) },
      placement: { placeTenantInCell },
    });

    const output = await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    expect(placeTenantInCell).toHaveBeenCalledTimes(2);
    expect(placeTenantInCell.mock.calls[1][0].tenant.cellId).toBe(OTHER_CELL_ID);
    expect(output.tenant?.cellId).toBe(OTHER_CELL_ID);
    expect(startedWorkflowInput().cellId).toBe(OTHER_CELL_ID);
  });

  test('exhausting the 5-attempt budget falls through to new-cell creation, not an error', async () => {
    const candidates = Array.from({ length: 7 }, (_, i) =>
      cellRecord({ cellId: `01BX5ZZKBKACTAV9WEVGEMMV${(i + 10).toString(36).toUpperCase()}` }),
    );
    const placeTenantInCell = jest.fn().mockRejectedValue(new PlacementRaceLostError('lost'));
    const createCellWithTenant = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(...candidates) },
      placement: { placeTenantInCell, createCellWithTenant },
    });

    const output = await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    // At most 5 claim attempts (§6) even though 7 candidates exist.
    expect(placeTenantInCell).toHaveBeenCalledTimes(5);
    expect(createCellWithTenant).toHaveBeenCalledTimes(1);
    expect(output.tenant?.status).toBe('CREATING');
  });

  test('no eligible candidate creates a new cell stamped from the deployment config', async () => {
    const createCellWithTenant = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant },
    });

    const output = await service.CreateTenant(
      { name: 'acme', description: 'first', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    const { cell, tenant } = createCellWithTenant.mock.calls[0][0];
    // New cell: CREATING, slot pre-claimed, definition stamped from config.
    expect(cell).toMatchObject({
      status: 'CREATING',
      tenantCount: 1,
      maxTenants: 5,
      source: cellDefinition.source,
      cellScripts: cellDefinition.cellScripts,
      tenantScripts: cellDefinition.tenantScripts,
    });
    expect(tenant.status).toBe('CREATING');
    expect(tenant.cellId).toBe(cell.cellId);
    expect(output.tenant?.cellId).toBe(cell.cellId);

    // New cell: cell create build precedes the tenant create build.
    expect(startedWorkflowInput()).toEqual({
      sourceType: 'GITHUB',
      sourceLocation: 'https://github.com/acme/deployment-config.git',
      sourceVersion: '',
      operatorId: 'op-1',
      ...accountInput,
      cellId: cell.cellId,
      cellBuild: {
        operation: 'create',
        scriptPath: 'scripts/sample-cell/create.sh',
        failedStatus: 'CREATE_FAILED',
      },
      tenantId: tenant.tenantId,
      tenantBuild: {
        operation: 'create',
        scriptPath: 'scripts/sample-tenant/create.sh',
        failedStatus: 'CREATE_FAILED',
        tenantName: 'acme', // every operation (ADR-023)
        adminEmail: 'success@simulator.amazonses.com',
      },
    });
  });

  test('an ambiguous claim outcome fails with 500 and never retargets', async () => {
    const placeTenantInCell = jest
      .fn()
      .mockRejectedValue(new AmbiguousTransactionError('unknown outcome'));
    const createCellWithTenant = jest.fn();
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord(), cellRecord({ cellId: OTHER_CELL_ID })) },
      placement: { placeTenantInCell, createCellWithTenant },
    });

    await expect(
      service.CreateTenant({ name: 'acme', adminEmail: 'success@simulator.amazonses.com' }, context),
    ).rejects.toBeInstanceOf(InternalServerError);

    // No second candidate, no new-cell fall-through, no workflow start.
    expect(placeTenantInCell).toHaveBeenCalledTimes(1);
    expect(createCellWithTenant).not.toHaveBeenCalled();
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('an ambiguous new-cell transaction fails with 500', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: {
        createCellWithTenant: jest
          .fn()
          .mockRejectedValue(new AmbiguousTransactionError('unknown outcome')),
      },
    });

    await expect(
      service.CreateTenant({ name: 'acme', adminEmail: 'success@simulator.amazonses.com' }, context),
    ).rejects.toBeInstanceOf(InternalServerError);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });
});

describe('CreateTenant compensation (§6)', () => {
  test('existing-cell placement: a rejected start compensates with a single tenant CAS', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('Step Functions unavailable'));
    const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'CREATE_FAILED' }));
    const failCreatingCellAndTenant = jest.fn();
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      tenantRepo: { transitionStatus },
      placement: { placeTenantInCell: jest.fn().mockResolvedValue(undefined), failCreatingCellAndTenant },
    });

    await expect(
      service.CreateTenant({ name: 'acme', adminEmail: 'success@simulator.amazonses.com' }, context),
    ).rejects.toThrow('Step Functions unavailable');

    expect(transitionStatus).toHaveBeenCalledTimes(1);
    expect(transitionStatus.mock.calls[0][1]).toMatchObject({
      fromAnyOf: ['CREATING'],
      to: 'CREATE_FAILED',
      setFields: { statusReason: expect.stringContaining('Failed to start provisioning workflow') },
    });
    // The paired shape is only for new-cell placement.
    expect(failCreatingCellAndTenant).not.toHaveBeenCalled();
  });

  test('new-cell placement: a rejected start compensates BOTH records with the paired transaction', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const failCreatingCellAndTenant = jest.fn().mockResolvedValue(undefined);
    const transitionStatus = jest.fn();
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      tenantRepo: { transitionStatus },
      placement: {
        createCellWithTenant: jest.fn().mockResolvedValue(undefined),
        failCreatingCellAndTenant,
      },
    });

    await expect(
      service.CreateTenant({ name: 'acme', adminEmail: 'success@simulator.amazonses.com' }, context),
    ).rejects.toThrow('start rejected');

    expect(failCreatingCellAndTenant).toHaveBeenCalledTimes(1);
    const compensation = failCreatingCellAndTenant.mock.calls[0][0];
    expect(compensation.cellKey.PK).toMatch(/^CELL#/);
    expect(compensation.tenantKey.PK).toMatch(/^TENANT#/);
    expect(compensation.statusReason).toContain('Failed to start provisioning workflow');
    // Never the single-CAS shape for a new cell.
    expect(transitionStatus).not.toHaveBeenCalled();
  });
});

describe('GetTenant', () => {
  test('returns the tenant including its placement', async () => {
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()) },
    });
    const output = await service.GetTenant({ tenantId: TENANT_ID }, context);
    expect(output.tenant?.cellId).toBe(CELL_ID);
  });

  test('throws the modelled 404 for a missing tenant', async () => {
    const service = makeService({ tenantRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.GetTenant({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});

describe('UpdateTenant', () => {
  test('updates only metadata fields via the existence-guarded write, no workflow', async () => {
    const updateExisting = jest.fn().mockResolvedValue(tenantRecord({ description: 'new desc' }));
    const service = makeService({ tenantRepo: { updateExisting } });

    const output = await service.UpdateTenant(
      { tenantId: TENANT_ID, description: 'new desc' },
      context,
    );

    expect(output.tenant?.description).toBe('new desc');
    const updateRequest = updateExisting.mock.calls[0][1];
    expect(updateRequest.updateExpression).toContain('#description = :description');
    expect(updateRequest.updateExpression).not.toContain('status');
    expect(updateRequest.updateExpression).not.toContain('lastBuildId');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('maps a concurrent-delete condition failure to 404, not 500 (§7)', async () => {
    const service = makeService({
      tenantRepo: {
        updateExisting: jest.fn().mockRejectedValue(new RecordGoneError('gone')),
      },
    });
    await expect(
      service.UpdateTenant({ tenantId: TENANT_ID, name: 'renamed' }, context),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe('DeleteTenant', () => {
  test.each(['CREATING', 'UPDATING', 'DELETING'] as const)(
    'rejects with 409 while in-flight (%s)',
    async (status) => {
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ status })) },
      });
      await expect(service.DeleteTenant({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
        ConflictError,
      );
    },
  );

  test.each(['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'] as const)(
    'transitions on the accepted set and starts the tenant delete build from %s',
    async (status) => {
      const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'DELETING' }));
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ status })), transitionStatus },
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
      });

      const output = await service.DeleteTenant({ tenantId: TENANT_ID }, context);

      expect(output.tenant?.status).toBe('DELETING');
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
        cellId: CELL_ID,
        tenantId: TENANT_ID,
        tenantBuild: {
          operation: 'delete',
          scriptPath: 'stamped/tenant/delete.sh',
          failedStatus: 'DELETE_FAILED',
          tenantName: 'acme', // from the stored record (ADR-023)
          adminEmail: '',
        },
      });
    },
  );

  test('is allowed regardless of cell status — cleanup must always be reachable (§5)', async () => {
    const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'DELETING' }));
    const service = makeService({
      tenantRepo: {
        get: jest.fn().mockResolvedValue(tenantRecord({ status: 'CREATE_FAILED' })),
        transitionStatus,
      },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status: 'CREATE_FAILED' })) },
    });

    const output = await service.DeleteTenant({ tenantId: TENANT_ID }, context);
    expect(output.tenant?.status).toBe('DELETING');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(1);
  });

  test('compensates a rejected workflow start DELETING → DELETE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(tenantRecord({ status: 'DELETING' }))
      .mockResolvedValueOnce(tenantRecord({ status: 'DELETE_FAILED' }));
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()), transitionStatus },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });

    await expect(service.DeleteTenant({ tenantId: TENANT_ID }, context)).rejects.toThrow(
      'start rejected',
    );

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['DELETING'],
      to: 'DELETE_FAILED',
    });
  });

  test('maps a stale transition to 409', async () => {
    const service = makeService({
      tenantRepo: {
        get: jest.fn().mockResolvedValue(tenantRecord()),
        transitionStatus: jest.fn().mockRejectedValue(new StaleTransitionError('raced')),
      },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });
    await expect(service.DeleteTenant({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('ListTenants', () => {
  test('unfiltered listing queries the static GSI-2 partition', async () => {
    const queryIndex = jest
      .fn()
      .mockResolvedValue({ items: [tenantRecord()], nextToken: 'token-1' });
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

  test('?cellId= filters via the tenant items GSI-1 partition', async () => {
    const queryIndex = jest.fn().mockResolvedValue({ items: [tenantRecord()], nextToken: undefined });
    const service = makeService({ tenantRepo: { queryIndex } });

    await service.ListTenants({ cellId: CELL_ID }, context);

    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: `CELL#${CELL_ID}` } },
      undefined,
      undefined,
    );
  });

  test('an unknown cellId yields an empty page, not a 404 (§5)', async () => {
    const service = makeService({
      tenantRepo: { queryIndex: jest.fn().mockResolvedValue({ items: [], nextToken: undefined }) },
    });
    const output = await service.ListTenants({ cellId: OTHER_CELL_ID }, context);
    expect(output.tenants).toEqual([]);
  });
});

describe('GetResource', () => {
  test('resolves source and scripts from the cell record, state from the tenant', async () => {
    const service = makeService({
      tenantRepo: {
        get: jest.fn().mockResolvedValue(tenantRecord({ lastBuildId: 'arn:build/1' })),
      },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });

    const output = await service.GetResource({ tenantId: TENANT_ID }, context);

    expect(output.source).toEqual(stampedSource);
    expect(output.scripts).toEqual(stampedTenantScripts);
    expect(output.status).toBe('ACTIVE');
    expect(output.lastBuildId).toBe('arn:build/1');
    expect(output.cellId).toBe(CELL_ID);
  });

  test('throws the modelled 404 for a missing tenant', async () => {
    const service = makeService({ tenantRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.GetResource({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test('a tenant referencing a missing cell is an invariant violation (500)', async () => {
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()) },
      cellRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.GetResource({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      InternalServerError,
    );
  });
});

describe('UpdateResource', () => {
  test.each(['CREATING', 'UPDATING', 'DELETING', 'CREATE_FAILED', 'DELETE_FAILED'] as const)(
    'rejects with 409 when the tenant is %s',
    async (status) => {
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ status })) },
      });
      await expect(service.UpdateResource({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
        ConflictError,
      );
    },
  );

  test.each(['CREATING', 'UPDATING', 'DELETING', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'] as const)(
    'rejects with 409 when the cell is %s (cross-entity guard, §5)',
    async (cellStatus) => {
      const transitionStatus = jest.fn();
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()), transitionStatus },
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status: cellStatus })) },
      });
      await expect(service.UpdateResource({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
        ConflictError,
      );
      // Guarded before any transition — no state was touched.
      expect(transitionStatus).not.toHaveBeenCalled();
    },
  );

  test.each(['ACTIVE', 'UPDATE_FAILED'] as const)(
    'transitions and starts the tenant update build from %s when the cell is ACTIVE',
    async (status) => {
      const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'UPDATING' }));
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ status })), transitionStatus },
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
      });

      const output = await service.UpdateResource({ tenantId: TENANT_ID }, context);

      expect(output.tenant?.status).toBe('UPDATING');
      expect(transitionStatus.mock.calls[0][1]).toMatchObject({
        fromAnyOf: ['ACTIVE', 'UPDATE_FAILED'],
        to: 'UPDATING',
      });
      expect(startedWorkflowInput()).toMatchObject({
        cellId: CELL_ID,
        tenantId: TENANT_ID,
        tenantBuild: {
          operation: 'update',
          scriptPath: 'stamped/tenant/update.sh',
          failedStatus: 'UPDATE_FAILED',
          tenantName: 'acme', // from the stored record (ADR-023)
          adminEmail: '',
        },
      });
      expect(startedWorkflowInput().cellBuild).toBeUndefined();
    },
  );

  test('compensates a rejected workflow start UPDATING → UPDATE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(tenantRecord({ status: 'UPDATING' }))
      .mockResolvedValueOnce(tenantRecord({ status: 'UPDATE_FAILED' }));
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()), transitionStatus },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });

    await expect(service.UpdateResource({ tenantId: TENANT_ID }, context)).rejects.toThrow(
      'start rejected',
    );

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['UPDATING'],
      to: 'UPDATE_FAILED',
    });
  });
});

describe('GetCell', () => {
  test('returns the full cell record including the stamped definition', async () => {
    const service = makeService({
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 3 })) },
    });
    const output = await service.GetCell({ cellId: CELL_ID }, context);
    expect(output.cell?.tenantCount).toBe(3);
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
  test('lists the static GSI-1 partition with pagination pass-through', async () => {
    const queryIndex = jest
      .fn()
      .mockResolvedValue({ items: [cellRecord()], nextToken: 'token-1' });
    const service = makeService({ cellRepo: { queryIndex } });

    const output = await service.ListCells({ maxResults: 20, nextToken: 'token-0' }, context);

    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'CELL' } },
      20,
      'token-0',
    );
    expect(output.cells).toHaveLength(1);
    expect(output.nextToken).toBe('token-1');
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
    // The emptiness check and the transition are ONE conditional write.
    const transition = transitionStatus.mock.calls[0][1];
    expect(transition).toMatchObject({
      fromAnyOf: ['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
      to: 'DELETING',
    });
    expect(transition.extraCondition.conditionExpression).toBe('#tenantCount = :zero');
    expect(startedWorkflowInput()).toEqual({
      sourceType: 'GITHUB',
      sourceLocation: 'https://github.com/acme/stamped.git',
      sourceVersion: '',
      operatorId: 'op-1',
      ...accountInput,
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
});

describe('CreateTenant idempotency (ADR-017)', () => {
  const CLIENT_TOKEN = 'retry-token-1';
  const createInput = {
    name: 'acme',
    adminEmail: 'success@simulator.amazonses.com',
    clientToken: CLIENT_TOKEN,
  };
  const requestHash = createTenantRequestHash({
    name: 'acme',
    adminEmail: 'success@simulator.amazonses.com',
  });

  function idempotencyRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
    return {
      clientToken: CLIENT_TOKEN,
      tenantId: TENANT_ID,
      requestHash,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: 1757203200,
      ...overrides,
    };
  }

  test('a clientToken adds the idempotency item to the existing-cell claim', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeTenantInCell },
    });

    const output = await service.CreateTenant(createInput, context);

    const item = placeTenantInCell.mock.calls[0][0].idempotencyItem;
    expect(item).toMatchObject({
      PK: `IDEMPOTENCY#${CLIENT_TOKEN}`,
      SK: 'META',
      clientToken: CLIENT_TOKEN,
      tenantId: output.tenant?.tenantId,
      requestHash,
    });
    // TTL garbage collection: 24h from creation, epoch seconds.
    expect(item.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 23 * 3600);
  });

  test('a clientToken adds the idempotency item to the new-cell transaction', async () => {
    const createCellWithTenant = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant },
    });

    await service.CreateTenant(createInput, context);

    expect(createCellWithTenant.mock.calls[0][0].idempotencyItem).toMatchObject({
      PK: `IDEMPOTENCY#${CLIENT_TOKEN}`,
      requestHash,
    });
  });

  test('without a clientToken no idempotency item is written (baseline behaviour)', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeTenantInCell },
    });

    await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    expect(placeTenantInCell.mock.calls[0][0].idempotencyItem).toBeUndefined();
  });

  test('a replay with matching parameters returns the original tenant — no duplicate onboard', async () => {
    const existing = tenantRecord({ status: 'CREATING' });
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeTenantInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      tenantRepo: { get: jest.fn().mockResolvedValue(existing) },
    });

    const output = await service.CreateTenant(createInput, context);

    // The ORIGINAL tenant, not a new one — and no workflow started.
    expect(output.tenant?.tenantId).toBe(TENANT_ID);
    expect(output.tenant?.status).toBe('CREATING');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('a replay via the new-cell path also returns the original tenant', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage() }, // no candidates → new-cell path
      placement: {
        createCellWithTenant: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()) },
    });

    const output = await service.CreateTenant(createInput, context);
    expect(output.tenant?.tenantId).toBe(TENANT_ID);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('token reuse with different parameters is a 409', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeTenantInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: {
        get: jest.fn().mockResolvedValue(idempotencyRecord({ requestHash: 'different' })),
      },
    });

    await expect(service.CreateTenant(createInput, context)).rejects.toBeInstanceOf(ConflictError);
  });

  test('token reuse with a different target accountId is a 409, not a replay of the first placement', async () => {
    // The stored hash is the one the first call (no accountId) produced; the
    // retry targets the same account explicitly, so the request identity
    // differs even though the placement would land in the same cell.
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeTenantInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
    });

    await expect(
      service.CreateTenant({ ...createInput, accountId: ACCOUNT_ID }, context),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('a replay whose tenant was since deleted is a 409, not a silent re-onboard', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeTenantInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      tenantRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });

    await expect(service.CreateTenant(createInput, context)).rejects.toBeInstanceOf(ConflictError);
  });

  test('a duplicate whose record was TTL-collected mid-flight is a 409', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeTenantInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });

    await expect(service.CreateTenant(createInput, context)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('operator propagation and source pinning (M12 / M10)', () => {
  test('a stamped source pin and a different operator flow into the workflow input', async () => {
    const sha = '4f0c9e1b2a3d4c5e6f708192a3b4c5d6e7f80912';
    const pinnedSource: StampedSourceDefinition = { ...stampedSource, sourceVersion: sha };
    const transitionStatus = jest.fn().mockResolvedValue(cellRecord({ status: 'UPDATING' }));
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ source: pinnedSource })),
        transitionStatus,
      },
    });

    await service.UpdateCell({ cellId: CELL_ID }, { operatorId: 'op-2', role: 'operator' });

    // M10 (T5): the stamped pin rides the resolved execution input — the
    // workflow forwards it to CodeBuild as the SourceVersion override.
    expect(startedWorkflowInput().sourceVersion).toBe(sha);
    // M12 (T10): the operator is the CALLER's verified sub, per request.
    expect(startedWorkflowInput().operatorId).toBe('op-2');
  });
});

// ---------------------------------------------------------------------------
// Accounts (ADR-024, ADR-025, ADR-026, ADR-027)
// ---------------------------------------------------------------------------

describe('CreateTenant across accounts (§7 step 0 and 3, ADR-024)', () => {
  const tenantAccount = accountRecord({
    accountId: TENANT_ACCOUNT_ID,
    owner: 'TENANT',
    maxCells: 1,
    cellCount: 0,
    externalId: 'customer-handshake-1',
    createdAt: new Date('2026-02-01T00:00:00Z'),
  });
  const input = { name: 'acme', adminEmail: 'success@simulator.amazonses.com' };

  test('untargeted placement considers vendor-owned accounts only, oldest registered first', async () => {
    const olderVendor = accountRecord({
      accountId: '333333333333',
      cellCount: 0,
      createdAt: new Date('2025-12-01T00:00:00Z'),
    });
    const createCellWithTenant = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      // Listing order differs from registration order on purpose.
      accountRepo: { queryIndex: accountPage(accountRecord(), tenantAccount, olderVendor) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant },
    });

    await service.CreateTenant(input, context);

    expect(createCellWithTenant).toHaveBeenCalledTimes(1);
    expect(createCellWithTenant.mock.calls[0][0]).toMatchObject({
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

  test('an untargeted scan skips ACTIVE cells with capacity that live in a tenant-owned account', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const createCellWithTenant = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      accountRepo: { queryIndex: accountPage(accountRecord({ cellCount: 0 }), tenantAccount) },
      cellRepo: { queryIndex: cellPage(cellRecord({ accountId: TENANT_ACCOUNT_ID, tenantCount: 0 })) },
      placement: { placeTenantInCell, createCellWithTenant },
    });

    await service.CreateTenant(input, context);

    expect(placeTenantInCell).not.toHaveBeenCalled();
    expect(createCellWithTenant.mock.calls[0][0]).toMatchObject({
      accountKey: { PK: `ACCOUNT#${ACCOUNT_ID}`, SK: 'META' },
    });
  });

  test('a full account refuses the claim and placement moves to the next vendor-owned account', async () => {
    const createCellWithTenant = jest
      .fn()
      .mockRejectedValueOnce(new AccountFullError('full'))
      .mockResolvedValueOnce(undefined);
    const second = accountRecord({ accountId: '444444444444', cellCount: 0, createdAt: new Date('2026-03-01T00:00:00Z') });
    const service = makeService({
      accountRepo: { queryIndex: accountPage(accountRecord({ cellCount: 2 }), second) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant },
    });

    const output = await service.CreateTenant(input, context);

    expect(createCellWithTenant).toHaveBeenCalledTimes(2);
    expect(createCellWithTenant.mock.calls[1][0].accountKey).toEqual({ PK: 'ACCOUNT#444444444444', SK: 'META' });
    expect(output.tenant!.status).toBe('CREATING');
  });

  test('every vendor-owned account full → InsufficientCapacityError, nothing started (R-28, ADR-026)', async () => {
    const createCellWithTenant = jest.fn().mockRejectedValue(new AccountFullError('full'));
    const service = makeService({
      accountRepo: { queryIndex: accountPage(accountRecord({ cellCount: 2 }), tenantAccount) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant },
    });

    await expect(service.CreateTenant(input, context)).rejects.toBeInstanceOf(InsufficientCapacityError);
    expect(createCellWithTenant).toHaveBeenCalledTimes(1); // the tenant-owned account was never tried
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('claim budget spent on cells with room, then every account full → retryable ConflictError, not InsufficientCapacityError (R-18, ADR-031)', async () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      cellRecord({ cellId: `01BX5ZZKBKACTAV9WEVGEMMV${(i + 10).toString(36).toUpperCase()}` }),
    );
    const placeTenantInCell = jest.fn().mockRejectedValue(new PlacementRaceLostError('lost'));
    const createCellWithTenant = jest.fn().mockRejectedValue(new AccountFullError('full'));
    const service = makeService({
      accountRepo: { queryIndex: accountPage(accountRecord({ cellCount: 2 })) },
      cellRepo: { queryIndex: cellPage(...candidates) },
      placement: { placeTenantInCell, createCellWithTenant },
    });

    await expect(service.CreateTenant(input, context)).rejects.toMatchObject({
      name: 'ConflictError',
      message: expect.stringContaining('Retry the request'),
    });
    expect(placeTenantInCell).toHaveBeenCalledTimes(5);
    expect(createCellWithTenant).toHaveBeenCalledTimes(1);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('no vendor-owned account registered at all → InsufficientCapacityError naming the remedy', async () => {
    const service = makeService({
      accountRepo: { queryIndex: accountPage(tenantAccount) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant: jest.fn() },
    });
    await expect(service.CreateTenant(input, context)).rejects.toMatchObject({
      name: 'InsufficientCapacityError',
      message: expect.stringContaining('No vendor-owned account is registered'),
    });
  });

  test('a targeted request places into the named account only — the way into a tenant-owned account', async () => {
    const createCellWithTenant = jest.fn().mockResolvedValue(undefined);
    const accountRepo = {
      get: jest.fn().mockResolvedValue(tenantAccount),
      queryIndex: jest.fn(),
    };
    const cellQuery = cellPage();
    const service = makeService({
      accountRepo,
      cellRepo: { queryIndex: cellQuery },
      placement: { createCellWithTenant },
    });

    await service.CreateTenant({ ...input, accountId: TENANT_ACCOUNT_ID }, context);

    expect(accountRepo.get).toHaveBeenCalledWith({ PK: `ACCOUNT#${TENANT_ACCOUNT_ID}`, SK: 'META' });
    expect(accountRepo.queryIndex).not.toHaveBeenCalled(); // no account scan for a targeted request
    // The candidate scan is the account's own GSI-2 partition.
    expect(cellQuery.mock.calls[0][0]).toEqual({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', value: `ACCOUNT#${TENANT_ACCOUNT_ID}` },
    });
    expect(createCellWithTenant.mock.calls[0][0].accountKey).toEqual({ PK: `ACCOUNT#${TENANT_ACCOUNT_ID}`, SK: 'META' });
    // The account's external id and roles ride the execution input (R-20, ADR-025).
    expect(startedWorkflowInput()).toMatchObject({
      accountId: TENANT_ACCOUNT_ID,
      externalId: 'customer-handshake-1',
      cellRoleArn: `arn:aws:iam::${TENANT_ACCOUNT_ID}:role/control-plane-cell-provisioning`,
      tenantRoleArn: `arn:aws:iam::${TENANT_ACCOUNT_ID}:role/control-plane-tenant-provisioning`,
      sessionName: 'op-1',
    });
  });

  test('a targeted request reuses an existing cell with capacity in that account before creating one', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const createCellWithTenant = jest.fn();
    const service = makeService({
      accountRepo: { get: jest.fn().mockResolvedValue(tenantAccount) },
      cellRepo: { queryIndex: cellPage(cellRecord({ accountId: TENANT_ACCOUNT_ID, tenantCount: 0 })) },
      placement: { placeTenantInCell, createCellWithTenant },
    });

    const output = await service.CreateTenant({ ...input, accountId: TENANT_ACCOUNT_ID }, context);

    expect(placeTenantInCell).toHaveBeenCalledTimes(1);
    expect(createCellWithTenant).not.toHaveBeenCalled();
    expect(output.tenant!.cellId).toBe(CELL_ID);
  });

  test('a targeted request at a full account → InsufficientCapacityError naming the account', async () => {
    const service = makeService({
      accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ accountId: TENANT_ACCOUNT_ID, owner: 'TENANT', maxCells: 1, cellCount: 1 })) },
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant: jest.fn().mockRejectedValue(new AccountFullError('full')) },
    });
    await expect(service.CreateTenant({ ...input, accountId: TENANT_ACCOUNT_ID }, context)).rejects.toMatchObject({
      name: 'InsufficientCapacityError',
      message: expect.stringContaining(TENANT_ACCOUNT_ID),
    });
  });

  test('a targeted request at an unregistered account is a 404, not a capacity error', async () => {
    const service = makeService({
      accountRepo: { get: jest.fn().mockResolvedValue(undefined) },
      cellRepo: { queryIndex: jest.fn() },
    });
    await expect(service.CreateTenant({ ...input, accountId: '555555555555' }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test('a duplicate clientToken on the new-cell path replays even when the account claim also failed', async () => {
    const original = tenantRecord({ status: 'ACTIVE' });
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant: jest.fn().mockRejectedValue(new DuplicateTokenError('dup')) },
      idempotencyRepo: {
        get: jest.fn().mockResolvedValue({
          clientToken: 'tok',
          tenantId: TENANT_ID,
          requestHash: createTenantRequestHash({ name: 'acme', description: undefined, adminEmail: input.adminEmail }),
          createdAt: new Date(),
          expiresAt: 0,
        }),
      },
      tenantRepo: { get: jest.fn().mockResolvedValue(original) },
    });
    const output = await service.CreateTenant({ ...input, clientToken: 'tok' }, context);
    expect(output.tenant!.tenantId).toBe(TENANT_ID);
  });

  test('the STS session name is the operator id made STS-safe (M23)', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeTenantInCell: jest.fn().mockResolvedValue(undefined) },
    });
    await service.CreateTenant(input, { operatorId: 'auth0|user 42', role: 'operator' });
    expect(startedWorkflowInput()).toMatchObject({ operatorId: 'auth0|user 42', sessionName: 'auth0-user-42' });
  });
});

describe('workflow input carries the cell account for every build (R-20, ADR-025)', () => {
  test('DeleteCell resolves the account and its external id into the execution input', async () => {
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

  test('a cell whose account record is missing is an invariant violation (500), never a 404', async () => {
    const service = makeService({
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
      accountRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.UpdateCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(InternalServerError);
  });
});

describe('ListCells?accountId= and GetResource.accountId', () => {
  test('?accountId= filters via the cell items GSI-2 partition; unfiltered uses GSI-1', async () => {
    const queryIndex = cellPage(cellRecord());
    const service = makeService({ cellRepo: { queryIndex } });
    await service.ListCells({ accountId: ACCOUNT_ID }, context);
    expect(queryIndex.mock.calls[0][0]).toEqual({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', value: `ACCOUNT#${ACCOUNT_ID}` },
    });
    await service.ListCells({}, context);
    expect(queryIndex.mock.calls[1][0]).toEqual({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', value: 'CELL' },
    });
  });

  test('an unknown accountId yields an empty page, not a 404 (§5)', async () => {
    const service = makeService({ cellRepo: { queryIndex: cellPage() } });
    await expect(service.ListCells({ accountId: '555555555555' }, context)).resolves.toEqual({
      cells: [],
      nextToken: undefined,
    });
  });

  test('cell summaries and GetResource name the account', async () => {
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()) },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });
    await expect(service.GetCell({ cellId: CELL_ID }, context)).resolves.toMatchObject({
      cell: { accountId: ACCOUNT_ID },
    });
    await expect(service.GetResource({ tenantId: TENANT_ID }, context)).resolves.toMatchObject({
      cellId: CELL_ID,
      accountId: ACCOUNT_ID,
    });
  });
});

describe('PutAccount (§5.3, ADR-027)', () => {
  const putInput = { accountId: TENANT_ACCOUNT_ID, owner: 'TENANT' as const, maxCells: 1, externalId: 'ext-1' };

  test('probes both roles with the external id, then writes the create-or-replace update', async () => {
    const handshake = jest.fn().mockResolvedValue([]);
    const update = jest.fn().mockResolvedValue(accountRecord({ ...putInput, cellCount: 0 }));
    const service = makeService({ handshake, accountRepo: { update } });

    const output = await service.PutAccount(putInput, context);

    expect(handshake).toHaveBeenCalledWith({ accountId: TENANT_ACCOUNT_ID, externalId: 'ext-1', operatorId: 'op-1' });
    expect(update).toHaveBeenCalledWith(
      { PK: `ACCOUNT#${TENANT_ACCOUNT_ID}`, SK: 'META' },
      expect.objectContaining({ conditionExpression: 'attribute_not_exists(PK) OR #owner = :owner' }),
    );
    // The external id is never returned (N-10) — only that one is set.
    expect(output.account).toMatchObject({ accountId: TENANT_ACCOUNT_ID, owner: 'TENANT', externalIdConfigured: true });
    expect(output.account).not.toHaveProperty('externalId');
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
      accountRepo: { update },
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
      accountRepo: { update },
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
    const service = makeService({ handshake, accountRepo: { update } });
    await expect(
      service.PutAccount({ accountId: TENANT_ACCOUNT_ID, owner: 'TENANT', maxCells: 1 }, context),
    ).rejects.toMatchObject({ name: 'ValidationException', message: expect.stringContaining('externalId is required') });
    expect(handshake).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('a vendor-owned account may omit the externalId', async () => {
    const handshake = jest.fn().mockResolvedValue([]);
    const update = jest.fn().mockResolvedValue(accountRecord({ cellCount: 0 }));
    const service = makeService({ handshake, accountRepo: { update } });
    const output = await service.PutAccount({ accountId: ACCOUNT_ID, owner: 'VENDOR', maxCells: 2 }, context);
    expect(handshake).toHaveBeenCalledWith({ accountId: ACCOUNT_ID, externalId: undefined, operatorId: 'op-1' });
    expect(output.account).toMatchObject({ accountId: ACCOUNT_ID, owner: 'VENDOR' });
  });

  test('an owner change on a registered account is a 409 (immutable owner)', async () => {
    const service = makeService({
      accountRepo: { update: jest.fn().mockRejectedValue(new ConditionFailedError('owner')) },
    });
    await expect(service.PutAccount({ ...putInput, owner: 'VENDOR' }, context)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('GetAccount / ListAccounts / DeleteAccount (§5.3)', () => {
  test('GetAccount returns the record without the external id value; 404 when unregistered', async () => {
    const service = makeService({
      accountRepo: { get: jest.fn().mockResolvedValueOnce(accountRecord({ externalId: 'secret-ish' })).mockResolvedValueOnce(undefined) },
    });
    const output = await service.GetAccount({ accountId: ACCOUNT_ID }, context);
    expect(output.account).toMatchObject({ accountId: ACCOUNT_ID, cellCount: 1, maxCells: 2, externalIdConfigured: true });
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

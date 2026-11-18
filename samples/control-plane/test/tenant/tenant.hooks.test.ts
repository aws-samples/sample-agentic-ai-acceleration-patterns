// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBItem } from '../../src/shared/data-model';
import { HookExistsError, HookGoneError, HookLimitError, HookTransactions } from '../../src/shared/hook-transactions';
import { AmbiguousTransactionError, DynamoDBRepository, PlacementTransactions, RecordGoneError } from '../../src/shared/repository';
import { CallerContext } from '../../src/shared/service-config';
import {
  ConflictError,
  InternalServerError,
  PutApplicationInput,
  PutHookInput,
  ResourceNotFoundError,
  ValidationException,
} from '../../src/smithy/source/typescript-ssdk-codegen/src';
import { AccountItem, AccountRecord } from '../../src/tenant/account.data-model';
import { ApplicationItem, ApplicationRecord } from '../../src/tenant/application.data-model';
import { CellItem, CellRecord } from '../../src/tenant/cell.data-model';
import { DeploymentItem, DeploymentRecord } from '../../src/tenant/deployment.data-model';
import { HookItem } from '../../src/tenant/hook.data-model';
import { GlobalHookRecord, HookDefinition } from '../../src/tenant/hook.types';
import { IdempotencyItem, IdempotencyRecord } from '../../src/tenant/idempotency.data-model';
import { TenantService } from '../../src/tenant/tenant';
import { TenantItem, TenantRecord } from '../../src/tenant/tenant.data-model';

const sfnMock = mockClient(SFNClient);
const context: CallerContext = { operatorId: 'op-1', role: 'operator', grant: 'operator' };

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CELL_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const APP_ID = 'app-x';
const ACCOUNT_ID = '111111111111';
const SHA = '4f0c9e1b2a3d4c5e6f708192a3b4c5d6e7f80912';
const T0 = new Date('2026-01-01T00:00:00Z');

const ALL_EVENTS = ['CELL_CREATE', 'CELL_UPDATE', 'CELL_DELETE', 'DEPLOYMENT_CREATE', 'DEPLOYMENT_UPDATE', 'DEPLOYMENT_DELETE'] as const;

function hookDef(hookId: string, overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    hookId,
    events: [...ALL_EVENTS],
    phase: 'PRE',
    source: { type: 'GITHUB', location: `https://github.com/acme/${hookId}.git`, sourceVersion: SHA },
    script: 'hooks/run.sh',
    timeoutMinutes: 10,
    ...overrides,
  };
}

function globalHook(hookId: string, overrides: Partial<GlobalHookRecord> = {}): GlobalHookRecord {
  return { ...hookDef(hookId), revision: 2, createdAt: T0, updatedAt: T0, ...overrides };
}

const source = { type: 'GITHUB' as const, location: 'https://github.com/acme/application.git' };
const scripts = (prefix: string) => ({ create: `${prefix}/create.sh`, update: `${prefix}/update.sh`, delete: `${prefix}/delete.sh` });

/** The application's CURRENT hooks, deliberately unlike the cell's stamp (P-4, R-40). */
const applicationHooks = [hookDef('current-app-hook')];
const stampedHooks = [hookDef('stamp-pre'), hookDef('stamp-post', { phase: 'POST' })];

function applicationRecord(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    applicationId: APP_ID,
    source,
    cellScripts: scripts('app/cell'),
    tenantScripts: scripts('app/tenant'),
    maxTenants: 4,
    placementStrategy: 'FILL',
    hooks: applicationHooks,
    cellCount: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}
function accountRecord(): AccountRecord {
  return { accountId: ACCOUNT_ID, owner: 'VENDOR', maxCells: 2, cellCount: 1, createdAt: T0, updatedAt: T0 };
}
function cellRecord(overrides: Partial<CellRecord> = {}): CellRecord {
  return {
    cellId: CELL_ID,
    applicationId: APP_ID,
    accountId: ACCOUNT_ID,
    status: 'ACTIVE',
    maxTenants: 5,
    tenantCount: 1,
    source,
    cellScripts: scripts('stamped/cell'),
    tenantScripts: scripts('stamped/tenant'),
    hooks: stampedHooks,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}
function tenantRecord(): TenantRecord {
  return { tenantId: TENANT_ID, name: 'acme', deploymentCount: 1, createdAt: T0, updatedAt: T0 };
}
function deploymentRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return { tenantId: TENANT_ID, applicationId: APP_ID, cellId: CELL_ID, status: 'ACTIVE', createdAt: T0, updatedAt: T0, ...overrides };
}

const page = <T>(...items: T[]) => jest.fn().mockResolvedValue({ items, nextToken: undefined });

interface Mocks {
  /** Every write and the hook read push their name here, in call order. */
  calls?: string[];
  globalHooks?: GlobalHookRecord[];
  hookRead?: jest.Mock;
  tenantRepo?: object;
  deploymentRepo?: object;
  cellRepo?: object;
  applicationRepo?: object;
  placement?: object;
  hookRepo?: object;
  hookTx?: object;
  warn?: jest.Mock;
}

/** A repository with only the mocked methods, typed as the real one. */
function repo<R, I extends DynamoDBItem>(methods: object): DynamoDBRepository<R, I> {
  return methods as unknown as DynamoDBRepository<R, I>;
}

function makeService(mocks: Mocks = {}) {
  const calls = mocks.calls ?? [];
  const write = (name: string, result: unknown) => jest.fn().mockImplementation(async () => {
    calls.push(name);
    return result;
  });
  return new TenantService({
    tenantRepository: repo<TenantRecord, TenantItem>({ get: jest.fn().mockResolvedValue(tenantRecord()), ...mocks.tenantRepo }),
    deploymentRepository: repo<DeploymentRecord, DeploymentItem>({
      get: jest.fn().mockResolvedValue(deploymentRecord()),
      ...mocks.deploymentRepo,
    }),
    cellRepository: repo<CellRecord, CellItem>({
      get: jest.fn().mockResolvedValue(cellRecord()),
      queryIndex: page(),
      ...mocks.cellRepo,
    }),
    idempotencyRepository: repo<IdempotencyRecord, IdempotencyItem>({ get: jest.fn().mockResolvedValue(undefined) }),
    accountRepository: repo<AccountRecord, AccountItem>({
      get: jest.fn().mockResolvedValue(accountRecord()),
      queryIndex: page(accountRecord()),
    }),
    applicationRepository: repo<ApplicationRecord, ApplicationItem>({
      get: jest.fn().mockResolvedValue(applicationRecord()),
      ...mocks.applicationRepo,
    }),
    placement: {
      placeDeploymentInCell: write('write', undefined),
      createCellWithDeployment: write('write', undefined),
      ...mocks.placement,
    } as unknown as PlacementTransactions<CellRecord, CellItem, DeploymentRecord, DeploymentItem>,
    hookRepository: {
      get: jest.fn().mockResolvedValue(undefined),
      queryPartition: mocks.hookRead ?? jest.fn().mockImplementation(async () => {
        calls.push('readHooks');
        return { items: mocks.globalHooks ?? [], nextToken: undefined };
      }),
      ...mocks.hookRepo,
    } as unknown as DynamoDBRepository<GlobalHookRecord, HookItem>,
    hookTransactions: { ...mocks.hookTx } as unknown as HookTransactions<GlobalHookRecord, HookItem>,
    fleetName: 'control-plane',
    partition: 'aws',
    handshake: jest.fn().mockResolvedValue([]),
    stateMachineArn: 'arn:aws:states:eu-central-1:111111111111:stateMachine:control-plane-workflow',
    sfnClient: new SFNClient({}),
    warn: mocks.warn ?? jest.fn(),
  });
}

const startedInput = (call = 0) => JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[call].args[0].input.input!);

beforeEach(() => {
  sfnMock.reset();
  sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:...:exec' });
});

// ---------------------------------------------------------------------------
// PutHook / GetHook / ListHooks / DeleteHook (§5.5, R-39)
// ---------------------------------------------------------------------------

describe('PutHook (§5.5, R-39)', () => {
  const putInput = {
    hookId: 'gate',
    events: ['DEPLOYMENT_CREATE' as const],
    phase: 'PRE' as const,
    source: { type: 'GITHUB' as const, location: 'https://github.com/acme/gate.git', sourceVersion: SHA },
    script: 'hooks/gate.sh',
  };

  test('a create is one transaction: revision 1, the default timeout stored, the counter claimed up to five', async () => {
    const createHook = jest.fn().mockResolvedValue(undefined);
    const get = jest.fn().mockResolvedValue(undefined);
    const service = makeService({ hookTx: { createHook }, hookRepo: { get } });

    const { hook } = await service.PutHook(putInput, context);

    expect(get).toHaveBeenCalledWith({ PK: 'HOOK', SK: 'HOOK#gate' }, { consistentRead: true });
    expect(createHook).toHaveBeenCalledTimes(1);
    const params = createHook.mock.calls[0][0];
    expect(params.counterKey).toEqual({ PK: 'HOOK', SK: 'META' });
    expect(params.maxHooks).toBe(5);
    expect(params.hook).toMatchObject({ hookId: 'gate', revision: 1, timeoutMinutes: 10 });
    expect(hook).toMatchObject({ hookId: 'gate', revision: 1, timeoutMinutes: 10, phase: 'PRE', script: 'hooks/gate.sh' });
    expect(hook?.createdAt).toEqual(hook?.updatedAt);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('a replace is one update conditioned on existence that increments the revision, and touches no counter', async () => {
    const updateExisting = jest.fn().mockResolvedValue(globalHook('gate', { revision: 3 }));
    const createHook = jest.fn();
    const service = makeService({
      hookRepo: { get: jest.fn().mockResolvedValue(globalHook('gate')), updateExisting },
      hookTx: { createHook },
    });

    const { hook } = await service.PutHook({ ...putInput, timeoutMinutes: 20 }, context);

    expect(createHook).not.toHaveBeenCalled();
    const [key, update] = updateExisting.mock.calls[0];
    expect(key).toEqual({ PK: 'HOOK', SK: 'HOOK#gate' });
    expect(update.updateExpression).toContain('#revision = #revision + :one');
    expect(update.expressionAttributeValues[':timeoutMinutes']).toBe(20);
    expect(JSON.stringify(update)).not.toContain('hookCount');
    expect(hook?.revision).toBe(3);
  });

  test('an invalid definition is a 400 before anything is read or written', async () => {
    const get = jest.fn();
    const createHook = jest.fn();
    const service = makeService({ hookRepo: { get }, hookTx: { createHook } });
    const invalid = [
      { ...putInput, timeoutMinutes: 4 },
      { ...putInput, timeoutMinutes: 31 },
      { ...putInput, events: [] },
      { ...putInput, script: 'has space.sh' },
      { ...putInput, source: { ...putInput.source, location: 'https://u:p@github.com/a/b.git' } },
      { ...putInput, source: { ...putInput.source, sourceVersion: 'bad\nref' } },
    ];
    for (const input of invalid) {
      await expect(service.PutHook(input, context)).rejects.toBeInstanceOf(ValidationException);
    }
    expect(get).not.toHaveBeenCalled();
    expect(createHook).not.toHaveBeenCalled();
  });

  test('a create that met a concurrent create is a 409 to retry', async () => {
    const service = makeService({ hookTx: { createHook: jest.fn().mockRejectedValue(new HookExistsError('exists')) } });
    const error = await service.PutHook(putInput, context).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain('retry the request');
  });

  test('a replace that met a concurrent delete is a 409 to retry', async () => {
    const service = makeService({
      hookRepo: { get: jest.fn().mockResolvedValue(globalHook('gate')), updateExisting: jest.fn().mockRejectedValue(new RecordGoneError('gone')) },
    });
    const error = await service.PutHook(putInput, context).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain('retry the request');
  });

  test('a sixth hook is a 409 without a retry hint: the remedy is DeleteHook', async () => {
    const service = makeService({ hookTx: { createHook: jest.fn().mockRejectedValue(new HookLimitError('full')) } });
    const error = await service.PutHook(putInput, context).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain('DeleteHook');
    expect(error.message).not.toContain('retry');
  });

  test('an ambiguous transaction is a 500', async () => {
    const service = makeService({ hookTx: { createHook: jest.fn().mockRejectedValue(new AmbiguousTransactionError('?')) } });
    await expect(service.PutHook(putInput, context)).rejects.toBeInstanceOf(InternalServerError);
  });

  test('a ref that is not a full commit SHA is accepted with a warning naming the hook; a SHA is silent (ADR-020)', async () => {
    const warn = jest.fn();
    const service = makeService({ warn, hookTx: { createHook: jest.fn().mockResolvedValue(undefined) } });
    await service.PutHook({ ...putInput, source: { ...putInput.source, sourceVersion: 'main' } }, context);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^PutHook gate: hook gate /);
    warn.mockClear();
    await service.PutHook(putInput, context);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('GetHook / ListHooks / DeleteHook (§5.5)', () => {
  test('GetHook returns the definition with revision and timestamps from a consistent read; 404 when unregistered', async () => {
    const get = jest.fn().mockResolvedValueOnce(globalHook('gate', { revision: 4 })).mockResolvedValueOnce(undefined);
    const service = makeService({ hookRepo: { get } });
    const { hook } = await service.GetHook({ hookId: 'gate' }, context);
    expect(hook).toMatchObject({ hookId: 'gate', revision: 4, events: [...ALL_EVENTS], timeoutMinutes: 10, createdAt: T0, updatedAt: T0 });
    expect(get.mock.calls[0][1]).toEqual({ consistentRead: true });
    await expect(service.GetHook({ hookId: 'gate' }, context)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test('ListHooks is one pinned query of the HOOK partition, passing the page controls', async () => {
    const queryPartition = jest.fn().mockResolvedValue({ items: [globalHook('a'), globalHook('b')], nextToken: 'next' });
    const service = makeService({ hookRepo: { queryPartition } });
    const out = await service.ListHooks({ maxResults: 2, nextToken: 'tok' }, context);
    expect(queryPartition).toHaveBeenCalledWith({ partitionKey: 'HOOK', sortKeyPrefix: 'HOOK#', consistentRead: true }, 2, 'tok');
    expect(out.hooks?.map((h) => h.hookId)).toEqual(['a', 'b']);
    expect(out.nextToken).toBe('next');
  });

  test('DeleteHook deletes the hook and releases the counter in one transaction and returns the hook', async () => {
    const deleteHook = jest.fn().mockResolvedValue(undefined);
    const service = makeService({ hookRepo: { get: jest.fn().mockResolvedValue(globalHook('gate')) }, hookTx: { deleteHook } });
    const { hook } = await service.DeleteHook({ hookId: 'gate' }, context);
    expect(hook?.hookId).toBe('gate');
    expect(deleteHook.mock.calls[0][0]).toMatchObject({ hookKey: { PK: 'HOOK', SK: 'HOOK#gate' }, counterKey: { PK: 'HOOK', SK: 'META' } });
  });

  test('DeleteHook of a missing hook is a 404, also when a concurrent delete won; a counter fault is a 500', async () => {
    const service = makeService({});
    await expect(service.DeleteHook({ hookId: 'gate' }, context)).rejects.toBeInstanceOf(ResourceNotFoundError);
    const raced = makeService({
      hookRepo: { get: jest.fn().mockResolvedValue(globalHook('gate')) },
      hookTx: { deleteHook: jest.fn().mockRejectedValue(new HookGoneError('gone')) },
    });
    await expect(raced.DeleteHook({ hookId: 'gate' }, context)).rejects.toBeInstanceOf(ResourceNotFoundError);
    const drift = makeService({
      hookRepo: { get: jest.fn().mockResolvedValue(globalHook('gate')) },
      hookTx: { deleteHook: jest.fn().mockRejectedValue(new AmbiguousTransactionError('counter')) },
    });
    await expect(drift.DeleteHook({ hookId: 'gate' }, context)).rejects.toBeInstanceOf(InternalServerError);
  });
});

describe('the generated validation rejects hook input before the handler (400)', () => {
  const base = {
    hookId: 'gate',
    events: ['CELL_CREATE'],
    phase: 'POST',
    script: 'a.sh',
    source: { type: 'GITHUB', location: 'https://github.com/a/b.git' },
  };
  const failures = (input: object) => PutHookInput.validate({ ...base, ...input } as never).map((f) => f.path);

  test('a conforming definition passes; each R-39 violation fails at its path', () => {
    expect(failures({})).toEqual([]);
    expect(failures({ hookId: 'Bad' })).toEqual(['/hookId']);
    expect(failures({ events: [] })).toEqual(['/events']);
    expect(failures({ events: ['CELL_CREATE', 'CELL_CREATE'] })).toEqual(['/events']);
    expect(failures({ events: ['TENANT_CREATE'] })).toEqual(['/events/0']);
    expect(failures({ phase: 'DURING' })).toEqual(['/phase']);
    expect(failures({ timeoutMinutes: 4 })).toEqual(['/timeoutMinutes']);
    expect(failures({ timeoutMinutes: 31 })).toEqual(['/timeoutMinutes']);
    expect(failures({ script: 'a b.sh' })).toEqual(['/script']);
    expect(failures({ source: { ...base.source, location: 'https://u:p@h/r.git' } })).toEqual(['/source/location']);
    expect(failures({ source: { ...base.source, sourceVersion: 'a"b' } })).toEqual(['/source/sourceVersion']);
  });

  test('PutApplication: hooks at most five, and the application source and script charsets', () => {
    const app = {
      applicationId: APP_ID,
      source,
      cellScripts: scripts('c'),
      tenantScripts: scripts('t'),
      maxTenants: 1,
      hooks: [hookDef('a')],
    };
    const paths = (input: object) => PutApplicationInput.validate({ ...app, ...input } as never).map((f) => f.path);
    expect(paths({})).toEqual([]);
    expect(paths({ hooks: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => hookDef(id)) })).toEqual(['/hooks']);
    expect(paths({ source: { ...source, location: 'https://u:p@github.com/a/b.git' } })).toEqual(['/source/location']);
    expect(paths({ source: { ...source, sourceVersion: 'a b' } })).toEqual(['/source/sourceVersion']);
    expect(paths({ cellScripts: { ...scripts('c'), update: 'a b.sh' } })).toEqual(['/cellScripts/update']);
  });
});

// ---------------------------------------------------------------------------
// PutApplication hooks (§4.1, R-29, R-39)
// ---------------------------------------------------------------------------

describe('PutApplication hooks', () => {
  const putInput = {
    applicationId: APP_ID,
    source,
    cellScripts: scripts('c'),
    tenantScripts: scripts('t'),
    maxTenants: 3,
    parameters: [],
    cellParameters: [],
  };

  test('absent hooks keep the stored list: no hooks attribute in the write and no condition on it', async () => {
    const update = jest.fn().mockResolvedValue(applicationRecord());
    await makeService({ applicationRepo: { update } }).PutApplication(putInput, context);
    const [, write] = update.mock.calls[0];
    expect(write.updateExpression).not.toContain('hooks');
    expect(write.conditionExpression).toBeUndefined();
  });

  test('a kept hooks list adds no condition even when a declaration list is kept', async () => {
    const update = jest.fn().mockResolvedValue(applicationRecord());
    const { parameters: _p, ...keepParameters } = putInput;
    await makeService({ applicationRepo: { update, get: jest.fn().mockResolvedValue(applicationRecord()) } })
      .PutApplication(keepParameters, context);
    const [, write] = update.mock.calls[0];
    expect(write.conditionExpression).toMatch(/parameters/);
    expect(write.conditionExpression).not.toMatch(/hooks/);
  });

  test('an empty list clears the hooks, a sent list replaces them, both as plain SET of the whole list', async () => {
    const update = jest.fn().mockResolvedValue(applicationRecord());
    const service = makeService({ applicationRepo: { update } });
    await service.PutApplication({ ...putInput, hooks: [] as never }, context);
    expect(update.mock.calls[0][1].updateExpression).toContain('#hooks = :hooks');
    expect(update.mock.calls[0][1].expressionAttributeValues[':hooks']).toEqual([]);
    await service.PutApplication({ ...putInput, hooks: [hookDef('a')] as never }, context);
    expect(update.mock.calls[1][1].expressionAttributeValues[':hooks']).toEqual([hookDef('a')]);
  });

  test('the hook timeout is stored resolved', async () => {
    const update = jest.fn().mockResolvedValue(applicationRecord());
    const { timeoutMinutes: _t, ...bare } = hookDef('a');
    await makeService({ applicationRepo: { update } }).PutApplication({ ...putInput, hooks: [bare] as never }, context);
    expect(update.mock.calls[0][1].expressionAttributeValues[':hooks'][0].timeoutMinutes).toBe(10);
  });

  test('a repeated hookId, more than five hooks and an invalid definition are 400s with nothing read or written', async () => {
    const update = jest.fn();
    const get = jest.fn();
    const service = makeService({ applicationRepo: { update, get } });
    const refused = [
      [hookDef('a'), hookDef('a')],
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => hookDef(id)),
      [hookDef('a', { timeoutMinutes: 99 })],
      [hookDef('a', { source: { type: 'GITHUB', location: 'https://u:p@h/r.git' } })],
    ];
    for (const hooks of refused) {
      await expect(service.PutApplication({ ...putInput, hooks: hooks as never }, context)).rejects.toBeInstanceOf(ValidationException);
    }
    expect(update).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  test.each([
    ['userinfo in the source location', { source: { ...source, location: 'https://u:p@github.com/a/b.git' } }],
    ['a control character in the source version', { source: { ...source, sourceVersion: 'a\nb' } }],
    ['a space in a script path', { tenantScripts: { ...scripts('t'), create: 't/a b.sh' } }],
  ])('refuses %s with a 400 and writes nothing (ADR-044 amends ADR-032)', async (_name, override) => {
    const update = jest.fn();
    await expect(makeService({ applicationRepo: { update } }).PutApplication({ ...putInput, ...override }, context))
      .rejects.toBeInstanceOf(ValidationException);
    expect(update).not.toHaveBeenCalled();
  });

  test('an unpinned hook ref is accepted with a warning naming the application and the hook', async () => {
    const warn = jest.fn();
    const update = jest.fn().mockResolvedValue(applicationRecord());
    const unpinned = hookDef('floating', { source: { type: 'GITHUB', location: 'https://github.com/a/b.git', sourceVersion: 'main' } });
    await makeService({ warn, applicationRepo: { update } }).PutApplication({ ...putInput, hooks: [hookDef('pinned'), unpinned] as never }, context);
    const hookWarnings = warn.mock.calls.map((c) => c[0]).filter((m) => m.includes('hook '));
    expect(hookWarnings).toHaveLength(1);
    expect(hookWarnings[0]).toMatch(new RegExp(`^PutApplication ${APP_ID}: hook floating `));
  });

  test('PutApplication never writes a counter (R-29)', async () => {
    const update = jest.fn().mockResolvedValue(applicationRecord());
    await makeService({ applicationRepo: { update } }).PutApplication({ ...putInput, hooks: [hookDef('a')] as never }, context);
    expect(update.mock.calls[0][1].updateExpression).not.toMatch(/hookCount|#cellCount = :|#cellCount \+/);
  });

  test('GetApplication returns the hooks, empty when none', async () => {
    const get = jest.fn().mockResolvedValueOnce(applicationRecord()).mockResolvedValueOnce(applicationRecord({ hooks: undefined }));
    const service = makeService({ applicationRepo: { get } });
    expect((await service.GetApplication({ applicationId: APP_ID }, context)).application?.hooks).toEqual(applicationHooks);
    expect((await service.GetApplication({ applicationId: APP_ID }, context)).application?.hooks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stamping and resolution (R-40, R-45, P-4, §7.1 step 0)
// ---------------------------------------------------------------------------

describe('a new cell is stamped with the application hooks as read in step 0 (R-40, P-4)', () => {
  test('the cell carries the list, and its two events resolve from it, the cell event first', async () => {
    const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
    const cellPre = globalHook('g-cell', { events: ['CELL_CREATE'] });
    const service = makeService({
      globalHooks: [cellPre, globalHook('g-dep', { events: ['DEPLOYMENT_CREATE'], phase: 'POST' })],
      placement: { createCellWithDeployment },
    });

    await service.CreateDeployment({ tenantId: TENANT_ID, applicationId: APP_ID, adminEmail: 'success@simulator.amazonses.com' }, context);

    expect(createCellWithDeployment.mock.calls[0][0].cell.hooks).toEqual(applicationHooks);
    const input = startedInput();
    expect(input.cellBuild.hooks.event).toBe('CELL_CREATE');
    expect(input.cellBuild.hooks.pre.map((h: { hookId: string; scope: string; revision: number }) => [h.scope, h.hookId, h.revision]))
      .toEqual([['GLOBAL', 'g-cell', 2], ['APPLICATION', 'current-app-hook', 0]]);
    expect(input.cellBuild.hooks.post).toEqual([]);
    expect(input.tenantBuild.hooks.event).toBe('DEPLOYMENT_CREATE');
    expect(input.tenantBuild.hooks.pre.map((h: { hookId: string }) => h.hookId)).toEqual(['current-app-hook']);
    expect(input.tenantBuild.hooks.post.map((h: { hookId: string }) => h.hookId)).toEqual(['g-dep']);
  });

  test('an application with no hooks stamps an empty list', async () => {
    const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ hooks: undefined })) },
      placement: { createCellWithDeployment },
    });
    await service.CreateDeployment({ tenantId: TENANT_ID, applicationId: APP_ID, adminEmail: 'success@simulator.amazonses.com' }, context);
    expect(createCellWithDeployment.mock.calls[0][0].cell.hooks).toEqual([]);
  });
});

describe('every operation resolves the hooks of its event before its first write (R-40, §7.1 step 0)', () => {
  const g = (id: string, events: GlobalHookRecord['events'], phase: GlobalHookRecord['phase'] = 'PRE') => globalHook(id, { events, phase });
  const globals = ALL_EVENTS.map((event) => g(`g-${event.toLowerCase().replace('_', '-')}`, [event]));

  type Case = {
    name: string;
    event: (typeof ALL_EVENTS)[number];
    build: 'cellBuild' | 'tenantBuild';
    mocks: (calls: string[]) => Mocks;
    run: (service: TenantService) => Promise<unknown>;
  };
  const cases: Case[] = [
    {
      name: 'CreateDeployment into an existing cell',
      event: 'DEPLOYMENT_CREATE',
      build: 'tenantBuild',
      mocks: (calls) => ({
        cellRepo: { queryIndex: page(cellRecord()) },
        placement: { placeDeploymentInCell: jest.fn().mockImplementation(async () => calls.push('write')) },
      }),
      run: (s) => s.CreateDeployment({ tenantId: TENANT_ID, applicationId: APP_ID, adminEmail: 'success@simulator.amazonses.com' }, context),
    },
    {
      name: 'UpdateDeployment',
      event: 'DEPLOYMENT_UPDATE',
      build: 'tenantBuild',
      mocks: (calls) => ({
        deploymentRepo: { transitionStatus: jest.fn().mockImplementation(async () => { calls.push('write'); return deploymentRecord({ status: 'UPDATING' }); }) },
      }),
      run: (s) => s.UpdateDeployment({ tenantId: TENANT_ID, applicationId: APP_ID }, context),
    },
    {
      name: 'DeleteDeployment',
      event: 'DEPLOYMENT_DELETE',
      build: 'tenantBuild',
      mocks: (calls) => ({
        deploymentRepo: { transitionStatus: jest.fn().mockImplementation(async () => { calls.push('write'); return deploymentRecord({ status: 'DELETING' }); }) },
      }),
      run: (s) => s.DeleteDeployment({ tenantId: TENANT_ID, applicationId: APP_ID }, context),
    },
    {
      name: 'UpdateCell',
      event: 'CELL_UPDATE',
      build: 'cellBuild',
      mocks: (calls) => ({
        cellRepo: { transitionStatus: jest.fn().mockImplementation(async () => { calls.push('write'); return cellRecord({ status: 'UPDATING' }); }) },
      }),
      run: (s) => s.UpdateCell({ cellId: CELL_ID }, context),
    },
    {
      name: 'DeleteCell',
      event: 'CELL_DELETE',
      build: 'cellBuild',
      mocks: (calls) => ({
        cellRepo: { transitionStatus: jest.fn().mockImplementation(async () => { calls.push('write'); return cellRecord({ status: 'DELETING' }); }) },
      }),
      run: (s) => s.DeleteCell({ cellId: CELL_ID }, context),
    },
  ];

  test.each(cases)('$name: the $event hooks, global then stamped, in the $build; the global read precedes the write', async (c) => {
    const calls: string[] = [];
    const service = makeService({ calls, globalHooks: globals, ...c.mocks(calls) });

    await c.run(service);

    expect(calls.indexOf('readHooks')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('readHooks')).toBeLessThan(calls.indexOf('write'));
    const hooks = startedInput()[c.build].hooks;
    expect(hooks.event).toBe(c.event);
    // The global hook of this event only, then the stamped pre hook; the post
    // hook is the stamp's only (a cell's stamp, never the application's list).
    expect(hooks.pre.map((h: { scope: string; hookId: string }) => `${h.scope}/${h.hookId}`)).toEqual([
      `GLOBAL/g-${c.event.toLowerCase().replace('_', '-')}`,
      'APPLICATION/stamp-pre',
    ]);
    expect(hooks.post.map((h: { hookId: string }) => h.hookId)).toEqual(['stamp-post']);
    expect(JSON.stringify(hooks)).not.toContain('current-app-hook');
  });

  test.each(cases)('$name: a failed global hook read is a 500 with nothing written and no execution started', async (c) => {
    const calls: string[] = [];
    const service = makeService({ calls, hookRead: jest.fn().mockRejectedValue(new Error('throttled')), ...c.mocks(calls) });

    await expect(c.run(service)).rejects.toBeInstanceOf(InternalServerError);

    expect(calls).not.toContain('write');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('a new-cell CreateDeployment reads the hooks before its first write, and a failed read writes nothing', async () => {
    const calls: string[] = [];
    const ok = makeService({ calls, globalHooks: globals });
    await ok.CreateDeployment({ tenantId: TENANT_ID, applicationId: APP_ID, adminEmail: 'success@simulator.amazonses.com' }, context);
    expect(calls).toEqual(['readHooks', 'write']);

    calls.length = 0;
    const failing = makeService({ calls, hookRead: jest.fn().mockRejectedValue(new Error('x')) });
    await expect(failing.CreateDeployment({ tenantId: TENANT_ID, applicationId: APP_ID, adminEmail: 'success@simulator.amazonses.com' }, context))
      .rejects.toBeInstanceOf(InternalServerError);
    expect(calls).toEqual([]);
  });

  test('the global hooks are read in ONE strongly consistent query of the HOOK partition', async () => {
    const queryPartition = jest.fn().mockResolvedValue({ items: [], nextToken: undefined });
    const service = makeService({ hookRead: queryPartition, cellRepo: { transitionStatus: jest.fn().mockResolvedValue(cellRecord({ status: 'DELETING' })) } });
    await service.DeleteCell({ cellId: CELL_ID }, context);
    expect(queryPartition).toHaveBeenCalledTimes(1);
    expect(queryPartition.mock.calls[0][0]).toEqual({ partitionKey: 'HOOK', sortKeyPrefix: 'HOOK#', consistentRead: true });
  });

  test('a cell stamped before hooks existed resolves to empty lists for its own events', async () => {
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ hooks: undefined })),
        transitionStatus: jest.fn().mockResolvedValue(cellRecord({ status: 'UPDATING' })),
      },
    });
    await service.UpdateCell({ cellId: CELL_ID }, context);
    expect(startedInput().cellBuild.hooks).toEqual({ event: 'CELL_UPDATE', pre: [], post: [] });
  });
});

// ---------------------------------------------------------------------------
// Reads: the stamped hooks and what ran (§5.2, §5.3, R-40)
// ---------------------------------------------------------------------------

describe('GetCell / GetDeployment return the stamped hooks and lastGlobalHooks', () => {
  const ran = [
    { hookId: 'g-1', phase: 'PRE' as const, revision: 2, sourceVersion: 'main', resolvedSourceVersion: SHA },
    { hookId: 'g-2', phase: 'POST' as const, revision: 1 },
  ];

  test('GetCell shows the stamp and what ran, an empty list when nothing did', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce(cellRecord({ lastGlobalHooks: ran }))
      .mockResolvedValueOnce(cellRecord({ hooks: undefined }));
    const service = makeService({ cellRepo: { get } });
    const first = await service.GetCell({ cellId: CELL_ID }, context);
    expect(first.cell?.hooks).toEqual(stampedHooks);
    expect(first.cell?.lastGlobalHooks).toEqual(ran);
    const second = await service.GetCell({ cellId: CELL_ID }, context);
    expect(second.cell?.hooks).toEqual([]);
    expect(second.cell?.lastGlobalHooks).toEqual([]);
  });

  test('GetDeployment resolves the effective hooks from the cell and reports its own lastGlobalHooks', async () => {
    const service = makeService({ deploymentRepo: { get: jest.fn().mockResolvedValue(deploymentRecord({ lastGlobalHooks: ran })) } });
    const out = await service.GetDeployment({ tenantId: TENANT_ID, applicationId: APP_ID }, context);
    expect(out.hooks).toEqual(stampedHooks);
    expect(out.deployment?.lastGlobalHooks).toEqual(ran);
  });
});

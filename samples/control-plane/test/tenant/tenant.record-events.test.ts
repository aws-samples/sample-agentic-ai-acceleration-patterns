// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The API side of ADR-045: the seven record operations accept a change with
 * one conditional write, start one execution named after the stored
 * `operationId`, and compensate a start that did not go through (spec R-48
 * to R-51, §5.1, §5.4, §5.5); placement claims only live records (R-13,
 * §7.1).
 */

import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBItem } from '../../src/shared/data-model';
import { HookTransactions } from '../../src/shared/hook-transactions';
import {
  AccountFullError,
  AccountNotLiveError,
  ApplicationNotLiveError,
  ConditionFailedError,
  DynamoDBRepository,
  PlacementTransactions,
  StaleTransitionError,
  TenantNotLiveError,
} from '../../src/shared/repository';
import { CallerContext } from '../../src/shared/service-config';
import {
  ConflictError,
  InsufficientCapacityError,
  InternalServerError,
  LifecycleStatus,
  ValidationException,
} from '../../src/smithy/source/typescript-ssdk-codegen/src';
import { AccountItem, AccountRecord } from '../../src/tenant/account.data-model';
import { ApplicationItem, ApplicationRecord } from '../../src/tenant/application.data-model';
import { CellItem, CellRecord } from '../../src/tenant/cell.data-model';
import { DeploymentItem, DeploymentRecord } from '../../src/tenant/deployment.data-model';
import { HookItem } from '../../src/tenant/hook.data-model';
import { GlobalHookRecord, HookDefinition, HookEvent } from '../../src/tenant/hook.types';
import { IdempotencyItem, IdempotencyRecord } from '../../src/tenant/idempotency.data-model';
import { TenantService } from '../../src/tenant/tenant';
import { TenantItem, TenantRecord } from '../../src/tenant/tenant.data-model';

const sfnMock = mockClient(SFNClient);
/** The two clients the service gets: the normal one and the one-attempt start client (R-51). */
const sfnClient = new SFNClient({});
const recordStartClient = new SFNClient({ maxAttempts: 1 });
const context: CallerContext = { operatorId: 'op-1', role: 'operator', grant: 'operator' };

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CELL_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const APP_ID = 'app-x';
const ACCOUNT_ID = '111111111111';
const TENANT_ACCOUNT_ID = '222222222222';
const SHA = '4f0c9e1b2a3d4c5e6f708192a3b4c5d6e7f80912';
const T0 = new Date('2026-01-01T00:00:00Z');
const STATE_MACHINE = `arn:aws:states:eu-central-1:${ACCOUNT_ID}:stateMachine:control-plane-workflow`;
const EARLIER_OP = 'earlier-operation';

const source = { type: 'GITHUB' as const, location: 'https://github.com/acme/application.git', sourceVersion: SHA };
const scripts = (prefix: string) => ({ create: `${prefix}/create.sh`, update: `${prefix}/update.sh`, delete: `${prefix}/delete.sh` });
const RECORD_EVENTS: HookEvent[] = [
  'APPLICATION_CREATE', 'APPLICATION_UPDATE', 'APPLICATION_DELETE',
  'TENANT_CREATE', 'TENANT_UPDATE', 'TENANT_DELETE',
  'ACCOUNT_CREATE', 'ACCOUNT_UPDATE', 'ACCOUNT_DELETE',
];

function hookDef(hookId: string, overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    hookId,
    events: ['APPLICATION_CREATE', 'APPLICATION_UPDATE', 'APPLICATION_DELETE'],
    phase: 'PRE',
    source: { type: 'GITHUB', location: `https://github.com/acme/${hookId}.git`, sourceVersion: SHA },
    script: 'hooks/run.sh',
    timeoutMinutes: 10,
    ...overrides,
  };
}
const gate: GlobalHookRecord = { ...hookDef('gate'), events: RECORD_EVENTS, revision: 3, createdAt: T0, updatedAt: T0 };

function applicationRecord(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    applicationId: APP_ID,
    source,
    cellScripts: scripts('app/cell'),
    tenantScripts: scripts('app/tenant'),
    maxTenants: 4,
    placementStrategy: 'FILL',
    hooks: [hookDef('stored-app-hook')],
    cellCount: 0,
    status: 'ACTIVE',
    operationId: EARLIER_OP,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}
function accountRecord(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    accountId: ACCOUNT_ID,
    owner: 'VENDOR',
    maxCells: 2,
    cellCount: 0,
    status: 'ACTIVE',
    operationId: EARLIER_OP,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}
function tenantRecord(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return { tenantId: TENANT_ID, name: 'acme', deploymentCount: 0, status: 'ACTIVE', createdAt: T0, updatedAt: T0, ...overrides };
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
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const page = <T>(...items: T[]) => jest.fn().mockResolvedValue({ items, nextToken: undefined });
const repo = <R, I extends DynamoDBItem>(methods: object) => methods as unknown as DynamoDBRepository<R, I>;

/**
 * Each repository's methods are merged over a default `get` (and, for the
 * record repositories, a write that echoes the record it was asked to
 * write). `calls` records the hook read and every write, in order.
 */
interface Mocks {
  calls?: string[];
  tenantRepo?: object;
  accountRepo?: object;
  applicationRepo?: object;
  cellRepo?: object;
  placement?: object;
  globalHooks?: GlobalHookRecord[];
  handshake?: jest.Mock;
}

function makeService(mocks: Mocks = {}) {
  const calls = mocks.calls ?? [];
  const logged = <T>(name: string, impl: (...args: any[]) => Promise<T>) =>
    jest.fn().mockImplementation(async (...args: any[]) => {
      calls.push(name);
      return impl(...args);
    });
  return new TenantService({
    tenantRepository: repo<TenantRecord, TenantItem>({
      get: jest.fn().mockResolvedValue(tenantRecord()),
      put: logged('write', async () => undefined),
      transitionStatus: logged('write', async (_key, t) => tenantRecord({ status: t.to, ...t.setFields })),
      ...mocks.tenantRepo,
    }),
    deploymentRepository: repo<DeploymentRecord, DeploymentItem>({}),
    cellRepository: repo<CellRecord, CellItem>({ get: jest.fn().mockResolvedValue(cellRecord()), queryIndex: page(), ...mocks.cellRepo }),
    idempotencyRepository: repo<IdempotencyRecord, IdempotencyItem>({ get: jest.fn().mockResolvedValue(undefined) }),
    accountRepository: repo<AccountRecord, AccountItem>({
      get: jest.fn().mockResolvedValue(accountRecord()),
      queryIndex: page(accountRecord()),
      update: logged('write', async () => accountRecord({ status: 'CREATING' })),
      transitionStatus: logged('write', async (_key, t) => accountRecord({ status: t.to, ...t.setFields })),
      ...mocks.accountRepo,
    }),
    applicationRepository: repo<ApplicationRecord, ApplicationItem>({
      get: jest.fn().mockResolvedValue(applicationRecord()),
      update: logged('write', async () => applicationRecord({ status: 'UPDATING' })),
      transitionStatus: logged('write', async (_key, t) => applicationRecord({ status: t.to, ...t.setFields })),
      ...mocks.applicationRepo,
    }),
    placement: { ...mocks.placement } as unknown as PlacementTransactions<CellRecord, CellItem, DeploymentRecord, DeploymentItem>,
    hookRepository: repo<GlobalHookRecord, HookItem>({
      get: jest.fn().mockResolvedValue(undefined),
      queryPartition: logged('readHooks', async () => ({ items: mocks.globalHooks ?? [], nextToken: undefined })),
    }),
    hookTransactions: {} as unknown as HookTransactions<GlobalHookRecord, HookItem>,
    fleetName: 'control-plane',
    partition: 'aws',
    handshake: mocks.handshake ?? jest.fn().mockResolvedValue([]),
    stateMachineArn: STATE_MACHINE,
    sfnClient,
    recordStartClient,
    warn: jest.fn(),
  });
}

const starts = () => sfnMock.commandCalls(StartExecutionCommand);
const started = (call = 0) => JSON.parse(starts()[call].args[0].input.input!).recordEvent;
const startedName = (call = 0) => starts()[call].args[0].input.name!;

/** An SDK-shaped service error: `name`, and the SDK's retry count when given. */
function sfnError(name: string, attempts?: number): Error {
  return Object.assign(new Error(name), { name, ...(attempts === undefined ? {} : { $metadata: { attempts } }) });
}

const putApplicationInput = {
  applicationId: APP_ID,
  source,
  cellScripts: scripts('c'),
  tenantScripts: scripts('t'),
  maxTenants: 3,
};
const putAccountInput = { accountId: ACCOUNT_ID, owner: 'VENDOR' as const, maxCells: 2 };

beforeEach(() => {
  sfnMock.reset();
  sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:exec' });
});

// ---------------------------------------------------------------------------
// One execution per accepted operation (R-50, R-51)
// ---------------------------------------------------------------------------

type OpCase = {
  readonly name: string;
  readonly event: HookEvent;
  readonly recordId: string;
  readonly mocks: Mocks;
  readonly run: (service: TenantService) => Promise<unknown>;
};
const opCases: OpCase[] = [
  {
    name: 'PutApplication (create)',
    event: 'APPLICATION_CREATE',
    recordId: APP_ID,
    mocks: { applicationRepo: { get: jest.fn().mockResolvedValue(undefined) } },
    run: (s) => s.PutApplication(putApplicationInput, context),
  },
  {
    name: 'PutApplication (replace)',
    event: 'APPLICATION_UPDATE',
    recordId: APP_ID,
    mocks: { applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ hooks: undefined })) } },
    run: (s) => s.PutApplication(putApplicationInput, context),
  },
  {
    name: 'DeleteApplication',
    event: 'APPLICATION_DELETE',
    recordId: APP_ID,
    mocks: {},
    run: (s) => s.DeleteApplication({ applicationId: APP_ID }, context),
  },
  { name: 'CreateTenant', event: 'TENANT_CREATE', recordId: '', mocks: {}, run: (s) => s.CreateTenant({ name: 'acme' }, context) },
  { name: 'UpdateTenant', event: 'TENANT_UPDATE', recordId: TENANT_ID, mocks: {}, run: (s) => s.UpdateTenant({ tenantId: TENANT_ID, name: 'b' }, context) },
  { name: 'DeleteTenant', event: 'TENANT_DELETE', recordId: TENANT_ID, mocks: {}, run: (s) => s.DeleteTenant({ tenantId: TENANT_ID }, context) },
  {
    name: 'PutAccount (create)',
    event: 'ACCOUNT_CREATE',
    recordId: ACCOUNT_ID,
    mocks: { accountRepo: { get: jest.fn().mockResolvedValue(undefined) } },
    run: (s) => s.PutAccount(putAccountInput, context),
  },
  { name: 'PutAccount (replace)', event: 'ACCOUNT_UPDATE', recordId: ACCOUNT_ID, mocks: {}, run: (s) => s.PutAccount(putAccountInput, context) },
  { name: 'DeleteAccount', event: 'ACCOUNT_DELETE', recordId: ACCOUNT_ID, mocks: {}, run: (s) => s.DeleteAccount({ accountId: ACCOUNT_ID }, context) },
];

describe('each of the seven record operations starts one execution named after the operationId it stored (R-50, R-51)', () => {
  test.each(opCases)('$name: reads the global hooks, writes once, starts $event under the stored operationId, answers 202 with the record', async (c) => {
    const calls: string[] = [];
    const service = makeService({ ...c.mocks, calls });
    const output = (await c.run(service)) as Record<string, { operationId?: string; status?: LifecycleStatus }>;

    // R-40: the global hooks are read before the first write; one write.
    expect(calls.filter((x) => x === 'write')).toHaveLength(1);
    expect(calls.indexOf('readHooks')).toBeLessThan(calls.indexOf('write'));
    expect(starts()).toHaveLength(1);
    const input = started();
    expect(input.event).toBe(c.event);
    expect(startedName()).toBe(input.operationId);
    expect(input.operationId).toMatch(new RegExp(`-${c.event.toLowerCase().replace('_', '-')}-\\d{13}-[0-9a-f]{8}$`));
    if (c.recordId !== '') {
      expect(input.recordId).toBe(c.recordId);
      expect(input.operationId.startsWith(`${c.recordId}-`)).toBe(true);
    }
    expect(input.environment.EXECUTION_ID).toBe(input.operationId);
    // No global hook is registered: the execution is started all the same (§8.4).
    expect(input.hooks.event).toBe(c.event);
    expect([...input.hooks.pre, ...input.hooks.post].filter((h: { scope: string }) => h.scope === 'GLOBAL')).toEqual([]);
    if (!c.event.startsWith('APPLICATION_') || c.name === 'PutApplication (replace)') {
      expect(input.hooks).toEqual({ event: c.event, pre: [], post: [] });
    }
    expect(Object.values(output)[0]).toBeDefined();
  });

  test('two operations accepted in the same millisecond get different names (R-51)', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1763460000000);
    try {
      const service = makeService();
      await service.UpdateTenant({ tenantId: TENANT_ID, name: 'a' }, context);
      await service.UpdateTenant({ tenantId: TENANT_ID, name: 'b' }, context);
      expect(startedName(0)).toMatch(/-tenant-update-1763460000000-[0-9a-f]{8}$/);
      expect(startedName(0)).not.toBe(startedName(1));
    } finally {
      now.mockRestore();
    }
  });

  test('a tenant or account event runs global hooks only; an application event adds the application hooks of the definition written (R-40, R-50)', async () => {
    const globalHooks = [gate];
    await makeService({ globalHooks }).UpdateTenant({ tenantId: TENANT_ID, name: 'b' }, context);
    expect(started(0).hooks.pre.map((h: { scope: string }) => h.scope)).toEqual(['GLOBAL']);
    await makeService({ globalHooks }).DeleteAccount({ accountId: ACCOUNT_ID }, context);
    expect(started(1).hooks.pre.map((h: { scope: string }) => h.scope)).toEqual(['GLOBAL']);

    // A replace that keeps the hook list runs the stored list ...
    await makeService({ globalHooks }).PutApplication(putApplicationInput, context);
    expect(started(2).hooks.pre.map((h: { hookId: string }) => h.hookId)).toEqual(['gate', 'stored-app-hook']);
    // ... one that sends a list runs the request's.
    await makeService({ globalHooks }).PutApplication({ ...putApplicationInput, hooks: [hookDef('sent')] as never }, context);
    expect(started(3).hooks.pre.map((h: { hookId: string }) => h.hookId)).toEqual(['gate', 'sent']);
    // A delete runs the stored list.
    await makeService({ globalHooks }).DeleteApplication({ applicationId: APP_ID }, context);
    expect(started(4).hooks.pre.map((h: { hookId: string }) => h.hookId)).toEqual(['gate', 'stored-app-hook']);
  });

  test('a record event\'s input carries no PARAM_ variable, no external id and no admin email (R-42)', async () => {
    const accountRepo = { get: jest.fn().mockResolvedValue(accountRecord({ owner: 'TENANT', externalId: 'old-ext' })) };
    await makeService({ accountRepo, globalHooks: [gate] })
      .PutAccount({ ...putAccountInput, owner: 'TENANT', externalId: 'new-ext' }, context);
    const raw = starts()[0].args[0].input.input!;
    expect(raw).not.toMatch(/new-ext|old-ext|PARAM_|ADMIN_EMAIL/);
  });
});

// ---------------------------------------------------------------------------
// The start's outcome and the compensation (R-51)
// ---------------------------------------------------------------------------

describe('the start client (R-51)', () => {
  test('a record event\'s StartExecution goes through the one-attempt client; DescribeExecution through the normal one', async () => {
    sfnMock.on(StartExecutionCommand).rejects(sfnError('TimeoutError'));
    sfnMock.on(DescribeExecutionCommand).resolves({ status: 'RUNNING' });
    await makeService().CreateTenant({ name: 'a' }, context);
    expect(starts()).toHaveLength(1);
    expect(starts()[0].thisValue).toBe(recordStartClient);
    expect(sfnMock.commandCalls(DescribeExecutionCommand)[0].thisValue).toBe(sfnClient);
    expect(await recordStartClient.config.maxAttempts()).toBe(1);
  });

  test('a create throttled on its one attempt is a definite refusal: the insert is deleted, no lookup and no second start', async () => {
    // A one-attempt client reports attempts 1 on its error.
    sfnMock.on(StartExecutionCommand).rejects(sfnError('ThrottlingException', 1));
    const del = jest.fn().mockResolvedValue(undefined);
    const transitionStatus = jest.fn();
    const failure = await makeService({ tenantRepo: { delete: del, transitionStatus } }).CreateTenant({ name: 'a' }, context).catch((e) => e);
    expect(failure).toBeInstanceOf(InternalServerError);
    expect(failure.message).toContain('was refused');
    expect(del).toHaveBeenCalledTimes(1);
    expect(transitionStatus).not.toHaveBeenCalled();
    expect(starts()).toHaveLength(1);
    expect(sfnMock.commandCalls(DescribeExecutionCommand)).toHaveLength(0);
  });
});

describe('a refused start (R-51)', () => {
  test.each(['ValidationException', 'ThrottlingException', 'ExecutionLimitExceeded', 'StateMachineDoesNotExist', 'AccessDeniedException'])(
    'CreateTenant whose own StartExecution answered %s deletes the fresh insert (CREATING, own operationId, count 0) and answers 500',
    async (name) => {
      sfnMock.on(StartExecutionCommand).rejects(sfnError(name, 1));
      const del = jest.fn().mockResolvedValue(undefined);
      const put = jest.fn().mockResolvedValue(undefined);
      const service = makeService({ tenantRepo: { put, delete: del } });

      const failure = await service.CreateTenant({ name: 'acme' }, context).catch((e) => e);

      expect(failure).toBeInstanceOf(InternalServerError);
      expect(failure.message).toContain('was refused');
      const record = put.mock.calls[0][0];
      expect(del).toHaveBeenCalledWith(
        { PK: `TENANT#${record.tenantId}`, SK: 'META' },
        {
          conditionExpression: '#status = :creating AND #operationId = :op AND #deploymentCount = :zero',
          expressionAttributeNames: { '#status': 'status', '#operationId': 'operationId', '#deploymentCount': 'deploymentCount' },
          expressionAttributeValues: { ':creating': 'CREATING', ':op': record.operationId, ':zero': 0 },
        },
      );
      // A refusal is known: no lookup, no second start.
      expect(sfnMock.commandCalls(DescribeExecutionCommand)).toHaveLength(0);
      expect(starts()).toHaveLength(1);
    },
  );

  test('PutApplication and PutAccount creates: a refused start deletes the insert on cellCount = 0', async () => {
    sfnMock.on(StartExecutionCommand).rejects(sfnError('ValidationException'));
    const appDelete = jest.fn().mockResolvedValue(undefined);
    await expect(makeService({ applicationRepo: { get: jest.fn().mockResolvedValue(undefined), delete: appDelete } })
      .PutApplication(putApplicationInput, context)).rejects.toBeInstanceOf(InternalServerError);
    expect(appDelete.mock.calls[0][1].conditionExpression).toBe('#status = :creating AND #operationId = :op AND #cellCount = :zero');
    const accountDelete = jest.fn().mockResolvedValue(undefined);
    await expect(makeService({ accountRepo: { get: jest.fn().mockResolvedValue(undefined), delete: accountDelete } })
      .PutAccount(putAccountInput, context)).rejects.toBeInstanceOf(InternalServerError);
    expect(accountDelete.mock.calls[0][1].conditionExpression).toBe('#status = :creating AND #operationId = :op AND #cellCount = :zero');
  });

  test('a pre-creation error after the SDK retried proves nothing about the earlier attempt: unknown, never a delete', async () => {
    sfnMock.on(StartExecutionCommand).rejects(sfnError('ThrottlingException', 3));
    sfnMock.on(DescribeExecutionCommand).rejects(sfnError('ExecutionDoesNotExist'));
    const del = jest.fn();
    const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'CREATE_FAILED' }));
    const failure = await makeService({ tenantRepo: { delete: del, transitionStatus } }).CreateTenant({ name: 'a' }, context).catch((e) => e);
    expect(failure).toBeInstanceOf(InternalServerError);
    expect(del).not.toHaveBeenCalled();
    expect(transitionStatus.mock.calls[0][1]).toMatchObject({ fromAnyOf: ['CREATING'], to: 'CREATE_FAILED' });
  });

  test('a re-put of a CREATE_FAILED application or account goes back to CREATE_FAILED, never deleted', async () => {
    sfnMock.on(StartExecutionCommand).rejects(sfnError('ValidationException'));
    const appTransition = jest.fn().mockResolvedValue(applicationRecord({ status: 'CREATE_FAILED' }));
    const appDelete = jest.fn();
    await expect(makeService({
      applicationRepo: {
        get: jest.fn().mockResolvedValue(applicationRecord({ status: 'CREATE_FAILED' })),
        update: jest.fn().mockResolvedValue(applicationRecord({ status: 'CREATING' })),
        transitionStatus: appTransition,
        delete: appDelete,
      },
    }).PutApplication(putApplicationInput, context)).rejects.toBeInstanceOf(InternalServerError);
    expect(appDelete).not.toHaveBeenCalled();
    expect(appTransition.mock.calls[0][1]).toMatchObject({ fromAnyOf: ['CREATING'], to: 'CREATE_FAILED' });

    const accountTransition = jest.fn().mockResolvedValue(accountRecord({ status: 'CREATE_FAILED' }));
    await expect(makeService({
      accountRepo: {
        get: jest.fn().mockResolvedValue(accountRecord({ status: 'CREATE_FAILED' })),
        update: jest.fn().mockResolvedValue(accountRecord({ status: 'CREATING' })),
        transitionStatus: accountTransition,
        delete: jest.fn(),
      },
    }).PutAccount(putAccountInput, context)).rejects.toBeInstanceOf(InternalServerError);
    expect(accountTransition.mock.calls[0][1]).toMatchObject({ to: 'CREATE_FAILED' });
  });
});

describe('an unknown start (R-51)', () => {
  /** The first StartExecution timed out; the lookup and the retry answer as given. */
  function unknownStart(describe: Error | object, retry: Error | object) {
    const timeout = sfnError('TimeoutError');
    const start = sfnMock.on(StartExecutionCommand);
    start.rejectsOnce(timeout);
    if (retry instanceof Error) {
      start.rejects(retry);
    } else {
      start.resolves(retry);
    }
    if (describe instanceof Error) {
      sfnMock.on(DescribeExecutionCommand).rejects(describe);
    } else {
      sfnMock.on(DescribeExecutionCommand).resolves(describe);
    }
  }

  test.each([
    ['ExecutionDoesNotExist', sfnError('ExecutionDoesNotExist')],
    ['a failed lookup', sfnError('AccessDeniedException')],
  ])('a fresh insert whose start timed out and whose DescribeExecution answered %s goes to CREATE_FAILED, never deleted; 500', async (_name, describeError) => {
    unknownStart(describeError, sfnError('ServiceUnavailable'));
    const del = jest.fn();
    const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'CREATE_FAILED' }));
    const put = jest.fn().mockResolvedValue(undefined);
    const failure = await makeService({ tenantRepo: { put, delete: del, transitionStatus } }).CreateTenant({ name: 'a' }, context).catch((e) => e);

    expect(failure).toBeInstanceOf(InternalServerError);
    expect(failure.message).toContain('unknown outcome');
    expect(del).not.toHaveBeenCalled();
    const record = put.mock.calls[0][0];
    expect(transitionStatus).toHaveBeenCalledWith({ PK: `TENANT#${record.tenantId}`, SK: 'META' }, expect.objectContaining({
      fromAnyOf: ['CREATING'],
      to: 'CREATE_FAILED',
      setFields: { statusReason: expect.stringContaining('TENANT_CREATE: the workflow start had an unknown outcome') },
      extraCondition: expect.objectContaining({ conditionExpression: '#operationId = :op', expressionAttributeValues: { ':op': record.operationId } }),
    }));
    // The lookup names the operation's own execution.
    expect(sfnMock.commandCalls(DescribeExecutionCommand)[0].args[0].input.executionArn).toBe(
      `arn:aws:states:eu-central-1:${ACCOUNT_ID}:execution:control-plane-workflow:${record.operationId}`,
    );
    // The optional same-name retry carried the same name and input.
    expect(starts()).toHaveLength(2);
    expect(starts()[1].args[0].input).toEqual(starts()[0].args[0].input);
  });

  test('DescribeExecution finding the execution means the start went through: 202, nothing compensated', async () => {
    unknownStart({ status: 'RUNNING' }, sfnError('ServiceUnavailable'));
    const transitionStatus = jest.fn();
    const output = await makeService({ tenantRepo: { transitionStatus } }).CreateTenant({ name: 'a' }, context);
    expect(output.tenant?.status).toBe('CREATING');
    expect(transitionStatus).not.toHaveBeenCalled();
    expect(starts()).toHaveLength(1);
  });

  test.each([
    ['answers with the execution', { executionArn: 'arn:exec' }],
    ['answers ExecutionAlreadyExists', sfnError('ExecutionAlreadyExists')],
  ])('a retry under the same name that %s means the start went through: 202', async (_name, retry) => {
    unknownStart(sfnError('ExecutionDoesNotExist'), retry);
    const transitionStatus = jest.fn();
    await expect(makeService({ tenantRepo: { transitionStatus } }).CreateTenant({ name: 'a' }, context)).resolves.toBeDefined();
    expect(transitionStatus).not.toHaveBeenCalled();
  });

  test('ExecutionAlreadyExists on the operation\'s own first call means it went through (only its earlier attempt could have made it)', async () => {
    sfnMock.on(StartExecutionCommand).rejects(sfnError('ExecutionAlreadyExists'));
    const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'DELETING' }));
    await expect(makeService({ tenantRepo: { transitionStatus } }).DeleteTenant({ tenantId: TENANT_ID }, context)).resolves.toMatchObject({
      tenant: { status: 'DELETING' },
    });
    // Only the DELETING write: no compensation, no lookup.
    expect(transitionStatus).toHaveBeenCalledTimes(1);
    expect(sfnMock.commandCalls(DescribeExecutionCommand)).toHaveLength(0);
  });

  test('an UPDATING record goes to UPDATE_FAILED with pending removed, only while pending exists', async () => {
    sfnMock.on(StartExecutionCommand).rejects(sfnError('ValidationException'));
    const transitionStatus = jest.fn()
      .mockResolvedValueOnce(tenantRecord({ status: 'UPDATING', pending: { name: 'b' } }))
      .mockResolvedValueOnce(tenantRecord({ status: 'UPDATE_FAILED' }));
    await expect(makeService({ tenantRepo: { transitionStatus } }).UpdateTenant({ tenantId: TENANT_ID, name: 'b' }, context))
      .rejects.toBeInstanceOf(InternalServerError);
    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['UPDATING'],
      to: 'UPDATE_FAILED',
      removeFields: ['pending'],
      extraCondition: { conditionExpression: '#operationId = :op AND attribute_exists(#pending)' },
    });
  });

  test('a DELETING record goes to DELETE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(sfnError('ValidationException'));
    const transitionStatus = jest.fn()
      .mockResolvedValueOnce(accountRecord({ status: 'DELETING' }))
      .mockResolvedValueOnce(accountRecord({ status: 'DELETE_FAILED' }));
    await expect(makeService({ accountRepo: { transitionStatus } }).DeleteAccount({ accountId: ACCOUNT_ID }, context))
      .rejects.toBeInstanceOf(InternalServerError);
    expect(transitionStatus.mock.calls[1][1]).toMatchObject({ fromAnyOf: ['DELETING'], to: 'DELETE_FAILED' });
  });
});

describe('a compensation whose condition fails is evidence (R-51)', () => {
  beforeEach(() => {
    sfnMock.on(StartExecutionCommand).rejects(sfnError('ValidationException'));
  });

  /** Runs UpdateTenant with the compensation refused and the record then read as `read`. */
  async function updateWithCompensationLost(read: (operationId: string) => TenantRecord | undefined) {
    let operationId = '';
    const transitionStatus = jest.fn()
      .mockImplementationOnce(async (_key, t) => {
        operationId = t.setFields.operationId;
        return tenantRecord({ status: 'UPDATING', pending: t.setFields.pending, operationId });
      })
      .mockRejectedValueOnce(new StaleTransitionError('lost'));
    const get = jest.fn()
      .mockResolvedValueOnce(tenantRecord())
      .mockImplementationOnce(async () => read(operationId));
    return makeService({ tenantRepo: { get, transitionStatus } }).UpdateTenant({ tenantId: TENANT_ID, name: 'b' }, context);
  }

  test.each([
    ['ACTIVE', (op: string) => tenantRecord({ status: 'ACTIVE', name: 'b', operationId: op })],
    ['UPDATE_FAILED', (op: string) => tenantRecord({ status: 'UPDATE_FAILED', operationId: op })],
    ['UPDATING without pending (the commit landed)', (op: string) => tenantRecord({ status: 'UPDATING', operationId: op })],
  ])('the same operationId read as %s: the execution ran, 202 with the record as read', async (_name, read) => {
    const output = await updateWithCompensationLost(read);
    expect(output.tenant?.operationId).toBe(startedName());
  });

  test.each([
    ['another operationId', () => tenantRecord({ status: 'ACTIVE', operationId: 'someone-else' })],
    ['UPDATING with pending still there', (op: string) => tenantRecord({ status: 'UPDATING', operationId: op, pending: { name: 'b' } })],
    ['a record gone after an update', () => undefined],
  ])('%s: 500', async (_name, read) => {
    await expect(updateWithCompensationLost(read)).rejects.toBeInstanceOf(InternalServerError);
  });

  test('a delete whose compensation found the record gone: the execution deleted it, 202 with the DELETING record', async () => {
    const transitionStatus = jest.fn()
      .mockImplementationOnce(async (_key, t) => tenantRecord({ status: 'DELETING', operationId: t.setFields.operationId }))
      .mockRejectedValueOnce(new StaleTransitionError('gone'));
    const get = jest.fn().mockResolvedValueOnce(tenantRecord()).mockResolvedValueOnce(undefined);
    const output = await makeService({ tenantRepo: { get, transitionStatus } }).DeleteTenant({ tenantId: TENANT_ID }, context);
    expect(output.tenant?.status).toBe('DELETING');
  });

  test('a retried CreateTenant whose refused-start delete found the tenant ACTIVE answers 202, so no second tenant is made', async () => {
    let created: TenantRecord | undefined;
    const put = jest.fn().mockImplementation(async (record: TenantRecord) => { created = record; });
    const del = jest.fn().mockRejectedValue(new ConditionFailedError('not CREATING'));
    const get = jest.fn().mockImplementation(async () => ({ ...created!, status: 'ACTIVE' }));
    const output = await makeService({ tenantRepo: { put, delete: del, get } }).CreateTenant({ name: 'a' }, context);
    expect(output.tenant).toMatchObject({ tenantId: created!.tenantId, status: 'ACTIVE' });
  });

  test('a compensation that fails for another reason is a 500 naming the stranded status (T47)', async () => {
    const transitionStatus = jest.fn()
      .mockResolvedValueOnce(tenantRecord({ status: 'DELETING' }))
      .mockRejectedValueOnce(new Error('network'));
    const failure = await makeService({ tenantRepo: { transitionStatus } }).DeleteTenant({ tenantId: TENANT_ID }, context).catch((e) => e);
    expect(failure).toBeInstanceOf(InternalServerError);
    expect(failure.message).toContain('stays DELETING');
  });
});

// ---------------------------------------------------------------------------
// PutApplication paths (R-48, §5.5)
// ---------------------------------------------------------------------------

describe('PutApplication paths (R-48)', () => {
  test.each([
    [undefined, 'CREATE', 'attribute_not_exists(PK)', 'APPLICATION_CREATE'],
    ['CREATE_FAILED', 'RE_PUT', '#status = :createFailed', 'APPLICATION_CREATE'],
    ['ACTIVE', 'REPLACE', '(attribute_not_exists(#status) OR #status IN (:active, :updateFailed))', 'APPLICATION_UPDATE'],
    ['UPDATE_FAILED', 'REPLACE', '(attribute_not_exists(#status) OR #status IN (:active, :updateFailed))', 'APPLICATION_UPDATE'],
  ] as const)('a record read as %s takes the %s path', async (status, _path, condition, event) => {
    const update = jest.fn().mockResolvedValue(applicationRecord());
    const get = jest.fn().mockResolvedValue(status === undefined ? undefined : applicationRecord({ status }));
    await makeService({ applicationRepo: { get, update } }).PutApplication({ ...putApplicationInput, parameters: [], cellParameters: [] }, context);
    const write = update.mock.calls[0][1];
    // RE_PUT and REPLACE also hold the operationId as read (R-48, R-40).
    expect(write.conditionExpression).toBe(status === undefined ? condition : `${condition} AND #operationId = :readOperationId`);
    if (status !== undefined) {
      expect(write.expressionAttributeValues[':readOperationId']).toBe(EARLIER_OP);
    }
    expect(started().event).toBe(event);
  });

  test('a replace that keeps hooks runs the hooks of the record it read, and its write holds that record\'s operationId, so a put that commits other hooks in between refuses it (R-40, R-48)', async () => {
    const readHooks = [hookDef('read')];
    const update = jest.fn().mockResolvedValue(applicationRecord({ status: 'UPDATING' }));
    const get = jest.fn().mockResolvedValue(applicationRecord({ hooks: readHooks as never }));
    await makeService({ applicationRepo: { get, update } }).PutApplication({ ...putApplicationInput, parameters: [], cellParameters: [] }, context);
    expect(update.mock.calls[0][1].conditionExpression).toContain('#operationId = :readOperationId');
    expect(update.mock.calls[0][1].expressionAttributeValues[':readOperationId']).toBe(EARLIER_OP);
  });

  test('a replace stages every definition field and stores no live value; the commit names what pending holds', async () => {
    const update = jest.fn().mockResolvedValue(applicationRecord({ status: 'UPDATING' }));
    await makeService({ applicationRepo: { update } }).PutApplication({ ...putApplicationInput, cellParameters: [] }, context);
    const write = update.mock.calls[0][1];
    expect(Object.keys(write.expressionAttributeValues[':pending']).sort()).toEqual(
      ['cellParameters', 'cellScripts', 'maxTenants', 'placementStrategy', 'source', 'tenantScripts'],
    );
    expect(write.updateExpression).not.toMatch(/#source =|#maxTenants =|#cellCount = :/);
    expect(started().commit).toEqual({
      action: 'UPDATE',
      set: ['source', 'cellScripts', 'tenantScripts', 'maxTenants', 'placementStrategy', 'cellParameters'],
      remove: [],
    });
  });

  test.each([
    ['CREATING', true],
    ['UPDATING', true],
    ['DELETING', false],
    ['DELETE_FAILED', false],
  ] as const)('a record read as %s is a 409 (retry hint: %s) before anything is written', async (status, hint) => {
    const update = jest.fn();
    const calls: string[] = [];
    const failure = await makeService({ calls, applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ status })), update } })
      .PutApplication(putApplicationInput, context).catch((e) => e);
    expect(failure).toBeInstanceOf(ConflictError);
    expect(failure.message.includes('retry the request')).toBe(hint);
    expect(update).not.toHaveBeenCalled();
    expect(starts()).toHaveLength(0);
  });

  test('a request both invalid and in flight is a 400, not a 409 (R-48: validation first)', async () => {
    const failure = await makeService({ applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ status: 'UPDATING' })) } })
      .PutApplication({ ...putApplicationInput, parameters: [{ name: 'A' }, { name: 'A' }] }, context).catch((e) => e);
    expect(failure).toBeInstanceOf(ValidationException);
  });

  test('a record with no status (stored before ADR-045) reads as ACTIVE and takes the replace path (R-47)', async () => {
    const update = jest.fn().mockResolvedValue(applicationRecord());
    await makeService({ applicationRepo: { update } }).PutApplication(putApplicationInput, context);
    expect(update.mock.calls[0][1].conditionExpression).toContain('attribute_not_exists(#status)');
  });

  test.each([
    ['no item (deleted in between: the retry creates)', undefined, true],
    ['CREATE_FAILED (the retry re-puts)', applicationRecord({ status: 'CREATE_FAILED' }), true],
    ['ACTIVE with a changed kept list', applicationRecord({ parameters: [] }), true],
    ['ACTIVE after another accepted put (operationId changed)', applicationRecord({ operationId: 'app-x-application-update-1763460000001-00000000' }), true],
    ['UPDATE_FAILED after another accepted put', applicationRecord({ status: 'UPDATE_FAILED', operationId: 'app-x-application-update-1763460000001-00000000' }), true],
    ['UPDATING', applicationRecord({ status: 'UPDATING' }), true],
    ['DELETING', applicationRecord({ status: 'DELETING' }), false],
  ])('a write that loses its condition with ALL_OLD %s is a 409 classified by R-14', async (_name, current, hint) => {
    const failure = await makeService({ applicationRepo: { update: jest.fn().mockRejectedValue(new StaleTransitionError('x', current)) } })
      .PutApplication(putApplicationInput, context).catch((e) => e);
    expect(failure).toBeInstanceOf(ConflictError);
    expect(failure.message.includes('retry the request')).toBe(hint);
    expect(starts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PutAccount paths and the rotation (R-48, §5.4)
// ---------------------------------------------------------------------------

describe('PutAccount paths (R-48)', () => {
  test('a replace writes externalId into the record and stages maxCells and applicationIds; the ACCOUNT_UPDATE commit names them', async () => {
    const update = jest.fn().mockResolvedValue(accountRecord({ status: 'UPDATING' }));
    await makeService({
      accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ owner: 'TENANT', externalId: 'old' })), update },
    }).PutAccount({ accountId: ACCOUNT_ID, owner: 'TENANT', maxCells: 4, externalId: 'new' }, context);
    const write = update.mock.calls[0][1];
    expect(write.updateExpression).toContain('#externalId = :externalId');
    expect(write.expressionAttributeValues[':externalId']).toBe('new');
    expect(write.expressionAttributeValues[':pending']).toEqual({ maxCells: 4 });
    // An account staged without applicationIds becomes shared on commit.
    expect(started().commit).toEqual({ action: 'UPDATE', set: ['maxCells'], remove: ['applicationIds'] });
    expect(started().environment).toMatchObject({ EVENT: 'ACCOUNT_UPDATE', ACCOUNT_OWNER: 'TENANT', ACCOUNT_APPLICATION_IDS: '' });
  });

  test('a re-put of a CREATE_FAILED account writes into the record and runs ACCOUNT_CREATE again', async () => {
    const update = jest.fn().mockResolvedValue(accountRecord({ status: 'CREATING' }));
    await makeService({ accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ status: 'CREATE_FAILED' })), update } })
      .PutAccount(putAccountInput, context);
    expect(update.mock.calls[0][1].conditionExpression).toBe('#status = :createFailed AND #owner = :owner');
    expect(started().event).toBe('ACCOUNT_CREATE');
  });

  test.each(['CREATING', 'DELETING', 'DELETE_FAILED'] as const)('a %s account is a 409 before the probe', async (status) => {
    const handshake = jest.fn().mockResolvedValue([]);
    const update = jest.fn();
    await expect(makeService({ handshake, accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ status })), update } })
      .PutAccount(putAccountInput, context)).rejects.toBeInstanceOf(ConflictError);
    expect(handshake).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('more than 100 applicationIds, or one named twice, is a 400 before any read (§4.5)', async () => {
    const service = makeService();
    const many = Array.from({ length: 101 }, (_, i) => `app-${i}`);
    await expect(service.PutAccount({ ...putAccountInput, applicationIds: many }, context)).rejects.toBeInstanceOf(ValidationException);
    await expect(service.PutAccount({ ...putAccountInput, applicationIds: [APP_ID, APP_ID] }, context)).rejects.toBeInstanceOf(ValidationException);
  });

  test('a write that loses its condition: ALL_OLD with another owner is the owner 409 without a hint; gone is a 409 with one', async () => {
    const lost = (current: unknown) => makeService({
      accountRepo: { update: jest.fn().mockRejectedValue(new StaleTransitionError('x', current)) },
    }).PutAccount(putAccountInput, context).catch((e) => e);
    const owner = await lost(accountRecord({ owner: 'TENANT', status: 'DELETING' }));
    expect(owner.message).toContain('owner is immutable');
    expect(owner.message).not.toContain('retry the request');
    expect((await lost(undefined)).message).toContain('retry the request');
  });
});

describe('PutAccount rotation on an UPDATING account (R-48, T28)', () => {
  const inFlight = accountRecord({ status: 'UPDATING', operationId: 'running-op', pending: { maxCells: 4, applicationIds: [APP_ID] } });
  const rotateInput = { ...putAccountInput, maxCells: 4, applicationIds: [APP_ID], externalId: 'rotated' };

  test('equal to the change in flight: after the probe, writes externalId alone on owner, UPDATING and the operationId read; no execution, no hook read', async () => {
    const calls: string[] = [];
    const handshake = jest.fn().mockImplementation(async () => { calls.push('probe'); return []; });
    const update = jest.fn().mockImplementation(async () => { calls.push('write'); return inFlight; });
    const output = await makeService({ calls, handshake, accountRepo: { get: jest.fn().mockResolvedValue(inFlight), update } })
      .PutAccount(rotateInput, context);

    expect(calls).toEqual(['probe', 'write']);
    const write = update.mock.calls[0][1];
    expect(write.updateExpression).toBe('SET #updatedAt = :now, #externalId = :externalId');
    expect(write.conditionExpression).toBe('#owner = :owner AND #status = :updating AND #operationId = :readOperationId');
    expect(write.expressionAttributeValues[':readOperationId']).toBe('running-op');
    expect(starts()).toHaveLength(0);
    // The record keeps its operationId and staged change.
    expect(output.account).toMatchObject({ status: 'UPDATING', operationId: 'running-op' });
  });

  test('once the commit removed pending, the change in flight is the live values', async () => {
    const committed = accountRecord({ status: 'UPDATING', operationId: 'running-op', maxCells: 4, applicationIds: [APP_ID] });
    const update = jest.fn().mockResolvedValue(committed);
    await makeService({ accountRepo: { get: jest.fn().mockResolvedValue(committed), update } }).PutAccount(rotateInput, context);
    expect(update.mock.calls[0][1].conditionExpression).toContain('#status = :updating');
  });

  test.each([
    ['another maxCells', { maxCells: 5 }],
    ['other applicationIds', { applicationIds: ['app-other'] }],
    ['no applicationIds (shared)', { applicationIds: undefined }],
  ])('%s than the change in flight is a 409 with the retry hint, before the probe', async (_name, override) => {
    const handshake = jest.fn();
    const failure = await makeService({ handshake, accountRepo: { get: jest.fn().mockResolvedValue(inFlight) } })
      .PutAccount({ ...rotateInput, ...override }, context).catch((e) => e);
    expect(failure).toBeInstanceOf(ConflictError);
    expect(failure.message).toContain('retry the request');
    expect(handshake).not.toHaveBeenCalled();
  });

  test('a rotation that loses its condition to an event that ended reads once more and takes the replace path, without a second probe', async () => {
    const handshake = jest.fn().mockResolvedValue([]);
    const get = jest.fn().mockResolvedValueOnce(inFlight).mockResolvedValueOnce(accountRecord({ status: 'ACTIVE', operationId: 'running-op' }));
    const update = jest.fn()
      .mockRejectedValueOnce(new StaleTransitionError('ended', accountRecord({ status: 'ACTIVE' })))
      .mockResolvedValueOnce(accountRecord({ status: 'UPDATING' }));
    await makeService({ handshake, accountRepo: { get, update } }).PutAccount(rotateInput, context);

    expect(handshake).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][1]).toEqual({ consistentRead: true });
    const replace = update.mock.calls[1][1];
    expect(replace.conditionExpression).toBe('#owner = :owner AND (attribute_not_exists(#status) OR #status IN (:active, :updateFailed))');
    expect(replace.expressionAttributeValues[':externalId']).toBe('rotated');
    expect(started().event).toBe('ACCOUNT_UPDATE');
  });

  test('a rotation that loses its condition twice answers a 409 classified by R-14', async () => {
    const get = jest.fn().mockResolvedValue(inFlight);
    const update = jest.fn().mockRejectedValue(new StaleTransitionError('again', inFlight));
    const failure = await makeService({ accountRepo: { get, update } }).PutAccount(rotateInput, context).catch((e) => e);
    expect(failure).toBeInstanceOf(ConflictError);
    expect(update).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('a rotation whose re-read finds a status that admits no put answers that 409', async () => {
    const get = jest.fn().mockResolvedValueOnce(inFlight).mockResolvedValueOnce(accountRecord({ status: 'DELETING' }));
    const update = jest.fn().mockRejectedValueOnce(new StaleTransitionError('x', accountRecord({ status: 'DELETING' })));
    const failure = await makeService({ accountRepo: { get, update } }).PutAccount(rotateInput, context).catch((e) => e);
    expect(failure).toBeInstanceOf(ConflictError);
    expect(failure.message).not.toContain('retry the request');
    expect(update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Placement claims only live records (R-13, §7.1)
// ---------------------------------------------------------------------------

describe('CreateDeployment needs the tenant, the application and the chosen account live (R-13, §7.1)', () => {
  const createInput = { tenantId: TENANT_ID, applicationId: APP_ID, adminEmail: 'success@simulator.amazonses.com' };

  test.each([
    ['CREATING', true],
    ['CREATE_FAILED', false],
    ['DELETING', false],
    ['DELETE_FAILED', false],
  ] as const)('a tenant, an application or a targeted account read as %s is a 409 (retry hint: %s), nothing written', async (status, hint) => {
    const placement = { placeDeploymentInCell: jest.fn(), createCellWithDeployment: jest.fn() };
    const variants: [string, Mocks, Record<string, unknown>][] = [
      ['tenant', { tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ status })) } }, {}],
      ['application', { applicationRepo: { get: jest.fn().mockResolvedValue(applicationRecord({ status })) } }, {}],
      ['account', { accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ accountId: TENANT_ACCOUNT_ID, status })) } }, { accountId: TENANT_ACCOUNT_ID }],
    ];
    for (const [, mocks, extra] of variants) {
      const failure = await makeService({ ...mocks, placement }).CreateDeployment({ ...createInput, ...extra }, context).catch((e) => e);
      expect(failure).toBeInstanceOf(ConflictError);
      expect(failure.message.includes('retry the request')).toBe(hint);
    }
    expect(placement.placeDeploymentInCell).not.toHaveBeenCalled();
    expect(placement.createCellWithDeployment).not.toHaveBeenCalled();
  });

  test('UPDATING and UPDATE_FAILED records are live, and so is one with no status (R-47)', async () => {
    for (const status of ['UPDATING', 'UPDATE_FAILED', undefined] as const) {
      const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
      const record = { status: status as LifecycleStatus };
      await makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue({ ...tenantRecord(), ...record }) },
        applicationRepo: { get: jest.fn().mockResolvedValue({ ...applicationRecord(), ...record }) },
        accountRepo: { queryIndex: page({ ...accountRecord(), ...record }) },
        placement: { createCellWithDeployment },
      }).CreateDeployment(createInput, context);
      expect(createCellWithDeployment).toHaveBeenCalledTimes(1);
    }
  });

  test('untargeted placement skips accounts that are not live', async () => {
    const createCellWithDeployment = jest.fn().mockResolvedValue(undefined);
    await makeService({
      accountRepo: {
        queryIndex: page(
          accountRecord({ accountId: '333333333333', status: 'CREATING', createdAt: new Date('2025-01-01T00:00:00Z') }),
          accountRecord({ accountId: '444444444444', status: 'DELETING', createdAt: new Date('2025-02-01T00:00:00Z') }),
          accountRecord(),
        ),
      },
      placement: { createCellWithDeployment },
    }).CreateDeployment(createInput, context);
    expect(createCellWithDeployment).toHaveBeenCalledTimes(1);
    expect(createCellWithDeployment.mock.calls[0][0].accountKey).toEqual({ PK: `ACCOUNT#${ACCOUNT_ID}`, SK: 'META' });
  });

  test('a targeted account the transaction finds not live is a 409 ConflictError, never InsufficientCapacityError', async () => {
    for (const status of ['DELETING', undefined] as const) {
      const failure = await makeService({
        accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ accountId: TENANT_ACCOUNT_ID })) },
        placement: { createCellWithDeployment: jest.fn().mockRejectedValue(new AccountNotLiveError(status)) },
      }).CreateDeployment({ ...createInput, accountId: TENANT_ACCOUNT_ID }, context).catch((e) => e);
      expect(failure).toBeInstanceOf(ConflictError);
      expect(failure).not.toBeInstanceOf(InsufficientCapacityError);
      expect(failure.message).not.toContain('retry the request');
    }
  });

  test('a targeted full account is still InsufficientCapacityError', async () => {
    await expect(makeService({
      accountRepo: { get: jest.fn().mockResolvedValue(accountRecord({ accountId: TENANT_ACCOUNT_ID })) },
      placement: { createCellWithDeployment: jest.fn().mockRejectedValue(new AccountFullError('full')) },
    }).CreateDeployment({ ...createInput, accountId: TENANT_ACCOUNT_ID }, context)).rejects.toBeInstanceOf(InsufficientCapacityError);
  });

  test('untargeted: an account the transaction finds not live moves placement to the next account', async () => {
    const createCellWithDeployment = jest.fn()
      .mockRejectedValueOnce(new AccountNotLiveError('DELETING'))
      .mockResolvedValueOnce(undefined);
    await makeService({
      accountRepo: { queryIndex: page(accountRecord(), accountRecord({ accountId: '333333333333', createdAt: new Date('2026-02-01T00:00:00Z') })) },
      placement: { createCellWithDeployment },
    }).CreateDeployment(createInput, context);
    expect(createCellWithDeployment.mock.calls[1][0].accountKey).toEqual({ PK: 'ACCOUNT#333333333333', SK: 'META' });
  });

  test('a tenant or an application that left a live status after step 0 cancels the claim: 409, hint only for CREATING', async () => {
    const tenantLost = await makeService({
      cellRepo: { queryIndex: page(cellRecord()) },
      placement: { placeDeploymentInCell: jest.fn().mockRejectedValue(new TenantNotLiveError(LifecycleStatus.DELETING)) },
    }).CreateDeployment(createInput, context).catch((e) => e);
    expect(tenantLost).toBeInstanceOf(ConflictError);
    expect(tenantLost.message).toContain(`Tenant ${TENANT_ID} is DELETING`);
    expect(tenantLost.message).not.toContain('retry the request');

    const applicationLost = await makeService({
      placement: { createCellWithDeployment: jest.fn().mockRejectedValue(new ApplicationNotLiveError(LifecycleStatus.CREATING)) },
    }).CreateDeployment(createInput, context).catch((e) => e);
    expect(applicationLost).toBeInstanceOf(ConflictError);
    expect(applicationLost.message).toContain('retry the request');
  });
});

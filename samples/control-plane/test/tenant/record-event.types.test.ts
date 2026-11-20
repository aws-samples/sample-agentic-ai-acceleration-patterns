// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { LifecycleStatus } from '../../src/smithy/source/typescript-ssdk-codegen/src';
import { HOOK_FORBIDDEN_ENV_VARS, HOOK_PARAM_ENV_PREFIX, ResolvedHook } from '../../src/tenant/hook.types';
import {
  isLive,
  isRecordEvent,
  newOperationId,
  OPERATION_ID_MAX_LENGTH,
  OPERATION_ID_PATTERN,
  readRecordStatus,
  recordCommit,
  recordEventEnvironment,
  recordHookEnvironment,
  recordTypeOf,
} from '../../src/tenant/record-event.types';

const MS = 1763460000000;

function hook(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return {
    hookId: 'gate',
    scope: 'GLOBAL',
    revision: 2,
    sourceType: 'GITHUB',
    sourceLocation: 'https://github.com/acme/hooks.git',
    sourceVersion: '',
    script: 'hooks/gate.sh',
    timeoutMinutes: 10,
    ...overrides,
  };
}

describe('record status (R-47)', () => {
  test('an absent status reads as ACTIVE', () => {
    expect(readRecordStatus(undefined)).toBe(LifecycleStatus.ACTIVE);
    expect(readRecordStatus(LifecycleStatus.DELETING)).toBe(LifecycleStatus.DELETING);
  });

  test('live: ACTIVE, UPDATING, UPDATE_FAILED and absent; nothing else', () => {
    for (const status of [LifecycleStatus.ACTIVE, LifecycleStatus.UPDATING, LifecycleStatus.UPDATE_FAILED, undefined]) {
      expect(isLive(status)).toBe(true);
    }
    for (const status of [LifecycleStatus.CREATING, LifecycleStatus.CREATE_FAILED, LifecycleStatus.DELETING, LifecycleStatus.DELETE_FAILED]) {
      expect(isLive(status)).toBe(false);
    }
  });
});

describe('record events (§8.4)', () => {
  test('nine events over three record types; build events are not record events', () => {
    expect(isRecordEvent('APPLICATION_UPDATE')).toBe(true);
    expect(isRecordEvent('ACCOUNT_DELETE')).toBe(true);
    expect(isRecordEvent('CELL_CREATE')).toBe(false);
    expect(isRecordEvent('DEPLOYMENT_CREATE')).toBe(false);
    expect(isRecordEvent('TENANT_CREATE_X')).toBe(false);
    expect(recordTypeOf('TENANT_UPDATE')).toBe('TENANT');
  });
});

describe('newOperationId (R-51)', () => {
  test('extends the execution name shape with an 8-hex suffix', () => {
    expect(newOperationId('my-app', 'APPLICATION_UPDATE', MS, '0a1b2c3d'))
      .toBe('my-app-application-update-1763460000000-0a1b2c3d');
    expect(newOperationId('01JD3ZJ7Q8X4N5V6W7Y8Z9ABCD', 'TENANT_CREATE', MS, 'ffffffff'))
      .toBe('01JD3ZJ7Q8X4N5V6W7Y8Z9ABCD-tenant-create-1763460000000-ffffffff');
    expect(newOperationId('111111111111', 'ACCOUNT_DELETE', MS, '00000000'))
      .toBe('111111111111-account-delete-1763460000000-00000000');
  });

  test('a 32-character application id fills exactly the 74-character maximum', () => {
    const name = newOperationId('a'.repeat(32), 'APPLICATION_CREATE', MS, '0a1b2c3d');
    expect(name).toHaveLength(OPERATION_ID_MAX_LENGTH);
    expect(OPERATION_ID_PATTERN.test(name)).toBe(true);
    expect(() => newOperationId('a'.repeat(33), 'APPLICATION_CREATE', MS, '0a1b2c3d')).toThrow(/over the 74/);
  });

  test('two operations in the same millisecond differ by their suffix', () => {
    expect(newOperationId('my-app', 'APPLICATION_UPDATE', MS, '0a1b2c3d'))
      .not.toBe(newOperationId('my-app', 'APPLICATION_UPDATE', MS, '0a1b2c3e'));
  });

  test('refuses a malformed suffix, clock, record id or event', () => {
    expect(() => newOperationId('my-app', 'APPLICATION_UPDATE', MS, '0A1B2C3D')).toThrow(/suffix/);
    expect(() => newOperationId('my-app', 'APPLICATION_UPDATE', MS, '0a1b2c3')).toThrow(/suffix/);
    expect(() => newOperationId('my-app', 'APPLICATION_UPDATE', -1, '0a1b2c3d')).toThrow(/nowMs/);
    expect(() => newOperationId('my-app', 'APPLICATION_UPDATE', 1.5, '0a1b2c3d')).toThrow(/nowMs/);
    expect(() => newOperationId('', 'APPLICATION_UPDATE', MS, '0a1b2c3d')).toThrow(/record id/);
    expect(() => newOperationId('my app', 'APPLICATION_UPDATE', MS, '0a1b2c3d')).toThrow(/record id/);
    expect(() => newOperationId('c1', 'CELL_UPDATE' as never, MS, '0a1b2c3d')).toThrow(/Not a record event/);
  });
});

describe('recordCommit (R-50): names only, decided at validation', () => {
  test('a create commits nothing, a delete deletes', () => {
    expect(recordCommit('TENANT_CREATE')).toEqual({ action: 'NONE', set: [], remove: [] });
    expect(recordCommit('ACCOUNT_DELETE')).toEqual({ action: 'DELETE', set: [], remove: [] });
  });

  test('a tenant update sets what it staged and removes a dropped description', () => {
    expect(recordCommit('TENANT_UPDATE', { name: 'n', description: 'd' }))
      .toEqual({ action: 'UPDATE', set: ['name', 'description'], remove: [] });
    expect(recordCommit('TENANT_UPDATE', { name: 'n' }))
      .toEqual({ action: 'UPDATE', set: ['name'], remove: ['description'] });
  });

  test('an account made shared removes applicationIds; externalId is never named', () => {
    expect(recordCommit('ACCOUNT_UPDATE', { maxCells: 3 }))
      .toEqual({ action: 'UPDATE', set: ['maxCells'], remove: ['applicationIds'] });
    const commit = recordCommit('ACCOUNT_UPDATE', { maxCells: 3, applicationIds: ['a'], externalId: 'x' } as never);
    expect(commit).toEqual({ action: 'UPDATE', set: ['maxCells', 'applicationIds'], remove: [] });
  });

  test('an application update keeps an absent list and removes nothing', () => {
    const staged = {
      source: { type: 'GITHUB' as const, location: 'https://example/v2.git' },
      cellScripts: { create: 'c', update: 'u', delete: 'd' },
      tenantScripts: { create: 'c', update: 'u', delete: 'd' },
      maxTenants: 2,
      placementStrategy: 'FILL' as const,
    };
    expect(recordCommit('APPLICATION_UPDATE', staged)).toEqual({
      action: 'UPDATE',
      set: ['source', 'cellScripts', 'tenantScripts', 'maxTenants', 'placementStrategy'],
      remove: [],
    });
    expect(recordCommit('APPLICATION_UPDATE', { ...staged, hooks: [] }).set).toContain('hooks');
  });

  test('an update needs pending; a create or delete takes none', () => {
    expect(() => recordCommit('TENANT_UPDATE')).toThrow(/needs the staged/);
    expect(() => recordCommit('TENANT_DELETE', { name: 'n' })).toThrow(/takes no pending/);
  });
});

describe('record hook environment (R-42)', () => {
  test('an application event: APPLICATION_ID and the common variables', () => {
    expect(recordEventEnvironment({
      event: 'APPLICATION_UPDATE',
      subject: { recordType: 'APPLICATION', applicationId: 'my-app' },
      operatorId: 'op-1',
      operationId: 'my-app-application-update-1763460000000-0a1b2c3d',
    })).toEqual({
      EVENT: 'APPLICATION_UPDATE',
      OPERATOR_ID: 'op-1',
      EXECUTION_ID: 'my-app-application-update-1763460000000-0a1b2c3d',
      APPLICATION_ID: 'my-app',
    });
  });

  test('a tenant event: TENANT_ID and TENANT_NAME, no APPLICATION_ID', () => {
    const env = recordEventEnvironment({
      event: 'TENANT_CREATE',
      subject: { recordType: 'TENANT', tenantId: '01T', tenantName: 'acme' },
      operatorId: 'op-1',
      operationId: 'op',
    });
    expect(env).toEqual({ EVENT: 'TENANT_CREATE', OPERATOR_ID: 'op-1', EXECUTION_ID: 'op', TENANT_ID: '01T', TENANT_NAME: 'acme' });
  });

  test('an account event: id, owner and the admitted ids joined by comma, empty when shared', () => {
    const base = { event: 'ACCOUNT_UPDATE' as const, operatorId: 'op-1', operationId: 'op' };
    expect(recordEventEnvironment({
      ...base,
      subject: { recordType: 'ACCOUNT', accountId: '111111111111', owner: 'TENANT', applicationIds: ['b-app', 'a-app'] },
    })).toMatchObject({ ACCOUNT_ID: '111111111111', ACCOUNT_OWNER: 'TENANT', ACCOUNT_APPLICATION_IDS: 'b-app,a-app' });
    expect(recordEventEnvironment({
      ...base,
      subject: { recordType: 'ACCOUNT', accountId: '111111111111', owner: 'VENDOR' },
    }).ACCOUNT_APPLICATION_IDS).toBe('');
  });

  test('refuses an event of another record type', () => {
    expect(() => recordEventEnvironment({
      event: 'ACCOUNT_CREATE',
      subject: { recordType: 'TENANT', tenantId: '01T', tenantName: 'acme' },
      operatorId: 'op-1',
      operationId: 'op',
    })).toThrow(/not an event of a tenant/);
  });

  test('a hook build adds the per-hook variables, SCRIPT_OUTPUTS {} on POST only, and nothing forbidden', () => {
    const env = recordEventEnvironment({
      event: 'ACCOUNT_CREATE',
      subject: { recordType: 'ACCOUNT', accountId: '111111111111', owner: 'VENDOR' },
      operatorId: 'op-1',
      operationId: 'op',
    });
    const pre = recordHookEnvironment(env, hook(), 'PRE', 1);
    expect(pre).toMatchObject({ PHASE: 'PRE', HOOK_ID: 'gate', HOOK_SCOPE: 'GLOBAL', HOOK_SCRIPT: 'hooks/gate.sh', ATTEMPT: '1' });
    expect(pre).not.toHaveProperty('SCRIPT_OUTPUTS');
    const post = recordHookEnvironment(env, hook(), 'POST', 3);
    expect(post.SCRIPT_OUTPUTS).toBe('{}');
    expect(post.ATTEMPT).toBe('3');
    for (const name of Object.keys(post)) {
      expect(HOOK_FORBIDDEN_ENV_VARS as readonly string[]).not.toContain(name);
      expect(name.startsWith(HOOK_PARAM_ENV_PREFIX)).toBe(false);
      expect(name).not.toMatch(/EXTERNAL|CELL_ID|ADMIN/);
    }
  });

  test('a tenant or account event runs no application hook; an application event does', () => {
    const tenantEnv = recordEventEnvironment({
      event: 'TENANT_DELETE',
      subject: { recordType: 'TENANT', tenantId: '01T', tenantName: 'acme' },
      operatorId: 'op-1',
      operationId: 'op',
    });
    expect(() => recordHookEnvironment(tenantEnv, hook({ scope: 'APPLICATION', revision: 0 }), 'PRE', 1)).toThrow(/global hooks only/);
    const appEnv = recordEventEnvironment({
      event: 'APPLICATION_DELETE',
      subject: { recordType: 'APPLICATION', applicationId: 'my-app' },
      operatorId: 'op-1',
      operationId: 'op',
    });
    expect(recordHookEnvironment(appEnv, hook({ scope: 'APPLICATION', revision: 0 }), 'PRE', 1).HOOK_SCOPE).toBe('APPLICATION');
    expect(() => recordHookEnvironment({ EVENT: 'CELL_CREATE' }, hook(), 'PRE', 1)).toThrow(/record EVENT/);
  });
});

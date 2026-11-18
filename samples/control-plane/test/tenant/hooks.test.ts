// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  HookEvent as ModelHookEvent,
  HookPhase as ModelHookPhase,
  SourceType as ModelSourceType,
  ValidationException,
} from '../../src/smithy/source/typescript-ssdk-codegen/src';
import { HookDataModel, hookCounterKey, hookKey, listHooksQuery, readLastGlobalHooks, replaceHookUpdate } from '../../src/tenant/hook.data-model';
import { GlobalHookRecord, HookDefinition, HookEvent, HOOK_EVENTS, HOOK_PHASES, HOOK_SOURCE_TYPES } from '../../src/tenant/hook.types';
import {
  hookPinningWarning,
  resolveHooks,
  validateApplicationDefinition,
  validateApplicationHooks,
  validateHookDefinition,
} from '../../src/tenant/hooks';

const SHA = '4f0c9e1b2a3d4c5e6f708192a3b4c5d6e7f80912';

function hook(overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    hookId: 'a-hook',
    events: ['DEPLOYMENT_CREATE'],
    phase: 'PRE',
    source: { type: 'GITHUB', location: 'https://github.com/acme/hooks.git', sourceVersion: SHA },
    script: 'hooks/run.sh',
    timeoutMinutes: 10,
    ...overrides,
  };
}

function globalHook(overrides: Partial<GlobalHookRecord> = {}): GlobalHookRecord {
  return {
    ...hook(),
    revision: 3,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

describe('the model and the contract agree member for member', () => {
  test.each([
    ['HookEvent', HOOK_EVENTS, ModelHookEvent],
    ['HookPhase', HOOK_PHASES, ModelHookPhase],
    ['SourceType', HOOK_SOURCE_TYPES, ModelSourceType],
  ])('%s', (_name, contract, model) => {
    expect([...contract].sort()).toEqual(Object.values(model).sort());
  });
});

describe('validateHookDefinition (R-39)', () => {
  const refused = (input: Record<string, unknown>) => () => validateHookDefinition({ ...hook(), ...input } as never, 'Hook a-hook');

  test('accepts a definition and stores the timeout resolved', () => {
    const { timeoutMinutes: _omitted, ...withoutTimeout } = hook();
    expect(validateHookDefinition(withoutTimeout, 'Hook a-hook').timeoutMinutes).toBe(10);
    expect(validateHookDefinition(hook({ timeoutMinutes: 30 }), 'Hook a-hook').timeoutMinutes).toBe(30);
  });

  test.each([
    ['a malformed id', { hookId: 'Bad_Id' }],
    ['an empty event list', { events: [] }],
    ['an unknown event', { events: ['TENANT_RENAME'] }],
    ['a repeated event', { events: ['CELL_CREATE', 'CELL_CREATE'] }],
    ['an unknown phase', { phase: 'DURING' }],
    ['an unknown source type', { source: { type: 'CODEPIPELINE', location: 'x' } }],
    ['a location with userinfo', { source: { type: 'GITHUB', location: 'https://user:token@github.com/a/b.git' } }],
    ['a location with a control character', { source: { type: 'GITHUB', location: 'https://github.com/a\n/b' } }],
    ['a location over 1,024 characters', { source: { type: 'GITHUB', location: `h${'x'.repeat(1024)}` } }],
    ['a source version with a quote', { source: { type: 'GITHUB', location: 'x', sourceVersion: 'a"b' } }],
    ['an empty source version', { source: { type: 'GITHUB', location: 'x', sourceVersion: '' } }],
    ['a source version over 128 characters', { source: { type: 'GITHUB', location: 'x', sourceVersion: 'v'.repeat(129) } }],
    ['a script path with a space', { script: 'hooks/a b.sh' }],
    ['a script path over 256 characters', { script: 's'.repeat(257) }],
    ['a timeout of 4', { timeoutMinutes: 4 }],
    ['a timeout of 31', { timeoutMinutes: 31 }],
    ['a fractional timeout', { timeoutMinutes: 10.5 }],
  ])('refuses %s with a ValidationException', (_name, input) => {
    expect(refused(input)).toThrow(ValidationException);
  });

  test('a message names the hook and field but never echoes a location', () => {
    const secret = 'https://user:s3cr3t-token@github.com/a/b.git';
    try {
      refused({ source: { type: 'GITHUB', location: secret } })();
      throw new Error('should have refused');
    } catch (error) {
      expect((error as ValidationException).message).toContain('Hook a-hook');
      expect((error as ValidationException).message).toContain('source.location');
      expect((error as ValidationException).message).not.toContain('s3cr3t');
    }
  });

  test('admits the characters of a ref pin, a SemVer + and an S3 location', () => {
    expect(() => validateHookDefinition(hook({ source: { type: 'GITHUB', location: 'https://github.com/a/b.git', sourceVersion: 'refs/tags/v1.2.3+build.5^{abc}' } }), 'Hook x')).not.toThrow();
    expect(() => validateHookDefinition(hook({ source: { type: 'S3', location: 'my-bucket/hooks/v1.zip' } }), 'Hook x')).not.toThrow();
  });
});

describe('validateApplicationHooks (R-39)', () => {
  test('absent stays absent (kept); [] is an empty list (clears)', () => {
    expect(validateApplicationHooks(undefined, 'app')).toBeUndefined();
    expect(validateApplicationHooks([], 'app')).toEqual([]);
  });

  test('refuses more than five hooks and a repeated hookId', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((hookId) => hook({ hookId }));
    expect(() => validateApplicationHooks(six, 'app')).toThrow(ValidationException);
    expect(() => validateApplicationHooks(six.slice(0, 5), 'app')).not.toThrow();
    expect(() => validateApplicationHooks([hook(), hook()], 'app')).toThrow(/appears more than once/);
  });

  test('every entry is validated and stored resolved', () => {
    const { timeoutMinutes: _omitted, ...bare } = hook();
    expect(validateApplicationHooks([bare], 'app')).toEqual([hook()]);
    expect(() => validateApplicationHooks([hook({ phase: 'NEVER' as never })], 'app')).toThrow(ValidationException);
  });

  test('refuses an application hook on a TENANT_* or ACCOUNT_* event; application events are allowed (R-39, ADR-045)', () => {
    for (const event of ['TENANT_CREATE', 'TENANT_UPDATE', 'TENANT_DELETE', 'ACCOUNT_CREATE', 'ACCOUNT_UPDATE', 'ACCOUNT_DELETE'] as const) {
      expect(() => validateApplicationHooks([hook({ events: ['CELL_CREATE', event] })], 'app'))
        .toThrow(new RegExp(`Application app, hook a-hook: an application hook may not name ${event}`));
    }
    const appEvents = hook({ events: ['APPLICATION_CREATE', 'APPLICATION_UPDATE', 'APPLICATION_DELETE'] });
    expect(validateApplicationHooks([appEvents], 'app')).toEqual([appEvents]);
  });

  test('a global hook may name any of the fifteen events (R-39)', () => {
    expect(HOOK_EVENTS).toHaveLength(15);
    expect(validateHookDefinition(hook({ events: [...HOOK_EVENTS] }), 'Hook a-hook').events).toEqual(HOOK_EVENTS);
  });
});

describe('validateApplicationDefinition: the application source and script charsets (§4.1, ADR-044)', () => {
  const scripts = {
    cellScripts: { create: 'c/create.sh', update: 'c/update.sh', delete: 'c/delete.sh' },
    tenantScripts: { create: 't/create.sh', update: 't/update.sh', delete: 't/delete.sh' },
  };
  const source = { location: 'https://github.com/acme/app.git', sourceVersion: SHA };

  test('accepts a conforming definition', () => {
    expect(() => validateApplicationDefinition('app', source, scripts)).not.toThrow();
  });

  test.each([
    ['userinfo in the location', { ...source, location: 'https://u:p@github.com/a/b.git' }, scripts],
    ['a control character in the location', { ...source, location: 'https://github.com/a\u0000b' }, scripts],
    ['a location over 2,048 characters', { ...source, location: `h${'x'.repeat(2048)}` }, scripts],
    ['a space in the source version', { ...source, sourceVersion: 'main branch' }, scripts],
    ['a source version over 256 characters', { ...source, sourceVersion: 'v'.repeat(257) }, scripts],
    ['a space in a cell script path', source, { ...scripts, cellScripts: { ...scripts.cellScripts, update: 'c/up date.sh' } }],
    ['a quote in a tenant script path', source, { ...scripts, tenantScripts: { ...scripts.tenantScripts, delete: 't/"x".sh' } }],
    ['a tenant script path over 1,024 characters', source, { ...scripts, tenantScripts: { ...scripts.tenantScripts, create: 'p'.repeat(1025) } }],
  ])('refuses %s', (_name, src, paths) => {
    expect(() => validateApplicationDefinition('app', src, paths)).toThrow(ValidationException);
  });
});

describe('hookPinningWarning (ADR-020)', () => {
  test('a full commit SHA is silent; a branch, a tag and no ref warn and name the hook', () => {
    expect(hookPinningWarning(hook())).toBeUndefined();
    for (const sourceVersion of ['main', 'v1.0.0', undefined]) {
      const warning = hookPinningWarning(hook({ source: { type: 'GITHUB', location: 'https://github.com/a/b.git', sourceVersion } }));
      expect(warning).toContain('hook a-hook');
    }
  });
});

describe('resolveHooks (R-40, R-45)', () => {
  const event: HookEvent = 'DEPLOYMENT_CREATE';

  test('pre: global then application; post: application then global; each in ascending hookId', () => {
    const globals = [
      globalHook({ hookId: 'g-b', phase: 'PRE', revision: 2 }),
      globalHook({ hookId: 'g-a', phase: 'PRE', revision: 7 }),
      globalHook({ hookId: 'g-y', phase: 'POST' }),
      globalHook({ hookId: 'g-x', phase: 'POST' }),
    ];
    const apps = [
      hook({ hookId: 'a-2', phase: 'PRE' }),
      hook({ hookId: 'a-1', phase: 'PRE' }),
      hook({ hookId: 'a-9', phase: 'POST' }),
      hook({ hookId: 'a-8', phase: 'POST' }),
    ];
    const resolved = resolveHooks(event, apps, globals);
    expect(resolved.event).toBe(event);
    expect(resolved.pre.map((h) => `${h.scope}/${h.hookId}`)).toEqual(['GLOBAL/g-a', 'GLOBAL/g-b', 'APPLICATION/a-1', 'APPLICATION/a-2']);
    expect(resolved.post.map((h) => `${h.scope}/${h.hookId}`)).toEqual(['APPLICATION/a-8', 'APPLICATION/a-9', 'GLOBAL/g-x', 'GLOBAL/g-y']);
  });

  test('byte order, not locale order', () => {
    const resolved = resolveHooks(event, [], [globalHook({ hookId: 'a-b' }), globalHook({ hookId: 'a1' }), globalHook({ hookId: 'a-a' })]);
    expect(resolved.pre.map((h) => h.hookId)).toEqual(['a-a', 'a-b', 'a1']);
  });

  test('only hooks that name the event are resolved', () => {
    const resolved = resolveHooks(
      'CELL_DELETE',
      [hook({ hookId: 'a-1', events: ['CELL_DELETE', 'DEPLOYMENT_DELETE'] }), hook({ hookId: 'a-2', events: ['DEPLOYMENT_DELETE'] })],
      [globalHook({ hookId: 'g-1', events: ['CELL_CREATE'] }), globalHook({ hookId: 'g-2', events: ['CELL_DELETE'] })],
    );
    expect(resolved.pre.map((h) => h.hookId)).toEqual(['g-2', 'a-1']);
  });

  test('each resolved hook is flat and fully populated: revision from the read, 0 for an application hook, "" for no ref', () => {
    const noRef = { type: 'S3' as const, location: 'bucket/key.zip' };
    const resolved = resolveHooks(event, [hook({ hookId: 'a-1', source: noRef, timeoutMinutes: 25 })], [globalHook({ hookId: 'g-1', revision: 4 })]);
    expect(resolved.pre).toEqual([
      {
        hookId: 'g-1',
        scope: 'GLOBAL',
        revision: 4,
        sourceType: 'GITHUB',
        sourceLocation: 'https://github.com/acme/hooks.git',
        sourceVersion: SHA,
        script: 'hooks/run.sh',
        timeoutMinutes: 10,
      },
      {
        hookId: 'a-1',
        scope: 'APPLICATION',
        revision: 0,
        sourceType: 'S3',
        sourceLocation: 'bucket/key.zip',
        sourceVersion: '',
        script: 'hooks/run.sh',
        timeoutMinutes: 25,
      },
    ]);
  });

  test('a cell stamped before hooks existed, and no global hook, resolve to empty lists', () => {
    expect(resolveHooks('CELL_UPDATE', undefined, [])).toEqual({ event: 'CELL_UPDATE', pre: [], post: [] });
  });

  test('a resolved definition stays under 1,600 bytes at the field caps (§8.1)', () => {
    const big = hook({
      hookId: 'h'.repeat(32),
      source: { type: 'GITHUB_ENTERPRISE', location: `h${'x'.repeat(1023)}`, sourceVersion: 'v'.repeat(128) },
      script: 's'.repeat(256),
      timeoutMinutes: 30,
    });
    const [resolved] = resolveHooks(event, [big], []).pre;
    expect(JSON.stringify(resolved).length).toBeLessThan(1600);
  });
});

describe('hook storage (§4.8)', () => {
  test('keys: PK=HOOK, SK=HOOK#<id> for a hook, SK=META for the counter', () => {
    expect(hookKey('g')).toEqual({ PK: 'HOOK', SK: 'HOOK#g' });
    expect(hookCounterKey()).toEqual({ PK: 'HOOK', SK: 'META' });
  });

  test('the list query is pinned to the static HOOK partition, strongly consistent, and leaves the counter out (R-10, R-40)', () => {
    expect(listHooksQuery()).toEqual({ partitionKey: 'HOOK', sortKeyPrefix: 'HOOK#', consistentRead: true });
  });

  test('the item carries no index attributes and round-trips', () => {
    const model = new HookDataModel();
    const item = model.toItem(globalHook());
    expect(item).toMatchObject({ PK: 'HOOK', SK: 'HOOK#a-hook', revision: 3 });
    expect(Object.keys(item).filter((key) => key.startsWith('GSI'))).toEqual([]);
    expect(model.fromItem(item)).toEqual(globalHook());
  });

  test('a replace is one update: revision + 1, no createdAt, no counter', () => {
    const update = replaceHookUpdate(hook(), '2026-02-01T00:00:00.000Z');
    expect(update.updateExpression).toContain('#revision = #revision + :one');
    expect(JSON.stringify(update)).not.toContain('createdAt');
    expect(JSON.stringify(update)).not.toContain('hookCount');
    expect(update.conditionExpression).toBeUndefined(); // updateExisting adds attribute_exists(PK)
  });

  test('lastGlobalHooks reads the workflow\'s maps; an empty string is an absent field, an absent attribute is []', () => {
    expect(readLastGlobalHooks(undefined)).toEqual([]);
    expect(
      readLastGlobalHooks([
        { hookId: 'g-1', phase: 'PRE', revision: 2, sourceVersion: 'main', resolvedSourceVersion: SHA },
        { hookId: 'g-2', phase: 'POST', revision: 1, sourceVersion: '', resolvedSourceVersion: '' },
      ]),
    ).toEqual([
      { hookId: 'g-1', phase: 'PRE', revision: 2, sourceVersion: 'main', resolvedSourceVersion: SHA },
      { hookId: 'g-2', phase: 'POST', revision: 1 },
    ]);
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { HookExecutionInput, ResolvedHook } from '../../src/tenant/hook.types';
import {
  RecordEvent,
  RecordEventInput,
  RecordEventSubject,
  RecordEventWorkflowInput,
  RecordPending,
  recordCommit,
  recordEventEnvironment,
  recordHookEnvironment,
} from '../../src/tenant/record-event.types';
import { ProvisioningWorkflow } from '../../src/tenant/tenant.sfn';
import { simulate, SimulationResult, TaskCall } from '../asl-simulator';

const FLEET = 'control-plane';
const START = Date.UTC(2026, 10, 18, 9, 0, 0);
const MINUTE = 60_000;
const OP = 'my-app-application-update-1763460000000-0a1b2c3d';
const OTHER_OP = 'my-app-application-update-1763460009999-ffffffff';

function synth(): { template: Template; definition: Record<string, any> } {
  const stack = new Stack();
  const table = new dynamodb.Table(stack, 'Table', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
  const role = (id: string) => new iam.Role(stack, id, { assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com') });
  new ProvisioningWorkflow(stack, 'Provisioning', { table, fleetName: FLEET, globalHookRole: role('GlobalHook'), appHookRole: role('AppHook'), concurrentBuildLimit: 5 });
  const template = Template.fromStack(stack);
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0] as any;
  const text = (machine.Properties.DefinitionString['Fn::Join'][1] as unknown[])
    .map((part) => (typeof part === 'string' ? part : 'INTRINSIC')).join('');
  return { template, definition: JSON.parse(text) };
}

const { template, definition } = synth();
const states: Record<string, any> = definition.States;

// ---------------------------------------------------------------------------
// A small DynamoDB: the expressions the record states send, evaluated as DynamoDB does
// ---------------------------------------------------------------------------

type Item = Record<string, any>;

class FakeTable {
  readonly items = new Map<string, Item>();
  readonly writes: TaskCall[] = [];
  /** Throws this error on the next call to the named state, after applying the call when `afterApply` (a lost response). */
  failures: Array<{ state: string; error: { Error: string; Cause?: string }; afterApply?: boolean; times?: number }> = [];

  put(item: Item): void {
    this.items.set(`${item.PK}|${item.SK}`, structuredClone(item));
  }

  get(pk: string, sk = 'META'): Item | undefined {
    return this.items.get(`${pk}|${sk}`);
  }

  handle(call: TaskCall): any {
    this.writes.push(call);
    const failure = this.failures.find((f) => f.state === call.state && (f.times ?? 1) > 0);
    if (failure !== undefined && failure.afterApply !== true) {
      failure.times = (failure.times ?? 1) - 1;
      throw failure.error;
    }
    const result = this.apply(call);
    if (failure !== undefined) {
      failure.times = (failure.times ?? 1) - 1;
      throw failure.error;
    }
    return result;
  }

  private apply(call: TaskCall): any {
    const args = call.args;
    const names: Record<string, string> = args.ExpressionAttributeNames ?? {};
    const values: Record<string, any> = Object.fromEntries(
      Object.entries(args.ExpressionAttributeValues ?? {}).map(([k, v]) => [k, unmarshall({ v: v as any }).v]),
    );
    const text = `${args.UpdateExpression ?? ''} ${args.ConditionExpression ?? ''}`;
    // DynamoDB refuses a name or a value the expressions do not use, and a placeholder that is not defined.
    for (const name of Object.keys(names)) {
      if (!new RegExp(`${name}\\b`).test(text)) {
        throw { Error: 'DynamoDB.ValidationException', Cause: `unused name ${name}` };
      }
    }
    for (const value of Object.keys(values)) {
      if (!new RegExp(`${value}\\b`).test(text)) {
        throw { Error: 'DynamoDB.ValidationException', Cause: `unused value ${value}` };
      }
    }
    for (const [placeholder] of text.matchAll(/[#:][A-Za-z0-9_]+/g)) {
      if (!(placeholder in names) && !(placeholder in values)) {
        throw { Error: 'DynamoDB.ValidationException', Cause: `undefined ${placeholder}` };
      }
    }
    const key = `${args.Key.PK.S}|${args.Key.SK.S}`;
    const item = this.items.get(key);
    const path = (token: string) => token.trim().split('.').map((p) => (p.startsWith('#') ? names[p] : p));
    const read = (target: Item | undefined, p: string[]) => p.reduce<any>((node, k) => (node === undefined ? undefined : node[k]), target);
    if (args.ConditionExpression !== undefined) {
      const holds = (args.ConditionExpression as string).split(' AND ').every((clause) => {
        const exists = /^attribute_(not_)?exists\((.+)\)$/.exec(clause.trim());
        if (exists !== null) {
          const present = read(item, path(exists[2])) !== undefined;
          return exists[1] === undefined ? present : !present;
        }
        const [left, right] = clause.split(' = ');
        return item !== undefined && read(item, path(left)) === values[right.trim()];
      });
      if (!holds) {
        throw { Error: 'DynamoDB.ConditionalCheckFailedException', Cause: 'The conditional request failed' };
      }
    }
    if (call.resource.endsWith(':deleteItem')) {
      this.items.delete(key);
      return {};
    }
    const next = structuredClone(item ?? { PK: args.Key.PK.S, SK: args.Key.SK.S });
    const expression: string = args.UpdateExpression;
    const set = /SET (.*?)(?= REMOVE |$)/.exec(expression)?.[1];
    const remove = /REMOVE (.*)$/.exec(expression)?.[1];
    for (const assignment of set === undefined ? [] : set.split(', ')) {
      const [left, right] = assignment.split(' = ');
      const value = right.trim().startsWith(':') ? values[right.trim()] : read(next, path(right));
      if (value === undefined) {
        throw { Error: 'DynamoDB.ValidationException', Cause: `the document path ${right} is invalid for update` };
      }
      next[path(left)[0]] = structuredClone(value);
    }
    for (const field of remove === undefined ? [] : remove.split(', ')) {
      delete next[path(field)[0]];
    }
    this.items.set(key, next);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Inputs, hooks and the scripted hook builds
// ---------------------------------------------------------------------------

const hook = (hookId: string, scope: 'GLOBAL' | 'APPLICATION', over: Partial<ResolvedHook> = {}): ResolvedHook => ({
  hookId,
  scope,
  revision: scope === 'GLOBAL' ? 2 : 0,
  sourceType: 'GITHUB',
  sourceLocation: 'https://github.com/o/hooks',
  sourceVersion: 'main',
  script: `hooks/${hookId}.sh`,
  timeoutMinutes: 10,
  ...over,
});

const KEYS = { APPLICATION: 'APPLICATION#my-app', TENANT: 'TENANT#01J00000000000000000000000', ACCOUNT: 'ACCOUNT#111111111111' } as const;
const SUBJECTS: Record<keyof typeof KEYS, RecordEventSubject> = {
  APPLICATION: { recordType: 'APPLICATION', applicationId: 'my-app' },
  TENANT: { recordType: 'TENANT', tenantId: '01J00000000000000000000000', tenantName: 'Acme' },
  ACCOUNT: { recordType: 'ACCOUNT', accountId: '111111111111', owner: 'TENANT', applicationIds: ['my-app', 'other'] },
};

function recordInput(event: RecordEvent, pre: ResolvedHook[] = [], post: ResolvedHook[] = [], pending?: RecordPending): RecordEventWorkflowInput {
  const recordType = event.split('_')[0] as keyof typeof KEYS;
  const subject = SUBJECTS[recordType];
  const hooks: HookExecutionInput = { event, pre, post };
  const input: RecordEventInput = {
    event,
    recordType,
    recordId: KEYS[recordType].split('#')[1],
    key: { PK: KEYS[recordType], SK: 'META' },
    operationId: OP,
    hooks,
    environment: recordEventEnvironment({ event, subject, operatorId: 'operator-1', operationId: OP }),
    commit: recordCommit(event, pending),
  };
  return { recordEvent: input };
}

interface Builds {
  starts: TaskCall[];
  metrics: TaskCall[];
}

/** The hook builds end 60 s after their start: `fail(hookId, attempt)` says which fail. */
function service(
  table: FakeTable,
  fail: (hookId: string, attempt: number) => boolean = () => false,
): { handler: (call: TaskCall) => any; builds: Builds } {
  const builds: Builds = { starts: [], metrics: [] };
  const started = new Map<string, { at: number; failed: boolean }>();
  const handler = (call: TaskCall) => {
    if (call.resource.includes(':dynamodb:')) {
      return table.handle(call);
    }
    if (call.resource.endsWith(':startBuild')) {
      builds.starts.push(call);
      const env = envOf(call);
      const id = `build-${started.size + 1}`;
      started.set(id, { at: call.at, failed: fail(env.HOOK_ID, Number(env.ATTEMPT)) });
      return { Build: { Id: id } };
    }
    if (call.resource.endsWith(':batchGetBuilds')) {
      const id: string = call.args.Ids[0];
      const build = started.get(id)!;
      const status = call.at - build.at < 60_000 ? 'IN_PROGRESS' : build.failed ? 'FAILED' : 'SUCCEEDED';
      return { Builds: [{ Id: id, BuildStatus: status, ResolvedSourceVersion: 'a'.repeat(40), Phases: [] }] };
    }
    if (call.resource.endsWith(':putMetricData')) {
      builds.metrics.push(call);
      return {};
    }
    throw new Error(`Unexpected ${call.resource}`);
  };
  return { handler, builds };
}

const envOf = (call: TaskCall): Record<string, string> =>
  Object.fromEntries((call.args.EnvironmentVariablesOverride as any[]).map((v) => [v.Name, v.Value]));

const STOP_AT = ['RecordEventDone', 'RecordSuperseded', 'CellBuildRequested'];

function run(input: any, handler: (call: TaskCall) => any, extra: Partial<Parameters<typeof simulate>[0]> = {}): Promise<SimulationResult> {
  return simulate({
    definition: definition as any,
    start: definition.StartAt,
    stopAt: STOP_AT,
    input,
    handler,
    startTime: START,
    executionName: OP,
    ...extra,
  });
}

const dynamoCalls = (result: SimulationResult) => result.calls.filter((c) => c.resource.includes(':dynamodb:')).map((c) => c.state);
const startedHooks = (builds: Builds) => builds.starts.map((c) => `${envOf(c).PHASE}:${envOf(c).HOOK_ID}`);

const application = (over: Item = {}): Item => ({
  PK: KEYS.APPLICATION,
  SK: 'META',
  maxTenants: 5,
  source: { type: 'GITHUB', location: 'https://github.com/o/old' },
  cellCount: 0,
  ...over,
});
const APPLICATION_PENDING = {
  source: { type: 'GITHUB', location: 'https://github.com/o/new' },
  cellScripts: { create: 'c.sh', update: 'u.sh', delete: 'd.sh' },
  tenantScripts: { create: 'c.sh', update: 'u.sh', delete: 'd.sh' },
  maxTenants: 9,
  placementStrategy: 'FILL',
} as unknown as RecordPending;

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------
describe('the record event branch of the workflow (R-50, ADR-045)', () => {
  test('the workflow starts at the record router; an input without recordEvent goes on to the cell and deployment states', async () => {
    expect(definition.StartAt).toBe('RecordEventRequested');
    expect(states.RecordEventRequested.Choices[0].Next).toBe('RecordPreHooks');
    expect(states.RecordEventRequested.Default).toBe('CellBuildRequested');
    const result = await run({ applicationId: 'a', cellId: 'c', cellBuild: { operation: 'update' } }, () => {
      throw new Error('no call');
    });
    expect(result.stoppedAt).toBe('CellBuildRequested');
  });

  test('every record state is JSONata, every write retries as R-22 and goes to RecordSuperseded on a lost condition', () => {
    const writes = ['CommitRecordUpdate', 'ProbeRecordCommitted', 'CommitRecordDelete', 'ProbeRecordDeleted', 'SetRecordActive', 'FailRecord'];
    for (const name of [...writes, 'RecordEventRequested', 'RecordCommit', 'RecordSucceeded', 'RecordPreHooks', 'RecordPostHooks']) {
      expect(states[name].QueryLanguage).toBe('JSONata');
    }
    for (const name of writes) {
      expect(states[name].Resource).toMatch(/^arn:aws:states:::dynamodb:(updateItem|deleteItem)$/);
      // The update commit hands its allowlist error to the Catch list at once, ahead of R-22's retriers.
      const retry = name === 'CommitRecordUpdate' ? states[name].Retry.slice(1) : states[name].Retry;
      expect(retry).toEqual([
        { ErrorEquals: ['DynamoDB.ConditionalCheckFailedException', 'DynamoDb.ConditionalCheckFailedException'], MaxAttempts: 0 },
        // ADR-0049: inert on these single-item writes, which raise no TransactionCanceledException.
        { ErrorEquals: ['DynamoDb.TransactionCanceledException'], IntervalSeconds: 1, BackoffRate: 2, MaxAttempts: 5, JitterStrategy: 'FULL' },
        { ErrorEquals: ['States.ALL'], IntervalSeconds: 2, BackoffRate: 2, MaxAttempts: 6 },
      ]);
      // Every write but the absence probe, which can only pass on a missing item, is conditioned on this operation.
      if (name !== 'ProbeRecordDeleted') {
        expect(states[name].Arguments).toContain('$states.input.recordEvent.operationId');
      }
    }
    expect(states.CommitRecordUpdate.Retry[0]).toEqual({ ErrorEquals: ['States.QueryEvaluationError'], MaxAttempts: 0 });
    expect(states.CommitRecordUpdate.Catch[0]).toMatchObject({ ErrorEquals: ['States.QueryEvaluationError'], Next: 'FailRecord' });
    for (const [name, next] of [['SetRecordActive', 'RecordSuperseded'], ['FailRecord', 'RecordFailWriteLost']]) {
      expect(states[name].Catch[0]).toMatchObject({
        ErrorEquals: ['DynamoDB.ConditionalCheckFailedException', 'DynamoDb.ConditionalCheckFailedException'],
        Next: next,
      });
    }
    // A lost failure write is superseded on create and update; on a delete the POST hooks still run (P-9).
    expect(states.RecordFailWriteLost.Choices).toHaveLength(1);
    expect(states.RecordFailWriteLost.Choices[0].Next).toBe('RecordPostHooks');
    expect(states.RecordFailWriteLost.Default).toBe('RecordSuperseded');
    // The failure write has no other Catch: exhausting it is the residual of §7.4.
    expect(states.FailRecord.Catch).toHaveLength(1);
    expect(states.SetRecordActive.Catch[1]).toMatchObject({ ErrorEquals: ['States.ALL'], Next: 'FailRecord' });
    expect(states.RecordSuperseded.Type).toBe('Succeed');
    // The commit names fields only: the expression text holds placeholders, never a pending value.
    expect(states.CommitRecordUpdate.Arguments).not.toMatch(/pending\.(source|name|maxCells)/);
  });

  test('the workflow role gets no new action: the base-table item grant covers the commit, the probes and the terminal writes', () => {
    const statements = (Object.values(template.findResources('AWS::IAM::Policy')) as any[])
      .flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
    const dynamo = statements.filter((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]).some((a: string) => a.startsWith('dynamodb:')));
    const explicit = dynamo.find((s) => JSON.stringify(s.Action) === JSON.stringify(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']));
    expect(explicit.Resource['Fn::GetAtt'][1]).toBe('Arn');
    expect(explicit.Condition).toBeUndefined();
    const actions = new Set(dynamo.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])));
    for (const action of ['dynamodb:PutItem', 'dynamodb:ConditionCheckItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchWriteItem']) {
      expect(actions.has(action)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The paths
// ---------------------------------------------------------------------------
describe('record events in the simulator (R-50, R-49, R-22)', () => {
  test('no hooks: a create writes ACTIVE with an empty lastGlobalHooks and commits nothing, in a few transitions', async () => {
    const table = new FakeTable();
    table.put({ PK: KEYS.TENANT, SK: 'META', status: 'CREATING', operationId: OP, name: 'Acme', deploymentCount: 0 });
    const { handler } = service(table);
    const result = await run(recordInput('TENANT_CREATE'), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(dynamoCalls(result)).toEqual(['SetRecordActive']);
    expect(table.get(KEYS.TENANT)).toMatchObject({ status: 'ACTIVE', operationId: OP, lastGlobalHooks: [], name: 'Acme' });
    // eslint-disable-next-line no-console
    console.log(`history events of a record create with no hook: ${result.historyEvents}`);
    expect(result.historyEvents).toBeLessThan(60);
  });

  test('an update commits pending into the named fields, removes pending, and leaves every other field alone', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'UPDATING', operationId: OP, pending: APPLICATION_PENDING, cellCount: 3, updatedAt: 'then' }));
    const { handler } = service(table);
    const result = await run(recordInput('APPLICATION_UPDATE', [], [], APPLICATION_PENDING), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(dynamoCalls(result)).toEqual(['CommitRecordUpdate', 'SetRecordActive']);
    const commit = result.calls.find((c) => c.state === 'CommitRecordUpdate')!;
    expect(commit.args.UpdateExpression).toBe('SET #s0 = #pending.#s0, #s1 = #pending.#s1, #s2 = #pending.#s2, #s3 = #pending.#s3, #s4 = #pending.#s4 REMOVE #pending');
    expect(commit.args.ConditionExpression).toBe('#status = :updating AND #op = :op AND attribute_exists(#pending)');
    expect(JSON.stringify(commit.args)).not.toContain('github.com/o/new');
    const item = table.get(KEYS.APPLICATION)!;
    expect(item).toMatchObject({ status: 'ACTIVE', maxTenants: 9, source: { location: 'https://github.com/o/new' }, placementStrategy: 'FILL', cellCount: 3 });
    expect(item.pending).toBeUndefined();
  });

  test('a tenant update whose description was dropped removes it; an account made shared removes applicationIds', async () => {
    const table = new FakeTable();
    table.put({ PK: KEYS.TENANT, SK: 'META', status: 'UPDATING', operationId: OP, name: 'Old', description: 'd', pending: { name: 'New' } });
    const tenant = await run(recordInput('TENANT_UPDATE', [], [], { name: 'New' } as RecordPending), service(table).handler);
    expect(tenant.stoppedAt).toBe('RecordEventDone');
    expect(table.get(KEYS.TENANT)).toEqual(expect.objectContaining({ name: 'New', status: 'ACTIVE' }));
    expect(table.get(KEYS.TENANT)!.description).toBeUndefined();

    table.put({ PK: KEYS.ACCOUNT, SK: 'META', status: 'UPDATING', operationId: OP, maxCells: 2, applicationIds: ['a'], externalId: 'x', pending: { maxCells: 4 } });
    await run(recordInput('ACCOUNT_UPDATE', [], [], { maxCells: 4 } as RecordPending), service(table).handler);
    expect(table.get(KEYS.ACCOUNT)).toEqual(expect.objectContaining({ maxCells: 4, externalId: 'x', status: 'ACTIVE' }));
    expect(table.get(KEYS.ACCOUNT)!.applicationIds).toBeUndefined();
  });

  test('a commit replay: the commit landed but its answer was lost, the repeat fails its condition, the probe proves it, POST hooks run', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'UPDATING', operationId: OP, pending: APPLICATION_PENDING }));
    table.failures = [{ state: 'CommitRecordUpdate', error: { Error: 'DynamoDB.InternalServerErrorException' }, afterApply: true }];
    const { handler, builds } = service(table);
    const result = await run(recordInput('APPLICATION_UPDATE', [], [hook('notify', 'GLOBAL')], APPLICATION_PENDING), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(dynamoCalls(result)).toEqual(['CommitRecordUpdate', 'CommitRecordUpdate', 'ProbeRecordCommitted', 'SetRecordActive']);
    expect(startedHooks(builds)).toEqual(['POST:notify']);
    expect(table.get(KEYS.APPLICATION)).toMatchObject({ status: 'ACTIVE', maxTenants: 9 });
    // The probe changes nothing: REMOVE of an absent pending.
    expect(result.calls.find((c) => c.state === 'ProbeRecordCommitted')!.args.UpdateExpression).toBe('REMOVE #pending');
  });

  test('a PRE hook failure on an update: UPDATE_FAILED naming the hook, pending removed, old values live, no commit, no POST hook', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'UPDATING', operationId: OP, pending: APPLICATION_PENDING }));
    const { handler, builds } = service(table, (id) => id === 'gate');
    const result = await run(recordInput('APPLICATION_UPDATE', [hook('gate', 'GLOBAL'), hook('later', 'APPLICATION')], [hook('notify', 'GLOBAL')], APPLICATION_PENDING), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(startedHooks(builds)).toEqual(['PRE:gate']);
    expect(dynamoCalls(result)).toEqual(['FailRecord']);
    const item = table.get(KEYS.APPLICATION)!;
    expect(item).toMatchObject({ status: 'UPDATE_FAILED', maxTenants: 5, operationId: OP });
    expect(item.pending).toBeUndefined();
    expect(item.statusReason).toMatch(/^Hook failed: global hook gate \(APPLICATION_UPDATE PRE\), build build-1: build ended with status FAILED$/);
    expect(item.lastGlobalHooks.map((h: any) => h.hookId)).toEqual(['gate']);
  });

  test('a PRE hook failure on a create: CREATE_FAILED, nothing committed', async () => {
    const table = new FakeTable();
    table.put({ PK: KEYS.ACCOUNT, SK: 'META', status: 'CREATING', operationId: OP, maxCells: 2, cellCount: 0 });
    const { handler } = service(table, () => true);
    const result = await run(recordInput('ACCOUNT_CREATE', [hook('gate', 'GLOBAL')]), handler);
    expect(dynamoCalls(result)).toEqual(['FailRecord']);
    expect(table.get(KEYS.ACCOUNT)).toMatchObject({ status: 'CREATE_FAILED', statusReason: expect.stringContaining('ACCOUNT_CREATE PRE') });
  });

  test('a POST hook failure on an update: UPDATE_FAILED after the commit, with the new values live', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'UPDATING', operationId: OP, pending: APPLICATION_PENDING }));
    const { handler, builds } = service(table, (id) => id === 'app-post');
    const result = await run(recordInput('APPLICATION_UPDATE', [hook('g-pre', 'GLOBAL')], [hook('app-post', 'APPLICATION'), hook('g-post', 'GLOBAL')], APPLICATION_PENDING), handler);
    expect(startedHooks(builds)).toEqual(['PRE:g-pre', 'POST:app-post']);
    expect(dynamoCalls(result)).toEqual(['CommitRecordUpdate', 'FailRecord']);
    expect(table.get(KEYS.APPLICATION)).toMatchObject({ status: 'UPDATE_FAILED', maxTenants: 9, statusReason: expect.stringContaining('application hook app-post (APPLICATION_UPDATE POST)') });
  });

  test('a delete: PRE hooks, the conditional delete, POST hooks, no terminal write', async () => {
    const table = new FakeTable();
    table.put({ PK: KEYS.TENANT, SK: 'META', status: 'DELETING', operationId: OP, name: 'Acme', deploymentCount: 0 });
    const { handler, builds } = service(table);
    const result = await run(recordInput('TENANT_DELETE', [hook('pre', 'GLOBAL')], [hook('post', 'GLOBAL')]), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(startedHooks(builds)).toEqual(['PRE:pre', 'POST:post']);
    expect(dynamoCalls(result)).toEqual(['CommitRecordDelete']);
    const commit = result.calls.find((c) => c.state === 'CommitRecordDelete')!;
    expect(commit.args.ConditionExpression).toBe('#status = :deleting AND #op = :op AND #count = :zero');
    expect(commit.args.ExpressionAttributeNames['#count']).toBe('deploymentCount');
    expect(builds.starts[1].at).toBeGreaterThan(commit.at);
    expect(table.get(KEYS.TENANT)).toBeUndefined();
  });

  test('a delete hook that fails three times is skipped and counted, and the delete still commits (P-9)', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'DELETING', operationId: OP }));
    const { handler, builds } = service(table, (id) => id === 'flaky');
    const result = await run(recordInput('APPLICATION_DELETE', [hook('flaky', 'GLOBAL'), hook('app', 'APPLICATION')]), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(startedHooks(builds)).toEqual(['PRE:flaky', 'PRE:flaky', 'PRE:flaky', 'PRE:app']);
    expect(builds.metrics).toHaveLength(1);
    expect(result.variables.SKIP_LOG.skippedHook).toMatchObject({ hookId: 'flaky', event: 'APPLICATION_DELETE', record: { recordType: 'APPLICATION', recordId: 'my-app' } });
    expect(dynamoCalls(result)).toEqual(['CommitRecordDelete']);
    expect(table.get(KEYS.APPLICATION)).toBeUndefined();
  });

  test('a delete replay: the record is gone, the absence probe proves the earlier delete, POST hooks run', async () => {
    const table = new FakeTable();
    const { handler, builds } = service(table);
    const result = await run(recordInput('ACCOUNT_DELETE', [], [hook('post', 'GLOBAL')]), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(dynamoCalls(result)).toEqual(['CommitRecordDelete', 'ProbeRecordDeleted']);
    expect(startedHooks(builds)).toEqual(['POST:post']);
  });

  test('a delete whose count is no longer 0 ends DELETE_FAILED (R-49), with no POST hook', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'DELETING', operationId: OP, cellCount: 1 }));
    const { handler, builds } = service(table);
    const result = await run(recordInput('APPLICATION_DELETE', [], [hook('post', 'GLOBAL')]), handler);
    expect(dynamoCalls(result)).toEqual(['CommitRecordDelete', 'ProbeRecordDeleted', 'FailRecord']);
    expect(builds.starts).toHaveLength(0);
    expect(table.get(KEYS.APPLICATION)).toMatchObject({
      status: 'DELETE_FAILED',
      statusReason: 'Record delete failed: DynamoDB.ConditionalCheckFailedException',
      cellCount: 1,
    });
  });

  test('a success write that exhausts its retries goes through the conditional failure write (R-22)', async () => {
    const table = new FakeTable();
    table.put({ PK: KEYS.TENANT, SK: 'META', status: 'CREATING', operationId: OP, name: 'Acme', deploymentCount: 0 });
    table.failures = [{ state: 'SetRecordActive', error: { Error: 'DynamoDB.ProvisionedThroughputExceededException' }, times: 7 }];
    const result = await run(recordInput('TENANT_CREATE'), service(table).handler);
    expect(dynamoCalls(result)).toEqual([...Array(7).fill('SetRecordActive'), 'FailRecord']);
    expect(table.get(KEYS.TENANT)).toMatchObject({ status: 'CREATE_FAILED', statusReason: 'Record terminal write failed: DynamoDB.ProvisionedThroughputExceededException' });
  });

  test('a commit naming a field outside the commit fields raises and fails the update: pending never reaches status', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'UPDATING', operationId: OP, pending: { status: 'ACTIVE', maxTenants: 9 } }));
    const input = recordInput('APPLICATION_UPDATE', [], [], APPLICATION_PENDING) as any;
    input.recordEvent.commit = { action: 'UPDATE', set: ['status', 'maxTenants'], remove: [] };
    const result = await run(input, service(table).handler);
    // No commit call, no R-22 retry, no probe: the error goes straight to the failure write.
    expect(result.trace.filter((s) => s === 'CommitRecordUpdate')).toHaveLength(1);
    expect(dynamoCalls(result)).toEqual(['FailRecord']);
    expect(result.elapsedMs).toBeLessThan(2_000);
    expect(table.get(KEYS.APPLICATION)).toMatchObject({
      status: 'UPDATE_FAILED',
      maxTenants: 5,
      statusReason: 'Record commit failed: the commit names a field outside the commit-field allowlist of the record type',
    });
    expect(table.get(KEYS.APPLICATION)!.pending).toBeUndefined();
  });

  test('the simulator retries an Arguments error under a States.ALL retrier, so the test above proves the exclusion', async () => {
    const result = await simulate({
      definition: {
        States: {
          Raise: {
            Type: 'Task',
            Resource: 'arn:aws:states:::dynamodb:updateItem',
            Arguments: "{% $error('boom') %}",
            Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 2, BackoffRate: 2, MaxAttempts: 6 }],
            Catch: [{ ErrorEquals: ['States.ALL'], Next: 'End' }],
          },
        },
      },
      start: 'Raise',
      stopAt: ['End'],
      input: {},
      handler: () => {
        throw new Error('no call');
      },
    });
    expect(result.stoppedAt).toBe('End');
    expect(result.output.Error).toBe('States.QueryEvaluationError');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(126_000);
  });

  test('a delete whose commit landed but whose probe ran out of retries: FailRecord finds no record, the POST hooks still run (P-9)', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'DELETING', operationId: OP }));
    table.failures = [
      { state: 'CommitRecordDelete', error: { Error: 'DynamoDB.InternalServerErrorException' }, afterApply: true },
      { state: 'ProbeRecordDeleted', error: { Error: 'DynamoDB.ProvisionedThroughputExceededException' }, times: 7 },
    ];
    const { handler, builds } = service(table);
    const result = await run(recordInput('APPLICATION_DELETE', [], [hook('post', 'GLOBAL')]), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(dynamoCalls(result)).toEqual(['CommitRecordDelete', 'CommitRecordDelete', ...Array(7).fill('ProbeRecordDeleted'), 'FailRecord']);
    expect(result.trace).toContain('RecordFailWriteLost');
    expect(startedHooks(builds)).toEqual(['POST:post']);
    expect(table.get(KEYS.APPLICATION)).toBeUndefined();
  });
});

describe('superseded: a write that loses its condition to another operation ends the execution, no write or hook after it, except a delete\'s POST hooks (R-50)', () => {
  test('create: the success write finds another operationId', async () => {
    const table = new FakeTable();
    table.put({ PK: KEYS.TENANT, SK: 'META', status: 'CREATING', operationId: OTHER_OP, name: 'Acme' });
    const before = structuredClone(table.get(KEYS.TENANT));
    const result = await run(recordInput('TENANT_CREATE', [], [hook('post', 'GLOBAL')]), service(table).handler);
    expect(result.stoppedAt).toBe('RecordSuperseded');
    expect(dynamoCalls(result)).toEqual(['SetRecordActive']);
    expect(table.get(KEYS.TENANT)).toEqual(before);
  });

  test('create: a compensation moved the status to CREATE_FAILED', async () => {
    const table = new FakeTable();
    table.put({ PK: KEYS.TENANT, SK: 'META', status: 'CREATE_FAILED', operationId: OP, name: 'Acme', statusReason: 'start unknown' });
    const result = await run(recordInput('TENANT_CREATE'), service(table).handler);
    expect(result.stoppedAt).toBe('RecordSuperseded');
    expect(table.get(KEYS.TENANT)).toMatchObject({ status: 'CREATE_FAILED', statusReason: 'start unknown' });
  });

  test('update: the commit, its probe and the failure write all fail on another operationId; no POST hook runs', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'UPDATING', operationId: OTHER_OP, pending: { maxTenants: 1 } }));
    const { handler, builds } = service(table);
    const result = await run(recordInput('APPLICATION_UPDATE', [hook('pre', 'GLOBAL')], [hook('post', 'GLOBAL')], APPLICATION_PENDING), handler);
    expect(result.stoppedAt).toBe('RecordSuperseded');
    expect(dynamoCalls(result)).toEqual(['CommitRecordUpdate', 'ProbeRecordCommitted', 'FailRecord']);
    expect(startedHooks(builds)).toEqual(['PRE:pre']);
    expect(table.get(KEYS.APPLICATION)).toMatchObject({ status: 'UPDATING', operationId: OTHER_OP, pending: { maxTenants: 1 }, maxTenants: 5 });
  });

  test('update: the record is gone', async () => {
    const table = new FakeTable();
    const result = await run(recordInput('TENANT_UPDATE', [], [hook('post', 'GLOBAL')], { name: 'n' } as RecordPending), service(table).handler);
    expect(result.stoppedAt).toBe('RecordSuperseded');
    expect(table.items.size).toBe(0);
  });

  test('update: a PRE hook failure whose failure write finds UPDATE_FAILED from a compensation', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'UPDATE_FAILED', operationId: OP, statusReason: 'start refused' }));
    const result = await run(recordInput('APPLICATION_UPDATE', [hook('gate', 'GLOBAL')], [], APPLICATION_PENDING), service(table, () => true).handler);
    expect(result.stoppedAt).toBe('RecordSuperseded');
    expect(dynamoCalls(result)).toEqual(['FailRecord']);
    expect(table.get(KEYS.APPLICATION)).toMatchObject({ statusReason: 'start refused' });
  });

  test('update: the success write after the POST hooks finds a newer operation', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'UPDATING', operationId: OP, pending: APPLICATION_PENDING }));
    const handler = service(table).handler;
    const swap = (call: TaskCall) => {
      if (call.state === 'SetRecordActive') {
        table.put({ ...table.get(KEYS.APPLICATION)!, operationId: OTHER_OP });
      }
      return handler(call);
    };
    const result = await run(recordInput('APPLICATION_UPDATE', [], [], APPLICATION_PENDING), swap);
    expect(result.stoppedAt).toBe('RecordSuperseded');
    expect(table.get(KEYS.APPLICATION)).toMatchObject({ status: 'UPDATING', operationId: OTHER_OP });
  });

  test('delete: the record holds another operation: no delete, no DELETE_FAILED, but the POST hooks run (taken over, P-9)', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'DELETING', operationId: OTHER_OP }));
    const { handler, builds } = service(table);
    const result = await run(recordInput('APPLICATION_DELETE', [], [hook('post', 'GLOBAL')]), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(dynamoCalls(result)).toEqual(['CommitRecordDelete', 'ProbeRecordDeleted', 'FailRecord']);
    expect(startedHooks(builds)).toEqual(['POST:post']);
    expect(table.get(KEYS.APPLICATION)).toMatchObject({ status: 'DELETING', operationId: OTHER_OP });
  });

  test('delete: a compensation moved the record to DELETE_FAILED: the POST hooks run, nothing more is written', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'DELETE_FAILED', operationId: OP, statusReason: 'start unknown' }));
    const { handler, builds } = service(table);
    const result = await run(recordInput('APPLICATION_DELETE', [], [hook('post', 'GLOBAL')]), handler);
    expect(result.stoppedAt).toBe('RecordEventDone');
    expect(dynamoCalls(result)).toEqual(['CommitRecordDelete', 'ProbeRecordDeleted', 'FailRecord']);
    expect(startedHooks(builds)).toEqual(['POST:post']);
    expect(table.get(KEYS.APPLICATION)).toMatchObject({ status: 'DELETE_FAILED', statusReason: 'start unknown' });
  });
});

describe('hooks of a record event (R-42, R-50)', () => {
  test('an application event runs global then application PRE hooks and application then global POST hooks', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'CREATING', operationId: OP }));
    const { handler, builds } = service(table);
    await run(recordInput('APPLICATION_CREATE', [hook('g1', 'GLOBAL'), hook('a1', 'APPLICATION')], [hook('a2', 'APPLICATION'), hook('g2', 'GLOBAL')]), handler);
    expect(builds.starts.map((c) => [envOf(c).PHASE, envOf(c).HOOK_ID, c.args.ProjectName])).toEqual([
      ['PRE', 'g1', `${FLEET}-global-hook`],
      ['PRE', 'a1', `${FLEET}-app-hook`],
      ['POST', 'a2', `${FLEET}-app-hook`],
      ['POST', 'g2', `${FLEET}-global-hook`],
    ]);
    expect(table.get(KEYS.APPLICATION)!.lastGlobalHooks.map((h: any) => `${h.phase}:${h.hookId}`)).toEqual(['PRE:g1', 'POST:g2']);
  });

  test('a tenant or an account event never runs an application hook, even when the input holds one', async () => {
    for (const event of ['TENANT_CREATE', 'ACCOUNT_CREATE'] as const) {
      const table = new FakeTable();
      const type = event.split('_')[0] as 'TENANT' | 'ACCOUNT';
      table.put({ PK: KEYS[type], SK: 'META', status: 'CREATING', operationId: OP });
      const { handler, builds } = service(table);
      const result = await run(recordInput(event, [hook('app', 'APPLICATION'), hook('g', 'GLOBAL')], [hook('app2', 'APPLICATION')]), handler);
      expect(startedHooks(builds)).toEqual(['PRE:g']);
      expect(result.stoppedAt).toBe('RecordEventDone');
    }
  });

  test('each hook build gets exactly the environment recordHookEnvironment builds, SCRIPT_OUTPUTS {} on POST only', async () => {
    for (const event of ['APPLICATION_UPDATE', 'TENANT_CREATE', 'ACCOUNT_DELETE'] as const) {
      const table = new FakeTable();
      const type = event.split('_')[0] as keyof typeof KEYS;
      const status = event.endsWith('UPDATE') ? 'UPDATING' : event.endsWith('CREATE') ? 'CREATING' : 'DELETING';
      table.put({ PK: KEYS[type], SK: 'META', status, operationId: OP, cellCount: 0, pending: APPLICATION_PENDING });
      const { handler, builds } = service(table);
      const pre = hook('pre-hook', 'GLOBAL');
      const post = hook('post-hook', 'GLOBAL');
      const input = recordInput(event, [pre], [post], event === 'APPLICATION_UPDATE' ? APPLICATION_PENDING : undefined);
      await run(input, handler);
      expect(builds.starts).toHaveLength(2);
      expect(envOf(builds.starts[0])).toEqual(recordHookEnvironment(input.recordEvent.environment, pre, 'PRE', 1));
      expect(envOf(builds.starts[1])).toEqual(recordHookEnvironment(input.recordEvent.environment, post, 'POST', 1));
      expect(envOf(builds.starts[1]).SCRIPT_OUTPUTS).toBe('{}');
      expect(envOf(builds.starts[0]).EXECUTION_ID).toBe(OP);
      for (const call of builds.starts) {
        expect(Object.keys(envOf(call)).filter((k) => k.startsWith('PARAM_') || k === 'CELL_ID' || k === 'ADMIN_EMAIL')).toEqual([]);
      }
    }
  });
});

describe('budgets (§8.1, R-23)', () => {
  test('a record event input at the caps is under 25 KiB', () => {
    const big = (id: string, scope: 'GLOBAL' | 'APPLICATION') => hook(id.padEnd(32, 'x').slice(0, 32), scope, {
      sourceLocation: `https://github.com/${'o'.repeat(1000)}`.slice(0, 1024),
      sourceVersion: 'v'.repeat(128),
      script: `s/${'p'.repeat(254)}`,
      timeoutMinutes: 30,
      revision: 999999,
    });
    const pre = [...[1, 2, 3, 4, 5].map((n) => big(`g${n}`, 'GLOBAL')), ...[1, 2, 3, 4, 5].map((n) => big(`a${n}`, 'APPLICATION'))];
    const input = recordInput('APPLICATION_UPDATE', pre, [], APPLICATION_PENDING);
    const account = recordInput('ACCOUNT_UPDATE', pre.slice(0, 5), [], { maxCells: 1 } as RecordPending) as any;
    account.recordEvent.environment = { ...account.recordEvent.environment, ACCOUNT_APPLICATION_IDS: Array(100).fill('a'.repeat(32)).join(',') };
    for (const candidate of [input, account]) {
      const bytes = Buffer.byteLength(JSON.stringify(candidate));
      // eslint-disable-next-line no-console
      console.log(`record event input at the caps (${candidate.recordEvent.event}): ${bytes} bytes`);
      expect(bytes).toBeLessThan(25 * 1024);
    }
  });

  test('a record delete hook refused for its whole budget stays inside the history quota at ten hooks', async () => {
    const table = new FakeTable();
    table.put(application({ status: 'DELETING', operationId: OP }));
    const refusing = (call: TaskCall) => {
      if (call.resource.endsWith(':startBuild')) {
        throw { Error: 'CodeBuild.AccountLimitExceededException', Cause: 'cap' };
      }
      return service(table).handler(call);
    };
    const one = await run(recordInput('APPLICATION_DELETE', [hook('gate', 'GLOBAL', { timeoutMinutes: 30 })]), refusing, { maxSteps: 100000 });
    expect(one.stoppedAt).toBe('RecordEventDone');
    expect(one.elapsedMs / MINUTE).toBeLessThanOrEqual(145);
    const base = (await run(recordInput('APPLICATION_DELETE'), service(new FakeTable()).handler)).historyEvents;
    // eslint-disable-next-line no-console
    console.log(`record delete: ${one.historyEvents} events with one hook refused for 144 minutes; x10 hooks ~ ${(one.historyEvents - base) * 10 + base}`);
    expect((one.historyEvents - base) * 10 + base).toBeLessThan(25_000);
  });
});

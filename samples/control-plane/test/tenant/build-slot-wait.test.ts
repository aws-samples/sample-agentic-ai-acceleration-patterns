// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * ADR-0049: a script build's StartBuild refused at the concurrent build limit waits for a
 * free slot, and a terminal transaction cancelled by a concurrent one is retried. These
 * tests read the synthesized workflow's own ASL, and run the build tasks on the ASL
 * simulator against a scripted CodeBuild.
 */

import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  BUILD_SLOT_WAIT,
  ProvisioningWorkflow,
  TRANSACTION_CANCELED_RETRY,
  buildStartRefusedReason,
} from '../../src/tenant/tenant.sfn';
import { simulate, TaskCall } from '../asl-simulator';

function synth(): Record<string, any> {
  const stack = new Stack();
  const table = new dynamodb.Table(stack, 'Table', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
  const role = (id: string) => new iam.Role(stack, id, { assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com') });
  new ProvisioningWorkflow(stack, 'Provisioning', { table, fleetName: 'control-plane', globalHookRole: role('GlobalHook'), appHookRole: role('AppHook'), concurrentBuildLimit: 5 });
  const machine = Object.values(Template.fromStack(stack).findResources('AWS::StepFunctions::StateMachine'))[0] as any;
  const text = (machine.Properties.DefinitionString['Fn::Join'][1] as unknown[])
    .map((part) => (typeof part === 'string' ? part : 'INTRINSIC')).join('');
  return JSON.parse(text).States;
}

const states = synth();
const BUILD_STATES = ['RunTenantBuild', 'RunTenantBuildPinned', 'RunCellBuild', 'RunCellBuildPinned'];
const SLOT_RETRIER = {
  ErrorEquals: ['CodeBuild.AccountLimitExceededException'],
  IntervalSeconds: 30,
  BackoffRate: 1,
  MaxAttempts: 40,
  JitterStrategy: 'FULL',
};

describe('the build-slot wait (ADR-0049, issue #95)', () => {
  test.each(BUILD_STATES)('%s retries a refused start every 30 s with full jitter, 40 times, and nothing else', (name) => {
    expect(states[name].Resource).toBe('arn:aws:states:::codebuild:startBuild.sync');
    expect(states[name].Retry).toEqual([SLOT_RETRIER]);
    // The build budget stays on the task; Step Functions applies it to each attempt (R-23).
    expect(states[name].TimeoutSeconds).toBe(3600);
    // A refused start creates no build, so the retry sends no token (spec H-9).
    expect(JSON.stringify(states[name].Arguments)).not.toContain('IdempotencyToken');
    expect(states[name].Catch).toHaveLength(1);
    expect(states[name].Catch[0].ErrorEquals).toEqual(['States.ALL']);
  });

  test('the wait is about 10 minutes and at most 20, which the 26-hour execution timeout holds at the caps', () => {
    const most = BUILD_SLOT_WAIT.intervalSeconds * BUILD_SLOT_WAIT.maxAttempts;
    expect(most).toBe(1200);
    // Full jitter picks each wait from 0 to the interval: half of it on average.
    expect(most / 2).toBe(600);
    // R-23: a delete at the caps is 1,500 minutes of hooks and script plus one wait; a new-cell create waits twice.
    expect(1500 + most / 60).toBeLessThan(26 * 60);
    expect(2 * (530 + most / 60)).toBe(1100);
  });

  test.each([
    ['Tenant', 'FailTenantWithReason'],
    ['Cell', 'CellFailureHasTenantWithReason'],
  ])('a start still refused when the wait ends gets a reason naming the refusal (%s)', (prefix, writer) => {
    const shape = states[`${prefix}BuildFailureShape`];
    expect(shape.Choices[0]).toEqual({
      Variable: '$.error.Error',
      StringEquals: 'CodeBuild.AccountLimitExceededException',
      Next: `${prefix}BuildStartRefused`,
    });
    const pass = states[`${prefix}BuildStartRefused`];
    expect(pass).toMatchObject({ Type: 'Pass', ResultPath: '$.failureReason', Next: writer });
    expect(pass.Result).toBe(buildStartRefusedReason(prefix));
    expect(pass.Result).toBe(
      `${prefix} provisioning failed: the build never started, CodeBuild refused it at the concurrent build limit `
      + 'for 40 tries over at most 20 minutes (CodeBuild.AccountLimitExceededException)',
    );
  });

  test('the reason writes read $.failureReason, so the record names the refused start', () => {
    expect(JSON.stringify(states.FailTenantWithReason.Parameters)).toContain('"S.$":"$.failureReason"');
    const cellRouter = states.CellFailureHasTenantWithReason;
    for (const next of [cellRouter.Default, ...cellRouter.Choices.map((c: any) => c.Next)]) {
      expect(JSON.stringify(states[next].Parameters)).toContain('$.failureReason');
    }
  });

  // The build task, run against a CodeBuild that refuses the first `refusals` starts.
  const input = {
    applicationId: 'app-1',
    cellId: 'cell-1',
    tenantId: 'tenant-1',
    accountId: '111111111111',
    operatorId: 'op-1',
    sessionName: 'op-1',
    externalId: '',
    sourceType: 'GITHUB',
    sourceLocation: 'https://github.com/o/r',
    sourceVersion: 'abc',
    tenantRoleArn: 'arn:aws:iam::111111111111:role/t',
    cellRoleArn: 'arn:aws:iam::111111111111:role/c',
    tenantBuild: { operation: 'create', scriptPath: 'tenant.sh', tenantName: 'Acme', adminEmail: '', parameters: {} },
    cellBuild: { operation: 'create', scriptPath: 'cell.sh', parameters: {} },
  };
  const run = (start: string, refusals: number) => {
    const starts: TaskCall[] = [];
    return simulate({
      definition: { States: states },
      start,
      stopAt: ['TenantScriptOutputs', 'CellScriptOutputs', 'TenantBuildFailureShape', 'CellBuildFailureShape'],
      input,
      handler: (call) => {
        starts.push(call);
        if (starts.length <= refusals) {
          throw { Error: 'CodeBuild.AccountLimitExceededException', Cause: 'This build project has a limit of 5 concurrent build(s)' };
        }
        return { Build: { Arn: 'arn:aws:codebuild:b', BuildStatus: 'SUCCEEDED', ExportedEnvironmentVariables: [] } };
      },
    }).then((result) => ({ result, starts }));
  };

  test.each(BUILD_STATES)('%s: refused 39 times, the 40th retry starts the build and the script outputs are checked', async (name) => {
    const { result, starts } = await run(name, 40);
    expect(starts).toHaveLength(41);
    expect(result.stoppedAt).toBe(name.startsWith('RunTenant') ? 'TenantScriptOutputs' : 'CellScriptOutputs');
    // The simulator waits the full interval each time: the bound, never the average.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(40 * 30_000);
    // Every try is a fresh start of the same build.
    expect(new Set(starts.map((s) => JSON.stringify(s.args))).size).toBe(1);
  });

  test.each(BUILD_STATES)('%s: refused 41 times, the Catch hands the refusal to the failure shape', async (name) => {
    const { result, starts } = await run(name, 41);
    expect(starts).toHaveLength(41);
    expect(result.stoppedAt).toBe(name.startsWith('RunTenant') ? 'TenantBuildFailureShape' : 'CellBuildFailureShape');
    expect(result.output.error).toEqual({ Error: 'CodeBuild.AccountLimitExceededException' });
    expect(result.output.failure).toBeUndefined();
  });
});

describe('the terminal-write retry (ADR-0049, issue #96)', () => {
  const transactions = Object.entries(states)
    .filter(([, s]) => s.Resource === 'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems')
    .map(([n]) => n)
    .sort();

  test('the five terminal transactions are all found', () => {
    expect(transactions).toEqual([
      'DeleteDeploymentRecord',
      'FailCellAndTenant',
      'FailCellAndTenantWithBuild',
      'FailCellAndTenantWithReason',
      'RemoveCellRecord',
    ]);
  });

  const terminalRetry = [
    { ErrorEquals: ['DynamoDB.ConditionalCheckFailedException', 'DynamoDb.ConditionalCheckFailedException'], MaxAttempts: 0 },
    { ErrorEquals: ['DynamoDb.TransactionCanceledException'], IntervalSeconds: 1, BackoffRate: 2, MaxAttempts: 5, JitterStrategy: 'FULL' },
    { ErrorEquals: ['States.ALL'], IntervalSeconds: 2, BackoffRate: 2, MaxAttempts: 6 },
  ];

  test.each(transactions)('%s retries a cancellation 5 times with jitter, never a failed condition, then transient errors', (name) => {
    expect(states[name].Retry).toEqual(terminalRetry);
    // A stable token: a retry within DynamoDB's window replays rather than writes twice.
    expect(states[name].Parameters['ClientRequestToken.$']).toContain('$$.Execution.Id');
  });

  test('every other terminal write (the typed UpdateItem tasks) carries the same policy', () => {
    const typed = Object.entries(states)
      .filter(([, s]) => /:states:::dynamodb:updateItem$/.test(String(s.Resource)) && s.QueryLanguage !== 'JSONata')
      .map(([n]) => n);
    expect(typed.length).toBeGreaterThanOrEqual(10);
    for (const name of typed) {
      expect(states[name].Retry).toEqual(terminalRetry);
    }
  });

  test('the cancellation waits are bounded at 31 s', () => {
    const { intervalSeconds, backoffRate, maxAttempts } = TRANSACTION_CANCELED_RETRY;
    const waits = Array.from({ length: maxAttempts }, (_, i) => intervalSeconds * backoffRate ** i);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(31);
  });

  test('DeleteDeploymentRecord, cancelled by a conflict twice, commits on the third try with the same token', async () => {
    // The transaction state is JSONPath; run its Retry list on the simulator as a JSONata task with fixed arguments.
    const calls: TaskCall[] = [];
    const definition = {
      States: {
        Write: { ...states.DeleteDeploymentRecord, Parameters: undefined, Arguments: { token: 'stable' }, Next: 'Done', Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Read' }] },
      },
    };
    const result = await simulate({
      definition,
      start: 'Write',
      stopAt: ['Done', 'Read'],
      input: {},
      handler: (call) => {
        calls.push(call);
        if (calls.length <= 2) throw { Error: 'DynamoDb.TransactionCanceledException', Cause: 'Transaction cancelled [None, TransactionConflict, None]' };
        return {};
      },
    });
    expect(result.stoppedAt).toBe('Done');
    expect(calls.map((c) => c.args.token)).toEqual(['stable', 'stable', 'stable']);
  });

  test('a cancellation that persists (a failed condition) reaches the Catch after 6 tries', async () => {
    const calls: TaskCall[] = [];
    const definition = {
      States: {
        Write: { ...states.RemoveCellRecord, Parameters: undefined, Arguments: {}, Next: 'Done' },
      },
    };
    const result = await simulate({
      definition,
      start: 'Write',
      stopAt: ['Done', 'GetCellRecord'],
      input: {},
      handler: (call) => {
        calls.push(call);
        throw { Error: 'DynamoDb.TransactionCanceledException', Cause: 'Transaction cancelled [ConditionalCheckFailed, None, None]' };
      },
    });
    expect(result.stoppedAt).toBe('GetCellRecord');
    expect(calls).toHaveLength(6);
  });

  test('a record-event write that meets a transaction in flight is retried as transient and commits', async () => {
    const calls: TaskCall[] = [];
    const definition = { States: { Write: { ...states.CommitRecordDelete, Arguments: {} } } };
    const result = await simulate({
      definition,
      start: 'Write',
      stopAt: [states.CommitRecordDelete.Next, 'ProbeRecordDeleted'],
      input: {},
      handler: (call) => {
        calls.push(call);
        if (calls.length <= 2) throw { Error: 'DynamoDB.TransactionConflictException', Cause: 'conflict' };
        return {};
      },
    });
    expect(result.stoppedAt).toBe(states.CommitRecordDelete.Next);
    expect(calls).toHaveLength(3);
  });

  test('a failed condition on a typed write is never retried', async () => {
    const calls: TaskCall[] = [];
    const definition = { States: { Write: { ...states.SetTenantActiveAfterCreate, Parameters: undefined, Arguments: {} } } };
    const result = await simulate({
      definition,
      start: 'Write',
      stopAt: ['FailTenant'],
      input: {},
      handler: (call) => {
        calls.push(call);
        throw { Error: 'DynamoDB.ConditionalCheckFailedException', Cause: 'condition' };
      },
    });
    expect(result.stoppedAt).toBe('FailTenant');
    expect(calls).toHaveLength(1);
  });
});

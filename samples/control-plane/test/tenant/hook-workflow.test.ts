// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CellDataModel, CellItem } from '../../src/tenant/cell.data-model';
import { readLastGlobalHooks } from '../../src/tenant/hook.data-model';
import { GlobalHookRecord, HookDefinition, HookExecutionInput, ResolvedHook, SCRIPT_OUTPUT_GUARD_PATTERN } from '../../src/tenant/hook.types';
import { HOOK_BUILDSPEC } from '../../src/tenant/hook.workflow';
import { resolveHooks } from '../../src/tenant/hooks';
import { INLINE_BUILDSPECS, ProvisioningWorkflow } from '../../src/tenant/tenant.sfn';

// The two halves differ only in their session tag line (ADR-0051); the outputs guard is the same in both.
const INLINE_BUILDSPEC = INLINE_BUILDSPECS.tenant;
import { simulate, SimulationResult, TaskCall } from '../asl-simulator';
import { evaluateJsonata } from '../workflow-jsonata';

const FLEET = 'control-plane';

function synth(fleetName = FLEET): { template: Template; definition: Record<string, any>; stack: Stack } {
  const stack = new Stack();
  const table = new dynamodb.Table(stack, 'Table', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
  const role = (id: string) => new iam.Role(stack, id, { assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com') });
  new ProvisioningWorkflow(stack, 'Provisioning', {
    table,
    fleetName,
    globalHookRole: role('GlobalHook'),
    appHookRole: role('AppHook'),
    concurrentBuildLimit: 5,
  });
  const template = Template.fromStack(stack);
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0] as any;
  const text = (machine.Properties.DefinitionString['Fn::Join'][1] as unknown[])
    .map((part) => (typeof part === 'string' ? part : 'INTRINSIC')).join('');
  return { template, definition: JSON.parse(text), stack };
}

const { template, definition } = synth();
const states: Record<string, any> = definition.States;

/** Every state of the definition whose name the hook sub-graph owns, by type and name. */
const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 18, 9, 0, 0);

// ---------------------------------------------------------------------------
// The synthesized ASL (R-46, R-41, R-23)
// ---------------------------------------------------------------------------
describe('the workflow definition (R-41, R-46, R-23)', () => {
  test('the four projects and the workflow have their fleet-derived physical names, and the execution timeout is 26 hours', () => {
    const names = (Object.values(template.findResources('AWS::CodeBuild::Project')) as any[]).map((p) => p.Properties.Name).sort();
    expect(names).toEqual([`${FLEET}-app-hook`, `${FLEET}-cell-build`, `${FLEET}-global-hook`, `${FLEET}-tenant-build`]);
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineName: `${FLEET}-workflow` });
    expect(definition.TimeoutSeconds).toBe(26 * 3600);
    // Four projects, no state machine of another name: a second fleet's names differ.
    const other = synth('fleet-b').template;
    other.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineName: 'fleet-b-workflow' });
  });

  test('each hook project runs under the role of its scope and no hook project holds a role override', () => {
    const projects = Object.values(template.findResources('AWS::CodeBuild::Project')) as any[];
    const hookRoleOf = (name: string) => projects.find((p) => p.Properties.Name === name).Properties.ServiceRole['Fn::GetAtt'][0];
    expect(hookRoleOf(`${FLEET}-global-hook`)).not.toBe(hookRoleOf(`${FLEET}-app-hook`));
    expect(hookRoleOf(`${FLEET}-global-hook`)).toMatch(/GlobalHook/);
    expect(hookRoleOf(`${FLEET}-app-hook`)).toMatch(/AppHook/);
    for (const task of [states.StartHookBuild, states.StopHookBuild, states.PollHookBuild]) {
      expect(JSON.stringify(task.Arguments)).not.toMatch(/ServiceRole|RoleOverride/i);
    }
  });

  test('the build roles trust CodeBuild only on their own project (R-41, H-7)', () => {
    const roles = Object.values(template.findResources('AWS::IAM::Role')) as any[];
    for (const kind of ['cell', 'tenant']) {
      const role = roles.find((r) => r.Properties.RoleName === `${FLEET}-${kind}-build`);
      const statement = role.Properties.AssumeRolePolicyDocument.Statement[0];
      expect(statement.Principal.Service).toBe('codebuild.amazonaws.com');
      expect(JSON.stringify(statement.Condition.ArnEquals['aws:SourceArn'])).toContain(`project/${FLEET}-${kind}-build`);
    }
  });

  test('the workflow role starts, stops and polls hook builds, holds no iam:PassRole, and counts skips in its namespace', () => {
    const statements = (Object.values(template.findResources('AWS::IAM::Policy')) as any[])
      .flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
    const hook = statements.find((s) => s.Sid === 'RunHookBuilds');
    expect(hook.Action).toEqual(['codebuild:StartBuild', 'codebuild:StopBuild', 'codebuild:BatchGetBuilds']);
    expect(hook.Resource).toHaveLength(2);
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).not.toContain('iam:PassRole');
    const metric = statements.find((s) => s.Sid === 'CountSkippedHooks');
    expect(metric.Condition.StringEquals['cloudwatch:namespace']).toBe(`${FLEET}/hooks`);
    // Every PutMetricData grant of the stack is held to that one namespace.
    const putMetric = statements.filter((s) => ([] as string[]).concat(s.Action).includes('cloudwatch:PutMetricData'));
    expect(putMetric).toHaveLength(1);
    expect(putMetric[0].Condition).toEqual({ StringEquals: { 'cloudwatch:namespace': `${FLEET}/hooks` } });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: `${FLEET}/hooks`,
      MetricName: 'HookSkipped',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('the start task is request-response with the R-46 retriers and Catch list, in order', () => {
    const start = states.StartHookBuild;
    expect(start.Resource).toBe('arn:aws:states:::codebuild:startBuild');
    expect(start.TimeoutSeconds).toBe(15);
    expect(start.Retry).toEqual([
      { ErrorEquals: ['CodeBuild.AccountLimitExceededException', 'CodeBuild.InvalidInputException'], MaxAttempts: 0 },
      { ErrorEquals: ['States.ALL'], IntervalSeconds: 10, BackoffRate: 1, MaxAttempts: 3, JitterStrategy: 'NONE' },
    ]);
    expect(start.Catch.map((c: any) => c.ErrorEquals)).toEqual([
      ['CodeBuild.AccountLimitExceededException'],
      ['CodeBuild.InvalidInputException'],
      ['States.ALL'],
    ]);
    expect(start.Catch.map((c: any) => c.Next)).toEqual(['RefusalWait', 'AttemptEnded', 'AttemptEnded']);
    // The refusal Catch passes its input through and keeps the bounded error outside the payload.
    expect(start.Catch[0].Output).toBe('{% $states.input %}');
    expect(Object.keys(start.Catch[0].Assign)).toEqual(['LAST_REFUSAL']);
    expect(start.Catch[0].Assign.LAST_REFUSAL).toContain('$substring($string($states.errorOutput.Cause), 0, 256)');
    // The 30-second wait has no backoff, and the Choice advances TRY only on the way back.
    expect(states.RefusalWait).toMatchObject({ Type: 'Wait', Seconds: 30 });
    expect(states.RefusalWindow.Choices[1]).toMatchObject({ Next: 'BeginTry', Assign: { TRY: '{% $TRY + 1 %}' } });
    expect(states.RefusalWindow.Choices[0].Next).toBe('AttemptEnded');
  });

  test('the stop task has the same shape, ending in "not confirmed stopped"', () => {
    const stop = states.StopHookBuild;
    expect(stop.Resource).toBe('arn:aws:states:::codebuild:stopBuild');
    expect(stop.Retry).toEqual(states.StartHookBuild.Retry);
    expect(stop.Catch.map((c: any) => [c.ErrorEquals, c.Next])).toEqual([
      [['CodeBuild.AccountLimitExceededException'], 'StopRefusalWait'],
      [['CodeBuild.InvalidInputException'], 'StopNotConfirmed'],
      [['States.ALL'], 'StopNotConfirmed'],
    ]);
    expect(states.StopRefusalWait.Seconds).toBe(30);
  });

  test('the poll is the SDK integration batchGetBuilds for one id, with no Retry', () => {
    const poll = states.PollHookBuild;
    expect(poll.Resource).toBe('arn:aws:states:::aws-sdk:codebuild:batchGetBuilds');
    expect(poll.Arguments).toBe('{% {"Ids": [$BUILD_ID]} %}');
    expect(poll.Retry).toBeUndefined();
    expect(poll.Catch).toHaveLength(1);
    expect(poll.Catch[0]).toMatchObject({ ErrorEquals: ['States.ALL'], Next: 'PollRouter' });
    // Never the environment: the summary keeps the id, status, phase timing and resolvedSourceVersion.
    expect(poll.Assign.POLL).not.toContain('Environment');
    expect(poll.Assign.POLL).toContain('ResolvedSourceVersion');
  });

  test('the states on the way back to the start task pass their input through unchanged', () => {
    for (const name of ['BeginAttempt', 'BeginTry', 'RefusalWait']) {
      expect(states[name].Output).toBe('{% $states.input %}');
    }
    expect(states.RefusalWindow.Choices.map((c: any) => c.Output)).toEqual([undefined, undefined]);
    // Exactly one state writes TRY on each transition: the entry sets 1, the refusal rule increments.
    const writers = Object.entries(states).filter(([, s]) => s.Assign?.TRY !== undefined
      || (s.Choices ?? []).some((c: any) => c.Assign?.TRY !== undefined)).map(([n]) => n).sort();
    expect(writers).toEqual(['BeginAttempt', 'RefusalWindow']);
    // q and the token are assigned by the state after the one that sets TRY.
    expect(Object.keys(states.BeginTry.Assign).sort()).toEqual(['Q', 'TOKEN']);
  });

  test('the start Arguments read only variables and the state input: nothing that changes between evaluations (H-8)', () => {
    const args: string = states.StartHookBuild.Arguments;
    for (const forbidden of ['$uuid', '$now', '$millis', 'RetryCount', '$states.context', '$random']) {
      expect(args).not.toContain(forbidden);
    }
    // No role override, no ARN of a role.
    expect(args).not.toMatch(/Role/);
  });

  test('the hook buildspec runs the script and nothing else: no role, no external id, no interpolation (R-41, T44)', () => {
    const lines = HOOK_BUILDSPEC.split('\n');
    expect(lines.filter((l) => l.includes('$'))).toEqual(['      - bash "$HOOK_SCRIPT"']);
    expect(HOOK_BUILDSPEC).not.toMatch(/assume-role|sts |EXTERNAL|ROLE|\$\(|\$\{|`|eval/);
    expect(HOOK_BUILDSPEC).toContain('bash "$HOOK_SCRIPT"');
    // It is the buildspec the start task sends.
    expect(states.StartHookBuild.Arguments).toContain('bash \\"$HOOK_SCRIPT\\"');
  });

  test('around each script: pre hooks, the script, the outputs check, post hooks, the terminal write (R-45)', () => {
    expect(states.CellBuildRequested.Choices[0].Next).toBe('CellPreHooks');
    expect(states.TenantBuildRequested.Choices[0].Next).toBe('TenantPreHooks');
    const exits = Object.fromEntries(states.HookListContinue.Choices.map((c: any) => [c.Condition.match(/'(\w+)'/)[1], c.Next]));
    expect({ ...exits, tenantPost: states.HookListContinue.Default }).toEqual({
      cellPre: 'RunCellBuildSourcePin',
      cellPost: 'CellBuildSucceeded',
      tenantPre: 'RunTenantBuildSourcePin',
      tenantPost: 'TenantBuildSucceeded',
      recordPre: 'RecordCommit',
      recordPost: 'RecordSucceeded',
    });
    expect(states.RunCellBuild.Next).toBe('CellScriptOutputs');
    expect(states.CellScriptOutputs.Next).toBe('CellScriptChecked');
    expect(states.RunTenantBuild.Next).toBe('TenantScriptOutputs');
    expect(states.TenantScriptOutputs.Next).toBe('TenantScriptChecked');
    expect(states.CellScriptChecked.Default).toBe('CellPostHooks');
    expect(states.TenantScriptChecked.Default).toBe('TenantPostHooks');
    // A hook that fails a create or update goes to the failure write of its build; one new-cell create moves both records.
    expect(states.HookFailureTarget.Choices[0].Next).toBe('CellFailureHasTenantWithReason');
    expect(states.HookFailureTarget.Choices[1].Next).toBe('FailRecord');
    expect(states.HookFailureTarget.Default).toBe('FailTenantWithReason');
    expect(states.CellFailureHasTenantWithReason.Default).toBe('FailCellWithReason');
    expect(states.CellFailureHasTenantWithReason.Choices[0].Next).toBe('FailCellAndTenantWithReason');
    // The new cell's success write still leads on to the deployment event.
    expect(states.SetCellActiveAfterCreate.Next).toBe('TenantBuildRequested');
  });

  test('every terminal write that leaves the record in place sets lastGlobalHooks from the payload (R-40, §8.2)', () => {
    const writes = ['SetCellActiveAfterCreate', 'SetCellActiveAfterUpdate', 'SetTenantActiveAfterCreate', 'SetTenantActiveAfterUpdate',
      'FailCell', 'FailCellWithBuild', 'FailCellWithReason', 'FailCellDelete', 'FailTenant', 'FailTenantWithBuild', 'FailTenantWithReason', 'FailTenantDelete'];
    for (const name of writes) {
      const text = JSON.stringify(states[name]);
      expect(text).toContain('lastGlobalHooks = :lgh');
      expect(text).toContain('"L.$":"$.lastGlobalHooks"');
    }
    // The cell half of the paired transaction lists them; the deployment half's event never ran.
    for (const name of ['FailCellAndTenant', 'FailCellAndTenantWithBuild', 'FailCellAndTenantWithReason']) {
      const [cell, deployment] = states[name].Parameters.TransactItems;
      expect(cell.Update.UpdateExpression).toContain('lastGlobalHooks = :lgh');
      expect(deployment.Update.UpdateExpression).not.toContain('lastGlobalHooks');
    }
    // The deletes that remove the record write nothing of the kind.
    expect(JSON.stringify(states.DeleteDeploymentRecord)).not.toContain('lastGlobalHooks');
    expect(JSON.stringify(states.RemoveCellRecord)).not.toContain('lastGlobalHooks');
    // The reason of a hook failure or rejected outputs is the one built where it was seen.
    expect(JSON.stringify(states.FailCellWithReason)).toContain('"S.$":"$.failureReason"');
  });

  test('every hook state is JSONata, and no definition fragment reads as a CloudFormation substitution', () => {
    const text = JSON.stringify(definition);
    expect(text).not.toContain('${');
    for (const name of ['StartHookBuild', 'PollHookBuild', 'StopHookBuild', 'BeginTry', 'PollRouter']) {
      expect(states[name].QueryLanguage).toBe('JSONata');
    }
  });
});

// ---------------------------------------------------------------------------
// R-43: the buildspec and the guard
// ---------------------------------------------------------------------------
describe('script outputs (R-43)', () => {
  /** The part of the provisioning buildspec that runs after the script. */
  const afterScript = (() => {
    const lines = INLINE_BUILDSPEC.split('\n');
    const from = lines.findIndex((l) => l.trim() === "SCRIPT_OUTPUTS='{}'");
    const to = lines.findIndex((l) => l.trim() === 'export SCRIPT_OUTPUTS');
    return lines.slice(from, to + 1).map((l) => l.replace(/^ {8}/, '')).join('\n');
  })();

  function runCheck(content: string | undefined, operation: 'create' | 'delete', link = false): { status: number; outputs: string } {
    const dir = mkdtempSync(join(tmpdir(), 'outputs-'));
    const file = join(dir, 'outputs.json');
    if (link) {
      writeFileSync(join(dir, 'target.json'), '{"a":"1"}');
      symlinkSync(join(dir, 'target.json'), file);
    } else if (content !== undefined) {
      writeFileSync(file, content);
    }
    const run = spawnSync('bash', ['-c', `set -euo pipefail\n${afterScript}\nprintf %s "$SCRIPT_OUTPUTS"`], {
      env: { PATH: process.env.PATH ?? '', OPERATION: operation, OUTPUTS_FILE: file },
      encoding: 'utf8',
    });
    // The buildspec logs a dropped file; the export is the last line.
    return { status: run.status ?? -1, outputs: run.stdout.split('\n').slice(-1)[0] };
  }

  test('the buildspec exports SCRIPT_OUTPUTS alone, from a fresh directory, before and after the script', () => {
    expect(INLINE_BUILDSPEC).toContain('  exported-variables:\n    - SCRIPT_OUTPUTS\n');
    expect(INLINE_BUILDSPEC.match(/exported-variables/g)).toHaveLength(1);
    expect(INLINE_BUILDSPEC).toContain('OUTPUTS_DIR=$(mktemp -d)');
    expect(INLINE_BUILDSPEC).toContain('OUTPUTS_FILE="$OUTPUTS_DIR/outputs.json"');
    expect(INLINE_BUILDSPEC.indexOf('export OUTPUTS_FILE')).toBeLessThan(INLINE_BUILDSPEC.indexOf('bash "$SCRIPT_PATH"'));
    expect(INLINE_BUILDSPEC.indexOf('bash "$SCRIPT_PATH"')).toBeLessThan(INLINE_BUILDSPEC.indexOf("SCRIPT_OUTPUTS='{}'"));
    expect(INLINE_BUILDSPEC).not.toContain('${');
    // The script is a child process; its environment is not the parent's (a child cannot change OUTPUTS_FILE here).
    expect(INLINE_BUILDSPEC).toMatch(/^ {8}bash "\$SCRIPT_PATH"$/m);
  });

  test('no file exports {} and a valid file exports its own compact re-serialisation', () => {
    expect(runCheck(undefined, 'create')).toEqual({ status: 0, outputs: '{}' });
    expect(runCheck('{"endpoint": "a"}\n', 'create')).toEqual({ status: 0, outputs: '{"endpoint":"a"}' });
    expect(runCheck('{ "a" : "x y" ,\n "b":"q" }', 'create').outputs).toBe('{"a":"x y","b":"q"}');
    // `"` and `\` are the only escapes of the compact form.
    expect(runCheck(String.raw`{"k":"a\"b\\c"}`, 'create').outputs).toBe(String.raw`{"k":"a\"b\\c"}`);
    expect(runCheck(String.raw`{"k":"a\/b"}`, 'create').outputs).toBe('{"k":"a/b"}');
    expect(runCheck(String.raw`{"k":"\u0041"}`, 'create').outputs).toBe('{"k":"A"}');
  });

  test.each([
    ['a repeated key', '{"a":"1","a":"2"}'],
    ['a non-string value', '{"a":1}'],
    ['a nested value', '{"a":{"b":"1"}}'],
    ['an array', '["a"]'],
    ['invalid JSON', '{"a":'],
    ['a key that starts with a digit', '{"1a":"x"}'],
    ['a key of 65 characters', `{"${'k'.repeat(65)}":"x"}`],
    ['a tab in a value', String.raw`{"a":"x\ty"}`],
    ['a newline in a value (the end anchor is the end of the string)', String.raw`{"a":"x\ny"}`],
    ['a DEL', String.raw`{"a":"x\u007fy"}`],
    ['a non-ASCII value', '{"a":"caf\u00e9"}'],
    ['4,097 bytes in compact form', `{"a":"${'x'.repeat(4097 - 8)}"}`],
  ])('%s fails a create and is dropped on a delete', (_name, content) => {
    expect(runCheck(content, 'create').status).not.toBe(0);
    expect(runCheck(content, 'delete')).toEqual({ status: 0, outputs: '{}' });
  });

  test('the largest valid value, 4,096 bytes, passes; a symbolic link does not', () => {
    const largest = `{"a":"${'x'.repeat(4096 - 8)}"}`;
    expect(largest).toHaveLength(4096);
    expect(runCheck(largest, 'create').outputs).toBe(largest);
    expect(runCheck(undefined, 'create', true).status).not.toBe(0);
    expect(runCheck(undefined, 'delete', true).outputs).toBe('{}');
  });

  describe('the guard in the state after the script task', () => {
    const guardState = (task: string) => {
      const check = states[task.startsWith('RunCell') ? 'CellScriptOutputs' : 'TenantScriptOutputs'];
      const branch = check.Branches[0];
      return branch.States[branch.StartAt];
    };
    // The task's Output, then the guard Pass's Output, then the Parallel's Output.
    const afterBuild = async (task: string, operation: string, exported: unknown[]) => {
      const taskOutput = await evaluateJsonata(states[task].Output, {
        input: { cellBuild: { operation }, tenantBuild: { operation } },
        result: { Build: { Arn: 'arn:b', BuildStatus: 'SUCCEEDED', ExportedEnvironmentVariables: exported } },
      });
      const guarded = await evaluateJsonata(guardState(task).Output, { input: taskOutput });
      return { taskOutput, output: guarded };
    };
    const guard = async (value: string | undefined, operation = 'create', task = 'RunCellBuild') =>
      (await afterBuild(task, operation, value === undefined ? [] : [{ Name: 'SCRIPT_OUTPUTS', Value: value }])).output;
    const admitted = async (value: string | undefined) => (await guard(value)).scriptOutputs === value;

    test('admits what R-43 admits', async () => {
      expect(await admitted('{}')).toBe(true);
      expect(await admitted('{"endpoint":"a"}')).toBe(true);
      expect(await admitted('{"a":"1","b":"two words"}')).toBe(true);
      expect(await admitted(`{"${'k'.repeat(64)}":"x"}`)).toBe(true);
      // The largest valid value, and the largest valid value of `\"` only.
      expect(await admitted(`{"a":"${'x'.repeat(4088)}"}`)).toBe(true);
      expect(await admitted(`{"a":"${String.raw`\"`.repeat(2044)}"}`)).toBe(true);
      // The pattern cannot see a repeated key; the buildspec and the hook do (R-43).
      expect(await admitted('{"a":"1","a":"2"}')).toBe(true);
    });

    test('rejects what R-43 rejects: an absent, empty, over-long or malformed value', async () => {
      for (const value of [
        undefined, '', '{', '[]', '{"a":1}', '{"a": "1"}', '{"a":"1", "b":"2"}', String.raw`{"a":"\u0041"}`, String.raw`{"a":"\/"}`,
        '{"a":"x\ty"}', '{"a":"x\u007fy"}', '{"a":"caf\u00e9"}', `{"${'k'.repeat(65)}":"x"}`, '{"1":"x"}',
        `{"a":"${'x'.repeat(4089)}"}`, `{"a":"${'x'.repeat(4090)}"}`, ' {}', '{} ', '{}\n',
      ]) {
        const output = await guard(value);
        expect(output.scriptOutputs).toBeUndefined();
        expect(output.failureReason).toBe('script outputs rejected');
      }
    });

    test('on delete a rejected value becomes {}, never a failure', async () => {
      for (const value of [undefined, '', '{"a":1}', 'x'.repeat(5000)]) {
        expect(await guard(value, 'delete')).toMatchObject({ scriptOutputs: '{}' });
        expect((await guard(value, 'delete')).failureReason).toBeUndefined();
      }
    });

    test('a 4,096-character near miss (a valid object of \\" escapes with its closing } missing) is rejected within 100 ms', async () => {
      const nearMiss = `{"a":"${String.raw`\"`.repeat(2044)}"`;
      expect(nearMiss).toHaveLength(4095);
      const mixed = `{"a":"${String.raw`\"\\`.repeat(1362)}x`;
      for (const value of [nearMiss, mixed, `${nearMiss} `]) {
        const t0 = Date.now();
        const output = await guard(value);
        expect(Date.now() - t0).toBeLessThan(100);
        expect(output.failureReason).toBe('script outputs rejected');
      }
    });

    test('an exported variable other than SCRIPT_OUTPUTS is never read, and a duplicate SCRIPT_OUTPUTS is rejected', async () => {
      const other = await afterBuild('RunTenantBuild', 'create', [{ Name: 'OTHER', Value: '{}' }]);
      expect(other.output.failureReason).toBe('script outputs rejected');
      const twice = await afterBuild('RunTenantBuild', 'create', [{ Name: 'SCRIPT_OUTPUTS', Value: '{}' }, { Name: 'SCRIPT_OUTPUTS', Value: '{"a":"1"}' }]);
      expect(twice.output.failureReason).toBe('script outputs rejected');
    });

    test('the task carries the raw value only when it is one string within the cap, and the guard drops it from state', async () => {
      const ok = await afterBuild('RunCellBuild', 'create', [{ Name: 'SCRIPT_OUTPUTS', Value: '{"a":"1"}' }]);
      expect(ok.taskOutput.scriptOutputsRaw).toBe('{"a":"1"}');
      expect(ok.output).toEqual({ cellBuild: { operation: 'create' }, tenantBuild: { operation: 'create' }, cellBuildResult: { Build: { Arn: 'arn:b', BuildStatus: 'SUCCEEDED' } }, scriptOutputs: '{"a":"1"}' });
      const long = await afterBuild('RunCellBuild', 'create', [{ Name: 'SCRIPT_OUTPUTS', Value: 'x'.repeat(100_000) }]);
      expect(long.taskOutput.scriptOutputsRaw).toBe(false);
      expect(long.output).not.toHaveProperty('scriptOutputsRaw');
    });

    test('the guard and the contract pattern are one rule', () => {
      for (const task of ['RunCellBuild', 'RunTenantBuild']) {
        expect(guardState(task).Output).toContain(SCRIPT_OUTPUT_GUARD_PATTERN.source);
        expect(guardState(task).Output).not.toContain('$parse');
        expect(states[task].Output).not.toContain(SCRIPT_OUTPUT_GUARD_PATTERN.source);
      }
    });

    test('an evaluation error of the guard is caught on its own state: {} on delete, a rejection otherwise; the task keeps only its build-failure Catch', async () => {
      for (const [task, phase] of [['RunCellBuild', 'cellBuild'], ['RunTenantBuild', 'tenantBuild']]) {
        const check = states[phase === 'cellBuild' ? 'CellScriptOutputs' : 'TenantScriptOutputs'];
        expect(check.Type).toBe('Parallel');
        expect(check.QueryLanguage).toBe('JSONata');
        expect(check.Branches).toHaveLength(1);
        expect(guardState(task).Type).toBe('Pass');
        expect(await evaluateJsonata(check.Output, { result: [{ a: 1 }] })).toEqual({ a: 1 });
        const [catcher] = check.Catch;
        expect(check.Catch).toHaveLength(1);
        expect(catcher.ErrorEquals).toEqual(['States.ALL']);
        const input = { [phase]: { operation: 'delete' }, scriptOutputsRaw: 'x' };
        const onDelete = await evaluateJsonata(catcher.Output, { input });
        expect(onDelete).toMatchObject({ scriptOutputs: '{}' });
        expect(onDelete).not.toHaveProperty('scriptOutputsRaw');
        expect(await evaluateJsonata(catcher.Output, { input: { [phase]: { operation: 'update' } } }))
          .toMatchObject({ failureReason: 'script outputs rejected' });
        expect(catcher.Next).toBe(phase === 'cellBuild' ? 'CellScriptChecked' : 'TenantScriptChecked');
        // An evaluation error of the task's own Arguments is a build failure, never a skipped script.
        expect(states[task].Catch.map((c: any) => c.ErrorEquals)).toEqual([['States.ALL']]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// R-46 expressions: token, q, deadline, budget
// ---------------------------------------------------------------------------
describe('the R-46 expressions', () => {
  const hook = (over: Partial<ResolvedHook> = {}): ResolvedHook => ({
    hookId: 'gate',
    scope: 'GLOBAL',
    revision: 4,
    sourceType: 'GITHUB',
    sourceLocation: 'https://github.com/o/r',
    sourceVersion: 'main',
    script: 'hooks/gate.sh',
    timeoutMinutes: 10,
    ...over,
  });
  const at = (offsetMs: number) => new Date(START + offsetMs).toISOString();

  test('the token is the SHA-256 of the seven values joined by |, 64 hex characters, different on every try and scope', async () => {
    const tokens = new Set<string>();
    for (const [scope, attempt, attemptTry] of [['GLOBAL', 1, 1], ['GLOBAL', 1, 2], ['GLOBAL', 2, 1], ['APPLICATION', 1, 1]] as const) {
      const variables = {
        EXECUTION_ID: 'exec-1', EVENT: 'CELL_CREATE', PHASE: 'PRE', HOOK: { scope }, HOOK_ID: 'gate', ATTEMPT: attempt, TRY: attemptTry,
      };
      const token: string = await evaluateJsonata(states.BeginTry.Assign.TOKEN, { context: { State: { EnteredTime: at(0) } } }, variables);
      expect(token).toBe(createHash('sha256').update(`exec-1|CELL_CREATE|PRE|${scope}|gate|${attempt}|${attemptTry}`).digest('hex'));
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(4);
  });

  test('q is 10 on the first try and max(5, 10 - ceil(r)) after, so refusals and the queue take at most 10 minutes', async () => {
    const q = (tryIndex: number, elapsedMs: number) => evaluateJsonata(
      states.BeginTry.Assign.Q,
      { context: { State: { EnteredTime: at(elapsedMs) } } },
      { TRY: tryIndex, FIRST_TRY_AT: at(0) },
    );
    expect(await q(1, 0)).toBe(10);
    // r is taken as 0 on try 1 whatever the clock says.
    expect(await q(1, 7 * MINUTE)).toBe(10);
    expect(await q(2, 30_000)).toBe(9);
    expect(await q(3, 61_000)).toBe(8);
    expect(await q(7, 3 * MINUTE)).toBe(7);
    expect(await q(11, 5 * MINUTE)).toBe(5);
    // The floor: the Choice ends the start at 5 minutes, but the clock can pass it by milliseconds.
    expect(await q(12, 5 * MINUTE + 40)).toBe(5);
    expect(await q(13, 9 * MINUTE)).toBe(5);
  });

  test('the attempt deadline is the run timeout, 10 minutes of refusals and queue and 5 of margin, from one instant', async () => {
    const assign = states.BeginAttempt.Assign;
    const evaluate = (field: string, variables: Record<string, unknown>, offset = 0) =>
      evaluateJsonata(assign[field], { context: { State: { EnteredTime: at(offset) } } }, variables);
    const vars = (op: string, T = 10, budgetEnd = 0) => ({ HOP: op, HOOK: hook({ timeoutMinutes: T }), BUDGET_END_MS: budgetEnd });
    expect(await evaluate('FIRST_TRY_AT', vars('create'))).toBe(at(0));
    expect(await evaluate('DEADLINE', vars('create'))).toBe(START + 25 * MINUTE);
    expect(await evaluate('DEADLINE', vars('update', 30))).toBe(START + 45 * MINUTE);
    // On delete, never later than 2 minutes before the end of the hook's budget.
    const budget = START + 144 * MINUTE;
    expect(await evaluate('DEADLINE', vars('delete', 30, budget))).toBe(START + 45 * MINUTE);
    expect(await evaluate('DEADLINE_BY', vars('delete', 30, budget))).toBe('timeout');
    const late = 120 * MINUTE;
    expect(await evaluate('DEADLINE', vars('delete', 30, budget), late)).toBe(budget - 2 * MINUTE);
    expect(await evaluate('DEADLINE_BY', vars('delete', 30, budget), late)).toBe('budget');
    // The expression never reads $FIRST_TRY_AT, which is unset or the last attempt's in that state.
    expect(assign.DEADLINE).not.toContain('FIRST_TRY_AT');
    expect(assign.DEADLINE_BY).not.toContain('FIRST_TRY_AT');
  });

  test('a delete hook shares one budget of 3 x (T + 17) + 3 minutes, 144 at the cap', async () => {
    const budget = (T: number) => evaluateJsonata(
      states.BeginHook.Assign.BUDGET_END_MS,
      { context: { State: { EnteredTime: at(0) } } },
      { HOOKS: [hook({ timeoutMinutes: T })], HI: 0 },
    );
    expect(await budget(30)).toBe(START + 144 * MINUTE);
    expect(await budget(5)).toBe(START + 69 * MINUTE);
  });
});

// ---------------------------------------------------------------------------
// The sub-graph, run against scripted CodeBuild answers
// ---------------------------------------------------------------------------
describe('the hook sub-graph (R-45, R-46)', () => {
  const hook = (hookId: string, scope: 'GLOBAL' | 'APPLICATION', over: Partial<ResolvedHook> = {}): ResolvedHook => ({
    hookId,
    scope,
    revision: scope === 'GLOBAL' ? 3 : 0,
    sourceType: 'GITHUB',
    sourceLocation: 'https://github.com/o/r',
    sourceVersion: 'main',
    script: `hooks/${hookId}.sh`,
    timeoutMinutes: 10,
    ...over,
  });
  const hooks = (event: HookExecutionInput['event'], pre: ResolvedHook[], post: ResolvedHook[]): HookExecutionInput => ({ event, pre, post });
  const SHA = 'a'.repeat(40);

  const payload = (cell: HookExecutionInput, operation = 'create') => ({
    applicationId: 'app-1',
    cellId: 'cell-1',
    accountId: '111111111111',
    operatorId: 'operator-1',
    tenantId: 'tenant-1',
    cellBuild: { operation, parameters: { CELL_SIZE: 'small' }, hooks: cell },
    tenantBuild: { operation, tenantName: 'Acme', parameters: { MODE: 'x' }, hooks: hooks('DEPLOYMENT_CREATE', [], []) },
    scriptOutputs: '{"endpoint":"a"}',
  });

  /** One scripted build: how it ends and when, from its start. */
  interface Plan { status?: string; afterMs?: number; phases?: unknown[]; hang?: boolean }
  interface Service {
    starts: TaskCall[];
    polls: TaskCall[];
    stops: TaskCall[];
    metrics: TaskCall[];
  }

  function service(options: {
    plan?: (buildNumber: number, startedAt: number, attemptNumber: number) => Plan;
    startErrors?: (startCall: number, call: TaskCall) => { Error: string; Cause?: string } | undefined;
    stopError?: { Error: string; Cause?: string };
  } = {}): { handler: (call: TaskCall) => any; log: Service } {
    const log: Service = { starts: [], polls: [], stops: [], metrics: [] };
    const builds = new Map<string, { startedAt: number; plan: Plan; stoppedAt?: number }>();
    let startCalls = 0;
    const handler = (call: TaskCall) => {
      if (call.resource.endsWith(':startBuild')) {
        log.starts.push(call);
        const error = options.startErrors?.(startCalls++, call);
        if (error !== undefined) {
          throw error;
        }
        const number = builds.size + 1;
        const plan = options.plan?.(number, call.at, number) ?? { status: 'SUCCEEDED', afterMs: 90_000 };
        builds.set(`build-${number}`, { startedAt: call.at, plan });
        return { Build: { Id: `build-${number}`, Arn: `arn:build-${number}`, Environment: { huge: 'x'.repeat(10) } } };
      }
      if (call.resource.endsWith(':stopBuild')) {
        log.stops.push(call);
        if (options.stopError !== undefined) {
          throw options.stopError;
        }
        builds.get(call.args.Id)!.stoppedAt = call.at;
        return { Build: { Id: call.args.Id } };
      }
      if (call.resource.endsWith(':batchGetBuilds')) {
        log.polls.push(call);
        const id: string = call.args.Ids[0];
        const build = builds.get(id)!;
        const elapsed = call.at - build.startedAt;
        let status = 'IN_PROGRESS';
        let phases: unknown[] = build.plan.phases ?? [];
        if (build.stoppedAt !== undefined && call.at >= build.stoppedAt) {
          status = 'STOPPED';
        } else if (build.plan.hang !== true && elapsed >= (build.plan.afterMs ?? 0)) {
          status = build.plan.status ?? 'SUCCEEDED';
        }
        if (status === 'SUCCEEDED' || status === 'FAILED') {
          phases = [{ PhaseType: 'QUEUED', PhaseStatus: 'SUCCEEDED', DurationInSeconds: 1 }, { PhaseType: 'BUILD', PhaseStatus: status, DurationInSeconds: 60 }];
        }
        return { Builds: [{ Id: id, BuildStatus: status, ResolvedSourceVersion: SHA, Phases: phases }], BuildsNotFound: [] };
      }
      if (call.resource.endsWith(':putMetricData')) {
        log.metrics.push(call);
        return {};
      }
      throw new Error(`Unexpected ${call.resource}`);
    };
    return { handler, log };
  }

  const STOP_AT = ['RunCellBuildSourcePin', 'CellBuildSucceeded', 'RunTenantBuildSourcePin', 'TenantBuildSucceeded',
    'CellFailureHasTenantWithReason', 'FailTenantWithReason'];

  const run = (
    start: string,
    input: any,
    handler: (call: TaskCall) => any,
    extra: Partial<Parameters<typeof simulate>[0]> = {},
  ): Promise<SimulationResult> =>
    simulate({ definition: definition as any, start, stopAt: STOP_AT, input, handler, startTime: START, ...extra });

  const envOf = (call: TaskCall) => Object.fromEntries((call.args.EnvironmentVariablesOverride as any[]).map((v) => [v.Name, v.Value]));

  test('pre hooks run one at a time in the order given, each in the project of its scope, then the script (R-45, R-41)', async () => {
    const { handler, log } = service();
    const input = payload(hooks('CELL_CREATE', [hook('audit', 'GLOBAL'), hook('route', 'APPLICATION')], []));
    const result = await run('CellPreHooks', input, handler);

    expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
    expect(log.starts.map((c) => [c.args.ProjectName, envOf(c).HOOK_ID, envOf(c).HOOK_SCOPE]))
      .toEqual([[`${FLEET}-global-hook`, 'audit', 'GLOBAL'], [`${FLEET}-app-hook`, 'route', 'APPLICATION']]);
    // One at a time: the second starts only after the first was polled to a final status.
    expect(log.starts[1].at).toBeGreaterThan(log.polls[1].at);
    // The payload carries the global hook that ran, in DynamoDB's own form, and nothing of the loop.
    expect(result.output.lastGlobalHooks).toEqual([
      { M: { hookId: { S: 'audit' }, phase: { S: 'PRE' }, revision: { N: '3' }, sourceVersion: { S: 'main' }, resolvedSourceVersion: { S: SHA } } },
    ]);
    expect(Object.keys(result.output).sort()).toEqual(['accountId', 'applicationId', 'cellBuild', 'cellId', 'lastGlobalHooks', 'operatorId', 'tenantBuild', 'tenantId']);
  });

  test('a global and an application hook with the same id on one event start under different tokens (R-46)', async () => {
    const { handler, log } = service();
    const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('audit', 'GLOBAL'), hook('audit', 'APPLICATION')], [])), handler);

    expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
    expect(log.starts.map((c) => c.args.ProjectName)).toEqual([`${FLEET}-global-hook`, `${FLEET}-app-hook`]);
    const [globalToken, appToken] = log.starts.map((c) => c.args.IdempotencyToken);
    expect(globalToken).not.toBe(appToken);
    expect(appToken).toBe(createHash('sha256').update('exec-1|CELL_CREATE|PRE|APPLICATION|audit|1|1').digest('hex'));
  });

  test('a hook build receives the R-42 environment and no other control plane state', async () => {
    const { handler, log } = service();
    await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('audit', 'GLOBAL')], [])), handler);
    const call = log.starts[0];
    expect(envOf(call)).toEqual({
      EVENT: 'CELL_CREATE',
      PHASE: 'PRE',
      HOOK_ID: 'audit',
      HOOK_SCOPE: 'GLOBAL',
      APPLICATION_ID: 'app-1',
      CELL_ID: 'cell-1',
      CELL_ACCOUNT_ID: '111111111111',
      OPERATOR_ID: 'operator-1',
      EXECUTION_ID: 'exec-1',
      ATTEMPT: '1',
      HOOK_SCRIPT: 'hooks/audit.sh',
      PARAM_CELL_SIZE: 'small',
    });
    expect(call.args).toMatchObject({
      SourceTypeOverride: 'GITHUB',
      SourceLocationOverride: 'https://github.com/o/r',
      SourceVersion: 'main',
      TimeoutInMinutesOverride: 10,
      QueuedTimeoutInMinutesOverride: 10,
      BuildspecOverride: HOOK_BUILDSPEC,
    });
    expect(call.args.IdempotencyToken).toBe(createHash('sha256').update('exec-1|CELL_CREATE|PRE|GLOBAL|audit|1|1').digest('hex'));
    expect(Object.keys(call.args).sort()).toEqual([
      'BuildspecOverride', 'EnvironmentVariablesOverride', 'IdempotencyToken', 'ProjectName', 'QueuedTimeoutInMinutesOverride',
      'SourceLocationOverride', 'SourceTypeOverride', 'SourceVersion', 'TimeoutInMinutesOverride',
    ]);
  });

  test('a deployment event adds TENANT_ID and TENANT_NAME and the deployment parameters; a hook with no ref sends no SourceVersion', async () => {
    const { handler, log } = service();
    const input = payload(hooks('CELL_CREATE', [], []));
    input.tenantBuild.hooks = hooks('DEPLOYMENT_CREATE', [hook('reg', 'APPLICATION', { sourceVersion: '', sourceType: 'S3' })], []);
    await run('TenantPreHooks', input, handler, { stopAt: [...STOP_AT] });
    const call = log.starts[0];
    expect(envOf(call)).toMatchObject({ EVENT: 'DEPLOYMENT_CREATE', TENANT_ID: 'tenant-1', TENANT_NAME: 'Acme', PARAM_MODE: 'x' });
    expect(envOf(call).PARAM_CELL_SIZE).toBeUndefined();
    expect('SourceVersion' in call.args).toBe(false);
    expect(call.args.ProjectName).toBe(`${FLEET}-app-hook`);
  });

  test('post hooks receive SCRIPT_OUTPUTS, which leaves the payload when the list is done; pre hooks receive none', async () => {
    const { handler, log } = service();
    const input = payload(hooks('CELL_CREATE', [hook('pre', 'APPLICATION')], [hook('app', 'APPLICATION'), hook('glob', 'GLOBAL')]));
    const post = await run('CellPostHooks', input, handler);
    expect(log.starts.map((c) => [envOf(c).HOOK_ID, envOf(c).SCRIPT_OUTPUTS])).toEqual([['app', '{"endpoint":"a"}'], ['glob', '{"endpoint":"a"}']]);
    expect(post.stoppedAt).toBe('CellBuildSucceeded');
    expect(post.output.scriptOutputs).toBeUndefined();
    expect(post.output.lastGlobalHooks).toHaveLength(1);
    const pre = service();
    await run('CellPreHooks', input, pre.handler);
    expect(envOf(pre.log.starts[0]).SCRIPT_OUTPUTS).toBeUndefined();
  });

  test('no hooks at all: the list is empty, the script follows, and lastGlobalHooks is an empty list', async () => {
    const { handler, log } = service();
    const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [], [])), handler);
    expect(log.starts).toHaveLength(0);
    expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
    expect(result.output.lastGlobalHooks).toEqual([]);
    // A missing hooks field is an empty list, never a failure.
    const bare = payload(hooks('CELL_CREATE', [], []));
    delete (bare.cellBuild as any).hooks;
    expect((await run('CellPreHooks', bare, handler)).stoppedAt).toBe('RunCellBuildSourcePin');
  });

  test('polling is every 60 seconds and keeps the commit of the poll that saw the final status', async () => {
    const { handler, log } = service({ plan: () => ({ status: 'SUCCEEDED', afterMs: 150_000 }) });
    const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('gate', 'GLOBAL')], [])), handler);
    expect(log.polls.map((c) => Math.round((c.at - log.starts[0].at) / 1000))).toEqual([60, 120, 180].map((s) => expect.closeTo(s, -1)));
    expect(result.output.lastGlobalHooks[0].M.resolvedSourceVersion).toEqual({ S: SHA });
  });

  test('an S3 hook is listed with the version it names and no resolved commit', async () => {
    const { handler } = service();
    const noSha = (call: TaskCall) => {
      const out = handler(call);
      if (call.resource.endsWith(':batchGetBuilds')) {
        delete out.Builds[0].ResolvedSourceVersion;
      }
      return out;
    };
    const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('gate', 'GLOBAL', { sourceType: 'S3', sourceVersion: 'v1' })], [])), noSha);
    expect(result.output.lastGlobalHooks[0].M).toEqual({ hookId: { S: 'gate' }, phase: { S: 'PRE' }, revision: { N: '3' }, sourceVersion: { S: 'v1' } });
  });

  describe('create and update: the first failure ends the event', () => {
    test('a failed pre hook stops the later hooks and the script, names scope, hook and build, and lists only hooks that ran', async () => {
      const { handler, log } = service({ plan: (n) => (n === 2 ? { status: 'FAILED', afterMs: 60_000 } : { status: 'SUCCEEDED', afterMs: 60_000 }) });
      const input = payload(hooks('CELL_CREATE', [hook('a-first', 'GLOBAL'), hook('b-gate', 'GLOBAL'), hook('c-never', 'APPLICATION')], []));
      const result = await run('CellPreHooks', input, handler);
      expect(result.stoppedAt).toBe('CellFailureHasTenantWithReason');
      expect(log.starts).toHaveLength(2);
      expect(result.output.failureReason).toBe('Hook failed: global hook b-gate (CELL_CREATE PRE), build build-2: build ended with status FAILED');
      expect(result.output.error).toEqual({ Error: 'HookFailed' });
      expect(result.output.lastGlobalHooks.map((e: any) => e.M.hookId.S)).toEqual(['a-first', 'b-gate']);
      expect(result.output.cellBuildResult).toBeUndefined();
    });

    test('an application hook that fails names the application scope and is not listed in lastGlobalHooks', async () => {
      const { handler } = service({ plan: () => ({ status: 'FAILED', afterMs: 60_000 }) });
      const result = await run('CellPostHooks', payload(hooks('CELL_UPDATE', [], [hook('route', 'APPLICATION')]), 'update'), handler);
      expect(result.output.failureReason).toBe('Hook failed: application hook route (CELL_UPDATE POST), build build-1: build ended with status FAILED');
      expect(result.output.lastGlobalHooks).toEqual([]);
    });

    test('a queued timeout is told from a run timeout by the phase timing', async () => {
      const queued = [{ PhaseType: 'SUBMITTED', PhaseStatus: 'SUCCEEDED' }, { PhaseType: 'QUEUED', PhaseStatus: 'TIMED_OUT', DurationInSeconds: 600 }];
      const ran = [{ PhaseType: 'QUEUED', PhaseStatus: 'SUCCEEDED' }, { PhaseType: 'BUILD', PhaseStatus: 'TIMED_OUT', DurationInSeconds: 600 }];
      const input = payload(hooks('CELL_CREATE', [hook('gate', 'GLOBAL')], []));
      const a = await run('CellPreHooks', input, service({ plan: () => ({ status: 'TIMED_OUT', afterMs: 60_000, phases: queued }) }).handler);
      expect(a.output.failureReason).toContain('queued timeout, the build never ran');
      const b = await run('CellPreHooks', input, service({ plan: () => ({ status: 'TIMED_OUT', afterMs: 60_000, phases: ran }) }).handler);
      expect(b.output.failureReason).toContain('run timeout in phase BUILD');
    });

    test('a build that outlives its deadline is stopped, polled to a final status, and treated as a timeout; later hooks do not run', async () => {
      const { handler, log } = service({ plan: () => ({ hang: true }) });
      const input = payload(hooks('CELL_CREATE', [hook('slow', 'GLOBAL', { timeoutMinutes: 5 }), hook('after', 'GLOBAL')], []));
      const result = await run('CellPreHooks', input, handler);
      expect(log.stops).toHaveLength(1);
      // 5 (run) + 10 (refusals and queue) + 5 (margin) minutes from the first try, within the 60-second poll.
      expect((log.stops[0].at - log.starts[0].at) / MINUTE).toBeGreaterThanOrEqual(20);
      expect((log.stops[0].at - log.starts[0].at) / MINUTE).toBeLessThan(20.1);
      expect(result.output.failureReason).toBe('Hook failed: global hook slow (CELL_CREATE PRE), build build-1: attempt deadline passed, build stopped (STOPPED)');
      expect(log.starts).toHaveLength(1);
      expect(result.elapsedMs / MINUTE).toBeLessThan(23);
    });

    test('a stop that cannot be confirmed names the build as not confirmed stopped', async () => {
      const { handler } = service({ plan: () => ({ hang: true }), stopError: { Error: 'CodeBuild.ResourceNotFoundException', Cause: 'no build' } });
      const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('slow', 'GLOBAL', { timeoutMinutes: 5 })], [])), handler);
      expect(result.output.failureReason).toContain('build build-1 not confirmed stopped');
    });

    test('a refusal loops through a 30-second wait with a new try and token, q shrinking by the minutes refused', async () => {
      const refusal = { Error: 'CodeBuild.AccountLimitExceededException', Cause: 'Concurrent build limit exceeded. This build project has a limit of 5 concurrent build(s)' };
      const { handler, log } = service({ startErrors: (n) => (n < 4 ? refusal : undefined) });
      const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('gate', 'GLOBAL')], [])), handler);
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
      expect(log.starts.map((c) => Math.round((c.at - START) / 1000))).toEqual([0, 30, 60, 90, 120].map((s) => expect.closeTo(s, -1)));
      expect(log.starts.map((c) => c.args.QueuedTimeoutInMinutesOverride)).toEqual([10, 9, 8, 8, 7]);
      expect(new Set(log.starts.map((c) => c.args.IdempotencyToken)).size).toBe(5);
      expect(log.starts.map((c) => c.args.IdempotencyToken)[1]).toBe(createHash('sha256').update('exec-1|CELL_CREATE|PRE|GLOBAL|gate|1|2').digest('hex'));
    });

    test('a start refused for 5 minutes ends as a hook that cannot start and names the last refusal', async () => {
      const refusal = { Error: 'CodeBuild.AccountLimitExceededException', Cause: `Concurrent build limit exceeded. ${'x'.repeat(400)}` };
      const { handler, log } = service({ startErrors: () => refusal });
      const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('gate', 'GLOBAL')], [])), handler);
      expect(result.stoppedAt).toBe('CellFailureHasTenantWithReason');
      expect((log.starts[log.starts.length - 1].at - START) / MINUTE).toBeLessThanOrEqual(5);
      expect(result.elapsedMs / MINUTE).toBeGreaterThanOrEqual(5);
      expect(result.output.failureReason).toMatch(/^Hook failed: global hook gate \(CELL_CREATE PRE\): start still refused when its window ended \(CodeBuild.AccountLimitExceededException: Concurrent build limit exceeded\. x+\)$/);
      // The cause is bounded to 256 characters, in a variable, never in the payload.
      expect(result.variables.LAST_REFUSAL.cause).toHaveLength(256);
      expect(JSON.stringify(result.output)).not.toContain('x'.repeat(300));
      expect(result.output.lastGlobalHooks).toEqual([]);
    });

    test('a transient error repeats the same call: 10 seconds apart, three times, the same arguments and token', async () => {
      const throttle = { Error: 'CodeBuild.AWSCodeBuildException', Cause: 'Rate exceeded: StartBuild (Service: AWSCodeBuild; Error Code: ThrottlingException)' };
      const { handler, log } = service({ startErrors: (n) => (n < 2 ? throttle : undefined) });
      const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('gate', 'GLOBAL')], [])), handler);
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
      expect(log.starts).toHaveLength(3);
      expect(log.starts.map((c) => Math.round((c.at - START) / 1000))).toEqual([0, 10, 20].map((s) => expect.closeTo(s, -1)));
      expect(log.starts[1].args).toEqual(log.starts[0].args);
      expect(log.starts[2].args).toEqual(log.starts[0].args);
    });

    test('a start whose repeats are all spent ends as "start outcome unknown" naming the last error, never a new try', async () => {
      const throttle = { Error: 'CodeBuild.AWSCodeBuildException', Cause: 'Rate exceeded: StartBuild' };
      const { handler, log } = service({ startErrors: () => throttle });
      const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('gate', 'GLOBAL')], [])), handler);
      expect(log.starts).toHaveLength(4);
      expect(new Set(log.starts.map((c) => c.args.IdempotencyToken)).size).toBe(1);
      expect(result.output.failureReason).toBe('Hook failed: global hook gate (CELL_CREATE PRE): start outcome unknown (CodeBuild.AWSCodeBuildException: Rate exceeded: StartBuild)');
    });

    test('CodeBuild.InvalidInputException is not repeated and ends the attempt as "start outcome unknown"', async () => {
      const { handler, log } = service({ startErrors: () => ({ Error: 'CodeBuild.InvalidInputException', Cause: 'Request parameter mismatch for idempotency token' }) });
      const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('gate', 'GLOBAL')], [])), handler);
      expect(log.starts).toHaveLength(1);
      expect(result.output.failureReason).toContain('start outcome unknown (CodeBuild.InvalidInputException: Request parameter mismatch');
    });
  });

  describe('delete: three attempts, then skip and go on (P-9)', () => {
    const deleteInput = (list: ResolvedHook[], phase: 'pre' | 'post' = 'pre') => {
      const input = payload(hooks('CELL_DELETE', phase === 'pre' ? list : [], phase === 'post' ? list : []), 'delete');
      return input;
    };

    test('a hook that fails three times is retried 60 and 120 seconds apart, each attempt its own build, then skipped and counted', async () => {
      const { handler, log } = service({ plan: () => ({ status: 'FAILED', afterMs: 60_000 }) });
      const result = await run('CellPreHooks', deleteInput([hook('gate', 'GLOBAL'), hook('later', 'APPLICATION')]), handler);
      // The delete went on: the next hook ran, and the way out is the script.
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
      const gate = log.starts.filter((c) => envOf(c).HOOK_ID === 'gate');
      expect(gate.map((c) => envOf(c).ATTEMPT)).toEqual(['1', '2', '3']);
      expect(new Set(gate.map((c) => c.args.IdempotencyToken)).size).toBe(3);
      // Each next attempt starts only after the last build is final, the backoff after that.
      const finals = [1, 2, 3].map((n) => log.polls.filter((c) => c.args.Ids[0] === `build-${n}`).slice(-1)[0].at);
      expect((gate[1].at - finals[0]) / 1000).toBeGreaterThanOrEqual(60);
      expect((gate[1].at - finals[0]) / 1000).toBeLessThan(62);
      expect((gate[2].at - finals[1]) / 1000).toBeGreaterThanOrEqual(120);
      expect((gate[2].at - finals[1]) / 1000).toBeLessThan(122);
      // Counted, logged, and the hook is listed because its builds ran.
      // Both hooks failed all three attempts: two skips, each counted.
      expect(log.metrics).toHaveLength(2);
      expect(log.metrics[0].args).toEqual({ Namespace: `${FLEET}/hooks`, MetricData: [{ MetricName: 'HookSkipped', Value: 1, Unit: 'Count' }] });
      expect(result.variables.SKIP_LOG.skippedHook).toMatchObject({
        scope: 'APPLICATION',
        hookId: 'later',
        event: 'CELL_DELETE',
        buildIds: ['build-4', 'build-5', 'build-6'],
        budgetRanOut: false,
        record: { applicationId: 'app-1', cellId: 'cell-1', tenantId: 'tenant-1' },
      });
      expect(result.output.lastGlobalHooks.map((e: any) => e.M.hookId.S)).toEqual(['gate']);
      expect(result.output.failureReason).toBeUndefined();
      // The skip log of the last skipped hook is the application hook's.
      expect(log.starts.filter((c) => envOf(c).HOOK_ID === 'later').map((c) => envOf(c).ATTEMPT)).toEqual(['1', '2', '3']);
    });

    test('a hook that succeeds on the second attempt is not skipped', async () => {
      const { handler, log } = service({ plan: (n) => ({ status: n === 1 ? 'FAILED' : 'SUCCEEDED', afterMs: 60_000 }) });
      const result = await run('CellPreHooks', deleteInput([hook('gate', 'GLOBAL')]), handler);
      expect(log.starts).toHaveLength(2);
      expect(log.metrics).toHaveLength(0);
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
    });

    test('a start refused for its whole window starts nothing, does not count against the three, and follows the 60-second backoff', async () => {
      const refusal = { Error: 'CodeBuild.AccountLimitExceededException', Cause: 'Concurrent build limit exceeded' };
      const { handler, log } = service({
        // Refused through the first 5-minute window and into the second, then started.
        startErrors: (_n, call) => (call.at - START <= 7 * MINUTE ? refusal : undefined),
        plan: () => ({ status: 'SUCCEEDED', afterMs: 60_000 }),
      });
      const result = await run('CellPreHooks', deleteInput([hook('gate', 'GLOBAL', { timeoutMinutes: 5 })]), handler);
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
      // ATTEMPT never moved while the start was refused: the one build is attempt 1.
      expect(new Set(log.starts.map((c) => envOf(c).ATTEMPT))).toEqual(new Set(['1']));
      const firstWindow = log.starts.filter((c) => c.at - START < 5 * MINUTE);
      const next = log.starts.find((c) => c.at - START >= 5 * MINUTE)!;
      // The last try of the window, its 30-second wait, then the 60-second backoff.
      expect(next.at - firstWindow[firstWindow.length - 1].at).toBeGreaterThanOrEqual(90_000);
      expect(next.at - firstWindow[firstWindow.length - 1].at).toBeLessThan(91_000);
      expect(log.metrics).toHaveLength(0);
      expect(result.output.lastGlobalHooks.map((e: any) => e.M.hookId.S)).toEqual(['gate']);
    });

    test('a start whose outcome is unknown counts, and the next attempt waits q + T since that try\'s last call', async () => {
      const throttle = { Error: 'CodeBuild.AWSCodeBuildException', Cause: 'Rate exceeded: StartBuild' };
      const { handler, log } = service({
        startErrors: (n) => (n < 4 ? throttle : undefined),
        plan: () => ({ status: 'SUCCEEDED', afterMs: 60_000 }),
      });
      const result = await run('CellPreHooks', deleteInput([hook('gate', 'GLOBAL', { timeoutMinutes: 5 })]), handler);
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
      const second = log.starts[4];
      expect(envOf(second).ATTEMPT).toBe('2');
      // The repeats ended at 30 s, so the hidden build stops by 30 s + q (10) + T (5) minutes at the latest.
      expect((second.at - log.starts[3].at) / MINUTE).toBeGreaterThanOrEqual(15);
      expect((second.at - log.starts[0].at) / MINUTE).toBeLessThan(5 + 10 + 1.5 + 0.5);
    });

    test('every attempt ends 2 minutes before the end of the hook\'s budget, at the cap, however long the builds hang', async () => {
      const { handler, log } = service({ plan: () => ({ hang: true }) });
      const result = await run('CellPreHooks', deleteInput([hook('slow', 'GLOBAL', { timeoutMinutes: 30 })]), handler);
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
      expect(log.starts.map((c) => envOf(c).ATTEMPT)).toEqual(['1', '2', '3']);
      expect(log.stops).toHaveLength(3);
      // 3 x (30 + 17) + 3 = 144 minutes, never more.
      expect(result.elapsedMs / MINUTE).toBeLessThanOrEqual(144);
      expect(result.elapsedMs / MINUTE).toBeGreaterThan(130);
      expect(result.variables.SKIP_LOG.skippedHook.buildIds).toHaveLength(3);
    });

    test('when the budget sets the deadline, the stop is polled and the skip says the budget ran out', async () => {
      // A start refused for 100 minutes leaves less than a full attempt in the 144-minute budget.
      const refusal = { Error: 'CodeBuild.AccountLimitExceededException', Cause: 'Concurrent build limit exceeded' };
      const { handler, log } = service({
        startErrors: (_n, call) => (call.at - START < 130 * MINUTE ? refusal : undefined),
        plan: () => ({ hang: true }),
      });
      const result = await run('CellPreHooks', deleteInput([hook('slow', 'GLOBAL', { timeoutMinutes: 30 })]), handler);
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
      expect(result.variables.SKIP_LOG.skippedHook.budgetRanOut).toBe(true);
      expect(result.elapsedMs / MINUTE).toBeLessThanOrEqual(144);
      expect(log.metrics).toHaveLength(1);
    });

    test('a delete never fails the operation, and a refused hook for the whole budget stays inside the history quota at the caps', async () => {
      const refusal = { Error: 'CodeBuild.AccountLimitExceededException', Cause: 'Concurrent build limit exceeded' };
      const { handler } = service({ startErrors: () => refusal });
      const result = await run('CellPreHooks', deleteInput([hook('gate', 'GLOBAL', { timeoutMinutes: 30 })]), handler, { maxSteps: 100000 });
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
      expect(result.output.failureReason).toBeUndefined();
      expect(result.elapsedMs / MINUTE).toBeLessThanOrEqual(144);
      // Ten hooks of the same kind run in sequence in one execution (R-39): the quota is 25,000 events.
      // eslint-disable-next-line no-console
      console.log(`history events of one delete hook refused for its whole 144-minute budget: ${result.historyEvents} (x10 = ${result.historyEvents * 10})`);
      expect(result.historyEvents).toBeGreaterThan(0);
    });
  });

  test('a global hook run is recorded only when a build started: a start refused for the whole window lists nothing', async () => {
    const { handler } = service({ startErrors: () => ({ Error: 'CodeBuild.AccountLimitExceededException', Cause: 'cap' }) });
    const result = await run('CellPreHooks', payload(hooks('CELL_CREATE', [hook('gate', 'GLOBAL')], [])), handler);
    expect(result.output.lastGlobalHooks).toEqual([]);
  });

  describe('the contract with the API (ADR-0044): resolveHooks in, lastGlobalHooks out', () => {
    const hookDef = (hookId: string, over: Partial<HookDefinition> = {}): HookDefinition => ({
      hookId,
      events: ['CELL_CREATE'],
      phase: 'PRE',
      source: { type: 'GITHUB', location: 'https://github.com/o/r', sourceVersion: 'main' },
      script: `hooks/${hookId}.sh`,
      timeoutMinutes: 10,
      ...over,
    });
    const record = (hookId: string, revision: number, over: Partial<HookDefinition> = {}): GlobalHookRecord => ({
      ...hookDef(hookId, over),
      revision,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });

    test('the input the API builds is the input the workflow runs; what it writes, the API reads back', async () => {
      // A global hook with a ref, a global S3 hook with none (no commit either), an application hook.
      const input = resolveHooks(
        'CELL_CREATE',
        [hookDef('route')],
        [record('audit', 3), record('nover', 7, { source: { type: 'S3', location: 'bucket/key' } })],
      );
      expect(input.pre.map((h) => [h.hookId, h.scope, h.revision, h.sourceVersion])).toEqual([
        ['audit', 'GLOBAL', 3, 'main'],
        ['nover', 'GLOBAL', 7, ''],
        ['route', 'APPLICATION', 0, 'main'],
      ]);
      const { handler, log } = service();
      const noCommit = (call: TaskCall) => {
        const out = handler(call);
        if (call.resource.endsWith(':batchGetBuilds') && call.args.Ids[0] === 'build-2') {
          delete out.Builds[0].ResolvedSourceVersion;
        }
        return out;
      };
      const result = await run('CellPreHooks', payload(input), noCommit);
      expect(result.stoppedAt).toBe('RunCellBuildSourcePin');
      // The workflow ran the list as given, each hook in the project of its scope.
      expect(log.starts.map((c) => [c.args.ProjectName, envOf(c).HOOK_ID, envOf(c).EVENT, envOf(c).PHASE]))
        .toEqual([[`${FLEET}-global-hook`, 'audit', 'CELL_CREATE', 'PRE'], [`${FLEET}-global-hook`, 'nover', 'CELL_CREATE', 'PRE'], [`${FLEET}-app-hook`, 'route', 'CELL_CREATE', 'PRE']]);

      // What the terminal write sends (`L` of the payload) is what DynamoDB stores; the document client unmarshalls it.
      const stored = unmarshall({ lastGlobalHooks: { L: result.output.lastGlobalHooks } }).lastGlobalHooks;
      expect(stored).toEqual([
        { hookId: 'audit', phase: 'PRE', revision: 3, sourceVersion: 'main', resolvedSourceVersion: SHA },
        { hookId: 'nover', phase: 'PRE', revision: 7 },
      ]);
      const expected = [
        { hookId: 'audit', phase: 'PRE', revision: 3, sourceVersion: 'main', resolvedSourceVersion: SHA },
        { hookId: 'nover', phase: 'PRE', revision: 7 },
      ];
      expect(readLastGlobalHooks(stored)).toEqual(expected);
      // And through the data model of the cell record, as GetCell reads it.
      const item = {
        cellId: 'cell-1',
        applicationId: 'app-1',
        accountId: '111111111111',
        status: 'ACTIVE',
        lastGlobalHooks: stored,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as unknown as CellItem;
      expect(new CellDataModel().fromItem(item).lastGlobalHooks).toEqual(expected);
    });

    test('the empty list the workflow writes reads back as none', () => {
      expect(readLastGlobalHooks(unmarshall({ lastGlobalHooks: { L: [] } }).lastGlobalHooks)).toEqual([]);
    });
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The hook half of the provisioning workflow (spec §6.5 R-41 to R-43, §8.3
 * R-45 and R-46, ADR-044): the JSONata of every hook state, the hook
 * buildspec, and the sub-graph that runs one list of hooks.
 *
 * ONE copy of the sub-graph serves the four lists of an execution (cell
 * `PRE`, cell `POST`, deployment `PRE`, deployment `POST`), and the two of a
 * record event (`PRE`, `POST`, §8.4 R-50, ADR-045). A caller enters
 * through one of six `*Hooks` Pass states, which assign the list and the
 * way back; the sub-graph runs the hooks one at a time and leaves through
 * {@link HookRunner.listDone} (the list ran) or {@link HookRunner.failureTarget}
 * (a create or update hook failed). The workflow wires the six ways back and
 * the three failure writes after it has built its own states.
 *
 * The loop holds its state in workflow variables, never in the state payload
 * (§8.1): the payload carries only what the terminal writes read
 * (`lastGlobalHooks`, `failureReason`) and the script outputs while the post
 * hooks run (`scriptOutputs`). The variable names are the ones R-46 uses
 * (`EXECUTION_ID`, `EVENT`, `PHASE`, `HOOK_ID`, `ATTEMPT`, `TRY`,
 * `FIRST_TRY_AT`, `LAST_REFUSAL`).
 */

import { Duration } from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import {
  HOOK_DELETE_BACKOFF_RATE,
  HOOK_DELETE_BACKOFF_SECONDS,
  HOOK_DELETE_MAX_ATTEMPTS,
  HOOK_POLL_INTERVAL_SECONDS,
  HOOK_REFUSAL_WAIT_SECONDS,
  HOOK_REFUSAL_WINDOW_MINUTES,
  HOOK_STOP_BUDGET_MINUTES,
  SCRIPT_OUTPUTS_MAX_BYTES,
  SCRIPT_OUTPUT_GUARD_SOURCE,
} from './hook.types';
import { buildProjectName } from '../shared/fleet';

/**
 * A raw-ASL state in JSONata. `CustomStateProps` has no `queryLanguage`, and
 * without one CDK renders the state's Catch in JSONPath form, dropping its
 * `Output`; overriding the field makes CDK emit `QueryLanguage: JSONata`
 * and render each Catch with `Output` and `Assign`.
 */
// see adr/0041-run-the-build-tasks-in-jsonata.md
export class JsonataCustomState extends sfn.CustomState {
  protected override readonly queryLanguage = sfn.QueryLanguage.JSONATA;
}

/** Wraps a JSONata expression for a JSONata state field. */
export function expr(expression: string): string {
  return `{% ${expression} %}`;
}

/** The error names of a refused start (R-46, H-9): the project's cap and, by CodeBuild's documentation, the account's quota. */
export const REFUSAL_ERRORS: readonly string[] = ['CodeBuild.AccountLimitExceededException'];
/** A repeat whose arguments differ from the first call's under one token (R-46, H-8). */
export const INVALID_INPUT_ERROR = 'CodeBuild.InvalidInputException';
/** The task timeout of a start, a stop and the repeat's interval (R-46). */
export const HOOK_TASK_TIMEOUT_SECONDS = 15;
export const HOOK_RETRY_INTERVAL_SECONDS = 10;
export const HOOK_RETRY_MAX_ATTEMPTS = 3;

/** The metric a skipped delete hook counts in (R-46, T42). */
export const HOOK_SKIPPED_METRIC_NAME = 'HookSkipped';
export function hookMetricNamespace(fleetName: string): string {
  return `${fleetName}/hooks`;
}

// ---------------------------------------------------------------------------
// Buildspec (R-41, T44)
// ---------------------------------------------------------------------------

/**
 * The hook buildspec: it hands nothing to the script but the environment the
 * build already has (R-42), assumes no role, passes no external id and
 * interpolates no value into a command line (T44). `$HOOK_SCRIPT` is
 * expanded by bash as one quoted word.
 */
export const HOOK_BUILDSPEC = [
  'version: 0.2',
  'env:',
  '  shell: bash',
  'phases:',
  '  build:',
  '    commands:',
  '      - bash "$HOOK_SCRIPT"',
].join('\n');

// ---------------------------------------------------------------------------
// R-43: the guard
// ---------------------------------------------------------------------------

/**
 * The workflow's check of a script's `SCRIPT_OUTPUTS` (R-43), as a JSONata
 * boolean over `value`: a string of 2 to 4,096 characters that the linear
 * pattern of `hook.types.ts` admits. Never `$parse`: it raises on bad input.
 */
export function scriptOutputsGuard(value: string): string {
  return `$type(${value}) = 'string' and $length(${value}) >= 2 and $length(${value}) <= ${SCRIPT_OUTPUTS_MAX_BYTES} `
    + `and $contains(${value}, /${SCRIPT_OUTPUT_GUARD_SOURCE}/)`;
}

/** The statusReason of a create or update whose script outputs the guard rejected (R-43). */
export const SCRIPT_OUTPUTS_REJECTED_REASON = 'script outputs rejected';

/**
 * The script task's `Output` fields for the outputs (R-43): the value when
 * the guard admits it; `{}` on delete when it does not; otherwise
 * `failureReason`, which routes the operation to its failure write.
 */
export function scriptOutputsFields(operationRef: string): string {
  const raw = "$states.result.Build.ExportedEnvironmentVariables[Name = 'SCRIPT_OUTPUTS'].Value";
  return `(\n$raw := ${raw};\n${scriptOutputsGuard('$raw')} ? {"scriptOutputs": $raw} : `
    + `(${operationRef} = 'delete' ? {"scriptOutputs": "{}"} : {"failureReason": "${SCRIPT_OUTPUTS_REJECTED_REASON}"})\n)`;
}

// ---------------------------------------------------------------------------
// Variable assignments of the sub-graph (R-46)
// ---------------------------------------------------------------------------

const ENTERED_MS = '$toMillis($states.context.State.EnteredTime)';
const MINUTE_MS = 60000;
const FINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'];
/** The margin of an attempt's deadline beyond its run timeout and its 10 minutes of refusals and queue (R-46). */
const DEADLINE_MARGIN_MINUTES = 5;
const REFUSAL_AND_QUEUE_MINUTES = 10;
/** A delete hook's attempts and refusal windows end this long before its budget (R-46). */
const BUDGET_STOP_MARGIN_MS = HOOK_STOP_BUDGET_MINUTES * MINUTE_MS;
/** A start and its repeats end within this long of the start task's entry: 15 + 3 x (10 + 15) seconds (R-46). */
const START_TRY_BOUND_MS = (HOOK_TASK_TIMEOUT_SECONDS + HOOK_RETRY_MAX_ATTEMPTS * (HOOK_RETRY_INTERVAL_SECONDS + HOOK_TASK_TIMEOUT_SECONDS)) * 1000;
/** Per attempt of a delete hook: the 17 minutes beyond the run timeout (10 refused or queued, 5 margin, 2 stop). */
const ATTEMPT_OVERHEAD_MINUTES = REFUSAL_AND_QUEUE_MINUTES + DEADLINE_MARGIN_MINUTES + HOOK_STOP_BUDGET_MINUTES;

/** One of the six lists a caller enters the sub-graph with. */
export type HookListKind = 'cellPre' | 'cellPost' | 'tenantPre' | 'tenantPost' | 'recordPre' | 'recordPost';

/** The record event of the execution input (`RecordEventWorkflowInput`, §8.4). */
const RECORD_EVENT = '$states.input.recordEvent';

/** The list's own variables: which build, which phase, which hooks, the way back. */
export function listBeginAssign(kind: HookListKind): Record<string, string | boolean | number | unknown[]> {
  const cell = kind.startsWith('cell');
  const pre = kind.endsWith('Pre');
  if (kind.startsWith('record')) {
    const list = `${RECORD_EVENT}.hooks.${pre ? 'pre' : 'post'}`;
    return {
      HMODE: 'record',
      HRET: kind,
      PHASE: pre ? 'PRE' : 'POST',
      // The verb of `<RECORD_TYPE>_<VERB>` tells create and update (first failure ends) from delete (skip, R-46).
      HOP: expr(`$lowercase($substringAfter(${RECORD_EVENT}.event, '_'))`),
      EVENT: expr(`${RECORD_EVENT}.event`),
      // R-50: a tenant or account event runs no application hook, whatever the input holds.
      HOOKS: expr(`$append([], ${RECORD_EVENT}.recordType = 'APPLICATION' ? ${list} : ${list}[scope = 'GLOBAL'])`),
      HI: 0,
      HFAILED: false,
      EXECUTION_ID: expr('$states.context.Execution.Name'),
      ...(pre ? { RUNS: [] } : {}),
    };
  }
  const build = cell ? '$states.input.cellBuild' : '$states.input.tenantBuild';
  const event = cell ? `"CELL_" & $uppercase(${build}.operation)` : `"DEPLOYMENT_" & $uppercase(${build}.operation)`;
  return {
    HMODE: cell ? 'cell' : 'tenant',
    HRET: kind,
    PHASE: pre ? 'PRE' : 'POST',
    HOP: expr(`${build}.operation`),
    EVENT: expr(`$exists(${build}.hooks.event) ? ${build}.hooks.event : ${event}`),
    HOOKS: expr(`$append([], ${build}.hooks.${pre ? 'pre' : 'post'})`),
    HI: 0,
    HFAILED: false,
    EXECUTION_ID: expr('$states.context.Execution.Name'),
    // The runs of one event span its pre and its post list (R-40).
    ...(pre ? { RUNS: [] } : {}),
  };
}

/** The hook's variables, set when its first attempt starts (R-46: the delete budget is data from the definition). */
export const BEGIN_HOOK_ASSIGN: Record<string, unknown> = {
  HOOK: expr('$HOOKS[$HI]'),
  HOOK_ID: expr('$HOOKS[$HI].hookId'),
  ATTEMPT: 1,
  BUILD_ID: '',
  BUILD_IDS: [],
  LAST_RESOLVED: '',
  NOT_CONFIRMED: false,
  BUDGET_RAN_OUT: false,
  START_UNKNOWN: false,
  BUDGET_END_MS: expr(
    `${ENTERED_MS} + (${HOOK_DELETE_MAX_ATTEMPTS} * ($HOOKS[$HI].timeoutMinutes + ${ATTEMPT_OVERHEAD_MINUTES}) + ${HOOK_DELETE_MAX_ATTEMPTS}) * ${MINUTE_MS}`,
  ),
};

/** The run timeout plus the 10 minutes of refusals and queue plus the margin, from one instant (R-46). */
const TIMEOUT_DEADLINE = `${ENTERED_MS} + ($HOOK.timeoutMinutes + ${REFUSAL_AND_QUEUE_MINUTES + DEADLINE_MARGIN_MINUTES}) * ${MINUTE_MS}`;
const BUDGET_DEADLINE = `$BUDGET_END_MS - ${BUDGET_STOP_MARGIN_MS}`;

/**
 * The attempt's entry (R-46): `TRY` 1, `FIRST_TRY_AT` and the deadline from the
 * same `EnteredTime`; the deadline never reads `$FIRST_TRY_AT`. On delete the
 * earlier of that and 2 minutes before the end of the hook's budget.
 */
export const BEGIN_ATTEMPT_ASSIGN: Record<string, unknown> = {
  TRY: 1,
  FIRST_TRY_AT: expr('$states.context.State.EnteredTime'),
  DEADLINE: expr(`$HOP = 'delete' ? $min([${TIMEOUT_DEADLINE}, ${BUDGET_DEADLINE}]) : ${TIMEOUT_DEADLINE}`),
  DEADLINE_BY: expr(`($HOP = 'delete' and ${BUDGET_DEADLINE} < ${TIMEOUT_DEADLINE}) ? 'budget' : 'timeout'`),
  BUILD_ID: '',
  STOPPING: false,
  START_UNKNOWN: false,
  LAST_REFUSAL: null,
  LAST_ERROR: null,
  POLL: { status: 'NONE' },
};

/** The try's queued timeout and token, from `TRY` (R-46): assigned in the state after the one that sets `TRY`. */
export const BEGIN_TRY_ASSIGN: Record<string, string> = {
  Q: expr(
    `$max([5, ${REFUSAL_AND_QUEUE_MINUTES} - ($TRY = 1 ? 0 : $ceil((${ENTERED_MS} - $toMillis($FIRST_TRY_AT)) / ${MINUTE_MS}))])`,
  ),
  TOKEN: expr("$hash($join([$EXECUTION_ID, $EVENT, $PHASE, $HOOK.scope, $HOOK_ID, $string($ATTEMPT), $string($TRY)], '|'), 'SHA-256')"),
};

/**
 * A record event's hook environment (R-42, R-50), as `recordHookEnvironment`
 * in `record-event.types.ts` builds it: the input's event-level variables,
 * then `PHASE`, `HOOK_ID`, `HOOK_SCOPE`, `HOOK_SCRIPT`, `ATTEMPT` and, on
 * `POST`, `SCRIPT_OUTPUTS` `{}` (a commit writes no outputs), each overriding
 * an input variable of the same name. No `PARAM_`, `CELL_ID` or external id:
 * the input holds none (§8.1). Evaluated only when `$HMODE` is `record`.
 */
export const RECORD_HOOK_ENVIRONMENT = [
  '$HMODE = \'record\' ? $append([], $each($merge([',
  `  ${RECORD_EVENT}.environment,`,
  '  {"PHASE": $PHASE, "HOOK_ID": $HOOK_ID, "HOOK_SCOPE": $HOOK.scope, "HOOK_SCRIPT": $HOOK.script, "ATTEMPT": $string($ATTEMPT)},',
  "  $PHASE = 'POST' ? {\"SCRIPT_OUTPUTS\": \"{}\"} : {}",
  ']), function($v, $k) {{"Name": $k, "Type": "PLAINTEXT", "Value": $v}})) : []',
].join('\n');

/** One fixed PLAINTEXT hook variable (R-42). */
function hookVar(name: string, value: string): string {
  return `{"Name": "${name}", "Type": "PLAINTEXT", "Value": ${value}}`;
}

/**
 * The start task's `Arguments` (R-46): every field reads only variables and
 * the state input, all fixed for the try; no `$uuid()`, `$now()` or other
 * value that changes between evaluations, and no `$states.context` field
 * (a `Retry` evaluates them again on each repeat, H-8). The project follows
 * the hook's scope (R-41) and no role override is sent.
 */
export function hookStartArguments(fleetName: string): string {
  const input = '$states.input';
  const fixed = [
    hookVar('EVENT', '$EVENT'),
    hookVar('PHASE', '$PHASE'),
    hookVar('HOOK_ID', '$HOOK_ID'),
    hookVar('HOOK_SCOPE', '$HOOK.scope'),
    hookVar('APPLICATION_ID', `${input}.applicationId`),
    hookVar('CELL_ID', `${input}.cellId`),
    hookVar('CELL_ACCOUNT_ID', `${input}.accountId`),
    hookVar('OPERATOR_ID', `${input}.operatorId`),
    hookVar('EXECUTION_ID', '$EXECUTION_ID'),
    hookVar('ATTEMPT', '$string($ATTEMPT)'),
    hookVar('HOOK_SCRIPT', '$HOOK.script'),
  ].join(',\n  ');
  const deployment = [
    hookVar('TENANT_ID', `${input}.tenantId`),
    hookVar('TENANT_NAME', `${input}.tenantBuild.tenantName`),
  ].join(', ');
  return expr([
    '(',
    `$build := $HMODE = 'cell' ? ${input}.cellBuild : ${input}.tenantBuild;`,
    `$fixed := [\n  ${fixed}\n];`,
    `$deployment := $HMODE = 'tenant' ? [${deployment}] : [];`,
    `$outputs := $PHASE = 'POST' ? [${hookVar('SCRIPT_OUTPUTS', `${input}.scriptOutputs`)}] : [];`,
    '$params := $each($build.parameters, function($v, $k) {{"Name": "PARAM_" & $k, "Type": "PLAINTEXT", "Value": $v}});',
    `$record := ${RECORD_HOOK_ENVIRONMENT};`,
    '$merge([{',
    `  "ProjectName": $HOOK.scope = 'GLOBAL' ? "${buildProjectName(fleetName, 'global-hook')}" : "${buildProjectName(fleetName, 'app-hook')}",`,
    '  "SourceTypeOverride": $HOOK.sourceType,',
    '  "SourceLocationOverride": $HOOK.sourceLocation,',
    `  "BuildspecOverride": ${JSON.stringify(HOOK_BUILDSPEC)},`,
    "  \"EnvironmentVariablesOverride\": $HMODE = 'record' ? $record : $append($append($append($fixed, $deployment), $outputs), $params),",
    '  "TimeoutInMinutesOverride": $HOOK.timeoutMinutes,',
    '  "QueuedTimeoutInMinutesOverride": $Q,',
    '  "IdempotencyToken": $TOKEN',
    "}, $HOOK.sourceVersion != '' ? {\"SourceVersion\": $HOOK.sourceVersion} : {}])",
    ')',
  ].join('\n'));
}

/** What the start task keeps of its result (§8.1): the build id, in variables. The payload is the input. */
export const START_SUCCESS_ASSIGN: Record<string, string> = {
  BUILD_ID: expr('$states.result.Build.Id'),
  BUILD_IDS: expr('$append($BUILD_IDS, $states.result.Build.Id)'),
};

/** A refusal's bounded name and cause, outside the payload (§8.1, R-46). */
export const REFUSAL_CATCH_ASSIGN: Record<string, string> = {
  LAST_REFUSAL: expr('{"name": $states.errorOutput.Error, "cause": $substring($string($states.errorOutput.Cause), 0, 256)}'),
};

const BOUNDED_ERROR = '{"name": $states.errorOutput.Error, "cause": $substring($string($states.errorOutput.Cause), 0, 256)}';

/**
 * A start whose outcome is unknown ends the attempt (R-46): the last error,
 * bounded as a refusal is, and when its last call can have been, because a
 * hidden build may exist and a delete's next attempt waits for it. The
 * `statusReason` keeps the error's name and the start of its cause.
 */
export const START_UNKNOWN_ASSIGN: Record<string, unknown> = {
  LAST_ERROR: expr(BOUNDED_ERROR),
  LAST_CALL_MS: expr(`${ENTERED_MS} + ${START_TRY_BOUND_MS}`),
  OUTCOME: 'NOT_STARTED',
  START_UNKNOWN: true,
  FAIL_KIND: expr('"start outcome unknown (" & $states.errorOutput.Error & ": " & $substring($string($states.errorOutput.Cause), 0, 256) & ")"'),
};

/** The refusal window ends the start after 5 minutes since the first try, or when the next try would pass the deadline (R-46). */
export const REFUSAL_WINDOW_ENDED = `${ENTERED_MS} - $toMillis($FIRST_TRY_AT) >= ${HOOK_REFUSAL_WINDOW_MINUTES * MINUTE_MS} or ${ENTERED_MS} >= $DEADLINE`;

/** The refusal `Choice` rule's assignment: the only place `TRY` advances. */
export const NEXT_TRY_ASSIGN: Record<string, string> = { TRY: expr('$TRY + 1') };

/** The final-poll summary kept in `POLL` (§8.1): the id, the status, the phase timing and `resolvedSourceVersion`, never the environment. */
export const POLL_ASSIGN: Record<string, string> = {
  POLL: expr([
    '(',
    '$b := $states.result.Builds[0];',
    '$exists($b) ? {',
    '  "id": $b.Id,',
    '  "status": $b.BuildStatus,',
    "  \"timedOutPhase\": $b.Phases[PhaseStatus = 'TIMED_OUT'][0].PhaseType,",
    '  "phases": $append([], $b.Phases.{"t": PhaseType, "s": PhaseStatus, "d": DurationInSeconds}),',
    '  "resolvedSourceVersion": $b.ResolvedSourceVersion',
    '} : $POLL',
    ')',
  ].join('\n')),
};

/** The wait before a poll: 60 s, cut to the deadline so the stop starts on it; 15 s while a stop is polled to a final status. */
export const POLL_WAIT_SECONDS = expr(
  `$STOPPING ? 15 : $max([1, $min([${HOOK_POLL_INTERVAL_SECONDS}, $ceil(($DEADLINE - ${ENTERED_MS}) / 1000)])])`,
);

/** `POLL.status` is final. */
export const POLL_IS_FINAL = `$POLL.status in [${FINAL_STATUSES.map((s) => `"${s}"`).join(', ')}]`;

/** What a final poll means for the attempt (R-46): the kind of failure, told queued timeout from run timeout by the phase timing. */
export const BUILD_FINAL_ASSIGN: Record<string, string> = {
  LAST_RESOLVED: expr("$exists($POLL.resolvedSourceVersion) ? $POLL.resolvedSourceVersion : ''"),
  OUTCOME: expr("$POLL.status = 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED'"),
  BUDGET_RAN_OUT: expr("$STOPPING and $DEADLINE_BY = 'budget' and $POLL.status != 'SUCCEEDED'"),
  FAIL_KIND: expr([
    '$STOPPING ? ($DEADLINE_BY = \'budget\' ? "budget ran out, build stopped (" & $POLL.status & ")" : "attempt deadline passed, build stopped (" & $POLL.status & ")")',
    ": $POLL.status = 'TIMED_OUT' ? ($POLL.timedOutPhase = 'QUEUED' ? \"queued timeout, the build never ran\" : \"run timeout in phase \" & ($exists($POLL.timedOutPhase) ? $POLL.timedOutPhase : \"unknown\"))",
    ': "build ended with status " & $POLL.status',
  ].join('\n')),
};

/** The stop's own window (R-46, R-23): 2 minutes from its start, refusals included. */
export const BEGIN_STOP_ASSIGN: Record<string, unknown> = {
  STOPPING: true,
  STOP_DEADLINE: expr(`${ENTERED_MS} + ${HOOK_STOP_BUDGET_MINUTES * MINUTE_MS}`),
};
export const STOP_WINDOW_ENDED = `${ENTERED_MS} >= $STOP_DEADLINE`;

/** The refusal window ended: the hook cannot start; `LAST_REFUSAL` is read by no other ending (R-46). */
export const START_REFUSED_ASSIGN: Record<string, unknown> = {
  OUTCOME: 'NOT_STARTED',
  START_UNKNOWN: false,
  BUDGET_RAN_OUT: expr(`$DEADLINE_BY = 'budget' and ${ENTERED_MS} >= $DEADLINE`),
  FAIL_KIND: expr('"start still refused when its window ended (" & $LAST_REFUSAL.name & ": " & $LAST_REFUSAL.cause & ")"'),
};

export const STOP_NOT_CONFIRMED_ASSIGN: Record<string, unknown> = {
  OUTCOME: 'FAILED',
  NOT_CONFIRMED: true,
  BUDGET_RAN_OUT: expr("$DEADLINE_BY = 'budget'"),
  FAIL_KIND: expr('"build " & $BUILD_ID & " not confirmed stopped"'),
};

/** A hook's entry of `lastGlobalHooks` (R-40): a global hook that started a build; the commit is the final poll's. */
const RUNS_APPENDED =
  "($HOOK.scope = 'GLOBAL' and $count($BUILD_IDS) > 0) ? $append($RUNS, [{\"hookId\": $HOOK_ID, \"phase\": $PHASE, \"revision\": $HOOK.revision, "
  + '"sourceVersion": $HOOK.sourceVersion, "resolvedSourceVersion": $LAST_RESOLVED}]) : $RUNS';

/** The statusReason of a failed create or update hook, or of a skipped delete hook (R-46): scope, hook id, event, phase, build, kind. */
export const HOOK_FAILURE_REASON =
  '"Hook failed: " & $lowercase($HOOK.scope) & " hook " & $HOOK_ID & " (" & $EVENT & " " & $PHASE & ")"'
  + ' & ($BUILD_ID != "" ? ", build " & $BUILD_ID : "") & ": " & $FAIL_KIND';

export const HOOK_SUCCEEDED_ASSIGN: Record<string, string> = { RUNS: expr(RUNS_APPENDED), HI: expr('$HI + 1') };
export const HOOK_FAILED_ASSIGN: Record<string, unknown> = {
  RUNS: expr(RUNS_APPENDED),
  FAILURE_REASON: expr(HOOK_FAILURE_REASON),
  HFAILED: true,
};

/** The skip log (R-46): scope, hook id, event, record, build ids, and whether the budget ran out. */
export const SKIP_LOG_ASSIGN: Record<string, string> = {
  SKIP_LOG: expr([
    '{',
    '"skippedHook": {',
    '  "scope": $HOOK.scope, "hookId": $HOOK_ID, "event": $EVENT, "phase": $PHASE,',
    '  "executionId": $EXECUTION_ID,',
    '  "record": $HMODE = \'record\' ? {"recordType": $states.input.recordEvent.recordType, "recordId": $states.input.recordEvent.recordId}',
    '    : {"applicationId": $states.input.applicationId, "cellId": $states.input.cellId, "tenantId": $states.input.tenantId},',
    '  "buildIds": $BUILD_IDS, "attempt": $ATTEMPT, "budgetRanOut": $BUDGET_RAN_OUT,',
    '  "reason": ' + HOOK_FAILURE_REASON,
    '}}',
  ].join('\n')),
};
export const SKIP_FINISHED_ASSIGN: Record<string, string> = { RUNS: expr(RUNS_APPENDED), HI: expr('$HI + 1') };

/** A delete attempt that started no build and is not unknown: refused for the whole window; the next start follows 60 s (R-46). */
export const DELETE_REFUSED_ONLY = "$OUTCOME = 'NOT_STARTED' and $not($START_UNKNOWN)";
const BACKOFF_MS = `${HOOK_DELETE_BACKOFF_SECONDS * 1000}`;
/** The earliest start of the next attempt after a refusal-only one. */
export const REFUSED_NEXT_AT = `${ENTERED_MS} + ${BACKOFF_MS}`;
/**
 * The earliest start of the next attempt after a counted failure: the backoff
 * of 60 s doubled per failed attempt, and for an unknown start no earlier
 * than q + T after the try's last call, so the next build never runs beside
 * a hidden one (R-46). `$ATTEMPT` is still the failed attempt's.
 */
export const COUNTED_NEXT_AT =
  `$max([${ENTERED_MS} + ${BACKOFF_MS} * $power(${HOOK_DELETE_BACKOFF_RATE}, $ATTEMPT - 1), `
  + `$START_UNKNOWN ? $LAST_CALL_MS + ($Q + $HOOK.timeoutMinutes) * ${MINUTE_MS} : 0])`;
/** No room before the budget's stop margin: the skip is logged with the budget flag. */
export const NEXT_AT_OVER_BUDGET = (nextAt: string) => `${nextAt} >= ${BUDGET_DEADLINE}`;
export const WAIT_NEXT_TIMESTAMP = expr('$fromMillis($NEXT_AT_MS)');

/**
 * The terminal writes' `lastGlobalHooks` (R-40, §8.2) in DynamoDB's own
 * attribute-value form (`L` of `M`), kept in the payload under the same
 * name; empty when none ran. Also drops the finished event's script outputs
 * from the payload (§8.1). The terminal writes read `$.lastGlobalHooks`.
 */
export const STORE_RUNS_OUTPUT = expr([
  '$merge([',
  "$sift($states.input, function($v, $k) {$k != 'scriptOutputs'}),",
  '{"lastGlobalHooks": $append([], $map($RUNS, function($r) {',
  '  {"M": $merge([',
  '    {"hookId": {"S": $r.hookId}, "phase": {"S": $r.phase}, "revision": {"N": $string($r.revision)}},',
  "    $r.sourceVersion != '' ? {\"sourceVersion\": {\"S\": $r.sourceVersion}} : {},",
  "    $r.resolvedSourceVersion != '' ? {\"resolvedSourceVersion\": {\"S\": $r.resolvedSourceVersion}} : {}",
  '  ])}',
  '}))}',
  '])',
].join('\n'));

/** A failed create or update hook hands the failure writes its reason (R-46, §8.2). */
export const FAILURE_EXIT_OUTPUT = expr('$merge([$states.input, {"failureReason": $FAILURE_REASON, "error": {"Error": "HookFailed"}}])');

// ---------------------------------------------------------------------------
// The sub-graph
// ---------------------------------------------------------------------------

export interface HookRunnerProps {
  readonly fleetName: string;
  /** The `cloudwatch:PutMetricData` namespace of the skip count. */
  readonly metricNamespace: string;
}

/** The ways back of the six lists (R-45), wired once the workflow has built its own states. */
export interface HookRunnerExits {
  /** The state a list leads to when it ran: the script (`PRE`) or the success router (`POST`). */
  readonly cellPre: sfn.IChainable;
  readonly cellPost: sfn.IChainable;
  readonly tenantPre: sfn.IChainable;
  readonly tenantPost: sfn.IChainable;
  /** A record event's lists (R-50): the commit takes the script's place (`PRE`), then the success router (`POST`). */
  readonly recordPre: sfn.IChainable;
  readonly recordPost: sfn.IChainable;
  /** The failure write of a failed create or update hook, by build: the cell's, the deployment's or the record's. */
  readonly cellFailure: sfn.IChainable;
  readonly tenantFailure: sfn.IChainable;
  readonly recordFailure: sfn.IChainable;
}

export class HookRunner extends Construct {
  /** The six entry states, one per list (R-45). */
  readonly cellPre: sfn.Pass;
  readonly cellPost: sfn.Pass;
  readonly tenantPre: sfn.Pass;
  readonly tenantPost: sfn.Pass;
  readonly recordPre: sfn.Pass;
  readonly recordPost: sfn.Pass;

  private readonly listContinue: sfn.Choice;
  private readonly failureTarget: sfn.Choice;

  constructor(scope: Construct, id: string, props: HookRunnerProps) {
    super(scope, id);
    const jsonata = (stateId: string, extra: { assign?: Record<string, unknown>; outputs?: unknown } = {}) =>
      sfn.Pass.jsonata(this, stateId, { outputs: '{% $states.input %}', ...extra } as sfn.PassJsonataProps);
    const choice = (stateId: string) => sfn.Choice.jsonata(this, stateId);
    const when = (condition: string) => sfn.Condition.jsonata(expr(condition));

    // --- entries ------------------------------------------------------
    const entry = (stateId: string, kind: HookListKind) => jsonata(stateId, { assign: listBeginAssign(kind) });
    this.cellPre = entry('CellPreHooks', 'cellPre');
    this.cellPost = entry('CellPostHooks', 'cellPost');
    this.tenantPre = entry('TenantPreHooks', 'tenantPre');
    this.tenantPost = entry('TenantPostHooks', 'tenantPost');
    this.recordPre = entry('RecordPreHooks', 'recordPre');
    this.recordPost = entry('RecordPostHooks', 'recordPost');

    // --- the list loop ------------------------------------------------
    const nextHook = choice('NextHook');
    const beginHook = jsonata('BeginHook', { assign: BEGIN_HOOK_ASSIGN });
    const hookSucceeded = jsonata('HookSucceeded', { assign: HOOK_SUCCEEDED_ASSIGN });
    const hookFailedFinal = jsonata('HookFailedFinal', { assign: HOOK_FAILED_ASSIGN });
    const storeRuns = sfn.Pass.jsonata(this, 'StoreHookRuns', { outputs: STORE_RUNS_OUTPUT });
    const listExit = choice('HookListExit');
    const failureExit = sfn.Pass.jsonata(this, 'HookFailureExit', { outputs: FAILURE_EXIT_OUTPUT });
    this.listContinue = choice('HookListContinue');
    this.failureTarget = choice('HookFailureTarget');

    // --- one attempt: start (R-46) -------------------------------------
    const beginAttempt = jsonata('BeginAttempt', { assign: BEGIN_ATTEMPT_ASSIGN });
    const beginTry = jsonata('BeginTry', { assign: BEGIN_TRY_ASSIGN });
    const start = this.hookTask('StartHookBuild', 'arn:aws:states:::codebuild:startBuild', hookStartArguments(props.fleetName), START_SUCCESS_ASSIGN);
    const refusalWait = sfn.Wait.jsonata(this, 'RefusalWait', {
      time: sfn.WaitTime.duration(Duration.seconds(HOOK_REFUSAL_WAIT_SECONDS)),
      outputs: '{% $states.input %}',
    } as sfn.WaitJsonataProps);
    const refusalWindow = choice('RefusalWindow');

    // --- poll and stop -------------------------------------------------
    const pollWait = sfn.Wait.jsonata(this, 'PollWait', {
      time: sfn.WaitTime.seconds(POLL_WAIT_SECONDS),
      outputs: '{% $states.input %}',
    } as sfn.WaitJsonataProps);
    const poll = this.hookTask('PollHookBuild', 'arn:aws:states:::aws-sdk:codebuild:batchGetBuilds', expr('{"Ids": [$BUILD_ID]}'), POLL_ASSIGN);
    const pollRouter = choice('PollRouter');
    const buildFinal = jsonata('BuildFinal', { assign: BUILD_FINAL_ASSIGN });
    const beginStop = jsonata('BeginStop', { assign: BEGIN_STOP_ASSIGN });
    const stop = this.hookTask('StopHookBuild', 'arn:aws:states:::codebuild:stopBuild', expr('{"Id": $BUILD_ID}'), {});
    const stopRefusalWait = sfn.Wait.jsonata(this, 'StopRefusalWait', {
      time: sfn.WaitTime.duration(Duration.seconds(HOOK_REFUSAL_WAIT_SECONDS)),
      outputs: '{% $states.input %}',
    } as sfn.WaitJsonataProps);
    const stopWindow = choice('StopWindow');
    const stopNotConfirmed = jsonata('StopNotConfirmed', { assign: STOP_NOT_CONFIRMED_ASSIGN });

    // --- how an attempt ended ------------------------------------------
    const attemptEnded = choice('AttemptEnded');
    const waitNext = sfn.Wait.jsonata(this, 'WaitNextAttempt', {
      time: sfn.WaitTime.timestamp(WAIT_NEXT_TIMESTAMP),
      outputs: '{% $states.input %}',
    } as sfn.WaitJsonataProps);
    const skipHook = jsonata('SkipHook', { assign: SKIP_LOG_ASSIGN });
    // The count of a skipped delete hook (R-46, T42): an alarm on this metric has no actions.
    const recordSkip = new JsonataCustomState(this, 'RecordHookSkip', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:cloudwatch:putMetricData',
        Arguments: {
          Namespace: props.metricNamespace,
          MetricData: [{ MetricName: HOOK_SKIPPED_METRIC_NAME, Value: 1, Unit: 'Count' }],
        },
        Output: '{% $states.input %}',
      },
    });
    const skipFinished = jsonata('HookSkipFinished', { assign: SKIP_FINISHED_ASSIGN });

    // ===== wiring =======================================================
    for (const begin of [this.cellPre, this.cellPost, this.tenantPre, this.tenantPost, this.recordPre, this.recordPost]) {
      begin.next(nextHook);
    }
    nextHook.when(sfn.Condition.jsonata(expr('$HI >= $count($HOOKS)')), storeRuns).otherwise(beginHook);
    beginHook.next(beginAttempt);
    beginAttempt.next(beginTry);
    beginTry.next(start);

    // The start: refusals loop, an error that may have left a build ends the attempt (R-46).
    start.next(pollWait);
    this.retryAndCatch(start);
    start.addCatch(refusalWait, { errors: [...REFUSAL_ERRORS], assign: REFUSAL_CATCH_ASSIGN, outputs: '{% $states.input %}' });
    start.addCatch(attemptEnded, { errors: [INVALID_INPUT_ERROR], assign: START_UNKNOWN_ASSIGN, outputs: '{% $states.input %}' });
    start.addCatch(attemptEnded, { errors: ['States.ALL'], assign: START_UNKNOWN_ASSIGN, outputs: '{% $states.input %}' });
    refusalWait.next(refusalWindow);
    refusalWindow
      .when(when(REFUSAL_WINDOW_ENDED), attemptEnded, { assign: START_REFUSED_ASSIGN })
      .when(when('true'), beginTry, { assign: NEXT_TRY_ASSIGN });

    // The poll: every 60 s until the build is final or the deadline, then stop (R-46).
    pollWait.next(poll);
    poll.next(pollRouter);
    poll.addCatch(pollRouter, { errors: ['States.ALL'], outputs: '{% $states.input %}' });
    pollRouter
      .when(when(POLL_IS_FINAL), buildFinal)
      .when(when('$STOPPING and ' + STOP_WINDOW_ENDED), stopNotConfirmed)
      .when(when('$not($STOPPING) and ' + `${ENTERED_MS} >= $DEADLINE`), beginStop)
      .otherwise(pollWait);
    buildFinal.next(attemptEnded);
    beginStop.next(stop);
    stop.next(pollWait);
    this.retryAndCatch(stop);
    stop.addCatch(stopRefusalWait, { errors: [...REFUSAL_ERRORS], outputs: '{% $states.input %}' });
    stop.addCatch(stopNotConfirmed, { errors: [INVALID_INPUT_ERROR], outputs: '{% $states.input %}' });
    stop.addCatch(stopNotConfirmed, { errors: ['States.ALL'], outputs: '{% $states.input %}' });
    stopRefusalWait.next(stopWindow);
    stopWindow.when(when(STOP_WINDOW_ENDED), stopNotConfirmed).otherwise(stop);
    stopNotConfirmed.next(attemptEnded);

    // How the attempt ended: create and update stop at the first failure; delete loops (R-46).
    attemptEnded
      .when(when("$OUTCOME = 'SUCCEEDED'"), hookSucceeded)
      .when(when("$HOP != 'delete'"), hookFailedFinal)
      .when(when('$NOT_CONFIRMED or $BUDGET_RAN_OUT'), skipHook)
      .when(when(`${DELETE_REFUSED_ONLY} and ${NEXT_AT_OVER_BUDGET(REFUSED_NEXT_AT)}`), skipHook, { assign: { BUDGET_RAN_OUT: true } })
      .when(when(DELETE_REFUSED_ONLY), waitNext, { assign: { NEXT_AT_MS: expr(REFUSED_NEXT_AT) } })
      .when(when(`$ATTEMPT >= ${HOOK_DELETE_MAX_ATTEMPTS}`), skipHook)
      .when(when(NEXT_AT_OVER_BUDGET(COUNTED_NEXT_AT)), skipHook, { assign: { BUDGET_RAN_OUT: true } })
      .when(when('true'), waitNext, { assign: { ATTEMPT: expr('$ATTEMPT + 1'), NEXT_AT_MS: expr(COUNTED_NEXT_AT) } });
    waitNext.next(beginAttempt);
    skipHook.next(recordSkip);
    recordSkip.next(skipFinished);
    recordSkip.addCatch(skipFinished, { errors: ['States.ALL'], outputs: '{% $states.input %}' });
    skipFinished.next(nextHook);
    hookSucceeded.next(nextHook);

    // Leaving the list.
    hookFailedFinal.next(storeRuns);
    storeRuns.next(listExit);
    listExit.when(when('$HFAILED'), failureExit).otherwise(this.listContinue);
    failureExit.next(this.failureTarget);
  }

  /** Wires the six ways back and the three failure writes (R-45, §8.2, R-50). */
  connect(exits: HookRunnerExits): void {
    this.listContinue
      .when(sfn.Condition.jsonata(expr("$HRET = 'cellPre'")), exits.cellPre)
      .when(sfn.Condition.jsonata(expr("$HRET = 'cellPost'")), exits.cellPost)
      .when(sfn.Condition.jsonata(expr("$HRET = 'tenantPre'")), exits.tenantPre)
      .when(sfn.Condition.jsonata(expr("$HRET = 'recordPre'")), exits.recordPre)
      .when(sfn.Condition.jsonata(expr("$HRET = 'recordPost'")), exits.recordPost)
      .otherwise(exits.tenantPost);
    this.failureTarget
      .when(sfn.Condition.jsonata(expr("$HMODE = 'cell'")), exits.cellFailure)
      .when(sfn.Condition.jsonata(expr("$HMODE = 'record'")), exits.recordFailure)
      .otherwise(exits.tenantFailure);
  }

  /**
   * A request-response hook task (R-46): `TimeoutSeconds` 15, the refusal and
   * `InvalidInputException` names handed to the Catch list at once, and the
   * only task `Retry`: `States.ALL`, 10 s, rate 1, three repeats, no jitter.
   */
  private hookTask(id: string, resource: string, argumentsField: unknown, assign: Record<string, string>): JsonataCustomState {
    return new JsonataCustomState(this, id, {
      stateJson: {
        Type: 'Task',
        Resource: resource,
        TimeoutSeconds: HOOK_TASK_TIMEOUT_SECONDS,
        Arguments: argumentsField,
        ...(Object.keys(assign).length > 0 ? { Assign: assign } : {}),
        Output: '{% $states.input %}',
      },
    });
  }

  private retryAndCatch(task: JsonataCustomState): void {
    task.addRetry({ errors: [...REFUSAL_ERRORS, INVALID_INPUT_ERROR], maxAttempts: 0 });
    task.addRetry({
      errors: ['States.ALL'],
      interval: Duration.seconds(HOOK_RETRY_INTERVAL_SECONDS),
      backoffRate: 1,
      maxAttempts: HOOK_RETRY_MAX_ATTEMPTS,
      jitterStrategy: sfn.JitterType.NONE,
    });
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The record event half of the provisioning workflow (spec §8.4 R-50, R-49,
 * R-22, ADR-045): an execution whose input has a top-level `recordEvent`
 * (`RecordEventWorkflowInput`) runs no build. It runs, in R-45's order, the
 * `PRE` hooks through the one hook sub-graph (`hook.workflow.ts`), the commit
 * in the script's place, the `POST` hooks, then the terminal write:
 *
 * ```
 * RecordPreHooks ─► RecordCommit ─┬─ NONE ───────────────────────────────┐
 *                                 ├─ UPDATE ─► CommitRecordUpdate ──────┤
 *                                 │             └ fail ► ProbeRecordCommitted ─┤ (replay)
 *                                 └─ DELETE ─► CommitRecordDelete ──────┤
 *                                               └ fail ► ProbeRecordDeleted ───┤ (replay)
 *                                                                        ▼
 *                RecordPostHooks ─► RecordSucceeded ─┬─ delete ─► RecordEventDone
 *                                                    └─ SetRecordActive ─► RecordEventDone
 * a failed create or update hook, a failed commit, a failed success write ─► FailRecord
 * any write whose condition fails on another operation (superseded) ─► RecordSuperseded
 * ```
 *
 * Every write is conditioned on the execution's `operationId` (the input's
 * `operationId`, which is also the execution name, R-51) and on the
 * in-flight status. A failed condition is classified by further conditional
 * writes, never by reading the record (R-50 forbids the re-read): a probe
 * whose condition is exactly the replay state and whose write changes
 * nothing. `ProbeRecordCommitted` is `REMOVE pending` on a record that is
 * `UPDATING` under this operation and has no `pending`; `ProbeRecordDeleted`
 * is a `DeleteItem` conditioned on the item not existing. Neither can change
 * the record. Every state here is JSONata.
 */

import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { HookRunner, JsonataCustomState, expr } from './hook.workflow';
import { RECORD_COMMIT_FIELDS, RECORD_COMMIT_REMOVABLE_FIELDS, RECORD_COUNT_ATTRIBUTE } from './record-event.types';

/** The condition-failure names of the DynamoDB integrations (the optimized one and the SDK one spell the service differently). */
export const CONDITION_FAILED_ERRORS: readonly string[] = [
  'DynamoDB.ConditionalCheckFailedException',
  'DynamoDb.ConditionalCheckFailedException',
];

const EVENT = '$states.input.recordEvent';
const VERB = `$substringAfter(${EVENT}.event, '_')`;
/** The in-flight status of the event's verb (§5.6). */
export const IN_FLIGHT_STATUS = `$lookup({"CREATE": "CREATING", "UPDATE": "UPDATING", "DELETE": "DELETING"}, ${VERB})`;
/** The failed status of the event's verb. */
export const FAILED_STATUS = `${VERB} & '_FAILED'`;
const KEY = `{"PK": {"S": ${EVENT}.key.PK}, "SK": {"S": ${EVENT}.key.SK}}`;
const OP = `{"S": ${EVENT}.operationId}`;
const NOW = '{"S": $states.context.State.EnteredTime}';
/** `lastGlobalHooks` in DynamoDB's form, as `StoreHookRuns` left it in the payload (R-40); empty when no list ran. */
const LAST_GLOBAL_HOOKS = '{"L": $exists($states.input.lastGlobalHooks) ? $states.input.lastGlobalHooks : []}';

/**
 * The commit of an update (R-50): one `UpdateItem` that copies each
 * `commit.set` field from `pending`, removes each `commit.remove` field and
 * `pending`, conditioned on `UPDATING`, this `operationId` and
 * `attribute_exists(pending)`. The input names the fields, never their
 * values (§8.1); each name goes into `ExpressionAttributeNames` behind a
 * placeholder, so no name is ever part of the expression text. A name
 * outside the record type's commit fields (`RECORD_COMMIT_FIELDS`,
 * `RECORD_COMMIT_REMOVABLE_FIELDS`) raises, so a malformed input can never
 * write `status`, `operationId`, a counter or `externalId` from `pending`.
 * The commit touches nothing else, not even `updatedAt` (R-29, R-24).
 */
export function commitUpdateArguments(tableName: string): string {
  return expr([
    '(',
    `$type := ${EVENT}.recordType;`,
    `$set := $append([], ${EVENT}.commit.set);`,
    `$remove := $append([], ${EVENT}.commit.remove);`,
    `$allowedSet := $lookup(${JSON.stringify(RECORD_COMMIT_FIELDS)}, $type);`,
    `$allowedRemove := $lookup(${JSON.stringify(RECORD_COMMIT_REMOVABLE_FIELDS)}, $type);`,
    '$bad := $append($set[$not($ in $allowedSet)], $remove[$not($ in $allowedRemove)]);',
    "$count($bad) > 0 ? $error('Commit names a field outside the commit fields of ' & $type);",
    '$setPart := $join($map($set, function($f, $i) {"#s" & $i & " = #pending.#s" & $i}), ", ");',
    '$removePart := $join($append($map($remove, function($f, $i) {"#r" & $i}), ["#pending"]), ", ");',
    '{',
    `  "TableName": ${JSON.stringify(tableName)},`,
    `  "Key": ${KEY},`,
    '  "UpdateExpression": ($count($set) > 0 ? "SET " & $setPart & " " : "") & "REMOVE " & $removePart,',
    '  "ConditionExpression": "#status = :updating AND #op = :op AND attribute_exists(#pending)",',
    '  "ExpressionAttributeNames": $merge($append([{"#status": "status", "#op": "operationId", "#pending": "pending"}],',
    '    $append($map($set, function($f, $i) {{"#s" & $i: $f}}), $map($remove, function($f, $i) {{"#r" & $i: $f}})))),',
    `  "ExpressionAttributeValues": {":updating": {"S": "UPDATING"}, ":op": ${OP}}`,
    '}',
    ')',
  ].join('\n'));
}

/**
 * The replay probe of an update commit (R-50): a record still `UPDATING`
 * under this operation and without `pending` is one whose commit landed.
 * The write is `REMOVE pending` on a record that has none, so it changes
 * nothing; it only succeeds or fails on the condition, atomically.
 */
export function commitReplayProbeArguments(tableName: string): string {
  return expr([
    '{',
    `  "TableName": ${JSON.stringify(tableName)},`,
    `  "Key": ${KEY},`,
    '  "UpdateExpression": "REMOVE #pending",',
    '  "ConditionExpression": "#status = :updating AND #op = :op AND attribute_not_exists(#pending)",',
    '  "ExpressionAttributeNames": {"#status": "status", "#op": "operationId", "#pending": "pending"},',
    `  "ExpressionAttributeValues": {":updating": {"S": "UPDATING"}, ":op": ${OP}}`,
    '}',
  ].join('\n'));
}

/**
 * The commit of a delete (R-49, R-50): delete the record, conditioned on
 * `DELETING`, this `operationId` and its count (`RECORD_COUNT_ATTRIBUTE`)
 * still 0.
 */
export function commitDeleteArguments(tableName: string): string {
  return expr([
    '{',
    `  "TableName": ${JSON.stringify(tableName)},`,
    `  "Key": ${KEY},`,
    '  "ConditionExpression": "#status = :deleting AND #op = :op AND #count = :zero",',
    `  "ExpressionAttributeNames": {"#status": "status", "#op": "operationId", "#count": $lookup(${JSON.stringify(RECORD_COUNT_ATTRIBUTE)}, ${EVENT}.recordType)},`,
    `  "ExpressionAttributeValues": {":deleting": {"S": "DELETING"}, ":op": ${OP}, ":zero": {"N": "0"}}`,
    '}',
  ].join('\n'));
}

/**
 * The replay probe of a delete (R-49): a missing record proves that an
 * earlier identical delete committed (P-11). `DeleteItem` conditioned on the
 * item not existing deletes nothing when it passes and fails on any record.
 */
export function deleteReplayProbeArguments(tableName: string): string {
  return expr([
    '{',
    `  "TableName": ${JSON.stringify(tableName)},`,
    `  "Key": ${KEY},`,
    '  "ConditionExpression": "attribute_not_exists(PK)"',
    '}',
  ].join('\n'));
}

/** The success write (R-50): `CREATING` or `UPDATING` → `ACTIVE` + `lastGlobalHooks`, conditioned on the in-flight status and this operation. */
export function setActiveArguments(tableName: string): string {
  return expr([
    '{',
    `  "TableName": ${JSON.stringify(tableName)},`,
    `  "Key": ${KEY},`,
    '  "UpdateExpression": "SET #status = :active, lastGlobalHooks = :lgh, updatedAt = :now REMOVE statusReason",',
    '  "ConditionExpression": "#status = :inflight AND #op = :op",',
    '  "ExpressionAttributeNames": {"#status": "status", "#op": "operationId"},',
    `  "ExpressionAttributeValues": {":active": {"S": "ACTIVE"}, ":inflight": {"S": ${IN_FLIGHT_STATUS}}, ":op": ${OP}, ":lgh": ${LAST_GLOBAL_HOOKS}, ":now": ${NOW}}`,
    '}',
  ].join('\n'));
}

/**
 * The failure write (R-50): the in-flight status → its `*_FAILED` status +
 * `statusReason` + `lastGlobalHooks`, removing `pending` when it is still
 * there (a `REMOVE` of an absent attribute is a no-op), conditioned on the
 * in-flight status and this operation. The reason is `$.failureReason`,
 * built where the failure was seen.
 */
export function failArguments(tableName: string): string {
  return expr([
    '{',
    `  "TableName": ${JSON.stringify(tableName)},`,
    `  "Key": ${KEY},`,
    '  "UpdateExpression": "SET #status = :failed, statusReason = :reason, lastGlobalHooks = :lgh, updatedAt = :now REMOVE #pending",',
    '  "ConditionExpression": "#status = :inflight AND #op = :op",',
    '  "ExpressionAttributeNames": {"#status": "status", "#op": "operationId", "#pending": "pending"},',
    `  "ExpressionAttributeValues": {":failed": {"S": ${FAILED_STATUS}}, ":inflight": {"S": ${IN_FLIGHT_STATUS}}, ":op": ${OP}, `,
    `    ":reason": {"S": $states.input.failureReason}, ":lgh": ${LAST_GLOBAL_HOOKS}, ":now": ${NOW}}`,
    '}',
  ].join('\n'));
}

/** A caught write error, kept by name only (§8.1: never the raw Cause), for the failure write's reason. */
const KEEP_WRITE_ERROR = (field: string) => expr(`$merge([$states.input, {"${field}": {"Error": $states.errorOutput.Error}}])`);
/** The probe failed too: the commit's own error is the reason. */
const REASON_FROM = (prefix: string, field: string) =>
  expr(`$merge([$states.input, {"failureReason": "${prefix}: " & $states.input.${field}.Error}])`);

export interface RecordEventStatesProps {
  readonly tableName: string;
  readonly hooks: HookRunner;
  /** R-22: the terminal-write retry policy of the cell and deployment writes, applied to every write here. */
  readonly addWriteRetries: (state: sfn.CustomState) => void;
}

/** The record event states (§8.4): `entry` is entered from the workflow's router; the hook sub-graph's record exits are returned for `HookRunner.connect`. */
export interface RecordEventStates {
  /** Where the hook sub-graph's record `PRE` list leads: the commit. */
  readonly afterPre: sfn.IChainable;
  /** Where its record `POST` list leads: the success router. */
  readonly afterPost: sfn.IChainable;
  /** The failure write of a failed create or update hook. */
  readonly failure: sfn.IChainable;
}

export function recordEventStates(scope: Construct, props: RecordEventStatesProps): RecordEventStates {
  const { tableName, hooks } = props;
  const pass = '{% $states.input %}';
  const when = (condition: string) => sfn.Condition.jsonata(expr(condition));
  const write = (id: string, resource: 'updateItem' | 'deleteItem', args: string) => {
    const state = new JsonataCustomState(scope, id, {
      stateJson: { Type: 'Task', Resource: `arn:aws:states:::dynamodb:${resource}`, Arguments: args, Output: pass },
    });
    props.addWriteRetries(state);
    return state;
  };

  const done = new sfn.Succeed(scope, 'RecordEventDone');
  // R-50: a write that lost its condition to another operation, a moved status or a missing record ends here, with no further write or hook.
  const superseded = new sfn.Succeed(scope, 'RecordSuperseded', {
    comment: 'Superseded (R-50): a later request or a compensation replaced this operation; nothing more is written and no hook runs.',
  });

  const fail = write('FailRecord', 'updateItem', failArguments(tableName));
  fail.addCatch(superseded, { errors: [...CONDITION_FAILED_ERRORS], outputs: pass });
  fail.next(done);

  const setActive = write('SetRecordActive', 'updateItem', setActiveArguments(tableName));
  setActive.addCatch(superseded, { errors: [...CONDITION_FAILED_ERRORS], outputs: pass });
  // R-22: retry exhaustion goes through the same conditional failure write.
  setActive.addCatch(fail, { errors: ['States.ALL'], outputs: expr('$merge([$states.input, {"failureReason": "Record terminal write failed: " & $states.errorOutput.Error}])') });
  setActive.next(done);

  const succeeded = sfn.Choice.jsonata(scope, 'RecordSucceeded')
    .when(when(`${VERB} = 'DELETE'`), done)
    .otherwise(setActive);

  // Update: the commit, then its replay probe, then the failure write (which also classifies a superseded record).
  const probeCommitted = write('ProbeRecordCommitted', 'updateItem', commitReplayProbeArguments(tableName));
  probeCommitted.addCatch(fail, { errors: ['States.ALL'], outputs: REASON_FROM('Record commit failed', 'commitError') });
  probeCommitted.next(hooks.recordPost);
  const commitUpdate = write('CommitRecordUpdate', 'updateItem', commitUpdateArguments(tableName));
  commitUpdate.addCatch(probeCommitted, { errors: ['States.ALL'], outputs: KEEP_WRITE_ERROR('commitError') });
  commitUpdate.next(hooks.recordPost);

  // Delete: the commit, then the absence probe, then DELETE_FAILED (R-49) or superseded.
  const probeDeleted = write('ProbeRecordDeleted', 'deleteItem', deleteReplayProbeArguments(tableName));
  probeDeleted.addCatch(fail, { errors: ['States.ALL'], outputs: REASON_FROM('Record delete failed', 'commitError') });
  probeDeleted.next(hooks.recordPost);
  const commitDelete = write('CommitRecordDelete', 'deleteItem', commitDeleteArguments(tableName));
  commitDelete.addCatch(probeDeleted, { errors: ['States.ALL'], outputs: KEEP_WRITE_ERROR('commitError') });
  commitDelete.next(hooks.recordPost);

  // The commit in the script's place (R-50): none on create.
  const commit = sfn.Choice.jsonata(scope, 'RecordCommit')
    .when(when(`${EVENT}.commit.action = 'UPDATE'`), commitUpdate)
    .when(when(`${EVENT}.commit.action = 'DELETE'`), commitDelete)
    .otherwise(hooks.recordPost);

  return { afterPre: commit, afterPost: succeeded, failure: fail };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The API's conditional writes on application, tenant and account records
 * that every record type shares (spec R-48, R-49, R-51, ADR-045): the
 * staging move to `UPDATING`, the move to `DELETING` with its empty check,
 * and the compensations of a workflow start that did not go through. Pure
 * builders; the type-specific create and replace writes of `PutApplication`
 * and `PutAccount` live with their data models.
 */

import { RECORD_COUNT_ATTRIBUTE, RecordType } from './record-event.types';
import { StatusTransition, WriteCondition } from '../shared/repository';
import { LifecycleStatus } from '../smithy/source/typescript-ssdk-codegen/src';

/** The statuses a record may be updated from (R-48): `ACTIVE` (or absent, R-47) and `UPDATE_FAILED`. */
export const RECORD_UPDATABLE_STATUSES: readonly LifecycleStatus[] = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.UPDATE_FAILED,
];

/** The statuses a record may be deleted from (R-49): `ACTIVE` (or absent) and every `*_FAILED` status. */
export const RECORD_DELETABLE_STATUSES: readonly LifecycleStatus[] = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.CREATE_FAILED,
  LifecycleStatus.UPDATE_FAILED,
  LifecycleStatus.DELETE_FAILED,
];

/** The in-flight statuses a record operation writes, and the failed status a compensation moves each to (R-51). */
export type RecordInFlightStatus = 'CREATING' | 'UPDATING' | 'DELETING';
export const RECORD_FAILED_STATUS: Readonly<Record<RecordInFlightStatus, LifecycleStatus>> = {
  CREATING: LifecycleStatus.CREATE_FAILED,
  UPDATING: LifecycleStatus.UPDATE_FAILED,
  DELETING: LifecycleStatus.DELETE_FAILED,
};

/**
 * The record's `operationId` exactly as a request read it:
 * `attribute_not_exists` when it had none (a record from before ADR-045),
 * equality otherwise. Conditions a write on no other operation having been
 * accepted on the record since the read.
 */
export function operationIdAsRead(read: string | undefined): WriteCondition {
  return read === undefined
    ? { conditionExpression: 'attribute_not_exists(#operationId)', expressionAttributeNames: { '#operationId': 'operationId' } }
    : {
      conditionExpression: '#operationId = :readOperationId',
      expressionAttributeNames: { '#operationId': 'operationId' },
      expressionAttributeValues: { ':readOperationId': read },
    };
}

/**
 * The staging write of `UpdateTenant` (R-48): `pending` and the new
 * `operationId` set and the record moved to `UPDATING` in one conditional
 * write on `ACTIVE`/`UPDATE_FAILED` (an absent status read as `ACTIVE`),
 * plus the caller's `extraCondition`. The live fields are not touched.
 * The failed condition returns the item (`ALL_OLD`) for classification
 * (R-14).
 */
export function stageRecordTransition(input: {
  readonly pending: object;
  readonly operationId: string;
  readonly updatedAt: string;
  readonly extraCondition?: WriteCondition;
}): StatusTransition {
  return {
    fromAnyOf: RECORD_UPDATABLE_STATUSES,
    to: LifecycleStatus.UPDATING,
    absentStatusIsActive: true,
    updatedAt: input.updatedAt,
    setFields: { pending: input.pending, operationId: input.operationId },
    removeFields: ['statusReason'],
    extraCondition: input.extraCondition,
    returnCurrentOnFailure: true,
  };
}

/**
 * The move to `DELETING` of `DeleteApplication`, `DeleteTenant` and
 * `DeleteAccount` (R-49): one conditional write on `ACTIVE` or a
 * `*_FAILED` status (an absent status read as `ACTIVE`) AND the record's
 * count still 0 (`cellCount`, or `deploymentCount` for a tenant), storing
 * the operation's new `operationId`. Placement claims only a live record
 * (R-13), so nothing can be counted against the record once it is
 * `DELETING`. The failed condition returns the item (`ALL_OLD`).
 */
export function deleteRecordTransition(recordType: RecordType, operationId: string, updatedAt: string): StatusTransition {
  const count = RECORD_COUNT_ATTRIBUTE[recordType];
  return {
    fromAnyOf: RECORD_DELETABLE_STATUSES,
    to: LifecycleStatus.DELETING,
    absentStatusIsActive: true,
    updatedAt,
    setFields: { operationId },
    removeFields: ['statusReason'],
    extraCondition: {
      conditionExpression: `#${count} = :zero`,
      expressionAttributeNames: { [`#${count}`]: count },
      expressionAttributeValues: { ':zero': 0 },
    },
    returnCurrentOnFailure: true,
  };
}

/**
 * The compensation of a fresh insert whose workflow start was refused
 * (R-51): delete it again, conditioned on `CREATING`, the operation's own
 * `operationId` and its count still 0. No hook ran and nothing can claim a
 * `CREATING` record (R-13), so the delete undoes the request.
 */
export function freshInsertDeleteCondition(recordType: RecordType, operationId: string): WriteCondition {
  const count = RECORD_COUNT_ATTRIBUTE[recordType];
  return {
    conditionExpression: `#status = :creating AND #operationId = :op AND #${count} = :zero`,
    expressionAttributeNames: { '#status': 'status', '#operationId': 'operationId', [`#${count}`]: count },
    expressionAttributeValues: { ':creating': LifecycleStatus.CREATING, ':op': operationId, ':zero': 0 },
  };
}

/**
 * Every other compensation of a start that did not go through (R-51): the
 * in-flight status to its `*_FAILED` status with the reason, conditioned on
 * the operation's own `operationId`. From `UPDATING` it also removes
 * `pending` and is conditioned on `attribute_exists(pending)`, so it never
 * marks failed a change the execution has already committed (R-50); an
 * `externalId` the replace wrote stays (R-48).
 */
export function compensateRecordTransition(input: {
  readonly inFlight: RecordInFlightStatus;
  readonly operationId: string;
  readonly statusReason: string;
  readonly updatedAt: string;
}): StatusTransition {
  const updating = input.inFlight === 'UPDATING';
  return {
    fromAnyOf: [input.inFlight],
    to: RECORD_FAILED_STATUS[input.inFlight],
    updatedAt: input.updatedAt,
    setFields: { statusReason: input.statusReason },
    ...(updating ? { removeFields: ['pending'] } : {}),
    extraCondition: {
      conditionExpression: updating ? '#operationId = :op AND attribute_exists(#pending)' : '#operationId = :op',
      expressionAttributeNames: { '#operationId': 'operationId', ...(updating ? { '#pending': 'pending' } : {}) },
      expressionAttributeValues: { ':op': input.operationId },
    },
  };
}

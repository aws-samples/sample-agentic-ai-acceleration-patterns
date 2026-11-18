// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { expectPlaceholdersMatch } from './expression-placeholders';
import { DataModel, DynamoDBItem } from '../../src/shared/data-model';
import { DynamoDBRepository, StatusTransition } from '../../src/shared/repository';
import {
  compensateRecordTransition,
  deleteRecordTransition,
  freshInsertDeleteCondition,
  operationIdAsRead,
  stageRecordTransition,
} from '../../src/tenant/record-writes';

const ddbMock = mockClient(DynamoDBDocumentClient);
const dataModel: DataModel<DynamoDBItem, DynamoDBItem> = { toItem: (s) => s, fromItem: (i) => i };
const repo = new DynamoDBRepository('table', dataModel, DynamoDBDocumentClient.from(new DynamoDBClient({})));
const OP = 'app-x-application-update-1763460000000-0a1b2c3d';
const NOW = '2026-11-18T00:00:00.000Z';

/** The UpdateItem a transition becomes, as the repository sends it. */
async function sent(transition: StatusTransition) {
  ddbMock.reset();
  ddbMock.on(UpdateCommand).resolves({ Attributes: { PK: 'X', SK: 'META' } });
  await repo.transitionStatus({ PK: 'X', SK: 'META' }, transition);
  const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
  expectPlaceholdersMatch({
    updateExpression: input.UpdateExpression!,
    conditionExpression: input.ConditionExpression,
    expressionAttributeNames: input.ExpressionAttributeNames,
    expressionAttributeValues: input.ExpressionAttributeValues,
  });
  return input;
}

describe('record writes shared by the seven record operations (R-48, R-49, R-51)', () => {
  test('staging: pending and the operationId set, UPDATING from ACTIVE (or absent) or UPDATE_FAILED, live fields untouched', async () => {
    const input = await sent(stageRecordTransition({
      pending: { name: 'renamed' },
      operationId: OP,
      updatedAt: NOW,
      extraCondition: operationIdAsRead('earlier-op'),
    }));
    expect(input.UpdateExpression).toBe(
      'SET #status = :to, #updatedAt = :updatedAt, #pending = :pending, #operationId = :operationId REMOVE #statusReason',
    );
    expect(input.ConditionExpression).toBe(
      '(attribute_not_exists(#status) OR #status IN (:from0, :from1)) AND (#operationId = :readOperationId)',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':to': 'UPDATING', ':from0': 'ACTIVE', ':from1': 'UPDATE_FAILED', ':pending': { name: 'renamed' }, ':operationId': OP,
    });
    expect(input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  test('a record read without an operationId (stored before ADR-045) conditions on attribute_not_exists', () => {
    expect(operationIdAsRead(undefined).conditionExpression).toBe('attribute_not_exists(#operationId)');
  });

  test.each([
    ['APPLICATION', 'cellCount'],
    ['TENANT', 'deploymentCount'],
    ['ACCOUNT', 'cellCount'],
  ] as const)('%s delete: DELETING from ACTIVE (or absent) or a *_FAILED status AND %s = 0, storing the operationId (R-49)', async (type, count) => {
    const input = await sent(deleteRecordTransition(type, OP, NOW));
    expect(input.ConditionExpression).toBe(
      `(attribute_not_exists(#status) OR #status IN (:from0, :from1, :from2, :from3)) AND (#${count} = :zero)`,
    );
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':to': 'DELETING',
      ':from0': 'ACTIVE',
      ':from1': 'CREATE_FAILED',
      ':from2': 'UPDATE_FAILED',
      ':from3': 'DELETE_FAILED',
      ':operationId': OP,
      ':zero': 0,
    });
    expect(input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  test('a refused fresh insert is deleted only while CREATING, under its own operationId, with a count of 0 (R-51)', () => {
    expect(freshInsertDeleteCondition('TENANT', OP)).toEqual({
      conditionExpression: '#status = :creating AND #operationId = :op AND #deploymentCount = :zero',
      expressionAttributeNames: { '#status': 'status', '#operationId': 'operationId', '#deploymentCount': 'deploymentCount' },
      expressionAttributeValues: { ':creating': 'CREATING', ':op': OP, ':zero': 0 },
    });
  });

  test.each([
    ['CREATING', 'CREATE_FAILED'],
    ['DELETING', 'DELETE_FAILED'],
  ] as const)('compensation %s → %s, conditioned on the status and the operationId', async (inFlight, failed) => {
    const input = await sent(compensateRecordTransition({ inFlight, operationId: OP, statusReason: 'refused', updatedAt: NOW }));
    expect(input.UpdateExpression).toBe('SET #status = :to, #updatedAt = :updatedAt, #statusReason = :statusReason');
    expect(input.ConditionExpression).toBe('#status IN (:from0) AND (#operationId = :op)');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':to': failed, ':from0': inFlight, ':op': OP });
  });

  test('compensation UPDATING → UPDATE_FAILED removes pending and needs pending to exist (never undoes a commit)', async () => {
    const input = await sent(compensateRecordTransition({ inFlight: 'UPDATING', operationId: OP, statusReason: 'x', updatedAt: NOW }));
    expect(input.UpdateExpression).toBe('SET #status = :to, #updatedAt = :updatedAt, #statusReason = :statusReason REMOVE #pending');
    expect(input.ConditionExpression).toBe('#status IN (:from0) AND (#operationId = :op AND attribute_exists(#pending))');
    // No externalId is touched: a replace's new id stays (R-48).
    expect(input.UpdateExpression).not.toContain('externalId');
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { DataModel, DynamoDBItem } from '../../src/shared/data-model';
import {
  AccountFullError,
  AmbiguousTransactionError,
  ApplicationGoneError,
  ConditionFailedError,
  DeploymentExistsError,
  DuplicateTokenError,
  DynamoDBRepository,
  PlacementRaceLostError,
  PlacementTransactions,
  RecordGoneError,
  StaleTransitionError,
  TenantGoneError,
} from '../../src/shared/repository';
import { ValidationException } from '../../src/smithy/source/typescript-ssdk-codegen/src';

interface TestSchema {
  id: string;
  name: string;
}

interface TestItem extends DynamoDBItem {
  id: string;
  name: string;
}

const dataModel: DataModel<TestSchema, TestItem> = {
  toItem: (s) => ({ PK: `TEST#${s.id}`, SK: 'META', id: s.id, name: s.name }),
  fromItem: (i) => ({ id: i.id, name: i.name }),
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new DynamoDBRepository<TestSchema, TestItem>('test-table', dataModel, client);

function conditionalCheckFailed(): Error {
  const error = new Error('conditional failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

function transactionCanceled(codes: (string | undefined)[]): Error {
  const error = new Error('transaction canceled');
  error.name = 'TransactionCanceledException';
  (error as any).CancellationReasons = codes.map((code) =>
    code === undefined ? {} : { Code: code },
  );
  return error;
}

beforeEach(() => ddbMock.reset());

describe('DynamoDBRepository', () => {
  test('get converts an item through the data model', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' } });
    expect(await repo.get({ PK: 'TEST#1', SK: 'META' })).toEqual({ id: '1', name: 'a' });
  });

  test('get returns undefined for a missing item', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await repo.get({ PK: 'TEST#1', SK: 'META' })).toBeUndefined();
  });

  test('put writes the converted item', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repo.put({ id: '1', name: 'a' });
    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.Item).toEqual({ PK: 'TEST#1', SK: 'META', id: '1', name: 'a' });
  });

  test('put maps ConditionalCheckFailedException to ConditionFailedError', async () => {
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.put({ id: '1', name: 'a' }, { conditionExpression: 'attribute_not_exists(PK)' }),
    ).rejects.toBeInstanceOf(ConditionFailedError);
  });

  test('update changes selected fields and returns the complete updated schema', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'renamed' },
    });

    const result = await repo.update(
      { PK: 'TEST#1', SK: 'META' },
      {
        updateExpression: 'SET #name = :name',
        conditionExpression: 'attribute_exists(PK)',
        expressionAttributeNames: { '#name': 'name' },
        expressionAttributeValues: { ':name': 'renamed' },
      },
    );

    expect(result).toEqual({ id: '1', name: 'renamed' });
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input).toMatchObject({
      Key: { PK: 'TEST#1', SK: 'META' },
      UpdateExpression: 'SET #name = :name',
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    });
  });

  test('update maps ConditionalCheckFailedException to ConditionFailedError', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.update(
        { PK: 'TEST#1', SK: 'META' },
        {
          updateExpression: 'SET #name = :name',
          conditionExpression: 'attribute_exists(PK)',
          expressionAttributeNames: { '#name': 'name' },
          expressionAttributeValues: { ':name': 'renamed' },
        },
      ),
    ).rejects.toBeInstanceOf(ConditionFailedError);
  });

  test('delete maps ConditionalCheckFailedException to ConditionFailedError', async () => {
    ddbMock.on(DeleteCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.delete({ PK: 'TEST#1', SK: 'META' }, { conditionExpression: '#s = :v' }),
    ).rejects.toBeInstanceOf(ConditionFailedError);
  });
});

describe('DynamoDBRepository.queryIndex', () => {
  test('queries the GSI partition and pages with an opaque token', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ PK: 'TEST#1', SK: 'META', id: '1', name: 'a' }],
      LastEvaluatedKey: { PK: 'TEST#1', SK: 'META', GSI1PK: 'CELL', GSI1SK: 'CELL#1' },
    });

    const page = await repo.queryIndex(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'CELL' } },
      10,
    );

    expect(page.items).toEqual([{ id: '1', name: 'a' }]);
    expect(page.nextToken).toBeDefined();
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      TableName: 'test-table',
      IndexName: 'GSI1',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'GSI1PK' },
      ExpressionAttributeValues: { ':pk': 'CELL' },
      Limit: 10,
    });

    // The token feeds the next query as ExclusiveStartKey
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await repo.queryIndex(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'CELL' } },
      10,
      page.nextToken,
    );
    expect(ddbMock.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual({
      PK: 'TEST#1',
      SK: 'META',
      GSI1PK: 'CELL',
      GSI1SK: 'CELL#1',
    });
  });
});

describe('pagination token validation (malformed nextToken → 400, never 500)', () => {
  const gsiQuery = { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'CELL' } };

  test('an undecodable nextToken throws the modelled ValidationException', async () => {
    await expect(repo.queryIndex(gsiQuery, 10, '%%%not-a-token%%%')).rejects.toBeInstanceOf(
      ValidationException,
    );
    // Never reached DynamoDB — rejected before the query
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test('a decodable but structurally invalid token (non-object) throws the modelled ValidationException', async () => {
    const token = Buffer.from(JSON.stringify(42), 'utf8').toString('base64url');
    await expect(repo.queryIndex(gsiQuery, 10, token)).rejects.toBeInstanceOf(ValidationException);
  });

  test('a parseable token DynamoDB rejects as an invalid ExclusiveStartKey maps to the modelled 400', async () => {
    const ddbValidation = new Error('The provided starting key is invalid');
    ddbValidation.name = 'ValidationException';
    ddbMock.on(QueryCommand).rejects(ddbValidation);
    const forged = Buffer.from(JSON.stringify({ bogus: 'key' }), 'utf8').toString('base64url');
    await expect(repo.queryIndex(gsiQuery, 10, forged)).rejects.toBeInstanceOf(ValidationException);
  });

  test('non-ValidationException query errors still propagate unchanged', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('throttled'));
    await expect(repo.queryIndex(gsiQuery, 10)).rejects.toThrow('throttled');
  });
});

describe('DynamoDBRepository.updateExisting', () => {
  test('guards the write with attribute_exists(PK)', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'renamed' },
    });
    await repo.updateExisting(
      { PK: 'TEST#1', SK: 'META' },
      {
        updateExpression: 'SET #name = :name',
        expressionAttributeNames: { '#name': 'name' },
        expressionAttributeValues: { ':name': 'renamed' },
      },
    );
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(PK)',
    );
  });

  test('ANDs attribute_exists(PK) with a caller condition', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'renamed' },
    });
    await repo.updateExisting(
      { PK: 'TEST#1', SK: 'META' },
      {
        updateExpression: 'SET #name = :name',
        conditionExpression: '#name = :old',
        expressionAttributeNames: { '#name': 'name' },
        expressionAttributeValues: { ':name': 'renamed', ':old': 'a' },
      },
    );
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(PK) AND (#name = :old)',
    );
  });

  test('maps a lost concurrent delete to RecordGoneError (→ 404)', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.updateExisting(
        { PK: 'TEST#1', SK: 'META' },
        {
          updateExpression: 'SET #name = :name',
          expressionAttributeNames: { '#name': 'name' },
          expressionAttributeValues: { ':name': 'renamed' },
        },
      ),
    ).rejects.toBeInstanceOf(RecordGoneError);
  });
});

describe('DynamoDBRepository.transitionStatus', () => {
  test('builds a compare-and-set on the accepted status set', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' },
    });

    await repo.transitionStatus(
      { PK: 'TEST#1', SK: 'META' },
      {
        fromAnyOf: ['ACTIVE', 'UPDATE_FAILED'],
        to: 'UPDATING',
        updatedAt: '2026-09-07T00:00:00.000Z',
      },
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe('SET #status = :to, #updatedAt = :updatedAt');
    expect(input.ConditionExpression).toBe('#status IN (:from0, :from1)');
    expect(input.ExpressionAttributeNames).toEqual({ '#status': 'status', '#updatedAt': 'updatedAt' });
    expect(input.ExpressionAttributeValues).toEqual({
      ':to': 'UPDATING',
      ':updatedAt': '2026-09-07T00:00:00.000Z',
      ':from0': 'ACTIVE',
      ':from1': 'UPDATE_FAILED',
    });
  });

  test('sets and removes additional owned fields', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' },
    });

    await repo.transitionStatus(
      { PK: 'TEST#1', SK: 'META' },
      {
        fromAnyOf: ['CREATING'],
        to: 'ACTIVE',
        updatedAt: '2026-09-07T00:00:00.000Z',
        setFields: { lastBuildId: 'build-1' },
        removeFields: ['statusReason'],
      },
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe(
      'SET #status = :to, #updatedAt = :updatedAt, #lastBuildId = :lastBuildId REMOVE #statusReason',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({ ':lastBuildId': 'build-1' });
    expect(input.ExpressionAttributeNames).toMatchObject({ '#statusReason': 'statusReason' });
  });

  test('ANDs an extra condition — the atomic DeleteCell emptiness guard', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' },
    });

    await repo.transitionStatus(
      { PK: 'TEST#1', SK: 'META' },
      {
        fromAnyOf: ['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
        to: 'DELETING',
        updatedAt: '2026-09-07T00:00:00.000Z',
        extraCondition: {
          conditionExpression: '#tenantCount = :zero',
          expressionAttributeNames: { '#tenantCount': 'tenantCount' },
          expressionAttributeValues: { ':zero': 0 },
        },
      },
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe(
      '#status IN (:from0, :from1, :from2, :from3) AND (#tenantCount = :zero)',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({ ':zero': 0 });
  });

  test('maps a stale transition to StaleTransitionError (→ 409)', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.transitionStatus(
        { PK: 'TEST#1', SK: 'META' },
        { fromAnyOf: ['ACTIVE'], to: 'DELETING', updatedAt: '2026-09-07T00:00:00.000Z' },
      ),
    ).rejects.toBeInstanceOf(StaleTransitionError);
  });
});

describe('DynamoDBRepository.transitionStatus returnCurrentOnFailure (spec R-14, ALL_OLD)', () => {
  const transition = {
    fromAnyOf: ['ACTIVE', 'UPDATE_FAILED'],
    to: 'UPDATING',
    updatedAt: '2026-11-12T00:00:00.000Z',
    setFields: { parameters: { LOG_LEVEL: 'debug' } },
    extraCondition: {
      conditionExpression: '#parameters = :readParameters',
      expressionAttributeNames: { '#parameters': 'parameters' },
      expressionAttributeValues: { ':readParameters': {} },
    },
    returnCurrentOnFailure: true,
  };

  test('asks for ALL_OLD and writes the whole map in one SET, with the map guard ANDed', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' } });
    await repo.transitionStatus({ PK: 'TEST#1', SK: 'META' }, transition);
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
    expect(input.UpdateExpression).toBe('SET #status = :to, #updatedAt = :updatedAt, #parameters = :parameters');
    expect(input.ConditionExpression).toBe('#status IN (:from0, :from1) AND (#parameters = :readParameters)');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':parameters': { LOG_LEVEL: 'debug' }, ':readParameters': {} });
  });

  test('a failed condition carries the item as it was, unmarshalled through the data model', async () => {
    const error = conditionalCheckFailed();
    (error as any).Item = { PK: { S: 'TEST#1' }, SK: { S: 'META' }, id: { S: '1' }, name: { S: 'old' } };
    ddbMock.on(UpdateCommand).rejects(error);
    const failure = await repo.transitionStatus({ PK: 'TEST#1', SK: 'META' }, transition).catch((e) => e);
    expect(failure).toBeInstanceOf(StaleTransitionError);
    expect(failure.current).toEqual({ id: '1', name: 'old' });
  });

  test('no item with the failure means the record is gone: current is undefined', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    const failure = await repo.transitionStatus({ PK: 'TEST#1', SK: 'META' }, transition).catch((e) => e);
    expect(failure).toBeInstanceOf(StaleTransitionError);
    expect(failure.current).toBeUndefined();
  });

  test('without the flag no return value is requested', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' } });
    await repo.transitionStatus({ PK: 'TEST#1', SK: 'META' }, { ...transition, returnCurrentOnFailure: undefined });
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ReturnValuesOnConditionCheckFailure).toBeUndefined();
  });
});

describe('DynamoDBRepository.queryIndex sortKeyPrefix (§4.7: one GSI-3 partition, two item types)', () => {
  test('adds begins_with on the index sort key named after the partition key', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await repo.queryIndex(
      {
        indexName: 'GSI3',
        partitionKey: { name: 'GSI3PK', value: 'APPLICATION#app-x' },
        sortKeyPrefix: 'CELL#',
      },
      25,
    );
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      IndexName: 'GSI3',
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeNames: { '#pk': 'GSI3PK', '#sk': 'GSI3SK' },
      ExpressionAttributeValues: { ':pk': 'APPLICATION#app-x', ':skPrefix': 'CELL#' },
      Limit: 25,
    });
  });

  test('without a prefix the query carries no sort-key condition', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await repo.queryIndex({ indexName: 'GSI2', partitionKey: { name: 'GSI2PK', value: 'TENANT' } });
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.KeyConditionExpression).toBe('#pk = :pk');
    expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'GSI2PK' });
  });
});

describe('DynamoDBRepository.queryPartition (§4.7: a tenant\'s deployments, base table)', () => {
  test('queries the base table partition with a sort-key prefix and no index', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ PK: 'TEST#1', SK: 'META', id: '1', name: 'a' }],
      LastEvaluatedKey: { PK: 'TENANT#t1', SK: 'DEPLOYMENT#app-x' },
    });
    const page = await repo.queryPartition(
      { partitionKey: 'TENANT#t1', sortKeyPrefix: 'DEPLOYMENT#' },
      5,
    );
    expect(page.items).toEqual([{ id: '1', name: 'a' }]);
    expect(page.nextToken).toBeDefined();
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.IndexName).toBeUndefined();
    expect(input).toMatchObject({
      TableName: 'test-table',
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': 'TENANT#t1', ':skPrefix': 'DEPLOYMENT#' },
      Limit: 5,
    });
  });

  test('a malformed nextToken is the modelled 400 here too', async () => {
    await expect(
      repo.queryPartition({ partitionKey: 'TENANT#t1', sortKeyPrefix: 'DEPLOYMENT#' }, 5, '%%%'),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe('PlacementTransactions', () => {
  const cellDataModel: DataModel<{ cellId: string }, DynamoDBItem & { cellId: string }> = {
    toItem: (c) => ({ PK: `CELL#${c.cellId}`, SK: 'META', cellId: c.cellId }),
    fromItem: (i) => ({ cellId: i.cellId }),
  };
  interface TestDeployment {
    tenantId: string;
    applicationId: string;
  }
  const deploymentDataModel: DataModel<TestDeployment, DynamoDBItem & TestDeployment> = {
    toItem: (d) => ({
      PK: `TENANT#${d.tenantId}`,
      SK: `DEPLOYMENT#${d.applicationId}`,
      tenantId: d.tenantId,
      applicationId: d.applicationId,
    }),
    fromItem: (i) => ({ tenantId: i.tenantId, applicationId: i.applicationId }),
  };
  const transactions = new PlacementTransactions(
    'test-table',
    cellDataModel,
    deploymentDataModel,
    client,
  );

  const deployment = { tenantId: 't1', applicationId: 'app-x' };
  const deploymentItem = {
    PK: 'TENANT#t1',
    SK: 'DEPLOYMENT#app-x',
    tenantId: 't1',
    applicationId: 'app-x',
  };

  /** The §7.1 step-2 inputs shared by the claim tests. */
  const placement = {
    cellKey: { PK: 'CELL#c1', SK: 'META' },
    tenantKey: { PK: 'TENANT#t1', SK: 'META' },
    deployment,
    updatedAt: '2026-09-07T00:00:00.000Z',
    clientRequestToken: 'token-t1',
  };

  /** The §7.1 step-3 inputs shared by the new-cell tests. */
  const newCell = {
    accountKey: { PK: 'ACCOUNT#111111111111', SK: 'META' },
    applicationKey: { PK: 'APPLICATION#app-x', SK: 'META' },
    cell: { cellId: 'c-new' },
    tenantKey: { PK: 'TENANT#t1', SK: 'META' },
    deployment,
    updatedAt: '2026-11-09T00:00:00.000Z',
    clientRequestToken: 'token-t1',
  };

  const idempotencyItem = {
    PK: 'IDEMPOTENCY#tok-1',
    SK: 'META',
    clientToken: 'tok-1',
    tenantId: 't1',
    applicationId: 'app-x',
    requestHash: 'abc',
    createdAt: '2026-09-07T00:00:00.000Z',
    expiresAt: 1757203200,
  };

  /** The tenant deploymentCount claim — the same shape in both paths (ADR-037). */
  function expectTenantClaim(update: any, updatedAt: string): void {
    expect(update.Key).toEqual({ PK: 'TENANT#t1', SK: 'META' });
    expect(update.UpdateExpression).toBe(
      'SET #deploymentCount = #deploymentCount + :one, #updatedAt = :updatedAt',
    );
    expect(update.ConditionExpression).toBe('attribute_exists(PK)');
    expect(update.ExpressionAttributeValues).toEqual({ ':one': 1, ':updatedAt': updatedAt });
  }

  describe('placeDeploymentInCell (§7.1 step 2)', () => {
    test('sends cell claim, tenant count claim and deployment insert, in that order', async () => {
      ddbMock.on(TransactWriteCommand).resolves({});
      await transactions.placeDeploymentInCell(placement);

      const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
      expect(input.ClientRequestToken).toBe('token-t1');
      expect(input.TransactItems).toHaveLength(3);

      const cellUpdate = input.TransactItems![0].Update!;
      expect(cellUpdate.Key).toEqual({ PK: 'CELL#c1', SK: 'META' });
      expect(cellUpdate.UpdateExpression).toBe(
        'SET #tenantCount = #tenantCount + :one, #updatedAt = :updatedAt',
      );
      expect(cellUpdate.ConditionExpression).toBe('#status = :active AND #tenantCount < #maxTenants');
      expect(cellUpdate.ExpressionAttributeValues).toMatchObject({ ':one': 1, ':active': 'ACTIVE' });

      expectTenantClaim(input.TransactItems![1].Update!, '2026-09-07T00:00:00.000Z');

      const deploymentPut = input.TransactItems![2].Put!;
      expect(deploymentPut.ConditionExpression).toBe('attribute_not_exists(PK)');
      expect(deploymentPut.Item).toEqual(deploymentItem);
    });

    test('a cell status/capacity cancellation alone is a lost race (next candidate)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        PlacementRaceLostError,
      );
    });

    test('a lost race with undefined reason codes on the other items is still a lost race', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', undefined, undefined]));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        PlacementRaceLostError,
      );
    });

    test('a failed deployment insert is DeploymentExistsError (→ 409), even beside a lost race', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'None', 'ConditionalCheckFailed']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        DeploymentExistsError,
      );
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'ConditionalCheckFailed']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        DeploymentExistsError,
      );
    });

    test('a failed tenant existence claim is TenantGoneError (→ 404)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'ConditionalCheckFailed', 'None']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        TenantGoneError,
      );
    });

    test('a cancellation with no failed condition is ambiguous — never retarget', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'TransactionConflict', 'None']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        AmbiguousTransactionError,
      );
    });

    test('non-cancellation transaction errors are ambiguous — never retarget', async () => {
      ddbMock.on(TransactWriteCommand).rejects(new Error('network sadness'));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        AmbiguousTransactionError,
      );
    });
  });

  describe('createCellWithDeployment (§7.1 step 3, ADR-024, ADR-032, ADR-037)', () => {
    test('sends account claim, application count, cell insert, tenant count, deployment insert', async () => {
      ddbMock.on(TransactWriteCommand).resolves({});
      await transactions.createCellWithDeployment(newCell);

      const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
      expect(input.ClientRequestToken).toBe('token-t1');
      expect(input.TransactItems).toHaveLength(5);

      const accountClaim = input.TransactItems![0].Update!;
      expect(accountClaim.Key).toEqual({ PK: 'ACCOUNT#111111111111', SK: 'META' });
      expect(accountClaim.UpdateExpression).toBe(
        'SET #cellCount = #cellCount + :one, #updatedAt = :updatedAt',
      );
      expect(accountClaim.ConditionExpression).toBe('attribute_exists(PK) AND #cellCount < #maxCells');
      expect(accountClaim.ExpressionAttributeNames).toEqual({
        '#cellCount': 'cellCount',
        '#maxCells': 'maxCells',
        '#updatedAt': 'updatedAt',
      });
      expect(accountClaim.ExpressionAttributeValues).toEqual({
        ':one': 1,
        ':updatedAt': '2026-11-09T00:00:00.000Z',
      });

      // The application counter has no cap — only existence (§7.1)
      const applicationClaim = input.TransactItems![1].Update!;
      expect(applicationClaim.Key).toEqual({ PK: 'APPLICATION#app-x', SK: 'META' });
      expect(applicationClaim.UpdateExpression).toBe(
        'SET #cellCount = #cellCount + :one, #updatedAt = :updatedAt',
      );
      expect(applicationClaim.ConditionExpression).toBe('attribute_exists(PK)');
      expect(applicationClaim.ExpressionAttributeNames).toEqual({
        '#cellCount': 'cellCount',
        '#updatedAt': 'updatedAt',
      });

      const cellPut = input.TransactItems![2].Put!;
      expect(cellPut.Item).toEqual({ PK: 'CELL#c-new', SK: 'META', cellId: 'c-new' });
      expect(cellPut.ConditionExpression).toBe('attribute_not_exists(PK)');

      expectTenantClaim(input.TransactItems![3].Update!, '2026-11-09T00:00:00.000Z');

      const deploymentPut = input.TransactItems![4].Put!;
      expect(deploymentPut.Item).toEqual(deploymentItem);
      expect(deploymentPut.ConditionExpression).toBe('attribute_not_exists(PK)');
    });

    test('a failed account condition alone is AccountFullError (try the next account)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None', 'None', 'None']));
      await expect(transactions.createCellWithDeployment(newCell)).rejects.toBeInstanceOf(
        AccountFullError,
      );
    });

    test('a failed application existence claim is ApplicationGoneError (→ 404)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'ConditionalCheckFailed', 'None', 'None', 'None']));
      await expect(transactions.createCellWithDeployment(newCell)).rejects.toBeInstanceOf(
        ApplicationGoneError,
      );
    });

    test('a failed tenant existence claim is TenantGoneError (→ 404)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'None', 'None', 'ConditionalCheckFailed', 'None']));
      await expect(transactions.createCellWithDeployment(newCell)).rejects.toBeInstanceOf(
        TenantGoneError,
      );
    });

    test('a failed deployment insert is DeploymentExistsError and wins over a full account', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(
          transactionCanceled(['ConditionalCheckFailed', 'None', 'None', 'None', 'ConditionalCheckFailed']),
        );
      await expect(transactions.createCellWithDeployment(newCell)).rejects.toBeInstanceOf(
        DeploymentExistsError,
      );
    });

    test('a failed cell insert is ambiguous, never a full account', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(
          transactionCanceled(['ConditionalCheckFailed', 'None', 'ConditionalCheckFailed', 'None', 'None']),
        );
      await expect(transactions.createCellWithDeployment(newCell)).rejects.toBeInstanceOf(
        AmbiguousTransactionError,
      );
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'None', 'ConditionalCheckFailed', 'None', 'None']));
      await expect(transactions.createCellWithDeployment(newCell)).rejects.toBeInstanceOf(
        AmbiguousTransactionError,
      );
    });

    test('a non-cancellation failure is ambiguous', async () => {
      ddbMock.on(TransactWriteCommand).rejects(new Error('throttled'));
      await expect(transactions.createCellWithDeployment(newCell)).rejects.toBeInstanceOf(
        AmbiguousTransactionError,
      );
    });
  });

  describe('CreateDeployment idempotency (ADR-017, §7.3)', () => {
    test('the idempotency item joins placeDeploymentInCell as the LAST conditional Put', async () => {
      ddbMock.on(TransactWriteCommand).resolves({});
      await transactions.placeDeploymentInCell({ ...placement, idempotencyItem });

      const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
      expect(input.TransactItems).toHaveLength(4);
      const put = input.TransactItems![3].Put!;
      expect(put.Item).toEqual(idempotencyItem);
      expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');
    });

    test('a failed idempotency condition classifies as DuplicateTokenError', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'None', 'None', 'ConditionalCheckFailed']));
      await expect(
        transactions.placeDeploymentInCell({ ...placement, idempotencyItem }),
      ).rejects.toBeInstanceOf(DuplicateTokenError);
    });

    test('a duplicate token wins over every other failure', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(
          transactionCanceled([
            'ConditionalCheckFailed',
            'ConditionalCheckFailed',
            'ConditionalCheckFailed',
            'ConditionalCheckFailed',
          ]),
        );
      await expect(
        transactions.placeDeploymentInCell({ ...placement, idempotencyItem }),
      ).rejects.toBeInstanceOf(DuplicateTokenError);
    });

    test('a lost race with a clean idempotency condition is still a lost race', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None', 'None']));
      await expect(
        transactions.placeDeploymentInCell({ ...placement, idempotencyItem }),
      ).rejects.toBeInstanceOf(PlacementRaceLostError);
    });

    test('without an idempotency item a failed LAST condition is the deployment insert — never a replay', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'None', 'ConditionalCheckFailed']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        DeploymentExistsError,
      );
    });

    test('the idempotency item joins createCellWithDeployment as the LAST conditional Put', async () => {
      ddbMock.on(TransactWriteCommand).resolves({});
      await transactions.createCellWithDeployment({ ...newCell, idempotencyItem });

      const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
      expect(input.TransactItems).toHaveLength(6);
      expect(input.TransactItems![5].Put!.Item).toEqual(idempotencyItem);
      expect(input.TransactItems![5].Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    });

    test('createCellWithDeployment: a duplicate token wins over a simultaneous full account', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(
          transactionCanceled(['ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed']),
        );
      await expect(
        transactions.createCellWithDeployment({ ...newCell, idempotencyItem }),
      ).rejects.toBeInstanceOf(DuplicateTokenError);
    });

    test('createCellWithDeployment: a full account with a clean token is still AccountFullError', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'None']));
      await expect(
        transactions.createCellWithDeployment({ ...newCell, idempotencyItem }),
      ).rejects.toBeInstanceOf(AccountFullError);
    });
  });

  describe('failCreatingCellAndDeployment (§7.4 R-19)', () => {
    const compensation = {
      cellKey: { PK: 'CELL#c-new', SK: 'META' },
      deploymentKey: { PK: 'TENANT#t1', SK: 'DEPLOYMENT#app-x' },
      statusReason: 'StartExecution rejected',
      updatedAt: '2026-09-07T00:00:00.000Z',
    };

    test('sends the paired CREATING→CREATE_FAILED compensation, cell first', async () => {
      ddbMock.on(TransactWriteCommand).resolves({});
      await transactions.failCreatingCellAndDeployment(compensation);

      const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
      expect(input.TransactItems).toHaveLength(2);
      for (const [index, key] of [compensation.cellKey, compensation.deploymentKey].entries()) {
        const update = input.TransactItems![index].Update!;
        expect(update.Key).toEqual(key);
        expect(update.ConditionExpression).toBe('#status = :creating');
        expect(update.UpdateExpression).toBe(
          'SET #status = :failed, #statusReason = :reason, #updatedAt = :updatedAt',
        );
        expect(update.ExpressionAttributeValues).toMatchObject({
          ':failed': 'CREATE_FAILED',
          ':creating': 'CREATING',
          ':reason': 'StartExecution rejected',
        });
      }
    });

    test('maps a condition failure to StaleTransitionError', async () => {
      ddbMock.on(TransactWriteCommand).rejects(transactionCanceled(['None', 'ConditionalCheckFailed']));
      await expect(transactions.failCreatingCellAndDeployment(compensation)).rejects.toBeInstanceOf(
        StaleTransitionError,
      );
    });

    test('maps other failures to AmbiguousTransactionError', async () => {
      ddbMock.on(TransactWriteCommand).rejects(new Error('throttled'));
      await expect(transactions.failCreatingCellAndDeployment(compensation)).rejects.toBeInstanceOf(
        AmbiguousTransactionError,
      );
    });
  });
});

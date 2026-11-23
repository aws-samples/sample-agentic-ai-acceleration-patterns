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
  AccountNotLiveError,
  AmbiguousTransactionError,
  ApplicationGoneError,
  ApplicationNotLiveError,
  attemptToken,
  ConditionFailedError,
  DeploymentExistsError,
  DuplicateTokenError,
  DynamoDBRepository,
  isRaceCancellation,
  PlacementRaceLostError,
  PlacementTransactions,
  RACE_RETRY_ATTEMPTS,
  RecordGoneError,
  StaleTransitionError,
  TenantGoneError,
  TenantNotLiveError,
  TransactionRaceError,
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

/**
 * A cancelled transaction. `items` holds the `ALL_OLD` item a failed member
 * returned, by index, in the low-level attribute-value form DynamoDB sends.
 */
function transactionCanceled(codes: (string | undefined)[], items: Record<number, Record<string, unknown>> = {}): Error {
  const error = new Error('transaction canceled');
  error.name = 'TransactionCanceledException';
  (error as any).CancellationReasons = codes.map((code, index) => ({
    ...(code === undefined ? {} : { Code: code }),
    ...(items[index] === undefined ? {} : { Item: items[index] }),
  }));
  return error;
}

/** A stored record's `ALL_OLD` item with the given status, low-level form. */
const withStatus = (status: string) => ({ PK: { S: 'X' }, status: { S: status } });
/** A record stored before ADR-045: no status, read as ACTIVE (R-47). */
const legacyItem = { PK: { S: 'X' } };

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

  test('update with returnCurrentOnFailure asks for ALL_OLD and carries the item on a StaleTransitionError', async () => {
    const error = conditionalCheckFailed();
    (error as any).Item = { PK: { S: 'TEST#1' }, SK: { S: 'META' }, id: { S: '1' }, name: { S: 'old' } };
    ddbMock.on(UpdateCommand).rejects(error);
    const update = {
      updateExpression: 'SET #name = :name',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeNames: { '#name': 'name' },
      expressionAttributeValues: { ':name': 'renamed' },
    };
    const failure = await repo.update({ PK: 'TEST#1', SK: 'META' }, update, { returnCurrentOnFailure: true }).catch((e) => e);
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
    expect(failure).toBeInstanceOf(StaleTransitionError);
    expect(failure.current).toEqual({ id: '1', name: 'old' });
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

  test('absentStatusIsActive reads an absent status as ACTIVE when ACTIVE is accepted (R-47)', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' } });
    await repo.transitionStatus({ PK: 'TEST#1', SK: 'META' }, { ...transition, absentStatusIsActive: true });
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe(
      '(attribute_not_exists(#status) OR #status IN (:from0, :from1)) AND (#parameters = :readParameters)',
    );
    ddbMock.reset();
    ddbMock.on(UpdateCommand).resolves({ Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' } });
    await repo.transitionStatus({ PK: 'TEST#1', SK: 'META' }, { ...transition, fromAnyOf: ['UPDATING'], absentStatusIsActive: true });
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe(
      '#status IN (:from0) AND (#parameters = :readParameters)',
    );
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
  // The race-retry jitter waits Math.random() * ceiling: 0 ms here.
  beforeEach(() => jest.spyOn(Math, 'random').mockReturnValue(0));
  afterEach(() => jest.restoreAllMocks());

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
    // R-13: only a live tenant (absent status read as ACTIVE) takes a deployment.
    expect(update.ConditionExpression).toBe(
      'attribute_exists(PK) AND (attribute_not_exists(#status) OR #status IN (:live0, :live1, :live2))',
    );
    expect(update.ExpressionAttributeValues).toEqual({
      ':one': 1,
      ':updatedAt': updatedAt,
      ':live0': 'ACTIVE',
      ':live1': 'UPDATING',
      ':live2': 'UPDATE_FAILED',
    });
    expect(update.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
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

    test('a failed tenant claim whose ALL_OLD item exists is TenantNotLiveError (→ 409, R-13)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'ConditionalCheckFailed', 'None'], { 1: withStatus('DELETE_FAILED') }));
      const error = await transactions.placeDeploymentInCell(placement).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TenantNotLiveError);
      expect((error as TenantNotLiveError).status).toBe('DELETE_FAILED');
    });

    test('a race-only cancellation is sent again on the same cell with a new token (ADR-0050)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejectsOnce(transactionCanceled(['None', 'TransactionConflict', 'None']))
        .rejectsOnce(transactionCanceled(['ThrottlingError', 'None', 'None']))
        .resolves({});
      await transactions.placeDeploymentInCell(placement);
      const calls = ddbMock.commandCalls(TransactWriteCommand);
      expect(calls).toHaveLength(3);
      expect(calls.map((call) => call.args[0].input.ClientRequestToken)).toEqual([
        'token-t1',
        'token-t1-r1',
        'token-t1-r2',
      ]);
      // The same candidate every time: a race is not a lost slot.
      const cellKeys = calls.map((call) => call.args[0].input.TransactItems?.[0].Update?.Key);
      expect(new Set(cellKeys.map((key) => JSON.stringify(key))).size).toBe(1);
    });

    test('races on every attempt are a TransactionRaceError, never ambiguous (ADR-0050)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'TransactionConflict', 'None']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        TransactionRaceError,
      );
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(RACE_RETRY_ATTEMPTS);
    });

    test('the jitter waits stay under 50, 100 and 200 ms, and each race logs one line (ADR-0050)', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.9999);
      const delays: number[] = [];
      jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        fn();
        return 0;
      }) as unknown as typeof setTimeout);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'TransactionConflict', 'None']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        TransactionRaceError,
      );
      expect(delays).toHaveLength(RACE_RETRY_ATTEMPTS - 1);
      [50, 100, 200].forEach((ceiling, i) => {
        expect(delays[i]).toBeLessThan(ceiling);
        expect(delays[i]).toBeGreaterThan(ceiling * 0.99);
      });
      expect(warn).toHaveBeenCalledTimes(RACE_RETRY_ATTEMPTS);
      expect(warn.mock.calls[0][0]).toContain('attempt 1 of 4 (reasons None,TransactionConflict,None); sending again');
      expect(warn.mock.calls[RACE_RETRY_ATTEMPTS - 1][0]).toContain('attempts spent');
    });

    test('a client token too long for the retry suffix is refused before the first send', async () => {
      expect(attemptToken('x'.repeat(33), RACE_RETRY_ATTEMPTS - 1)).toHaveLength(36);
      expect(() => attemptToken('x'.repeat(34), 0)).toThrow('race-retry suffix');
      await expect(
        transactions.placeDeploymentInCell({ ...placement, clientRequestToken: 'x'.repeat(34) }),
      ).rejects.toBeInstanceOf(AmbiguousTransactionError);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    test('a conflict beside a failed condition is classified by the condition, not retried', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'TransactionConflict', 'None']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        PlacementRaceLostError,
      );
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    });

    test('a cancellation with every reason None is ambiguous — never retarget', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'None', 'None']));
      await expect(transactions.placeDeploymentInCell(placement)).rejects.toBeInstanceOf(
        AmbiguousTransactionError,
      );
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
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
      expect(accountClaim.ConditionExpression).toBe(
        'attribute_exists(PK) AND #cellCount < #maxCells AND (attribute_not_exists(#status) OR #status IN (:live0, :live1, :live2))',
      );
      expect(accountClaim.ExpressionAttributeNames).toEqual({
        '#cellCount': 'cellCount',
        '#maxCells': 'maxCells',
        '#status': 'status',
        '#updatedAt': 'updatedAt',
      });
      expect(accountClaim.ExpressionAttributeValues).toEqual({
        ':one': 1,
        ':updatedAt': '2026-11-09T00:00:00.000Z',
        ':live0': 'ACTIVE',
        ':live1': 'UPDATING',
        ':live2': 'UPDATE_FAILED',
      });
      expect(accountClaim.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');

      // The application counter has no cap — only existence (§7.1)
      const applicationClaim = input.TransactItems![1].Update!;
      expect(applicationClaim.Key).toEqual({ PK: 'APPLICATION#app-x', SK: 'META' });
      expect(applicationClaim.UpdateExpression).toBe(
        'SET #cellCount = #cellCount + :one, #updatedAt = :updatedAt',
      );
      expect(applicationClaim.ConditionExpression).toBe(
        'attribute_exists(PK) AND (attribute_not_exists(#status) OR #status IN (:live0, :live1, :live2))',
      );
      expect(applicationClaim.ExpressionAttributeNames).toEqual({
        '#cellCount': 'cellCount',
        '#status': 'status',
        '#updatedAt': 'updatedAt',
      });
      expect(applicationClaim.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');

      const cellPut = input.TransactItems![2].Put!;
      expect(cellPut.Item).toEqual({ PK: 'CELL#c-new', SK: 'META', cellId: 'c-new' });
      expect(cellPut.ConditionExpression).toBe('attribute_not_exists(PK)');

      expectTenantClaim(input.TransactItems![3].Update!, '2026-11-09T00:00:00.000Z');

      const deploymentPut = input.TransactItems![4].Put!;
      expect(deploymentPut.Item).toEqual(deploymentItem);
      expect(deploymentPut.ConditionExpression).toBe('attribute_not_exists(PK)');
    });

    test('a failed account condition alone on a live account is AccountFullError (try the next account)', async () => {
      for (const item of [withStatus('ACTIVE'), withStatus('UPDATING'), withStatus('UPDATE_FAILED'), legacyItem]) {
        ddbMock
          .on(TransactWriteCommand)
          .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None', 'None', 'None'], { 0: item }));
        await expect(transactions.createCellWithDeployment(newCell)).rejects.toBeInstanceOf(AccountFullError);
      }
    });

    test.each(['CREATING', 'CREATE_FAILED', 'DELETING', 'DELETE_FAILED'])(
      'a failed account condition on a %s account is AccountNotLiveError carrying the status (R-13, R-14)',
      async (status) => {
        ddbMock
          .on(TransactWriteCommand)
          .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None', 'None', 'None'], { 0: withStatus(status) }));
        const error = await transactions.createCellWithDeployment(newCell).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AccountNotLiveError);
        expect((error as AccountNotLiveError).status).toBe(status);
      },
    );

    test('a failed account condition with no ALL_OLD item is a gone account: AccountNotLiveError without a status', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None', 'None', 'None']));
      const error = await transactions.createCellWithDeployment(newCell).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AccountNotLiveError);
      expect((error as AccountNotLiveError).status).toBeUndefined();
    });

    test('a failed application claim on an item is ApplicationNotLiveError; a failed tenant claim on an item TenantNotLiveError', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'ConditionalCheckFailed', 'None', 'None', 'None'], { 1: withStatus('DELETING') }));
      const application = await transactions.createCellWithDeployment(newCell).catch((e: unknown) => e);
      expect(application).toBeInstanceOf(ApplicationNotLiveError);
      expect((application as ApplicationNotLiveError).status).toBe('DELETING');
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'None', 'None', 'ConditionalCheckFailed', 'None'], { 3: withStatus('CREATING') }));
      const tenant = await transactions.createCellWithDeployment(newCell).catch((e: unknown) => e);
      expect(tenant).toBeInstanceOf(TenantNotLiveError);
      expect((tenant as TenantNotLiveError).status).toBe('CREATING');
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

    test('a race-only cancellation is sent again, then succeeds (ADR-0050)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejectsOnce(transactionCanceled(['TransactionConflict', 'None', 'None', 'ProvisionedThroughputExceeded', 'None']))
        .resolves({});
      await transactions.createCellWithDeployment(newCell);
      const tokens = ddbMock.commandCalls(TransactWriteCommand).map((call) => call.args[0].input.ClientRequestToken);
      expect(tokens).toEqual(['token-t1', 'token-t1-r1']);
    });

    test('races on every attempt are a TransactionRaceError (ADR-0050)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['TransactionConflict', 'None', 'None', 'None', 'None']));
      await expect(transactions.createCellWithDeployment(newCell)).rejects.toBeInstanceOf(
        TransactionRaceError,
      );
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(RACE_RETRY_ATTEMPTS);
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

    test('a race, then a failed idempotency condition on the next attempt, is DuplicateTokenError (ADR-0050)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejectsOnce(transactionCanceled(['None', 'None', 'None', 'TransactionConflict']))
        .rejects(transactionCanceled(['None', 'None', 'None', 'ConditionalCheckFailed']));
      await expect(
        transactions.placeDeploymentInCell({ ...placement, idempotencyItem }),
      ).rejects.toBeInstanceOf(DuplicateTokenError);
      const calls = ddbMock.commandCalls(TransactWriteCommand);
      expect(calls).toHaveLength(2);
      // The retry still carries the idempotency Put, last.
      expect(calls[1].args[0].input.TransactItems?.[3].Put?.Item).toEqual(idempotencyItem);
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
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'None'], { 0: withStatus('ACTIVE') }));
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

    test('a race-only cancellation is sent again, so the records do not stay CREATING (ADR-0050)', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejectsOnce(transactionCanceled(['TransactionConflict', 'None']))
        .rejectsOnce(transactionCanceled(['None', 'TransactionConflict']))
        .resolves({});
      await transactions.failCreatingCellAndDeployment(compensation);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(3);
    });

    test('races on every attempt are a TransactionRaceError', async () => {
      ddbMock.on(TransactWriteCommand).rejects(transactionCanceled(['TransactionConflict', 'None']));
      await expect(transactions.failCreatingCellAndDeployment(compensation)).rejects.toBeInstanceOf(
        TransactionRaceError,
      );
    });
  });

  describe('isRaceCancellation (ADR-0050)', () => {
    test.each([
      [['None', 'TransactionConflict', 'None'], true],
      [['ThrottlingError'], true],
      [['ProvisionedThroughputExceeded', 'TransactionConflict'], true],
      [['None', 'None'], false],
      [['ConditionalCheckFailed', 'TransactionConflict'], false],
      [['ValidationError', 'TransactionConflict'], false],
    ])('%j is a race: %s', (codes, expected) => {
      expect(isRaceCancellation(codes)).toBe(expected);
    });

    test('no cancellation reasons is not a race', () => {
      expect(isRaceCancellation(undefined)).toBe(false);
    });
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The smoke test's stand-in control plane: answers the three reads the
 * registrar makes (`GetCell`, `GetDeployment`, `GetTenant`) from fixture
 * items the smoke writes. The item key is the request path, its `body`
 * the JSON the real control plane would answer. A missing item is the
 * control plane's 404 (`x-amzn-errortype: ResourceNotFoundError`).
 *
 * API Gateway's Cognito authorizer admits only a client-credentials token
 * with the reader scope, so the function sees authenticated calls only.
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddb = new DynamoDBClient({});
const READS = /^\/(cells\/[0-9A-Z]{26}|tenants\/[0-9A-Z]{26}(\/deployments\/[a-z0-9-]{1,32})?)$/;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const path = event.path;
  if (event.httpMethod !== 'GET' || !READS.test(path)) return notFound();
  const out = await ddb.send(new GetItemCommand({ TableName: process.env.FIXTURE_TABLE, Key: { pk: { S: path } } }));
  const body = out.Item?.body?.S;
  if (body === undefined) return notFound();
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body };
};

function notFound(): APIGatewayProxyResult {
  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ResourceNotFoundError' },
    body: '{"message":"not found"}',
  };
}

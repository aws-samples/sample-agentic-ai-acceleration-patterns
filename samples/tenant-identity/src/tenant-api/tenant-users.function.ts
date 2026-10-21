// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { TenantUsersService, type TenantCallerContext } from './tenant-users';
import { ENV, parseTopology, POOL_INDEX_NAME, requireEnv } from '../shared/constants';
import { DynamoDBRegistry } from '../shared/registry';
import { getTenantServiceServiceHandler } from '../smithy/tenant/typescript-ssdk-codegen/src';
import { createProvisioner, type ProvisionerDeps } from '../topology';

/**
 * The `/tenant/users` handler (ADR-0014) — a pass-through, like every function
 * in the sample. It reads the tenant and caller from the authoriser context
 * (never the request, P-11) and dispatches to the generated service handler.
 * Its role holds Cognito user actions only, no pool or group lifecycle action
 * (R-8, P-8).
 *
 * Cold-start wiring reads optional env vars without branching on the topology:
 * `createProvisioner` is the one place a topology value selects behaviour
 * (spec P-1). `sharedPool` and `triggerFunctionArn` are set only in the
 * topologies that use them, so reading them unconditionally is correct.
 */

const region = requireEnv('AWS_REGION');
const topology = parseTopology(requireEnv(ENV.topology));
const tableName = requireEnv(ENV.tableName);

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const registry = new DynamoDBRegistry(tableName, documentClient, process.env[ENV.poolIndexName] ?? POOL_INDEX_NAME);

function readSharedPool(): ProvisionerDeps['sharedPool'] {
  const userPoolId = process.env[ENV.userPoolId];
  const appClientId = process.env[ENV.appClientId];
  if (typeof userPoolId === 'string' && userPoolId !== '' && typeof appClientId === 'string' && appClientId !== '') {
    return { userPoolId, appClientId };
  }
  return undefined;
}

const provisioner = createProvisioner(topology, {
  cognito: new CognitoIdentityProviderClient({}),
  region,
  sharedPool: readSharedPool(),
  triggerFunctionArn: process.env[ENV.triggerFunctionArn],
});

const service = new TenantUsersService(registry, provisioner);
const serviceHandler = getTenantServiceServiceHandler<TenantCallerContext>(service);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const authorizer = event.requestContext.authorizer;
  const tenantId = authorizer?.tenantId;
  const sub = authorizer?.sub;
  if (typeof tenantId !== 'string' || typeof sub !== 'string') {
    // The authoriser guarantees both — absence is an ingress wiring bug.
    return { statusCode: 500, body: JSON.stringify({ message: 'Missing caller context' }) };
  }
  // readonly fields enforce immutability; the object stays extensible so the
  // generated handler can attach bookkeeping (e.g. metricsRecorder).
  const context: TenantCallerContext = { tenantId, sub };
  const response = await serviceHandler.handle(convertEvent(event), context);
  return convertVersion1Response(response);
}

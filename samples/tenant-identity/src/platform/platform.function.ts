// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PlatformContext, PlatformService } from './platform';
import { ENV, parseTopology, requireEnv } from '../shared/constants';
import { DynamoDBRegistry } from '../shared/registry';
import { getPlatformServiceServiceHandler } from '../smithy/platform/typescript-ssdk-codegen/src';
import { createProvisioner } from '../topology';

/**
 * The platform API handler — a pass-through (ADR-0005, context separation):
 * 1. reads the IAM caller ARN from the event for audit logs (N-4)
 * 2. converts the API Gateway event to an HttpRequest
 * 3. dispatches to the Smithy-generated service handler
 *
 * No topology branch lives here (P-1): the optional pool/trigger env vars are
 * read unconditionally and passed to `createProvisioner`, which validates
 * what its topology actually needs. Everything below is built once at cold
 * start.
 */

const topology = parseTopology(process.env[ENV.topology]);
const region = requireEnv('AWS_REGION');

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const registry = new DynamoDBRegistry(
  requireEnv(ENV.tableName),
  documentClient,
  requireEnv(ENV.poolIndexName),
);

const cognito = new CognitoIdentityProviderClient({});

// Read the optional env vars without branching on the topology (P-1). The
// provisioner validates presence of what it needs; absence for the wrong
// topology surfaces there, not here.
const userPoolId = process.env[ENV.userPoolId];
const appClientId = process.env[ENV.appClientId];
const triggerFunctionArn = process.env[ENV.triggerFunctionArn];
const stackName = process.env[ENV.stackName];

const provisioner = createProvisioner(topology, {
  cognito,
  region,
  sharedPool:
    userPoolId !== undefined && appClientId !== undefined ? { userPoolId, appClientId } : undefined,
  triggerFunctionArn,
  stackName,
});

const service = new PlatformService({ registry, provisioner, topology });
const serviceHandler = getPlatformServiceServiceHandler<PlatformContext>(service);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // IAM authorises the route (ADR-0005); the ARN is carried for audit only.
  const context: PlatformContext = { callerArn: event.requestContext.identity?.userArn ?? undefined };
  const httpResponse = await serviceHandler.handle(convertEvent(event), context);
  return convertVersion1Response(httpResponse);
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PlatformContext, PlatformService } from './platform';
import { ENV, parseDeployment, requireEnv } from '../shared/constants';
import { DynamoDBRegistry } from '../shared/registry';
import { ApiGatewayTenantApiKeys } from '../shared/tenant-api-keys';
import { getPlatformServiceServiceHandler } from '../smithy/platform/typescript-ssdk-codegen/src';
import { createProvisioners } from '../topology';

/**
 * The platform API handler — a pass-through (ADR-0005, context separation):
 * 1. reads the IAM caller ARN from the event for audit logs (N-4)
 * 2. converts the API Gateway event to an HttpRequest
 * 3. dispatches to the Smithy-generated service handler
 *
 * No topology branch lives here (P-1): the optional pool/trigger env vars are
 * read unconditionally and passed to `createProvisioners`, which builds the
 * strategy for each topology the deployment offers (one, or both tiers' in
 * `tiered`, ADR-0027) and validates what each actually needs. Everything
 * below is built once at cold start; the service picks a strategy per
 * request from the tenant's registry row.
 */

const deployment = parseDeployment(process.env[ENV.topology]);
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

const provisioners = createProvisioners(deployment, {
  cognito,
  region,
  sharedPool:
    userPoolId !== undefined && appClientId !== undefined ? { userPoolId, appClientId } : undefined,
  triggerFunctionArn,
  stackName,
});

// ADR-0025: per-tenant API keys in the stack's /tenant/* usage plan. The
// plan is found by name at first use (ENV.tenantUsagePlanName explains why).
// The premium plan (ADR-0027) is set by the stack in `tiered` only; read
// unconditionally, the key module refuses a premium key without it.
const apiKeys = new ApiGatewayTenantApiKeys(
  new APIGatewayClient({}),
  requireEnv(ENV.tenantUsagePlanName),
  requireEnv(ENV.stackName),
  process.env[ENV.premiumUsagePlanName],
);

const service = new PlatformService({ registry, provisioners, apiKeys, deployment });
const serviceHandler = getPlatformServiceServiceHandler<PlatformContext>(service);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // IAM authorises the route (ADR-0005); the ARN is carried for audit only.
  const context: PlatformContext = { callerArn: event.requestContext.identity?.userArn ?? undefined };
  const httpResponse = await serviceHandler.handle(convertEvent(event), context);
  return convertVersion1Response(httpResponse);
}

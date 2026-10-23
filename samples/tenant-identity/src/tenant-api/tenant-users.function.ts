// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { perTenant, TenantCredentialCache } from './tenant-credentials';
import { TenantUsersService, type ProvisionerFor, type TenantCallerContext } from './tenant-users';
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
 *
 * ADR-0026: when the stack sets a tenant-scoped role (pool-per-tenant), this
 * function's own role holds no Cognito action. Every Cognito call signs with
 * that role's credentials, assumed per tenant with the authoriser's tenant id
 * as the session tag, so IAM keeps the call inside that tenant's pool. The
 * R-12 and R-13 checks in the service still run (defence in depth). Without
 * the role (shared pools), the function calls Cognito with its own role:
 * IAM cannot scope users inside one pool.
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

const baseDeps: Omit<ProvisionerDeps, 'cognito'> = {
  region,
  sharedPool: readSharedPool(),
  triggerFunctionArn: process.env[ENV.triggerFunctionArn],
};

/** One provisioner for every tenant, or one per tenant on scoped credentials (ADR-0026). */
function buildProvisionerFor(): ProvisionerFor {
  const scopedRoleArn = process.env[ENV.tenantScopedRoleArn];
  if (scopedRoleArn === undefined || scopedRoleArn === '') {
    const shared = createProvisioner(topology, { ...baseDeps, cognito: new CognitoIdentityProviderClient({}) });
    return () => shared;
  }
  const credentials = new TenantCredentialCache({ sts: new STSClient({}), roleArn: scopedRoleArn });
  return perTenant((tenantId) =>
    createProvisioner(topology, {
      ...baseDeps,
      cognito: new CognitoIdentityProviderClient({ credentials: () => credentials.credentialsFor(tenantId) }),
    }),
  );
}

const service = new TenantUsersService(registry, buildProvisionerFor());
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

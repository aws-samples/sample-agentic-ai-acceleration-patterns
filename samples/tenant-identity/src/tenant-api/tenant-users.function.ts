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
import { ENV, parseDeployment, POOL_INDEX_NAME, requireEnv } from '../shared/constants';
import { DynamoDBRegistry } from '../shared/registry';
import { getTenantServiceServiceHandler } from '../smithy/tenant/typescript-ssdk-codegen/src';
import { createProvisioners, type ProvisionerDeps, usesTenantScopedCredentials } from '../topology';

/**
 * The `/tenant/users` handler (ADR-0014) — a pass-through, like every function
 * in the sample. It reads the tenant and caller from the authoriser context
 * (never the request, P-11) and dispatches to the generated service handler.
 * Its role holds Cognito user actions only, no pool or group lifecycle action
 * (R-8, P-8).
 *
 * Cold-start wiring reads optional env vars without branching on the topology:
 * `createProvisioners` is the one place a topology value selects behaviour
 * (spec P-1), and the service asks it for the strategy on each tenant's
 * registry row (ADR-0027). `sharedPool` and `triggerFunctionArn` are set only
 * in the deployments that use them, so reading them unconditionally is
 * correct.
 *
 * ADR-0026: when the stack sets a tenant-scoped role (pool-per-tenant,
 * tiered), this function's own role holds no Cognito action on per-tenant
 * pools. Every Cognito call for a pool-per-tenant tenant signs with that
 * role's credentials, assumed per tenant with the authoriser's tenant id as
 * the session tag, so IAM keeps the call inside that tenant's pool. The R-12
 * and R-13 checks in the service still run (defence in depth). Shared-pool
 * tenants (every tenant in shared-pool*, the standard tier in tiered) are
 * served on the function's own role: IAM cannot scope users inside one pool,
 * so the code-only wall (T-18) applies there.
 */

const region = requireEnv('AWS_REGION');
const deployment = parseDeployment(requireEnv(ENV.topology));
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

/**
 * The strategy for a tenant's row, on the credentials its topology needs.
 * Shared-pool tenants always run on the function's own client. Pool-per-tenant
 * tenants run on scoped credentials when the stack set the role (ADR-0026);
 * without it (a shared-pool* deployment) a pool-per-tenant row is a registry
 * bug, and `createProvisioners` throws (a 500) rather than fall back.
 */
function buildProvisionerFor(): ProvisionerFor {
  const own = createProvisioners(deployment, { ...baseDeps, cognito: new CognitoIdentityProviderClient({}) });
  const scopedRoleArn = process.env[ENV.tenantScopedRoleArn];
  if (scopedRoleArn === undefined || scopedRoleArn === '') {
    return (_tenantId, topology) => own(topology);
  }
  const credentials = new TenantCredentialCache({ sts: new STSClient({}), roleArn: scopedRoleArn });
  const scoped = perTenant((tenantId) =>
    createProvisioners(deployment, {
      ...baseDeps,
      cognito: new CognitoIdentityProviderClient({ credentials: () => credentials.credentialsFor(tenantId) }),
    }),
  );
  return (tenantId, topology) => (usesTenantScopedCredentials(topology) ? scoped(tenantId)(topology) : own(topology));
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

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The entitlement API handler (spec §5.3, C-14). One module, deployed as
 * two functions, one per door (`RI_ENTITLEMENTS_SIDE`):
 *
 * - `vendor`: behind IAM auth on the REST API (SigV4); the caller ARN is
 *   read from the event for audit only.
 * - `tenant-admin`: verifies the identity token itself (the same verifier as
 *   the ingress, refusing a transaction token, P-14), requires the admin
 *   scope (403 `admin_scope_missing`), selects the tenant (`tenant_id`, or
 *   `X-Tenant-Id` among `tenants`), then vends credentials for that tenant
 *   with a `TenantId` session tag (ADR-0033, M-45) and hands the Smithy
 *   service a DynamoDB client built from them.
 *
 * Then it converts the event with `convertEvent` and dispatches to the
 * generated service handler, as tenant-identity does.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { type EntitlementContext, EntitlementServiceImpl } from './entitlements';
import { ENV, isLambdaRuntime, requireEnv } from '../shared/config';
import { headerValue } from '../shared/headers';
import { sharedHandler } from '../shared/http';
import { errorName, log } from '../shared/logger';
import { TENANT_HEADER } from '../shared/tenant';
import { TokenVendingMachine } from '../shared/tvm';
import { bearerToken, TokenError, TokenVerifier } from '../shared/verifier';
import { getEntitlementsServiceHandler } from '../smithy/entitlements/typescript-ssdk-codegen/src';

/** Environment variables of the two entitlement functions. */
export const ENTITLEMENTS_ENV = {
  SIDE: 'RI_ENTITLEMENTS_SIDE',
  ADMIN_SCOPE: 'RI_ENTITLEMENTS_ADMIN_SCOPE',
  MAX_AGENTS: 'RI_ENTITLEMENTS_MAX_AGENTS',
  MAX_TOOLS: 'RI_ENTITLEMENTS_MAX_TOOLS',
  /** The tenant-admin role (tenant-partition writes only), assumed per request with the TenantId tag. */
  TENANT_ADMIN_ROLE_ARN: 'RI_ENTITLEMENTS_TENANT_ADMIN_ROLE_ARN',
} as const;

export interface EntitlementHandlerDependencies {
  readonly side: 'vendor' | 'tenant-admin';
  readonly service: EntitlementServiceImpl;
  readonly verifier?: Pick<TokenVerifier, 'verify'>;
  readonly adminScope?: string;
  /** Builds the tenant-scoped client for one tenant (vends credentials). */
  readonly tenantClient?: (tenantId: string, sub: string) => Promise<DynamoDBDocumentClient>;
}

function refusal(statusCode: 401 | 403 | 400, reason?: string): APIGatewayProxyResult {
  const text = statusCode === 401 ? 'unauthorized' : statusCode === 400 ? 'bad request' : 'forbidden';
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: reason === undefined ? text : `${text}: ${reason}` }),
  };
}

/** The tenant-admin gate: verify, admin scope, tenant. Returns the context, or a refusal. */
export async function tenantAdminContext(
  event: APIGatewayProxyEvent,
  deps: EntitlementHandlerDependencies,
): Promise<EntitlementContext | APIGatewayProxyResult> {
  if (deps.verifier === undefined || deps.tenantClient === undefined || deps.adminScope === undefined) {
    throw new Error('tenant-admin side is not configured');
  }
  let claims;
  try {
    claims = await deps.verifier.verify(bearerToken(headerValue(event.headers, 'authorization')), headerValue(event.headers, TENANT_HEADER));
  } catch (error) {
    if (error instanceof TokenError) {
      log.warn('entitlement request refused', { side: 'tenant-admin', reason: error.reason, status: error.status });
      const publicReason = error.reason === 'tenant_required' || error.reason === 'tenant_not_allowed' ? error.reason : undefined;
      return refusal(error.status, publicReason);
    }
    throw error;
  }
  if (!claims.scopes.includes(deps.adminScope)) {
    log.warn('entitlement request refused', { side: 'tenant-admin', tenantId: claims.tenantId, reason: 'admin_scope_missing', status: 403 });
    return refusal(403, 'admin_scope_missing');
  }
  return {
    side: 'tenant-admin',
    tenantId: claims.tenantId,
    adminSub: claims.sub,
    tenantClient: await deps.tenantClient(claims.tenantId, claims.sub),
  };
}

export async function handleEntitlements(event: APIGatewayProxyEvent, deps: EntitlementHandlerDependencies): Promise<APIGatewayProxyResult> {
  let context: EntitlementContext;
  if (deps.side === 'vendor') {
    // IAM authorises the route; the ARN is carried for audit only.
    context = { side: 'vendor', callerArn: event.requestContext?.identity?.userArn ?? undefined };
  } else {
    const gate = await tenantAdminContext(event, deps);
    if ('statusCode' in gate) {
      return gate;
    }
    context = gate;
  }
  const httpResponse = await getEntitlementsServiceHandler<EntitlementContext>(deps.service).handle(convertEvent(event), context);
  return convertVersion1Response(httpResponse);
}

function defaultDependencies(): EntitlementHandlerDependencies {
  const side = requireEnv(ENTITLEMENTS_ENV.SIDE);
  if (side !== 'vendor' && side !== 'tenant-admin') {
    throw new Error(`${ENTITLEMENTS_ENV.SIDE} must be vendor or tenant-admin`);
  }
  const tableName = requireEnv(ENV.ENTITLEMENTS_TABLE);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ requestHandler: sharedHandler() }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const service = new EntitlementServiceImpl({
    tableName,
    client,
    maxAgentsPerTenant: Number(process.env[ENTITLEMENTS_ENV.MAX_AGENTS] ?? '1000'),
    maxToolsPerTenant: Number(process.env[ENTITLEMENTS_ENV.MAX_TOOLS] ?? '1000'),
  });
  if (side === 'vendor') {
    return { side, service };
  }
  const verifier = new TokenVerifier({
    discoveryUrl: requireEnv(ENV.DISCOVERY_URL),
    allowedClientIds: requireEnv(ENV.ALLOWED_CLIENT_IDS).split(',').map((s) => s.trim()),
    multiTenant: process.env[ENV.MULTI_TENANT] === 'true',
    ownIssuer: process.env[ENV.ISSUER],
  });
  const tvm = new TokenVendingMachine({
    roleArn: requireEnv(ENTITLEMENTS_ENV.TENANT_ADMIN_ROLE_ARN),
    includeUserIdTag: false,
    claimTags: {},
    durationSeconds: 900,
  });
  const tenantClient = async (tenantId: string, sub: string) => {
    const { credentials } = await tvm.vend({ tenantId, sub, clientId: 'entitlements', scopes: [], claims: {} });
    return DynamoDBDocumentClient.from(
      new DynamoDBClient({
        requestHandler: sharedHandler(),
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
          expiration: new Date(credentials.expiration),
        },
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  };
  return { side, service, verifier, adminScope: requireEnv(ENTITLEMENTS_ENV.ADMIN_SCOPE), tenantClient };
}

let deps: EntitlementHandlerDependencies | undefined = isLambdaRuntime() ? defaultDependencies() : undefined;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  deps ??= defaultDependencies();
  try {
    return await handleEntitlements(event, deps);
  } catch (error) {
    log.error('entitlement handler failed', { error: errorName(error) });
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'upstream error' }) };
  }
}

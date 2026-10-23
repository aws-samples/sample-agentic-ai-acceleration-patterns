// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { authorize, stripBearer, type AuthorizeDeps, type Caller, type TokenVerifier } from './tenant-authorizer';
import { ENV, POOL_INDEX_NAME, requireEnv } from '../shared/constants';
import { log } from '../shared/logger';
import { DynamoDBRegistry } from '../shared/registry';

/**
 * The tenant authoriser Lambda (TOKEN type, ADR-0007). It verifies a narrowed
 * admin token on every request — result caching is off in the model
 * (`resultTtlInSeconds: 0`), so the per-request registry read in `authorize`
 * takes effect at once and offboarding stops `/tenant/*` immediately (P-2).
 *
 * Allow → an IAM policy that lets the caller invoke the method, with
 * `{ tenantId, sub }` in the authoriser context and the tenant's API key as
 * `usageIdentifierKey` (ADR-0025). Refuse → an explicit Deny
 * policy; API Gateway answers the client 403 with no reason in the body
 * (spec §5.3). A missing header is a non-bearer header to this handler, so it
 * also refuses: API Gateway then returns 403, which is acceptable for the
 * sample (the alternative, throwing `Unauthorized` for 401, leaks the
 * missing-vs-invalid distinction the spec keeps opaque).
 *
 * Everything below is built once at cold start. The registry is read-only
 * here (R-9): the role holds registry reads and no Cognito action.
 */

// One verifier per (pool id, client id). aws-jwt-verify caches each pool's
// JWKS inside the verifier, so reusing it across invocations avoids
// refetching the keys. M-25: the cache key includes the client id so a
// verifier built for one app client is never reused for another — a verifier
// is bound to the client id it was created with.
const verifiers = new Map<string, TokenVerifier>();

export function verifierFor(userPoolId: string, clientId: string): TokenVerifier {
  const key = `${userPoolId}|${clientId}`;
  const existing = verifiers.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const verifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: 'access',
    clientId,
  }) as unknown as TokenVerifier;
  verifiers.set(key, verifier);
  return verifier;
}

function readSharedPool(): { userPoolId: string; appClientId: string } | undefined {
  const userPoolId = process.env[ENV.userPoolId];
  const appClientId = process.env[ENV.appClientId];
  // Both or neither: a half-set pair is a wiring bug, treated as pool-per-tenant.
  if (typeof userPoolId === 'string' && userPoolId !== '' && typeof appClientId === 'string' && appClientId !== '') {
    return { userPoolId, appClientId };
  }
  return undefined;
}

const tableName = requireEnv(ENV.tableName);
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const deps: AuthorizeDeps = {
  registry: new DynamoDBRegistry(tableName, documentClient, process.env[ENV.poolIndexName] ?? POOL_INDEX_NAME),
  verifierFor,
  sharedPool: readSharedPool(),
};

/** Builds an Allow/Deny policy for the one method that triggered the request. */
export function buildPolicy(methodArn: string, effect: 'Allow' | 'Deny', caller?: Caller): APIGatewayAuthorizerResult {
  return {
    principalId: caller?.sub ?? 'unauthorized',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: methodArn,
        },
      ],
    },
    // The only two values the function may trust (R-9, P-11). Absent on Deny.
    context: caller === undefined ? undefined : { tenantId: caller.tenantId, sub: caller.sub },
    // ADR-0025: the tenant's key, so the usage plan throttles per tenant. The
    // API's key source is AUTHORIZER, so this is the only key API Gateway
    // reads; a client's x-api-key header is ignored. Absent on Deny.
    ...(caller === undefined ? {} : { usageIdentifierKey: caller.usageIdentifierKey }),
  };
}

export async function handler(event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  const token = stripBearer(event.authorizationToken);
  if (token === undefined) {
    log.warn('authorizer refused', { rule: 'missing_or_non_bearer_header' });
    return buildPolicy(event.methodArn, 'Deny');
  }

  let caller: Caller | undefined;
  try {
    caller = await authorize(token, deps);
  } catch (error) {
    // An unexpected failure (e.g. the registry) is not an allow. Deny, and let
    // the error name — never the token — reach the logs.
    log.error('authorizer error', { rule: error instanceof Error ? error.name : 'unknown' });
    return buildPolicy(event.methodArn, 'Deny');
  }

  if (caller === undefined) {
    return buildPolicy(event.methodArn, 'Deny');
  }
  return buildPolicy(event.methodArn, 'Allow', caller);
}

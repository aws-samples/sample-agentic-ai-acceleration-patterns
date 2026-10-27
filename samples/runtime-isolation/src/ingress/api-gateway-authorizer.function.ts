// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * API Gateway Lambda authoriser (spec C-3a, P-3). Verifies the bearer token
 * with the shared verifier and returns Allow with the verified `tenantId`
 * and `sub` as context, so the stage's JSON access log carries the tenant on
 * every request (P-9). Any refusal is an explicit Deny; the body API Gateway
 * returns is its fixed text, never anything from the token.
 *
 * The integration Lambda re-verifies the token itself (one shared pipeline
 * on both ingresses, src/shared/request.ts); this authoriser is the gate
 * that keeps bad tokens from ever starting the streaming Lambda.
 */

import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { readIngressConfig } from '../shared/config';
import { errorName, log } from '../shared/logger';
import { bearerToken, TokenError, TokenVerifier } from '../shared/verifier';

const config = readIngressConfig();
const verifier = new TokenVerifier({
  discoveryUrl: config.discoveryUrl,
  allowedClientIds: config.allowedClientIds,
  requiredScopes: config.requiredScopes,
  requireNarrowedToken: config.delegation.requireNarrowedToken,
  allowedScopes: config.delegation.allowedScopes,
});
// Fetch the discovery document and JWKS during init, at boosted CPU and off
// the first request's path, instead of inside the first verify.
verifier.warm();

/** The policy for one method ARN. Allow carries the tenant context; Deny carries none. */
export function buildPolicy(
  methodArn: string,
  effect: 'Allow' | 'Deny',
  context?: { tenantId: string; sub: string },
): APIGatewayAuthorizerResult {
  return {
    principalId: context?.sub ?? 'unauthorized',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: methodArn }],
    },
    ...(context === undefined ? {} : { context }),
  };
}

function authorizationHeader(event: APIGatewayRequestAuthorizerEvent): string | undefined {
  const headers = event.headers ?? {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization' && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  try {
    const claims = await verifier.verify(bearerToken(authorizationHeader(event)));
    return buildPolicy(event.methodArn, 'Allow', { tenantId: claims.tenantId, sub: claims.sub });
  } catch (error) {
    if (error instanceof TokenError) {
      log.warn('token refused', { ingress: 'api-gateway', component: 'authorizer', reason: error.reason, status: error.status });
    } else {
      log.error('authorizer failed', { ingress: 'api-gateway', component: 'authorizer', error: errorName(error) });
    }
    return buildPolicy(event.methodArn, 'Deny');
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The token authoriser on every `/tenant/*` method (spec §3.2, M-1,
 * ADR-0011). A TOKEN authoriser: API Gateway passes `Authorization` and
 * caches the result per token for 300 s (the revocation lag the README
 * states). It verifies the tenant-identity token contract
 * (src/shared/verifier.ts) and answers:
 *
 * - every refusal: `Unauthorized` (API Gateway's 401), whatever the reason;
 * - otherwise an Allow on `/tenant/*` of this API and stage, the same for
 *   every route (the handler enforces scope per route, M-2), with context
 *   `tenantId`, `sub`, `scope`, and with `tenantThrottle` the tenant's
 *   computed `usageIdentifierKey` (M-5).
 *
 * `authoriserRole` holds logs only: no registry read, no AWS call at all.
 */

import type { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { usageKeyValue } from './usage-key';
import { boolEnv, ENV, requireEnv } from '../shared/constants';
import { errorName, log } from '../shared/logger';
import { bearerToken, TokenError, TokenVerifier, type VerifierDependencies } from '../shared/verifier';

export interface AuthoriserConfig {
  readonly discoveryUrl: string;
  readonly allowedClientIds: string[];
  readonly tenantThrottle: boolean;
  readonly stackId?: string;
}

export function configFromEnv(): AuthoriserConfig {
  const tenantThrottle = boolEnv(ENV.tenantThrottle);
  return {
    discoveryUrl: requireEnv(ENV.discoveryUrl),
    allowedClientIds: requireEnv(ENV.allowedClientIds).split(',').filter((s) => s.length > 0),
    tenantThrottle,
    stackId: tenantThrottle ? requireEnv(ENV.stackId) : undefined,
  };
}

/** `arn:...:execute-api:<region>:<account>:<api>/<stage>/*\/tenant/*` from the method ARN. */
export function tenantRoutesArn(methodArn: string): string {
  const [base, stage] = methodArn.split('/');
  return `${base}/${stage}/*/tenant/*`;
}

export function createAuthoriser(config: AuthoriserConfig, deps: VerifierDependencies = {}) {
  const verifier = new TokenVerifier({ discoveryUrl: config.discoveryUrl, allowedClientIds: config.allowedClientIds }, deps);
  return async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
    let claims;
    try {
      claims = await verifier.verify(bearerToken(event.authorizationToken));
    } catch (error) {
      log.warn('token refused', { operation: 'authorise', reason: error instanceof TokenError ? error.reason : 'verifier_error', errorType: errorName(error) });
      // API Gateway turns exactly this message into a 401.
      throw new Error('Unauthorized');
    }
    log.info('token admitted', { tenantId: claims.tenantId, operation: 'authorise' });
    return {
      principalId: claims.sub,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'execute-api:Invoke', Resource: tenantRoutesArn(event.methodArn) }],
      },
      context: {
        tenantId: claims.tenantId,
        sub: claims.sub,
        scope: claims.scopes.join(' '),
      },
      ...(config.tenantThrottle && config.stackId !== undefined
        ? { usageIdentifierKey: usageKeyValue(config.stackId, claims.tenantId) }
        : {}),
    };
  };
}

let cached: ReturnType<typeof createAuthoriser> | undefined;

export async function handler(event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  cached ??= createAuthoriser(configFromEnv());
  return cached(event);
}

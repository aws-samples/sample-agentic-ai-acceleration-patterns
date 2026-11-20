// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The stand-in agent ingress's REQUEST authoriser (spec §10 step 23,
 * ADR-0024): it verifies the bearer against the `tenant-identity` pool with
 * the demo cell's token check and allows the call when it passes, so the
 * stand-in, like the real ingress, serves no unauthenticated request. Not
 * part of the sample.
 */

import { TokenVerifier } from '../../../src/demo-cell/token';

export interface AuthorizerEvent {
  readonly methodArn: string;
  readonly headers?: Record<string, string | undefined> | null;
}

export interface AuthorizerResult {
  readonly principalId: string;
  readonly policyDocument: { readonly Version: '2012-10-17'; readonly Statement: readonly { Action: string; Effect: 'Allow'; Resource: string }[] };
  readonly context: { readonly tenantId: string };
}

/** Builds the handler around a verifier, so a test passes a local key set. */
export function authorizer(verifier: Pick<TokenVerifier, 'verify'>) {
  return async (event: AuthorizerEvent): Promise<AuthorizerResult> => {
    const header = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? '');
    let tenantId: string;
    try {
      if (match === null) throw new Error('no bearer');
      ({ tenantId } = await verifier.verify(match[1]));
    } catch {
      // API Gateway answers 401 for exactly this error message.
      throw new Error('Unauthorized');
    }
    return {
      principalId: tenantId,
      policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: event.methodArn }] },
      context: { tenantId },
    };
  };
}

let verifier: TokenVerifier | undefined;

/** The Lambda handler: the verifier is made on the first call, from the function's environment. */
export const handler = async (event: AuthorizerEvent): Promise<AuthorizerResult> => {
  verifier ??= new TokenVerifier({
    issuer: process.env.ISSUER ?? '',
    jwksUrl: `${process.env.ISSUER ?? ''}/.well-known/jwks.json`,
    allowedClientIds: (process.env.CLIENT_IDS ?? '').split(',').filter((c) => c !== ''),
    tenantClaim: 'tenant_id',
  });
  return authorizer(verifier)(event);
};

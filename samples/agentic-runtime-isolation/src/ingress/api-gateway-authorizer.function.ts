// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * API Gateway Lambda authoriser (spec C-3a, P-3, ADR-0024; v2, ADR-0030,
 * ADR-0031, ADR-0038). Verifies the identity token with the shared verifier
 * and selects the tenant (`tenant_id`, or `tenants` plus `X-Tenant-Id`),
 * resolves the backend the route names through the registry, then runs the
 * v2 authority step: one `BatchGetItem` for the tenant row and the user's
 * cut row, the grant rule, and the mint (KMS `Sign`, cached). It returns
 * Allow with `{ tenantId, sub, backend, runtimeArn, transactionToken, txn,
 * grantSize, mint }` as context: the stage's JSON access log carries the
 * tenant (P-9), and the integration Lambda forwards the token to the agent.
 * Any refusal is an explicit Deny whose context carries only a fixed reason
 * code, which the `ACCESS_DENIED` gateway response renders (spec §5.1).
 *
 * This function's role is the only one allowed `kms:Sign` on the signing key
 * on this ingress (C-13). API Gateway caches the result per `Authorization`
 * header, `context.path` and, with `identity.multiTenant`, `X-Tenant-Id`
 * (src/shared-ingress.cdk.ts), so one token's Allow for one route and one
 * tenant is never served for another. The cache life is shorter than the
 * mint's reuse margin, so a cached token always has a stream's worth of life
 * left.
 */

import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { AuthorityError, type AuthorityResolver } from '../shared/authority';
import { isLambdaRuntime, readIngressConfig } from '../shared/config';
import { headerValue } from '../shared/headers';
import { errorName, log } from '../shared/logger';
import { BackendRegistry, backendFromPath, isValidBackendName, RegistryError } from '../shared/registry';
import { authorityFor, PUBLIC_REASONS, type RegistryResolver, verifierFor } from '../shared/request';
import { TENANT_HEADER } from '../shared/tenant';
import { bearerToken, TokenError, type TokenVerifier } from '../shared/verifier';

/** What the authoriser needs; the Lambda entry point builds them at init, tests inject them. */
export interface AuthorizerDependencies {
  readonly verifier: Pick<TokenVerifier, 'verify'>;
  readonly registry: RegistryResolver;
  readonly authority: Pick<AuthorityResolver, 'resolve'>;
  /** The backend served at the bare `/invocations` route; undefined when there is none. */
  readonly defaultBackend?: string;
  /** Resolves once init's fetches are done (ADR-0023); the first request awaits it. */
  readonly ready?: Promise<void>;
}

/** The Allow context: every value a string, as API Gateway requires. */
export interface AuthorizerContext {
  readonly tenantId: string;
  readonly sub: string;
  readonly backend: string;
  readonly runtimeArn: string;
  /** (v2) The transaction token for the integration Lambda to forward. Never logged. */
  readonly transactionToken: string;
  readonly txn: string;
  readonly grantSize: string;
  readonly mint: 'hit' | 'miss';
}

/** The policy for one method ARN. Allow carries the context; Deny carries at most a public reason code. */
export function buildPolicy(
  methodArn: string,
  effect: 'Allow' | 'Deny',
  context?: AuthorizerContext,
  reason?: string,
): APIGatewayAuthorizerResult {
  const denyContext = reason !== undefined && PUBLIC_REASONS.has(reason) ? { reason } : undefined;
  return {
    principalId: context?.sub ?? 'unauthorized',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: methodArn }],
    },
    ...(context !== undefined ? { context: { ...context } } : denyContext !== undefined ? { context: denyContext } : {}),
  };
}

/**
 * The backend name of the request. API Gateway fills `pathParameters.backend`
 * for the `/{backend}/invocations` resource; the bare `/invocations` route
 * has no parameter, so the path is read and the default backend applies
 * (ADR-0024). A parameter that is not a valid name is undefined (404).
 */
function backendOf(event: APIGatewayRequestAuthorizerEvent, defaultBackend: string | undefined): string | undefined {
  const parameter = event.pathParameters?.backend;
  if (typeof parameter === 'string' && parameter.length > 0) {
    return isValidBackendName(parameter) ? parameter : undefined;
  }
  return backendFromPath(event.path, defaultBackend);
}

/** The authoriser's logic (unit-tested directly). */
export async function authorize(event: APIGatewayRequestAuthorizerEvent, deps: AuthorizerDependencies): Promise<APIGatewayAuthorizerResult> {
  await deps.ready;
  const fields = { ingress: 'api-gateway', component: 'authorizer' };
  let tenantId: string;
  let sub: string;
  try {
    ({ tenantId, sub } = await deps.verifier.verify(
      bearerToken(headerValue(event.headers, 'authorization')),
      headerValue(event.headers, TENANT_HEADER),
    ));
  } catch (error) {
    if (error instanceof TokenError) {
      log.warn('token refused', { ...fields, reason: error.reason, status: error.status });
      return buildPolicy(event.methodArn, 'Deny', undefined, error.reason);
    }
    log.error('authorizer failed', { ...fields, error: errorName(error) });
    return buildPolicy(event.methodArn, 'Deny');
  }
  const backend = backendOf(event, deps.defaultBackend);
  if (backend === undefined) {
    log.warn('request refused', { ...fields, tenantId, reason: 'unknown_backend', status: 404 });
    return buildPolicy(event.methodArn, 'Deny');
  }
  let entry;
  try {
    entry = await deps.registry.resolve(backend);
  } catch (error) {
    if (error instanceof RegistryError) {
      log.warn('request refused', { ...fields, tenantId, backend, reason: error.reason });
    } else {
      log.error('authorizer failed', { ...fields, tenantId, backend, error: errorName(error) });
    }
    return buildPolicy(event.methodArn, 'Deny');
  }
  // v2: entitlement read, grant rule, mint (spec §3.6). A refusal costs no KMS call.
  try {
    const authority = await deps.authority.resolve(tenantId, sub, backend, entry);
    log.info('request authorised', {
      ...fields,
      tenantId,
      agent: backend,
      txn: authority.txn,
      grantSize: authority.grantSize,
      mint: authority.mint,
      noToolsGranted: authority.noToolsGranted,
    });
    return buildPolicy(event.methodArn, 'Allow', {
      tenantId,
      sub,
      backend,
      runtimeArn: entry.runtimeArn,
      transactionToken: authority.token,
      txn: authority.txn,
      grantSize: String(authority.grantSize),
      mint: authority.mint,
    });
  } catch (error) {
    if (error instanceof AuthorityError) {
      log.warn('request refused', { ...fields, tenantId, backend, reason: error.reason, status: error.status });
      return buildPolicy(event.methodArn, 'Deny', undefined, error.reason);
    }
    log.error('authorizer failed', { ...fields, tenantId, backend, error: errorName(error) });
    return buildPolicy(event.methodArn, 'Deny');
  }
}

// ---------------------------------------------------------------------------
// Lambda entry point. Built at module load: the config read, the verifier's
// discovery and JWKS fetch and the default backend's registry read run during
// init, at boosted CPU and off the first request's path (ADR-0023).
// ---------------------------------------------------------------------------

function defaultDependencies(): AuthorizerDependencies {
  const config = readIngressConfig();
  const verifier = verifierFor(config);
  const registry = new BackendRegistry(config.registry);
  const authority = authorityFor(config);
  if (authority === undefined) {
    throw new Error('The API Gateway authoriser mints the transaction token: RI_TXN_KEY_ID must be set');
  }
  const ready = Promise.all([verifier.warm(), registry.warm(config.registry.defaultBackend)]).then(() => undefined);
  return { verifier, registry, authority, defaultBackend: config.registry.defaultBackend, ready };
}

let deps: AuthorizerDependencies | undefined = isLambdaRuntime() ? defaultDependencies() : undefined;

export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  deps ??= defaultDependencies();
  return authorize(event, deps);
}

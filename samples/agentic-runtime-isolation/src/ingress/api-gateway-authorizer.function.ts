// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * API Gateway Lambda authoriser (spec C-3a, P-3, ADR-0024). Verifies the
 * bearer token with the shared verifier, resolves the backend the route names
 * through the registry and requires one of that backend's scopes (ADR-0025),
 * then returns Allow
 * with `{ tenantId, sub, backend, runtimeArn }` as context, so the stage's
 * JSON access log carries the tenant and the backend on every request (P-9).
 * Any refusal is an explicit Deny; the body API Gateway returns is its fixed
 * text, never anything from the token.
 *
 * The integration Lambda re-runs the same checks itself (one shared pipeline
 * on both ingresses, src/shared/request.ts); this authoriser is the gate
 * that keeps a bad token, an unknown route or a token without the backend's
 * scopes from ever starting the streaming Lambda. API Gateway caches the
 * result per `Authorization` header AND `context.path` (ADR-0015, amended by
 * ADR-0024; src/shared-ingress.cdk.ts), so one token's Allow for one route is
 * never served for another; the policy also names the one method ARN.
 */

import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { readIngressConfig } from '../shared/config';
import { hasAnyScope, headerValue } from '../shared/headers';
import { errorName, log } from '../shared/logger';
import { BackendRegistry, backendFromPath, isValidBackendName, RegistryError } from '../shared/registry';
import type { RegistryResolver } from '../shared/request';
import { bearerToken, TokenError, TokenVerifier } from '../shared/verifier';

/** What the authoriser needs; the Lambda entry point builds them at init, tests inject them. */
export interface AuthorizerDependencies {
  readonly verifier: TokenVerifier;
  readonly registry: RegistryResolver;
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
}

/** The policy for one method ARN. Allow carries the tenant and backend context; Deny carries none. */
export function buildPolicy(methodArn: string, effect: 'Allow' | 'Deny', context?: AuthorizerContext): APIGatewayAuthorizerResult {
  return {
    principalId: context?.sub ?? 'unauthorized',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: methodArn }],
    },
    ...(context === undefined ? {} : { context: { ...context } }),
  };
}

/**
 * The backend name of the request. API Gateway fills `pathParameters.backend`
 * for the `/{backend}/invocations` resource; the bare `/invocations` route of
 * the one-agent form (bare `/invocations`) has no parameter, so the path is read and the
 * default backend applies (ADR-0024). A parameter that is not a valid name is
 * undefined (404), so an arbitrary client segment is never logged or looked up.
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
  let scopes: string[];
  try {
    ({ tenantId, sub, scopes } = await deps.verifier.verify(bearerToken(headerValue(event.headers, 'authorization'))));
  } catch (error) {
    if (error instanceof TokenError) {
      log.warn('token refused', { ...fields, reason: error.reason, status: error.status });
    } else {
      log.error('authorizer failed', { ...fields, error: errorName(error) });
    }
    return buildPolicy(event.methodArn, 'Deny');
  }
  // The route's backend (ADR-0024): unknown or draining is refused here, so
  // the streaming Lambda never starts for a route the registry does not serve.
  const backend = backendOf(event, deps.defaultBackend);
  if (backend === undefined) {
    log.warn('request refused', { ...fields, tenantId, reason: 'unknown_backend', status: 404 });
    return buildPolicy(event.methodArn, 'Deny');
  }
  let runtimeArn: string;
  try {
    const entry = await deps.registry.resolve(backend);
    if (!hasAnyScope(scopes, entry.scopes)) {
      log.warn('request refused', { ...fields, tenantId, backend, reason: 'backend_scope_missing', status: 403 });
      return buildPolicy(event.methodArn, 'Deny');
    }
    runtimeArn = entry.runtimeArn;
  } catch (error) {
    if (error instanceof RegistryError) {
      log.warn('request refused', { ...fields, tenantId, backend, reason: error.reason });
    } else {
      log.error('authorizer failed', { ...fields, tenantId, backend, error: errorName(error) });
    }
    return buildPolicy(event.methodArn, 'Deny');
  }
  return buildPolicy(event.methodArn, 'Allow', { tenantId, sub, backend, runtimeArn });
}

// ---------------------------------------------------------------------------
// Lambda entry point. Built at module load: the config read, the verifier's
// discovery and JWKS fetch and the default backend's registry read run during
// init, at boosted CPU and off the first request's path (ADR-0023). The first
// request awaits `ready`; a failed fetch resolves too and the first call
// retries. A missing or malformed variable fails init, naming it (intended).
// ---------------------------------------------------------------------------

function defaultDependencies(): AuthorizerDependencies {
  const config = readIngressConfig();
  const verifier = new TokenVerifier({
    discoveryUrl: config.discoveryUrl,
    allowedClientIds: config.allowedClientIds,
    requiredScopes: config.requiredScopes,
    requireNarrowedToken: config.delegation.requireNarrowedToken,
    allowedScopes: config.delegation.allowedScopes,
  });
  const registry = new BackendRegistry(config.registry);
  const ready = Promise.all([verifier.warm(), registry.warm(config.registry.defaultBackend)]).then(() => undefined);
  return { verifier, registry, defaultBackend: config.registry.defaultBackend, ready };
}

const deps = defaultDependencies();

export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  return authorize(event, deps);
}

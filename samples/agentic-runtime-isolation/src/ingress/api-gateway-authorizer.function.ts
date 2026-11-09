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
import { type DelegationConfig, isLambdaRuntime, readIngressConfig } from '../shared/config';
import type { DelegationCaller, DelegationTokenVerifier } from '../shared/delegation';
import { headerValue } from '../shared/headers';
import { errorName, log } from '../shared/logger';
import { BackendRegistry, backendFromPath, DELEGATION_ROUTE, isValidBackendName, type RegistryEntry, RegistryError, routeFromPath } from '../shared/registry';
import { authorityFor, delegationVerifierFor, PUBLIC_REASONS, type RegistryResolver, verifierFor } from '../shared/request';
import { TENANT_HEADER } from '../shared/tenant';
import { bearerToken, TokenError, type TokenVerifier } from '../shared/verifier';

/** What the authoriser needs; the Lambda entry point builds them at init, tests inject them. */
export interface AuthorizerDependencies {
  readonly verifier: Pick<TokenVerifier, 'verify'>;
  readonly registry: RegistryResolver;
  readonly authority: Pick<AuthorityResolver, 'resolve' | 'delegate'> | Pick<AuthorityResolver, 'resolve'>;
  /** The backend served at the bare `/invocations` route; undefined when there is none. */
  readonly defaultBackend?: string;
  /** (ADR-0048) The delegation module and the caller-token verifier; both present or both absent. */
  readonly delegation?: { readonly config: DelegationConfig; readonly verify: DelegationTokenVerifier };
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
  /** (ADR-0048) On the delegation route: the calling agent and the chain length after this hop. */
  readonly delegatedFrom?: string;
  readonly depth?: string;
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

/** Whether the event is for `/{backend}/delegations` (ADR-0048); the target is the path parameter. */
function delegationTarget(event: APIGatewayRequestAuthorizerEvent): string | undefined {
  const route = routeFromPath(event.path);
  return route?.route === DELEGATION_ROUTE ? route.backend : undefined;
}

/**
 * (ADR-0048, spec §3.7, §5.1.1) The delegation route: the bearer is a
 * transaction token this ingress minted; the caller's and the target's
 * registry entries are read; the authority step runs the three delegation
 * checks and mints the replacement token. The Allow context carries the
 * target as `backend`, plus `delegatedFrom` and `depth`.
 */
async function authorizeDelegation(
  event: APIGatewayRequestAuthorizerEvent,
  target: string,
  deps: AuthorizerDependencies,
): Promise<APIGatewayAuthorizerResult> {
  const fields = { ingress: 'api-gateway', component: 'authorizer', route: DELEGATION_ROUTE };
  if (deps.delegation === undefined || !('delegate' in deps.authority)) {
    // The route exists only with the module; a request here without it is a deployment fault.
    log.error('delegation refused', { ...fields, to: target, reason: 'delegation_unavailable', status: 502 });
    return buildPolicy(event.methodArn, 'Deny');
  }
  let caller: DelegationCaller;
  try {
    caller = await deps.delegation.verify(bearerToken(headerValue(event.headers, 'authorization')));
  } catch {
    log.warn('delegation refused', { ...fields, to: target, reason: 'token_invalid', status: 401 });
    return buildPolicy(event.methodArn, 'Deny');
  }
  const attributed = { ...fields, tenantId: caller.tenantId, from: caller.agent, to: target, depth: caller.chain.length + 1, txn: caller.txn };
  const entries: RegistryEntry[] = [];
  for (const name of [caller.agent, target]) {
    try {
      entries.push(await deps.registry.resolve(name));
    } catch (error) {
      if (error instanceof RegistryError) {
        log.warn('delegation refused', { ...attributed, backend: name, reason: error.reason });
      } else {
        log.error('authorizer failed', { ...attributed, backend: name, error: errorName(error) });
      }
      return buildPolicy(event.methodArn, 'Deny');
    }
  }
  const [callerEntry, targetEntry] = entries;
  try {
    const authority = await deps.authority.delegate(caller, target, targetEntry, callerEntry, deps.delegation.config.maxDepth);
    log.info('delegation admitted', { ...attributed, grantSize: authority.grantSize, noToolsGranted: authority.noToolsGranted });
    return buildPolicy(event.methodArn, 'Allow', {
      tenantId: caller.tenantId,
      sub: caller.sub,
      backend: target,
      runtimeArn: targetEntry.runtimeArn,
      transactionToken: authority.token,
      txn: authority.txn,
      grantSize: String(authority.grantSize),
      mint: authority.mint,
      delegatedFrom: caller.agent,
      depth: String(caller.chain.length + 1),
    });
  } catch (error) {
    if (error instanceof AuthorityError) {
      log.warn('delegation refused', { ...attributed, reason: error.reason, status: error.status });
      return buildPolicy(event.methodArn, 'Deny', undefined, error.reason);
    }
    log.error('authorizer failed', { ...attributed, error: errorName(error) });
    return buildPolicy(event.methodArn, 'Deny');
  }
}

/** The authoriser's logic (unit-tested directly). */
export async function authorize(event: APIGatewayRequestAuthorizerEvent, deps: AuthorizerDependencies): Promise<APIGatewayAuthorizerResult> {
  await deps.ready;
  // ADR-0048: `/<target>/delegations` takes a transaction token, never an identity token.
  const target = delegationTarget(event);
  if (target !== undefined) {
    return authorizeDelegation(event, target, deps);
  }
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
    // The transaction token rides in the Allow `context`. Spike V-17
    // (2026-11-04) settled the bound: the REQUEST authoriser context carried
    // 24,000 bytes intact to the integration, cached and uncached, so it is
    // not a limit (and it is not a header, so the 20,480-byte client header
    // quota does not apply). The limit is the Runtime's: InvokeAgentRuntime
    // refuses a custom header value over 10,240 bytes, and api-gateway-ingress
    // forwards this token in one. The mint enforces it (MAX_TOKEN_BYTES,
    // src/shared/mint.ts, ADR-0045): a larger token is refused here with
    // grant_too_large and never reaches the context.
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
  const verify = delegationVerifierFor(config);
  const delegation = config.delegation === undefined || verify === undefined ? undefined : { config: config.delegation, verify };
  return { verifier, registry, authority, defaultBackend: config.registry.defaultBackend, ready, delegation };
}

let deps: AuthorizerDependencies | undefined = isLambdaRuntime() ? defaultDependencies() : undefined;

export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  deps ??= defaultDependencies();
  return authorize(event, deps);
}

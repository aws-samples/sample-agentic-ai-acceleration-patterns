// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingress pipeline (spec §3.4, §3.6, §5.1), shared by the API Gateway
 * integration Lambda and the AgentCore Gateway REQUEST interceptor so both
 * ingresses enforce one contract. Check order (spec §5.1): verify the
 * identity token and select the tenant (P-3, ADR-0038), the floor scopes
 * (ADR-0005), the registry entry (ADR-0024), the per-tenant limit
 * (ADR-0020), (v2) the entitlement read, the grant rule and the mint
 * (P-11, P-14), the unit (P-2) and the TVM (P-8). A refused request costs no
 * KMS call and no STS call.
 *
 * On `api-gateway` the authoriser has already run the authority step and
 * minted; the integration Lambda receives the token through the authoriser
 * context (`RequestInputs.authorized`) and only checks it is for the tenant
 * and backend it verified itself. On `agentcore-gateway` the interceptor
 * runs every step here. The output is a ValidatedRequest; nothing here knows
 * how the backend is invoked.
 */

import { KMSClient } from '@aws-sdk/client-kms';
import { createLocalJWKSet, createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { AuthorityError, AuthorityResolver, checkDelegation } from './authority';
import type { IngressConfig } from './config';
import { type DelegationCaller, type DelegationTokenVerifier, delegationTokenVerifierFor } from './delegation';
import { EntitlementReader } from './entitlements';
import { endpointHost, preconnect, sharedHandler } from './http';
import { kmsDigestSigner } from './jws';
import { TenantLimiter } from './limits';
import { AGENT_AUDIENCE_PREFIX, sameActChain, TokenMinter } from './mint';
import { BackendRegistry, backendFromPath, DELEGATION_ROUTE, type RegistryEntry, RegistryError, type RegistryMiss, ROUTE, routeFromPath } from './registry';
import { isValidConversationId, randomUnitId, sessionUnitId } from './session';
import { ClaimMissingError, TokenVendingMachine } from './tvm';
import { bearerToken, TokenError, TokenVerifier, type VerifiedClaims } from './verifier';
import type { ValidatedRequest } from '../backend/backend';

/** Fixed response bodies (spec §5): never echo the token, the unit id or the input. */
export type ErrorStatus = 400 | 401 | 403 | 404 | 429 | 502;

export const ERROR_TEXT: Record<ErrorStatus, string> = {
  400: 'bad request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not found',
  429: 'too many requests',
  502: 'upstream error',
};

/** The v2 reason codes a refusal body carries after its text (spec §5.1, for example `forbidden: agent_not_subscribed`). */
export const PUBLIC_REASONS: ReadonlySet<string> = new Set([
  'tenant_required',
  'tenant_not_allowed',
  'tenant_suspended',
  'agent_not_subscribed',
  // ADR-0048, spec §5.1.1
  'delegation_not_declared',
  'delegation_depth',
  'delegation_loop',
]);

/** The fixed body for a refusal: the status text, plus the reason when it is one of PUBLIC_REASONS. */
export function errorBody(status: ErrorStatus, reason?: string): string {
  return reason !== undefined && PUBLIC_REASONS.has(reason) ? `${ERROR_TEXT[status]}: ${reason}` : ERROR_TEXT[status];
}

export class RequestError extends Error {
  /** `tenantId` is set only once the token is verified, so a refusal after that point is attributed (P-9). */
  constructor(readonly status: ErrorStatus, readonly reason: string, readonly tenantId?: string) {
    super(reason);
    this.name = 'RequestError';
  }
}

/** The status a registry miss maps to (ADR-0024): a name that is not served is 404; a registry fault is 502. */
const REGISTRY_MISS_STATUS: Record<RegistryMiss, ErrorStatus> = {
  unknown_backend: 404,
  backend_draining: 404,
  registry_entry_invalid: 502,
  registry_entry_v1: 502,
  registry_unavailable: 502,
};

export interface ParsedBody {
  readonly prompt: string;
  readonly conversationId?: string;
}

/**
 * Parses the request body. `prompt` must be a string. With the `session`
 * module on, `conversationId` must be present and well formed; with it off,
 * it must be absent (ADR-0013). Anything else is a 400.
 */
export function parseBody(raw: string | null | undefined, sessionOn: boolean): ParsedBody {
  let body: unknown;
  try {
    body = JSON.parse(raw === null || raw === undefined || raw === '' ? '{}' : raw);
  } catch {
    throw new RequestError(400, 'malformed_json');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RequestError(400, 'malformed_body');
  }
  const { prompt, conversationId } = body as Record<string, unknown>;
  if (typeof prompt !== 'string') {
    throw new RequestError(400, 'malformed_prompt');
  }
  if (sessionOn) {
    if (!isValidConversationId(conversationId)) {
      throw new RequestError(400, 'malformed_conversation_id');
    }
    return { prompt, conversationId };
  }
  if (conversationId !== undefined) {
    throw new RequestError(400, 'conversation_id_without_session');
  }
  return { prompt };
}

/** What the API Gateway authoriser decided and minted, read back from its context (spec §3.1 C-3a). */
export interface AuthorizedContext {
  readonly tenantId: string;
  readonly backend: string;
  readonly transactionToken: string;
  readonly txn: string;
  readonly grantSize: number;
  readonly mint: 'hit' | 'miss';
  /** Set when minted here; the authoriser logs its own and does not pass it on. */
  readonly noToolsGranted?: boolean;
}

export interface RequestInputs {
  /** The `Authorization` header value as received. */
  readonly authorization?: string;
  /** (v2) The `X-Tenant-Id` header value as received, if any (P-3). */
  readonly tenantHeader?: string;
  /** The request body as received. */
  readonly body?: string | null;
  /**
   * The request path, which names the backend: `/<backend>/invocations`
   * (ADR-0024). Absent, it is read as the bare `/invocations` route, which
   * resolves to the default backend when one is configured and is 404
   * otherwise.
   */
  readonly path?: string;
  /**
   * Refuse a path that carries no backend name (404 `unknown_backend`) even
   * when a default backend is configured. The Gateway ingress sets this.
   */
  readonly requireBackendInPath?: boolean;
  /** (v2) The authoriser's decision and token (`api-gateway`); absent where this pipeline mints. */
  readonly authorized?: AuthorizedContext;
}

/** What the pipeline needs from the registry; `BackendRegistry` is the implementation, tests pass a stub. */
export type RegistryResolver = Pick<BackendRegistry, 'resolve' | 'warm'>;

/** What the pipeline needs from the authority step; `AuthorityResolver` is the implementation. */
export type AuthoritySource = Pick<AuthorityResolver, 'resolve'>;

/**
 * Verifies a transaction token the authoriser forwarded in the Allow context
 * and returns the tenant and agent it was minted for; throws on any failure.
 * The integration Lambda is a separate invocation target (2026-11-04 red
 * team): an in-account principal with `lambda:InvokeFunction` can hand it a
 * hand-written authorizer context, so the forwarded token is verified like
 * any other bearer before it is trusted (M-82).
 */
export type ForwardedTokenVerifier = (token: string) => Promise<ForwardedToken>;

/** What the forwarded-token verifier returns: the claims the receiving function compares with its own decision. */
export interface ForwardedToken {
  readonly tenantId: string;
  readonly agent: string;
  /** (ADR-0048) The token's `act` and `txn`, compared with the verified caller on the delegation route. */
  readonly act?: unknown;
  readonly txn?: string;
}

/**
 * The default verifier: `typ: txn+jwt`, `iss`, `exp` and `iat` against the
 * ingress's own JWKS. The JWKS document is given in the environment when the
 * construct knows it (the integration function, M-82): it changes in the same
 * deployment as the minter's key id, so a rotation never leaves this function
 * holding a cached JWKS without the new `kid` (integration run 13). Without
 * it, or when a `kid` is not in it, the JWKS route is fetched.
 */
export function forwardedTokenVerifierFor(issuer: string, jwks?: string): ForwardedTokenVerifier {
  const remote = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 60_000, cacheMaxAge: 300_000 });
  const local: JWTVerifyGetKey | undefined = jwks === undefined ? undefined : createLocalJWKSet(JSON.parse(jwks));
  const options = { issuer, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'iat'] };
  return async (token) => {
    let verified;
    try {
      verified = await jwtVerify(token, local ?? remote, options);
    } catch (error) {
      if (local === undefined) {
        throw error;
      }
      verified = await jwtVerify(token, remote, options); // a kid the deployed document lacks: ask the route once
    }
    const { payload, protectedHeader } = verified;
    const { tenant_id: tenantId, agent, act, txn } = payload as Record<string, unknown>;
    if (protectedHeader.typ !== 'txn+jwt' || typeof tenantId !== 'string' || typeof agent !== 'string') {
      throw new Error('not a transaction token');
    }
    return { tenantId, agent, act, txn: typeof txn === 'string' ? txn : undefined };
  };
}

/** What the pipeline needs from the authority step for a delegation (ADR-0048). */
export type DelegationAuthoritySource = Pick<AuthorityResolver, 'resolve' | 'delegate'>;

export class IngressPipeline {
  constructor(
    private readonly config: IngressConfig,
    private readonly verifier: TokenVerifier,
    /** The backend registry the route is resolved through (ADR-0024). */
    readonly registry: RegistryResolver,
    private readonly tvm?: TokenVendingMachine,
    /** Per-tenant limits (ADR-0020); undefined when off. */
    readonly limiter?: TenantLimiter,
    /** (v2) The authority step; present only on the function that mints. */
    private readonly authority?: AuthoritySource | DelegationAuthoritySource,
    /** (v2) Verifies a token the authoriser forwarded; present on the function that does not mint. */
    private readonly forwarded?: ForwardedTokenVerifier,
    /** (ADR-0048) Verifies the caller's transaction token on the delegation route; present when `config.delegation` is set. */
    private readonly delegationVerifier?: DelegationTokenVerifier,
  ) {
    if (config.tvm !== undefined && tvm === undefined) {
      throw new Error('IngressPipeline: tvm module is configured but no TokenVendingMachine was given');
    }
  }

  /**
   * Pre-fetches what the first request would otherwise wait for (ADR-0023):
   * the issuer's discovery document and JWKS, the default backend's registry
   * entry, and a TLS connection to each service the pipeline calls.
   */
  warm(): Promise<void> {
    return Promise.all([
      this.verifier.warm(),
      this.registry.warm(this.config.registry.defaultBackend),
      preconnect([
        this.tvm === undefined ? undefined : endpointHost('sts'),
        this.limiter === undefined && this.authority === undefined ? undefined : endpointHost('dynamodb'),
      ]),
    ]).then(() => undefined);
  }

  /** Verifies the identity token and selects the tenant (P-3); throws RequestError. */
  async verify(inputs: Pick<RequestInputs, 'authorization' | 'tenantHeader'>): Promise<VerifiedClaims> {
    try {
      return await this.verifier.verify(bearerToken(inputs.authorization), inputs.tenantHeader);
    } catch (error) {
      if (error instanceof TokenError) {
        throw new RequestError(error.status, error.reason);
      }
      throw error;
    }
  }

  /** Runs every check, in the order of spec §5.1 (or §5.1.1 on the delegation route); throws RequestError with the status to return. */
  async validate(inputs: RequestInputs): Promise<ValidatedRequest> {
    // ADR-0048: `/<target>/delegations` is its own pipeline; the bearer is a
    // transaction token, not an identity token. Without the module the route
    // does not exist on the API, so a path that names it is an unknown route.
    const route = routeFromPath(inputs.path ?? `/${ROUTE}`, inputs.requireBackendInPath === true ? undefined : this.config.registry.defaultBackend);
    if (route?.route === DELEGATION_ROUTE) {
      if (this.config.delegation === undefined) {
        throw new RequestError(404, 'unknown_backend');
      }
      return this.validateDelegation(inputs, route.backend);
    }
    const claims = await this.verify(inputs);
    // The backend comes from the route and the registry alone (ADR-0024).
    // Resolved before the body is read, so an unknown route costs no parse.
    const { backend, entry } = await this.resolveBackend(inputs, claims);
    const body = parseBody(inputs.body, this.config.sessionScope !== undefined);
    // Per-tenant limit (ADR-0020) before any cost is incurred: no KMS call,
    // no STS call, no Runtime session and no model call for a limited tenant.
    if (this.limiter !== undefined && (await this.limiter.admit(claims.tenantId)) === 'limited') {
      throw new RequestError(429, 'tenant_rate_limited', claims.tenantId);
    }
    const authority = await this.authorityFor(inputs, claims, backend, entry);
    const unitId =
      this.config.sessionScope !== undefined
        ? sessionUnitId(claims.tenantId, claims.sub, this.config.sessionScope, body.conversationId!)
        : randomUnitId();
    const request: {
      -readonly [K in keyof ValidatedRequest]: ValidatedRequest[K];
    } = {
      tenantId: claims.tenantId,
      sub: claims.sub,
      unitId,
      backend,
      runtimeArn: entry.runtimeArn,
      prompt: body.prompt,
      ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
      transactionToken: authority.transactionToken,
      txn: authority.txn,
      grantSize: authority.grantSize,
      mint: authority.mint,
      ...(authority.noToolsGranted === undefined ? {} : { noToolsGranted: authority.noToolsGranted }),
    };
    if (this.tvm !== undefined) {
      try {
        request.credentials = (await this.tvm.vend(claims)).credentials;
      } catch (error) {
        if (error instanceof ClaimMissingError) {
          throw new RequestError(403, 'claim_missing', claims.tenantId);
        }
        throw new RequestError(502, 'tvm_failed', claims.tenantId);
      }
    }
    return request;
  }

  /**
   * (ADR-0048, spec §3.7, §5.1.1) The delegation pipeline: verify the caller's
   * transaction token, resolve the caller's and the target's registry entries,
   * parse, the per-tenant limit for the token's tenant, the replacement token
   * (the authoriser's, checked for this tenant and target, or minted here),
   * the unit, the TVM for the copied tenant and user. Throws RequestError.
   */
  private async validateDelegation(inputs: RequestInputs, target: string): Promise<ValidatedRequest> {
    if (this.delegationVerifier === undefined) {
      throw new RequestError(502, 'delegation_unavailable'); // deployment fault: the route exists but nothing can verify its bearer
    }
    let caller: DelegationCaller;
    try {
      caller = await this.delegationVerifier(bearerToken(inputs.authorization));
    } catch {
      throw new RequestError(401, 'token_invalid');
    }
    // Spec §5.1.1 order: the three delegation checks need only the caller's entry and run
    // before the target is looked up, so an undeclared target is 403, never a 404 that
    // tells an agent whether a backend exists (ADR-0048).
    const callerEntry = await this.entryFor(caller.agent, caller.tenantId);
    const maxDepth = this.config.delegation!.maxDepth;
    try {
      checkDelegation(caller, target, callerEntry, maxDepth);
    } catch (error) {
      if (error instanceof AuthorityError) {
        throw new RequestError(error.status, error.reason, caller.tenantId);
      }
      throw error;
    }
    const targetEntry = await this.entryFor(target, caller.tenantId);
    const body = parseBody(inputs.body, this.config.sessionScope !== undefined);
    if (this.limiter !== undefined && (await this.limiter.admit(caller.tenantId)) === 'limited') {
      throw new RequestError(429, 'tenant_rate_limited', caller.tenantId);
    }
    const authority = await this.delegationAuthorityFor(inputs, caller, target, targetEntry, callerEntry);
    const unitId =
      this.config.sessionScope !== undefined
        ? sessionUnitId(caller.tenantId, caller.sub, this.config.sessionScope, body.conversationId!)
        : randomUnitId();
    const request: {
      -readonly [K in keyof ValidatedRequest]: ValidatedRequest[K];
    } = {
      tenantId: caller.tenantId,
      sub: caller.sub,
      unitId,
      backend: target,
      runtimeArn: targetEntry.runtimeArn,
      prompt: body.prompt,
      ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
      transactionToken: authority.transactionToken,
      txn: authority.txn,
      grantSize: authority.grantSize,
      mint: authority.mint,
      ...(authority.noToolsGranted === undefined ? {} : { noToolsGranted: authority.noToolsGranted }),
      delegatedFrom: caller.agent,
      depth: caller.chain.length + 1,
    };
    if (this.tvm !== undefined) {
      // The replacement token carries the tenant and the user; `tvm.claimTags`
      // needs identity claims it does not have, and synth refuses that pairing.
      const claims: VerifiedClaims = { tenantId: caller.tenantId, sub: caller.sub, clientId: '', scopes: [], claims: { tenant_id: caller.tenantId, sub: caller.sub } };
      try {
        request.credentials = (await this.tvm.vend(claims)).credentials;
      } catch (error) {
        if (error instanceof ClaimMissingError) {
          throw new RequestError(403, 'claim_missing', caller.tenantId);
        }
        throw new RequestError(502, 'tvm_failed', caller.tenantId);
      }
    }
    return request;
  }

  /** A registry entry by name, with the spec §5.1 statuses for a miss; attributed to the tenant. */
  private async entryFor(backend: string, tenantId: string): Promise<RegistryEntry> {
    try {
      return await this.registry.resolve(backend);
    } catch (error) {
      if (error instanceof RegistryError) {
        throw new RequestError(REGISTRY_MISS_STATUS[error.reason], error.reason, tenantId);
      }
      throw error;
    }
  }

  /** The replacement token for a delegation: the authoriser's, or minted here. Throws RequestError. */
  private async delegationAuthorityFor(
    inputs: RequestInputs,
    caller: DelegationCaller,
    target: string,
    targetEntry: RegistryEntry,
    callerEntry: RegistryEntry,
  ): Promise<Omit<AuthorizedContext, 'tenantId' | 'backend'>> {
    if (inputs.authorized !== undefined) {
      if (inputs.authorized.tenantId !== caller.tenantId || inputs.authorized.backend !== target) {
        throw new RequestError(403, 'tenant_not_allowed', caller.tenantId);
      }
      if (this.forwarded === undefined) {
        throw new RequestError(502, 'mint_failed', caller.tenantId);
      }
      let minted: ForwardedToken;
      try {
        minted = await this.forwarded(inputs.authorized.transactionToken);
      } catch {
        throw new RequestError(403, 'tenant_not_allowed', caller.tenantId);
      }
      // M-82 on this route (ADR-0048): the forwarded token must be the
      // replacement for THIS caller, so its act nests agent:<caller> over the caller's own act
      // and its txn is the caller's; a hand-written context cannot pair another chain with it.
      const expectedAct = { sub: `${AGENT_AUDIENCE_PREFIX}${caller.agent}`, act: caller.act };
      if (
        minted.tenantId !== caller.tenantId ||
        minted.agent !== target ||
        minted.txn !== caller.txn ||
        !sameActChain(minted.act, expectedAct)
      ) {
        throw new RequestError(403, 'tenant_not_allowed', caller.tenantId);
      }
      return inputs.authorized;
    }
    if (this.authority === undefined || !('delegate' in this.authority)) {
      throw new RequestError(502, 'mint_failed', caller.tenantId);
    }
    try {
      const minted = await this.authority.delegate(caller, target, targetEntry, callerEntry, this.config.delegation!.maxDepth);
      const { token: transactionToken, txn, grantSize, mint, noToolsGranted } = minted;
      return { transactionToken, txn, grantSize, mint, noToolsGranted };
    } catch (error) {
      if (error instanceof AuthorityError) {
        throw new RequestError(error.status, error.reason, caller.tenantId);
      }
      throw error;
    }
  }

  /**
   * The transaction token for this request: the authoriser's (checked to be
   * for this tenant and backend), or minted here. Throws RequestError.
   */
  private async authorityFor(
    inputs: RequestInputs,
    claims: VerifiedClaims,
    backend: string,
    entry: RegistryEntry,
  ): Promise<Omit<AuthorizedContext, 'tenantId' | 'backend'>> {
    if (inputs.authorized !== undefined) {
      if (inputs.authorized.tenantId !== claims.tenantId || inputs.authorized.backend !== backend) {
        throw new RequestError(403, 'tenant_not_allowed', claims.tenantId);
      }
      // The context is trusted only once its token verifies against our own
      // JWKS and names this tenant and this agent (M-82): a direct invoke with
      // a hand-written context cannot run an agent the tenant does not hold.
      if (this.forwarded === undefined) {
        throw new RequestError(502, 'mint_failed', claims.tenantId); // deployment fault: nothing can vouch for the context
      }
      let minted: { tenantId: string; agent: string };
      try {
        minted = await this.forwarded(inputs.authorized.transactionToken);
      } catch {
        throw new RequestError(403, 'tenant_not_allowed', claims.tenantId);
      }
      if (minted.tenantId !== claims.tenantId || minted.agent !== backend) {
        throw new RequestError(403, 'tenant_not_allowed', claims.tenantId);
      }
      return inputs.authorized;
    }
    if (this.authority === undefined) {
      // A deployment fault: neither an authoriser token nor a mint here.
      throw new RequestError(502, 'mint_failed', claims.tenantId);
    }
    try {
      const minted = await this.authority.resolve(claims.tenantId, claims.sub, backend, entry);
      const { token: transactionToken, txn, grantSize, mint, noToolsGranted } = minted;
      return { transactionToken, txn, grantSize, mint, noToolsGranted };
    } catch (error) {
      if (error instanceof AuthorityError) {
        throw new RequestError(error.status, error.reason, claims.tenantId);
      }
      throw error;
    }
  }

  /**
   * Resolves the route's backend (ADR-0024): an unparseable path, an unknown
   * name or a draining backend is 404; a registry fault or a v1-shaped entry
   * is 502. With `requireBackendInPath` the default backend is not consulted.
   * (v2) There is no per-backend scope check: what the caller may do with
   * the agent is the grant rule's (ADR-0030).
   */
  async resolveBackend(
    inputs: Pick<RequestInputs, 'path' | 'requireBackendInPath'>,
    claims: VerifiedClaims,
  ): Promise<{ backend: string; entry: RegistryEntry }> {
    const defaultBackend = inputs.requireBackendInPath === true ? undefined : this.config.registry.defaultBackend;
    const backend = backendFromPath(inputs.path ?? `/${ROUTE}`, defaultBackend);
    if (backend === undefined) {
      throw new RequestError(404, 'unknown_backend', claims.tenantId);
    }
    try {
      return { backend, entry: await this.registry.resolve(backend) };
    } catch (error) {
      if (error instanceof RegistryError) {
        throw new RequestError(REGISTRY_MISS_STATUS[error.reason], error.reason, claims.tenantId);
      }
      throw error;
    }
  }
}

/** The identity-token verifier for a configuration (the ingress refuses its own issuer, P-14). */
export function verifierFor(config: IngressConfig): TokenVerifier {
  return new TokenVerifier({
    discoveryUrl: config.discoveryUrl,
    allowedClientIds: config.allowedClientIds,
    requiredScopes: config.requiredScopes,
    multiTenant: config.multiTenant,
    ownIssuer: config.issuer,
  });
}

/** The authority step for a configuration that mints, else undefined. */
export function authorityFor(config: IngressConfig): AuthorityResolver | undefined {
  if (config.mint === undefined) {
    return undefined;
  }
  if (config.entitlementsTable === undefined) {
    throw new Error('authorityFor: a minting function needs the entitlement store table');
  }
  const minter = new TokenMinter(config.mint, {
    signer: kmsDigestSigner(new KMSClient({ requestHandler: sharedHandler() }), config.mint.keyId, config.mint.algorithm),
  });
  return new AuthorityResolver(new EntitlementReader(config.entitlementsTable, config.registry.ttlSeconds), minter);
}

/** Builds the verifier, the registry, the TVM, the limiter and (when this function mints) the authority step. */
export function pipelineFor(
  config: IngressConfig,
  deps: {
    tvm?: TokenVendingMachine;
    verifier?: TokenVerifier;
    limiter?: TenantLimiter;
    registry?: RegistryResolver;
    authority?: AuthoritySource | DelegationAuthoritySource;
    forwarded?: ForwardedTokenVerifier;
    delegationVerifier?: DelegationTokenVerifier;
  } = {},
): IngressPipeline {
  const verifier = deps.verifier ?? verifierFor(config);
  const registry = deps.registry ?? new BackendRegistry(config.registry);
  const tvm = config.tvm === undefined ? undefined : deps.tvm ?? new TokenVendingMachine(config.tvm);
  const limiter = config.limits === undefined ? undefined : deps.limiter ?? new TenantLimiter(config.limits);
  const authority = deps.authority ?? authorityFor(config);
  // The function that does not mint receives the authoriser's token and must verify it (M-82).
  const forwarded =
    deps.forwarded ?? (authority === undefined && config.issuer !== undefined ? forwardedTokenVerifierFor(config.issuer, config.txnJwks) : undefined);
  // ADR-0048: the delegation route's bearer is verified against our own JWKS; the ingress role ARN is the chain's root.
  const delegationVerifier = deps.delegationVerifier ?? delegationVerifierFor(config);
  return new IngressPipeline(config, verifier, registry, tvm, limiter, authority, forwarded, delegationVerifier);
}

/** The caller-token verifier for a configuration with the delegation module, else undefined. */
export function delegationVerifierFor(config: IngressConfig): DelegationTokenVerifier | undefined {
  if (config.delegation === undefined || config.issuer === undefined) {
    return undefined;
  }
  const ingressRoleArn = config.mint?.ingressRoleArn ?? config.ingressRoleArn;
  if (ingressRoleArn === undefined) {
    throw new Error('delegationVerifierFor: the delegation route needs the ingress role ARN (RI_INGRESS_ROLE_ARN)');
  }
  return delegationTokenVerifierFor({ issuer: config.issuer, ingressRoleArn, jwks: config.txnJwks });
}

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
import { AuthorityError, AuthorityResolver } from './authority';
import type { IngressConfig } from './config';
import { EntitlementReader } from './entitlements';
import { endpointHost, preconnect, sharedHandler } from './http';
import { kmsDigestSigner } from './jws';
import { TenantLimiter } from './limits';
import { TokenMinter } from './mint';
import { BackendRegistry, backendFromPath, type RegistryEntry, RegistryError, type RegistryMiss, ROUTE } from './registry';
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
    private readonly authority?: AuthoritySource,
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

  /** Runs every check, in the order of spec §5.1; throws RequestError with the status to return. */
  async validate(inputs: RequestInputs): Promise<ValidatedRequest> {
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
      transactionToken: authority.transactionToken,
      txn: authority.txn,
      grantSize: authority.grantSize,
      mint: authority.mint,
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
      return inputs.authorized;
    }
    if (this.authority === undefined) {
      // A deployment fault: neither an authoriser token nor a mint here.
      throw new RequestError(502, 'mint_failed', claims.tenantId);
    }
    try {
      const minted = await this.authority.resolve(claims.tenantId, claims.sub, backend, entry);
      return { transactionToken: minted.token, txn: minted.txn, grantSize: minted.grantSize, mint: minted.mint };
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
    authority?: AuthoritySource;
  } = {},
): IngressPipeline {
  const verifier = deps.verifier ?? verifierFor(config);
  const registry = deps.registry ?? new BackendRegistry(config.registry);
  const tvm = config.tvm === undefined ? undefined : deps.tvm ?? new TokenVendingMachine(config.tvm);
  const limiter = config.limits === undefined ? undefined : deps.limiter ?? new TenantLimiter(config.limits);
  const authority = deps.authority ?? authorityFor(config);
  return new IngressPipeline(config, verifier, registry, tvm, limiter, authority);
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingress pipeline (spec §3.4, §5), shared by the API Gateway integration
 * Lambda and the AgentCore Gateway REQUEST interceptor so both ingresses
 * enforce one contract: verify the token (P-3), resolve the backend named by
 * the route through the registry and require its scopes (ADR-0024), parse
 * `{conversationId, prompt}`, choose the unit (P-2), attach the user token on
 * opt-in (P-5) and vend tenant credentials on opt-in (P-8). The output is a
 * ValidatedRequest naming the backend and its Runtime ARN; nothing here knows
 * how the backend is invoked.
 */

import type { IngressConfig } from './config';
import { endpointHost, preconnect } from './http';
import { TenantLimiter } from './limits';
import { BackendRegistry, backendFromPath, RegistryError, type RegistryMiss, ROUTE } from './registry';
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

export interface RequestInputs {
  /** The `Authorization` header value as received. */
  readonly authorization?: string;
  /** The request body as received. */
  readonly body?: string | null;
  /**
   * The request path, which names the backend: `/<backend>/invocations`
   * (ADR-0024). Absent, it is read as the bare `/invocations` route, which
   * resolves to the default backend when one is configured and is 404
   * otherwise.
   */
  readonly path?: string;
}

/** What the pipeline needs from the registry; `BackendRegistry` is the implementation, tests pass a stub. */
export type RegistryResolver = Pick<BackendRegistry, 'resolve' | 'warm'>;

export class IngressPipeline {
  constructor(
    private readonly config: IngressConfig,
    private readonly verifier: TokenVerifier,
    /** The backend registry the route is resolved through (ADR-0024). */
    readonly registry: RegistryResolver,
    private readonly tvm?: TokenVendingMachine,
    /** Per-tenant limits (ADR-0020); undefined when off. */
    readonly limiter?: TenantLimiter,
  ) {
    if (config.tvm !== undefined && tvm === undefined) {
      throw new Error('IngressPipeline: tvm module is configured but no TokenVendingMachine was given');
    }
  }

  /**
   * Pre-fetches what the first request would otherwise wait for (ADR-0023):
   * the issuer's discovery document and JWKS, the default backend's registry
   * entry when there is one, and a TLS connection to each service the
   * pipeline calls (STS for the TVM, DynamoDB for the limiter), all in
   * parallel. Resolves when every attempt has ended, success or not.
   */
  warm(): Promise<void> {
    return Promise.all([
      this.verifier.warm(),
      this.registry.warm(this.config.registry.defaultBackend),
      preconnect([
        this.tvm === undefined ? undefined : endpointHost('sts'),
        this.limiter === undefined ? undefined : endpointHost('dynamodb'),
      ]),
    ]).then(() => undefined);
  }

  /** Runs every check, in the order of the architecture's request flow; throws RequestError with the status to return. */
  async validate(inputs: RequestInputs): Promise<ValidatedRequest> {
    const token = bearerToken(inputs.authorization);
    let claims: VerifiedClaims;
    try {
      claims = await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof TokenError) {
        throw new RequestError(error.status, error.reason);
      }
      throw error;
    }
    // The backend comes from the route and the registry alone (ADR-0024).
    // Resolved before the body is read, so an unknown route costs no parse.
    const { backend, runtimeArn } = await this.resolveBackend(inputs.path, claims);
    const body = parseBody(inputs.body, this.config.sessionScope !== undefined);
    // Per-tenant limit (ADR-0020) before any cost is incurred: no STS call,
    // no Runtime session and no model call for a limited tenant.
    if (this.limiter !== undefined && (await this.limiter.admit(claims.tenantId)) === 'limited') {
      throw new RequestError(429, 'tenant_rate_limited', claims.tenantId);
    }
    const unitId =
      this.config.sessionScope !== undefined
        ? sessionUnitId(claims.tenantId, claims.sub, this.config.sessionScope, body.conversationId!)
        : randomUnitId();
    const request: {
      -readonly [K in keyof ValidatedRequest]: ValidatedRequest[K];
    } = { tenantId: claims.tenantId, sub: claims.sub, unitId, backend, runtimeArn, prompt: body.prompt };
    if (this.config.delegation.forwardUserToken) {
      request.userToken = token;
    }
    if (this.tvm !== undefined) {
      try {
        request.credentials = (await this.tvm.vend(claims)).credentials;
      } catch (error) {
        if (error instanceof ClaimMissingError) {
          throw new RequestError(403, 'claim_missing');
        }
        throw new RequestError(502, 'tvm_failed');
      }
    }
    return request;
  }

  /**
   * Resolves the route's backend (ADR-0024): an unparseable path, an unknown
   * name or a draining backend is 404; a registry fault is 502; a token
   * without the backend's `requiredScopes` is 403 `backend_scope_missing`,
   * checked after the ingress-wide scopes the verifier enforced (ADR-0005).
   */
  private async resolveBackend(path: string | undefined, claims: VerifiedClaims): Promise<{ backend: string; runtimeArn: string }> {
    const backend = backendFromPath(path ?? `/${ROUTE}`, this.config.registry.defaultBackend);
    if (backend === undefined) {
      throw new RequestError(404, 'unknown_backend', claims.tenantId);
    }
    let entry;
    try {
      entry = await this.registry.resolve(backend);
    } catch (error) {
      if (error instanceof RegistryError) {
        throw new RequestError(REGISTRY_MISS_STATUS[error.reason], error.reason, claims.tenantId);
      }
      throw error;
    }
    if (entry.requiredScopes.some((scope) => !claims.scopes.includes(scope))) {
      throw new RequestError(403, 'backend_scope_missing', claims.tenantId);
    }
    return { backend, runtimeArn: entry.runtimeArn };
  }
}

/** Builds the verifier, the registry and, when configured, the TVM and the limiter from the ingress configuration. */
export function pipelineFor(
  config: IngressConfig,
  deps: { tvm?: TokenVendingMachine; verifier?: TokenVerifier; limiter?: TenantLimiter; registry?: RegistryResolver } = {},
): IngressPipeline {
  const verifier =
    deps.verifier ??
    new TokenVerifier({
      discoveryUrl: config.discoveryUrl,
      allowedClientIds: config.allowedClientIds,
      requiredScopes: config.requiredScopes,
      requireNarrowedToken: config.delegation.requireNarrowedToken,
      allowedScopes: config.delegation.allowedScopes,
    });
  const registry = deps.registry ?? new BackendRegistry(config.registry);
  const tvm = config.tvm === undefined ? undefined : deps.tvm ?? new TokenVendingMachine(config.tvm);
  const limiter = config.limits === undefined ? undefined : deps.limiter ?? new TenantLimiter(config.limits);
  return new IngressPipeline(config, verifier, registry, tvm, limiter);
}

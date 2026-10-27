// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingress pipeline (spec §3.4, §5), shared by the API Gateway integration
 * Lambda and the AgentCore Gateway REQUEST interceptor so both ingresses
 * enforce one contract: verify the token (P-3), parse `{conversationId,
 * prompt}`, choose the unit (P-2), attach the user token on opt-in (P-5) and
 * vend tenant credentials on opt-in (P-8). The output is a backend-neutral
 * ValidatedRequest; nothing here knows which backend will receive it.
 */

import type { IngressConfig } from './config';
import { TenantLimiter } from './limits';
import { isValidConversationId, randomUnitId, sessionUnitId } from './session';
import { ClaimMissingError, TokenVendingMachine } from './tvm';
import { bearerToken, TokenError, TokenVerifier, type VerifiedClaims } from './verifier';
import type { ValidatedRequest } from '../backend/backend';

/** Fixed response bodies (spec §5): never echo the token, the unit id or the input. */
export type ErrorStatus = 400 | 401 | 403 | 429 | 502;

export const ERROR_TEXT: Record<ErrorStatus, string> = {
  400: 'bad request',
  401: 'unauthorized',
  403: 'forbidden',
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
}

export class IngressPipeline {
  constructor(
    private readonly config: IngressConfig,
    private readonly verifier: TokenVerifier,
    private readonly tvm?: TokenVendingMachine,
    /** Per-tenant limits (ADR-0020); undefined when off. */
    readonly limiter?: TenantLimiter,
  ) {
    if (config.tvm !== undefined && tvm === undefined) {
      throw new Error('IngressPipeline: tvm module is configured but no TokenVendingMachine was given');
    }
  }

  /** Runs every check; throws RequestError with the status to return. */
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
    } = { tenantId: claims.tenantId, sub: claims.sub, unitId, prompt: body.prompt };
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
}

/** Builds the verifier and, when configured, the TVM from the ingress configuration. */
export function pipelineFor(
  config: IngressConfig,
  deps: { tvm?: TokenVendingMachine; verifier?: TokenVerifier; limiter?: TenantLimiter } = {},
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
  const tvm = config.tvm === undefined ? undefined : deps.tvm ?? new TokenVendingMachine(config.tvm);
  const limiter = config.limits === undefined ? undefined : deps.limiter ?? new TenantLimiter(config.limits);
  return new IngressPipeline(config, verifier, tvm, limiter);
}

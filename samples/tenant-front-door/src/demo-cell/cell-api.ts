// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo cell API (spec §3.1 Cell API origin, §3.5, §6.1): the reference
 * for what a cell API behind the front door must do. It sits behind a
 * Lambda function URL with `AWS_IAM` auth that only the edge distribution
 * can invoke, through origin access control (ADR-0011, `CellRouteAccess`).
 *
 * Every request, in this order:
 *
 * 1. Verify the token in `x-tenant-token` (ADR-0011) against the issuer's
 *    JWKS and the token contract (`token.ts`). An expired but authentic
 *    token gets 401 with `WWW-Authenticate: Bearer`, so the client signs in
 *    again; every other refusal is 403 (§10 step 7). An issuer whose keys
 *    cannot be fetched gets 503.
 * 2. Compare the verified tenant with `x-tenant-route`, case-insensitively:
 *    403 on a mismatch or a missing hint (ADR-0005).
 * 3. Count the request against the tenant's `tenantRequestsPer5Min`
 *    (ADR-0009, `limiter.ts`): 429 with `Retry-After` when over.
 * 4. The hosts check: 403 when the cell's own namespace for the verified
 *    tenant is empty, 503 when SSM cannot answer (`hosts.ts`).
 * 5. Route: `GET /api/whoami` answers the verified tenant (control-plane
 *    form), the cell id and the route hint it received; anything else 404.
 *
 * Each refusal is logged with both tenant ids (§3.5) and a fixed reason
 * code; each served request is logged with the verified tenant, so the
 * cell's log is the billing-grade count of verified requests (§3.1
 * Telemetry). No log line carries the token, a header value or the body.
 */

import type { APIGatewayProxyStructuredResultV2 as CellApiResult, LambdaFunctionURLEvent } from 'aws-lambda';
import type { HostsCheck } from './hosts';
import type { TenantLimiter } from './limiter';
import { IssuerUnavailableError, TokenError, type TokenVerifier } from './token';
import { HEADER_TENANT_ROUTE, HEADER_TENANT_TOKEN } from '../shared/contracts';

export interface CellApiDependencies {
  readonly cellId: string;
  readonly verifier: Pick<TokenVerifier, 'verify'>;
  readonly hosts: Pick<HostsCheck, 'hosts'>;
  readonly limiter: Pick<TenantLimiter, 'admit'>;
  /** One structured log record; the default writes a JSON line to stdout. */
  readonly log?: (record: LogRecord) => void;
}

/** What the cell logs; ids and fixed codes only. */
export interface LogRecord {
  readonly level: 'INFO' | 'WARN' | 'ERROR';
  readonly message: 'served' | 'refused';
  readonly status: number;
  readonly reason?: string;
  /** The verified tenant, control-plane form; `-` when verification failed. */
  readonly tenantId: string;
  /** The router's hint, lower case; `-` when absent or not a route id. */
  readonly routeTenantId: string;
  readonly cellId: string;
  readonly method?: string;
  readonly path?: string;
  /** An error's class name, never its message. */
  readonly error?: string;
}

/** The `GET /api/whoami` answer. */
export interface WhoamiResponse {
  /** The verified tenant claim, upper-cased to the control-plane form. */
  readonly tenantId: string;
  readonly cellId: string;
  /** The `x-tenant-route` value the router sent. */
  readonly routeHint: string;
}

const ROUTE_ID = /^[a-z0-9-]{1,63}$/;
/** Paths the cell logs as they are; anything else is logged as `-`, so a path never carries caller data into the log. */
const KNOWN_PATHS = new Set(['/api/whoami']);

function defaultLog(record: LogRecord): void {
  process.stdout.write(JSON.stringify(record) + '\n');
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): CellApiResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  };
}

/** The token from `x-tenant-token`: the raw JWT, or a `Bearer <jwt>` value as copied from `Authorization`. */
export function tokenFromHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const bearer = /^Bearer\s+(\S+)$/i.exec(trimmed);
  return bearer ? bearer[1] : trimmed;
}

/** A function URL handler that always answers a structured result. */
export type CellApi = (event: LambdaFunctionURLEvent) => Promise<CellApiResult>;

export function createCellApi(deps: CellApiDependencies): CellApi {
  const log = deps.log ?? defaultLog;
  const cellId = deps.cellId;

  return async (event) => {
    const headers = event.headers ?? {};
    const hint = headers[HEADER_TENANT_ROUTE];
    const routeTenantId = hint !== undefined && ROUTE_ID.test(hint.toLowerCase()) ? hint.toLowerCase() : '-';
    const method = event.requestContext?.http?.method ?? '-';
    const path = KNOWN_PATHS.has(event.rawPath) ? event.rawPath : '-';
    const refuse = (status: number, reason: string, tenantId: string, extra: Record<string, string> = {}, error?: unknown) => {
      log({
        level: status >= 500 ? 'ERROR' : 'WARN',
        message: 'refused',
        status,
        reason,
        tenantId,
        routeTenantId,
        cellId,
        method,
        path,
        error: error === undefined ? undefined : error instanceof Error ? error.name : typeof error,
      });
      const body = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'too many requests' : 'unavailable';
      return json(status, { message: body }, extra);
    };

    // 1. The token (ADR-0011): verified, never logged.
    let tenantId: string;
    try {
      ({ tenantId } = await deps.verifier.verify(tokenFromHeader(headers[HEADER_TENANT_TOKEN])));
    } catch (error) {
      if (error instanceof TokenError) {
        return error.reason === 'expired_token'
          ? refuse(401, error.reason, '-', { 'www-authenticate': 'Bearer error="invalid_token"' })
          : refuse(403, error.reason, '-');
      }
      if (error instanceof IssuerUnavailableError) {
        return refuse(503, 'issuer_unavailable', '-', {}, error.cause);
      }
      return refuse(503, 'verify_failed', '-', {}, error);
    }

    // 2. The route hint must name the verified tenant (ADR-0005), compared case-insensitively.
    if (hint === undefined || hint.toLowerCase() !== tenantId.toLowerCase()) {
      return refuse(403, 'route_mismatch', tenantId);
    }

    // 3. The per-tenant rate at the origin (ADR-0009); fails open inside the limiter.
    const admission = await deps.limiter.admit(tenantId);
    if (!admission.admitted) {
      return refuse(429, 'rate_limited', tenantId, { 'retry-after': String(admission.retryAfterSeconds) });
    }

    // 4. The hosts check, on the cell's own namespace; fails closed.
    let hosted: boolean;
    try {
      hosted = await deps.hosts.hosts(tenantId);
    } catch (error) {
      return refuse(503, 'hosts_check_failed', tenantId, {}, error);
    }
    if (!hosted) {
      return refuse(403, 'not_hosted', tenantId);
    }

    // 5. Routes.
    if (method === 'GET' && event.rawPath === '/api/whoami') {
      log({ level: 'INFO', message: 'served', status: 200, tenantId, routeTenantId, cellId, method, path });
      const body: WhoamiResponse = { tenantId, cellId, routeHint: hint };
      return json(200, body);
    }
    log({ level: 'INFO', message: 'served', status: 404, tenantId, routeTenantId, cellId, method, path });
    return json(404, { message: 'not found' });
  };
}

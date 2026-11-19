// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Same-origin calls to the cell API (spec §3.2, §7.2): the bearer token in
 * `Authorization`, which the router copies to `x-tenant-token`, and on
 * `PUT` and `POST` the body's SHA-256 in `x-amz-content-sha256`, which
 * origin access control needs to sign a body (ADR-0011).
 */

import { HEADER_CONTENT_SHA256 } from '../../src/shared/contracts';
import { hex, sha256 } from './encoding';
import type { FetchLike, RequestInitLike, ResponseLike } from './http';

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`API answered ${status}`);
  }
}

/** Lower-case hex SHA-256 of the UTF-8 body: the value OAC expects in `x-amz-content-sha256`. */
export async function contentSha256(body: string): Promise<string> {
  return hex(await sha256(body));
}

export async function apiRequest(
  fetchFn: FetchLike,
  accessToken: string,
  method: RequestInitLike['method'],
  path: string,
  body?: string,
): Promise<ResponseLike> {
  if (!path.startsWith('/api/')) throw new Error('apiRequest: path must start with /api/');
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  let sent: string | undefined;
  if (method === 'PUT' || method === 'POST') {
    sent = body ?? '';
    headers['Content-Type'] = 'application/json';
    headers[HEADER_CONTENT_SHA256] = await contentSha256(sent);
  } else if (body !== undefined) {
    throw new Error(`apiRequest: ${method} has no body`);
  }
  return fetchFn(path, { method, headers, body: sent, credentials: 'same-origin' });
}

/** `GET /api/whoami`: the cell's view of the caller (§10 step 4). */
export async function whoami(fetchFn: FetchLike, accessToken: string): Promise<unknown> {
  const res = await apiRequest(fetchFn, accessToken, 'GET', '/api/whoami');
  if (!res.ok) throw new ApiError(res.status);
  return res.json();
}

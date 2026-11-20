// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * A small SigV4 signer (header form and query presign) on `node:crypto`, for
 * the two things the driver does that the SDK clients do not: presigning a PUT
 * for the no-egress probe, and calling API Gateway IAM routes of other
 * samples. It signs `host`, `x-amz-date`, the session token and the headers
 * the caller names; paths are assumed to be encoded already (the driver's
 * paths hold no special characters). Unit-tested against the AWS test-suite
 * case `get-vanilla`.
 */

import { createHash, createHmac } from 'node:crypto';

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** `20150830T123600Z` */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
}

function encode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The canonical path: each segment URI-encoded once, and once more for every service but S3. */
export function canonicalPath(pathname: string, service: string): string {
  const once = pathname.split('/').map((seg) => encode(decodeURIComponent(seg))).join('/') || '/';
  return service === 's3' ? once : once.split('/').map(encode).join('/');
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()].map(([k, v]) => [encode(k), encode(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
}

export interface SignInput {
  readonly method: string;
  readonly url: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: Credentials;
  readonly body?: string | Buffer;
  /** Extra headers to sign and send (for example `content-type`). */
  readonly headers?: Record<string, string>;
  readonly now?: Date;
}

/** The headers to send with the request, `authorization` included. */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const date = amzDate(input.now ?? new Date());
  const day = date.slice(0, 8);
  const payload = sha256(input.body ?? '');
  const headers: Record<string, string> = { 'host': url.host, 'x-amz-date': date };
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;
  if (input.service === 's3') headers['x-amz-content-sha256'] = payload;
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const canonical = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname || '/', input.service),
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    payload,
  ].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const signature = hmac(signingKey(input.credentials.secretAccessKey, day, input.region, input.service), toSign).toString('hex');
  const { host: _host, ...send } = headers;
  return {
    ...send,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

export interface PresignInput {
  readonly method: string;
  readonly url: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: Credentials;
  readonly expiresSeconds: number;
  readonly now?: Date;
}

/** A presigned URL (query form), payload unsigned, `host` the only signed header. */
export function presignUrl(input: PresignInput): string {
  const url = new URL(input.url);
  const date = amzDate(input.now ?? new Date());
  const day = date.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', date);
  url.searchParams.set('X-Amz-Expires', String(input.expiresSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  if (input.credentials.sessionToken) url.searchParams.set('X-Amz-Security-Token', input.credentials.sessionToken);
  const canonical = [input.method.toUpperCase(), canonicalPath(url.pathname, input.service), canonicalQuery(url.searchParams), `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const signature = hmac(signingKey(input.credentials.secretAccessKey, day, input.region, input.service), toSign).toString('hex');
  url.searchParams.set('X-Amz-Signature', signature);
  return url.toString();
}

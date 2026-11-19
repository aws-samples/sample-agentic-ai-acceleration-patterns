// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The router-to-cell seam (spec §3.2, §3.3 step 7, §3.5): the request the
 * router forwards on `/api/*`, cut to the three headers the origin request
 * policy passes, is what the demo cell API reads. A header rename, a
 * `Bearer` prefix or a case change on either side fails here.
 */

import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { createCellApi, LogRecord } from '../../src/demo-cell/cell-api';
import { API_FORWARDED_HEADERS, HEADER_TENANT_TOKEN } from '../../src/shared/contracts';
import { ACME_HOST, Answer, event, HOST_DOMAIN, loadRouter, SINGLE_DOMAIN, T_ACME, tokenFor, tokenValues } from '../router/harness';

const CELL = '01HZX8K9P0QRST7VWXYZ1A2B3D';

/** What CloudFront sends the function URL: only the policy's headers, `Host` dropped (§3.2). */
function toCellEvent(forwarded: Answer): LambdaFunctionURLEvent {
  const headers: Record<string, string> = {};
  for (const name of API_FORWARDED_HEADERS) {
    const h = forwarded.headers[name];
    if (h !== undefined) headers[name] = h.value;
  }
  return {
    version: '2.0',
    rawPath: forwarded.uri!,
    rawQueryString: '',
    headers,
    requestContext: { http: { method: 'GET', path: forwarded.uri! } },
  } as unknown as LambdaFunctionURLEvent;
}

function cellApi(seen: string[]) {
  const logs: LogRecord[] = [];
  const api = createCellApi({
    cellId: CELL,
    // Stands in for the JWKS check: records the token it was given and
    // returns the claim, upper-cased as the real verifier does.
    verifier: {
      verify: async (token: string | undefined) => {
        seen.push(token ?? '');
        const payload = JSON.parse(Buffer.from(token!.split('.')[1], 'base64url').toString('utf8'));
        return { tenantId: String(payload.tenant_id).toUpperCase(), claims: payload } as never;
      },
    },
    hosts: { hosts: async () => true },
    limiter: { admit: async () => ({ admitted: true }) as never },
    log: (r) => logs.push(r),
  });
  return { api, logs };
}

describe.each([
  ['single', SINGLE_DOMAIN, tokenValues()],
  ['host', ACME_HOST, tokenValues({ appDomain: HOST_DOMAIN, addressing: 'host' })],
] as const)('%s mode: router output into the demo cell', (_mode, host, values) => {
  test('§3.3 step 7, §3.5: the cell verifies the raw token the router copied and accepts its route hint', async () => {
    const router = loadRouter(values);
    const jwt = tokenFor(T_ACME);
    const forwarded = await router.run(event({ host, uri: '/api/whoami', token: jwt }));
    expect(forwarded.statusCode).toBeUndefined(); // forwarded, not answered
    expect(forwarded.headers[HEADER_TENANT_TOKEN].value).toBe(jwt);

    const seen: string[] = [];
    const { api } = cellApi(seen);
    const res = await api(toCellEvent(forwarded));
    expect(seen).toEqual([jwt]);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ tenantId: T_ACME.toUpperCase(), cellId: CELL, routeHint: T_ACME });
  });

  test('§3.2: a client x-tenant-* header never reaches the cell', async () => {
    const router = loadRouter(values);
    const forwarded = await router.run(event({
      host,
      uri: '/api/whoami',
      token: tokenFor(T_ACME),
      headers: { 'x-tenant-route': 'someone-else', 'x-tenant-token': 'forged' },
    }));
    const cellEvent = toCellEvent(forwarded);
    expect(cellEvent.headers['x-tenant-route']).toBe(T_ACME);
    expect(cellEvent.headers['x-tenant-token']).toBe(tokenFor(T_ACME));
  });
});

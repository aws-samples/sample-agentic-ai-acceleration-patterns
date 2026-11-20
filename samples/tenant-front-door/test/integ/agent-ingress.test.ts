// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The stand-in agent ingress (test/integ/agent-ingress, ADR-0024) and the
 * route table helper's redaction (test/integ/edge-tool.ts).
 */

import { createHash } from 'node:crypto';
import { authorizer } from './agent-ingress/authorizer.function';
import { fingerprint, recordOf, STREAM_EVENTS, STREAM_GAP_MS, writeStream } from './agent-ingress/record';
import { streamTo } from './agent-ingress/stream.function';
import { redact } from './edge-tool';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZW5hbnRfaWQiOiJhIn0.c2ln';

describe('the stand-in record', () => {
  it('holds the stage path, the method, the route hint and a fingerprint, never the bearer', () => {
    const r = recordOf({
      httpMethod: 'POST',
      path: '/support-bot/invocations',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'X-Tenant-Route': '01kaf5m0000000000000000t01' },
      requestContext: { path: '/prod/support-bot/invocations', stage: 'prod', requestId: 'r-1' },
    });
    expect(r).toEqual({
      message: 'agent-ingress-request',
      requestId: 'r-1',
      method: 'POST',
      stagePath: '/prod/support-bot/invocations',
      tenantRoute: '01kaf5m0000000000000000t01',
      authorizationFingerprint: createHash('sha256').update(`Bearer ${TOKEN}`).digest('hex').slice(0, 16),
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('marks a missing header null and a route hint outside the id form invalid', () => {
    expect(recordOf({ headers: { 'x-tenant-route': 'A B' } })).toMatchObject({ tenantRoute: 'invalid', authorizationFingerprint: null });
    expect(recordOf({ headers: null })).toMatchObject({ tenantRoute: null, stagePath: '' });
    expect(fingerprint('x')).toHaveLength(16);
  });

  it('streams ten events, 500 ms apart', async () => {
    const chunks: string[] = [];
    const sleeps: number[] = [];
    let now = 1000;
    await writeStream((c) => chunks.push(c), async (ms) => { sleeps.push(ms); now += ms; }, () => now);
    expect(chunks).toHaveLength(STREAM_EVENTS);
    expect(sleeps).toEqual(Array(STREAM_EVENTS - 1).fill(STREAM_GAP_MS));
    expect(chunks[0]).toBe('data: {"i":0,"at":1000}\n\n');
    expect(JSON.parse(chunks[9].slice(6))).toEqual({ i: 9, at: 1000 + 9 * STREAM_GAP_MS });
  });

  it('logs one record and ends the stream', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const writes: string[] = [];
    let ended = false;
    await streamTo({ headers: { authorization: `Bearer ${TOKEN}` } }, { write: (c) => writes.push(c), end: () => { ended = true; } }, async () => undefined);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).not.toContain(TOKEN);
    expect(writes).toHaveLength(STREAM_EVENTS);
    expect(ended).toBe(true);
    log.mockRestore();
  });
});

describe('the stand-in authoriser', () => {
  const verify = jest.fn();
  const handler = authorizer({ verify });
  const methodArn = 'arn:aws:execute-api:eu-central-1:111111111111:abc/prod/POST/support-bot/invocations';

  it('allows the method for a verified token, naming its tenant', async () => {
    verify.mockResolvedValueOnce({ tenantId: '01KAF5M0000000000000000T01' });
    const r = await handler({ methodArn, headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(verify).toHaveBeenCalledWith(TOKEN);
    expect(r.policyDocument.Statement).toEqual([{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: methodArn }]);
    expect(r.context.tenantId).toBe('01KAF5M0000000000000000T01');
  });

  it.each([
    ['no header', {}],
    ['another scheme', { authorization: `Basic ${TOKEN}` }],
    ['a token the check refuses', { authorization: `Bearer ${TOKEN}` }],
  ])('answers Unauthorized (401) for %s', async (_name, headers) => {
    verify.mockRejectedValueOnce(new Error('invalid_token'));
    await expect(handler({ methodArn, headers })).rejects.toThrow(/^Unauthorized$/);
  });
});

describe('the route table helper', () => {
  it('prints whether a challenge token and the signin keys exist, never their values', () => {
    expect(redact(undefined)).toBeNull();
    expect(redact(JSON.stringify({ v: 1, c: 'cell', s: 'active', d: 'dd.example.com', dk: 'secret-token-value', dx: 1 })))
      .toEqual({ v: 1, c: 'cell', s: 'active', d: 'dd.example.com', dkPresent: true, dx: 1 });
    expect(JSON.stringify(redact(JSON.stringify({ v: 1, cur: 'k1', k: { k2: 'a2V5', k1: 'a2V5MQ==' } })))).toBe('{"v":1,"cur":"k1","kids":["k1","k2"]}');
  });
});

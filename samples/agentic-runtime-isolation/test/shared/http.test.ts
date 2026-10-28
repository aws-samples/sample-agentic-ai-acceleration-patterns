// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { endpointHost, httpsAgent, preconnect, sharedHandler } from '../../src/shared/http';

const requestMock = jest.fn();
jest.mock('node:https', () => ({ ...jest.requireActual('node:https'), request: (...args: unknown[]) => requestMock(...args) }));

/** ADR-0023: one socket pool per process; connections opened at init are the ones the first request reuses. */
describe('shared HTTPS pool', () => {
  it('endpointHost is the regional endpoint of the service, undefined without a Region', () => {
    expect(endpointHost('sts', 'eu-central-1')).toBe('sts.eu-central-1.amazonaws.com');
    expect(endpointHost('dynamodb', 'us-east-1')).toBe('dynamodb.us-east-1.amazonaws.com');
    expect(endpointHost('bedrock-agentcore', 'eu-central-1')).toBe('bedrock-agentcore.eu-central-1.amazonaws.com');
    expect(endpointHost('sts', undefined)).toBeUndefined();
    expect(endpointHost('sts', '')).toBeUndefined();
  });

  it('sharedHandler uses the one keep-alive agent and carries the timeouts it is given', async () => {
    const plain = await (sharedHandler() as any).configProvider;
    expect(plain.httpsAgent).toBe(httpsAgent);
    const timed = await (sharedHandler({ connectionTimeout: 500, requestTimeout: 1000 }) as any).configProvider;
    expect(timed).toMatchObject({ connectionTimeout: 500, requestTimeout: 1000 });
    expect(httpsAgent.keepAlive).toBe(true);
  });

  it('preconnect sends one empty POST per host on the shared agent, skips undefined hosts, and never rejects', async () => {
    const seen: string[] = [];
    requestMock.mockImplementation((options: any, callback?: any) => {
      seen.push(options.host);
      expect(options.agent).toBe(httpsAgent);
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({ 'Content-Length': '0' });
      const listeners: Record<string, () => void> = {};
      const req = {
        on: (event: string, fn: () => void) => {
          listeners[event] = fn;
          return req;
        },
        end: () => {
          if (options.host === 'down.example.com') {
            listeners.error();
          } else {
            callback({ resume: () => undefined, on: (event: string, fn: () => void) => event === 'end' && fn() });
          }
        },
        destroy: () => undefined,
      };
      return req;
    });
    await expect(preconnect(['sts.eu-central-1.amazonaws.com', undefined, 'down.example.com'])).resolves.toBeUndefined();
    expect(seen).toEqual(['sts.eu-central-1.amazonaws.com', 'down.example.com']);
  });
});

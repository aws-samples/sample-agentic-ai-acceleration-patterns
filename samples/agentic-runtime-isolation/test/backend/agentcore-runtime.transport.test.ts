// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  AgentCoreRuntimeBackend,
  customHeaders,
  decodeCredentials,
  encodeCredentials,
  RUNTIME_HEADERS,
  runtimePayload,
} from '../../src/backend/agentcore-runtime.transport';
import type { ValidatedRequest } from '../../src/backend/backend';
import { RUNTIME_ARN } from '../helpers';

/** The `agentcore-runtime` backend's five concerns on the request path (spec §3.4, ADR-0011, ADR-0012, ADR-0024). */
const credentials = { accessKeyId: 'ASIA-SYNTHETIC', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-token', expiration: '2026-01-01T00:15:00.000Z' };
const request = (overrides: Partial<ValidatedRequest> = {}): ValidatedRequest => ({
  tenantId: 'tenant-a',
  sub: 'user-a1',
  unitId: 's-abcdefghijklmnopqrstuvwxyz-conversationA1x0001',
  backend: 'agent',
  runtimeArn: RUNTIME_ARN,
  prompt: 'hello',
  ...overrides,
});

describe('credential transport', () => {
  it('round-trips as base64 JSON', () => {
    const header = encodeCredentials(credentials);
    expect(header).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(decodeCredentials(header)).toEqual(credentials);
    // About the size the spike measured (V-7: ~1.2 KB for real STS output).
    expect(header.length).toBeGreaterThan(100);
  });

  it('refuses an incomplete credential object', () => {
    expect(() => decodeCredentials(Buffer.from('{"accessKeyId":"x"}').toString('base64'))).toThrow(/incomplete/);
    expect(() => decodeCredentials('not base64 json')).toThrow();
  });
});

describe('customHeaders', () => {
  it('sets no header when neither option is on', () => {
    expect(customHeaders(request())).toEqual({});
  });

  it('sets the user-token header only with a forwarded token, the credential header only with credentials', () => {
    expect(customHeaders(request({ userToken: 'jwt' }))).toEqual({ [RUNTIME_HEADERS.USER_TOKEN]: 'jwt' });
    expect(customHeaders(request({ credentials }))).toEqual({ [RUNTIME_HEADERS.TENANT_CREDENTIALS]: encodeCredentials(credentials) });
  });

  it('the header names are the Runtime custom-header family the Gateway allows (ADR-0006)', () => {
    expect(RUNTIME_HEADERS.USER_TOKEN).toMatch(/^X-Amzn-Bedrock-AgentCore-Runtime-Custom-/);
    expect(RUNTIME_HEADERS.TENANT_CREDENTIALS).toMatch(/^X-Amzn-Bedrock-AgentCore-Runtime-Custom-/);
  });
});

describe('AgentCoreRuntimeBackend', () => {
  const mock = mockClient(BedrockAgentCoreClient);
  beforeEach(() => mock.reset());

  it('transportHeaders carries the unit id plus the custom headers (the Gateway path, ADR-0002)', () => {
    const backend = new AgentCoreRuntimeBackend();
    expect(backend.transportHeaders(request({ userToken: 'jwt' }))).toEqual({
      [RUNTIME_HEADERS.SESSION_ID]: 's-abcdefghijklmnopqrstuvwxyz-conversationA1x0001',
      [RUNTIME_HEADERS.USER_TOKEN]: 'jwt',
    });
  });

  it('runtimePayload is {prompt} and nothing else from the request', () => {
    expect(JSON.parse(Buffer.from(runtimePayload(request({ userToken: 'jwt', credentials }))).toString())).toEqual({ prompt: 'hello' });
  });

  it("invoke calls InvokeAgentRuntime on the request's Runtime with the unit id as runtimeSessionId and streams the response", async () => {
    async function* body() {
      yield Buffer.from('data: one\n\n');
      yield Buffer.from('data: two\n\n');
    }
    mock.on(InvokeAgentRuntimeCommand).resolves({ contentType: 'text/event-stream', response: body() as any });
    const backend = new AgentCoreRuntimeBackend(new BedrockAgentCoreClient({}));
    const response = await backend.invoke(request());
    expect(response.contentType).toBe('text/event-stream');
    const chunks: string[] = [];
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk).toString());
    }
    expect(chunks).toEqual(['data: one\n\n', 'data: two\n\n']);
    expect(mock).toHaveReceivedCommandWith(InvokeAgentRuntimeCommand, {
      agentRuntimeArn: RUNTIME_ARN,
      runtimeSessionId: 's-abcdefghijklmnopqrstuvwxyz-conversationA1x0001',
      contentType: 'application/json',
      accept: 'text/event-stream, application/json',
    });
    const sent = mock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input.payload as Uint8Array;
    expect(JSON.parse(Buffer.from(sent).toString())).toEqual({ prompt: 'hello' });
  });

  it('one instance serves every backend: the ARN is taken from each request (ADR-0024)', async () => {
    async function* body() {
      yield Buffer.from('{}');
    }
    mock.on(InvokeAgentRuntimeCommand).resolves({ contentType: 'application/json', response: body() as any });
    const other = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_billing-1';
    const backend = new AgentCoreRuntimeBackend(new BedrockAgentCoreClient({}));
    await backend.invoke(request());
    await backend.invoke(request({ backend: 'billing', runtimeArn: other }));
    const arns = mock.commandCalls(InvokeAgentRuntimeCommand).map((c) => c.args[0].input.agentRuntimeArn);
    expect(arns).toEqual([RUNTIME_ARN, other]);
  });

  it('invoke adds the custom headers at the build step so they are signed (spike V-6)', async () => {
    async function* body() {
      yield Buffer.from('{}');
    }
    mock.on(InvokeAgentRuntimeCommand).resolves({ contentType: 'application/json', response: body() as any });
    const backend = new AgentCoreRuntimeBackend(new BedrockAgentCoreClient({}));
    await backend.invoke(request({ userToken: 'jwt', credentials }));
    const command = mock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0];
    // The middleware is registered on the command's stack under its name.
    const names = (command.middlewareStack as any).identify() as string[];
    expect(names.some((n) => n.startsWith('runtimeCustomHeaders'))).toBe(true);
  });

  it('invoke fails when there is no runtime ARN or no body', async () => {
    await expect(new AgentCoreRuntimeBackend(new BedrockAgentCoreClient({})).invoke(request({ runtimeArn: '' }))).rejects.toThrow(/runtime ARN/);
    expect(mock).toHaveReceivedCommandTimes(InvokeAgentRuntimeCommand, 0);
    mock.on(InvokeAgentRuntimeCommand).resolves({ contentType: 'application/json' });
    await expect(new AgentCoreRuntimeBackend(new BedrockAgentCoreClient({})).invoke(request())).rejects.toThrow(/no response body/);
  });
});

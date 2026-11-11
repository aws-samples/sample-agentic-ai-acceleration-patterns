// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  buildReport,
  conversationIdOf,
  delegateProbe,
  callToolsGateway,
  converse,
  gatewayClients,
  headerShapes,
  jwtShape,
  MCP_PROTOCOL_VERSION,
  McpSessions,
  parseGatewayUrls,
  isProbe,
  MAX_PROMPT_CHARS,
  NONCE,
  promptOf,
  respond,
  type AgentClients,
  type ResponseSink,
  toolProbe,
  unverifiedClaims,
} from '../../src/agent/app';
import { encodeCredentials, RUNTIME_HEADERS } from '../../src/backend/agentcore-runtime.transport';
import { parseUsageEvent } from '../../src/shared/metrics';

/** The sample agent (spec C-2, ADR-0017): calls the one model, reports what reached it, ends every stream with a usage event, never echoes a header value. */
const credentials = { accessKeyId: 'ASIA-SYNTHETIC', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-token', expiration: '2026-01-01T00:15:00.000Z' };
const token = `h.${Buffer.from(
  JSON.stringify({
    tenant_id: 'tenant-a',
    scope: 'default/chat crm/*',
    sub: 'tenant-a#user-a1',
    user: 'user-a1',
    agent: 'default',
    aud: ['agent:default', 'tools-gateway:default'],
    act: { sub: 'arn:aws:iam::111122223333:role/ingress' },
    exp: 2_000_000_000,
  }),
).toString('base64url')}.sig`;
const MODEL_ID = 'amazon.nova-lite-v1:0';

const bedrockMock = mockClient(BedrockRuntimeClient);

const clients = (items: Record<string, Record<string, unknown>>, deny = false): AgentClients & { sent: unknown[] } => {
  const sent: unknown[] = [];
  return {
    sent,
    sts: () => ({
      send: async (cmd: unknown) => {
        sent.push(cmd);
        return { Arn: 'arn:aws:sts::111122223333:assumed-role/tenant/tenant-tenant-a' } as any;
      },
    }),
    dynamo: () => ({
      send: async (cmd: unknown) => {
        sent.push(cmd);
        if (deny) {
          const e = new Error('denied');
          e.name = 'AccessDeniedException';
          throw e;
        }
        const key = (cmd as GetItemCommand).input.Key!.PK.S!;
        return { Item: items[key] } as any;
      },
    }),
    bedrock: () => new BedrockRuntimeClient({ region: 'eu-central-1' }),
  };
};

/** The vended credentials in the agent's SDK shape (expiration as a Date), for the model/data clients. */
const sdkCreds = { accessKeyId: 'ASIA-SYNTHETIC', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-token', expiration: new Date('2026-01-01T00:15:00.000Z') };

/** A ConverseStream reply: text deltas then the metadata event with usage. */
async function* converseStream(deltas: string[], usage?: { inputTokens: number; outputTokens: number }): AsyncGenerator<ConverseStreamOutput> {
  yield { messageStart: { role: 'assistant' } };
  for (const text of deltas) {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } };
  }
  yield { contentBlockStop: { contentBlockIndex: 0 } };
  yield { messageStop: { stopReason: 'end_turn' } };
  if (usage !== undefined) {
    yield { metadata: { usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens }, metrics: { latencyMs: 10 } } };
  }
}

interface Captured {
  status?: number;
  headers?: Record<string, string>;
  body: string;
  ended: boolean;
  close?: () => void;
}

const sink = (): { c: Captured; s: ResponseSink } => {
  const c: Captured = { body: '', ended: false };
  return {
    c,
    s: {
      head: (status, headers) => {
        c.status = status;
        c.headers = headers;
      },
      write: (text) => {
        c.body += text;
      },
      end: () => {
        c.ended = true;
      },
      onClose: (listener) => {
        c.close = listener;
      },
    },
  };
};

/** Splits an SSE body into events: { event?, data }. */
function events(body: string): { event?: string; data: string }[] {
  return body
    .split('\n\n')
    .filter((b) => b.length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice('event:'.length).trim();
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice('data:'.length).trim())
        .join('\n');
      return event === undefined ? { data } : { event, data };
    });
}

beforeEach(() => bedrockMock.reset());

describe('promptOf', () => {
  it('accepts prompt at the top level or under input; refuses non-strings and over-long strings', () => {
    expect(promptOf('{"prompt":"hi"}')).toBe('hi');
    expect(promptOf('{"input":{"prompt":"hi"}}')).toBe('hi');
    expect(promptOf('{"prompt":42}')).toBeUndefined();
    expect(promptOf('{}')).toBeUndefined();
    expect(promptOf('')).toBeUndefined();
    expect(promptOf('nope')).toBeUndefined();
    expect(promptOf(JSON.stringify({ prompt: 'x'.repeat(MAX_PROMPT_CHARS) }))).toHaveLength(MAX_PROMPT_CHARS);
    expect(promptOf(JSON.stringify({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }))).toBeUndefined();
  });
});

describe('isProbe', () => {
  it('names the three probe commands and nothing else', () => {
    expect(isProbe('report')).toBe(true);
    expect(isProbe('read tenant-a')).toBe(true);
    expect(isProbe('stream 10')).toBe(true);
    expect(isProbe('hello')).toBe(false);
    expect(isProbe('report on the weather')).toBe(false);
    expect(isProbe('read me a story')).toBe(false);
    expect(isProbe('stream of consciousness')).toBe(false);
  });
});

describe('unverifiedClaims', () => {
  it('decodes the transaction token claims the report shows, for display only', () => {
    expect(unverifiedClaims(token)).toMatchObject({
      tenant_id: 'tenant-a',
      agent: 'default',
      scope: 'default/chat crm/*',
      aud: ['agent:default', 'tools-gateway:default'],
      actSub: 'arn:aws:iam::111122223333:role/ingress',
      exp: 2_000_000_000,
    });
    expect(unverifiedClaims('garbage')).toBeNull();
  });
});

describe('buildReport', () => {
  it('reports the unit id, its prefix, the per-VM nonce, and no token or credentials when none arrived', async () => {
    const report = await buildReport({ [RUNTIME_HEADERS.SESSION_ID.toLowerCase()]: 's-abcdefghijklmnopqrstuvwxyz-conversationA1x0001' }, 'report', undefined);
    expect(report).toEqual({
      nonce: NONCE,
      unitId: 's-abcdefghijklmnopqrstuvwxyz-conversationA1x0001',
      sessionPrefix: 'abcdefghijklmnopqrstuvwxyz',
      transactionToken: false,
      tokenTenant: null,
      tokenAgent: null,
      tokenScope: null,
      tokenAud: null,
      tokenActSub: null,
      chain: [],
      tokenExp: null,
      tokenIss: null,
      tokenTyp: null,
      tokenKid: null,
      tokenSub: null,
      tokenUser: null,
      headerNames: [RUNTIME_HEADERS.SESSION_ID.toLowerCase()],
      jwtHeaders: [],
      credentials: false,
    });
    expect(NONCE).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports the transaction token by its claims, never the token itself (C-2)', async () => {
    const report = await buildReport({ [RUNTIME_HEADERS.TRANSACTION_TOKEN.toLowerCase()]: token }, 'report', undefined);
    expect(report.transactionToken).toBe(true);
    expect(report.tokenTenant).toBe('tenant-a');
    expect(report.tokenAgent).toBe('default');
    expect(report.tokenScope).toBe('default/chat crm/*');
    expect(report.tokenAud).toEqual(['agent:default', 'tools-gateway:default']);
    expect(report.tokenActSub).toBe('arn:aws:iam::111122223333:role/ingress');
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("'read <tenant>' uses the vended credentials and returns the item; the caller ARN is reported", async () => {
    const c = clients({ 'TENANT#tenant-a': { PK: { S: 'TENANT#tenant-a' }, secret: { S: 'alpha' } } });
    const report = await buildReport(
      { [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: encodeCredentials(credentials) },
      'read tenant-a',
      'demo-table',
      c,
    );
    expect(report.credentials).toBe(true);
    expect(report.callerArn).toBe('arn:aws:sts::111122223333:assumed-role/tenant/tenant-tenant-a');
    expect(report.read).toEqual({ tenant: 'tenant-a', result: 'ok', item: { PK: 'TENANT#tenant-a', secret: 'alpha' } });
    expect(c.sent[0]).toBeInstanceOf(GetCallerIdentityCommand);
    expect((c.sent[1] as GetItemCommand).input).toEqual({ TableName: 'demo-table', Key: { PK: { S: 'TENANT#tenant-a' } } });
    expect(JSON.stringify(report)).not.toContain('synthetic-secret');
  });

  it("'read <other tenant>' surfaces IAM's refusal by name (the wall is IAM, P-8)", async () => {
    const report = await buildReport(
      { [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: encodeCredentials(credentials) },
      'read tenant-b',
      'demo-table',
      clients({}, true),
    );
    expect(report.read).toEqual({ tenant: 'tenant-b', result: 'error', error: 'AccessDeniedException' });
  });

  it("'read' without credentials, without a table, or with a malformed header reports why", async () => {
    expect((await buildReport({}, 'read tenant-a', 'demo-table')).read).toEqual({ tenant: 'tenant-a', result: 'error', error: 'NoCredentials' });
    const h = { [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: encodeCredentials(credentials) };
    expect((await buildReport(h, 'read tenant-a', undefined)).read).toEqual({ tenant: 'tenant-a', result: 'error', error: 'NoTable' });
    expect((await buildReport({ [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: 'bad' }, 'read tenant-a', 't')).read).toEqual({
      tenant: 'tenant-a',
      result: 'error',
      error: 'MalformedCredentials',
    });
  });
});

describe('converse', () => {
  it('streams each text delta as a data event and returns the usage from the metadata event', async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({ stream: converseStream(['Hel', 'lo'], { inputTokens: 17, outputTokens: 42 }) } as any);
    const written: string[] = [];
    const usage = await converse('what is runtime isolation?', MODEL_ID, sdkCreds, (t) => written.push(t), clients({}));
    expect(usage).toEqual({ inputTokens: 17, outputTokens: 42, modelId: MODEL_ID });
    expect(written).toEqual(['data: {"text":"Hel"}\n\n', 'data: {"text":"lo"}\n\n']);
    expect(bedrockMock).toHaveReceivedCommandTimes(ConverseStreamCommand, 1);
    const input = bedrockMock.commandCalls(ConverseStreamCommand)[0].args[0].input;
    expect(input.modelId).toBe(MODEL_ID);
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: 'what is runtime isolation?' }] }]);
    expect(input.inferenceConfig?.maxTokens).toBeDefined();
  });

  it('fails by name when the stream ends without metadata (no usage to report)', async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({ stream: converseStream(['x']) } as any);
    await expect(converse('hi', MODEL_ID, sdkCreds, () => {}, clients({}))).rejects.toMatchObject({ name: 'NoUsageMetadata' });
  });
});

describe('respond', () => {
  const headers = { [RUNTIME_HEADERS.SESSION_ID.toLowerCase()]: 's-abcdefghijklmnopqrstuvwxyz-conversationA1x0001' };
  // A model prompt requires the vended credential header (ADR-0018): the model client is built from it.
  const modelHeaders = { ...headers, [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: encodeCredentials(credentials) };

  it('a model prompt: SSE text deltas, then the usage event LAST with the tokens and the model id (ADR-0017)', async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({ stream: converseStream(['Hel', 'lo'], { inputTokens: 17, outputTokens: 42 }) } as any);
    const { c, s } = sink();
    await respond(modelHeaders, 'what is runtime isolation?', { modelId: MODEL_ID }, s, clients({}));
    expect(c.status).toBe(200);
    expect(c.headers).toEqual({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    expect(c.ended).toBe(true);
    const evs = events(c.body);
    expect(evs).toEqual([
      { data: '{"text":"Hel"}' },
      { data: '{"text":"lo"}' },
      { event: 'usage', data: `{"inputTokens":17,"outputTokens":42,"modelId":"${MODEL_ID}"}` },
    ]);
    // The ingress parser reads exactly this.
    expect(parseUsageEvent(c.body)).toEqual({ inputTokens: 17, outputTokens: 42, modelId: MODEL_ID });
  });

  it.each(['report', 'read tenant-a'])("probe '%s': the report as a data event, then a zero usage event, no model call", async (prompt) => {
    const { c, s } = sink();
    await respond(headers, prompt, { modelId: MODEL_ID, tableName: 'demo-table' }, s, clients({}));
    expect(bedrockMock).not.toHaveReceivedCommand(ConverseStreamCommand);
    expect(c.status).toBe(200);
    expect(c.headers?.['Content-Type']).toBe('text/event-stream');
    const evs = events(c.body);
    expect(evs).toHaveLength(2);
    const report = JSON.parse(evs[0].data);
    expect(report.nonce).toBe(NONCE);
    expect(report.sessionPrefix).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(evs[1]).toEqual({ event: 'usage', data: '{"inputTokens":0,"outputTokens":0}' });
    expect(parseUsageEvent(c.body)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(c.ended).toBe(true);
  });

  it("probe 'stream N': the report first, one event per interval, a zero usage event last", async () => {
    const { c, s } = sink();
    // N=0 ends on the first tick: wall time is N seconds whatever the interval.
    await respond(headers, 'stream 0', { modelId: MODEL_ID, streamIntervalMs: 5 }, s, clients({}));
    expect(bedrockMock).not.toHaveReceivedCommand(ConverseStreamCommand);
    const evs = events(c.body);
    expect(evs).toHaveLength(3);
    expect(JSON.parse(evs[0].data)).toMatchObject({ t: 0, report: { nonce: NONCE } });
    expect(evs[1].event).toBeUndefined();
    expect(JSON.parse(evs[1].data)).toEqual({ t: 0.005 });
    expect(evs[2]).toEqual({ event: 'usage', data: '{"inputTokens":0,"outputTokens":0}' });
    expect(c.ended).toBe(true);
  });

  it('a model failure is an error event with the error NAME only, and no usage event (the gap is visible, not guessed)', async () => {
    const error = new Error('model said: the prompt was <content>');
    error.name = 'ThrottlingException';
    bedrockMock.on(ConverseStreamCommand).rejects(error);
    const { c, s } = sink();
    await respond(modelHeaders, 'hello', { modelId: MODEL_ID }, s, clients({}));
    expect(c.status).toBe(200);
    expect(events(c.body)).toEqual([{ event: 'error', data: '{"error":"ThrottlingException"}' }]);
    expect(c.body).not.toContain('<content>');
    expect(parseUsageEvent(c.body)).toBeUndefined();
    expect(c.ended).toBe(true);
  });

  it('a model prompt without the credential header is a NoCredentials error, no model call, no fallback (ADR-0018)', async () => {
    const { c, s } = sink();
    await respond(headers, 'hello', { modelId: MODEL_ID }, s, clients({}));
    expect(bedrockMock).not.toHaveReceivedCommand(ConverseStreamCommand);
    expect(events(c.body)).toEqual([{ event: 'error', data: '{"error":"NoCredentials"}' }]);
    expect(parseUsageEvent(c.body)).toBeUndefined();
    expect(c.ended).toBe(true);
  });

  it('a model prompt with a malformed credential header is a MalformedCredentials error, no model call (ADR-0018)', async () => {
    const { c, s } = sink();
    await respond({ ...headers, [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: 'not-base64-json' }, 'hello', { modelId: MODEL_ID }, s, clients({}));
    expect(bedrockMock).not.toHaveReceivedCommand(ConverseStreamCommand);
    expect(events(c.body)).toEqual([{ event: 'error', data: '{"error":"MalformedCredentials"}' }]);
    expect(c.ended).toBe(true);
  });

  it('without MODEL_ID a model prompt is an error event, not a crash', async () => {
    const { c, s } = sink();
    await respond(headers, 'hello', {}, s, clients({}));
    expect(bedrockMock).not.toHaveReceivedCommand(ConverseStreamCommand);
    expect(events(c.body)).toEqual([{ event: 'error', data: '{"error":"NoModelConfigured"}' }]);
    expect(c.ended).toBe(true);
  });

  it('writes nothing to the process log (stdout, stderr, console) for a prompt, a reply or a model error: content never leaves the response (P-10)', async () => {
    const PROMPT = 'tell me about tenant-a <prompt-content>';
    const REPLY = 'the reply <reply-content>';
    const spies = [
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true),
      jest.spyOn(process.stderr, 'write').mockImplementation(() => true),
      jest.spyOn(console, 'log').mockImplementation(() => {}),
      jest.spyOn(console, 'error').mockImplementation(() => {}),
      jest.spyOn(console, 'warn').mockImplementation(() => {}),
    ];
    try {
      bedrockMock.on(ConverseStreamCommand).resolvesOnce({ stream: converseStream([REPLY], { inputTokens: 3, outputTokens: 4 }) } as any);
      const ok = sink();
      await respond(modelHeaders, PROMPT, { modelId: MODEL_ID }, ok.s, clients({}));
      expect(ok.c.body).toContain(REPLY);

      const error = new Error(`validation failed for: ${PROMPT}`);
      error.name = 'ValidationException';
      bedrockMock.on(ConverseStreamCommand).rejects(error);
      const failed = sink();
      await respond(modelHeaders, PROMPT, { modelId: MODEL_ID }, failed.s, clients({}));
      expect(events(failed.c.body)).toEqual([{ event: 'error', data: '{"error":"ValidationException"}' }]);

      const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' '))).join('\n');
      expect(logged).toBe('');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it('never writes a header value into the response: not the token, not the credentials', async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({ stream: converseStream(['ok'], { inputTokens: 1, outputTokens: 1 }) } as any);
    const h = {
      ...headers,
      [RUNTIME_HEADERS.TRANSACTION_TOKEN.toLowerCase()]: token,
      [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: encodeCredentials(credentials),
    };
    for (const prompt of ['report', 'hello']) {
      const { c, s } = sink();
      await respond(h, prompt, { modelId: MODEL_ID }, s, clients({}));
      expect(c.body).not.toContain(token);
      expect(c.body).not.toContain('synthetic-secret');
      expect(c.body).not.toContain(encodeCredentials(credentials));
    }
  });
});

describe('tool probes (C-2)', () => {
  const sinkOf = () => {
    const c = { body: '' };
    const s: ResponseSink = { head: () => undefined, write: (t) => void (c.body += t), end: () => undefined };
    return { c, s };
  };

  it('toolProbe parses `tools` and `tool <target>/<tool> <json>`; anything else is not a tool probe', () => {
    expect(toolProbe('tools')).toEqual({ method: 'tools/list' });
    expect(toolProbe('tool crm/get_account {"accountId":"a1"}')).toEqual({ method: 'tools/call', name: 'crm___get_account', arguments: { accountId: 'a1' } });
    expect(toolProbe('tool crm/list_cases')).toEqual({ method: 'tools/call', name: 'crm___list_cases', arguments: {} });
    expect(toolProbe('tool crm/get_account [1]')).toBeUndefined();
    expect(toolProbe('tool crm/get_account {bad')).toBeUndefined();
    expect(toolProbe('tool Crm/x')).toBeUndefined();
    expect(toolProbe('tools please')).toBeUndefined();
  });

  it('calls the tools gateway with the transaction token as bearer and returns the result; never echoes the token', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'crm___get_account' }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { c, s } = sinkOf();
    const headers = { [RUNTIME_HEADERS.TRANSACTION_TOKEN.toLowerCase()]: token };
    await respond(headers, 'tools', { toolsGatewayUrl: 'https://tools.example.com/mcp', fetch: fetcher }, s);
    expect(seen.url).toBe('https://tools.example.com/mcp');
    expect((seen.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(seen.init!.body))).toMatchObject({ method: 'tools/list' });
    expect(c.body).toContain('crm___get_account');
    expect(c.body).not.toContain(token);
    expect(c.body).toContain('event: usage');
  });

  it('a refused call returns the error message; no gateway or no token is an error event', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'forbidden: tool_not_granted' } }), { status: 403 })) as unknown as typeof fetch;
    const one = sinkOf();
    await respond({ [RUNTIME_HEADERS.TRANSACTION_TOKEN.toLowerCase()]: token }, 'tool invoices/get_invoice {}', { toolsGatewayUrl: 'https://t/mcp', fetch: fetcher }, one.s);
    expect(one.c.body).toContain('forbidden: tool_not_granted');
    const two = sinkOf();
    await respond({}, 'tools', { toolsGatewayUrl: 'https://t/mcp', fetch: fetcher }, two.s);
    expect(two.c.body).toContain('NoTransactionToken');
    const three = sinkOf();
    await respond({ [RUNTIME_HEADERS.TRANSACTION_TOKEN.toLowerCase()]: token }, 'tools', {}, three.s);
    expect(three.c.body).toContain('NoToolsGateway');
  });

  describe('several tools gateways (ADR-0041)', () => {
    const twoGatewayToken = `h.${Buffer.from(
      JSON.stringify({ tenant_id: 'tenant-a', scope: 'crm/* invoices/*', agent: 'default', aud: ['agent:default', 'tools-gateway:default', 'tools-gateway:finance'] }),
    ).toString('base64url')}.sig`;
    const urls = { default: 'https://default.example.com/mcp', finance: 'https://finance.example.com/mcp', other: 'https://other.example.com/mcp' };

    it('parseGatewayUrls reads the JSON map and refuses anything else', () => {
      expect(parseGatewayUrls(JSON.stringify(urls))).toEqual(urls);
      expect(parseGatewayUrls(JSON.stringify({ a: 'u', b: 1 }))).toEqual({ a: 'u' });
      expect(parseGatewayUrls('[1]')).toBeUndefined();
      expect(parseGatewayUrls('{bad')).toBeUndefined();
      expect(parseGatewayUrls(undefined)).toBeUndefined();
    });

    it('keeps one client per gateway in aud that has a URL; the single-URL option is the default gateway', () => {
      expect(gatewayClients({ toolsGatewayUrls: urls }, ['agent:default', 'tools-gateway:default', 'tools-gateway:finance'])).toEqual([
        ['default', urls.default],
        ['finance', urls.finance],
      ]);
      expect(gatewayClients({ toolsGatewayUrls: urls }, ['agent:default'])).toEqual([]);
      expect(gatewayClients({ toolsGatewayUrl: urls.default }, ['agent:default', 'tools-gateway:finance'])).toEqual([]);
      expect(gatewayClients({ toolsGatewayUrl: urls.default }, ['tools-gateway:default'])).toEqual([['default', urls.default]]);
    });

    it('lists every gateway in aud, and calls a tool on the gateway that lists it', async () => {
      const seen: { url: string; method: string }[] = [];
      const fetcher = (async (url: string, init: RequestInit) => {
        const method = JSON.parse(String(init.body)).method as string;
        seen.push({ url, method });
        const tools = url === urls.finance ? [{ name: 'invoices___get_invoice' }] : [{ name: 'crm___get_account' }];
        const result = method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: `from ${url}` }] };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
      }) as unknown as typeof fetch;
      const headers = { [RUNTIME_HEADERS.TRANSACTION_TOKEN.toLowerCase()]: twoGatewayToken };
      const list = sinkOf();
      await respond(headers, 'tools', { toolsGatewayUrls: urls, fetch: fetcher }, list.s);
      expect(list.c.body).toContain('crm___get_account');
      expect(list.c.body).toContain('invoices___get_invoice');
      expect(seen.filter((s) => s.method === 'tools/list').map((s) => s.url)).toEqual([urls.default, urls.finance]);
      expect(seen.filter((s) => s.method === 'initialize').map((s) => s.url)).toEqual([urls.default, urls.finance]);
      seen.length = 0;
      const call = sinkOf();
      await respond(headers, 'tool invoices/get_invoice {}', { toolsGatewayUrls: urls, fetch: fetcher }, call.s);
      expect(call.c.body).toContain(`from ${urls.finance}`);
      expect(seen.filter((s) => s.method === 'tools/call').map((s) => s.url)).toEqual([urls.finance]);
      // The lists of this token's life are cached (spec §3.6): the call lists nothing again.
      expect(seen.filter((s) => s.method === 'tools/list')).toEqual([]);
      expect(seen.some((s) => s.url === urls.other)).toBe(false);
    });
  });

  describe('MCP session (spec §3.6)', () => {
    const url = 'https://tools.example.com/mcp';
    interface Seen {
      readonly method: string;
      readonly session?: string;
      readonly params: any;
    }

    function gateway(options: { sessionId?: string; pages?: string[][]; expireOnce?: boolean; now?: () => number } = {}) {
      const seen: Seen[] = [];
      let expired = false;
      const fetcher = (async (_: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const headers = init.headers as Record<string, string>;
        seen.push({ method: body.method, session: headers['Mcp-Session-Id'], params: body.params });
        if (body.method === 'initialize') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } }), {
            status: 200,
            headers: options.sessionId === undefined ? {} : { 'Mcp-Session-Id': options.sessionId },
          });
        }
        if (body.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        if (options.expireOnce === true && !expired && body.method === 'tools/call') {
          expired = true;
          return new Response('', { status: 404 });
        }
        if (body.method === 'tools/list') {
          const pages = options.pages ?? [['crm___get_account']];
          const index = body.params?.cursor === undefined ? 0 : Number(body.params.cursor);
          const result = { tools: pages[index].map((name) => ({ name })), ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}) };
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [] } }), { status: 200 });
      }) as unknown as typeof fetch;
      return { seen, sessions: new McpSessions(fetcher, options.now ?? (() => 1_000_000_000_000)) };
    }

    it('initialize (protocol 2025-11-25), notifications/initialized, then the request; the session id rides every later request', async () => {
      const { seen, sessions } = gateway({ sessionId: 'session-1' });
      await sessions.request(url, token, 2_000_000_000, 'tools/call', { name: 'crm___get_account', arguments: {} });
      await sessions.request(url, token, 2_000_000_000, 'tools/call', { name: 'crm___list_cases', arguments: {} });
      expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
      expect(seen[0].params).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: 'runtime-isolation-agent' } });
      expect(seen[0].session).toBeUndefined();
      expect(seen.slice(1).every((s) => s.session === 'session-1')).toBe(true);
    });

    it('a gateway without session ids is initialised once per token', async () => {
      const { seen, sessions } = gateway();
      await sessions.request(url, token, 2_000_000_000, 'tools/list', {});
      await sessions.request(url, token, 2_000_000_000, 'tools/list', {});
      expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(1);
    });

    it('a 404 on a session initialises again, once', async () => {
      const { seen, sessions } = gateway({ sessionId: 'session-1', expireOnce: true });
      const answer = await sessions.request(url, token, 2_000_000_000, 'tools/call', { name: 'x', arguments: {} });
      expect(answer).toEqual({ result: { content: [] }, status: 200 });
      expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(2);
    });

    it('tools/list reads every page and caches the names until the token expires', async () => {
      let clock = 1_000_000_000_000;
      const { sessions } = gateway({ pages: [['crm___get_account'], ['crm___list_cases', 'crm___update_case']], now: () => clock });
      const answer = await sessions.listAll(url, token, 2_000_000_000);
      expect(((answer as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name)).toEqual(['crm___get_account', 'crm___list_cases', 'crm___update_case']);
      expect(sessions.cachedTools(url, token, 2_000_000_000)).toEqual(['crm___get_account', 'crm___list_cases', 'crm___update_case']);
      // Once the token has expired its session and cache are gone.
      clock = 2_000_000_001_000;
      expect(sessions.cachedTools(url, token, 2_000_000_000)).toBeUndefined();
    });

    it('an initialize refused by the gateway is the answer, with its HTTP status', async () => {
      const fetcher = (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'insufficient_scope' } }), { status: 403 })) as unknown as typeof fetch;
      expect(await callToolsGateway(url, token, { method: 'tools/list' }, fetcher)).toEqual({ error: 'insufficient_scope', status: 403 });
    });
  });

  describe('header shapes (integ step 11)', () => {
    it('names every header and reports only typ and iss of the JWT-shaped ones, never a value', () => {
      const identity = `eyJ${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url').slice(3)}.${Buffer.from(JSON.stringify({ iss: 'https://cognito-idp.example.com/pool' })).toString('base64url')}.sig`;
      const txn = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'txn+jwt' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'https://issuer.example.com/prod' })).toString('base64url')}.sig`;
      const shapes = headerShapes({ 'x-b': 'plain', 'authorization': `Bearer ${identity}`, 'x-a': txn });
      expect(shapes.headerNames).toEqual(['authorization', 'x-a', 'x-b']);
      expect(shapes.jwtHeaders).toEqual([
        { name: 'authorization', typ: null, iss: 'https://cognito-idp.example.com/pool' },
        { name: 'x-a', typ: 'txn+jwt', iss: 'https://issuer.example.com/prod' },
      ]);
      expect(JSON.stringify(shapes)).not.toContain(identity);
      expect(jwtShape('a.b')).toBeUndefined();
    });
  });
});

describe('delegation probe (ADR-0048, C-2)', () => {
  const callerToken = `h.${Buffer.from(JSON.stringify({ tenant_id: 'tenant-a', agent: 'default', aud: ['agent:default'], act: { sub: 'arn:aws:iam::111122223333:role/ingress' } })).toString('base64url')}.sig`;
  const headers = { [RUNTIME_HEADERS.TRANSACTION_TOKEN.toLowerCase()]: callerToken };

  it('delegateProbe reads the target and the prompt; anything else is not a delegation', () => {
    expect(delegateProbe('delegate billing what is due?')).toEqual({ agent: 'billing', prompt: 'what is due?' });
    expect(delegateProbe('delegate billing   report ')).toEqual({ agent: 'billing', prompt: 'report' });
    expect(delegateProbe('delegate Billing x')).toBeUndefined();
    expect(delegateProbe('delegate billing')).toBeUndefined();
    expect(delegateProbe('delegated billing x')).toBeUndefined();
  });

  it('conversationIdOf reads a well-formed id from the Runtime payload, else nothing', () => {
    expect(conversationIdOf('{"prompt":"x","conversationId":"conversationA1x0001"}')).toBe('conversationA1x0001');
    expect(conversationIdOf('{"input":{"prompt":"x","conversationId":"c-1"}}')).toBe('c-1');
    expect(conversationIdOf('{"prompt":"x"}')).toBeUndefined();
    expect(conversationIdOf('{"prompt":"x","conversationId":"bad id"}')).toBeUndefined();
    expect(conversationIdOf('nope')).toBeUndefined();
  });

  it('posts to <url>/<agent>/delegations with the token as bearer and the conversation, relays the stream as delegated events, then usage', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: report\ndata: {"a":1}\n\n'));
          controller.enqueue(new TextEncoder().encode('event: usage\ndata: {}\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const { c, s } = sink();
    await respond(headers, 'delegate billing what is due?', { delegationUrl: 'https://api.example.com/prod/', conversationId: 'conversationA1x0001', fetch: fetcher }, s, clients({}));
    expect(calls[0].url).toBe('https://api.example.com/prod/billing/delegations');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${callerToken}`);
    expect((calls[0].init.headers as Record<string, string>)['x-tenant-id']).toBe('tenant-a'); // multiTenant identity source (spec §3.7)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ prompt: 'what is due?', conversationId: 'conversationA1x0001' });
    const evs = events(c.body);
    expect(evs[0].event).toBe('delegated');
    expect(JSON.parse(evs[0].data)).toMatchObject({ agent: 'billing' });
    expect(evs.map((e) => e.event).filter((e) => e === 'delegated').length).toBeGreaterThanOrEqual(1);
    expect(evs[evs.length - 1].event).toBe('usage');
  });

  it('a refusal is one error event with the status and the fixed body; no URL is NoDelegation; no token is NoTransactionToken', async () => {
    const refusing = (async () => new Response('forbidden: delegation_not_declared', { status: 403 })) as typeof fetch;
    const one = sink();
    await respond(headers, 'delegate billing x', { delegationUrl: 'https://api.example.com/prod', fetch: refusing }, one.s, clients({}));
    expect(events(one.c.body)[0]).toEqual({ event: 'error', data: '{"error":"DelegationRefused","status":403,"body":"forbidden: delegation_not_declared"}' });
    const two = sink();
    await respond(headers, 'delegate billing x', {}, two.s, clients({}));
    expect(two.c.body).toContain('NoDelegation');
    const three = sink();
    await respond({}, 'delegate billing x', { delegationUrl: 'https://api.example.com/prod' }, three.s, clients({}));
    expect(three.c.body).toContain('NoTransactionToken');
  });

  it('the report shows the chain of a nested act, outermost first', async () => {
    const nested = `h.${Buffer.from(JSON.stringify({ tenant_id: 'tenant-a', agent: 'billing', act: { sub: 'agent:planner', act: { sub: 'agent:default', act: { sub: 'arn:aws:iam::111122223333:role/ingress' } } } })).toString('base64url')}.sig`;
    const report = await buildReport({ [RUNTIME_HEADERS.TRANSACTION_TOKEN.toLowerCase()]: nested }, 'report', undefined, clients({}));
    expect(report.chain).toEqual(['planner', 'default']);
    expect(report.tokenActSub).toBe('agent:planner');
  });
});

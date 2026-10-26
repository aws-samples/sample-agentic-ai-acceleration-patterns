// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  buildReport,
  converse,
  isProbe,
  MAX_PROMPT_CHARS,
  NONCE,
  promptOf,
  respond,
  type AgentClients,
  type ResponseSink,
  unverifiedClaims,
} from '../../src/agent/app';
import { encodeCredentials, RUNTIME_HEADERS } from '../../src/backend/agentcore-runtime.transport';
import { parseUsageEvent } from '../../src/shared/metrics';

/** The sample agent (spec C-2, ADR-0017): calls the one model, reports what reached it, ends every stream with a usage event, never echoes a header value. */
const credentials = { accessKeyId: 'ASIA-SYNTHETIC', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-token', expiration: '2026-01-01T00:15:00.000Z' };
const token = `h.${Buffer.from(JSON.stringify({ tenant_id: 'tenant-a', scope: 'tenant-api/read', sub: 'user-a1' })).toString('base64url')}.sig`;
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
  it('decodes tenant_id and scope for display only', () => {
    expect(unverifiedClaims(token)).toEqual({ tenant_id: 'tenant-a', scope: 'tenant-api/read' });
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
      forwardedToken: false,
      forwardedTenant: null,
      forwardedScope: null,
      credentials: false,
    });
    expect(NONCE).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports the forwarded token by its non-secret claims, never the token itself', async () => {
    const report = await buildReport({ [RUNTIME_HEADERS.USER_TOKEN.toLowerCase()]: token }, 'report', undefined);
    expect(report.forwardedToken).toBe(true);
    expect(report.forwardedTenant).toBe('tenant-a');
    expect(report.forwardedScope).toBe('tenant-api/read');
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
      [RUNTIME_HEADERS.USER_TOKEN.toLowerCase()]: token,
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

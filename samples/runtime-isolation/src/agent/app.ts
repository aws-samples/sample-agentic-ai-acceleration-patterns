// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sample agent (spec C-2). It runs inside the isolation unit, calls the
 * one model its execution role allows, and reports what reached it so the
 * integration test can prove the mapping. Every response is an SSE stream
 * whose LAST event is `event: usage` (ADR-0017): the ingress reads the token
 * figures from it and attributes them to the tenant; the client sees the
 * same event. Three probe prompts never call the model:
 *
 *   `report`           the echo report: the unit id the Runtime handed it,
 *                      the prefix part of that id, a nonce chosen once per
 *                      microVM, whether a user token or tenant credentials
 *                      arrived, and the forwarded token's non-secret claims;
 *   `read <tenantId>`  the report plus a GetItem of `TENANT#<tenantId>` from
 *                      the demo table with the vended credentials (P-8; a
 *                      cross-tenant read fails in IAM, not here);
 *   `stream <N>`       an SSE stream of N seconds (capped at 120), one event
 *                      every two seconds, for the streaming checks (V-4, V-5).
 *
 * Any other prompt goes to the model (`MODEL_ID`) through Bedrock
 * ConverseStream; text deltas stream as `data:` events and the usage event
 * carries the input and output tokens from the ConverseStream metadata.
 *
 * It never logs or echoes a header value: not the token, not the credentials
 * (ADR-0006, ADR-0012, spike V-7). It validates that `prompt` is a string of
 * bounded length (Runtime input validation best practice).
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { decodeCredentials, RUNTIME_HEADERS } from '../backend/agentcore-runtime.transport';
import { AGENT_ENV } from '../shared/config';
import { USAGE_EVENT, type UsageEvent } from '../shared/metrics';
import { prefixOf } from '../shared/session';
import type { VendedCredentials } from '../shared/tvm';

/** One per process, and the Runtime runs one process per microVM. */
export const NONCE = randomUUID();

const PORT = 8080;
const MAX_STREAM_SECONDS = 120;
const STREAM_INTERVAL_MS = 2000;
/** The longest prompt accepted; longer is a 400, not a model call. */
export const MAX_PROMPT_CHARS = 8000;
/** Output cap for the model call; the sample is a probe, not a chat product. */
const MAX_OUTPUT_TOKENS = 512;

export interface AgentReport {
  readonly nonce: string;
  readonly unitId: string | null;
  readonly sessionPrefix: string | null;
  readonly forwardedToken: boolean;
  readonly forwardedTenant: string | null;
  readonly forwardedScope: string | null;
  readonly credentials: boolean;
  readonly callerArn?: string;
  readonly read?: { tenant: string; result: 'ok' | 'error'; item?: Record<string, unknown>; error?: string };
  readonly error?: string;
}

/** Non-secret claims of a JWT, decoded WITHOUT verification: display only, never trusted. */
export function unverifiedClaims(token: string): { tenant_id?: string; scope?: string } | null {
  try {
    const payload = token.split('.')[1];
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return {
      tenant_id: typeof parsed.tenant_id === 'string' ? parsed.tenant_id : undefined,
      scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    };
  } catch {
    return null;
  }
}

/** The prompt from the Runtime payload, or undefined when it is not a string of at most MAX_PROMPT_CHARS. */
export function promptOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>;
    const nested = parsed.input as Record<string, unknown> | undefined;
    const prompt = parsed.prompt ?? nested?.prompt;
    return typeof prompt === 'string' && prompt.length <= MAX_PROMPT_CHARS ? prompt : undefined;
  } catch {
    return undefined;
  }
}

/** The vended credentials in the SDK's shape (expiration as a Date). */
export type SdkCredentials = Omit<VendedCredentials, 'expiration'> & { expiration: Date };

export interface AgentClients {
  readonly dynamo: (credentials: SdkCredentials) => Pick<DynamoDBClient, 'send'>;
  readonly sts: (credentials: SdkCredentials) => Pick<STSClient, 'send'>;
  /** The model client runs as the execution role (P-6): no tenant credentials. */
  readonly bedrock: () => Pick<BedrockRuntimeClient, 'send'>;
}

let bedrockClient: BedrockRuntimeClient | undefined;

const defaultClients: AgentClients = {
  dynamo: (credentials) => new DynamoDBClient({ credentials }),
  sts: (credentials) => new STSClient({ credentials }),
  bedrock: () => (bedrockClient ??= new BedrockRuntimeClient({})),
};

function sdkCredentials(header: string): SdkCredentials {
  const decoded = decodeCredentials(header);
  return { ...decoded, expiration: new Date(decoded.expiration) };
}

function headerValue(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Builds the report for one request (unit-tested directly). */
export async function buildReport(
  headers: IncomingMessage['headers'],
  prompt: string,
  tableName: string | undefined,
  clients: AgentClients = defaultClients,
): Promise<AgentReport> {
  const unitId = headerValue(headers, RUNTIME_HEADERS.SESSION_ID) ?? null;
  const userToken = headerValue(headers, RUNTIME_HEADERS.USER_TOKEN);
  const credentialHeader = headerValue(headers, RUNTIME_HEADERS.TENANT_CREDENTIALS);
  const claims = userToken === undefined ? null : unverifiedClaims(userToken);
  const report: { -readonly [K in keyof AgentReport]: AgentReport[K] } = {
    nonce: NONCE,
    unitId,
    sessionPrefix: unitId === null ? null : prefixOf(unitId),
    forwardedToken: userToken !== undefined,
    forwardedTenant: claims?.tenant_id ?? null,
    forwardedScope: claims?.scope ?? null,
    credentials: credentialHeader !== undefined,
  };

  const read = /^read\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(prompt);
  if (read !== null) {
    const tenant = read[1];
    if (credentialHeader === undefined) {
      report.read = { tenant, result: 'error', error: 'NoCredentials' };
    } else if (tableName === undefined) {
      report.read = { tenant, result: 'error', error: 'NoTable' };
    } else {
      let credentials: SdkCredentials | undefined;
      try {
        credentials = sdkCredentials(credentialHeader);
      } catch {
        report.read = { tenant, result: 'error', error: 'MalformedCredentials' };
      }
      if (credentials !== undefined) {
        try {
          const identity = await clients.sts(credentials).send(new GetCallerIdentityCommand({}));
          report.callerArn = identity.Arn;
        } catch (error) {
          report.callerArn = `error:${error instanceof Error ? error.name : 'unknown'}`;
        }
        try {
          const result = await clients
            .dynamo(credentials)
            .send(new GetItemCommand({ TableName: tableName, Key: { PK: { S: `TENANT#${tenant}` } } }));
          const item: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(result.Item ?? {})) {
            item[key] = value.S ?? value.N ?? null;
          }
          report.read = { tenant, result: 'ok', item };
        } catch (error) {
          report.read = { tenant, result: 'error', error: error instanceof Error ? error.name : 'unknown' };
        }
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// The SSE response (ADR-0017)
// ---------------------------------------------------------------------------

/** What a response needs from the HTTP layer; `ServerResponse` supplies it, tests supply a buffer. */
export interface ResponseSink {
  head(status: number, headers: Record<string, string>): void;
  write(text: string): void;
  end(): void;
  /** Fires when the caller goes away; timers and the model stream stop. */
  onClose?(listener: () => void): void;
}

export interface AgentOptions {
  /** The demo table for `read <tenant>` (TABLE_NAME). */
  readonly tableName?: string;
  /** The one model the execution role allows (MODEL_ID); without it a model prompt is a 503 event. */
  readonly modelId?: string;
  /** Interval of the `stream N` probe; tests shorten it. */
  readonly streamIntervalMs?: number;
}

/** One SSE event: `event:` (optional) and one `data:` line. */
export function sseEvent(data: unknown, event?: string): string {
  return `${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** The final usage event; zeros when no model was called (the contract holds for every response). */
export function usageEvent(usage: UsageEvent): string {
  return sseEvent(usage, USAGE_EVENT);
}

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' };

/** The probe commands; anything else is a model prompt. */
export function isProbe(prompt: string): boolean {
  return /^report\s*$/.test(prompt) || /^read\s+[A-Za-z0-9_-]{1,64}\s*$/.test(prompt) || /^stream\s+\d{1,3}\s*$/.test(prompt);
}

/**
 * Calls the model with the prompt, writes each text delta as a `data:`
 * event, and returns the usage from the metadata event. Only figures are
 * returned; the content goes to the caller and nowhere else.
 */
export async function converse(
  prompt: string,
  modelId: string,
  write: (text: string) => void,
  clients: AgentClients = defaultClients,
  abortSignal?: AbortSignal,
): Promise<UsageEvent> {
  const output = await clients.bedrock().send(
    new ConverseStreamCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS },
    }),
    { abortSignal },
  );
  let inputTokens = 0;
  let outputTokens = 0;
  let sawMetadata = false;
  for await (const event of output.stream ?? []) {
    const text = event.contentBlockDelta?.delta?.text;
    if (text !== undefined) {
      write(sseEvent({ text }));
    }
    if (event.metadata?.usage !== undefined) {
      sawMetadata = true;
      inputTokens = event.metadata.usage.inputTokens ?? 0;
      outputTokens = event.metadata.usage.outputTokens ?? 0;
    }
  }
  if (!sawMetadata) {
    throw Object.assign(new Error('ConverseStream ended without a metadata event'), { name: 'NoUsageMetadata' });
  }
  return { inputTokens, outputTokens, modelId };
}

/**
 * Answers one request (unit-tested directly). The response is always SSE and,
 * when it completes, always ends with the usage event. A model failure is an
 * `event: error` with the error NAME, and no usage event: the tokens are then
 * unattributed and the ingress metric shows the gap rather than a guess.
 */
export async function respond(
  headers: IncomingMessage['headers'],
  prompt: string,
  options: AgentOptions,
  sink: ResponseSink,
  clients: AgentClients = defaultClients,
): Promise<void> {
  const zero: UsageEvent = { inputTokens: 0, outputTokens: 0 };

  const stream = /^stream\s+(\d{1,3})\s*$/.exec(prompt);
  if (stream !== null) {
    const report = await buildReport(headers, prompt, options.tableName, clients);
    const seconds = Math.min(Number(stream[1]), MAX_STREAM_SECONDS);
    const intervalMs = options.streamIntervalMs ?? STREAM_INTERVAL_MS;
    sink.head(200, SSE_HEADERS);
    sink.write(sseEvent({ t: 0, report }));
    await new Promise<void>((resolve) => {
      let t = 0;
      const timer = setInterval(() => {
        t += intervalMs / 1000;
        sink.write(sseEvent({ t }));
        if (t >= seconds) {
          clearInterval(timer);
          sink.write(usageEvent(zero));
          sink.end();
          resolve();
        }
      }, intervalMs);
      sink.onClose?.(() => {
        clearInterval(timer);
        resolve();
      });
    });
    return;
  }

  if (isProbe(prompt)) {
    const report = await buildReport(headers, prompt, options.tableName, clients);
    sink.head(200, SSE_HEADERS);
    sink.write(sseEvent(report));
    sink.write(usageEvent(zero));
    sink.end();
    return;
  }

  sink.head(200, SSE_HEADERS);
  if (options.modelId === undefined) {
    sink.write(sseEvent({ error: 'NoModelConfigured' }, 'error'));
    sink.end();
    return;
  }
  const abort = new AbortController();
  sink.onClose?.(() => abort.abort());
  try {
    const usage = await converse(prompt, options.modelId, (text) => sink.write(text), clients, abort.signal);
    sink.write(usageEvent(usage));
  } catch (error) {
    // The name only (AccessDeniedException, ThrottlingException, ...): no message, which could carry content.
    sink.write(sseEvent({ error: error instanceof Error ? error.name : 'unknown' }, 'error'));
  } finally {
    sink.end();
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sinkFor(req: IncomingMessage, res: ServerResponse): ResponseSink {
  return {
    head: (status, headers) => res.writeHead(status, headers),
    write: (text) => {
      res.write(text);
    },
    end: () => res.end(),
    onClose: (listener) => req.on('close', listener),
  };
}

async function serve(req: IncomingMessage, res: ServerResponse, options: AgentOptions): Promise<void> {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Healthy' }));
    return;
  }
  const prompt = promptOf(await readBody(req));
  if (prompt === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `prompt must be a string of at most ${MAX_PROMPT_CHARS} characters` }));
    return;
  }
  await respond(req.headers, prompt, options, sinkFor(req, res));
}

/** Starts the HTTP server the Runtime talks to. Not called under test. */
export function main(): void {
  const options: AgentOptions = { tableName: process.env[AGENT_ENV.TABLE_NAME], modelId: process.env[AGENT_ENV.MODEL_ID] };
  createServer((req, res) => {
    serve(req, res, options).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal' }));
    });
  }).listen(PORT, '0.0.0.0');
}

if (require.main === module) {
  main();
}

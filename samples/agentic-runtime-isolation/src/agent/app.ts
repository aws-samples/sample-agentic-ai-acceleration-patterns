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
 *                      microVM, whether a transaction token (v2) and tenant
 *                      credentials arrived, and the token's claims (`tenant_id`,
 *                      `agent`, `scope`, `aud`, `act.sub`, `exp`), never the token;
 *   `tools`            (v2) `tools/list` on every tools gateway the token's
 *                      `aud` names (`tools-gateway:<name>`, ADR-0041), with
 *                      the transaction token as bearer, one client per gateway;
 *   `tool <t>/<n> <json>` (v2) `tools/call` of `<t>___<n>` with those arguments,
 *                      on the gateway that lists the tool;
 *   `read <tenantId>`  the report plus a GetItem of `TENANT#<tenantId>` from
 *                      the demo table with the vended credentials (P-8; a
 *                      cross-tenant read fails in IAM, not here);
 *   `stream <N>`       an SSE stream of N seconds (capped at 120), one event
 *                      every two seconds, for the streaming checks (V-4, V-5).
 *
 * Any other prompt goes to the model (`MODEL_ID`) through Bedrock
 * ConverseStream, using a Bedrock client built from the vended tenant
 * credentials (ADR-0018): the call is signed by the tenant role, so AWS
 * attributes the model cost to that tenant. A model prompt with no credential
 * header, or a malformed one, is an `event: error` (`NoCredentials` /
 * `MalformedCredentials`) with no usage event; the agent never falls back to
 * the execution role, which holds no model permission at all (ADR-0008
 * amended). Text deltas stream as `data:` events and the usage event carries
 * the input and output tokens from the ConverseStream metadata.
 *
 * It never logs or echoes a header value: not the token, not the credentials
 * (ADR-0012, ADR-0031, spike V-7, V-13). It validates that `prompt` is a string of
 * bounded length (Runtime input validation best practice).
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { decodeCredentials, RUNTIME_HEADERS } from '../backend/agentcore-runtime.transport';
import { AGENT_ENV } from '../shared/config';
import { USAGE_EVENT, type UsageEvent } from '../shared/metrics';
import { DEFAULT_TOOLS_GATEWAY, toolsGatewaysOf } from '../shared/mint';
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
  /** (v2) Whether the transaction-token header arrived; the token itself is never reported. */
  readonly transactionToken: boolean;
  readonly tokenTenant: string | null;
  readonly tokenAgent: string | null;
  readonly tokenScope: string | null;
  readonly tokenAud: string[] | null;
  readonly tokenActSub: string | null;
  readonly tokenExp: number | null;
  readonly credentials: boolean;
  readonly callerArn?: string;
  readonly read?: { tenant: string; result: 'ok' | 'error'; item?: Record<string, unknown>; error?: string };
  readonly error?: string;
}

/** The claims a report shows. */
export interface ReportedClaims {
  readonly tenant_id?: string;
  readonly agent?: string;
  readonly scope?: string;
  readonly aud?: string[];
  readonly actSub?: string;
  readonly exp?: number;
}

/**
 * Non-secret claims of the transaction token, decoded WITHOUT verification:
 * display only. Only the ingress can set the header (P-1), so the agent need
 * not verify; it may with the published JWKS (`RI_ISSUER`).
 */
export function unverifiedClaims(token: string): ReportedClaims | null {
  try {
    const payload = token.split('.')[1];
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const act = parsed.act as Record<string, unknown> | undefined;
    return {
      tenant_id: typeof parsed.tenant_id === 'string' ? parsed.tenant_id : undefined,
      agent: typeof parsed.agent === 'string' ? parsed.agent : undefined,
      scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
      aud: Array.isArray(parsed.aud) ? parsed.aud.filter((a): a is string => typeof a === 'string') : undefined,
      actSub: typeof act?.sub === 'string' ? act.sub : undefined,
      exp: typeof parsed.exp === 'number' ? parsed.exp : undefined,
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
  /** The model client runs as the vended tenant credentials (ADR-0018): cost is attributed per tenant and the agent has no shared model permission. */
  readonly bedrock: (credentials: SdkCredentials) => Pick<BedrockRuntimeClient, 'send'>;
}

/**
 * One socket pool for the whole process. The clients stay per request, built
 * from that request's vended credentials (ADR-0018: every call is signed by
 * the tenant role), but they share this handler so a conversation's second
 * and later turns reuse the TLS connection to Bedrock instead of opening a
 * new one. Credentials are per client, never on the handler.
 */
const requestHandler = new NodeHttpHandler({ httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 50 }) });

const defaultClients: AgentClients = {
  dynamo: (credentials) => new DynamoDBClient({ credentials, requestHandler }),
  sts: (credentials) => new STSClient({ credentials, requestHandler }),
  bedrock: (credentials) => new BedrockRuntimeClient({ credentials, requestHandler }),
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
  const transactionToken = headerValue(headers, RUNTIME_HEADERS.TRANSACTION_TOKEN);
  const credentialHeader = headerValue(headers, RUNTIME_HEADERS.TENANT_CREDENTIALS);
  const claims = transactionToken === undefined ? null : unverifiedClaims(transactionToken);
  const report: { -readonly [K in keyof AgentReport]: AgentReport[K] } = {
    nonce: NONCE,
    unitId,
    sessionPrefix: unitId === null ? null : prefixOf(unitId),
    transactionToken: transactionToken !== undefined,
    tokenTenant: claims?.tenant_id ?? null,
    tokenAgent: claims?.agent ?? null,
    tokenScope: claims?.scope ?? null,
    tokenAud: claims?.aud ?? null,
    tokenActSub: claims?.actSub ?? null,
    tokenExp: claims?.exp ?? null,
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
  /** (v2) The `default` tools gateway MCP endpoint (RI_TOOLS_GATEWAY_URL), used when `toolsGatewayUrls` is unset. */
  readonly toolsGatewayUrl?: string;
  /**
   * (v2, ADR-0041) Every tools gateway's MCP endpoint by name
   * (RI_TOOLS_GATEWAY_URLS); the agent uses the ones its token's `aud`
   * names. With neither this nor `toolsGatewayUrl`, the tool probes answer
   * `NoToolsGateway`.
   */
  readonly toolsGatewayUrls?: Readonly<Record<string, string>>;
  /** (v2) The HTTP client for the tools gateway; tests inject one. */
  readonly fetch?: typeof fetch;
}

/** (v2) The tool probe in a prompt: `tools`, or `tool <target>/<tool> <json>`. */
export function toolProbe(prompt: string): { method: 'tools/list' } | { method: 'tools/call'; name: string; arguments: Record<string, unknown> } | undefined {
  if (/^tools\s*$/.test(prompt)) {
    return { method: 'tools/list' };
  }
  const call = /^tool\s+([a-z0-9-]{1,32})\/([a-z0-9_]{1,64})(?:\s+(\{.*\}))?\s*$/s.exec(prompt);
  if (call === null) {
    return undefined;
  }
  let args: unknown = {};
  try {
    args = call[3] === undefined ? {} : JSON.parse(call[3]);
  } catch {
    return undefined;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return undefined;
  }
  return { method: 'tools/call', name: `${call[1]}___${call[2]}`, arguments: args as Record<string, unknown> };
}

/**
 * (v2, C-2) Calls the tools gateway with the transaction token as bearer:
 * one JSON-RPC request over MCP streamable HTTP. Returns the JSON-RPC result
 * or `{ error: <code or status> }`; never the token.
 * TODO(v2): the MCP `initialize` handshake and `Mcp-Session-Id` if the Gateway starts requiring them (the spike called tools/list directly).
 */
export async function callToolsGateway(
  url: string,
  token: string,
  probe: NonNullable<ReturnType<typeof toolProbe>>,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const params = probe.method === 'tools/call' ? { name: probe.name, arguments: probe.arguments } : {};
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: probe.method, params }),
  });
  const text = await response.text();
  // A streamed answer is SSE: take the last `data:` line.
  const json = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).pop()?.slice(5) ?? '';
  try {
    const parsed = JSON.parse(json) as { result?: unknown; error?: { message?: unknown } };
    if (parsed.error !== undefined) {
      return { error: typeof parsed.error.message === 'string' ? parsed.error.message : `http_${response.status}` };
    }
    return response.ok ? parsed.result : { error: `http_${response.status}` };
  } catch {
    return { error: `http_${response.status}` };
  }
}

/** (ADR-0041) Reads RI_TOOLS_GATEWAY_URLS; anything malformed is no map. */
export function parseGatewayUrls(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return undefined;
  }
}

/**
 * (ADR-0041) One MCP client (here: an endpoint) per tools gateway the
 * token's `aud` names and the agent knows a URL for, in `aud` order.
 */
export function gatewayClients(options: AgentOptions, aud: readonly string[]): [string, string][] {
  const urls: Readonly<Record<string, string>> =
    options.toolsGatewayUrls ?? (options.toolsGatewayUrl === undefined ? {} : { [DEFAULT_TOOLS_GATEWAY]: options.toolsGatewayUrl });
  return toolsGatewaysOf(aud)
    .filter((name) => Object.prototype.hasOwnProperty.call(urls, name))
    .map((name) => [name, urls[name]]);
}

/** The tools of a `tools/list` result, or none. */
function listedNames(result: unknown): string[] {
  const tools = (result as { tools?: unknown } | undefined)?.tools;
  return Array.isArray(tools) ? tools.map((t) => (t as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string') : [];
}

/**
 * Runs one tool probe over the gateways in `aud`: `tools/list` on each
 * (results by gateway name), or `tools/call` on the gateway that lists the
 * tool (the only one, when `aud` names one).
 * TODO(v2): cache each gateway's list for the token's life instead of listing per call (spec §3.6).
 */
export async function runToolProbe(
  clients: readonly [string, string][],
  token: string,
  probe: NonNullable<ReturnType<typeof toolProbe>>,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (probe.method === 'tools/list') {
    const results: Record<string, unknown> = {};
    for (const [name, url] of clients) {
      results[name] = await callToolsGateway(url, token, probe, fetcher);
    }
    return results;
  }
  let url = clients[0][1];
  if (clients.length > 1) {
    for (const [, candidate] of clients) {
      if (listedNames(await callToolsGateway(candidate, token, { method: 'tools/list' }, fetcher)).includes(probe.name)) {
        url = candidate;
        break;
      }
    }
  }
  return callToolsGateway(url, token, probe, fetcher);
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
 * Calls the model with the prompt as the vended tenant credentials
 * (ADR-0018), writes each text delta as a `data:` event, and returns the
 * usage from the metadata event. Only figures are returned; the content goes
 * to the caller and nowhere else.
 */
export async function converse(
  prompt: string,
  modelId: string,
  credentials: SdkCredentials,
  write: (text: string) => void,
  clients: AgentClients = defaultClients,
  abortSignal?: AbortSignal,
): Promise<UsageEvent> {
  const output = await clients.bedrock(credentials).send(
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

  const probe = toolProbe(prompt);
  if (probe !== undefined) {
    const token = headerValue(headers, RUNTIME_HEADERS.TRANSACTION_TOKEN);
    sink.head(200, SSE_HEADERS);
    const gateways = token === undefined ? [] : gatewayClients(options, unverifiedClaims(token)?.aud ?? []);
    if (token === undefined) {
      sink.write(sseEvent({ error: 'NoTransactionToken' }, 'error'));
    } else if (gateways.length === 0) {
      sink.write(sseEvent({ error: 'NoToolsGateway' }, 'error'));
    } else {
      try {
        sink.write(sseEvent({ tool: probe.method, result: await runToolProbe(gateways, token, probe, options.fetch) }));
      } catch (error) {
        sink.write(sseEvent({ error: error instanceof Error ? error.name : 'unknown' }, 'error'));
      }
    }
    sink.write(usageEvent(zero));
    sink.end();
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
  // The model call is signed by the vended tenant credentials (ADR-0018):
  // without them the agent errors rather than falling back to the execution
  // role, which holds no model permission at all.
  const credentialHeader = headerValue(headers, RUNTIME_HEADERS.TENANT_CREDENTIALS);
  if (credentialHeader === undefined) {
    sink.write(sseEvent({ error: 'NoCredentials' }, 'error'));
    sink.end();
    return;
  }
  let credentials: SdkCredentials;
  try {
    credentials = sdkCredentials(credentialHeader);
  } catch {
    sink.write(sseEvent({ error: 'MalformedCredentials' }, 'error'));
    sink.end();
    return;
  }
  const abort = new AbortController();
  sink.onClose?.(() => abort.abort());
  try {
    const usage = await converse(prompt, options.modelId, credentials, (text) => sink.write(text), clients, abort.signal);
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
  const options: AgentOptions = {
    tableName: process.env[AGENT_ENV.TABLE_NAME],
    modelId: process.env[AGENT_ENV.MODEL_ID],
    toolsGatewayUrl: process.env[AGENT_ENV.TOOLS_GATEWAY_URL],
    toolsGatewayUrls: parseGatewayUrls(process.env[AGENT_ENV.TOOLS_GATEWAY_URLS]),
  };
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

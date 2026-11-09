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
 *                      `agent`, `scope`, `aud`, `act.sub`, `exp`, `iss`, `sub`,
 *                      `user`) and header (`typ`, `kid`), never the token; and
 *                      (integ step 11) the NAMES of every request header it
 *                      received, plus for each header whose value has the
 *                      shape of a JWT only that JWT's `typ` and `iss`, so the
 *                      driver can show no identity token reached it;
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

import { createHash, randomUUID } from 'node:crypto';
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
  /** (ADR-0048) The agents that delegated to this one, outermost first, read from the nested `act`; empty on a direct call. */
  readonly chain: string[];
  readonly tokenExp: number | null;
  /** (v2, step 11) The token's `iss`, `typ`, `kid`, `sub` and `user`. */
  readonly tokenIss: string | null;
  readonly tokenTyp: string | null;
  readonly tokenKid: string | null;
  readonly tokenSub: string | null;
  readonly tokenUser: string | null;
  /** (v2, step 11) The names of every request header, lowercased and sorted; never a value. */
  readonly headerNames: string[];
  /** (v2, step 11) Each header whose value is JWT-shaped: its name and that JWT's `typ` and `iss` only. */
  readonly jwtHeaders: { readonly name: string; readonly typ: string | null; readonly iss: string | null }[];
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
  /** (ADR-0048) The `agent:` entries of a nested `act`, outermost first. */
  readonly chain?: string[];
  readonly exp?: number;
  readonly iss?: string;
  readonly sub?: string;
  readonly user?: string;
  readonly typ?: string;
  readonly kid?: string;
}

/** The `typ` and `iss` of a JWT-shaped value, decoded WITHOUT verification; undefined when it is not one. */
export function jwtShape(value: string): { typ: string | null; iss: string | null } | undefined {
  const parts = value.split('.');
  if (parts.length !== 3 || !value.startsWith('eyJ')) {
    return undefined;
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return { typ: typeof header.typ === 'string' ? header.typ : null, iss: typeof payload.iss === 'string' ? payload.iss : null };
  } catch {
    return undefined;
  }
}

/** Header names and the JWT-shaped headers' `typ` and `iss` (integ step 11); never a value. */
export function headerShapes(headers: IncomingMessage['headers']): Pick<AgentReport, 'headerNames' | 'jwtHeaders'> {
  const headerNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const jwtHeaders: { name: string; typ: string | null; iss: string | null }[] = [];
  for (const name of headerNames) {
    const raw = headers[name];
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const candidate = typeof value === 'string' ? value.replace(/^Bearer\s+/i, '') : undefined;
      const shape = candidate === undefined ? undefined : jwtShape(candidate);
      if (shape !== undefined) {
        jwtHeaders.push({ name, ...shape });
      }
    }
  }
  return { headerNames, jwtHeaders };
}

/**
 * Non-secret claims of the transaction token, decoded WITHOUT verification:
 * display only. Only the ingress can set the header (P-1), so the agent need
 * not verify; it may with the published JWKS (`RI_ISSUER`).
 */
export function unverifiedClaims(token: string): ReportedClaims | null {
  try {
    const [rawHeader, payload] = token.split('.');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    let header: Record<string, unknown> = {};
    try {
      header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      header = {};
    }
    const act = parsed.act as Record<string, unknown> | undefined;
    const chain: string[] = [];
    for (let level = act, depth = 0; level !== undefined && depth < 8; level = level.act as Record<string, unknown> | undefined, depth += 1) {
      if (typeof level.sub === 'string' && level.sub.startsWith('agent:') && level.act !== undefined) {
        chain.push(level.sub.slice('agent:'.length));
      }
    }
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return {
      iss: text(parsed.iss),
      sub: text(parsed.sub),
      user: text(parsed.user),
      typ: text(header.typ),
      kid: text(header.kid),
      tenant_id: typeof parsed.tenant_id === 'string' ? parsed.tenant_id : undefined,
      agent: typeof parsed.agent === 'string' ? parsed.agent : undefined,
      scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
      aud: Array.isArray(parsed.aud) ? parsed.aud.filter((a): a is string => typeof a === 'string') : undefined,
      actSub: typeof act?.sub === 'string' ? act.sub : undefined,
      chain,
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

/** (ADR-0048) The validated `conversationId` the ingress forwards with the prompt, when sessions are on. */
export function conversationIdOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>;
    const nested = parsed.input as Record<string, unknown> | undefined;
    const id = parsed.conversationId ?? nested?.conversationId;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
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
    chain: claims?.chain ?? [],
    tokenExp: claims?.exp ?? null,
    tokenIss: claims?.iss ?? null,
    tokenTyp: claims?.typ ?? null,
    tokenKid: claims?.kid ?? null,
    tokenSub: claims?.sub ?? null,
    tokenUser: claims?.user ?? null,
    ...headerShapes(headers),
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
  /**
   * (ADR-0048) The `api-gateway` base URL to delegate through
   * (RI_DELEGATION_URL); the agent posts to `<url>/<agent>/delegations`
   * with its transaction token. Unset: the `delegate` probe answers
   * `NoDelegation`.
   */
  readonly delegationUrl?: string;
  /** (ADR-0048) The conversation this request is in, forwarded to a delegation so the target's session is the same conversation. */
  readonly conversationId?: string;
}

/** (ADR-0048, C-2) The delegation probe in a prompt: `delegate <agent> <prompt>`. */
export function delegateProbe(prompt: string): { agent: string; prompt: string } | undefined {
  const match = /^delegate\s+([a-z0-9-]{1,32})\s+([\s\S]+)$/.exec(prompt);
  return match === null ? undefined : { agent: match[1], prompt: match[2].trim() };
}

/**
 * (ADR-0048, C-2) Posts `prompt` to `<delegationUrl>/<agent>/delegations` with
 * the transaction token as bearer and relays the answer: the target's SSE
 * events are forwarded as they arrive (wrapped as `delegated` events), a
 * refusal is one `error` event with the status and the fixed body.
 */
export async function delegateTo(
  delegationUrl: string,
  agent: string,
  prompt: string,
  token: string,
  conversationId: string | undefined,
  write: (event: string) => void,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  // With `identity.multiTenant` the api-gateway authoriser lists X-Tenant-Id as an identity
  // source, so a request without it is API Gateway's own 401 before the authoriser runs. The
  // route itself takes the tenant from the token; the header only has to be present and equal.
  const tenantId = unverifiedClaims(token)?.tenant_id;
  const response = await fetcher(`${delegationUrl.replace(/\/$/, '')}/${agent}/delegations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
      ...(tenantId === undefined ? {} : { 'x-tenant-id': tenantId }),
    },
    body: JSON.stringify({ prompt, ...(conversationId === undefined ? {} : { conversationId }) }),
  });
  if (!response.ok || response.body === null) {
    const text = (await response.text()).slice(0, 200);
    write(sseEvent({ error: 'DelegationRefused', status: response.status, body: text }, 'error'));
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    // The target's stream is SSE too; each chunk is relayed as data of a `delegated` event, never parsed.
    write(sseEvent({ agent, chunk: decoder.decode(value, { stream: true }) }, 'delegated'));
  }
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

/** The MCP protocol version the agent speaks; the tools gateway lists it (V-15a). */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

/** One JSON-RPC answer from a tools gateway: the result, or the error message (or `http_<status>`) and the HTTP status. */
export type GatewayAnswer = { readonly result: unknown; readonly status: number } | { readonly error: string; readonly status: number };

/** The most `tools/list` pages read for one listing (30 tools a page before Policy, V-14). */
const MAX_LIST_PAGES = 100;
/** The most sessions one process keeps; the oldest goes first. */
const MAX_SESSIONS = 256;

interface McpSession {
  /** `Mcp-Session-Id` from `initialize`, when the gateway issued one. */
  sessionId?: string;
  /** The token's `exp` (seconds): the session and the cached list end with the token. */
  readonly exp: number;
  /** The tool names the last full listing returned (spec §3.6: cached for the token life). */
  tools?: string[];
  /** The `initialize` handshake completed. */
  ready?: boolean;
}

/**
 * (v2, C-2, spec §3.6) The agent's MCP client: one session per tools gateway
 * per transaction token. The first request on a session runs the MCP
 * `initialize` handshake (protocol `2025-11-25`) and `notifications/initialized`,
 * keeps the `Mcp-Session-Id` the gateway returns and sends it on every later
 * request; a 404 on a session re-initialises once. `tools/list` reads every
 * page (`cursor` / `nextCursor`) and caches the names until the token's
 * `exp`, so a `tools/call` on several gateways finds its gateway without
 * listing again. Sessions are keyed by a SHA-256 of the token, held in
 * memory only; nothing here logs or returns the token.
 */
export class McpSessions {
  private readonly sessions = new Map<string, McpSession>();
  private nextId = 1;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    /** Milliseconds since the epoch. */
    private readonly now: () => number = Date.now,
  ) {}

  private key(url: string, token: string): string {
    return `${url}\u0000${createHash('sha256').update(token).digest('base64url')}`;
  }

  private session(url: string, token: string, exp: number): McpSession {
    const key = this.key(url, token);
    const nowSeconds = Math.floor(this.now() / 1000);
    let session = this.sessions.get(key);
    if (session !== undefined && session.exp <= nowSeconds) {
      this.sessions.delete(key);
      session = undefined;
    }
    if (session === undefined) {
      for (const [k, s] of this.sessions) {
        if (s.exp <= nowSeconds || this.sessions.size >= MAX_SESSIONS) {
          this.sessions.delete(k);
        }
      }
      session = { exp };
      this.sessions.set(key, session);
    }
    return session;
  }

  /** One POST of a JSON-RPC message; `id` undefined is a notification. */
  private async post(
    url: string,
    token: string,
    session: McpSession,
    method: string,
    params: unknown,
    id?: number,
  ): Promise<{ response: Response; text: string }> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    };
    if (session.sessionId !== undefined) {
      headers['Mcp-Session-Id'] = session.sessionId;
    }
    const body = id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
    const response = await this.fetcher(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { response, text: await response.text() };
  }

  private async initialize(url: string, token: string, session: McpSession): Promise<GatewayAnswer | undefined> {
    session.sessionId = undefined;
    const { response, text } = await this.post(url, token, session, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'runtime-isolation-agent', version: '2' },
    }, this.nextId++);
    const answer = parseAnswer(response, text);
    if ('error' in answer) {
      return answer;
    }
    const sessionId = response.headers.get('mcp-session-id');
    session.sessionId = sessionId === null || sessionId.length === 0 ? undefined : sessionId;
    // The notification has no answer worth reading (202); a failure surfaces on the next request.
    await this.post(url, token, session, 'notifications/initialized', {});
    return undefined;
  }

  /** One request on the session, initialising it first; `exp` is the token's. */
  async request(url: string, token: string, exp: number, method: string, params: unknown): Promise<GatewayAnswer> {
    const session = this.session(url, token, exp);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (session.ready !== true) {
        const failed = await this.initialize(url, token, session);
        if (failed !== undefined) {
          return failed;
        }
        session.ready = true;
      }
      const { response, text } = await this.post(url, token, session, method, params, this.nextId++);
      if (response.status === 404 && session.sessionId !== undefined && attempt === 0) {
        // The gateway dropped the session: initialise again, once.
        session.sessionId = undefined;
        session.ready = false;
        continue;
      }
      return parseAnswer(response, text);
    }
    return { error: 'http_404', status: 404 };
  }

  /** Every page of `tools/list`; refreshes the cached names. */
  async listAll(url: string, token: string, exp: number): Promise<GatewayAnswer> {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const answer = await this.request(url, token, exp, 'tools/list', cursor === undefined ? {} : { cursor });
      if ('error' in answer) {
        return answer;
      }
      const result = answer.result as { tools?: unknown; nextCursor?: unknown } | undefined;
      if (Array.isArray(result?.tools)) {
        tools.push(...result.tools);
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (cursor === undefined) {
        break;
      }
    }
    this.session(url, token, exp).tools = listedNames({ tools });
    return { result: { tools }, status: 200 };
  }

  /** The cached tool names of a gateway for this token, or undefined when it was not listed in the token's life. */
  cachedTools(url: string, token: string, exp: number): string[] | undefined {
    return this.session(url, token, exp).tools;
  }
}

function parseAnswer(response: Response, text: string): GatewayAnswer {
  // A streamed answer is SSE: take the last `data:` line.
  const json = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).pop()?.slice(5) ?? '';
  try {
    const parsed = JSON.parse(json) as { result?: unknown; error?: { message?: unknown } };
    if (parsed.error !== undefined) {
      return { error: typeof parsed.error.message === 'string' ? parsed.error.message : `http_${response.status}`, status: response.status };
    }
    return response.ok ? { result: parsed.result, status: response.status } : { error: `http_${response.status}`, status: response.status };
  } catch {
    return { error: `http_${response.status}`, status: response.status };
  }
}

/** A per-fetcher session store (tests inject a fetcher; the agent runs one process-wide store). */
const sessionStores = new WeakMap<typeof fetch, McpSessions>();
export function sessionsFor(fetcher: typeof fetch = fetch): McpSessions {
  let store = sessionStores.get(fetcher);
  if (store === undefined) {
    store = new McpSessions(fetcher);
    sessionStores.set(fetcher, store);
  }
  return store;
}

/**
 * (v2, C-2) One probe on one tools gateway with the transaction token as
 * bearer: the JSON-RPC result, or `{ error, status }`; never the token.
 */
export async function callToolsGateway(
  url: string,
  token: string,
  probe: NonNullable<ReturnType<typeof toolProbe>>,
  fetcher: typeof fetch = fetch,
  sessions: McpSessions = sessionsFor(fetcher),
): Promise<unknown> {
  const exp = unverifiedClaims(token)?.exp ?? Math.floor(Date.now() / 1000) + 60;
  const answer =
    probe.method === 'tools/list'
      ? await sessions.listAll(url, token, exp)
      : await sessions.request(url, token, exp, 'tools/call', { name: probe.name, arguments: probe.arguments });
  return 'error' in answer ? { error: answer.error, status: answer.status } : answer.result;
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
 * (results by gateway name; every listing refreshes the cache), or
 * `tools/call` on the gateway that lists the tool (the only one, when `aud`
 * names one). With several gateways the cached list of each, for the token's
 * life, decides; a gateway not listed yet in the token's life is listed once.
 */
export async function runToolProbe(
  clients: readonly [string, string][],
  token: string,
  probe: NonNullable<ReturnType<typeof toolProbe>>,
  fetcher: typeof fetch = fetch,
  sessions: McpSessions = sessionsFor(fetcher),
): Promise<unknown> {
  if (probe.method === 'tools/list') {
    const results: Record<string, unknown> = {};
    for (const [name, url] of clients) {
      results[name] = await callToolsGateway(url, token, probe, fetcher, sessions);
    }
    return results;
  }
  const exp = unverifiedClaims(token)?.exp ?? Math.floor(Date.now() / 1000) + 60;
  let url = clients[0][1];
  if (clients.length > 1) {
    for (const [, candidate] of clients) {
      let names = sessions.cachedTools(candidate, token, exp);
      if (names === undefined) {
        await sessions.listAll(candidate, token, exp);
        names = sessions.cachedTools(candidate, token, exp) ?? [];
      }
      if (names.includes(probe.name)) {
        url = candidate;
        break;
      }
    }
  }
  return callToolsGateway(url, token, probe, fetcher, sessions);
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

  const delegation = delegateProbe(prompt);
  if (delegation !== undefined) {
    const token = headerValue(headers, RUNTIME_HEADERS.TRANSACTION_TOKEN);
    sink.head(200, SSE_HEADERS);
    if (token === undefined) {
      sink.write(sseEvent({ error: 'NoTransactionToken' }, 'error'));
    } else if (options.delegationUrl === undefined) {
      sink.write(sseEvent({ error: 'NoDelegation' }, 'error'));
    } else {
      try {
        const write = (event: string) => sink.write(event);
        await delegateTo(options.delegationUrl, delegation.agent, delegation.prompt, token, options.conversationId, write, options.fetch);
      } catch (error) {
        sink.write(sseEvent({ error: error instanceof Error ? error.name : 'unknown' }, 'error'));
      }
    }
    sink.write(usageEvent(zero));
    sink.end();
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
  const body = await readBody(req);
  const prompt = promptOf(body);
  if (prompt === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `prompt must be a string of at most ${MAX_PROMPT_CHARS} characters` }));
    return;
  }
  // ADR-0048: a delegation stays in this request's conversation when the ingress forwarded one.
  await respond(req.headers, prompt, { ...options, conversationId: conversationIdOf(body) }, sinkFor(req, res));
}

/** Starts the HTTP server the Runtime talks to. Not called under test. */
export function main(): void {
  const options: AgentOptions = {
    tableName: process.env[AGENT_ENV.TABLE_NAME],
    modelId: process.env[AGENT_ENV.MODEL_ID],
    toolsGatewayUrl: process.env[AGENT_ENV.TOOLS_GATEWAY_URL],
    toolsGatewayUrls: parseGatewayUrls(process.env[AGENT_ENV.TOOLS_GATEWAY_URLS]),
    delegationUrl: process.env[AGENT_ENV.DELEGATION_URL],
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

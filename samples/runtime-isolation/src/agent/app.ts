// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The echo agent (spec C-2). It runs inside the isolation unit and reports
 * what reached it, so the integration test can prove the mapping: the unit
 * id the Runtime handed it, the prefix part of that id, a nonce chosen once
 * per microVM, whether a user token or tenant credentials arrived, and the
 * forwarded token's non-secret claims. Two prompts do more:
 *
 *   `read <tenantId>`  GetItem `TENANT#<tenantId>` from the demo table with
 *                      the vended credentials (P-8; a cross-tenant read fails
 *                      in IAM, not here);
 *   `stream <N>`       an SSE stream of N seconds (capped at 120), one event
 *                      every two seconds, for the streaming checks (V-4, V-5).
 *
 * It never logs or echoes a header value: not the token, not the credentials
 * (ADR-0006, ADR-0012, spike V-7). It validates that `prompt` is a string
 * (Runtime input validation best practice).
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { decodeCredentials, RUNTIME_HEADERS } from '../backend/agentcore-runtime.transport';
import { prefixOf } from '../shared/session';
import type { VendedCredentials } from '../shared/tvm';

/** One per process, and the Runtime runs one process per microVM. */
export const NONCE = randomUUID();

const PORT = 8080;
const MAX_STREAM_SECONDS = 120;
const STREAM_INTERVAL_MS = 2000;

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

/** The prompt from the Runtime payload, or undefined when it is not a string. */
export function promptOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>;
    const nested = parsed.input as Record<string, unknown> | undefined;
    const prompt = parsed.prompt ?? nested?.prompt;
    return typeof prompt === 'string' ? prompt : undefined;
  } catch {
    return undefined;
  }
}

/** The vended credentials in the SDK's shape (expiration as a Date). */
export type SdkCredentials = Omit<VendedCredentials, 'expiration'> & { expiration: Date };

export interface AgentClients {
  readonly dynamo: (credentials: SdkCredentials) => Pick<DynamoDBClient, 'send'>;
  readonly sts: (credentials: SdkCredentials) => Pick<STSClient, 'send'>;
}

const defaultClients: AgentClients = {
  dynamo: (credentials) => new DynamoDBClient({ credentials }),
  sts: (credentials) => new STSClient({ credentials }),
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

async function serve(req: IncomingMessage, res: ServerResponse, tableName: string | undefined): Promise<void> {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Healthy' }));
    return;
  }
  const prompt = promptOf(await readBody(req));
  if (prompt === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'prompt must be a string' }));
    return;
  }
  const report = await buildReport(req.headers, prompt, tableName);
  const stream = /^stream\s+(\d{1,3})\s*$/.exec(prompt);
  if (stream === null) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(report));
    return;
  }
  const seconds = Math.min(Number(stream[1]), MAX_STREAM_SECONDS);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ t: 0, report })}\n\n`);
  let t = 0;
  const timer = setInterval(() => {
    t += STREAM_INTERVAL_MS / 1000;
    res.write(`data: ${JSON.stringify({ t })}\n\n`);
    if (t >= seconds) {
      clearInterval(timer);
      res.end('data: [DONE]\n\n');
    }
  }, STREAM_INTERVAL_MS);
  req.on('close', () => clearInterval(timer));
}

/** Starts the HTTP server the Runtime talks to. Not called under test. */
export function main(): void {
  const tableName = process.env.TABLE_NAME;
  createServer((req, res) => {
    serve(req, res, tableName).catch(() => {
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

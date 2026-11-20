// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The backend against the real SDK client and a local HTTP server, with no
 * client mock: what the mock cannot show is how the SDK reads the answer
 * body, whether it retries an invoke, and what it sends.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentcoreBackend } from '../src/backends/agentcore';
import { buildJob, newNonce, resultProof, sessionIdFor, type RunJob } from '../src/protocol';

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-west-1:ACCOUNT_ID:runtime/Example_runtime-AbCdEfGhIj';
const BOOT_ID = '0123456789abcdef0123456789abcdef';
const SAVED = { ...process.env };

interface Seen { readonly method?: string; readonly url?: string; readonly headers: http.IncomingHttpHeaders; readonly body: string }

let server: http.Server;
let seen: Seen[];
let answer: (req: Seen, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(s);
      answer(s, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AWS_REGION = 'eu-west-1';
  process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLEEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'example-secret-not-real';
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  process.env.AWS_CONFIG_FILE = '/dev/null';
  process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

beforeEach(() => {
  seen = [];
});

async function started() {
  const backend = new AgentcoreBackend({ AGENTCORE_RUNTIME_ARN: RUNTIME_ARN });
  const handle = await backend.start('tenant-a', newNonce(), {
    tenantId: 'tenant-a', accessKeyId: 'x', secretAccessKey: 'x', sessionToken: 'x',
  });
  const job: RunJob = buildJob({
    runId: 'run-1', tenantId: 'tenant-a', nonce: handle.nonce, code: 'print(1)', timeoutMs: 1000, maxOutputBytes: 1024,
  });
  return { backend, handle, job };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('a job goes out as one POST to the runtime with the tenant\'s session id, and the answer is read from the body', async () => {
  const { backend, handle, job } = await started();
  answer = (_req, res) => json(res, 200, {
    v: 1,
    runId: job.runId,
    exitCode: 0,
    stdout: '1\n',
    stderr: '',
    truncated: false,
    durationMs: 5,
    timedOut: false,
    memoryExceeded: false,
    bootId: BOOT_ID,
    proof: resultProof(handle.nonce, job.runId),
  });
  const out = await backend.run(handle, job);
  expect(out).toMatchObject({ kind: 'result', result: { runId: 'run-1', stdout: '1\n', bootId: BOOT_ID } });
  expect(seen).toHaveLength(1);
  expect(seen[0].method).toBe('POST');
  expect(seen[0].url).toContain('/invocations');
  expect(seen[0].headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(sessionIdFor('tenant-a'));
  expect(JSON.parse(seen[0].body)).toEqual(job);
});

test('a refusal comes back as a refusal', async () => {
  const { backend, handle, job } = await started();
  answer = (_req, res) => json(res, 200, { v: 1, error: 'dirty', bootId: BOOT_ID });
  expect(await backend.run(handle, job)).toEqual({ kind: 'refused', refusal: { v: 1, error: 'dirty', bootId: BOOT_ID } });
});

test('a server error is not retried: the job is sent once', async () => {
  const { backend, handle, job } = await started();
  answer = (_req, res) => json(res, 500, { message: 'internal' });
  await expect(backend.run(handle, job)).rejects.toThrow();
  expect(seen).toHaveLength(1);
});

test('a throttle is not retried either', async () => {
  const { backend, handle, job } = await started();
  answer = (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'x-amzn-errortype': 'ThrottlingException' });
    res.end(JSON.stringify({ message: 'slow down' }));
  };
  await expect(backend.run(handle, job)).rejects.toThrow();
  expect(seen).toHaveLength(1);
});

test('stopping the session is one call that names the runtime and the tenant\'s session id', async () => {
  const { backend, handle } = await started();
  answer = (_req, res) => json(res, 200, { runtimeSessionId: handle.handle, statusCode: 200 });
  await backend.stop(handle);
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toContain('/stopruntimesession');
  expect(decodeURIComponent(seen[0].url ?? '')).toContain(RUNTIME_ARN);
  expect(seen[0].headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(sessionIdFor('tenant-a'));
});

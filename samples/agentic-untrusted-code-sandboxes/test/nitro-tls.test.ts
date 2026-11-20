// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The TLS client of the nitro backend against a real TLS server: the
 * certificate fingerprint, one connection for /hello and /run, timeouts, a
 * lost connection, an oversized answer, and the whole call against a runner
 * stand-in that follows runner/PROTOCOL.md. The certificate is made with the
 * `openssl` binary, as the runner makes its own (spec §3.5).
 */

import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxHandle } from '../src/backend';
import { NitroBackend, NITRO_ENV, RunnerConnectionError, RunnerTimeoutError, connectTls } from '../src/backends/nitro';
import { buildJob, helloProof, newNonce, resultProof, type RunJob } from '../src/protocol';

interface Pem { key: string; cert: string; fingerprint: string }

function makeCert(dir: string, name: string): Pem {
  const keyFile = join(dir, `${name}.key`);
  const certFile = join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', `/CN=${name}`, '-days', '1'], { stdio: 'ignore' });
  const cert = readFileSync(certFile, 'utf8');
  return { key: readFileSync(keyFile, 'utf8'), cert, fingerprint: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex') };
}

let dir: string;
let pemA: Pem;
let pemB: Pem;
const servers: { close: () => void }[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nitro-tls-'));
  pemA = makeCert(dir, 'runner-a');
  pemB = makeCert(dir, 'runner-b');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
});

function listen(server: https.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push({ close: () => server.close() });
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

describe('connectTls', () => {
  test('reports the fingerprint of the certificate the server presented, and keeps one connection for every request', async () => {
    const remotePorts: number[] = [];
    let connections = 0;
    const server = https.createServer({ key: pemA.key, cert: pemA.cert }, async (req, res) => {
      remotePorts.push(req.socket.remotePort ?? 0);
      const body = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, echoed: body.length }));
    });
    server.on('secureConnection', () => { connections += 1; });
    const port = await listen(server);

    const conn = await connectTls('127.0.0.1', port, 2000);
    expect(conn.fingerprint).toBe(pemA.fingerprint);
    const hello = await conn.post('/hello', '{"a":1}', 2000, 4096);
    const run = await conn.post('/run', '{"b":22}', 2000, 4096);
    conn.close();

    expect(hello).toEqual({ status: 200, body: JSON.stringify({ path: '/hello', echoed: 7 }) });
    expect(run.status).toBe(200);
    expect(JSON.parse(run.body)).toEqual({ path: '/run', echoed: 8 });
    expect(connections).toBe(1);
    expect(new Set(remotePorts).size).toBe(1);
  });

  test('a server that never answers is a timeout, and the socket is closed', async () => {
    let closed = false;
    const server = https.createServer({ key: pemA.key, cert: pemA.cert }, (req) => {
      req.socket.on('close', () => { closed = true; });
      // never answers
    });
    const port = await listen(server);
    const conn = await connectTls('127.0.0.1', port, 2000);
    await expect(conn.post('/run', '{}', 150, 4096)).rejects.toBeInstanceOf(RunnerTimeoutError);
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
  });

  test('an answer past the byte limit is refused and the connection is dropped', async () => {
    const server = https.createServer({ key: pemA.key, cert: pemA.cert }, (_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(20000));
    });
    const port = await listen(server);
    const conn = await connectTls('127.0.0.1', port, 2000);
    await expect(conn.post('/run', '{}', 2000, 1000)).rejects.toThrow(/larger than allowed/);
  });

  test('a connection cut mid-answer is a lost connection', async () => {
    const server = https.createServer({ key: pemA.key, cert: pemA.cert }, (req, res) => {
      res.writeHead(200, { 'Content-Length': '1000' });
      res.write('partial');
      setTimeout(() => req.socket.destroy(), 20);
    });
    const port = await listen(server);
    const conn = await connectTls('127.0.0.1', port, 2000);
    await expect(conn.post('/run', '{}', 2000, 4096)).rejects.toBeInstanceOf(RunnerConnectionError);
  });

  test('a runner that closes the connection after /hello (Connection: close) fails the next post at once, with no uncaught exception', async () => {
    const server = https.createServer({ key: pemA.key, cert: pemA.cert }, (_req, res) => {
      res.writeHead(200, { 'Connection': 'close', 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const port = await listen(server);
    const uncaught: Error[] = [];
    const onUncaught = (e: Error) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const conn = await connectTls('127.0.0.1', port, 2000);
      expect((await conn.post('/hello', '{}', 2000, 4096)).status).toBe(200);
      const started = Date.now();
      await expect(conn.post('/run', '{}', 5000, 4096)).rejects.toBeInstanceOf(RunnerConnectionError);
      expect(Date.now() - started).toBeLessThan(1000);
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  test('a post on a connection the size limit destroyed is refused at once', async () => {
    const server = https.createServer({ key: pemA.key, cert: pemA.cert }, (_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(20000));
    });
    const port = await listen(server);
    const conn = await connectTls('127.0.0.1', port, 2000);
    await expect(conn.post('/run', '{}', 2000, 1000)).rejects.toThrow(/larger than allowed/);
    await expect(conn.post('/run', '{}', 2000, 1000)).rejects.toThrow(/connection closed/);
  });

  test('a server that offers only TLS 1.2 is refused (TLS 1.3 is the minimum, ADR-0047)', async () => {
    const server = https.createServer({ key: pemA.key, cert: pemA.cert, maxVersion: 'TLSv1.2' }, (_req, res) => res.end('{}'));
    const port = await listen(server);
    await expect(connectTls('127.0.0.1', port, 2000)).rejects.toBeInstanceOf(RunnerConnectionError);
  });

  test('a closed port is a connection error', async () => {
    const server = https.createServer({ key: pemA.key, cert: pemA.cert });
    const port = await listen(server);
    server.close();
    await new Promise((r) => setTimeout(r, 50));
    await expect(connectTls('127.0.0.1', port, 1000)).rejects.toBeInstanceOf(RunnerConnectionError);
  });

  test('a peer that accepts the connection but never speaks TLS is a connect timeout', async () => {
    const server = net.createServer(() => undefined);
    const port = await listen(server);
    await expect(connectTls('127.0.0.1', port, 150)).rejects.toBeInstanceOf(RunnerTimeoutError);
  });

  test('a peer that speaks plain HTTP is a connection error', async () => {
    const server = http.createServer((_req, res) => res.end('hi'));
    const port = await listen(server as unknown as net.Server);
    await expect(connectTls('127.0.0.1', port, 1000)).rejects.toBeInstanceOf(RunnerConnectionError);
  });
});

describe('NitroBackend over real TLS against a runner stand-in', () => {
  const ENV = {
    [NITRO_ENV.CLUSTER_ARN]: `arn:aws:ecs:eu-central-1:${'1'.repeat(12)}:cluster/c1`,
    [NITRO_ENV.TASK_DEFINITION_ARN]: 'td',
    [NITRO_ENV.SUBNET_IDS]: 's',
    [NITRO_ENV.SECURITY_GROUP_ID]: 'sg',
  };
  const BOOT_ID = 'fedcba9876543210fedcba9876543210';

  /** A runner that follows runner/PROTOCOL.md for `/hello` and `/run` on one certificate. */
  async function runnerStandIn(nonce: string, tls: Pem, reportedFingerprint = tls.fingerprint) {
    const seen: string[] = [];
    const server = https.createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
      const body = JSON.parse(await readBody(req)) as Record<string, string>;
      seen.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      if (body.nonce !== nonce) {
        res.writeHead(403);
        res.end(JSON.stringify({ v: 1, error: 'wrong_sandbox' }));
        return;
      }
      if (req.url === '/hello') {
        const proof = helloProof(nonce, body.challenge, reportedFingerprint);
        res.end(JSON.stringify({ v: 1, bootId: BOOT_ID, certFingerprint: reportedFingerprint, proof }));
        return;
      }
      const job = body as unknown as RunJob;
      res.end(JSON.stringify({
        v: 1,
        runId: job.runId,
        exitCode: 0,
        stdout: 'ünï\n',
        stderr: '',
        truncated: false,
        durationMs: 3,
        timedOut: false,
        memoryExceeded: false,
        bootId: BOOT_ID,
        proof: resultProof(nonce, job.runId),
      }));
    });
    const port = await listen(server);
    return { port, seen };
  }

  const backendFor = (port: number) => new NitroBackend(ENV, { connect: (_h, _p, to) => connectTls('127.0.0.1', port, to) });
  const handleFor = (nonce: string): SandboxHandle => ({ backend: 'nitro', tenantId: 'tenant-a', handle: 't', address: '10.0.0.5', nonce });
  const jobFor = (nonce: string): RunJob => buildJob({ runId: 'r-1', tenantId: 'tenant-a', nonce, code: 'print(1)', timeoutMs: 5000, maxOutputBytes: 1000 });

  test('runs a job: /hello, then /run, one connection', async () => {
    const nonce = newNonce();
    const { port, seen } = await runnerStandIn(nonce, pemA);
    const out = await backendFor(port).run(handleFor(nonce), jobFor(nonce));
    expect(out.kind).toBe('result');
    if (out.kind === 'result') expect(out.result.stdout).toBe('ünï\n');
    expect(seen).toEqual(['/hello', '/run']);
  });

  test('a peer that relays the real runner\'s /hello through its own certificate fails the check, and gets no job', async () => {
    // The relay forwards the runner's answer, which names the runner's fingerprint (A) while the
    // connection carries the relay's certificate (B).
    const nonce = newNonce();
    const { port, seen } = await runnerStandIn(nonce, pemB, pemA.fingerprint);
    const out = await backendFor(port).run(handleFor(nonce), jobFor(nonce));
    expect(out).toEqual({ kind: 'dead', reason: 'the /hello proof does not match' });
    expect(seen).toEqual(['/hello']);
  });

  test('a runner of another tenant\'s task (another nonce) is refused and gets no job', async () => {
    const { port, seen } = await runnerStandIn(newNonce(), pemA);
    const nonce = newNonce();
    const out = await backendFor(port).run(handleFor(nonce), jobFor(nonce));
    expect(out).toEqual({ kind: 'dead', reason: 'wrong_sandbox' });
    expect(seen).toEqual(['/hello']);
  });
});

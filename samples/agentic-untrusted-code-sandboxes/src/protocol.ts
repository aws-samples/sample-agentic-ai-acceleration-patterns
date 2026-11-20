// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The wire protocol between the tool and the runner (runner/PROTOCOL.md,
 * ADR-0025). Types and pure functions only: no I/O, no AWS clients. The
 * Python runner implements the same encodings; both sides test against
 * runner/protocol/vectors.json.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Protocol version carried as `v` in every body. */
export const PROTOCOL_VERSION = 1;

/** Length of the start nonce in raw bytes. */
export const NONCE_BYTES = 32;

/** Tenant id rule (spec §5.1). */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Largest input the runner takes, in bytes after base64 decoding (runner/wire.py `MAX_INPUT_BYTES`, ADR-0039). */
export const MAX_INPUT_BYTES = 6 * 1024 * 1024;

/** A runner's `bootId`: 16 random bytes as 32 lowercase hex characters (runner/PROTOCOL.md). */
export const BOOT_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Ports the runner listens on (spec §3.5). */
export const RUNNER_PORTS = { http: 8080, tls: 8443, hooks: 9000 } as const;

/** Header AgentCore sets on every invocation (spec §3.5, S-14). */
export const AGENTCORE_SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

/** Environment variable that carries the nonce hash on `nitro` (spec §3.4). */
export const NONCE_HASH_ENV = 'RUNNER_NONCE_HASH';

/** One job, the body of `POST /run` and of `POST /invocations`. */
export interface RunJob {
  readonly v: 1;
  /** Tool-made run id, UTF-8 text; a UUID in practice. */
  readonly runId: string;
  readonly tenantId: string;
  /** The 32-byte nonce, base64url without padding (43 characters). */
  readonly nonce: string;
  /** UTF-8 Python source. */
  readonly code: string;
  /** The input object's bytes, standard base64 with padding. Absent when the call names no input. */
  readonly input?: string;
  /** Kill time in ms; the runner clamps it to 1000..60000. */
  readonly timeoutMs: number;
  /** stdout and stderr together, in bytes. */
  readonly maxOutputBytes: number;
  /** base64url HMAC-SHA-256, see {@link jobAuth}. */
  readonly jobAuth: string;
}

/** The runner's answer to a job it ran. */
export interface RunResult {
  readonly v: 1;
  readonly runId: string;
  /** Exit status 0..255, or -N when signal N ended the process. */
  readonly exitCode: number;
  /** UTF-8, invalid sequences replaced; cut by bytes before decoding. */
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly memoryExceeded: boolean;
  /** 16 random bytes, lowercase hex (32 characters). */
  readonly bootId: string;
  /** base64url HMAC-SHA-256(nonce, runId), see {@link resultProof}. */
  readonly proof: string;
}

/** Refusal codes the runner returns before it writes or runs anything. */
export type RefusalCode = 'wrong_sandbox' | 'busy' | 'dirty' | 'tool_failed';

/** HTTP status of each refusal on `/run` and `/hello`. On `/invocations` every refusal is HTTP 200. */
export const REFUSAL_STATUS: Readonly<Record<RefusalCode, number>> = {
  wrong_sandbox: 403,
  busy: 409,
  dirty: 410,
  tool_failed: 500,
};

/** HTTP status of a `tool_failed` refusal for a body the runner cannot parse or that breaks the schema. */
export const MALFORMED_JOB_STATUS = 400;

/** Body of every refusal. The tool decides on `error`, never on the status alone. */
export interface Refusal {
  readonly v: 1;
  readonly error: RefusalCode;
  /** Present when the runner has one. */
  readonly bootId?: string;
}

/** `GET /ping`. `bootId` is absent on `microvm` until the `/run` hook delivered the hash. */
export interface PingResponse {
  readonly status: 'Healthy';
  readonly bootId?: string;
}

/** `POST /hello` request (`nitro`, over TLS on 8443). */
export interface HelloRequest {
  readonly v: 1;
  readonly nonce: string;
  /** 32 random bytes, base64url without padding. */
  readonly challenge: string;
}

/** `POST /hello` response. */
export interface HelloResponse {
  readonly v: 1;
  readonly bootId: string;
  /** SHA-256 of the runner certificate's DER bytes, lowercase hex. */
  readonly certFingerprint: string;
  /** base64url HMAC-SHA-256(nonce, challenge ‖ certFingerprint), raw bytes on both sides. */
  readonly proof: string;
}

/** The `microvm` `/run` lifecycle hook payload (port 9000), sent as `runHookPayload`. */
export interface RunHookPayload {
  /** {@link nonceHash} of the nonce, lowercase hex. */
  readonly nonceHash: string;
  readonly tenant: string;
}

/** Either a result or a refusal, as the tool reads a job response. */
export type JobResponse = RunResult | Refusal;

export function isRefusal(body: JobResponse): body is Refusal {
  return typeof (body as Refusal).error === 'string';
}

/** base64url without padding. */
export function base64url(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

/** Decode base64url; refuses padding, any character outside the alphabet, and non-canonical text. */
export function fromBase64url(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error('not base64url without padding');
  }
  const raw = Buffer.from(text, 'base64url');
  if (raw.toString('base64url') !== text) {
    throw new Error('not canonical base64url');
  }
  return raw;
}

/** Decode a nonce and check its length. */
export function decodeNonce(nonce: string): Buffer {
  const raw = fromBase64url(nonce);
  if (raw.length !== NONCE_BYTES) {
    throw new Error(`nonce must be ${NONCE_BYTES} bytes`);
  }
  return raw;
}

/** A fresh nonce from the platform's CSPRNG, as stored in the registry row. */
export function newNonce(): string {
  return base64url(randomBytes(NONCE_BYTES));
}

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function framed(data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

/** SHA-256("nonce" ‖ raw nonce), lowercase hex. Travels in start calls instead of the nonce. */
export function nonceHash(nonce: string): string {
  return sha256(Buffer.from('nonce', 'utf8'), decodeNonce(nonce)).toString('hex');
}

/** Idempotency token for RunTask and RunMicrovm: first 32 hex of SHA-256("start" ‖ raw nonce). */
export function startToken(nonce: string): string {
  return sha256(Buffer.from('start', 'utf8'), decodeNonce(nonce)).toString('hex').slice(0, 32);
}

/** AgentCore runtime session id: "rc-" + hex SHA-256 of the tenant id (67 characters, ADR-0009). */
export function sessionIdFor(tenantId: string): string {
  return `rc-${sha256(Buffer.from(tenantId, 'utf8')).toString('hex')}`;
}

/**
 * jobAuth (spec §3.5): key = raw nonce; message = len(runId) ‖ runId ‖
 * len(tenantId) ‖ tenantId ‖ SHA-256(len(code) ‖ code ‖ len(input) ‖ input),
 * each len a 4-byte big-endian byte count; HMAC-SHA-256, base64url.
 * `input` is the raw object bytes; an absent input is zero bytes.
 */
export function jobAuth(nonce: string, runId: string, tenantId: string, code: string, input?: Uint8Array): string {
  const digest = sha256(framed(Buffer.from(code, 'utf8')), framed(input ?? new Uint8Array(0)));
  const message = Buffer.concat([framed(Buffer.from(runId, 'utf8')), framed(Buffer.from(tenantId, 'utf8')), digest]);
  return base64url(createHmac('sha256', decodeNonce(nonce)).update(message).digest());
}

/** The result proof: HMAC-SHA-256(raw nonce, UTF-8 runId), base64url. */
export function resultProof(nonce: string, runId: string): string {
  return base64url(createHmac('sha256', decodeNonce(nonce)).update(Buffer.from(runId, 'utf8')).digest());
}

/** The `/hello` proof: HMAC-SHA-256(raw nonce, raw challenge ‖ raw fingerprint), base64url. */
export function helloProof(nonce: string, challenge: string, certFingerprintHex: string): string {
  const fp = Buffer.from(certFingerprintHex, 'hex');
  if (fp.length !== 32 || fp.toString('hex') !== certFingerprintHex) {
    throw new Error('certFingerprint must be 64 lowercase hex characters');
  }
  const ch = fromBase64url(challenge);
  if (ch.length !== 32) {
    throw new Error('challenge must be 32 bytes');
  }
  return base64url(createHmac('sha256', decodeNonce(nonce)).update(Buffer.concat([ch, fp])).digest());
}

/** Constant-time comparison of two base64url proofs. */
export function proofMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build a signed job. The input travels as standard base64. */
export function buildJob(args: {
  runId: string;
  tenantId: string;
  nonce: string;
  code: string;
  input?: Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
}): RunJob {
  const job: RunJob = {
    v: PROTOCOL_VERSION,
    runId: args.runId,
    tenantId: args.tenantId,
    nonce: args.nonce,
    code: args.code,
    ...(args.input === undefined ? {} : { input: Buffer.from(args.input).toString('base64') }),
    timeoutMs: args.timeoutMs,
    maxOutputBytes: args.maxOutputBytes,
    jobAuth: jobAuth(args.nonce, args.runId, args.tenantId, args.code, args.input),
  };
  return job;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildJob, decodeNonce, fromBase64url, helloProof, isRefusal, jobAuth, MALFORMED_JOB_STATUS, newNonce, nonceHash,
  proofMatches, REFUSAL_STATUS, resultProof, sessionIdFor, startToken, TENANT_ID_PATTERN,
} from '../src/protocol';

interface Case {
  name: string;
  nonceHex: string;
  nonce: string;
  runId: string;
  tenantId: string;
  code: string;
  inputHex: string | null;
  expected: {
    nonceHash: string;
    startToken: string;
    sessionId: string;
    jobAuth: string;
    resultProof: string;
    job: Record<string, unknown>;
  };
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'runner', 'protocol', 'vectors.json'), 'utf8'),
) as {
  cases: Case[];
  hello: { nonce: string; challenge: string; certFingerprint: string; expected: { proof: string } };
  negative: Record<string, string>;
  refusalStatus: Record<string, number>;
  mustRefuseNonce: Record<string, string>;
  mustRefuseChallenge: { short: string };
};

const inputOf = (c: Case) => (c.inputHex === null ? undefined : Buffer.from(c.inputHex, 'hex'));

describe('wire protocol vectors (runner/protocol/vectors.json)', () => {
  test.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(Buffer.from(c.nonceHex, 'hex').toString('base64url')).toBe(c.nonce);
    expect(nonceHash(c.nonce)).toBe(c.expected.nonceHash);
    expect(startToken(c.nonce)).toBe(c.expected.startToken);
    expect(sessionIdFor(c.tenantId)).toBe(c.expected.sessionId);
    expect(sessionIdFor(c.tenantId)).toHaveLength(67);
    expect(jobAuth(c.nonce, c.runId, c.tenantId, c.code, inputOf(c))).toBe(c.expected.jobAuth);
    expect(resultProof(c.nonce, c.runId)).toBe(c.expected.resultProof);
    expect(TENANT_ID_PATTERN.test(c.tenantId)).toBe(true);
    const job = buildJob({
      runId: c.runId,
      tenantId: c.tenantId,
      nonce: c.nonce,
      code: c.code,
      input: inputOf(c),
      timeoutMs: 30000,
      maxOutputBytes: 262144,
    });
    expect(job).toEqual(c.expected.job);
  });

  test('hello proof', () => {
    const h = vectors.hello;
    expect(helloProof(h.nonce, h.challenge, h.certFingerprint)).toBe(h.expected.proof);
  });

  test('negative cases differ from the basic jobAuth', () => {
    const basic = vectors.cases[0].expected.jobAuth;
    for (const name of ['flipRunId', 'flipTenant', 'moveByteFromCodeToInput']) {
      expect(vectors.negative[name]).not.toBe(basic);
    }
  });

  test('every nonce and challenge the vectors mark as invalid is refused', () => {
    for (const [name, value] of Object.entries(vectors.mustRefuseNonce)) {
      if (name === 'note') continue;
      expect(() => decodeNonce(value)).toThrow();
    }
    const h = vectors.hello;
    expect(() => helloProof(h.nonce, vectors.mustRefuseChallenge.short, h.certFingerprint)).toThrow(/challenge/);
  });

  test('refusal statuses match the vectors', () => {
    const { malformedJob, onInvocations, ...byCode } = vectors.refusalStatus;
    expect(byCode).toEqual(REFUSAL_STATUS);
    expect(malformedJob).toBe(MALFORMED_JOB_STATUS);
    expect(onInvocations).toBe(200);
  });
});

describe('encodings', () => {
  test('a new nonce is 32 bytes of base64url', () => {
    const n = newNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decodeNonce(n)).toHaveLength(32);
    expect(newNonce()).not.toBe(n);
  });

  test('padding, standard base64, non-canonical text and short values are refused', () => {
    expect(() => fromBase64url('AAAA=')).toThrow();
    expect(() => fromBase64url('AA+/')).toThrow();
    expect(() => fromBase64url('AB')).toThrow(/canonical/);
    expect(() => decodeNonce('AAAA')).toThrow(/32 bytes/);
    const h = vectors.hello;
    expect(() => helloProof(h.nonce, 'AAAA', h.certFingerprint)).toThrow(/challenge/);
  });

  test('a fingerprint must be lowercase hex of 32 bytes', () => {
    const h = vectors.hello;
    expect(() => helloProof(h.nonce, h.challenge, h.certFingerprint.toUpperCase())).toThrow();
    expect(() => helloProof(h.nonce, h.challenge, 'ab')).toThrow();
  });

  test('tenant id rule', () => {
    expect(TENANT_ID_PATTERN.test('a'.repeat(65))).toBe(false);
    expect(TENANT_ID_PATTERN.test('-a')).toBe(false);
    expect(TENANT_ID_PATTERN.test('TENANT#a')).toBe(false);
  });

  test('refusals', () => {
    expect(isRefusal({ v: 1, error: 'busy' })).toBe(true);
    expect(REFUSAL_STATUS.wrong_sandbox).toBe(403);
  });

  test('proofMatches', () => {
    expect(proofMatches('abc', 'abc')).toBe(true);
    expect(proofMatches('abc', 'abd')).toBe(false);
    expect(proofMatches('abc', 'ab')).toBe(false);
    expect(proofMatches('abc', undefined)).toBe(false);
  });
});

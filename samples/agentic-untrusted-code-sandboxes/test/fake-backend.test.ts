// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { FakeBackend } from './fake-backend';
import type { RegistryRow, TenantCredentials } from '../src/backend';
import { buildJob, newNonce, proofMatches, resultProof } from '../src/protocol';

const creds = (tenantId: string): TenantCredentials => ({
  tenantId, accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example', sessionToken: 'example',
});
const row = { version: 1 } as RegistryRow;

test('the fake backend starts, probes, runs a signed job and stops', async () => {
  const b = new FakeBackend('nitro');
  b.script.startingProbes = 1;
  const nonce = newNonce();
  const h = await b.start('tenant-a', nonce, creds('tenant-a'));
  expect((await b.ready(h, row)).state).toBe('starting');
  const ready = await b.ready(h, row);
  expect(ready.state).toBe('ready');
  const job = buildJob({ runId: 'r1', tenantId: 'tenant-a', nonce, code: 'print(1)', timeoutMs: 1000, maxOutputBytes: 10 });
  const out = await b.run(h, job);
  expect(out.kind).toBe('result');
  if (out.kind === 'result') expect(proofMatches(resultProof(nonce, 'r1'), out.result.proof)).toBe(true);
  const listed = [];
  for await (const s of b.list()) listed.push(s);
  expect(listed).toEqual([expect.objectContaining({ handle: h.handle, tenantId: 'tenant-a', live: true })]);
  await b.stop(h);
  expect(await b.isAlive(h)).toBe(false);
  expect((await b.stopReason(h)).stoppedAt).toBeDefined();
});

test('a job signed with another nonce is refused as wrong_sandbox', async () => {
  const b = new FakeBackend();
  const h = await b.start('tenant-a', newNonce(), creds('tenant-a'));
  const job = buildJob({ runId: 'r1', tenantId: 'tenant-a', nonce: newNonce(), code: '', timeoutMs: 1000, maxOutputBytes: 10 });
  expect(await b.run(h, job)).toEqual({ kind: 'refused', refusal: { v: 1, error: 'wrong_sandbox' } });
});

test('a failed start and a dead handle', async () => {
  const b = new FakeBackend();
  b.script.endBeforeReady = 'Essential container exited';
  const h = await b.start('tenant-a', newNonce(), creds('tenant-a'));
  expect(await b.ready(h, row)).toEqual({ state: 'ended', reason: 'Essential container exited' });
  const job = buildJob({ runId: 'r', tenantId: 'tenant-a', nonce: h.nonce, code: '', timeoutMs: 1000, maxOutputBytes: 1 });
  expect((await b.run(h, job)).kind).toBe('dead');
  await expect(b.start('tenant-a', newNonce(), creds('tenant-b'))).rejects.toThrow(/another tenant/);
});

test('a scripted no_answer outcome reaches the caller', async () => {
  const b = new FakeBackend();
  const h = await b.start('tenant-a', newNonce(), creds('tenant-a'));
  b.script.nextRun = { kind: 'no_answer' };
  const job = buildJob({ runId: 'r', tenantId: 'tenant-a', nonce: h.nonce, code: '', timeoutMs: 1000, maxOutputBytes: 1 });
  expect(await b.run(h, job)).toEqual({ kind: 'no_answer' });
});

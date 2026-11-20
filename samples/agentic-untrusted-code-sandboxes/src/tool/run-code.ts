// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `runCode`: the run logic of the `run_code` tool (spec §4.1, §5.1, ADR-0032).
 * The gateway entry and the standalone entry both call it, each with a tenant
 * id it took from a verified identity. It never throws and never reads a
 * tenant from anything but its `tenantId`: it validates the call, fetches the
 * input with the tenant's own credentials, finds or starts the tenant's
 * sandbox in the registry, runs one signed job, and writes one log line.
 *
 * The registry rules, in the spec's order:
 *   step 1 read the row and decide (`acquire`),
 *   step 2 take over with a version condition (`startNew`),
 *   step 3 run, treating a failed identity check or a refusal as a dead handle,
 *   step 4 move `lastUsedAt` forward,
 *   step 5 on no answer, set STOPPING, stop, and return `timedOut`.
 */

import { type BackendName, BACKEND_NAMES, type RegistryRow, type SandboxBackend, type TenantCredentials } from '../backend';
import { buildJob, proofMatches, resultProof, TENANT_ID_PATTERN } from '../protocol';
import { handleLessStaleMs } from './config';
import { defaultDeps, type RunCodeDeps } from './deps';
import { errorName, Logger, type RunLine } from './log';
import { InputError, validInputName, type ObjectStore } from './objects';
import type { Registry } from './registry';
import { handleOf, stopQuietly, writeStopLine } from './sandbox';
import type { RunCodeError, RunCodeOutput, RunCodeRequest, RunCodeResult } from './types';

/** Re-reads one call makes after losing a race, across every step, before it gives up with `sandbox_starting`. */
const MAX_REREADS = 4;
/** A failed start or a dead sandbox backs off this long before the next takeover (spec §4.1). */
const FAIL_BACKOFF_MS = 30_000;
/** Advice to a caller whose call found the sandbox still starting. */
const STARTING_RETRY_SECONDS = 5;
/** Exit code of a job the tool ended by stopping its sandbox: the runner never answered, so it was killed (signal 9). */
const OVERRUN_EXIT_CODE = -9;
/** What a runner's `bootId` looks like on the wire (hex in the protocol); the tool bounds it before it writes it to the row. */
const BOOT_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;
/** `code` limit in UTF-8 bytes (spec §5.1). */
const MAX_CODE_BYTES = 65536;

type ReadyRow = RegistryRow & { readonly handle: string };
type Next =
  | { readonly kind: 'ready'; readonly row: ReadyRow }
  | { readonly kind: 'reread' }
  | { readonly kind: 'error'; readonly error: RunCodeError };

interface Call {
  readonly deps: RunCodeDeps;
  readonly tenantId: string;
  readonly backendName: BackendName;
  readonly backend: SandboxBackend;
  readonly creds: TenantCredentials;
  readonly registry: Registry;
  readonly runId: string;
  readonly code: string;
  /** Milliseconds the function may still run (a Lambda's `getRemainingTimeInMillis`). */
  readonly remainingMs?: () => number;
  input?: Uint8Array;
  sandbox: 'started' | 'reused';
  handle?: string;
  /** The call has slept for a starting sandbox. */
  waited: boolean;
  /** The call may not wait again (spec §4.1 step 3). */
  spent: boolean;
  waitUntil?: number;
  rereads: number;
  deads: number;
  stoppedReason?: string;
  startMs?: number;
}

const fail = (error: RunCodeError['error'], retryAfterSeconds?: number): RunCodeError =>
  retryAfterSeconds === undefined ? { error } : { error, retryAfterSeconds };

/** Checks the fields (spec §5.1). Everything here comes from a caller, so each field is checked as `unknown`. */
function validate(request: unknown, deps: RunCodeDeps):
  | { readonly error: RunCodeError; readonly tenantId?: string }
  | { readonly tenantId: string; readonly code: string; readonly input?: string; readonly backend: BackendName; readonly saveOutput: boolean } {
  if (typeof request !== 'object' || request === null) return { error: fail('invalid_argument') };
  const r = request as Record<string, unknown>;
  if (typeof r.tenantId !== 'string' || !TENANT_ID_PATTERN.test(r.tenantId)) return { error: fail('invalid_argument') };
  const code = r.code;
  // From here the tenant id is a valid one, so a refusal is counted against it.
  const tenantId = r.tenantId;
  const refuse = (error: RunCodeError['error']) => ({ error: fail(error), tenantId });
  if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) return refuse('invalid_argument');
  // A lone surrogate does not survive UTF-8: the runner would hash different bytes than the tool.
  if (Buffer.from(code, 'utf8').toString('utf8') !== code) return refuse('invalid_argument');
  if (r.input !== undefined && !validInputName(r.input)) return refuse('invalid_argument');
  if (r.saveOutput !== undefined && typeof r.saveOutput !== 'boolean') return refuse('invalid_argument');
  let backend = deps.config.defaultBackend;
  if (r.backend !== undefined) {
    const named = BACKEND_NAMES.find((b) => b === r.backend);
    if (named === undefined) return refuse('invalid_argument');
    backend = named;
  }
  if (!deps.config.backends.includes(backend) || !deps.backends.has(backend)) return refuse('backend_disabled');
  return { tenantId: r.tenantId, code, input: r.input as string | undefined, backend, saveOutput: r.saveOutput === true };
}

export interface RunCodeOptions {
  /** The function's remaining time. With it, a call that has used most of its time does not start a second sandbox. */
  readonly remainingMs?: () => number;
}

/**
 * Runs `request.code` in the tenant's sandbox and returns the output, or a
 * tool error (spec §5.1). `deps` is for tests; the handlers pass none.
 */
export async function runCode(request: RunCodeRequest, deps?: RunCodeDeps, options: RunCodeOptions = {}): Promise<RunCodeResult> {
  let d: RunCodeDeps;
  try {
    d = deps ?? defaultDeps();
  } catch (error) {
    new Logger().run({ tenantId: 'unknown', outcome: 'tool_failed', stoppedReason: errorName(error) });
    return fail('tool_failed');
  }
  const t0 = d.now();
  const checked = validate(request, d);
  if ('error' in checked) {
    d.log.run({ tenantId: checked.tenantId ?? 'invalid', outcome: checked.error.error, durationMs: d.now() - t0 });
    return checked.error;
  }
  let call: Call | undefined;
  let result: RunCodeResult;
  let failure: string | undefined;
  try {
    const creds = await d.credentials(checked.tenantId);
    call = {
      deps: d,
      tenantId: checked.tenantId,
      backendName: checked.backend,
      backend: d.backends.get(checked.backend) as SandboxBackend,
      creds,
      registry: d.registryFor(creds),
      runId: d.newRunId(),
      code: checked.code,
      remainingMs: options.remainingMs,
      sandbox: 'reused',
      waited: false,
      spent: false,
      rereads: 0,
      deads: 0,
    };
    if (checked.input !== undefined) call.input = await d.objectsFor(creds).readInput(checked.tenantId, checked.input, d.config.maxInputBytes);
    result = await execute(call, checked.saveOutput, d.objectsFor(creds));
  } catch (error) {
    if (error instanceof InputError) {
      result = fail(error.code);
    } else {
      result = fail('tool_failed');
      failure = errorName(error);
    }
  }
  const line: RunLine = {
    tenantId: checked.tenantId,
    backend: checked.backend,
    handle: call?.handle,
    runId: call?.runId,
    outcome: 'error' in result ? result.error : 'ok',
    durationMs: d.now() - t0,
    startMs: call?.startMs,
    inputBytes: call?.input?.length ?? 0,
    stoppedReason: call?.stoppedReason ?? failure,
    ...('error' in result
      ? {}
      : {
        sandbox: result.sandbox,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputBytes: Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8'),
      }),
  };
  d.log.run(line);
  return result;
}

async function execute(call: Call, saveOutput: boolean, objects: ObjectStore): Promise<RunCodeResult> {
  const { deps } = call;
  const t0 = deps.now();
  let row: ReadyRow | undefined;
  for (;;) {
    if (row === undefined) {
      const acquired = await acquire(call);
      if (acquired.kind === 'error') return acquired.error;
      row = acquired.row;
    }
    call.handle = row.handle;
    const marked = await markStart(call, row);
    if (marked === undefined) {
      row = undefined;
      if (++call.rereads > MAX_REREADS) return fail('sandbox_starting', STARTING_RETRY_SECONDS);
      continue;
    }
    call.startMs ??= deps.now() - t0;
    const ran = await runJob(call, marked);
    if (ran.kind === 'done') {
      if (ran.output === undefined) return ran.error ?? fail('tool_failed');
      if (saveOutput) await objects.writeOutput(call.tenantId, call.runId, JSON.stringify(ran.output));
      return ran.output;
    }
    const next = await retireDead(call, ran.row);
    if (next.kind === 'error') return next.error;
    if (next.kind === 'reread' && ++call.rereads > MAX_REREADS) return fail('sandbox_starting', STARTING_RETRY_SECONDS);
    row = next.kind === 'ready' ? next.row : undefined;
  }
}

/** Whether the call may still sleep for a starting sandbox: once per call, at most `startWait` (spec §4.1). */
function mayWait(call: Call): boolean {
  if (call.spent) return false;
  const now = call.deps.now();
  call.waitUntil ??= now + call.deps.config.startWaitMs;
  return now < call.waitUntil;
}

async function pause(call: Call): Promise<void> {
  call.waited = true;
  call.sandbox = 'started';
  await call.deps.sleep(call.deps.pollMs);
}

/** Step 1: read the row and decide until a `READY` row is in hand or the call has an answer. */
async function acquire(call: Call): Promise<{ readonly kind: 'ready'; readonly row: ReadyRow } | { readonly kind: 'error'; readonly error: RunCodeError }> {
  const { deps } = call;
  for (;;) {
    const row = await call.registry.get(call.tenantId, call.backendName);
    const now = deps.now();
    let next: Next;
    if (row === undefined) {
      next = await startNew(call, undefined, 'missing');
    } else if (now >= row.expiresAt) {
      next = await startNew(call, row, 'expired');
    } else if (row.state === 'READY') {
      if (row.handle === undefined) {
        next = await startNew(call, row, 'dead');
      } else {
        return { kind: 'ready', row: { ...row, handle: row.handle } };
      }
    } else if (row.state === 'STARTING') {
      if (row.handle === undefined) {
        if (now - row.createdAt > handleLessStaleMs(deps.config)) {
          next = await startNew(call, row, 'handleless');
        } else {
          // Another call is between its takeover and recording the handle.
          if (!mayWait(call)) return { kind: 'error', error: fail('sandbox_starting', STARTING_RETRY_SECONDS) };
          await pause(call);
          continue;
        }
      } else {
        next = await probe(call, { ...row, handle: row.handle });
      }
    } else if (row.state === 'FAILED' && row.retryAt !== undefined && now < row.retryAt) {
      return { kind: 'error', error: fail('sandbox_failed', Math.max(1, Math.ceil((row.retryAt - now) / 1000))) };
    } else {
      // FAILED after `retryAt`, or STOPPING.
      next = await startNew(call, row, row.state === 'FAILED' ? 'failed' : 'stopping');
    }
    if (next.kind === 'ready') return next;
    if (next.kind === 'error') return next;
    if (++call.rereads > MAX_REREADS) return { kind: 'error', error: fail('sandbox_starting', STARTING_RETRY_SECONDS) };
  }
}

/**
 * Step 2: put a `STARTING` row with a new nonce, stop the handle it replaced,
 * start, record the handle, and probe. `prev` is the row the caller read.
 */
async function startNew(call: Call, prev: RegistryRow | undefined, why: string): Promise<Next> {
  const { deps } = call;
  const nonce = deps.newNonce();
  const row = await call.registry.takeOver({
    tenantId: call.tenantId,
    backend: call.backendName,
    nonce,
    now: deps.now(),
    startCapMs: call.backend.startCapMs,
    sandboxMaxLifeMs: deps.config.sandboxMaxLifeMs,
    replaces: prev?.handle,
  }, prev);
  if (row === undefined) return { kind: 'reread' };
  call.sandbox = 'started';
  let held: RegistryRow = row;
  if (prev?.handle !== undefined) {
    await retire(call, { ...prev, handle: prev.handle }, why);
    // The replaced sandbox now has its line. Until this write a reaper or drain pass that finds the row old and unmarked
    // writes the line itself, because the call may have died before it did (ADR-0034).
    const marked = await call.registry.update(row, { replacesLined: true });
    if (marked === undefined) {
      // An offboard that deleted the row meanwhile has ended this tenant: do not start a sandbox for it.
      if (await call.registry.get(call.tenantId, call.backendName) === undefined) return { kind: 'error', error: fail('sandbox_starting', 1) };
      return { kind: 'reread' };
    }
    held = { ...row, version: marked };
  }
  let started;
  try {
    started = await call.backend.start(call.tenantId, nonce, call.creds);
  } catch (error) {
    // Nothing is recorded to stop. A sandbox the failed call launched anyway is an orphan the reaper's sweep stops.
    call.stoppedReason = errorName(error);
    await call.registry.update(held, { state: 'FAILED', retryAt: deps.now() + FAIL_BACKOFF_MS });
    return { kind: 'error', error: fail('sandbox_failed', FAIL_BACKOFF_MS / 1000) };
  }
  call.handle = started.handle;
  const version = await call.registry.update(held, { handle: started.handle, address: started.address });
  if (version === undefined) {
    // The row moved while the sandbox started (an offboard, or the reaper): nothing names it any more.
    await stopQuietly(call.backend, started, deps.log, call.creds);
    await writeStopLine({
      log: deps.log,
      backend: call.backend,
      now: deps.now(),
      sandboxIdleMs: deps.config.sandboxIdleMs,
      by: 'tool',
      reason: 'orphan',
      orphan: true,
      row: { tenantId: call.tenantId, backend: call.backendName, handle: started.handle, createdAt: row.createdAt },
    });
    return { kind: 'error', error: fail('sandbox_starting', 1) };
  }
  return probe(call, { ...held, handle: started.handle, address: started.address, version });
}

/** Stops the handle a takeover replaced. The takeover moved the row out of READY or STARTING only then does this call owe the line. */
async function retire(call: Call, prev: ReadyRow, why: string): Promise<void> {
  const { deps } = call;
  await stopQuietly(call.backend, handleOf(prev), deps.log, call.creds);
  if (prev.state === 'READY' || prev.state === 'STARTING') {
    await writeStopLine({
      log: deps.log, backend: call.backend, row: prev, now: deps.now(), sandboxIdleMs: deps.config.sandboxIdleMs, by: 'tool', reason: why,
    });
  }
}

/** The ready check of step 1: probe, write what the probe learnt, and wait up to `startWait`. */
async function probe(call: Call, start: ReadyRow): Promise<Next> {
  const { deps } = call;
  let row = start;
  for (;;) {
    const result = await call.backend.ready(handleOf(row), row);
    if (result.state === 'ended') return failStart(call, row, result.reason);
    if (result.state === 'ready') {
      const address = result.patch.address ?? row.address;
      // A backend's boot id goes to the row only when it looks like one (ADR-0032).
      const bootId = result.patch.bootId !== undefined && BOOT_ID_PATTERN.test(result.patch.bootId) ? result.patch.bootId : row.bootId;
      const version = await call.registry.update(row, { state: 'READY', address, bootId });
      if (version === undefined) return { kind: 'reread' };
      call.handle = row.handle;
      return { kind: 'ready', row: { ...row, state: 'READY', address, bootId, version } };
    }
    if (result.patch.address !== undefined && result.patch.address !== row.address) {
      const version = await call.registry.update(row, { address: result.patch.address });
      if (version === undefined) return { kind: 'reread' };
      row = { ...row, address: result.patch.address, version };
    }
    if (deps.now() >= (row.leaseUntil ?? row.createdAt + call.backend.startCapMs)) return failStart(call, row, 'start_cap');
    if (!mayWait(call)) return { kind: 'error', error: fail('sandbox_starting', STARTING_RETRY_SECONDS) };
    await pause(call);
  }
}

/** A start that ended, or ran out its cap, becomes FAILED with a backoff; whoever notices does this (spec §4.1). */
async function failStart(call: Call, row: ReadyRow, reason: string): Promise<Next> {
  const { deps } = call;
  call.stoppedReason = reason;
  const version = await call.registry.update(row, { state: 'FAILED', retryAt: deps.now() + FAIL_BACKOFF_MS });
  if (version === undefined) return { kind: 'reread' };
  await stopQuietly(call.backend, handleOf(row), deps.log, call.creds);
  await writeStopLine({
    log: deps.log, backend: call.backend, row, now: deps.now(), sandboxIdleMs: deps.config.sandboxIdleMs, by: 'tool', reason: 'failed_start', stoppedReason: reason,
  });
  return { kind: 'error', error: fail('sandbox_failed', FAIL_BACKOFF_MS / 1000) };
}

/**
 * The start mark (spec §3.8): `lastUsedAt` = now, conditioned on the value
 * read. Re-reads and retries when another call wrote first. Undefined when the
 * row is no longer this call's `READY` row.
 */
async function markStart(call: Call, row: ReadyRow): Promise<ReadyRow | undefined> {
  const { deps } = call;
  let cur = row;
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = deps.now();
    // microvm: each idle gap is suspended time, counted once (spec §3.8).
    const gap = call.backendName === 'microvm'
      ? Math.max(0, now - (cur.lastUsedAt ?? cur.createdAt) - deps.config.sandboxIdleMs)
      : undefined;
    const marked = await call.registry.markStart(cur, now, gap);
    if (marked?.handle !== undefined) return { ...marked, handle: marked.handle };
    const fresh = await call.registry.get(call.tenantId, call.backendName);
    if (fresh === undefined || fresh.state !== 'READY' || fresh.handle !== row.handle || fresh.nonce !== row.nonce) return undefined;
    cur = { ...fresh, handle: fresh.handle };
  }
  // Three marks lost to other calls: re-read the row from the top rather than run on a stale snapshot.
  return undefined;
}

type Ran =
  | { readonly kind: 'done'; readonly output?: RunCodeOutput; readonly error?: RunCodeError }
  | { readonly kind: 'dead'; readonly row: ReadyRow };

/** Step 3, 4 and 5: send the job and act on the outcome. */
async function runJob(call: Call, row: ReadyRow): Promise<Ran> {
  const { deps } = call;
  const config = deps.config;
  const job = buildJob({
    runId: call.runId,
    tenantId: call.tenantId,
    nonce: row.nonce,
    code: call.code,
    input: call.input,
    timeoutMs: config.runTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  });
  const began = deps.now();
  const outcome = await call.backend.run(handleOf(row), job);
  switch (outcome.kind) {
    case 'result': {
      const res = outcome.result;
      if (res.runId !== call.runId || !proofMatches(resultProof(row.nonce, call.runId), res.proof)) return { kind: 'dead', row };
      if (typeof res.bootId !== 'string' || !BOOT_ID_PATTERN.test(res.bootId)) return { kind: 'dead', row };
      if (res.bootId !== row.bootId) {
        // A changed boot id is a restarted sandbox (spec §4.1 step 3); the first one the row sees is only recorded.
        if (row.bootId !== undefined) call.sandbox = 'started';
        await call.registry.update(row, { bootId: res.bootId });
      }
      await call.registry.touch(call.tenantId, call.backendName, row.handle, deps.now());
      const [stdout, stderr, cut] = capOutput(res.stdout, res.stderr, config.maxOutputBytes);
      return {
        kind: 'done',
        output: {
          runId: call.runId,
          backend: call.backendName,
          exitCode: res.exitCode,
          stdout,
          stderr,
          truncated: res.truncated || cut,
          timedOut: res.timedOut,
          memoryExceeded: res.memoryExceeded,
          durationMs: res.durationMs,
          sandbox: call.sandbox,
        },
      };
    }
    case 'refused':
      switch (outcome.refusal.error) {
        case 'busy': return { kind: 'done', error: fail('sandbox_busy') };
        case 'tool_failed': return { kind: 'done', error: fail('tool_failed') };
        default: return { kind: 'dead', row };
      }
    case 'dead':
      return { kind: 'dead', row };
    case 'no_answer': {
      await overrun(call, row);
      return {
        kind: 'done',
        output: {
          runId: call.runId,
          backend: call.backendName,
          exitCode: OVERRUN_EXIT_CODE,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: true,
          memoryExceeded: false,
          durationMs: deps.now() - began,
          sandbox: call.sandbox,
        },
      };
    }
  }
}

/** Step 5: the runner did not answer by `runTimeout` + 5 s. Set STOPPING, stop the sandbox, write its line. */
async function overrun(call: Call, row: ReadyRow): Promise<void> {
  const { deps } = call;
  let wrote = false;
  let cur: RegistryRow = row;
  for (let attempt = 0; attempt < MAX_REREADS; attempt++) {
    wrote = (await call.registry.update(cur, { state: 'STOPPING' })) !== undefined;
    if (wrote) break;
    const fresh = await call.registry.get(call.tenantId, call.backendName);
    // Another call moved the row. The same sandbox still on it means stop it anyway; a different one is not ours to stop.
    if (fresh?.handle !== row.handle || fresh.nonce !== row.nonce) return;
    // Out of READY and STARTING already: whoever moved it wrote the line.
    if (fresh.state !== 'READY' && fresh.state !== 'STARTING') break;
    cur = fresh;
  }
  await stopQuietly(call.backend, handleOf(row), deps.log, call.creds);
  if (wrote) {
    await writeStopLine({
      log: deps.log, backend: call.backend, row, now: deps.now(), sandboxIdleMs: deps.config.sandboxIdleMs, by: 'tool', reason: 'overrun',
    });
  }
}

/** A failed identity check or a refusal marks the row dead: take it over once, then give up with a backoff (spec §4.1 step 3). */
async function retireDead(call: Call, row: ReadyRow): Promise<Next> {
  const { deps } = call;
  // Another start and run must fit in what is left of the function's time, or the next call finds a handle-less row.
  // Without that time the row is failed as for a second dead handle, so a handle that is dead but slow to detect is not kept.
  const left = call.remainingMs?.();
  const noTime = left !== undefined && left < deps.config.startWaitMs + deps.config.runTimeoutMs + 5000;
  if (call.deads >= 1 || noTime) {
    const version = await call.registry.update(row, { state: 'FAILED', retryAt: deps.now() + FAIL_BACKOFF_MS });
    if (version === undefined) return { kind: 'reread' };
    call.stoppedReason = 'dead';
    await stopQuietly(call.backend, handleOf(row), deps.log, call.creds);
    await writeStopLine({
      log: deps.log, backend: call.backend, row, now: deps.now(), sandboxIdleMs: deps.config.sandboxIdleMs, by: 'tool', reason: 'dead',
    });
    return { kind: 'error', error: fail('sandbox_failed', FAIL_BACKOFF_MS / 1000) };
  }
  call.deads += 1;
  // A call that already waited for a start does not wait again (spec §4.1 step 3).
  if (call.waited) call.spent = true;
  return startNew(call, row, 'dead');
}

/** Cuts stdout first, then stderr, to `max` bytes together. The runner already does; this is the tool's own cap on what it returns. */
function capOutput(stdout: string, stderr: string, max: number): [string, string, boolean] {
  const out = Buffer.from(stdout, 'utf8');
  const err = Buffer.from(stderr, 'utf8');
  if (out.length + err.length <= max) return [stdout, stderr, false];
  const errKept = Math.min(err.length, max);
  const outKept = Math.max(0, max - errKept);
  return [cutUtf8(out, outKept), cutUtf8(err, errKept), true];
}

/** The first `max` bytes of `buf`, ending on a character boundary so the cut never adds a replacement character. */
function cutUtf8(buf: Buffer, max: number): string {
  if (buf.length <= max) return buf.toString('utf8');
  let end = max;
  while (end > 0 && buf[end] >= 0x80 && buf[end] < 0xc0) end--;
  return buf.subarray(0, end).toString('utf8');
}

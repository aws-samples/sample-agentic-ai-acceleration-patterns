// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Behaviour steps 2, the ones that run the hostile probes of
 * test/integ/hostile/: limits, no-credentials, no-egress, runaway,
 * session-files, dns, dns-platform (spec §8).
 */

import { randomBytes } from 'node:crypto';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { sleep } from '../aws';
import { insights, logEvidence, runnerGroups } from '../cloud';
import { type Backend, TENANT } from '../common';
import { type Ctx, type CallResult } from '../ctx';
import { INPUT_AT_CAP, INPUT_OVER_CAP, inputAtCap, sha256Hex } from '../fixtures';
import { presignUrl } from '../sigv4';
import { type Unit } from '../steps';
import { attempt, field } from './basic';
import { MAX_INPUT_BYTES_CAP, MAX_OUTPUT_BYTES_CAP } from '../../../src/props';

const { a: A, b: B } = TENANT;

const backendOf = (u: Unit): Backend => {
  if (!u.backend) throw new Error(`step ${u.step} needs a backend`);
  return u.backend;
};

/** A blocked call: the probe's attempt failed with `PermissionError` (EPERM). */
const blocked = (out: Record<string, unknown>, name: string): boolean => {
  const a = attempt(out, name);
  return a.ok === false && (a.err === 'PermissionError' || a.errno === 1);
};

/** The probe errors (test/integ/hostile/_lib.py) that never count as blocked: a completed connect, a lookup with no answer, a thread that did not start. */
export const CONNECTED = 'ProbeConnected';
export const LOOKUP_SLOW = 'ProbeLookupSlow';
// RuntimeError: a probe thread could not start (the job's process limit), so nothing was tried.
const NOT_BLOCKED: ReadonlySet<string> = new Set([CONNECTED, LOOKUP_SLOW, 'RuntimeError']);

/** True when a probe got no connection at all: an error, and not one that leaves the path open or unknown. */
export const noConnection = (o: unknown): boolean => {
  const r = (o ?? {}) as { error?: string };
  return r.error !== undefined && !NOT_BLOCKED.has(r.error);
};

/** The status of a probe's answer, from either field the scripts write (`status` or `outcome`). */
const statusOf = (o: unknown): number | undefined => {
  const r = (o ?? {}) as { status?: unknown; outcome?: unknown };
  const v = r.status ?? r.outcome;
  return typeof v === 'number' ? v : undefined;
};

/**
 * A read or write of B's data, or a post out, is denied. Where the sandbox has a route to the service (S3 on
 * `agentcore`, through the gateway endpoint), it must reach it and be refused with 403. Everywhere else (S3 on
 * `microvm` and `nitro`, DynamoDB and the internet on every backend) it must make no connection at all, so an
 * unreachable service and a denial never look the same.
 */
export function denied(target: 's3' | 'dynamodb' | 'internet', o: unknown, backend: Backend): boolean {
  if (target === 's3' && backend === 'agentcore') return statusOf(o) === 403;
  return noConnection(o) && statusOf(o) === undefined;
}

/** A no-egress attempt fails (see `denied`); the TCP probes report `connected` when their connect completes. */
export function egressFailed(name: string, o: unknown, backend: Backend): boolean {
  if (name === 'put_presigned') return denied('s3', o, backend);
  const r = (o ?? {}) as { outcome?: string | number };
  if (r.outcome === 'connected') return false;
  return denied('internet', o, backend);
}

/** The positive control of no-egress: the same request code, under the same deadline, got a status from an allowed address. */
export const controlAnswered = (o: unknown): boolean => statusOf(o) !== undefined;

/** How long a blocked no-egress probe may take: a lookup of up to 5 s, then 2 s per address tried (at most four), plus 1 s. */
export const PROBE_BOUND_MS = 14_000;

/** The 6 MB Lambda response limit; the tool's answer must stay under it. */
export const LAMBDA_RESPONSE_BYTES = 6_000_000;

/** The control-byte print returned cut, under the response limit, and holding only 0x01 bytes. */
export function controlOutputOk(r: { truncated?: boolean; stdout?: string } | undefined): boolean {
  if (r === undefined || r.truncated !== true || typeof r.stdout !== 'string' || r.stdout.length === 0) return false;
  return Buffer.byteLength(JSON.stringify(r)) < LAMBDA_RESPONSE_BYTES && r.stdout.split('\u0001').join('') === '';
}

export async function limits(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  // The run-code instance sets maxInputBytes and maxOutputBytes to their caps (test/integ.sandboxes.ts).
  const over = await c.call('run-code', A, { code: 'print(1)', input: INPUT_OVER_CAP, backend }, { once: true });
  c.rec.check(`an input one byte over maxInputBytes returns input_too_large (got ${over.outcome.kind === 'error' ? over.outcome.code : over.outcome.kind})`, over.outcome.kind === 'error' && over.outcome.code === 'input_too_large');
  const at = await c.probe('run-code', A, backend, 'limits', { mode: 'input' }, { input: INPUT_AT_CAP });
  c.rec.check(`an input of exactly maxInputBytes is read back whole (size ${String(field(at.out, 'size'))}, exit ${String(at.call.result?.exitCode)})`,
    at.call.result?.exitCode === 0 && field(at.out, 'size') === MAX_INPUT_BYTES_CAP && field(at.out, 'sha256') === sha256Hex(inputAtCap()));
  const ctl = await c.probe('run-code', A, backend, 'limits', { mode: 'control', bytes: MAX_OUTPUT_BYTES_CAP });
  const r = ctl.call.result;
  const size = r === undefined ? 0 : Buffer.byteLength(JSON.stringify(r));
  // The stdout length shows which bound cut it: the runner's maxOutputBytes, or the tool's 5 MiB JSON bound (ADR-0063).
  c.rec.check(`a print of maxOutputBytes control bytes returns truncated under ${LAMBDA_RESPONSE_BYTES} bytes (truncated ${String(r?.truncated)}, ${size} bytes, stdout ${String(r?.stdout.length)} of ${MAX_OUTPUT_BYTES_CAP} characters)`,
    controlOutputOk(r));

  const lock = await c.probe('run-code', A, backend, 'limits', { mode: 'shm_write' });
  const mp = attempt(lock.out, 'mp_lock');
  if (backend === 'microvm') {
    c.rec.check(`multiprocessing.Lock() raises PermissionError on microvm (got ${mp.ok ? 'ok' : mp.err})`, mp.ok === false && mp.err === 'PermissionError');
  } else {
    c.rec.check(`multiprocessing.Lock() works on ${backend} (got ${mp.ok ? 'ok' : mp.err})`, mp.ok === true);
    c.rec.check('the probe left a file in /dev/shm', attempt(lock.out, 'shm_file').ok === true);
    const check = await c.probe('run-code', A, backend, 'limits', { mode: 'shm_check' });
    c.rec.check('a file the job leaves in /dev/shm is gone at its next call', field(check.out, 'shm_file_present') === false);
  }
  if (backend === 'microvm') {
    const f = await c.probe('run-code', A, backend, 'limits', { mode: 'microvm' });
    for (const name of ['memfd_create', 'semget', 'setsockopt_sndbuf', 'af_unix_socket', 'listen_128']) {
      c.rec.check(`${name} is refused on microvm`, blocked(f.out, name));
    }
    c.rec.check('socketpair works', attempt(f.out, 'socketpair').ok === true);
    c.rec.check('listen(5) works', attempt(f.out, 'listen_5').ok === true);
    c.rec.check(`the job's /proc/self/status shows Seccomp: 2 (got ${String(field(f.out, 'seccomp'))})`, field(f.out, 'seccomp') === 2);
  } else if (backend === 'nitro') {
    const f = await c.probe('run-code', A, backend, 'limits', { mode: 'nitro' });
    c.rec.check('semget is refused on nitro', blocked(f.out, 'semget'));
  }
}

/** A probe's status or error, for the notes. */
const seen = (o: unknown): string => {
  const r = (o ?? {}) as { status?: number; error?: string };
  return r.status !== undefined ? String(r.status) : (r.error ?? 'none');
};

export async function noCredentials(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const { call, out } = await c.probe('run-code', A, backend, 'nocreds', {});
  c.rec.check(`the probe ran (${brief(call.result)})`, call.result?.exitCode === 0 && Object.keys(out).length > 0);
  c.rec.check('boto3 and environment credentials are absent', field(out, 'boto3_importable') === false && field(out, 'env_credentials') === false && field(out, 'credentials_file') === false);
  if (backend === 'agentcore') {
    c.rec.check('credentials load through the metadata service (C-2)', field(out, 'credentials_loaded') === true);
  } else {
    c.rec.check('no credentials are returned', field(out, 'credentials_loaded') === false);
    const role = (out.imds_role_path ?? {}) as { status?: number; error?: string };
    const withToken = (out.imds_role_path_with_token ?? {}) as { status?: number | null };
    if (backend === 'microvm') {
      c.rec.check(`the MicroVM metadata path iam/security-credentials/ gives 404, with or without the token flow (got ${seen(role)}, ${String(withToken.status)})`,
        (role.status === 404 || withToken.status === 404) && role.status !== 200 && withToken.status !== 200);
    } else {
      c.rec.check(`IMDS on nitro gives no connection within the script's timeout (got ${seen(role)})`, noConnection(role));
      c.rec.check(`the ECS credentials path gives 404 (got ${seen(out.ecs_credentials_path)})`, ((out.ecs_credentials_path ?? {}) as { status?: number }).status === 404);
    }
  }
  c.rec.check(`GetObject on B's invoice is ${backend === 'agentcore' ? 'refused with 403' : 'unreachable'} (got ${seen(out.get_object_b)})`, denied('s3', out.get_object_b, backend));
  c.rec.check(`GetItem on B's registry row is unreachable (got ${seen(out.get_row_b)})`, denied('dynamodb', out.get_row_b, backend));
}

/** What a failed check should show about a call: the exit status and the start of stderr (a probe prints no secret). */
export function brief(r: { exitCode: number; timedOut?: boolean; stderr?: string } | undefined): string {
  return r === undefined ? 'no result' : `exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}${r.stderr ? `, stderr: ${r.stderr.replace(/\s+/g, ' ').slice(0, 240)}` : ''}`;
}

export async function noEgress(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const bucket = c.out.OutsideBucket;
  const key = `integ/${c.runId}/${backend}`;
  // Presigned with a role that may put under integ/ in the outside bucket and nothing else, not with the driver's own session.
  const assumed = await c.aws.sts.send(new AssumeRoleCommand({ RoleArn: c.out.PresignRoleArn, RoleSessionName: 'rc-integ-presign', DurationSeconds: 900 }));
  const cr = assumed.Credentials;
  const creds = { accessKeyId: cr?.AccessKeyId ?? '', secretAccessKey: cr?.SecretAccessKey ?? '', sessionToken: cr?.SessionToken };
  const presigned = presignUrl({
    method: 'PUT', url: `https://${bucket}.s3.${c.aws.region}.amazonaws.com/${key}`, region: c.aws.region, service: 's3', credentials: creds, expiresSeconds: 600,
  });
  const direct = await fetch(presigned, { method: 'PUT', body: 'x' });
  c.rec.check(`the presigned URL works from outside the sandbox (control; got ${direct.status})`, direct.status === 200);
  const rowB = await c.aws.row(c.output('run-code', 'Table'), B, backend);
  // B's sandbox address: a task's private IP (TCP) or a MicroVM's endpoint (HTTPS). AgentCore has none to aim at.
  const peer: Record<string, unknown> = {};
  if (backend === 'nitro' && typeof rowB?.address === 'string') Object.assign(peer, { peer_ip: rowB.address, peer_port: 8443 });
  if (backend === 'microvm' && typeof rowB?.address === 'string') {
    const url = rowB.address.startsWith('http') ? rowB.address : `https://${rowB.address}/`;
    // The TCP connect is probed too: a TLS error after a completed connect is a failure of the step (spec §8).
    Object.assign(peer, { peer_url: url, peer_ip: new URL(url).hostname, peer_port: 443 });
  }
  const { call, out } = await c.probe('run-code', A, backend, 'noegress', { presigned, public_ip: '1.1.1.1', ...peer });
  c.rec.check(`the probe ran (${brief(call.result)})`, call.result?.exitCode === 0 && Object.keys(out).length > 0);
  c.rec.check(`the positive control: the same request code gets a status from the sandbox's own allowed address within the deadline (got ${seen(out.control)})`, controlAnswered(out.control));
  const names = ['https_name', 'tcp_public_ip', 'put_presigned', ...(peer.peer_ip ? ['tcp_peer'] : []), ...(peer.peer_url ? ['https_peer'] : [])];
  for (const n of names) {
    const r = (out[n] ?? {}) as { outcome?: string | number; error?: string; ms?: number };
    const what = n === 'put_presigned' && backend === 'agentcore' ? 'reaches S3 and is refused with 403 by the endpoint policy' : 'fails before a connection is made';
    c.rec.check(`${n} ${what} (got ${r.error ?? String(r.outcome)})`, egressFailed(n, r, backend));
    const done = n === 'put_presigned' && backend === 'agentcore' ? 'answers' : 'fails';
    // A lookup of up to 5 s, then 2 s per address tried, at most four (test/integ/hostile/_lib.py), plus a second.
    c.rec.check(`${n} ${done} within ${PROBE_BOUND_MS / 1000} s (took ${String(r.ms)} ms)`, typeof r.ms === 'number' && r.ms <= PROBE_BOUND_MS);
  }
  c.rec.check('the IP-literal TCP connect did not complete', ((out.tcp_public_ip ?? {}) as { outcome?: string }).outcome !== 'connected');
  // The hostile "one bad script": reads B's invoice and row, posts what it has out, then runs past the time cap.
  const bad = await c.probe('run-code', A, backend, 'hostile_one_bad', { presigned });
  const reads = [['read_invoice_b', 's3'], ['read_row_b', 'dynamodb'], ['post_internet', 'internet'], ['post_presigned', 's3']] as const;
  c.rec.check('the hostile job ran and reported', Object.keys(bad.out).length > 0);
  for (const [n, target] of reads) {
    c.rec.check(`the hostile job's ${n} is denied (got ${seen(bad.out[n])})`, denied(target, bad.out[n], backend));
  }
  c.rec.check('the hostile job leaked nothing', field(bad.out, 'leaked') === false);
  c.rec.check(`the time cap kills the hostile job (timedOut ${String(bad.call.result?.timedOut)})`, bad.call.result?.timedOut === true);
}

interface Called { step: string; r: CallResult }

export async function runaway(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const table = c.output('run-code', 'Table');
  const since = Date.now() - 5_000;
  const run = async (mode: string, extra: Record<string, unknown> = {}): Promise<Called & { out: Record<string, unknown> }> => {
    const p = await c.probe('run-code', A, backend, 'runaway', { mode, ...extra });
    return { step: mode, r: p.call, out: p.out };
  };
  const live = (x: Called): boolean => x.r.result !== undefined;

  const loop = await run('loop');
  // The runner that serves this step: read after its first call, because A's session may have idled out since the
  // last step, and the first call then starts a new one.
  const row0 = await c.aws.row(table, A, backend);
  let bootId0 = row0?.bootId;
  c.rec.check(`a loop returns timedOut (got ${String(loop.r.result?.timedOut)}, exit ${String(loop.r.result?.exitCode)})`, loop.r.result?.timedOut === true || (loop.r.result?.exitCode ?? 0) !== 0);

  const spawn = await run('setsid_spawn');
  c.rec.check('a setsid child is started', live(spawn) && spawn.r.result?.exitCode === 0);
  const chk = await run('setsid_check');
  c.rec.check(`the setsid child did not survive into the next call (alive ${String(field(chk.out, 'child_alive'))})`, field(chk.out, 'child_alive') === false);
  c.rec.check(`no other process of the job's user survives (found ${JSON.stringify(field(chk.out, 'other_processes'))})`, JSON.stringify(field(chk.out, 'other_processes')) === '[]');

  const kill = await run('kill_pid1');
  c.rec.check('a kill of PID 1 and of the runner is refused', attempt(kill.out, 'kill_pid1').ok === false && attempt(kill.out, 'kill_runner').ok === false);

  const disk = await run('disk_fill');
  c.rec.check(`a file past the file-size limit is refused (got ${String(field(disk.out, 'fsize_errno'))})`, field(disk.out, 'fsize_errno') === 'EFBIG');
  c.rec.check(`a disk fill ends by a full disk or the time cap, and the call returns (stopped by ${String(field(disk.out, 'stopped_by'))}, timedOut ${String(disk.r.result?.timedOut)})`,
    live(disk) && (['ENOSPC', 'EDQUOT'].includes(String(field(disk.out, 'stopped_by'))) || disk.r.result?.timedOut === true || (disk.r.result?.exitCode ?? 0) !== 0));
  const clean = await run('disk_clean');
  c.rec.check(`the next call works and removes what the fill left (removed ${String(field(clean.out, 'removed'))}, left ${String(field(clean.out, 'left'))})`, live(clean) && clean.r.result?.exitCode === 0 && field(clean.out, 'left') === 0);

  const mem = await run('mem_children');
  const m = mem.r.result;
  if (backend === 'microvm') {
    c.rec.check(`on microvm the memory fill exits non-zero with MemoryError in stderr (exit ${String(m?.exitCode)})`, (m?.exitCode ?? 0) !== 0 && /MemoryError/.test(m?.stderr ?? ''));
    const forked = /forked (\d+) of (\d+) errno (\w+)/.exec(m?.stderr ?? '');
    c.rec.check(`the job plus N-1 children fill the process limit (forked ${forked?.[1]} of ${forked?.[2]})`, forked !== null && Number(forked[1]) === Number(forked[2]) - 1);
    c.rec.check(`the N-th fork fails with EAGAIN (got ${String(forked?.[3])})`, forked?.[3] === 'EAGAIN');
    c.rec.check('the 60 % budget keeps the free-memory floor silent: memoryExceeded and timedOut are false', m?.memoryExceeded === false && m?.timedOut === false);
  } else {
    c.rec.check(`on ${backend} the memory fill returns memoryExceeded (got ${String(m?.memoryExceeded)}, timedOut ${String(m?.timedOut)})`, m?.memoryExceeded === true || m?.timedOut === true);
    if (backend === 'agentcore' || m?.memoryExceeded === true) {
      c.rec.check(`on ${backend} the total memory cap fires: memoryExceeded`, m?.memoryExceeded === true);
    } else {
      // nitro, T-89: a fill by every process slot can stall the runner past runTimeout + 5 s. The tool then stops the
      // tenant's task (overrun) and the next call starts a fresh one. That is the only other outcome that passes.
      const oldTask = String(row0?.handle ?? '').split('/').pop() ?? '';
      const lines = /^[0-9a-f]{32}$/.test(oldTask)
        ? await logEvidence(c, () => runnerGroups(c, 'run-code', backend), since, `@logStream like /${oldTask}/`)
        : [];
      c.rec.note(`nitro memory fill overran; the stopped task's runner lines: ${lines.join(' | ') || 'none'}`);
      const fresh = await run('setsid_spawn');
      const row1 = await c.aws.row(table, A, backend);
      c.rec.check(`on nitro a fill without memoryExceeded is a tool overrun: exit -9 and timedOut, then a fresh task with a new bootId (exit ${String(m?.exitCode)}, next sandbox ${String(fresh.r.result?.sandbox)}, bootId ${String(bootId0).slice(0, 8)} then ${String(row1?.bootId).slice(0, 8)})`,
        m?.timedOut === true && m?.exitCode === -9 && fresh.r.result?.sandbox === 'started' && fresh.r.result?.exitCode === 0
          && row1?.bootId !== undefined && row1.bootId !== bootId0 && row1.handle !== row0?.handle);
      // The later checks compare against the runner that now serves A.
      bootId0 = row1?.bootId;
    }
  }

  const over = await run('over_as');
  c.rec.check(`one process past its own address-space limit gets MemoryError and memoryExceeded false (got ${String(over.r.result?.memoryExceeded)})`,
    over.r.result?.memoryExceeded === false && /MemoryError/.test(over.r.result?.stderr ?? ''));

  if (backend === 'nitro') {
    const files = await run('files', { mib: 900 });
    c.rec.check(`on nitro a job that writes 900 MiB of files is not killed (exit ${String(files.r.result?.exitCode)}, exceeded ${String(files.r.result?.memoryExceeded)})`,
      files.r.result?.exitCode === 0 && files.r.result?.memoryExceeded === false && files.r.result?.timedOut === false);
  }
  if (backend === 'microvm') {
    const threads = await run('threads');
    c.rec.check(`on microvm four threads that each allocate 32 MiB complete (exit ${String(threads.r.result?.exitCode)})`, threads.r.result?.exitCode === 0 && field(threads.out, 'held_mib') === 128);
  }
  if (backend !== 'microvm') {
    const fill = await run('memfd_fill');
    c.rec.check(`a memfd fill at 1.5 times the cap returns memoryExceeded on ${backend} (target ${String(field(fill.out, 'target_mib'))} MiB)`, fill.r.result?.memoryExceeded === true);
    const next = await run('setsid_check');
    c.rec.check(`the next call works on the same sandbox after the memfd kill (sandbox ${String(next.r.result?.sandbox)}, ${brief(next.r.result)})`, next.r.result?.exitCode === 0 && next.r.result?.sandbox === 'reused');
  }
  if (backend === 'agentcore') {
    const create = await run('sysv_create');
    c.rec.check('a SysV semaphore array is created on agentcore', typeof field(create.out, 'semid') === 'number' && (field<number>(create.out, 'semid') ?? -1) >= 0);
    const gone = await run('sysv_check');
    c.rec.check(`the semaphore array is gone at the next call (still there ${String(field(gone.out, 'still_there'))})`, field(gone.out, 'still_there') === false);
  }

  // No zombies: the count a job can fork is the same before and after a killed job that held every slot.
  const base = await run('fork_count');
  const limit = field<number>(base.out, 'nproc_limit');
  c.rec.check(`the N-th fork fails with EAGAIN (got ${String(field(base.out, 'fork_failed_errno'))})`, field(base.out, 'fork_failed_errno') === 'EAGAIN');
  c.rec.check(`a job forks N-1 children (forked ${String(field(base.out, 'forked'))} of ${String(limit)})`, limit !== undefined && field(base.out, 'forked') === limit - 1);
  const hold = await run('fork_hold');
  c.rec.check(`a job that holds every process slot is killed by the time cap (timedOut ${String(hold.r.result?.timedOut)})`, hold.r.result?.timedOut === true || (hold.r.result?.exitCode ?? 0) !== 0);
  const after = await run('fork_count');
  c.rec.check(`after that kill the next job forks N-1 children again (forked ${String(field(after.out, 'forked'))})`, field(after.out, 'forked') === field(base.out, 'forked'));

  const end = await c.aws.row(table, A, backend);
  c.rec.check(`the runner that answers is the same: the registry bootId did not change (${String(bootId0).slice(0, 8)} then ${String(end?.bootId).slice(0, 8)})`, end?.bootId === bootId0);
  if (end?.bootId !== bootId0) {
    // Why the runner restarted (a dirty job group, a sweep past the post-job budget, a platform stop), read now:
    // the teardown deletes the runtime's groups.
    // The runner's plain-text lines other than the per-job ones, so the restart cause is not pushed out.
    const lines = await logEvidence(c, () => runnerGroups(c, 'run-code', backend), since, '@message not like /job_done/');
    c.rec.note(`runner lines: ${lines.join(' | ') || 'none'}`);
  }
  const fin = await c.probe('run-code', A, backend, 'parse', {}, { input: 'invoice.csv' });
  c.rec.check(`A's next call works, on the same sandbox (sandbox ${String(fin.call.result?.sandbox)})`, fin.call.result?.exitCode === 0 && fin.call.result?.sandbox === 'reused');
}

export async function sessionFiles(c: Ctx): Promise<void> {
  const value = `note-${c.runId}`;
  const bucketKey = { tenant: B };
  const wb = await c.probe('run-code-files', B, 'agentcore', 'session_files', { ...bucketKey, mode: 'write', value: `${value}-b` });
  c.rec.check('B writes its own session note', ((wb.out.put ?? {}) as { v?: number }).v === 200);
  const wa = await c.probe('run-code-files', A, 'agentcore', 'session_files', { tenant: A, mode: 'write', value });
  c.rec.check(`A writes its own session note (got ${String(((wa.out.put ?? {}) as { v?: number }).v)})`, ((wa.out.put ?? {}) as { v?: number }).v === 200);
  const ra = await c.probe('run-code-files', A, 'agentcore', 'session_files', { tenant: A, mode: 'read', value });
  const g = (ra.out.get ?? {}) as { v?: { status?: number; match?: boolean } };
  c.rec.check('A reads its own session note back', g.v?.status === 200 && g.v?.match === true);
  const da = await c.probe('run-code-files', A, 'agentcore', 'session_files', { tenant: A, other: B, mode: 'deny' });
  const d = (da.out.get_other ?? {}) as { ok?: boolean; v?: number };
  c.rec.check(`GetObject on B's session prefix is denied (got ${String(d.v)})`, d.ok === false || (d.v !== undefined && d.v >= 400));
}

const isPrivate = (ip: string | null | undefined): boolean => ip !== null && ip !== undefined && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** Unique names of this run's lookups per backend, kept for dns-platform. */
export async function dns(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const instance = u.instance ?? 'run-code';
  const region = c.aws.region;
  const token = `rc${randomBytes(6).toString('hex')}${backend[0]}`;
  const exfil = randomBytes(20).toString('hex');
  const names = [
    { label: 'example', name: 'example.com', type: 1 },
    { label: 'unique', name: `${token}.example.com`, type: 1 },
    { label: 'exfil', name: `${exfil}.example.com`, type: 1 },
    { label: 'txt', name: `txt-${token}.example.com`, type: 16 },
    { label: 'logs', name: `logs.${region}.amazonaws.com`, type: 1 },
  ];
  for (const n of names.slice(0, 4)) c.lookedUpNames.add(n.name);
  const started = Date.now();
  const { call, out } = await c.probe(instance, A, backend, 'dns', { names });
  c.rec.check(`the probe ran (${brief(call.result)})`, call.result?.exitCode === 0 && Object.keys(out).length > 0);
  const rc = (label: string): number | undefined => ((attempt(out, label).v ?? {}) as { rcode?: number }).rcode;
  const addr = (label: string): string | null | undefined => ((attempt(out, label).v ?? {}) as { address?: string | null }).address;
  if (instance === 'run-code') {
    for (const l of ['example', 'unique', 'exfil', 'txt']) c.rec.check(`${l} lookup returns NXDOMAIN with the firewall on (got ${String(rc(l))})`, rc(l) === 3);
    c.rec.check(`logs.${region}.amazonaws.com resolves to an endpoint address (got ${String(rc('logs'))})`, rc('logs') === 0 && isPrivate(addr('logs')));
    const group = c.out.QueryLogGroup;
    if (group) {
      const wanted = [names[0].name, names[1].name, names[2].name, names[3].name];
      const list = wanted.flatMap((n) => [`"${n}"`, `"${n}."`]).join(', ');
      const query = `fields query_name, srcaddr, firewall_rule_action | filter firewall_rule_action = "BLOCK" and query_name in [${list}] | limit 1000`;
      // The query log is about a minute behind: poll until all four names are there (not until some rows are), for up to 5 minutes.
      let rows: Array<Record<string, string>> = [];
      const seenNames = (): Set<string> => new Set(rows.map((r) => r.query_name.replace(/\.$/, '').toLowerCase()));
      for (const end = Date.now() + 300_000; ;) {
        rows = await insights(c, [group], query, started - 5000, 0, 1000);
        if (wanted.every((n) => seenNames().has(n)) || Date.now() > end) break;
        await sleep(15_000);
      }
      const blockedNames = seenNames();
      for (const n of wanted) c.rec.check(`${n === 'example.com' ? 'example.com' : n.split('.')[0].replace(/[0-9a-f]{12,}/, '<token>')} appears in the query log as BLOCK`, blockedNames.has(n));
      if (backend === 'nitro') {
        const row = await c.aws.row(c.output('run-code', 'Table'), A, 'nitro');
        c.rec.check('on nitro the BLOCK line\'s srcaddr is A\'s task address', rows.some((r) => r.srcaddr === row?.address));
      }
    } else {
      c.rec.check('the stack publishes the query log group', false);
    }
  } else {
    c.rec.check(`with the firewall off, example.com resolves to a public address (rcode ${String(rc('example'))})`, rc('example') === 0 && addr('example') !== null && addr('example') !== undefined && !isPrivate(addr('example')));
  }
}

/** Query-log names that are the platform's own and stay blocked on purpose (spec §3.9). */
const NTP_ZONE = /\.amazon\.pool\.ntp\.org\.?$/;

/** The reverse name of a dotted IPv4 address (`10.0.1.2` is `2.1.0.10.in-addr.arpa`), or undefined for anything else (an octet is 0 to 255, no leading zero). */
export function reverseName(address: string | undefined): string | undefined {
  const parts = (address ?? '').split('.');
  const octet = (p: string): boolean => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255;
  return parts.length === 4 && parts.every(octet) ? `${parts.reverse().join('.')}.in-addr.arpa` : undefined;
}

/**
 * The blocked names of a query log that no test script looked up and that the platform has no standing to look up (spec §3.9):
 * the NTP zone stays blocked on purpose, and so does a PTR query for the reverse name of the querying address itself (the
 * sandbox's own address; on agentcore, the shared runtime address). A PTR for any other address, any other query type and any
 * other name still counts. The firewall is unchanged; only this check ignores those. Each name is listed once. Pure.
 */
export function unexpectedBlocked(
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
  lookedUp: ReadonlySet<string>,
): string[] {
  const named = (r: Readonly<Record<string, string>>): string => r.query_name.replace(/\.$/, '').toLowerCase();
  const unexpected = rows
    .filter((r) => !(r.query_type === 'PTR' && reverseName(r.srcaddr) === named(r)))
    .map(named)
    .filter((n) => !lookedUp.has(n) && !NTP_ZONE.test(n));
  return [...new Set(unexpected)];
}

export async function dnsPlatform(c: Ctx): Promise<void> {
  const group = c.out.QueryLogGroup;
  if (!group) {
    c.rec.check('the stack publishes the query log group', false);
    return;
  }
  await sleep(1000);
  const rows = await insights(c, [group], 'filter firewall_rule_action = "BLOCK" | stats count() as n by query_name, query_type, srcaddr | limit 1000', Date.now() - 6 * 3_600_000);
  const unexpected = unexpectedBlocked(rows, c.lookedUpNames);
  c.rec.check(`every blocked name is one a test script looked up, the NTP zone, or a sandbox's PTR for its own address (unexpected: ${unexpected.slice(0, 5).join(', ') || 'none'})`, unexpected.length === 0);
}

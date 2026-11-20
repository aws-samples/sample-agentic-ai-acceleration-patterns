// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `microvm` backend: Lambda MicroVMs (spec §3.3, §3.4, ADR-0040 to ADR-0044).
 *
 * Runs inside the tool, reaper, drain and offboard functions. It starts,
 * probes, calls, lists and ends MicroVMs of the sample's one image, with the
 * calling function's own role (the MicroVM actions take no tenant condition
 * key, S-3, so the tenant filter is code: ADR-0040). It never reads or writes
 * the registry; the caller does, with its own version condition (ADR-0025).
 */

import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import type { GetMicrovmCommandOutput } from '@aws-sdk/client-lambda-microvms';
import type {
  ReadyResult, RegistryRow, RunJob, RunOutcome, SandboxBackend, SandboxHandle, SandboxSummary, StartOptions,
  StopFacts, TenantCredentials,
} from '../backend';
import { NO_ANSWER_MARGIN_MS } from '../backend';
import { BACKEND_ENV, ENV, TEST_HOOK_ENV, TEST_HOOK_FIELDS } from '../env';
import type { Refusal, RefusalCode, RunHookPayload, RunResult } from '../protocol';
import {
  PROTOCOL_VERSION, RUNNER_PORTS, TENANT_ID_PATTERN, nonceHash, proofMatches, resultProof, startToken,
} from '../protocol';

/** Start cap in ms (spec §3.4: measured P90 2.8 s). */
export const MICROVM_START_CAP_MS = 20_000;

/** The platform ends a MicroVM this long after it suspends (spec §3.4 Start; `suspendedDurationSeconds`). */
export const SUSPENDED_DURATION_SECONDS = 1800;

/** Auth tokens last five minutes and allow port 8080 only (spec §3.4 Address). */
export const AUTH_TOKEN_MINUTES = 5;

/** Most the platform allows for `maximumDurationInSeconds` (8 h). */
const MAX_DURATION_SECONDS = 28_800;

/** `runHookPayload` is capped at 4096 characters (spec §3.4, S-4); the SDK documents a larger limit. */
const RUN_HOOK_PAYLOAD_MAX = 4096;

/** One `/ping` probe waits this long, a suspended MicroVM's auto-resume (0.6 s, S-4) included. */
const PING_TIMEOUT_MS = 5000;

/** The auth token header (platform contract). */
const AUTH_HEADER = 'X-aws-proxy-auth';

const BOOT_ID = /^[0-9a-f]{32}$/;
const REFUSALS: readonly RefusalCode[] = ['wrong_sandbox', 'busy', 'dirty', 'tool_failed'];

/** `arn:<partition>:lambda:<region>:<account>:microvm-image:<name>`. */
const IMAGE_ARN = /^(arn:[a-z-]+):lambda:([a-z0-9-]+):(\d{12}):microvm-image:[A-Za-z0-9_-]{1,64}$/;

/** An account-owned network connector, versioned or not. The platform-managed ones carry the account `aws`. */
const OWN_CONNECTOR_ARN = /^(arn:[a-z-]+):lambda:([a-z0-9-]+):(\d{12}):network-connector:[A-Za-z0-9_-]+(:\d+)?$/;

/**
 * A MicroVM endpoint is `<id>.lambda-microvm.<region>.on.aws` (see https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html).
 * Other accounts hold names under `on.aws` too (Lambda function URLs), so the whole form is required, not the suffix.
 * shortcut: this is the commercial partitions' domain; another partition's differs (China is reported as `.on.amazonwebservices.com.cn`,
 * unverified), so a start there fails and ends its MicroVM; widen the form with a spike result.
 */
const ENDPOINT_HOST = /^[a-z0-9-]+\.lambda-microvm\.([a-z0-9-]+)\.on\.aws$/;

/** Connection failures that happen before the request is sent. */
const NOT_SENT: readonly string[] = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'];

/** A MicroVM that ended this long before the request left cannot have run the job; the margin covers clock skew with the platform. */
const TERMINATED_BEFORE_CALL_MS = 2000;

/** The state lookup behind a no-answer must not hold the call past the tool's own deadline. */
const NO_ANSWER_LOOKUP_MS = 3000;

/** States in which a MicroVM is gone or going. */
const ENDED_STATES: readonly string[] = ['TERMINATING', 'TERMINATED'];

/** Why a start failed, for the tool line and for a vendor reading the log. */
export type MicrovmStartFailure = 'quota' | 'throttled' | 'capacity' | 'failed';

export class MicrovmStartError extends Error {
  public constructor(public readonly failure: MicrovmStartFailure, message: string) {
    super(message);
    this.name = 'MicrovmStartError';
  }
}

/** The platform-managed ingress connector for HTTP, built from the image ARN's partition and Region. */
export function httpIngressConnectorArn(imageArn: string): string {
  const m = IMAGE_ARN.exec(imageArn);
  if (!m) throw new Error(`${BACKEND_ENV.MICROVM_IMAGE_ARN} is not a MicroVM image ARN`);
  return `${m[1]}:lambda:${m[2]}:aws:network-connector:aws-network-connector:HTTP_INGRESS`;
}

/** Test seams: a client and a `fetch`. */
export interface MicrovmDeps {
  readonly client?: LambdaMicrovmsClient;
  readonly fetch?: typeof fetch;
}

interface Settings {
  readonly imageArn: string;
  readonly connectorArn: string;
  readonly ingressArn: string;
  readonly maxLifeSeconds: number;
  readonly idleSeconds: number;
}

function errorName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
}

function isNotFound(e: unknown): boolean {
  return errorName(e) === 'ResourceNotFoundException';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Normalise an endpoint to an `https://host` origin on the platform's endpoint domain, in `region` when it is given; refuse
 * anything else. The token and the job go only to such an origin.
 */
export function endpointOrigin(endpoint: string, region?: string): string {
  const url = new URL(/^[a-z]+:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/?$/.test(url.pathname)) {
    throw new Error('MicroVM endpoint is not an https origin');
  }
  const host = ENDPOINT_HOST.exec(url.hostname);
  if (!host || (region !== undefined && host[1] !== region)) throw new Error('MicroVM endpoint is not on the platform endpoint domain');
  return url.origin;
}

function validOrigin(address: string | undefined, region?: string): string | undefined {
  if (address === undefined) return undefined;
  try {
    return endpointOrigin(address, region);
  } catch {
    return undefined;
  }
}

function toMs(d: Date | undefined): number | undefined {
  return d ? d.getTime() : undefined;
}

export class MicrovmBackend implements SandboxBackend {
  public readonly name = 'microvm' as const;
  public readonly startCapMs = MICROVM_START_CAP_MS;
  private readonly client: LambdaMicrovmsClient;
  private readonly fetchFn: typeof fetch;

  /** Reads its settings from the function environment the construct sets (`BackendConstruct.environment`, ADR-0025). */
  public constructor(public readonly env: Readonly<Record<string, string | undefined>> = process.env, deps: MicrovmDeps = {}) {
    this.client = deps.client ?? new LambdaMicrovmsClient({});
    this.fetchFn = deps.fetch ?? fetch;
  }

  /** The Region of the image; endpoints must be in it. Throws when the image is not configured, so the Region match never turns off. */
  private region(): string {
    const image = IMAGE_ARN.exec(this.imageArn());
    if (!image) throw new Error(`microvm backend: ${BACKEND_ENV.MICROVM_IMAGE_ARN} is not a MicroVM image ARN`);
    return image[2];
  }

  /** The image every list and start names. */
  private imageArn(): string {
    const imageArn = this.env[BACKEND_ENV.MICROVM_IMAGE_ARN];
    if (!imageArn) throw new Error(`microvm backend: ${BACKEND_ENV.MICROVM_IMAGE_ARN} is not set`);
    return imageArn;
  }

  /**
   * Settings for a start. A start without the sample's own
   * connector is refused here, because a MicroVM run without an egress
   * connector gets the Lambda-managed internet egress (S-2). IAM refuses
   * the same start a second time (`lambda:PassNetworkConnector`, ADR-0041).
   */
  private settings(): Settings {
    const imageArn = this.imageArn();
    const connectorArn = this.env[BACKEND_ENV.MICROVM_NETWORK_CONNECTOR_ARN];
    if (!connectorArn) {
      throw new Error(`microvm backend: ${BACKEND_ENV.MICROVM_NETWORK_CONNECTOR_ARN} is not set; a start without the sample's connector is refused`);
    }
    const image = IMAGE_ARN.exec(imageArn);
    if (!image) throw new Error(`microvm backend: ${BACKEND_ENV.MICROVM_IMAGE_ARN} is not a MicroVM image ARN`);
    const own = OWN_CONNECTOR_ARN.exec(connectorArn);
    if (!own || own[1] !== image[1] || own[2] !== image[2] || own[3] !== image[3]) {
      throw new Error(`microvm backend: ${BACKEND_ENV.MICROVM_NETWORK_CONNECTOR_ARN} is not a network connector of the image's partition, account and Region; a start without the sample's connector is refused`);
    }
    const positiveMs = (name: string): number => {
      const ms = Number(this.env[name]);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`microvm backend: ${name} is not set to a positive number of milliseconds`);
      return ms;
    };
    return {
      imageArn,
      connectorArn,
      ingressArn: httpIngressConnectorArn(imageArn),
      maxLifeSeconds: Math.min(MAX_DURATION_SECONDS, Math.floor(positiveMs(ENV.SANDBOX_MAX_LIFE_MS) / 1000)),
      idleSeconds: Math.ceil(positiveMs(ENV.SANDBOX_IDLE_MS) / 1000),
    };
  }

  public async start(tenantId: string, nonce: string, creds: TenantCredentials, options: StartOptions = {}): Promise<SandboxHandle> {
    if (!TENANT_ID_PATTERN.test(tenantId)) throw new Error('microvm backend: tenant id is not valid');
    if (creds.tenantId !== tenantId) throw new Error('microvm backend: credentials of another tenant');
    const s = this.settings();
    // Only the hash travels in the start call; CloudTrail and GetMicrovm never see the nonce (ADR-0018).
    // Test hook of the integration test (spec §8 `failed-start`, runner/PROTOCOL.md): sent only when the tool asks and this function
    // honours the hooks (`RC_INTEG_OVERRIDES` = `1`), so a production deployment never sends it.
    const failAtBoot = options.failAtBoot === true && this.env[TEST_HOOK_ENV.RC_INTEG_OVERRIDES] === '1';
    const payload: RunHookPayload & { readonly [TEST_HOOK_FIELDS.RUN_HOOK_FAIL_AT_BOOT]?: true } = {
      nonceHash: nonceHash(nonce),
      tenant: tenantId,
      ...(failAtBoot ? { [TEST_HOOK_FIELDS.RUN_HOOK_FAIL_AT_BOOT]: true as const } : {}),
    };
    const runHookPayload = JSON.stringify(payload);
    if (runHookPayload.length > RUN_HOOK_PAYLOAD_MAX) throw new Error('microvm backend: run hook payload is too long');
    let out;
    try {
      out = await this.client.send(new RunMicrovmCommand({
        imageIdentifier: s.imageArn,
        // The sample's connector only; an omitted connector would get INTERNET_EGRESS (S-2).
        egressNetworkConnectors: [s.connectorArn],
        ingressNetworkConnectors: [s.ingressArn],
        maximumDurationInSeconds: s.maxLifeSeconds,
        idlePolicy: {
          autoResumeEnabled: true,
          maxIdleDurationSeconds: s.idleSeconds,
          suspendedDurationSeconds: SUSPENDED_DURATION_SECONDS,
        },
        logging: { disabled: {} },
        runHookPayload,
        // No executionRoleArn: the code holds no credentials (C-2).
        clientToken: startToken(nonce),
      }));
    } catch (e) {
      throw startError(e);
    }
    if (!out.microvmId) throw new Error('microvm backend: RunMicrovm returned no id');
    let address: string | undefined;
    try {
      if (out.endpoint) address = endpointOrigin(out.endpoint, this.region());
    } catch {
      address = undefined;
    }
    if (address === undefined) {
      // The MicroVM exists but cannot be called safely; end it so it does not run until its limits.
      let ended = true;
      await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: out.microvmId })).catch(() => { ended = false; });
      throw new Error(ended
        ? `microvm backend: RunMicrovm returned no usable MicroVM endpoint; MicroVM ${out.microvmId} was terminated`
        : `microvm backend: RunMicrovm returned no usable MicroVM endpoint; terminating MicroVM ${out.microvmId} failed, so the reaper must end it`);
    }
    return { backend: 'microvm', tenantId, handle: out.microvmId, address, nonce };
  }

  public async ready(handle: SandboxHandle, row: RegistryRow): Promise<ReadyResult> {
    let info: GetMicrovmCommandOutput;
    try {
      info = await this.get(handle.handle);
    } catch (e) {
      if (isNotFound(e)) return { state: 'ended', reason: 'not_found' };
      throw e;
    }
    if (info.state && ENDED_STATES.includes(info.state)) {
      return { state: 'ended', reason: info.stateReason ?? info.state.toLowerCase() };
    }
    const address = info.endpoint ? endpointOrigin(info.endpoint, this.region()) : validOrigin(handle.address ?? row.address, this.region());
    const learnt = address !== undefined && address !== row.address ? { address } : {};
    // PENDING: the platform is still provisioning. Every other live state is probed; a suspended MicroVM auto-resumes on the request.
    if (info.state === 'PENDING' || address === undefined) return { state: 'starting', patch: learnt };
    let bootId: string | undefined;
    try {
      bootId = await this.ping(handle.handle, address);
    } catch (e) {
      // The MicroVM may have ended between the lookup and the token request, as in `run`.
      if (isNotFound(e) || !(await this.isAlive(handle))) return { state: 'ended', reason: 'not_found' };
      throw e;
    }
    return bootId === undefined ? { state: 'starting', patch: learnt } : { state: 'ready', patch: { ...learnt, bootId } };
  }

  /** One `/ping`. The bootId when the runner answered healthy with one (it has none until the `/run` hook ran), else undefined. */
  private async ping(microvmId: string, address: string): Promise<string | undefined> {
    const token = await this.authToken(microvmId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`${address}/ping`, {
        method: 'GET',
        headers: { [AUTH_HEADER]: token },
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const body: unknown = JSON.parse(await res.text());
      return isRecord(body) && body.status === 'Healthy' && typeof body.bootId === 'string' && BOOT_ID.test(body.bootId)
        ? body.bootId
        : undefined;
    } catch {
      // Not answering yet (refused, timed out, not JSON): still starting. The start cap ends a start that never answers.
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  public async run(handle: SandboxHandle, job: RunJob): Promise<RunOutcome> {
    // The nonce and the tenant of the call must be the handle's own (C-1); a mismatch is a tool defect, not a dead handle.
    if (job.nonce !== handle.nonce || job.tenantId !== handle.tenantId) {
      throw new Error('microvm backend: job does not belong to the handle');
    }
    let address = validOrigin(handle.address, this.region());
    if (handle.address !== undefined && address === undefined) return { kind: 'dead', reason: 'bad_address' };
    if (address === undefined) {
      try {
        const info = await this.get(handle.handle);
        if ((info.state && ENDED_STATES.includes(info.state)) || !info.endpoint) {
          return { kind: 'dead', reason: info.stateReason ?? 'not_running' };
        }
        address = endpointOrigin(info.endpoint, this.region());
      } catch (e) {
        if (isNotFound(e)) return { kind: 'dead', reason: 'not_found' };
        throw e;
      }
    }
    let token: string;
    try {
      token = await this.authToken(handle.handle);
    } catch (e) {
      if (isNotFound(e) || !(await this.isAlive(handle))) return { kind: 'dead', reason: 'not_found' };
      throw e;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), job.timeoutMs + NO_ANSWER_MARGIN_MS);
    const sentAt = Date.now();
    let status: number;
    let text: string;
    try {
      const res = await this.fetchFn(`${address}/run`, {
        method: 'POST',
        headers: { [AUTH_HEADER]: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(job),
        signal: controller.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      if (controller.signal.aborted) return await this.noAnswer(handle, sentAt);
      // Only a failure before the request left is a dead handle; after that the job may have run, and a rerun in a fresh MicroVM would run the tenant's code twice (ADR-0044).
      const code = errorCode(e);
      return NOT_SENT.includes(code) ? { kind: 'dead', reason: `connection_failed: ${code}` } : await this.noAnswer(handle, sentAt);
    } finally {
      clearTimeout(timer);
    }
    const outcome = interpret(status, text, job);
    return outcome.kind === 'no_answer' ? this.noAnswer(handle, sentAt) : outcome;
  }

  /**
   * No answer. The proxy answers 502 for a MicroVM that was terminated (smoke run), the same as for one that did not
   * respond. When the platform says the MicroVM was TERMINATED more than 2 s before the request left, the job cannot
   * have run: a dead handle. TERMINATING, a missing `terminatedAt`, a MicroVM that is still running and an unreadable
   * or slow answer all stay no answer, the safe one (ADR-0044).
   */
  private async noAnswer(handle: SandboxHandle, sentAt: number): Promise<RunOutcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const lookup = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('GetMicrovm took too long')), NO_ANSWER_LOOKUP_MS);
      });
      const info = await Promise.race([this.get(handle.handle), lookup]);
      const endedAt = toMs(info.terminatedAt);
      if (info.state === 'TERMINATED' && endedAt !== undefined && endedAt + TERMINATED_BEFORE_CALL_MS < sentAt) {
        return { kind: 'dead', reason: info.stateReason ?? 'terminated_before_call' };
      }
    } catch {
      // Unreadable or slow: keep no_answer.
    } finally {
      clearTimeout(timer);
    }
    return { kind: 'no_answer' };
  }

  public async stop(handle: SandboxHandle, _creds?: TenantCredentials): Promise<void> {
    try {
      await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: handle.handle }));
    } catch (e) {
      if (isNotFound(e)) return;
      // Already ending is a stop that worked (offboard and the reaper may race).
      if (/Conflict/.test(errorName(e)) && !(await this.isAlive(handle))) return;
      throw e;
    }
  }

  public async *list(): AsyncGenerator<SandboxSummary> {
    const imageArn = this.imageArn();
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(new ListMicrovmsCommand({ imageIdentifier: imageArn, nextToken }));
      for (const item of page.items ?? []) {
        if (!item.microvmId) continue;
        yield {
          backend: 'microvm',
          handle: item.microvmId,
          startedAt: toMs(item.startedAt),
          // Anything not TERMINATED can still bill, and an image with a MicroVM that is not TERMINATED yet cannot be deleted (spec §5.3).
          live: item.state !== 'TERMINATED',
        };
      }
      nextToken = page.nextToken;
    } while (nextToken);
  }

  public async isAlive(handle: SandboxHandle): Promise<boolean> {
    try {
      const info = await this.get(handle.handle);
      return !(info.state && ENDED_STATES.includes(info.state));
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  public async stopReason(handle: SandboxHandle): Promise<StopFacts> {
    try {
      const info = await this.get(handle.handle);
      return { startedAt: toMs(info.startedAt), stoppedAt: toMs(info.terminatedAt), reason: info.stateReason };
    } catch (e) {
      if (isNotFound(e)) return {};
      throw e;
    }
  }

  private get(microvmId: string): Promise<GetMicrovmCommandOutput> {
    return this.client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
  }

  /** A fresh token per call: port 8080 only, five minutes (spec §3.4 Address). The 9000 hook port is never reachable. */
  private async authToken(microvmId: string): Promise<string> {
    const out = await this.client.send(new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: AUTH_TOKEN_MINUTES,
      allowedPorts: [{ port: RUNNER_PORTS.http }],
    }));
    const token = out.authToken?.[AUTH_HEADER];
    if (!token) throw new Error('microvm backend: CreateMicrovmAuthToken returned no token');
    return token;
  }
}

function errorCode(e: unknown): string {
  const cause = isRecord(e) && isRecord(e.cause) ? e.cause : undefined;
  const code = cause?.code ?? (isRecord(e) ? e.code : undefined);
  return typeof code === 'string' ? code : 'error';
}

function startError(e: unknown): Error {
  switch (errorName(e)) {
    case 'ServiceQuotaExceededException': {
      const code = isRecord(e) && typeof e.quotaCode === 'string' ? ` (${e.quotaCode})` : '';
      return new MicrovmStartError('quota', `microvm backend: RunMicrovm refused, a Lambda MicroVMs quota is used up${code}; the memory quota is L-CD1C0CC4 (spec §6.1)`);
    }
    case 'ThrottlingException':
    case 'TooManyRequestsException':
      return new MicrovmStartError('throttled', 'microvm backend: RunMicrovm was throttled (5 calls per second per account)');
    case 'InsufficientCapacityException':
      return new MicrovmStartError('capacity', 'microvm backend: RunMicrovm found no capacity');
    default:
      return e instanceof Error ? e : new Error('microvm backend: RunMicrovm failed');
  }
}

/** Turn the data channel's answer into an outcome. A protocol body decides, never the status alone (PROTOCOL.md). */
function interpret(status: number, text: string, job: RunJob): RunOutcome {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!isRecord(body) || body.v !== PROTOCOL_VERSION) {
    // Not a runner answer: the proxy's own error. 502 is "application not responding, or auto-resume did not succeed": the job may have started, so it is no answer, not a dead handle (ADR-0044).
    if (status === 502) return { kind: 'no_answer' };
    throw new Error(`microvm backend: the data channel answered HTTP ${status} without a runner body`);
  }
  if (typeof body.error === 'string') {
    if (!REFUSALS.includes(body.error as RefusalCode)) return { kind: 'dead', reason: 'unknown_refusal' };
    const refusal: Refusal = {
      v: PROTOCOL_VERSION,
      error: body.error as RefusalCode,
      ...(typeof body.bootId === 'string' && BOOT_ID.test(body.bootId) ? { bootId: body.bootId } : {}),
    };
    return { kind: 'refused', refusal };
  }
  // A result that does not carry the nonce's proof did not come from the sandbox this handle names: a failed identity check (spec §3.4).
  if (!proofMatches(resultProof(job.nonce, job.runId), body.proof)) return { kind: 'dead', reason: 'identity_check_failed' };
  return { kind: 'result', result: parseResult(body, job) };
}

function parseResult(body: Record<string, unknown>, job: RunJob): RunResult {
  const bad = (field: string): never => {
    throw new Error(`microvm backend: runner result has a bad ${field}`);
  };
  if (body.runId !== job.runId) bad('runId');
  if (typeof body.exitCode !== 'number' || !Number.isInteger(body.exitCode)) bad('exitCode');
  if (typeof body.stdout !== 'string') bad('stdout');
  if (typeof body.stderr !== 'string') bad('stderr');
  if (typeof body.truncated !== 'boolean') bad('truncated');
  if (typeof body.durationMs !== 'number' || !(body.durationMs >= 0)) bad('durationMs');
  if (typeof body.timedOut !== 'boolean') bad('timedOut');
  if (typeof body.memoryExceeded !== 'boolean') bad('memoryExceeded');
  if (typeof body.bootId !== 'string' || !BOOT_ID.test(body.bootId)) bad('bootId');
  if (typeof body.proof !== 'string') bad('proof');
  return body as unknown as RunResult;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What every step shares: the clients, the recorder, the stack outputs, and
 * the calls (`run_code` through the gateway, through the standalone function,
 * the mint). Steps are `(ctx) => Promise<void>` and record their checks on
 * `ctx.rec`; a throw is recorded as a failed step by the runner.
 */

import { InvokeCommand } from '@aws-sdk/client-lambda';
import { callGateway, sleep, type Aws } from './aws';
import { type Backend, type Instance, TOOL_NAME, TOOL_TARGET, TOOLS_GATEWAY, INSTANCE_BACKENDS } from './common';
import { type Probe, probeCode } from './hostile';
import { type Recorder } from './record';
import { type Outcome, type RunResult, lastJsonLine } from './tool-result';

/** Output keys of the integration stack: `RunCode<Name>` and `RunCodeFiles<Name>` per instance. */
export function outputKey(instance: Instance, name: string): string {
  return `${instance === 'run-code' ? 'RunCode' : 'RunCodeFiles'}${name}`;
}

/** Per-backend outputs of the construct (image ARN, cluster ARN, runtime ARN): `<Instance>Backend<Backend><Key>`. */
export function backendOutputKey(instance: Instance, backend: Backend, key: string): string {
  const b = backend[0].toUpperCase() + backend.slice(1);
  return `${outputKey(instance, `Backend${b}`)}${key.replace(/[^A-Za-z0-9]/g, '')}`;
}

export interface CallArgs {
  readonly code: string;
  readonly input?: string;
  readonly backend?: Backend;
  readonly saveOutput?: boolean;
}

export interface CallResult {
  readonly outcome: Outcome;
  /** The result when there is one. */
  readonly result?: RunResult;
  /** Milliseconds from the first attempt to the final answer, retries included. */
  readonly ms: number;
  /** How many `sandbox_starting` answers came before the final one. */
  readonly starting: number;
  readonly status: number;
}

export interface CallOptions {
  /** Keep retrying `sandbox_starting` and `sandbox_busy` for this long (default: the backend's start cap plus a minute). */
  readonly retryMs?: number;
  /** Do not retry: return the first answer. */
  readonly once?: boolean;
}

/** Start caps of spec §3.4, in ms, for the retry bound. */
export const START_CAP_MS: Readonly<Record<Backend, number>> = { microvm: 20_000, nitro: 300_000, agentcore: 30_000 };

/** How long a minted token is handed out again (spec §8: the gateway refuses a token with 60 s or less left). */
export const TOKEN_REUSE_MS = 180_000;

export class Ctx {
  private readonly tokens = new Map<string, { token: string; at: number }>();
  /** Names the probes looked up that the DNS Firewall may log as BLOCK (dns-platform). */
  public readonly lookedUpNames = new Set<string>(['example.com']);
  /** Run ids of the calls the telemetry step checks, by backend. */
  public readonly parseRuns: Partial<Record<Backend, string>> = {};
  /** Every run id a gateway call returned, with its backend: the telemetry step checks one tool line for each. */
  public readonly runs: Array<{ instance: Instance; backend: Backend; runId: string }> = [];
  /** Set when the run is stopped: the next call throws, so no step starts a sandbox while the stack is deleted. */
  public aborted = false;
  private readonly revoked = new Set<string>();

  public constructor(
    public readonly aws: Aws,
    public readonly rec: Recorder,
    public readonly stack: string,
    public readonly out: Record<string, string>,
    public readonly runId: string,
  ) {}

  public output(instance: Instance, name: string): string {
    const v = this.out[outputKey(instance, name)];
    if (v === undefined || v === '') throw new Error(`stack output ${outputKey(instance, name)} is missing`);
    return v;
  }

  public optionalOutput(instance: Instance, name: string): string | undefined {
    return this.out[outputKey(instance, name)] || undefined;
  }

  public backendOutput(instance: Instance, backend: Backend, pattern: RegExp): string {
    const prefix = backendOutputKey(instance, backend, '');
    const keys = Object.keys(this.out).filter((k) => k.startsWith(prefix) && pattern.test(k.slice(prefix.length)));
    if (keys.length !== 1) throw new Error(`expected one stack output ${prefix}* matching ${pattern} (found ${keys.length})`);
    return this.out[keys[0]];
  }

  public enabled(instance: Instance, backend: Backend): boolean {
    return INSTANCE_BACKENDS[instance].includes(backend);
  }

  /** Stops minting for a tenant and drops its cached tokens: this stands in for removing the tenant's grant. */
  public revoke(tenant: string): void {
    this.revoked.add(tenant);
    for (const key of [...this.tokens.keys()]) if (key.endsWith(`|${tenant}`)) this.tokens.delete(key);
  }

  /** A transaction token for one tenant, from the test-only mint; cached for four minutes (they last five). */
  public async token(instance: Instance, tenant: string): Promise<string> {
    if (this.aborted) throw new Error('the run was stopped');
    if (this.revoked.has(tenant)) throw new Error(`the driver no longer mints tokens for tenant ${tenant}`);
    const key = `${instance}|${tenant}`;
    const hit = this.tokens.get(key);
    // A token lasts 300 s and the gateway refuses one with 60 s or less left: reuse one for at most 180 s.
    if (hit && Date.now() - hit.at < TOKEN_REUSE_MS) return hit.token;
    const r = await this.aws.lambda.send(new InvokeCommand({
      FunctionName: this.out.MintFunction,
      Payload: Buffer.from(JSON.stringify({
        tenantId: tenant,
        sub: `integ-${tenant}`,
        agent: 'default',
        scope: `${TOOL_TARGET[instance]}/${TOOL_NAME}`,
        gateways: [TOOLS_GATEWAY],
      })),
    }));
    const body = JSON.parse(Buffer.from(r.Payload ?? []).toString('utf8')) as { token?: string };
    if (r.FunctionError || !body.token) throw new Error('the test mint answered no token');
    this.tokens.set(key, { token: body.token, at: Date.now() });
    return body.token;
  }

  /** A forged tool context for the `forged` step, signed with a key that is not the tool context key. */
  public async forgedContext(tenant: string, instance: Instance): Promise<string> {
    const r = await this.aws.lambda.send(new InvokeCommand({
      FunctionName: this.out.MintFunction,
      Payload: Buffer.from(JSON.stringify({
        tenantId: tenant,
        sub: `integ-${tenant}`,
        agent: 'default',
        scope: '',
        gateways: [TOOLS_GATEWAY],
        forgeContext: { tenantId: tenant, tool: `${TOOL_TARGET[instance]}/${TOOL_NAME}` },
      })),
    }));
    const body = JSON.parse(Buffer.from(r.Payload ?? []).toString('utf8')) as { context?: string };
    if (!body.context) throw new Error('the test mint answered no context');
    return body.context;
  }

  /** One `run_code` call through the gateway entry, retrying a starting or busy sandbox. */
  public async call(instance: Instance, tenant: string, args: CallArgs, options: CallOptions = {}): Promise<CallResult> {
    const backend = args.backend ?? 'microvm';
    const bound = options.retryMs ?? START_CAP_MS[backend] + 60_000;
    const t0 = Date.now();
    let starting = 0;
    for (;;) {
      if (this.aborted) throw new Error('the run was stopped');
      // Inside the loop: a start can retry for minutes, and the token it began with may be about to expire.
      const token = await this.token(instance, tenant);
      const r = await callGateway(this.out.ToolsGatewayUrl, token, `${TOOL_TARGET[instance]}___${TOOL_NAME}`, { ...args });
      const o = r.outcome;
      const retry = o.kind === 'error' && (o.code === 'sandbox_starting' || o.code === 'sandbox_busy');
      if (o.kind === 'error' && o.code === 'sandbox_starting') starting++;
      if (!retry || options.once || Date.now() - t0 > bound) {
        if (o.kind === 'result') this.runs.push({ instance, backend, runId: o.result.runId });
        return { outcome: o, result: o.kind === 'result' ? o.result : undefined, ms: Date.now() - t0, starting, status: r.status };
      }
      await sleep(Math.max(1, (o.kind === 'error' && o.retryAfterSeconds) || 5) * 1000);
    }
  }
  /**
   * Runs one probe script as `tenant` on `backend`. The config always carries
   * region, bucket, table, backend, the tenant and the other tenant.
   */
  public async probe(
    instance: Instance, tenant: string, backend: Backend, name: Probe, config: Record<string, unknown> = {}, options: ProbeOptions = {},
  ): Promise<{ call: CallResult; out: Record<string, unknown> }> {
    const base = {
      region: this.aws.region,
      bucket: this.output(instance, 'Bucket'),
      table: this.output(instance, 'Table'),
      backend,
      tenant,
      other: tenant === 'A' ? 'B' : 'A',
    };
    const call = await this.call(instance, tenant, { code: probeCode(name, { ...base, ...config }), input: options.input, backend }, options.retry);
    return { call, out: probeOut(call) };
  }
}

/** The output of a probe, read from the last JSON line of a result's stdout. */
export function probeOut(r: CallResult): Record<string, unknown> {
  return lastJsonLine(r.result?.stdout ?? '') ?? {};
}

export interface ProbeOptions {
  readonly input?: string;
  readonly retry?: CallOptions;
}


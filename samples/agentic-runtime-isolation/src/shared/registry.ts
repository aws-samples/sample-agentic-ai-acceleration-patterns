// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The backend registry (ADR-0024; v2, ADR-0032, ADR-0035). One shared
 * ingress serves `POST /{backend}/invocations`; each backend's own stack
 * writes an entry at `${prefix}backends/<name>` in SSM Parameter Store, and
 * the ingress resolves the name through this client with a per-process
 * cache. The ingress never holds a Runtime ARN in its environment, so
 * creating, changing or removing a backend never redeploys the ingress.
 *
 * (v2) An entry is an agent product (ADR-0032): the Runtime plus the agent's
 * `needs` and the `tools` it may use, and a `version` that is part of the
 * mint cache key (ADR-0036). The v1 `scopes` field is refused.
 *
 * Two halves share this file: the CDK side imports the schema, the name
 * rules and the parameter-name builders; the Lambda side uses the client.
 */

import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { BACKEND_NAME_PATTERN, type RegistryConfig } from './config';
import { sharedHandler } from './http';

/** The name rule lives in config.ts (which validates `RI_DEFAULT_BACKEND` without loading the SSM client); re-exported for the CDK side. */
export { BACKEND_NAME_PATTERN };

/** The route suffix under every backend name (spec §5). */
export const ROUTE = 'invocations';

/** The tag `AgentBackend` puts on its Runtime at creation; the ingress role's invoke grant is conditioned on it (ADR-0024). */
export const INGRESS_TAG_KEY = 'ri:ingress';

/** The path segment under the prefix that holds backend entries. */
export const REGISTRY_BACKENDS_SEGMENT = 'backends/';

/** The path segment under the prefix that holds tool registry pointers (spec §4.4). */
export const REGISTRY_TOOLS_SEGMENT = 'tools/';

/** The registry entry one backend writes (spec §4.3; v2, ADR-0032, ADR-0035). */
export interface RegistryEntry {
  /** The AgentCore Runtime ARN the route invokes. */
  readonly runtimeArn: string;
  /** `A.needs` (P-13): the agent's own actions, `<backend>/<action>`, granted whenever the agent is. Non-empty. */
  readonly needs: string[];
  /** `A.tools` (P-13): `<target>/<tool>` or `<target>/*`. May be empty: the agent then holds only its needs. */
  readonly tools: string[];
  /** Bumped on every update of the entry; part of the mint cache key (ADR-0036). */
  readonly version: number;
  /** `draining` refuses new requests (404) while running streams finish; the entry is removed afterwards. */
  readonly status: 'active' | 'draining';
}

export function isValidBackendName(name: unknown): name is string {
  return typeof name === 'string' && BACKEND_NAME_PATTERN.test(name);
}

/** The SSM parameter name of one backend's entry. */
export function registryParameterName(prefix: string, backend: string): string {
  return `${prefix}${REGISTRY_BACKENDS_SEGMENT}${backend}`;
}

/** The SSM parameter name of one tool target's registry pointer (spec §4.4). */
export function toolRegistryParameterName(prefix: string, target: string): string {
  return `${prefix}${REGISTRY_TOOLS_SEGMENT}${target}`;
}

const RUNTIME_ARN_PATTERN = /^arn:([a-z-]+):bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/[A-Za-z0-9_-]+$/;

/**
 * A need (spec §3.3, ADR-0032): `<name>/<action>`, both sides `[a-z0-9-]`,
 * 3 to 128 characters in all; for a backend the name is its own. (v2: was
 * `SCOPE_NAME_PATTERN`.)
 */
export const NEEDS_NAME_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/;
export const NEEDS_NAME_MIN_LENGTH = 3;
export const NEEDS_NAME_MAX_LENGTH = 128;

/** A tool target name (spec §3.3); one namespace with backend names (ADR-0035). */
export const TARGET_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
/** One tool's own name inside its target (spec §3.5). */
export const TOOL_SHORT_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;
/** A tool entry, `<target>/<tool>` or `<target>/*` (spec §3.3, §3.5). */
export const TOOL_NAME_PATTERN = /^[a-z0-9-]{1,32}\/([a-z0-9_]{1,64}|\*)$/;
/** The most entries `AgentBackend.tools` may list (spec §3.3). */
export const MAX_AGENT_TOOLS = 64;

/** Whether `need` is a well-formed need name. */
export function isValidNeedName(need: unknown): need is string {
  return (
    typeof need === 'string' &&
    need.length >= NEEDS_NAME_MIN_LENGTH &&
    need.length <= NEEDS_NAME_MAX_LENGTH &&
    NEEDS_NAME_PATTERN.test(need)
  );
}

/** Whether `tool` is a well-formed tool entry. */
export function isValidToolName(tool: unknown): tool is string {
  return typeof tool === 'string' && TOOL_NAME_PATTERN.test(tool);
}

/** The owner of a need or tool entry: the text before the slash. */
export function nameOwner(name: string): string {
  return name.split('/')[0];
}

/**
 * Checks a backend's `needs` at synth (spec §3.3, ADR-0032): at least one,
 * no duplicates, each a valid need owned by `backend`. Returns the message
 * to fail with, or undefined when the list is acceptable.
 */
export function backendNeedsProblem(backend: string, needs: readonly string[]): string | undefined {
  if (!Array.isArray(needs) || needs.length === 0) {
    return 'must name at least one need (ADR-0032)';
  }
  for (const need of needs) {
    if (!isValidNeedName(need)) {
      return `'${String(need)}' must match ${NEEDS_NAME_PATTERN.source} and be ${NEEDS_NAME_MIN_LENGTH} to ${NEEDS_NAME_MAX_LENGTH} characters`;
    }
    if (nameOwner(need) !== backend) {
      return `'${need}' must be owned by this backend: ${backend}/<action> (ADR-0032)`;
    }
  }
  if (new Set(needs).size !== needs.length) {
    return 'must not repeat a need';
  }
  return undefined;
}

/**
 * Checks a backend's `tools` at synth (spec §3.3, ADR-0032): at most
 * `MAX_AGENT_TOOLS`, no duplicates, each `<target>/<tool>` or `<target>/*`.
 * A target named here need not exist yet. Empty is valid.
 */
export function backendToolsProblem(tools: readonly string[]): string | undefined {
  if (!Array.isArray(tools)) {
    return 'must be a list of tool names';
  }
  if (tools.length > MAX_AGENT_TOOLS) {
    return `must list at most ${MAX_AGENT_TOOLS} tools (got ${tools.length})`;
  }
  for (const tool of tools) {
    if (!isValidToolName(tool)) {
      return `'${String(tool)}' must match ${TOOL_NAME_PATTERN.source} (<target>/<tool> or <target>/*)`;
    }
  }
  if (new Set(tools).size !== tools.length) {
    return 'must not repeat a tool';
  }
  return undefined;
}

/** The partition a Region belongs to, so an entry's ARN can be checked against the Lambda's own. */
export function partitionOf(region: string): string {
  if (region.startsWith('cn-')) {
    return 'aws-cn';
  }
  if (region.startsWith('us-gov-')) {
    return 'aws-us-gov';
  }
  return 'aws';
}

/** Where the ingress runs; an entry whose Runtime ARN points elsewhere is refused. Either field absent skips its check. */
export interface RegistryScope {
  readonly region?: string;
  readonly account?: string;
}

/** A v1-shaped entry (`scopes`, or no `needs`/`tools`): refused loudly (spec §4.3, `registry_entry_v1`). */
export class RegistryEntryV1Error extends Error {
  constructor() {
    super('registry entry is in the v1 shape');
    this.name = 'RegistryEntryV1Error';
  }
}

/**
 * Parses and validates an entry's JSON. Throws on anything the ingress must
 * not act on: a malformed ARN, an ARN outside the ingress's own partition,
 * Region or account, a malformed `needs` or `tools` list, a bad `version`,
 * an unknown status. An entry in the v1 shape throws RegistryEntryV1Error,
 * so it fails with 502 `registry_entry_v1` rather than granting the wrong
 * set (spec §4.3).
 */
export function parseRegistryEntry(raw: string, scope: RegistryScope = {}): RegistryEntry {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('registry entry is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('registry entry is not an object');
  }
  const record = value as Record<string, unknown>;
  const { runtimeArn, needs, tools, version, status } = record;
  if ('scopes' in record || needs === undefined || tools === undefined) {
    throw new RegistryEntryV1Error();
  }
  const arn = typeof runtimeArn === 'string' ? RUNTIME_ARN_PATTERN.exec(runtimeArn) : null;
  if (arn === null) {
    throw new Error('registry entry runtimeArn is not an AgentCore Runtime ARN');
  }
  const [, partition, region, account] = arn;
  if (scope.region !== undefined && (region !== scope.region || partition !== partitionOf(scope.region))) {
    throw new Error('registry entry runtimeArn is outside the ingress Region');
  }
  if (scope.account !== undefined && account !== scope.account) {
    throw new Error('registry entry runtimeArn is outside the ingress account');
  }
  if (!Array.isArray(needs) || needs.length === 0 || needs.some((n) => !isValidNeedName(n))) {
    throw new Error('registry entry needs must be a non-empty list of need names');
  }
  if (!Array.isArray(tools) || tools.some((t) => !isValidToolName(t))) {
    throw new Error('registry entry tools must be a list of tool names');
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('registry entry version must be a positive integer');
  }
  if (status !== 'active' && status !== 'draining') {
    throw new Error('registry entry status must be active or draining');
  }
  return { runtimeArn: runtimeArn as string, needs: needs as string[], tools: tools as string[], version, status };
}

/**
 * Reads the backend name from a request path. Both ingresses hand the Lambda
 * the path stage-stripped (API Gateway's `event.path`, the Gateway target's
 * path), so exactly two shapes are accepted: `/<name>/invocations` yields the
 * name; the bare `/invocations` yields `defaultBackend` when one is
 * configured. A trailing slash and a query string are tolerated. Anything
 * else is undefined: more segments, an ill-formed name, or a name equal to
 * the route word itself.
 */
export function backendFromPath(path: string | undefined, defaultBackend?: string): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  const segments = path.split('?')[0].split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length > 2 || segments[segments.length - 1] !== ROUTE) {
    return undefined;
  }
  if (segments.length === 1) {
    return defaultBackend;
  }
  const name = segments[0];
  return name !== ROUTE && isValidBackendName(name) ? name : undefined;
}

/** Why a lookup produced no backend. */
export type RegistryMiss = 'unknown_backend' | 'backend_draining' | 'registry_unavailable' | 'registry_entry_invalid' | 'registry_entry_v1';

export class RegistryError extends Error {
  constructor(readonly reason: RegistryMiss) {
    super(reason);
    this.name = 'RegistryError';
  }
}

interface CacheSlot {
  entry?: RegistryEntry;
  /** The miss to report while the slot is stale and a refresh fails. */
  miss?: RegistryMiss;
  /** When the entry or miss was last read from SSM; bounds how long a stale entry may be served. */
  fetchedAt: number;
  /** When the next refresh may run: `fetchedAt` plus the TTL, or pushed out by a failed refresh. */
  nextRefreshAt: number;
  inflight?: Promise<void>;
}

/**
 * Seconds a failed refresh of a stale entry holds before the next attempt
 * (bounded by the TTL), so a request storm during an SSM outage reads SSM
 * once per interval per backend instead of once per request.
 */
export const REFRESH_RETRY_SECONDS = 5;

/**
 * The multiple of the TTL after which a stale entry is no longer served and
 * the miss becomes `registry_unavailable`: the registry has been unreadable
 * for that long, and the entry may describe a Runtime that no longer exists
 * or whose needs and tools have changed. With the default 60 s TTL that is
 * 10 minutes.
 */
export const MAX_STALE_TTL_MULTIPLE = 10;

/**
 * Resolves backend names through SSM with a per-process cache. An entry is
 * served from the cache for `ttlSeconds`; after that the next request
 * refreshes it in flight, and a failed refresh serves the stale entry
 * (stale-while-refresh) for up to MAX_STALE_TTL_MULTIPLE TTLs, retrying
 * every REFRESH_RETRY_SECONDS, so SSM's 40 TPS standard quota is paid once
 * per process per backend per TTL. A name that SSM does not know is cached
 * as a miss for the same TTL, so an unknown route cannot drive a read per
 * request.
 */
export class BackendRegistry {
  private readonly cache = new Map<string, CacheSlot>();
  private readonly client: SSMClient;

  constructor(
    private readonly config: RegistryConfig,
    client?: SSMClient,
    private readonly now: () => number = Date.now,
  ) {
    this.client = client ?? new SSMClient({ requestHandler: sharedHandler() });
  }

  /** The configured prefix, for log lines and tests. */
  get prefix(): string {
    return this.config.prefix;
  }

  /**
   * Resolves one backend. Throws RegistryError: `unknown_backend` for a name
   * with no entry, `backend_draining` for a draining one,
   * `registry_entry_invalid` for an entry the schema rejects,
   * `registry_entry_v1` for an entry in the v1 shape, and
   * `registry_unavailable` when SSM cannot be read and nothing is cached.
   */
  async resolve(backend: string): Promise<RegistryEntry> {
    if (!isValidBackendName(backend)) {
      throw new RegistryError('unknown_backend');
    }
    const slot = this.cache.get(backend);
    if (slot === undefined || this.now() >= slot.nextRefreshAt) {
      // Cold or stale: refresh. A failed refresh leaves the slot holding
      // either the stale entry (served below) or a `registry_unavailable`
      // miss, so the SDK error never escapes as anything but a RegistryError.
      await this.refresh(backend).catch(() => undefined);
    }
    const current = this.cache.get(backend);
    if (current?.entry !== undefined) {
      if (current.entry.status === 'draining') {
        throw new RegistryError('backend_draining');
      }
      return current.entry;
    }
    throw new RegistryError(current?.miss ?? 'registry_unavailable');
  }

  /** Pre-fetches one backend during init (ADR-0023); failures are swallowed, the first request retries. */
  warm(backend: string | undefined): Promise<void> {
    return backend === undefined ? Promise.resolve() : this.refresh(backend).catch(() => undefined);
  }

  private refresh(backend: string): Promise<void> {
    const existing = this.cache.get(backend);
    if (existing?.inflight !== undefined) {
      return existing.inflight;
    }
    const ttlMs = this.config.ttlSeconds * 1000;
    const slot: CacheSlot = existing ?? { fetchedAt: 0, nextRefreshAt: 0 };
    slot.inflight = this.fetch(backend)
      .then((result) => {
        slot.fetchedAt = this.now();
        slot.nextRefreshAt = slot.fetchedAt + ttlMs;
        if ('entry' in result) {
          slot.entry = result.entry;
          slot.miss = undefined;
        } else {
          // A definite miss replaces a stale entry: the backend is gone.
          slot.entry = undefined;
          slot.miss = result.miss;
        }
      })
      .catch((error: unknown) => {
        const now = this.now();
        if (slot.entry !== undefined && now - slot.fetchedAt > MAX_STALE_TTL_MULTIPLE * ttlMs) {
          // Too stale to trust: drop it and report the registry as down.
          slot.entry = undefined;
        }
        if (slot.entry === undefined) {
          slot.miss = 'registry_unavailable';
          slot.fetchedAt = now;
          slot.nextRefreshAt = now + ttlMs;
        } else {
          slot.nextRefreshAt = now + Math.min(ttlMs, REFRESH_RETRY_SECONDS * 1000);
        }
        throw error;
      })
      .finally(() => {
        slot.inflight = undefined;
      });
    this.cache.set(backend, slot);
    return slot.inflight;
  }

  private async fetch(backend: string): Promise<{ entry: RegistryEntry } | { miss: RegistryMiss }> {
    let value: string | undefined;
    try {
      const out = await this.client.send(new GetParameterCommand({ Name: registryParameterName(this.config.prefix, backend) }));
      value = out.Parameter?.Value;
    } catch (error) {
      if (error instanceof ParameterNotFound) {
        return { miss: 'unknown_backend' };
      }
      throw error;
    }
    if (value === undefined) {
      return { miss: 'unknown_backend' };
    }
    try {
      return { entry: parseRegistryEntry(value, { region: this.config.region, account: this.config.account }) };
    } catch (error) {
      return { miss: error instanceof RegistryEntryV1Error ? 'registry_entry_v1' : 'registry_entry_invalid' };
    }
  }
}

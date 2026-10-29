// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The backend registry (ADR-0024). One shared ingress serves
 * `POST /{backend}/invocations`; each backend's own stack writes an entry at
 * `${prefix}backends/<name>` in SSM Parameter Store, and the ingress resolves
 * the name through this client with a per-process cache. The ingress never
 * holds a Runtime ARN in its environment, so creating, changing or removing
 * a backend never redeploys the ingress.
 *
 * Two halves share this file: the CDK side imports the schema, the name
 * rules and the parameter-name builder; the Lambda side uses the client.
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

/** The registry entry one backend writes. */
export interface RegistryEntry {
  /** The AgentCore Runtime ARN the route invokes. */
  readonly runtimeArn: string;
  /** Scopes a token must carry for this backend, on top of the ingress-wide list (ADR-0005). Empty means none. */
  readonly requiredScopes: string[];
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

const RUNTIME_ARN_PATTERN = /^arn:([a-z-]+):bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/[A-Za-z0-9_-]+$/;

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

/**
 * Parses and validates an entry's JSON. Throws on anything the ingress must
 * not act on: a malformed ARN, an ARN outside the ingress's own partition,
 * Region or account, a non-string scope, an unknown status.
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
  const { runtimeArn, requiredScopes, status } = value as Record<string, unknown>;
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
  const scopes = requiredScopes === undefined ? [] : requiredScopes;
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== 'string' || s.length === 0 || /\s/.test(s))) {
    throw new Error('registry entry requiredScopes must be a list of scope strings');
  }
  if (status !== 'active' && status !== 'draining') {
    throw new Error('registry entry status must be active or draining');
  }
  return { runtimeArn: runtimeArn as string, requiredScopes: scopes as string[], status };
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
export type RegistryMiss = 'unknown_backend' | 'backend_draining' | 'registry_unavailable' | 'registry_entry_invalid';

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
 * or whose scopes have changed. With the default 60 s TTL that is 10 minutes.
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
   * `registry_entry_invalid` for an entry the schema rejects, and
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
    } catch {
      return { miss: 'registry_entry_invalid' };
    }
  }
}

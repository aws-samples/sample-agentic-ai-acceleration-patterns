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
import type { RegistryConfig } from './config';
import { sharedHandler } from './http';

/** A backend name: lower-case letters, digits and hyphens, 1 to 32 characters. */
export const BACKEND_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;

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

const RUNTIME_ARN_PATTERN = /^arn:[a-z-]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z0-9_-]+$/;

/**
 * Parses and validates an entry's JSON. Throws on anything the ingress must
 * not act on: a malformed ARN, a non-string scope, an unknown status.
 */
export function parseRegistryEntry(raw: string): RegistryEntry {
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
  if (typeof runtimeArn !== 'string' || !RUNTIME_ARN_PATTERN.test(runtimeArn)) {
    throw new Error('registry entry runtimeArn is not an AgentCore Runtime ARN');
  }
  const scopes = requiredScopes === undefined ? [] : requiredScopes;
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== 'string' || s.length === 0 || /\s/.test(s))) {
    throw new Error('registry entry requiredScopes must be a list of scope strings');
  }
  if (status !== 'active' && status !== 'draining') {
    throw new Error('registry entry status must be active or draining');
  }
  return { runtimeArn, requiredScopes: scopes as string[], status };
}

/**
 * Reads the backend name from a request path. `/<name>/invocations` yields
 * the name; the bare `/invocations` yields `defaultBackend` when one is
 * configured. A stage prefix (`/prod/...`) is tolerated because API Gateway
 * and the Gateway differ in what they hand the Lambda. Returns undefined
 * for anything else, including an ill-formed name.
 */
export function backendFromPath(path: string | undefined, defaultBackend?: string): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  const segments = path.split('?')[0].split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments[segments.length - 1] !== ROUTE) {
    return undefined;
  }
  if (segments.length === 1) {
    return defaultBackend;
  }
  const name = segments[segments.length - 2];
  return isValidBackendName(name) ? name : undefined;
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
  fetchedAt: number;
  inflight?: Promise<void>;
}

/**
 * Resolves backend names through SSM with a per-process cache. An entry is
 * served from the cache for `ttlSeconds`; after that the next request
 * refreshes it in flight, and a failed refresh serves the stale entry
 * (stale-while-refresh), so SSM's 40 TPS standard quota is paid once per
 * process per backend per TTL. A name that SSM does not know is cached as a
 * miss for the same TTL, so an unknown route cannot drive a read per request.
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
    const fresh = slot !== undefined && this.now() - slot.fetchedAt < this.config.ttlSeconds * 1000;
    if (slot === undefined || !fresh) {
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
    const slot: CacheSlot = existing ?? { fetchedAt: 0 };
    slot.inflight = this.fetch(backend)
      .then((result) => {
        slot.fetchedAt = this.now();
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
        if (slot.entry === undefined) {
          slot.miss = 'registry_unavailable';
          slot.fetchedAt = this.now();
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
      return { entry: parseRegistryEntry(value) };
    } catch {
      return { miss: 'registry_entry_invalid' };
    }
  }
}

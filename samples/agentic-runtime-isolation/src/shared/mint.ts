// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The transaction-token mint (spec §6.2.2, P-14; ADR-0031, ADR-0036,
 * ADR-0037, ADR-0040). The ingress mints one token per (tenant, user, agent,
 * versions) after its own checks: it names exactly one tenant, one user and
 * one agent, carries exactly the granted `scope`, is bound by `aud` to that
 * agent and to each tools gateway its granted tools live on
 * (`tools-gateway:<name>`, ADR-0041), names the ingress role in `act`, and lives
 * `ttl` seconds. It is signed by KMS (`MessageType: DIGEST`), never by a key
 * in this process.
 *
 * `sub` is `<tenant_id>#<sub>` (ADR-0040: the AgentCore Identity vault keys
 * on `iss` and `sub`, so a user in two tenants must have two subjects), and
 * the identity provider's `sub` is carried in `user` for logs and the
 * session prefix. Nothing reads the user by splitting `sub`.
 *
 * Minted tokens are cached per (tenant, sub, agent, tenant.version,
 * agent.version, plan.version) and reused while more than the reuse margin
 * of their life is left, so a busy user costs one KMS call per token life,
 * not per request (ADR-0036). A write to the tenant or a cut bumps
 * `tenant.version`, so the next request misses the cache and mints the new
 * grant. The cache is bounded (LRU), like the TVM's (ADR-0022).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { type DigestSigner, type JwsAlgorithm, signJws } from './jws';
import { log } from './logger';

/**
 * The encoded transaction-token bound (spec §3.6, ADR-0045). Every ingress
 * forwards the token in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token`,
 * and `InvokeAgentRuntime` refuses a custom header value over 10,240 bytes
 * (spike V-17, 2026-11-04: 10,240 passes, 10,241 is `ValidationException`,
 * 16,000 is HTTP 413; the header-allowlist page documents 4 KB). A token
 * over this bound is refused at mint with `grant_too_large` instead of
 * failing at the Runtime with an opaque 400. Lowering it is the one change
 * needed if the Runtime ever enforces its documented value (threat model
 * T-101).
 */
export const MAX_TOKEN_BYTES = 10240;

/**
 * The signed token is longer than MAX_TOKEN_BYTES. The authority step
 * answers it with 502 `grant_too_large` (src/shared/authority.ts).
 */
export class TokenTooLargeError extends Error {
  constructor(readonly encodedBytes: number) {
    super('transaction token too large');
    this.name = 'TokenTooLargeError';
  }
}

/** The JOSE `typ` of a transaction token (spec §6.2.2). */
export const TRANSACTION_TOKEN_TYPE = 'txn+jwt';
/** The tools gateway audience prefix: `tools-gateway:<gateway name>` (spec §3.6, ADR-0041). */
export const TOOLS_GATEWAY_AUDIENCE_PREFIX = 'tools-gateway:';
/** The tools gateway name pattern (spec §3.3, ADR-0041). */
export const TOOLS_GATEWAY_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
/** The gateway a target lives on when its catalogue rows name none (one gateway, `default`). */
export const DEFAULT_TOOLS_GATEWAY = 'default';

/** The audience of one tools gateway (its `allowedAudience` and the token's `aud` entry). */
export function toolsGatewayAudience(gateway: string): string {
  return `${TOOLS_GATEWAY_AUDIENCE_PREFIX}${gateway}`;
}

/** The tools gateways a token's `aud` names, in order. */
export function toolsGatewaysOf(aud: readonly unknown[]): string[] {
  return aud
    .filter((a): a is string => typeof a === 'string' && a.startsWith(TOOLS_GATEWAY_AUDIENCE_PREFIX))
    .map((a) => a.slice(TOOLS_GATEWAY_AUDIENCE_PREFIX.length))
    .filter((g) => TOOLS_GATEWAY_NAME_PATTERN.test(g));
}
/** The agent audience prefix: `agent:<backend>`. */
export const AGENT_AUDIENCE_PREFIX = 'agent:';

/**
 * The `act` claim (RFC 8693 §4.1). A token minted from an identity token
 * carries `{ sub: <ingress role ARN> }`. A replacement token minted for a
 * delegation (spec §3.7, ADR-0048) nests the calling agent over the caller's
 * own `act`, so the innermost `sub` is always the ingress role and the chain
 * of agents reads from the outside in.
 */
export interface ActClaim {
  readonly sub: string;
  readonly act?: ActClaim;
}

/** The most agents a chain may hold after a hop (spec §3.3, `agentDelegation.maxDepth`). */
export const MAX_DELEGATION_DEPTH = 3;

/**
 * The agents named in an `act` chain, outermost first (`agent:` prefix
 * removed), or undefined when the chain is not well formed: a level that is
 * not an object with a string `sub`, an outer level whose `sub` is not an
 * `agent:` entry, or an innermost `sub` that is not the ingress role. Bounded
 * at MAX_DELEGATION_DEPTH + 1 levels, so a hostile token cannot drive a long
 * walk.
 */
export function agentChainOf(act: unknown, ingressRoleArn: string): string[] | undefined {
  const chain: string[] = [];
  let level: unknown = act;
  for (let depth = 0; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
    if (typeof level !== 'object' || level === null || Array.isArray(level)) {
      return undefined;
    }
    const { sub, act: inner } = level as Record<string, unknown>;
    if (typeof sub !== 'string') {
      return undefined;
    }
    if (inner === undefined) {
      return sub === ingressRoleArn ? chain : undefined;
    }
    if (!sub.startsWith(AGENT_AUDIENCE_PREFIX) || sub.length === AGENT_AUDIENCE_PREFIX.length) {
      return undefined;
    }
    chain.push(sub.slice(AGENT_AUDIENCE_PREFIX.length));
    level = inner;
  }
  return undefined;
}

/**
 * Whether two `act` chains are the same chain: the same `sub` at every level
 * and the same depth. Compared level by level, so key order and any
 * property other than `sub` and `act` do not matter. False for anything that
 * is not a well-formed level, and for a chain deeper than the walk bound.
 */
export function sameActChain(a: unknown, b: unknown): boolean {
  let left: unknown = a;
  let right: unknown = b;
  for (let depth = 0; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
    if (!isActLevel(left) || !isActLevel(right)) {
      return false;
    }
    if (left.sub !== right.sub) {
      return false;
    }
    if (left.act === undefined || right.act === undefined) {
      return left.act === undefined && right.act === undefined;
    }
    left = left.act;
    right = right.act;
  }
  return false;
}

function isActLevel(level: unknown): level is { sub: string; act?: unknown } {
  return typeof level === 'object' && level !== null && !Array.isArray(level) && typeof (level as Record<string, unknown>).sub === 'string';
}

/** Default bound on cached tokens per ingress instance (spec §3.3). */
export const DEFAULT_MINT_CACHE_MAX_ENTRIES = 1000;

/** The tenant-qualified subject (ADR-0040). */
export function qualifiedSubject(tenantId: string, sub: string): string {
  return `${tenantId}#${sub}`;
}

export interface MintConfig {
  /** The ingress issuer URL (`<baseUrl>`), the `iss` claim. */
  readonly issuer: string;
  /** The KMS key id of the current signing key; the `kid`. */
  readonly keyId: string;
  readonly algorithm: JwsAlgorithm;
  /** `exp - iat`, MIN_TRANSACTION_TTL_SECONDS to MAX_TRANSACTION_TTL_SECONDS (120 to 900 s; spec §3.3). */
  readonly ttlSeconds: number;
  /** A cached token is reused only while more than this many seconds of its life are left. */
  readonly reuseMarginSeconds: number;
  /** The ingress role ARN, `act.sub` (RFC 8693). */
  readonly ingressRoleArn: string;
  readonly cacheMaxEntries?: number;
}

export interface MintInput {
  readonly tenantId: string;
  /** The identity token's `sub`. */
  readonly sub: string;
  readonly agent: string;
  /** The granted set, space-separated (src/shared/grant.ts). */
  readonly scope: string;
  /**
   * The tools gateways the granted tools live on (ADR-0041), resolved from
   * the catalogue rows' `gateway`. Empty when no tool is granted: `aud` is
   * then the agent alone.
   */
  readonly gateways: readonly string[];
  /** The versions in the cache key (ADR-0036). */
  readonly versions: { readonly tenant: number; readonly agent: number; readonly plan?: number };
  /**
   * (ADR-0048) Set when this is a replacement token for a delegation: the
   * calling agent, the caller's `act` (nested under the caller) and the
   * caller's `txn` (copied). Such a token is signed every time, never cached.
   */
  readonly delegation?: DelegationInput;
}

/** What a replacement token takes from the caller's token (spec §3.7). */
export interface DelegationInput {
  /** The calling agent's backend name. */
  readonly from: string;
  /** The caller's `act`, already verified to end in the ingress role. */
  readonly act: ActClaim;
  /** The caller's `txn`. */
  readonly txn: string;
}

/** The claims of a transaction token (spec §6.2.2). */
export interface TransactionClaims {
  readonly iss: string;
  readonly sub: string;
  readonly user: string;
  readonly tenant_id: string;
  readonly agent: string;
  readonly scope: string;
  readonly aud: string[];
  readonly act: ActClaim;
  readonly txn: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface MintedToken {
  readonly token: string;
  readonly txn: string;
  readonly exp: number;
  /** `hit` when served from the cache (no KMS call), `miss` when minted now (P-9). */
  readonly mint: 'hit' | 'miss';
}

/** The claims for one mint. `now` is in seconds. Pure. */
export function transactionClaims(
  input: MintInput,
  config: Pick<MintConfig, 'issuer' | 'ttlSeconds' | 'ingressRoleArn'>,
  now: number,
  ids: { txn: string; jti: string },
): TransactionClaims {
  return {
    iss: config.issuer,
    sub: qualifiedSubject(input.tenantId, input.sub),
    user: input.sub,
    tenant_id: input.tenantId,
    agent: input.agent,
    scope: input.scope,
    aud: [`${AGENT_AUDIENCE_PREFIX}${input.agent}`, ...[...new Set(input.gateways)].sort().map(toolsGatewayAudience)],
    act: input.delegation === undefined ? { sub: config.ingressRoleArn } : { sub: `${AGENT_AUDIENCE_PREFIX}${input.delegation.from}`, act: input.delegation.act },
    txn: input.delegation === undefined ? ids.txn : input.delegation.txn,
    iat: now,
    exp: now + config.ttlSeconds,
    jti: ids.jti,
  };
}

/** The mint cache key: tenant, user, agent, the three versions, the scope and the gateways (spec §3.6). */
export function mintCacheKey(input: MintInput): string {
  return JSON.stringify([
    input.tenantId,
    input.sub,
    input.agent,
    input.versions.tenant,
    input.versions.agent,
    input.versions.plan ?? 0,
    input.scope,
    [...new Set(input.gateways)].sort(),
  ]);
}

export interface TokenMinterDependencies {
  readonly signer: DigestSigner;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
  readonly txnId?: () => string;
  readonly jti?: () => string;
}

/**
 * The shortest transaction-token lifetime (spec §3.3, amended 2026-11-03).
 * The AgentCore Gateway's JWT authoriser refuses a token with 60 s or less
 * left before `exp` (integ run 7: a fresh 60 s or 61 s token is 403
 * insufficient_scope, 62 s and longer are served), so a 60 s token would be
 * refused at every tools gateway. 120 s leaves at least 60 s of use there.
 */
export const MIN_TRANSACTION_TTL_SECONDS = 120;
/** The longest transaction-token lifetime (spec §3.3). */
export const MAX_TRANSACTION_TTL_SECONDS = 900;

export class TokenMinter {
  private readonly cache = new Map<string, MintedToken>();
  private readonly inflight = new Map<string, Promise<MintedToken>>();
  private readonly now: () => number;
  private readonly txnId: () => string;
  private readonly jti: () => string;

  constructor(private readonly config: MintConfig, private readonly deps: TokenMinterDependencies) {
    if (!Number.isInteger(config.ttlSeconds) || config.ttlSeconds < MIN_TRANSACTION_TTL_SECONDS || config.ttlSeconds > MAX_TRANSACTION_TTL_SECONDS) {
      throw new Error(`TokenMinter: ttlSeconds must be an integer from ${MIN_TRANSACTION_TTL_SECONDS} to ${MAX_TRANSACTION_TTL_SECONDS}`);
    }
    this.now = deps.now ?? Date.now;
    // 128 random bits, base64url (spec §6.2.2).
    this.txnId = deps.txnId ?? (() => randomBytes(16).toString('base64url'));
    this.jti = deps.jti ?? randomUUID;
  }

  /**
   * A token for `input`: from the cache while enough life is left, else a
   * fresh KMS-signed one. A replacement token (`input.delegation`) is signed
   * every time: its `act` and `txn` are the caller's, so no two delegations
   * share one (spec §3.7).
   */
  async mint(input: MintInput): Promise<MintedToken> {
    const nowSeconds = Math.floor(this.now() / 1000);
    if (input.delegation !== undefined) {
      return this.sign(input, nowSeconds);
    }
    const key = mintCacheKey(input);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      if (cached.exp - nowSeconds > this.config.reuseMarginSeconds) {
        // LRU: move to the end.
        this.cache.delete(key);
        this.cache.set(key, cached);
        return { ...cached, mint: 'hit' };
      }
      this.cache.delete(key);
    }
    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      return pending.then((t) => ({ ...t, mint: 'hit' as const }));
    }
    const minting = this.sign(input, nowSeconds).finally(() => this.inflight.delete(key));
    this.inflight.set(key, minting);
    const minted = await minting;
    this.store(key, minted);
    return minted;
  }

  private async sign(input: MintInput, nowSeconds: number): Promise<MintedToken> {
    const claims = transactionClaims(input, this.config, nowSeconds, { txn: this.txnId(), jti: this.jti() });
    const token = await signJws(
      { alg: this.config.algorithm, typ: TRANSACTION_TOKEN_TYPE, kid: this.config.keyId },
      claims,
      this.deps.signer,
    );
    // The real bound (ADR-0045): the scope check in grantFor ran before the
    // KMS call; this one measures what the Runtime will measure. The token
    // is ASCII (base64url and dots), so its length is its byte count. It is
    // not cached, so every retry is refused the same way.
    if (token.length > MAX_TOKEN_BYTES) {
      log.warn('transaction token over the runtime header bound', {
        tenantId: input.tenantId,
        agent: input.agent,
        encodedBytes: token.length,
        limitBytes: MAX_TOKEN_BYTES,
        scopeBytes: Buffer.byteLength(input.scope, 'utf8'),
      });
      throw new TokenTooLargeError(token.length);
    }
    return { token, txn: claims.txn, exp: claims.exp, mint: 'miss' };
  }

  private store(key: string, token: MintedToken): void {
    const max = this.config.cacheMaxEntries ?? DEFAULT_MINT_CACHE_MAX_ENTRIES;
    while (this.cache.size >= max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
    this.cache.set(key, token);
  }

  /** Cached entries, for tests. */
  get size(): number {
    return this.cache.size;
  }
}

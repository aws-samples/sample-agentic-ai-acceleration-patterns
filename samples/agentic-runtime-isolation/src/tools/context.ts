// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tool-side library (spec C-15b, §6.2.4, P-15; ADR-0034). A tool learns
 * its tenant only from the context the tools gateway interceptor signed for
 * this call, and reaches tenant data only through its own TVM:
 *
 * 1. `verifyToolContext` verifies `_ri_ctx` with the cached public half of
 *    `ToolContextKey` (never the ingress JWKS: a transaction token can never
 *    pass as a context), checks `typ`, `exp`, that `tool` is the tool being
 *    called and that `argsHash` matches the arguments, and strips `_ri_ctx`;
 * 2. `withTenantCredentials` assumes the tool's tenant role with the
 *    `TenantId` session tag from the context (C-7);
 * 3. `toolHandler` wraps both around a Lambda tool and writes one
 *    `tool served` line with `tenantId`, `txn`, duration and bytes (P-9).
 *
 * A tool with no valid context gets `context_invalid` and no credentials:
 * its own role reaches no tenant data. The context value is never logged.
 */

import type { KeyObject } from 'node:crypto';
import { KMSClient } from '@aws-sdk/client-kms';
import type { Context } from 'aws-lambda';
import { catalogueToolName } from '../shared/cedar';
import type { TvmConfig } from '../shared/config';
import { argsHash, CONTEXT_ARGUMENT, kmsPublicKey, verifyJws } from '../shared/jws';
import { errorName, log } from '../shared/logger';
import { TokenVendingMachine, type VendedCredentials } from '../shared/tvm';

/** The JOSE `typ` of a signed tenant context (spec §6.2.4). */
export const CONTEXT_TYPE = 'ri-ctx+jwt';

/** Environment variables a tool function reads (set by `ToolTarget`). */
export const TOOL_ENV = {
  CONTEXT_KEY_ID: 'RI_CONTEXT_KEY_ID',
  /** The tool's tenant role (`ToolTarget.tvm.role`); unset when the tool reaches no tenant data. */
  TVM_ROLE_ARN: 'RI_TOOL_TVM_ROLE_ARN',
} as const;

/** What a verified context says (spec §6.2.4). */
export interface ToolContext {
  readonly tenantId: string;
  /** The transaction token's subject, `<tenant_id>#<sub>`. */
  readonly sub: string;
  /** The identity provider's `sub` (ADR-0040): read the user from here, never by splitting `sub`. */
  readonly user: string;
  readonly agent: string;
  /** `<target>/<tool>`. */
  readonly tool: string;
  readonly txn: string;
  readonly exp: number;
}

export type ContextFailure = 'context_missing' | 'context_invalid' | 'context_expired' | 'context_tool_mismatch' | 'context_args_mismatch';

/** Every failure surfaces to the agent as the one tool error `context_invalid` (spec §5.4); `detail` is for the log. */
export class ContextError extends Error {
  readonly code = 'context_invalid';
  constructor(readonly detail: ContextFailure) {
    super('context_invalid');
    this.name = 'ContextError';
  }
}

export interface VerifyOptions {
  /** The public half of `ToolContextKey`. */
  readonly publicKey: () => Promise<KeyObject>;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
}

/**
 * Verifies the context in `args` for `tool` (either `<target>/<tool>` or the
 * Gateway's `<target>___<tool>`). Returns the context and the arguments
 * without `_ri_ctx`. Throws ContextError.
 */
export async function verifyToolContext(
  args: Record<string, unknown>,
  tool: string,
  options: VerifyOptions,
): Promise<{ context: ToolContext; args: Record<string, unknown> }> {
  const raw = args[CONTEXT_ARGUMENT];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ContextError('context_missing');
  }
  let payload: Record<string, unknown>;
  try {
    const decoded = verifyJws(raw, await options.publicKey(), ['RS256']);
    if (decoded.header.typ !== CONTEXT_TYPE) {
      throw new Error('typ');
    }
    payload = decoded.payload;
  } catch {
    throw new ContextError('context_invalid');
  }
  const { tenant_id: tenantId, sub, user, agent, tool: signedTool, txn, exp, argsHash: signedHash } = payload;
  if (
    typeof tenantId !== 'string' ||
    typeof sub !== 'string' ||
    typeof user !== 'string' ||
    typeof agent !== 'string' ||
    typeof signedTool !== 'string' ||
    typeof txn !== 'string' ||
    typeof exp !== 'number' ||
    typeof signedHash !== 'string'
  ) {
    throw new ContextError('context_invalid');
  }
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (exp <= now) {
    throw new ContextError('context_expired');
  }
  const called = tool.includes('___') ? catalogueToolName(tool) : tool;
  if (called !== signedTool) {
    throw new ContextError('context_tool_mismatch');
  }
  const rest: Record<string, unknown> = { ...args };
  delete rest[CONTEXT_ARGUMENT];
  if (argsHash(rest) !== signedHash) {
    throw new ContextError('context_args_mismatch');
  }
  return { context: { tenantId, sub, user, agent, tool: signedTool, txn, exp }, args: rest };
}

/** A cached public-key getter over KMS `GetPublicKey` (one call per process). */
export function kmsContextPublicKey(keyId: string, kms: KMSClient = new KMSClient({})): () => Promise<KeyObject> {
  let cached: Promise<KeyObject> | undefined;
  return () => {
    cached ??= kmsPublicKey(kms, keyId).then((k) => k.key);
    cached.catch(() => {
      cached = undefined;
    });
    return cached;
  };
}

/**
 * Runs `fn` with credentials vended for the context's tenant (P-15): the
 * tool's tenant role, `TenantId` session tag only. The TVM caches per tag
 * set (ADR-0022).
 */
export async function withTenantCredentials<T>(
  context: ToolContext,
  tvm: Pick<TokenVendingMachine, 'vend'>,
  fn: (credentials: VendedCredentials) => Promise<T>,
): Promise<T> {
  const { credentials } = await tvm.vend({ tenantId: context.tenantId, sub: context.user, clientId: 'tools-gateway', scopes: [], claims: {} });
  return fn(credentials);
}

/** What a tool implementation receives. */
export interface ToolInvocation {
  readonly context: ToolContext;
  /** The arguments without `_ri_ctx`. */
  readonly args: Record<string, unknown>;
  /** Tenant-scoped credentials; undefined when the target has no tool tenant role. */
  readonly credentials?: VendedCredentials;
}

export interface ToolHandlerOptions {
  readonly publicKey?: () => Promise<KeyObject>;
  readonly tvm?: Pick<TokenVendingMachine, 'vend'>;
  readonly now?: () => number;
}

/** The Gateway's tool name from a Lambda target invocation (spike V-10: `clientContext.custom.bedrockAgentCoreToolName`). */
export function gatewayToolNameOf(context: Pick<Context, 'clientContext'> | undefined): string | undefined {
  const custom = (context?.clientContext as { custom?: Record<string, unknown> } | undefined)?.custom;
  const name = custom?.bedrockAgentCoreToolName;
  return typeof name === 'string' ? name : undefined;
}

/**
 * Wraps a tool implementation as a Lambda target handler: verify, vend,
 * run, log `tool served`. A context failure returns `{ error: 'context_invalid' }`
 * and runs nothing.
 */
export function toolHandler(
  implementation: (invocation: ToolInvocation) => Promise<unknown>,
  options: ToolHandlerOptions = {},
): (event: Record<string, unknown>, lambdaContext?: Context) => Promise<unknown> {
  let publicKey = options.publicKey;
  let tvm = options.tvm;
  return async (event, lambdaContext) => {
    const started = (options.now ?? Date.now)();
    const tool = gatewayToolNameOf(lambdaContext) ?? '';
    publicKey ??= kmsContextPublicKey(process.env[TOOL_ENV.CONTEXT_KEY_ID] ?? '');
    const roleArn = process.env[TOOL_ENV.TVM_ROLE_ARN];
    if (tvm === undefined && roleArn !== undefined && roleArn.length > 0) {
      const config: TvmConfig = { roleArn, includeUserIdTag: false, claimTags: {}, durationSeconds: 900 };
      tvm = new TokenVendingMachine(config);
    }
    let verified;
    try {
      verified = await verifyToolContext(event ?? {}, tool, { publicKey, now: options.now });
    } catch (error) {
      const detail = error instanceof ContextError ? error.detail : 'context_invalid';
      log.warn('tool refused', { tool: catalogueToolName(tool) ?? 'unknown', reason: 'context_invalid', detail });
      return { error: 'context_invalid' };
    }
    const { context, args } = verified;
    try {
      const credentials = tvm === undefined ? undefined : (await tvm.vend({ tenantId: context.tenantId, sub: context.user, clientId: 'tools-gateway', scopes: [], claims: {} })).credentials;
      const result = await implementation({ context, args, credentials });
      log.info('tool served', {
        tenantId: context.tenantId,
        txn: context.txn,
        agent: context.agent,
        tool: context.tool,
        durationMs: (options.now ?? Date.now)() - started,
        bytes: Buffer.byteLength(JSON.stringify(result ?? null), 'utf8'),
      });
      return result;
    } catch (error) {
      log.error('tool failed', { tenantId: context.tenantId, txn: context.txn, tool: context.tool, error: errorName(error) });
      return { error: 'tool_failed' };
    }
  };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { Context } from 'aws-lambda';
import { argsHash, CONTEXT_ARGUMENT, signJws } from '../../src/shared/jws';
import { CONTEXT_TYPE, ContextError, gatewayToolNameOf, toolHandler, verifyToolContext } from '../../src/tools/context';
import { localRsaKey } from '../jws-helpers';

/** The tool-side library (spec C-15b, §6.2.4, P-15, ADR-0034). */
const NOW = 1_000_000_000;
const key = localRsaKey();
const other = localRsaKey();

async function signedContext(
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  signer = key.signer,
  typ = CONTEXT_TYPE,
): Promise<string> {
  const now = Math.floor(NOW / 1000);
  return signJws(
    { alg: 'RS256', typ, kid: 'ctx-key' },
    {
      tenant_id: 't-a',
      sub: 't-a#user-1',
      user: 'user-1',
      agent: 'default',
      tool: 'crm/get_account',
      argsHash: argsHash(args),
      txn: 'txn-1',
      iat: now,
      exp: now + 60,
      ...overrides,
    },
    signer,
  );
}

const options = { publicKey: async () => key.publicKey, now: () => NOW };

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ContextError) {
      expect(err.code).toBe('context_invalid');
      return err.detail;
    }
    throw err;
  }
  throw new Error('expected a ContextError');
}

describe('verifyToolContext', () => {
  it('returns the signed context and the arguments without _ri_ctx', async () => {
    const args = { accountId: 'acc-1' };
    const result = await verifyToolContext({ ...args, [CONTEXT_ARGUMENT]: await signedContext(args) }, 'crm___get_account', options);
    expect(result.args).toEqual(args);
    expect(result.context).toEqual({
      tenantId: 't-a',
      sub: 't-a#user-1',
      user: 'user-1',
      agent: 'default',
      tool: 'crm/get_account',
      txn: 'txn-1',
      exp: Math.floor(NOW / 1000) + 60,
    });
    // The catalogue name is accepted too.
    await expect(verifyToolContext({ ...args, [CONTEXT_ARGUMENT]: await signedContext(args) }, 'crm/get_account', options)).resolves.toBeDefined();
  });

  it('refuses a missing context', async () => {
    expect(await failure(verifyToolContext({ accountId: 'acc-1' }, 'crm___get_account', options))).toBe('context_missing');
    expect(await failure(verifyToolContext({ [CONTEXT_ARGUMENT]: '' }, 'crm___get_account', options))).toBe('context_missing');
  });

  it('refuses a context signed by another key, of another typ, or not a JWS', async () => {
    const args = { accountId: 'acc-1' };
    expect(await failure(verifyToolContext({ ...args, [CONTEXT_ARGUMENT]: await signedContext(args, {}, other.signer) }, 'crm___get_account', options))).toBe('context_invalid');
    // A transaction token is never a context (different typ, different key).
    expect(await failure(verifyToolContext({ ...args, [CONTEXT_ARGUMENT]: await signedContext(args, {}, key.signer, 'txn+jwt') }, 'crm___get_account', options))).toBe('context_invalid');
    expect(await failure(verifyToolContext({ ...args, [CONTEXT_ARGUMENT]: 'a.b.c' }, 'crm___get_account', options))).toBe('context_invalid');
    expect(await failure(verifyToolContext({ ...args, [CONTEXT_ARGUMENT]: await signedContext(args, { tenant_id: 7 }) }, 'crm___get_account', options))).toBe('context_invalid');
  });

  it('refuses an expired context', async () => {
    const args = { accountId: 'acc-1' };
    const token = await signedContext(args, { exp: Math.floor(NOW / 1000) });
    expect(await failure(verifyToolContext({ ...args, [CONTEXT_ARGUMENT]: token }, 'crm___get_account', options))).toBe('context_expired');
  });

  it('refuses a context signed for another tool', async () => {
    const args = { accountId: 'acc-1' };
    const token = await signedContext(args);
    expect(await failure(verifyToolContext({ ...args, [CONTEXT_ARGUMENT]: token }, 'crm___update_case', options))).toBe('context_tool_mismatch');
    expect(await failure(verifyToolContext({ ...args, [CONTEXT_ARGUMENT]: token }, 'not-a-tool', options))).toBe('context_tool_mismatch');
  });

  it('refuses arguments that differ from the signed hash', async () => {
    const token = await signedContext({ accountId: 'acc-1' });
    expect(await failure(verifyToolContext({ accountId: 'acc-2', [CONTEXT_ARGUMENT]: token }, 'crm___get_account', options))).toBe('context_args_mismatch');
    expect(await failure(verifyToolContext({ accountId: 'acc-1', tenantId: 't-b', [CONTEXT_ARGUMENT]: token }, 'crm___get_account', options))).toBe('context_args_mismatch');
  });
});

describe('gatewayToolNameOf', () => {
  it('reads clientContext.custom.bedrockAgentCoreToolName (spike V-10)', () => {
    expect(gatewayToolNameOf({ clientContext: { custom: { bedrockAgentCoreToolName: 'crm___get_account' } } } as unknown as Context)).toBe('crm___get_account');
    expect(gatewayToolNameOf(undefined)).toBeUndefined();
    expect(gatewayToolNameOf({ clientContext: undefined } as Context)).toBeUndefined();
  });
});

describe('toolHandler', () => {
  let lines: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    lines = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((l: unknown) => {
      lines.push(String(l));
      return true;
    });
  });
  afterEach(() => spy.mockRestore());

  const lambdaContext = { clientContext: { custom: { bedrockAgentCoreToolName: 'crm___get_account' } } } as unknown as Context;

  it('runs the implementation with the verified context and vended credentials, and logs tool served', async () => {
    const vend = jest.fn().mockResolvedValue({ credentials: { accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't' } });
    const implementation = jest.fn().mockResolvedValue({ name: 'Acme' });
    const handler = toolHandler(implementation, { publicKey: options.publicKey, now: options.now, tvm: { vend } });
    const args = { accountId: 'acc-1' };
    const result = await handler({ ...args, [CONTEXT_ARGUMENT]: await signedContext(args) }, lambdaContext);
    expect(result).toEqual({ name: 'Acme' });
    expect(vend).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-a', sub: 'user-1' }));
    expect(implementation.mock.calls[0][0].args).toEqual(args);
    expect(implementation.mock.calls[0][0].context.tenantId).toBe('t-a');
    const served = lines.map((l) => JSON.parse(l)).find((l) => l.message === 'tool served');
    expect(served).toMatchObject({ tenantId: 't-a', txn: 'txn-1', tool: 'crm/get_account' });
  });

  it('returns context_invalid, runs nothing and vends nothing without a valid context; never logs the context value', async () => {
    const vend = jest.fn();
    const implementation = jest.fn();
    const handler = toolHandler(implementation, { publicKey: options.publicKey, now: options.now, tvm: { vend } });
    const forged = await signedContext({ accountId: 'acc-1' }, {}, other.signer);
    expect(await handler({ accountId: 'acc-1', [CONTEXT_ARGUMENT]: forged }, lambdaContext)).toEqual({ error: 'context_invalid' });
    expect(await handler({ accountId: 'acc-1' }, lambdaContext)).toEqual({ error: 'context_invalid' });
    expect(implementation).not.toHaveBeenCalled();
    expect(vend).not.toHaveBeenCalled();
    expect(lines.join('')).not.toContain(forged);
    expect(lines.map((l) => JSON.parse(l))).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'tool refused', reason: 'context_invalid' })]));
  });

  it('a failing implementation returns tool_failed', async () => {
    const handler = toolHandler(async () => {
      throw new Error('boom');
    }, { publicKey: options.publicKey, now: options.now });
    const args = { accountId: 'acc-1' };
    expect(await handler({ ...args, [CONTEXT_ARGUMENT]: await signedContext(args) }, lambdaContext)).toEqual({ error: 'tool_failed' });
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The gateway entry's tool body (spec §3.2, §5.1, ADR-0055) run inside the
// producer's real `toolHandler`: the tenant comes only from the signed
// context, an unsigned or altered call is refused before `runCode`, and a
// `tenantId` argument is refused.

import { toolHandler } from 'agentic-runtime-isolation/tools';
import type { Context } from 'aws-lambda';
import { CONTEXT_ARGUMENT, signContext, testKey } from './gateway-signed-context';
import { harness } from './harness';
import { gatewayRunCode } from '../src/gateway/handler';
import { GATEWAY_ARGUMENTS, runCodeToolDefinition } from '../src/gateway/tool-schema';
import { TENANT_ID_PATTERN } from '../src/protocol';
import { runCode as coreRunCode } from '../src/tool/run-code';
import type { RunCodeRequest, RunCodeResult } from '../src/tool/types';

const key = testKey();
const GATEWAY_TOOL_NAME = 'run-code___run_code';
const lambdaContext = (tool: string = GATEWAY_TOOL_NAME): Context =>
  ({ clientContext: { custom: { bedrockAgentCoreToolName: tool } } }) as unknown as Context;

const RESULT: RunCodeResult = { runId: 'r1', backend: 'microvm', exitCode: 0, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false, memoryExceeded: false, durationMs: 4, sandbox: 'started' };

type Run = (request: RunCodeRequest) => Promise<RunCodeResult>;

function setup(options: { run?: Run } = {}) {
  const runCode = jest.fn<ReturnType<Run>, Parameters<Run>>(options.run ?? (async () => RESULT));
  // No `tvm`: the gateway entry holds no credential; the core's `runCode` vends its own.
  const handler = toolHandler(gatewayRunCode(runCode), { publicKey: async () => key.publicKey });
  return { handler, runCode };
}

/** A call the interceptor signed for `tenantId` and exactly these arguments. */
function signedCall(tenantId: string, args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, [CONTEXT_ARGUMENT]: signContext({ tenantId, signedFor: args, key }) };
}

beforeEach(() => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => jest.restoreAllMocks());

describe('the tenant comes only from the signed context', () => {
  test('a signed call runs for the context tenant', async () => {
    const { handler, runCode } = setup();
    const result = await handler(signedCall('tenant-a', { code: 'print(1)', input: 'invoice.csv', backend: 'microvm', saveOutput: true }), lambdaContext());
    expect(result).toEqual(RESULT);
    expect(runCode).toHaveBeenCalledTimes(1);
    expect(runCode.mock.calls[0]).toEqual([{ tenantId: 'tenant-a', code: 'print(1)', input: 'invoice.csv', backend: 'microvm', saveOutput: true }]);
  });

  test.each([
    ['another tenant', 'tenant-b'],
    ['the same tenant', 'tenant-a'],
  ])('a tenantId argument naming %s is refused', async (_name, named) => {
    const { handler, runCode } = setup();
    const result = await handler(signedCall('tenant-a', { code: 'print(1)', tenantId: named }), lambdaContext());
    expect(result).toEqual({ error: 'invalid_argument', message: expect.stringContaining('tenantId') });
    expect(runCode).not.toHaveBeenCalled();
  });

  test('a tenantId argument is refused even when its value is empty or not a string', async () => {
    for (const value of ['', null, 7, { id: 'tenant-b' }]) {
      const { handler, runCode } = setup();
      const result = await handler(signedCall('tenant-a', { code: 'x', tenantId: value }), lambdaContext());
      expect(result).toMatchObject({ error: 'invalid_argument' });
      expect(runCode).not.toHaveBeenCalled();
    }
  });

  test('an argument the tool does not declare is refused', async () => {
    const { handler, runCode } = setup();
    for (const extra of ['tenant', 'TenantId', 'tenant_id', 'roleArn', '__proto__']) {
      const args: Record<string, unknown> = JSON.parse(`{"code":"x","${extra}":"tenant-b"}`);
      const result = await handler(signedCall('tenant-a', args), lambdaContext());
      expect(result).toMatchObject({ error: 'invalid_argument' });
    }
    expect(runCode).not.toHaveBeenCalled();
  });

  test('the request never carries a tenant other than the context\'s', async () => {
    const { handler, runCode } = setup();
    await handler(signedCall('tenant-a', { code: 'x' }), lambdaContext());
    expect(runCode.mock.calls.map(([r]) => r.tenantId)).toEqual(['tenant-a']);
  });
});

describe('an unsigned or altered call is refused before runCode', () => {
  test('no context', async () => {
    const { handler, runCode } = setup();
    expect(await handler({ code: 'print(1)' }, lambdaContext())).toEqual({ error: 'context_invalid' });
    expect(runCode).not.toHaveBeenCalled();
  });

  test('an empty or garbage context', async () => {
    const { handler, runCode } = setup();
    expect(await handler({ code: 'x', [CONTEXT_ARGUMENT]: '' }, lambdaContext())).toEqual({ error: 'context_invalid' });
    expect(await handler({ code: 'x', [CONTEXT_ARGUMENT]: 'a.b.c' }, lambdaContext())).toEqual({ error: 'context_invalid' });
    expect(runCode).not.toHaveBeenCalled();
  });

  test('a context signed with another key', async () => {
    const { handler, runCode } = setup();
    const args = { code: 'x' };
    const forged = { ...args, [CONTEXT_ARGUMENT]: signContext({ tenantId: 'tenant-b', signedFor: args, key: testKey() }) };
    expect(await handler(forged, lambdaContext())).toEqual({ error: 'context_invalid' });
    expect(runCode).not.toHaveBeenCalled();
  });

  test('arguments changed after signing', async () => {
    const { handler, runCode } = setup();
    const call = signedCall('tenant-a', { code: 'print(1)' });
    expect(await handler({ ...call, code: 'print(2)' }, lambdaContext())).toEqual({ error: 'context_invalid' });
    expect(runCode).not.toHaveBeenCalled();
  });

  test('a context signed for another tool', async () => {
    const { handler, runCode } = setup();
    const args = { code: 'x' };
    const call = { ...args, [CONTEXT_ARGUMENT]: signContext({ tenantId: 'tenant-a', tool: 'crm/get_account', signedFor: args, key }) };
    expect(await handler(call, lambdaContext())).toEqual({ error: 'context_invalid' });
    expect(runCode).not.toHaveBeenCalled();
  });

  test('a call that does not name its tool', async () => {
    const { handler, runCode } = setup();
    expect(await handler(signedCall('tenant-a', { code: 'x' }), undefined)).toEqual({ error: 'context_invalid' });
    expect(runCode).not.toHaveBeenCalled();
  });
});

describe('what a refusal does', () => {
  test.each([
    ['code is not a string', { code: 5 }],
    ['code is nested', { code: { tenantId: 'tenant-b' } }],
    ['input is nested', { code: 'x', input: { tenantId: 'tenant-b' } }],
    ['input is null', { code: 'x', input: null }],
    ['backend is a list', { code: 'x', backend: ['microvm'] }],
    ['saveOutput is a string', { code: 'x', saveOutput: 'true' }],
  ])('%s: invalid_argument, nothing runs', async (_name, args) => {
    const { handler, runCode } = setup();
    expect(await handler(signedCall('tenant-a', args), lambdaContext())).toEqual({ error: 'invalid_argument', message: expect.any(String) });
    expect(runCode).not.toHaveBeenCalled();
  });

  test('each refusal writes one WARN line with the reason and no value from the call', async () => {
    const write = jest.spyOn(process.stdout, 'write');
    const { handler } = setup();
    await handler(signedCall('tenant-a', { code: 'x', tenantId: 'VALUE_MARKER' }), lambdaContext());
    await handler(signedCall('tenant-a', { code: 'x', extra: 'VALUE_MARKER' }), lambdaContext());
    await handler(signedCall('tenant-a', { code: 7 }), lambdaContext());
    await handler(signedCall('a/b', { code: 'x' }), lambdaContext());
    const lines = write.mock.calls.map((c) => String(c[0]).trim()).filter((l) => l.includes('"tool refused"')).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.reason)).toEqual(['tenant_argument', 'unknown_argument', 'argument_type', 'tenant_id_rule']);
    expect(lines.map((l) => l.tenantId)).toEqual(['tenant-a', 'tenant-a', 'tenant-a', undefined]);
    expect(lines.every((l) => l.level === 'WARN' && l.tool === 'run-code/run_code' && l.txn === 'txn-1')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('VALUE_MARKER');
  });
});

describe('the verified tenant id must fit the tenant id rule (spec §5.1)', () => {
  test.each([
    ['empty', ''],
    ['a slash', 'tenant/a'],
    ['a leading hyphen', '-tenant'],
    ['a space', 'tenant a'],
    ['a hash', 'TENANT#a'],
    ['a dot', 'tenant.a'],
    ['65 characters', 'a'.repeat(65)],
  ])('%s is refused as context_invalid and nothing runs', async (_name, tenantId) => {
    const { handler, runCode } = setup();
    expect(await handler(signedCall(tenantId, { code: 'x' }), lambdaContext())).toEqual({ error: 'context_invalid' });
    expect(runCode).not.toHaveBeenCalled();
  });

  test.each(['a', 'A1', 'tenant-a', 'tenant_a', 'a'.repeat(64)])('%s is accepted', async (tenantId) => {
    const { handler, runCode } = setup();
    expect(await handler(signedCall(tenantId, { code: 'x' }), lambdaContext())).toEqual(RESULT);
    expect(runCode).toHaveBeenCalledTimes(1);
  });

  test('the pattern is the one of spec §5.1', () => {
    expect(TENANT_ID_PATTERN.source).toBe('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');
  });
});

describe('what the tool returns', () => {
  test('a tool error from runCode reaches the caller unchanged', async () => {
    const { handler } = setup({ run: async () => ({ error: 'sandbox_starting', retryAfterSeconds: 7 }) });
    expect(await handler(signedCall('tenant-a', { code: 'x' }), lambdaContext())).toEqual({ error: 'sandbox_starting', retryAfterSeconds: 7 });
  });

  test('a fault inside runCode is tool_failed, with no message or stack', async () => {
    const { handler } = setup({
      run: async () => {
        throw new Error('dynamodb said tenant-a key abc');
      },
    });
    expect(await handler(signedCall('tenant-a', { code: 'x' }), lambdaContext())).toEqual({ error: 'tool_failed' });
  });

  test('the code and the input never reach the log', async () => {
    const write = jest.spyOn(process.stdout, 'write');
    const { handler } = setup();
    await handler(signedCall('tenant-a', { code: 'SECRET_CODE_MARKER', input: 'SECRET_INPUT_MARKER.csv' }), lambdaContext());
    const logged = write.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('tool served');
    expect(logged).not.toContain('SECRET_CODE_MARKER');
    expect(logged).not.toContain('SECRET_INPUT_MARKER');
    expect(logged).not.toContain('secret');
  });
});

describe('the tool definition (spec §5.1)', () => {
  const tool = runCodeToolDefinition(['microvm', 'nitro'], 'microvm');
  const schema = tool.inputSchema as { type: string; properties: Record<string, { type: string; description: string }>; required: string[] };

  test('is named run_code and declares exactly the gateway arguments, none of them a tenant', () => {
    expect(tool.name).toBe('run_code');
    expect(Object.keys(schema.properties).sort()).toEqual([...GATEWAY_ARGUMENTS].sort());
    expect(Object.keys(schema.properties).filter((k) => /tenant/i.test(k))).toEqual([]);
    expect(schema.required).toEqual(['code']);
  });

  test('uses only the schema keywords a Lambda target accepts', () => {
    const walk = (node: Record<string, unknown>): void => {
      for (const k of Object.keys(node)) expect(['type', 'properties', 'required', 'items', 'description']).toContain(k);
      for (const child of Object.values((node.properties ?? {}) as Record<string, Record<string, unknown>>)) walk(child);
    };
    walk(schema as unknown as Record<string, unknown>);
  });

  test('names the deployed backends and the default in the backend argument', () => {
    expect(schema.properties.backend.description).toContain('microvm, nitro');
    expect(schema.properties.backend.description).toContain('Default microvm');
  });

  test('states the limits an agent writes code for', () => {
    for (const phrase of ['256 MiB', 'PermissionError', 'inputs/', '/work/input', 'retryAfterSeconds']) expect(tool.description).toContain(phrase);
    expect(tool.description.length).toBeLessThan(1200);
  });
});

describe('the gateway body joined to the core runCode', () => {
  function joined(over: Parameters<typeof harness>[0] = {}) {
    const h = harness(over);
    const handler = toolHandler(gatewayRunCode((request) => coreRunCode(request, h.deps)), { publicKey: async () => key.publicKey });
    return { h, handler };
  }

  test.each([
    ['no code', {}],
    ['a lone surrogate', { code: 'a\ud800b' }],
    ['an unknown backend', { code: 'x', backend: 'lambda' }],
    ['an empty input name', { code: 'x', input: '' }],
    ['an input name with ..', { code: 'x', input: 'a/../b' }],
  ])('%s: invalid_argument from the core, and no credential requested', async (_name, args) => {
    const { h, handler } = joined();
    expect(await handler(signedCall('tenant-a', args), lambdaContext())).toEqual({ error: 'invalid_argument' });
    expect(h.credsFor).toEqual([]);
  });

  test('a backend that is not deployed is backend_disabled, with no credential requested', async () => {
    const { h, handler } = joined();
    expect(await handler(signedCall('tenant-a', { code: 'x', backend: 'agentcore' }), lambdaContext())).toEqual({ error: 'backend_disabled' });
    expect(h.credsFor).toEqual([]);
  });

  test('the body refusals ask for no credential either', async () => {
    const { h, handler } = joined();
    await handler(signedCall('tenant-a', { code: 'x', tenantId: 'tenant-b' }), lambdaContext());
    await handler(signedCall('a/b', { code: 'x' }), lambdaContext());
    expect(h.credsFor).toEqual([]);
  });

  test('a good call asks for the context tenant\'s credentials once and runs the job for that tenant', async () => {
    const { h, handler } = joined();
    const result = await handler(signedCall('tenant-a', { code: 'print(1)' }), lambdaContext());
    expect(h.credsFor).toEqual(['tenant-a']);
    expect(h.backends.get('microvm')?.jobs.map((j) => j.tenantId)).toEqual(['tenant-a']);
    expect(result).not.toHaveProperty('error', 'invalid_argument');
  });
});

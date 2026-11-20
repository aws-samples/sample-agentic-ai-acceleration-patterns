// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Threat T-88, mitigation M-60: the test-only overrides are accepted by the
 * integration stack alone and cannot be turned on in a normal deployment.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { INTEG_CONTEXT_KEY, INTEG_FAIL_START_TENANT_ENV, INTEG_OVERRIDES_ENV, enableIntegOverrides, overrideEnvironment } from './overrides';
import { DemoStack } from '../../src/demo.cdk';
import { resolveProps } from '../../src/props';

const SRC = path.resolve(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function fn(app: App): lambda.Function {
  return new lambda.Function(new Stack(app, 'S'), 'F', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler = async () => 1') });
}

/** Every Lambda function of a stack, with the names of its environment variables. */
function functionEnvironments(stack: Stack): string[][] {
  const t = Template.fromStack(stack).findResources('AWS::Lambda::Function');
  return Object.values(t).map((r) => Object.keys((r.Properties as { Environment?: { Variables?: object } }).Environment?.Variables ?? {}));
}

describe('RC_INTEG_OVERRIDES (T-88, M-60)', () => {
  test('the escape hatch writes the variable, and the tenant of a failed start only when asked', () => {
    expect(overrideEnvironment()).toEqual({ [INTEG_OVERRIDES_ENV]: '1' });
    expect(overrideEnvironment({ failStartTenant: 'E' })).toEqual({ [INTEG_OVERRIDES_ENV]: '1', [INTEG_FAIL_START_TENANT_ENV]: 'E' });
    expect(() => overrideEnvironment({ failStartTenant: '../x' })).toThrow(/tenant id/);
  });

  test('it refuses to run in an app that is not the integration app', () => {
    expect(() => enableIntegOverrides(fn(new App()))).toThrow(/integration app/);
    expect(() => enableIntegOverrides(fn(new App({ context: { [INTEG_CONTEXT_KEY]: false } })))).toThrow(/integration app/);
  });

  test('in the integration app it sets the variable on that function only', () => {
    const app = new App({ context: { [INTEG_CONTEXT_KEY]: true } });
    const f = fn(app);
    const stack = Stack.of(f);
    const other = new lambda.Function(stack, 'Other', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler = async () => 1') });
    enableIntegOverrides(f, { failStartTenant: 'E' });
    const envs = Template.fromStack(stack).findResources('AWS::Lambda::Function');
    const withVar = Object.entries(envs).filter(([, r]) => JSON.stringify(r.Properties).includes(INTEG_OVERRIDES_ENV)).map(([id]) => id);
    expect(withVar).toHaveLength(1);
    expect(withVar[0]).not.toContain(other.node.id);
    expect(JSON.stringify(envs)).toContain('"RC_INTEG_FAIL_START_TENANT":"E"');
  });

  test('a normal deployment has no function with the variable, with the context key set or not', () => {
    for (const context of [{}, { [INTEG_CONTEXT_KEY]: true }]) {
      const app = new App({ context });
      const stack = new DemoStack(app, 'Demo', { backends: ['microvm', 'nitro', 'agentcore'], standalone: true });
      const names = functionEnvironments(stack).flat();
      expect(names.filter((n) => n.startsWith('RC_INTEG'))).toEqual([]);
      expect(JSON.stringify(Template.fromStack(stack).toJSON())).not.toContain('RC_INTEG');
    }
  });

  test('no construct prop exposes it: a prop of that name changes nothing', () => {
    const resolved = resolveProps({ RC_INTEG_OVERRIDES: '1', integOverrides: true } as never);
    expect(JSON.stringify(resolved)).not.toMatch(/INTEG|integ/i);
  });

  test('only run-time code names it, and no CDK-side file names it or imports a file that does', () => {
    const files = sourceFiles(SRC);
    const holders = files.filter((f) => readFileSync(f, 'utf8').includes('RC_INTEG'));
    // Allowed: the names file (src/env.ts `TEST_HOOKS`), the tool, the reaper and the backends' run-time classes.
    const allowed = (f: string): boolean => /[\\/]env\.ts$|[\\/](tool|reaper)[\\/]|\.function\.ts$/.test(f) || (/[\\/]backends[\\/]/.test(f) && !/\.cdk\.ts$/.test(f));
    expect(holders.filter((f) => !allowed(f))).toEqual([]);
    const cdkSide = files.filter((f) => /\.cdk\.ts$|[\\/](props|main|backend-construct|handler-entry|index|backend|protocol)\.ts$|[\\/]gateway[\\/]/.test(f));
    expect(cdkSide.length).toBeGreaterThan(0);
    // The construct imports `env.ts` for its function variables; it may not import any other holder, and it may not use `TEST_HOOKS`.
    const stems = new Set(holders.filter((f) => !/[\\/]env\.ts$/.test(f)).map((f) => f.replace(/\.ts$/, '')));
    for (const f of cdkSide) {
      const text = readFileSync(f, 'utf8');
      expect(text).not.toContain('RC_INTEG');
      expect(text).not.toContain('TEST_HOOKS');
      for (const m of text.matchAll(/from '(\.[^']*)'/g)) {
        expect(stems.has(path.resolve(path.dirname(f), m[1]))).toBe(false);
      }
    }
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      // run-time code reads the variable (`process.env`); nothing in src/ assigns it, by key or by property path
      // (env.ts only names it: its `TEST_HOOK_ENV` key is the name itself)
      if (!/[\\/]env\.ts$/.test(f)) expect(text).not.toMatch(/RC_INTEG_OVERRIDES['"]?\s*[:=](?!=)/);
      expect(text).not.toContain('Environment.Variables.');
    }
  });
});

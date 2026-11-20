// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { readContext } from '../src/demo.cdk';
import { resolveProps } from '../src/props';
import { UntrustedCodeSandboxes } from '../src/untrusted-code-sandboxes.cdk';

describe('props validation (spec §3.3)', () => {
  test('defaults', () => {
    const r = resolveProps({});
    expect(r.backends).toEqual(['microvm']);
    expect(r.defaultBackend).toBe('microvm');
    expect(r.toolBudget.toSeconds()).toBe(60);
    expect(r.settings.maxOutputBytes).toBe(262144);
    expect(r.settings.nitroInstanceTypes).toEqual(['m7i.xlarge']);
  });

  test.each([
    [{ backends: [] }, /at least one/],
    [{ backends: ['wasm' as never] }, /unknown backend/],
    [{ backends: ['nitro', 'nitro'] as never }, /twice/],
    [{ backends: ['nitro'], defaultBackend: 'microvm' } as const, /not in backends/],
    [{ runTimeout: Duration.millis(500) }, /runTimeout/],
    [{ runTimeout: Duration.seconds(61) }, /runTimeout/],
    [{ runTimeout: Duration.seconds(60), startWait: Duration.seconds(46) }, /above 120 s/],
    [{ sandboxMaxLife: Duration.hours(9) }, /at most 8 h/],
    [{ sandboxIdle: Duration.seconds(30) }, /at least 1 min/],
    [{ sandboxIdle: Duration.hours(1), sandboxMaxLife: Duration.hours(1) }, /below sandboxMaxLife/],
    [{ maxOutputBytes: 0 }, /maxOutputBytes/],
  ])('refuses %p', (props, message) => {
    expect(() => resolveProps(props as never)).toThrow(message);
  });

  test('a budget of exactly 120 s is allowed', () => {
    expect(resolveProps({ runTimeout: Duration.seconds(60), startWait: Duration.seconds(45) }).toolBudget.toSeconds()).toBe(120);
  });

  test('fractional durations round the budget up', () => {
    expect(resolveProps({ runTimeout: Duration.millis(1500), startWait: Duration.millis(200) }).toolBudget.toSeconds()).toBe(18);
  });

  test('dnsFirewall is refused with a supplied vpc', () => {
    const stack = new Stack();
    const vpc = new ec2.Vpc(stack, 'V');
    expect(() => resolveProps({ vpc, dnsFirewall: true })).toThrow(/dnsFirewall/);
  });
});

describe('construct shell', () => {
  test('synthesises with every backend and the standalone entry', () => {
    const app = new App();
    const stack = new Stack(app, 'S');
    const c = new UntrustedCodeSandboxes(stack, 'Sandboxes', { standalone: true, backends: ['microvm', 'nitro', 'agentcore'] });
    expect(Object.keys(c.backends).sort()).toEqual(['agentcore', 'microvm', 'nitro']);
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::ECR::Repository', 1);
    t.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: { BlockPublicAcls: true } });
  });

  test('microvm alone needs no runner repository', () => {
    const stack = new Stack(new App(), 'S');
    const c = new UntrustedCodeSandboxes(stack, 'Sandboxes', { standalone: true });
    expect(c.runnerRepository).toBeUndefined();
    Template.fromStack(stack).resourceCountIs('AWS::ECR::Repository', 0);
  });

  test('a core with no entry fails synth', () => {
    const app = new App();
    const stack = new Stack(app, 'S');
    new UntrustedCodeSandboxes(stack, 'Sandboxes', {});
    expect(() => app.synth()).toThrow(/has no entry/);
  });
});

describe('demo app context', () => {
  const ctx = (m: Record<string, unknown>) => (k: string) => m[k];
  test('reads backends and standalone', () => {
    expect(readContext(ctx({ backends: 'microvm, nitro', standalone: 'true' }))).toEqual({ backends: ['microvm', 'nitro'], standalone: true });
  });
  test.each([
    [{}, /backends/],
    [{ backends: 'microvm,lambda', standalone: 'true' }, /unknown backend "lambda"/],
    [{ backends: 'microvm' }, /standalone/],
    [{ backends: 'microvm', standalone: 'yes' }, /standalone/],
  ])('fails fast on %p', (m, message) => {
    expect(() => readContext(ctx(m))).toThrow(message);
  });
});

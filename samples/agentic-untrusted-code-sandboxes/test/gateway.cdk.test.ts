// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// `RunCodeToolTarget` (spec §3.3, ADR-0055) synthesised offline with the
// producer's real `SharedIngress`: the Lambda target, the tool schema, the
// time cap, the tool tenant role as TVM role, and the bind.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GATEWAY_TARGET_NAME, SharedIngress } from 'agentic-runtime-isolation';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as esbuild from 'esbuild';
import { RunCodeToolTarget } from '../src/gateway';
import { HANDLERS, handlerEntry } from '../src/handler-entry';
import type { UntrustedCodeSandboxesProps } from '../src/props';
import { UntrustedCodeSandboxes } from '../src/untrusted-code-sandboxes.cdk';

const DISCOVERY_URL = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00/.well-known/openid-configuration';

function setup(props: UntrustedCodeSandboxesProps = {}, target: { toolName?: string; gateway?: string } = {}) {
  // Bundling is skipped: the test checks the template, not the esbuild output.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'Test');
  const ingress = new SharedIngress(stack, 'Ingress', {
    ingress: 'api-gateway',
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'] },
    defaultBackend: GATEWAY_TARGET_NAME,
  });
  const core = new UntrustedCodeSandboxes(stack, 'Sandboxes', props);
  const sandboxes = core;
  const { toolRole, toolTenantRole } = core;
  const bind = jest.spyOn(core, 'bindRunCode');
  const runCode = new RunCodeToolTarget(stack, 'RunCode', { sandboxes, ingress, ...target });
  return { app, stack, sandboxes, runCode, bind, toolRole, toolTenantRole, template: () => Template.fromStack(stack) };
}

function isGatewayFunction(f: any): boolean {
  const d = f.Properties.Description;
  return typeof d === 'string' && d.includes('run_code on the tools gateway');
}

function gatewayTarget(template: Template): any {
  const targets = Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget'));
  expect(targets).toHaveLength(1);
  return (targets[0] as any).Properties;
}

describe('RunCodeToolTarget', () => {
  test('registers one Lambda target named run-code with the single tool run_code', () => {
    const { template, runCode } = setup();
    const props = gatewayTarget(template());
    expect(props.Name).toBe('run-code');
    const lambdaTarget = props.TargetConfiguration.Mcp.Lambda;
    expect(lambdaTarget.ToolSchema.InlinePayload).toHaveLength(1);
    expect(lambdaTarget.ToolSchema.InlinePayload[0].Name).toBe('run_code');
    expect(runCode.tools).toEqual(['run_code']);
    expect(runCode.gateway).toBe('default');
    expect(runCode.isolation).toBe('enforced');
  });

  test('the schema has no tenantId and requires code', () => {
    const { template } = setup({ backends: ['microvm', 'nitro'], defaultBackend: 'nitro' });
    const tool = gatewayTarget(template()).TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload[0];
    expect(Object.keys(tool.InputSchema.Properties).sort()).toEqual(['backend', 'code', 'input', 'saveOutput']);
    expect(tool.InputSchema.Required).toEqual(['code']);
    expect(tool.InputSchema.Properties.backend.Description).toContain('microvm, nitro');
    expect(tool.InputSchema.Properties.backend.Description).toContain('Default nitro');
    expect(JSON.stringify(tool)).not.toMatch(/tenantId/);
  });

  test('toolName and gateway name the target and the tools gateway', () => {
    const { template, runCode } = setup({}, { toolName: 'run-code-files' });
    expect(gatewayTarget(template()).Name).toBe('run-code-files');
    expect(runCode.name).toBe('run-code-files');
    expect(() => setup({}, { toolName: 'Run_Code' })).toThrow(/name/);
    expect(() => setup({}, { gateway: 'missing-gateway' })).toThrow(/gateway/);
  });

  test('the function runs as the core tool role, with the budget as its timeout', () => {
    const { template, stack, toolRole } = setup();
    const functions = Object.values(template().findResources('AWS::Lambda::Function')).filter((f: any) => isGatewayFunction(f));
    expect(functions).toHaveLength(1);
    const props = (functions[0] as any).Properties;
    expect(props.Timeout).toBe(60);
    expect(props.Runtime).toBe('nodejs24.x');
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.Role).toEqual(stack.resolve(toolRole.roleArn));
    expect(props.LoggingConfig).toMatchObject({ LogFormat: 'JSON', SystemLogLevel: 'WARN', ApplicationLogLevel: 'INFO' });
  });

  test('the Lambda timeout follows startWait and runTimeout', () => {
    const { template } = setup({ startWait: Duration.seconds(20), runTimeout: Duration.seconds(50) });
    template().hasResourceProperties('AWS::Lambda::Function', { Timeout: 85, Description: Match.stringLikeRegexp('run_code on the tools gateway') });
  });

  test('a budget of exactly 90 s is allowed and 91 s fails at synth (spike S-11)', () => {
    const { template } = setup({ startWait: Duration.seconds(25), runTimeout: Duration.seconds(50) });
    template().hasResourceProperties('AWS::Lambda::Function', { Timeout: 90, Description: Match.stringLikeRegexp('run_code on the tools gateway') });
    expect(() => setup({ startWait: Duration.seconds(26), runTimeout: Duration.seconds(50) })).toThrow(/above the 90 s cap/);
    expect(() => setup({ startWait: Duration.seconds(30), runTimeout: Duration.seconds(60) })).toThrow(/105 s, above the 90 s cap/);
  });

  test('the function reads the context key, vends no tenant role itself, and only the gateway may invoke it', () => {
    const { template } = setup();
    const fn = Object.values(template().findResources('AWS::Lambda::Function')).find((f: any) => isGatewayFunction(f)) as any;
    const env = fn.Properties.Environment.Variables;
    expect(Object.keys(env)).toContain('RI_CONTEXT_KEY_ID');
    // The core's runCode vends the tenant role; the target must not make the producer's toolHandler vend it too.
    expect(Object.keys(env)).not.toContain('RI_TOOL_TVM_ROLE_ARN');
    const statements = Object.values(template().findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    expect(statements.some((st: any) => st.Action === 'kms:GetPublicKey' && st.Effect === 'Allow')).toBe(true);
    // Only the tools gateway's role may invoke it (M-61).
    const permissions = Object.values(template().findResources('AWS::Lambda::Permission')).map((p: any) => p.Properties);
    const invoke = permissions.filter((p: any) => p.Action === 'lambda:InvokeFunction' && JSON.stringify(p.FunctionName).includes('RunCodeHandler'));
    expect(invoke).toHaveLength(1);
    expect(JSON.stringify(invoke[0].Principal)).toContain('GatewayRole');
  });

  test('the core binds the function: tool subnets, environment, budget, an owned log group, no trust change', () => {
    const { template, stack, toolRole, toolTenantRole } = setup();
    const fn = Object.values(template().findResources('AWS::Lambda::Function')).find((f: any) => isGatewayFunction(f)) as any;
    expect(fn.Properties.VpcConfig.SubnetIds).toHaveLength(2);
    expect(fn.Properties.VpcConfig.SecurityGroupIds).toHaveLength(1);
    expect(fn.Properties.Timeout).toBe(60);
    const env = fn.Properties.Environment.Variables;
    for (const name of ['REGISTRY_TABLE', 'INPUT_BUCKET', 'TOOL_TENANT_ROLE_ARN', 'RI_CONTEXT_KEY_ID']) expect(Object.keys(env)).toContain(name);
    expect(fn.Properties.LoggingConfig.LogFormat).toBe('JSON');
    expect(JSON.stringify(fn.Properties.LoggingConfig.LogGroup)).toContain('BoundLogs');
    // On the tool role the function needs no extra trust: the tool tenant role already trusts that role, and only it.
    expect(fn.Properties.Role).toEqual(stack.resolve(toolRole.roleArn));
    const tenantRole = template().findResources('AWS::IAM::Role')[stack.resolve(toolTenantRole.roleArn)['Fn::GetAtt'][0]] as any;
    const trust = tenantRole.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0].Principal.AWS).toEqual(stack.resolve(toolRole.roleArn));
  });

  test('the function is handed to the core exactly once', () => {
    const { bind, runCode } = setup();
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith(runCode.function);
  });

  test('a core with only this target has an entry, so its own validation passes', () => {
    const { app } = setup({ standalone: false });
    expect(() => app.synth()).not.toThrow();
  });

  test('two targets on one core bind two functions', () => {
    const { stack, sandboxes, bind } = setup();
    const ingress = stack.node.findChild('Ingress') as SharedIngress;
    new RunCodeToolTarget(stack, 'RunCodeFiles', { sandboxes, ingress, toolName: 'run-code-files' });
    expect(bind).toHaveBeenCalledTimes(2);
    const targets = Object.values(Template.fromStack(stack).findResources('AWS::BedrockAgentCore::GatewayTarget')).map((t: any) => t.Properties.Name);
    expect(targets.sort()).toEqual(['run-code', 'run-code-files']);
  });
});

describe('the gateway entry stays out of the core', () => {
  const src = path.resolve(__dirname, '..', 'src');

  test('the entry resolves under src/', () => {
    expect(fs.existsSync(handlerEntry(HANDLERS.gatewayRunCode))).toBe(true);
  });

  const lib = path.resolve(__dirname, '..', 'lib');
  (fs.existsSync(path.join(lib, 'handlers')) ? test : test.skip)('the entry is copied into the handler tree after compile', () => {
    expect(fs.existsSync(handlerEntry(HANDLERS.gatewayRunCode, lib))).toBe(true);
  });

  test('the entry bundles with no CDK or construct code in it', async () => {
    const result = await esbuild.build({
      entryPoints: [handlerEntry(HANDLERS.gatewayRunCode)],
      bundle: true,
      platform: 'node',
      target: 'node24',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((f) => f.includes('agentic-runtime-isolation/src/tools/context.ts'))).toBe(true);
    expect(inputs.filter((f) => /aws-cdk-lib|\/constructs\/|\.cdk\.ts$/.test(f))).toEqual([]);
  });

  test('the gateway directory does import the producer, so the lint exemption is not empty', () => {
    const text = fs.readdirSync(path.join(src, 'gateway')).map((f) => fs.readFileSync(path.join(src, 'gateway', f), 'utf8')).join('\n');
    expect(text).toMatch(/from 'agentic-runtime-isolation(\/tools)?'/);
  });

  test('nothing outside src/gateway/ and the demo app files names the producer', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (p === path.join(src, 'gateway')) continue;
          walk(p);
        } else if (p.endsWith('.ts') && !['main.ts', 'demo.cdk.ts'].includes(e.name) && /(from|require\()\s*'agentic-runtime-isolation/.test(fs.readFileSync(p, 'utf8'))) {
          offenders.push(path.relative(src, p));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

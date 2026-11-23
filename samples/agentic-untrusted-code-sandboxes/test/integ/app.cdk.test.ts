// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration app (test/integ.sandboxes.ts) synthesises offline against
 * the real constructs, and publishes every stack output the driver reads. The
 * hooks of ADR-0058 are on the `run-code` reaper and tool functions only.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { logsPoliciesNeeded } from './common';
import { backendOutputKey, outputKey } from './ctx';
import { MAX_INPUT_BYTES_CAP, MAX_OUTPUT_BYTES_CAP } from '../../src/props';
import { createIntegApp } from '../integ.sandboxes';

function synth(): { stack: Stack; template: Template; outputs: Record<string, unknown> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-agent-'));
  writeFileSync(path.join(dir, 'app.js'), '// stub agent\n');
  const app = createIntegApp({ prefix: 'IntegTest', agentCodePath: dir, context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = app.node.findChild('IntegTest') as Stack;
  const template = Template.fromStack(stack);
  return { stack, template, outputs: template.toJSON().Outputs as Record<string, unknown> };
}

describe('the integration app', () => {
  const { template, outputs } = synth();

  test('publishes every output the driver reads', () => {
    const names = ['MintFunction', 'ToolsGatewayUrl', 'EndpointUrl', 'EntitlementsApiUrl', 'QueryLogGroup', 'QueryLogGroupArn', 'OutsideBucket',
      'PresignRoleArn', 'VendorRoleArn', 'NoGrantRoleArn'];
    for (const instance of ['run-code', 'run-code-files'] as const) {
      for (const n of ['Table', 'TableArn', 'Bucket', 'ToolRole', 'ToolTenantRole', 'OffboardFunction', 'ReaperFunction', 'ToolFunction']) names.push(outputKey(instance, n));
    }
    names.push(outputKey('run-code', 'RunCodeFunction'));
    for (const n of names) expect(outputs).toHaveProperty([n]);
    // the per-backend values the driver finds by pattern: image, cluster, task definition, runtime
    const keys = Object.keys(outputs);
    expect(keys.filter((k) => k.startsWith(backendOutputKey('run-code', 'microvm', '')) && /image/i.test(k))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith(backendOutputKey('run-code', 'nitro', '')) && /cluster/i.test(k))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith(backendOutputKey('run-code', 'nitro', '')) && /taskDefinition/i.test(k))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith(backendOutputKey('run-code', 'agentcore', '')) && /runtime/i.test(k))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith(backendOutputKey('run-code-files', 'agentcore', '')) && /runtime/i.test(k))).toHaveLength(1);
  });

  test('the test hooks are on three functions of the run-code instance and nowhere else', () => {
    const fns = Object.entries(template.findResources('AWS::Lambda::Function'));
    const withHook = fns.filter(([, r]) => JSON.stringify(r.Properties).includes('RC_INTEG_OVERRIDES')).map(([id]) => id);
    expect(withHook).toHaveLength(3);
    for (const id of withHook) expect(id).toMatch(/^RunCode(?!Files)/);
    expect(fns.filter(([, r]) => JSON.stringify(r.Properties).includes('RC_INTEG_FAIL_START_TENANT'))).toHaveLength(2);
  });

  test('the reaper schedule is off in both instances, and the key grant of the mint is in the template', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule')).filter((r) => r.Properties.ScheduleExpression !== undefined);
    expect(rules).toHaveLength(2);
    for (const r of rules) expect(r.Properties.State).toBe('DISABLED');
    // the mint's grant on the ingress key: kms:Sign appears in the template (a role policy or the key policy)
    expect(JSON.stringify(template.toJSON())).toContain('kms:Sign');
  });

  test('the presign role may put under integ/ in the outside bucket and nothing else', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((r) => JSON.stringify(r.Properties.Roles).includes('PresignRole'));
    expect(policies).toHaveLength(1);
    const statements = (policies[0].Properties.PolicyDocument as { Statement: Array<{ Action: string }> }).Statement;
    expect(statements.map((s) => s.Action)).toEqual(['s3:PutObject']);
  });

  test('the second instance has the firewall off and session files on', () => {
    const groups = Object.values(template.findResources('AWS::Route53Resolver::FirewallRuleGroup'));
    expect(groups).toHaveLength(1);
  });

  test('the Logs resource policies of the template are the number the precheck asks to be free', () => {
    expect(logsPoliciesNeeded()).toBe(3);
    expect(Object.keys(template.findResources('AWS::Logs::ResourcePolicy'))).toHaveLength(logsPoliciesNeeded());
  });

  test('the run-code instance has the input and output sizes at their caps', () => {
    const fns = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([id]) => /^RunCode(?!Files)/.test(id))
      .map(([, r]) => (r.Properties.Environment?.Variables ?? {}) as Record<string, string>)
      .filter((v) => v.MAX_INPUT_BYTES !== undefined);
    expect(fns.length).toBeGreaterThan(0);
    for (const v of fns) {
      expect(v.MAX_INPUT_BYTES).toBe(String(MAX_INPUT_BYTES_CAP));
      expect(v.MAX_OUTPUT_BYTES).toBe(String(MAX_OUTPUT_BYTES_CAP));
    }
  });
});

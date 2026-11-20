// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Spec §8 step `synth`: two construct instances in one stack (the shape of
 * the integration stack). Every explicit name of spec §5.3 is unique and
 * matches its service's charset, the drain role may deregister container
 * instances and the reaper role may not, and the offboard function runs as
 * the reaper role. Run by the build and, as the `synth` step, by the driver
 * before it deploys.
 */

import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { UntrustedCodeSandboxes } from '../../src/untrusted-code-sandboxes.cdk';

/** Resource type, name property, and the charset and length of spec §5.3. */
const NAMED: ReadonlyArray<{ type: string; props: string[]; pattern: RegExp }> = [
  { type: 'AWS::BedrockAgentCore::Runtime', props: ['AgentRuntimeName'], pattern: /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/ },
  { type: 'AWS::ECR::Repository', props: ['RepositoryName'], pattern: /^[a-z0-9._/-]{1,256}$/ },
  { type: 'AWS::ECS::Cluster', props: ['ClusterName'], pattern: /^[a-zA-Z0-9_-]{1,255}$/ },
  { type: 'AWS::ECS::CapacityProvider', props: ['Name'], pattern: /^[a-zA-Z0-9_-]{1,255}$/ },
  { type: 'AWS::Lambda::MicrovmImage', props: ['Name', 'ImageName'], pattern: /^[a-zA-Z0-9_-]{1,64}$/ },
  { type: 'AWS::Lambda::NetworkConnector', props: ['Name', 'ConnectorName'], pattern: /^[a-zA-Z0-9_-]{1,64}$/ },
  { type: 'AWS::Logs::LogGroup', props: ['LogGroupName'], pattern: /^[\w./#-]{1,512}$/ },
  { type: 'AWS::Logs::DeliverySource', props: ['Name'], pattern: /^[\w-]{1,60}$/ },
  { type: 'AWS::Logs::DeliveryDestination', props: ['Name'], pattern: /^[\w-]{1,60}$/ },
  { type: 'AWS::CloudWatch::InsightRule', props: ['RuleName'], pattern: /^.{1,128}$/ },
  { type: 'AWS::Route53Resolver::FirewallDomainList', props: ['Name'], pattern: /^[\w-]{1,64}$/ },
  { type: 'AWS::Route53Resolver::FirewallRuleGroup', props: ['Name'], pattern: /^[\w-]{1,64}$/ },
  { type: 'AWS::Route53Resolver::ResolverQueryLoggingConfig', props: ['Name'], pattern: /^[\w-]{1,64}$/ },
  { type: 'AWS::Logs::ResourcePolicy', props: ['PolicyName'], pattern: /^[\w-]{1,255}$/ },
];

function twoInstances(): Template {
  const stack = new Stack(new App(), 'Integ');
  const common = { runTimeout: Duration.seconds(20), startWait: Duration.seconds(15), sandboxIdle: Duration.minutes(2), standalone: true };
  new UntrustedCodeSandboxes(stack, 'RunCode', { ...common, backends: ['microvm', 'nitro', 'agentcore'], dnsFirewall: true });
  new UntrustedCodeSandboxes(stack, 'RunCodeFiles', { ...common, backends: ['agentcore'], agentcore: { sessionFiles: true } });
  return Template.fromStack(stack);
}

describe('two construct instances in one stack (spec §8 synth)', () => {
  const t = twoInstances();
  const resources = t.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>;

  test.each(NAMED)('$type names are unique and match their charset', ({ type, props, pattern }) => {
    const names: string[] = [];
    for (const r of Object.values(resources).filter((x) => x.Type === type)) {
      for (const p of props) {
        const v = r.Properties?.[p];
        if (typeof v === 'string') names.push(v);
        else if (v !== undefined) throw new Error(`${type}.${p} is not a plain string: ${JSON.stringify(v)} (spec §5.3 names are known at synth)`);
      }
    }
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(pattern);
  });

  test('both instances create their own resources of each kind', () => {
    const count = (type: string) => Object.values(resources).filter((r) => r.Type === type).length;
    expect(count('AWS::BedrockAgentCore::Runtime')).toBe(2);
    expect(count('AWS::EC2::VPC')).toBe(2);
  });

  const roleOf = (policy: { Properties?: Record<string, unknown> }): string[] =>
    ((policy.Properties?.Roles ?? []) as Array<{ Ref?: string }>).map((r) => r.Ref ?? '');
  const policiesWith = (action: string) => Object.values(resources).filter((r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties).includes(`"${action}"`));

  test('the drain role may deregister container instances on the cluster, and the reaper role may not', () => {
    const policies = policiesWith('ecs:DeregisterContainerInstance');
    expect(policies.length).toBeGreaterThan(0);
    const roles = policies.flatMap(roleOf);
    expect(roles.length).toBeGreaterThan(0);
    for (const r of roles) {
      expect(r).toMatch(/drain/i);
      expect(r).not.toMatch(/reaper/i);
    }
    // on the cluster ARN, not a wildcard
    expect(JSON.stringify(policies)).not.toMatch(/"Resource":"\*"[^}]*DeregisterContainerInstance/);
  });

  test('the offboard function runs as the reaper role', () => {
    const offboard = Object.entries(resources).filter(([id, r]) => r.Type === 'AWS::Lambda::Function' && /offboard/i.test(id));
    expect(offboard.length).toBe(2);
    for (const [, r] of offboard) {
      const role = (r.Properties?.Role as { 'Fn::GetAtt'?: string[] })['Fn::GetAtt']?.[0] ?? '';
      expect(role).toMatch(/reaper/i);
      expect(role).not.toMatch(/drain/i);
    }
  });
});

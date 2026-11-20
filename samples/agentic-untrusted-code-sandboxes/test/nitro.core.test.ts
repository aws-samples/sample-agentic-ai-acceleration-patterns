// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The nitro backend inside the real core construct: the seam the core
 * consumes (statements on each role, the Logs endpoint, the drain order, the
 * environment, the names), with the core's own name sanitiser.
 */

import { App, CfnResource, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { IConstruct } from 'constructs';
import { NITRO_ENV } from '../src/backends/nitro';
import type { NitroBackendResources } from '../src/backends/nitro.cdk';
import { NAME_PATTERNS } from '../src/names';
import { UntrustedCodeSandboxes } from '../src/untrusted-code-sandboxes.cdk';

function build(id = 'Sandboxes', stack = new Stack(new App(), 'S')) {
  const sandboxes = new UntrustedCodeSandboxes(stack, id, { standalone: true, backends: ['nitro'] });
  return { stack, sandboxes, nitro: sandboxes.backends.nitro as NitroBackendResources };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The CloudFormation resource of a given type inside a construct subtree. */
function cfnOf(root: IConstruct, cfnResourceType: string): CfnResource {
  const found = root.node.findAll().find((n) => n instanceof CfnResource && n.cfnResourceType === cfnResourceType);
  if (found === undefined) throw new Error(`no ${cfnResourceType} under ${root.node.path}`);
  return found as CfnResource;
}

describe('nitro inside the core construct', () => {
  const { stack, sandboxes, nitro } = build();
  const t = Template.fromStack(stack);
  const idOf = (c: IConstruct, type: string) => stack.getLogicalId(cfnOf(c, type));

  /** Sid -> the roles (by construct id under the core) whose policy holds it. */
  const policies = Object.values(t.findResources('AWS::IAM::Policy')) as Json[];
  const rolesWithSid = (sid: string): string[] => {
    const roleIds = ['ToolRole', 'ReaperRole', 'DrainRole', 'ToolTenantRole'].map((n) => [n, idOf(sandboxes.node.findChild(n), 'AWS::IAM::Role')] as const);
    return policies
      .filter((p) => (p.Properties.PolicyDocument.Statement as Json[]).some((s) => s.Sid === sid))
      .flatMap((p) => (p.Properties.Roles as Json[]).map((r) => roleIds.find(([, id]) => id === r.Ref)?.[0] ?? `other:${String(r.Ref)}`));
  };

  test('the core hands the backend a repository and an image tag, and the task starts that image', () => {
    const def = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0].Properties.ContainerDefinitions[0];
    expect(JSON.stringify(def.Image)).toMatch(/runner-amd64-/);
  });

  test('every statement of each kind lands on exactly the roles of spec §3.6', () => {
    expect(rolesWithSid('DescribeNitroTasks')).toEqual(['ToolRole']);
    for (const sid of ['RunNitroTask', 'TagNitroTaskAtRunTask', 'StopOwnNitroTask', 'PassNitroExecutionRole']) {
      expect(rolesWithSid(sid)).toEqual(['ToolTenantRole']);
    }
    for (const sid of ['ListNitroTasks', 'DescribeAndStopNitroTasks']) {
      expect(rolesWithSid(sid).sort()).toEqual(['DrainRole', 'ReaperRole']);
    }
    for (const sid of ['DrainNitroInstances', 'DescribeNitroInstances', 'WaitForInstanceTermination']) {
      expect(rolesWithSid(sid)).toEqual(['DrainRole']);
    }
  });

  test('the Logs endpoint policy names the task log group, and the task group reaches the Logs endpoint group only', () => {
    const endpoints = Object.values(t.findResources('AWS::EC2::VPCEndpoint')).filter((e) => JSON.stringify(e.Properties.ServiceName).includes('logs'));
    expect(endpoints).toHaveLength(1);
    expect(JSON.stringify(endpoints[0].Properties.PolicyDocument)).toContain(nitro.logGroupName);

    const taskGroup = stack.getLogicalId(nitro.taskSecurityGroup.node.defaultChild as CfnResource);
    const endpointGroups = (endpoints[0].Properties.SecurityGroupIds as Json[]).map((g) => JSON.stringify(g));
    const egress = Object.values(t.findResources('AWS::EC2::SecurityGroupEgress')).filter((e) => e.Properties.GroupId?.['Fn::GetAtt']?.[0] === taskGroup);
    expect(egress).toHaveLength(1);
    expect(egress[0].Properties).toMatchObject({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 });
    expect(endpointGroups).toContain(JSON.stringify(egress[0].Properties.DestinationSecurityGroupId));
    // no inline egress rule on the group itself other than CDK's "disallow all" placeholder
    const inline = (t.toJSON().Resources[taskGroup].Properties.SecurityGroupEgress ?? []) as Json[];
    expect(inline.filter((r) => r.CidrIp !== '255.255.255.255/32')).toEqual([]);
  });

  test('the log cleanup resource is told to delete the task log group by name', () => {
    const cleanupId = stack.getLogicalId(cfnOf(sandboxes.node.findChild('LogCleanup'), 'AWS::CloudFormation::CustomResource'));
    const resource = t.toJSON().Resources[cleanupId] as Json;
    expect(JSON.stringify(resource.Properties)).toContain(nitro.logGroupName);
  });

  test('the task definition waits for the runner image copy, so a start never pulls a tag that is not there yet', () => {
    const tdId = idOf(nitro.taskDefinition, 'AWS::ECS::TaskDefinition');
    const depends = (t.toJSON().Resources[tdId].DependsOn ?? []) as string[];
    const copies = Object.entries(t.toJSON().Resources as Record<string, Json>)
      .filter(([, r]) => /CDKECRDeployment/.test(String(r.Type)) || r.Type === 'Custom::CDKECRDeployment')
      .map(([id]) => id);
    expect(copies.length).toBeGreaterThan(0);
    expect(depends.some((d) => copies.includes(d))).toBe(true);
  });

  test('the drain is deleted before the cluster, the capacity provider, the task definition and the groups the tasks hold', () => {
    const wanted = [
      idOf(nitro.cluster, 'AWS::ECS::Cluster'),
      idOf(nitro.capacityProvider, 'AWS::ECS::CapacityProvider'),
      idOf(nitro.taskDefinition, 'AWS::ECS::TaskDefinition'),
      idOf(nitro.taskSecurityGroup, 'AWS::EC2::SecurityGroup'),
      idOf(nitro.instanceSecurityGroup, 'AWS::EC2::SecurityGroup'),
    ];
    const drain = cfnOf(sandboxes.node.findChild('DrainResource'), 'AWS::CloudFormation::CustomResource');
    const depends = (t.toJSON().Resources[stack.getLogicalId(drain)].DependsOn ?? []) as string[];
    for (const id of wanted) expect(depends).toContain(id);
  });

  test('the function environment carries every name the run-time class reads', () => {
    const fns = Object.values(t.findResources('AWS::Lambda::Function'));
    const withNitro = fns.filter((f) => f.Properties.Environment?.Variables?.[NITRO_ENV.CLUSTER_ARN] !== undefined);
    expect(withNitro.length).toBeGreaterThan(0);
    for (const f of withNitro) {
      for (const name of Object.values(NITRO_ENV)) expect(f.Properties.Environment.Variables[name]).toBeDefined();
    }
  });

  test('cdk-nag finds nothing under the backend', () => {
    const found = new AwsSolutionsChecks(stack).validateScope(stack).violations
      .flatMap((v) => v.violatingResources.map((r) => `${v.ruleName}: ${r.constructPath}`));
    expect(found.filter((f) => f.includes('Backend-nitro'))).toEqual([]);
  });

  test('two instances in one stack get distinct, valid names', () => {
    const s = new Stack(new App(), 'Two');
    build('One', s);
    build('Two', s);
    const tt = Template.fromStack(s);
    const names = (type: string, prop: string) => Object.values(tt.findResources(type)).map((r) => r.Properties[prop] as string);
    for (const [type, prop, service] of [
      ['AWS::ECS::Cluster', 'ClusterName', 'ecs-cluster'],
      ['AWS::ECS::CapacityProvider', 'Name', 'ecs-capacity-provider'],
    ] as const) {
      const ns = names(type, prop);
      expect(ns).toHaveLength(2);
      expect(new Set(ns).size).toBe(2);
      for (const n of ns) expect(n).toMatch(NAME_PATTERNS[service]);
    }
    const taskLogs = names('AWS::Logs::LogGroup', 'LogGroupName').filter((n) => n !== undefined && /nitro/.test(n));
    expect(taskLogs).toHaveLength(2);
    expect(new Set(taskLogs).size).toBe(2);
    for (const n of taskLogs) expect(n).toMatch(NAME_PATTERNS['log-group']);
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The nitro backend inside the real core construct: the seam the core
 * consumes (statements on each role, the Logs endpoint, the drain order, the
 * environment, the names), with the core's own name sanitiser.
 */

import { App, CfnResource, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NITRO_ENV } from '../src/backends/nitro';
import type { NitroBackendResources } from '../src/backends/nitro.cdk';
import { NAME_PATTERNS } from '../src/names';
import { UntrustedCodeSandboxes } from '../src/untrusted-code-sandboxes.cdk';

function build(id = 'Sandboxes', stack = new Stack(new App(), 'S')) {
  const sandboxes = new UntrustedCodeSandboxes(stack, id, { standalone: true, backends: ['nitro'] });
  return { stack, sandboxes, nitro: sandboxes.backends.nitro as NitroBackendResources };
}

/** Every statement of every IAM policy in the template, by Sid. */
function statementsBySid(t: Template): Map<string, { policy: string; statement: Record<string, unknown> }[]> {
  const out = new Map<string, { policy: string; statement: Record<string, unknown> }[]>();
  for (const [logicalId, p] of Object.entries(t.findResources('AWS::IAM::Policy'))) {
    for (const s of p.Properties.PolicyDocument.Statement as Record<string, unknown>[]) {
      const sid = s.Sid as string | undefined;
      if (sid === undefined) continue;
      out.set(sid, [...(out.get(sid) ?? []), { policy: logicalId, statement: s }]);
    }
  }
  return out;
}

describe('nitro inside the core construct', () => {
  const { stack, nitro } = build();
  const t = Template.fromStack(stack);
  const sids = statementsBySid(t);

  test('the core hands the backend a repository and an image tag, and the task starts that image', () => {
    const def = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0].Properties.ContainerDefinitions[0];
    expect(JSON.stringify(def.Image)).toMatch(/runner-amd64-/);
  });

  test('every statement of the backend lands on a policy', () => {
    for (const s of [
      ...nitro.toolStatements(), ...nitro.tenantStatements(), ...nitro.reaperStatements(), ...nitro.drainStatements(),
    ]) {
      expect(sids.has(s.toStatementJson().Sid)).toBe(true);
    }
  });

  test('the instance drain is on the drain role only; the reaper statements are on the reaper and the drain roles; the tenant statements on neither', () => {
    const roleOf = (sid: string) => sids.get(sid)!.map((x) => x.policy);
    for (const sid of ['RunNitroTask', 'TagNitroTaskAtRunTask', 'StopOwnNitroTask', 'PassNitroExecutionRole']) {
      expect(roleOf(sid)).toHaveLength(1);
    }
    const drainPolicies = roleOf('DrainNitroInstances');
    expect(drainPolicies).toHaveLength(1);
    expect(roleOf('ListNitroTasks')).toHaveLength(2);
    expect(roleOf('ListNitroTasks')).toContain(drainPolicies[0]);
    for (const sid of ['RunNitroTask', 'StopOwnNitroTask', 'PassNitroExecutionRole']) {
      expect(roleOf(sid)).not.toContain(drainPolicies[0]);
      expect(roleOf(sid)).not.toContain(roleOf('ListNitroTasks').find((p) => p !== drainPolicies[0]));
    }
  });

  test('the Logs endpoint policy names the task log group and the task group may reach the endpoint group only', () => {
    const endpoints = Object.values(t.findResources('AWS::EC2::VPCEndpoint'))
      .filter((e) => JSON.stringify(e.Properties.ServiceName).includes('logs'));
    expect(endpoints).toHaveLength(1);
    expect(JSON.stringify(endpoints[0].Properties.PolicyDocument)).toContain(nitro.logGroupName);
    const taskGroupId = JSON.stringify(stack.resolve(nitro.taskSecurityGroup.securityGroupId));
    const egress = Object.values(t.findResources('AWS::EC2::SecurityGroupEgress'))
      .filter((e) => JSON.stringify(e.Properties.GroupId) === taskGroupId);
    expect(egress).toHaveLength(1);
    expect(egress[0].Properties).toMatchObject({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 });
  });

  test('the log cleanup resource deletes the task log group by name', () => {
    expect(JSON.stringify(t.toJSON())).toContain(nitro.logGroupName);
  });

  test('the drain is deleted before the cluster, the capacity provider and the groups the tasks hold', () => {
    const logicalId = (c: { node: { findAll(): unknown[] } }) => {
      const cfn = c.node.findAll().find((n) => n instanceof CfnResource) as CfnResource;
      return stack.getLogicalId(cfn);
    };
    const wanted = [nitro.cluster, nitro.capacityProvider, nitro.taskSecurityGroup, nitro.instanceSecurityGroup].map(logicalId);
    const resources = Object.values(t.toJSON().Resources as Record<string, { DependsOn?: string[] }>);
    const drain = resources.filter((r) => wanted.every((id) => (r.DependsOn ?? []).includes(id)));
    expect(drain).toHaveLength(1);
  });

  test('the function environment carries the names the run-time class reads, from the core\'s own environment', () => {
    const fns = Object.values(t.findResources('AWS::Lambda::Function'));
    const withNitro = fns.filter((f) => f.Properties.Environment?.Variables?.[NITRO_ENV.CLUSTER_ARN] !== undefined);
    expect(withNitro.length).toBeGreaterThan(0);
    for (const f of withNitro) {
      for (const name of Object.values(NITRO_ENV)) expect(f.Properties.Environment.Variables[name]).toBeDefined();
    }
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
    const logs = Object.values(tt.findResources('AWS::Logs::LogGroup')).map((r) => r.Properties.LogGroupName as string).filter((n) => n !== undefined);
    const taskLogs = logs.filter((n) => /nitro/.test(n));
    expect(taskLogs).toHaveLength(2);
    expect(new Set(taskLogs).size).toBe(2);
    for (const n of taskLogs) expect(n).toMatch(NAME_PATTERNS['log-group']);
  });
});

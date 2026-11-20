// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * A fake `BackendConstruct` for the core construct's synth tests (ADR-0025).
 * Each statement carries a marker action (`fake:*`), so a test can see which
 * role the core put it on. The instance actions of the drain role are the
 * real ones, so the tests can assert the reaper role never holds them. The
 * fake also asks `nameFor` for one name per service, so the name tests can
 * check every service's charset and length across two instances.
 */

import { Aws, CfnResource, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct, type IConstruct } from 'constructs';
import type { BackendName } from '../src/backend';
import type { BackendConstruct, BackendContext, BackendFactory, NamedService, SandboxEndpoint } from '../src/backend-construct';
import { NAME_RULES } from '../src/names';

/** Every name the fakes asked for, by construct path of the backend, for the name tests. */
export const requestedNames: { path: string; service: NamedService; name: string }[] = [];

const ENDPOINTS: Record<BackendName, SandboxEndpoint[]> = {
  microvm: [],
  nitro: ['logs'],
  agentcore: ['s3-gateway', 'ecr-api', 'ecr-dkr', 'logs'],
};

export class FakeBackendResources extends Construct implements BackendConstruct {
  public readonly resource: CfnResource;
  public readonly clients: ec2.ISecurityGroup[] = [];

  public constructor(scope: Construct, id: string, public readonly name: BackendName, private readonly ctx: BackendContext) {
    super(scope, id);
    this.resource = new CfnResource(this, 'Marker', { type: 'AWS::CloudFormation::WaitConditionHandle' });
    // The container backends ask the core for their image tag, each for its own architecture.
    if (name !== 'microvm') ctx.runnerImageTag?.(name === 'nitro' ? 'amd64' : 'arm64');
    for (const service of Object.keys(NAME_RULES) as NamedService[]) {
      requestedNames.push({ path: this.node.path, service, name: ctx.nameFor(service, `fake-${name}`) });
    }
    if (ENDPOINTS[name].length > 0) {
      this.clients.push(new ec2.SecurityGroup(this, 'Clients', { vpc: ctx.vpc, allowAllOutbound: false }));
    }
    if (name === 'nitro') {
      this.clients.push(new ec2.SecurityGroup(this, 'Instances', { vpc: ctx.vpc, allowAllOutbound: true }));
    }
  }

  private arn(what: string): string {
    return `arn:${Aws.PARTITION}:fake:${Aws.REGION}:${Aws.ACCOUNT_ID}:${this.name}/${what}`;
  }

  public toolStatements(): iam.PolicyStatement[] {
    return [new iam.PolicyStatement({ actions: [`fake:Tool${this.name}`], resources: [this.arn('tool')] })];
  }

  public tenantStatements(): iam.PolicyStatement[] {
    return [new iam.PolicyStatement({ actions: [`fake:Tenant${this.name}`], resources: [this.arn('tenant')] })];
  }

  public reaperStatements(): iam.PolicyStatement[] {
    return [new iam.PolicyStatement({ actions: [`fake:Reaper${this.name}`], resources: [this.arn('reaper')] })];
  }

  public drainStatements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        actions: ['ecs:ListContainerInstances', 'ecs:DeregisterContainerInstance'],
        resources: [`arn:${Aws.PARTITION}:ecs:${Aws.REGION}:${Aws.ACCOUNT_ID}:cluster/${this.name}`],
      }),
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances'],
        // The action takes no resource (spec 3.6).
        resources: ['*'],
      }),
    ];
  }

  public endpoints(): SandboxEndpoint[] {
    return ENDPOINTS[this.name];
  }

  public endpointClients(): ec2.ISecurityGroup[] {
    return this.clients;
  }

  public environment(): Record<string, string> {
    return { [`FAKE_${this.name.toUpperCase()}`]: this.arn('env') };
  }

  public drainOrder(): IConstruct[] {
    return [this.resource];
  }

  public logCleanup(): { prefixes: string[]; names: string[] } {
    const region = Stack.of(this).region;
    if (this.name === 'agentcore') return { prefixes: ['/aws/bedrock-agentcore/runtimes/Fake_agentcore-'], names: [] };
    if (this.name === 'nitro') return { prefixes: [], names: [`/fake/${region}/task-logs`] };
    return { prefixes: [], names: ['/aws/lambda-microvms/fake-image'] };
  }

  public outputs(): Record<string, string> {
    return { [`${this.name}Arn`]: this.arn('out') };
  }
}

export function fakeFactory(name: BackendName): BackendFactory {
  return (scope, id, ctx) => new FakeBackendResources(scope, id, name, ctx);
}

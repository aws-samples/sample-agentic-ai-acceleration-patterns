// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CDK side of the `agentcore` backend: the V2 runtime in VPC mode, its role and security group, the usage-log delivery.
 *
 * Stub from the scaffold (ADR-0025): it creates nothing and grants nothing,
 * so the core construct synthesises before the backend exists. The agentcore
 * backend worker owns this file.
 */

import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { Construct, type IConstruct } from 'constructs';
import type { BackendConstruct, BackendContext, SandboxEndpoint } from '../backend-construct';

export class AgentcoreBackendResources extends Construct implements BackendConstruct {
  public readonly name = 'agentcore' as const;

  public constructor(scope: Construct, id: string, public readonly ctx: BackendContext) {
    super(scope, id);
  }

  public toolStatements(): iam.PolicyStatement[] {
    return [];
  }

  public tenantStatements(): iam.PolicyStatement[] {
    return [];
  }

  public reaperStatements(): iam.PolicyStatement[] {
    return [];
  }

  public drainStatements(): iam.PolicyStatement[] {
    return [];
  }

  public endpoints(): SandboxEndpoint[] {
    return [];
  }

  public endpointClients(): ec2.ISecurityGroup[] {
    return [];
  }

  public environment(): Record<string, string> {
    return {};
  }

  public drainOrder(): IConstruct[] {
    return [];
  }

  public logCleanup(): { prefixes: string[]; names: string[] } {
    return { prefixes: [], names: [] };
  }
}

export function createAgentcoreBackend(scope: Construct, id: string, ctx: BackendContext): BackendConstruct {
  return new AgentcoreBackendResources(scope, id, ctx);
}

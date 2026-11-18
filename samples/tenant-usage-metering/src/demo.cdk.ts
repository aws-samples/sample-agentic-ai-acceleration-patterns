// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack: one `TenantUsageMetering` with a stand-in registrar and
 * operator role, which the integration test assumes until the control
 * plane's hooks are released (spec §6.4). Both roles trust only this
 * account, and a principal there needs `sts:AssumeRole` on them.
 */

import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { IngestPath } from './construct/props';
import { TenantUsageMetering } from './tenant-usage-metering';

export interface DemoContext {
  readonly fleetName: string;
  readonly ingestPath: IngestPath;
}

export function parseDemoContext(get: (key: string) => unknown): DemoContext {
  const fleetName = (get('fleetName') as string | undefined) ?? 'demo';
  const ingestPath = ((get('ingestPath') as string | undefined) ?? 'BUS') as IngestPath;
  return { fleetName, ingestPath };
}

export interface DemoStackProps extends StackProps {
  readonly context: DemoContext;
}

export class TenantUsageMeteringDemoStack extends Stack {
  public readonly metering: TenantUsageMetering;

  constructor(scope: Construct, id: string, props: DemoStackProps) {
    super(scope, id, props);
    const account = new iam.AccountPrincipal(this.account);
    const registrar = new iam.Role(this, 'DemoRegistrar', {
      assumedBy: account,
      description: 'Stand-in for the control plane global hook (spec §6.4)',
    });
    const operator = new iam.Role(this, 'DemoOperator', {
      assumedBy: account,
      description: 'Metering operator for the integration test',
    });

    this.metering = new TenantUsageMetering(this, 'Metering', {
      fleetName: props.context.fleetName,
      ingestPath: props.context.ingestPath,
      registrarPrincipalArns: [registrar.roleArn],
      operatorPrincipalArns: [operator.roleArn],
    });

    new CfnOutput(this, 'UsageBusArn', { value: this.metering.usageBusArn });
    if (this.metering.ingestBusArn !== undefined) {
      new CfnOutput(this, 'IngestBusArn', { value: this.metering.ingestBusArn });
    }
    new CfnOutput(this, 'RawBucketName', { value: this.metering.rawBucket.bucketName });
    new CfnOutput(this, 'TableName', { value: this.metering.table.tableName });
    new CfnOutput(this, 'RegistrarRoleArn', { value: registrar.roleArn });
    new CfnOutput(this, 'OperatorRoleArn', { value: operator.roleArn });
  }
}

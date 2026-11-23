// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The observability sink of the run dashboard (stress ADR-0022, docs/stress-dashboard.design.md
 * §8, §11): a fixture of the platform account, made once per Region by the account's owner. It
 * holds no data and costs nothing idle. Its policy names the cell account ids and allows only the
 * metric resource type, so no third account can link to it. The cell accounts' links
 * (`CellAccountBaseStack`, `observabilitySinkArn`) point at it.
 */

import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as oam from 'aws-cdk-lib/aws-oam';
import type { Construct } from 'constructs';

/** The sink's name: one sink exists per account and Region. */
export const SINK_NAME = 'StressRunSink';

export interface RunSinkStackProps extends StackProps {
  /** The cell account ids that may link to the sink. */
  readonly cellAccountIds: readonly string[];
}

export class RunSinkStack extends Stack {
  readonly sink: oam.CfnSink;

  constructor(scope: Construct, id: string, props: RunSinkStackProps) {
    super(scope, id, props);
    if (props.cellAccountIds.length === 0 || !props.cellAccountIds.every((a) => /^[0-9]{12}$/.test(a))) {
      throw new Error('cellAccountIds must list one or more 12-digit account ids');
    }
    this.sink = new oam.CfnSink(this, 'Sink', {
      name: SINK_NAME,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: [...props.cellAccountIds] },
            Resource: '*',
            Action: ['oam:CreateLink', 'oam:UpdateLink'],
            Condition: { 'ForAllValues:StringEquals': { 'oam:ResourceTypes': ['AWS::CloudWatch::Metric'] } },
          },
        ],
      },
    });
    new CfnOutput(this, 'SinkArn', { value: this.sink.attrArn });
  }
}

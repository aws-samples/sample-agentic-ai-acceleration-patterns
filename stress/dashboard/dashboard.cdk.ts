// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The run dashboard (stress ADR-0022, docs/stress-dashboard.design.md §8): one stack with one
 * `AWS::CloudWatch::Dashboard` and nothing else. No function, role, log group or custom resource,
 * so CloudFormation deletes all of it and a run leaves nothing the dashboard owned.
 */

import { Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type { Construct } from 'constructs';
import { type DashboardPlan, dashboardBody } from './widgets';
import { dashboardName } from '../src/metrics';

export interface RunDashboardStackProps extends StackProps {
  readonly prefix: string;
  readonly plan: DashboardPlan;
}

export class RunDashboardStack extends Stack {
  constructor(scope: Construct, id: string, props: RunDashboardStackProps) {
    super(scope, id, props);
    new cloudwatch.CfnDashboard(this, 'Dashboard', {
      dashboardName: dashboardName(props.prefix),
      dashboardBody: JSON.stringify(dashboardBody(props.plan)),
    });
  }
}

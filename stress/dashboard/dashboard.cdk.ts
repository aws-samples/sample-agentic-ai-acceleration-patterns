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

/**
 * The tag every run dashboard stack carries. `dashboard.sh` updates and deletes a stack of the
 * dashboard's name only when it has this tag, so a stack of another kind with that name is never touched.
 */
export const DASHBOARD_TAG = { key: 'stress:part', value: 'run-dashboard' } as const;

export class RunDashboardStack extends Stack {
  constructor(scope: Construct, id: string, props: RunDashboardStackProps) {
    super(scope, id, { ...props, tags: { ...props.tags, [DASHBOARD_TAG.key]: DASHBOARD_TAG.value } });
    new cloudwatch.CfnDashboard(this, 'Dashboard', {
      dashboardName: dashboardName(props.prefix),
      dashboardBody: JSON.stringify(dashboardBody(props.plan)),
    });
  }
}

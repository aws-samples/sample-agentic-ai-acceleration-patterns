// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The edge logging stack (spec §3.1, ADR-0010): CloudFront standard
 * logging v2 for the distribution, in `us-east-1`, because a CloudWatch
 * Logs delivery cannot cross Regions and its destination must sit in its
 * log group's Region (spike S-1). Deployed after the main stack.
 */

import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * The delivery's record fields: exactly the ones the per-tenant telemetry
 * reads (ADR-0010), a closed list. `cs-uri-query`, `cs(Referer)` and
 * `cs(Cookie)` are never in it: the sign-in host's query and a `/callback`
 * page's referrer carry authorization codes (M-21).
 */
export const ACCESS_LOG_FIELDS: readonly string[] = [
  'timestamp(ms)',
  'x-edge-location',
  'x-host-header',
  'distribution-tenant-id',
  'cs-method',
  'cs-uri-stem',
  'sc-status',
  'sc-bytes',
  'time-taken',
  'x-edge-result-type',
  'x-edge-request-id',
  'cs-protocol',
  'ssl-protocol',
  'viewer-request-log-data',
];

/** Fields the delivery must never carry (§3.1). */
export const FORBIDDEN_LOG_FIELDS: readonly string[] = ['cs-uri-query', 'cs(Referer)', 'cs(Cookie)'];

export interface EdgeLoggingStackProps extends StackProps {
  /** The multi-tenant distribution, from the main stack. */
  readonly distributionArn: string;
}

export class EdgeLoggingStack extends Stack {
  /** The log group of the access log, in `us-east-1`. */
  public readonly logGroupName: string;

  constructor(scope: Construct, id: string, props: EdgeLoggingStackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, 'AccessLog', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    this.logGroupName = logGroup.logGroupName;

    // Delivery names are unique per account and Region, at most 60 characters.
    const name = this.stackName.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 50);
    const source = new logs.CfnDeliverySource(this, 'Source', {
      name: `${name}-source`,
      logType: 'ACCESS_LOGS',
      resourceArn: props.distributionArn,
    });
    const destination = new logs.CfnDeliveryDestination(this, 'Destination', {
      name: `${name}-dest`,
      destinationResourceArn: logGroup.logGroupArn,
      outputFormat: 'json',
    });
    const delivery = new logs.CfnDelivery(this, 'Delivery', {
      deliverySourceName: source.name,
      deliveryDestinationArn: destination.attrArn,
      recordFields: [...ACCESS_LOG_FIELDS],
    });
    delivery.node.addDependency(source);
  }
}

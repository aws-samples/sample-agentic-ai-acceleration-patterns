// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The deploy-time bus share guard (ADR-0006, M-6): a custom resource that
 * reads the registry on Create and Update and fails the deploy when an
 * account the buses are shared with holds a registered emitter
 * (src/guard/share-guard.ts). The AWS RAM shares depend on it, so a failed
 * check stops the deploy before a share changes, rather than shrinking it.
 *
 * The guard depends on the admin function, so the function's block list
 * (`PutEmitter` refuses emitters in listed accounts) is live before the
 * check reads the registry.
 *
 * shortcut: the check reads the `list-by-type` index, which is eventually
 * consistent. A `PutEmitter` that succeeded just before the block list
 * went live may not be in the index yet when the check reads it (index
 * propagation lag, normally under a second), and is not caught; the next
 * deploy that changes a list catches it. A stricter version would block the
 * account in one deploy and share in a second.
 */

import { CustomResource, Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { createFunction } from './functions';
import { ENV } from '../shared/env';
import { LIST_BY_TYPE_INDEX } from '../shared/keys';
import { acknowledgeGranularFinding } from '../shared/nag';

/** The construct id of the provider; the wildcard acknowledgment matches on it. */
export const SHARE_GUARD_PROVIDER_ID = 'BusShareGuardProvider';

export function createShareGuard(scope: Construct, table: dynamodb.TableV2, accountIds: ReadonlyArray<string>): CustomResource {
  const role = new iam.Role(scope, 'BusShareGuardRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: 'tenant-usage-metering bus share guard: reads the emitter list (ADR-0006)',
  });
  // Read only, and only the index that lists the emitters.
  role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [`${table.tableArn}/index/${LIST_BY_TYPE_INDEX}`] }));

  const fn = createFunction(scope, 'BusShareGuardFunction', {
    entry: 'guard/share-guard.function.ts',
    role,
    timeout: Duration.minutes(2),
    environment: { [ENV.tableName]: table.tableName },
    logRetention: logs.RetentionDays.ONE_MONTH,
    description: 'tenant-usage-metering bus share guard (ADR-0006)',
  });

  const providerLogs = new logs.LogGroup(scope, `${SHARE_GUARD_PROVIDER_ID}Logs`, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  const provider = new cr.Provider(scope, SHARE_GUARD_PROVIDER_ID, { onEventHandler: fn, logGroup: providerLogs });
  acknowledgeGranularFinding(
    provider,
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    "The custom-resource provider framework's role takes the logs-only managed policy from CDK; the sample does not own the framework (ADR-0006).",
  );
  Validations.of(provider).acknowledge({
    id: 'AwsSolutions-L1',
    reason: "The custom-resource provider framework's function runtime is chosen by CDK, not by the sample (ADR-0006).",
  });

  return new CustomResource(scope, 'BusShareGuard', {
    serviceToken: provider.serviceToken,
    resourceType: 'Custom::BusShareGuard',
    // The list is the resource's only property, so a change to it re-runs the check.
    properties: { AccountIds: [...new Set(accountIds)].sort() },
  });
}

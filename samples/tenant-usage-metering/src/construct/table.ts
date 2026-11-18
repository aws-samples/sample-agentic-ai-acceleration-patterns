// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The one table (spec §4): registry, meters, sinks, hours, jobs and usage
 * records, single-table on `PK`/`SK`. PITR on, TTL on `expiresAt`, a stream
 * with both images for the record publisher (spec §4.7), and two sparse
 * indexes: hours that are not `CLOSED` (spec §4.5) and records whose
 * `publishPending` marker is set (spec §4.7).
 *
 * A resource-based policy denies item writes, PartiQL included, to every
 * principal but the stack's own roles (spec §3.5, M-24).
 */

import { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** The sparse index of hours not yet `CLOSED` (spec §4.5). */
export const PENDING_HOURS_INDEX = 'pending-hours';
/** The sparse outbox index (spec §4.7). */
export const PUBLISH_OUTBOX_INDEX = 'publish-outbox';
/** `publishShard` takes values 0 to this minus one. */
export const PUBLISH_SHARDS = 4;

const WRITE_ACTIONS = [
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:PartiQLInsert',
  'dynamodb:PartiQLUpdate',
  'dynamodb:PartiQLDelete',
  'dynamodb:ConditionCheckItem',
];

export function createTable(scope: Construct, writers: iam.IRole[]): dynamodb.TableV2 {
  return new dynamodb.TableV2(scope, 'Table', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    billing: dynamodb.Billing.onDemand(),
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    timeToLiveAttribute: 'expiresAt',
    dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    removalPolicy: RemovalPolicy.DESTROY, // sample only (standard §4.3)
    globalSecondaryIndexes: [
      {
        indexName: PENDING_HOURS_INDEX,
        partitionKey: { name: 'pending', type: dynamodb.AttributeType.NUMBER },
        sortKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      },
      {
        indexName: PUBLISH_OUTBOX_INDEX,
        partitionKey: { name: 'publishShard', type: dynamodb.AttributeType.NUMBER },
        sortKey: { name: 'publishPending', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.KEYS_ONLY,
      },
    ],
    resourcePolicy: new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: 'DenyItemWritesExceptTheStack',
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: WRITE_ACTIONS,
          // A table's own resource policy cannot name the table's ARN without a
          // cycle; `*` here means this table (the policy is attached to it).
          resources: ['*'],
          conditions: { ArnNotEquals: { 'aws:PrincipalArn': writers.map((role) => role.roleArn) } },
        }),
      ],
    }),
  });
}

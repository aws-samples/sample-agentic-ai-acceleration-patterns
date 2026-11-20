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
import { LIST_BY_TYPE_INDEX, PENDING_HOURS_INDEX, PUBLISH_OUTBOX_INDEX, PUBLISH_SHARDS } from '../shared/keys';

export { LIST_BY_TYPE_INDEX, PENDING_HOURS_INDEX, PUBLISH_OUTBOX_INDEX, PUBLISH_SHARDS };


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
        // Meters (their CURRENT item), sinks, emitters and jobs, for the List
        // operations; sorted by id (a ULID for jobs, so by creation).
        indexName: LIST_BY_TYPE_INDEX,
        partitionKey: { name: 'listType', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'listSort', type: dynamodb.AttributeType.STRING },
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

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registry table (spec §4, ADR-0010, M-23, M-24): one table, tenant
 * partitions plus `SYSTEM`, on demand, PITR on (35 days; the README names
 * that backups keep file names and hashes, never content), a stream with
 * `NEW_AND_OLD_IMAGES` for the registry watch, TTL on `ttl`, an AWS-owned key
 * (identifiers and status only), `DESTROY` (sample only).
 *
 * Two sparse GSIs (ADR-0021):
 * - `statusBucket-urlExpiresAt` (spec §4.2): delivery rows while `OPEN`, and
 *   terminal rows while their event is `OWED` (src/shared/registry.ts). One
 *   constant value is one hot GSI partition, well within limits at N-2 rates.
 * - `keyStatus`: key rows only (no delivery row carries `keyStatus`). The
 *   sweep must find `REVOKED` keys and reconcile `inFlight` per key row, and
 *   `sweepRole` holds no `Scan` (architecture.md §14 refinements).
 */

import { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import { KEY_STATUS_INDEX_NAME, OPEN_INDEX_NAME } from '../shared/constants';

export function createRegistryTable(scope: Construct, id: string): dynamodb.Table {
  const table = new dynamodb.Table(scope, id, {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    timeToLiveAttribute: 'ttl',
    encryption: dynamodb.TableEncryption.DEFAULT,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  table.addGlobalSecondaryIndex({
    indexName: OPEN_INDEX_NAME,
    partitionKey: { name: 'statusBucket', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'urlExpiresAt', type: dynamodb.AttributeType.NUMBER },
    projectionType: dynamodb.ProjectionType.ALL,
  });
  table.addGlobalSecondaryIndex({
    indexName: KEY_STATUS_INDEX_NAME,
    partitionKey: { name: 'keyStatus', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });
  return table;
}

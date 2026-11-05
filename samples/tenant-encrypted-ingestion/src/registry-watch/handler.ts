// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registry watch (spec §7.1 "Base-role registry access is filtered",
 * P-8, ADR-0010, M-24). A Lambda on the table's stream (`NEW_AND_OLD_IMAGES`)
 * behind an event-source filter `SK = KEY`, under `watchRole`.
 *
 * `keyFactoryRole` writes a binding with `PutItem` and a write-once guard
 * its own code chooses, and `platformRole` may delete a row: together they
 * could rebind a tenant. That is detected here, not prevented:
 *
 * - `MODIFY` of a tenant key row that changes `keyArn` or `tier`: alarm.
 * - `REMOVE` of a tenant key row: write `SYSTEM / TOMBSTONE#<tenantId>`
 *   with a 7-day `ttl`.
 * - `INSERT` of a tenant key row while that tombstone exists: alarm (a
 *   re-onboarding within 7 days, which the operator acknowledges).
 *
 * The alarm is the `KeyBindingChanged` metric (src/construct/alarms.ts) plus
 * one WARN line naming the tenant and the case. Images are never logged:
 * only the tenant id from the key and the record's event name. `watchRole`
 * may only `UpdateItem` in the `SYSTEM` partition, so the tombstone check is
 * an update conditioned on the item existing (it creates nothing when the
 * tombstone is absent). A failed batch is retried and then goes to the
 * on-failure SQS queue.
 */

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AttributeValue, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { BINDING_CHANGE_METRIC, ENV, METRICS_NAMESPACE, requireEnv } from '../shared/constants';
import { isConditionalCheckFailed } from '../shared/errors';
import { log } from '../shared/logger';
import { isoNow, KEY_SK, tenantOfPk, tombstoneKey, updateInput } from '../shared/registry';

export const TOMBSTONE_TTL_SECONDS = 7 * 24 * 3600;

export type WatchAlarm = 'binding-changed' | 'reinserted-after-removal';

export interface WatchDependencies {
  readonly tableName: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly cloudwatch: CloudWatchClient;
  readonly now?: () => number;
}

function str(image: Record<string, AttributeValue> | undefined, name: string): string | undefined {
  return image?.[name]?.S;
}

/** What a MODIFY record means: a changed binding, or nothing. Exported for tests. */
export function bindingChanged(record: DynamoDBRecord): boolean {
  const oldImage = record.dynamodb?.OldImage;
  const newImage = record.dynamodb?.NewImage;
  return str(oldImage, 'keyArn') !== str(newImage, 'keyArn') || str(oldImage, 'tier') !== str(newImage, 'tier');
}

export function createWatch(deps: WatchDependencies) {
  const now = deps.now ?? Date.now;

  async function alarm(kind: WatchAlarm, tenantId: string): Promise<void> {
    log.warn('registry binding alarm', { tenantId, alarm: kind });
    await deps.cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: METRICS_NAMESPACE,
        MetricData: [{ MetricName: BINDING_CHANGE_METRIC, Value: 1, Unit: 'Count' }],
      }),
    );
  }

  async function handleRecord(record: DynamoDBRecord): Promise<WatchAlarm | 'tombstone' | undefined> {
    const keys = record.dynamodb?.Keys;
    const pk = keys?.PK?.S;
    const sk = keys?.SK?.S;
    const tenantId = tenantOfPk(pk);
    if (tenantId === undefined || sk !== KEY_SK) {
      return undefined; // KEYARN# items, or anything the filter let through
    }
    switch (record.eventName) {
      case 'MODIFY':
        if (bindingChanged(record)) {
          await alarm('binding-changed', tenantId);
          return 'binding-changed';
        }
        return undefined;
      case 'REMOVE':
        await deps.ddb.send(
          new UpdateCommand(
            updateInput(deps.tableName, tombstoneKey(tenantId), {
              set: { ttl: Math.floor(now() / 1000) + TOMBSTONE_TTL_SECONDS, removedAt: isoNow(now()) },
            }),
          ),
        );
        log.info('tenant tombstone written', { tenantId, eventName: 'REMOVE' });
        return 'tombstone';
      case 'INSERT':
        try {
          await deps.ddb.send(
            new UpdateCommand(
              updateInput(deps.tableName, tombstoneKey(tenantId), {
                set: { reinsertedAt: isoNow(now()) },
                condition: 'attribute_exists(#PK)',
              }),
            ),
          );
        } catch (error) {
          if (isConditionalCheckFailed(error)) {
            return undefined; // no tombstone: a first onboarding
          }
          throw error;
        }
        await alarm('reinserted-after-removal', tenantId);
        return 'reinserted-after-removal';
      default:
        return undefined;
    }
  }

  return async (event: DynamoDBStreamEvent): Promise<void> => {
    for (const record of event.Records) {
      await handleRecord(record);
    }
  };
}

let cached: ReturnType<typeof createWatch> | undefined;

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  cached ??= createWatch({
    tableName: requireEnv(ENV.tableName),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cloudwatch: new CloudWatchClient({}),
  });
  return cached(event);
}

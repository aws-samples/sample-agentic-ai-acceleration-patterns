// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The pipeline's events (spec §5.4, M-29). The detail carries ids, keys and
 * outcomes only: no file name, no key ARN (a consumer calls `GetTenantKey`),
 * no URL. Delivery is at least once, so consumers de-duplicate on
 * `deliveryId`; the bus is vendor-side and filtered, so a consumer filters
 * on `detail.tenantId`.
 */

import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { EVENT_SOURCE } from './constants';

export type DeliveryEventType = 'DeliveryAccepted' | 'DeliveryRejected' | 'DeliveryKeyUnavailable';

export interface DeliveryEventDetail {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly landedKey?: string;
  readonly sizeBytes?: number;
  readonly contentType?: string;
  readonly reason?: string;
}

/** The only detail fields an event may carry. */
export const EVENT_DETAIL_FIELDS = ['tenantId', 'deliveryId', 'landedKey', 'sizeBytes', 'contentType', 'reason'] as const;

/** The detail with every field outside the schema dropped. */
export function eventDetail(detail: DeliveryEventDetail): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const field of EVENT_DETAIL_FIELDS) {
    const value = detail[field];
    if (value !== undefined) {
      out[field] = value;
    }
  }
  return out;
}

export async function publishDeliveryEvent(
  events: EventBridgeClient,
  busName: string,
  type: DeliveryEventType,
  detail: DeliveryEventDetail,
): Promise<void> {
  const response = await events.send(
    new PutEventsCommand({
      Entries: [{ EventBusName: busName, Source: EVENT_SOURCE, DetailType: type, Detail: JSON.stringify(eventDetail(detail)) }],
    }),
  );
  if ((response.FailedEntryCount ?? 0) > 0) {
    throw new Error(`PutEvents failed: ${response.Entries?.[0]?.ErrorCode ?? 'unknown'}`);
  }
}

/** The event type of a terminal status, or undefined for one that publishes nothing. */
export function eventTypeOf(status: string): DeliveryEventType | undefined {
  switch (status) {
    case 'ACCEPTED':
      return 'DeliveryAccepted';
    case 'REJECTED':
      return 'DeliveryRejected';
    case 'KEY_UNAVAILABLE':
      return 'DeliveryKeyUnavailable';
    default:
      return undefined;
  }
}

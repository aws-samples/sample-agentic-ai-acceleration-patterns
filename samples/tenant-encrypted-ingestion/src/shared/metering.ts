// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Per-tenant metering (spec P-9, M-28, ADR-0012).
 *
 * The registry counters on the key row are the per-tenant figures:
 * `bytesStored`, `deliveriesAccepted`, `deliveriesRejected` and
 * `kmsRequests`. KMS requests are counted from what the pipeline did, four
 * plus one per validator for an accepted delivery: the tenant's PUT
 * (`GenerateDataKey`), the structural read (`Decrypt`), the copy
 * (`Decrypt` + `GenerateDataKey`) and one `Decrypt` per validator GET.
 *
 * Optional per-tenant EMF (`perTenantMetrics`): one record per delivery
 * with `TenantId` as a dimension. Off by default, because a dimension per
 * tenant is a custom metric per tenant; Contributor Insights on the
 * `tenantId` log field gives the top tenants at a cost that does not grow
 * with tenants.
 */

import { METRICS_NAMESPACE } from './constants';

/** KMS requests of the tenant's PUT: one `GenerateDataKey`. */
export const KMS_REQUESTS_PUT = 1;
/** KMS requests of one SSE-KMS read: one `Decrypt`. */
export const KMS_REQUESTS_READ = 1;
/** KMS requests of a copy into `documents/`: `Decrypt` + `GenerateDataKey`. */
export const KMS_REQUESTS_COPY = 2;

/** A running count of the KMS requests one delivery caused. */
export class KmsMeter {
  private count = KMS_REQUESTS_PUT;
  read(): void {
    this.count += KMS_REQUESTS_READ;
  }
  copy(): void {
    this.count += KMS_REQUESTS_COPY;
  }
  get total(): number {
    return this.count;
  }
}

export interface DeliveryMetric {
  readonly tenantId: string;
  readonly status: string;
  readonly sizeBytes: number;
  readonly kmsRequests: number;
  readonly durationMs: number;
}

/** One EMF record for a delivery, or nothing when per-tenant metrics are off. */
export function emitDeliveryMetric(enabled: boolean, metric: DeliveryMetric, now: number = Date.now()): void {
  if (!enabled) {
    return;
  }
  const record = {
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: METRICS_NAMESPACE,
          Dimensions: [['TenantId', 'Status']],
          Metrics: [
            { Name: 'Deliveries', Unit: 'Count' },
            { Name: 'DeliveryBytes', Unit: 'Bytes' },
            { Name: 'KmsRequests', Unit: 'Count' },
            { Name: 'DeliveryDuration', Unit: 'Milliseconds' },
          ],
        },
      ],
    },
    TenantId: metric.tenantId,
    Status: metric.status,
    Deliveries: 1,
    DeliveryBytes: metric.sizeBytes,
    KmsRequests: metric.kmsRequests,
    DeliveryDuration: metric.durationMs,
  };
  process.stdout.write(JSON.stringify(record) + '\n');
}

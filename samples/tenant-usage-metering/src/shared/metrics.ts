// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CloudWatch metrics in the embedded metric format: one JSON line on stdout
 * per flush, which Lambda's log pipeline turns into metrics with no API call
 * and no extra permission. Dimensions are fixed names with low cardinality
 * (a reason, a sink id); tenant ids are never a dimension.
 */

/** The metric names the construct's alarms read (src/construct/alarms.ts). */
export const METRIC = {
  unregisteredCaller: 'UnregisteredCaller',
  accepted: 'EventsAccepted',
  refused: 'EventsRefused',
  retried: 'EventsRetried',
  droppedRefusals: 'RefusalsNotStored',
  objectInClosedHour: 'ObjectInClosedHour',
  firehoseErrorObject: 'FirehoseErrorObject',
  hourPastCloseNotCounted: 'HourPastCloseNotCounted',
  hoursPastGrace: 'HoursPastGrace',
  hourCounted: 'HourCounted',
  recountFailed: 'RecountFailed',
  recountFailedThrice: 'RecountFailedThrice',
  recountLostLease: 'RecountLostLease',
  malformedStoredEvent: 'MalformedStoredEvent',
  recordsWritten: 'UsageRecordsWritten',
  published: 'UsageRecordsPublished',
  deliverySent: 'DeliveriesSent',
  deliveryFailed: 'DeliveriesFailed',
  deliveryBlocked: 'DeliveriesBlocked',
} as const;

export const DEFAULT_NAMESPACE = 'TenantUsageMetering';

type Point = { name: string; value: number; dimensions: Record<string, string> };

export class Metrics {
  private readonly points: Point[] = [];

  constructor(private readonly namespace: string = process.env.METERING_METRIC_NAMESPACE ?? DEFAULT_NAMESPACE) {}

  /** Adds a point; a zero is dropped unless `keepZero` (a gauge an alarm reads, such as `HoursPastGrace`). */
  add(name: string, value = 1, dimensions: Record<string, string> = {}, keepZero = false): void {
    if (value !== 0 || keepZero) {
      this.points.push({ name, value, dimensions });
    }
  }

  /** Writes one EMF line per distinct dimension set. */
  flush(): void {
    const groups = new Map<string, Point[]>();
    for (const point of this.points) {
      const key = JSON.stringify(Object.entries(point.dimensions).sort());
      const list = groups.get(key) ?? [];
      list.push(point);
      groups.set(key, list);
    }
    for (const points of groups.values()) {
      const dimensions = points[0].dimensions;
      const values: Record<string, number> = {};
      for (const point of points) {
        values[point.name] = (values[point.name] ?? 0) + point.value;
      }
      const line = {
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: this.namespace,
              Dimensions: [Object.keys(dimensions)],
              Metrics: Object.keys(values).map((name) => ({ Name: name, Unit: 'Count' })),
            },
          ],
        },
        ...dimensions,
        ...values,
      };
      process.stdout.write(`${JSON.stringify(line)}\n`);
    }
    this.points.length = 0;
  }
}

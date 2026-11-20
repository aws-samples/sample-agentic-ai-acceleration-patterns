// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What the admin operations need: the table, the deployment inputs they
 * enforce, a clock, and a way to start a job's worker.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { RoleCaller } from '../shared/identity';
import type { JobItem } from '../shared/items';

export interface AdminConfig {
  readonly tableName: string;
  readonly fleetName: string;
  readonly recountWindowHours: number;
  readonly closeGraceMinutes: number;
  /** The metering account and the accounts a bus is shared with: no emitter may live there (spec §3.2). */
  readonly blockedAccountIds: ReadonlyArray<string>;
  readonly ingestPath: 'BUS' | 'DIRECT';
}

export interface AdminDeps {
  readonly db: DynamoDBDocumentClient;
  readonly config: AdminConfig;
  /** Starts the worker of a job just written as `RUNNING`. */
  readonly startJob: (job: JobItem) => Promise<void>;
  readonly now?: () => number;
}

export interface AdminContext {
  readonly caller: RoleCaller;
  readonly requestId: string;
}

export function nowOf(deps: AdminDeps): number {
  return (deps.now ?? Date.now)();
}

export const toDate = (value: string | undefined): Date | undefined => (value === undefined ? undefined : new Date(value));

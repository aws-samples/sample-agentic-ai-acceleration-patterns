// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the drain custom resource (spec §5.3, ADR-0034). It is the
 * `onEvent` handler of a CloudFormation custom resource provider, so it
 * returns the physical resource id and the provider sends the response; a
 * thrown error fails the resource and the stack delete with it.
 *
 * Create and Update do nothing. Delete stops every sandbox, waits until none
 * is live, and runs each backend's cleanup (ADR-0034).
 */

import type { Context } from 'aws-lambda';
import { drain, type DrainDeps } from './drain';
import { loadConfig } from '../tool/config';
import { loadBackends, registryClient } from '../tool/deps';
import { Logger } from '../tool/log';

/** Left for the provider to answer in, before the Lambda's own time runs out. */
const MARGIN_MS = 30_000;
const PHYSICAL_ID = 'untrusted-code-sandboxes-drain';

export interface DrainEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
}

export interface DrainResponse {
  readonly PhysicalResourceId: string;
}

function build(): DrainDeps {
  const config = loadConfig();
  return {
    config,
    backends: loadBackends(config),
    registry: registryClient(config.table),
    log: new Logger(undefined, config.perTenantMetrics),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function handler(event: DrainEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<DrainResponse> {
  const physicalId = event.PhysicalResourceId ?? PHYSICAL_ID;
  if (event.RequestType !== 'Delete') return { PhysicalResourceId: physicalId };
  const limit = context === undefined ? Number.POSITIVE_INFINITY : Date.now() + context.getRemainingTimeInMillis() - MARGIN_MS;
  await drain(build(), limit);
  return { PhysicalResourceId: physicalId };
}

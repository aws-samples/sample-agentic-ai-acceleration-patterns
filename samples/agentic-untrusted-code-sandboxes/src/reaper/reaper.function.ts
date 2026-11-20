// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the reaper, on a five-minute schedule (spec §4.1, ADR-0034).
 * It runs as the reaper role and reads the registry with that role's own
 * credentials. A pass that hit an error still finishes every row it could,
 * then fails, so the error shows in the function's own metrics.
 */

import { reapOnce, type ReaperDeps, type ReaperSummary } from './reaper';
import { loadConfig } from '../tool/config';
import { loadBackends, registryClient } from '../tool/deps';
import { Logger } from '../tool/log';

let deps: ReaperDeps | undefined;

function build(): ReaperDeps {
  const config = loadConfig();
  return {
    config,
    backends: loadBackends(config),
    registry: registryClient(config.table),
    log: new Logger(undefined, config.perTenantMetrics),
    now: Date.now,
  };
}

export async function handler(_event?: unknown): Promise<ReaperSummary> {
  deps ??= build();
  return reapOnce(deps);
}

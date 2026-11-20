// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the reaper, on a five-minute schedule (spec §4.1, ADR-0034).
 * It runs as the reaper role and reads the registry with that role's own
 * credentials. A pass that hit an error still finishes every row it could,
 * then fails, so the error shows in the function's own metrics.
 */

import { reapOnce, type ReaperDeps, type ReaperSummary } from './reaper';
import { TEST_HOOK_ENV, TEST_HOOK_FIELDS } from '../env';
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

/**
 * Test hook of the integration test (spec §8 `max-life`, ADR-0058): with `RC_INTEG_OVERRIDES` = `1` on this function,
 * a positive `maxLifeSeconds` in the event replaces `sandboxMaxLife` for this one pass. Otherwise the event is ignored.
 */
export function maxLifeOverrideMs(event: unknown, env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  if (env[TEST_HOOK_ENV.RC_INTEG_OVERRIDES] !== '1') return undefined;
  const seconds = (event as Record<string, unknown> | null | undefined)?.[TEST_HOOK_FIELDS.REAPER_MAX_LIFE_SECONDS];
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export async function handler(event?: unknown): Promise<ReaperSummary> {
  deps ??= build();
  const override = maxLifeOverrideMs(event);
  return reapOnce(override === undefined ? deps : { ...deps, config: { ...deps.config, sandboxMaxLifeMs: override } });
}

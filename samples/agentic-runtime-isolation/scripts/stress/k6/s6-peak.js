// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// S6 peak (§5): the S1 shape at the tier's peak rate for 60 s (PEAK_SECONDS overrides). The
// Runtime data plane runs at its quota: throttles are expected and must surface as a 429 or
// 503 naming the right tenant, never a 500 (status_<code> counters, collect.sh).

import { loadTier, loadManifest, plan, tokenMode, setupTokens, setPacing, vusFor, warmupScenario, warmAll, step, pickProbe, buildOptions, summarize, scenarioSeconds } from './lib.js';

const tier = loadTier();
const manifest = loadManifest();
const p = plan(manifest, tier);
const rate = tier.peakRps;
const vus = vusFor(rate);
const slots = Math.min(vus, p.tenants);
const mode = tokenMode(p, vus);
const warm = warmupScenario(vus, p, mode, true);
const seconds = Number(__ENV.PEAK_SECONDS) > 0 ? Number(__ENV.PEAK_SECONDS) : 60;
setPacing(vus);

export const options = buildOptions(
  {
    warmup: warm.scenario,
    peak: {
      executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: `${seconds}s`,
      preAllocatedVUs: vus, maxVUs: vus, startTime: warm.startTime, exec: 'main',
    },
  },
  p,
  mode,
);

export function setup() {
  return setupTokens(manifest, tier, { mode });
}

export function warmup(data) {
  warmAll(data, 'peak', slots, true);
}

export function main(data) {
  step(data, { pool: 'peak', slots, kind: pickProbe });
}

export function handleSummary(data) {
  return summarize(data);
}

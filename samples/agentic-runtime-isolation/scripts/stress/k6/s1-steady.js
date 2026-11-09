// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// S1 steady (§5): the active tenants with the tier's users each, the tier's steady rate of
// the §6 probe mix (report / read <A> / read <B>), one warm conversation per tenant opened in
// an untimed warm-up at WARM_RPS, for the tier's scenario length (large: 600 s).

import { loadTier, loadManifest, plan, tokenMode, setupTokens, setPacing, vusFor, warmupScenario, warmAll, step, pickProbe, buildOptions, summarize, scenarioSeconds } from './lib.js';

const tier = loadTier();
const manifest = loadManifest();
const p = plan(manifest, tier);
const rate = tier.steadyRps;
const vus = vusFor(rate);
const slots = Math.min(vus, p.tenants);
const mode = tokenMode(p, vus);
const warm = warmupScenario(vus, p, mode, true);
setPacing(vus);

export const options = buildOptions(
  {
    warmup: warm.scenario,
    steady: {
      executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: `${scenarioSeconds(tier, 600)}s`,
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
  warmAll(data, 'steady', slots, true);
}

export function main(data) {
  step(data, { pool: 'steady', slots, kind: pickProbe });
}

export function handleSummary(data) {
  return summarize(data);
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// S7 cache eviction (§5): twice the active tenants (2,000 at large, bounded by the
// manifest), one user each, at 0.6 x steady (300 rps at large; EVICTION_RPS overrides) for
// the tier's length (large: 300 s). Each VU walks its tenants in turn, one request per tenant
// per pass, so more tag sets than the TVM and mint caches hold pass through each instance.
// seed.sh must have subscribed every tenant this uses.

import { loadTier, loadManifest, plan, tokenMode, setupTokens, setPacing, vusFor, warmupScenario, warmAll, step, pickProbe, buildOptions, summarize, scenarioSeconds } from './lib.js';

const tier = loadTier();
const manifest = loadManifest();
const tenants = Math.min(manifest.tenants.length, tier.tenantsActive * 2);
const p = plan(manifest, tier, { tenants, usersPerTenant: 1 });
const rate = Number(__ENV.EVICTION_RPS) > 0 ? Number(__ENV.EVICTION_RPS) : Math.max(1, Math.ceil(tier.steadyRps * 0.6));
const vus = vusFor(rate);
const slots = Math.min(vus, p.tenants);
const mode = tokenMode(p, vus);
const warm = warmupScenario(vus, p, mode, true);
setPacing(vus);

export const options = buildOptions(
  {
    warmup: warm.scenario,
    eviction: {
      executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: `${scenarioSeconds(tier, 300)}s`,
      preAllocatedVUs: vus, maxVUs: vus, startTime: warm.startTime, exec: 'main',
    },
  },
  p,
  mode,
);

export function setup() {
  return setupTokens(manifest, tier, { tenants, usersPerTenant: 1, mode });
}

export function warmup(data) {
  warmAll(data, 'eviction', slots, true);
}

export function main(data) {
  step(data, { pool: 'eviction', slots, kind: pickProbe });
}

export function handleSummary(data) {
  return summarize(data);
}

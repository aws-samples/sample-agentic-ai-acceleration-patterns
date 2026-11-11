// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// S3 noisy neighbour (§5): S1 at the steady rate over every active tenant but one, plus a
// second scenario, `noisy`, where that one tenant sends 10 x its per-tenant limit
// (tenantLimitRpm, default 60 -> 600 requests a minute) of `report` for the tier's length
// (large: 300 s). Expected: the noisy tenant is refused 429 above its limit each minute; no
// other tenant sees a 429 (tenant_429 is tagged by tenant; collect.sh joins the
// `tenant_minute` lines against the ingress log).

import { loadTier, loadManifest, plan, tokenMode, setupTokens, setPacing, vusFor, warmupScenario, warmAll, step, pickProbe, buildOptions, summarize, scenarioSeconds } from './lib.js';

const tier = loadTier();
const manifest = loadManifest();
const p = plan(manifest, tier);
const seconds = scenarioSeconds(tier, 300);
const noisyIndex = p.tenants - 1;
const steadyPlan = Object.assign({}, p, { tenants: p.tenants - 1 });
const rate = tier.steadyRps;
const vus = vusFor(rate);
const noisyPerMinute = tier.tenantLimitRpm * 10;
const noisyVus = vusFor(noisyPerMinute / 60);
const slots = Math.min(vus, steadyPlan.tenants);
const mode = tokenMode(p, vus + noisyVus);
const warm = warmupScenario(vus, steadyPlan, mode, true);
setPacing(vus + noisyVus);

const steadyOnly = (e) => e.tenantIndex !== noisyIndex;
const noisyOnly = (e) => e.tenantIndex === noisyIndex && e.userIndex === 0;

export const options = buildOptions(
  {
    warmup: warm.scenario,
    steady: {
      executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: `${seconds}s`,
      preAllocatedVUs: vus, maxVUs: vus, startTime: warm.startTime, exec: 'main',
    },
    noisy: {
      executor: 'constant-arrival-rate', rate: noisyPerMinute, timeUnit: '1m', duration: `${seconds}s`,
      preAllocatedVUs: noisyVus, maxVUs: noisyVus, startTime: warm.startTime, exec: 'noisy',
    },
  },
  p,
  mode,
);

export function setup() {
  return setupTokens(manifest, tier, { mode });
}

export function warmup(data) {
  warmAll(data, 'steady', slots, true, steadyOnly);
}

export function main(data) {
  step(data, { pool: 'steady', slots, filter: steadyOnly, kind: pickProbe });
}

export function noisy(data) {
  // One conversation per noisy VU (`n<vu>`), its token issued or refreshed by that VU.
  step(data, { pool: 'noisy', slots: 1, filter: noisyOnly, suffix: (id) => `n${id}`, kind: () => 'report', ensure: true });
}

export function handleSummary(data) {
  return summarize(data);
}

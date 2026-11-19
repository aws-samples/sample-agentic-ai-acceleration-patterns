// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// S3 noisy neighbour (§5): S1 at the steady rate over every active tenant but one, plus that
// one tenant sending 10 x its per-tenant limit (tenantLimitRpm, default 60 -> 600 requests a
// minute) of `report` for the tier's length (large: 300 s). Expected: the noisy tenant is
// refused 429 above its limit each minute; no other tenant sees a 429. collect.sh checks both
// against the ingress log (the `429 only on the noisy tenant` row); setup() names the noisy
// tenant in a `noisy_tenant` line on k6's stderr for it.
//
// One timed scenario of VUS + NOISY_VUS VUs, each pacing itself. VU ids 1..VUS carry the
// steady load, the rest the noisy load. Two concurrent arrival-rate scenarios (the first
// version) draw their VUs from k6's one pool in no fixed order, so the steady VUs' ids were
// not 1..VUS and adopt()'s `(id - 1) % slots` gave some tenants two owners and others none;
// and with 19 tenants over 10 slots one slot held a single tenant, which got a whole VU's
// rate. Both pushed a steady tenant to its limit (2026-11-19: 77 requests in a minute, 17
// of them 429). Here the ids are fixed, and each steady VU's rate is its owned tenants'
// share of the steady rate divided by the VUs sharing its slot, so every steady tenant gets
// steadyRps / tenants.

import { sleep } from 'k6';
import exec from 'k6/execution';
import { loadTier, loadManifest, plan, tokenMode, setupTokens, setPacing, vusFor, warmupScenario, warmAll, step, pickProbe, buildOptions, summarize, scenarioSeconds, adopt } from './probe.js';

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
const totalVus = vus + noisyVus;
const slots = Math.min(vus, steadyPlan.tenants);
const mode = tokenMode(p, totalVus);
const warm = warmupScenario(vus, steadyPlan, mode, true);
setPacing(totalVus);

const steadyOnly = (e) => e.tenantIndex !== noisyIndex;
const noisyOnly = (e) => e.tenantIndex === noisyIndex && e.userIndex === 0;

// Every VU runs the warm-up once (only the steady ones warm), so the timed scenario's VUs are
// exactly ids 1..totalVus.
warm.scenario.vus = totalVus;

export const options = buildOptions(
  {
    warmup: warm.scenario,
    load: {
      executor: 'constant-vus', vus: totalVus, duration: `${seconds}s`, gracefulStop: '30s',
      startTime: warm.startTime, exec: 'main',
    },
  },
  p,
  mode,
);

export function setup() {
  const data = setupTokens(manifest, tier, { mode });
  const noisy = data.entries.find((e) => e.tenantIndex === noisyIndex);
  console.log(JSON.stringify({ kind: 'noisy_tenant', tenantId: noisy ? noisy.tenantId : null }));
  return data;
}

const isSteady = () => exec.vu.idInTest <= vus;

export function warmup(data) {
  if (isSteady()) {
    warmAll(data, 'steady', slots, true, steadyOnly);
  }
}

/** Milliseconds between two of this VU's requests (see the header). */
function intervalMs(data) {
  const id = exec.vu.idInTest;
  if (!isSteady()) {
    return (60000 * noisyVus) / noisyPerMinute;
  }
  const tenants = new Set(data.entries.filter(steadyOnly).map((e) => e.tenantIndex)).size;
  const owned = new Set(adopt(data, 'steady', slots, steadyOnly).map((e) => e.tenantIndex)).size;
  const s = Math.max(1, Math.min(slots, tenants));
  const slot = (id - 1) % s;
  const sharers = Math.floor((vus - 1 - slot) / s) + 1;
  const perVuRps = ((rate / tenants) * owned) / sharers;
  return perVuRps > 0 ? 1000 / perVuRps : 1000 * seconds;
}

const pace = {};

export function main(data) {
  const now = Date.now();
  if (pace.every === undefined) {
    pace.every = intervalMs(data);
    // Spread the VUs' first requests over one interval.
    pace.next = now + ((exec.vu.idInTest - 1) / totalVus) * pace.every;
  }
  if (pace.next > now) {
    sleep((pace.next - now) / 1000);
  }
  if (isSteady()) {
    step(data, { pool: 'steady', slots, filter: steadyOnly, kind: pickProbe });
  } else {
    // One conversation per noisy VU (`n<vu>`), its token issued or refreshed by that VU.
    step(data, { pool: 'noisy', slots: 1, filter: noisyOnly, suffix: (id) => `n${id}`, kind: () => 'report', ensure: true });
  }
  // A VU that falls behind does not burst to catch up.
  pace.next = Math.max(pace.next + pace.every, Date.now());
}

export function handleSummary(data) {
  return summarize(data, 'S3');
}

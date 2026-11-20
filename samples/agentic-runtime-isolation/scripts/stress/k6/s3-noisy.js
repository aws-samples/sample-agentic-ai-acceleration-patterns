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
// steady load, the rest the noisy load. The ids must be fixed: adopt() gives the tenants to
// VU slots by `(id - 1) % slots`, and k6 hands out VUs of concurrent scenarios from one pool
// in no fixed order, so two arrival-rate scenarios would give some steady tenants two owners
// and others none. And a slot can hold fewer tenants than another (19 tenants over 10 slots),
// so a VU's rate is its owned tenants' share of the steady rate divided by the VUs sharing
// its slot (noisy-pace.js), which gives every steady tenant steadyRps / tenants and keeps
// each under its per-tenant limit (ADR-0052, "S3 delivery").
//
// A VU that falls behind its pace skips the requests it missed rather than bursting, and
// counts them (`iteration_skipped{reason:behind}`). `steady_sent` counts the steady requests
// sent and `steady_expected` holds steadyRps x seconds; a threshold fails the scenario when
// the steady VUs sent more than 5 % under it, and collect.sh reports the same bound
// (delivered.jq).

import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { minSteadySent, noisyIntervalMs, steadyPace } from './noisy-pace.js';
import { loadTier, loadManifest, plan, tokenMode, setupTokens, setPacing, vusFor, warmupScenario, warmAll, step, pickProbe, buildOptions, summarize, scenarioSeconds, adopt, iterationSkipped } from './probe.js';

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

const steadySent = new Counter('steady_sent');
const steadyExpected = new Counter('steady_expected');

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
  { 'iteration_skipped{reason:behind}': ['count>=0'], steady_sent: [`count>=${minSteadySent(rate * seconds)}`] },
);

export function setup() {
  steadyExpected.add(rate * seconds);
  steadySent.add(0);
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

/** Milliseconds between two of this VU's requests (see the header and noisy-pace.js). */
function intervalMs(data) {
  if (!isSteady()) {
    return noisyIntervalMs(noisyVus, noisyPerMinute);
  }
  const tenants = new Set(data.entries.filter(steadyOnly).map((e) => e.tenantIndex)).size;
  const share = steadyPace(exec.vu.idInTest, { vus, slots, tenants, rate, seconds });
  // noisy-pace.js mirrors adopt()'s split; a VU that owns other tenants than it computed for
  // would send the wrong rate, so the scenario stops instead.
  const owned = new Set(adopt(data, 'steady', slots, steadyOnly).map((e) => e.tenantIndex)).size;
  if (owned !== share.owned) {
    exec.test.abort(`s3-noisy: VU ${exec.vu.idInTest} owns ${owned} tenants, noisy-pace.js computed ${share.owned}`);
  }
  return share.intervalMs;
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
    if (step(data, { pool: 'steady', slots, filter: steadyOnly, kind: pickProbe })) {
      steadySent.add(1);
    }
  } else {
    // One conversation per noisy VU (`n<vu>`), its token issued or refreshed by that VU.
    step(data, { pool: 'noisy', slots: 1, filter: noisyOnly, suffix: (id) => `n${id}`, kind: () => 'report', ensure: true });
  }
  // A VU that falls behind does not burst to catch up: the next request goes now, and the
  // ones whose time has already passed are skipped and counted.
  const after = Date.now();
  const next = pace.next + pace.every;
  if (next < after) {
    const missed = Math.floor((after - next) / pace.every);
    if (missed > 0) {
      iterationSkipped.add(missed, { reason: 'behind', pool: isSteady() ? 'steady' : 'noisy' });
    }
    pace.next = after;
  } else {
    pace.next = next;
  }
}

export function handleSummary(data) {
  return summarize(data, 'S3');
}

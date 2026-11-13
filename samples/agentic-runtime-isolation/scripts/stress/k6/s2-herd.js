// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// S2 thundering herd (§5, §13 question 2): run.sh first retires every warm ingress instance
// and flushes the authoriser cache. This file then primes the tokens (platform API only, the
// ingress stays idle), and ramps 0 -> herd rate in 5 s, held for the tier's length (large:
// 120 s; herd rate 1.6 x steady, 800 rps at large; HERD_RPS overrides). No conversation is
// warmed: set CONVERSATION_RUN_ID to an S1 run id from the Runtime's idle window to hit warm
// microVMs behind the cold ingress, or leave it unset to open new sessions in the herd.

import { loadTier, loadManifest, plan, tokenMode, setupTokens, setPacing, vusFor, warmupScenario, warmAll, step, pickProbe, buildOptions, summarize, scenarioSeconds } from './lib.js';

const tier = loadTier();
const manifest = loadManifest();
const p = plan(manifest, tier);
const rate = Number(__ENV.HERD_RPS) > 0 ? Number(__ENV.HERD_RPS) : Math.ceil(tier.steadyRps * 1.6);
const vus = vusFor(rate, 2);
const slots = Math.min(vus, p.tenants);
const mode = tokenMode(p, vus);
const prime = warmupScenario(vus, p, mode, false);
setPacing(vus);

export const options = buildOptions(
  {
    warmup: prime.scenario,
    herd: {
      executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s',
      stages: [
        { duration: '5s', target: rate },
        { duration: `${scenarioSeconds(tier, 120)}s`, target: rate },
      ],
      preAllocatedVUs: vus, maxVUs: vus, startTime: prime.startTime, exec: 'main',
    },
  },
  p,
  mode,
);

export function setup() {
  return setupTokens(manifest, tier, { mode });
}

export function warmup(data) {
  warmAll(data, 'herd', slots, false);
}

export function main(data) {
  step(data, { pool: 'herd', slots, kind: pickProbe, warm: false });
}

export function handleSummary(data) {
  return summarize(data);
}

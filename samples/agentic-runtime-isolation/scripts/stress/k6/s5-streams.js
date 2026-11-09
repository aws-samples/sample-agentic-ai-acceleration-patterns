// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// S5 long streams (§5): the model-free `stream <N>` probe (N = 60, small tier 10;
// STREAM_SECONDS overrides) across half the active tenants, at the rate that holds 90 % of
// the ingress reserved concurrency (12 rps x 60 s = 720 of 800 at large; STREAM_RPS
// overrides) for the tier's length (large: 300 s). The first event's report is asserted as
// in S1; a stream that ends early counts in stream_interrupted.

import { loadTier, loadManifest, plan, tokenMode, setupTokens, setPacing, vusFor, warmupScenario, warmAll, step, pickProbe, buildOptions, summarize, scenarioSeconds } from './lib.js';

const tier = loadTier();
const manifest = loadManifest();
const streamSeconds = Number(__ENV.STREAM_SECONDS) > 0 ? Number(__ENV.STREAM_SECONDS) : tier.scale === 'small' ? 10 : 60;
const tenants = Math.max(2, Math.ceil(tier.tenantsActive / 2));
const p = plan(manifest, tier, { tenants });
const reserved = Number(tier.ingressReservedConcurrency) > 0 ? Number(tier.ingressReservedConcurrency) : null;
const rate = Number(__ENV.STREAM_RPS) > 0
  ? Number(__ENV.STREAM_RPS)
  : Math.max(1, Math.floor(reserved ? (0.9 * reserved) / streamSeconds : (tier.steadyRps * 12) / 500));
const vus = vusFor(rate, streamSeconds + 5);
const slots = Math.min(vus, p.tenants);
const mode = tokenMode(p, vus);
const warm = warmupScenario(vus, p, mode, true);
setPacing(vus);

export const options = buildOptions(
  {
    warmup: warm.scenario,
    streams: {
      executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: `${scenarioSeconds(tier, 300)}s`,
      preAllocatedVUs: vus, maxVUs: vus, startTime: warm.startTime, exec: 'main', gracefulStop: `${streamSeconds + 30}s`,
    },
  },
  p,
  mode,
);

export function setup() {
  return setupTokens(manifest, tier, { tenants, mode });
}

export function warmup(data) {
  warmAll(data, 'streams', slots, true);
}

export function main(data) {
  step(data, { pool: 'streams', slots, kind: () => 'stream', streamSeconds });
}

export function handleSummary(data) {
  return summarize(data);
}

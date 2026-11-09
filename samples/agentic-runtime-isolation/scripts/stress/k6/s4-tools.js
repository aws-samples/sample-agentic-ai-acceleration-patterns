// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// S4 tool storm (§5): `tool t01/tool_001 {}` through the tools gateway (the REQUEST
// interceptor, AgentCore Policy, t01's own TVM) across the active tenants at 0.4 x steady
// (200 rps at large; TOOL_RPS overrides) for the tier's length (large: 300 s). Each answer
// must name tenant A, and A's tenant role session when the tool holds vended credentials.

import { loadTier, loadManifest, plan, tokenMode, setupTokens, setPacing, vusFor, warmupScenario, warmAll, step, pickProbe, buildOptions, summarize, scenarioSeconds } from './lib.js';

const tier = loadTier();
const manifest = loadManifest();
const p = plan(manifest, tier);
const rate = Number(__ENV.TOOL_RPS) > 0 ? Number(__ENV.TOOL_RPS) : Math.max(1, Math.ceil(tier.steadyRps * 0.4));
const vus = vusFor(rate, 2);
const slots = Math.min(vus, p.tenants);
const mode = tokenMode(p, vus);
const warm = warmupScenario(vus, p, mode, true);
const toolPrompt = __ENV.TOOL_PROMPT || 'tool t01/tool_001 {}';
setPacing(vus);

export const options = buildOptions(
  {
    warmup: warm.scenario,
    tools: {
      executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: `${scenarioSeconds(tier, 300)}s`,
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
  warmAll(data, 'tools', slots, true);
}

export function main(data) {
  step(data, { pool: 'tools', slots, kind: () => 'tool', toolPrompt });
}

export function handleSummary(data) {
  return summarize(data);
}

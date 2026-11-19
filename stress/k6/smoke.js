// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// Smoke scenario of the driver host and the library (stress ADR-0008): five requests to one
// public AWS endpoint, each with a fresh correlation header, then the result record. It proves
// that k6 runs on the host, that the library loads from its mirrored path, and that the record
// it writes is one `parseRecord` (stress/src/result.ts) accepts. It touches no sample and no
// tenant: its one isolation assertion per request is that the response is the expected one and
// that the correlation id has the shape every hop accepts.
//
//   stress/driver/k6.sh stress/k6/smoke.js STRESS_SMOKE_URL=<https URL>   (default below)
//
// Needs the STRESS_* variables of a run (STRESS_RUN_ID, STRESS_TIER_JSON, STRESS_MODE,
// STRESS_COMMIT) and STRESS_RESULTS to write the record; the slice name is `driver-smoke`.

import http from 'k6/http';
import { buildOptions, correlate, countStatus, env, isolationCheck, summarize, timed } from './lib.js';

const URL = env('STRESS_SMOKE_URL', 'https://checkip.amazonaws.com/');
const CORRELATION_ID = /^[A-Za-z0-9-]{1,64}$/;

export const options = buildOptions({ smoke: { executor: 'shared-iterations', vus: 1, iterations: 5, maxDuration: '60s' } }, { entries: 0 }, 'vu');

export default function () {
  const { id, headers } = correlate();
  const res = http.get(URL, { headers, tags: { name: 'smoke' }, responseType: 'none' });
  countStatus(res.status, 'smoke');
  timed(res.timings.waiting, res.timings.duration, { probe: 'smoke' });
  const bad = [];
  if (res.status !== 200) bad.push('status');
  if (!CORRELATION_ID.test(id)) bad.push('correlationId');
  isolationCheck({ tenantId: 'smoke', otherTenantId: 'smoke' }, 'smoke', res.status, bad, null, id);
}

export function handleSummary(data) {
  return summarize(data, { slice: 'driver-smoke', scenario: 'smoke' });
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// Spike SD-2 (stress ADR-0022, docs/stress-dashboard.design.md §12): the load of a platform
// scenario with no HTTP in it, so the relay and the k6 library's minute line can be measured on
// the driver host without a front door. Every iteration makes the calls a real probe makes into
// `stress/k6/lib.js` (a status, a timing, an isolation assertion) and prints the lines the
// runtime-isolation scenarios print: an `edge_refusal` for each 429. One iteration in 400 is a
// mismatch, so the mismatch counters are seen to move.
//
//   STRESS_MODE=platform RECORD_SCENARIO=PS-2 STRESS_RUN_ID=<id> AWS_REGION=<Region> \
//     STRESS_PREFIX=<driver prefix> STRESS_RESULTS=<local folder> \
//     stress/driver/k6.sh stress/spikes/dashboard/relay-load.js [DURATION=4m] [VUS=4]
//
// 4 VUs at 4 iterations a second each is 16 requests a second for 4 minutes: about 3,800 requests.

import { sleep } from 'k6';
import exec from 'k6/execution';
import { countStatus, env, isolationCheck, timed } from '../../k6/lib.js';

export const options = {
  scenarios: {
    load: { executor: 'constant-vus', vus: Number(env('VUS', 4)), duration: env('DURATION', '4m') },
  },
};

export default function () {
  const n = exec.scenario.iterationInTest;
  const status = n % 10 === 0 ? 429 : 200;
  const entry = { tenantId: 'tenant-a', otherTenantId: 'tenant-b' };
  countStatus(status, entry.tenantId);
  timed(40, 100 + (n % 50) * 10, {});
  isolationCheck(entry, 'read-own', status, n % 400 === 399 ? ['field'] : [], 'request', 'correlation');
  if (status === 429) {
    console.log(JSON.stringify({ kind: 'edge_refusal', epochMinute: Math.floor(Date.now() / 60000), tenantId: entry.tenantId, status }));
  }
  sleep(0.25);
}

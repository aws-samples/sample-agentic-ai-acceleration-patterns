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
//   STRESS_METRICS=1 STRESS_MODE=platform STRESS_RUN_ID=<id> AWS_REGION=<Region> \
//     STRESS_PREFIX=<driver prefix> STRESS_RESULTS=<local folder> \
//     stress/driver/k6.sh stress/spikes/dashboard/relay-load.js RECORD_SCENARIO=PS-2 [DURATION=4m] [EXECUTOR=vus|arrival]
//
// RECORD_SCENARIO is an argument of k6.sh, not an environment variable of the caller: only an
// argument is exported on the host, and without it the relay does not start.
//
// EXECUTOR=vus (the default): 4 VUs, a call every 0.25 s each, 16 requests a second, about 3,800 in 4 minutes.
// EXECUTOR=arrival: a constant-arrival-rate of 16 iterations a second over up to 100 VUs, which is how
// the runtime-isolation scenarios arrive: a VU is idle between its iterations and can have none for a while.

import { sleep } from 'k6';
import exec from 'k6/execution';
import { countStatus, env, isolationCheck, timed } from '../../k6/lib.js';

const arrival = env('EXECUTOR', 'vus') === 'arrival';

export const options = {
  scenarios: {
    load: arrival
      ? { executor: 'constant-arrival-rate', rate: 16, timeUnit: '1s', duration: env('DURATION', '4m'), preAllocatedVUs: 50, maxVUs: 100 }
      : { executor: 'constant-vus', vus: 4, duration: env('DURATION', '4m') },
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
  if (!arrival) {
    sleep(0.25);
  }
}

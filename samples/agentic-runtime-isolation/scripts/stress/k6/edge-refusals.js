// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// The edge-refusal lines of a platform-mode scenario (stress/README.md, "Platform mode:
// manifests"). No k6 import, so the slice's tests run this file as it is.
//
// A refusal through the edge (a 4xx or 5xx) is counted per tenant and status in the VU that saw
// it, and printed as one `edge_refusal` line per tenant, status and minute:
//   {"kind":"edge_refusal","epochMinute":<n>,"tenantId":"<id>","status":<n>,"count":<n>}
// `collect-platform.sh` reads these lines from k6's output and gives each refusal its tenant and
// its reason (`http-<status>`, P-7).
//
// `track` runs on EVERY response, not only on a refusal, so a minute's counts are written when
// the next minute's first response arrives even if that response is a success, and after every
// response in the last 1 % of the scenario (k6 has no per-VU end hook), like the library's
// per-tenant ledger (stress/k6/lib.js).

/**
 * NOW returns the epoch milliseconds, PROGRESS the scenario's progress from 0 to 1, LOG prints
 * one line. Returns `{ track(tenantId, status) }`.
 */
export function createEdgeRefusals(now, progress, log) {
  let counts = {};
  let minute = null;

  function flush() {
    for (const key of Object.keys(counts)) {
      const [tenantId, status] = key.split('|');
      log(JSON.stringify({ kind: 'edge_refusal', epochMinute: minute, tenantId, status: Number(status), count: counts[key] }));
    }
    counts = {};
  }

  return {
    track(tenantId, status) {
      const current = Math.floor(now() / 60000);
      if (minute !== null && current !== minute) {
        flush();
      }
      minute = current;
      if (status >= 400) {
        const key = `${tenantId}|${status}`;
        counts[key] = (counts[key] || 0) + 1;
      }
      if (progress() >= 0.99) {
        flush();
      }
    },
  };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// The edge-refusal lines of a platform-mode scenario (stress/README.md, "Platform mode:
// manifests"). No k6 import, so the slice's tests run this file as it is.
//
// A refusal through the edge (a 4xx or 5xx) is printed at once as one `edge_refusal` line:
//   {"kind":"edge_refusal","epochMinute":<n>,"tenantId":"<id>","status":<n>}
// `collect-platform.sh` counts the lines per tenant and status, and gives each refusal its tenant
// and its reason (`http-<status>`, P-7). A line is written when the refusal happens, because k6
// has no per-VU end hook: counts held in the VU for a later flush would be lost with the last
// response of a VU that ends before the flush.
//
// shortcut: one line per refusal, so a scenario that refuses most of its requests (the noisy
// tenant of PS-4) prints as many lines as it has refusals; aggregate in the VU when a run at
// a larger tier shows k6's output in the way.

/**
 * NOW returns the epoch milliseconds, LOG prints one line. Returns `{ track(tenantId, status) }`.
 */
export function createEdgeRefusals(now, log) {
  return {
    track(tenantId, status) {
      if (status >= 400) {
        log(JSON.stringify({ kind: 'edge_refusal', epochMinute: Math.floor(now() / 60000), tenantId, status: Number(status) }));
      }
    },
  };
}

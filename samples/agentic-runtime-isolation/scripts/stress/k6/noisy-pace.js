// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// S3's pacing arithmetic (s3-noisy.js). No k6 imports, so the slice's jest tests load this
// file as it is (test/stress/slice.test.ts) and check that the steady VUs' rates add up to
// steadyRps, split evenly over the steady tenants.

/**
 * The request interval of steady VU `id` (1-based, ids 1..vus are the steady VUs).
 *
 * The steady tenants are spread over `s = min(slots, tenants)` slots as lib.js `adopt` does:
 * VU `id` is in slot `(id - 1) % s` and owns the tenants whose index `i` has `i % s` equal to
 * its slot, shared with every other VU in that slot. So the VU's rate is its owned tenants'
 * share of the steady rate, divided by the VUs in its slot.
 *
 * @returns {{ owned: number, sharers: number, rps: number, intervalMs: number }}
 */
export function steadyPace(id, { vus, slots, tenants, rate, seconds }) {
  const s = Math.max(1, Math.min(slots, tenants));
  const slot = (id - 1) % s;
  const owned = slot < tenants ? Math.floor((tenants - 1 - slot) / s) + 1 : 0;
  const sharers = Math.floor((vus - 1 - slot) / s) + 1;
  const rps = tenants > 0 ? ((rate / tenants) * owned) / sharers : 0;
  return { owned, sharers, rps, intervalMs: rps > 0 ? 1000 / rps : 1000 * seconds };
}

/** The request interval of a noisy VU: `noisyVus` VUs share `perMinute` requests a minute. */
export function noisyIntervalMs(noisyVus, perMinute) {
  return (60000 * noisyVus) / perMinute;
}

/**
 * The fewest steady requests that pass S3's delivery criterion: at most 5 % under the
 * expected `steadyRps x seconds` (delivered.jq checks the same bound in collect).
 */
export function minSteadySent(expected) {
  return Math.ceil((95 * expected) / 100);
}

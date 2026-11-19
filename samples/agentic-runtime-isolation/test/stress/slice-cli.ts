// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What `scripts/stress/slice.sh` asks of this sample's tier table (ADR-0052):
 *
 *   ts-node test/stress/slice-cli.ts budget   {"draws": [...]} for the `budget` verb
 *   ts-node test/stress/slice-cli.ts tier     the sample's tier as JSON, for k6 (STRESS_TIER_JSON)
 *
 * Both read `STRESS_TIER` (`small`, `medium`, `large`) and need no credentials.
 */

import type { Draw } from '../../../../stress/src/budget';
import { type StressTier, tierOf } from './tiers';

/** The label of the account that holds the cell; in slice mode it is the one test account. */
export const CELL_ACCOUNT = 'cell-account-1';

/** Lambda keeps this much concurrency unreserved; a reserve that would leave less is refused. */
export const LAMBDA_UNRESERVED_FLOOR = 100;

/** The warm-up opens conversations at this rate (`WARM_RPS` in stress/k6/lib.js). */
export const WARM_CONVERSATIONS_PER_SECOND = 20;

/**
 * The peak draw of the tier on each account-wide quota (spec §4.4, the runtime-isolation
 * column). Every figure is an upper bound read from the tier, not a measurement:
 *
 * - Lambda concurrency: the two reserves plus the floor Lambda keeps unreserved. The tool
 *   functions, the interceptors and the Entitlements API run in that floor.
 * - STS `AssumeRole` and KMS `Sign` (the default token key is RSA): one call per request at
 *   the peak rate, as when the TVM and mint caches miss (S6, S7).
 * - Runtime invocations a second: the peak rate (S6).
 * - Runtime new sessions a second: the warm-up's conversation rate, capped by the sessions.
 * - Runtime active sessions: one per tenant a scenario walks, at most twice the active tenants
 *   (S7), and never more than the seeded tenants. A session is one conversation, and every
 *   scenario of a run shares them (the run id names the conversations).
 */
export function drawsOf(tier: StressTier): Draw[] {
  const sessions = Math.min(tier.tenantsSeeded, 2 * tier.tenantsActive);
  const draw = (quota: Draw['quota'], amount: number): Draw => ({ account: CELL_ACCOUNT, quota, amount });
  return [
    draw('lambda-concurrency', tier.ingressReservedConcurrency + tier.authorizerReservedConcurrency + LAMBDA_UNRESERVED_FLOOR),
    draw('sts-assume-role-rps', tier.peakRps),
    draw('kms-rsa-rps', tier.peakRps),
    draw('agentcore-new-sessions-rps', Math.min(WARM_CONVERSATIONS_PER_SECOND, sessions)),
    draw('agentcore-active-sessions', sessions),
    draw('agentcore-runtime-tps', tier.peakRps),
  ];
}

function main(command: string | undefined): void {
  const tier = tierOf(process.env.STRESS_TIER);
  if (command === 'budget') {
    process.stdout.write(`${JSON.stringify({ draws: drawsOf(tier) })}\n`);
  } else if (command === 'tier') {
    process.stdout.write(`${JSON.stringify(tier)}\n`);
  } else {
    process.stderr.write('usage: slice-cli.ts budget | tier\n');
    process.exit(2);
  }
}

if (require.main === module) {
  main(process.argv[2]);
}

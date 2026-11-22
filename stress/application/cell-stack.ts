// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What the stress application's cell app deploys for one control-plane cell (spec §3.3,
 * step 2): the stack name, its tags and the runtime-isolation demo context. Pure, so the
 * tests pin it without a synth.
 */

/** A control-plane cell id: a ULID (Crockford base 32, 26 characters). */
const CELL_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The stack tag every stress cell carries, beside `stress:cell=<cell id>`. */
export const CELL_TAG = { key: 'stress:part', value: 'cell' } as const;

/** The cell's stack name: `StressCell-<cell id>`, unique in the account, at most 37 characters. */
export function cellStackName(cellId: string): string {
  if (!CELL_ID.test(cellId)) throw new Error('CELL_ID must be a control-plane cell id (a ULID)');
  return `StressCell-${cellId}`;
}

/**
 * The runtime-isolation demo context of a cell: the `api-gateway` ingress with the TVM
 * (the shape the path spike and W-10 deployed under the workload boundary), and no
 * account-wide published parameters, so two cells in one account do not overwrite each
 * other (the interface goes under the stack's own prefix).
 */
export function cellAppContext(stackName: string): Record<string, string> {
  return {
    ingress: 'api-gateway',
    tvm: 'true',
    publishParameters: 'false',
    owner: stackName,
  };
}

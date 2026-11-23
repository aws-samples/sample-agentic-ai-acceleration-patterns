// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** Synthetic data the steps seed; invented tenants only (scripts/CONVENTIONS.md). */

import { createHash } from 'node:crypto';
import { TENANT } from './common';
import { MAX_INPUT_BYTES_CAP } from '../../src/props';

const { a: A, b: B } = TENANT;

/** Synthetic invoices; the totals are what the `parse` probe must report (spec §8 seed). */
export const INVOICES: Readonly<Record<string, { body: string; total: number; rows: number }>> = {
  [A]: { body: `tenant,id,amount\n${A},1,10.50\n${A},2,20.25\n${A},3,5.00\n`, total: 35.75, rows: 3 },
  [B]: { body: `tenant,id,amount\n${B},1,100.00\n${B},2,200.00\n${B},3,50.50\n`, total: 350.5, rows: 3 },
};

/** Input keys of the `limits` step: one at the `run-code` instance's `maxInputBytes` (the cap), one a byte over. */
export const INPUT_AT_CAP = 'at-cap.bin';
export const INPUT_OVER_CAP = 'over-cap.bin';

/** The bytes of the input at the cap: every byte value, so a lost or changed byte shows in the hash. */
export function inputAtCap(): Buffer {
  const b = Buffer.alloc(MAX_INPUT_BYTES_CAP);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) % 256;
  return b;
}

export function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

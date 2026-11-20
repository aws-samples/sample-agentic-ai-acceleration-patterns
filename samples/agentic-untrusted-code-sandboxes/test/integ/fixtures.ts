// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** Synthetic data the steps seed; invented tenants only (scripts/CONVENTIONS.md). */

import { TENANT } from './common';

const { a: A, b: B } = TENANT;

/** Synthetic invoices; the totals are what the `parse` probe must report (spec §8 seed). */
export const INVOICES: Readonly<Record<string, { body: string; total: number; rows: number }>> = {
  [A]: { body: `tenant,id,amount\n${A},1,10.50\n${A},2,20.25\n${A},3,5.00\n`, total: 35.75, rows: 3 },
  [B]: { body: `tenant,id,amount\n${B},1,100.00\n${B},2,200.00\n${B},3,50.50\n`, total: 350.5, rows: 3 },
};


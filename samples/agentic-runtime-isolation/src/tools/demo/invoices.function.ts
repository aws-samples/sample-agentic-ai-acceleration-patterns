// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Demo tool target `invoices` (spec C-4): one tool, synthetic data for the
 * tenant the signed context names (P-15).
 */

import { toolHandler, type ToolInvocation } from '../context';

export const INVOICES_TOOLS = [
  {
    name: 'get_invoice',
    description: 'Get one invoice of the calling tenant',
    inputSchema: { type: 'object', properties: { invoiceId: { type: 'string', description: 'invoice id' } }, required: ['invoiceId'] },
  },
] as const;

export async function invoices({ context, args }: ToolInvocation): Promise<Record<string, unknown>> {
  if (context.tool !== 'invoices/get_invoice') {
    return { error: 'unknown_tool' };
  }
  return { tenantId: context.tenantId, invoiceId: String(args.invoiceId ?? ''), amount: '100.00', currency: 'EUR' };
}

export const handler = toolHandler(invoices);

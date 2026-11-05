// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Demo tool target `invoices` (spec C-4, §8 fixtures; ADR-0041: two tools,
 * so the `finance` gateway's list filter has a partial grant to trim): the
 * calling tenant's invoices from its demo item (`TENANT#<id>`, attribute
 * `invoices`), read with the credentials the tool's own TVM vended for the
 * tenant the signed context names (P-15). Synthetic without a demo table.
 */

import { contextReport, type DemoDataDependencies, defaultDemoData, probeOtherTenant, readTenantAttribute } from './data';
import { toolHandler, type ToolInvocation } from '../context';

export const INVOICES_TOOLS = [
  {
    name: 'get_invoice',
    description: 'Get one invoice of the calling tenant',
    inputSchema: { type: 'object', properties: { invoiceId: { type: 'string', description: 'invoice id' } }, required: ['invoiceId'] },
  },
  {
    name: 'list_invoices',
    description: 'List the invoices of the calling tenant',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

type Invoices = Record<string, { amount?: unknown; currency?: unknown }>;

function invoiceOf(invoiceId: string, value: { amount?: unknown; currency?: unknown } | undefined) {
  return { invoiceId, amount: typeof value?.amount === 'string' ? value.amount : null, currency: typeof value?.currency === 'string' ? value.currency : null };
}

/** The `invoices` tools over the demo data (unit-tested with the client mocked). */
export function invoicesWith(deps: DemoDataDependencies): (invocation: ToolInvocation) => Promise<Record<string, unknown>> {
  return async ({ context, args, credentials }) => {
    const report = contextReport(context, args);
    const invoiceId = typeof args.invoiceId === 'string' ? args.invoiceId : '';
    if (context.tool !== 'invoices/get_invoice' && context.tool !== 'invoices/list_invoices') {
      return { ...report, error: 'unknown_tool' };
    }
    if (deps.tableName === undefined || credentials === undefined) {
      return context.tool === 'invoices/get_invoice'
        ? { ...report, invoice: { invoiceId, amount: '100.00', currency: 'EUR' }, source: 'synthetic' }
        : { ...report, invoices: [{ invoiceId: 'inv-0001', amount: '100.00', currency: 'EUR' }], source: 'synthetic' };
    }
    const probe = await probeOtherTenant(deps, credentials, args.probeTenantId);
    const withProbe = probe === undefined ? {} : { probe };
    const all = ((await readTenantAttribute(deps, credentials, context, 'invoices')) as Invoices | undefined) ?? {};
    if (context.tool === 'invoices/get_invoice') {
      const found = Object.prototype.hasOwnProperty.call(all, invoiceId) ? all[invoiceId] : undefined;
      return { ...report, invoice: found === undefined ? null : invoiceOf(invoiceId, found), source: 'table', ...withProbe };
    }
    return {
      ...report,
      invoices: Object.entries(all)
        .map(([id, v]) => invoiceOf(id, v))
        .sort((a, b) => a.invoiceId.localeCompare(b.invoiceId)),
      source: 'table',
      ...withProbe,
    };
  };
}

export const handler = toolHandler(invoicesWith(defaultDemoData()));

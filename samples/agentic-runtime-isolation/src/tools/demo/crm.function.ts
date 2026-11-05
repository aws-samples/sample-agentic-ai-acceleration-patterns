// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Demo tool target `crm` (spec C-4, §8 fixtures): three tools behind the
 * tools gateway `default`. Each reads or writes the calling tenant's demo
 * item (`TENANT#<id>`, attributes `crmAccount` and `crmCases`) with the
 * credentials the tool's own TVM vended for the tenant the signed context
 * names (P-15, src/tools/demo/data.ts). It never reads a tenant from its
 * arguments. Without a demo table (the demo without tenant data) it answers
 * with synthetic data.
 */

import { contextReport, type DemoDataDependencies, defaultDemoData, probeOtherTenant, readTenantAttribute, updateTenantEntry } from './data';
import { toolHandler, type ToolInvocation } from '../context';

/** The tools this target serves, with their input schemas (the `ToolTarget` registers these). */
export const CRM_TOOLS = [
  {
    name: 'get_account',
    description: 'Get the account of the calling tenant',
    inputSchema: { type: 'object', properties: { accountId: { type: 'string', description: 'account id' } } },
  },
  {
    name: 'list_cases',
    description: 'List the cases of the calling tenant',
    inputSchema: { type: 'object', properties: { accountId: { type: 'string', description: 'account id' } } },
  },
  {
    name: 'update_case',
    description: 'Update the status of one case of the calling tenant',
    inputSchema: {
      type: 'object',
      properties: { caseId: { type: 'string', description: 'case id' }, status: { type: 'string', description: 'new status' } },
      required: ['caseId'],
    },
  },
] as const;

/** The `crm` tools over the demo data (unit-tested with the client mocked). */
export function crmWith(deps: DemoDataDependencies): (invocation: ToolInvocation) => Promise<Record<string, unknown>> {
  return async ({ context, args, credentials }) => {
    const report = contextReport(context, args);
    if (deps.tableName === undefined || credentials === undefined) {
      return { ...report, ...synthetic(context.tool, args), source: 'synthetic' };
    }
    const probe = await probeOtherTenant(deps, credentials, args.probeTenantId);
    const withProbe = probe === undefined ? {} : { probe };
    switch (context.tool) {
      case 'crm/get_account':
        return { ...report, account: (await readTenantAttribute(deps, credentials, context, 'crmAccount')) ?? null, source: 'table', ...withProbe };
      case 'crm/list_cases': {
        const cases = (await readTenantAttribute(deps, credentials, context, 'crmCases')) as Record<string, { status?: unknown }> | undefined;
        return {
          ...report,
          cases: Object.entries(cases ?? {})
            .map(([caseId, c]) => ({ caseId, status: typeof c?.status === 'string' ? c.status : 'unknown' }))
            .sort((a, b) => a.caseId.localeCompare(b.caseId)),
          source: 'table',
          ...withProbe,
        };
      }
      case 'crm/update_case': {
        const caseId = typeof args.caseId === 'string' ? args.caseId : '';
        const status = typeof args.status === 'string' && args.status.length > 0 ? args.status : 'open';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId) || status.length > 32) {
          return { ...report, error: 'invalid_arguments' };
        }
        const updated = await updateTenantEntry(deps, credentials, context, 'crmCases', caseId, 'status', status);
        return { ...report, caseId, status, updated, source: 'table', ...withProbe };
      }
      default:
        return { ...report, error: 'unknown_tool' };
    }
  };
}

function synthetic(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case 'crm/get_account':
      return { account: { accountId: String(args.accountId ?? 'acc-0001'), name: 'Example Account' } };
    case 'crm/list_cases':
      return { cases: [{ caseId: 'case-0001', status: 'open' }] };
    case 'crm/update_case':
      return { caseId: String(args.caseId ?? ''), status: String(args.status ?? 'open'), updated: true };
    default:
      return { error: 'unknown_tool' };
  }
}

export const handler = toolHandler(crmWith(defaultDemoData()));

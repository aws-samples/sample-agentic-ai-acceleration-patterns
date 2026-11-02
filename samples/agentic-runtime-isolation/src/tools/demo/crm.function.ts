// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Demo tool target `crm` (spec C-4): three tools behind the tools gateway,
 * each answering with synthetic data for the tenant the signed context names
 * (P-15). It never reads a tenant from its arguments.
 */

import { toolHandler, type ToolInvocation } from '../context';

/** The tools this target serves, with their input schemas (the `ToolTarget` registers these). */
export const CRM_TOOLS = [
  {
    name: 'get_account',
    description: 'Get one account of the calling tenant',
    inputSchema: { type: 'object', properties: { accountId: { type: 'string', description: 'account id' } }, required: ['accountId'] },
  },
  {
    name: 'list_cases',
    description: 'List the open cases of one account',
    inputSchema: { type: 'object', properties: { accountId: { type: 'string', description: 'account id' } } },
  },
  {
    name: 'update_case',
    description: 'Update the status of one case',
    inputSchema: {
      type: 'object',
      properties: { caseId: { type: 'string', description: 'case id' }, status: { type: 'string', description: 'new status' } },
      required: ['caseId'],
    },
  },
] as const;

/** The demo implementation: echoes the tenant from the context and the tool's own arguments. */
export async function crm({ context, args }: ToolInvocation): Promise<Record<string, unknown>> {
  // TODO(v2): read the demo tenant table with `credentials` (the tool's TVM) once the demo grants the tool a tenant role.
  switch (context.tool) {
    case 'crm/get_account':
      return { tenantId: context.tenantId, accountId: String(args.accountId ?? ''), name: 'Example Account' };
    case 'crm/list_cases':
      return { tenantId: context.tenantId, accountId: String(args.accountId ?? ''), cases: [{ caseId: 'case-0001', status: 'open' }] };
    case 'crm/update_case':
      return { tenantId: context.tenantId, caseId: String(args.caseId ?? ''), status: String(args.status ?? 'open'), updated: true };
    default:
      return { error: 'unknown_tool' };
  }
}

export const handler = toolHandler(crm);

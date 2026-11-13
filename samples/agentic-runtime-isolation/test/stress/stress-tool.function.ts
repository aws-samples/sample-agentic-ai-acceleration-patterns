// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The stress tool (stress-test plan §8.3): one Lambda per stress tool target,
 * serving `tool_001`..`tool_NNN`. Every tool answers the same thing: the tool
 * and the tenant the signed context names and, when the target has a tool
 * tenant role (`t01`), the ARN STS reports for the vended credentials, so a
 * probe can check the credentials carry the calling tenant (§6). It reads no
 * tenant from its arguments.
 */

import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { VendedCredentials } from '../../src/shared/tvm';
import type { ToolDefinition } from '../../src/tool-target.cdk';
import { toolHandler, type ToolInvocation } from '../../src/tools/context';

/** The generated tool list of a stress target: `tool_001`..`tool_NNN`. */
export function stressTools(count: number): ToolDefinition[] {
  return Array.from({ length: count }, (_, i) => {
    const name = `tool_${String(i + 1).padStart(3, '0')}`;
    return {
      name,
      description: `Stress tool ${name}: reports the calling tenant`,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    };
  });
}

/** `GetCallerIdentity` with the given credentials; returns the caller ARN. */
export type CallerIdentity = (credentials: VendedCredentials) => Promise<string | undefined>;

/** The default caller lookup: STS with the vended credentials, nothing else. */
export const stsCallerIdentity: CallerIdentity = async (credentials) => {
  const sts = new STSClient({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
  return (await sts.send(new GetCallerIdentityCommand({}))).Arn;
};

/** The stress tool implementation (unit-tested with the caller lookup stubbed). */
export function stressToolWith(callerIdentity: CallerIdentity): (invocation: ToolInvocation) => Promise<Record<string, unknown>> {
  return async ({ context, credentials }) => ({
    tool: context.tool,
    tenantId: context.tenantId,
    callerArn: credentials === undefined ? null : ((await callerIdentity(credentials)) ?? null),
  });
}

export const handler = toolHandler(stressToolWith(stsCallerIdentity));

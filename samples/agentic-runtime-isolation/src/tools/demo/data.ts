// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tenant data for the demo tools (spec C-4, §8 fixtures, P-15). A tool
 * reaches the demo table only with the credentials its own TVM vended for
 * the tenant the signed context names (`ToolInvocation.credentials`): the
 * tool's tenant role allows item calls only where `dynamodb:LeadingKeys` is
 * `TENANT#${aws:PrincipalTag/TenantId}`, so a read of another tenant's
 * item fails in IAM whatever the code asks for.
 *
 * Each tenant's demo data is attributes of its one item, `TENANT#<id>`, in
 * the demo table (the table has a partition key only, the same item the
 * agent's `read` probe reads): `crmAccount` (map), `crmCases` (map of case
 * id to `{ status }`) and `invoices` (map of invoice id to
 * `{ amount, currency }`).
 *
 * Test mode (`RI_TOOL_TEST_MODE=true`, integration stacks only, never the
 * demo stack): a call with `probeTenantId` also tries to read that tenant's
 * item with the SAME credentials and reports only the outcome (the error
 * name), integ step 20.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { sharedHandler } from '../../shared/http';
import type { VendedCredentials } from '../../shared/tvm';
import type { ToolContext } from '../context';

/** Environment of a demo tool function (set by the demo stack). */
export const DEMO_TOOL_ENV = {
  TABLE_NAME: 'RI_TOOL_TABLE_NAME',
  TEST_MODE: 'RI_TOOL_TEST_MODE',
} as const;

/** The partition key prefix the tool tenant role pins (as the agent's tenant role, src/demo.cdk.ts). */
export const DEMO_TENANT_PREFIX = 'TENANT#';

/** What a demo tool needs to reach tenant data. */
export interface DemoDataDependencies {
  /** The demo table; undefined: synthetic answers (the demo without tenant data). */
  readonly tableName?: string;
  /** A document client signed with the vended credentials. */
  readonly client: (credentials: VendedCredentials) => Pick<DynamoDBDocumentClient, 'send'>;
  readonly testMode: boolean;
}

const handler = sharedHandler();

export function defaultDemoData(env: NodeJS.ProcessEnv = process.env): DemoDataDependencies {
  return {
    tableName: env[DEMO_TOOL_ENV.TABLE_NAME] === undefined || env[DEMO_TOOL_ENV.TABLE_NAME] === '' ? undefined : env[DEMO_TOOL_ENV.TABLE_NAME],
    client: (credentials) =>
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          requestHandler: handler,
          credentials: { ...credentials, expiration: new Date(credentials.expiration) },
        }),
      ),
    testMode: env[DEMO_TOOL_ENV.TEST_MODE] === 'true',
  };
}

/** The tenant item's key. */
export function tenantItemKey(tenantId: string): { PK: string } {
  return { PK: `${DEMO_TENANT_PREFIX}${tenantId}` };
}

/** Reads one attribute of the caller's tenant item. */
export async function readTenantAttribute(
  deps: DemoDataDependencies,
  credentials: VendedCredentials,
  context: ToolContext,
  attribute: string,
): Promise<unknown> {
  const out = await deps
    .client(credentials)
    .send(
      new GetCommand({ TableName: deps.tableName, Key: tenantItemKey(context.tenantId), ProjectionExpression: '#a', ExpressionAttributeNames: { '#a': attribute } }),
    );
  return out.Item?.[attribute];
}

/** Sets `<map>.<key>.<field>` on the caller's tenant item; false when the key does not exist. */
export async function updateTenantEntry(
  deps: DemoDataDependencies,
  credentials: VendedCredentials,
  context: ToolContext,
  map: string,
  key: string,
  field: string,
  value: string,
): Promise<boolean> {
  try {
    await deps.client(credentials).send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: tenantItemKey(context.tenantId),
        UpdateExpression: 'SET #m.#k.#f = :v',
        ConditionExpression: 'attribute_exists(#m.#k)',
        ExpressionAttributeNames: { '#m': map, '#k': key, '#f': field },
        ExpressionAttributeValues: { ':v': value },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
}

/** Test mode: the outcome of reading another tenant's item with the same credentials (integ step 20). */
export async function probeOtherTenant(
  deps: DemoDataDependencies,
  credentials: VendedCredentials,
  probeTenantId: unknown,
): Promise<{ tenant: string; result: 'ok' | 'error'; error?: string } | undefined> {
  if (!deps.testMode || typeof probeTenantId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(probeTenantId)) {
    return undefined;
  }
  try {
    await deps.client(credentials).send(new GetCommand({ TableName: deps.tableName, Key: tenantItemKey(probeTenantId), ProjectionExpression: 'PK' }));
    return { tenant: probeTenantId, result: 'ok' };
  } catch (error) {
    return { tenant: probeTenantId, result: 'error', error: error instanceof Error ? error.name : 'unknown' };
  }
}

/**
 * What every demo tool answer carries besides its data: the tenant from the
 * verified context, the client's own `tenantId` argument as the tool
 * received it (the interceptor overwrites a client value, so it equals the
 * context's), and the NAMES of the context's claims (never a value that
 * could be a token).
 */
export function contextReport(context: ToolContext, args: Record<string, unknown>): Record<string, unknown> {
  return {
    tenantId: context.tenantId,
    contextVerified: true,
    contextClaims: Object.keys(context).sort(),
    argsTenantId: typeof args.tenantId === 'string' ? args.tenantId : null,
  };
}

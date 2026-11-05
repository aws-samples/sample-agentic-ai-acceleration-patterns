// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { UnprocessedError } from '../../src/shared/batch';
import { EntitlementReader, tenantKey, userCutKey } from '../../src/shared/entitlements';

/** The ingress read (spec §3.6): a throttled key is resent, never read as absent. */
const doc = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
const reader = () => new EntitlementReader('table', 60, client, () => 1000, async () => undefined);

beforeEach(() => doc.reset());

describe('EntitlementReader.tenantEntitlement', () => {
  it('resends a throttled cut row, so a cut is never lost to throttling', async () => {
    doc
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { table: [{ ...tenantKey('t-a'), agents: ['default'], tools: ['crm/*'], status: 'active', version: 3 }] },
        UnprocessedKeys: { table: { Keys: [userCutKey('t-a', 'u1')] } },
      })
      .resolvesOnce({ Responses: { table: [{ ...userCutKey('t-a', 'u1'), cutTools: ['crm/update_case'] }] } });
    const out = await reader().tenantEntitlement('t-a', 'u1');
    expect(out.cut).toEqual({ cutAgents: [], cutTools: ['crm/update_case'] });
    expect(out.tenant?.version).toBe(3);
    expect(doc).toHaveReceivedCommandTimes(BatchGetCommand, 2);
  });

  it('fails the read (502 upstream) when keys are still unread after the retries', async () => {
    doc.on(BatchGetCommand).resolves({ Responses: { table: [] }, UnprocessedKeys: { table: { Keys: [userCutKey('t-a', 'u1')] } } });
    await expect(reader().tenantEntitlement('t-a', 'u1')).rejects.toBeInstanceOf(UnprocessedError);
    expect(doc).toHaveReceivedCommandTimes(BatchGetCommand, 3);
  });

  it('no cut row is the common case: one call, no cut', async () => {
    doc.on(BatchGetCommand).resolves({ Responses: { table: [{ ...tenantKey('t-a'), agents: [], tools: [] }] } });
    const out = await reader().tenantEntitlement('t-a', 'u1');
    expect(out.cut).toBeUndefined();
    expect(doc).toHaveReceivedCommandTimes(BatchGetCommand, 1);
  });
});

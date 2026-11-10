// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The Memory resource fence covers every data-plane operation the pinned
 * Memory SDK knows (ADR-0007, M-4). When the SDK gains an operation under
 * `/memories/{memoryId}/`, the first test fails until the operation has been
 * reviewed and added to `MEMORY_DATA_ACTIONS`.
 */

import * as sdk from '@aws-sdk/client-bedrock-agentcore';
import { fencePolicy, MEMORY_DATA_ACTIONS } from '../src/fence';
import { AGENT_OPERATIONS } from '../src/policies';

/** Every operation of the pinned client whose request URI is on one Memory resource. */
function memoryDataOperations(): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(sdk)) {
    // `$Command` is the SDK's generic base class, not an operation.
    if (!name.endsWith('Command') || name.startsWith('$') || typeof value !== 'function') {
      continue;
    }
    const schema = (new (value as new (input: object) => { schema?: unknown })({}) as { schema?: unknown }).schema;
    if (!Array.isArray(schema)) {
      throw new Error(`${name}: the SDK no longer exposes an operation schema; review how this test reads the model`);
    }
    const http = (schema[3] as { http?: [string, string, number] } | undefined)?.http;
    if (http === undefined) {
      throw new Error(`${name}: no http trait in the operation schema`);
    }
    if (http[1].startsWith('/memories/{memoryId}/')) {
      found.push(name.slice(0, -'Command'.length));
    }
  }
  return [...new Set(found)].sort();
}

describe('the fence', () => {
  it('names exactly the Memory data operations of the pinned SDK', () => {
    expect(memoryDataOperations()).toEqual([...MEMORY_DATA_ACTIONS].sort());
  });

  it('includes IngestData and the batch operations, which no Cedar action covers', () => {
    for (const name of ['IngestData', 'BatchCreateMemoryRecords', 'BatchUpdateMemoryRecords', 'BatchDeleteMemoryRecords']) {
      expect(MEMORY_DATA_ACTIONS).toContain(name);
    }
  });

  it('covers the operations agents use', () => {
    for (const name of AGENT_OPERATIONS) {
      expect(MEMORY_DATA_ACTIONS).toContain(name);
    }
  });

  it('denies every data operation to every principal but the Gateway role', () => {
    const role = 'arn:aws:iam::111122223333:role/gateway';
    const memory = 'arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/TenantMemory-abcdefghij';
    const policy = fencePolicy(memory, role) as { Statement: Array<Record<string, unknown>> };
    expect(policy.Statement).toEqual([
      {
        Sid: 'DenyDataAccessOutsideGateway',
        Effect: 'Deny',
        Principal: '*',
        Action: MEMORY_DATA_ACTIONS.map((n) => `bedrock-agentcore:${n}`),
        Resource: memory,
        Condition: { ArnNotEquals: { 'aws:PrincipalArn': role } },
      },
    ]);
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The Memory resource fence (ADR-0004, ADR-0007): a resource policy that
 * denies every Memory data-plane operation to every principal except the
 * Gateway execution role. Cedar governs requests that pass through the
 * Gateway; this policy closes the path around it, and it is the only control
 * for the operations the connector does not expose (the batch record
 * operations and `IngestData`).
 */

/**
 * Every data-plane operation on one Memory resource (request URI under
 * `/memories/{memoryId}/`). `test/fence.test.ts` compares this list with the
 * pinned Memory SDK client and fails when the client gains or loses an
 * operation, so a new operation is reviewed before it ships (ADR-0007).
 */
export const MEMORY_DATA_ACTIONS = [
  'BatchCreateMemoryRecords',
  'BatchDeleteMemoryRecords',
  'BatchUpdateMemoryRecords',
  'CreateEvent',
  'DeleteEvent',
  'DeleteMemoryRecord',
  'GetEvent',
  'GetMemoryRecord',
  'IngestData',
  'ListActors',
  'ListEvents',
  'ListMemoryExtractionJobs',
  'ListMemoryRecords',
  'ListSessions',
  'RetrieveMemoryRecords',
  'StartMemoryExtractionJob',
] as const;

/** The resource policy document for `memoryArn`, admitting only `gatewayRoleArn`. */
export function fencePolicy(memoryArn: string, gatewayRoleArn: string): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyDataAccessOutsideGateway',
        Effect: 'Deny',
        Principal: '*',
        Action: MEMORY_DATA_ACTIONS.map((name) => `bedrock-agentcore:${name}`),
        Resource: memoryArn,
        Condition: { ArnNotEquals: { 'aws:PrincipalArn': gatewayRoleArn } },
      },
    ],
  };
}

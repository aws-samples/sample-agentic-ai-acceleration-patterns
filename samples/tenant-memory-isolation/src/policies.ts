// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The two Cedar policies the Gateway's Policy engine enforces (spec §5,
 * ADR-0001, ADR-0009). Everything they do not permit is denied by default.
 *
 * - `eventWritePolicy`: `CreateEvent` only when `actorId` is the token's
 *   tenant, `sessionId` is the token's session claim (the user's `sub` by
 *   default), and the request carries no extraction override.
 * - `sharedRecallPolicy`: `RetrieveMemoryRecords` and `ListMemoryRecords`
 *   only when the exact `namespace` is the token's tenant and the request
 *   carries no hierarchical `namespacePath`.
 *
 * The strategy writes each tenant's facts to the namespace `{actorId}`, so
 * the namespace a tenant may read is its tenant id, compared without string
 * building (Cedar has no concatenation; ADR-0009). Every field is guarded
 * with `has` and each policy names only the actions that carry the fields it
 * reads, as the Memory FGAC reference requires.
 */

/** The Gateway target name: the prefix of every Cedar action id. */
export const TARGET_NAME = 'tenant-memory';

/** The Memory operations agents may call through the Gateway (ADR-0001). */
export const AGENT_OPERATIONS = ['CreateEvent', 'RetrieveMemoryRecords', 'ListMemoryRecords'] as const;

/** Cedar action ids of the connector, `<target>___<METHOD>:<uri-template>`. */
export const ACTION_IDS = {
  CreateEvent: 'POST:/memories/{memoryId}/events',
  RetrieveMemoryRecords: 'POST:/memories/{memoryId}/retrieve',
  ListMemoryRecords: 'POST:/memories/{memoryId}/memoryRecords',
  ListEvents: 'POST:/memories/{memoryId}/actor/{actorId}/sessions/{sessionId}',
  GetEvent: 'GET:/memories/{memoryId}/actor/{actorId}/sessions/{sessionId}/events/{eventId}',
  DeleteEvent: 'DELETE:/memories/{memoryId}/actor/{actorId}/sessions/{sessionId}/events/{eventId}',
  ListSessions: 'POST:/memories/{memoryId}/actor/{actorId}/sessions',
  ListActors: 'POST:/memories/{memoryId}/actors',
  GetMemoryRecord: 'GET:/memories/{memoryId}/memoryRecord/{memoryRecordId}',
  DeleteMemoryRecord: 'DELETE:/memories/{memoryId}/memoryRecords/{memoryRecordId}',
  ListMemoryExtractionJobs: 'POST:/memories/{memoryId}/extractionJobs',
  StartMemoryExtractionJob: 'POST:/memories/{memoryId}/extractionJobs/start',
} as const;

export type ConnectorOperation = keyof typeof ACTION_IDS;

/** The claims the policies read (ARCHITECTURE.md §2.1 names; ADR-0009). */
export interface ClaimNames {
  /** The tenant claim; the actor id and the namespace must equal it. */
  readonly tenant: string;
  /** The claim a write's `sessionId` must equal. */
  readonly session: string;
  /** The required `token_use` value, or undefined when the issuer emits none. */
  readonly tokenUse?: string;
}

export const DEFAULT_CLAIMS: ClaimNames = { tenant: 'tenant_id', session: 'sub', tokenUse: 'access' };

/** The Cedar action reference for one connector operation on `target`. */
export function actionRef(operation: ConnectorOperation, target: string = TARGET_NAME): string {
  return `AgentCore::Action::"${target}___${ACTION_IDS[operation]}"`;
}

function claimConditions(claims: ClaimNames): string[] {
  const tenant = `principal.getTag(${JSON.stringify(claims.tenant)})`;
  const conditions = [`principal.hasTag(${JSON.stringify(claims.tenant)})`];
  if (claims.tokenUse !== undefined) {
    conditions.push('principal.hasTag("token_use")', `principal.getTag("token_use") == ${JSON.stringify(claims.tokenUse)}`);
  }
  // The tenant id is the actor id and the namespace: one value with no path,
  // scope, or wildcard characters (M-2).
  conditions.push(`!(${tenant} like "*/*")`, `!(${tenant} like "*:*")`, `!(${tenant} like "*\\**")`);
  return conditions;
}

function render(actions: string, gatewayArn: string, conditions: string[]): string {
  return [
    'permit (',
    '    principal is AgentCore::OAuthUser,',
    `    ${actions},`,
    `    resource == AgentCore::Gateway::"${gatewayArn}"`,
    ')',
    'when {',
    conditions.map((c) => `    ${c}`).join(' &&\n'),
    '};',
    '',
  ].join('\n');
}

/** Scoped event writes: the token's tenant as actor, its session claim as session. */
export function eventWritePolicy(gatewayArn: string, claims: ClaimNames = DEFAULT_CLAIMS, target: string = TARGET_NAME): string {
  return render(`action == ${actionRef('CreateEvent', target)}`, gatewayArn, [
    ...claimConditions(claims),
    `principal.hasTag(${JSON.stringify(claims.session)})`,
    'context has input',
    'context.input has actorId',
    'context.input has sessionId',
    `context.input.actorId == principal.getTag(${JSON.stringify(claims.tenant)})`,
    `context.input.sessionId == principal.getTag(${JSON.stringify(claims.session)})`,
    '!(context.input has extractionConfig)',
  ]);
}

/** Shared recall: the exact namespace of the token's tenant, never a hierarchy. */
export function sharedRecallPolicy(gatewayArn: string, claims: ClaimNames = DEFAULT_CLAIMS, target: string = TARGET_NAME): string {
  return render(
    `action in [\n        ${actionRef('RetrieveMemoryRecords', target)},\n        ${actionRef('ListMemoryRecords', target)}\n    ]`,
    gatewayArn,
    [
      ...claimConditions(claims),
      'context has input',
      'context.input has namespace',
      `context.input.namespace == principal.getTag(${JSON.stringify(claims.tenant)})`,
      '!(context.input has namespacePath)',
    ],
  );
}

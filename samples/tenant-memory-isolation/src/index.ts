// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sample's published build-time interface (standard §1.1, §4.5; spec
 * §6.3). A consumer declares this sample as a local dependency and imports
 * from here; nothing else in src/ is a contract.
 */

export {
  TenantMemoryIsolation,
  resolveClaims,
  DEFAULT_EVENT_EXPIRY_DAYS,
  DEFAULT_TENANT_REQUESTS_PER_SECOND,
  MEMORY_STRATEGY_NAME,
  NAMESPACE_TEMPLATE,
} from './tenant-memory-isolation';
export type { TenantMemoryIsolationProps, MemoryIssuer, MemoryClaims } from './tenant-memory-isolation';
export { TARGET_NAME, AGENT_OPERATIONS, ACTION_IDS, DEFAULT_CLAIMS, eventWritePolicy, sharedRecallPolicy } from './policies';
export type { ClaimNames, ConnectorOperation } from './policies';
export { MEMORY_DATA_ACTIONS, fencePolicy } from './fence';
export { PUBLISHED_PARAMETER, PUBLISHED_VERSION } from './demo.cdk';
export type { PublishedMemoryGateway } from './demo.cdk';

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sample's published build-time interface (standard §1.1, §4.5): the
 * construct and its props. A consumer declares this sample as a local
 * dependency and imports from here; nothing else in src/ is a contract.
 */

export { IsolatedRuntime, resolveOptions, STAGE_NAME, ROUTE, GATEWAY_TARGET_NAME, INTEGRATION_TIMEOUT } from './runtime-isolation.cdk';
export type {
  IsolatedRuntimeProps,
  IdentityProps,
  AgentProps,
  SessionProps,
  DelegationProps,
  TvmProps,
  ResolvedOptions,
} from './runtime-isolation.cdk';
export type { BackendKind } from './backend/backend';
export type { IngressKind, UsageEvent } from './shared/metrics';
// The agent-to-ingress usage event (ADR-0017): a consumer's own agent ends its SSE stream with `event: usage`.
export { USAGE_EVENT, METRIC_NAMES } from './shared/metrics';
export type { SessionScope } from './shared/session';

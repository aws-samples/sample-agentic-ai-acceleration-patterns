// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sample's published build-time interface (standard §1.1, §4.5): the
 * constructs and their props. A consumer declares this sample as a local
 * dependency and imports from here; nothing else in src/ is a contract.
 *
 * `SharedIngress` plus one `AgentBackend` per agent is the construct. For a
 * single agent, give the ingress a `defaultBackend` and one `AgentBackend` of
 * that name: the backend is then served at the bare `/invocations` URL too
 * (ADR-0024).
 */

export { resolveOptions, STAGE_NAME, INTEGRATION_TIMEOUT, AUTHORIZER_CACHE_TTL, GATEWAY_TARGET_NAME } from './shared-ingress.cdk';
export type {
  IdentityProps,
  SessionProps,
  DelegationProps,
  TvmProps,
  TenantLimitsProps,
  StageThrottleProps,
  ResolvedOptions,
} from './shared-ingress.cdk';
export { ROUTE } from './shared/registry';
export type { AgentProps } from './agent-backend.cdk';
export { SharedIngress, DEFAULT_REGISTRY_PREFIX, DEFAULT_REGISTRY_TTL, PUBLISHED } from './shared-ingress.cdk';
export type { SharedIngressProps, SharedIngressRef } from './shared-ingress.cdk';
export { AgentBackend } from './agent-backend.cdk';
export type { AgentBackendProps } from './agent-backend.cdk';
export { RegistryEntryResource, LONGEST_STREAM } from './shared/registry-entry.cdk';
export type { RegistryEntryResourceProps } from './shared/registry-entry.cdk';
// The registry contract (ADR-0024): a consumer that reads or writes entries by hand uses the same names and schema.
export { BACKEND_NAME_PATTERN, INGRESS_TAG_KEY, registryParameterName } from './shared/registry';
export type { RegistryEntry } from './shared/registry';
export type { BackendKind } from './backend/backend';
export type { IngressKind, UsageEvent } from './shared/metrics';
// The agent-to-ingress usage event (ADR-0017): a consumer's own agent ends its SSE stream with `event: usage`.
export { USAGE_EVENT, METRIC_NAMES } from './shared/metrics';
export type { SessionScope } from './shared/session';

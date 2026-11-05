// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sample's published build-time interface (standard §1.1, §4.5; spec
 * §6.4): the constructs and their props. A consumer declares this sample as
 * a local dependency and imports from here; nothing else in src/ is a
 * contract.
 *
 * `SharedIngress` plus one `AgentBackend` per agent product and one
 * `ToolTarget` per tool group is the construct; (v2, ADR-0041) the ingress
 * holds one or more named tools gateways and each `ToolTarget` names one.
 * For a single agent, give the
 * ingress a `defaultBackend` and one `AgentBackend` of that name (ADR-0024).
 * (v2) `ScopeRegistration` and `backendScopesProblem` are removed (ADR-0030).
 */

export {
  resolveOptions,
  STAGE_NAME,
  INTEGRATION_TIMEOUT,
  AUTHORIZER_CACHE_TTL,
  GATEWAY_TARGET_NAME,
  DEFAULT_TRANSACTION_TOKEN_TTL,
  DEFAULT_ADMIN_SCOPE,
} from './shared-ingress.cdk';
export type {
  IdentityProps,
  SessionProps,
  TvmProps,
  TenantLimitsProps,
  StageThrottleProps,
  TransactionTokenProps,
  EntitlementsProps,
  ToolsGatewayOptions,
  ToolsGatewayRef,
  ResolvedOptions,
} from './shared-ingress.cdk';
export { ROUTE } from './shared/registry';
export type { AgentProps } from './agent-backend.cdk';
export {
  SharedIngress,
  DEFAULT_REGISTRY_PREFIX,
  DEFAULT_REGISTRY_TTL,
  MAX_REGISTRY_TTL,
  PUBLISHED,
  PUBLISHED_INGRESS_VERSION,
} from './shared-ingress.cdk';
export type { PublishedIngress, PublishedToolsGateway, SharedIngressProps, SharedIngressRef } from './shared-ingress.cdk';
export { AgentBackend } from './agent-backend.cdk';
export type { AgentBackendProps } from './agent-backend.cdk';
export { RegistryEntryResource, LONGEST_STREAM, MAX_DRAIN } from './shared/registry-entry.cdk';
export type { RegistryEntryResourceProps } from './shared/registry-entry.cdk';
// v2 constructs (spec §6.4)
export { ToolTarget, MAX_TOOLS_PER_TARGET } from './tool-target.cdk';
export type { ToolTargetProps, ToolTargetKind, ToolDefinition } from './tool-target.cdk';
export {
  ToolsGateway,
  MAX_TOOL_TARGETS,
  MCP_SUPPORTED_VERSIONS,
  DEFAULT_MAX_TOOLS_PER_GATEWAY,
  MAX_TOOLS_PER_GATEWAY_LIMIT,
} from './tools-gateway.cdk';
// The token audiences (ADR-0041): `agent:<name>` and `tools-gateway:<gateway>`; the encoded token bound (ADR-0045).
export {
  AGENT_AUDIENCE_PREFIX,
  TOOLS_GATEWAY_AUDIENCE_PREFIX,
  TOOLS_GATEWAY_NAME_PATTERN,
  DEFAULT_TOOLS_GATEWAY,
  toolsGatewayAudience,
  toolsGatewaysOf,
  MAX_TOKEN_BYTES,
} from './shared/mint';
// The Cedar star permit a ToolTarget writes (ADR-0041), for consumers that write policies by hand.
export { cedarPolicyFor, MAX_POLICY_STATEMENT_CHARS } from './shared/cedar';
export type { ToolsGatewayProps, ResolvedToolsGateway } from './tools-gateway.cdk';
export { TokenSigner } from './shared/token-signer.cdk';
export type { TokenSignerProps } from './shared/token-signer.cdk';
export { EntitlementStore } from './shared/entitlement-store.cdk';
export type { EntitlementStoreProps } from './shared/entitlement-store.cdk';
export { OwnedRows, ownerProblem, OWNER_MAX_LENGTH } from './shared/reservation.cdk';
// The registry contract (ADR-0024, ADR-0032): a consumer that reads or writes entries by hand uses the same names and schema.
export {
  BACKEND_NAME_PATTERN,
  INGRESS_TAG_KEY,
  NEEDS_NAME_PATTERN,
  TOOL_NAME_PATTERN,
  TARGET_NAME_PATTERN,
  registryParameterName,
  toolRegistryParameterName,
  backendNeedsProblem,
  backendToolsProblem,
} from './shared/registry';
export type { RegistryEntry } from './shared/registry';
// The grant rule (P-11), for consumers that test their own data.
export { grantFor, expandTools, compressTools, MAX_SCOPE_BYTES } from './shared/grant';
export type { GrantInputs, GrantResult, ToolCatalogue } from './shared/grant';
// The tool-side library (C-15b).
export { verifyToolContext, withTenantCredentials, toolHandler, kmsContextPublicKey, ContextError } from './tools/context';
export type { ToolContext, ToolInvocation } from './tools/context';
export type { BackendKind } from './backend/backend';
export type { IngressKind, UsageEvent } from './shared/metrics';
export { USAGE_EVENT, METRIC_NAMES } from './shared/metrics';
export type { SessionScope } from './shared/session';
export { TENANT_HEADER } from './shared/tenant';

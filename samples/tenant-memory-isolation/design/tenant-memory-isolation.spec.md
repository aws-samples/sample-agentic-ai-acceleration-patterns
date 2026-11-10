<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant memory isolation specification

## 1. Problem statement

Agents that serve many tenants need long-term memory that a tenant's agents
and users share and that no other tenant can read or write. The sample pools
one AgentCore Memory resource for every tenant (pool model) behind an
AgentCore Gateway with the native Memory connector, and enforces the tenant
boundary in Gateway, Policy, and IAM rather than in agent code.

What this is NOT:

- Not an identity provider: the construct trusts an issuer that meets the
  token contract (§6.1); the demo bundles a synthetic one (ADR-0013).
- Not a store for private user facts: the shared namespace is tenant-wide.
- Not a conversation-history service: stored event reads and deletion are
  not offered to agents (ADR-0005).
- Not credential vending: Memory sees only the Gateway's role (ADR-0001).
- Not multi-Region, not a control plane, not tenant onboarding.

## 2. Guiding principles

1. **P-1: The issuer owns the tenant.** Every scope value an agent may use
   comes from a signed claim; nothing in a request can widen it. One claim,
   `tenant_id`, decides both the actor and the namespace, so the two cannot
   disagree (ADR-0009).
2. **P-2: Share only what the tenant shares.** Tenant-wide memory holds
   facts every agent and user of the tenant may see; each user's events stay
   in that user's session.
3. **P-3: Deny by default, at every layer.** Policy permits three operations
   under exact conditions; the role holds three actions on one Memory; the
   fence denies every data operation outside the Gateway role. A new Memory
   operation is denied until reviewed (ADR-0007).
4. **P-4: Evidence names what it proves.** Unit tests prove policy logic and
   synthesised configuration; the integration test proves deployed
   enforcement; a probe that cannot prove its claim fails rather than
   passes.

## 3. System shape

Components: an OIDC issuer (supplied); one Memory with a semantic strategy;
one Gateway (`CUSTOM_JWT`, no MCP protocol type, Policy `ENFORCE`); one
`agentcore-memory` connector target using the Gateway role; one Policy engine
with two policies; the Gateway execution role; the Memory resource policy;
a per-tenant rate limit; Memory application-log delivery with top-tenant
rules.

Callers are tenant agents or applications presenting a user's access token.
The vendor operates the stack. Deployment inputs are the construct props
(§6.1); the demo stack's are the optional `issuerDiscoveryUrl` and
`issuerClientIds` context keys.

## 4. Data model

| Entity | Key | Notes |
| --- | --- | --- |
| Actor | `actorId` = `tenant_id` | One per tenant |
| Session | `sessionId` = the user's `sub` | One per user within the tenant |
| Event | `eventId` within actor and session | Kept `eventExpiryDays` (default 30) |
| Memory record | `memoryRecordId` in namespace = `tenant_id` | Written by the `TenantFacts` semantic strategy (template `{actorId}`) |

Tenant ids match `[A-Za-z0-9_-]{1,64}`; the policies also refuse `/`, `:`,
and `*`.

## 5. API surface

The native Memory API through the Gateway at
`<gateway origin>/tenant-memory/memories/<memoryId>/...`:

| Operation | Permitted when |
| --- | --- |
| `CreateEvent` | `actorId` = `tenant_id`, `sessionId` = session claim, no `extractionConfig` |
| `RetrieveMemoryRecords`, `ListMemoryRecords` | `namespace` = `tenant_id`, no `namespacePath` |

Every other connector operation is denied. Errors: 401 for a missing,
invalid, or expired token or a foreign client; 403 for a Policy denial;
429 above the tenant's rate.

## 6. Contracts

### 6.1 What the deployer supplies

An issuer whose access tokens carry `tenant_id` (one tenant), `sub`,
`client_id` in `allowedClients` (or `aud` in `allowedAudience`), and
`token_use: access`, with the tenant set by the vendor and immutable by the
user. Tenant ids match `[A-Za-z0-9_-]{1,64}`; the policies refuse `/`, `:`,
and `*` as a backstop for issuers that do not check. Props:

| Prop | Default | Meaning |
| --- | --- | --- |
| `issuer.discoveryUrl` | required | https OIDC discovery URL |
| `issuer.allowedClients` / `allowedAudience` | one required | Which tokens of the issuer are accepted |
| `claims.tenant` | `tenant_id` | Tenant claim |
| `claims.session` | `sub` | Session claim, must differ from the tenant claim |
| `claims.tokenUse` | `access` | `false` only with `allowedAudience` |
| `eventExpiryDays` | 30 | 7 to 365 |
| `tenantRequestsPerSecond` | 25 | Per-tenant Gateway rate |
| `logRetention` | one month | Memory application logs |

Invalid props fail synth with a message naming the prop.

### 6.2 What the sample promises

Tenant isolation of writes and recall as in §5; shared recall within a
tenant; no data path to Memory except the Gateway; per-tenant extraction
telemetry; complete teardown.

### 6.3 Published interface

- **Construct** `TenantMemoryIsolation` (src/index.ts), read-only
  properties `gatewayUrl`, `targetName`, `gatewayId`, `gatewayArn`,
  `memoryId`, `memoryArn`, `gatewayRole`, `policyEngine`, `policyEngineArn`,
  `applicationLogs`, `claims`.
- **Published parameter** (demo stack) `/application-plane/shared/memory/gateway`,
  one JSON document: `version`, `gatewayUrl`, `targetName`, `gatewayArn`,
  `memoryId`, `memoryArn`, `policyEngineArn`, `gatewayRoleArn`,
  `tenantClaim`, `sessionClaim`, `applicationLogGroup`, and `demoIssuer`
  (`userPoolId`, `appClientId`) with the bundled issuer.

### 6.4 Samples consumed

None. tenant-identity's `shared-pool` or agentic-runtime-isolation's ingress
can be the issuer through props or context (ADR-0008, ADR-0013).

<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant memory isolation specification

## Problem statement

Demonstrate a pool of tenant organisations sharing one AgentCore Memory
resource through its native HTTP connector on AgentCore Gateway. Two agents
in a tenant share deliberately selected long-term facts while keeping
separate short-term sessions; another tenant sees none of them. The
deployment model is pool: one Memory, one Gateway, one Policy engine for all
tenants.

What this is NOT:

- Not an identity provider. Tenant membership and conversation assignment
  belong to the vendor's issuer; the sample's Cognito issuer is a synthetic
  fixture (ADR-0003).
- Not a store for private user facts. Those need their own actor and
  namespace claims.
- Not a conversation history service. Stored event reads and deletion are not
  offered to agents (ADR-0005).
- Not a credential vending design. Memory sees the Gateway execution role
  only (ADR-0001).

## Guiding principles

1. **P-1: The vendor's identity provider owns the memory scope.** A caller
   cannot obtain a broader actor, session, or namespace by changing request
   arguments; every scope value comes from a signed claim, and the claims are
   built from one tenant id.
2. **P-2: Share only the facts the tenant has agreed to share.** Tenant-wide
   memory contains organisational facts, not private user preferences.
3. **P-3: A missing claim or an unlisted operation denies access.** Each
   Cedar permit names its operations and Gateway; the connector fixes the
   Memory ID; IAM permissions pin the Memory ARN; the resource fence denies
   every data operation the service model lists outside the Gateway role.
4. **P-4: Evidence distinguishes policy evaluation from deployed
   enforcement.** Local Cedar tests are real language evaluation but do not
   prove JWT validation, Gateway context mapping, extraction, or
   resource-policy enforcement; each live probe tests exactly what it names.

## System shape

The vendor supplies an OIDC issuer, a client restriction, a Gateway
execution role, one Memory resource with a semantic strategy, and a Policy
engine in `ENFORCE` mode. The issuer verifies tenant membership and
agent-session entitlement before issuing `memory_actor`, `memory_session`,
and `memory_namespace` claims. Gateway authenticates each bearer token
(`CUSTOM_JWT`) and calls Memory as its execution role (`GATEWAY_IAM_ROLE`).
The Gateway has no MCP protocol type, so it accepts the native HTTP target
(ADR-0006).

## Data model

`actorId=tenant-a` represents a tenant organisation. Its semantic strategy
writes to `/tenants/{actorId}/shared/`. Agent sessions such as `shopping-001`
and `support-001` stay separate under that actor. A token carries exactly one
session and the actor's own shared path. Actor and session ids are single
lowercase path segments.

## API surface

Native Memory HTTP operations are routed through `/{targetName}/{Memory path}`.
The SDK model supplies the method, path, and wire serialization. Agents may
call `CreateEvent` only for the signed actor and session, without an
extraction override, and `RetrieveMemoryRecords` and `ListMemoryRecords` only
for the signed `namespacePath`. Every other Memory operation is denied: event
reads and deletion, actor and session enumeration, record-ID access, batch
writes, direct ingestion, and extraction administration. Gateway returns 401
for a missing or expired token and 403 for a Policy denial.

## Contracts

The deployer supplies an issuer whose access tokens carry the three claims
above, built from one verified tenant id, and a Region with AgentCore Memory,
Gateway, and Policy. The sample promises repeatable local Cedar tests, SDK
serialization tests, configuration generation, an explicit live isolation
harness, and journalled cleanup of its disposable environment. No deployment
credentials belong in its source.

The Gateway is created with account-and-Region-scoped Policy evaluation
permissions because `CreateGateway` checks them before it returns an ID;
the driver narrows them and the role trust to the returned Gateway and
Policy engine ARNs before it adds the Memory target (ADR-0003).

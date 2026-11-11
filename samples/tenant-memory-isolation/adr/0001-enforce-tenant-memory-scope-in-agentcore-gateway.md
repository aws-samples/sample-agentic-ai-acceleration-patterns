<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0001: Enforce tenant memory scope in AgentCore Gateway with issuer-scoped claims

- Status: Accepted
- Date: 2026-11-10
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

Several agents in one tenant need shared facts while each agent's
conversation history stays its own. Tenant A's shopping and support agents
share Tenant A's facts but write to different sessions; Tenant B
has its own actor and namespace. Callers authenticate with OAuth tokens. The
vendor needs one place that decides, per request, which actor, session, and
namespace a caller may use, and a Memory resource that cannot be reached
around that place.

## Options considered

### Option 1: AgentCore Gateway with the native Memory connector and Cedar

Gateway validates issuer-signed JWTs (`CUSTOM_JWT`). AgentCore Policy in
`ENFORCE` mode compares the requested `actorId`, `sessionId`, or
`namespace` with the token's claims before the native `agentcore-memory`
connector calls Memory as the Gateway execution role
(`GATEWAY_IAM_ROLE`, the only outbound mode `CUSTOM_JWT` supports for this
connector). A Memory resource policy denies data access to every other
principal (ADR-0004).

Pros: one managed enforcement point, no vendor code on the request path,
authorization rules readable as Cedar, every request evaluated against
signed claims. Cons: OAuth claims are Cedar principal tags, not IAM session
tags, so Memory sees one shared role; tenant scope depends on Policy, and the
resource fence must keep every other principal out.

### Option 2: Token vending to the caller's IAM identity

A trusted broker exchanges verified identity for scoped STS credentials, and
the caller signs `AWS_IAM` Gateway requests that the connector forwards with
`CALLER_IAM_CREDENTIALS`.

Pros: per-tenant IAM identity reaches Memory. Cons: a broker to build and
operate, session-policy and tag rules that must express the same actor,
session, and namespace limits, and credential lifetimes to manage.

### Option 3: Interceptor vending to a custom target

A Gateway interceptor issues scoped credentials that a custom target uses
for its own Memory SDK client.

Pros: room for custom entitlement lookups. Cons: replaces the native
connector with vendor code that must reject missing credentials and never
fall back to its own role; credentials issued before Policy denies a request
still exist.

## Decision

Option 1. AgentCore Gateway with `CUSTOM_JWT`, Cedar in `ENFORCE` mode, and
the native Memory connector is the design. Agents get exactly three
operations: `CreateEvent` for their own actor and session, and
`RetrieveMemoryRecords` and `ListMemoryRecords` for their own namespace;
everything else is denied by default. Requests that carry their own
extraction configuration are denied, so the configured strategy alone places
facts in namespaces.

## Consequences

The issuer owns tenant membership and conversation assignment; Cedar owns
request authorization; the resource fence and role trust own the path around
Gateway. Agents share selected facts while their writes stay in separate
sessions. Private user facts need their own actor and namespace claims.
Revisiting this decision means adapting the fence, which today admits only
the Gateway execution role.

## References

- [Native Memory connector](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-connector.html)
- [Memory OAuth authentication and claim-based authorization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-oauth.html)
- [Policy principal types](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html)

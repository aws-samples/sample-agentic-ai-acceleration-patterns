<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0034: Serve tools through one shared AgentCore Gateway that trusts the ingress issuer, with Policy on `scope` and an interceptor that checks `act` and signs the tenant context

- Status: Accepted
- Date: 2026-11-02
- Amended by: ADR-0040
- Deciders: Dave Roberts (PSA)

## Context
The tools gateway was planned as its own sample, `agentic-tool-gateway`, consuming the user token this sample forwards (ADR-0006). Its feature review (`design/agentic-tool-gateway.review.md`) settled the request path: `CUSTOM_JWT` verify, AgentCore Policy on the token's `scope` (default deny, filters `tools/list` and refuses `tools/call`), then a REQUEST interceptor that re-verifies, writes a per-tenant log line, and signs a tenant context the Lambda tool verifies before it runs the TVM (review §3, §4). The context is signed because the Gateway calls a Lambda target with its own role and passes nothing about the caller; a plain tenant id in the arguments could have been written by the client.

With ADR-0031 the natural verifier of the transaction token is the Gateway's `CUSTOM_JWT` authoriser pointed at the ingress's discovery URL (ADR-0037). The two samples then share one issuer, one entitlement store and one demo, so they are one pattern: runtime, tools and entitlements, in one PR, one README and one blog. The OAuth authoriser checks `aud` against a list and scopes, but it cannot validate a nested claim such as `act`.

## Options considered
### Option 1: A separate sample consuming a forwarded user token
Pros: two smaller samples. Cons: the forwarded token is the identity token ADR-0031 keeps at the ingress; entitlement would live in two places; the README and threat model would be split across a boundary that is really one design.

### Option 2: Fold the tools gateway into this sample; the Gateway trusts the ingress issuer
One Gateway for every tenant; `CUSTOM_JWT` on the ingress discovery URL with `allowedAudience` `tools-gateway`; one Cedar policy per target on `scope`; the REQUEST interceptor checks `act` names the ingress role and `aud` holds the calling agent, then signs `{tenant_id, sub, tool, argsHash, exp 60 s}` with KMS and writes the log line. Pros: the transaction token is verified natively; the store is the single source of entitlement; Policy is O(targets), never O(tenants). Cons: a larger sample; Policy and a KMS `Sign` per admitted call.

### Option 3: The agent calls tools directly with TVM credentials, no gateway
Pros: no Gateway, Policy or interceptor cost; the credentials are already in the agent. Cons: no `tools/list` filtering and no MCP endpoint; every tool re-implements entitlement; the wall between tools becomes IAM on each tool's role, which the agent holds the keys to.

The review's four rejected alternatives stay rejected for the reasons it gives: credentials in the request body (they land in every request log); OBO exchange against tenant-identity (Lambda targets cannot use it, and the store now owns entitlement); one Gateway per tenant (silo, N deploys per tool change, no isolation gain because the tool still runs as the Gateway role); interceptor-only entitlement (the wall becomes vendor code, kept only as the interceptor's repeat check).

## Decision
Option 2. The Gateway verifies the transaction token, Policy enforces the grant per target, and the interceptor covers what the authoriser cannot: `act` and the agent in `aud`. It then signs the tenant context the tool trusts, with a second KMS key, `ToolContextKey`, that is never listed in the ingress JWKS, so a signed context can never pass as a transaction token and a transaction token can never pass as a context. The Gateway, Policy, interceptor and the tool-side verifier ship as the `toolsGateway` module of `SharedIngress` (on by default; `false` creates none) and the `ToolTarget` construct.

## Consequences
Easier: one issuer, one store, one demo; a tool is one `ToolTarget` construct (Lambda, OpenAPI, Smithy or MCP-server target) with one generated Cedar policy; per-tenant rate limits are native on `$.context.jwt.tenant_id`. Harder: per call the Gateway ($0.005 per 1,000), Policy ($0.025 per 1,000), KMS `Sign` ($0.003 per 1,000) and two Lambda invocations (interceptor and tool), prices as reviewed on 2026-10-30; Policy is the largest line and the interceptor-only fallback is named in the README. A known defect denies tools added after a policy is written, so `ToolTarget`'s custom resource issues a no-op `UpdatePolicy` after each sync. Follow-up: the `agentic-tool-gateway` directory is not created; its review doc already lives in this sample's `design/`; the review's spikes V-1 to V-6 run before the spec amendment is accepted. Revisit if the Gateway authoriser gains nested-claim checks (then the interceptor's `act` check moves into it), or if Policy cost per call makes the interceptor-only path the better trade.

**2026-11-02.** Amended by ADR-0040: the interceptor runs before Policy and is the first wall; policy deleted before target, sequential policy writes, 100-target cap, application logs off, OBO only with trusted authorisation servers.

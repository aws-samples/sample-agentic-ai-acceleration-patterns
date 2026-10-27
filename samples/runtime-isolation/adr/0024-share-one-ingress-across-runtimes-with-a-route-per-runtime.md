<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0024: Share one ingress across several Runtimes, one route per Runtime

- Status: Proposed
- Date: 2026-10-27
- Deciders: Dave Roberts (PSA)

## Context
`IsolatedRuntime` creates one ingress and one backend (ADR-0003, ADR-0011):
the integration Lambda or the interceptor reads one `RI_RUNTIME_ARN`, and the
Runtime's resource policy names that ingress role alone (ADR-0001). A vendor
with several agents (a support agent, a billing agent) deploys the construct
once per agent and gets one API, one authoriser, one stage throttle, one
counter table and one log drain per agent. The token check, the TVM, the
tenant limit and the metering are identical across those copies; only the
Runtime differs. Tenants call several hostnames for one product.

Constraints: P-1 (the backend trusts exactly one ingress) must hold for
every Runtime. The published interface (`endpointUrl`, `runtimeArn`, the
SSM parameters, standard §1.1) must not break for the single-agent deployer.
The AgentCore Gateway already addresses a target by URL
(`/<target>/invocations`, ADR-0010), so the shared shape must fit both
ingresses with the same client contract (spec §5).

## Options considered
### Option 1: Keep one construct per Runtime (status quo)
Pros: no change; the smallest blast radius, one ingress bug reaches one
Runtime. Cons: N copies of the identical ingress; N hostnames for one
product; N counter tables, so a tenant's limit is per agent and never per
product; N stage throttles that do not add up to a product-wide budget.

### Option 2: One ingress, one route per Runtime
`agents: Record<name, AgentProps>`; the ingress serves
`POST /<name>/invocations` for each name and maps the route to the Runtime
from a name-to-ARN map in its environment. On `agentcore-gateway` each name
is a Gateway target, which is the URL shape the Gateway already has.
Pros: one hostname, one token path, one tenant limit and one metering line
for the product; the Gateway side needs no new idea; a static resource per
name means an unknown route never reaches the Lambda. Cons: the ingress role
may invoke N Runtimes, so an ingress bug reaches all of them; on
`api-gateway` one integration Lambda's concurrency is shared by every agent,
so one slow agent can starve the rest.

### Option 3: One ingress, the tenant table picks the Runtime
The route stays `/invocations`; a tenant attribute (tier, silo) names the
Runtime. Pros: fits tiered or silo tenants. Cons: the construct would need a
tenant store it does not have today (spec §4: no stored entities); a tenant
sees one agent, which does not answer the several-agents case; a lookup per
request on the hot path before the Runtime call.

### Option 4: Share the REST API only, one integration Lambda per route
Pros: per-route reserved concurrency, so agents cannot starve each other;
each Lambda keeps one `RI_RUNTIME_ARN` and the P-1 shape per Lambda role.
Cons: N Lambdas, N log drains and N TVM caches behind one API; does not
exist on `agentcore-gateway`, where the interceptor is one function per
Gateway; most of Option 1's duplication returns behind one hostname.

## Decision
Option 2, as a proposal to be verified by implementation. `IsolatedRuntime`
accepts `agents` (several named agents) as an alternative to `agent` (one);
each name creates one Runtime whose resource policy names the one ingress
role, so P-1 holds per Runtime while the ingress may invoke every Runtime of
the construct. The route is `/<name>/invocations` on both ingresses: an API
Gateway resource per name on the same authoriser and integration Lambda, a
Gateway target per name on the same interceptor. The single `agent` prop
keeps today's URLs, so no published value changes for existing deployers.
Option 4 stays open as the answer when per-agent concurrency matters more
than one Lambda; Option 3 is a different sample (tenant tiers).

## Consequences
Easier: one hostname and one bearer token path per product; one tenant limit
across all its agents (ADR-0020); one log line and one Contributor Insights
rule set with an `agent` field (ADR-0017, ADR-0021); adding an agent is a map
entry and a deploy. Harder: the ingress role's `InvokeAgentRuntime` grant
lists every Runtime, so the ingress is a larger single point of trust
(threat model: a route-to-Runtime mapping bug sends a tenant to the wrong
agent; the vended credentials stay tenant-scoped, so data stays with the
tenant, but the wrong agent answers); on `api-gateway` the stage throttle
and the Lambda concurrency are shared by all agents, which the README must
say next to the existing 6,000-concurrent figure. One `tvm.role` serves
every agent, so an agent cannot be given a narrower tenant role than its
siblings. Follow-up: `runtimes` and `endpointUrls` on the construct and
`/application-plane/shared/agent-runtime/agents/<name>/*` parameters, with
`endpointUrl` and `runtimeArn` pointing at `defaultAgent`; spec §3.3, §5 and
§6.4 get dated notes when this ships; integ step 9 (two agents behind one
ingress, each route reaches only its Runtime); verify on first deploy that
the interceptor event names the Gateway target, or the `request admitted`
line cannot carry `agent`. Revisit if a deployer needs per-agent tenant
roles or per-agent concurrency, which points at Option 4 or a construct per
agent again.

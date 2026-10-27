<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Runtime Isolation: Architecture (draft)

> **Status: draft, not implemented.** The next version of this sample: one
> ingress shared by several AgentCore Runtimes, one route per Runtime
> (ADR-0024, Proposed). [`architecture.md`](./architecture.md) describes
> what is deployed today. Changes against it are marked **(draft)**. This
> file replaces `architecture.md` when the work ships and its integration
> run is green.

This file describes the planned state. The design trail is
[`design/runtime-isolation.spec.md`](./design/runtime-isolation.spec.md), the
[ADRs](./adr/README.md) and the [threat model](./threat-model.md).

## Purpose

A pooled agent backend where each tenant user's conversation runs in its own
compute unit (an AgentCore Runtime microVM), and every backend trusts exactly
one ingress. One ingress fronts one or more Runtimes, one per named agent
**(draft)**. The ingress verifies the token, picks the Runtime from the
route, chooses the unit, vends tenant-scoped credentials, limits each
tenant's share across all its agents, and attributes cost per tenant and
agent (ADR-0001, ADR-0012, ADR-0017, ADR-0020, ADR-0024).

## Agents and routes (draft)

| Prop | Routes | `endpointUrl` / `runtimeArn` | Published parameters |
|---|---|---|---|
| `agent` (one, today's shape) | `POST /invocations` (`api-gateway`); `POST /agent/invocations` (`agentcore-gateway`) | the one agent | unchanged |
| `agents: { support, billing }` | `POST /support/invocations`, `POST /billing/invocations` on both ingresses | the agent named by `defaultAgent` (required with more than one entry) | existing three for `defaultAgent`, plus `/application-plane/shared/agent-runtime/agents/<name>/{endpointUrl,runtimeArn}` |

`agent` and `agents` are mutually exclusive; a name is `[a-z0-9-]{1,32}`.
The construct exposes `runtimes: Record<name, { runtimeArn, endpointUrl }>`
next to the existing read-only properties.

```
client ──POST /<name>/invocations──▶ one ingress ──InvokeAgentRuntime──▶ Runtime <name>
                                       │   (route → ARN map)             resource policy:
                                       │                                 ingress role only
                                       └── same token check, TVM, limit, log line for every route
```

## Components

| Component | What it does | Code |
|---|---|---|
| Ingress, `api-gateway` | REST API with a REQUEST Lambda authoriser and a streaming integration Lambda (`responseTransferMode: STREAM`, 2-minute timeout). One static resource per agent name on the same authoriser and Lambda **(draft)**; the Lambda maps the route to a Runtime ARN from `RI_RUNTIMES` (a name-to-ARN JSON map replacing `RI_RUNTIME_ARN`), calls `InvokeAgentRuntime` and forwards the stream (ADR-0003, ADR-0009, ADR-0015, ADR-0024) | `src/ingress/api-gateway-authorizer.function.ts`, `src/ingress/api-gateway-ingress.function.ts` |
| Ingress, `agentcore-gateway` | AgentCore Gateway with a `CUSTOM_JWT` authoriser, one Runtime target per agent name **(draft)**, and one REQUEST interceptor Lambda that re-verifies the token and sets the session id and credential headers. The Gateway routes to the target named in the URL and calls that Runtime (ADR-0010, ADR-0015, ADR-0024) | `src/ingress/gateway-interceptor.function.ts` |
| Backend | One AgentCore Runtime per agent name **(draft)**. Each Runtime's resource policy allows `InvokeAgentRuntime` to the one ingress role only; the ingress role is granted every Runtime of the construct (ADR-0001, ADR-0011, ADR-0024) | `src/backend/agentcore-runtime.cdk.ts`, `src/backend/agentcore-runtime.transport.ts` |
| Agent | Code in the microVM, one `codePath` and `modelId` per name **(draft)**. It builds its AWS clients per request from the vended credentials and ends each stream with a `usage` event (ADR-0008, ADR-0017, ADR-0018) | `src/agent/app.ts` |
| Token vending machine (TVM) | Always on. `AssumeRole` plus `TagSession` on the tenant role with `TenantId` from the verified claim; a bounded LRU cache per instance with single flight, refreshed ahead of the margin for hot tag sets (ADR-0012, ADR-0018, ADR-0022, ADR-0023) | `src/shared/tvm.ts` |
| Tenant limits | A DynamoDB fixed-window counter per tenant per minute, shared by every ingress instance and by every agent behind the ingress **(draft)**: the key stays `TENANT#<id>#<minute>`, so the limit is the tenant's share of the product, not of one agent; 429 before the TVM and the backend; fail-open after a bounded wait (ADR-0020, ADR-0023, ADR-0024) | `src/shared/limits.ts` |
| Cold path | One HTTPS pool per ingress process; discovery, JWKS and the connections to STS, DynamoDB and the Runtime endpoint open during Lambda init, and the first request awaits them (ADR-0023) | `src/shared/http.ts`, `warm()` in `src/shared/request.ts` |
| Logs and metrics | A structured JSON log line per request with `tenantId`, `agent` **(draft)** and the cost figures; per-tenant EMF metrics only with `perTenantMetrics`, gaining an `Agent` dimension **(draft)** (ADR-0017, ADR-0021, ADR-0024) | `src/shared/logger.ts`, `src/shared/metrics.ts` |
| Teardown | An owned execution log group and one log drain per ingress (ADR-0019) | `src/shared/log-drain.ts` |
| Demo stack | The construct wired to tenant-identity `shared-pool` with two demo agents behind one ingress **(draft)**, a demo tenant table and role, four Contributor Insights rules on `api-gateway`, and the published SSM parameters, now also per agent (ADR-0004, ADR-0016, ADR-0024) | `src/main.ts`, `src/demo.cdk.ts` |

## Request flow

Both ingresses run the same checks in the same order:

1. Verify the token: signature, `iss`, `client_id`, `exp`, `token_use`, a single `tenant_id` (ADR-0004, ADR-0015). Refusal: 401 or 403.
2. Check required scopes and the narrowed-token rule when configured (ADR-0005, ADR-0007). Refusal: 403.
3. Pick the Runtime from the route **(draft)**: `api-gateway` has a static resource per name, so an unknown name is refused by API Gateway before the authoriser; the Gateway refuses an unknown target itself. A name present in the route but missing from the ARN map is a deploy fault: 502.
4. Parse the body: `prompt` a string, `conversationId` matching `[A-Za-z0-9]{16,64}` (spec §5). Refusal: 400.
5. Check the tenant limit: one conditional `UpdateItem` (ADR-0020). Refusal: 429, with no STS, Runtime or model call. The counter is per tenant, not per agent **(draft)**.
6. Vend credentials through the TVM, from the cache when possible (ADR-0012, ADR-0022). One `tvm.role` and one cache serve every agent **(draft)**.
7. Derive the session id from the verified claims (ADR-0002, ADR-0013). Session ids are scoped per Runtime, so the same `conversationId` on two agents is two sessions **(draft)**.
8. Invoke the chosen Runtime with the session id and the credential header; on `api-gateway`, forward the stream.
9. On `api-gateway`, read the `usage` event, add output tokens to the tenant's counter, and log `request served` with `agent`. On the interceptor, log `request admitted` before the Gateway calls the Runtime; `agent` is present only if the interceptor event names the target (to verify on first deploy, ADR-0024) **(draft)**.

## Scale limits

Values are the defaults or the documented AWS quotas on 2026-10-27. Check
[Service Quotas](https://docs.aws.amazon.com/general/latest/gr/aws_service_limits.html)
for your account and Region before sizing.

| Limit | Value | What hits it | What the sample does | Deployer action |
|---|---|---|---|---|
| API Gateway stage throttle | 50 rps, burst 25 (defaults) | All tenants and all agents together on `api-gateway` **(draft)** | `stageThrottle` prop; still shared by every tenant and agent (ADR-0020, ADR-0024) | Size it to the Runtime and Lambda limits below; add WAF |
| Per-tenant requests | 60 per minute per tenant (default) | One tenant's script | DynamoDB fixed-window counter, 429 before STS and the Runtime; up to 2x across a window boundary (ADR-0020) | Set `tenantLimits.requestsPerMinute` per tier; `0` turns it off |
| AgentCore Runtime active sessions | 2,500 per account outside us-east-1 and us-west-2; 5,000 in those two; adjustable ([source](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)) | Concurrent conversations across all tenants. With `session` off every request is its own session | Per-tenant request limit bounds one tenant's share | Request a quota increase; turn session mapping on so resumed conversations reuse a session |
| AgentCore Runtime data plane | 1,000 TPS; adjustable ([source](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)) | `InvokeAgentRuntime` across all tenants | As above | Keep the stage throttle below it |
| STS `AssumeRole` | 600 rps per account per Region, shared with other STS calls; raised by Support case | TVM cache misses: instances × tag sets ÷ credential lifetime | Bounded LRU cache, single flight, limits before STS (ADR-0022) | Keep `includeUserIdTag` off unless needed; watch STS throttling |
| Lambda concurrency | Per account per Region; see [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) | On `api-gateway` the one integration Lambda is held for the whole stream, up to the 2-minute integration timeout: 50 rps × 120 s = 6,000 concurrent, shared by every agent, so one slow agent can starve the rest **(draft)** | Nothing beyond the stage throttle | Reserved concurrency on the ingress function; prefer `agentcore-gateway` for long streams; one construct per agent, or ADR-0024 Option 4, when agents must not share concurrency |
| Amazon Bedrock model quota | Per account per model, shared by all tenants | Model tokens across all tenants | Optional `tenantLimits.outputTokensPerMinute` on `api-gateway` (ADR-0020) | Request quota per model; set the token limit per tier |
| CloudWatch custom metrics | Up to 9 per tenant per ingress when on (`TenantId` and `Ingress` dimensions); see [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) | `perTenantMetrics: true` at many tenants | Off by default, synth warning when on (ADR-0021) | Use Logs Insights and Contributor Insights at scale |
| Contributor Insights | Top 500 contributors per rule | Rules over the access log and the ingress log line | Four demo rules on `api-gateway`: requests and errors on the access log, backend seconds and output tokens on the `request served` line (ADR-0021) | Use Logs Insights for the long tail |
| TVM cache | 1000 entries per instance (default), about 1.5 MB | More active tag sets per instance than the bound | LRU eviction, expired entries dropped first (ADR-0022) | Size `tvm.cacheMaxEntries` to active tenants per instance |

## Cross-tenant data safety

Reviewed on 2026-10-27 for the scale changes. Each item was checked in code:

- The TVM cache key is the full sorted session tag set plus the role ARN, so two tenants or users never share an entry (`src/shared/tvm.ts`, ADR-0022).
- No per-request tenant state is held in module scope; module scope holds only clients, config and the credential cache.
- The `api-gateway` path forwards no client headers to the Runtime (M-8).
- `conversationId` is `[A-Za-z0-9]{16,64}` and is always qualified by a 130-bit prefix of `sha256(tenant_id|sub)` (ADR-0002).
- The agent builds its AWS clients per request from that request's credentials, never from a previous request's.
- The `usage` event is attributed to the verified tenant of the request that carried it, never to a tenant the agent names.
- Demo data access is ABAC: `GetItem` and `Query` with `dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/TenantId}` (M-10).
- The API Gateway authoriser cache is keyed on the whole `Authorization` header (ADR-0015).
- The limits counter key is built from the verified `tenant_id` only, and only `tvmCallerRole` can update it (ADR-0020).
- The Runtime is chosen from the route, never from the body or a header, and only from the static map the construct wrote at synth **(draft)**. A mapping fault sends a tenant to the wrong agent, not to another tenant's data: the vended credentials and the session id prefix are built from the verified claims alone (ADR-0002, ADR-0012, ADR-0024).
- Each Runtime's resource policy still names the one ingress role and denies every other principal (ADR-0001). What grows is the ingress role's grant: every Runtime of the construct **(draft)**.

## What the service cannot carry per tenant

Standard §4.4 asks where a shared component cannot name the tenant:

- **`agentcore-gateway` path.** The interceptor returns before the Runtime is invoked and never sees the response, so backend seconds, model tokens and streamed bytes are not metered there, and the output-token limit does not exist there. Join through the session id prefix in the `request admitted` line and the Runtime's log streams.
- **Runtime CPU and memory.** The Runtime bills active CPU and memory per session, but does not report them per tenant. Join through the session id: its prefix is logged next to `tenantId` at the ingress (ADR-0002, ADR-0017).
- **Model cost.** Read from CUR 2.0 by `iamPrincipal/TenantId` (ADR-0018), a day later. Per agent it splits by the model each agent uses; two agents on one model are told apart only by the ingress log line **(draft)**.
- **Runtime cost per agent.** Each agent is its own Runtime, so the Runtime bill is already per agent; the `agent` field on the log line joins it to the tenant **(draft)**.

See the [README](./README.md#scale-and-limits) for the props and the
[Costs](./README.md#costs) section for the attribution formula.

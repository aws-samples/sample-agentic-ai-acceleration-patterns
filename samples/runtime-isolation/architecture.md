<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Runtime Isolation: Architecture

> **Status: implemented and verified.**
> Last green integration run: 2026-10-27, a sandbox account, eu-central-1,
> both ingresses (`api-gateway` and `agentcore-gateway`), spec §8 steps 3 to
> 8b plus the per-tenant limit probe (ADR-0020). See the
> [README integration test](./README.md#integration-test) for the step table.
> Security scans: 2026-10-27, ASH 0 actionable findings; Holmes CSR v3 0 high,
> 0 medium.

This file describes what is deployed. The design trail is
[`design/runtime-isolation.spec.md`](./design/runtime-isolation.spec.md), the
[ADRs](./adr/README.md) and the [threat model](./threat-model.md).

## Purpose

A pooled agent backend where each tenant user's conversation runs in its own
compute unit (an AgentCore Runtime microVM), and the backend trusts exactly
one ingress. The ingress verifies the token, chooses the unit, vends
tenant-scoped credentials, limits each tenant's share, and attributes cost
per tenant (ADR-0001, ADR-0012, ADR-0017, ADR-0020).

## Components

| Component | What it does | Code |
|---|---|---|
| Ingress, `api-gateway` | REST API with a REQUEST Lambda authoriser and a streaming integration Lambda (`responseTransferMode: STREAM`, 2-minute timeout). The integration Lambda calls `InvokeAgentRuntime` and forwards the stream (ADR-0003, ADR-0009, ADR-0015) | `src/ingress/api-gateway-authorizer.function.ts`, `src/ingress/api-gateway-ingress.function.ts` |
| Ingress, `agentcore-gateway` | AgentCore Gateway with a `CUSTOM_JWT` authoriser and a REQUEST interceptor Lambda that re-verifies the token and sets the session id and credential headers. The Gateway calls the Runtime (ADR-0010, ADR-0015) | `src/ingress/gateway-interceptor.function.ts` |
| Backend | One AgentCore Runtime. Its resource policy allows `InvokeAgentRuntime` to the ingress role only (ADR-0001, ADR-0011) | `src/backend/agentcore-runtime.cdk.ts`, `src/backend/agentcore-runtime.transport.ts` |
| Agent | Code in the microVM. It builds its AWS clients per request from the vended credentials and ends each stream with a `usage` event (ADR-0008, ADR-0017, ADR-0018) | `src/agent/app.ts` |
| Token vending machine (TVM) | Always on. `AssumeRole` plus `TagSession` on the tenant role with `TenantId` from the verified claim; a bounded LRU cache per instance with single flight (ADR-0012, ADR-0018, ADR-0022) | `src/shared/tvm.ts` |
| Tenant limits | A DynamoDB fixed-window counter per tenant per minute, shared by every ingress instance; 429 before the TVM and the backend (ADR-0020) | `src/shared/limits.ts` |
| Logs and metrics | A structured JSON log line per request with `tenantId` and the cost figures; per-tenant EMF metrics only with `perTenantMetrics` (ADR-0017, ADR-0021) | `src/shared/logger.ts`, `src/shared/metrics.ts` |
| Teardown | An owned execution log group and one log drain per ingress (ADR-0019) | `src/shared/log-drain.ts` |
| Demo stack | The construct wired to tenant-identity `shared-pool`, a demo tenant table and role, Contributor Insights rules, and the published SSM parameters (ADR-0004, ADR-0016) | `src/main.ts`, `src/demo.cdk.ts` |

## Request flow

Both ingresses run the same checks in the same order:

1. Verify the token: signature, `iss`, `client_id`, `exp`, `token_use`, a single `tenant_id` (ADR-0004, ADR-0015). Refusal: 401 or 403.
2. Check required scopes and the narrowed-token rule when configured (ADR-0005, ADR-0007). Refusal: 403.
3. Parse the body: `prompt` a string, `conversationId` matching `[A-Za-z0-9]{16,64}` (spec §5). Refusal: 400.
4. Check the tenant limit: one conditional `UpdateItem` (ADR-0020). Refusal: 429, with no STS, Runtime or model call.
5. Vend credentials through the TVM, from the cache when possible (ADR-0012, ADR-0022).
6. Derive the session id from the verified claims (ADR-0002, ADR-0013).
7. Invoke the Runtime with the session id and the credential header; on `api-gateway`, forward the stream.
8. On `api-gateway`, read the `usage` event, add output tokens to the tenant's counter, and log `request served`. On the interceptor, log `request admitted` before the Gateway calls the Runtime.

## Scale limits

Values are the defaults or the documented AWS quotas on 2026-10-27. Check
[Service Quotas](https://docs.aws.amazon.com/general/latest/gr/aws_service_limits.html)
for your account and Region before sizing.

| Limit | Value | What hits it | What the sample does | Deployer action |
|---|---|---|---|---|
| API Gateway stage throttle | 50 rps, burst 25 (defaults) | All tenants together on `api-gateway` | `stageThrottle` prop; still shared by every tenant (ADR-0020) | Size it to the Runtime and Lambda limits below; add WAF |
| Per-tenant requests | 60 per minute per tenant (default) | One tenant's script | DynamoDB fixed-window counter, 429 before STS and the Runtime; up to 2x across a window boundary (ADR-0020) | Set `tenantLimits.requestsPerMinute` per tier; `0` turns it off |
| AgentCore Runtime active sessions | 2,500 per account outside us-east-1 and us-west-2; 5,000 in those two; adjustable ([source](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)) | Concurrent conversations across all tenants. With `session` off every request is its own session | Per-tenant request limit bounds one tenant's share | Request a quota increase; turn session mapping on so resumed conversations reuse a session |
| AgentCore Runtime data plane | 1,000 TPS; adjustable ([source](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)) | `InvokeAgentRuntime` across all tenants | As above | Keep the stage throttle below it |
| STS `AssumeRole` | 600 rps per account per Region, shared with other STS calls; raised by Support case | TVM cache misses: instances × tag sets ÷ credential lifetime | Bounded LRU cache, single flight, limits before STS (ADR-0022) | Keep `includeUserIdTag` off unless needed; watch STS throttling |
| Lambda concurrency | 1,000 per account per Region by default (unverified; check your account) | On `api-gateway` the integration Lambda is held for the whole stream, up to the 2-minute integration timeout: 50 rps × 120 s = 6,000 concurrent | Nothing beyond the stage throttle | Reserved concurrency on the ingress function, or prefer `agentcore-gateway` for long streams |
| Amazon Bedrock model quota | Per account per model, shared by all tenants | Model tokens across all tenants | Optional `tenantLimits.outputTokensPerMinute` on `api-gateway` (ADR-0020) | Request quota per model; set the token limit per tier |
| CloudWatch custom metrics | About 9 per tenant per ingress when on | `perTenantMetrics: true` at many tenants | Off by default, synth warning when on (ADR-0021) | Use Logs Insights and Contributor Insights at scale |
| Contributor Insights | Top 500 contributors per rule | Rules over the ingress log line | Two demo rules on the log line (ADR-0021) | Use Logs Insights for the long tail |
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

## What the service cannot carry per tenant

Standard §4.4 asks where a shared component cannot name the tenant:

- **`agentcore-gateway` path.** The interceptor returns before the Runtime is invoked and never sees the response, so backend seconds, model tokens and streamed bytes are not metered there, and the output-token limit does not exist there. Join through the session id prefix in the `request admitted` line and the Runtime's log streams.
- **Runtime CPU and memory.** The Runtime bills active CPU and memory per session, but does not report them per tenant. Join through the session id: its prefix is logged next to `tenantId` at the ingress (ADR-0002, ADR-0017).
- **Model cost.** Read from CUR 2.0 by `iamPrincipal/TenantId` (ADR-0018), a day later.

See the [README](./README.md#scale-and-limits) for the props and the
[Costs](./README.md#costs) section for the attribution formula.

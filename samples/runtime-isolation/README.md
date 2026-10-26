<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Runtime Isolation

A backend that trusts exactly one ingress, which maps the validated caller to
an isolated compute unit (Amazon Bedrock AgentCore Runtime first), with
optional session mapping, scope checks, delegation and a token vending machine.

This README is a placeholder written by the implementation stage; the
documentation stage replaces it with the sections of
[`docs/sample-standard.md`](../../docs/sample-standard.md) §7. Until then, the
design trail is the reference:

- [`design/runtime-isolation.spec.md`](./design/runtime-isolation.spec.md)
- [`adr/`](./adr/README.md)
- [`threat-model.md`](./threat-model.md)

Build: `npx projen build`. The construct is `IsolatedRuntime`, exported from
[`src/index.ts`](./src/index.ts); the demo stack is
[`src/main.ts`](./src/main.ts) (`--context ingress=api-gateway|agentcore-gateway`).

## Costs

The backend, the model, the gateway and the ingress Lambda are pooled across
tenants, so nothing in the bill carries a tenant tag. The ingress meters, per
request and per verified tenant, the consumption each pooled service bills
for, and publishes it as CloudWatch metrics (namespace `RuntimeIsolation`,
dimensions `TenantId` and `Ingress`). The agent reports its model usage in
the last event of its response stream; the ingress reads the figures and
never stores the content (P-10, ADR-0017).

### The usage event (agent-to-ingress contract)

Every agent response is a `text/event-stream`. Its last event is:

    event: usage
    data: {"inputTokens":123,"outputTokens":45,"modelId":"<model id>"}

- `inputTokens`, `outputTokens`: non-negative integers from the model call
  (Bedrock ConverseStream `metadata.usage`); zero, with no `modelId`, when no
  model was called (the `report`, `read <tenant>` and `stream N` probes).
- `modelId`: the id the agent called; anything not shaped like a model id,
  inference-profile id or ARN is dropped by the ingress.
- On a model failure the agent sends `event: error` with the error name and
  no usage event, so those tokens show as unattributed, never as zero.
- The ingress forwards the stream unchanged. A consumer's own agent keeps
  the metering by emitting this event last.

### The metrics

| Metric | Unit | Source | api-gateway | agentcore-gateway |
|---|---|---|---|---|
| `Requests` | Count | ingress, one per request, refusals included | yes | yes |
| `IngressDurationMs` | Milliseconds | ingress handler wall time | yes | yes |
| `BackendInvokeSeconds` | Seconds | ingress: invoke call to end of stream | yes | no |
| `ModelInputTokens` | Count | agent usage event | yes | no |
| `ModelOutputTokens` | Count | agent usage event | yes | no |
| `StreamedBytes` | Bytes | bytes forwarded to the caller | yes | no |

`Errors4xx`, `Errors5xx` and `TtfbMs` are emitted alongside (P-9). On the
agentcore-gateway ingress the REQUEST interceptor returns before the Runtime
is invoked and never sees the response, so backend seconds, tokens and bytes
are not attributed there; the dashboard says so. The demo adds Contributor
Insights rules for the top tenants by `BackendInvokeSeconds` and
`ModelOutputTokens`, and a dashboard `RuntimeIsolation-<ingress>` with one
per-tenant line per metric.

### Attribution formula

    cost(tenant) = Σ over metrics ( metric(tenant) × unit price )
                 + share of the unattributable remainder

Plug in the current prices for the deployment Region:

| Metric | Price to apply |
|---|---|
| `BackendInvokeSeconds` | AgentCore Runtime vCPU-hour and GB-hour. The Runtime bills active CPU and memory per second, so wall time is an upper bound; treat it as the share key for the Runtime's billed total rather than an exact figure |
| `ModelInputTokens`, `ModelOutputTokens` | Bedrock input and output token prices for the configured model |
| `IngressDurationMs` | Lambda GB-second (milliseconds × the ingress function's memory) |
| `Requests` | Lambda request price, plus the API Gateway REST request price or the AgentCore Gateway per-call price |
| `StreamedBytes` | Data transfer out, where billed |

**Unattributable remainder**: log storage and ingestion, the dashboard and
Contributor Insights rules, the custom metrics themselves, X-Ray traces, and
the backend time of requests whose stream broke before the usage event.
Apportion it equally across active tenants or by `Requests`, and say which.
CloudWatch bills each custom metric-dimension pair, so the metric set stays
small: the monthly metric count grows with tenants × ingresses × 9.

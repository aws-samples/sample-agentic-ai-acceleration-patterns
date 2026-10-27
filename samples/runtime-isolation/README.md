<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Runtime Isolation

A backend that trusts exactly one ingress, which maps the validated caller to
an isolated compute unit (Amazon Bedrock AgentCore Runtime first), with an
always-on token vending machine (every model call signed per tenant) and
optional session mapping, scope checks and delegation.

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

### Props and deploy notes (ADR-0018)

- The TVM is always on. `tvm` is an optional prop: unset, the construct
  creates `TenantModelRole`, a role that may invoke only the one model;
  set, you supply a role that also reaches tenant data (the construct adds
  the model grant and the deployer owns its trust and ABAC, spec §6.1). An
  **imported** `tvm.role` must already carry
  `bedrock:InvokeModel`/`...WithResponseStream` on the model, because the
  construct cannot add a policy to a role it did not create.
- The construct exposes `tenantRole` (the role every model call is signed by)
  alongside `ingressRole`, `executionRole` and `tvmCallerRole`.
- Demo (`src/main.ts`): the `--context tvm=true` flag means "demo tenant
  data" — it adds a DynamoDB table and a data-bearing tenant role. With
  `tvm` unset the demo still runs; model cost is attributed per tenant
  through the construct's default role.
- After deploy, turn on the two account-level billing options below so model
  cost splits by tenant.

## Demo

[`scripts/demo.sh`](./scripts/demo.sh) walks the primary flow against a
deployed stack. It needs tenant-identity `shared-pool` deployed in the same
account and Region, and reads both samples' published parameters.

```bash
export AWS_REGION=eu-central-1
npx cdk deploy --context ingress=api-gateway --context session=user --context requiredScopes=tenant-api/read --context forwardUserToken=true --context tvm=true
scripts/demo.sh
```

| Step | Shows |
|---|---|
| 1 | two tenants, three users (tenant-identity platform API) |
| 2 to 4 | the session follows the token: A2 and B1 reuse A1's `conversationId` and fake A1's session header, and land in their own units; A1 resumes on the same microVM |
| 5 | no token, a tampered token, an ID token: 401/403 |
| 6 | the forwarded token's scope (forwarding on) |
| 7 | A1 reads tenant A's item; tenant B's is `AccessDeniedException` from IAM |
| 8 | `stream 10` arrives as `text/event-stream` |
| 9 | a model prompt ends with the `usage` event; the per-tenant metric command |

Steps whose module is off are skipped. The script creates two tenants and
deletes them on exit, also on failure. It prints status codes, tenant ids
and report fields, never a token, password or header value
([`scripts/CONVENTIONS.md`](./scripts/CONVENTIONS.md)).

## Integration test

```bash
export AWS_REGION=eu-central-1
npx projen integ
```

[`scripts/integ.sh`](./scripts/integ.sh) reuses a published tenant-identity
`shared-pool`, or deploys and later destroys it. It deploys the four stacks of
[`test/integ.runtime.ts`](./test/integ.runtime.ts) at once, runs spec §8,
runs `scripts/demo.sh`, destroys everything from an exit trap, and fails if a
stack, parameter or log group is left behind.

Last green run: 2026-10-27, a sandbox account, eu-central-1: deploy 107 s,
steps 223 s, then the destroy (which waits about 90 s for the ADR-0019 log drain).

| Spec §8 step | api-gateway | agentcore-gateway |
|---|---|---|
| 3 direct `InvokeAgentRuntime` with the runner's credentials denied | pass | pass |
| 4a session off: `conversationId` is 400; two requests, two units | pass | not run |
| 4b A2/B1 with A1's `conversationId` and session header: own units | pass | pass |
| 5 A1 resumes on the same microVM | pass | pass |
| 6 no token 401; tampered token, ID token 403; malformed id 400 | pass | pass |
| 7 token narrowed to `tenant-api/write` refused | pass | pass |
| 8 forwarded scope reported; `requireNarrowedToken` refuses un-narrowed | pass | forwarded scope only |
| 8a A reads A; A reads B and B reads A denied by IAM; runner cannot assume the tenant role | pass | pass |
| 8b usage event on the stream; `ModelOutputTokens` per tenant in CloudWatch | pass | usage event only |
| ADR-0018 default `TenantModelRole` signs a model call | pass | not run |

Not covered yet: step 3 with a second, non-ingress role (the spike's V-1
covered it); the CloudTrail check of one `AssumeRole` per tenant per credential
lifetime; the CUR 2.0 `iamPrincipal/TenantId` line items (they arrive a day later).

### Latency (20 `report` calls, no model, warm)

| Ingress | TTFB p50 | TTFB p95 | `stream 10` TTFB | `stream 10` total |
|---|---|---|---|---|
| api-gateway | 0.193 s | 0.206 s | 0.204 s | 10.19 s |
| agentcore-gateway | 0.295 s | 0.334 s | 0.262 s | 10.23 s |

Both ingresses stream: the first event of `stream 10` arrives after about
0.2 s and the last after about 10 s. This is one run from one client; it is
an input to ADR-0009, not a benchmark.

## Scale and limits

The pool is shared, so the construct limits each tenant's share and keeps its
own cost flat as tenants grow. Every value, the AWS quota it protects and the
deployer action are in [`architecture.md`](./architecture.md#scale-limits).

| Prop | Default | What it does |
|---|---|---|
| `tenantLimits.requestsPerMinute` | 60 | Requests per tenant per minute, counted fleet-wide in a DynamoDB table; a hit is 429 before STS, the Runtime or the model (ADR-0020). `0` turns it off |
| `tenantLimits.outputTokensPerMinute` | unset (off) | Model output tokens per tenant per minute; `api-gateway` only, synth fails otherwise (ADR-0020) |
| `tenantLimits: false` | | No table and no per-tenant limit |
| `stageThrottle` | `{ rateLimit: 50, burstLimit: 25 }` | The API Gateway stage throttle; `api-gateway` only; shared by all tenants (ADR-0020) |
| `perTenantMetrics` | `false` | Per-tenant CloudWatch metrics (ADR-0017, ADR-0021) |
| `tvm.cacheMaxEntries` | 1000 | Credential cache entries per Lambda instance, LRU, about 1.5 KB each (ADR-0022) |

**Cost warning: `perTenantMetrics: true` adds about 9 CloudWatch custom
metrics per tenant per ingress, billed monthly. At 10,000 tenants that is
about 90,000 metrics.** The synth prints a warning when it is on. The ingress
log line carries the same figures, so use Logs Insights or Contributor
Insights at scale.

The limit is a fixed one-minute window: a tenant can reach up to twice the
limit across a window boundary. If DynamoDB errors, requests are admitted and
an error is logged. Demo: `--context requestsPerMinute=<n>`,
`--context outputTokensPerMinute=<n>`, `--context perTenantMetrics=true`.

## Costs

The backend, the model, the gateway and the ingress Lambda are pooled across
tenants, so nothing in the bill carries a tenant tag. Two mechanisms make
cost attributable per tenant:

- **Model tokens come from the bill, by IAM principal (ADR-0018).** The agent
  signs every model call with credentials vended from the verified token and
  tagged `TenantId`, so AWS attributes the model cost to
  `iamPrincipal/TenantId` in CUR 2.0 and Cost Explorer — the bill is the
  source of truth for model cost, independent of what the agent reports.
- **Everything else the ingress meters per tenant.** For the consumption each
  other pooled service bills for (requests, ingress compute, backend seconds,
  bytes), the ingress writes the figures with `tenantId` on its structured
  log line (`request served` on `api-gateway`, `request admitted` on the
  interceptor). Per-tenant CloudWatch metrics (namespace `RuntimeIsolation`,
  dimensions `TenantId` and `Ingress`) are opt-in with `perTenantMetrics`
  (ADR-0021).

The agent still reports its model token usage in the last event of its
response stream; the ingress reads the figures and never stores the content
(P-10, ADR-0017). Those figures and the `ModelInputTokens` / `ModelOutputTokens`
metrics are a near-real-time **cross-check** against the bill, not the billing
source.

### Turn on model-cost attribution (one-time, account level)

CUR 2.0 does not split cost by IAM principal until the deployer turns it on.
Both settings are account-level, so the construct cannot set them; do them
once per account:

1. In **Billing → Cost allocation tags**, activate the `iamPrincipal/TenantId`
   cost allocation tag.
2. In the CUR 2.0 data export, enable **"Include caller identity (IAM
   principal) allocation data"**.

Model cost per tenant is then one query over CUR 2.0's `line_item_iam_principal`
and `iamPrincipal/TenantId` columns.

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

Emitted only with `perTenantMetrics: true` (ADR-0021). With it off, the log
line carries the same figures as `ttfbMs`, `streamedBytes`,
`backendInvokeSeconds`, `usageInput`, `usageOutput` and `modelId`, so every
row below can be summed per tenant with Logs Insights.

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
Insights rules for the top tenants by backend seconds and output tokens,
which read the log line (`$.backendInvokeSeconds`, `$.usageOutput`) and so
work with metrics off. The dashboard `RuntimeIsolation-<ingress>`, with one
per-tenant line per metric, is added only with
`--context perTenantMetrics=true`.

### Attribution formula

    cost(tenant) = Σ over metrics ( metric(tenant) × unit price )
                 + share of the unattributable remainder

Plug in the current prices for the deployment Region:

| Metric | Price to apply |
|---|---|
| `BackendInvokeSeconds` | AgentCore Runtime vCPU-hour and GB-hour. The Runtime bills active CPU and memory per second, so wall time is an upper bound; treat it as the share key for the Runtime's billed total rather than an exact figure |
| `ModelInputTokens`, `ModelOutputTokens` | Cross-check only (ADR-0018). The billed model cost per tenant is read from CUR 2.0 by `iamPrincipal/TenantId`, not computed from these metrics; use them to spot drift, not to bill |
| `IngressDurationMs` | Lambda GB-second (milliseconds × the ingress function's memory) |
| `Requests` | Lambda request price, plus the API Gateway REST request price or the AgentCore Gateway per-call price |
| `StreamedBytes` | Data transfer out, where billed |

Model cost itself is the CUR 2.0 figure keyed on `iamPrincipal/TenantId`
(above), added to the metered total per tenant.

**Unattributable remainder**: log storage and ingestion, the dashboard and
Contributor Insights rules, the custom metrics themselves, X-Ray traces, and
the backend time of requests whose stream broke before the usage event.
Apportion it equally across active tenants or by `Requests`, and say which.
CloudWatch bills each custom metric-dimension pair: with `perTenantMetrics`
on, the monthly metric count grows with tenants × ingresses × 9, which is why
it is off by default (ADR-0021). Contributor Insights bills per rule and per
matched log event, not per tenant.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Agentic Runtime Isolation: Architecture

> **Status: implemented and verified by the integration run of 2026-10-29.**
> Last green integration run: 2026-10-29, a sandbox account, eu-central-1,
> both ingresses (`api-gateway` and `agentcore-gateway`), spec §8 steps 3 to
> 8b, the per-tenant limit probe (ADR-0020), step 9-registry (ADR-0024:
> two backends behind one ingress, an unknown name, a backend added and
> drained after the ingress deploy) and the ADR-0025 checks (each backend
> owns its scopes, registered with tenant-identity's catalogue at deploy,
> any one of them admits; tenant and user entitlement refused at the
> exchange; the ingress-wide floor on the narrowed stack). Step 1 reused the
> published tenant-identity (`GET /platform/scopes` 200); the run before it
> had found that deployment stale (no `/platform/scopes` route) and
> republished it from `../tenant-identity`. See the
> [README integration test](./README.md#integration-test) for the step table.
> Security scans: 2026-10-27, ASH 0 actionable findings; Holmes CSR v3 0 high,
> 0 medium; dispositions in the [threat model](./threat-model.md#security-review).
> Also checked by hand on 2026-10-27 (`api-gateway`, `outputTokensPerMinute=200`,
> per-tenant metrics off): tenant A was refused with 429 after 233 output tokens
> while tenant B was served; the ingress log has `tenantId` and the cost figures
> as top-level fields, with no EMF records; the four Contributor Insights
> rules reported both tenants (requests, errors, backend seconds, output tokens).

This file describes what is deployed. The design trail is
[`design/runtime-isolation.spec.md`](./design/runtime-isolation.spec.md), the
[ADRs](./adr/README.md) and the [threat model](./threat-model.md).

## Purpose

A pooled agent backend where each tenant user's conversation runs in its own
compute unit (an AgentCore Runtime microVM), and every backend trusts exactly
one ingress. One ingress fronts one or more Runtimes, one per registered
backend. The ingress verifies the token, looks the backend up from the
route, requires one of the backend's own scopes, chooses the unit, vends
tenant-scoped credentials, limits each tenant's share across all its
backends, and attributes cost per tenant and backend (ADR-0001, ADR-0005,
ADR-0012, ADR-0017, ADR-0020, ADR-0024, ADR-0025). Each backend owns its
scopes, named after it, and puts them in the identity provider's catalogue
when it deploys; who holds a scope is decided at the identity provider, per
tenant and per user.

## Backends, routes and the registry

| Construct | Creates | Route | Published parameters |
|---|---|---|---|
| `SharedIngress` | the ingress alone: API or Gateway, authoriser, TVM, limits, log drain | `POST /{backend}/invocations` on both ingresses, one API resource; with `defaultBackend`, also `POST /invocations` on `api-gateway` | `<registryPrefix>{endpointUrl,baseUrl,ingressRoleArn,ingressId,ingress,tenantRoleArn}` (`gatewayIdentifier` on the Gateway) |
| `AgentBackend(ingress)` | one Runtime, its resource policy naming the ingress role, its scope registration with tenant-identity, its registry entry, its Gateway target | served under its name | `<registryPrefix>backends/<name>`; its scopes in tenant-identity's catalogue (`GET /platform/scopes`) |
| One backend: a `SharedIngress` with `defaultBackend` plus one `AgentBackend` of that name | the ingress and one Runtime | `POST /invocations` and `POST /default/invocations` (`api-gateway`); `POST /default/invocations` (`agentcore-gateway`) | the single-backend set; the demo stack adds `runtimeArn` |

A backend name is `[a-z0-9-]{1,32}`. The registry entry is a JSON string
`{ "runtimeArn", "scopes": ["<name>/<action>", ...], "status": "active" | "draining" }`
in SSM Parameter Store under `registryPrefix` (default
`/application-plane/shared/agent-runtime/`; set it when one account runs
several ingresses). The ingress caches it per process for `registryTtl`
(60 s default, at most 750 s) and serves a stale entry while it refreshes;
a refresh that fails backs off, and an entry older than ten times the TTL
is no longer served (502 `registry_unavailable`). The ingress accepts an
entry only when its `runtimeArn` is in the ingress's own partition, Region
and account. The backend role may write and delete its own name only, and
its custom resource refuses to create a name that already exists and drains
only an entry whose `runtimeArn` is its own; the ingress role reads the
prefix only. Creating, updating or deleting a backend never redeploys the
ingress: a change is live within one TTL, and a delete sets `draining`
first so running streams finish (ADR-0024).

Each backend's `scopes` are its own (ADR-0025): at least one, named
`<name>/<action>` with `<name>` the backend's name, so two backends cannot
share a scope. A `ScopeRegistration` custom resource puts them in
tenant-identity's scope catalogue (`PUT /platform/scopes/{scope}`, SigV4
signed by a role carrying the published `PlatformInvokePolicy`) before the
registry entry is written, and removes them on delete (best effort). The
ingress admits a token that carries any one of them (OR), after the optional
ingress-wide `requiredScopes` floor (AND). Entitlement is the identity
provider's: a tenant holds a scope through `CreateTenant.scopes` or
`UpdateTenant`, a user through the tenant admin's `PATCH
/tenant/users/{username}`, and a token narrowed to a scope the user does not
hold is refused at the exchange, never reaching the ingress.

```
client ──POST /<backend>/invocations──▶ one ingress ──InvokeAgentRuntime──▶ Runtime <backend>
                                          │  lookup <backend> in registry      resource policy:
                                          │  (SSM, cached registryTtl)         ingress role only
                                          │  token carries one of its scopes?
                                          └── same token check, TVM, limit, log line for every route

AgentBackend stack ──PUT /platform/scopes/<name>/<action>──▶ tenant-identity catalogue   (no identity deploy)
                   ──writes──▶ registry entry, Runtime policy, Gateway target          (no ingress deploy)
```

## Components

| Component | What it does | Code |
|---|---|---|
| `SharedIngress` | The construct that creates one ingress (either kind), the TVM and limits wiring, the log drain, the ingress role with its tag-conditioned invoke grant, the registry read grant, and the published parameters. `fromParameters(scope, id, prefix, ingress)` imports an ingress from another stack, and is the only way an `AgentBackend` in another stack may name it | `src/shared-ingress.cdk.ts` |
| `AgentBackend` | The construct that creates one Runtime tagged `ri:ingress = <ingressId>`, writes its resource policy naming the ingress role, adds the one-model statement to the tenant role, on `agentcore-gateway` adds the Gateway target, registers its scopes, and writes the registry entry last. Refuses at synth a scope list that is empty, repeats a name, or names a scope not owned by the backend | `src/agent-backend.cdk.ts` |
| Scope registration | The custom resource behind each backend's scopes (ADR-0025): Create and Update `PUT /platform/scopes/{scope}` for each (Update also `DELETE`s the dropped ones) and fail the deploy on a refused or unreachable API; Delete `DELETE`s each, best effort. Every `PUT` writes the description `<StackId>#<LogicalResourceId>` as an ownership marker; Create `GET`s each scope first and fails with `scope <name> already registered by another stack` when the marker names another stack, taking the physical id `scope-registration:<backend>:unclaimed` so the rollback's Delete is a no-op; Delete skips a scope whose marker names another stack. Each call has a 10 s abort timeout and one retry on 429, 5xx or a transport error, and the handler answers CloudFormation before its own Lambda timeout. `ApiUrl` must be an `https` URL whose hostname ends `.execute-api.<region>.amazonaws.com`. SigV4 over `execute-api` with the function's own role, which carries tenant-identity's published `PlatformInvokePolicy` less an inline Deny on every `/platform/tenants*` route; the API URL and policy ARN are read from `/application-plane/shared/identity/{apiUrl,platformInvokePolicyArn}` at deploy time. Renaming the backend replaces the resource, so the old name's scopes are deleted. Fixed physical id per backend, no log on success | `src/shared/scope-registration.cdk.ts`, `src/shared/scope-registration.function.ts` |
| Registry entry | The custom resource behind each entry: Create writes `active` and refuses an existing name; Update overwrites; Delete sets `draining`, waits one TTL plus the longest stream, then removes the entry, and only when the entry's `runtimeArn` is its own. Depends on the scope registration | `src/shared/registry-entry.cdk.ts`, `src/shared/registry-entry.function.ts` |
| Registry cache | Per-process cache of entries keyed by name: stale-while-refresh, back-off on a failed refresh, a maximum stale age of ten times `registryTtl`, and the partition, Region and account check against the ingress's own (`RI_REGISTRY_ACCOUNT`). The parser requires `scopes`; an entry without it is refused with 502, never read as "no scopes" | `src/shared/registry.ts` |
| Scope checks | `missingScopes` (AND) for the ingress-wide floor and `hasAnyScope` (OR) for the backend's own scopes, one copy for the authoriser and the pipeline; an empty backend list admits no token | `src/shared/headers.ts` |
| Ingress, `api-gateway` | REST API with a REQUEST Lambda authoriser and a streaming integration Lambda (`responseTransferMode: STREAM`, 2-minute timeout). One `/{backend}/invocations` resource on the same authoriser and Lambda; the authoriser resolves the name through the registry cache and requires one of the backend's scopes, the Lambda reads the resolved Runtime ARN from the authoriser context, calls `InvokeAgentRuntime` and forwards the stream (ADR-0003, ADR-0005, ADR-0009, ADR-0015, ADR-0024, ADR-0025) | `src/ingress/api-gateway-authorizer.function.ts`, `src/ingress/api-gateway-ingress.function.ts` |
| Ingress, `agentcore-gateway` | AgentCore Gateway with a `CUSTOM_JWT` authoriser (`allowedScopes` is the product floor only, so a backend added later needs no Gateway redeploy), one Runtime target per backend created by the backend's own stack, and one REQUEST interceptor Lambda that re-verifies the token, requires one of the target's `scopes` from the registry and sets the session id and credential headers. The Gateway routes to the target named in the URL and calls that Runtime; the name is always in the path, there is no default backend on this ingress (ADR-0005, ADR-0010, ADR-0015, ADR-0024, ADR-0025) | `src/ingress/gateway-interceptor.function.ts` |
| Backend | One AgentCore Runtime per backend. Each Runtime's resource policy allows `InvokeAgentRuntime` to the one ingress role only, on the Runtime ARN (the service accepts exactly one resource per statement), and denies the other entry points to `*`; the ingress role is granted the Runtime ARN pattern with a `ri:ingress` tag condition; `InvokeAgentRuntime` honours `aws:ResourceTag` on both the Runtime and its endpoint, and a tag set at creation is copied to the `DEFAULT` endpoint (checked 2026-10-28), so the tag goes on `CfnRuntime.tags` (ADR-0001, ADR-0011, ADR-0024) | `src/backend/agentcore-runtime.cdk.ts`, `src/backend/agentcore-runtime.transport.ts` |
| Agent | Code in the microVM, one `codePath` and `modelId` per backend. It builds its AWS clients per request from the vended credentials and ends each stream with a `usage` event (ADR-0008, ADR-0017, ADR-0018) | `src/agent/app.ts` |
| Token vending machine (TVM) | Always on. `AssumeRole` plus `TagSession` on the tenant role with `TenantId` from the verified claim; a bounded LRU cache per instance with single flight, refreshed ahead of the margin for hot tag sets (ADR-0012, ADR-0018, ADR-0022, ADR-0023) | `src/shared/tvm.ts` |
| Tenant limits | A DynamoDB fixed-window counter per tenant per minute, shared by every ingress instance and by every backend behind the ingress: the key is `TENANT#<id>#<minute>`, so the limit is the tenant's share of the product, not of one backend; 429 before the TVM and the backend; fail-open after a bounded wait (ADR-0020, ADR-0023, ADR-0024) | `src/shared/limits.ts` |
| Cold path | One HTTPS pool per ingress process; discovery, JWKS and the connections to STS, DynamoDB and the Runtime endpoint open during Lambda init, and the first request awaits them (ADR-0023) | `src/shared/http.ts`, `warm()` in `src/shared/request.ts` |
| Logs and metrics | A structured JSON log line per request with `tenantId`, `backend` and the cost figures; per-tenant EMF metrics only with `perTenantMetrics`, with a `Backend` dimension (ADR-0017, ADR-0021, ADR-0024) | `src/shared/logger.ts`, `src/shared/metrics.ts` |
| Teardown | An owned execution log group and one log drain per ingress (ADR-0019) | `src/shared/log-drain.ts` |
| Demo stack | A `SharedIngress` wired to tenant-identity `shared-pool` with `defaultBackend: 'default'`, the `default` backend owning `default/chat`, a demo tenant table and role, four Contributor Insights rules on `api-gateway`, and the published SSM parameters, also per backend; with `billingBackend` a second backend, `billing`, owning `billing/read` and `billing/invoke` (ADR-0004, ADR-0016, ADR-0024, ADR-0025) | `src/main.ts`, `src/demo.cdk.ts` |

## Request flow

Both ingresses run the same checks in the same order:

1. Verify the token: signature, `iss`, `client_id`, `exp`, `token_use`, a single `tenant_id` (ADR-0004, ADR-0015). Refusal: 401 or 403.
2. Check the ingress-wide required scopes and the narrowed-token rule when configured (ADR-0005, ADR-0007). Refusal: 403.
3. Resolve the backend from the route: the path is `/{backend}/invocations` exactly (a stage-prefixed path is not accepted); on `api-gateway` the bare `/invocations` resolves to `defaultBackend`. Look the name up in the registry cache (one SSM read per cold instance or expired entry). Unknown or `draining`: 404; an entry outside the ingress's partition, Region or account, or one the cache can no longer serve: 502. Then require any one of the backend's `scopes` on the token (OR): 403 `backend_scope_missing`. The authoriser result is cached per token and route (ADR-0005, ADR-0015, ADR-0024, ADR-0025).
4. Parse the body: `prompt` a string, `conversationId` matching `[A-Za-z0-9]{16,64}` (spec §5). Refusal: 400.
5. Check the tenant limit: one conditional `UpdateItem` (ADR-0020). Refusal: 429, with no STS, Runtime or model call. The counter is per tenant, not per backend.
6. Vend credentials through the TVM, from the cache when possible (ADR-0012, ADR-0022). One `tvm.role` and one cache serve every backend.
7. Derive the session id from the verified claims (ADR-0002, ADR-0013). Session ids are scoped per Runtime, so the same `conversationId` on two backends is two sessions.
8. Invoke the resolved Runtime with the session id and the credential header; on `api-gateway`, forward the stream.
9. On `api-gateway`, read the `usage` event, add output tokens to the tenant's counter, and log `request served` with `backend`. On the interceptor, log `request admitted` before the Gateway calls the Runtime; the interceptor event names the target, so `backend` is present.

## Scale limits

Values are the defaults or the documented AWS quotas on 2026-10-28. Check
[Service Quotas](https://docs.aws.amazon.com/general/latest/gr/aws_service_limits.html)
for your account and Region before sizing.

| Limit | Value | What hits it | What the sample does | Deployer action |
|---|---|---|---|---|
| API Gateway stage throttle | 50 rps, burst 25 (defaults) | All tenants and all backends together on `api-gateway` | `stageThrottle` prop; still shared by every tenant and backend (ADR-0020, ADR-0024) | Size it to the Runtime and Lambda limits below; add WAF |
| Per-tenant requests | 60 per minute per tenant (default) | One tenant's script | DynamoDB fixed-window counter, 429 before STS and the Runtime; up to 2x across a window boundary (ADR-0020) | Set `tenantLimits.requestsPerMinute` per tier; `0` turns it off |
| AgentCore Runtime active sessions | 2,500 per account outside us-east-1 and us-west-2; 5,000 in those two; adjustable ([source](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)) | Concurrent conversations across all tenants. With `session` off every request is its own session | Per-tenant request limit bounds one tenant's share | Request a quota increase; turn session mapping on so resumed conversations reuse a session |
| AgentCore Runtime data plane | 1,000 TPS; adjustable ([source](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)) | `InvokeAgentRuntime` across all tenants | As above | Keep the stage throttle below it |
| STS `AssumeRole` | 600 rps per account per Region, shared with other STS calls; raised by Support case | TVM cache misses: instances × tag sets ÷ credential lifetime | Bounded LRU cache, single flight, limits before STS (ADR-0022) | Keep `includeUserIdTag` off unless needed; watch STS throttling |
| Lambda concurrency | Per account per Region; see [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) | On `api-gateway` the one integration Lambda is held for the whole stream, up to the 2-minute integration timeout: 50 rps × 120 s = 6,000 concurrent, shared by every backend, so one slow backend can starve the rest | Nothing beyond the stage throttle | Reserved concurrency on the ingress function; prefer `agentcore-gateway` for long streams; a separate `SharedIngress` per backend, or ADR-0024 Option 4, when backends must not share concurrency |
| SSM Parameter Store reads | 40 TPS per account per Region standard; higher throughput is a paid setting ([source](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-throughput.html)) | Registry misses: ingress instances × backends ÷ `registryTtl` | Per-process cache, 60 s default and 750 s at most; a miss serves the stale entry while refreshing, a failed refresh backs off, and an entry older than ten TTLs is refused with 502 (ADR-0024) | Raise `registryTtl`; turn on higher throughput for very large fleets |
| Amazon Bedrock model quota | Per account per model, shared by all tenants | Model tokens across all tenants | Optional `tenantLimits.outputTokensPerMinute` on `api-gateway` (ADR-0020) | Request quota per model; set the token limit per tier |
| CloudWatch custom metrics | Up to 9 per tenant per ingress when on (`TenantId`, `Ingress` and `Backend` dimensions); see [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) | `perTenantMetrics: true` at many tenants | Off by default, synth warning when on (ADR-0021) | Use Logs Insights and Contributor Insights at scale |
| Contributor Insights | Top 500 contributors per rule | Rules over the access log and the ingress log line | Four demo rules on `api-gateway`: requests and errors on the access log, backend seconds and output tokens on the `request served` line (ADR-0021) | Use Logs Insights for the long tail |
| TVM cache | 1000 entries per instance (default), about 1.5 MB | More active tag sets per instance than the bound | LRU eviction, expired entries dropped first (ADR-0022) | Size `tvm.cacheMaxEntries` to active tenants per instance |

## Cross-tenant data safety

Reviewed on 2026-10-28 for the shared ingress. Each item was checked in code:

- The TVM cache key is the full sorted session tag set plus the role ARN, so two tenants or users never share an entry (`src/shared/tvm.ts`, ADR-0022).
- No per-request tenant state is held in module scope; module scope holds only clients, config, the credential cache and the registry cache.
- The `api-gateway` path forwards no client headers to the Runtime (M-8).
- `conversationId` is `[A-Za-z0-9]{16,64}` and is always qualified by a 130-bit prefix of `sha256(tenant_id|sub)` (ADR-0002).
- The agent builds its AWS clients per request from that request's credentials, never from a previous request's.
- The `usage` event is attributed to the verified tenant of the request that carried it, never to a tenant the agent names.
- Demo data access is ABAC: `GetItem` and `Query` with `dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/TenantId}` (M-10).
- The API Gateway authoriser cache is keyed on the whole `Authorization` header (ADR-0015).
- The limits counter key is built from the verified `tenant_id` only, and only `tvmCallerRole` can update it (ADR-0020).
- The Runtime is chosen from the route, never from the body or a header, and only through the registry entry for that name. A wrong entry sends a tenant to the wrong backend, not to another tenant's data: the vended credentials and the session id prefix are built from the verified claims alone (ADR-0002, ADR-0012, ADR-0024).
- The registry is a trust boundary (threat model B6, T-39): only the backend's own role may write its name (`ssm:PutParameter` and `DeleteParameter` on that one parameter), the ingress role may only read the prefix, and the ingress refuses an entry whose `runtimeArn` is outside its own partition, Region and account.
- A token reaches only the backends one of whose `scopes` it carries; the ingress-wide list stays as the floor (ADR-0005, ADR-0025). Which scopes a token can carry is decided at the identity provider per tenant and per user, so a tenant not entitled to `billing/*` cannot obtain a token for billing at all.
- The scope registration's role holds tenant-identity's `PlatformInvokePolicy`, every `/platform/*` route, less an inline Deny on every `/platform/tenants*` route (threat model B7, T-41), so of the policy's routes it reaches the catalogue alone. What remains is wider than one backend's names: a compromised backend stack could delete another backend's scopes from the catalogue, but not register a scope another stack owns (the ownership marker in the scope's description is checked before each Create), not change a tenant's entitlement, users or data, not route a request (the registry entry is pinned to the backend's own name at synth) and not reach another tenant's data. A direct invoker of the registration function can pick any `Backend` in the event; the handler re-validates the shape and the owner rule, and the control on who may invoke the function or assume its role is IAM (residual, T-41).
- Each Runtime's resource policy names the one ingress role on the Runtime ARN and denies every other principal (ADR-0001). The ingress role's grant is a Runtime ARN pattern with a `ri:ingress` tag condition instead of a list, so the resource policy carries P-1 alone if the condition is not honoured (threat model T-40).

## Differences from the specification

Where the implemented state differs from
[`design/runtime-isolation.spec.md`](./design/runtime-isolation.spec.md), the
specification carries a dated amendment that points here.

- **ADR-0025 (amended 2026-10-29).** The scope registration claims ownership
  of each scope: every `PUT /platform/scopes/{scope}` writes the description
  `<StackId>#<LogicalResourceId>`, Create `GET`s each scope first and fails
  the deploy with `scope <name> already registered by another stack` when
  the marker names another stack (the resource then holds the physical id
  `scope-registration:<backend>:unclaimed`, whose Delete is a no-op), and
  Delete skips a scope another stack owns. The specification's registration
  was an unconditional `PUT`. Each platform call has a 10 s abort timeout
  and one retry on 429, 5xx or a transport error; the handler answers
  CloudFormation before its Lambda timeout. `ApiUrl` must be `https` with a
  hostname ending `.execute-api.<region>.amazonaws.com`. Renaming a backend
  replaces the registration, so the old name's scopes are deleted from the
  catalogue. The function's role carries the `PlatformInvokePolicy` less an
  inline Deny on every `/platform/tenants*` route; the policy also grants
  `kms:Encrypt` and `kms:GenerateDataKey` on tenant-identity's admin-password
  key under `kms:ViaService = ssm`, which the function never uses (inert). The integration driver
  replaces a stale published tenant-identity only with
  `INTEG_REPLACE_STALE_IDENTITY=1`, otherwise failing with instructions, and
  its cleanup verifies that the demo scopes are gone from a reused catalogue.

## What the service cannot carry per tenant

Standard §4.4 asks where a shared component cannot name the tenant:

- **`agentcore-gateway` path.** The interceptor returns before the Runtime is invoked and never sees the response, so backend seconds, model tokens and streamed bytes are not metered there, and the output-token limit does not exist there. Join through the session id prefix in the `request admitted` line and the Runtime's log streams.
- **Runtime CPU and memory.** The Runtime bills active CPU and memory per session, but does not report them per tenant. Join through the session id: its prefix is logged next to `tenantId` at the ingress (ADR-0002, ADR-0017).
- **Model cost.** Read from CUR 2.0 by `iamPrincipal/TenantId` (ADR-0018), a day later. Per backend it splits by the model each backend uses; two backends on one model are told apart only by the ingress log line.
- **Runtime cost per backend.** Each backend is its own Runtime, so the Runtime bill is already per backend; the `backend` field on the log line joins it to the tenant.

See the [README](./README.md#scale-and-limits) for the props and the
[Costs](./README.md#costs) section for the attribution formula.

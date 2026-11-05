<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Agentic Runtime Isolation: Architecture

> **Status: implemented and verified.** Last green integration run: run 14,
> 2026-11-05, eu-central-1, 57/57 steps, deploy 280 s, steps 1,842 s, key
> rotation 167 s, teardown clean (commit 6acb991). The run used a sandbox
> account and `scripts/integ.sh` (the CDK CLI driver, ADR-0044) with six
> stacks (`api-gateway`, `agentcore-gateway`, `session-off`, `session-user`,
> `limits`, `multi-tenant`); it covered the 2026-11-05 scale changes
> (`ingressReservedConcurrency`, `toolContextKey.algorithm` and the
> stage-throttle synth warning). Both all-on stacks ran spec §8 steps 3 to
> 24: P-1 (direct invoke refused), units and sessions, the grants table,
> ABAC, model usage, latency, the registry, a late agent and a drain, the
> headers that reach the agent (no identity token), cuts landing on the next
> request, the per-tool wall, forged contexts, token expiry, `aud` and `act`
> refusals, the tool-side TVM, AgentCore Policy time-to-ACTIVE and the
> RESPONSE filter. Step 9, total time of a `report` call (a one-event
> stream, so TTFB is within 1 ms of it), p50/p95: `api-gateway` warm mint
> cache 0.204/0.247 s, cold 0.229/0.244 s; `agentcore-gateway` warm
> 0.248/0.306 s, cold 0.308/0.405 s; `stream 10` first byte at about 0.2 to
> 0.3 s. Step 23: one ACTIVE star permit per target, 10.7 to 10.8 s from
> `CreatePolicy`. On their own stacks: 4a, 4b-user, the tenant limit (tenant
> A refused with 429 on call 6, tenant B served) and step 19 (a user in
> several tenants). Step 21 served the rotated JWKS with two keys 10 s after
> the deploy returned. The log sweep read 139 log groups and found 0 token
> segments; the teardown left no stack, parameter, log group, table, Gateway
> or policy engine (13 KMS keys pending deletion). The
> [README integration test](./README.md#deployment-integration-test) has the
> step table; the [threat model](./threat-model.md#security-review) records
> the security scans and their dates.

This file describes what is deployed. The design trail is
[`design/agentic-runtime-isolation.spec.md`](./design/agentic-runtime-isolation.spec.md), the
[ADRs](./adr/README.md) and the [threat model](./threat-model.md).

## Purpose

A pooled agent platform where each tenant user's conversation runs in its own
compute unit (a Runtime session, one microVM; "unit" below), every Runtime trusts exactly one
ingress, and every tool call carries a tenant context the tool can verify. One
ingress fronts one or more agents and one or more tools gateways.
For each request the ingress verifies the identity token, selects the tenant,
resolves the agent from the route, reads what the tenant and the user are
entitled to, computes the grant, mints a short-lived transaction token that
names exactly one tenant, user and agent and carries exactly that grant,
chooses the unit, vends tenant-scoped credentials, limits each tenant's share,
and attributes cost per tenant and agent (ADR-0001, ADR-0012, ADR-0017,
ADR-0020, ADR-0024, ADR-0030, ADR-0031). The agent reaches tools only through
a tools gateway that accepts that transaction token alone (ADR-0034,
ADR-0041).

## Tenant isolation

Deployment model: pool at every layer (`ARCHITECTURE.md` §3.1). One
ingress, one Runtime per agent (a microVM per session, one tenant per
microVM), one entitlement table, one tools gateway per tool domain and one
tenant-data table serve every tenant; no resource is dedicated to a tenant.
Isolation is the material a request carries and the walls it meets.

Trust zones:

| Zone | Code | Trusts | Holds |
|---|---|---|---|
| Ingress | `SharedIngress`: authoriser or interceptor, integration Lambda, entitlement API | the identity provider (`identity.discoveryUrl`, `allowedClientIds`) | the identity token (never forwarded), `kms:Sign` on the signing keys, read and write on the entitlement store |
| Agent | `AgentBackend`: the Runtime and the agent code in it | the ingress role, named in its resource policy | untrusted: the transaction token (one tenant, user, agent, grant) and `TenantId`-tagged credentials; an execution role with logs and traces only (ADR-0018) |
| Tool | `ToolTarget`: the tool function | `_ri_ctx` signed by `ToolContextKey`, nothing else | its own tenant role, assumed with the context's `TenantId` (P-15) |

Walls per layer (`ARCHITECTURE.md` §3.3). **IAM** is enforced isolation:
the service refuses a cross-tenant call when the code is wrong. A **check**
is vendor code deciding what the agent may do, in front of an IAM wall.
Boundary ids are the [threat model's](./threat-model.md#assets-and-trust-boundaries);
proof is the integration step in the [README](./README.md#deployment-integration-test).

| Layer | Boundary | Wall | Kind | Code | Proof |
|---|---|---|---|---|---|
| Identity | B1 | identity token verified; tenant from `tenant_id`, or `tenants` plus `X-Tenant-Id`; a transaction token refused as an identity token | check | `src/shared/verifier.ts`, `src/shared/tenant.ts` | 6, 18, 19 |
| Invocation | B2 | Runtime resource policy: `InvokeAgentRuntime` for the ingress role only, every other principal denied; the ingress role's grant conditioned on `ri:ingress` (ADR-0001, ADR-0024) | IAM | `src/backend/agentcore-runtime.cdk.ts` | 3 |
| Session | B3 | unit id derived from verified claims (`session.scope`), client header ignored; only the ingress can set it (ADR-0002, ADR-0039) | IAM (same resource policy) | `src/shared/request.ts` | 4a, 4b, 4b-user, 5 |
| Delegation | B2, B8, B13 | transaction token: `sub` `<tenant_id>#<sub>`, `agent`, `scope`, `aud`, `act.sub`, 300 s; `kms:Sign` granted in the key policy to the minting role alone, grants denied; the identity token stays at the ingress (ADR-0031, ADR-0037) | IAM (key policy) | `src/shared/mint.ts`, `src/shared/token-signer.cdk.ts` | 7, 11, 15, 17, 18, 21 |
| Tools | B8 | `CUSTOM_JWT` on the ingress issuer and `aud`; REQUEST interceptor: `typ`, `iss`, `aud`, `act.sub`, `exp`, tool in `scope`; AgentCore Policy: one star permit per target on `scope`, default deny (ADR-0041) | check | `src/tools/interceptor.function.ts`, `src/shared/cedar.ts` | 13, 14, 17, 22, 23, 24 |
| Data, agent | B4 | TVM: `AssumeRole` plus `TagSession` `TenantId` from the verified claim; the tenant role scopes model and data calls by `${aws:PrincipalTag/TenantId}` (ADR-0012, ADR-0018) | IAM | `src/shared/tvm.ts` | 8a |
| Data, tool | B9 | `_ri_ctx` verified (`typ`, `exp`, `tool`, `argsHash`); the tool's own TVM assumes its tenant role with the context's `TenantId`; `dynamodb:LeadingKeys` `TENANT#${aws:PrincipalTag/TenantId}`; no context, no role | IAM for `lambda` targets; filtered for 2LO and API-key targets (synth warns, ADR-0034) | `src/tools/context.ts` | 15, 20, 20-cloudtrail |
| Entitlement writes | B10, B11 | `TenantAdminRole`: items under `TENANT#${aws:PrincipalTag/TenantId}` only, writes limited to the cut row's attributes and version (`dynamodb:Attributes`); vendor routes SigV4; owned rows by owner marker (ADR-0033, ADR-0035) | IAM | `src/shared/entitlement-store.cdk.ts`, `src/shared/reservation.function.ts` | 12 |

Not a wall: the microVM boundary itself (T-24, the service's), the
tenant limits and tool rate limits (fairness, fail-open, ADR-0020, M-60), and
the RESPONSE list filter (it only removes names, ADR-0041). The
[Cross-tenant data safety](#cross-tenant-data-safety) list below is the
item-by-item code check behind this table.

## Actors and identity

| Actor | Holds | Acts through |
|---|---|---|
| Vendor | every stack and role; the entitlement API's vendor routes | IAM (SigV4) on `/entitlements/tenants*` and `/entitlements/plans*`; no call path into a session |
| Tenant | a subscription row: agents, tools, an optional plan, `status` | the vendor's writes (ADR-0030) |
| Tenant admin | a tenant user whose identity token carries `entitlements/admin` | the bearer routes `/entitlements/users*`; can only cut, never add (ADR-0033) |
| Tenant user | an identity token from tenant-identity's `shared-pool` (`tenant_id` or, with `identity.multiTenant`, `tenants` plus `X-Tenant-Id`) | `POST /{backend}/invocations` (ADR-0004, ADR-0038) |
| Agent | its registry entry: `needs`, `tools` | the transaction token it receives in the `Transaction-Token` header |
| Tool | its catalogue rows and its own tenant role | the signed context `_ri_ctx` and its own TVM (P-15) |

IAM principals on the path:

| Role | Owner | May |
|---|---|---|
| Ingress role (integration Lambda role on `api-gateway`, Gateway role on `agentcore-gateway`) | `SharedIngress` | `InvokeAgentRuntime` on Runtimes tagged `ri:ingress = <ingressId>`; the only principal each Runtime's resource policy names (ADR-0001, ADR-0024). Named in the token's `act.sub` |
| Minting role (the authoriser on `api-gateway`, the interceptor on `agentcore-gateway`) | `SharedIngress` | `kms:Sign` on the current signing key, granted in the key policy alone (P-14, ADR-0037); reads the entitlement store |
| TVM caller role (integration Lambda or interceptor) | `SharedIngress` | `sts:AssumeRole` and `sts:TagSession` on the tenant role; `UpdateItem` on `TenantLimits` |
| Tenant role (`TenantModelRole`, or `tvm.role`) | `SharedIngress` or the deployer | the agents' models (one statement per model, ADR-0018); with `tvm.role`, the deployer's tenant data under ABAC |
| Tools gateway role, one per gateway | `ToolsGateway` | invoke its interceptors and its registered tool functions; `GetPolicyEngine`, `AuthorizeAction`, `PartiallyAuthorizeActions` (M-61) |
| Tool tenant role, one per tool target with `tvm.role` | the deployer | trusts the tool function's role, requires the `TenantId` tag, scopes data by it (P-15) |
| `TenantAdminRole` | `EntitlementApi` | item calls on `TENANT#${aws:PrincipalTag/TenantId}` only; writes limited to the cut row's attributes and version by `dynamodb:Attributes` (ADR-0033) |

See the [specification](./design/agentic-runtime-isolation.spec.md) §3.2.

## Constructs, routes and the registry

| Construct | Creates | Code |
|---|---|---|
| `SharedIngress` | the ingress (API Gateway REST API or AgentCore Gateway), the token verifier, the entitlement store and API, the token signer and discovery routes, the tools gateways, the TVM wiring, `TenantLimits`, the log drain, the published parameter | `src/shared-ingress.cdk.ts` |
| `AgentBackend(ingress)` | one Runtime, its resource policy, on `agentcore-gateway` its Gateway target, the `NAME#<name>` reservation, its model statement on the tenant role, its registry entry (written last) | `src/agent-backend.cdk.ts` |
| `ToolTarget(ingress)` | the `NAME#<target>`, `TOOL#<target>` and `GATEWAY#<g>` rows, the Gateway target on one tools gateway, its one Cedar permit, its registry pointer | `src/tool-target.cdk.ts` |
| `ToolsGateway` | one AgentCore Gateway for tools with its policy engine, interceptors and tool rate limit; created by `SharedIngress` | `src/tools-gateway.cdk.ts` |
| Demo stack | a `SharedIngress` with `defaultBackend: 'default'` and two tools gateways (`default`, `finance` with `responseFilter`); the `default` agent (`needs: ['default/chat']`, `tools: ['crm/*']`); optionally `billing` (`billing/read`, `billing/invoke`, `invoices/*`); tool targets `crm` (`get_account`, `list_cases`, `update_case`) on `default` and `invoices` (`get_invoice`, `list_invoices`) on `finance` | `src/main.ts`, `src/demo.cdk.ts`, `src/tools/demo/*` |

Routes: `POST /{backend}/invocations` on both ingresses (one API resource on
`api-gateway`, one Runtime target per agent on `agentcore-gateway`); with
`defaultBackend`, also `POST /invocations` on `api-gateway`. An agent or
target name is `[a-z0-9-]{1,32}`; agents and tool targets share one name
space (ADR-0035).

Under `registryPrefix` (default `/application-plane/shared/agent-runtime/`,
SSM Parameter Store):

| Parameter | Written by | Value |
|---|---|---|
| `backends/<name>` | the agent's `Custom::RuntimeIsolationRegistryEntry` | JSON `{ runtimeArn, needs, tools, version, status }`; `version` 1 on Create, +1 on Update; `status` `active` or `draining` (ADR-0024, ADR-0032) |
| `tools/<target>` | the tool target's own `AWS::SSM::Parameter` | JSON `{ gatewayTargetId, gateway, kind, status, version }`; no tool names, the catalogue holds them (spec §4.4) |
| `ingress` | `SharedIngress` with `publish` on | the published interface, below (ADR-0042) |

The ingress caches entries per process for `registryTtl` (60 s, 1 s to
750 s), serves a stale entry while it refreshes, backs off a failed refresh,
and refuses an entry older than ten TTLs (502 `registry_unavailable`), one
outside its own partition, Region and account, or an entry without `needs`
and `tools` (502, log reason `registry_entry_v1`). The registry-entry function's role may
put, get and delete its one parameter; it refuses to create a name that
exists and drains only an entry whose `runtimeArn` is its own. Delete sets
`draining`, waits one TTL plus the longest stream (120 s), then removes the
entry. Nothing an agent or tool target does redeploys the ingress.

```
tenant user ──POST /<agent>/invocations (identity token)──▶ ingress ──InvokeAgentRuntime──▶ Runtime <agent>
                                   verify, tenant, registry, entitlements,             (Transaction-Token,
                                   grant, mint, limit, unit, TVM                        Tenant-Credentials)
                                                                                                │ MCP, Bearer txn token
              tool function ◀── Policy (star permit) ◀── REQUEST interceptor ◀── tools gateway <g> ◀┘
              verifies _ri_ctx,       per target           per tool, signs _ri_ctx      CUSTOM_JWT on the
              own TVM                                                                    ingress issuer
```

## Components

| Component | What it does | Code |
|---|---|---|
| Identity token verifier | Signature, `iss`, `client_id`, `exp`, `token_use`; refuses a transaction token presented as an identity token (`typ: txn+jwt` or `iss` = the ingress issuer); the optional `requiredScopes` floor (AND, 403 `scope_missing`) (ADR-0005, ADR-0015) | `src/shared/verifier.ts` |
| Tenant selection | One `tenant_id`; or `tenants` plus `X-Tenant-Id` with `identity.multiTenant`. Refusals `no_tenant`, `multi_tenant_token`, `tenant_required` (400), `tenant_not_allowed` (403), `malformed_tenant_header` (400) (ADR-0038) | `src/shared/tenant.ts` |
| Ingress, `api-gateway` | The recommended ingress (ADR-0029). REST API, REQUEST authoriser (`AuthorizerFunction`) that verifies, resolves the agent, runs the authority step and mints; streaming integration Lambda (`IngressFunction`, `responseTransferMode: STREAM`, 2-minute integration timeout) that re-verifies the identity token, checks the authoriser context names the same tenant and agent, applies the limit, the unit and the TVM, invokes the Runtime and relays the stream. The authoriser cache is min(60 s, `ttl` − longest stream) on `Authorization` and the path, plus `X-Tenant-Id` with `multiTenant`; a Deny renders through the `ACCESS_DENIED` response with `$context.authorizer.reason` | `src/ingress/api-gateway-authorizer.function.ts`, `src/ingress/api-gateway-ingress.function.ts` |
| Ingress, `agentcore-gateway` | AgentCore Gateway with `CUSTOM_JWT` (the floor scopes only) and a REQUEST interceptor (`InterceptorFunction`) that runs the whole pipeline and sets the session, `Transaction-Token` and `Tenant-Credentials` headers; one Runtime target per agent; a small issuer REST API beside it serves discovery and the entitlement API. Gateway name lowercased (ADR-0010, ADR-0027) | `src/ingress/gateway-interceptor.function.ts` |
| Pipeline | One check order for both ingresses (spec §5.1) and fixed error bodies | `src/shared/request.ts` |
| Entitlement reader | One `BatchGetItem` per request for `#SUB` and `USER#<sub>`; plan and catalogue rows cached per process for `registryTtl` | `src/shared/entitlements.ts` |
| Grant rule | Pure: `granted = A.needs ∪ (A.tools ∩ T.tools ∩ U.tools)` (next section) | `src/shared/grant.ts` |
| Authority step | Entitlement read, grant rule, mint; refusals `agent_not_subscribed`, `tenant_suspended` (403), `grant_too_large`, `entitlements_unavailable`, `mint_failed` (502) | `src/shared/authority.ts` |
| Mint | Builds and signs the transaction token with KMS `Sign` (`MessageType: DIGEST`); LRU cache | `src/shared/mint.ts`, `src/shared/jws.ts` |
| `TokenSigner` | KMS keys per generation, key policy, `Custom::RuntimeIsolationJwks`, the two mock-integration discovery routes | `src/shared/token-signer.cdk.ts`, `src/shared/jwks.function.ts` |
| `EntitlementStore` | The table and the asymmetric grants (ingress reads; vendor writes tenant and plan rows; tenant admin writes cut rows under its own leading key) | `src/shared/entitlement-store.cdk.ts` |
| Entitlement API | Two functions: `VendorFunction` (IAM-authorised routes) and `TenantAdminFunction` (verifies the identity token and `adminScope` itself, then assumes `TenantAdminRole`) | `src/entitlements/entitlement-api.cdk.ts`, `src/entitlements/entitlements.function.ts`, `src/entitlements/entitlements.ts`, `model/entitlements.smithy` |
| Owned rows | `Custom::RuntimeIsolationOwnedRows`: owner-marked rows, the per-gateway count check (ADR-0035, ADR-0041) | `src/shared/reservation.cdk.ts`, `src/shared/reservation.function.ts` |
| Registry entry | `Custom::RuntimeIsolationRegistryEntry`; SSM client in adaptive retry mode, 8 attempts | `src/shared/registry-entry.cdk.ts`, `src/shared/registry-entry.function.ts` |
| Registry cache | Stale-while-refresh, back-off, maximum stale age, account check | `src/shared/registry.ts` |
| TVM | Always on: `AssumeRole` plus `TagSession` with `TenantId` from the verified claim; bounded LRU cache, single flight, refresh ahead (ADR-0012, ADR-0018, ADR-0022) | `src/shared/tvm.ts` |
| Tenant limits | DynamoDB fixed-window counter per tenant per minute, shared by every agent; 429 before the TVM and the backend; fail-open after a bounded wait (ADR-0020) | `src/shared/limits.ts` |
| Backend | One Runtime per agent: resource policy names the ingress role on the Runtime ARN, denies the other entry points; `ri:ingress` tag on `CfnRuntime.tags` (ADR-0001, ADR-0011) | `src/backend/agentcore-runtime.cdk.ts`, `src/backend/agentcore-runtime.transport.ts` |
| Agent | Demo code in the microVM: model prompts through Nova Lite on the geography inference profile, signed by the vended credentials (ADR-0028); probes `report`, `read`, `stream`, `tools`, `tool`; one MCP client per tools gateway its token's `aud` names; ends each stream with `event: usage` | `src/agent/app.ts` |
| Tools gateways | Next sections | `src/tools-gateway.cdk.ts`, `src/tools/*` |
| Logs, metrics, teardown | JSON log lines (`src/shared/logger.ts`), EMF only with `perTenantMetrics` (`src/shared/metrics.ts`), one log drain per stack so teardown leaves no log group (ADR-0019, `src/shared/log-drain.ts`) | |
| Cold path | One HTTPS pool per process; discovery, JWKS, STS, DynamoDB and the default agent's registry entry warmed during init (ADR-0023) | `src/shared/http.ts` |

## Entitlements and the grant rule

The entitlement store is one DynamoDB table per `SharedIngress`: on-demand,
PITR on, no TTL, no GSI (ADR-0030, spec §4.5). The agent definition stays in
the registry entry.

```
T(tenant)       = tenant.agents ∪ plan.agents,  tenant.tools ∪ plan.tools
U(tenant, user) = T minus the admin's cuts
A(agent)        = agent.needs, agent.tools
granted         = A.needs ∪ (A.tools ∩ T.tools ∩ U.tools)
                  only if agent ∈ T.agents ∩ U.agents, else agent_not_subscribed
```

No tenant row and an agent the tenant does not hold or the user is cut from
are both `agent_not_subscribed`; a `suspended` tenant is `tenant_suspended`.
Tool sets are normalised first: `<target>/*` expands against the catalogue,
names not catalogued drop, and each target whose every tool is granted is
compressed back to `<target>/*`, sorted, so equal inputs give the same `scope`
string and the same mint cache entry. A grant holding only `needs` is
`no_tools_granted`: logged, served, not refused. A `scope` above 6,144 bytes,
or a signed token above 10,240 bytes, is `grant_too_large` (502) (ADR-0032,
ADR-0033, ADR-0041, ADR-0045).

### Change lag

Every vendor or tenant-admin write bumps `tenant.version`, which is in the
mint cache key (ADR-0036, spec §4.6). "Next request" on `api-gateway` means
the next request that misses the authoriser cache (at most 60 s, or at once
with a new identity token, ADR-0043). A token in flight keeps its grant
until `exp` at the agent and until `exp − 60 s` at a tools gateway (the
Gateway refuses a token with 60 s or less left). No revocation list is
kept; lower `transactionToken.ttl` for a faster stop. Integ steps 12 and 16
measure the subscription and cut rows.

| Change | New mints | Tokens in flight |
|---|---|---|
| Subscription change (vendor adds or drops an agent or a tool, or suspends the tenant) | next request | at `exp` |
| Cut added by a tenant admin | next request | at `exp` |
| Cut removed | next request | n/a (the old token held less) |
| Plan change, or a tool leaves a plan | within `registryTtl` (plan cache), then the next mint | at `exp` |
| Agent product change (`AgentBackend.needs` or `tools`) | within `registryTtl` (registry cache) | at `exp` |
| Tool added to a target | at once for grants holding `<target>/*` at every level (the star permit and the interceptor match the wildcard); an explicit tool list does not gain it (ADR-0046) | as for new mints |
| Tool removed from a target | at once: the Gateway target no longer lists it | at once |

## Transaction token

The ingress is an OIDC issuer (ADR-0031, ADR-0037). The issuer is
`<baseUrl>` of the REST API that serves the discovery routes: the
`api-gateway` ingress's own API, or the issuer API beside the AgentCore
Gateway.

| Part | Value |
|---|---|
| Header | `alg` `RS256` (default) or `ES256`, `typ: txn+jwt`, `kid` = the KMS key id |
| Claims | `iss`; `sub` = `<tenant_id>#<sub>` (the AgentCore Identity vault keys on `iss` and `sub`, ADR-0040); `user` = the identity provider's `sub`; `tenant_id`; `agent`; `scope` = the grant; `aud` = `agent:<agent>` plus `tools-gateway:<g>` for each gateway the granted tools live on (sorted, ADR-0041); `act.sub` = the ingress role ARN; `txn`; `iat`; `exp`; `jti` |
| Lifetime | `transactionToken.ttl`, 120 s to 900 s, default 300 s |
| Mint cache | Per (tenant, sub, agent, tenant.version, agent.version, plan.version, scope, gateways), LRU 1,000 per process (`mintCacheKey`; a catalogue change that changes the grant or its gateways re-mints); reused while more than the reuse margin (authoriser cache TTL + 120 s, 180 s by default) is left, so a busy user costs one `kms:Sign` per token life. The log field `mint` is `hit` or `miss` |
| Delivery | `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token` to the Runtime; the identity token never reaches the agent (integ step 11) |
| Keys | One KMS `SIGN_VERIFY` key per generation (`RSA_2048` or `ECC_NIST_P256`). `kms:Sign` is granted only in the key policy, to the minting role; grants are denied in the key policy (`kms:CreateGrant` for every principal) and the account root keeps the administrative actions but no `kms:Create*`, so no IAM policy and no grant can add a signer. The residual is `kms:PutKeyPolicy`, held by the account's key administrators (the deployer's own privilege) and visible in CloudTrail (ADR-0046, threat model T-97). `ToolContextKey` has the same policy with the interceptor role as signer |
| JWKS | `Custom::RuntimeIsolationJwks` reads `GetPublicKey` at deploy and renders `{ keys: [...] }`, current key first; `/.well-known/openid-configuration` and `/.well-known/jwks.json` are mock integrations with `Cache-Control: public, max-age=300`: no Lambda or KMS call per read |
| Rotation | Bump `transactionToken.keyGeneration` (demo context `keyGeneration`): key N+1 signs from that deploy, key N stays in the JWKS without `kms:Sign`; at N+2 key N leaves and is scheduled for deletion (30 days). Two bumps at least `ttl` + 300 s apart. Integ step 21: 167 s, the JWKS served both keys 10 s after the deploy |

KMS `Sign` measured p50 8.2 ms, p95 11.1 ms (spec §7.1); a mint cache miss
adds about 0.02 to 0.06 s to the total time (step 9 cold against warm).

## Tools gateways

`SharedIngress` creates one tools gateway named `default` (`toolsGateway`), or
one per entry of `toolsGateways`, or none (`toolsGateway: false`). Each has its
own policy engine, interceptors and tool rate limit, because one engine's Cedar
schema holds about 330 tools (ADR-0041).

| Part | Behaviour |
|---|---|
| Inbound | `CUSTOM_JWT` on the ingress issuer's discovery URL, `allowedAudience: ['tools-gateway:<g>']`, no `allowedClients`. An identity token fails on `iss`, a token for another gateway on `aud`; a token with 60 s or less to `exp` is refused (403) |
| REQUEST interceptor | `src/tools/interceptor.function.ts`, `passRequestHeaders: true`, provisioned concurrency 1 on the `InterceptorLive` alias. Runs before Policy, so it is the first wall and the per-tool wall: re-verifies the token against the ingress JWKS (`typ: txn+jwt`, `iss`, `aud` holding `tools-gateway:<g>` and `agent:<agent>`, `act.sub` = the ingress role, `exp`); admits only one JSON-RPC object with an allowlisted method, else `malformed_request` (a batch never reaches a target unchecked); on `tools/call` checks the tool against `scope` (`tool_not_granted`) and refuses non-object `arguments`; overwrites a client `tenantId` argument; computes `argsHash`; signs the tenant context with `ToolContextKey` and writes it to `_ri_ctx`, overwriting anything the client sent. A refusal is HTTP 403 with JSON-RPC error `-32003` `forbidden: <reason>`; a throw or timeout is a Gateway 5xx (fail-closed). A token minted for another gateway is `token_invalid`; a non-`txn+jwt` `typ`, or a token without `exp` or `iat`, is `token_invalid`; no `act` is `act_missing` (integ step 17) |
| Policy | AgentCore Policy in `ENFORCE` mode, default deny. One Cedar star permit per target (`src/shared/cedar.ts`): `action in AgentCore::Action::"<target>"` when `principal.getTag("scope")` holds `<target>/*` or any `<target>/<tool>` as a whole entry; about 450 bytes whatever the tool count. Filters `tools/list` and refuses `tools/call` at target grain |
| Policy writer | `Custom::RuntimeIsolationToolPolicy` (`src/tools/tool-policy.function.ts`): `CreatePolicy` and wait for ACTIVE, retrying a conflict or throttle with backoff and deleting a `CREATE_FAILED` policy first; Update on every target change (the touch for tools added later); Delete and wait until gone, before the Gateway target is deleted. Name `<target>_target_<8 hex>` (a hash of stack, construct path and gateway). Returns `SecondsToActive` (demo outputs `CrmPolicySecondsToActive`, `InvoicesPolicySecondsToActive`) |
| RESPONSE filter | Optional (`responseFilter`, demo `finance`): `src/tools/response-filter.function.ts` re-verifies the token from the passed request headers and trims each `tools/list` page to the exact tools in `scope`; only removes; on any error an empty page and `response_filter_failed` (integ step 24) |
| Signed tool context (`_ri_ctx`) | Compact JWS, RS256 by default, ES256 with `toolContextKey.algorithm`, `typ: ri-ctx+jwt`; claims `tenant_id`, `sub`, `user`, `agent`, `tool`, `argsHash`, `txn`, `iat`, `exp` (`contextLifetime`, 60 s, 10 s to 300 s). `ToolContextKey` is one KMS key per ingress, shared by its gateways; each interceptor's role gets `kms:Sign` in the key policy; its public half is never in the JWKS, so a context cannot pass as a transaction token |
| Tool side | `toolHandler` in `src/tools/context.ts`: verifies `_ri_ctx` with the cached public half of `ToolContextKey`, checks `typ`, `exp`, `tool` and `argsHash`, strips `_ri_ctx`, then assumes the tool's tenant role with the `TenantId` tag from the context (its own TVM; STS from the tool's role). No valid context: `context_invalid`, no credentials, and the tool's own role reaches no tenant data (integ step 20) |
| Tool rate limit | `CfnGatewayRateLimit` on `$.context.jwt.tenant_id`, 10 requests per second per tenant by default, up to 1,000 overrides; fairness, fail-open by design (M-60) |
| Application logs | Off: no delivery source, because those logs hold request and response bodies (ADR-0040) |
| MCP | `supportedVersions` includes `2025-11-25` |

Target kinds (`ToolTarget.kind`): `lambda` (the inline tool schema, Gateway
role outbound auth, the only kind that receives `_ri_ctx` and so the only one
with enforced isolation through the context), `openApi`, `smithy` and
`mcpServer` (outbound auth `oauth` 3LO, OBO or M2M, `apiKey`, or
`gatewayIamRole`). The Gateway drops undeclared arguments for non-Lambda
targets, so they learn the caller only from the outbound credential; synth
warns `runtime-isolation:filtered-isolation` for each one without 3LO or OBO
(ADR-0034). Only `lambda` targets are deployed by the integration test.

Deploy-time bounds: a `ToolTarget` reserves its count row
`GATEWAY#<g>` / `TARGET#<t>`; Create and Update Query every count row of the
gateway, from every stack, and fail the deploy past `maxToolsPerGateway`
(300, 1 to 1,000) or 100 targets. Same-app targets are also counted at synth.
Two deploys racing on one gateway can both pass; the engine's schema quota is
the backstop.

### Laying out tools gateways

A gateway is a tool partition, not a tenant partition: every tenant shares
every gateway, and the tenant wall is the tool's tenant role (spec §6.1),
whichever gateway the call came through. Several domains on one gateway is
the default; the split exists because one policy engine's Cedar schema
holds about 330 tools (ADR-0041), and because the tool rate limit and
`responseFilter` are set per gateway. Each extra gateway costs one more
policy engine, one more interceptor (provisioned concurrency 1 unless turned
off), one more MCP client in each agent that uses it, and another 10 rps of
tool rate limit per tenant. Deploy time does not change: a `ToolTarget` is
one star permit either way.

| Layout | When | Trade |
|---|---|---|
| One gateway, all domains (`{ default: {} }`) | under `maxToolsPerGateway` and one `responseFilter` setting fits all | one rate bucket per tenant, one MCP client per agent |
| One gateway per tool domain (the demo: `crm` on `default`, `invoices` on `finance`) | a domain needs `responseFilter` or its own rate budget, or a domain nears the bound | a tenant's budget is per domain; an agent holds one client per domain in its `aud` |
| Pack by count | thousands of tools, no per-domain rules | leave a margin: a target that grows past the bound fails its deploy, and moving a target changes every granted token's `aud` |
| One gateway per agent | agents use disjoint tool sets | shortest `tools/list`; a tool two agents share needs a target on each gateway, under two names (target names are unique per ingress) |

Pick the first that fits, in that order. The demo uses two gateways to
exercise the second layout: an `aud` with two entries, a token for one
gateway refused by the other, and `responseFilter` on one of them.

## Published interface

`SharedIngress` publishes ONE parameter, `<registryPrefix>ingress`
(`IngressParameter`, intelligent tiering), holding the JSON document
`PublishedIngress` version 2 (ADR-0042):

```
{ version, ingress, endpointUrl, baseUrl, ingressRoleArn, ingressId, tenantRoleArn,
  gatewayIdentifier?, issuer, jwksUrl, entitlementsTableName, entitlementsApiUrl,
  toolContextKeyId?, toolsGateways: { <g>: { url, identifier, roleArn, policyEngineId } } }
```

`SharedIngress.fromParameters(scope, id, prefix, ingress?, { toolsGateway?, toolsGateways? })`
is a synth-time lookup (`ssm.StringParameter.valueFromLookup`, like
`Vpc.fromLookup`), because CloudFormation cannot parse JSON at deploy time:
the consuming stack needs `env: { account, region }` and AWS credentials at
synth, and the value is cached in `cdk.context.json` (reset with
`cdk context --reset` after the ingress changes). It refuses a non-JSON value
or another `version`, an `ingress` mismatch and a gateway the document does
not list; the first synth builds the ref from placeholders. `publish: false`
writes none of it; the integration stacks deploy that way and read stack
outputs, because six stacks writing about 20 parameters each hit Parameter
Store's 3 writes per second on deploy and destroy. The construct writes the
document itself rather than the demo stack, and the integration driver reads
stack outputs rather than the document; both depart from
`docs/sample-standard.md` and are recorded in ADR-0044. An `AgentBackend` or
`ToolTarget` in another stack must name its ingress through this ref.

## Data model

| Store | Key | Attributes | Lifecycle |
|---|---|---|---|
| Entitlements: tenant subscription | `TENANT#<tenantId>` / `#SUB` | `agents`, `tools`, `plan?`, `status`, `version`, `updatedAt` | vendor `PutTenantSubscription` (a `TransactWriteItems` conditioned on the plan it read; a lost race is 409 `concurrent_write`) |
| Entitlements: user cut | `TENANT#<tenantId>` / `USER#<sub>` | `cutAgents`, `cutTools`, `version`, `updatedBy`, `updatedAt` | tenant admin; bumps the tenant row's `version` in the same transaction |
| Entitlements: plan | `PLAN#<name>` / `#PLAN` | `agents`, `tools`, `version`, `updatedAt` | vendor; `PlanName` `[a-z0-9-]{1,32}` |
| Entitlements: plan listing | `PLANS` / `PLAN#<name>` | | written with the plan; `ListPlans` Queries it |
| Entitlements: plan member | `PLAN#<name>` / `TENANT#<id>` | | written with the tenant row; `DeletePlan`'s `plan_in_use` (409) is a `Limit 1` Query |
| Entitlements: catalogue | `TOOL#<target>` / `TOOL#<tool>` | `gateway`, `owner` | `ToolTarget` deploy |
| Entitlements: name reservation | `NAME#<name>` / `#NAME` | `owner` | `AgentBackend` and `ToolTarget` deploy |
| Entitlements: gateway count | `GATEWAY#<g>` / `TARGET#<t>` | `tools`, `owner` | `ToolTarget` deploy |
| Registry, SSM | `backends/<name>`, `tools/<target>`, `ingress` | JSON, above | deploy, drain, delete |
| `TenantLimits`, DynamoDB, with `tenantLimits` | `TENANT#<tenantId>#<epochMinute>` | `requests`, `outputTokens`, `expiresAt` (TTL, 180 s) | one item per tenant per minute (ADR-0020) |
| Demo table, with demo tenant data | `TENANT#<id>` | `crmAccount`, `crmCases`, `invoices` | one item per tenant; the agent's `read` probe and both demo tools read it |

Every owned row is written with `attribute_not_exists(PK) OR owner = :owner`,
so a row another stack holds fails the deploy with
`name <name> already registered by another stack`; a `NAME#` row also
carries `kind` (`agent` or `target`) and is refused when the same owner
holds it under the other kind, and one CDK app refuses the clash at synth.
Delete removes only rows still carrying this owner. The function's role may write only the partition
keys it owns (`dynamodb:LeadingKeys`). See the
[specification](./design/agentic-runtime-isolation.spec.md) §4.

## API

| Route | Auth | Operation |
|---|---|---|
| `POST /{backend}/invocations`, `POST /invocations` | identity token, `X-Tenant-Id` when the token carries `tenants` | InvokeAgent; body `{prompt}`, with `session` `{conversationId, prompt}`; `200` `text/event-stream`, last event `event: usage` |
| `GET /.well-known/openid-configuration`, `GET /.well-known/jwks.json` | none | issuer discovery (ADR-0037) |
| `PUT`, `GET`, `DELETE /entitlements/tenants/{tenantId}` | IAM (SigV4) | tenant subscription |
| `PUT`, `GET`, `DELETE /entitlements/plans/{planName}`, `GET /entitlements/plans` | IAM (SigV4) | plans |
| `PUT`, `GET`, `DELETE /entitlements/users/{sub}/cut`, `GET /entitlements/users` | identity token with `entitlements/admin` | user cuts, own tenant only (ADR-0033) |
| tools gateway MCP endpoint, one per gateway | transaction token | `initialize`, `tools/list`, `tools/call` |

The transaction token's claims are in [Transaction token](#transaction-token)
and the signed tool context's format in [Tools gateways](#tools-gateways).
The Smithy service is `Entitlements` (`model/entitlements.smithy`); the
generated OpenAPI is under `src/smithy/entitlements`. Entitlement write
refusals: 400 `unknown_name`, `not_subscribed` (a cut naming something the
tenant does not hold), `too_many`; 409 `plan_in_use`, `concurrent_write`.

### Errors

InvokeAgent errors are fixed bodies that never echo the token, the unit id or
the input. Four reason codes are public and follow the text
(`forbidden: agent_not_subscribed`); every refusal's reason is also the log
line's `reason` (`src/shared/request.ts`, `PUBLIC_REASONS`).

**The rule on `api-gateway`:** every refusal the authoriser makes is 403
`forbidden` or `forbidden: <reason>`, rendered through the `ACCESS_DENIED`
gateway response (`src/shared-ingress.cdk.ts`), whatever status the check
would have on `agentcore-gateway`: an invalid identity token, an unknown or
`draining` agent and a registry or mint failure are all 403 there (integ
9-registry). Only a request without `Authorization` (and, with
`multiTenant`, without `X-Tenant-Id`) is API Gateway's own 401, before the
authoriser runs; a body that fails the request model is API Gateway's own
400. The integration Lambda then answers 400, 403, 429 and 502 itself. On
`agentcore-gateway` the interceptor answers every status in the table.

| Status | Body | When |
|---|---|---|
| 400 | `bad request` | malformed `prompt`, `conversationId` or `X-Tenant-Id`; `conversationId` with `session` off |
| 400 | `bad request: tenant_required` | `agentcore-gateway`: the token carries `tenants` and no `X-Tenant-Id` was sent |
| 401 | `unauthorized` | `agentcore-gateway`: missing or invalid identity token, or a transaction token presented as one |
| 403 | `forbidden` | no tenant claim, `tenants` without `multiTenant`, a floor scope missing (`scope_missing`), a `tvm.claimTags` claim missing (`claim_missing`); on `api-gateway` also every authoriser refusal without a public reason |
| 403 | `forbidden: tenant_not_allowed` | `X-Tenant-Id` not in `tenants` or not the token's `tenant_id`, also after a cached Allow on `api-gateway`; a forwarded transaction token not for this tenant and agent |
| 403 | `forbidden: tenant_suspended` | the tenant row is `suspended` |
| 403 | `forbidden: agent_not_subscribed` | the agent is not in `T.agents ∩ U.agents`, including a tenant with no row |
| 404 | `not found` | `agentcore-gateway`: no registry entry, or it is `draining` |
| 429 | `too many requests` | over the tenant limit |
| 502 | `upstream error` | `agentcore-gateway`, and the `api-gateway` integration Lambda: backend invoke failed; registry or entitlement store unreadable; an entry without `needs` and `tools` (`registry_entry_v1`); `grant_too_large`; `mint_failed`; `tvm_failed` |

An agent whose grant holds only its `needs` is served (`no_tools_granted`
is a log reason, not an error); its tool calls are refused at the gateway.

At a tools gateway (MCP over streamable HTTP, bearer = the transaction
token): a bad signature, `aud`, `iss` or `exp` is 403 `insufficient_scope`
from the Gateway, and only a missing bearer or an unknown `kid` is 401; the
interceptor refuses with HTTP 403 and JSON-RPC error `-32003`
`forbidden: <reason>` (`act_missing`, `aud_mismatch`, `tool_not_granted`,
`token_invalid`, `malformed_request`); AgentCore Policy refuses a target the
token names no entry of; an empty tool rate limit bucket is 429; an
interceptor error or timeout is a Gateway 5xx, never a pass-through. A tool
refuses a missing, expired, mismatched or foreign signed tool context with
`context_invalid` and assumes no role.

## Request flow

| # | Step | `api-gateway` | `agentcore-gateway` |
|---|---|---|---|
| 1 | Verify the identity token, select the tenant, check the floor scopes | authoriser | interceptor |
| 2 | Resolve the agent from the path through the registry cache | authoriser | interceptor (the Gateway refuses an unknown target first) |
| 3 | Per-tenant limit, one conditional `UpdateItem` | integration Lambda (after step 4) | interceptor |
| 4 | Entitlement read, grant rule, mint (`kms:Sign` on a cache miss) | authoriser; Allow carries the token in its context; `request authorised` | interceptor |
| 5 | Parse the body; derive the unit id from the verified claims (`session.scope` `tenant` by default, ADR-0039) | integration Lambda | interceptor |
| 6 | TVM: credentials for the tenant role with `TenantId` | integration Lambda | interceptor |
| 7 | Invoke the Runtime with the session id, `Transaction-Token` and `Tenant-Credentials` headers | integration Lambda; relays the stream, reads `usage`, adds output tokens to the counter, logs `request served` | the Gateway; the interceptor logs `request admitted` and never sees the response |
| 8 | Tool calls: the agent calls `tools/list` or `tools/call` on each gateway its `aud` names | tools gateway: `CUSTOM_JWT`, REQUEST interceptor (`tools request admitted` or `tool admitted` with `decision: admit` or `deny`), Policy, optional RESPONSE filter (`tools list filtered`), tool (`tool served`) | same |

A refusal before step 4 costs no KMS call; a refusal before step 6 costs no
STS call. Session ids are per Runtime, so the same `conversationId` on two
agents is two sessions.

## Scale limits

The design targets 10,000s of tenants, 100,000s of tenant users, 100s of
agents and 1,000s of tools; none of those counts grows a policy, a Gateway,
a role or a token per tenant or per user (P-16, spec §3.6). Values are
defaults or documented AWS quotas on 2026-11-05; check
[Service Quotas](https://docs.aws.amazon.com/general/latest/gr/aws_service_limits.html)
for your account and Region.

What grows with agents and tools:

| Grows with | Where | Bound |
|---|---|---|
| Agents | registry entries in SSM | SSM standard tier, 10,000 parameters; read per name, cached |
| Agents | Runtimes | AgentCore Runtime quota per account |
| Agents on `agentcore-gateway` | one Runtime target each on the ingress Gateway | 100 targets per Gateway: that ingress caps at 100 agents; `api-gateway` has no such cap |
| Agents per tenant | `agents` on the tenant row | `maxAgentsPerTenant`, 1,000 |
| Tools | catalogue rows | 1,000 per target; queried one target at a time, cached `registryTtl` |
| Tools | Cedar policy per target | one star permit, about 450 bytes, whatever the tool count |
| Tools | policy engine schema | 400 KB per engine, about 330 tools: `maxToolsPerGateway` 300; add gateways by tool domain |
| Targets | per Gateway | 100 |
| Tools | `tools/list` pages | about 30 tools a page; an agent lists only the gateways in its `aud` |
| Tools per tenant | `tools` on the tenant row | `maxToolsPerTenant`, 1,000 entries; subscribe by `<target>/*` |
| Tools in a token | `scope` after compression | 6,144 bytes; over it is 502 `grant_too_large` |
| Tools in a token | the encoded transaction token | 10,240 bytes, the Runtime's custom header cap; over it is 502 `grant_too_large` |

Shared pools every tenant draws on, in the order they give out:

| Pool | Default | Gives out at | Size it with |
|---|---|---|---|
| `api-gateway` stage throttle | 50 rps, burst 25, one bucket for every tenant and every refusal; the tenant limit runs behind it | 50 tenants at the default 60 a minute; one tenant at 50 rps starves the rest | `stageThrottle.rateLimit` >= tenants x `tenantLimits.requestsPerMinute` / 60 (synth warns when unset); WAF rate rules for an edge limit per tenant |
| Lambda concurrency | account pool (1,000); the integration Lambda is held for the whole stream | rps x average stream seconds (50 rps at 20 s, 8 rps at 120 s) | `ingressReservedConcurrency`; raise the account quota; `agentcore-gateway` for long streams |
| KMS `Sign` | 1,000 RSA requests per second per account per Region, shared by the mint, one `Sign` per admitted `tools/call` and every other RSA key | about active (tenant, user, agent) triples / 120 s + tool calls per second | `toolContextKey.algorithm: 'ES256'` (the ECC quota); `transactionToken.algorithm: 'ES256'`; a quota increase |
| STS `AssumeRole` | 600 rps per account per Region; the ingress TVM, every tool's TVM and the tenant-admin TVM share it | cold-start fan-out: new instances x tenants each; steady state is instances x tag sets / 780 s | reserved concurrency to bound fan-out; `tvm.includeUserIdTag` off |
| SSM `GetParameter` | 40 TPS; a throttled cold registry read is cached as `registry_unavailable` for one TTL on that instance | 40 cold reads in one second (a deploy, a burst) | Parameter Store higher throughput; raise `registryTtl` |
| Tenant limit item | one conditional `UpdateItem` per request on `TENANT#<tenantId>#<epochMinute>` | 1,000 writes per second from one tenant, then the limiter fails open | reachable only above the stage throttle |
| AgentCore Runtime | 2,500 active sessions per account (5,000 in us-east-1 and us-west-2), 1,000 TPS data plane, adjustable | concurrent conversations, `InvokeAgentRuntime` | quota increase; keep the stage throttle below it |
| Tools gateway | 200 TPS and 5,000 connections per Gateway; tool rate limit 10 rps per tenant per gateway | one tenant's tool calls | `tenantRateLimit`, `tenantRateLimitOverrides`; more gateways |
| Amazon Bedrock model quota | per account per model | model tokens across tenants | `outputTokensPerMinute` on `api-gateway`; quota per model |
| CloudWatch custom metrics | 9 × (1 + agents) per tenant per ingress when on | `perTenantMetrics` at many tenants | off by default, synth warning (ADR-0021); Logs Insights and Contributor Insights |
| Contributor Insights | top 500 contributors per rule | the four demo rules | Logs Insights for the long tail |
| TVM and mint caches | 1,000 entries each per instance | more active tag sets or users per instance | `tvm.cacheMaxEntries`, `transactionToken.cacheMaxEntries` (ADR-0022) |

The tenant limit is a fixed one-minute window (up to twice the limit
across a boundary) and admits requests if DynamoDB errors.

## Quotas that shape the design

| Quota or finding | Value | Design consequence |
|---|---|---|
| Cedar schema per policy engine | 400 KB per engine, about 330 tools (spec §7.2) | several tools gateways, one engine each; `maxToolsPerGateway` 300 (ADR-0041) |
| Per-tool Cedar permits | 28 tools per 10,000-character statement, 2 to 3 min to ACTIVE at 15+ policies | one star permit per target; the interceptor is the per-tool wall (ADR-0041) |
| `CreatePolicy` | names unique per account and Region; concurrent writes fail; 10.7 to 10.8 s to ACTIVE (integ step 23) | `<target>_target_<8 hex>` names; each policy resource chained after the previous one on the gateway; retry with backoff |
| Gateway targets | 100 per Gateway | `agentcore-gateway` ingress caps at 100 agents; tools gateways at 100 targets, checked at deploy |
| `tools/list` paging | one page per about 30 tools before Policy filters | an agent lists only its own targets' gateways |
| `InvokeAgentRuntime` custom header value | 10,240 bytes enforced, documented as 4 KB (spec §7.4, T-101); the API Gateway authoriser context carried 24,000 bytes, cached and uncached | `MAX_TOKEN_BYTES` 10,240 checked on the signed token, `grant_too_large` above it (ADR-0045) |
| `scope` claim | 6,144 bytes, a token of about 9.7 KB with long claims | `grant_too_large` above it, before the KMS call; `<target>/*` compression (ADR-0041, ADR-0045) |
| Token near `exp` | AgentCore Gateway refuses a token with 60 s or less left | `ttl` floor 120 s; usable at a tools gateway until `exp − 60 s` (ADR-0040) |
| KMS `Sign` latency | p50 8.2 ms, p95 11.1 ms (spec §7.1) | mint on the request path with a cache |
| SSM Parameter Store writes | 3 `PutParameter` and 3 `DeleteParameter` per second per account | one JSON parameter per ingress; test stacks publish nothing; the integ teardown retries at concurrency 2 (ADR-0042) |
| STS | 600 rps per account per Region, shared | TVM caches at the ingress and the tool side; limits run before STS |
| Lambda-backed custom resources | CloudFormation does not retry a failed handler | each handler retries its own throttles: registry entry (SSM adaptive, 8 attempts), tool policy (conflict and throttle backoff); owned rows rely on the SDK's default retries; each handler answers CloudFormation before its Lambda timeout |

The token is about 4/3 of `scope` plus 1.3 to 1.6 KB of other claims and
signature, so a full `scope` gives a token of about 9.7 KB. Whole targets
compress to one entry, and `scope` holds about 600 short names
(`crm/t0001`). A user cut from one tool of a 300-tool target expands to 299
names (about 2.7 KB): two such targets still fit, three overflow, and one
300-tool target with 24-byte tool names overflows alone (about 7.5 KB).
Every overflow fails loud with 502 `grant_too_large` before any Runtime
call. If the Runtime starts enforcing its documented 4 KB, a token over it
fails at the Runtime with a 400 (`scope` of about 2 KB); lower
`MAX_TOKEN_BYTES` and `MAX_SCOPE_BYTES` to match (ADR-0045).

## Known limitations

- Revocation lags: a cut or an unsubscription reaches tokens in flight only
  at their `exp` (300 s by default); no revocation list is kept.
- On `api-gateway` the authoriser caches its decision for up to 60 s per
  identity token and path (ADR-0043), so a change for a cached caller lands
  within that window. A foreign `X-Tenant-Id` after a cached Allow is still
  refused by the integration Lambda.
- Without `responseFilter`, `tools/list` shows every tool of a target the
  user holds any entry of; the call is still refused per tool.
- AgentCore Policy refusals carry no tenant in its logs. The interceptor
  runs first and logs every refusal it makes; a Policy denial after an
  admitted call means the two disagree and should be alarmed on.
- OpenAPI, Smithy and MCP-server targets without 3LO or OBO are filtered
  isolation, and the tool rate limit fails open by design.
- The `agentcore-gateway` ingress never sees the response, so backend
  seconds, tokens and bytes are not attributed there.
- A grant whose token would exceed 10,240 bytes is refused, not served
  (ADR-0045, T-100); the bound rests on the Runtime's enforced header limit,
  which is above its documented 4 KB (T-101).

## Cross-tenant data safety

The code check behind the [Tenant isolation](#tenant-isolation) table. Each
item was checked in code on 2026-11-04:

- The tenant comes from the verified identity token only; with `multiTenant`, `X-Tenant-Id` must be one of its `tenants` (ADR-0038).
- The grant is computed from the entitlement rows of that tenant and user and the registry entry of the routed agent; nothing in the body or a header adds to it (ADR-0030).
- The mint cache key holds tenant, user, agent, the three versions, the granted `scope` and the gateway list; `sub` is `<tenant_id>#<sub>`, so one user in two tenants has two subjects (ADR-0040).
- `kms:Sign` is granted only in the key policy, to the minting role (the interceptor role on `ToolContextKey`); grants are denied in the key policy, so no IAM policy can add a signer; the residual is `kms:PutKeyPolicy`, held by the account's key administrators (the deployer's own privilege), visible in CloudTrail (P-14, ADR-0046).
- Every verifier (the ingress, the tools interceptor, the list filter) requires `exp` and `iat` (`requiredClaims`); a wrong `typ` at the interceptor is `token_invalid`.
- A grant compresses to `<target>/*` only when the agent, the tenant (or plan) and the user each held `<target>/*`; an explicit full list stays explicit, so a tool added to the catalogue later is not granted by it (`compressTools`, ADR-0046).
- On `api-gateway` the integration Lambda accepts the authoriser's token only for the tenant and agent it verified itself.
- On a single-tenant `api-gateway` ingress `X-Tenant-Id` is not an identity source, so the authoriser decision is cached per token and path for up to 60 s: after a foreign header the same token is refused until the entry expires, and after a cached Allow the integration Lambda selects the tenant again and refuses a foreign header with 403 `tenant_not_allowed` (`src/ingress/api-gateway-ingress.function.ts`, `src/shared/tenant.ts`). Fail-closed either way; no cross-tenant effect.
- The tools gateway accepts only tokens from the ingress issuer with its own `aud`; the interceptor also checks `typ`, `agent` and `act.sub`.
- The interceptor overwrites a client `tenantId` and `_ri_ctx`; the context is bound to one tool and its `argsHash` and lives 60 s; its key is not in the JWKS.
- A tool reaches tenant data only with credentials its own TVM vended for the context's tenant; the tool tenant role allows item calls where `dynamodb:LeadingKeys` is `TENANT#${aws:PrincipalTag/TenantId}` (step 20: a probe of another tenant fails in IAM, and no `AssumeRole` follows a direct invoke).
- A Cedar `<target>/<tool>` entry cannot match another target (`xcrm/a` does not start with `crm/`, ` crm/` needs the space).
- The TVM cache key is the full sorted session tag set; module scope holds only clients, config and the caches.
- `conversationId` is `[A-Za-z0-9]{16,64}` and always qualified by a claim-derived prefix (ADR-0002, ADR-0039).
- `TenantAdminRole` reaches only `TENANT#${aws:PrincipalTag/TenantId}` items, and its writes may name only `PK`, `SK`, `cutAgents`, `cutTools`, `updatedBy`, `updatedAt` and `version`, so it cannot change its own `#SUB` row's `agents` or `tools`; the owned-rows role only its own partition keys.
- The registry is a trust boundary: only an agent's registry-entry role may write its entry, the ingress role only reads the prefix, and an entry outside the ingress's account is refused.
- Each Runtime's resource policy names the one ingress role and denies every other principal; the ingress role's grant is tag-conditioned (ADR-0001, ADR-0024).
- No log line carries a token, a context value, credentials or a prompt; the integ sweep found no signature segment in 139 log groups.

## Differences from the specification

The specification carries dated amendments for the implementation findings
(ADR-0040 to ADR-0045): the 120 s `ttl` floor and the `exp − 60 s` tools
gateway margin, the authoriser cache formula, policy names, the plan index and
gateway count rows, the demo tool data layout, the interceptor refusal code,
the published document and the integ stacks. The 2026-11-04 review added
notes for what the code does where the text said otherwise: `aud` names the
gateways of the granted tools, `toolsGateways: {}` fails synth, the Gateway
refuses an altered token with 403, the mint cache key includes `scope` and
the gateways, the grant compression rule, required `exp` and `iat`, the list
filter's empty page and log lines, the catalogue row attributes, the tool
pointer's fixed `version`, the same-stack synth tool count, and the
`ToolsGateway` members. With those notes, one difference remains after
reading code against spec §5.1:

- **Check order on `api-gateway`.** The spec orders the per-tenant limit
  before the mint, so a 429 costs no KMS call. On `api-gateway` the authoriser
  mints and the limit runs later in the integration Lambda, so a request
  refused with 429 may already have cost one `kms:Sign` (on a mint cache miss;
  the authoriser and mint caches absorb most). `agentcore-gateway` follows the
  spec order. No isolation effect; a cost and quota effect only.

## Per-tenant observability

| Signal | Where | Tenant field |
|---|---|---|
| Access log (`api-gateway`) | `ApiAccessLogs` | `tenantId` from the authoriser context, `principalId` |
| Ingress lines | `request authorised` (authoriser), `request served` (integration Lambda: `ttfbMs`, `streamedBytes`, `backendInvokeSeconds`, `usageInput`, `usageOutput`, `modelId`), `request admitted` (interceptor: `sessionPrefix`), `request refused` and `token refused` with `reason` | `tenantId`, `backend`/`agent`, `txn`, `grantSize`, `mint` |
| Tools lines | `tools request admitted`, `tool admitted` (`decision`, `gateway`, `target`, `reason`), `tools list filtered` (`listed`, `kept`), `tool served` (`durationMs`, `bytes`), `tool refused` | `tenantId`, `agent`, `txn` |
| Entitlement API | `entitlement written`, `entitlement deleted`, `entitlement request refused` | the target tenant id |
| EMF, opt-in | namespace `RuntimeIsolation`, dimensions `[TenantId, Ingress]` and `[TenantId, Ingress, Backend]`: `Requests`, `Errors4xx`, `Errors5xx`, `IngressDurationMs`, `TtfbMs`, `BackendInvokeSeconds`, `StreamedBytes`, `ModelInputTokens`, `ModelOutputTokens` | `perTenantMetrics`, off by default because each tenant adds about nine billed metrics per ingress (ADR-0021); integ 8b-metrics checks it |
| Contributor Insights (demo, `api-gateway`) | top tenants by requests and errors (access log), by backend seconds and output tokens per agent (`request served`) | `$.tenantId`, `$.backend` |
| Usage event | the agent's last SSE event `event: usage` `{inputTokens, outputTokens, modelId}` | attributed to the verified tenant of the request, never to a tenant the agent names |

## Per-tenant cost attribution

Nothing in the bill carries a tenant tag: no resource is dedicated to a
tenant. Two mechanisms attribute cost per tenant (standard §4.4):

    cost(tenant) = Σ over metered drivers ( driver(tenant) × unit price )
                 + model cost from CUR 2.0 by iamPrincipal/TenantId
                 + share of the unattributable remainder

| Driver | Source | Billed item |
|---|---|---|
| `BackendInvokeSeconds` | `request served` or EMF | AgentCore Runtime vCPU-hour and GB-hour (wall time is an upper bound, so use it as the share key) |
| `IngressDurationMs`, `Requests` | ingress lines or EMF | Lambda GB-second and requests; API Gateway REST or AgentCore Gateway calls |
| `StreamedBytes` | `request served` or EMF | data transfer out where billed |
| Mints with `mint: miss`; `tool admitted` count | ingress and interceptor lines | KMS `Sign` requests |
| `tools request admitted` + `tool admitted` count | interceptor lines | tools gateway calls and AgentCore Policy authorisations ($0.025 per 1,000) |
| `tool served` `durationMs` | tool lines | tool Lambda GB-second |
| Model tokens | CUR 2.0 by `iamPrincipal/TenantId` (ADR-0018) | Amazon Bedrock; `ModelInputTokens`/`ModelOutputTokens` and the agent's `usage` event are a cross-check, not the billing source (ADR-0017) |

**Model cost comes from the bill, by IAM principal.** Every call the agent
signs carries the `TenantId` session tag from the TVM, and the tool-side TVM
tags its credentials the same way. Turn it on once per account: in Billing,
Cost allocation tags, activate `iamPrincipal/TenantId`; in the CUR 2.0 data
export, enable "Include caller identity (IAM principal) allocation data".
Model cost per tenant is then one query over `line_item_iam_principal` and
`iamPrincipal/TenantId`. A model failure sends `event: error` and no usage
event, so those tokens show as unattributed, never as zero.

**The unattributable remainder**: the KMS keys' monthly charge (two per
ingress, three during a rotation, about $1/month each), the entitlement
store and `TenantLimits` tables (on demand, PITR on), SSM reads, the
custom-resource Lambdas (registry entry, owned rows, tool policy, JWKS, log
drain), provisioned concurrency on the tools interceptors, Gateway calls
refused before an interceptor runs, log storage and ingestion, dashboards,
Contributor Insights rules and the custom metrics themselves (with
`perTenantMetrics`, 9 × (1 + agents) per tenant per ingress), X-Ray traces,
and the backend time of streams that broke before the usage event. The
sample apportions it by each tenant's share of `Requests`, refusals
included. The two unit prices stated here (KMS keys, AgentCore Policy) are
the ones the README Costs summary repeats; take the others from each
service's pricing page.

## What the service cannot carry per tenant

- **`agentcore-gateway` ingress.** The interceptor returns before the Runtime is invoked, so backend seconds, model tokens and streamed bytes are not metered there and the output-token limit does not exist; a failure after admission is only in the Gateway's own logs and metrics. Join through `sessionPrefix` and time on `request admitted`.
- **Tools gateways.** No access log and no application logs (ADR-0040), no per-tenant metrics; a request refused by `CUSTOM_JWT` or the native rate limit before the interceptor leaves no line with `tenantId`. Per-tenant tool figures are Logs Insights over the interceptor and tool lines.
- **Runtime CPU and memory.** Billed per session, not reported per tenant; join through the session id prefix.
- **Model cost.** From CUR 2.0 a day later; two agents on one model are told apart only by the ingress lines.
- **X-Ray traces.** No trace carries `tenantId`; join through the Lambda request id on the log line.
- **Non-Lambda tool targets.** The tool learns the caller only from its outbound credential; its own cost is the target owner's to split.
- **Top-tenant views.** The four Contributor Insights rules exist only on `api-gateway`; elsewhere use Logs Insights.

The README's [Operate](./README.md#operate) section has the deployer's
summary of limits and costs.

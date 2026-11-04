<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Agentic Runtime Isolation: Architecture

> **Status: v2 implemented and verified.** Last green integration run: run 9,
> 2026-11-04, a sandbox account, eu-central-1. All 57 steps of
> `scripts/integ.sh` (the CDK CLI driver, ADR-0044) passed and the teardown left nothing behind (no stack,
> parameter, log group, table, Gateway or Policy engine; the KMS keys pending
> deletion). Six stacks (`api-gateway`, `agentcore-gateway`, `session-off`,
> `session-user`, `limits`, `multi-tenant`) deployed in 278 s; the steps took
> 1,669 s. Both all-on stacks ran spec §8 steps 3 to 24: P-1 (direct invoke
> refused), units and sessions, the grants table, ABAC, model usage, latency
> (step 9), the registry, a late agent and a drain, the headers that reach the
> agent (no identity token), cuts landing on the next request, the per-tool
> wall, forged contexts, token expiry, `aud` and `act` refusals, the tool-side
> TVM, Policy time-to-ACTIVE and the RESPONSE filter. Step 9 TTFB p50/p95:
> `api-gateway` warm 0.203/0.244 s, cold mint cache 0.227/0.248 s;
> `agentcore-gateway` warm 0.265/0.327 s, cold 0.297/0.349 s; `stream 10`
> first byte at about 0.2 to 0.3 s. Step 23: one ACTIVE star permit per
> target, 10.6 to 15.7 s from `CreatePolicy`. On their own stacks: 4a, 4b-user,
> the per-tenant limit (tenant A refused with 429 on call 6, tenant B served)
> and step 19 (a user in several tenants). Step 21 rotated the signing key in
> 151 s with two keys in the JWKS. The log sweep read 139 log groups and found
> 0 token segments. The [README integration test](./README.md#deployment-integration-test)
> has the step table; the [threat model](./threat-model.md#security-review)
> records the security scans and their dates.

This file describes what is deployed. The design trail is
[`design/agentic-runtime-isolation.spec.md`](./design/agentic-runtime-isolation.spec.md), the
[ADRs](./adr/README.md) and the [threat model](./threat-model.md).

## Purpose

A pooled agent platform where each tenant user's conversation runs in its own
compute unit (an AgentCore Runtime microVM), every Runtime trusts exactly one
ingress, and every tool call carries a tenant context the tool can verify. One
ingress fronts one or more agents (backends) and one or more tools gateways.
For each request the ingress verifies the identity token, selects the tenant,
resolves the agent from the route, reads what the tenant and the user are
entitled to, computes the grant, mints a short-lived transaction token that
names exactly one tenant, user and agent and carries exactly that grant,
chooses the unit, vends tenant-scoped credentials, limits each tenant's share,
and attributes cost per tenant and agent (ADR-0001, ADR-0012, ADR-0017,
ADR-0020, ADR-0024, ADR-0030, ADR-0031). The agent reaches tools only through
a tools gateway that accepts that transaction token alone (ADR-0034,
ADR-0041).

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
| `TenantAdminRole` | `EntitlementApi` | item calls on `TENANT#${aws:PrincipalTag/TenantId}` only (ADR-0033) |

See the [specification](./design/agentic-runtime-isolation.spec.md) §3.2.

## Constructs, routes and the registry

| Construct | Creates | Code |
|---|---|---|
| `SharedIngress` | the ingress (API Gateway REST API or AgentCore Gateway), the token verifier, the entitlement store and API, the token signer and discovery routes, the tools gateways, the TVM wiring, `TenantLimits`, the log drain, the published parameter | `src/shared-ingress.cdk.ts` |
| `AgentBackend(ingress)` | one Runtime, its resource policy, on `agentcore-gateway` its Gateway target, the `NAME#<name>` reservation, its model statement on the tenant role, its registry entry (written last) | `src/agent-backend.cdk.ts` |
| `ToolTarget(ingress)` | the `NAME#<target>`, `TOOL#<target>` and `GATEWAY#<g>` rows, the Gateway target on one tools gateway, its one Cedar permit, its registry pointer | `src/tool-target.cdk.ts` |
| `ToolsGateway` | one AgentCore Gateway for tools with its Policy engine, interceptors and rate limit; created by `SharedIngress` | `src/tools-gateway.cdk.ts` |
| Demo stack | a `SharedIngress` with `defaultBackend: 'default'` and two tools gateways (`default`, `finance` with `responseFilter`); the `default` agent (`needs: ['default/chat']`, `tools: ['crm/*']`); optionally `billing` (`billing/read`, `billing/invoke`, `invoices/*`); tool targets `crm` (`get_account`, `list_cases`, `update_case`) on `default` and `invoices` (`get_invoice`, `list_invoices`) on `finance` | `src/main.ts`, `src/demo.cdk.ts`, `src/tools/demo/*` |

Routes: `POST /{backend}/invocations` on both ingresses (one API resource on
`api-gateway`, one Runtime target per agent on `agentcore-gateway`); with
`defaultBackend`, also `POST /invocations` on `api-gateway`. A backend or
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
outside its own partition, Region and account, or a v1-shaped entry with
`scopes` (502 `registry_entry_v1`). The registry-entry function's role may
put, get and delete its one parameter; it refuses to create a name that
exists and drains only an entry whose `runtimeArn` is its own. Delete sets
`draining`, waits one TTL plus the longest stream (120 s), then removes the
entry. Nothing a backend or tool target does redeploys the ingress.

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
`no_tools_granted`: logged, served, not refused. A `scope` above 8,192 bytes
is `grant_too_large` (502) (ADR-0032, ADR-0033, ADR-0041).

Change lag (ADR-0036): every vendor or admin write bumps `tenant.version`,
which is in the mint cache key, so it lands on the next request; a plan, an
agent's tools or a tool added to a target lands within `registryTtl`. A
token in flight keeps its grant until `exp` at the agent and until
`exp − 60 s` at a tools gateway (the Gateway refuses a token with 60 s or
less left). No revocation list is kept; lower `transactionToken.ttl` for a
faster stop. Integ steps 12 and 16 measured both.

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
| Keys | One KMS `SIGN_VERIFY` key per generation (`RSA_2048` or `ECC_NIST_P256`). `kms:Sign` is granted only in the key policy, to the minting role; grants are denied in the key policy (`kms:CreateGrant` for every principal) and the account root keeps the administrative actions but no `kms:Create*`, so no IAM policy and no grant can add a signer. The residual is `kms:PutKeyPolicy`, held by the account's key administrators (the deployer's own privilege) and visible in CloudTrail (ADR-0037 amendment, threat model T-97). `ToolContextKey` has the same policy with the interceptor role as signer |
| JWKS | `Custom::RuntimeIsolationJwks` reads `GetPublicKey` at deploy and renders `{ keys: [...] }`, current key first; `/.well-known/openid-configuration` and `/.well-known/jwks.json` are mock integrations with `Cache-Control: public, max-age=300`: no Lambda or KMS call per read |
| Rotation | Bump `transactionToken.keyGeneration` (demo context `keyGeneration`): key N+1 signs from that deploy, key N stays in the JWKS without `kms:Sign`; at N+2 key N leaves and is scheduled for deletion (30 days). Two bumps at least `ttl` + 300 s apart. Integ step 21: 151 s, two keys in the JWKS |

KMS `Sign` measured p50 8.2 ms, p95 11.1 ms (spec §7.1); a mint cache miss
adds about 0.02 to 0.04 s to TTFB (step 9 cold against warm).

## Tools gateways

`SharedIngress` creates one tools gateway named `default` (`toolsGateway`), or
one per entry of `toolsGateways`, or none (`toolsGateway: false`). Each has its
own Policy engine, interceptors and rate limit, because one engine's Cedar
schema holds about 330 tools (ADR-0041).

| Part | Behaviour |
|---|---|
| Inbound | `CUSTOM_JWT` on the ingress issuer's discovery URL, `allowedAudience: ['tools-gateway:<g>']`, no `allowedClients`. An identity token fails on `iss`, a token for another gateway on `aud`; a token with 60 s or less to `exp` is refused (403) |
| REQUEST interceptor | `src/tools/interceptor.function.ts`, `passRequestHeaders: true`, provisioned concurrency 1 on the `InterceptorLive` alias. Runs before Policy, so it is the first wall and the per-tool wall: re-verifies the token against the ingress JWKS (`typ: txn+jwt`, `iss`, `aud` holding `tools-gateway:<g>` and `agent:<agent>`, `act.sub` = the ingress role, `exp`); on `tools/call` checks the tool against `scope` (`tool_not_granted`); overwrites a client `tenantId` argument; computes `argsHash`; signs the tenant context with `ToolContextKey` and writes it to `_ri_ctx`, overwriting anything the client sent. A refusal is HTTP 403 with JSON-RPC error `-32003` `forbidden: <reason>`; a throw or timeout is a Gateway 5xx (fail-closed). A token minted for another gateway is `token_invalid`; a non-`txn+jwt` `typ`, or a token without `exp` or `iat`, is `token_invalid`; no `act` is `act_missing` (integ step 17) |
| Policy | AgentCore Policy in `ENFORCE` mode, default deny. One Cedar star permit per target (`src/shared/cedar.ts`): `action in AgentCore::Action::"<target>"` when `principal.getTag("scope")` holds `<target>/*` or any `<target>/<tool>` as a whole entry; about 450 bytes whatever the tool count. Filters `tools/list` and refuses `tools/call` at target grain |
| Policy writer | `Custom::RuntimeIsolationToolPolicy` (`src/tools/tool-policy.function.ts`): `CreatePolicy` and wait for ACTIVE, retrying a conflict or throttle with backoff and deleting a `CREATE_FAILED` policy first; Update on every target change (the touch for tools added later); Delete and wait until gone, before the Gateway target is deleted. Name `<target>_target_<8 hex>` (a hash of stack, construct path and gateway). Returns `SecondsToActive` (demo outputs `CrmPolicySecondsToActive`, `InvoicesPolicySecondsToActive`) |
| RESPONSE filter | Optional (`responseFilter`, demo `finance`): `src/tools/response-filter.function.ts` re-verifies the token from the passed request headers and trims each `tools/list` page to the exact tools in `scope`; only removes; on any error an empty page and `response_filter_failed` (integ step 24) |
| Tenant context | Compact JWS, RS256, `typ: ri-ctx+jwt`; claims `tenant_id`, `sub`, `user`, `agent`, `tool`, `argsHash`, `txn`, `iat`, `exp` (`contextLifetime`, 60 s, 10 s to 300 s). `ToolContextKey` is one KMS key per ingress, shared by its gateways; each interceptor's role gets `kms:Sign` in the key policy; its public half is never in the JWKS, so a context cannot pass as a transaction token |
| Tool side | `toolHandler` in `src/tools/context.ts`: verifies `_ri_ctx` with the cached public half of `ToolContextKey`, checks `typ`, `exp`, `tool` and `argsHash`, strips `_ri_ctx`, then assumes the tool's tenant role with the `TenantId` tag from the context (its own TVM; STS from the tool's role). No valid context: `context_invalid`, no credentials, and the tool's own role reaches no tenant data (integ step 20) |
| Rate limit | `CfnGatewayRateLimit` on `$.context.jwt.tenant_id`, 10 requests per second per tenant by default, up to 1,000 overrides; fairness, fail-open by design (M-60) |
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
`name <name> already registered by another stack`; Delete removes only rows
still carrying this owner. The function's role may write only the partition
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

The Smithy service is `Entitlements` (`model/entitlements.smithy`); the
generated OpenAPI is under `src/smithy/entitlements`. Entitlement write
refusals: 400 `unknown_name`, `not_subscribed` (a cut naming something the
tenant does not hold), `too_many`; 409 `plan_in_use`, `concurrent_write`.

InvokeAgent errors are fixed bodies that never echo the token, the unit id or
the input; a v2 refusal carries its reason code (`forbidden: agent_not_subscribed`):

| Status | When |
|---|---|
| 400 | malformed body or `X-Tenant-Id`; `tenant_required` |
| 401 | missing or invalid identity token, or a transaction token presented as one |
| 403 | no tenant; `tenant_not_allowed`; a floor scope missing; `tenant_suspended`; `agent_not_subscribed`; a `tvm.claimTags` claim missing |
| 404 | unknown or `draining` agent |
| 429 | the tenant's limit for the minute |
| 502 | backend, registry or entitlement store failed; `registry_entry_v1`; `grant_too_large`; `mint_failed` |

On `api-gateway` every authoriser Deny renders as 403 through `ACCESS_DENIED`,
including the authoriser's 404 and 502 cases (integ 9-registry: an unknown
agent is 403 there, 404 on `agentcore-gateway`); with `multiTenant` a request
without `X-Tenant-Id` is API Gateway's own 401 before the authoriser runs. The
[README API section](./README.md#api) has the full table.

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

Values are defaults or documented AWS quotas on 2026-11-04; check
[Service Quotas](https://docs.aws.amazon.com/general/latest/gr/aws_service_limits.html)
for your account and Region.

| Limit | Value | What hits it | What the sample does | Deployer action |
|---|---|---|---|---|
| API Gateway stage throttle | 50 rps, burst 25 (defaults) | all tenants and agents on `api-gateway` | `stageThrottle` prop (ADR-0020) | size it to the limits below; add WAF |
| Per-tenant requests | 60 per minute per tenant | one tenant's script | fixed-window counter, 429 before STS and the Runtime; up to 2x across a window boundary | `tenantLimits.requestsPerMinute` per tier |
| Tools gateway per-tenant rate | 10 rps per tenant per gateway | one tenant's tool calls | native rate limit on `tenant_id`, fail-open | `tenantRateLimit`, `tenantRateLimitOverrides` |
| AgentCore Runtime active sessions | 2,500 per account (5,000 in us-east-1 and us-west-2), adjustable | concurrent conversations | per-tenant limit bounds one tenant's share | quota increase; session mapping |
| AgentCore Runtime data plane | 1,000 TPS, adjustable | `InvokeAgentRuntime` | as above | keep the stage throttle below it |
| Lambda concurrency | per account per Region | the integration Lambda is held for the whole stream: 50 rps × 120 s = 6,000 | stage throttle only | reserved concurrency; `agentcore-gateway` for long streams |
| SSM Parameter Store reads | 40 TPS standard | registry misses: instances × agents ÷ `registryTtl` | per-process cache, stale-while-refresh | raise `registryTtl`; higher throughput |
| KMS `Sign` | per account per Region, shared request quota for asymmetric keys | mint misses and every `tools/call` (context signing) | mint cache; context per call only | watch KMS throttling; raise the quota |
| Amazon Bedrock model quota | per account per model | model tokens across tenants | optional `outputTokensPerMinute` on `api-gateway` | quota per model |
| CloudWatch custom metrics | 9 × (1 + agents) per tenant per ingress when on | `perTenantMetrics` at many tenants | off by default, synth warning (ADR-0021) | Logs Insights and Contributor Insights |
| Contributor Insights | top 500 contributors per rule | the four demo rules | `api-gateway` only | Logs Insights for the long tail |
| TVM and mint caches | 1,000 entries each per instance | more active tag sets or users per instance | LRU (ADR-0022) | `tvm.cacheMaxEntries`, `transactionToken.cacheMaxEntries` |

## Quotas that shape the design

| Quota or finding | Value | Design consequence |
|---|---|---|
| Policy engine Cedar schema | 400 KB per engine, about 330 tools (spec §7.2) | several tools gateways, one engine each; `maxToolsPerGateway` 300 (ADR-0041) |
| Per-tool Cedar permits | 28 tools per 10,000-character statement, 2 to 3 min to ACTIVE at 15+ policies | one star permit per target; the interceptor is the per-tool wall (ADR-0041) |
| `CreatePolicy` | names unique per account and Region; concurrent writes fail; 10.6 to 15.7 s to ACTIVE (run 9) | `<target>_target_<8 hex>` names; each policy resource chained after the previous one on the gateway; retry with backoff |
| Gateway targets | 100 per Gateway | `agentcore-gateway` ingress caps at 100 agents; tools gateways at 100 targets, checked at deploy |
| `tools/list` paging | one page per about 30 tools before Policy filters | an agent lists only its own targets' gateways |
| `scope` claim | 8,192 bytes accepted end to end | `grant_too_large` above it; `<target>/*` compression (ADR-0041) |
| Token near `exp` | AgentCore Gateway refuses a token with 60 s or less left | `ttl` floor 120 s; usable at a tools gateway until `exp − 60 s` (ADR-0040) |
| KMS `Sign` latency | p50 8.2 ms, p95 11.1 ms (spec §7.1) | mint on the request path with a cache |
| SSM Parameter Store writes | 3 `PutParameter` and 3 `DeleteParameter` per second per account | one JSON parameter per ingress; test stacks publish nothing; the integ teardown retries at concurrency 2 (ADR-0042) |
| STS | 600 rps per account per Region, shared | TVM caches at the ingress and the tool side; limits run before STS |
| Lambda-backed custom resources | CloudFormation does not retry a failed handler | each handler retries its own throttles: registry entry (SSM adaptive, 8 attempts), tool policy (conflict and throttle backoff); owned rows rely on the SDK's default retries; each handler answers CloudFormation before its Lambda timeout |

## Cross-tenant data safety

Each item was checked in code on 2026-11-04:

- The tenant comes from the verified identity token only; with `multiTenant`, `X-Tenant-Id` must be one of its `tenants` (ADR-0038).
- The grant is computed from the entitlement rows of that tenant and user and the registry entry of the routed agent; nothing in the body or a header adds to it (ADR-0030).
- The mint cache key holds tenant, user, agent, the three versions, the granted `scope` and the gateway list; `sub` is `<tenant_id>#<sub>`, so one user in two tenants has two subjects (ADR-0040).
- `kms:Sign` is granted only in the key policy, to the minting role (the interceptor role on `ToolContextKey`); grants are denied in the key policy, so no IAM policy can add a signer; the residual is `kms:PutKeyPolicy`, held by the account's key administrators (the deployer's own privilege), visible in CloudTrail (P-14, ADR-0037 amendment).
- Every verifier (the ingress, the tools interceptor, the list filter) requires `exp` and `iat` (`requiredClaims`); a wrong `typ` at the interceptor is `token_invalid`.
- A grant compresses to `<target>/*` only when the agent, the tenant (or plan) and the user each held `<target>/*`; an explicit full list stays explicit, so a tool added to the catalogue later is not granted by it (`compressTools`, ADR-0032 amendment).
- On `api-gateway` the integration Lambda accepts the authoriser's token only for the tenant and agent it verified itself.
- On a single-tenant `api-gateway` ingress `X-Tenant-Id` is not an identity source, so the authoriser decision is cached per token and path for up to 60 s: after a foreign header the same token is refused until the entry expires, and after a cached Allow a foreign header is ignored. Fail-closed or own-tenant; no cross-tenant effect.
- The tools gateway accepts only tokens from the ingress issuer with its own `aud`; the interceptor also checks `typ`, `agent` and `act.sub`.
- The interceptor overwrites a client `tenantId` and `_ri_ctx`; the context is bound to one tool and its `argsHash` and lives 60 s; its key is not in the JWKS.
- A tool reaches tenant data only with credentials its own TVM vended for the context's tenant; the tool tenant role allows item calls where `dynamodb:LeadingKeys` is `TENANT#${aws:PrincipalTag/TenantId}` (step 20: a probe of another tenant fails in IAM, and no `AssumeRole` follows a direct invoke).
- A Cedar `<target>/<tool>` entry cannot match another target (`xcrm/a` does not start with `crm/`, ` crm/` needs the space).
- The TVM cache key is the full sorted session tag set; module scope holds only clients, config and the caches.
- `conversationId` is `[A-Za-z0-9]{16,64}` and always qualified by a claim-derived prefix (ADR-0002, ADR-0039).
- `TenantAdminRole` reaches only `TENANT#${aws:PrincipalTag/TenantId}` items; the owned-rows role only its own partition keys.
- The registry is a trust boundary: only an agent's registry-entry role may write its entry, the ingress role only reads the prefix, and an entry outside the ingress's account is refused.
- Each Runtime's resource policy names the one ingress role and denies every other principal; the ingress role's grant is tag-conditioned (ADR-0001, ADR-0024).
- No log line carries a token, a context value, credentials or a prompt; the integ sweep found no signature segment in 139 log groups.

## Differences from the specification

The specification carries dated amendments for the implementation findings
(ADR-0040 to ADR-0044): the 120 s `ttl` floor and the `exp − 60 s` tools
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

    cost(tenant) = Σ over drivers ( driver(tenant) × unit price )
                 + share of the unattributable remainder

| Driver | Source | Billed item |
|---|---|---|
| `BackendInvokeSeconds` | `request served` or EMF | AgentCore Runtime vCPU-hour and GB-hour (wall time as the share key) |
| `IngressDurationMs`, `Requests` | ingress lines or EMF | Lambda GB-second and requests; API Gateway REST or AgentCore Gateway calls |
| `StreamedBytes` | `request served` or EMF | data transfer out where billed |
| Mints with `mint: miss`; `tool admitted` count | ingress and interceptor lines | KMS `Sign` requests |
| `tools request admitted` + `tool admitted` count | interceptor lines | tools gateway calls and Policy authorizations |
| `tool served` `durationMs` | tool lines | tool Lambda GB-second |
| Model tokens | CUR 2.0 by `iamPrincipal/TenantId` (ADR-0018) | Amazon Bedrock; `ModelInputTokens`/`ModelOutputTokens` are a cross-check |

Every call the agent signs carries the `TenantId` session tag from the TVM,
and the tool-side TVM tags its credentials the same way, so model and data
calls are attributed by IAM principal once the `iamPrincipal/TenantId` cost
allocation tag and the CUR caller-identity option are on (account-level). No
resource is dedicated to a tenant, so no resource carries a `TenantId` tag.

The unattributable remainder: the KMS keys' monthly charge, the entitlement
store and `TenantLimits` tables, SSM reads, the custom-resource Lambdas
(registry entry, owned rows, tool policy, JWKS, log drain), provisioned
concurrency on the tools interceptors, Gateway calls refused before an
interceptor runs, log storage and ingestion, Contributor Insights rules and
the custom metrics themselves, X-Ray traces, and the backend time of streams
that broke before the usage event. The sample apportions it by each tenant's
share of `Requests`, refusals included. The [README Costs section](./README.md#costs)
has the unit prices.

## What the service cannot carry per tenant

- **`agentcore-gateway` ingress.** The interceptor returns before the Runtime is invoked, so backend seconds, model tokens and streamed bytes are not metered there and the output-token limit does not exist; a failure after admission is only in the Gateway's own logs and metrics. Join through `sessionPrefix` and time on `request admitted`.
- **Tools gateways.** No access log and no application logs (ADR-0040), no per-tenant metrics; a request refused by `CUSTOM_JWT` or the native rate limit before the interceptor leaves no line with `tenantId`. Per-tenant tool figures are Logs Insights over the interceptor and tool lines.
- **Runtime CPU and memory.** Billed per session, not reported per tenant; join through the session id prefix.
- **Model cost.** From CUR 2.0 a day later; two agents on one model are told apart only by the ingress lines.
- **X-Ray traces.** No trace carries `tenantId`; join through the Lambda request id on the log line.
- **Non-Lambda tool targets.** The tool learns the caller only from its outbound credential; its own cost is the target owner's to split.
- **Top-tenant views.** The four Contributor Insights rules exist only on `api-gateway`; elsewhere use Logs Insights.

See the [README](./README.md#scale-and-limits) for the props and the
[Costs](./README.md#costs) section for the formula.

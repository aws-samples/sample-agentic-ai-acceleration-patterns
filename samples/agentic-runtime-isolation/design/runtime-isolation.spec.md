<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Specification: Runtime Isolation

> **Status:** Draft, 2026-10-26. Requirements and principles for the
> `agentic-runtime-isolation` sample. Items marked **[verify]** are service
> behaviours the design depends on; the first spike (§7) proves them, and if
> one fails the named fallback applies and an ADR records the change.

The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

---

## 1. Problem statement

A multi-tenant agent needs compute that keeps one tenant's work out of
another's process. Several AWS services offer that unit of isolation: Amazon
Bedrock AgentCore Runtime runs each `runtimeSessionId` in its own microVM;
AWS Lambda runs each function instance in its own microVM. None of them
decides *which* unit a given caller may use. That mapping, from an
authenticated caller to an isolated unit, is left to the vendor
([Runtime security best practices](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html)).

The obvious build puts a JWT authoriser on the compute service and a check in
the agent that the caller matches the unit. That is **filtered** isolation:
any valid token can call the service and name any unit, and the only thing
between a tenant and another tenant's process is a line of agent code that
runs *inside* the unit it is meant to guard.

**Runtime isolation**, as this sample defines it, makes the mapping
**enforced**. The compute service trusts exactly one IAM principal, an
ingress the vendor controls. The ingress validates the user's JWT, reads the
tenant and user from the validated claims, chooses the isolation unit, and
invokes the service with SigV4. A leaked or forged JWT, or a guessed unit id,
cannot reach a unit the ingress would not have chosen for that caller. Every
check sits in front of the compute, never inside it.

The pattern is a core plus optional modules. The core is the trusted ingress,
the one-principal resource policy (P-1, P-3), and an always-on token vending
machine that signs model calls and data access per tenant (P-8, P-10,
ADR-0018). The modules below each add a check; the TVM is always on,
per-tenant limits are on by default, and the rest are off by default (P-4):

| Module | Adds | Prop |
|---|---|---|
| Session mapping | conversations that persist across requests, in a unit derived from the caller's claims, so a user resumes only their own session (P-2, ADR-0002, ADR-0013) | `session` |
| Scope checks | required OAuth scopes on the token (ADR-0005) | `requiredScopes` |
| Delegation | the user's token forwarded to the agent, optionally narrowed (P-5) | `delegation` |
| TVM | always on (ADR-0018): tenant-scoped AWS credentials for the model call and the agent's data access (P-8); `tvm` customises it, e.g. a role that also reaches tenant data | `tvm` |
| Per-tenant limits | on by default (ADR-0020): requests per tenant per minute, and on `api-gateway` optionally output tokens, counted fleet-wide; over the limit is 429 | `tenantLimits` |
| Per-tenant metrics | off by default (ADR-0021): per-tenant CloudWatch metrics (EMF); the ingress log line carries the same figures without them | `perTenantMetrics` |

Without session mapping every request runs in a fresh unit and nothing
carries over between requests: the strictest setting. With it, the sample
realises the "Runtime isolation with session mapping" pattern of
[Agentic AI delegation patterns](https://builder.aws.com/content/3HBLL1UuIpyzPENldeTfjYjvGQj/agentic-ai-delegation-patterns),
Figure 3.

The pattern is not tied to one service. It needs any compute service that
runs work in isolated units and lets one IAM principal be the only caller.
The construct models that as a **backend**, a typed prop (ADR-0011).
AgentCore Runtime is the first and, for now, only backend; AWS Lambda's
microVMs are a candidate for a later one. The principles (§2) are written
against the backend, and §3 maps them onto AgentCore Runtime.

The sample ships as CDK constructs, `SharedIngress` and `AgentBackend`
(standard §4.5), with the ingress a deploy-time choice: an Amazon API Gateway REST API with response
streaming, or an AgentCore Gateway with a Runtime target. The tenant-identity
sample, topology `shared-pool`, is the identity provider.

### 1.1 Deployment model

**Pool**: one backend per agent, shared by every tenant; isolation per unit.
A unit is one request by default, or one conversation per user or per tenant
with `session` set. Enforced isolation at the invocation boundary.

| Layer | What isolates tenants |
|---|---|
| Who may invoke the backend | Backend resource policy: only the ingress principal (P-1) |
| Which unit a request lands in | Ingress chooses the unit: fresh per request, or derived from validated claims with `session` (P-2) |
| What the agent can reach | Execution role: logs and traces only; no model and no tenant data (P-6) |
| What model and tenant data the agent may reach | Always-on TVM: tenant-scoped credentials vended at ingress from the same claims, used to sign the model call (cost attributed per tenant, P-10) and any data access, IAM-enforced (P-8) |
| What a delegated token can do | Optional; forwarded only on opt-in, optionally narrowed (P-5) |

### 1.2 What this sample is NOT

- Not a backend catalogue. Only the AgentCore Runtime backend is built. A new
  backend is added only when it meets P-1 and P-2, proved by the same e2e
  suite (ADR-0011).
- Not a session-mapping sample only. Session mapping is one module; the
  construct is complete without it.

- Not an identity provider. It consumes tokens from tenant-identity's
  `shared-pool` topology; any OIDC provider that issues the §6.2 token
  contract works.
- Not a data-layer sample. The always-on TVM (P-8, ADR-0018) vends tenant-scoped
  credentials; what they unlock (memory, RAG stores, tools) is the data layer
  (`ARCHITECTURE.md` §3.3) and belongs to later samples that consume this
  construct. The demo ships one tenant-partitioned table only to prove the
  credentials work.
- Not multi-tenant-per-user. A user belongs to exactly one tenant
  (tenant-identity `shared-pool`). The `shared-pool-multi-tenant` topology is
  out of scope.
- Not a tool gateway. AgentCore Gateway is used only as an ingress to the
  Runtime, never as an MCP aggregator.
- Not an RFC 8693 token service. Downscoping reuses tenant-identity's
  `/oauth2/token` (ADR-0007).
- Not a session store. No table lists or revokes sessions.

---

## 2. Guiding principles

**P-1. The backend trusts one IAM principal, and it is the ingress.**
The backend uses IAM (SigV4) inbound authorisation. Its resource policy
allows the invoke call only for the ingress principal and denies every other
entry point to everyone. For AgentCore Runtime that is
`bedrock-agentcore:InvokeAgentRuntime` for the ingress, and a deny on
`InvokeAgentRuntimeForUser` and the WebSocket and command variants. No user
token can invoke the backend directly. Rules out: a JWT authoriser on the
backend as the only gate.

**P-2. The ingress alone chooses the isolation unit, from validated claims,
never from the request alone.** Without `session`, every request runs in a
fresh unit: the ingress generates a random unit id and nothing is shared
between requests. With `session`,
`runtimeSessionId = "s-" + base32(sha256(tenant_id "|" sub))[0:26] + "-" + conversationId`
for `session.scope: 'user'`, and `sha256(tenant_id)` for `'tenant'`.
`conversationId` is client-chosen (16 to 64 of `[A-Za-z0-9]`), so a user can
hold several conversations, but the prefix comes only from the verified
token. In both cases a unit id sent by the client is ignored and overwritten
(ADR-0002, ADR-0013).

**P-3. Tenant context comes only from the validated JWT.** `tenant_id` and
`sub` are read from a token whose signature, issuer, client, expiry, and
`token_use: access` were checked at ingress. Nothing in the body, query, or a
client header names a tenant.

**P-4. Every module is typed, with a secure default.** Session mapping,
scope checks, token forwarding, downscoping and per-tenant metrics are off by
default. The TVM is always on (ADR-0018). Per-tenant limits are on by
default, at 60 requests per tenant per minute (`tenantLimits`, ADR-0020).
Turning a module on adds a check; none removes one (amended 2026-10-27,
ADR-0018, ADR-0020, ADR-0021).

**P-5. A delegated token is the narrowest token that works, in a header the
agent asked for.** The user's JWT reaches the agent only when
`delegation.forwardUserToken` is set, in
`X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Token`, never in
`Authorization` (which carries SigV4 to the Runtime). With
`delegation.requireNarrowedToken`, the ingress refuses any bearer token whose
`scope` set is not a subset of `delegation.allowedScopes` (ADR-0006,
ADR-0007).

**P-6. The agent's own role cannot cross tenants because it holds nothing
tenant-scoped, and holds no model permission either.** The execution role
grants logs and traces only; it has no data permission and, since ADR-0018,
no `bedrock:Invoke*`. The agent invokes the model with the vended tenant
credentials (P-8), so model access too is scoped to the verified tenant. The
microVM's MMDS credential is therefore not a tenant boundary concern in this
sample.

**P-7. Security first, then latency, then cost.** Both ingress options MUST
meet P-1 to P-6 identically. They are compared on measured latency
(time to first byte, total) and per-request cost, and the README states
which to prefer and why (ADR-0009).

**P-8. Tenant data and the model are reached only with credentials vended
from the validated token, never from the agent's own role.** The TVM is
always on (ADR-0018). The ingress assumes a tenant role with session tags
built from the claims it has just verified (`TenantId` always; `UserId` and
allowlisted claims on opt-in) and forwards the credentials to the backend
over the transport the backend defines (§3.4; ADR-0011). The agent signs
every model call with those credentials, so AWS attributes model cost to the
IAM principal per tenant (CUR 2.0, ADR-0018); a data-bearing role's policy
scopes data by `${aws:PrincipalTag/TenantId}`, so a cross-tenant call fails
in IAM whatever the agent does (enforced, not filtered). The agent holds no
`sts:AssumeRole` and, since ADR-0018, no model permission of its own
(ADR-0012). `tvm.role` is optional: unset, the construct creates a default
role that may invoke only the one model; set, the deployer supplies a role
that also reaches tenant data and the construct adds the model grant to it.

**P-9. Every request is attributable to a tenant in telemetry.** The ingress
writes the verified `tenant_id` (and the session prefix, never the token) as
a top-level field of one structured log line per request and, on API Gateway,
in the access log. That log line is the default path (ADR-0021). On
`api-gateway` it is `request served` and carries status, TTFB, streamed
bytes, backend invoke seconds and the usage tokens. On `agentcore-gateway`
the interceptor writes `request admitted` with request-side fields only,
because it never sees the response. Per-tenant CloudWatch metrics (EMF) are
opt-in through `perTenantMetrics`, default `false`. The demo adds four
Contributor Insights top-tenant rules, on `api-gateway` only: two on the
access log (requests, errors) and two on the ingress log line (backend
seconds, output tokens) (amended 2026-10-27, ADR-0021). The Runtime's own log streams are named by session id, whose
prefix is derived from the tenant, so a session can be joined back to a
tenant through the ingress log. What the Runtime cannot carry per tenant is
listed in `architecture.md` (standard §4.4).

**P-10. Every request's cost is attributable to its tenant.** The pattern
pools one backend across tenants, so nothing in the bill carries a tenant
tag; the ingress meters, per tenant, the consumption each billed service
charges for: ingress requests, ingress compute milliseconds, backend
invocation seconds (wall time of the invoke, the AgentCore Runtime billing
unit together with memory), and streamed bytes. Backend seconds, bytes and
tokens are metered on `api-gateway` only; the `agentcore-gateway`
interceptor sees the request, not the response, so it meters requests only
(amended 2026-10-27, ADR-0021). Model tokens are the
exception (ADR-0018): because the agent signs every model call with
credentials tagged `TenantId`, AWS itself attributes model cost to the IAM
principal per tenant (CUR 2.0 `line_item_iam_principal`,
`iamPrincipal/TenantId`), so the bill is the source of truth for model cost;
the agent's final usage event (input and output tokens) stays as a
near-real-time cross-check in the ingress log line (and in the token metrics
when `perTenantMetrics` is on). The demo reads these figures with the
Contributor Insights rules of P-9, not with metrics (ADR-0021), and the README gives
the attribution formula, the two account-level billing options the deployer
must turn on for model cost, and the unattributable remainder (idle, fixed,
and per-request service fees below the metered unit). Only usage figures
leave the agent, never content (ADR-0017).

---

## 3. System shape

### 3.1 Components

| ID | Component | Notes |
|---|---|---|
| C-1 | **Backend: AgentCore Runtime** (the first backend, ADR-0011) | TypeScript agent, direct code deployment; IAM inbound auth; resource policy per P-1; `requireMMDSV2: true` (amended 2026-10-26: not exposed by `AWS::BedrockAgentCore::Runtime` in aws-cdk-lib 2.274.0, so left out until CloudFormation supports it; threat-model T-13); execution role grants logs and traces only, no model (ADR-0018); `requestHeaderAllowlist` always holds the credential header (ADR-0018) and holds the user-token header only when P-5 forwarding is on |
| C-2 | **Agent** | Echoes its unit id and a per-VM nonce and calls one Bedrock model; validates `prompt` is a string (Runtime best practices, input validation) |
| C-3a | **Ingress A: API Gateway** | Regional REST API, one `POST /invocations` route, Lambda request authoriser (JWT verify, P-3) and a Lambda proxy integration with `responseTransferMode: STREAM`. The integration Lambda chooses the unit (P-2) and calls `InvokeAgentRuntime` with SigV4, streaming the response back |
| C-3b | **Ingress B: AgentCore Gateway** | No protocol type; `CUSTOM_JWT` inbound authoriser on the tenant-identity pool; one Runtime target (`http.agentcoreRuntime`) with `GATEWAY_IAM_ROLE` outbound; a REQUEST interceptor Lambda that chooses the unit and overwrites the session header (P-2), and enforces P-5 |
| C-4 | **Demo app** | `src/main.ts`: reads tenant-identity's SSM parameters and instantiates the construct with one ingress |
| C-6 | **Unit module** | Shared by both ingress Lambdas: random unit id, or with `session` the claim-derived id (P-2) |
| C-7 | **TVM module** | Shared by both ingress Lambdas, always on (ADR-0018): validated claims to session tags, `AssumeRole` + `TagSession` on `tvm.role` or the default `TenantModelRole`, per-tag-set cache bounded by `tvm.cacheMaxEntries` with one STS call per tag set (ADR-0022), credential header (P-8) |
| C-5 | **Integration driver** | `scripts/integ.sh`: deploys tenant-identity (`shared-pool`), then this sample once per ingress, runs the e2e suite and the latency probe, destroys everything |

### 3.2 Caller and identity model

- A **tenant user** signs in to tenant-identity's shared pool and receives an
  access token with `tenant_id`, `sub`, `client_id`, and `scope`
  (`tenant-api/read tenant-api/write` un-narrowed).
- To downscope, the client exchanges its refresh token at tenant-identity
  `POST /oauth2/token` for a token holding only the scopes it needs
  (tenant-identity ADR-0009), and calls the ingress with that token.
- The **vendor** deploys the construct; no vendor call path into a session
  exists.

### 3.3 Deployment inputs (construct props)

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `identity.discoveryUrl` | string | required | OIDC discovery URL of the issuer |
| `identity.allowedClientIds` | string[] | required, non-empty | `client_id` values accepted |
| `agent` | `{ codePath, modelId, environment? }` | required | agent code and the one model it may invoke; `environment` (added 2026-10-26 at implementation: the demo agent needs its table name, and a construct cannot know a consumer's agent configuration) |
| `backend` | `'agentcore-runtime'` | `'agentcore-runtime'` | the session-isolating compute service (ADR-0011) |
| `ingress` | `'api-gateway' \| 'agentcore-gateway'` | required | C-3a or C-3b; `agentcore-gateway` is valid only with the `agentcore-runtime` backend |
| `session.scope` | `'user' \| 'tenant'` | none (session mapping off: fresh unit per request) | with `session` set, conversations persist in a unit derived from the claims; `'user'` if `scope` is omitted (P-2, ADR-0013) |
| `requiredScopes` | string[] | none | if set, the token's `scope` MUST contain all of them (ADR-0005) |
| `delegation.forwardUserToken` | boolean | `false` | P-5 |
| `delegation.requireNarrowedToken` | boolean | `false` | only valid with `forwardUserToken` |
| `delegation.allowedScopes` | string[] | required when `requireNarrowedToken` | P-5 |
| `tvm.role` | `iam.IRole` | none (construct creates a model-only role) | the TVM is always on (ADR-0018); unset, the construct creates `TenantModelRole` that may invoke only the one model; set, a role that also reaches tenant data, whose trust and ABAC the deployer owns and to which the construct adds the model grant (P-8, ADR-0012, ADR-0018) |
| `tvm.includeUserIdTag` | boolean | `false` | add `UserId = sub` as a session tag |
| `tvm.claimTags` | `Record<string, string>` | none | extra session tags, tag key to claim name; a claim missing from the token fails the request with 403; `TenantId` and `UserId` are reserved keys |
| `tvm.durationSeconds` | number | `900` | 900 to 3600; credential lifetime |
| `tvm.cacheMaxEntries` | number | `1000` | cached credential sets per ingress instance, one per tag set; least recently used evicted first (ADR-0022) |
| `tenantLimits` | `{ requestsPerMinute?, outputTokensPerMinute? } \| false` | on, `requestsPerMinute: 60` | per-tenant fixed-window limits shared by every ingress instance; over the limit is 429 before the TVM and the backend; `requestsPerMinute: 0` turns the request limit off; `false` creates no counter table (ADR-0020) |
| `tenantLimits.outputTokensPerMinute` | number | none (no token limit) | model output tokens per tenant per minute, counted after the stream ends; `api-gateway` only (ADR-0020) |
| `stageThrottle` | `{ rateLimit?, burstLimit? }` | `50` rps, burst `25` | the API Gateway stage throttle, shared by all tenants; `api-gateway` only; was hard-coded before ADR-0020 |
| `perTenantMetrics` | boolean | `false` | per-tenant CloudWatch metrics (EMF); on adds the synth warning `runtime-isolation:per-tenant-metrics-cost` (ADR-0021) |

Props are validated at synth; an invalid combination fails with the prop name.

**Amended 2026-10-28 (ADR-0024).** The construct is two parts; the one-backend
form is a `SharedIngress` with a `defaultBackend` plus one `AgentBackend` of
that name (the bare `/invocations` URL kept), with no separate wrapper
construct:

| Construct | Props | Meaning |
|---|---|---|
| `SharedIngress` | every ingress prop except `agent`, plus `registryPrefix` (default `/application-plane/shared/agent-runtime/`), `registryTtl` (`Duration`, default 60 s), `defaultBackend` (default none) | the ingress alone: API or Gateway, authoriser, TVM, limits, log drain, and the registry prefix it publishes under and reads `backends/<name>` from. `registryPrefix` is one per account and Region; set it when one account runs several ingresses. `defaultBackend` is the backend the bare `/invocations` route resolves to. `SharedIngress.fromParameters(scope, id, prefix, ingress)` imports an ingress deployed in another stack through its published parameters (§6.4); an `AgentBackend` in another stack must take the ingress this way, a `SharedIngress` instance from another stack fails synth. `registryTtl` is 1 s to 750 s |
| `AgentBackend` | `name` (`[a-z0-9-]{1,32}`), `ingress` (a `SharedIngress` or `fromParameters`), `agent` (`{ codePath, modelId, environment? }`), `requiredScopes?` | one backend: the Runtime tagged `ri:ingress = <ingressId>`, its resource policy naming the ingress role, on `agentcore-gateway` a Gateway target named `name`, and the registry entry `{ runtimeArn, requiredScopes, status }`. `requiredScopes` are required on top of the ingress-wide list, per route. On delete the entry is set to `draining`, held for `registryTtl` plus 120 s, then removed |

The ingress-wide `requiredScopes` stays the floor every token must meet.

### 3.4 Backend interface

A backend (ADR-0011) defines five things. Everything else in the construct is
backend-neutral.

| Concern | `agentcore-runtime` | A later backend supplies |
|---|---|---|
| Isolation unit (P-2) | one `runtimeSessionId`, one microVM | its own unit (function instance, container, session) |
| Invoke call | `InvokeAgentRuntime`, SigV4 | its own call |
| Who may invoke (P-1) | Runtime resource policy, ingress principal only | its own resource policy |
| Unit id transport (P-2) | `runtimeSessionId` | its own field |
| Credential and user-token transport (P-5, P-8) | allowlisted headers `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Credentials` (always, ADR-0018) and `...-Custom-User-Token` (on opt-in); the credentials header is base64 JSON, the user token is the raw JWT (amended 2026-10-27, ADR-0006, ADR-0012) | its own payload or context field, with V-7 repeated |

The ingress hands the backend a validated request (`tenant_id`, `sub`, the
chosen unit id, `prompt`, optional user token, the vended credentials); the
backend maps it onto these and never sees the bearer token's raw
`Authorization` value.

**Amended 2026-10-28 (ADR-0024).** "Who may invoke" splits into
two halves. The backend's `bindIngress` takes the ingress role ARN (from the
`SharedIngress` or its published `ingressRoleArn`) and writes only the
Runtime's resource policy, naming that one role (P-1 per Runtime). The
identity-side grant is the ingress's own: `InvokeAgentRuntime` on the
account's Runtime ARN pattern (`runtime/*` and `runtime/*/runtime-endpoint/*`)
conditioned on `aws:ResourceTag/ri:ingress = <ingressId>`, a tag the backend
sets in `CfnRuntime.tags` at creation (copied to the `DEFAULT` endpoint,
checked 2026-10-28). The resource policy remains the hard gate; the condition
narrows the identity grant to Runtimes registered behind this ingress. A
later backend supplies its own resource policy and its own tag-or-equivalent
condition for the pattern grant.

---

## 4. Data model

No stored entities (amended 2026-10-28: except the backend registry, below).
The only derived value is the unit id (P-2):

| Field | Source | Shape |
|---|---|---|
| random id (no `session`) | `s-` + base32 of 32 random bytes, generated per request at ingress | `s-[a-z2-7]{52}` |
| prefix (`session`) | `sha256(tenant_id "|" sub)` or `sha256(tenant_id)`, base32, first 26 chars | `[a-z2-7]{26}` |
| `conversationId` (`session`) | client, in the request body, on both ingresses | `[A-Za-z0-9]{16,64}` |
| `runtimeSessionId` | the random id, or `s-<prefix>-<conversationId>` | 45 to 93 chars (Runtime minimum is 33) |

Model cost per tenant is not stored by the sample: it is read from the bill
(ADR-0018). Because the agent signs the model call with a role session tagged
`TenantId`, AWS records the cost against `iamPrincipal/TenantId` in CUR 2.0;
the deployer activates that cost allocation tag and the CUR caller-identity
option (both account-level, README). The usage event's token figures are a
cross-check, read by the ingress and never stored.

**Amended 2026-10-28 (ADR-0024).** The backend registry is a
stored entity the construct now has: one SSM `String` parameter per backend
at `<registryPrefix>backends/<name>`, written by that backend's stack and
read by the ingress.

| Field | Shape | Meaning |
|---|---|---|
| `runtimeArn` | `arn:<partition>:bedrock-agentcore:<region>:<account>:runtime/<id>` | the Runtime the route invokes |
| `requiredScopes` | string[], may be empty | scopes required on top of the ingress-wide list |
| `status` | `active` or `draining` | `draining` refuses new requests (404) while running streams finish |

The entry is a JSON string, 4 KB on the standard tier, schema by convention
and validated at synth by `AgentBackend` and at read time by the ingress
(`src/shared/registry.ts`). The ingress caches it per process for
`registryTtl` and serves a stale entry while it refreshes; a name with no
entry is cached as a miss for the same TTL. Writes are last-write-wins and
eventually consistent; one writer per name is enforced by IAM, not by the
store. Tenant state is still not stored.

---

## 5. API surface

One operation, the same contract on both ingresses: `InvokeAgent`.

| | `api-gateway` | `agentcore-gateway` |
|---|---|---|
| URL | `POST https://<api>/prod/invocations` (a `defaultBackend`); `POST https://<api>/prod/<backend>/invocations` (amended 2026-10-28, ADR-0024) | `POST https://<gw>.gateway.bedrock-agentcore.<region>.amazonaws.com/<target>/invocations`, where the target is the backend name |
| Auth | `Authorization: Bearer <access token>` | same |
| Body | `{prompt}`; with `session`, `{conversationId, prompt}` | same |
| Unit | chosen by the integration Lambda | chosen by the interceptor, written to `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`; a client value is overwritten (V-3) |
| Response | `text/event-stream`, streamed | same |

Errors written by the ingress code, with fixed bodies (`src/shared/request.ts`):

| Status | Body | When |
|---|---|---|
| 400 | `bad request` | malformed `prompt`, malformed `conversationId`, or `conversationId` sent without `session` |
| 401 | `unauthorized` | missing or invalid token |
| 403 | `forbidden` | `tenant_id` absent, `tenants` claim present, required scope missing (ingress-wide, or the backend's `requiredScopes` from the registry, amended 2026-10-28, ADR-0024), narrowed-token rule failed, or a `tvm.claimTags` claim missing |
| 404 | `not found` | the backend name has no registry entry or its entry is `draining`; refused before the body is read (amended 2026-10-28, ADR-0024) |
| 429 | `too many requests` | the tenant is over its `tenantLimits`; checked before the TVM and the backend (ADR-0020) |
| 502 | `upstream error` | the backend invoke failed; the registry could not be read or its entry is malformed (amended 2026-10-28, ADR-0024) |

These bodies never echo the token, the unit id or the input. Refusals made by
the gateway itself use the gateway's own status and body. On `api-gateway`
the Lambda authoriser's Deny surfaces as 403, so a missing or invalid token
is 403 there, not 401; API Gateway's request validator (400) and stage
throttle (429) return API Gateway's JSON body (amended 2026-10-27, ADR-0015,
ADR-0020). Behind a `SharedIngress` the route is `POST /{backend}/invocations`
on both ingresses, one API Gateway resource and one Gateway; the backend name
is `[a-z0-9-]{1,32}`, resolved through the registry before the body is read.
An unknown or `draining` name refused by the API Gateway authoriser surfaces
as that 403; `agentcore-gateway` refuses a name it has no target for with the
Gateway's own status. The 403 for a missing backend scope follows the
ADR-0005 order: ingress-wide scopes first, then the backend's (amended
2026-10-28, ADR-0024).

---

## 6. Contracts

### 6.1 What the deployer supplies

- An OIDC issuer whose access tokens satisfy §6.2 (the sample uses
  tenant-identity `shared-pool`; its `userPoolId` and `appClientId` SSM
  parameters give the discovery URL and client id).
- An agent code bundle and a Bedrock model id enabled in the Region.
- Optionally `tvm.role` (the TVM itself is always on, ADR-0018): a tenant role that also
  reaches tenant data, whose trust policy allows `sts:AssumeRole` and
  `sts:TagSession` to `tvmCallerRole` only, requires the `TenantId` request
  tag, pins `aws:TagKeys` to the tags it expects, and whose permissions scope
  every data resource by `${aws:PrincipalTag/TenantId}` (ADR-0012). Without
  it the construct creates a role that may invoke only the one model
  (ADR-0018).

### 6.2 Token contract

Access token, RS256, with `iss`, `exp`, `client_id`, `token_use: "access"`,
`sub`, `tenant_id` (single string), and `scope` (space-separated). A token
without `tenant_id` or with a `tenants` claim is refused (single-tenant users
only, §1.2).

### 6.3 What the sample promises

- No principal other than the ingress can invoke the backend (integ step 3).
- Without `session`, no two requests share a unit, even from the same user
  (integ step 4a).
- With `session`, tenant A's valid token cannot land in tenant B's unit, nor
  user A1's in user A2's under `scope: 'user'` (integ steps 4b, 5).
- The user token reaches the agent only when forwarding is on, and only
  narrowed when `requireNarrowedToken` is on (integ steps 7, 8).
- The TVM is always on (ADR-0018): the agent's credentials are vended for
  the caller's `tenant_id`; a read of the caller's own tenant data succeeds and a
  read of another tenant's fails in IAM; the role cannot be assumed by the
  test runner's own credentials (integ step 8a).
- Both ingresses pass the same e2e suite; the README reports measured TTFB and
  total latency (p50, p95) and the per-request cost of each.
- With `tenantLimits`, a tenant over its limit gets 429 while another
  tenant is served (integ limits step, ADR-0020).
- `cdk destroy` plus the integration script's teardown leaves no stacks, log
  groups, or parameters with the sample's prefix. The Runtime creates its own
  log groups outside CloudFormation; the script deletes them after destroy
  and checks that none is recreated (amended 2026-10-27, ADR-0019).

### 6.4 Composition (standard §1.1)

**Consumes:** `tenant-identity`, topology `shared-pool`, through
`/application-plane/shared/identity/{userPoolId,appClientId}` (ADR-0004). Only
the demo app and the integration driver read them; the construct takes the
issuer as props.

**Published interface**, so a later sample (for example a data-layer sample
that adds tenant-scoped memory) can consume this one:

- Constructs `SharedIngress` and `AgentBackend`, exported from `src/index.ts`.
  The ingress exposes read-only `endpointUrl`, `ingressRole`, `tvmCallerRole`
  (the role that validates the token and assumes the tenant role: the
  integration Lambda or the interceptor Lambda) and `tenantRole` (the role
  every model call is signed by, the deployer's or the default model-only one,
  ADR-0018); a backend exposes `runtimeArn` and `executionRole`.
- Parameters, written by the demo stack under
  `/application-plane/shared/agent-runtime/`: `endpointUrl` (the ingress
  invocation URL), `runtimeArn`, and `ingress` (`api-gateway` or
  `agentcore-gateway`).

**Amended 2026-10-28 (ADR-0024).** `SharedIngress` and `AgentBackend` are the
exported constructs. `SharedIngress` publishes, under its `registryPrefix`:
`endpointUrl` (the ingress base URL without a route; a backend is at
`<endpointUrl>/<backend>/invocations`, and a `defaultBackend` makes the ingress
publish today's full invocation URL), `ingress`, `ingressRoleArn` (the role
every Runtime behind it trusts), `ingressId` (the `ri:ingress` tag value),
`tenantRoleArn`, and on `agentcore-gateway` `gatewayIdentifier`. Each
`AgentBackend` publishes its registry entry at `backends/<name>`.
`runtimeArn` stays, written by the one-backend demo stack, so today's
consumer contract does not break. `SharedIngress.fromParameters(scope, id,
prefix, ingress)` imports an ingress from those parameters (`ingress` names
the kind, decided at synth before a parameter can be read), so a backend
stack in the same account and Region needs only the prefix and no
CloudFormation dependency on the ingress stack; the deploy order (ingress first) is
documented and scripted. `SharedIngress` exposes `urlFor(name)`, the URL of
one backend's route.

---

## 7. Spike: behaviours to verify first

| ID | Behaviour | Fallback if it fails |
|---|---|---|
| V-1 | A Runtime resource policy that allows only one role denies SigV4 calls from another role in the same account | Add `aws:PrincipalArn` deny on the Runtime and its endpoint; if still open, stop: the pattern does not hold |
| V-2 | `AWS::BedrockAgentCore::GatewayTarget` accepts `TargetConfiguration.Http.AgentcoreRuntime` through `addPropertyOverride` (CDK L1 lacks it, aws-cdk#37999) | Custom resource calling `CreateGatewayTarget` (ADR-0010) |
| V-3 | A Gateway REQUEST interceptor sees `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` and can deny the request; whether it can overwrite it | Deny-only check is sufficient for P-2; if the interceptor cannot see the header, `agentcore-gateway` is dropped and ADR-0003 is superseded |
| V-4 | A REQUEST interceptor runs on a streaming Runtime invocation and the response still streams (docs say buffered only; field reports say request interceptors work) | Accept buffered responses on `agentcore-gateway` and report it in the latency table |
| V-5 | API Gateway REST `responseTransferMode: STREAM` with a Lambda proxy relays the Runtime's SSE stream past 29 s | Buffered response with a 29 s cap, documented |
| V-6 | Runtime `requestHeaderAllowlist` passes `X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Token` from both ingresses | Forward the token in the payload under a reserved key the agent strips; ADR records it |
| V-7 | A second allowlisted header of about 2 KB (base64 STS credentials) reaches the agent from both ingresses, and neither API Gateway access logs nor Gateway/interceptor logs record request header values | Split the credential across headers, or forward only a reference the agent redeems; if a log records headers and cannot be configured not to, the TVM is dropped on that ingress (ADR-0012) |

### 7.1 Spike results (2026-10-26, pg sandbox, eu-central-1)

Throwaway stack `RiacSpike` (Cognito, SigV4 Runtime with an echo agent, API
Gateway REST + streaming Lambda proxy, AgentCore Gateway + REQUEST
interceptor). Deployed, probed, destroyed; no fallback is needed.

| ID | Result | Evidence |
|---|---|---|
| V-1 | PASS | Admin role and a same-account role whose identity policy allows `InvokeAgentRuntime` both get `AccessDeniedException ... explicit deny in a resource-based policy`. A deny on the runtime ARN alone is enough; the endpoint needs no policy of its own. |
| V-2 | PASS | `addPropertyDeletionOverride('TargetConfiguration.Http.Connector')` plus `addPropertyOverride('TargetConfiguration.Http.AgentcoreRuntime', {Arn, Qualifier})` deploys; target `READY`. A placeholder `connector` must be deleted, or the merge keeps both keys. |
| V-3 | PASS | Interceptor sees the session header (and `Authorization`) with `passRequestHeaders: true`. A2 or B1 sending A1's session id: 403; no header: 403. Returning the header in `transformedGatewayRequest.headers` **overwrites** it: the Runtime received the interceptor's value, not the client's. |
| V-4 | PASS | With the REQUEST interceptor on, a 36 s SSE response streamed: TTFB 0.33 s, total 36.3 s, all 20 events. |
| V-5 | PASS, with a setting | With the integration timeout at 29 s the stream is cut at 29.1 s (15 of 20 events). With `timeout: Duration.minutes(2)` it streams the full 36 s, TTFB 0.25 s. STREAM mode allows up to 15 min; the construct must set it. |
| V-6 | PASS | The allowlisted header reaches the agent from both ingresses (Lambda via an SDK `build` middleware; Gateway via the interceptor's `transformedGatewayRequest.headers`). The Gateway does not pass the client's `Authorization` to a SigV4 Runtime. |

**V-7 (run separately, same day, same account):** PASS. Rebuilt the spike with
a `riacspike-tenant` role (trusts only the two token-validating Lambda roles,
requires `aws:RequestTag/TenantId`, `aws:TagKeys` pinned to `TenantId`,
`UserId`; `dynamodb:GetItem` with `dynamodb:LeadingKeys =
TENANT#${aws:PrincipalTag/TenantId}`), a table with one item per tenant, and
the credential header on the Runtime allowlist.

| Check | API Gateway | AgentCore Gateway |
|---|---|---|
| Credential header reaches the agent | yes, 1,240 bytes | yes, 1,240 bytes |
| Agent's caller identity | `assumed-role/riacspike-tenant/tenant-tenanta` | same |
| A1 reads tenant A (positive control) | item returned | item returned |
| A1 reads tenant B | `AccessDeniedException` from DynamoDB | same |
| B1 reads tenant A | not run | `AccessDeniedException` |
| Second call, same tenant | served from the Lambda's cache | same |
| Runner assumes the tenant role directly | `AccessDenied` | |

CloudTrail shows one `AssumeRole` on the tenant role per ingress Lambda per
tenant, not per request, plus the runner's denied attempt. After the run,
every log group on the path was pulled and searched for the access key prefix
`ASIA`, `secretAccessKey`, the base64 of `{"accessKeyId":`, the header name,
and a JWT prefix: API Gateway execution logs (INFO, data trace off) and the
JSON access log hold request ids, status, and timings only; the ingress and
interceptor Lambda logs hold header *names* only (by construction); the
Runtime log group's per-session, `otel-rt-logs`, and `spans` streams were
empty for this agent; AgentCore Gateway vends no log group. Zero hits.

Two things the construct must carry from this: `dataTraceEnabled` MUST stay
off on the API Gateway stage (data trace logs request headers), and the agent
and any OTEL instrumentation MUST not record request headers. Cold-start TTFB
with a fresh `AssumeRole` was 1.5 to 3.7 s; a cached credential added about
0.1 s.

Also seen: the same session id from both ingresses lands in the same microVM
(same per-VM nonce), and A2 using A1's `conversationId` gets a different
session and microVM. Single-call latencies were 0.2-0.3 s warm on both
ingresses; this is not the §8 step 9 measurement.

Follow-up for the design: because V-3 overwrite works, the `agentcore-gateway`
ingress chooses the unit itself, as API Gateway does (ADR-0002, decided
2026-10-26). Both ingresses share one request contract. The same overwrite
carries the random per-request id when `session` is off (ADR-0013).

---

## 8. Integration test outline

1. Deploy tenant-identity (`shared-pool`); create tenants A and B, users A1,
   A2, B1; issue tokens.
2. Deploy the sample with the chosen ingress.
3. Call `InvokeAgentRuntime` directly with the test runner's own
   credentials: denied (P-1). A second, non-ingress role is not exercised
   here; spike V-1 showed that such a role, with an identity policy that
   allows the call, is denied too (amended 2026-10-27, ADR-0001).
4a. `session` off: A1 sends a `conversationId` in the body: 400. A1 then
   sends two requests, the second with the first's unit id in the session
   header: two different units and two different nonces (P-2, ADR-0013). The
   same stack sends a model prompt signed by the default `TenantModelRole`
   (ADR-0018).
4b. `session` on: A1 opens conversation `c1`. A2 and B1 send `c1`, and also
   set the session header to A1's unit id: each lands in its own unit and
   microVM, never A1's (the agent returns its unit id and a per-VM nonce)
   (P-2).
5. `session` on: A1 resumes `c1`: same microVM (same nonce).
6. No token, a tampered token, an ID token: 401 or 403, by ingress (§5). A
   malformed `conversationId`: 400 or 403. Tokens with no `tenant_id`,
   expired, or from another client are covered by the verifier unit tests
   (`test/shared/verifier.test.ts`), not by the script (amended 2026-10-27,
   ADR-0015).
7. `requiredScopes` on: a token narrowed to `tenant-api/write` only is refused
   when `tenant-api/read` is required.
8. Forwarding on: the agent reports the forwarded token's `scope`; with
   `requireNarrowedToken`, an un-narrowed token is refused and a narrowed one
   accepted.
8a. TVM (always on): the demo table holds one item per tenant under
   `TENANT#<id>`. A1 asks the agent to read tenant A's item: success
   (positive control). A1 asks it to read tenant B's item, and B1 tenant A's:
   `AccessDeniedException` from IAM. The runner calls `sts:AssumeRole` on the
   tenant role with its own credentials: denied. The agent reports its
   caller ARN; the script prints a note, and does not fail, when the session
   name does not carry the tenant id. One `AssumeRole` per tenant per
   credential lifetime was shown in CloudTrail by spike V-7, not by this
   script (amended 2026-10-27, ADR-0012, ADR-0018).
8b. A model prompt ends with `event: usage` (P-10, ADR-0018). The
   `api-gateway` stack, with `perTenantMetrics` on, publishes tenant A's
   `ModelOutputTokens` and `BackendInvokeSeconds`; the `agentcore-gateway`
   stack, with it off, publishes no per-tenant metrics (ADR-0021).
Limits. On a stack with `requestsPerMinute: 5`, tenant A gets 429
   `too many requests` within the minute while tenant B is served (ADR-0020).
   The output-token limit is not in the script. It was checked by hand on
   2026-10-27 at 200 tokens per minute: tenant A was refused after 233
   tokens, tenant B was served, the log fields were top level, and the four
   Contributor Insights rules reported both tenants (ADR-0020, ADR-0021).
9. Latency probe: 20 invocations per ingress, TTFB and total, p50 and p95.
   Then `scripts/demo.sh` runs against the `api-gateway` stack.
9-registry. (added 2026-10-28, ADR-0024; green on both ingresses 2026-10-28) Each all-on stack carries a
   second backend, `billing`, with its own required scope. A tenant-A token
   narrowed to the ingress floor is 200 on the default backend and 403 on
   `/billing/invocations`; a token narrowed to the floor plus the billing
   scope is 200 on `billing`. `/nosuch/invocations` is refused: on
   `api-gateway` 403 (the authoriser's Deny) or 404, on `agentcore-gateway`
   the Gateway's own refusal of an unknown target. On `api-gateway` only, the
   script writes a registry entry `late` pointing at `billing`'s Runtime
   with no extra scopes and polls `/late/invocations` until 200 within 90 s
   (one `registryTtl` plus margin; the tag-conditioned grant reaches a
   Runtime the ingress deploy never named), sets it to `draining` and polls
   until refused within 90 s, then deletes the entry (also from the exit
   trap). The add-and-drain half is not run on `agentcore-gateway`, where a
   backend is also a Gateway target the registry alone cannot create.
10. Destroy; delete the Runtime's service-created log groups; assert no
   stacks, parameters or log groups are left (ADR-0019).

Steps 3 to 9 and 9-registry run on both all-on stacks (`api-gateway`, `agentcore-gateway`).
Step 4a, the narrowed-token case of step 8 and the limits step run on their
own stacks. All four stacks come from `test/integ.runtime.ts` and deploy
together.

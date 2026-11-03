<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Specification: Agentic Runtime Isolation (v2)

> **Status:** v2, Accepted 2026-11-02 (Dave Roberts). Supersedes the v1
> specification of 2026-10-26, kept as `agentic-runtime-isolation.spec.v1.md`.
> Not yet implemented: `architecture.md` still describes v1 until the v2
> integration test passes. ADR-0030 to ADR-0040 are Accepted. v1 promises
> that still hold are kept as they are; where v2 changes one, the text says
> so with "(v2, ADR-00NN)". The v1 amendment notes are folded into the text;
> their ADRs are still cited. Spikes V-8 to V-15 (§7) run before code.

The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

ADRs v2 adds:

| ADR | Title | Amends / supersedes |
|---|---|---|
| 0030 | Hold entitlements in an ingress-owned store, not in identity-provider scopes | amends ADR-0005; supersedes ADR-0025 |
| 0031 | Mint a transaction token at the ingress; the identity token never leaves it | supersedes ADR-0006, ADR-0007 |
| 0032 | Model an agent as a product: a backend plus the tools it may use, capped below the tenant's subscription | amends ADR-0011, ADR-0024 |
| 0033 | Let a tenant admin cut, never add, with sparse per-user rows | - |
| 0034 | Serve tools through one shared AgentCore Gateway that trusts the ingress issuer, with Policy on `scope` and an interceptor that checks `act` and signs the tenant context | - |
| 0035 | Register tools and agents at deploy with an owner marker, in the store and the registry | amends ADR-0024 |
| 0036 | Bound change lag by a version in the token cache key and a 5-minute token life | - |
| 0037 | Publish the ingress as an OIDC issuer: JWKS and discovery on the ingress, keys in KMS with `kid` rotation | - |
| 0038 | Accept users in several tenants; the request names one the verified token lists | amends ADR-0004 |
| 0039 | Default session mapping to the tenant scope when it is turned on | amends ADR-0013 |
| 0040 | Apply the spike findings to the tools gateway and the transaction token | amends ADR-0031, ADR-0034, ADR-0038 |


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

v2 widens the sample from the runtime to what the agent may do once it runs
(ADR-0030, ADR-0034). It now covers three things, all behind one shared
ingress:

1. **The isolated agent runtime.** The v1 design, unchanged in its promises.
2. **The tools the agent may call**, through one shared Amazon Bedrock
   AgentCore Gateway the vendor owns. Folded in from the tool-gateway
   feature review (`agentic-tool-gateway.review.md`), which no longer
   becomes a sample of its own.
3. **Entitlements**: which agents and tools a tenant has subscribed to,
   minus what a tenant admin has cut from a user, minus what the agent
   product itself does not need.

The model is pool throughout. The design targets 10,000s of tenants,
100,000s of tenant users, 100s of agents and 1,000s of tools (amended
2026-11-03). None of those counts may grow a policy, a Gateway, a role or a
token per tenant or per user (P-16). What grows with agents and tools is
bounded in §3.6 ("Scale at 100s of agents and 1,000s of tools").

v1 forwarded the user's identity token to the agent on opt-in, optionally
narrowed by an exchange at tenant-identity. v2 replaces that with a
**transaction token** the ingress mints for each call (ADR-0031). It names
one tenant, one user and one agent, carries exactly the granted set, lives
five minutes, and is useless outside this sample's trust domain. The
identity token never leaves the ingress.

The pattern is a core plus optional modules. The core is the trusted ingress,
the one-principal resource policy (P-1, P-3), the always-on token vending
machine (P-8, ADR-0018), and in v2 the entitlement check and the transaction
token (P-11, P-14). The modules below each add a check; the TVM, the
entitlement check and the transaction token are always on, per-tenant
limits and the tools gateway are on by default, and the rest are off by
default (P-4):

| Module | Adds | Default | Prop |
|---|---|---|---|
| Session mapping | conversations that persist across requests, in a unit derived from the caller's claims, so a user resumes only their own session (P-2, ADR-0002, ADR-0013) | off: a fresh unit per request. When set, `scope` is `'tenant'` (one conversation per tenant, v2, ADR-0039); `'user'` is the option | `session` |
| Scope floor | scopes every identity token must carry (AND, ADR-0005), for example `app/use` | off: no floor | `requiredScopes` on the ingress |
| TVM | tenant-scoped AWS credentials for the model call and the agent's data access (P-8, ADR-0018) | always on: model-only `TenantModelRole`, `TenantId` tag only, 900 s credentials, 1,000 cached sets | `tvm` |
| Per-tenant limits | requests per tenant per minute, and on `api-gateway` optionally output tokens; over the limit is 429 (ADR-0020) | on: 60 requests per tenant per minute, no token limit | `tenantLimits` |
| Per-tenant metrics | per-tenant CloudWatch metrics (EMF) (ADR-0021) | off: the ingress log line carries the same figures | `perTenantMetrics` |
| Entitlements (v2) | the grant rule decides the agent and the tool set per call (ADR-0030) | always on: one table per ingress, PITR on; admin scope `entitlements/admin` | `entitlements` |
| Transaction token (v2) | the only token the agent and the tools see (ADR-0031, ADR-0037) | always on: RS256, 300 s life, key generation 1 | `transactionToken` |
| Tools gateway (v2) | one MCP endpoint for every tool, Cedar policy on the token's `scope`, a signing interceptor, per-tenant rate limits (ADR-0034) | on: one Gateway, 10 requests per second per tenant, 60 s context life; `false` creates none | `toolsGateway` |

Removed in v2: the delegation module (`delegation.*`, superseded by the
transaction token, ADR-0031) and backend scope registration with
tenant-identity's catalogue (`ScopeRegistration`, C-8, ADR-0030).

Without session mapping every request runs in a fresh unit and nothing
carries over between requests: the strictest setting. With it, the sample
realises the "Runtime isolation with session mapping" pattern of
[Agentic AI delegation patterns](https://builder.aws.com/content/3HBLL1UuIpyzPENldeTfjYjvGQj/agentic-ai-delegation-patterns),
Figure 3.

The pattern is not tied to one service. The construct models the compute
service as a **backend**, a typed prop (ADR-0011). AgentCore Runtime is the
first and only backend built; AWS Lambda's microVMs are a candidate for a
later one. The sample ships as CDK constructs (standard §4.5): `SharedIngress`,
`AgentBackend`, and in v2 `ToolTarget`, `TokenSigner` and `EntitlementStore`.
The ingress is a deploy-time choice: an Amazon API Gateway REST API with
response streaming, or an AgentCore Gateway with a Runtime target. The
tenant-identity sample is the identity provider, topology `shared-pool` or,
in v2, `shared-pool-multi-tenant` (R-1, ADR-0038).

### Requirements (v2)

| ID | Requirement |
|---|---|
| R-1 | A tenant user may belong to several tenants. The identity token carries `tenants` (an array) and the request names one with `X-Tenant-Id`, or the token already carries one `tenant_id`. |
| R-2 | An agent is a product: an agent backend plus the list of tools it may use. |
| R-3 | Each tenant has its own list of subscribed agents and subscribed tools, given directly or through a plan. |
| R-4 | A tenant admin can take subscriptions away from individual users (cuts). A tenant admin can never add one. |
| R-5 | An agent may list tools the tenant has not subscribed to. Those tools are not granted. |
| R-6 | Least privilege. At the agent's ingress the caller's authority is narrowed to what this agent, for this tenant and this user, may do: the agent's own needs plus the tool permissions it may use, because the agent hands that token on to the tools gateway. |

### Research basis

The token design follows these sources. Each line is a paraphrase.

- IETF OAuth Transaction Tokens, draft-09
  (https://www.ietf.org/archive/id/draft-ietf-oauth-transaction-tokens-09.html):
  a short-lived signed token that carries the caller's identity and the
  call's context through the workloads of one trust domain; no refresh, and
  not usable outside the domain.
- RFC 8693, OAuth 2.0 Token Exchange
  (https://www.rfc-editor.org/rfc/rfc8693): the `act` claim names the party
  acting for the subject; a token can be exchanged for a narrower one.
- RFC 8707, Resource Indicators
  (https://www.rfc-editor.org/rfc/rfc8707): bind a token to the resource
  that will accept it, so it cannot be replayed elsewhere.
- MCP authorization specification
  (https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):
  an MCP server accepts only tokens issued for it, and must not pass a
  client's token through to an upstream API.
- AWS Prescriptive Guidance on tenant claims in JWTs (link to confirm at
  acceptance): keep tokens lean; reference a large claim set by a hash
  rather than embed it.
- Microsoft Entra Agent ID (link to confirm at acceptance): an agent acting
  for a user gets at most the user's permissions, never more.
- Google Cloud agent identity (link to confirm at acceptance): three
  identities are kept apart: the user, the agent, and the agent acting for
  the user.

### 1.1 Deployment model

**Pool**: one backend per agent, shared by every tenant; isolation per unit.
One tools gateway and one set of tool targets, shared by every tenant;
isolation per call. A unit is one request by default, or one conversation per
user or per tenant with `session` set.

| Layer | What isolates tenants |
|---|---|
| Who may invoke the backend | Backend resource policy: only the ingress principal (P-1) |
| Which tenant a request acts for | The verified identity token's `tenant_id`, or one tenant of its `tenants` named by `X-Tenant-Id` (P-3, v2) |
| Which agent and tools the caller may use | The grant rule over subscriptions, cuts and the agent product (P-11, P-12, P-13, v2) |
| Which unit a request lands in | Ingress chooses the unit: fresh per request, or derived from validated claims with `session` (P-2) |
| What the agent can reach | Execution role: logs and traces only; no model and no tenant data (P-6) |
| What model and tenant data the agent may reach | Always-on TVM: tenant-scoped credentials vended at ingress (P-8) |
| What the agent can do on the user's behalf | Transaction token: one tenant, one agent, the granted set, five minutes (P-5, P-14, v2) |
| Which tools the agent may call | Tools gateway: `CUSTOM_JWT` on the ingress issuer, Cedar policy on `scope`, interceptor rechecks (P-15, v2) |
| What tenant data a tool may reach | Signed tenant context, then the tool's own TVM with a `TenantId` session tag (P-15, v2) |

### 1.2 What this sample is NOT

- Not a backend catalogue. Only the AgentCore Runtime backend is built. A new
  backend is added only when it meets P-1 and P-2, proved by the same e2e
  suite (ADR-0011).
- Not a session-mapping sample only. Session mapping is one module; the
  construct is complete without it.
- Not an identity provider. It consumes identity tokens from tenant-identity
  (`shared-pool` or `shared-pool-multi-tenant`); any OIDC provider that
  issues the §6.2 identity token contract works. It is the issuer of the
  transaction token only, and that token is never accepted as an identity
  token (P-14).
- Not a general token service. The ingress mints transaction tokens for its
  own agents and its own tools gateway. It has no `/token` endpoint, no
  RFC 8693 exchange endpoint and no refresh tokens.
- Not a billing or plan-management product. It stores subscriptions, plans
  and cuts so it can enforce them. Pricing, invoicing and plan design are the
  vendor's.
- Not a data-layer sample. The TVM vends tenant-scoped credentials to the
  agent and, in v2, to each tool; what they unlock (memory, RAG stores) is
  the data layer (`ARCHITECTURE.md` §3.3). The demo ships one
  tenant-partitioned table only to prove the credentials work.
- (v2, R-1, ADR-0038) The v1 line "Not multi-tenant-per-user" is withdrawn. A
  user may belong to several tenants (R-1). A single request still acts for
  exactly one.
- (v2, ADR-0034) The v1 line "Not a tool gateway" is withdrawn. The sample
  now owns one shared tools gateway. AgentCore Gateway is still not used as
  an aggregator of third-party MCP servers the vendor does not register as
  `ToolTarget`s.
- Not a model gateway. Inference targets and model routing on AgentCore
  Gateway are out of scope (review §2 item 9).
- Not a Gateway per tenant. One tools gateway for every tenant (review §4).
- Not cross-Region. One tools gateway per Region.
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
for `session.scope: 'user'`, and `sha256(tenant_id)` for `'tenant'`, the
default when `session` is set (v2, ADR-0039).
`conversationId` is client-chosen (16 to 64 of `[A-Za-z0-9]`), but the prefix
comes only from the verified token. In both cases a unit id sent by the
client is ignored and overwritten (ADR-0002, ADR-0013). (v2, R-1, ADR-0038)
`tenant_id` here is the tenant the request acts for, chosen under P-3, so a
user in two tenants has two disjoint sets of sessions.

**P-3. Tenant context comes only from the validated identity token.**
`tenant_id` and `sub` are read from a token whose signature, issuer, client,
expiry, and `token_use: access` were checked at ingress. Nothing in the body
or query names a tenant. (v2, R-1, ADR-0038) A token may instead carry `tenants`,
the list of tenants the user belongs to. The request then MUST name one with
`X-Tenant-Id`, and the ingress MUST refuse a value that is not in the
verified list. The header selects among tenants the token already names; it
can never add one.

**P-4. Every module is typed, with a secure default.** Session mapping, the
scope floor and per-tenant metrics are off by default. The TVM is always on
(ADR-0018). Per-tenant limits are on by default, at 60 requests per tenant
per minute (ADR-0020). Turning a module on adds a check; none removes one.
(v2) Entitlements and the transaction token are always on (ADR-0030,
ADR-0031): there is no setting under which an agent sees the identity token
or more than the granted set. The tools gateway is on by default
(ADR-0034); `toolsGateway: false` creates none, and then any `AgentBackend`
with a non-empty `tools` fails synth.

**P-5. A delegated token is the narrowest token that works, in a header the
agent asked for.** (v2, ADR-0031) The agent receives the transaction token,
never the identity token, in
`X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token`, never in
`Authorization` (which carries SigV4 to the Runtime). Narrowing is no longer
the client's job (v1 ADR-0007: present a narrowed bearer): the ingress
computes the narrowest set itself (P-11) and signs it. The v1 header
`...-Custom-User-Token` and the props `delegation.forwardUserToken`,
`delegation.requireNarrowedToken` and `delegation.allowedScopes` are removed.

**P-6. The agent's own role cannot cross tenants because it holds nothing
tenant-scoped, and holds no model permission either.** The execution role
grants logs and traces only; it has no data permission and, since ADR-0018,
no `bedrock:Invoke*`. The agent invokes the model with the vended tenant
credentials (P-8). (v2) It holds no permission on the tools gateway either:
the gateway's inbound authoriser is the transaction token, not IAM.

**P-7. Security first, then latency, then cost.** Both ingress options MUST
meet P-1 to P-6 and, in v2, P-11 to P-15 identically. They are compared on
measured latency and per-request cost (ADR-0009). The README recommends
`api-gateway` as the default: both ingresses stream, and `api-gateway` had
the lower TTFB, p50 0.198 s against 0.274 s (2026-10-27, eu-central-1;
ADR-0029). (v2) The mint adds one KMS `Sign` per cache miss on both
ingresses; spike V-12 measures it.

**P-8. Tenant data and the model are reached only with credentials vended
from the validated token, never from the agent's own role.** The TVM is
always on (ADR-0018). The ingress assumes a tenant role with session tags
built from the claims it has just verified (`TenantId` always; `UserId` and
allowlisted claims on opt-in) and forwards the credentials to the backend
(§3.4; ADR-0011, ADR-0012). A data-bearing role's policy scopes data by
`${aws:PrincipalTag/TenantId}`, so a cross-tenant call fails in IAM whatever
the agent does. (v2, ADR-0034) A tool reaches tenant data the same way, with
credentials its own TVM vends from the signed tenant context (P-15).

**P-9. Every request is attributable to a tenant in telemetry.** The ingress
writes the verified `tenant_id` (and the session prefix, never a token) as a
top-level field of one structured log line per request (ADR-0021). On
`api-gateway` it is `request served`; on `agentcore-gateway` the interceptor
writes `request admitted`. (v2) The line also carries `agent`, `txn` (the
transaction token's id), `grantSize` (entries in `scope`) and `mint`
(`hit` or `miss`). The tools gateway interceptor writes `tool admitted` with
`tenantId`, `sub`, `agent`, `txn`, `target`, `tool` and `decision`, and each
tool writes `tool served` with `tenantId`, `txn`, duration and bytes. `txn`
joins one agent request to every tool call it made.

**P-10. Every request's cost is attributable to its tenant.** The ingress
meters, per tenant, what each billed service charges for: ingress requests,
ingress compute milliseconds, backend invocation seconds and streamed bytes
(backend seconds, bytes and tokens on `api-gateway` only, ADR-0021). Model
cost is read from the bill: the agent signs every model call with
credentials tagged `TenantId`, so CUR 2.0 attributes it per tenant
(ADR-0018). (v2) Tool calls are metered per tenant from the `tool admitted`
and `tool served` lines: Gateway calls, Policy evaluations, interceptor and
tool Lambda milliseconds, KMS `Sign` calls (one per mint miss, one per tool
call). Only usage figures leave the agent, never content (ADR-0017).

**P-11. The authority an agent holds is computed at the ingress, per agent,
tenant and user, and is never more than the grant rule allows.** (v2,
ADR-0030, ADR-0032) The ingress evaluates the rule below on every request and mints
exactly its result. The client cannot ask for more and does not need to ask
for less. Rules out: forwarding the user's full scope set to the agent;
asking the agent to drop scopes it does not need; computing the grant in
the agent.

```
T(tenant)        = tenant.agents ∪ plan.agents, tenant.tools ∪ plan.tools     (subscriptions)
U(tenant, user)  = T minus the admin's cuts                                   (sparse: a row exists only when cut)
A(agent)         = agent.needs, agent.tools                                   (product definition, registered at deploy)

granted(agent, tenant, user) = A.needs ∪ (A.tools ∩ T.tools ∩ U.tools)
                               only if agent ∈ T.agents ∩ U.agents, else 403
```

**P-12. A tenant's entitlement is its subscriptions; a tenant admin can only
subtract.** (v2, ADR-0033) Subscriptions are written by the vendor, directly
or through a plan. A tenant admin writes cuts, and a cut row has no field
that adds an agent or a tool. A user with no cut row holds the tenant's full
set. Rules out: per-user grants; an admin role that edits the tenant's
subscriptions.

**P-13. An agent product declares what it needs and which tools it may use;
nothing else is ever granted through it.** (v2, ADR-0032,
ADR-0035) `needs` are the
agent's own actions (`<agent>/<action>`), granted whenever the agent is.
`tools` are the tools the agent may call; a tool the agent does not list is
not granted even when the tenant subscribes to it, and a tool the agent
lists but the tenant has not subscribed to is not granted either (R-5). The
definition is registered by the agent's own stack at deploy.

**P-14. The identity token never leaves the ingress. Everything downstream
sees only a transaction token the ingress minted.** (v2, ADR-0031,
ADR-0037) The transaction token is signed by a KMS key the ingress alone may
use, names exactly one tenant, one user and one agent, is bound by `aud` to
that agent and the tools gateway, lives 300 s by default, comes with no
refresh token, and is refused by the ingress as an identity token. Rules
out: forwarding the identity token; a token exchange at tenant-identity per
request; tokens that outlive a conversation turn.

P-14 does not rule out AgentCore Identity at the tools gateway or in the
agent; it changes which token AgentCore Identity sees. Outbound auth per
target still works, keyed on the transaction token: 3LO (authorization
code) stores the user's third-party grant in the token vault under the
inbound token's `sub` and issuer, and `sub` is the same tenant-identity
user id in every transaction token, so the grant survives across tokens;
OBO token exchange (RFC 8693 or RFC 7523) sends the inbound token as the
subject token, so the third-party authorisation server MUST trust the
ingress issuer (its discovery URL and JWKS, ADR-0037), not tenant-identity;
M2M (client credentials) and API key are vendor-shared and unaffected. What
P-14 does rule out is an OBO exchange that needs the tenant-identity token
itself as the subject token. The same holds for `GetWorkloadAccessTokenForJWT`
inside the agent: the JWT it presents is the transaction token, so the
workload identity's allowed issuer is the ingress. Spike V-15 verifies both.

**P-15. A tool learns its tenant only from a context signed for this call,
and reaches tenant data only through its own TVM.** (v2, ADR-0034) The tools
gateway interceptor derives the tenant from the transaction token it has
verified, signs `{tenant_id, sub, agent, tool, argsHash, exp}` with a second
KMS key, and writes it into a reserved argument, overwriting anything the
client sent. The tool verifies the signature, the tool name and the
arguments hash, then assumes its tenant role with `TenantId` from the
context. A tool with no valid context has no credentials: its own role
reaches no tenant data. Rules out: tenant id as a plain argument;
credentials in the request body.

**P-16. Entitlement cardinality lives in data, never in policy, roles or
Gateways.** (v2, ADR-0030, ADR-0034) The Gateway holds one Cedar policy per
target (O(targets)), the ingress one role and one key, the table one row per
tenant, plan, agent name, tool and cut. Adding a tenant or a user adds rows,
never a deploy. The token carries the granted set compressed per target
(`crm/*` when the whole target is granted), so its size grows with the
agent's tool list, not with the tenant's.

---

## 3. System shape

### 3.1 Components

| ID | Component | Notes |
|---|---|---|
| C-1 | **Backend: AgentCore Runtime** (ADR-0011) | TypeScript agent, direct code deployment; IAM inbound auth; resource policy per P-1; `requireMMDSV2` deferred until CloudFormation exposes it (ADR-0026, threat model T-13); execution role grants logs and traces only (ADR-0018). (v2) `requestHeaderAllowlist` always holds the credentials header and the transaction-token header, and never the v1 user-token header |
| C-2 | **Agent** | Echoes its unit id and a per-VM nonce and calls one Bedrock model; validates `prompt` is a string. (v2) Reports the transaction token's claims (`tenant_id`, `agent`, `scope`, `aud`, `act.sub`, `exp`), never the token. A prompt `tool <target>/<tool> <json>` makes it call that tool through the tools gateway with the transaction token as bearer, and `tools` makes it call `tools/list`; it returns the result or the error code |
| C-3a | **Ingress A: API Gateway** | Regional REST API, `POST /invocations` (with a `defaultBackend`) and `POST /{backend}/invocations`, a Lambda request authoriser and a Lambda proxy integration with `responseTransferMode: STREAM` and a 2 min timeout. (v2) The authoriser also selects the tenant (P-3), evaluates the grant rule (P-11) and mints the transaction token (P-14); the integration Lambda forwards it. The same REST API carries the JWKS and discovery routes (C-13) and the entitlement API (C-14) |
| C-3b | **Ingress B: AgentCore Gateway** | `CUSTOM_JWT` on the identity issuer, one Runtime target per `AgentBackend`, `GATEWAY_IAM_ROLE` outbound, a REQUEST interceptor that chooses the unit and overwrites the session header (P-2). (v2) The interceptor also selects the tenant, evaluates the grant rule and mints the token, and writes the token header in `transformedGatewayRequest.headers`. JWKS, discovery and the entitlement API live on a small REST API the construct creates beside it (C-13, C-14) |
| C-4 | **Demo app** | `src/main.ts`: a `SharedIngress` with `defaultBackend: 'default'`, its `AgentBackend`, plus a `billing` backend with `billingBackend=true`. (v2) Also `ToolTarget`s `crm` and `invoices` (Lambda), a plan `standard` and the demo tenants' subscriptions, written by the integration driver, not the stack |
| C-5 | **Integration driver** | `scripts/integ.sh`: deploys or reuses tenant-identity, deploys this sample's stacks, runs the e2e suite and the latency probe, destroys everything (ADR-0019). (v2) No longer checks `/platform/scopes` for backend scopes; registers the vendor application scopes `app/use` and `entitlements/admin` once (§6.4) |
| C-6 | **Unit module** | Shared by both ingress Lambdas: random unit id, or with `session` the claim-derived id (P-2) |
| C-7 | **TVM module** | Shared by both ingress Lambdas and, in v2, by the tool-side library: claims to session tags, `AssumeRole` + `TagSession`, bounded per-tag-set cache with one STS call per tag set (ADR-0022) |
| C-8 | ~~Scope registration~~ | (v2, ADR-0030) Removed. A backend no longer registers scopes with tenant-identity's catalogue. Its needs and tools are data in its own registry entry |
| C-9 | **Registry entry** (`RegistryEntryResource`, ADR-0024) | One per `AgentBackend`: writes `<registryPrefix>backends/<name>`; on delete sets it to `draining`, holds it, then removes it (§4). (v2) The entry carries `needs`, `tools` and `version` instead of `scopes` |
| C-10 | **Tenant limits table** (`TenantLimits`, ADR-0020) | Per-tenant fixed-window counters, `UpdateItem` only |
| C-11 | **Log drain** (`LogDrain`, ADR-0019) | Waits between writers and their log groups on delete |
| C-12 | **Entitlement store** (`EntitlementStore`, DynamoDB, v2, ADR-0030) | One table per `SharedIngress`, single-table design: tenant subscriptions, user cuts, plans, the tool catalogue and name reservations (§4). On-demand, PITR on, no TTL, AWS-owned encryption. The agent definition is not here: it stays in the SSM registry entry `backends/<name>` (fields `needs` and `tools` replace `scopes`), so one writer owns one record and the ingress reads one cache |
| C-13 | **Token signer** (`TokenSigner`, v2, ADR-0037) | One KMS asymmetric key, `SIGN_VERIFY`, `RSA_2048` (`RS256`, default) or `ECC_NIST_P256` (`ES256`). `kms:Sign` per mint, granted to the minting role alone; public key fetched once per process with `GetPublicKey` and cached. Two unauthenticated `GET` routes: `<baseUrl>/.well-known/jwks.json` and `<baseUrl>/.well-known/openid-configuration`, answered by a mock integration with the JWKS rendered at deploy, `Cache-Control: max-age=300`. `kid` is the KMS key id. During rotation the JWKS lists two keys (§6.2.3) |
| C-14 | **Entitlement API** (v2, ADR-0030) | Smithy model, `aws.protocols#restJson1`, on the ingress REST API (or C-13's REST API on `agentcore-gateway`). Vendor operations under IAM (SigV4); tenant-admin operations under the identity token with scope `entitlements/admin`. Operations in §5.3. Lifecycle verbs only (standard §4.2) |
| C-15 | **Tools gateway** (v2, ADR-0034) | One AgentCore Gateway, protocol MCP; `CUSTOM_JWT` with `discoveryUrl` = the ingress's discovery URL and `allowedAudience: ['tools-gateway']`; AgentCore Policy (Cedar), default deny, one generated policy per target on the `scope` claim; one REQUEST interceptor (C-15a); native per-tenant rate limits keyed on `$.context.jwt.tenant_id`; a second KMS key, `ToolContextKey`, for the tenant context. Detail in §3.6 |
| C-15a | **Tools interceptor** (v2) | Lambda, provisioned concurrency (`toolsGateway.interceptorProvisionedConcurrency`, default 1). Re-verifies the transaction token against the JWKS, requires `typ`, `iss`, `aud`, `act` and `exp`, checks the tool against `scope` again, signs the tenant context into the reserved argument `_ri_ctx`, writes `tool admitted`. On `tools/list` it only verifies and logs |
| C-15b | **Tool-side library** (v2, `src/tools/context.ts`) | Verifies `_ri_ctx` with the cached public half of `ToolContextKey`, checks `tool`, `argsHash` and `exp`, strips the argument, runs the TVM (C-7) with `TenantId` from the context, writes `tool served`. Exported from `src/index.ts` for tool authors |
| C-16 | **Tool target** (`ToolTarget`, v2, ADR-0035) | One per tool group: a Gateway target of kind `lambda`, `openApi`, `smithy` or `mcpServer`; catalogue rows `TOOL#<target>` for each tool and a `NAME#<target>` reservation, both with an owner marker as ADR-0025 did; the target's Cedar policy; a no-op `UpdatePolicy` touch after the target syncs, for the known defect that denies tools added after a policy was written; the registry pointer `tools/<target>` |
| C-17 | **Agent product** (`AgentBackend`, v2, ADR-0032) | The class keeps the name `AgentBackend`. The prop `scopes` is renamed `needs` (breaking, v2), and a new prop `tools` lists the tools the agent may use. The backend also reserves `NAME#<name>` in the entitlement store, so an agent and a tool target can never share an owner name |

### 3.2 Caller and identity model

- A **tenant user** signs in to tenant-identity and receives an identity
  token (an access token) with `sub`, `client_id`, `scope` and either
  `tenant_id` (`shared-pool`) or `tenants` (`shared-pool-multi-tenant`).
  (v2) `scope` holds the application floor only (for example `app/use`,
  and `entitlements/admin` for a tenant admin). It holds no agent and no
  tool names; those come from the entitlement store (ADR-0030).
- The client calls the ingress with the identity token as bearer and, when
  the token carries `tenants`, `X-Tenant-Id: <tenantId>`. No token exchange
  happens before the call (v2, ADR-0031).
- The **ingress** is the issuer of the transaction token. Its role ARN is the
  `act.sub` of every token it mints.
- The **agent** is a holder of the transaction token. It presents it as
  bearer to the tools gateway and to nothing else. It may verify it with the
  published JWKS; it does not need to, because only the ingress can set the
  header (P-1).
- The **tools gateway** is a relying party of the transaction token alone.
  It never sees an identity token: a Cognito-issued token fails its issuer
  check.
- A **tool** is a relying party of the signed tenant context alone. It never
  sees either token.
- A **tenant admin** calls the tenant-admin operations of the entitlement
  API with their identity token, scope `entitlements/admin`, for the tenant
  the token names (or `X-Tenant-Id` selects).
- The **vendor** calls the vendor operations of the entitlement API with
  SigV4 (the control plane's tenant create script is the intended caller,
  `ARCHITECTURE.md` §5.2), deploys the constructs, and has no call path into
  a session.

### 3.3 Deployment inputs (construct props)

`SharedIngress` props. Props are validated at synth; an invalid combination
fails with the prop name.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `identity.discoveryUrl` | string | required | OIDC discovery URL of the identity issuer |
| `identity.allowedClientIds` | string[] | required, non-empty | `client_id` values accepted |
| `identity.multiTenant` | boolean | `false` | (v2, R-1, ADR-0038) accept tokens that carry `tenants`; off, such a token is refused as in v1 |
| `backend` | `'agentcore-runtime'` | `'agentcore-runtime'` | ADR-0011 |
| `ingress` | `'api-gateway' \| 'agentcore-gateway'` | required | C-3a or C-3b |
| `session.scope` | `'tenant' \| 'user'` | `'tenant'` when `session` is set; no session mapping when `session` is absent | (v2, ADR-0039) P-2, ADR-0013 |
| `requiredScopes` | string[] | none | the floor: every identity token MUST carry all of them (ADR-0005), for example `['app/use']` |
| `tvm.role`, `tvm.includeUserIdTag`, `tvm.claimTags`, `tvm.durationSeconds`, `tvm.cacheMaxEntries` | as v1 | as v1 | P-8, ADR-0012, ADR-0018, ADR-0022 |
| `tenantLimits` | `{ requestsPerMinute?, outputTokensPerMinute? } \| false` | `requestsPerMinute: 60` | ADR-0020; keyed on the selected tenant (v2) |
| `stageThrottle` | `{ rateLimit?, burstLimit? }` | 50 rps, burst 25 | `api-gateway` only |
| `perTenantMetrics` | boolean | `false` | ADR-0021 |
| `registryPrefix` | string | `/application-plane/shared/agent-runtime/` | ADR-0024 |
| `registryTtl` | `Duration` | 60 s | cache life of registry entries, plans and the tool catalogue, 1 s to 750 s |
| `defaultBackend` | string | none | backend for the bare `/invocations` route |
| `transactionToken.ttl` | `Duration` | 300 s | (v2) `exp - iat`; 60 s to 900 s |
| `transactionToken.cacheMaxEntries` | number | 1000 | (v2) minted tokens kept per ingress instance, LRU |
| `transactionToken.algorithm` | `'RS256' \| 'ES256'` | `'RS256'` | (v2) key spec of C-13; `ES256` only after V-8 shows the Gateway accepts it |
| `transactionToken.keyGeneration` | number | 1 | (v2) bump to rotate: a new key signs, the previous stays in the JWKS (§6.2.3) |
| `entitlements.adminScope` | string | `'entitlements/admin'` | (v2) identity-token scope the tenant-admin operations require |
| `entitlements.maxAgentsPerTenant` | number | 1000 | (v2) bound on `agents` entries in a tenant or plan row (amended 2026-11-03) |
| `entitlements.maxToolsPerTenant` | number | 1000 | (v2) bound on `tools` entries in a tenant or plan row; a `<target>/*` entry counts once, so a tenant subscribed to whole targets holds 1,000s of tools in 10s of entries |
| `toolsGateway` | object `\| false` | on | (v2, ADR-0034) `false` creates no tools gateway |
| `toolsGateway.tenantRateLimit` | `{ requestsPerSecond: number }` | `{ requestsPerSecond: 10 }` | (v2) native limit, one bucket per `tenant_id` (`*` entry) |
| `toolsGateway.tenantRateLimitOverrides` | `Record<string, number>` | none | (v2) named tenants with their own rate, at most 1,000 |
| `toolsGateway.interceptorProvisionedConcurrency` | number | 1 | (v2) on C-15a |
| `toolsGateway.contextLifetime` | `Duration` | 60 s | (v2) `exp` of the signed tenant context |

Removed (v2, ADR-0031): `delegation.forwardUserToken`,
`delegation.requireNarrowedToken`, `delegation.allowedScopes`. Synth fails
with `delegation is removed in v2; the agent receives a transaction token
(ADR-0031)` when any is set. The v1 limitation that a static
`allowedScopes` list forced an ingress redeploy per backend goes with them.

Constructs:

| Construct | Props | Meaning |
|---|---|---|
| `SharedIngress` | the table above | the ingress: API or Gateway, authoriser, TVM, limits, log drain, entitlement store, token signer, entitlement API and, unless `toolsGateway: false`, the tools gateway. `SharedIngress.fromParameters(scope, id, prefix, ingress)` returns a `SharedIngressRef` read from the published parameters (§6.4); the v1 option `{ forwardUserToken? }` is removed (v2) |
| `AgentBackend` | `name` (`[a-z0-9-]{1,32}`), `ingress`, `agent` (`{ codePath, modelId, environment? }`), `needs` (required, v2), `tools` (default `[]`, v2), `owner?` (default `<StackId>#<LogicalResourceId>`; was `scopeOwner`) | one agent product: the Runtime tagged `ri:ingress = <ingressId>`, its resource policy naming the ingress role, on `agentcore-gateway` a Gateway target named `name`, the `NAME#<name>` reservation and the registry entry `{ runtimeArn, needs, tools, status, version }`. The agent's environment receives `RI_TOOLS_GATEWAY_URL` and `RI_ISSUER` (v2). The props `scopes`, `identityApi` and `scopeOwner` are removed (v2, ADR-0032): synth fails naming `scopes` with `renamed to needs in v2` |
| `ToolTarget` | `name` (`[a-z0-9-]{1,32}`), `ingress`, `kind` (`'lambda' \| 'openApi' \| 'smithy' \| 'mcpServer'`), `tools` (`{ name, description, inputSchema }[]` for `lambda`; read from the spec for the others), `function?` (`lambda`), `spec?` (`openApi`, `smithy`), `endpoint?` (`mcpServer`), `outboundAuth?`, `tvm?` (`{ role }`, the tool's tenant role), `owner?` | (v2, ADR-0035) one Gateway target and its catalogue rows, policy and registry pointer (§3.6) |
| `TokenSigner` | `algorithm`, `keyGeneration`, `signer` (the role allowed `kms:Sign`); method `grantSign(grantee)` for a second minting principal, used by the integration stacks only | (v2) C-13; created by `SharedIngress`, exported for a consumer that builds its own ingress |
| `EntitlementStore` | `maxAgentsPerTenant`, `maxToolsPerTenant` | (v2) C-12; created by `SharedIngress`, exported for the same reason |

**Agent product names (v2, ADR-0032).** `needs` is a non-empty list of
`<name>/<action>`, where `<name>` is the backend's own name, both sides
`[a-z0-9-]`, 3 to 128 characters in all. `tools` is a list of
`<target>/<tool>` or `<target>/*`, at most 64 entries, no duplicates; a
target named in `tools` need not exist at deploy (it is granted only once it
does and the tenant subscribes). An agent name and a tool target name share
one namespace: each stack reserves `NAME#<name>` in the entitlement store
with a conditional put, and a name held by another owner fails the deploy
with `name <name> already registered by another stack`, as ADR-0025's
scope claim did.

### 3.4 Backend interface

A backend (ADR-0011) defines five things. Everything else in the construct is
backend-neutral.

| Concern | `agentcore-runtime` | A later backend supplies |
|---|---|---|
| Isolation unit (P-2) | one `runtimeSessionId`, one microVM | its own unit |
| Invoke call | `InvokeAgentRuntime`, SigV4 | its own call |
| Who may invoke (P-1) | Runtime resource policy, ingress principal only | its own resource policy |
| Unit id transport (P-2) | `runtimeSessionId` | its own field |
| Credential and token transport (P-5, P-8) | allowlisted headers `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Credentials` (base64 JSON, ADR-0018) and, (v2, ADR-0031), `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token` (the raw JWT), both always | its own payload or context field, with V-13 repeated |

The ingress hands the backend a validated request (`tenant_id`, `sub`, the
chosen unit id, `prompt`, the vended credentials and, in v2, the transaction
token). The backend never sees the identity token (v2; in v1 it could, on
opt-in).

"Who may invoke" has two halves (ADR-0024). `bindIngress` writes only the
Runtime's resource policy, naming the ingress role. The identity-side grant
is the ingress's own: `InvokeAgentRuntime` on the account's Runtime ARN
pattern, conditioned on `aws:ResourceTag/ri:ingress = <ingressId>`.

### 3.5 Tool target interface (v2, ADR-0034, ADR-0035)

A tool target is what `ToolTarget` registers behind the tools gateway. It
defines:

| Concern | `lambda` | `openApi` / `smithy` | `mcpServer` |
|---|---|---|---|
| Tool names | `tools[].name`, `[a-z0-9_]{1,64}` | operation ids from the spec | the server's `tools/list` at sync |
| Who may invoke | function resource policy: the Gateway role only | the API's own auth (outbound) | the server's own auth (outbound) |
| Tenant context | `_ri_ctx` argument, verified by C-15b | `_ri_ctx` as a request field if the spec declares it (V-10); otherwise none | `_ri_ctx` argument, verified by C-15b in the server |
| Tenant data | tool's TVM, `TenantId` tag (P-15) | the third party's: per user with 3LO, vendor-shared with 2LO or an API key | tool's TVM, as `lambda` |
| Isolation style | enforced | enforced with 3LO; **filtered** with 2LO or an API key, said in the README | enforced |

Catalogue names are `<target>/<tool>`. The Gateway's own tool name is
`<target>___<tool>`; the interceptor and the policy translate between the
two. A target has at most 1,000 tools; a Gateway at most 100 targets, so
one Gateway holds up to 100,000 tools on count alone (§3.6).

### 3.6 Request path and tools gateway detail (v2)

**Amended 2026-11-02 (ADR-0040, spike V-11).** The REQUEST interceptor runs
before Policy, so it is the first wall: it refuses an ungranted tool and
logs the refusal with the tenant, and signs `_ri_ctx` only for an admitted
call. Policy is the second wall and the native `tools/list` filter.
`ToolTarget` deletes its policy before its target and creates policies one
at a time; a tools gateway holds at most 100 targets; Gateway application
logs are off by default.

```
client ──identity token (+ X-Tenant-Id when tenants[])──▶ ingress authoriser
   verify identity token (v1 checks); pick tenant; 403 if not in tenants[]
   per-tenant limit (v1)                                                  ──▶ 429
   read TENANT row, USER cut row (often a miss), AGENT def (registry cache)
   granted = rule; agent ∉ T∩U ──▶ 403 agent_not_subscribed
   mint transaction token (KMS Sign); cache per (tenant, sub, agent, tenant.version) for its life
   TVM (v1): tenant credentials
──▶ ingress Lambda: InvokeAgentRuntime, headers: credentials (v1) + transaction token
──▶ agent: reads scope from the transaction token; calls tools gateway with it as bearer
──▶ tools gateway: CUSTOM_JWT (ingress issuer) ──▶ interceptor (typ, act, aud, scope; refuse or sign context; log) ──▶ Policy (scope; tools/list filter)
──▶ tool: verify context ──▶ TVM TenantId ──▶ data
```

On `agentcore-gateway` the first two boxes are one REQUEST interceptor, as
in v1.

**Reads per request.** One `BatchGetItem` (eventually consistent) for
`TENANT#<id>` / `#SUB` and `TENANT#<id>` / `USER#<sub>`. The plan row, the
agent's registry entry and the tool catalogue rows of the targets the grant
touches come from the per-process cache (`registryTtl`). A miss on the cut
row is the common case and means "no cut".

**Grant evaluation.** Every set is normalised before the rule runs: each
`<target>/*` is expanded against the catalogue rows `TOOL#<target>`, names
not in the catalogue are dropped, the rule is applied, and the result is
compressed back to `<target>/*` for each target whose every catalogued tool
is granted. The result is sorted, so the same inputs give the same `scope`
string and the same cache entry. `needs` are not expanded or compressed. A
compressed `scope` longer than 4,096 bytes is refused with 502 and log
reason `grant_too_large`; with at most 64 entries in `tools` this cannot
happen unless a target has hundreds of tools and the user is cut from one
(V-13 records the fallback).

**Scale at 100s of agents and 1,000s of tools (amended 2026-11-03).** The
counts that grow with agents and tools, and where each is bounded:

| Grows with | Where | Bound | Rule |
|---|---|---|---|
| Agents | registry entries in SSM, one per agent | SSM standard tier, 10,000 parameters | cached per name; no listing on the hot path |
| Agents | `AgentBackend` Runtimes | AgentCore Runtime quota per account | one Runtime per agent, as v1 |
| Agents on the `agentcore-gateway` ingress | one Runtime target per agent on the ingress Gateway | 100 targets per Gateway (V-14) | **the `agentcore-gateway` ingress caps at 100 agents**; `api-gateway` has no such cap and is the recommended ingress (ADR-0029). The README says so |
| Agents per tenant | `agents` entries on the tenant row | `maxAgentsPerTenant`, 1,000 | one row read per mint, cached per tenant version |
| Tools | catalogue rows `TOOL#` | 1,000 per target, 100 targets | the ingress Queries one target at a time and caches it `registryTtl`; the whole catalogue is never read |
| Tools | Cedar policy text per target | one policy per target; its size grows with the tools named one by one | V-16 measures a 1,000-tool target; the fallback is one `<target>/*` permit plus per-tool permits in groups of 100 |
| Tools | `tools/list` pages | about 30 tools per page before Policy filters (V-14) | an agent product lists its own targets only, so a product with 3 targets pays 3 to 100 pages, never the whole catalogue; the agent caches the list for the token life; `toolsGateway.semanticSearch` (off by default) replaces listing for products that span many targets |
| Tools per tenant | `tools` entries on the tenant row | `maxToolsPerTenant`, 1,000 entries; a 400 KB item holds about 10,000 names | subscribe by `<target>/*`; the row is read once per mint, cached |
| Tools in a token | `scope` after compression | 4,096 bytes (`grant_too_large`) | whole targets compress to one entry; a user cut from one tool of a 1,000-tool target expands to 999 names and overflows. V-16 decides the fix: a `cut` claim that Policy enforces with one `forbid` per target, or the hash-referenced grant (V-13 fallback). Until then the limitation is named in the README |

**Mint cache (ADR-0036).** Key `(tenant_id, sub, agent, tenant.version, agent.version,
plan.version)`. A cached token is reused while more than 60 s of its life is
left. `tenant.version` is bumped by every write to the tenant row or to any
cut row of that tenant, so a write is seen by the very next request.

**Tools gateway.**

- Inbound: `CUSTOM_JWT`, `discoveryUrl` = `<issuer>/.well-known/openid-configuration`,
  `allowedAudience: ['tools-gateway']`, no `allowedClients` (the token has no
  `client_id`). An identity token fails here on `iss`.
- Policy: AgentCore Policy, default deny. One policy per target, generated
  by `ToolTarget`, permitting action `<target>___*` when the principal's
  `scope` claim contains `<target>/*`, and action `<target>___<tool>` when it
  contains `<target>/<tool>`, matched as a whole space-separated token with
  `like` (V-9). The same rule filters `tools/list` and refuses `tools/call`.
  A list-only filter would be filtered isolation and is not enough (review
  §2).
- Interceptor (C-15a), on `tools/call`, in order: verify signature against
  the JWKS (cached, refreshed on unknown `kid`); require header
  `typ: txn+jwt`, `iss` = the ingress issuer, `aud` contains `tools-gateway`
  and `agent:<agent>` for the token's own `agent`, `act.sub` = the published
  ingress role ARN, `exp` in the future; check the called tool against
  `scope`; compute `argsHash = base64url(sha256(canonical JSON of the
  arguments without _ri_ctx))`; sign `{tenant_id, sub, agent, tool,
  argsHash, txn, exp: now + contextLifetime}` with `ToolContextKey` as a
  compact JWS; set `arguments._ri_ctx` to it, overwriting any client value;
  write `tool admitted`. Any failure returns a refusal (§5.4); none passes
  the call on.
- Rate limits: one Gateway rate limit keyed on `$.context.jwt.tenant_id`
  with a `*` entry at `tenantRateLimit` and one entry per override. Fail-open
  by the service's design, so a fairness control, never an isolation one
  (review §5.3).
- Outbound: `GATEWAY_IAM_ROLE` for Lambda targets; the Gateway role may
  invoke only the registered tool functions. Third-party targets use
  AgentCore Identity: 3LO and OBO per user, 2LO and API keys vendor-shared.

Rejected alternatives, kept from the review (§4) and recorded in ADR-0034:

- **Credentials in the request body.** Every request log would hold a
  credential.
- **OBO token exchange at tenant-identity's RFC 8693 endpoint.** Lambda
  targets cannot use it. Kept as a possible MCP-server variant.
- **One Gateway per tenant.** 1,000 Gateways per account, every tool change
  N deploys, no isolation gain because the Lambda still runs as the Gateway
  role.
- **Interceptor-only entitlement.** No Policy charge, but two Lambda
  invocations per `tools/list` and the wall is vendor code. Kept as the
  defence-in-depth recheck.
- (v2) **Scopes in the identity token** (the review's plan: tool scopes in
  tenant-identity's catalogue). The identity token would carry every tool
  the user may use with any agent, not the ones this agent may use, so it
  fails R-6; and at 100s of tools it would pass Cognito's 2,048-character
  `custom:scopes` bound. Rejected in ADR-0030.
- (v2) **The identity token as the tools bearer.** It is not bound to an
  agent (RFC 8707) and the MCP specification forbids passing a client token
  through. Rejected in ADR-0031.

---

## 4. Data model

### 4.1 Derived values (v1)

| Field | Source | Shape |
|---|---|---|
| random id (no `session`) | `s-` + base32 of 32 random bytes | `s-[a-z2-7]{52}` |
| prefix (`session`) | `sha256(tenant_id "|" sub)` or `sha256(tenant_id)`, base32, first 26 chars | `[a-z2-7]{26}` |
| `conversationId` (`session`) | client, in the body | `[A-Za-z0-9]{16,64}` |
| `runtimeSessionId` | the random id, or `s-<prefix>-<conversationId>` | 45 to 93 chars |

Model cost per tenant is not stored; it is read from the bill (ADR-0018).

### 4.2 Tenant limits (v1, ADR-0020)

`TenantLimits`: `PK = TENANT#<tenantId>#<epochMinute>`, attributes
`requests` and `outputTokens`, TTL on `expiresAt` (180 s). Counters only.

### 4.3 Backend registry (ADR-0024; v2, ADR-0032, ADR-0035)

One SSM `String` parameter per backend at `<registryPrefix>backends/<name>`,
written by that backend's stack, read by the ingress, JSON, 4 KB.

| Field | Shape | Meaning |
|---|---|---|
| `runtimeArn` | `arn:<partition>:bedrock-agentcore:<region>:<account>:runtime/<id>` | the Runtime the route invokes |
| `needs` | string[], required, non-empty (v2) | `A.needs`, always granted with the agent |
| `tools` | string[], required, may be empty (v2) | `A.tools`, `<target>/<tool>` or `<target>/*` |
| `version` | integer (v2) | bumped on every update; part of the mint cache key |
| `status` | `active` or `draining` | `draining` refuses new requests (404) while streams finish |

(v2) An entry without `needs` or `tools`, or with the v1 field `scopes`, is
refused with 502 and log reason `registry_entry_v1`, so an entry in the old
shape fails loudly rather than granting the wrong set.

### 4.4 Tool registry pointer (v2, ADR-0035)

One SSM `String` parameter per tool target at `<registryPrefix>tools/<target>`:
`{ gatewayTargetId, kind, status, version }`. It holds no tool names; the
catalogue rows (§4.5) do. Consumers use it to discover targets; the ingress
does not read it.

### 4.5 Entitlement store (v2, ADR-0030)

One table per `SharedIngress`, `PK` and `SK` strings, on-demand, PITR on,
no TTL, no GSI. Every list attribute is a DynamoDB string set or list of
names matching the patterns in §3.3.

| Row | PK | SK | Attributes | Written by | Read by | Size bound |
|---|---|---|---|---|---|---|
| Tenant subscription | `TENANT#<tenantId>` | `#SUB` | `agents: string[]`, `tools: string[]`, `plan?: string`, `status: active \| suspended`, `version: number`, `updatedAt` | vendor, `PutTenantSubscription` / `DeleteTenantSubscription`; `version` also by every cut write | ingress, every request (batch get) | ≤ 100 agents, ≤ 1,000 tools: about 40 KB at 1,000 tools of 40 bytes |
| User cut | `TENANT#<tenantId>` | `USER#<sub>` | `cutAgents: string[]`, `cutTools: string[]`, `version: number`, `updatedBy` (admin `sub`), `updatedAt` | tenant admin, `PutUserCut` / `DeleteUserCut` | ingress, every request (batch get, usually a miss) | ≤ 100 + 1,000 names; one row per cut user, absent = full |
| Plan | `PLAN#<planName>` | `#PLAN` | `agents: string[]`, `tools: string[]`, `version: number`, `updatedAt` | vendor, `PutPlan` / `DeletePlan` | ingress, cached `registryTtl` | as tenant row; tens of plans |
| Tool catalogue | `TOOL#<target>` | `TOOL#<tool>` | `description`, `owner` (`<StackId>#<LogicalResourceId>`), `addedAt` | `ToolTarget` custom resource at deploy | ingress (Query per target, cached `registryTtl`), entitlement API validation | ≤ 1,000 rows per target, ≤ 100 targets |
| Name reservation | `NAME#<name>` | `#NAME` | `kind: agent \| target`, `owner` | `AgentBackend` and `ToolTarget` custom resources, conditional put | the same, on create and delete | tens of rows |

Status values: a tenant row is `active` or `suspended`; `suspended` refuses
every request for the tenant with 403 `tenant_suspended` and is how the
vendor stops a tenant without deleting its cuts. No row means no
subscription: every agent is `agent_not_subscribed`.

Writes:

- `PutTenantSubscription` writes the whole row and increments `version`.
- `PutUserCut` and `DeleteUserCut` are a `TransactWriteItems` of the cut row
  and an `ADD version 1` on the tenant row, both conditioned on the tenant
  row existing.
- The tenant-admin handler runs under credentials vended with a `TenantId`
  session tag from the verified identity token, and its role allows
  `dynamodb:*Item` only where `dynamodb:LeadingKeys` is
  `TENANT#${aws:PrincipalTag/TenantId}`. A tenant admin's cut for another
  tenant fails in IAM (enforced, P-8 applied to the store).
- The ingress roles have `dynamodb:BatchGetItem`, `GetItem` and `Query`
  only, never a write.
- Catalogue and reservation rows carry an owner marker. A create whose
  `NAME#` row names another owner fails the deploy; a delete skips rows owned
  by another stack (the ADR-0025 rule, moved from tenant-identity's
  catalogue to this table, ADR-0035).

Scale at the target sizes: 50,000 tenants × 40 KB is 2 GB; cut rows exist
only for cut users; reads per agent request are one batch get of two items,
about 1 RCU in all at the sizes above (V-12 records the measured figure).

### 4.6 Change lag (v2, ADR-0036)

| Change | Who | Lands for new mints | Lands for tokens in flight |
|---|---|---|---|
| Tenant drops a tool or an agent | vendor | next request (the batch get reads `#SUB`; `version` changes the cache key) | at `exp`, at most `transactionToken.ttl` |
| Admin cuts a user | tenant admin | next request (`version` bump in the same transaction) | at `exp` |
| Admin removes a cut | tenant admin | next request | n/a (the old token held less) |
| Tool leaves a plan, or a plan changes | vendor | within `registryTtl` (plan cache), then next mint | at `exp` |
| Agent gains or loses a tool (`AgentBackend.tools`) | agent stack | within `registryTtl` (registry cache) | at `exp` |
| Tool added to a target | tool stack | within `registryTtl` for explicit grants; at once for tokens that already hold `<target>/*`, because Policy matches the wildcard | as for new mints |
| Tool removed from a target | tool stack | at once: the Gateway target no longer lists it | at once |
| Signing key rotated | vendor | next mint signs with the new key | old `kid` stays in the JWKS until every token it signed has expired |

A cut therefore lands at once for new mints and within `exp` for tokens in
flight. A deployer who needs a faster stop for tokens in flight lowers
`transactionToken.ttl`; no revocation list is kept.

---

## 5. API surface

### 5.1 `InvokeAgent` (v1, amended)

| | `api-gateway` | `agentcore-gateway` |
|---|---|---|
| URL | `POST https://<api>/prod/invocations` (a `defaultBackend`); `POST https://<api>/prod/<backend>/invocations` | `POST https://<gw>.gateway.bedrock-agentcore.<region>.amazonaws.com/<backend>/invocations` |
| Auth | `Authorization: Bearer <identity token>` | same |
| Tenant | (v2) `X-Tenant-Id: <tenantId>`, required when the token carries `tenants`, optional and checked when it carries `tenant_id` | same |
| Body | `{prompt}`; with `session`, `{conversationId, prompt}` | same |
| Unit | chosen by the integration Lambda | chosen by the interceptor, written to the session header; a client value is overwritten |
| Response | `text/event-stream`, streamed | same |

Errors written by the ingress code. Bodies are fixed; (v2) a 403 or 400 from
the v2 checks carries a fixed reason code after the text, for example
`forbidden: agent_not_subscribed`, and the same code is the `reason` field of
the log line. On `api-gateway` the authoriser's Deny surfaces through the
`ACCESS_DENIED` gateway response, whose template reads the code from
`$context.authorizer.reason`; if that context is empty the body is API
Gateway's own and the code is in the log only.

| Status | Body | When |
|---|---|---|
| 400 | `bad request` | malformed `prompt` or `conversationId`, `conversationId` without `session`, or a malformed `X-Tenant-Id` |
| 400 | `bad request: tenant_required` | (v2) the token carries `tenants` and no `X-Tenant-Id` was sent |
| 401 | `unauthorized` | missing or invalid token, or (v2) a transaction token presented as the identity token (`typ: txn+jwt` or `iss` = the ingress issuer); on `api-gateway` surfaces as 403 (ADR-0015) |
| 403 | `forbidden` | `tenant_id` and `tenants` both absent; `tenants` present with `identity.multiTenant` off; a floor scope missing (ADR-0005); a `tvm.claimTags` claim missing |
| 403 | `forbidden: tenant_not_allowed` | (v2) `X-Tenant-Id` not in `tenants`, or different from `tenant_id`, or both claims present |
| 403 | `forbidden: tenant_suspended` | (v2) the tenant row has `status: suspended` |
| 403 | `forbidden: agent_not_subscribed` | (v2) the agent is not in `T.agents ∩ U.agents`, including a tenant with no row |
| 404 | `not found` | no registry entry, or the entry is `draining` |
| 429 | `too many requests` | over `tenantLimits` (ADR-0020) |
| 502 | `upstream error` | backend invoke failed; registry or entitlement store unreadable; a v1-shaped registry entry (`registry_entry_v1`); `grant_too_large`; `kms:Sign` failed (`mint_failed`) |

Not an error: `no_tools_granted`, an agent whose grant holds only its `needs`.
It is served with `scope` = its needs; any tool call it makes is refused at
the tools gateway.

Check order: verify token, select tenant, floor scopes, registry entry,
per-tenant limit, entitlement read, grant rule, mint, TVM, invoke. A
refused request costs no KMS call and no STS call.

### 5.2 Token discovery routes (v2, ADR-0037)

| Route | Auth | Body |
|---|---|---|
| `GET <baseUrl>/.well-known/openid-configuration` | none | `{ issuer, jwks_uri, id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["token"], subject_types_supported: ["public"] }`; `issuer` = `<baseUrl>`; extra fields only if V-8 shows the Gateway needs them |
| `GET <baseUrl>/.well-known/jwks.json` | none | `{ keys: [ { kty, kid, use: "sig", alg, n, e } ] }`, one key, two during rotation |

Both answer from a mock integration rendered at deploy (no Lambda, no KMS
call per read), with `Cache-Control: public, max-age=300`. On
`agentcore-gateway`, `<baseUrl>` is the small REST API of C-13. Neither
route is behind the per-tenant limit or the stage throttle's tenant logic;
the stage throttle applies.

### 5.3 Entitlement API (v2, ADR-0030, ADR-0033, C-14)

Smithy service `EntitlementService`, `restJson1`, resources `TenantSubscription`,
`Plan` and `UserCut`. Paths are under `<baseUrl>/entitlements`.

| Operation | Method and path | Caller and auth | Input | Output |
|---|---|---|---|---|
| `PutTenantSubscription` | `PUT /entitlements/tenants/{tenantId}` | vendor, SigV4 (`execute-api:Invoke`) | `{ agents, tools, plan?, status? }` | the row with `version` |
| `GetTenantSubscription` | `GET /entitlements/tenants/{tenantId}` | vendor, SigV4 | - | the row |
| `DeleteTenantSubscription` | `DELETE /entitlements/tenants/{tenantId}` | vendor, SigV4 | - | 204; also deletes the tenant's cut rows |
| `PutPlan` | `PUT /entitlements/plans/{planName}` | vendor, SigV4 | `{ agents, tools }` | the row with `version` |
| `GetPlan` | `GET /entitlements/plans/{planName}` | vendor, SigV4 | - | the row |
| `DeletePlan` | `DELETE /entitlements/plans/{planName}` | vendor, SigV4 | - | 204; 409 `plan_in_use` while a tenant row names it |
| `ListPlans` | `GET /entitlements/plans` | vendor, SigV4 | `nextToken?` | `{ plans, nextToken? }` |
| `PutUserCut` | `PUT /entitlements/users/{sub}/cut` | tenant admin, identity token with `entitlements/admin`; tenant from the token or `X-Tenant-Id` (P-3) | `{ cutAgents, cutTools }` | the row with `version` |
| `GetUserCut` | `GET /entitlements/users/{sub}/cut` | tenant admin | - | the row, or 404 when the user has no cut |
| `DeleteUserCut` | `DELETE /entitlements/users/{sub}/cut` | tenant admin | - | 204; the user holds the full tenant set again |
| `ListUserCuts` | `GET /entitlements/users` | tenant admin | `nextToken?` | `{ cuts, nextToken? }`, the caller's tenant only |

Validation: names match §3.3; a name in a vendor write that is neither a
reserved agent name nor a catalogued tool (or `<target>/*` for a catalogued
target) is refused with 400 `unknown_name`; `planName` is `[a-z0-9-]{1,32}`;
`tenantId` matches tenant-identity's tenant id pattern. A cut may name
only an agent or tool the tenant holds (`T`); anything else is 400
`not_subscribed` (ADR-0033). The API cannot add to a user's set: there is no
operation for it (P-12).

Errors: 400 `bad request` with a reason; 401/403 per the ingress rules
(a tenant-admin call without `entitlements/admin` is 403
`forbidden: admin_scope_missing`); 404 `not found`; 409 `conflict` with a
reason; 429; 502. Smithy's `StandardOperationVerb` validator runs at
`DANGER` (standard §4.2).

### 5.4 Tools gateway (v2, ADR-0034)

**Amended 2026-11-02 (ADR-0040, spike V-8).** A token the Gateway refuses
for its signature, `aud`, `iss` or `exp` is 403 `insufficient_scope`; only a
missing bearer or an unknown `kid` is 401. The Gateway does not check `typ`;
the interceptor does.

MCP over streamable HTTP at `<toolsGatewayUrl>/mcp`, bearer = the
transaction token. `tools/list` returns, page by page (30 tools a page,
cursor), only the tools Policy permits. `tools/call` runs one tool.

| Status / result | Who refuses | When |
|---|---|---|
| 401 | Gateway `CUSTOM_JWT` | no token, bad signature, expired, wrong `iss` (an identity token), `aud` without `tools-gateway` |
| tool absent from `tools/list`; `tools/call` refused with the Gateway's not-authorised error | Policy | `scope` grants neither `<target>/*` nor `<target>/<tool>`, including a tool the tenant has not subscribed to, a tool the user was cut from, and a tool the agent does not list |
| 403 `forbidden: act_missing` | interceptor | `act` absent or `act.sub` is not the ingress role |
| 403 `forbidden: aud_mismatch` | interceptor | `aud` lacks `agent:<agent>` for the token's `agent`, or `typ` is not `txn+jwt` |
| 403 `forbidden: tool_not_granted` | interceptor | recheck of `scope` fails (Policy should already have refused) |
| 403 `forbidden: token_invalid` | interceptor | signature or claims fail the interceptor's own verification |
| 429 | Gateway rate limit | the tenant's bucket is empty |
| tool error `context_invalid` | tool library (C-15b) | `_ri_ctx` missing, expired, for another tool, or `argsHash` mismatch; the tool assumes no role |
| 5xx | Gateway | interceptor timeout or error (fail-closed, V-11) |

A denied call does not invoke the interceptor (V-11), so refusals by Policy
are counted from the Gateway's `UserErrors` metric and Policy decision logs,
which carry no tenant; the `txn` of the agent request is in the agent's
error report instead.

---

## 6. Contracts

### 6.1 What the deployer supplies

- An OIDC issuer whose identity tokens satisfy §6.2.1 (the sample uses
  tenant-identity `shared-pool` or `shared-pool-multi-tenant`), and the
  vendor application scopes registered there: the floor (for example
  `app/use`) and `entitlements/admin`.
- An agent code bundle and a Bedrock model id enabled in the Region, and for
  each agent its `needs` and `tools`.
- For each tool target: the function, spec or endpoint, and optionally a
  tool tenant role (`ToolTarget.tvm.role`) whose trust allows
  `sts:AssumeRole` and `sts:TagSession` to the tool's role only, requires
  the `TenantId` request tag, and scopes data by
  `${aws:PrincipalTag/TenantId}`.
- Optionally `tvm.role` for the agent, as v1 (ADR-0012, ADR-0018).
- Subscriptions and plans, written through the vendor operations of §5.3.
- Service quota headroom for the tools gateway (200 TPS per Gateway and per
  account, 5,000 connections) and KMS `Sign` at the expected call rate
  (review §5.4).

### 6.2 Token contracts

#### 6.2.1 Identity token (v1 contract, amended)

Access token, RS256, with `iss`, `exp`, `client_id`, `token_use: "access"`,
`sub`, `scope` (space-separated, the application floor only, no agent or
tool names) and exactly one of:

- `tenant_id`: one string; or
- (v2, R-1, ADR-0038) `tenants`: an array of tenant ids, accepted only with
  `identity.multiTenant` on; the request selects one with `X-Tenant-Id`.

A token with both, or neither, is refused (403). A token whose `iss` is the
ingress's own issuer, or whose header `typ` is `txn+jwt`, is refused as an
identity token (401). The identity token MUST NOT be forwarded beyond the
ingress (v2, ADR-0031).

#### 6.2.2 Transaction token (v2, ADR-0031, ADR-0037)

| Token | Issuer | Carries | Life |
|---|---|---|---|
| Identity token (v1 contract) | tenant-identity (Cognito) | `sub`, `tenant_id` or `tenants[]`, `scope` (application floor only, no tools) | IdP's |
| Transaction token (new) | the `SharedIngress`: KMS asymmetric key, RS256 (default) or ES256; JWKS at `<baseUrl>/.well-known/jwks.json`, OIDC discovery at `<baseUrl>/.well-known/openid-configuration` | see below | 300 s default (`transactionToken.ttl`) |

JOSE header: `{ "alg": "RS256", "typ": "txn+jwt", "kid": "<KMS key id>" }`.

| Claim | Value |
|---|---|
| `iss` | the ingress issuer URL, `<baseUrl>` |
| `sub` | `<tenant_id>#<sub>`: the tenant and the identity token's `sub` (amended 2026-11-02, ADR-0040: the AgentCore Identity vault keys on `iss` and `sub`, so `sub` MUST differ per tenant) |
| `user` | the identity token's `sub`, for logs and the session prefix (ADR-0040) |
| `tenant_id` | exactly one tenant: the selected one |
| `agent` | the backend name of this request |
| `scope` | the granted set, space-separated `<owner>/<name>`, sorted, compressed per target (§3.6) |
| `aud` | `["agent:<agent>", "tools-gateway"]` |
| `act` | `{ "sub": "<ingress role ARN>" }` (RFC 8693) |
| `txn` | a unique id per agent request (128 random bits, base64url) |
| `iat`, `exp` | issue time; `iat + lifetime` |
| `jti` | unique per minted token |

Rules:

- MUST NOT contain the identity token or any of its claims beyond `sub` and
  the selected tenant.
- MUST NOT come with a refresh token; there is no way to extend one.
- MUST NOT be accepted on the ingress as an identity token: the issuer
  check and the `typ` check each refuse it (§6.2.1).
- A cached token is reused for later requests of the same key (§3.6), so
  `txn` identifies the mint, not each request; the ingress log line carries
  both `txn` and its own request id. (Divergence: draft-09 expects a new
  `txn` per transaction. The cache saves one KMS call per request; ADR-0037
  weighs it.)
- Size: about 1.2 KB with RS256 and a scope of ten entries; spike V-13
  confirms the Runtime header allowlist carries it beside the credentials.

Divergences from IETF draft-09, stated in ADR-0031:

- The draft passes the token in a `Txn-Token` header. The Gateway's
  `CUSTOM_JWT` authoriser reads only `Authorization: Bearer`, so inside this
  sample the transaction token is the bearer on the tools path. The agent
  receives it in the Runtime custom header
  `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token`, which replaces
  v1's `...-Custom-User-Token`.
- The draft's `aud` names the trust domain. Here it names the two relying
  parties (RFC 8707), so a token minted for agent `default` is not accepted
  for agent `billing`'s bearer checks.
- The draft carries context in `tctx` and `rctx`. Here the context the
  relying parties need (`tenant_id`, `agent`) is top-level, because Cedar
  policies and Gateway rate limits address top-level claims.
- The draft issues through an RFC 8693 exchange at a token service. Here the
  ingress mints in-process after its own verification; there is no exchange
  endpoint (§1.2).

The identity token never leaves the ingress. v2 supersedes ADR-0006 and
ADR-0007 through ADR-0031.

#### 6.2.3 Key rotation (v2, ADR-0037)

`kid` is the KMS key id. Bumping `transactionToken.keyGeneration` from N to
N+1 creates key N+1, which signs from the deploy on; the JWKS lists N+1 and
N. Key N is no longer allowed `kms:Sign` but stays in the JWKS. Bumping to
N+2 drops N from the JWKS and schedules its deletion (30-day window). Two
bumps MUST be at least `lifetime` plus the JWKS cache life (300 s) apart,
or tokens signed by N would fail before they expire; synth cannot see the
time between deploys, so the README runbook says to wait 15 minutes.
Relying parties refresh their JWKS cache on an unknown `kid`, at most once a
minute.

#### 6.2.4 Tenant context (v2, ADR-0034)

Compact JWS, `alg` per `ToolContextKey` (RS256), `typ: ri-ctx+jwt`, claims
`tenant_id`, `sub`, `agent`, `tool` (`<target>/<tool>`), `argsHash`, `txn`,
`iat`, `exp` (`iat + contextLifetime`, default 60 s). Carried in the
reserved argument `_ri_ctx`. Never logged by the interceptor or the
library. `ToolContextKey` signs contexts only; its public half is not in
the JWKS, so a context can never pass as a transaction token.

### 6.3 What the sample promises

v1 promises that hold unchanged:

- No principal other than the ingress can invoke the backend (integ step 3).
- Without `session`, no two requests share a unit (integ step 4a).
- With `session`, tenant A's token cannot land in tenant B's unit; under the
  default `scope: 'tenant'` A1 and A2 share a conversation they both name,
  and under `scope: 'user'` A1 cannot land in A2's unit (integ steps 4b, 5).
- The TVM is always on: a read of the caller's own tenant data succeeds and
  a read of another tenant's fails in IAM; the runner cannot assume the role
  (integ step 8a).
- Both ingresses pass the same e2e suite; the README reports measured TTFB
  and total latency (p50, p95). Per-request cost was not measured and that
  promise is withdrawn (ADR-0029).
- With `tenantLimits`, a tenant over its limit gets 429 while another is
  served (integ limits step).

v1 promise changed:

- (v2, ADR-0031) "The user token reaches the agent only when forwarding is
  on" becomes: the identity token never reaches the agent or a tool. The
  agent reports the headers it received and its claims; neither holds an
  identity token, and the Runtime allowlist has no user-token header
  (integ step 11).

New promises (v2):

- A transaction token from tenant A cannot call a tool for tenant B. The
  tool sees tenant A's context only, a client-written `_ri_ctx` naming
  tenant B is overwritten, and a token whose `tenant_id` is altered fails
  the signature check (401) (integ step 15).
- A tool the tenant has not subscribed to is absent from `tools/list` and
  refused on `tools/call` (integ step 13).
- A tool the agent product does not list is refused even when the tenant
  subscribes to it (integ step 14).
- An agent the tenant, or the user, is not subscribed to is refused at the
  ingress with 403 `agent_not_subscribed` (integ step 12).
- An admin cut lands at once for new mints and within the token's life for
  tokens in flight (integ step 16).
- A token without `act` is refused with 403 at the interceptor; a token
  without `tools-gateway` in `aud` is refused with 401 at the Gateway
  (integ step 17).
- The ingress refuses its own transaction token as an identity token (integ
  step 18).
- A user in several tenants acts for exactly the one they select, and a
  tenant they do not belong to is 403 `tenant_not_allowed` (integ step 19).
- A tool reaches only its caller's tenant data, through its own TVM; a tool
  called without a valid context assumes no role (integ step 20).
- JWKS rotation keeps the old `kid` valid until the tokens it signed have
  expired (integ step 21).
- `cdk destroy` plus the integration script's teardown leaves no stacks,
  log groups, parameters, Gateways, KMS keys pending outside their deletion
  window, or entitlement tables with the sample's prefix (v1 promise,
  extended; integ step 10).

### 6.4 Composition (standard §1.1)

**Consumes:** `tenant-identity`, topology `shared-pool` and, (v2,
R-1), `shared-pool-multi-tenant` (tokens with `tenants`), through
`/application-plane/shared/identity/{userPoolId,appClientId}` (ADR-0004).
Only the demo app and the integration driver read them; the constructs take
the issuer as props. (v2, ADR-0030) The constructs no longer call
`/platform/scopes` and no longer read `apiUrl` or `platformInvokePolicyArn`;
the integration driver uses them once to register `app/use` and
`entitlements/admin`, and tenant-identity's own API to create the demo
tenants, users and tenant admins. Removing the registration also removes
threat-model T-41's residual (a direct invoke of the registration function).

**Published interface.**

Constructs, exported from `src/index.ts`: `SharedIngress`, `AgentBackend`,
and (v2) `ToolTarget`, `TokenSigner`, `EntitlementStore`, plus the
tool-side library `verifyToolContext` / `withTenantCredentials` (C-15b) and
the helpers `registryParameterName`, `BACKEND_NAME_PATTERN`,
`NEEDS_NAME_PATTERN` (was `SCOPE_NAME_PATTERN`), `TOOL_NAME_PATTERN`,
`INGRESS_TAG_KEY` and `grantFor` (the rule, for consumers that test their
own data). `ScopeRegistration` and `backendScopesProblem` are removed (v2,
breaking).

Read-only members:

- `SharedIngress`: v1's `endpointUrl`, `ingressRole`, `tvmCallerRole`,
  `tenantRole`, `ingressId`, `registryPrefix`, `gatewayIdentifier`,
  `limitsTable`, `logDrain`, `options`, `urlFor(name)`; (v2) `issuer`,
  `jwksUrl`, `tokenSigner`, `entitlementStore`, `entitlementsApiUrl`,
  `toolsGatewayUrl`, `toolsGatewayIdentifier`, `toolsGatewayRole`.
- `AgentBackend`: `runtimeArn`, `executionRole`, `endpointUrl`, `name`,
  `needs` (was `scopes`), `tools`, `registryParameterName`, `backend`.
- `ToolTarget`: `name`, `targetId`, `tools`, `policyId`,
  `registryParameterName`.

Parameters under `/application-plane/shared/agent-runtime/` (the
`registryPrefix`):

| Name | Value | Written by |
|---|---|---|
| `endpointUrl`, `baseUrl`, `ingress`, `ingressRoleArn`, `ingressId`, `tenantRoleArn`, `gatewayIdentifier` | as v1 (ADR-0024) | `SharedIngress` |
| `issuer` | (v2) the transaction-token issuer URL | `SharedIngress` |
| `jwksUrl` | (v2) `<issuer>/.well-known/jwks.json` | `SharedIngress` |
| `entitlementsTableName` | (v2) C-12's table name, for `AgentBackend` and `ToolTarget` reservations | `SharedIngress` |
| `entitlementsApiUrl` | (v2) `<baseUrl>/entitlements` | `SharedIngress` |
| `toolsGatewayUrl` | (v2) the MCP endpoint | `SharedIngress` |
| `toolsGatewayIdentifier` | (v2) the Gateway id, for `ToolTarget` | `SharedIngress` |
| `backends/<name>` | registry entry (§4.3) | each `AgentBackend` |
| `tools/<target>` | (v2) tool registry pointer (§4.4) | each `ToolTarget` |
| `runtimeArn`, `backends-info/billing/runtimeArn` | as v1 | demo stack |

`ARCHITECTURE.md` §5.1 and §6 are updated in the same change that accepts
this draft. Renaming `scopes` to `needs`, removing `delegation.*`, removing
`ScopeRegistration` and the `forwardUserToken` import option are breaking
changes to a published interface and are recorded in ADR-0030, ADR-0031 and ADR-0032
(standard §1.1). No sample consumes them today.

---

## 7. Spikes to run before acceptance (v2)

V-1 to V-7 were run on 2026-10-26 and passed; their results are in v1 §7
(kept as `agentic-runtime-isolation.spec.v1.md` §7 on acceptance). The v2
design depends on these further behaviours.

| ID | Behaviour | Fallback if it fails |
|---|---|---|
| V-8 | The tools gateway's `CUSTOM_JWT` authoriser accepts the ingress as issuer through a discovery URL served by API Gateway (no Cognito), fetches the JWKS, accepts `RS256` from a KMS key, and enforces `allowedAudience: ['tools-gateway']` against an array `aud`. Also: whether `ES256` is accepted | The interceptor becomes the only verifier of the transaction token: the Gateway keeps `CUSTOM_JWT` on the identity issuer only if the agent may send both tokens, which P-14 forbids, so instead the Gateway runs with IAM inbound auth for the agent's tenant credentials and the interceptor verifies the transaction token from a second header. The loss of the native check is recorded in ADR-0034. If only `ES256` fails, `RS256` stays the one algorithm |
| V-9 | A Cedar policy can read the `scope` claim and match `<target>/*` and `<target>/<tool>` as whole space-separated tokens with `like` (was tool-gateway V-2) | One policy per tool rather than per target, still O(tools) not O(tenants); or a `scope_targets` claim (array) the ingress adds for Policy |
| V-10 | The REQUEST interceptor can add `_ri_ctx` to `tools/call` arguments when the tool's `inputSchema` does not declare it, and the Lambda target receives it (was tool-gateway V-1) | `ToolTarget` adds `_ri_ctx` (string, optional) to every tool's `inputSchema`; or carry the context in `params._meta` if the Gateway passes it to the target |
| V-11 | A call denied by Policy does not invoke the interceptor; an interceptor timeout or error is a Gateway error, never a pass-through (was tool-gateway V-4, V-5) | If denied calls reach the interceptor, it refuses them too and logs them with the tenant (better telemetry, more cost). If failure passes through, the tools gateway is not shipped: the design depends on fail-closed |
| V-12 | KMS `Sign` latency at p50 and p95 from the authoriser and the interceptor Lambdas; the per-request cost of a mint; the mint cache hit ratio in the latency probe; `BatchGetItem` latency and RCU per request | If p95 adds more than 50 ms to TTFB, raise the default reuse margin and lifetime within 900 s, or sign with a key held in the Lambda and rotated from Secrets Manager (rejected unless measured: the private key would leave KMS) |
| V-13 | The Runtime `requestHeaderAllowlist` carries the transaction token (about 1.2 KB, up to 4 KB at the `scope` bound) beside the credentials header (about 2 KB) from both ingresses, and no log on the path records it (v1 V-7 repeated) | Hash-referenced grant: the token carries `grant` = sha256 of the granted set instead of `scope`, the ingress writes the set to the entitlement store under `GRANT#<hash>` with a TTL, and Policy is replaced by the interceptor's lookup (AWS Prescriptive Guidance's lean-token pattern); recorded in ADR-0031 |
| V-14 | Policy evaluation latency, and `tools/list` latency, at 100 targets with one policy each (was tool-gateway V-6) | Group tools into fewer targets; document the measured figure in the README |
| V-16 | At 1,000s of tools (amended 2026-11-03): (a) a Cedar policy for a target with 1,000 tools named one by one is accepted, becomes ACTIVE, and `tools/call` latency stays within the V-14 figures; (b) a `forbid` policy on a `cut` claim (`principal.getTag("cut") like "* <target>/<tool> *"`) is accepted beside the permit and removes the tool from `tools/list` and refuses `tools/call`; (c) a `scope` of 4,096 bytes passes the Gateway authoriser | (a) fails: split the permit into groups of 100 tools per policy, cap tools per target in `ToolTarget` at the measured size; (b) fails: keep the 4 KB bound and the hash-referenced grant of V-13 as the fallback, named in the README; (c) fails: lower the bound to the measured size |
| V-15 | AgentCore Identity with the transaction token as the inbound JWT: (a) a 3LO credential provider on a `ToolTarget` keys the vault on the transaction token's `sub` and issuer, and a second transaction token for the same user reuses the stored grant; (b) an OBO `TOKEN_EXCHANGE` provider accepts the ingress as issuer; (c) `GetWorkloadAccessTokenForJWT` in the agent accepts a transaction token when the workload identity names the ingress discovery URL | If (a) fails, 3LO targets are documented as needing the user's consent per token life, or the sample drops 3LO; if (b) fails, OBO targets are out of scope and the README says a third party must trust the ingress issuer; if (c) fails, the agent's outbound identity is M2M only |

The spike stack deploys a throwaway `SharedIngress` with `toolsGateway`, one
`ToolTarget` of kind `lambda`, and a test-only mint function granted
`TokenSigner.grantSign`. It is destroyed after the run, and the
results are added here as §7.1 with the same evidence standard as v1.

### 7.1 Spike results (2026-11-02, pg sandbox, eu-central-1)

Throwaway stack `RiacSpikeV2`, a plain CDK app outside the repo, tagged
`riac-spike=v2`: three KMS signing keys (`SignKey` RSA_2048, `SignKeyEc`
P-256, `ContextKey` RSA_2048); a REST API serving OIDC discovery and a JWKS
rendered from `GetPublicKey` (`Cache-Control: max-age=300`), whose stage URL
is the issuer; a `Mint` Lambda that signs well-formed and malformed
transaction tokens; an AgentCore Gateway (MCP, `CUSTOM_JWT` on the discovery
URL, `allowedAudience: ['tools-gateway']`) with a Policy engine in `ENFORCE`
mode, a REQUEST interceptor (re-verify, `typ`, `iss`, `aud`, `act.sub`,
`scope`, sign `_ri_ctx`, one log line) and a Lambda target `crm` with three
tools; a SigV4 Runtime with an echo agent and a resource policy naming the
`Invoke` Lambda's role (the ingress stand-in); a workload identity; a mock
authorisation server for RFC 8693 token exchange and authorisation code. Raw
outputs are under `/tmp/riac-spike-v2/out/`. Every token used `kid` = KMS
key id and `typ: txn+jwt`.

| ID | Result | Evidence |
|---|---|---|
| V-8 | PASS, with two corrections | Well-formed RS256 token: 200, three tools. ES256 from KMS P-256: 200. `aud` as an array and as a plain string: both 200. Refused: wrong `aud`, a signature from a throwaway key under the real `kid`, expired, wrong `iss`, no `exp`: each **403** `insufficient_scope` (JSON-RPC -32002, `WWW-Authenticate: Bearer error="insufficient_scope"`), not 401. No bearer: 401 `Missing Bearer token`; unknown `kid`: 401 `Invalid Bearer token`. The Gateway accepted a token with `typ: JWT`: the `typ` check is the interceptor's only. The interceptor logged 4 calls for the 4 accepted requests and none for the 7 refused. |
| V-9 | PASS | The scope claim is read as `principal.getTag("scope")`. `principal.scope` fails validation (`attribute scope on entity type AgentCore::OAuthUser not found`), and so does `context.jwt.scope` (`attribute jwt in context ... not found, did you mean input?`). `like` matches a whole entry with four alternatives and `\*` for a literal `*` (policy below, `FAIL_ON_ANY_FINDINGS`, ACTIVE in 7 s). `crm/*`: 3 tools listed. `crm/get_account crm/list_cases`: 2 listed. `invoices/*`: none. `xcrm/* crm/get_accountx crm`: none. `update_case` as the middle entry of three: listed and callable. Policy refuses `tools/call`: with the interceptor set to pass everything, `update_case` under the two-entry scope returned `Tool Execution Denied ... No policy applies to the request (denied by default)` and the tool was not invoked. |
| V-10 | PASS | The Lambda target received `_ri_ctx` although its `inputSchema` does not declare it (event keys `accountId`, `_ri_ctx`; `clientContext.custom` carries `bedrockAgentCoreToolName`, `...TargetId`, `...GatewayId`). The tool verified it with `ContextKey`'s public key (`typ`, `exp`, tool, `argsHash`). A client `_ri_ctx` (an `alg: none` JWS for `tenant-b`) and `tenantId: tenant-b` were overwritten: the tool saw `tenant-a` in both. On an OpenAPI target the Gateway drops arguments outside the schema: the endpoint received body keys `["note"]` only, so `_ri_ctx` does not reach a third-party HTTP target. |
| V-11 | FAIL (order), PASS (fail-closed) | The interceptor runs **before** Policy. A call that Policy would deny reaches the interceptor (it logged `tool refused`, reason `scope`). With the interceptor passing everything, Policy denied the same call afterwards. Interceptor throws: 500 `An internal error occurred. Please retry later.` in 0.56 s, for `tools/call` and `tools/list`. Interceptor timeout (1 s, sleeping 5 s): 500 in 1.5 s. The tool was not invoked in either case (its log has no line in those windows). Restored: 200. |
| V-12 | PASS | 200 mints: KMS `Sign` p50 8.2 ms, p95 11.1 ms (one cold 193 ms); handler total p50 8.3 ms. 200 interceptor calls: `Sign` for `_ri_ctx` p50 8.6 ms, p95 11.5 ms (one cold 161 ms). Both far below the 50 ms threshold. `Sign` used `MessageType: DIGEST`: `RAW` takes at most 4,096 bytes, which a token at the `scope` bound exceeds. The mint cache hit ratio and `BatchGetItem` were not measured (no store or cache in this stack). |
| V-13 | PASS for the token; one log finding | Through `InvokeAgentRuntime` with both custom headers on the allowlist, the agent read: transaction token 1,261 bytes (10 scope entries), 4,514 bytes (140 entries) and 8,061 bytes, each beside a 2,048-byte credentials header. The AgentCore Gateway ingress path was not repeated (v1 V-6 covers it). Zero hits for the token signature segments or `eyJ` in all eight Lambda log groups, the API Gateway access and execution logs and the Runtime log group (empty). Gateway application logs, when delivery is turned on, record the request body after the interceptor and the full response body: 20 lines held a signed `_ri_ctx`, none the bearer token. |
| V-14 | PASS, measured, with a quota | `targets-per-gateway` is 100 (`ServiceQuotaExceededException`, HTTP 402, at the 101st). 98 `ping` targets plus `crm` and an OBO target: created in 3 min. Policies: 7 s to ACTIVE with 1 in the engine, 54 to 90 s each one at a time at 50 to 75; 53 of 98 created in parallel ended `CREATE_FAILED` (`An internal error occurred during creation`). Measured at 100 targets with 75 ACTIVE policies. `tools/list` pages at about 30 tools before filtering, so every caller pays 4 pages at 100 targets. Policy `latencyMs` in the Gateway log: 44 to 100 ms, p50 81 (n = 24 `tools/call`). |
| V-15 | (a) PASS, against a mock AS; (b) PASS; (c) PASS | (a) URL elicitation needs MCP `2025-11-25`: the Gateway's `supportedVersions` and the client's `MCP-Protocol-Version` header must both name it, or the call fails with `URL elicitation requires MCP version 2025-11-25 or newer`. The consent flow (Identity authorize, AS authorize, Identity callback, return URL with `session_id`) completed from a script. `CompleteResourceTokenAuth` accepted the transaction token as `userToken`. A second token for the same `sub`: served from the vault, no new authorise. A different `sub`: a new elicitation. The same `sub` with another `tenant_id`: **served from the same grant**. Cognito's hosted UI was not used: the mock AS grants at once, which tests the vault, not a login page. (b) The AS log shows `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token_type=...:jwt`, subject `iss` = the spike issuer, signature verified against its JWKS, `scope=obo-echo`, no actor token. The target received `Bearer` with the AS's token (`iss .../as`, `sub user-a1`). Two calls caused one exchange. (c) `GetWorkloadAccessTokenForJWT` from the agent with the transaction token: a 2,268-character workload access token. Expired: `UnauthorizedException: Token has expired`. Throwaway key: `Invalid Signature for bearerToken`. The workload identity has no issuer setting; Identity resolved the key from `iss`. |

The Cedar policy that worked (one per target; ACTIVE with
`validationMode: FAIL_ON_ANY_FINDINGS`):

```cedar
permit(
  principal is AgentCore::OAuthUser,
  action in [AgentCore::Action::"crm___get_account", AgentCore::Action::"crm___list_cases", AgentCore::Action::"crm___update_case"],
  resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:eu-central-1:111122223333:gateway/riac-spike-v2-tools-ffa2quenmn"
) when {
  principal.hasTag("scope") && ((principal.getTag("scope") == "crm/*" || principal.getTag("scope") like "crm/\* *" || principal.getTag("scope") like "* crm/\*" || principal.getTag("scope") like "* crm/\* *") || (action == AgentCore::Action::"crm___get_account" && (principal.getTag("scope") == "crm/get_account" || principal.getTag("scope") like "crm/get_account *" || principal.getTag("scope") like "* crm/get_account" || principal.getTag("scope") like "* crm/get_account *")) || (action == AgentCore::Action::"crm___list_cases" && (principal.getTag("scope") == "crm/list_cases" || principal.getTag("scope") like "crm/list_cases *" || principal.getTag("scope") like "* crm/list_cases" || principal.getTag("scope") like "* crm/list_cases *")) || (action == AgentCore::Action::"crm___update_case" && (principal.getTag("scope") == "crm/update_case" || principal.getTag("scope") like "crm/update_case *" || principal.getTag("scope") like "* crm/update_case" || principal.getTag("scope") like "* crm/update_case *")))
};
```

**Orphaned policy (found during V-14, reproduced twice).** About 60 s after
a target was deleted while its policy stayed ACTIVE, `tools/list` stopped
filtering for every caller: a token with `scope: invoices/*` got 30 tools on
the first page. `tools/call` stayed denied by Policy throughout. Deleting
the orphaned policy restored filtering within 20 s. Seen for `t098` and
`t001`.

Latency, measured from the sandbox host (unauthenticated 401 floor p50 42
ms, p95 106 ms); 50 sequential calls each, ms:

| Targets / ACTIVE policies | Caller scope | `tools/list` page 1 p50 / p95 | full listing p50 / p95 | `tools/call` p50 / p95 |
|---|---|---|---|---|
| 2 / 2 | `crm/*` | 130 / 172 | 1 page | 151 / 184 |
| 2 / 2 | all targets | 125 / 160 | 1 page | 150 / 175 |
| 100 / 75 | `crm/*` | 249 / 369 | 868 / 973 (4 pages: 3, 0, 0, 0 tools) | 189 / 264 |
| 100 / 75 | all targets | 206 / 273 | 828 / 948 (4 pages: 30, 21, 18, 7) | 166 / 223 |
| 2 / 2, 200 calls, 4 parallel | `crm/*` | | | 154 / 249 |

Cost per call from public prices: KMS `Sign` on RSA_2048 is $0.03 per 10,000
requests ($0.003 per 1,000), on P-256 $0.15 per 10,000 ($0.015 per 1,000);
each key is $1 a month. One `_ri_ctx` per admitted `tools/call` adds
$0.003 per 1,000 calls; a mint adds the same per mint, before the cache.
Every MCP request, `tools/list` included, also costs one interceptor Lambda
invocation (1 to 6 ms warm, 512 MB arm64).

Log search: every log group on the path was pulled after the run and
searched for the signature segments of the tokens used, the `eyJ` prefix,
the `_ri_ctx` JWS header prefix and the string `_ri_ctx`. Mint, Invoke,
interceptor, tool, mock AS, echo and discovery Lambdas, the API Gateway
access log and the execution log (INFO, data trace off): zero token or
context values. The tool's log holds the argument *names* `_ri_ctx` (413
lines), by construction. The Runtime log group was empty for this agent.
The Gateway's vended application log (enabled by `PutDeliverySource`
`APPLICATION_LOGS`) holds no bearer token and no client-forged context.
It does hold `requestBody` after the interceptor, so 20 lines carry a
signed `_ri_ctx`, and every `responseBody`, so tool results are logged.
It also holds `Policy evaluation completed` lines with the decision, the
determining policy, the principal's `sub` and `latencyMs`.

Consequence for the design:

- V-8: the Gateway accepts any `typ`, so the interceptor's `typ` check stays
  and is the only one. Refusals are 403, not 401; §5.4 and the tests expect
  403 for a bad signature, `aud`, `iss` or `exp`.
- V-11 fallback applies: Policy runs after the interceptor. The interceptor
  already refuses an ungranted tool and logs it with the tenant, so each
  denied call costs one interceptor invocation and no KMS `Sign`. Policy
  sees `context.input` with `_ri_ctx` already injected.
- V-9 and the orphan finding: `ToolTarget` MUST delete its policy before its
  target, and the delete path MUST wait for the policy to be gone. A
  `tools/list` call that returns tools outside `scope` is the symptom; the
  `tools/call` wall held.
- V-14: 100 targets per Gateway is the default quota, so the registry caps
  targets at 100 per tools gateway. Policy writes are slow and fail when
  concurrent, so the `ToolTarget` custom resource creates policies one at a
  time with retry. Full listing at 100 targets is about 0.9 s (4 pages);
  the README states it and suggests grouping tools into fewer targets.
- V-13: no fallback needed for header size (8 KB passed). Gateway
  application logs MUST stay off by default, or be documented as holding
  tool arguments, signed contexts (60 s life) and tool results.
- V-15(a): the vault keys on (`iss`, `sub`), not on the tenant. With
  ADR-0038 a user in two tenants shares one 3LO grant across them. The
  transaction token's `sub` must be tenant-qualified (for example
  `<tenant_id>#<sub>`), or 3LO targets are refused for multi-tenant users.
  The Gateway must list MCP `2025-11-25`.
- V-15(b): the third-party AS receives the transaction token as
  `subject_token`. That token is a bearer at the tools gateway for the rest
  of its life, so OBO targets are limited to AS operators the vendor trusts,
  and the README says so.
- V-15(c): the agent can get a workload access token from the transaction
  token; the agent's outbound identity is not limited to M2M.

---

## 8. Integration test outline

Fixtures (v2):

| Kind | Name | Definition |
|---|---|---|
| Tool target | `crm` (`lambda`) | tools `get_account`, `list_cases`, `update_case`; each reads or writes the demo table row `TENANT#<id>` / `CRM#...` with the tool's TVM credentials |
| Tool target | `invoices` (`lambda`) | tool `get_invoice` |
| Agent | `default` | needs `default/chat`; tools `crm/*` |
| Agent | `billing` | needs `billing/read`, `billing/invoke`; tools `invoices/*` |
| Plan | `standard` | agents `default`, `billing`; tools `crm/*`, `invoices/*` |
| Tenant | A | `plan: standard`, no direct lists |
| Tenant | B | direct: agents `default`; tools `crm/get_account`, `crm/list_cases` |
| Tenant | M | direct: agents `default`; tools `crm/get_account` (for the multi-tenant user) |
| User | A1 | tenant A, no cut |
| User | A2 | tenant A, cut `cutTools: ["crm/update_case"]` |
| User | AA | tenant A admin (`entitlements/admin`) |
| User | B1 | tenant B, no cut |
| User | MU | `shared-pool-multi-tenant`: `tenants: [A, M]` |

Expected grants:

| Caller, agent | `scope` |
|---|---|
| A1, `default` | `crm/* default/chat` |
| A2, `default` | `crm/get_account crm/list_cases default/chat` |
| A1, `billing` | `billing/invoke billing/read invoices/*` |
| B1, `default` | `crm/get_account crm/list_cases default/chat` |
| B1, `billing` | 403 `agent_not_subscribed` |
| MU with `X-Tenant-Id: M`, `default` | `crm/get_account default/chat` |

Steps 1 to 10 are v1's, amended where v2 changes them. Steps 11 to 21 are
new and run between step 9-registry and step 10.

1. Deploy tenant-identity, or reuse a published one. (v2) Both topologies
   are needed: `shared-pool` for A, B and their users, and a
   `shared-pool-multi-tenant` deployment for MU. Reuse needs no scope
   catalogue check any more; the driver registers `app/use` and
   `entitlements/admin` if absent and removes them in step 10 only if it
   added them. The v1 stale-identity replacement (`INTEG_REPLACE_STALE_IDENTITY`)
   is dropped (v2, ADR-0030).
2. Deploy the sample with the chosen ingress: `SharedIngress`, both
   `AgentBackend`s, both `ToolTarget`s. All stacks pass
   `owner: 'RuntimeIsolationInteg'`. Then create tenants A, B and M and the
   users above in tenant-identity; write plan `standard` and the three
   tenant subscriptions with the vendor operations (SigV4); sign in as AA and
   write A2's cut with `PutUserCut`. Issue identity tokens.
3. Call `InvokeAgentRuntime` directly with the runner's own credentials:
   denied (P-1).
4a. `session` off: a `conversationId` in the body is 400; two requests with
   the first's unit id in the session header land in two units (P-2).
4b. `session` on, default `scope: 'tenant'`: B1 sending A1's `c1` and unit id
   lands in tenant B's own unit; A2 sending `c1` shares A1's unit (one
   conversation per tenant). `scope: 'user'` stack: A2 sending `c1` lands in
   its own unit (P-2).
5. `session` on: A1 resumes `c1`: same microVM.
6. No token, a tampered token, an ID token: 401 or 403 by ingress (§5.1). A
   malformed `conversationId`: 400 or 403.
7. (v2) Grants: for each row of the expected grants table, the agent
   reports `scope`, `tenant_id`, `agent`, `aud` and `act.sub` equal to the
   expected values. Replaces v1 step 7 (backend scopes).
8. (v2) Replaced by step 11. The v1 forwarding cases (`forwardUserToken`,
   `requireNarrowedToken`) no longer exist.
8a. TVM, as v1: A1's agent reads tenant A's item, and fails in IAM for
   tenant B's; B1 likewise; the runner cannot assume the tenant role.
8b. A model prompt ends with `event: usage` (P-10); per-tenant metrics as
   v1.
Limits. As v1: tenant A gets 429 on the `requestsPerMinute: 5` stack while
   B is served.
9. Latency probe, as v1, plus (v2) the mint: 20 invocations with a cold
   mint cache and 20 warm, TTFB and total, p50 and p95; the README reports
   the difference (V-12).
9-registry. As v1 (ADR-0024), with `needs` in place of `scopes`: `late`
   registered with `needs: ["late/run"]`, `tools: []` is refused with
   `agent_not_subscribed` until the driver adds `late` to tenant A's
   subscription, then 200 within 90 s, then `draining` refuses within 90 s.
   On `api-gateway` only, as v1.
11. Identity token stays at the ingress (P-14). A1 calls `default`; the
   agent reports the names of every request header it received and the
   claims of the transaction token. The header names hold the credentials
   and transaction-token headers and no `...-Custom-User-Token`; the
   transaction token's `iss` is the ingress issuer and its `typ` is
   `txn+jwt`; no header value equals the identity token. A1's agent calls
   `crm/get_account`; the tool reports that its `_ri_ctx` was valid and
   holds no token.
12. Agent subscription. B1 on `/billing/invocations`: 403
   `forbidden: agent_not_subscribed`. AA cuts A1 with
   `cutAgents: ["billing"]`; A1 on billing: 403 `agent_not_subscribed` on
   the next request; AA deletes the cut; A1 on billing: 200. An agent with
   needs only (`late` from 9-registry, `tools: []`) is served and any tool
   call it makes is refused at the gateway (not an ingress error).
13. Tenant tool subscription. B1's agent runs `tools`: the list holds
   `crm___get_account` and `crm___list_cases`, not `crm___update_case` and
   nothing from `invoices`. B1's agent calls `crm/update_case`: refused by
   Policy. A1's agent runs `tools`: all three `crm` tools.
14. Agent product bound. A1 calls `default`; tenant A subscribes to
   `invoices/*` through `standard`, but `default` does not list it: the
   list holds no `invoices___get_invoice` and calling it is refused by
   Policy. A1 on `billing` calls `invoices/get_invoice`: served.
15. Cross-tenant tool call. The runner mints, through the integration stack's
   test-only mint function (`TokenSigner.grantSign`), a token for tenant A and then alters its
   `tenant_id` to B without re-signing: 401 at the Gateway. A1's agent calls
   `crm/get_account` with arguments that include
   `_ri_ctx: "<context signed for tenant B by a key not ToolContextKey>"`
   and `tenantId: "B"`: the tool returns tenant A's account only and reports
   that the client value was overwritten. B1's agent calls the same tool and
   gets tenant B's account only.
16. Cut lands. A1's agent calls `crm/update_case`: served. AA puts a cut
   `cutTools: ["crm/update_case"]` on A1. A1's next request: `scope` no
   longer holds `crm/*`, and `crm/update_case` is refused by Policy. The
   runner keeps a token minted before the cut (from step 15's signer path,
   with the old scope) and shows it is still accepted until `exp`, then
   refused with 401 after it. AA deletes the cut.
17. Interceptor checks. With the signer path the runner mints otherwise
   valid tokens: without `act`: 403 `forbidden: act_missing`; with
   `act.sub` another role: 403 `act_missing`; with `aud: ["agent:default"]`
   only: 401 at the Gateway; with `aud: ["agent:billing", "tools-gateway"]`
   and `agent: "default"`: 403 `forbidden: aud_mismatch`. An identity token
   as bearer on the tools gateway: 401.
18. Self-issued token refused at ingress. A valid transaction token (signer
   path) sent to `/invocations` as the bearer: 401 (`api-gateway`: 403) on
   both ingresses, before any entitlement read.
19. Multi-tenant user (R-1, ADR-0038). MU without `X-Tenant-Id`: 400
   `bad request: tenant_required`. MU with `X-Tenant-Id: B`: 403
   `forbidden: tenant_not_allowed`. MU with `M`: the grant row above, and the
   tool returns tenant M's account. MU with `A`: tenant A's grant. A1 (a
   `tenant_id` token) with `X-Tenant-Id: B`: 403 `tenant_not_allowed`.
20. Tool data isolation (P-15). The `crm` Lambda invoked directly by the
   runner (its own credentials, no `_ri_ctx`): `context_invalid`, and
   CloudTrail shows no `AssumeRole` on the tool tenant role for that call.
   A1's agent's `crm/get_account` reads tenant A's row; the tool's attempt,
   in test mode, to read tenant B's row with the same credentials:
   `AccessDeniedException`.
21. Key rotation. Mint a token (signer path, current `kid`), bump
   `transactionToken.keyGeneration` and redeploy the ingress stack; the
   JWKS lists two keys; the old token is still accepted at the tools
   gateway until `exp`; a new A1 request carries the new `kid`. Run on the
   `api-gateway` stack only.
10. Destroy; delete the Runtime's service-created log groups; assert no
   stacks, parameters, log groups or tables are left (ADR-0019). (v2) Also
   assert the tools gateway and its targets are gone, both KMS keys are
   pending deletion, and `app/use` and `entitlements/admin` are removed from
   tenant-identity if step 1 added them.

Steps 3 to 9, 9-registry and 11 to 20 run on both all-on stacks
(`api-gateway`, `agentcore-gateway`). Step 4a, the `scope: 'user'` half of 4b,
and the limits step run on their own stacks; step 21 on the `api-gateway` stack. The stacks come from
`test/integ.runtime.ts` and deploy together; the test-only mint function and its
`grantSign` exist only on the integration stacks, never in the demo stack, and
the README says so.

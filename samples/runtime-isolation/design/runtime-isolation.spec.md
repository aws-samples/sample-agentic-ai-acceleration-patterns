<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Specification: Runtime Isolation

> **Status:** Draft, 2026-10-26. Requirements and principles for the
> `runtime-isolation` sample. Items marked **[verify]** are service
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

The pattern is a core plus optional modules. The core is the trusted ingress
and the one-principal resource policy (P-1, P-3). The modules each add a
check and are off by default (P-4):

| Module | Adds | Prop |
|---|---|---|
| Session mapping | conversations that persist across requests, in a unit derived from the caller's claims, so a user resumes only their own session (P-2, ADR-0002, ADR-0013) | `session` |
| Scope checks | required OAuth scopes on the token (ADR-0005) | `requiredScopes` |
| Delegation | the user's token forwarded to the agent, optionally narrowed (P-5) | `delegation` |
| TVM | tenant-scoped AWS credentials for the agent's data access (P-8) | `tvm` |

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

The sample ships as a CDK construct, `IsolatedRuntime` (standard §4.5), with
the ingress a deploy-time choice: an Amazon API Gateway REST API with response
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
| What the agent can reach | Execution role: model invocation only; no tenant data (P-6) |
| What tenant data the agent may reach | Optional TVM: tenant-scoped credentials vended at ingress from the same claims, IAM-enforced (P-8) |
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
- Not a data-layer sample. The optional TVM (P-8) vends tenant-scoped
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

**P-4. Every optional behaviour is off by default and typed.** Session
mapping, scope checks, token forwarding, downscoping, and the TVM are props
with secure defaults. Turning one on adds a check; none removes one.

**P-5. A delegated token is the narrowest token that works, in a header the
agent asked for.** The user's JWT reaches the agent only when
`delegation.forwardUserToken` is set, in
`X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Token`, never in
`Authorization` (which carries SigV4 to the Runtime). With
`delegation.requireNarrowedToken`, the ingress refuses any bearer token whose
`scope` set is not a subset of `delegation.allowedScopes` (ADR-0006,
ADR-0007).

**P-6. The agent's own role cannot cross tenants because it holds nothing
tenant-scoped.** The execution role grants `bedrock:InvokeModel` on named
models and logs; it has no data permission. The microVM's MMDS credential is
therefore not a tenant boundary concern in this sample.

**P-7. Security first, then latency, then cost.** Both ingress options MUST
meet P-1 to P-6 identically. They are compared on measured latency
(time to first byte, total) and per-request cost, and the README states
which to prefer and why (ADR-0009).

**P-8. Tenant data is reached only with credentials vended from the validated
token, never from the agent's own role.** With `tvm` set, the ingress assumes
`tvm.role` with session tags built from the claims it has just verified
(`TenantId` always; `UserId` and allowlisted claims on opt-in) and forwards the
credentials to the backend over the transport the backend defines (§3.4;
ADR-0011). The tenant role's
policy scopes data by `${aws:PrincipalTag/TenantId}`, so a cross-tenant call
fails in IAM whatever the agent does (enforced, not filtered). The agent holds
no `sts:AssumeRole` (ADR-0012).

**P-9. Every request is attributable to a tenant in telemetry.** The ingress
writes the verified `tenant_id` (and the session prefix, never the token) as
a field in its structured logs and, on API Gateway, in the access log; it
emits per-tenant metrics for requests, 4xx/5xx, TTFB, and streamed bytes
(CloudWatch EMF), and the demo adds Contributor Insights top-tenant rules on
the access log. The Runtime's own log streams are named by session id, whose
prefix is derived from the tenant, so a session can be joined back to a
tenant through the ingress log. What the Runtime cannot carry per tenant is
listed in `architecture.md` (standard §4.4).

---

## 3. System shape

### 3.1 Components

| ID | Component | Notes |
|---|---|---|
| C-1 | **Backend: AgentCore Runtime** (the first backend, ADR-0011) | TypeScript agent, direct code deployment; IAM inbound auth; resource policy per P-1; `requireMMDSV2: true`; `requestHeaderAllowlist` holds the user-token header only when P-5 forwarding is on |
| C-2 | **Agent** | Echoes its unit id and a per-VM nonce and calls one Bedrock model; validates `prompt` is a string (Runtime best practices, input validation) |
| C-3a | **Ingress A: API Gateway** | Regional REST API, one `POST /invocations` route, Lambda request authoriser (JWT verify, P-3) and a Lambda proxy integration with `responseTransferMode: STREAM`. The integration Lambda chooses the unit (P-2) and calls `InvokeAgentRuntime` with SigV4, streaming the response back |
| C-3b | **Ingress B: AgentCore Gateway** | No protocol type; `CUSTOM_JWT` inbound authoriser on the tenant-identity pool; one Runtime target (`http.agentcoreRuntime`) with `GATEWAY_IAM_ROLE` outbound; a REQUEST interceptor Lambda that chooses the unit and overwrites the session header (P-2), and enforces P-5 |
| C-4 | **Demo app** | `src/main.ts`: reads tenant-identity's SSM parameters and instantiates the construct with one ingress |
| C-6 | **Unit module** | Shared by both ingress Lambdas: random unit id, or with `session` the claim-derived id (P-2) |
| C-7 | **TVM module** | Shared by both ingress Lambdas, optional: validated claims to session tags, `AssumeRole` + `TagSession` on `tvm.role`, per-tag-set cache, credential header (P-8) |
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
| `agent` | `{ codePath, modelId }` | required | agent code and the one model it may invoke |
| `backend` | `'agentcore-runtime'` | `'agentcore-runtime'` | the session-isolating compute service (ADR-0011) |
| `ingress` | `'api-gateway' \| 'agentcore-gateway'` | required | C-3a or C-3b; `agentcore-gateway` is valid only with the `agentcore-runtime` backend |
| `session.scope` | `'user' \| 'tenant'` | none (session mapping off: fresh unit per request) | with `session` set, conversations persist in a unit derived from the claims; `'user'` if `scope` is omitted (P-2, ADR-0013) |
| `requiredScopes` | string[] | none | if set, the token's `scope` MUST contain all of them (ADR-0005) |
| `delegation.forwardUserToken` | boolean | `false` | P-5 |
| `delegation.requireNarrowedToken` | boolean | `false` | only valid with `forwardUserToken` |
| `delegation.allowedScopes` | string[] | required when `requireNarrowedToken` | P-5 |
| `tvm.role` | `iam.IRole` | none (TVM off) | the tenant role the ingress assumes; the deployer owns its trust and ABAC policies (P-8, ADR-0012) |
| `tvm.includeUserIdTag` | boolean | `false` | add `UserId = sub` as a session tag |
| `tvm.claimTags` | `Record<string, string>` | none | extra session tags, tag key to claim name; a claim missing from the token fails the request with 403; `TenantId` and `UserId` are reserved keys |
| `tvm.durationSeconds` | number | `900` | 900 to 3600; credential lifetime |

Props are validated at synth; an invalid combination fails with the prop name.

### 3.4 Backend interface

A backend (ADR-0011) defines five things. Everything else in the construct is
backend-neutral.

| Concern | `agentcore-runtime` | A later backend supplies |
|---|---|---|
| Isolation unit (P-2) | one `runtimeSessionId`, one microVM | its own unit (function instance, container, session) |
| Invoke call | `InvokeAgentRuntime`, SigV4 | its own call |
| Who may invoke (P-1) | Runtime resource policy, ingress principal only | its own resource policy |
| Unit id transport (P-2) | `runtimeSessionId` | its own field |
| Credential and user-token transport (P-5, P-8) | allowlisted headers `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Credentials` and `...-Custom-User-Token`, base64 JSON | its own payload or context field, with V-7 repeated |

The ingress hands the backend a validated request (`tenant_id`, `sub`, the
chosen unit id, `prompt`, optional user token, optional credentials); the
backend maps it onto these and never sees the bearer token's raw
`Authorization` value.

---

## 4. Data model

No stored entities. The only derived value is the unit id (P-2):

| Field | Source | Shape |
|---|---|---|
| random id (no `session`) | `s-` + base32 of 32 random bytes, generated per request at ingress | `s-[a-z2-7]{52}` |
| prefix (`session`) | `sha256(tenant_id "|" sub)` or `sha256(tenant_id)`, base32, first 26 chars | `[a-z2-7]{26}` |
| `conversationId` (`session`) | client, in the request body, on both ingresses | `[A-Za-z0-9]{16,64}` |
| `runtimeSessionId` | the random id, or `s-<prefix>-<conversationId>` | 45 to 93 chars (Runtime minimum is 33) |

---

## 5. API surface

One operation, the same contract on both ingresses: `InvokeAgent`.

| | `api-gateway` | `agentcore-gateway` |
|---|---|---|
| URL | `POST https://<api>/prod/invocations` | `POST https://<gw>.gateway.bedrock-agentcore.<region>.amazonaws.com/<target>/invocations` |
| Auth | `Authorization: Bearer <access token>` | same |
| Body | `{prompt}`; with `session`, `{conversationId, prompt}` | same |
| Unit | chosen by the integration Lambda | chosen by the interceptor, written to `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`; a client value is overwritten (V-3) |
| Response | `text/event-stream`, streamed | same |

Errors (both): 401 missing/invalid token; 403 `tenant_id` absent, required
scope missing, or narrowed-token rule failed; 400 malformed `prompt`,
malformed `conversationId`, or `conversationId` sent without `session`. Error
bodies are fixed text and never echo the token or the unit id.

---

## 6. Contracts

### 6.1 What the deployer supplies

- An OIDC issuer whose access tokens satisfy §6.2 (the sample uses
  tenant-identity `shared-pool`; its `userPoolId` and `appClientId` SSM
  parameters give the discovery URL and client id).
- An agent code bundle and a Bedrock model id enabled in the Region.
- With `tvm`: a tenant role whose trust policy allows `sts:AssumeRole` and
  `sts:TagSession` to `tvmCallerRole` only, requires the `TenantId` request
  tag, pins `aws:TagKeys` to the tags it expects, and whose permissions scope
  every data resource by `${aws:PrincipalTag/TenantId}` (ADR-0012).

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
- With `tvm` on, the agent's credentials carry `TenantId` equal to the
  caller's `tenant_id`; a read of the caller's own tenant data succeeds and a
  read of another tenant's fails in IAM; the role cannot be assumed by the
  test runner's own credentials (integ step 8a).
- Both ingresses pass the same e2e suite; the README reports measured TTFB and
  total latency (p50, p95) and the per-request cost of each.
- `cdk destroy` leaves no stacks, log groups, or parameters with the sample's
  prefix.

### 6.4 Composition (standard §1.1)

**Consumes:** `tenant-identity`, topology `shared-pool`, through
`/application-plane/shared/identity/{userPoolId,appClientId}` (ADR-0004). Only
the demo app and the integration driver read them; the construct takes the
issuer as props.

**Published interface**, so a later sample (for example a data-layer sample
that adds tenant-scoped memory) can consume this one:

- Construct `IsolatedRuntime`, exported from `src/index.ts`, with
  read-only `endpointUrl`, `runtimeArn`, `ingressRole`, `executionRole`, and
  `tvmCallerRole` (the role that validates the token and, with `tvm`, assumes
  the tenant role: the integration Lambda or the interceptor Lambda).
- Parameters, written by the demo stack under
  `/application-plane/shared/agent-runtime/`: `endpointUrl` (the ingress
  invocation URL), `runtimeArn`, and `ingress` (`api-gateway` or
  `agentcore-gateway`).

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
3. Call `InvokeAgentRuntime` directly with the test runner's own Admin
   credentials and with a role that is not the ingress: both denied (P-1).
4a. `session` off: A1 sends two requests, the second with the first's unit id
   in the session header and a `conversationId` in the body: 400 for the
   body field; with the body fixed, two different units and nonces (P-2).
4b. `session` on: A1 opens conversation `c1`. A2 and B1 send `c1`, and also
   set the session header to A1's unit id: each lands in its own unit and
   microVM, never A1's (the agent returns its unit id and a per-VM nonce)
   (P-2).
5. `session` on: A1 resumes `c1`: same microVM (same nonce).
6. Token with no `tenant_id`, an expired token, a token from another client:
   401/403.
7. `requiredScopes` on: a token narrowed to `tenant-api/write` only is refused
   when `tenant-api/read` is required.
8. Forwarding on: the agent reports the forwarded token's `scope`; with
   `requireNarrowedToken`, an un-narrowed token is refused and a narrowed one
   accepted.
8a. TVM on: the demo table holds one item per tenant under `TENANT#<id>`. A1
   asks the agent to read tenant A's item: success (positive control). A1 asks
   it to read tenant B's item: `AccessDeniedException` from IAM. The runner
   calls `sts:AssumeRole` on the tenant role with its own credentials: denied.
   The agent reports the `TenantId` tag of its credentials via
   `sts:GetCallerIdentity` plus the session name; CloudTrail shows one
   `AssumeRole` per tenant per credential lifetime, not per request.
9. Latency probe: 20 invocations per ingress, TTFB and total, p50 and p95.
10. Destroy; assert nothing left.

Steps 3 to 8 run on both ingresses; option toggles are separate deployments
of the demo app with different context.

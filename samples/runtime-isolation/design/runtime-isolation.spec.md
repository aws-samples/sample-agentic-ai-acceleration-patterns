<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Specification: Runtime Isolation with Session Mapping

> **Status:** Draft, 2026-10-26. Requirements and principles for the
> `runtime-isolation` sample. Items marked **[verify]** are service
> behaviours the design depends on; the first spike (§7) proves them, and if
> one fails the named fallback applies and an ADR records the change.

The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

---

## 1. Problem statement

Amazon Bedrock AgentCore Runtime runs each `runtimeSessionId` in its own
microVM. A vendor can use that as a tenant boundary: build the session id from
the caller's tenant and user, and one tenant's conversation never shares a
process with another's. AgentCore does not map sessions to callers; that is
left to the vendor
([Runtime security best practices](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html)).

The obvious build is a Runtime with inbound JWT authorisation and a check in
the agent that the session id matches the token. That is **filtered**
isolation: any valid token can call the Runtime with any session id, and the
only thing between a tenant and another tenant's microVM is a line of agent
code that runs *inside* the session it is meant to guard.

This sample makes session mapping **enforced**. The Runtime trusts exactly one
IAM principal, an ingress the vendor controls. The ingress validates the user's
JWT, derives the session id from the validated `tenant_id` and `sub`, and
invokes the Runtime with SigV4. A leaked or forged JWT, or a guessed session
id, cannot reach a session the ingress would not have built for that caller.
This is the "Runtime isolation with session mapping" pattern of
[Agentic AI delegation patterns](https://builder.aws.com/content/3HBLL1UuIpyzPENldeTfjYjvGQj/agentic-ai-delegation-patterns),
Figure 3.

The pattern is not tied to AgentCore. It needs any compute service that runs
each session in its own isolated environment and lets one IAM principal be
the only caller. The construct models that as a **backend**, a typed prop
(ADR-0011). AgentCore Runtime is the first and, for now, only backend; AWS
Lambda's microVMs are a candidate for a later one. The principles (§2) are
written against the backend, and §3 maps them onto AgentCore Runtime.

The sample ships as a CDK construct, `SessionIsolatedAgentRuntime`
(standard §4.5), with the ingress a deploy-time choice: an Amazon API Gateway
REST API with response streaming, or an AgentCore Gateway with a Runtime
target. The tenant-identity sample, topology `shared-pool`, is the identity
provider.

### 1.1 Deployment model

**Pool**: one Runtime per agent, shared by every tenant; isolation per session
(per user by default, per tenant optionally). Enforced isolation at the
invocation boundary.

| Layer | What isolates tenants |
|---|---|
| Who may invoke the Runtime | Runtime resource policy: only the ingress principal (P-1) |
| Which session a request lands in | Ingress derives or checks the session id from validated claims (P-2) |
| What the agent can reach | Runtime execution role: model invocation only; no tenant data (P-6) |
| What a delegated token can do | Optional; forwarded only on opt-in, optionally narrowed (P-5) |

### 1.2 What this sample is NOT

- Not a backend catalogue. Only the AgentCore Runtime backend is built. A new
  backend is added only when it meets P-1 and P-2, proved by the same e2e
  suite (ADR-0011).

- Not an identity provider. It consumes tokens from tenant-identity's
  `shared-pool` topology; any OIDC provider that issues the §6.2 token
  contract works.
- Not a data-isolation sample. The agent holds no tenant data and no TVM
  credential. Isolating memory, RAG stores, or tools is the data layer
  (`ARCHITECTURE.md` §3.3) and belongs to a later sample that can consume
  this construct.
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

**P-1. The Runtime trusts one IAM principal, and it is the ingress.**
The Runtime uses IAM (SigV4) inbound authorisation. Its resource policy
allows `bedrock-agentcore:InvokeAgentRuntime` only for the ingress principal
and denies `InvokeAgentRuntimeForUser` and the WebSocket and command
variants to everyone. No user token can invoke the Runtime directly. Rules
out: a JWT authoriser on the Runtime as the only gate.

**P-2. The session id is a function of validated claims, never of the
request alone.** `runtimeSessionId = "s-" + base32(sha256(tenant_id "|" sub))[0:26] + "-" + conversationId`
for `sessionScope: 'user'`, and `sha256(tenant_id)` for `'tenant'`.
`conversationId` is client-chosen (16 to 64 of `[A-Za-z0-9]`), so a user can
hold several conversations, but the prefix comes only from the verified
token. The ingress always builds the id; a session id sent by the client is
ignored and overwritten (ADR-0002).

**P-3. Tenant context comes only from the validated JWT.** `tenant_id` and
`sub` are read from a token whose signature, issuer, client, expiry, and
`token_use: access` were checked at ingress. Nothing in the body, query, or a
client header names a tenant.

**P-4. Every optional behaviour is off by default and typed.** Scope checks,
token forwarding, downscoping, and the per-tenant session scope are props
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

---

## 3. System shape

### 3.1 Components

| ID | Component | Notes |
|---|---|---|
| C-1 | **Backend: AgentCore Runtime** (the first backend, ADR-0011) | TypeScript agent, direct code deployment; IAM inbound auth; resource policy per P-1; `requireMMDSV2: true`; `requestHeaderAllowlist` holds the user-token header only when P-5 forwarding is on |
| C-2 | **Agent** | Echoes the derived session prefix and calls one Bedrock model; validates `prompt` is a string (Runtime best practices, input validation) |
| C-3a | **Ingress A: API Gateway** | Regional REST API, one `POST /invocations` route, Lambda request authoriser (JWT verify, P-3) and a Lambda proxy integration with `responseTransferMode: STREAM`. The integration Lambda builds the session id (P-2) and calls `InvokeAgentRuntime` with SigV4, streaming the response back |
| C-3b | **Ingress B: AgentCore Gateway** | No protocol type; `CUSTOM_JWT` inbound authoriser on the tenant-identity pool; one Runtime target (`http.agentcoreRuntime`) with `GATEWAY_IAM_ROLE` outbound; a REQUEST interceptor Lambda that builds the session id and overwrites the session header (P-2), and enforces P-5 |
| C-4 | **Demo app** | `src/main.ts`: reads tenant-identity's SSM parameters and instantiates the construct with one ingress |
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
| `sessionScope` | `'user' \| 'tenant'` | `'user'` | isolation dimension (P-2) |
| `requiredScopes` | string[] | none | if set, the token's `scope` MUST contain all of them (ADR-0005) |
| `delegation.forwardUserToken` | boolean | `false` | P-5 |
| `delegation.requireNarrowedToken` | boolean | `false` | only valid with `forwardUserToken` |
| `delegation.allowedScopes` | string[] | required when `requireNarrowedToken` | P-5 |

Props are validated at synth; an invalid combination fails with the prop name.

---

## 4. Data model

No stored entities. The only derived value is the session id (P-2):

| Field | Source | Shape |
|---|---|---|
| prefix | `sha256(tenant_id "|" sub)` or `sha256(tenant_id)`, base32, first 26 chars | `[a-z2-7]{26}` |
| `conversationId` | client, in the request body, on both ingresses | `[A-Za-z0-9]{16,64}` |
| `runtimeSessionId` | `s-<prefix>-<conversationId>` | 45 to 93 chars (Runtime minimum is 33) |

---

## 5. API surface

One operation, the same contract on both ingresses: `InvokeAgent`.

| | `api-gateway` | `agentcore-gateway` |
|---|---|---|
| URL | `POST https://<api>/prod/invocations` | `POST https://<gw>.gateway.bedrock-agentcore.<region>.amazonaws.com/<target>/invocations` |
| Auth | `Authorization: Bearer <access token>` | same |
| Body | `{conversationId, prompt}` | same |
| Session | built by the integration Lambda | built by the interceptor, written to `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`; a client value is overwritten (V-3) |
| Response | `text/event-stream`, streamed | same |

Errors (both): 401 missing/invalid token; 403 `tenant_id` absent, required
scope missing, or narrowed-token rule failed; 400
malformed `conversationId` or `prompt`. Error bodies are fixed text and never
echo the token or the session id.

---

## 6. Contracts

### 6.1 What the deployer supplies

- An OIDC issuer whose access tokens satisfy §6.2 (the sample uses
  tenant-identity `shared-pool`; its `userPoolId` and `appClientId` SSM
  parameters give the discovery URL and client id).
- An agent code bundle and a Bedrock model id enabled in the Region.

### 6.2 Token contract

Access token, RS256, with `iss`, `exp`, `client_id`, `token_use: "access"`,
`sub`, `tenant_id` (single string), and `scope` (space-separated). A token
without `tenant_id` or with a `tenants` claim is refused (single-tenant users
only, §1.2).

### 6.3 What the sample promises

- No principal other than the ingress can invoke the Runtime (integ step 3).
- Tenant A's valid token cannot land in tenant B's session, nor user A1's in
  user A2's under `sessionScope: 'user'` (integ steps 4, 5).
- The user token reaches the agent only when forwarding is on, and only
  narrowed when `requireNarrowedToken` is on (integ steps 7, 8).
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

- Construct `SessionIsolatedAgentRuntime`, exported from `src/index.ts`, with
  read-only `endpointUrl`, `runtimeArn`, `ingressRole`, and
  `executionRole`.
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

Also seen: the same session id from both ingresses lands in the same microVM
(same per-VM nonce), and A2 using A1's `conversationId` gets a different
session and microVM. Single-call latencies were 0.2-0.3 s warm on both
ingresses; this is not the §8 step 9 measurement.

Follow-up for the design: because V-3 overwrite works, the `agentcore-gateway`
ingress builds the session id itself, as API Gateway does (ADR-0002, decided
2026-10-26). Both ingresses share one request contract.

---

## 8. Integration test outline

1. Deploy tenant-identity (`shared-pool`); create tenants A and B, users A1,
   A2, B1; issue tokens.
2. Deploy the sample with the chosen ingress.
3. Call `InvokeAgentRuntime` directly with the test runner's own Admin
   credentials and with a role that is not the ingress: both denied (P-1).
4. A1 opens conversation `c1`. A2 and B1 send `c1`, and also set the session
   header to A1's session id: each lands in its own session and microVM, never
   A1's (the agent returns its derived prefix and a per-VM nonce) (P-2).
5. A1 resumes `c1`: same microVM (same nonce).
6. Token with no `tenant_id`, an expired token, a token from another client:
   401/403.
7. `requiredScopes` on: a token narrowed to `tenant-api/write` only is refused
   when `tenant-api/read` is required.
8. Forwarding on: the agent reports the forwarded token's `scope`; with
   `requireNarrowedToken`, an un-narrowed token is refused and a narrowed one
   accepted.
9. Latency probe: 20 invocations per ingress, TTFB and total, p50 and p95.
10. Destroy; assert nothing left.

Steps 3 to 8 run on both ingresses; option toggles are separate deployments
of the demo app with different context.

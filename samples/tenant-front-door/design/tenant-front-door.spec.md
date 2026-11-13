<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant front door for agentic applications: specification

Status: Proposed. No ADRs accepted yet; §8 lists the decisions the first ADR
batch records, and §9 the spikes that must pass before code.

## 1. Problem statement

A multi-tenant agentic application serves one web client to every tenant,
and each tenant request must land on the cell that hosts the tenant. The
sample puts one Amazon CloudFront multi-tenant distribution in front of a
shared single-page application (SPA) and the cells' APIs. A CloudFront
Function, the **tenant router**, finds the request's tenant, looks it up in a
CloudFront KeyValueStore (the **route table**) and sends the request to the
tenant's cell. Each tenant stack, or the control plane's tenant create
script, registers its own route at deploy time.

The router finds the tenant in one of two ways, chosen at deploy time
(`addressing`):

| Mode | Tenants reach the app at | The router reads the tenant from |
|---|---|---|
| `single` (default) | one URL, `https://<appDomain>` | the `tenant_id` claim of the bearer token |
| `host` | one host each, `https://<tenant>.<appDomain>` | the host name |

Both modes send the same route hint to the origin, and the origin checks it
against the verified token the same way (P-4).

Deployment model: the SPA and the edge are pooled. Cells behind the edge are
whatever the control plane placed (pool, or `maxTenants: 1` for a dedicated
cell). A tenant with its own domain gets a dedicated distribution tenant on
the same distribution, in either mode.

### 1.1 What the sample shows

- Edge routing to a cell origin chosen per request, from the token's tenant
  or from the host.
- A route table at the edge: unknown tenants are refused and suspended
  tenants get 503 there. Neither reaches an origin.
- Reading a token at the edge without trusting it: the router decodes the
  tenant claim to route, and the origin verifies the token.
- A route hint the origin checks against the verified token and the tenants
  its cell hosts, so a request can only be served by its own tenant's cell.
- One web security baseline for every tenant (§7), set once at the edge.
- Per-tenant telemetry and cost attribution at the edge; a per-tenant rate
  limit at the edge in `host` mode and at the origin in `single` mode
  (decision 9).
- Agent traffic (`/agents/*`) on the same origin, streamed through to the
  agent ingress.

### 1.2 What the sample does not do yet

- Routes written from accounts other than the front door's account.
- Several Regions per tenant, failover between cells, or moving a tenant
  between cells with no downtime.
- Server-side rendering, or a backend-for-frontend that holds the tokens.
- Per-tenant SPA versions (version pinning) and staged SPA rollouts.
- A collector for browser security reports (only the endpoint is wired).

### 1.3 What the sample is NOT

- Not an identity provider. The SPA signs in against an issuer that meets
  the token contract (`ARCHITECTURE.md` §2.1).
- Not the authoriser. The edge routes; the cell's API verifies the token.
- Not the application. The demo cell API and the demo SPA exist only to
  prove the routing and the browser baseline.
- Not tenant onboarding. The control plane creates tenants; this sample
  gives it a route to write.

## 2. Guiding principles

1. **P-1: The edge reads the tenant; it never trusts it.** The router decodes
   the token's tenant claim, or reads the host, only to choose where the
   request goes and whether the tenant is live. It checks no signature and
   grants nothing. A forged claim can only send a request to a cell that
   then refuses it.
2. **P-2: The tenant comes from the token or the host, never the client.**
   No header, query parameter or path segment names the tenant. In `single`
   mode the token's claim decides; in `host` mode the host decides and the
   token must agree.
3. **P-3: The route table is vendor data.** Only vendor deploy code writes
   routes. Nothing in a request can add, change or pick a route, and every
   client `x-tenant-*` header is removed before routing.
4. **P-4: The verified token and the cell must agree.** The router forwards
   the tenant it routed on as a route hint. The origin verifies the token,
   refuses a `tenant_id` that differs from the hint, and refuses a tenant its
   cell does not host.
5. **P-5: Stop bad traffic at the edge.** Requests with no tenant, unknown
   or suspended tenants and cross-site API calls are refused before any
   origin is reached, so they cost no origin capacity.
6. **P-6: One baseline, every tenant.** Security headers come from one
   response headers policy. A tenant cannot weaken them, and an origin cannot
   drop them.
7. **P-7: Register a tenant with one write.** Onboarding a pooled tenant is
   one route write. In `host` mode the wildcard certificate and DNS record
   already cover its host. Removing it is one delete. No distribution update
   and no cache invalidation.

## 3. System shape

### 3.1 Components

| Component | Runs on | Job |
|---|---|---|
| Edge stack | ACM and AWS WAF in `us-east-1` | Certificate for `<appDomain>` (and `*.<appDomain>` in `host` mode), web ACL |
| Multi-tenant distribution | CloudFront (`ConnectionMode: tenant-only`) | Shared behaviours, policies and origins |
| Pooled distribution tenant | CloudFront distribution tenant | Serves `<appDomain>` (`single`) or `*.<appDomain>` (`host`) for every pooled tenant |
| Dedicated distribution tenant | CloudFront distribution tenant | Serves one tenant's own domain, with its own certificate and optional web ACL override |
| Tenant router | CloudFront Function (viewer request, JS 2.0) | Finds the tenant, refuses or routes |
| Route table | CloudFront KeyValueStore | `tenant`, `host` and `cell` entries (§4) |
| SPA origin | S3 bucket with origin access control | One build for every tenant |
| Cell API origin | The cell's API (demo: Lambda function URL with origin access control) | Verifies the token, checks the route hint and the cell's tenants |
| Agent route | `/agents/*` behaviour | Streams to the agent ingress of `agentic-runtime-isolation`, when configured |
| `TenantRoute` construct | Custom resource | Writes and deletes one tenant's route |
| Telemetry | CloudFront standard logs to CloudWatch Logs | Per-tenant requests, errors, bytes, latency |

### 3.2 Request paths

| Path | Behaviour | Origin | Cache | Needs a tenant |
|---|---|---|---|---|
| `/assets/*` | static | SPA bucket | one year, immutable, shared by all tenants | no |
| `/`, other SPA routes | static, rewritten to `/index.html` | SPA bucket | `no-cache`, revalidated | no |
| `/config.json` | generated at the edge | none | `no-store` | `host` mode only |
| `/api/*` | dynamic | the tenant's cell API | disabled | yes |
| `/agents/*` | dynamic, streaming | the agent ingress | disabled | yes |
| `/logout` | generated at the edge | none | `no-store` | no |

`/config.json` gives the SPA its public settings: issuer URL, client id and
scopes, plus the tenant id and display name in `host` mode. It holds nothing
secret. Serving it from the edge keeps the SPA bundle the same file for
every tenant. In `single` mode the SPA learns the tenant after sign-in, from
its own token.

### 3.3 Tenant router, step by step

On every viewer request:

1. Remove every client `x-tenant-*` header (P-3).
2. In `host` mode, or for a dedicated tenant's domain, lower-case the
   `Host` header and look up `host#<host>`. No entry: 404 with a static
   page.
3. Paths that need no tenant (§3.2) skip to step 8.
4. For `/api/*` and `/agents/*`, check `Sec-Fetch-Site`. Allow only
   `same-origin`, `none`, or no header; refuse the rest with 403 (§7.3).
5. Find the tenant:
   - `single` mode: take the `Authorization: Bearer` token, base64url-decode
     its payload without checking the signature, and read `tenant_id`. If
     the token carries a `tenants` list instead, the client names one with
     `X-Tenant-Id`, and the router accepts it only when it is in that list.
     No token, an undecodable token, or no single tenant: 401 with
     `WWW-Authenticate: Bearer`.
   - `host` mode: the tenant from step 2.
6. Look up `tenant#<tenantId>`. No entry: 403. Status `suspended`: 503 with
   `Retry-After`.
7. For `/api/*`, look up `cell#<cellId>` and set the request's origin to the
   cell's API domain with origin access control. No cell entry: 503. Add
   `x-tenant-route: <tenantId>` for `/api/*` and `/agents/*`.
8. Serve `/config.json` and `/logout` directly. Rewrite SPA routes with no
   file extension to `/index.html`.

The router reads at most three keys per request. It holds no secrets,
checks no signatures and writes nothing.

### 3.4 Identity model

- Tenant users sign in in the SPA with authorization code flow and PKCE.
  In `single` mode there is one callback URL, `https://<appDomain>/`. In
  `host` mode each tenant origin is a callback URL; Cognito allows no
  wildcards there, so spike S-4 picks between `TenantRoute` adding the
  callback URL and one shared sign-in host with a signed `state`.
- A user in several tenants (`shared-pool-multi-tenant`) holds a token with
  a `tenants` list. The SPA either sends `X-Tenant-Id` for the tenant the
  user picked, which the router checks against that list (§3.3 step 5), or
  narrows the token to one tenant first (`ARCHITECTURE.md` §2.1).
- Access tokens stay in memory in the SPA. Nothing is written to
  `localStorage`, `sessionStorage` or cookies.
- The cell API verifies the token (`ARCHITECTURE.md` §2.1), then refuses
  the request with 403 when `tenant_id` differs from `x-tenant-route` or the
  tenant is not one its cell hosts. A refusal is logged with both tenant ids.
- The agent ingress already verifies the token and selects the tenant from
  it, so it reaches the same tenant the router routed on. The router's role
  on `/agents/*` is to refuse unknown and suspended tenants at the edge.

### 3.5 Deployment inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `appDomain` | yes | | Domain the app is served at, for example `app.example.com` |
| `hostedZone` | yes | | Public Route 53 zone for `appDomain`, for the DNS records and certificate validation |
| `addressing` | no | `single` | `single`: one URL, tenant from the token. `host`: one host per tenant |
| `issuer` | yes | | Discovery URL and client id the SPA uses |
| `tenantClaim` | no | `tenant_id` | Claim the router and the origin read |
| `spaSource` | no | the demo SPA | Path of the built SPA |
| `agentIngress` | no | off | Agent ingress endpoint; omit to leave `/agents/*` off |
| `tenantRequestsPer5Min` | no | 2,000 | Per-tenant rate (decision 9) |
| `reportingEndpoint` | no | off | URL for CSP and other browser reports |

## 4. Data model

### 4.1 Route table (KeyValueStore)

| Key | Value (JSON, 1 KB max) | Written by |
|---|---|---|
| `tenant#<tenantId>` | `{"v":1,"c":"<cellId>","s":"active"\|"suspended","n":"<display name>"}` | `TenantRoute` |
| `host#<host>` | `{"v":1,"t":"<tenantId>"}` | `TenantRoute`, in `host` mode and for a dedicated tenant's domain |
| `cell#<cellId>` | `{"v":1,"o":"<api domain>","a":"<agent domain>"}` | `CellRoute` |
| `app` | `{"v":1,"iss":"<issuer>","cid":"<client id>","sc":"<scopes>"}` | the front door stack |

Rules:

- Tenant ids match `[a-z0-9-]{1,63}` and cannot start or end with `-`, so
  every tenant id is a valid DNS label in either mode.
- `<host>` is the full lower-case host name. In `host` mode pooled tenants
  use `<tenantId>.<appDomain>`; a dedicated tenant adds its own domain as
  another `host#` key.
- Reserved labels (`www`, `api`, `admin`, `auth`, `static`, `status`) are
  refused at registration.
- A tenant needs about 100 bytes in `single` mode and 150 in `host` mode,
  so one store (5 MB) holds about 30,000 to 50,000 tenants. The ceiling and
  the shard plan go in an ADR.
- Writes use the store's ETag (`IfMatch`) and retry on conflict, because
  parallel tenant stacks write the same store.

### 4.2 Route status

| Status | Edge answer | Set by |
|---|---|---|
| (no entry) | 403 (`single`) or 404 (`host`) | tenant removal, or never registered |
| `active` | routed | `TenantRoute` create |
| `suspended` | 503, `Retry-After: 300` | `TenantRoute` update, for the vendor's suspend |

A route goes live everywhere within the store's propagation time (spike S-2
measures it). Removal is a delete, not a status.

## 5. API surface

The sample has no API of its own. Its interfaces are:

- **`TenantRoute` construct**, used in a tenant stack: props `routeTable`,
  `tenantId`, `cellId`, `displayName`, `status`, optional `customDomain`.
  On create it writes the `tenant#` key and, in `host` mode, the `host#`
  key; with `customDomain` it also creates a dedicated distribution tenant
  with a CloudFront-managed certificate. On delete it removes them.
- **`CellRoute` construct**, used in a cell stack: props `routeTable`,
  `cellId`, `apiDomain`, optional `agentDomain`.
- **Script form** for the control plane: `scripts/route.sh put|delete`,
  driven by the same environment variables as the control plane's tenant
  create script, so a `CellDefinition` can register routes without CDK.

Edge errors, all with a small static HTML or JSON body and `no-store`:

| Status | When |
|---|---|
| 401 | `single` mode: no token, an undecodable token, or no single tenant |
| 403 | unknown tenant (`single`), or a cross-site call to `/api/*` or `/agents/*` |
| 404 | unknown host (`host` mode, or an unknown dedicated domain) |
| 429 | tenant over its rate (`host` mode, at the edge) |
| 503 | tenant suspended, or its cell has no route |

## 6. Contracts

### 6.1 What the deployer supplies

- A public hosted zone for `appDomain` in the front door's account.
- An issuer that meets `ARCHITECTURE.md` §2.1 and accepts the app's
  callback URLs.
- A cell API that verifies tokens, refuses a `tenant_id` that differs from
  `x-tenant-route`, and refuses tenants its cell does not host. The demo
  cell API is the reference.
- CloudFront origin access control support on the cell origin (Lambda
  function URL, or S3). Other origin types need their own origin check
  (§1.2).

### 6.2 What the sample promises

- A request with no tenant, or with an unknown or suspended tenant, never
  reaches an origin.
- A request reaches only the cell its route names.
- A forged or foreign token cannot be served: the cell it routes to
  refuses it.
- In `host` mode, a token for one tenant is refused on another tenant's
  host.
- Every response carries the §7 header set.
- Each pooled tenant is registered and removed with one route write, with
  no distribution change.
- Per-tenant requests, errors, bytes and refusals are visible.
- `cdk destroy` leaves nothing behind.

### 6.3 Samples consumed

| Sample | How | Needed for |
|---|---|---|
| `tenant-identity` `shared-pool` | its published parameters | the demo issuer and the integration test |
| `agentic-runtime-isolation` | its `/application-plane/shared/agent-runtime/ingress` parameter | `/agents/*`, optional |
| `control-plane` | its `CellDefinition` scripts call `scripts/route.sh` | onboarding, documented, not in the integration test |

### 6.4 Published interface

- **Constructs** `TenantFrontDoor`, `TenantRoute`, `CellRoute`
  (`src/index.ts`). `TenantFrontDoor` exposes `distributionId`,
  `distributionArn`, `routeTableArn`, `appDomain`, `addressing`,
  `pooledTenantId` (the distribution tenant) and `routeWriterPolicy` (a
  managed policy that may write the route table and create distribution
  tenants).
- **Published parameter** `/application-plane/shared/front-door/edge`, one
  JSON document: `version`, `appDomain`, `addressing`, `distributionId`,
  `routeTableArn`, `routeWriterPolicyArn`, `tenantClaim`, `reservedLabels`.

## 7. Web platform baseline

One response headers policy on every behaviour. The SPA is static, so CSP
uses script hashes, not nonces. The build step computes the hashes and writes
the policy.

### 7.1 Headers

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (no `preload` in the sample) |
| `Content-Security-Policy` | `default-src 'self'; script-src 'sha384-…' 'strict-dynamic' 'report-sample'; connect-src 'self' <issuer origin>; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' <issuer origin>; frame-ancestors 'none'; worker-src 'self'; require-trusted-types-for 'script'; report-to fd` |
| `Reporting-Endpoints` | `fd="<reportingEndpoint>"`, only when set |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` (sign-in is a full redirect, no popup) |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `Clear-Site-Data` | `"cookies", "storage", "cache"`, on `/logout` only |

### 7.2 SPA rules

- No HTML strings into the DOM: `textContent`, `createElement`, or
  `setHTML()` with a fallback sanitiser. Agent output is text, never HTML.
- Trusted Types enforced, with no pass-through policy.
- Same-origin API and agent calls, so no CORS is needed anywhere.
- Content-hashed asset names, so `/assets/*` can be immutable.
- Streaming agent replies render with `fetch` and a `ReadableStream`, not
  `EventSource`, so the bearer token goes in a header.
- In `single` mode every tenant shares one browser origin, so the SPA keeps
  no tenant data in persistent browser storage and clears its in-memory
  state when the user switches tenant or signs out.

### 7.3 What the browser separates

| | `single` | `host` |
|---|---|---|
| Browser origin | one for all tenants | one per tenant |
| Storage and service workers | shared, so the SPA stores none (§7.2) | separated by the browser |
| Other tenants are | `same-origin` | `same-site` |

Fetch Metadata allows `same-origin` and `none` only, in both modes. In
`host` mode every other tenant is `same-site`, so `same-site` is refused;
any cookie the application adds uses the `__Host-` prefix so no tenant host
can set one for another; and the production hardening checklist adds
`appDomain` to the Public Suffix List, so each tenant becomes its own site.
The sample documents that step and does not do it.

## 8. Decisions for the first ADR batch

| # | Decision | Options to weigh |
|---|---|---|
| 1 | Default to one URL with the tenant from the token; offer one host per tenant | token claim; host name; client header; path prefix |
| 2 | Use a CloudFront multi-tenant distribution | multi-tenant distribution with tenants; one standard distribution with a wildcard; one distribution per tenant |
| 3 | Keep the route table in CloudFront KeyValueStore | KeyValueStore; Lambda@Edge plus DynamoDB; routes in function code |
| 4 | Route to cells with CloudFront Functions origin modification | origin modification; one origin and cache behaviour per cell; Lambda@Edge |
| 5 | Route on the unverified claim, verify at the origin with a route hint | decode at the edge and verify at the origin; verify at the edge with Lambda@Edge; no hint |
| 6 | Generate `/config.json` at the edge | edge-generated; per-tenant file in S3; build per tenant |
| 7 | Keep tokens in SPA memory | memory with PKCE; backend-for-frontend with `__Host-` cookie |
| 8 | Hash-based CSP with Trusted Types | hashes; nonces through Lambda@Edge; allowlist |
| 9 | Per-tenant rate limit: AWS WAF on the host in `host` mode, the origin in `single` mode | WAF custom key; origin limit; none |
| 10 | Split the edge stack into `us-east-1` | edge stack plus main stack with cross-Region references; everything in `us-east-1` |
| 11 | Protect cell origins with origin access control | OAC on function URLs; secret header; IP allowlist |
| 12 | Route table size ceiling and sharding | one store and a ceiling; shard by distribution |

## 9. Spikes before code

Each spike reports its deploy and destroy time.

| # | Question | Pass when |
|---|---|---|
| S-1 | Does a multi-tenant distribution take a viewer-request function with an associated KeyValueStore, on both an apex and a wildcard pooled distribution tenant? | a request runs the function and reads the store in both |
| S-2 | How long does a KeyValueStore write take to apply at the edge? | median and p99 from write to first routed request |
| S-3 | Does `cf.updateRequestOrigin()` set origin access control for a Lambda function URL? | a signed request reaches a URL with `AWS_IAM` auth; an unsigned one is 403 |
| S-4 | `host` mode: how does the issuer take one callback URL per tenant at 1,000s of tenants? | a working option for Cognito app clients (limit and update rate measured), or a single sign-in host with a signed `state` |
| S-5 | Does streaming pass through `/agents/*` to the agent ingress without buffering? | first byte at the client within 1 s of first byte from the ingress |
| S-6 | Does a WAF rate rule keyed on the `Host` header count each tenant on its own? | tenant A over its limit gets 429 while tenant B is served |
| S-7 | Can the router decode a `tenant-identity` access token's payload within the CloudFront Functions limits? | `tenant_id` read from a real token; compute utilisation under 50 %; 401 on a malformed token |

## 10. Integration test outline

Runs in `eu-central-1`, with the edge stack in `us-east-1` (decision 10).
It reuses the `tenant-identity` shared pool. It needs a public hosted zone
for a test domain (open question Q-1). `test/integ.single.ts` covers the
default mode; `test/integ.host.ts` repeats the steps marked (host) with
`addressing: 'host'`.

1. Deploy the front door, one demo cell and its `CellRoute`.
2. Register tenants `a` and `b` with `TenantRoute`.
3. `/` serves the SPA with every §7.1 header.
4. `/api/whoami` with a token for `a` returns `a`; with a token for `b`
   returns `b`.
5. `/api/whoami` with no token returns 401 from the edge (no origin log
   line).
6. A token for an unregistered tenant returns 403 from the edge.
7. A token whose payload is edited to name `b`, with `a`'s signature,
   reaches `b`'s cell and is refused there with 403.
8. A client `x-tenant-route: b` header with `a`'s token is ignored.
9. `Sec-Fetch-Site: same-site` on `/api/*` returns 403.
10. A direct call to the cell's function URL, without CloudFront, returns
    403.
11. Suspend `a`: `a`'s token returns 503, `b` is still served.
12. Per-tenant log fields name `a` and `b`.
13. Delete `a`'s route: `a`'s token returns 403.
14. (host) `a.<appDomain>/config.json` names `a`; an unregistered host
    returns 404; a token for `a` on `b.<appDomain>/api/whoami` returns 403;
    `a` over its rate gets 429 while `b` is served.
15. Destroy everything except the shared identity pool.

## 11. Open questions

| # | Question | Needed by |
|---|---|---|
| Q-1 | Which public hosted zone can the test account use for `appDomain`? | spike S-1 |
| Q-2 | Should the integration test also compose `agentic-runtime-isolation` for `/agents/*`, or reuse a deployment only when one is found? | integration test |
| Q-3 | Does the dedicated tenant (custom domain) path belong in this sample or in a follow-up? | scope |

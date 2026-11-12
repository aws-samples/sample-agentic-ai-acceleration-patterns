<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant front door for agentic applications: specification

Status: Proposed. No ADRs accepted yet; §8 lists the decisions the first ADR
batch records, and §9 the spikes that must pass before code.

## 1. Problem statement

A multi-tenant agentic application serves one web client to every tenant.
Each tenant reaches it at its own address, and each request must land on the
cell that hosts the tenant. The sample puts one Amazon CloudFront
multi-tenant distribution in front of a shared single-page application (SPA)
and the cells' APIs. A CloudFront Function, the **tenant router**, reads the
host name, looks the tenant up in a CloudFront KeyValueStore (the **route
table**) and sends the request to the tenant's cell. Each tenant stack, or
the control plane's tenant create script, registers its own route at deploy
time.

Deployment model: the SPA and the edge are pooled. Cells behind the edge are
whatever the control plane placed (pool, or `maxTenants: 1` for a dedicated
cell). A tenant with its own domain gets a dedicated distribution tenant on
the same distribution.

### 1.1 What the sample shows

- One origin per tenant (`<tenant>.<appDomain>`), so the browser keeps each
  tenant's storage, service workers and cookies apart.
- A route table at the edge: unknown hosts get 404 from the edge, and
  suspended tenants get 503 there too. Neither reaches an origin.
- Edge routing to a cell origin chosen per request.
- A route hint the origin checks against the verified token, so a token for
  tenant A is refused on tenant B's host.
- One web security baseline for every tenant (§7), set once at the edge.
- Per-tenant rate limit, telemetry and cost attribution at the edge.
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

1. **P-1: The edge routes; it never authorises.** The router decides where a
   request goes and whether the host is a live tenant. Whether the caller may
   act for that tenant is decided at the origin from a verified token. The
   edge never reads a token.
2. **P-2: One tenant, one browser origin.** Each tenant has its own host
   name, so the browser's same-origin policy separates tenants' storage and
   scripts. Paths under one host never carry the tenant.
3. **P-3: The route table is vendor data.** Only vendor deploy code writes
   routes. Nothing in a request can add, change or pick a route, and any
   client header that looks like a route hint is removed before routing.
4. **P-4: The host and the token must agree.** The router forwards the
   tenant id it resolved as a route hint. The origin refuses a request whose
   verified `tenant_id` differs from the hint. Neither one is enough alone.
5. **P-5: Stop bad traffic at the edge.** Unknown hosts, suspended tenants,
   cross-site API calls and over-limit tenants are refused before any origin
   is reached, so they cost no origin capacity.
6. **P-6: One baseline, every tenant.** Security headers come from one
   response headers policy. A tenant cannot weaken them, and an origin cannot
   drop them.
7. **P-7: Register a tenant with one write.** Onboarding a pooled tenant is
   one route write; the wildcard certificate and DNS record already cover
   its host. Removing it is one delete. No distribution update and no cache
   invalidation.

## 3. System shape

### 3.1 Components

| Component | Runs on | Job |
|---|---|---|
| Edge stack | ACM and AWS WAF in `us-east-1` | Wildcard certificate for `*.<appDomain>`, web ACL with the per-tenant rate rule |
| Multi-tenant distribution | CloudFront (`ConnectionMode: tenant-only`) | Shared behaviours, policies and origins |
| Pooled distribution tenant | CloudFront distribution tenant | Serves `*.<appDomain>` for every pooled tenant |
| Dedicated distribution tenant | CloudFront distribution tenant | Serves one tenant's own domain, with its own certificate and optional web ACL override |
| Tenant router | CloudFront Function (viewer request, JS 2.0) | Resolves host to tenant and cell, refuses or routes |
| Route table | CloudFront KeyValueStore | `host` and `cell` entries (§4) |
| SPA origin | S3 bucket with origin access control | One build for every tenant |
| Cell API origin | The cell's API (demo: Lambda function URL with origin access control) | Verifies the token and checks the route hint |
| Agent route | `/agents/*` behaviour | Streams to the agent ingress of `agentic-runtime-isolation`, when configured |
| `TenantRoute` construct | Custom resource | Writes and deletes one tenant's route |
| Telemetry | CloudFront standard logs to CloudWatch Logs | Per-tenant requests, errors, bytes, latency |

### 3.2 Request paths

All paths share one host, `https://<tenant>.<appDomain>`:

| Path | Behaviour | Origin | Cache |
|---|---|---|---|
| `/assets/*` | static | SPA bucket | one year, immutable, shared by all tenants |
| `/`, other SPA routes | static, rewritten to `/index.html` | SPA bucket | `no-cache`, revalidated |
| `/tenant.json` | generated at the edge | none | `no-store` |
| `/api/*` | dynamic | the tenant's cell API | disabled |
| `/agents/*` | dynamic, streaming | the agent ingress | disabled |
| `/logout` | generated at the edge | none | `no-store` |

`/tenant.json` gives the SPA its public settings: tenant id, display name,
issuer URL, client id and scopes. It holds nothing secret. Serving it from
the edge means the SPA bundle is the same file for every tenant.

### 3.3 Tenant router, step by step

On every viewer request:

1. Remove client headers `x-tenant-route`, `x-tenant-cell` and any other
   `x-tenant-*` header (P-3).
2. Lower-case the `Host` header and look up `host#<host>`. No entry: return
   404 with a static page. Status `suspended`: return 503 with
   `Retry-After`.
3. For `/api/*` and `/agents/*`, check `Sec-Fetch-Site`. Allow only
   `same-origin`, `none`, or no header. Refuse `same-site` with 403, because
   every other tenant is same-site (§7.3).
4. For `/api/*`, look up `cell#<cellId>` and set the request's origin to the
   cell's API domain with origin access control. No cell entry: 503.
5. Add `x-tenant-route: <tenantId>` for `/api/*` and `/agents/*`.
6. Serve `/tenant.json` and `/logout` directly. Rewrite SPA routes with no
   file extension to `/index.html`.

The router reads at most two keys per request. It holds no secrets and
writes nothing.

### 3.4 Identity model

- Tenant users sign in in the SPA with authorization code flow and PKCE
  against the issuer in `/tenant.json`. The redirect URI is the tenant's own
  origin, so the app client needs one callback URL per tenant. Cognito
  allows no wildcards there; spike S-4 picks between `TenantRoute` adding the
  callback URL and one shared sign-in host with a signed `state`.
- Access tokens stay in memory in the SPA. Nothing is written to
  `localStorage`, `sessionStorage` or cookies.
- The cell API verifies the token (`ARCHITECTURE.md` §2.1), then compares
  `tenant_id` with `x-tenant-route`. A mismatch is 403 and is logged with
  both tenant ids.
- The agent ingress already verifies the token and selects the tenant. It
  gets the same route hint check through an ingress option (open question
  Q-3).

### 3.5 Deployment inputs

| Input | Required | Meaning |
|---|---|---|
| `appDomain` | yes | Parent domain, for example `app.example.com` |
| `hostedZone` | yes | Public Route 53 zone for `appDomain`, for the wildcard record and certificate validation |
| `issuer` | yes | Discovery URL and client id the SPA uses |
| `spaSource` | no | Path of the built SPA; the demo SPA by default |
| `agentIngress` | no | Agent ingress endpoint; omit to leave `/agents/*` off |
| `tenantRequestsPer5Min` | no | WAF rate per tenant host, default 2,000 |
| `reportingEndpoint` | no | URL for CSP and other browser reports; reporting is off without it |

## 4. Data model

### 4.1 Route table (KeyValueStore)

| Key | Value (JSON, 1 KB max) | Written by |
|---|---|---|
| `host#<host>` | `{"v":1,"t":"<tenantId>","c":"<cellId>","s":"active"\|"suspended","n":"<display name>"}` | `TenantRoute` |
| `cell#<cellId>` | `{"v":1,"o":"<api domain>","a":"<agent domain>"}` | `CellRoute` |
| `app` | `{"v":1,"iss":"<issuer>","cid":"<client id>","sc":"<scopes>"}` | the front door stack |

Rules:

- `<host>` is the full lower-case host name. Pooled tenants use
  `<tenantId>.<appDomain>`; dedicated tenants add their own domain as a
  second `host#` key with the same tenant id.
- Tenant ids match `[a-z0-9-]{1,63}` and cannot start or end with `-`, so
  every tenant id is a valid DNS label.
- Reserved labels (`www`, `api`, `admin`, `auth`, `static`, `status`) are
  refused at registration.
- A `host#` value stays near 100 bytes, so one store (5 MB) holds about
  40,000 hosts. The ceiling and the shard plan go in an ADR.
- Writes use the store's ETag (`IfMatch`) and retry on conflict, because
  parallel tenant stacks write the same store.

### 4.2 Route status

| Status | Edge answer | Set by |
|---|---|---|
| (no entry) | 404 | tenant removal, or never registered |
| `active` | routed | `TenantRoute` create |
| `suspended` | 503, `Retry-After: 300` | `TenantRoute` update, for the vendor's suspend |

A route goes live everywhere within the store's propagation time (spike S-2
measures it). Removal is a delete, not a status.

## 5. API surface

The sample has no API of its own. Its interfaces are:

- **`TenantRoute` construct**, used in a tenant stack: props `routeTable`,
  `tenantId`, `cellId`, `displayName`, `status`, optional `customDomain`.
  On create it writes `host#` keys (and, with `customDomain`, a dedicated
  distribution tenant with a CloudFront-managed certificate). On delete it
  removes them.
- **`CellRoute` construct**, used in a cell stack: props `routeTable`,
  `cellId`, `apiDomain`, optional `agentDomain`.
- **Script form** for the control plane: `scripts/route.sh put|delete`,
  driven by the same environment variables as the control plane's tenant
  create script, so a `CellDefinition` can register routes without CDK.

Edge errors, all with a small static HTML or JSON body and `no-store`:

| Status | When |
|---|---|
| 404 | unknown host |
| 403 | cross-site call to `/api/*` or `/agents/*` |
| 429 | tenant over its WAF rate |
| 503 | tenant suspended, or its cell has no route |

## 6. Contracts

### 6.1 What the deployer supplies

- A public hosted zone for `appDomain` in the front door's account.
- An issuer that meets `ARCHITECTURE.md` §2.1 and accepts the tenant origins
  as redirect URIs.
- A cell API that verifies tokens and refuses a `tenant_id` that differs
  from `x-tenant-route`. The demo cell API is the reference.
- CloudFront origin access control support on the cell origin (Lambda
  function URL, or S3). Other origin types need their own origin check
  (§1.2).

### 6.2 What the sample promises

- An unknown or suspended host never reaches an origin.
- A request reaches only the cell its route names.
- A token for one tenant is refused on another tenant's host.
- Every response carries the §7 header set.
- Each pooled tenant is registered and removed with one route write, with
  no distribution change.
- Per-tenant requests, errors, bytes and rate-limit hits are visible.
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
  `distributionArn`, `routeTableArn`, `appDomain`, `pooledTenantId`
  (the distribution tenant) and `routeWriterPolicy` (a managed policy that
  may write the route table and create distribution tenants).
- **Published parameter** `/application-plane/shared/front-door/edge`, one
  JSON document: `version`, `appDomain`, `distributionId`, `routeTableArn`,
  `routeWriterPolicyArn`, `reservedLabels`.

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

### 7.3 Why sibling tenants are not trusted

Every tenant host shares the registrable domain `appDomain`, so to the
browser all tenants are **same-site**. Three rules follow:

1. Fetch Metadata allows `same-origin` only, never `same-site` (§3.3 step 3).
2. Any cookie the application adds uses the `__Host-` prefix, so no tenant
   host can set a cookie for another.
3. Production hardening: add `appDomain` to the Public Suffix List, so each
   tenant becomes its own site. The sample documents the step and does not
   do it.

## 8. Decisions for the first ADR batch

| # | Decision | Options to weigh |
|---|---|---|
| 1 | Address tenants by subdomain | subdomain; path prefix `/t/<id>`; header |
| 2 | Use a CloudFront multi-tenant distribution | multi-tenant distribution with tenants; one standard distribution with a wildcard; one distribution per tenant |
| 3 | Keep the route table in CloudFront KeyValueStore | KeyValueStore; Lambda@Edge plus DynamoDB; routes in function code |
| 4 | Route to cells with CloudFront Functions origin modification | origin modification; one origin and cache behaviour per cell; Lambda@Edge |
| 5 | Verify tokens at the origin and send a route hint | origin only with hint; Lambda@Edge JWT check; no hint |
| 6 | Generate `/tenant.json` at the edge | edge-generated; per-tenant file in S3; build per tenant |
| 7 | Keep tokens in SPA memory | memory with PKCE; backend-for-frontend with `__Host-` cookie |
| 8 | Hash-based CSP with Trusted Types | hashes; nonces through Lambda@Edge; allowlist |
| 9 | Per-tenant rate limit in AWS WAF keyed on host | WAF custom key; none; at the origin |
| 10 | Split the edge stack into `us-east-1` | edge stack plus main stack with cross-Region references; everything in `us-east-1` |
| 11 | Protect cell origins with origin access control | OAC on function URLs; secret header; IP allowlist |
| 12 | Route table size ceiling and sharding | one store and a ceiling; shard by distribution |

## 9. Spikes before code

Each spike reports its deploy and destroy time.

| # | Question | Pass when |
|---|---|---|
| S-1 | Does a multi-tenant distribution take a viewer-request function with an associated KeyValueStore, and a wildcard pooled distribution tenant? | a request to `a.<appDomain>` runs the function and reads the store |
| S-2 | How long does a KeyValueStore write take to apply at the edge? | median and p99 from write to first routed request |
| S-3 | Does `cf.updateRequestOrigin()` set origin access control for a Lambda function URL? | a signed request reaches a URL with `AWS_IAM` auth; an unsigned one is 403 |
| S-4 | How does the issuer take one redirect URI per tenant at 1,000s of tenants? | a working option for Cognito app clients (limit and update rate measured), or a single redirect host with a signed `state` |
| S-5 | Does streaming pass through `/agents/*` to the agent ingress without buffering? | first byte at the client within 1 s of first byte from the ingress |
| S-6 | Does a WAF rate rule keyed on the `Host` header count each tenant on its own? | tenant A over its limit gets 429 while tenant B is served |

## 10. Integration test outline

Runs in `eu-central-1`, with the edge stack in `us-east-1` (decision 10).
It reuses the `tenant-identity` shared pool. It needs a public hosted zone
for a test domain (open question Q-1).

1. Deploy the front door, one demo cell and its `CellRoute`.
2. Register tenants `a` and `b` with `TenantRoute`.
3. `a.<appDomain>/` serves the SPA with every §7.1 header.
4. `a.<appDomain>/tenant.json` names tenant `a`; `b` names `b`.
5. An unregistered host returns 404 from the edge (no origin log line).
6. A token for `a` on `a.<appDomain>/api/whoami` returns `a`.
7. A token for `a` on `b.<appDomain>/api/whoami` returns 403.
8. A client `x-tenant-route: b` header on `a`'s host is ignored.
9. `Sec-Fetch-Site: same-site` on `/api/*` returns 403.
10. A direct call to the cell's function URL, without CloudFront, returns 403.
11. Suspend `a`: its host returns 503, `b` is still served.
12. Push `a` over its rate: 429 for `a`, `b` still served.
13. Per-tenant log fields name `a` and `b`.
14. Delete `a`'s route: its host returns 404.
15. Destroy everything except the shared identity pool.

## 11. Open questions

| # | Question | Needed by |
|---|---|---|
| Q-1 | Which public hosted zone can the test account use for `appDomain`? | spike S-1 |
| Q-2 | Should the integration test also compose `agentic-runtime-isolation` for `/agents/*`, or reuse a deployment only when one is found? | integration test |
| Q-3 | Does `agentic-runtime-isolation`'s ingress take an option to check `x-tenant-route`, or does the front door check it in a small proxy? | decision 5 |
| Q-4 | Does the dedicated tenant (custom domain) path belong in this sample or in a follow-up? | scope |

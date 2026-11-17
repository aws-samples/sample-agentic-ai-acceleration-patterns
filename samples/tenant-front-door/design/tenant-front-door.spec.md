<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant front door for agentic applications: specification

Status: Proposed. §8 lists the decisions, all Accepted. One spike is
still open, S-5 (`/agents/*` streaming, §9); if it fails it reopens the
`/agents/*` origin request policy in ADR-0011.

## 1. Problem statement

A multi-tenant agentic application serves one web client to every tenant,
and each tenant request must land on the cell that hosts the tenant. The
control plane places those cells across many AWS accounts: vendor-owned
accounts that fill and overflow, and tenant-owned accounts a tenant
registers for its own deployments. The sample puts one Amazon CloudFront
multi-tenant distribution, in one **edge account**, in front of a shared
single-page application (SPA) and every cell's API, wherever the cell lives.
A CloudFront Function, the **tenant router**, finds the request's tenant,
looks it up in a CloudFront KeyValueStore (the **route table**) and sends the
request to the tenant's cell. Cell and tenant scripts, running in the cell's
own account, register their routes through a **route registrar** in the
edge account, which accepts a route only when the control plane says that
cell or deployment lives in the calling account.

The router finds the tenant in one of two ways, chosen at deploy time
(`addressing`):

| Mode | Tenants reach the app at | The router reads the tenant from |
|---|---|---|
| `single` (default) | one URL, `https://<appDomain>` | the `tenant_id` claim of the bearer token |
| `host` | one host each, `https://<tenant>.<appDomain>` | the host name |

Both modes send the same route hint to the origin, and the origin checks it
against the verified token the same way (P-4).

Deployment model: the SPA and the edge are pooled, one front door per
control-plane application. Cells behind the edge are whatever the control
plane placed (pool, or `maxTenants: 1` for a dedicated cell), in whichever
registered account it placed them. A tenant with its own domain gets a
dedicated distribution tenant on the same distribution, in either mode.

### 1.1 What the sample shows

- Edge routing to a cell origin chosen per request, from the token's tenant
  or from the host, across vendor-owned and tenant-owned accounts.
- Cross-account route registration that an account can only use for its own
  cells and deployments, checked against the control plane.
- A route table at the edge: unknown tenants are refused and suspended
  tenants get 503 there. Neither reaches an origin.
- Reading a token at the edge without trusting it: the router decodes the
  tenant claim to route, and the origin verifies the token.
- A route hint the origin checks against the verified token and the tenants
  its cell hosts, so a request can only be served by its own tenant's cell.
- One web security baseline for every tenant (§7), set once at the edge.
- Per-tenant telemetry and cost attribution at the edge; a per-tenant rate
  limit at the edge in `host` mode and at the origin in `single` mode
  (ADR-0009).
- Agent traffic (`/agents/*`) on the same origin, streamed through to the
  agent ingress.

### 1.2 What the sample does not do yet

- Several Regions per tenant, failover between cells, or moving a tenant
  between cells with no downtime.
- Server-side rendering, or a backend-for-frontend that holds the tokens.
- Per-tenant SPA versions (version pinning) and staged SPA rollouts.
- A collector for browser security reports (only the endpoint is wired).
- Origins other than Lambda function URLs and S3 (§6.1).

### 1.3 What the sample is NOT

- Not an identity provider. The SPA signs in against an issuer that meets
  the token contract (`ARCHITECTURE.md` §2.1).
- Not the authoriser. The edge routes; the cell's API verifies the token.
- Not the application. The demo cell API and the demo SPA exist only to
  prove the routing and the browser baseline.
- Not tenant onboarding or placement. The control plane creates tenants and
  places them in cells; this sample gives its scripts a route to register
  and reads the placement back to check it.

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
3. **P-3: The route table is vendor data.** Only the route registrar writes
   routes. Nothing in a request can add, change or pick a route, and every
   client `x-tenant-*` header is removed before routing.
4. **P-4: The verified token and the cell must agree.** The router forwards
   the tenant it routed on as a route hint. The origin verifies the token,
   refuses a `tenant_id` that differs from the hint, and refuses a tenant its
   cell does not host.
5. **P-5: An account routes traffic only to itself.** The registrar takes
   the calling account from the signed request, never from its body, and
   accepts a route only when the control plane places that cell or
   deployment in that account. A tenant-owned account controls its own
   credentials, so this is the wall that stops it pointing another tenant's
   traffic at its own cell.
6. **P-6: Placement has one source of truth.** The control plane owns where
   each cell and deployment lives. The registrar reads it back on every
   write and keeps no placement data of its own.
7. **P-7: Stop bad traffic at the edge.** Requests with no tenant, unknown
   or suspended tenants and cross-site API calls are refused before any
   origin is reached, so they cost no origin capacity.
8. **P-8: One baseline, every tenant.** Security headers come from one
   response headers policy. A tenant cannot weaken them, and an origin cannot
   drop them.
9. **P-9: Register a tenant with one call.** Onboarding a pooled tenant is
   one registrar call from its tenant create script. In `host` mode the
   wildcard certificate and DNS record already cover its host. Removing it
   is one call from the delete script. No distribution update and no cache
   invalidation.

## 3. System shape

### 3.1 Components

| Component | Account | Runs on | Job |
|---|---|---|---|
| Edge stack | edge, `us-east-1` | ACM and AWS WAF | Certificate for `<appDomain>` (and `*.<appDomain>` in `host` mode), web ACL |
| Edge logging stack | edge, `us-east-1` | CloudWatch Logs delivery | Standard logging v2 for the distribution: the delivery source, the delivery destination and the log group it points at (a CloudWatch Logs delivery cannot cross Regions, spike S-1) and the delivery, all in `us-east-1`, deployed after the main stack. The delivery lists its record fields and leaves out `cs-uri-query`, which on the sign-in host carries authorization codes (§3.5, ADR-0010) |
| Multi-tenant distribution | edge | CloudFront (`ConnectionMode: tenant-only`) | Shared behaviours, policies and origins |
| Pooled distribution tenant | edge | CloudFront distribution tenant | Serves `<appDomain>` (`single`) or `*.<appDomain>` (`host`) for every pooled tenant |
| Dedicated distribution tenant | edge | CloudFront distribution tenant | Serves one tenant's own domain, with its own certificate and optional web ACL override |
| Tenant router | edge | CloudFront Function (viewer request, JS 2.0) | Finds the tenant, refuses or routes. In `host` mode it also mints and checks the signed sign-in `state` and starts sign-out (§3.5, ADR-0016) |
| Route table | edge | CloudFront KeyValueStore | `tenant`, `host` and `cell` entries, the `app` settings and, in `host` mode, the `signin` key (§4) |
| Route registrar | edge | API Gateway (IAM auth) and Lambda | The only writer of the route table; checks each write against the control plane (§3.4) |
| SPA origin | edge | S3 bucket with origin access control | One build for every tenant |
| Cell API origin | the cell's | The cell's API (demo: Lambda function URL with origin access control) | Verifies the token, checks the route hint and the cell's tenants |
| `CellRouteAccess` construct | the cell's | Lambda permission | Grants `cloudfront.amazonaws.com` `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, conditioned on the edge distribution's ARN |
| Agent route | edge | `/agents/*` behaviour | Streams to the agent ingress of `agentic-runtime-isolation`, when configured, with the `Managed-AllViewerExceptHostHeader` origin request policy |
| `route.sh` | the cell's | the control plane's cell and tenant scripts | Calls the registrar with the script's own credentials |
| Telemetry | edge | CloudFront standard logging v2: delivery source, delivery destination, delivery and log group in `us-east-1` (ADR-0010) | Per-tenant requests, errors, bytes, latency, from the record fields the delivery lists (such as `x-host-header`, `cs-uri-stem`, `sc-status`, `sc-bytes`, `time-taken`, `x-edge-result-type`), never `cs-uri-query` |

### 3.2 Request paths

| Path | Behaviour | Origin | Cache | Needs a tenant |
|---|---|---|---|---|
| `/assets/*` | static | SPA bucket | one year, immutable, shared by all tenants | no |
| `/`, other SPA routes | static, rewritten to `/index.html` | SPA bucket | `no-cache`, revalidated | no |
| `/config.json` | generated at the edge | none | `no-store` | `host` mode only |
| `/api/*` | dynamic | the tenant's cell API, in the cell's account | disabled | yes |
| `/agents/*` | dynamic, streaming | the agent ingress | disabled | yes |
| `/logout` | generated at the edge: 302 to the issuer's logout endpoint (§3.5) | none | `no-store` | no (`host` mode: a registered pooled host, §3.3 step 2) |
| `/signin-state` | generated at the edge, `host` mode only | none | `no-store` | yes, on a pooled host |
| `login.<appDomain>/callback`, `/logout` | the sign-in host, `host` mode only: 302, a static signed-out page, or 400 | none | `no-store` | no (§3.3 step 2) |

`/agents/*` uses the managed origin request policy
`Managed-AllViewerExceptHostHeader`. It forwards `Authorization` on `GET`
and `POST`, and it does not forward `Host`.

`/config.json` gives the SPA its public settings: the issuer's authorize
and token endpoints, client id and scopes, plus the tenant id
(upper-cased back to its control-plane form, which the token exchange
expects), display name and `redirectUri`
(`https://login.<appDomain>/callback`) in `host` mode. It holds nothing
secret. The SPA does not fetch the issuer's discovery document (§7.1).
On a dedicated domain in `host` mode it also names `pooledHost`,
`<tenant>.<appDomain>`, where the SPA sends the user to sign in (§3.5).
Serving the file from the edge keeps the SPA bundle the same file for
every tenant. In `single` mode the SPA learns the tenant after sign-in, from
its own token.

### 3.3 Tenant router, step by step

On every viewer request:

1. Remove every client `x-tenant-*` header (P-3).
2. Lower-case the `Host` header. `appDomain` is a constant compiled into
   the function; no key holds it. A **pooled host** matches
   `^[a-z0-9-]{1,63}\.<appDomain>$` and its label is not reserved
   (§4.1): one label under `appDomain`, covered by the vendor's
   wildcard DNS record and certificate. In `host` mode, when the host
   is `login.<appDomain>`, answer as the sign-in host and stop (§3.5,
   ADR-0016), before any `host#` lookup, because
   `host#login.<appDomain>` does not exist. `/callback` with a `state`
   and either `code` or `error`: read the `signin` key; verify the
   `state`'s `kid` and HMAC; check that `h` is a pooled host, that
   `host#<h>` exists and that its tenant is `active`. When the `state`
   is unexpired and carries a nonce `n`, answer 302 to
   `https://<h>/callback` with the same `state` and `code`, or `error`
   and `error_description`. When it has expired or has no `n`, answer
   302 to `https://<h>/` without the code, so the SPA starts sign-in
   again. `/logout`: 200 with a static "signed out" page that names no
   tenant, a harmless landing that no flow redirects to. Anything
   else, or any failed check: 400 with a static body. Otherwise, in
   `host` mode or for a dedicated tenant's domain, look up
   `host#<host>`. No entry: 404 with a static page.
3. Paths that need no tenant (§3.2) skip to step 8, and so does
   `/signin-state` in `single` mode.
4. For `/api/*`, `/agents/*` and `/signin-state`, check `Sec-Fetch-Site`.
   Allow only `same-origin`, `none`, or no header; refuse the rest with
   403 (§7.3).
5. Find the tenant:
   - `single` mode: take the `Authorization: Bearer` token, base64url-decode
     its payload without checking the signature, read `tenant_id`, and
     lower-case it. No token, an undecodable token, or no single `tenant_id` (a token with a
     `tenants` list included): 401 with `WWW-Authenticate: Bearer`. The SPA
     narrows a `tenants` token first (§3.5).
   - `host` mode: the tenant from step 2. `/signin-state` therefore gets
     404 for an unknown host and 503 for a suspended tenant (step 6), so
     a `state` is minted only for an active tenant.
6. Look up `tenant#<tenantId>`. No entry: 403. Status `suspended`: 503 with
   `Retry-After`.
7. For `/api/*`, look up `cell#<cellId>` and set the request's origin to the
   cell's API domain with origin access control. No cell entry: 503.
   Origin access control signs the request and overwrites `Authorization`,
   so copy the bearer token into `x-tenant-token` (ADR-0011). Add
   `x-tenant-route: <tenantId>`, with the lower-case id, for `/api/*` and
   `/agents/*`. The `/api/*` origin request policy forwards `x-tenant-token`
   and `x-tenant-route`. `/agents/*` goes to the single `agentIngress`
   input, an origin without origin access control (the API Gateway or
   AgentCore Gateway ingress of `agentic-runtime-isolation`). Its origin
   request policy, `Managed-AllViewerExceptHostHeader`, forwards
   `Authorization` on `GET` and `POST` and does not forward `Host`.
8. Serve `/config.json` and `/logout` directly (§3.5). In `host` mode
   also serve `/signin-state` (§3.5), which answers 400 unless `nonce` is
   16 to 64 base64url characters; in `single` mode it is 404. In `host`
   mode `/signin-state` and `/logout` mint a `state` only on a pooled
   host (step 2); on a dedicated domain both answer 400. Rewrite SPA
   routes with no file extension to `/index.html`.

The router reads at most three keys per request. It checks no token
signatures and writes nothing. In `single` mode it holds no secrets. In
`host` mode it holds one, the sign-in HMAC key in the `signin` entry
(§3.5, ADR-0016).

### 3.4 Route registrar, step by step

The registrar is a regional API in the edge account with `AWS_IAM`
authorisation. Its resource policy admits callers whose
`aws:PrincipalArn` is a `<fleet>-cell-provisioning` or
`<fleet>-tenant-provisioning` role in any account, plus the edge account's
own operator role. The policy also carries an explicit `Deny` with
`ArnNotLike` on `aws:PrincipalArn` for every other principal: without it,
any principal in the edge account whose identity policy allows
`execute-api:Invoke` gets in, because a same-account call needs only one
of the two policies to allow it (spike S-8). Admission only gets a caller
to the checks below; it grants no route.

On every write:

1. Take the caller's account id and role from the signed request context.
   Ignore any account id in the body.
2. Read the placement from the control plane API with a reader token
   (control-plane R-36): the registrar's own app client on the vendor IdP,
   whose `role` is one of the control plane's `readerRoles`, so the
   registrar can read placement and change nothing:
   - cell route: `GetCell(cellId)`;
   - tenant route: `GetDeployment(tenantId, applicationId)`, where
     `applicationId` is the front door's own.
3. Refuse with 403 when the record is missing, belongs to another
   application, or its `accountId` differs from the caller's account. A
   cell route needs a cell provisioning role; a tenant route needs a tenant
   provisioning role.
4. A tenant route also needs its cell's route to exist, written by the same
   account: 409 otherwise.
5. Write the route table with the store's ETag (`IfMatch`), retrying on a
   conflict, and record the caller's account in the value.
6. Log the caller account, role, key and outcome, never the body.

Deletes run steps 1 and 6 and need the caller's account to match the
account recorded on the route, so cleanup works after the control plane has
already removed the record (P-9 of the control plane: cleanup is always
reachable). Status changes (`suspended`, `active`) are vendor operations:
only the edge account's operator role may make them.

### 3.5 Identity model

- Tenant users sign in in the SPA with authorization code flow and PKCE.
  In `single` mode there is one callback URL, `https://<appDomain>/`. In
  `host` mode the one callback URL is a shared sign-in host,
  `https://login.<appDomain>/callback`. A per-tenant URL would cap a
  pool at 100 URLs per client and 15 client updates per second (spike
  S-4, ADR-0016). The `host` mode flow:
  1. The SPA on `<tenant>.<appDomain>` makes a nonce and a PKCE verifier,
     saves both in `sessionStorage`, and calls
     `GET /signin-state?nonce=<base64url>` on its own host. The router
     (§3.3 steps 4 to 8) answers `{"state":"..."}` with `no-store`.
  2. The SPA navigates to the authorize endpoint from `/config.json` with
     `redirect_uri=https://login.<appDomain>/callback` (`redirectUri`),
     the `state` and the code challenge.
  3. The issuer redirects to the sign-in host, which §3.3 step 2 checks
     and redirects to `https://<h>/callback` with the code and `state`.
  4. On `/callback` the SPA refuses the callback unless the `state`'s `n`
     equals its saved nonce, exchanges the code with the saved verifier
     and the same `redirect_uri`, and deletes both saved values on every
     outcome. A callback with `error` gets a fixed message; the SPA
     never renders `error_description` as HTML (§7.2).
  5. Sign-out: `/logout` on the tenant host answers 302 to the issuer's
     logout endpoint with `client_id=<cid>`, `response_type=code`,
     `scope=openid`, `redirect_uri=https://login.<appDomain>/callback`
     and a `state` the router mints for that host with no `n`, plus
     `Clear-Site-Data: "storage", "cache"` (§7.1). Cognito signs the
     user out and shows its sign-in page, keeping the `state` (spike
     S-4o). After sign-in the sign-in host gets the code with that
     `state`, which has no `n`, so it answers 302 to `https://<h>/`
     without the code. The SPA then starts sign-in at step 1, and the
     issuer's new session answers without the sign-in form. That code
     was issued without a PKCE challenge, so `client_id` and the
     `redirect_uri` are enough to redeem it. It reaches only
     `login.<appDomain>`, which drops it, and it is not logged: the
     access log leaves out the query string (§3.1).
- The `state` is `base64url(payload) + "." + base64url(HMAC)`, where the
  HMAC is HMAC-SHA256 over the encoded payload with the `signin` key
  named by `cur`. The payload is
  `{"v":1,"kid":"<key id>","h":"<tenant host>","n":"<nonce>","exp":<unix seconds>}`,
  with `exp` 10 minutes out. `h` is the request's lower-cased `Host`, so
  a tenant host cannot mint a `state` for another host. `/signin-state`
  copies the SPA's nonce into `n`; the `state` that `/logout` mints has
  no `n`. A replayed `state` yields no token, because the replayer lacks
  the PKCE verifier. The router cannot see the code exchange.
- The router mints a `state` only on a pooled host, and the sign-in
  host forwards only to one (§3.3 step 2). The vendor's wildcard DNS
  record covers every pooled host, so `https://<h>/callback` is always
  the vendor's SPA. A dedicated domain's DNS belongs to the tenant: a
  code forwarded there would reach a server the tenant runs, holding a
  nonce and a PKCE verifier of its own choosing. So a dedicated domain
  in `host` mode signs in on its pooled host `<tenant>.<appDomain>`:
  its SPA redirects there for sign-in (`pooledHost`, §3.2), and the
  session continues on that host. A dedicated domain with its own
  callback URL on the issuer (ADR-0016 Option 1 for that one client)
  is out of scope until Q-3 is answered.
- The `signin` key holds one or two keys of 32 random bytes, named by
  `kid` (§4.1). A custom resource of the front door stack generates them
  with a cryptographic random source for the ids in `signinKeys` (§3.6)
  and writes them to the store. It writes with the store's ETag
  (`IfMatch`) and retries on a conflict, as the registrar does (§3.4
  step 5), because both write the same store. The key is never in the
  template, a stack output, the custom resource's response `Data` or a
  log. KeyValueStore actions name the store, not a key, and a function
  has one store (ADR-0012). So the registrar role, the custom resource
  and any edge-account principal with `cloudfront-keyvaluestore:GetKey`
  or `ListKeys` on the store can read the key, and so can any principal
  that can update or test the router (`cloudfront:UpdateFunction`,
  `cloudfront:TestFunction`). The registrar code never reads `signin` or
  `app`, and the deployer keeps those actions off every other role in
  the edge account (§6.1). A leaked key mints a `state` for any
  registered tenant host while it is live, and the nonce and PKCE
  binding still stops it from yielding a token. Rotation is in §4.1.
- `single` mode sign-out: `/logout` answers 302 to the issuer's logout
  endpoint with `client_id=<cid>` and `logout_uri=https://<appDomain>/`,
  plus `Clear-Site-Data: "storage", "cache"` (§7.1).
- A user in several tenants (`shared-pool-multi-tenant`) holds a token with
  a `tenants` list. The SPA narrows it to the tenant the user picked with
  an RFC 8693 token exchange before calling `/api/*` or `/agents/*`
  (`ARCHITECTURE.md` §2.1). The router refuses a token with no single
  `tenant_id` with 401 (§3.3 step 5).
- Access tokens stay in memory in the SPA. No token is written to
  `localStorage`, `sessionStorage` or cookies. Sign-in is a full-page
  redirect, which discards memory, so the PKCE verifier and the nonce are
  kept in `sessionStorage` on the origin that starts the flow, from the
  authorize redirect until `/callback` reads and deletes them (ADR-0007).
- The cell API verifies the token it receives in `x-tenant-token`
  (`ARCHITECTURE.md` §2.1, ADR-0011), then refuses
  the request with 403 when `tenant_id` differs from `x-tenant-route`,
  compared case-insensitively, or the tenant is not one its cell hosts. A
  refusal is logged with both tenant ids.
- Each check stops a different request. Signature verification stops a
  forged claim (§10 step 7). The hosts check catches a validly signed token
  routed to the wrong cell, for example through a stale or wrong `cell#`
  route. The route hint guards `host` mode, where the host picks the tenant
  and the token must agree.
  The cell knows its tenants from its own namespace in its own account
  (`/application-plane/tenants/<tenantId>/<applicationId>/*`), so the check
  needs nothing from the edge account. It builds that path from the
  verified `tenant_id` claim in its control-plane form (upper case), never
  from the lower-case `x-tenant-route` hint: SSM names are case-sensitive.
- The agent ingress already verifies the token and selects the tenant from
  it, so it reaches the same tenant the router routed on. The router's role
  on `/agents/*` is to refuse unknown and suspended tenants at the edge.
- Scripts call the registrar with the provisioning role credentials the
  control plane's build already holds in the cell's account; no new
  credential is handed to a script.

### 3.6 Deployment inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `appDomain` | yes | | Domain the app is served at, for example `app.example.com`. At most 64 characters, ACM's limit on a certificate's primary name; validated at synth |
| `hostedZone` | yes | | Public Route 53 zone for `appDomain`, in the edge account |
| `addressing` | no | `single` | `single`: one URL, tenant from the token. `host`: one host per tenant |
| `applicationId` | yes | | The control-plane application this front door serves |
| `controlPlane` | yes | | Control plane API URL, and the vendor IdP token URL and client (secret in Secrets Manager) the registrar uses to get a reader token. The deployer lists that client id in the control plane's `vendorIdp.clientIds` (§6.1) |
| `fleet` | yes | | The control plane's fleet name, which names the provisioning roles the registrar admits |
| `issuer` | yes | | The SPA's client id and scopes, and the issuer's authorize, token and logout endpoints as `https` URLs, or a Cognito user-pool domain they are derived from (`/oauth2/authorize`, `/oauth2/token`, `/logout`). Validated at synth, with no network call (§7.1) |
| `signinKeys` | no | `{ids: ["k1"], current: "k1"}` | `host` mode only: `{ids: string[], current: string}`, the `kid`s the `signin` key holds and the one that signs. Synth checks that `ids` holds one or two unique ids, each matching `[a-z0-9]{1,8}`, and that `current` is one of them (§4.1) |
| `tenantClaim` | no | `tenant_id` | Claim the router and the origin read |
| `spaSource` | no | the demo SPA | Path of the built SPA |
| `agentIngress` | no | off | Agent ingress endpoint; omit to leave `/agents/*` off |
| `tenantRequestsPer5Min` | no | 2,000 | Per-tenant rate (ADR-0009) |
| `reportingEndpoint` | no | off | URL for CSP and other browser reports |

## 4. Data model

### 4.1 Route table (KeyValueStore)

| Key | Value (JSON, 1 KB max) | Written by |
|---|---|---|
| `tenant#<tenantId>` | `{"v":1,"c":"<cellId>","ac":"<accountId>","s":"active"\|"suspended","n":"<display name>"}` | registrar, from the tenant create script |
| `host#<host>` | `{"v":1,"t":"<tenantId>"}` | registrar, in `host` mode and for a dedicated tenant's domain; only a pooled host's entry is a sign-in target (§3.3 step 2) |
| `cell#<cellId>` | `{"v":1,"ac":"<accountId>","o":"<api domain>"}` | registrar, from the cell create script |
| `app` | `{"v":1,"az":"<authorize endpoint>","tk":"<token endpoint>","cid":"<client id>","sc":"<scopes>","lo":"<logout endpoint>"}` | the front door stack |
| `signin` | `{"v":1,"cur":"<kid>","k":{"<kid>":"<base64 key>"}}`, `host` mode only | custom resource of the front door stack (ADR-0016) |

Rules:

- The registrar and the router lower-case tenant ids, and every key uses
  the lower-case id. Stored ids match `[a-z0-9-]{1,63}` and cannot start or
  end with `-`, so every tenant id is a valid DNS label in either mode. A
  control-plane `TenantId` is a 26-character upper-case Crockford ULID, so
  it fits once lower-cased. The registrar reads the control plane with the
  id in the control plane's own upper-case form.
- `<host>` is the full lower-case host name. In `host` mode pooled tenants
  use `<tenantId>.<appDomain>`; a dedicated tenant adds its own domain as
  another `host#` key.
- Reserved labels (`www`, `api`, `admin`, `auth`, `login`, `static`, `status`) are
  refused at registration.
- The `signin` key holds one or two keys, each 32 random bytes and
  named by a `kid` of at most 8 characters from `[a-z0-9]` (§3.6), so
  it is at most about 150 bytes, needs no JSON escaping, and sits in
  the 20 % the ceilings below leave for non-tenant entries
  (ADR-0012). On each stack update the custom
  resource (§3.5) generates a key for an id in `signinKeys.ids` it has
  not stored, keeps the others, deletes any `kid` not listed, and sets
  `cur` to `signinKeys.current`. Rotation is three stack updates: (1)
  add the new id to `ids`, with `current` still the old; wait past
  propagation (60 s, S-2), so every edge location can verify the new key
  before anything signs with it; (2) set `current` to the new id; (3)
  after the 10-minute `state` lifetime, remove the old id. An operator
  runs the updates and the waits. Rotate on a schedule and whenever the
  key may have been read.
- `ac` is the account the registrar verified at write time. The router
  never reads it; the registrar uses it to authorise deletes.
- Display name `n` is for display only, and the registrar never refuses
  any name the control plane accepts. A control-plane `TenantName` runs to
  128 characters with no character rule. The registrar replaces each
  control character (U+0000 to U+001F, U+007F) with a space, `"` with `'`
  and `\` with `/`, then truncates the raw string to at most 64 UTF-8 bytes
  on a code-point boundary. No stored character then needs JSON escaping,
  so the stored field is at most 64 bytes.
- Worst case, a tenant needs 217 bytes in `single` mode and 427 in `host`
  mode, keys included. The stated ceilings are 18,433 tenants in `single`
  mode and 9,367 in `host` mode, 80 % of the 5 MB store (ADR-0012). The
  registrar refuses a write past 5 MB with 507, and an alarm fires at
  80 %.

### 4.2 Route status

| Status | Edge answer | Set by |
|---|---|---|
| (no entry) | 403 (`single`) or 404 (`host`) | tenant removal, or never registered |
| `active` | routed | tenant create script |
| `suspended` | 503, `Retry-After: 300` | vendor operator in the edge account |

A change reaches an edge location within the store's propagation time:
about 30 s (spike S-2, measured at one location: median 28.4 s, p99 29.4 s,
max 29.5 s). `route.sh` bounds its wait at 45 s after the registrar
returns. For `put-cell`, `delete-cell` and every call in `single` mode it
waits the full 45 s, a bound and not a check: in `single` mode a route
cannot be observed without a tenant token, and a `cell#` route cannot be
observed from outside. In `host` mode `put-tenant` polls
`https://<tenant>.<appDomain>/config.json` and returns on the first 200,
and `delete-tenant` returns on the first 404. When none arrives within
45 s, it prints a warning and exits 0: the write succeeded and only
propagation is late. No unauthenticated probe path exists, because it
would reveal whether a tenant id exists.

`suspended` and a delete take effect after the same window. Until then the
tenant is still routed, and the cell's hosts check is the only refusal
(§3.5). Removal is a delete, not a status.

## 5. API surface

### 5.1 Route registrar

Modelled in Smithy; all operations `AWS_IAM`, all idempotent.

| Op | HTTP | Caller | Contract |
|---|---|---|---|
| `PutCellRoute` | `PUT /cells/{cellId}` | cell provisioning role | Body `{apiDomain}`. Checks §3.4. 200 |
| `DeleteCellRoute` | `DELETE /cells/{cellId}` | cell provisioning role | 409 while a tenant route names the cell. 200, also when absent |
| `PutTenantRoute` | `PUT /tenants/{tenantId}` | tenant provisioning role | Body `{displayName, customDomain?}`. `displayName` is stored as §4.1 says. A `customDomain` gets a `host#` key that routes requests; it is never a sign-in target, and in `host` mode its users sign in on the pooled host (§3.5). Cell taken from the control plane, never the body. Checks §3.4. 200 |
| `DeleteTenantRoute` | `DELETE /tenants/{tenantId}` | tenant provisioning role | Removes the `tenant#` and `host#` keys and any dedicated distribution tenant. 200, also when absent |
| `UpdateTenantRouteStatus` | `PUT /tenants/{tenantId}/status` | edge operator role | Body `{status}` |

Errors: 400 for a malformed id or domain, or an empty display name; 403 when the caller's account or
role does not match the placement (the message names neither the real
account nor the real cell); 409 for a missing cell route or a cell still in
use; 507 when a write would exceed the route table's 5 MB (ADR-0012); 503 when the control plane cannot be read (the write is refused, never
made unchecked).

### 5.2 Script and construct forms

- **`scripts/route.sh put-cell|delete-cell|put-tenant|delete-tenant`**,
  driven by the control plane's script variables (`CELL_ID`, `TENANT_ID`,
  `TENANT_NAME`) and the registrar URL from the edge's published parameter.
  It signs with the credentials the script already holds.
- **`PARAM_FRONT_DOOR_CUSTOM_DOMAIN`**, an optional declared deployment
  parameter (control-plane ADR-0039), carries a tenant's own domain to
  `put-tenant`.
- **`CellRouteAccess` construct**, used in a cell stack: grants
  `cloudfront.amazonaws.com` `lambda:InvokeFunctionUrl` and
  `lambda:InvokeFunction` on the cell's function, conditioned on the edge
  distribution's ARN (ADR-0011).

### 5.3 Edge errors

All with a small static HTML or JSON body and `no-store`:

| Status | When |
|---|---|
| 401 | `single` mode: no token, an undecodable token, or no single `tenant_id` (a `tenants` list included) |
| 403 | unknown tenant (`single`), or a cross-site call to `/api/*`, `/agents/*` or `/signin-state` |
| 404 | unknown host (`host` mode, or an unknown dedicated domain), or `/signin-state` in `single` mode |
| 429 | tenant over its rate on `/api/*` or `/agents/*` (`host` mode, at the edge): the WAF rate rule's Block action returns a custom 429, and a scope-down keeps SPA loads out of the count (ADR-0009) |
| 400 | `/signin-state` with a missing or malformed nonce; `/signin-state` or `/logout` on a dedicated domain (`host` mode); on `login.<appDomain>`: a missing or changed `state`, an unknown `kid`, an `h` that is not a pooled host, an unregistered or suspended tenant host, or any other path. An authentic expired `state` gets 302 to `https://<h>/` instead (§3.3 step 2) |
| 503 | tenant suspended, or its cell has no route |

## 6. Contracts

### 6.1 What the deployer supplies

- A public hosted zone for `appDomain` in the edge account.
- An issuer that meets `ARCHITECTURE.md` §2.1 and accepts the app's
  callback and sign-out URLs: `https://<appDomain>/` as both in `single`
  mode. In `host` mode, `https://login.<appDomain>/callback` as the
  callback URL, which tenant-host sign-out also uses (§3.5), and no
  sign-out URL (ADR-0016).
- A control plane whose `GetCell` and `GetDeployment` return `accountId`
  and `applicationId`, with a reader role enabled (control-plane R-36), and
  a vendor IdP app client whose client-credentials tokens carry that role
  and pass the control plane authorizer (spike S-9, ADR-0015). A Cognito
  client-credentials token has no `aud` and no custom `role`. Two things
  make it pass. The vendor IdP adds `role` to machine tokens with a
  pre-token-generation trigger (V3 event, which needs the Essentials or
  Plus feature plan); the trigger cannot add `aud`, because Cognito ignores
  an `aud` override on access tokens. And the deployer lists the
  registrar's client id in the control plane's `vendorIdp.clientIds`
  (control-plane R-38, ADR-0043), which accepts a listed `client_id` in
  place of `aud` when a token has none. The deployer also sets
  `vendorIdp.requiredScope` when that client can call another API on the
  issuer.
- In every account that hosts cells, the control plane's role pair; the
  registrar admits only those roles.
- In `host` mode, the edge account's read boundary for the `signin` key.
  The registrar role, the custom resource and any edge-account principal
  with `cloudfront-keyvaluestore:GetKey` or `ListKeys` on the route
  table, or `cloudfront:UpdateFunction` or `cloudfront:TestFunction` on
  the router, can read the key. The registrar code never reads `signin`
  or `app`. The deployer keeps those actions off every other role in the
  edge account: KeyValueStore has no resource policy, so the stack
  cannot (§3.5).
- A cell API that verifies the token in `x-tenant-token`, refuses a
  `tenant_id` that differs from `x-tenant-route` (compared
  case-insensitively), refuses tenants its cell does not host, and in `single`
  mode limits each verified tenant to `tenantRequestsPer5Min` (ADR-0009). The demo
  cell API is the reference.
- CloudFront origin access control support on the cell origin (Lambda
  function URL, or S3), with the cell stack granting the edge distribution
  through `CellRouteAccess`.
- Any client of `/api/*` through the front door, not only the SPA, sends
  the SHA-256 of a `PUT` or `POST` body in `x-amz-content-sha256` (§7.2,
  ADR-0011).

### 6.2 What the sample promises

- A request with no tenant, or with an unknown or suspended tenant, never
  reaches an origin, once the route change has propagated (§4.2).
- A request reaches only the cell its route names.
- An account can register routes only for cells and deployments the control
  plane places in it.
- A forged token cannot be served: the cell's signature check refuses
  it. A validly signed token routed to the wrong cell is refused by that
  cell's hosts check.
- In `host` mode, a token for one tenant is refused on another tenant's
  host.
- Every response carries the §7 header set.
- Each pooled tenant is registered and removed with one registrar call, with
  no distribution change.
- Per-tenant requests, errors, bytes and refusals are visible.
- `cdk destroy` leaves nothing behind.

### 6.3 Samples consumed

| Sample | How | Needed for |
|---|---|---|
| `control-plane` | its API (`GetCell`, `GetDeployment`) with the reader grant (R-36) and a client-credentials reader token (spike S-9 showed both are needed: a `role` trigger on the vendor IdP and the `vendorIdp.clientIds` input of R-38, ADR-0043), its role pair in each cell account, and its scripts calling `route.sh` | placement checks, registration, the integration test |
| `tenant-identity` `shared-pool` | its published parameters | the demo issuer and the integration test |
| `agentic-runtime-isolation` | its `/application-plane/shared/agent-runtime/ingress` parameter | `/agents/*`, optional |

### 6.4 Published interface

- **Constructs** `TenantFrontDoor` and `CellRouteAccess` (`src/index.ts`).
  `TenantFrontDoor` exposes `distributionId`, `distributionArn`,
  `routeTableArn`, `registrarUrl`, `appDomain`, `addressing` and
  `pooledTenantId` (the distribution tenant).
- **Published parameter** `/application-plane/shared/front-door/edge` in
  the edge account, one JSON document: `version`, `appDomain`,
  `addressing`, `applicationId`, `distributionArn`, `registrarUrl`,
  `tenantClaim`, `reservedLabels`. A cell script in another account cannot
  read it, so the application's shared stack in each cell account copies
  `registrarUrl` and `distributionArn` to
  `/application-plane/applications/<applicationId>/shared/front-door`
  (control-plane §6.2).

## 7. Web platform baseline

One response headers policy on every behaviour. The SPA is static, so CSP
uses script hashes, not nonces. The build step computes the hashes and writes
the policy. For one release the policy carries the previous and the new
script hashes: the policy deploys first, then the SPA files are uploaded,
and the next release drops the old hash. Two sets of hashes fit within the
1,783-character CSP limit (ADR-0008).

### 7.1 Headers

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (no `preload` in the sample) |
| `Content-Security-Policy` | `default-src 'self'; script-src 'sha384-…' 'strict-dynamic' 'report-sample'; connect-src 'self' <token origin>; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' <authorize origin>; frame-ancestors 'none'; worker-src 'self'; require-trusted-types-for 'script'; report-to fd` |
| `Reporting-Endpoints` | `fd="<reportingEndpoint>"`, only when set |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` (sign-in is a full redirect, no popup) |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `Clear-Site-Data` | on `/logout` only: `"storage", "cache"` (§7.3) |

`<token origin>` and `<authorize origin>` are the origins of the token and
authorize endpoints in the `issuer` input (§3.6), not the issuer URL: for
Cognito they are the user pool domain, while the issuer is on
`cognito-idp.<region>.amazonaws.com`. A `connect-src` that names only the
issuer blocks the code exchange. The stack takes them from its inputs at
synth, with no network call. The SPA reads the same endpoints from
`/config.json` and never fetches the discovery document, which
`connect-src` would block. In `host` mode `form-action` also allows
`https://login.<appDomain>`.

The response headers policy overrides origin headers, so a cell in a
tenant-owned account cannot weaken the baseline (P-8).

### 7.2 SPA rules

- No HTML strings into the DOM: `textContent`, `createElement`, or
  `setHTML()` with a fallback sanitiser. Agent output is text, never HTML.
- A callback with `error` shows a fixed message. Anyone holding a
  `state` can choose the `error_description` text, so the SPA never
  renders it as HTML, at most as `textContent`.
- Trusted Types enforced, with no pass-through policy.
- Same-origin API and agent calls, so no CORS is needed anywhere.
- `PUT` and `POST` calls to `/api/*` send the body's SHA-256 in
  `x-amz-content-sha256`, which origin access control needs to sign a
  request with a body to a Lambda function URL (ADR-0011).
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

`/logout` sends no `"cookies"` directive in either mode. The browser
clears cookies for the whole registrable domain, so the directive would
clear every other site the vendor runs under that domain and, in `host`
mode, every other tenant's cookies. The sample sets no cookies (§3.5).

## 8. Decisions

| Record | Decision | Options weighed |
|---|---|---|
| [ADR-0001](../adr/0001-default-to-one-url-with-the-tenant-from-the-token.md) | Default to one URL with the tenant from the token; offer one host per tenant | token claim; host name; client header; path prefix |
| [ADR-0002](../adr/0002-use-a-cloudfront-multi-tenant-distribution.md) | Use a CloudFront multi-tenant distribution | multi-tenant distribution with tenants; one standard distribution with a wildcard; one distribution per tenant |
| [ADR-0003](../adr/0003-keep-the-route-table-in-cloudfront-keyvaluestore.md) | Keep the route table in CloudFront KeyValueStore | KeyValueStore; Lambda@Edge plus DynamoDB; routes in function code |
| [ADR-0004](../adr/0004-route-to-cells-with-cloudfront-functions-origin-modification.md) | Route to cells with CloudFront Functions origin modification | origin modification; one origin and cache behaviour per cell; Lambda@Edge |
| [ADR-0005](../adr/0005-route-on-the-unverified-claim-and-verify-at-the-origin.md) | Route on the unverified claim, verify at the origin with a route hint | decode at the edge and verify at the origin; verify at the edge with Lambda@Edge; no hint |
| [ADR-0006](../adr/0006-generate-config-json-at-the-edge.md) | Generate `/config.json` at the edge | edge-generated; per-tenant file in S3; build per tenant |
| [ADR-0007](../adr/0007-keep-tokens-in-spa-memory.md) | Keep tokens in SPA memory; the PKCE verifier and nonce in `sessionStorage` until `/callback` | memory with PKCE; backend-for-frontend with `__Host-` cookie |
| [ADR-0008](../adr/0008-use-a-hash-based-csp-with-trusted-types.md) | Hash-based CSP with Trusted Types | hashes; nonces through Lambda@Edge; allowlist |
| [ADR-0009](../adr/0009-rate-limit-each-tenant-with-waf-on-the-host-or-at-the-origin.md) | Per-tenant rate limit: AWS WAF on the host in `host` mode, the origin in `single` mode | WAF custom key; origin limit; none |
| [ADR-0010](../adr/0010-deploy-the-edge-stack-in-us-east-1.md) | Split the edge stack into `us-east-1`, logs included | edge stacks plus main stack with cross-Region references and CloudWatch Logs; the same with logs in S3; everything in `us-east-1` |
| [ADR-0011](../adr/0011-protect-cell-origins-with-origin-access-control-across-accounts.md) | Protect cell origins with origin access control, across accounts | OAC with a cross-account Lambda permission; secret header; IP allowlist |
| [ADR-0012](../adr/0012-cap-the-route-table-and-shard-by-distribution.md) | Route table size ceiling and sharding | one store and a ceiling; shard by distribution |
| [ADR-0013](../adr/0013-register-routes-through-a-registrar-that-checks-the-control-plane.md) | Register routes through a registrar that checks the control plane | registrar with a placement check; a cross-account role that writes the store directly; the control plane writes routes |
| [ADR-0014](../adr/0014-run-one-front-door-per-control-plane-application.md) | One front door per control-plane application | one per application; one shared front door keyed by application |
| [ADR-0015](../adr/0015-read-the-control-plane-with-a-reader-token.md) | Read the control plane with a reader token | reader role (control-plane ADR-0042); operator app client; an IAM-authorised read stage |
| [ADR-0016](../adr/0016-sign-in-through-one-shared-host-in-host-mode.md) | Sign in and out through one shared host in `host` mode | shared sign-in host with a signed `state`; a callback URL per tenant; a wildcard callback URL |

## 9. Spikes before code

Each spike reports its deploy and destroy time.

| # | Question | Pass when |
|---|---|---|
| S-1 | Does a multi-tenant distribution take a viewer-request function with an associated KeyValueStore, on both an apex and a wildcard pooled distribution tenant? | a request runs the function and reads the store in both; standard logging v2 set up in `us-east-1` (delivery source, delivery destination and delivery) delivers to a log group in `eu-central-1`. **Passed 2026-11-16, with a logging change**: the function read the store on both tenants (apex and `a.` under the wildcard), 200 within 46 s of deploy. A CloudWatch Logs delivery to another Region is refused (`Cross-region Delivery Destination is not supported`), and a delivery destination must be in its log group's Region. With the log group in `us-east-1` logs arrived in 33 s; with an S3 bucket in `eu-central-1` (destination and delivery in `us-east-1`) in 312 s. The log group is in `us-east-1` (ADR-0010). Deploy 481 s, destroy 312 s |
| S-2 | How long does a KeyValueStore write take to apply at the edge? | median and p99 from write to first routed request. **Measured 2026-11-16** over 100 rounds (one POP, 250 ms polling): median 28.4 s, p90 29.2 s, p99 29.4 s, max 29.5 s from the start of `put-key` to the first routed request; 29.6 s median until four pollers all saw it; no timeouts; inserts and updates alike. `put-key` itself takes about 0.6 s. Deploy 340 s |
| S-3 | Does `cf.updateRequestOrigin()` set origin access control for a Lambda function URL **in another account**? | through the multi-tenant distribution, with its ARN as the permission's `SourceArn`: a signed request reaches a URL with `AWS_IAM` auth in the second account; an unsigned one is 403; a `POST` with a body and `x-amz-content-sha256` is served; the cell receives the viewer's token in `x-tenant-token`; the permission set is confirmed. **Passed 2026-11-16**: a signed `GET` and a `POST` with `x-amz-content-sha256` reached the function URL in the second account through the multi-tenant distribution, with the distribution ARN (not the tenant ARN) as `SourceArn`; the cell saw the viewer's token in `x-tenant-token`, and a client's own `x-tenant-token` was replaced. Refused with 403: a direct unsigned call, a call before the permission existed, a `POST` without `x-amz-content-sha256` (signature mismatch), and a call with `lambda:InvokeFunctionUrl` but no `lambda:InvokeFunction`. Lambda removes the signed `Authorization` header from the event. Deploy 506 s, destroy 185 s |
| S-4 | `host` mode: how does the issuer take one callback URL per tenant at 1,000s of tenants? | a working option for Cognito app clients (limit and update rate measured), or a single sign-in host with a signed `state`. **Passed 2026-11-16 with the shared sign-in host**: one Cognito app client takes 100 callback URLs (the 101st is refused), a pool 1,000 clients by default, and `UpdateUserPoolClient` about 15 per second before `TooManyRequestsException`. One sign-in host with a signed `state` completed a real hosted sign-in and sent the code to the tenant host; a missing, changed or expired `state`, or a host outside `appDomain`, got 400. A wildcard callback URL is saved but matched as a literal string: a tenant host gets `redirect_mismatch` (ADR-0016). Deploy 446 s, destroy 220 s |
| S-4o | `host` mode: does Cognito's `/logout` return `state` on its `logout_uri` redirect, and which `/logout` form brings a user back to a tenant host? | the observed redirect for the `logout_uri` form and the `redirect_uri` form, and for an unregistered `logout_uri`. **Measured 2026-11-16**: `/logout` with `client_id`, a registered `logout_uri` of `https://login.<appDomain>/logout` and `state` answered 302 to the `logout_uri` with `state` dropped, and ended the session (the next authorize showed the sign-in form). An unregistered `logout_uri`, on another domain or a tenant host, was refused with a redirect to Cognito's own `/login` page. `/logout` with `client_id`, `response_type=code`, `scope=openid`, a registered `redirect_uri` of `https://login.<appDomain>/callback` and `state` answered 302 to Cognito's `/login` with `state` kept; after sign-in the code reached the callback with the same `state`. A live session gave a code without the sign-in form, and both `/logout` forms ended it: the next authorize showed the form again (rerun 2026-11-17). The design uses the `redirect_uri` form (ADR-0016). Deploy 39 s, destroy 31 s |
| S-5 | Does streaming pass through `/agents/*` to the agent ingress without buffering? | first byte at the client within 1 s of first byte from the ingress; the ingress receives the bearer token on `GET` and `POST`; the `Managed-AllViewerExceptHostHeader` policy deploys with the pinned CDK version |
| S-6 | Does a WAF rate rule keyed on the `Host` header count each tenant on its own? | tenant A over its limit on `/api/*` gets the custom 429 while tenant B is served; A's SPA loads (`/`, `/assets/*`) are not counted. **Passed 2026-11-16**: limit 10 per 60 s keyed on the lower-cased `Host`, scoped down to `/api/`. Tenant A got the custom 429 (JSON body, `retry-after: 60`) 21 s into its burst while B's `/api/x` stayed 200; 300 requests to A's `/` and 100 to `/assets/app.js` during the block were all 200. The rule's managed-keys call does not support a `Host` key. Deploy 443 s, destroy 250 s |
| S-7 | Can the router decode a `tenant-identity` access token's payload within the CloudFront Functions limits? | `tenant_id` read from a real token; compute utilisation under 50 %; 401 on a malformed token. **Passed 2026-11-13**: 13-14 % compute, 401 at 9-10 % (ADR-0005) |
| S-8 | Can an API Gateway resource policy admit a role name in any account through `aws:PrincipalArn`, and does the request context give the caller's account? | a provisioning role in the second account reaches the registrar; a role of another name is refused. **Passed 2026-11-13** with one design fix: the second account's provisioning role got 200 with `identity.accountId` and `userArn` in the request context; another role name got 403. The edge account's own admin also got 200 through its identity policy, so the resource policy adds an explicit `Deny` with `ArnNotLike` (§3.4, ADR-0013). Deploy 75 s, destroy 33 s |
| S-9 | Does a client-credentials token from the registrar's own vendor IdP client pass the control plane authorizer (single `audience`, required `sub` and `role`)? | `GetCell` returns 200 with that token, the token's `role` is the reader value, and a write returns 403. **Failed 2026-11-13; fallback proven**: the token has no `aud` (`sub` equals `client_id`), and the audience check denies it. A V3 trigger on the Essentials plan adds `role: control-plane:reader` but its `aud` override is ignored. With a `client_id` allow-list in place of the audience check, the same token is allowed with the reader grant (ADR-0015, §6.1). Deploy 36 s per phase, destroy 61 s |

## 10. Integration test outline

Runs in `eu-central-1`, with the edge stacks in `us-east-1` (ADR-0010),
in two accounts: the edge account, which also hosts the control plane and
cell A, and a second account registered tenant-owned, hosting cell B. It
reuses the `tenant-identity` shared pool, and reuses a `control-plane`
deployment when one is found, deploying one otherwise (Q-2). It needs a
public hosted zone for a test domain (Q-1). `test/integ.single.ts` covers
the default mode; `test/integ.host.ts` repeats the steps marked (host) with
`addressing: 'host'`.

Expected time, from S-1: deploying the edge stacks and the distribution
takes about 481 s and destroying them about 312 s, before the control plane
and the cells the test also deploys. The route changes of steps 2 and 15
go through `route.sh`, which already waits its 45 s bound (§4.2). Step 13
is a status change the test makes as the operator, without `route.sh`,
so the test waits 60 s for propagation (ADR-0003, spike S-2) before its
next call. The rotation check after the list is a separate run with its
own time.

1. Deploy the front door and register the demo application with the control
   plane, its scripts calling `route.sh`.
2. Create tenant `a` (placed in the edge account) and tenant `b` (pinned to
   the second account). Their cell and tenant scripts register the routes.
3. `/` serves the SPA with every §7.1 header. In `single` mode
   `/signin-state` returns 404, and `/logout` returns 302 to the
   issuer's logout endpoint with `client_id` and
   `logout_uri=https://<appDomain>/`, with `Clear-Site-Data:
   "storage", "cache"` (§7.1).
4. `/api/whoami` with a token for `a` returns `a` from cell A; with a token
   for `b` returns `b` from cell B in the second account. Each cell read
   the token from `x-tenant-token`.
5. `/api/whoami` with no token, or with a token that carries a `tenants`
   list and no `tenant_id`, returns 401 from the edge (no origin log line).
6. A token for an unregistered tenant returns 403 from the edge.
7. A token whose payload is edited to name `b`, with `a`'s signature,
   reaches cell B and is refused there with 403.
8. A client `x-tenant-route: b` or `x-tenant-token` header with `a`'s
   token is ignored.
9. `Sec-Fetch-Site: same-site` on `/api/*` returns 403.
10. A direct call to either cell's function URL, without CloudFront,
    returns 403.
11. The second account's tenant provisioning role calls `PutTenantRoute`
    for `a`: 403, and `a` is still routed to cell A.
12. The second account's cell role calls `DeleteCellRoute` for cell A: 403.
    An edge-account principal that is not the operator role, with
    `execute-api:Invoke` in its identity policy, calls the registrar: 403
    (the explicit `Deny`, §3.4).
13. Suspend `b`: after 60 s, `b`'s token returns 503, `a` is still served.
14. Wait 60 s for log delivery (33 s in S-1). Per-tenant log fields name
    `a` and `b`, queried in `us-east-1` where the log group is (ADR-0010),
    and the registrar log, in `eu-central-1`, names the second account on
    steps 11 and 12.
15. Delete `b`'s deployment: its script removes the route through
    `route.sh`, and once the script returns `b`'s token returns 403.
16. (host) `a.<appDomain>/config.json` names `a`; an unregistered host
    returns 404; a token for `a` on `b.<appDomain>/api/whoami` returns 403;
    `a` over its rate gets 429 while `b` is served.
17. (host) Sign-in host (ADR-0016). `/signin-state` on `a`'s host with
    `Sec-Fetch-Site: same-origin` returns a `state`; cross-site it gets
    403, and with a malformed nonce 400. A real sign-in through the issuer
    reaches the sign-in host and gets a 302 to `a`'s `/callback` with the
    code and `state`; the SPA's exchange with the same `redirect_uri`
    returns a token. A missing or changed `state`, a host that is not a
    registered tenant, and a suspended tenant's host each get 400 on
    `login.<appDomain>`; an expired `state` gets 302 to `a`'s `/`. A
    `state` for a dedicated domain is refused with 400 at the mint
    (`/signin-state` on that domain) and on `login.<appDomain>` (a
    `state` the test signs with the live key). `/logout` on `a`'s host
    returns 302 to the issuer's logout endpoint with `client_id`,
    `response_type=code`, the sign-in host's `redirect_uri` and a
    `state` for `a`'s host, with `Clear-Site-Data: "storage",
    "cache"`. The issuer then shows the sign-in form, so the session
    ended. After a fresh sign-in the sign-in host's `Location` is
    `https://a.<appDomain>/` with no `code` and no `state`.
    `login.<appDomain>/logout` returns the static signed-out page.
18. Destroy everything the test deployed, in both accounts, except the
    shared identity pool.

Rotation check, optional and run on its own against a `host` mode front
door: run the three rotation updates of §4.1 and check that a `state`
minted before the switch to the new `current` still verifies, and that
it gets 400 once the old id is removed. It adds three stack updates, the
60 s propagation wait and the 10-minute `state` lifetime, so at least
11 minutes plus the updates.

## 11. Open questions

| # | Question | Needed by |
|---|---|---|
| Q-1 | Which public hosted zone can the test account use for `appDomain`? **Answered 2026-11-16**: a public zone for a delegated test subdomain in the edge account, with its own SPF, DKIM and DMARC records. The spikes and the integration test take its name and zone id as inputs (`TFD_APP_DOMAIN`, `TFD_HOSTED_ZONE_ID`); neither is committed | spike S-1 |
| Q-2 | Does the integration test deploy its own control plane, or reuse one when found and skip otherwise? | integration test |
| Q-3 | Does the dedicated tenant (custom domain) path belong in this sample or in a follow-up? | scope |
| Q-4 | Should the integration test also compose `agentic-runtime-isolation` for `/agents/*`, or reuse a deployment only when one is found? | integration test |

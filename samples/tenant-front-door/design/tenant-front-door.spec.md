<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant front door for agentic applications: specification

Status: Proposed. §8 lists the decisions, all Accepted except ADR-0013,
which ADR-0017 supersedes, and ADR-0027, which is Proposed. Routes are
registered as ADR-0017 decides, from the control plane's global hooks
(control-plane ADR-0044).

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
request to the tenant's cell. Routes are registered by the control plane's
own operations: a vendor **route hook**, which the control plane runs in
its own account on cell and deployment events, calls a **route
registrar** in the edge account. The registrar admits no role a cell
account holds, and writes a route only to the cell and account the
control plane placed it in (ADR-0017).

The router finds the tenant in one of two ways, chosen at deploy time
(`addressing`):

| Mode | Tenants reach the app at | The router reads the tenant from |
|---|---|---|
| `single` (default) | one URL, `https://<appDomain>` | the `tenant_id` claim of the bearer token |
| `host` | one host each, `https://<tenant>.<appDomain>` | the host name |

Both modes send the same route hint to the origin, and the origin checks it
against the verified token the same way (P-4). In `host` mode the router
also compares the token's claim with the host's tenant at the edge.

Deployment model: the SPA and the edge are pooled, one front door per
control-plane application. Cells behind the edge are whatever the control
plane placed (pool, or `maxTenants: 1` for a dedicated cell), in whichever
registered account it placed them. When the deployer turns on
`dedicatedDomains` (§3.6), a tenant with its own domain gets a dedicated
distribution tenant on the same distribution, in either mode, once it
has passed the registrar's domain challenge (ADR-0018).

### 1.1 What the sample shows

- Edge routing to a cell origin chosen per request, from the token's tenant
  or from the host, across vendor-owned and tenant-owned accounts.
- Route registration that only the vendor can make: a control-plane
  global hook writes each route from the cell or deployment operation,
  checked against the control plane, and no cell account, tenant-owned
  or not, holds a credential the registrar admits.
- A route table at the edge: unknown tenants are refused and suspended
  tenants get 503 there. Neither reaches an origin.
- Reading a token at the edge without trusting it: the router decodes the
  tenant claim to route, and the origin verifies the token.
- A route hint the origin checks against the verified token and the tenants
  its cell hosts, so a request can only be served by its own tenant's cell.
- One web security baseline for every tenant (§7), set once at the edge.
- Per-tenant telemetry and cost attribution at the edge in both modes,
  from one access-log field the router fills with the tenant it routed
  on. That is the claimed tenant, so billing-grade counts come from the
  cell's log of verified requests (§3.1).
- A per-tenant rate limit at the edge in `host` mode, behind a per-client
  rule that stops one address using up a tenant's budget, and at the
  origin in `single` mode, which has no edge rate rule (ADR-0009).
- Optional dedicated domains: a tenant proves that it controls its own
  domain with a TXT record carrying a token the registrar issued for
  that tenant and domain, before any certificate or distribution tenant
  exists for it (ADR-0018). A dedicated domain is a branded entry point:
  the SPA loads there, but sign-in and the session move to `signInHost`
  (§3.5), so no browser session holds a token on that domain.
- Agent traffic (`/agents/*`) on the same origin, streamed through to the
  agent ingress.

### 1.2 What the sample does not do yet

- Several Regions per tenant, failover between cells, or moving a tenant
  between cells with no downtime.
- Server-side rendering, or a backend-for-frontend that holds the tokens.
- Per-tenant SPA versions (version pinning) and staged SPA rollouts.
- A collector for browser security reports (only the endpoint is wired).
- Origins other than Lambda function URLs and S3 (§6.1).
- Refusals for agent traffic that bypasses the edge. The agent ingress is
  a public endpoint that verifies tokens itself but does not see a
  tenant's suspension or the route table, so a suspended tenant's tokens
  still work when sent to it directly. The hardening path is an ingress
  that admits only the distribution (a secret origin header that a WAF
  rule on the ingress checks), or one that reads the suspension. The
  sample builds neither (§6.2).

### 1.3 What the sample is NOT

- Not an identity provider. The SPA signs in against an issuer that meets
  the token contract (`ARCHITECTURE.md` §2.1).
- Not the authoriser. The edge routes; the cell's API verifies the token.
- Not the application. The demo cell API and the demo SPA exist only to
  prove the routing and the browser baseline.
- Not tenant onboarding or placement. The control plane creates tenants and
  places them in cells; this sample gives the control plane a hook that
  registers each route, and reads the placement back to check it.

## 2. Guiding principles

1. **P-1: The edge reads the tenant; it never trusts it.** The router decodes
   the token's tenant claim, or reads the host, only to choose where the
   request goes and whether the tenant is live. It checks no signature and
   grants nothing. A forged claim can only send a request to a cell that
   then refuses it.
2. **P-2: The tenant comes from the token or the host, never the client.**
   No header, query parameter or path segment names the tenant. In `single`
   mode the token's claim decides; in `host` mode the host decides and the
   token must agree. The router checks that agreement at the edge on the
   decoded claim, and the cell checks it again at the origin on the
   verified one (P-4).
3. **P-3: The route table is vendor data.** Only the route registrar writes
   routes. Nothing in a request can add, change or pick a route, and every
   client `x-tenant-*` header is removed before routing.
4. **P-4: The verified token and the cell must agree.** The router forwards
   the tenant it routed on as a route hint. In `host` mode it first
   refuses, at the edge, a token whose decoded `tenant_id` is not the
   host's tenant (§3.3 step 5). The origin verifies the token, refuses a
   `tenant_id` that differs from the hint, and refuses a tenant its cell
   does not host.
5. **P-5: Only the vendor writes routes, and only to the placement.** The
   registrar admits two principals: the control plane's global hook
   role, under which the route hook runs, and the vendor's edge operator
   role. No role a cell account holds reaches it. A tenant-owned account
   controls its own credentials, so this is the wall that stops it
   writing, deleting or re-creating any route, its own included. The
   registrar takes a route's cell and account from the control plane's
   record, never from the body, and accepts a hook's write only while
   that record is in a status of the kind of operation that runs the
   hook (§3.4 step 3). A cell's origin is set once, by the cell's
   first hook write, and only the edge operator role changes it. A
   tenant route claims only its own pooled host. A
   dedicated domain (`customDomain`) is set only by the vendor's edge
   operator role, is routed only after the tenant has published the
   registrar's challenge token for that tenant and domain in the
   domain's DNS (ADR-0018), and only outside `appDomain` and when no
   other tenant holds it (§3.4 steps 3 to 5). The edge operator role's domain
   change is checked against the account recorded on the tenant route.
6. **P-6: Placement has one source of truth.** The control plane owns where
   each cell and deployment lives. The registrar reads it back on every
   write that sets a route's placement and keeps no placement data of
   its own.
7. **P-7: Stop bad traffic at the edge.** Requests with no tenant, unknown
   or suspended tenants and cross-site API calls are refused before any
   origin is reached, so they cost no origin capacity.
8. **P-8: One baseline, every tenant.** Security headers come from one
   response headers policy. A tenant cannot weaken them, and an origin cannot
   drop them.
9. **P-9: Register a tenant with one call.** Onboarding a pooled tenant is
   one registrar call, which the route hook makes after the control
   plane's deployment create script has run. In `host` mode the wildcard
   certificate and DNS record already cover its host. Removing it is one
   call from the route hook before the delete script runs. No script
   calls the registrar. No distribution update and no cache
   invalidation.

## 3. System shape

### 3.1 Components

| Component | Account | Runs on | Job |
|---|---|---|---|
| Edge stack | edge, `us-east-1` | ACM and AWS WAF | Certificate for `<appDomain>` (and `*.<appDomain>` in `host` mode), web ACL |
| Edge logging stack | edge, `us-east-1` | CloudWatch Logs delivery | Standard logging v2 for the distribution: the delivery source, the delivery destination and the log group it points at (a CloudWatch Logs delivery cannot cross Regions, spike S-1) and the delivery, all in `us-east-1`, deployed after the main stack. The delivery lists its record fields (ADR-0010) and leaves out `cs-uri-query`, `cs(Referer)` and `cs(Cookie)`: the query on the sign-in host and the referrer of a `/callback` page carry authorization codes (§3.5) |
| Multi-tenant distribution | edge | CloudFront (`ConnectionMode: tenant-only`) | Shared behaviours, policies and origins |
| Pooled distribution tenant | edge | CloudFront distribution tenant | Serves `<appDomain>` (`single`) or `*.<appDomain>` (`host`) for every pooled tenant |
| Dedicated distribution tenant | edge | CloudFront distribution tenant | A branded entry point for one tenant's own domain: the SPA loads there, but sign-in and the session move to `signInHost` (§3.5), so no token is held on it. It has its own ACM certificate in `us-east-1` and optional web ACL override. Only when `dedicatedDomains` is on (§3.6). On the edge operator role's `PutTenantRoute` the registrar first issues a domain challenge; once the tenant has published its token it requests the certificate and, once that has validated, creates the distribution tenant. It removes both in two phases when the domain goes, and re-checks the challenge record daily (§3.4 step 5, ADR-0018) |
| Tenant router | edge | CloudFront Function (viewer request, JS 2.0) | Finds the tenant, refuses or routes. It names the tenant it routed on in the access log with `cf.logCustomData` (Telemetry, below). In `host` mode it also mints and checks the signed sign-in `state` and starts sign-out (§3.5, ADR-0016) |
| Route table | edge | CloudFront KeyValueStore | `tenant`, `host` and `cell` entries, the `app` settings and, in `host` mode, the `signin` key (§4) |
| Route registrar | edge | API Gateway (IAM auth) and Lambda | The only writer of the route table, and the only creator of dedicated distribution tenants, which the sweeper deletes once disabled. Admits only the control plane's global hook role and the edge operator role, and checks each write against the control plane (§3.4) |
| Sweeper | edge | A Lambda function of its own, with a 15-minute timeout, its own execution role and its own log group, run by EventBridge Scheduler. Only when `dedicatedDomains` is on (§3.6) | Every 15 minutes it deletes the dedicated distribution tenants and certificates that no tenant's `d` names any more. Daily it re-checks the challenge record of every passed challenge, routed or not (§3.4 step 5), and keeps the state of that re-check in a DynamoDB table of its own (ADR-0020, ADR-0022). Its log group holds no registrar request log |
| SPA origin | edge | S3 bucket with origin access control | One build for every tenant. Block Public Access on, `BucketOwnerEnforced`, versioning on. The bucket policy lets only the distribution read (origin access control) and denies object writes and deletes (`s3:PutObject`, `DeleteObject`, `DeleteObjectVersion`) to every principal except the stack's two deployment roles, the one that uploads the build and the one that empties the bucket at teardown. A script served from `/assets/*` is then the one the build made, and the import map pins it (§7.1, ADR-0023) |
| Cell API origin | the cell's | The cell's API (demo: Lambda function URL with origin access control) | Verifies the token, checks the route hint and the cell's tenants |
| `CellRouteAccess` construct | the cell's | Lambda permission | Grants `cloudfront.amazonaws.com` `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, conditioned on the edge distribution's ARN |
| Agent route | edge | `/agents/*` behaviour | Streams to the agent ingress of `agentic-runtime-isolation`, when configured, with the `Managed-AllViewerExceptHostHeader` origin request policy. The router forwards only `/agents/<backend>/invocations` and strips the leading `/agents`, so the ingress receives `<stage>/<backend>/invocations` (§3.3 step 7, ADR-0019) |
| Route hook | the control plane's | CodeBuild, the control plane's global hook project, under `<fleet>-global-hook` (control-plane R-41) | `hooks/route-hook.sh`, registered as two global hooks. `front-door-post` (`POST` on `CELL_CREATE`, `CELL_UPDATE`, `DEPLOYMENT_CREATE`, `DEPLOYMENT_UPDATE`) puts the cell or tenant route; `front-door-pre` (`PRE` on `CELL_DELETE`, `DEPLOYMENT_DELETE`) deletes it (§3.2, §3.4). It acts only for an application that has a front door hook parameter (`RouteHookAccess`, below) in the control plane's account, and exits 0 for every other (ADR-0014) |
| `RouteHookAccess` stack | the control plane's | IAM and SSM Parameter Store | Added by the front door's app once the `registrarUrl` input names the deployed registrar (§3.6, ADR-0027). The front door hook parameter `/application-plane/applications/<applicationId>/shared/front-door-hook`, one JSON document with `version`, `registrarUrl`, `appDomain` and `addressing` (§6.4), a name of its own so that it cannot collide with the cell-account copy (§6.4) when the control plane's account also hosts cells. The parameter has `DeletionPolicy` and `UpdateReplacePolicy` `Retain`, so deleting or replacing the stack keeps it (§3.4 route hook step 1, §6.2). The name is fixed, so a retained parameter has to be deleted, or imported into the new stack, before `RouteHookAccess` is deployed again after a stack delete or after a first create that rolled back (CloudFormation keeps `Retain` resources on a create rollback too); otherwise the create fails because the parameter exists. When `applicationId` changes, the operator deletes the old application's parameter: while it stays, the hook calls the registrar for that application, the registrar refuses with 403 (§3.4 step 3) and that application's creates and updates fail (§6.2 limits). The stack also holds a customer-managed policy, `tenant-front-door-route-hook-<applicationId>`, listed in the control plane's `globalHookManagedPolicyArns`, that lets `<fleet>-global-hook` read any front door hook parameter (`ssm:GetParameter` on `/application-plane/applications/*/shared/front-door-hook`) and invoke this registrar's hook routes (`execute-api:Invoke` on `PUT` and `DELETE` of `/cells/*` and `/tenants/*`). `/tenants/*` also matches `PUT /tenants/<tenantId>/status`, because IAM's `*` matches `/` too, so the policy denies `execute-api:Invoke` on that route and on `/hosts/*` explicitly, and the registrar refuses both to the hook role (§5.1). It grants nothing else |
| `register-hooks.sh` | the operator's shell | the control plane API, with an operator token | Puts both global hooks with `PutHook`, the `PRE` hook first, from this sample's source at a pinned commit, and checks them with `ListHooks`; idempotent. `--delete` removes them, the `POST` hook first (§5.2) |
| Telemetry | edge | CloudFront standard logging v2: delivery source, delivery destination, delivery and log group in `us-east-1` (ADR-0010) | Per-tenant requests, errors, bytes and latency from the record fields ADR-0010 lists, and the tenant in `viewer-request-log-data` (Telemetry, below) |

**Telemetry.** The delivery's record fields are the ones ADR-0010 lists.
It never carries `cs-uri-query`, `cs(Referer)` or `cs(Cookie)`. The
tenant is in `viewer-request-log-data`, in both modes. In `single` mode
every pooled tenant shares one host and one distribution tenant, so no
other field names it. In `host` mode `x-host-header` names a pooled
host's tenant but not a dedicated domain's, so the router fills the field
there too, and one query serves both modes.

The router calls `cf.logCustomData` where it first knows the tenant,
with the lower-case tenant id, or `-` when the id does not match the §4.1
id pattern: straight after the §3.3 step 2 `host#` lookup, with the
entry's `t`, on every host it looks up (`host` mode, and a dedicated
domain in either mode); and in §3.3 step 5 in `single` mode, on every
host, with the decoded claim, or `-` when step 5 found none. CloudFront
keeps only the last value a request logs, so in `single` mode on a
dedicated domain the claim, which the router routes on, replaces the
host's tenant for every request that reaches step 5. The router never
passes the token, a header, the path or the query. CloudFront writes the
value into the request's own access-log record, URL-encoded, at most 800
bytes; an id of the §4.1 form needs no encoding.

On a looked-up host every request therefore names the tenant, SPA loads,
`/config.json`, `/logout` and step 4 refusals included. On `<appDomain>`
in `single` mode the requests answered before step 5 (SPA loads,
`/config.json`, `/logout`, step 4 refusals) carry no tenant, because no
token is decoded for them. The sign-in host and a 404 for an unknown host
leave the field empty. The field names the claimed tenant, which is
unverified: the decoded claim in `single` mode, the host the caller chose
in `host` mode. Traffic with a forged claim counts against the tenant it
names, so the field serves operations and cost estimates, and a
billing-grade count comes from the cell's own log of verified requests.

**Stacks.** Four stacks hold the components above, in this deploy order
(ADR-0010):

| Stack | Account | Region | Holds |
|---|---|---|---|
| Edge stack | edge | `us-east-1` | The ACM certificate for `<appDomain>` (and `*.<appDomain>` in `host` mode) and the CloudFront-scope web ACL with its rate rules (ADR-0009, ADR-0021) |
| Main stack | edge | The deployment Region, the control plane's (`eu-central-1` in the integration test) | The multi-tenant distribution and the pooled distribution tenant, the router, the KeyValueStore, the response headers policy (§7.1) and the SPA bucket; the registrar (API, function, resource policy); the custom resources for the `signin` key and the teardown; the published parameter. With `dedicatedDomains` on: the sweeper, its table, queue, schedules, log group and alarms, the guard and the starter. The `dedicatedDomains` switch is an update of this stack |
| Edge logging stack | edge | `us-east-1` | The log group, delivery source, delivery destination and delivery, after the main stack |
| `RouteHookAccess` stack | the control plane's | The control plane's | The hook parameter and the hook policy (§3.1), after the main stack, with that stack's `registrarUrl` as an input (ADR-0027) |

A cell's own stack (`CellRouteAccess`) is in the cell's account and Region.
The registrar requests the ACM certificates of dedicated domains, in
`us-east-1`, outside CloudFormation: no stack owns them, so the teardown
resource removes them (§6.2).

### 3.2 Request paths

| Path | Behaviour | Origin | Cache | Needs a tenant |
|---|---|---|---|---|
| `/assets/*` | static | SPA bucket | one year, immutable, shared by all tenants | no |
| `/`, other SPA routes | static, rewritten to `/index.html` | SPA bucket | `no-cache`, revalidated | no |
| `/config.json` | generated at the edge | none | `no-store` | in `host` mode, and on a dedicated domain in `single` mode |
| `/api/*` | dynamic | the tenant's cell API, in the cell's account | disabled | yes |
| `/agents/*` | dynamic, streaming | the agent ingress | disabled | yes |
| `/logout` | generated at the edge: 302 to the issuer's logout endpoint (§3.5) | none | `no-store` | no (`host` mode: a registered pooled host, §3.3 step 2) |
| `/signin-state` | generated at the edge, `host` mode only | none | `no-store` | yes, on a pooled host |
| `login.<appDomain>/callback`, `/logout` | the sign-in host, `host` mode only: 302, a static signed-out page, or 400 | none | `no-store` | no (§3.3 step 2) |

`/agents/*` uses the managed origin request policy
`Managed-AllViewerExceptHostHeader`. It forwards `Authorization` on `GET`
and `POST`, and it does not forward `Host`. The router strips `/agents`
from the path before the request leaves the edge (§3.3 step 7,
ADR-0019).

`/api/*` uses a custom origin request policy with the cache policy
`CachingDisabled`. It forwards exactly three headers: `x-tenant-token`
and `x-tenant-route` (§3.3 step 7), and `Content-Type`. CloudFront
refuses an `x-amz-*` name in an origin request policy. Origin access
control signs a request with a body with the viewer's own
`x-amz-content-sha256` and sends it to the origin with the signature
(ADR-0011), so that header also reaches the cell; it describes only the
caller's own body, Lambda checks it against that body, and the cell does
not read it. The policy forwards every query string and no cookie. It
does not forward `Host`, so the request reaches the origin under the
origin's own host name, which the signature covers, and it does not
forward `Authorization`, which origin access control overwrites. No
other request header reaches the cell.

Routes reach the route table on a path of their own, from the control
plane's workflow, never from a request or a cell account (ADR-0017):

| Control-plane event | Hook, phase | Registrar call | Values from |
|---|---|---|---|
| `CELL_CREATE`, `CELL_UPDATE` | `front-door-post`, `POST` | `PutCellRoute` | `CELL_ID`; the API domain from the cell script's `frontDoorApiDomain` output (`SCRIPT_OUTPUTS`, control-plane R-43) |
| `DEPLOYMENT_CREATE`, `DEPLOYMENT_UPDATE` | `front-door-post`, `POST` | `PutTenantRoute` | `TENANT_ID` |
| `DEPLOYMENT_DELETE` | `front-door-pre`, `PRE` | `DeleteTenantRoute` | `TENANT_ID` |
| `CELL_DELETE` | `front-door-pre`, `PRE` | `DeleteCellRoute` | `CELL_ID` |

The control plane runs a new cell's event, post hooks included, before
the deployment's (control-plane R-45), so a cell route exists before the
first tenant route that names it. The registrar takes each route's cell
and account from the control plane (§3.4 step 2), never from these
values. A cell's API domain is the one value a hook supplies, so the
registrar pins its form and lets the global hook role set it only once
(§3.4 step 3).

`/config.json` gives the SPA its public settings: the issuer's authorize
and token endpoints, the token-exchange endpoint when the `issuer` input
names one (`exchangeEndpoint`, §3.5), client id and scopes, the
`tenantClaim` name, so the SPA reads the tenant from the same claim as the
router and the cell (§3.6), plus the
tenant id (upper-cased back to its control-plane form, which the token
exchange expects), display name and `redirectUri`
(`https://login.<appDomain>/callback`) in `host` mode. Wherever the file
names a tenant it also carries `rev`, the route entry's `dt` (§4.1), which
the SPA ignores and the route hook reads to see that a replaced entry is
live (§4.2). It holds nothing secret. The SPA does not fetch the issuer's
discovery document (§7.1).
On a dedicated domain it also names `signInHost`, the host where
sign-in happens, to which the SPA sends the user (§3.5):
`<tenant>.<appDomain>` in `host` mode, from the tenant id the `host#`
entry gave the router, and `<appDomain>` in `single` mode. Neither
needs an extra read.
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
   `host#<host>`. No entry: 404 with a static page, which is also the
   answer for the apex `<appDomain>` in `host` mode: it is no pooled
   host and has no `host#` entry, and the sample points no DNS record
   and no distribution tenant at it. An entry: call
   `cf.logCustomData` with its `t` (§3.1), so every later answer on the
   host, SPA loads and step 4 refusals included, names the tenant; in
   `single` mode step 5 replaces it with the decoded claim.
3. `/agents`, and any path under `/agents/` that does not match
   `^/agents/[a-z0-9-]{1,32}/invocations$` (`/agents/` itself
   included), get 404 with a static body (ADR-0019). `/agents`
   without a slash falls under the default behaviour, so this check
   comes before step 8 rewrites it to `/index.html`. Paths that need
   no tenant (§3.2) skip to step 8, and so does `/signin-state` in
   `single` mode. With `agentIngress` off there is no `/agents/*`
   behaviour and no rewrite, and the router answers 404 for every
   `/agents` path that reaches it, a well-formed
   `/agents/<backend>/invocations` included (a `POST`, which the
   default behaviour refuses, gets CloudFront's own 403).
4. For `/api/*`, `/agents/*` and `/signin-state`, check `Sec-Fetch-Site`.
   Allow only `same-origin`, `none`, or no header; refuse the rest with
   403 (§7.3).
5. Find the tenant. An `Authorization` header longer than 8,192 bytes
   gets 401 with `WWW-Authenticate: Bearer`, in both modes and before
   any decode. The limit is chosen, not measured: it is about seven
   times the 1,184-byte token of spike S-7 and below CloudFront's own
   limit on the size of a request's headers, so no legitimate token is
   refused and the decode never runs on an unbounded input.
   - `single` mode: take the `Authorization: Bearer` token,
     base64url-decode its payload without checking the signature, read
     `tenant_id`, and lower-case it. No token, an undecodable token, or
     no single `tenant_id` (a token with a `tenants` list included): 401
     with `WWW-Authenticate: Bearer`. The SPA narrows a `tenants` token
     first (§3.5).
   - `host` mode: the tenant from step 2. `/signin-state` therefore gets
     404 for an unknown host and 503 for a suspended tenant (step 6), so
     a `state` is minted only for an active tenant. On `/api/*` and
     `/agents/*` the router also decodes the bearer token's `tenant_id`
     as in `single` mode, without checking the signature. No token, an
     undecodable token, or no single `tenant_id`: 401 with
     `WWW-Authenticate: Bearer`, as in `single` mode, so a client
     re-authenticates the same way in both modes. A lower-cased claim
     that names a tenant other than the host's: 403. A token for one
     tenant therefore never leaves the edge towards another tenant's
     cell, which may run in an account that tenant owns. A claim forged
     to match the host gains nothing: the forged token fails at every
     verifier (P-1).
   - `single` mode, on every host, before any answer: call
     `cf.logCustomData` with the claim this step decoded, or `-` when
     it found none (§3.1). CloudFront keeps only the last value, so on
     a dedicated domain the claim the router routes on replaces the
     host's tenant that step 2 logged. In `host` mode the tenant step 2
     logged stays, because a claim that differs from it is refused
     above. The value is never request data: an id that does not match
     the §4.1 pattern is logged as `-`.
6. Look up `tenant#<tenantId>`. No entry: 403, also in `host` mode for a
   `host#` entry with no `tenant#` entry, which a skipped delete hook can
   leave. Status `suspended`: 503 with `Retry-After`.
7. For `/api/*`, look up `cell#<cellId>` and set the request's origin to the
   cell's API domain with origin access control. No cell entry: 503.
   Origin access control signs the request and overwrites `Authorization`,
   so copy the bearer token into `x-tenant-token` (ADR-0011). Add
   `x-tenant-route: <tenantId>`, with the lower-case id, for `/api/*` and
   `/agents/*`. The `/api/*` origin request policy forwards both headers
   and three others (§3.2). `/agents/*` goes to the single `agentIngress`
   input, an origin without origin access control (the API Gateway or
   AgentCore Gateway ingress of `agentic-runtime-isolation`). Its origin
   path is the ingress's stage, for example `/prod` (§6.3). The ingress
   routes `POST /{backend}/invocations` with no `/agents` prefix, and
   CloudFront appends the request path to the origin path as it is, so
   the router drops the leading `/agents` from `request.uri`:
   `/agents/<backend>/invocations` reaches the ingress as
   `<originPath>/<backend>/invocations` (ADR-0019). Step 3 has already
   refused every other `/agents` path. The rewrite changes only `uri`,
   which holds no query string, so the query string goes on unchanged.
   CloudFront chose the `/agents/*` cache behaviour, and with it the
   origin, from the viewer's path before the function ran, and a changed
   `uri` changes neither (CloudFront Functions event structure, `uri`),
   so the rewritten request keeps this behaviour's origin and policies.
   Its origin request policy, `Managed-AllViewerExceptHostHeader`,
   forwards `Authorization` on `GET` and `POST` and does not forward
   `Host`.
8. Serve `/config.json` and `/logout` directly (§3.5). In `host` mode
   also serve `/signin-state` (§3.5), which answers 400 unless `nonce` is
   16 to 64 base64url characters; in `single` mode it is 404. In `host`
   mode `/signin-state` and `/logout` mint a `state` only on a pooled
   host (step 2); on a dedicated domain both answer 400. Rewrite SPA
   routes with no file extension to `/index.html`.

The router reads at most three keys per request. `/api/*` on a host it
looks up (`host` mode, or a dedicated domain) reads all three: `host#`,
`tenant#` and `cell#`. The token decode reads no key, so the `host` mode
agreement check of step 5 adds no read, and its compute is the decode
S-7 measured (13-14 %). The stress slice reads the function's compute
utilization once a minute, as the maximum over that minute's
invocations, and its highest minute is 94 % under ordinary load. The
two figures measure different things, one decode against the worst
invocation of a minute. What raises the worst invocation to 94 % is
not established, and the router's margin to the function's limit at
that reading is open (§11, Q-1). The router checks no
token signatures and writes nothing to the store; its only output
besides the request or the answer is the tenant id it passes to
`cf.logCustomData` (§3.1). In `single` mode it holds no secrets. In
`host` mode it holds one, the sign-in HMAC key in the `signin` entry
(§3.5, ADR-0016).

### 3.4 Route registrar, step by step

The registrar is a regional API in the edge account, in the main stack's
Region (§3.1), with `AWS_IAM` authorisation. Its resource policy admits
two principals by `aws:PrincipalArn`: the control plane's global hook
role,
`arn:<partition>:iam::<control plane account>:role/<fleet>-global-hook`
(§3.6), under which the route hook runs, and the **edge operator role**,
the role in the edge account that the deployer names in
`edgeOperatorRoleArn` (§3.6). The policy also carries an explicit `Deny`
with `ArnNotLike` on `aws:PrincipalArn`, listing those two ARNs, for
every other principal: without it,
any principal in the edge account whose identity policy allows
`execute-api:Invoke` gets in, because a same-account call needs only one
of the two policies to allow it (spike S-8). When the control plane runs
in another account, the hook role also needs `execute-api:Invoke` on the
registrar in its identity policy, which the `RouteHookAccess` policy
gives it (§3.1). No role of a cell account is admitted, its provisioning
role pair included, so a tenant-owned account reaches the registrar with
no credential it holds (ADR-0017). Admission only gets a caller to the
checks below; it grants no route.

The edge operator role is the vendor's own. The deployer brings it and
the stack only names it in the resource policy, so the stack creates no
principal that can suspend a tenant. It makes every vendor-only call:
suspending and resuming a tenant, setting a dedicated domain, backfilling
a cell route, changing a cell's origin and clearing a leftover route
(§5.1). It belongs to the vendor's operators and operations automation
alone, behind the vendor's usual sign-in and multi-factor rule, and no
role a cell account, a tenant or the control plane's hook role can assume
may reach it. Each call it makes appears in CloudTrail under its name,
which is the audit trail for vendor-only changes. The integration test
creates one for the run and removes it after (§10).

Every global hook on the control plane runs under the same
`<fleet>-global-hook` role (control-plane R-41). Admission therefore
proves that a vendor global hook is calling, not that the route hook is
calling for the record it names. So the registrar still reads the
control plane on every global hook write, takes the placement from
it, and admits a global hook's write only while the record has an
operation of the matching kind in flight (ADR-0015, ADR-0017). That binds a write to the
record's status, not to the hook, its phase or its execution: the record
carries no execution id to compare. Any global hook, in either phase,
can therefore write while a create, update or delete of that record
runs. For a tenant route that gains it nothing: the record supplies the
cell and account, a put keeps `s`, and a delete needs a deleting record.
A cell route's origin comes from the hook, so the registrar pins its
form and accepts it once (step 3). A global hook that sets a new cell's
origin before `front-door-post` does makes the route hook's own put
fail with 409, so the cell lands in `CREATE_FAILED` and no tenant is
placed in it (placement claims only `ACTIVE` cells, control-plane
§7.1); one that tries after it gets 409 itself. The residual, until the
control plane offers a role per global hook (control-plane §11): any
global hook can set the origin of a cell that has no route yet, during
the cell's create or, for a cell older than the hooks, during an
`UpdateCell`. That fails the operation: the cell lands in
`CREATE_FAILED` or `UPDATE_FAILED`, and cannot return to `ACTIVE`
while `cell#` holds an origin its own script did not write, until the
edge operator role replaces it (backfill, below). Any global hook can
also put a tenant's route during that deployment's create or update. In a tenant-owned account the cell
script, which the tenant controls, still chooses its own cell's origin
within the pinned form.

On every put (deletes and status changes run the subset of these steps
given below):

1. Take the caller's role from the signed request context: the global
   hook role or the edge operator role. Ignore any account or cell id in
   the body.
2. Read the placement from the control plane API with a reader token
   (control-plane R-36): the registrar's own app client on the vendor IdP,
   whose `role` is one of the control plane's `readerRoles`, so the
   registrar can read placement and change nothing:
   - cell route: `GetCell(cellId)`;
   - tenant route: `GetDeployment(tenantId, applicationId)`, where
     `applicationId` is the front door's own, and `GetTenant(tenantId)`,
     whose `name` becomes the display name `n` (§4.1). The hook sends
     no name: a body from any global hook running during the
     deployment's create or update could otherwise set the one
     tenant-facing string in the route.
3. Refuse with 403 when the record is missing or belongs to another
   application. A put from the global hook role also needs the record in
   `CREATING` or `UPDATING`, the statuses in which the control plane runs
   a `POST` hook on create and update (control-plane R-45): 409
   otherwise. The route's cell and account are the record's `cellId` and
   `accountId`. A cell route's `apiDomain` must be a Lambda function URL
   host in the control plane's Region, where the control plane
   provisions every cell (control-plane §1.2):
   `<url-id>.lambda-url.<region>.on.aws`, with a 32-character
   `[a-z0-9]` url id and `<region>` from the `controlPlane` input
   (§3.6); 400 otherwise. The origin is write-once for the global hook
   role: its put is accepted when `cell#<cellId>` is absent or already
   holds that `apiDomain`, and gets 409 otherwise. Only the edge
   operator role changes an existing origin (below). Cell ids are ULIDs
   and never reused, so a `cell#` key that a skipped delete hook left
   never blocks a new cell. The global hook role that sends a
   `customDomain` is refused with 403: only the edge operator role
   sets, changes or drops a tenant's dedicated domain, and the registrar
   routes it only after the tenant has passed the domain challenge of
   step 5 (ADR-0018). While `dedicatedDomains` is off (§3.6), the
   operator's `customDomain` gets 400. The
   operator's `PutTenantRoute` changes only the domain of an existing
   tenant route: the `tenant#` entry must exist, the deployment
   record's `accountId` must be that entry's `ac` and its `createdAt`
   (as Unix ms, §4.1) that entry's `dt` (409 otherwise), and the entry keeps its `c`, `ac`
   and `dt`. A hook's call keeps the stored domain and its challenge, unless
   its record is a new deployment (step 5).
4. A tenant route also needs its cell's route to exist, with the
   deployment's account as its `ac` (for the operator's call, the tenant
   route's): 409 otherwise. A `customDomain` must be one lower-case host
   name of at most 64 characters, ACM's limit on a certificate's primary
   name, with no wildcard label: 400 otherwise. One that equals
   `appDomain` or ends in `.<appDomain>` is refused with 400, so no tenant route can
   hold a pooled host or a reserved label. When `host#<customDomain>`
   exists and its `t` names another tenant, the write is refused with
   409, so no tenant route can take another tenant's dedicated domain.
   The same 409 answers a new `customDomain` for which the registrar
   already holds a certificate tagged with another tenant: that tenant
   holds the domain pending, and the sweeper deletes the certificate,
   releasing the claim, only once the domain is no longer that tenant's
   `d` (step 5). ACM keeps one validation record per domain name per
   account and reuses it for every later certificate for that name, so
   without this check a certificate requested for a second tenant would
   validate from the first tenant's record. These checks run on every
   operator call for a domain, before a challenge is issued and before
   every repeat, so no tenant is issued a token for a domain another
   tenant holds.
5. Write the route table with the store's ETag (`IfMatch`), and record
   the account the control plane placed the cell or deployment in
   (`ac`, on `tenant#`, `host#` and `cell#` entries alike); the
   operator's domain change keeps the tenant route's account. A
   `tenant#` entry also records `dt`, the deployment's `createdAt` from
   `GetDeployment` (§4.1). A hook put whose record's `createdAt` equals
   the stored `dt` writes to the existing entry, so the hook's own
   retries and every update stay idempotent. One whose `createdAt`
   differs has met an entry that an earlier deployment of the tenant
   left when its delete hook was skipped (below): the registrar
   replaces it with a new entry for the new deployment, and removes the
   old entry's `host#` keys and its domain as a delete would. The new
   entry keeps the old entry's `s`, so a suspended leftover stays
   suspended. A `tenant#` entry with no entry before it gets
   `s: active`. Any write to an existing entry keeps its `s`, whether
   the global hook role or the edge operator role makes it, and a
   replacement does the same: only `UpdateTenantRouteStatus` changes it
   (§4.2).

   A dedicated domain is kept in the `tenant#` entry as `d`, with its
   domain challenge as `dk` and `dx` (§4.1, ADR-0018). The operator's
   `PutTenantRoute` with a `customDomain` runs in this order, so a
   repeat finds what an earlier call made:
   1. When `customDomain` is not the stored `d`, write it as `d` first,
      with the ETag, together with a new challenge, and remove the old
      domain and its challenge as below. The challenge token `dk` is 32
      bytes from a cryptographic random source, base64url without
      padding (43 characters); `dx` is its expiry, 7 days out. Answer
      202 with `stage: "domain-challenge"`, the record to publish,
      `_tfd-challenge.<d>` TXT `tfd-verify=<dk>`, and the expiry as
      `expiresAt` (`dx`, Unix seconds). Every 202 with
      `stage: "domain-challenge"` carries `expiresAt`. This
      call looks nothing up: no record can hold a token that did not
      exist before it.
   2. Challenge open (`dx` present): when `dx` has passed, issue a new
      token and expiry as in sub-step 1 and answer 202 with
      `stage: "domain-challenge"` and the new record; the old token no
      longer passes. Otherwise resolve TXT at
      `_tfd-challenge.<d>` with the function's default resolver (below).
      When one record's strings, joined, equal `tfd-verify=<dk>`, the
      challenge passes: remove `dx` with the ETag, keep `dk`, and go on
      to sub-step 3 in the same call. Other values at the name, a former
      holder's or another tenant's token among them, are ignored. The
      registrar refuses a CNAME at `_tfd-challenge.<d>`: it also asks
      for a CNAME at the name, and a CNAME answer is a mismatch whatever
      its target holds, so a CNAME left pointing into a zone someone
      else can register never passes. Any other answer gets 202 with
      `stage: "domain-challenge"`, the same record and one of three
      `challenge` values: `"missing"`
      (the name does not exist, or holds no TXT record), `"mismatch"`
      (TXT records, none with this token, or a CNAME) or `"unresolved"`
      (the resolver answered SERVFAIL or REFUSED, or timed out, on
      every lookup, below). A resolver error is never a pass. No
      certificate is requested before the challenge passes.
   3. Challenge passed (`dk` without `dx`): find what exists and create
      only what is missing. The certificate is an ACM certificate in
      `us-east-1`, which CloudFront requires, requested by the registrar across Regions with DNS validation and
      tagged with the tenant id (`tenant-front-door:tenant`, lower-case),
      the distribution id (`tenant-front-door:distribution`) and the cost
      allocation tag `TenantId`, the tenant id in the control plane's
      upper-case form, so Cost Explorer and CUR split the domain's
      certificate and distribution tenant by tenant once the deployer
      activates the tag (standard §4.4). A request past
      ACM's certificate quota fails with `LimitExceededException`, and
      the call answers 429 with `reason: certificate-quota` (§5.1). The
      registrar finds it among its own certificates by domain name and tags,
      taking an issued one first, then a pending one. A certificate in a
      terminal status (`FAILED`, `VALIDATION_TIMED_OUT`, `REVOKED` or
      `EXPIRED`) counts as absent, so the call requests a new one, and so
      does one the sweeper deleted between the list and its read. The
      request's idempotency token is the first 32 hex characters of a
      SHA-256 over the distribution id, the tenant id, the domain and `dk`,
      so a repeat within ACM's hour gets the same certificate and a new
      challenge gets a new one. The registrar finds the distribution tenant
      with `GetDistributionTenantByDomain`.
   4. Certificate pending: answer 202 with `stage: "certificate"` and
      ACM's validation record. The operator repeats the call once the
      tenant has published the record in the domain's DNS. ACM attaches
      a new certificate's validation record a few seconds after the
      request; the registrar reads the certificate up to five times, 1 s
      apart, and when the record is still not there it answers the 202
      without `record`, and the operator repeats the call to get it.
   5. Certificate issued: resolve `_tfd-challenge.<d>` again as in
      sub-step 2, because up to 72 hours may have passed since the
      challenge did. When the challenge passed in sub-step 2 of the same
      call, seconds earlier, this lookup is skipped, which also keeps the
      call's DNS time to sub-step 2's two queries. Unless the record still holds `tfd-verify=<dk>`,
      answer 202 with `stage: "challenge-recheck"`, the record and its
      `challenge` value (`"missing"`, `"mismatch"` or `"unresolved"`, as
      in sub-step 2) and write no `host#<d>`; the certificate stays, the
      challenge stays passed, and the operator repeats the call once the
      record is back. Otherwise create the distribution tenant with the
      certificate, on this distribution, in the stack's connection group
      (the pooled distribution tenant's) and with the same tags, unless
      it exists. The tenant points the domain with a CNAME at that
      connection group's routing endpoint, which the main stack publishes
      as its `RoutingEndpoint` output (§6.4); the domain serves once that
      record resolves and the distribution tenant has deployed. Its name is `tfd-` and the first 32 hex characters of a
      SHA-256 over the distribution id, the tenant id and the domain, 36
      characters, inside CloudFront's 128 for any id and domain. A
      distribution tenant for the domain that is this tenant's and
      disabled (the domain was dropped and set again before the sweeper
      deleted it), or that holds another certificate, is updated to serve,
      enabled, with this certificate. Then write `host#<d>`; answer 200. No request is routed on
      the domain before then. Once `host#<d>` exists, a repeat looks
      nothing up, changes nothing and answers 200.
   6. Certificate failed or timed out, within and after ACM's hour:
      the request of sub-step 3 derives its idempotency token from
      `dk`, and ACM keeps a token for one hour, so the answer depends on
      when the repeat comes. A repeat within the hour of a request whose
      certificate failed gets that certificate back and answers 422
      whose `message` carries ACM's failure reason. A repeat after the
      hour requests a new certificate under the same `dk` and answers
      202 with `stage: "certificate"`, or 422 again when the cause
      persists (a CAA record that admits no Amazon CA, for example). ACM
      stops waiting for validation after 72 hours, so a timed-out
      certificate is always past its hour: a repeat requests a new
      certificate and answers 202 `certificate`, never 422. Each new
      request counts once against ACM's yearly certificate requests
      (§4.1), so repeats over a persistent failure spend one request per
      hour in which they come; the operator fixes the cause the 422 names
      before repeating. The sweeper keeps a registrar certificate in a
      terminal status until an hour after its `CreatedAt`, so the 422 and
      its reason hold for the whole hour, and then deletes it if nothing
      uses it, whatever its tenant's `d`, logging `certificate deleted`
      with its status and ACM's `FailureReason` (an ACM enum value, never
      tenant data). A timed-out certificate is past its hour, so the
      sweeper's next run deletes it. A repeat within the hour can still
      get back the ARN of a certificate deleted another way (by hand, or
      by another tool). The registrar reads a certificate that no longer
      exists (`ResourceNotFoundException`) as no certificate: it answers
      202 `certificate` without `record`, and a repeat after the hour
      requests a new one. Dropping the domain and
      setting it again issues a new challenge and so, once it passes, a
      request under a new token, at any time.

   The token binds the challenge to one tenant and one domain: it lives
   in that tenant's `tenant#` entry next to `d`, is compared only for
   that `d`, and goes when `d` goes. A token issued to another tenant,
   or for another domain, is never compared, and a former holder's
   record names a token that was removed with its `d`, so neither
   passes. The resolver is the default one of a Lambda function outside
   a VPC, AWS's recursive resolver: no third party, no egress rule and
   no resolver code. It caps the TTL of an answer at 300 s and keeps a
   negative answer for the zone's negative-caching TTL, the lesser of
   the SOA's TTL and its minimum field. Its caches are not one, so
   lookups in one invocation can get different answers: S-10's data
   shows that, once the record was in the zone, the first lookup of an
   invocation still got the cached negative answer in 28 of 318
   invocations (34 of 315 for a second name), and all five of its
   lookups did in only 7 (3). Each query, TXT or CNAME, in sub-step 2,
   in sub-step 5 and in the daily re-check therefore makes up to five
   lookups about 100 ms apart and stops at the first lookup that finds
   what it looks for. Each lookup is one try, abandoned after 1 s of
   wall time, for example through a Node.js `Resolver` built with
   `timeout: 1000, tries: 1`: a plain `timeout` is per try, and the
   default lookup inherits `timeout:2 attempts:5` from
   `/etc/resolv.conf`. The 1 s is a chosen value, not a measured one:
   S-10's longest lookup took 64 ms. The match is a record holding
   `tfd-verify=<dk>`, or a CNAME. A query with no such lookup takes its
   outcome from the lookups that got an answer: `mismatch` when any of
   them held TXT records or a CNAME, `missing` otherwise. It is
   `unresolved` only when every lookup errors; a mix of errors and
   misses is a miss. The CNAME query runs only when the TXT query was
   empty or matched, and a TXT match passes only when the CNAME query
   got an answer: a TXT match whose CNAME query errored on every lookup
   is `unresolved`, so a pass never rests on a CNAME query that did not
   answer. A query takes at most
   5.4 s. A call makes at most two queries, because sub-step 5 skips its
   lookup when sub-step 2 passed in the same call, so 10.8 s of DNS and
   the ACM calls of sub-step 3 (up to five validation-record reads 1 s
   apart) fit API Gateway's 29 s integration limit and the registrar
   function's 30 s timeout. An environment whose first lookup got the cached negative
   answer got it again on its next invocation's first lookup about half
   the time (14 of 24 and 16 of 31). So a repeat made before the tenant
   published the record can still answer `missing` for as long as the
   zone's negative-caching TTL, 15 minutes for a zone whose SOA TTL is
   900 s and minimum at least 900 s (spike S-10). The tenant's DNS
   provider sets that TTL, and it can be an hour or more. The operator
   repeats the call, which is repeat-safe, only after the tenant
   confirms the record is published and, if `missing` persists, after
   that zone's negative-caching TTL; the 7-day `dx` bounds how long the
   challenge stays open. A tenant that publishes the record before the
   first repeat meets no delay. A changed value is read as the old one
   for at most the record's TTL, and a record whose strings were split
   arrives as an array of strings per record, which the function joins.
   Caching can delay a pass but never cause one, because no cached
   answer can predate the token. The check
   trusts one DNS answer from one Region without DNSSEC, as ACM's own
   DNS validation does. Shortcut: one vantage point; upgrade to a second
   Region's answer, or DNSSEC validation, when a vendor needs the
   multi-perspective check public certificate authorities make.

   The tenant keeps the `_tfd-challenge` record for as long as it
   holds the domain, pending or routed. A second EventBridge Scheduler
   schedule runs the sweeper daily over every `tenant#` entry with a
   passed challenge (`dk` without `dx`), routed or not, because a
   certificate request still pending rests on the same proof as a
   routed domain. The re-check keeps its state in a DynamoDB table the
   sweeper owns (ADR-0020), in the main stack, deployed and removed with
   the sweeper. The table has string keys `pk` and `sk`, on-demand
   capacity, point-in-time recovery and a time-to-live attribute
   `expiresAt`. Only the sweeper's role reads or writes it (the
   integration test role also does, §10); the registrar's role has no
   access, and the route table stays registrar-only (P-3). It holds no
   token and two kinds of item:

   - An entry item for each tenant and domain checked: `pk` `ENTRY`,
     `sk` `<tenantId>#<d>`, with `lastCheckedDay` (UTC date),
     `lastOutcome` (`pass`, `miss` or `error`), `missStreak` and
     `errorStreak` (consecutive checks, after that day's outcome), and
     `missBefore` and `errorBefore` (the same counts before it).
   - A run item for each UTC day: `pk` `RUN`, `sk` the UTC date, which
     is the run's `runDay`, with `pagesStarted` (a number),
     `pagesFinished` (a set of page numbers) and an `expiresAt` 14
     days out.

   A run is one UTC day, and the run item is its identity. The lister
   takes the date it starts on; every attempt starts before 06:00 UTC
   (below), so the date does not change between attempts. A Lambda or
   Scheduler retry of the lister, the starter's run and a run started by
   hand on the same day are one run: they write the same items, and the
   day rule below makes a repeat change nothing. The lister passes its
   date to each page it starts. A page compares that date with the
   current UTC date when it starts and, when they differ, logs a
   stale-page line naming the date and the page number and exits as a
   no-op, writing no item. Otherwise the page uses the passed date as
   today for every read and write: the `lastCheckedDay` it compares and
   writes, the day rule's condition (below) and the run item whose
   `pagesFinished` it adds to. A page that starts before midnight and
   ends after it files all of its outcomes and its page number under its
   own day. The date is therefore not an input a caller can choose: a
   page acts only on the day it starts, and the Scheduler's input names
   no date (ADR-0022). A page that the on-failure queue redrives on a
   later day is dropped this way, so it never files outcomes or a page
   number under a day its lister did not start, and it shows as a
   missing page for its own day (below). The integration test reaches
   other days by editing items (§10 step 14).

   The lister (1) lists the entries with a passed challenge; (2) reads
   the previous day's run item and emits the missing-pages count
   (below); (3) deletes the entry items whose tenant and domain are not
   among those entries, which is how an item goes when its domain is
   changed or dropped or its tenant route is deleted; (4) sets
   `pagesStarted` on today's run item to the number of pages, zero
   included; and (5) starts one asynchronous run of the sweeper per page
   of 500 entries, passing the page number and the page's list of
   tenant ids. Ids are at most 63 characters, so 500 of them are about
   33 KB of payload, inside the 1 MB limit of an asynchronous
   invocation ([Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html),
   "Invocation payload", checked 2026-11-18). A page checks only the ids
   it was passed. It reads each one's `tenant#<id>` entry again with
   `GetKey`, 10 at a time, and skips one whose `d` is gone or whose
   challenge is open; it does not scan the route table (ADR-0022). A
   `GetKey` that returns `ResourceNotFoundException` means the entry is
   gone (the tenant route was deleted after the lister ran): the page
   skips that id, logs one line naming the tenant id, writes no item
   for it (the next lister deletes its items) and goes on. The lister
   has just read the store, so a 404 here is a missing key, not a
   missing store. It resolves the others
   as sub-step 2 does, 10 queries at a time, each with up to five
   lookups of one try abandoned after 1 s. It queries CNAME at the name
   only when the TXT answer is empty or holds the token, so a pass
   never rests on a CNAME. An entry ends in a pass, a miss (`missing` or
   `mismatch`) or an error (`unresolved`).

   Each entry's outcome is recorded once for each UTC day. Today is the
   page's date throughout. The page reads the entry's item (a consistent
   read) and takes the counts before today from it: `missStreak` and
   `errorStreak` when `lastCheckedDay` is earlier than today,
   `missBefore` and `errorBefore` when it is today, zero without an
   item. A pass sets both counts to 0. A miss adds 1 to `missStreak` and
   sets `errorStreak` to 0. An error adds 1 to `errorStreak` and leaves
   `missStreak` as it was, so an error day neither resets nor extends
   the miss streak and a resolver outage never looks like a lost proof.
   One `UpdateItem` writes the item, on the condition that the item does
   not exist, or `lastCheckedDay` is earlier than today, or it is today
   and `lastOutcome` is weaker than this outcome (error is weaker than
   pass, pass weaker than miss). A repeated page, a lister retry or an
   extra run on the same day therefore changes nothing; a miss after a
   pass the same day replaces it, because a miss only counts toward
   three; a failed condition is a no-op, not an error. A day on which a
   page failed leaves the item as it was, so a streak counts consecutive
   checks, not calendar days: a failed page delays an alarm and never
   cancels one.

   When this write's outcome is a miss and it leaves `missStreak` at 3
   or more, the page logs a three-miss line naming the tenant and the
   domain, never the token, and emits one count, as an embedded metric
   format log line, to the metric the three-miss alarm watches. A domain
   that stays broken counts again on every later miss; an error day or a
   pass emits no three-miss count (ADR-0022). When a write leaves
   `errorStreak` at 3 or more, the page logs an `unverifiable` line and
   counts to a metric and alarm of its own, so whoever controls a
   domain's DNS cannot hold it out of detection by breaking only
   `_tfd-challenge.<d>`; a resolver outage does not last three days. A
   write that did nothing emits nothing. Shortcut: an item's identity is
   the tenant and the domain, so a domain dropped and set again between
   two daily runs keeps its earlier streaks and can alarm early; upgrade
   to a key that includes a hash of `dk` when that matters. A lost table
   restarts every streak at zero.

   When a page has recorded its last entry it adds its page number to
   `pagesFinished` (an `ADD` to a set, so a retried page adds nothing).
   A page that fails before that, after Lambda's two retries, is kept in
   the sweeper function's on-failure destination, an SQS queue. Each of
   a page's DynamoDB calls is made once, with a 2 s limit, and a failed
   call fails the page. Each `GetKey` read is likewise made once, with a
   2 s limit, and a read that fails with any error other than
   `ResourceNotFoundException` (above) fails the page. The limit is chosen, not
   measured: no spike measured `GetKey` latency from the deployment
   Region to the store's global endpoint, so the page logs the time its
   reads took and the integration run records it (§10 step 14). The
   reads cost the page's size, not the store's: a page takes at most
   500 ÷ 10 × 2 s = 100 s for the reads, plus 500 ÷ 10 × (2 queries ×
   5.4 s + 2 calls × 2 s) = 740 s, plus 2 s to finish, 842 s, inside the
   sweeper function's 15-minute timeout of 900 s (ADR-0022).
   The route table holds at most 3,472 dedicated tenants (§4.1), so a
   run is at most 7 pages.

   A run records only on the UTC day it starts, because a page that
   starts on a later day exits as above. A run by hand late in the day
   can therefore lose the pages that start after midnight; they show as
   missing pages for that day. The daily schedule fires at
   02:00 UTC with a retry policy of at most 2 retries and a maximum
   event age of 1 hour, and the sweeper function's asynchronous
   invocation configuration keeps an event for at most 3 hours, with
   two retries. With the 15-minute timeout, the lister's last attempt
   starts by 06:00 UTC and ends by 06:15, and the last attempt of its
   last page starts by 09:15 and ends by 09:30 UTC. The next day's lister
   emits a missing-pages count, as an embedded metric format log line:
   the page numbers from 1 to `pagesStarted` on the previous day's run
   item that `pagesFinished` lacks, zero included. A previous day with no
   run item counts as one missing page only when the table holds an
   earlier run item (a query for one run item below that day); otherwise
   the count is 0. So the first run after the sweeper is deployed, or
   after `dedicatedDomains` is turned back on, does not alarm, and a run
   that never started alerts on any later day. A failed read fails the
   lister, which Lambda and the Scheduler retry. The run it judges ended
   by 09:30 UTC the day before, so the count is always about a finished
   run. Four alarms watch the re-check itself besides the three-miss
   alarm: the queue's depth; the `unverifiable` count; and two on the
   missing-pages count. The missing-pages alarm fires on a `Maximum`
   above zero over one one-day period, 1 of 1, with missing data not
   breaching. The no-lister alarm fires on a `SampleCount` below one over
   two one-day periods, 2 of 2, with missing data treated as breaching.
   A count, zero included, never breaches it, and yesterday's count
   keeps today's empty period from tripping it; two days with no lister
   alarm it. So that it has a datapoint within minutes of deployment, a
   custom resource, the starter, deployed with the sweeper and after it,
   invokes the sweeper function asynchronously with the Scheduler's
   input on its Create (the stack created with `dedicatedDomains` on, or
   the update that turns it on) and does nothing on any other event. No
   `tenant#` entry holds a `d` then, so its run sets `pagesStarted` to 0
   and emits 0, and the next daily run judges that finished zero-page
   run. The alarm can read ALARM for the few minutes that run takes. The
   starter does not wait for it, so a failed deploy-time run does not
   fail the deployment: the alarm then reads ALARM until the first daily
   run, which finds no run item and emits 0. An invoke that Lambda
   refuses (a missing grant or function) fails the starter, and with it
   the deployment.

   The sweeper function runs one of three jobs, named by its input's
   `job`: `{"job":"remove"}` from the 15-minute schedule;
   `{"job":"recheck"}`, the lister, from the daily schedule, the starter
   or a run by hand; and `{"job":"page","runDay","page","tenantIds"}`,
   which only the lister sends. Any other input fails the invocation.
   Both schedules retry a delivery at most twice and send one they could
   not make to the on-failure queue as their dead-letter queue, so the
   queue's depth alarm covers them too. The removal schedule's maximum
   event age is 15 minutes, because the next run redoes the work.

   The alarms' periods: the three-miss and `unverifiable` alarms fire on
   a `Sum` of at least 1 over one one-hour period, 1 of 1, with missing
   data not breaching, so a count alarms within the hour of the page that
   wrote it. A domain that stays broken therefore alarms for that hour
   after each daily page and then returns to OK until the next page
   counts again: an OK after an ALARM does not mean the domain was
   fixed, and the operator acts on the ALARM itself. The queue-depth alarm fires on a `Maximum` of at least
   1 visible message over one five-minute period, the queue metric's own
   period, with missing data not breaching.

   Size and cost. At the ceiling of 3,472 dedicated tenants the table
   holds 3,472 entry items of under 400 bytes, about 1.4 MB, and about 14
   run items. A day makes at most 3,472 reads and 3,472 writes in the
   pages and one paginated query in the lister, so about 104,000 reads
   and 104,000 writes a month, on demand, with no capacity to plan.

   In spike S-10 a deleted record whose TTL (86400) was above the
   resolver's 300 s cap was still served 661 s after its deletion, in
   one run; values changed at TTL 60 and 300 were read as the old one
   for at most their TTL. A run that starts while the resolver still
   serves a removed record can pass, and while any such stale window is
   under a day the alarm fires at most one UTC day later than it would
   otherwise. The alarm means that the tenant does not show control of
   a domain it claimed: for a routed domain, the domain may have
   changed owner; for a pending one, the certificate request rests on a
   proof that is gone. The alarm tells the operator, who drops the
   domain with `PutTenantRoute` or removes the route. The sweeper never
   drops a domain itself: a DNS fault or a tenant's mistake would then
   take a domain offline with no person deciding. This covers a domain
   that changes owner: the new owner's zone lacks the record, the alarm
   fires, and the old tenant's route stays until the operator drops it.
   An operator call with the same domain after 200 does not re-check and
   answers 200; a changed domain gets a new challenge. ACM's managed
   renewal depends on ACM's validation record, not on this one, and the
   re-check does not follow renewals.

   CloudFront refuses a second distribution tenant for a domain one
   already serves (`CNAMEAlreadyExists`), and a distribution tenant
   found for the domain that is on another distribution or tagged with
   another tenant belongs to someone else: both answer 409, naming no
   tenant. With the certificate check of step 4 one tenant at a time
   holds a domain, pending or routed. An open challenge holds no claim:
   two tenants may hold open challenges for one domain, the first whose
   token is published gets the certificate, and the other's next call
   gets 409 (step 4). Two operator calls for one domain
   and two tenants that run at once can both pass that check; then only
   one gets the distribution tenant, and the other gets 409 and keeps a
   pending `d` until the operator drops it.

   Removal runs in two phases. CloudFront deletes only a disabled
   distribution tenant, disabling deploys over minutes, longer than an
   API request may run, and ACM deletes only a certificate that nothing
   uses. When a domain is changed or dropped, or its tenant route is
   deleted or replaced, the write removes `host#<d>`, `d`, `dk` and `dx` at once,
   so routing on the domain stops after propagation, and then disables
   the domain's distribution tenant. That disable is best effort: the
   write has landed, so an error (a throttle, or a distribution tenant
   for the domain that is not this tenant's) is logged by its error name
   and the call keeps its answer. The sweeper later disables one left
   enabled that is this tenant's and this distribution's, and leaves any
   other alone. The sweeper (§3.1), run
   every 15 minutes by EventBridge Scheduler, lists this distribution's
   dedicated distribution tenants and the registrar's certificates. It
   skips the pooled distribution tenant by its id, which the stack
   passes it as it does to the guard, before it reads it or its tags.
   That skip is a second guard: the pooled distribution tenant's
   distribution tag is `pooled/<distribution id>`, which matches no
   grant, so IAM refuses the sweeper's update and delete on it (§3.4
   IAM paragraphs).
   A distribution tenant whose domain is no longer the `d` of the
   tenant it is tagged with is disabled if it is still enabled, deleted
   once it is disabled and deployed, and its certificate deleted after
   it. A registrar certificate that never had a distribution tenant
   (the domain was dropped or changed while the certificate was
   pending), and whose domain is no longer the `d` of the tenant it is
   tagged with, is deleted on its own. So is a registrar certificate in a
   terminal status (sub-step 3) that no distribution tenant uses, whatever
   its tenant's `d`, once an hour has passed since its `CreatedAt`, because
   it can never serve and counts against ACM's quota. Within that hour,
   ACM's idempotency window, it is kept like a pending certificate, so a
   repeat still gets its 422 (sub-step 6). Its `certificate deleted` log
   carries its status and ACM's `FailureReason`. The sweeper reads the tenant's `d` with `GetKey` again right
   before each disable and each delete, with no cache for the run, so a
   domain the registrar set again meanwhile is left alone. A disabled
   distribution tenant whose domain is its tenant's `d` and whose
   `host#<d>` names that tenant is left as it is and logged as
   `distribution tenant disabled on a routed domain`. A removal cannot
   leave it: the sweeper reads `d` after `GetDistributionTenant` and
   sends that read's ETag with every disable and delete, and the
   registrar re-enables only after its own `d` write, so a re-enable
   either lands before the sweeper's `d` read, which then finds `d`, or
   after its `GetDistributionTenant`, which makes the ETag stale. The
   log detects a distribution tenant disabled outside the registrar and
   the sweeper, by hand or by another tool. Nothing repairs it, and a
   routed repeat looks nothing up, so the operator drops the domain and
   sets it again. The
   sweeper finds what a crashed call left the same way. A changed domain is offline
   from the write until the new one validates. Before it touches a
   distribution tenant or a certificate, the registrar checks that its
   tags name this tenant and this distribution (409 on a domain call, a
   logged refusal on a release), so a write for one tenant never removes
   another tenant's domain.
   CloudFront returns a distribution tenant's tags only from
   `ListTagsForResource` on its ARN: `GetDistributionTenantByDomain`,
   `GetDistributionTenant` and `ListDistributionTenants` carry none
   (design/spikes.md, Smoke run), so the registrar, the sweeper and the
   teardown read them there.

   On an ETag conflict, re-read the keys the write touches and repeat
   the step 3 operator checks, step 4 and the 507 size check (§4.1)
   before the next attempt. Two writers that race for one domain
   therefore cannot both pass, and an operator write that loses to a
   delete gets 409. A write that rests on a DNS answer, the pass of
   sub-step 2 and the `host#<d>` write of sub-step 5, is attempted again
   only when the re-read entry still holds the `d` and `dk` that answer
   was compared against. Otherwise the sub-steps start again from the
   re-read entry, at sub-step 1 when `d` changed and with a new lookup
   when `dk` is new, so no write marks a token passed that no answer
   held.

   Every writer shares the store's one ETag (ADR-0003), so writes
   serialise and a conflict costs a re-read. The registrar attempts a
   write at most five times, with a jittered backoff of 50 to 500 ms
   between attempts, and then answers 503, which the route hook
   retries (route hook step 4: five attempts over about two
   minutes). These bounds are chosen, and so is the stage throttle,
   10 calls a second with a burst of 100. The rates that follow are
   measured by the stress slice (`scripts/stress/README.md`, small
   tier). A run starts with a burst of 20 writes at once, then writes
   one a second for 30 s. In such a run a write takes 0.50 to 0.51 s
   at the median, 7.2 to 7.8 s at the 95th percentile and 8.2 to 8.6 s
   at the 99th, because every writer waits on the store's one ETag.
   The 20 writes of the burst are all written within 16 s, which includes the
   measuring client's own wait of about 5 s before it tries a 503
   again, so the store takes no longer than that. About one registrar
   call in twelve of such a run answers 503 after the registrar's five
   attempts, and the route hook retries it. The load assumed is about
   one write a second; nothing throttles the registrar to it, and at
   that load the store has room for the retries. A burst of 20
   creates at once is the largest one characterised, and the capacity
   above it is not. A burst the store cannot clear within the hook's
   retries leaves creates in `CREATE_FAILED`, which the operator
   deletes and creates again (route hook, after step 4). Sharding by
   distribution, each shard with its own store and ETag (ADR-0012), is
   the way past the ceiling.
6. Log the caller role, key and outcome, never the body.

Deletes run steps 1 and 2, the write of step 5 with its ETag and its
conflict re-read but without the domain sub-steps, and step 6. A delete
from the global hook role needs
the record missing or in `DELETING`, the status in which the control
plane runs a `PRE` hook on delete: 409 otherwise, so no global hook can
remove the route of a live cell or deployment. A missing record is
accepted so that cleanup works after the control plane has already
removed it (P-9 of the control plane: cleanup is always reachable). A
delete removes a `host#` key only when its `t` names the tenant, and
finds the tenant's dedicated `host#<d>` key from the `d` of its
`tenant#` entry. The edge operator role's deletes skip step 2: it may
remove any tenant or cell route, to clear one that a skipped delete
hook left behind (below). `UpdateTenantRouteStatus` skips step 2 as
well: it runs step 1, the write of step 5 with its ETag and its
conflict re-read but without the domain sub-steps, and step 6. It
changes only `s` of an existing `tenant#` entry and copies every other
field as stored, so the operator can suspend a tenant while the control
plane cannot be read (ADR-0025). A tenant with no `tenant#` entry gets
409. Status changes (`suspended`, `active`), dedicated domains and
`DeleteHostRoute`, which clears a `host#` key left behind (§5.1), are
vendor operations: only the edge account's operator role may make them.

The edge operator role may also call `PutCellRoute`, with the same
`GetCell` check and origin form, the record's account and `apiDomain`
from the body, but with no status check and with the right to change an
existing origin. It serves two cases:

- **Backfill.** A cell created before the front door's hooks were
  registered, or whose stamped scripts write no `frontDoorApiDomain`,
  has no cell route, so every deployment placed in it gets 409 from its
  hook and lands in `CREATE_FAILED`. The operator takes each such cell's
  API domain from the cell stack's outputs and calls `PutCellRoute` for
  the cell, which also replaces any origin a global hook wrote meanwhile
  (§3.4, the residual above). The cell must be `ACTIVE`, because the
  control plane refuses `UpdateDeployment` in a cell that is not
  (control-plane R-13). The operator then runs `UpdateDeployment` for
  each `ACTIVE` or `UPDATE_FAILED` deployment in the cell, whose
  `front-door-post` writes the tenant route, and deletes and creates
  again each `CREATE_FAILED` one, which `UpdateDeployment` refuses
  (control-plane §5.2; the failure paragraph below). `UpdateCell` is not
  the path: it runs the cell's stamped update script (control-plane
  P-4), and a stamp that writes no `frontDoorApiDomain` fails the hook
  on every `UpdateCell`, leaving the cell in `UPDATE_FAILED`. Such a
  cell stays unable to update under a front door, because a stamp is
  immutable, and once it is in `UPDATE_FAILED` it takes no new
  deployment and no deployment update. Tenants it already routes stay
  routed; a tenant without a route, or one that needs an update, moves
  to a new cell by delete and create. Backfill therefore runs before
  any `UpdateCell` of such a cell. The
  definition-replacing `UpdateCell` field is a control-plane seam
  (control-plane §11).
- **Origin change.** When a cell update moves the cell's API to a new
  host, the hook's put gets 409 and the cell lands in `UPDATE_FAILED`.
  The operator confirms the new host, sets it with `PutCellRoute`, and
  retries `UpdateCell`, whose put now matches.

Besides the store, the registrar's role holds the CloudFront actions
a domain call needs (`CreateDistributionTenant`, with tagging on
create, `GetDistributionTenantByDomain`, `ListTagsForResource` on
distribution tenants and `UpdateDistributionTenant`) and, in
`us-east-1`, the ACM actions `RequestCertificate`,
`DescribeCertificate`, `ListCertificates`, `ListTagsForCertificate` and
`AddTagsToCertificate`. The creates (`CreateDistributionTenant`,
`RequestCertificate`) and the tag grants (`cloudfront:TagResource`,
`acm:AddTagsToCertificate`, which CloudFront and ACM authorise for the
tags of a create) require `aws:RequestTag/tenant-front-door:distribution`
to be this distribution's id and allow no tag keys but the registrar's
three. The tag grants also require `aws:ResourceTag/tenant-front-door:distribution`
to be this distribution's id. CloudFront and ACM authorise the tags of
a create through the tag grants with the request's tags as the
resource's, so a create passes; a resource with no distribution tag, or
another front door's, is refused, so the role cannot put the
distribution tag on a resource it did not create; it can still rewrite
the tenant tags on its own (threat model AR-33). `UpdateDistributionTenant` requires
`aws:ResourceTag/tenant-front-door:distribution` to be this
distribution's id. The main stack creates the pooled distribution tenant
with `tenant-front-door:distribution` set to `pooled/<distribution id>`.
The value is no distribution's id, so IAM refuses every front door's
registrar the tag grants on it, and the `UpdateDistributionTenant` and
`DeleteDistributionTenant` of every front door's registrar, sweeper and
teardown. No code reads the value. The residual is threat model AR-33.
The registrar uses these grants only on the edge operator role's domain
calls and on deletes and replacements of an
entry that has a `d`, and never deletes a distribution tenant or a
certificate. The sweeper runs as an execution role of its own. It
holds the route table read it needs to list `tenant#` entries
(`cloudfront-keyvaluestore:DescribeKeyValueStore` and `ListKeys` on
the store, for the lister) and `GetKey` on the store, for a page's
per-entry reads (ADR-0022), the CloudFront actions `ListDistributionTenants`,
`GetDistributionTenant`, `ListTagsForResource` on distribution tenants,
`UpdateDistributionTenant` and `DeleteDistributionTenant` and, in `us-east-1`, `ListCertificates`,
`ListTagsForCertificate`, `DescribeCertificate` and
`DeleteCertificate`, the ACM delete conditioned on the registrar's
tag. For the daily re-check it also holds `dynamodb:GetItem`,
`Query`, `UpdateItem` and `BatchWriteItem` on the
sweeper's table (`BatchWriteItem` for the lister's batch delete, an
IAM action of its own, ADR-0022), `sqs:SendMessage` on
the on-failure queue and, for the lister's fan-out of one asynchronous
invocation per page, `lambda:InvokeFunction` on the sweeper function.
No other role in the stack has access to the table. The starter holds
only `lambda:InvokeFunction` on the sweeper function. The challenge
lookup itself needs no IAM action: it is a DNS lookup. The re-check's counts,
the three-miss, `unverifiable` and missing-pages counts, are embedded
metric format log lines, so no role needs `cloudwatch:PutMetricData`.
Each carries the dimension `DistributionId` with the distribution's id,
as `RouteTableBytes` does (§4.1), and every alarm on them watches that
dimension, so a second front door in the account and Region neither
trips this one's alarms nor keeps its no-lister alarm out of ALARM.
The log group keeps its lines for 14 days. Where IAM cannot narrow a CloudFront action to this
distribution's tenants, the registrar and the sweeper check a
distribution tenant's distribution and tags before they change it. The
stack's teardown custom resource holds only the removal actions:
`ListDistributionTenants`, `GetDistributionTenant`,
`ListTagsForResource` on distribution tenants, `UpdateDistributionTenant`
and `DeleteDistributionTenant` conditioned on the registrar's tag and, in
`us-east-1`, `ListCertificates`, `ListTagsForCertificate` and
`DeleteCertificate` conditioned on the registrar's tag (§6.2). It
creates nothing and requests nothing.

While `dedicatedDomains` is off the registrar role holds none of its
CloudFront or ACM actions, and the sweeper, its role, its table, its
schedules and the starter are not deployed. The teardown custom resource holds its actions in
both cases, so a front door that once served a dedicated domain still
tears down. A stack update that turns `dedicatedDomains` off fails
while any `tenant#` entry holds a `d`, or while the registrar still
holds a dedicated distribution tenant or certificate for the sweeper
to delete: a custom resource, the guard, reads the route table and
those lists and refuses the update. The guard exists in both states
and takes `dedicatedDomains` as a property, so CloudFormation sends it
an Update when the switch flips; it refuses only on that on-to-off
Update and lets a Create, a Delete and an off-to-on Update succeed. The
update runs in this order: the registrar function first, so that new
`customDomain` writes get 400; then the guard, which depends on the
function; then the narrowing of both roles, the registrar role losing
its CloudFront and ACM actions and the sweeper's role losing all of
its actions as it goes with the sweeper, and the removal of both
schedules, which depend on the guard. The registrar function's timeout
is 30 s, and the guard waits 40 s after the function update before it
reads the table, the 10 s Lambda init limit plus that timeout, so every
registrar call that started on the old configuration, cold start
included, has ended and no operator call can add a `d` after the guard
has read the table. The guard function's own timeout is 2 minutes,
which covers the 40 s wait and its reads. API Gateway answers 504 at its 29 s integration
limit while the function runs on, so a call can outlive its 504; every
operator call is repeat-safe, and the operator repeats it. When the guard refuses, the whole update rolls back
together, the function's switch included. The operator drops every
dedicated domain first and waits for the sweeper, so no domain stays
routed with no role able to remove it and no daily re-check. The guard
needs the route table read,
`cloudfront-keyvaluestore:DescribeKeyValueStore` and `ListKeys` on the
store, `cloudfront:ListDistributionTenants` and, in `us-east-1`,
`acm:ListCertificates` and `acm:ListTagsForCertificate`.

The route hook (`hooks/route-hook.sh`) runs on the events of §3.2 with
the control plane's hook environment (control-plane R-42). It first
checks `PHASE` and `EVENT` against the two registrations of §5.2, and
`HOOK_SCOPE` against `GLOBAL`, and fails on any other, so a wrong
registration fails loudly (control-plane `scripts/CONVENTIONS.md`).

1. Read `/application-plane/applications/<APPLICATION_ID>/shared/front-door-hook`
   in the control plane's account. No such parameter: exit 0, because
   the application has no front door (ADR-0014). That is a silent skip
   by design: only `ParameterNotFound` is skipped, and an
   `AccessDenied` is another read error that fails the hook. Nothing
   counts a skip, and on a delete the hook exits 0, so the control
   plane's skip alarm stays quiet. An application with a front door
   whose parameter is gone therefore reaches `ACTIVE` with no route,
   and its deletes leave an `active` `tenant#` entry. `RouteHookAccess`
   keeps the parameter against that (§3.1), so only a deliberate
   deletion in the control plane's account removes it (§6.2 limits).
   The kept parameter has a fixed name, so it has to be deleted or
   imported before `RouteHookAccess` is deployed again, and a changed
   `applicationId` leaves the old one behind (§3.1, §6.2 limits).
   The hook runs for every
   application on the control plane, so a throttled read
   (`ThrottlingException`, `TooManyRequestsException`) is retried inside
   the build, five attempts with jittered backoff over about a minute,
   and fails the hook only when it still fails after that. Any other
   read error fails the hook at once. A parameter that is not a version 1
   document, whose `registrarUrl` is not an API Gateway stage URL in the
   control plane's Region, or whose `appDomain` is not a lower-case DNS
   name, fails the hook too.
2. Take the ids from `CELL_ID` and `TENANT_ID`, never from
   `SCRIPT_OUTPUTS`, and fail on one that is not a control-plane id (26
   upper-case Crockford base32 characters). The hook sends no display name; the registrar reads
   it from the control plane (step 2 of §3.4). On a cell `POST`,
   read `frontDoorApiDomain` from `SCRIPT_OUTPUTS`. The outputs are
   written by a
   script that in a tenant-owned account the tenant controls
   (control-plane R-43, T44). The hook finds a repeated key with a
   streaming parse (`jq --stream`, comparing the keys it emits with the
   object's own), because plain `jq` keeps the last value of a repeated
   key. A value that is not a JSON object of strings, an object with a
   repeated key, or one with no `frontDoorApiDomain`, fails the hook. It checks the value against the §3.4 step 3 origin
   form before sending, and the registrar checks it again (400). It
   builds every request body with `jq --arg`, and never `eval`s an
   input or splices one into a command line.
3. Call the registrar with `curl --aws-sigv4`, signed for
   `execute-api` with the hook role's credentials, which the hook reads
   with `aws configure export-credentials` from the CodeBuild container
   credential provider and never prints.
   They are temporary, so the request also carries the session token
   in `x-amz-security-token`. The key pair and that header reach curl
   through a config file (`-K`), mode 600 in a temporary directory,
   never as command-line arguments, which other processes in the
   container could read. Then wait for propagation as §4.2 says.
4. Act on the answer. 200 or 202: exit 0. 503, 429, another 5xx, or no
   answer: retry inside the build, five attempts with jittered backoff over
   about two minutes, then fail (the hook never sends `customDomain`, so
   its 429 is always a throttle, never `certificate-quota`); the
   control plane does not retry a create or update hook, so a hook that
   wants retries makes them itself (control-plane R-46). 400, 403, 409
   or 507: fail at once, printing the status and the response body. The
   cause is in the
   input or the route table (a cell script that wrote no valid API
   domain, a tenant route whose cell has no route, a record in the
   wrong status, a full store, a misconfigured role), and a retry would
   not change it.

A failing `POST` hook fails the operation (control-plane R-46): the cell
or deployment lands in `CREATE_FAILED` or `UPDATE_FAILED` with the hook
named in `statusReason`, the script's changes stay in place, and the
route table holds whatever the registrar last accepted. From
`UPDATE_FAILED` the operator fixes the cause and retries with
`UpdateCell` or `UpdateDeployment`, whose `POST` hook puts the route
again. `CREATE_FAILED` cannot be retried with an update: the control
plane refuses `UpdateCell` and `UpdateDeployment` from it
(control-plane §5.2, §5.3). The operator deletes the failed deployment,
and a failed cell once it is empty, whose `front-door-pre` hooks remove
any route already written, and creates the deployment again. So a cell
or deployment of a front-door application reaches `ACTIVE` only with
its route written.

The delete hook runs `PRE`, before the delete script, so the route goes
while the cell or deployment still exists and no request is routed to a
tenant whose resources the script is tearing down. It also goes when the
delete script then fails, because the control plane runs `POST` hooks
only after a script succeeded (control-plane R-45): a `POST` delete hook
would leave a `DELETE_FAILED` deployment routed. A failing delete hook
cannot stop the delete. The control plane makes three attempts, 60 and
120 seconds apart, then logs and counts the skip and goes on
(control-plane R-46). A 503 that outlasts the retries ends that way.
`DeleteCellRoute` never looks for tenant routes that name the cell: the
control plane refuses `DeleteCell` while the cell holds a deployment
(control-plane P-10), so `front-door-pre` runs for a cell only once it
is empty. A tenant route that a skipped deployment delete hook left
behind then answers 503, because its `cell#` entry is gone (§3.3 step
7). The control plane's skip alarm, which fires for that skipped hook,
tells the operator, who removes the leftover route with the edge
operator role's `DeleteTenantRoute` or `DeleteCellRoute`. Until then a
leftover tenant route keeps its status and points either at its old
cell, whose hosts check refuses the tenant once the delete script has
removed its namespace, or at a cell route that is gone. A
later `CreateDeployment` for the same tenant does not inherit the
leftover's cell, `dt`, `host#` keys or domain: the new deployment's
`createdAt` differs from the entry's `dt`, so the hook's put replaces
the entry, routed to the new cell. Only the status the leftover held
carries over (step 5).

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
  4. On `/callback` the first script of `index.html`, a hashed inline
     classic script at the top of `<head>`, ahead of the import map and
     the entry (§7.1), copies the query into a variable and calls
     `history.replaceState` to drop it from the address. It runs before
     the document loads anything, so no request carries the code or
     `state` in `Referer` and no violation report carries them in its
     URL (§7.1 Reports). `single` mode handles its callback,
     `https://<appDomain>/`, with the same script. The access log still
     leaves out `cs(Referer)` (§3.1), in case a browser fetches ahead
     of the parser. The SPA then refuses the callback unless the `state`'s `n`
     equals its saved nonce, exchanges the code with the saved verifier
     and the same `redirect_uri`, and deletes both saved values on every
     outcome. A callback with `error` gets a fixed message; the SPA
     never renders `error_description` as HTML (§7.2). After the
     exchange the SPA compares the token's `tenant_id`,
     case-insensitively, with `/config.json`'s tenant id; a `tenants`
     token is narrowed to that tenant first (below). A token that names
     another tenant, or a `tenants` token that does not list the
     host's, is discarded, and the SPA signs the user out through
     `/logout` (step 5) before any `/api/*` or `/agents/*` call. The
     router would refuse such a call anyway (§3.3 step 5).
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
  record covers every pooled host, and the registrar refuses a
  `customDomain` that equals `appDomain` or ends in `.<appDomain>`
  (§3.4 step 4), so a pooled host's only `host#` entry is the one its
  own tenant's route writes. That registrar rule is what makes
  `https://<h>/callback` always the vendor's SPA for its own tenant. A
  dedicated domain's DNS belongs to the tenant: a code forwarded there
  would reach a server the tenant runs, holding a nonce and a PKCE
  verifier of its own choosing. So a dedicated domain receives no code
  in either mode. Its SPA redirects to `signInHost` (§3.2) for sign-in,
  and the session continues on that host: `<tenant>.<appDomain>` in
  `host` mode, and in `single` mode `<appDomain>`, which signs in
  through its one callback URL, `https://<appDomain>/`. A dedicated
  domain with its own callback URL on the issuer (ADR-0016 Option 1 for
  that one client) stays out of scope: the domain challenge confirms
  that the tenant controls the domain's DNS and can point it at a server
  of its own, so a code sent there could leave the vendor's edge
  (ADR-0016, amended by ADR-0018).
- The `signin` key holds one or two keys of 32 random bytes, named by
  `kid` (§4.1). A custom resource of the front door stack generates them
  with a cryptographic random source for the ids in `signinKeys` (§3.6)
  and writes them to the store. It writes with the store's ETag
  (`IfMatch`) and re-reads and retries on a conflict, as the registrar
  does (§3.4 step 5), because both write the same store. The key is
  never in the template, a stack output, the custom resource's response
  `Data` or a log. KeyValueStore actions name the store, not a key, and
  a function has one store (ADR-0012). So the registrar role, the
  sweeper's role, the custom resource and any edge-account principal with
  `cloudfront-keyvaluestore:GetKey`
  or `ListKeys` on the store can read the key, and so can any principal
  that can update or test the router (`cloudfront:UpdateFunction`,
  `cloudfront:TestFunction`), the integration test role among them
  (§10), which also writes the store for one fixture (§6.1). The
  registrar code never reads `signin` or `app`, and the deployer keeps
  those actions off every other role in the edge
  account (§6.1). A leaked key mints a `state` for any registered
  tenant host while it is live, and the nonce and PKCE binding still
  stops it from yielding a token. Rotation is in §4.1.
- `single` mode sign-out: `/logout` answers 302 to the issuer's logout
  endpoint with `client_id=<cid>` and `logout_uri=https://<appDomain>/`,
  plus `Clear-Site-Data: "storage", "cache"` (§7.1).
- A user in several tenants (`shared-pool-multi-tenant`) holds a token with
  a `tenants` list. The SPA narrows it to the tenant the user picked with
  an RFC 8693 token exchange before calling `/api/*` or `/agents/*`
  (`ARCHITECTURE.md` §2.1). The router refuses a token with no single
  `tenant_id` with 401 (§3.3 step 5). Where the exchange runs depends on
  the issuer:
  - An issuer that serves the exchange at its own token endpoint needs
    nothing more. The SPA posts to the token endpoint `/config.json`
    already names, whose origin `connect-src` already allows (§7.1).
  - `tenant-identity` serves it on its own API, at `POST /oauth2/token`,
    because Cognito's own token exchange narrows scopes and audience but
    cannot name a tenant (`tenant-identity` ADR-0039). For that issuer the
    deployer sets `exchangeEndpoint` in the `issuer` input (§3.6). It
    reaches the SPA through the `app` key and `/config.json` (§3.2, §4.1),
    its origin is in `connect-src` (§7.1), and the exchange API must
    answer with CORS headers (§7.2). The deployer lists the app's origins
    in `tenant-identity`'s `allowedOrigins` input (`tenant-identity`
    §5.4.1 and `tenant-identity` ADR-0040; the values are in §6.1).
  - The request is `tenant-identity`'s: a form-encoded `POST` with
    `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
    `client_id`, `subject_token` (the user's refresh token),
    `subject_token_type=urn:ietf:params:oauth:token-type:refresh_token`,
    `resource=urn:tenant-identity:tenant:<tenantId>` and `scope`. The
    answer holds an access token and no refresh token.
  - The subject is a refresh token, so the SPA keeps the refresh token that
    the code exchange returns in memory, as it keeps the access token, and
    never in storage (ADR-0007). It sends it only to the issuer's token
    endpoint and to `exchangeEndpoint`, both in `connect-src`. A reload
    loses it and the user signs in again. Its lifetime is the issuer's (one
    day in `tenant-identity`), longer than an access token's, so script in
    the page that could read memory would hold a longer-lived credential:
    the CSP and Trusted Types are the control (ADR-0008).
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
  route. In `host` mode, where the host picks the tenant and the token
  must agree, the router compares the decoded claim with the host's
  tenant and refuses a mismatch at the edge (§3.3 step 5), so a token
  for one tenant never reaches another tenant's cell, which may run in
  an account that tenant owns. The route hint repeats that check at the
  origin on the verified claim.
  The cell knows its tenants from its own namespace in its own account
  (`/application-plane/tenants/<tenantId>/<applicationId>/*`), so the check
  needs nothing from the edge account. It builds that path from the
  verified `tenant_id` claim in its control-plane form (upper case), never
  from the lower-case `x-tenant-route` hint: SSM names are case-sensitive.
- The agent ingress already verifies the token and selects the tenant from
  it, so it reaches the same tenant the router routed on. The router's role
  on `/agents/*` is to refuse unknown and suspended tenants at the edge,
  for traffic that passes through it. The ingress is a public endpoint
  that does not see suspension, so a request sent to it directly is
  verified but not refused as suspended (§1.2, §6.2).
- No script calls the registrar, and no credential for it is handed to
  a cell account. The route hook calls it under the control plane's
  global hook role, in the control plane's account; a cell script only
  writes its API domain to `OUTPUTS_FILE` (§3.2, ADR-0017).

### 3.6 Deployment inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `appDomain` | yes | | Domain the app is served at, for example `app.example.com`. At most 64 characters, ACM's limit on a certificate's primary name; validated at synth |
| `hostedZone` | yes | | Public Route 53 zone for `appDomain`, in the edge account |
| `addressing` | no | `single` | `single`: one URL, tenant from the token. `host`: one host per tenant |
| `applicationId` | yes | | The control-plane application this front door serves |
| `controlPlane` | yes | | Control plane API URL, account id and Region, and the vendor IdP token URL and client (secret in Secrets Manager) the registrar uses to get a reader token. The deployer lists that client id in the control plane's `vendorIdp.clientIds` (§6.1). The account id names the global hook role the registrar admits; the Region is the one every cell origin must be in (§3.4 step 3) |
| `fleet` | yes | | The control plane's fleet name (`fleetName`, `[a-z0-9][a-z0-9-]{0,31}`, control-plane §3.3), which names its global hook role, `<fleet>-global-hook`, the one control-plane role the registrar admits |
| `edgeOperatorRoleArn` | yes | | ARN of a role in the edge account that the registrar admits for the vendor-only calls: suspend and resume, `customDomain`, backfill, origin changes and clearing leftovers (§3.4). The deployer brings the role; the stack does not create it |
| `issuer` | yes | | The SPA's client id and scopes, and the issuer's authorize, token and logout endpoints as `https` URLs, or a Cognito user-pool domain they are derived from (`/oauth2/authorize`, `/oauth2/token`, `/logout`). Optionally `exchangeEndpoint`, an `https` URL, for an issuer that serves the multi-tenant token exchange on a URL other than its token endpoint (§3.5); omit it when the issuer serves the exchange at its token endpoint or no user holds a `tenants` token. Validated at synth, with no network call (§7.1) |
| `signinKeys` | no | `{ids: ["k1"], current: "k1"}` | `host` mode only: `{ids: string[], current: string}`, the `kid`s the `signin` key holds and the one that signs. Synth checks that `ids` holds one or two unique ids, each matching `[a-z0-9]{1,8}`, and that `current` is one of them (§4.1) |
| `tenantClaim` | no | `tenant_id` | Name of the claim that holds the tenant id. The router, the SPA and the origin read it (below) |
| `spaSource` | no | the demo SPA | Path of the built SPA |
| `agentIngress` | no | off | Agent ingress endpoint; omit to leave `/agents/*` off, and the router then answers 404 for every `/agents` path (§3.3 step 3) |
| `dedicatedDomains` | no | off | Lets the edge operator role set a tenant's `customDomain` (§3.4 step 5, ADR-0018). Off: any `customDomain` gets 400, the registrar role holds no ACM or distribution-tenant action, and the sweeper, its role, its table, its schedules and the starter are not deployed. A stack update that turns it off fails while any `tenant#` entry holds a `d` or the sweeper has a distribution tenant or certificate left to delete; the operator drops every dedicated domain first (§3.4) |
| `tenantRequestsPer5Min` | no | 2,000 | Per-tenant rate: at the edge per host in `host` mode, at the origin per verified tenant in `single` mode (ADR-0009) |
| `ipRequestsPer5Min` | no | 500 | `host` mode only: the most requests one client IP may send to one tenant host's `/api/*` and `/agents/*` in 5 minutes before the edge answers 429, counted ahead of the per-host count (ADR-0021). One value for every tenant host; there is no per-tenant setting. A chosen value, not a measured one. Keep it below `tenantRequestsPer5Min`. A tenant whose users all reach the edge through one office NAT address shares one count: at 500 its whole user base gets about 1.7 requests per second before `tenantRequestsPer5Min` applies. Raising it raises it for every host |
| `reportingEndpoint` | no | off | URL for CSP and other browser reports, on for the whole session in both modes. No report carries the callback's code, because the first inline script removes it from the URL before anything loads (§7.1 Reports) |
| `registrarUrl` | no | none | The `registrarUrl` of this front door's edge parameter (§6.4), `https://<api id>.execute-api.<control plane Region>.amazonaws.com/v1/`, known once the main stack is deployed. Set, the app adds the `RouteHookAccess` stack in the control plane's account and Region (§3.1, ADR-0027); validated at synth |
| `stackNamePrefix` | no | `TenantFrontDoor` | The start of every stack name, and of the app's construct id, which names the CloudFront policies and other account-wide resources. Two front doors in one account need different values, and different Regions, because the edge parameter's name is fixed (§6.4) |
| `alarmTopicArn` | no | none | ARN of an SNS topic in the main stack's account and Region. The construct adds it as the ALARM action of every alarm this specification defines: the three-miss, `unverifiable`, queue-depth, missing-pages and no-lister alarms of the sweeper (§3.4 step 5) and the 80 % route table alarm on the registrar's `RouteTableBytes` metric (§4.1). Every one of these alarms is in the main stack's Region, so one topic serves them all. The deployer owns the topic, its policy (it must allow CloudWatch to publish) and its subscribers. With no topic the alarms exist and notify no one |

`tenant_id` in this specification means the claim that `tenantClaim`
names, `tenant_id` by default. That covers the router's rules and its 401
conditions (§3.3, §5.3), the host-mode comparison of the claim with the
host's tenant, the SPA's check after the token exchange (§3.5), the cell
API's route-hint check and the path of the cell's own tenant namespace
(§3.5, §6.1), and the demo cell API that reads the claim.
The published interface carries the name (§6.4).

## 4. Data model

### 4.1 Route table (KeyValueStore)

| Key | Value (JSON, 1 KB max) | Written by |
|---|---|---|
| `tenant#<tenantId>` | `{"v":1,"c":"<cellId>","ac":"<accountId>","dt":<deployment createdAt, Unix ms>,"s":"active"\|"suspended","n":"<display name>","d":"<dedicated domain>","dk":"<challenge token>","dx":<challenge expiry, Unix s>}`, `d` and `dk` only for a tenant with a dedicated domain, `dx` only while its challenge is open | registrar, from the route hook on deployment create and update; `d` from the edge operator role (§3.4 step 3) |
| `host#<host>` | `{"v":1,"t":"<tenantId>","ac":"<accountId>"}` | registrar, in `host` mode and for a dedicated tenant's domain; only a pooled host's entry is a sign-in target (§3.3 step 2) |
| `cell#<cellId>` | `{"v":1,"ac":"<accountId>","o":"<api domain>"}` | registrar, from the route hook on cell create (`o` is write-once for it) and from the edge operator role (§3.4 step 3) |
| `app` | `{"v":1,"az":"<authorize endpoint>","tk":"<token endpoint>","cid":"<client id>","sc":"<scopes>","lo":"<logout endpoint>","ex":"<exchange endpoint>"}`, `ex` only when `exchangeEndpoint` is set (§3.6) | the front door stack |
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
  another `host#` key, outside `appDomain` and held by no other tenant
  (§3.4 step 4), and names it in its `tenant#` entry's `d`.
- Reserved labels (`www`, `api`, `admin`, `auth`, `login`, `static`,
  `status`) are refused at registration.
- The `signin` key holds one or two keys, each 32 random bytes and
  named by a `kid` of at most 8 characters from `[a-z0-9]` (§3.6), so
  it is at most about 150 bytes, needs no JSON escaping, and sits in
  the 20 % the ceilings below leave for non-tenant entries
  (ADR-0012). On each stack update the custom
  resource (§3.5) generates a key for an id in `signinKeys.ids` it has
  not stored, keeps the others, deletes any `kid` not listed, and sets
  `cur` to `signinKeys.current`. Rotation is three stack updates: (1)
  add the new id to `ids`, with `current` still the old; wait past
  propagation (90 s, §4.2), so every edge location can verify the new key
  before anything signs with it; (2) set `current` to the new id; (3)
  after the 10-minute `state` lifetime, remove the old id. An operator
  runs the updates and the waits. Rotate on a schedule and whenever the
  key may have been read.
- `ac` is the account the control plane placed the cell or deployment
  in, as the registrar read it at write time. The router never reads
  it; the registrar uses it to tie a tenant route to its cell's route
  and to check the operator's domain change (§3.4 steps 3 and 4).
- `dt` is the deployment's `createdAt` from `GetDeployment`, as Unix
  milliseconds (13 digits). It tells the hook's retries and the updates
  of one deployment (same `dt`) from a new deployment of the same tenant
  that meets an entry a skipped delete hook left (another `dt`, §3.4
  step 5). No tenant input reaches it. The router reads it only to put
  it in `/config.json` as `rev` (§3.2). `GetDeployment` returns
  `createdAt` as an RFC 3339 `date-time` in UTC with millisecond
  precision, which may omit a zero fraction (control-plane §4, §5.2). The
  registrar parses it to Unix milliseconds before it stores or compares
  it, so `...:01Z` and `...:01.000Z` are the same `dt`. It treats a value
  that does not parse like a control plane it cannot read (503, the
  write refused, §5.1). It never compares the strings.
- `d` is the tenant's dedicated domain, present only when the edge
  operator role has set one. It is written on the operator's first
  call for the domain, before the certificate validates, so a delete
  always finds what that call created. The router never reads it; the
  registrar uses it to find the `host#<d>` key, the distribution tenant
  and the certificate. When the domain changes or is dropped, or the
  tenant route is deleted or replaced, it removes `d` and `host#<d>` at
  once and the other two in two phases (§3.4 step 5).
- `dk` is the domain challenge token for `d`, 43 base64url characters,
  and `dx` its expiry in Unix seconds (10 digits), present only until
  the challenge passes (§3.4 step 5, ADR-0018). Both are written with
  `d`, replaced when `d` changes, and removed with it. The token is
  stored as it is, not hashed: the tenant publishes it in public DNS,
  knowing it lets no one pass without control of the domain's DNS, and
  keeping it lets a repeat answer 202 with the same record. The router
  never reads either.
- Display name `n` is the tenant's `name` from the control plane's
  `GetTenant` (§3.4 step 2), never a request value. It is for display
  only, and the registrar never refuses any name the control plane
  accepts. A control-plane `TenantName` runs to
  128 characters with no character rule. The registrar replaces each
  control character (U+0000 to U+001F, U+007F) with a space, `"` with `'`
  and `\` with `/`, then truncates the raw string to at most 64 UTF-8 bytes
  on a code-point boundary. No stored character then needs JSON escaping,
  so the stored field is at most 64 bytes.
- Worst case, keys included, a tenant needs 236 bytes in `single` mode:
  its `tenant#` entry, a 70-byte key and a 166-byte value with `ac` and
  `dt`. In `host` mode it adds a `host#` entry of 230 bytes (a 133-byte
  key and a 97-byte value with `ac`), so 466. The stated ceilings are
  80 % of the 5 MB store over those sizes (ADR-0012, amended by
  ADR-0017): floor(4,000,000 / 236) = 16,949 tenants in `single` mode
  and floor(4,000,000 / 466) = 8,583 in `host` mode. Pooled tenants
  carry no `d`, `dk` or `dx`, so these sizes and ceilings hold. A
  dedicated tenant's fields and its dedicated `host#` entry count
  against the 20 % headroom (ADR-0012, amended by ADR-0018). At worst,
  with a 64-character domain, they add 288 bytes once routed: `d` (71)
  and `dk` (51) on the `tenant#` value, and a `host#<d>` entry of 166
  (a 69-byte key and the 97-byte value). While the challenge is open
  the entry also carries `dx` (16) and there is no `host#<d>` yet, 138
  bytes. A `tenant#` value is then at most 166 + 138 = 304 bytes,
  inside the 1 KB limit. The headroom, 1,000,000 bytes, holds
  floor(1,000,000 / 288) = 3,472 dedicated tenants at worst, less what
  `app` and `signin` take. The registrar refuses a write past 5 MB with
  507, and an alarm fires at 80 %. CloudFront publishes no store-size
  metric, so the registrar publishes its own: after each write it
  takes `TotalSizeInBytes` from the write's own response (`PutKey`,
  `DeleteKey` or `UpdateKeys`), which holds the size after the write,
  and writes it as the custom metric
  `RouteTableBytes` (namespace `TenantFrontDoor`, dimension
  `DistributionId` with the distribution's id, an embedded metric format
  line in its log). The dimension keeps the metrics of several front
  doors in one account and Region apart (ADR-0014), so the registrar
  reads `DISTRIBUTION_ID` whether or not `dedicatedDomains` is on. The
  alarm (maximum at or above 4,000,000 bytes, on this distribution's
  dimension) lives in the main stack's Region beside the registrar, so the
  main-Region `alarmTopicArn` is its action (§3.6) and no `us-east-1`
  topic is needed.
- ACM binds before that headroom does. A dedicated domain needs one ACM
  certificate in the edge account's `us-east-1`, and ACM's default quota
  is 2,500 certificates for each account and Region, expired and revoked
  ones included, with 5,000 certificate requests in any 365 days
  ([ACM quotas](https://docs.aws.amazon.com/acm/latest/userguide/acm-limits.html),
  read 2026-11-18). The `appDomain` certificate and any other
  certificate in that account and Region count against the same 2,500, so
  the default quota allows at most about 2,500 dedicated domains,
  below the 3,472 the headroom holds. The deployer requests a higher ACM
  quota before routing more. A request past the quota fails with
  `LimitExceededException` and the registrar answers 429 with
  `reason: certificate-quota` (§5.1). The yearly
  count includes every request, so a domain dropped and set again
  repeatedly uses it up. CloudFront's limit of 1,000,000 distribution
  tenants for each account does not bind
  ([CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html),
  "Quotas on multi-tenant distributions", read 2026-11-18).

### 4.2 Route status

| Status | Edge answer | Set by |
|---|---|---|
| (no entry) | `single`: 403. `host`: 404 for a host with no `host#` entry, the apex `<appDomain>` included, and 403 for a `host#` entry with no `tenant#` entry | tenant removal, never registered, or a `host#` key left behind (§3.4) |
| `active` | routed | the route hook's first write for a deployment of the tenant; afterwards only `UpdateTenantRouteStatus` (§3.4 step 5) |
| `suspended` | 503, `Retry-After: 300` | vendor operator in the edge account |

A change reaches an edge location within the store's propagation time:
about 30 s at one location (spike S-2: median 28.4 s, p99 29.4 s, max
29.5 s). It does not reach every server of that location at once: from
one client the first routed request came 16 to 37 s after the write, and
requests still missed the change up to about 63 s after it (design/spikes.md,
Smoke run). A check that needs every request to see a change therefore
waits 90 s. The route hook bounds its wait at 45 s after the registrar
returns, so the operation does not end before its route is live. For
cell routes and every call in `single` mode it waits the full 45 s, a
bound and not a check: in `single` mode a route cannot be observed
without a tenant token, and a `cell#` route cannot be observed from
outside. In `host` mode a tenant route put polls
`https://<tenant>.<appDomain>/config.json` every 3 s and returns on the
first 200 whose `rev` equals the `dt` in the registrar's answer. A replaced entry
(a new `dt`, §3.4 step 5) is therefore live before the hook ends, which
the old entry's own 200 would otherwise hide. A tenant route delete
returns on the first 404. When none arrives within
45 s, it prints a warning and exits 0: the write succeeded and only
propagation is late. In `host` mode `/config.json` on a tenant's own host
is the one unauthenticated read that names a tenant, and an unknown host
gets 404, so the host already shows whether the tenant exists. In
`single` mode no unauthenticated read names a tenant, and the hook holds
no token for one. A request with a forged, unsigned token shows a route
that is not live (403), but a live route sends it on to the cell, so the
hook does not probe and waits the full bound. A caller who already holds
a tenant id can sort it the same way (§6.2 limits).

`suspended` and a delete take effect after the same window. Until then the
tenant is still routed, and the cell's hosts check is the only refusal
(§3.5). Removal is a delete, not a status. A later `PutTenantRoute`, from
either role, keeps the stored status.

A tenant cannot lift its own suspension at the edge. The registrar
admits no role a cell account holds (§3.4), so a tenant-owned account
can neither write nor delete its route. Only the route hook writes it,
on an operation the vendor started. A hook's put to an existing entry
keeps `suspended`, and so does a put that replaces a leftover entry of
an earlier deployment (a different `dt`, which a skipped delete hook
leaves, §3.4 step 5). A hook's delete is accepted only while the
control plane is deleting the deployment (§3.4). The route starts
`active` again only when no entry is left: the vendor deletes the
deployment, its delete hook removes the entry, and the vendor creates a
new deployment. The status belongs to the entry, and the delete removes
the entry. A vendor role that deletes a deployment and creates a new one,
for a tenant move or a repair, therefore lifts a suspension the edge
operator set, and nothing tells the edge operator, who suspends the new
deployment again.
A suspension also does not reach a cell the tenant owns or the agent
ingress (§6.2 limits).

## 5. API surface

### 5.1 Route registrar

Modelled in Smithy; all operations `AWS_IAM`, all idempotent.

| Op | HTTP | Caller | Contract |
|---|---|---|---|
| `PutCellRoute` | `PUT /cells/{cellId}` | global hook role (route hook, cell create and update); edge operator role, for backfill and origin changes (§3.4) | Body `{apiDomain}`, from the cell script's `frontDoorApiDomain` output, or from the operator. A Lambda function URL host in the control plane's Region (400 otherwise). Account taken from the control plane, never the body. For the global hook role, 409 while the cell is neither `CREATING` nor `UPDATING`, and 409 when `cell#` holds another origin: the origin is write-once for it. Checks §3.4. 200 |
| `DeleteCellRoute` | `DELETE /cells/{cellId}` | global hook role (route hook, cell delete); edge operator role, to clear a route a skipped hook left | For the global hook role, 409 while the cell is neither missing nor `DELETING` (§3.4). It does not look for tenant routes that name the cell (§3.4). 200, also when absent |
| `PutTenantRoute` | `PUT /tenants/{tenantId}` | global hook role (route hook, deployment create and update); edge operator role to set `customDomain` | Body `{customDomain?}`, which only the edge operator role may send (below). The display name and the cell come from the control plane, never the body. The entry records the deployment's `createdAt` as `dt`. A `tenant#` entry with no entry before it gets `s: active`; a write to an existing entry keeps its `s`, from either role, and only `UpdateTenantRouteStatus` changes it. A hook put whose deployment `createdAt` differs from the stored `dt` replaces the entry and keeps its `s` (§3.4 step 5). Checks §3.4. 200 with `dt`, or 202 with `stage`, `record` and, after a lookup, `challenge` while the challenge is open (`domain-challenge`, also with `expiresAt`), the certificate is pending (`certificate`, without `record` until ACM attaches it) or the record is gone after the certificate issued (`challenge-recheck`) |
| `DeleteTenantRoute` | `DELETE /tenants/{tenantId}` | global hook role (route hook, deployment delete); edge operator role, to clear a route a skipped hook left | Removes the `tenant#` key, the pooled host's `host#` key and the `host#<d>` key its `d` names, each `host#` key only when its `t` names the tenant (§3.4). It disables the distribution tenant of that `d`, and the sweeper deletes it and its certificate, each only when its tags name this tenant (§3.4 step 5). For the global hook role, 409 while the deployment is neither missing nor `DELETING`. 200, also when absent |
| `DeleteHostRoute` | `DELETE /hosts/{host}` | edge operator role | Removes one `host#` key whatever its `t` and `ac`, and the `d` of the tenant it names when `d` is that host, to clear a key left behind. That domain's distribution tenant and certificate then go in two phases (§3.4 step 5). 200, also when absent |
| `UpdateTenantRouteStatus` | `PUT /tenants/{tenantId}/status` | edge operator role | Body `{status}` |

**`PutTenantRoute` and `customDomain`.** Only the edge operator role may
send `customDomain`, and only while `dedicatedDomains` is on (400
otherwise). The global hook role that sends it gets 403, and its call
without it keeps the stored domain. The operator's call sets the domain,
or drops it when `customDomain` is absent. A new domain is one host name
of at most 64 characters with no wildcard, outside `appDomain` and held
by no other tenant. The call writes it as `d` on `tenant#` first, with a
domain challenge for this tenant and domain, and answers 202 with
`stage: "domain-challenge"` and the TXT record to publish,
`_tfd-challenge.<d>` `tfd-verify=<token>`, valid for 7 days, with its
expiry as `expiresAt` (Unix seconds). A repeat
resolves that record: until it holds this tenant's token the call answers
202 again, with `challenge: "missing"`, `"mismatch"` or `"unresolved"` (a
resolver error, never a pass), and an expired challenge gets a new token.

Once the challenge passes, the call requests the domain's ACM certificate
in `us-east-1`, which validates by DNS once the tenant publishes ACM's
validation record, and answers 202 with `stage: "certificate"` and that
record until then (a 202 `certificate` without `record` means ACM has
not attached it yet, and the operator repeats the call); a repeat finds
the certificate and creates nothing twice (ADR-0018). Once the certificate has validated, the call resolves
the record again. Unless it still holds the token, the call answers 202
with `stage: "challenge-recheck"`, the record and its `challenge` value,
and writes no `host#` key. Otherwise it creates the dedicated
distribution tenant and writes the domain's `host#` key, which routes
requests and records its owner (`t`, `ac`), and answers 200. The tenant
then points the domain with a CNAME at the main stack's
`RoutingEndpoint` output (§6.4). A failed validation gets 422, with
ACM's failure reason, on every repeat within ACM's one-hour idempotency
window from the request: the sweeper keeps the failed certificate for that
hour, then deletes it and logs the reason. A repeat after that
hour, or over a timed-out validation, requests a new certificate under
the same challenge and answers 202 `certificate`, and each such request
counts once against ACM's yearly certificate requests (§3.4 step 5
sub-step 6). A changed or dropped domain removes the
old `host#<d>` at once and its distribution tenant and certificate in two
phases (§3.4 steps 3 to 5). The domain is never a sign-in target: its
users sign in on `signInHost` (§3.5).

Errors: 400 for a malformed id or domain, an `apiDomain` that is not a
Lambda function URL host in the control plane's Region, a `customDomain` that is not one host name of at most 64
characters without a wildcard, or that equals `appDomain` or ends in
`.<appDomain>`, and any `customDomain` while `dedicatedDomains` is off;
403
from API Gateway for any principal the resource policy does not admit,
and from the registrar when the placement record is missing or belongs
to another application (the message names neither the real account nor
the real cell), or a role other than the edge operator role sends
`customDomain`; 409 for a global hook role write whose record is not in
the status of its operation (§3.4), a global hook role `PutCellRoute`
that would change a cell's origin, a missing cell route, an operator
domain change with no tenant route or for another
deployment (`dt`), a `customDomain` whose `host#` entry names another
tenant, one another tenant holds pending (a registrar certificate for
it tagged with that tenant), one CloudFront already serves (`CNAMEAlreadyExists`), or a
distribution tenant or certificate tagged for another tenant (the
message names no tenant); 422 when the dedicated domain's certificate
failed validation, on any repeat within ACM's hour of its request, for
which the sweeper keeps the failed certificate (a
domain challenge never fails: it expires and is issued again); 507
when a write would exceed the route table's 5 MB (ADR-0012); 429 with
`reason: certificate-quota` when ACM refuses a certificate request for
its quota (§4.1), which lasts until the deployer raises the quota or
certificates are deleted, so the operator does not repeat the call until
then; 503 when
the control plane cannot be read or returns a `createdAt` that does not
parse (the write is refused, never made unchecked), or when the store's
ETag still conflicts after five
attempts (§3.4 step 5).

Every error body the registrar function writes is `{message, reason?}`.
`reason` is set only where a status alone does not tell the caller what
to do, which is only `certificate-quota` on 429. API Gateway's own
answers, the resource-policy 403 and the stage throttle 429, carry its
default body and no `reason`. A 429 with no `reason` is retried with
backoff; a 429 with `reason: certificate-quota` is not.

### 5.2 Script and construct forms

- **`hooks/route-hook.sh`**, the route hook (§3.4), driven by the control
  plane's hook variables (`EVENT`, `PHASE`, `HOOK_ID`, `HOOK_SCOPE`,
  `APPLICATION_ID`, `CELL_ID`, `TENANT_ID` and, on `POST`,
  `SCRIPT_OUTPUTS`; control-plane R-42), `AWS_REGION`, which CodeBuild
  sets, and the front door hook parameter in the control plane's
  account. It signs with the global hook role's credentials
  through `curl --aws-sigv4`, with the session token in
  `x-amz-security-token` and every credential in a `-K` config file,
  parses the outputs with `jq --stream` and
  builds bodies with `jq --arg` (§3.4). It needs the AWS CLI v2, `jq` and
  curl 7.75 or later, which the CodeBuild standard image of the control
  plane's hook projects carries. Its worst case, a minute of throttled
  parameter reads, two minutes of registrar retries and the 45 s wait,
  fits the hooks' 10-minute run timeout.
- **`scripts/register-hooks.sh [--delete]`**, run by an operator with an
  operator token (`CONTROL_PLANE_URL`, `CONTROL_PLANE_TOKEN`, which
  reaches curl on stdin): puts `front-door-pre`, then `front-door-post`,
  with `PutHook` (control-plane R-39), each with this sample's repository as
  `source` (`GITHUB`, overridable for a fork), pinned to a full commit
  SHA (`HOOK_SOURCE_VERSION`), `samples/tenant-front-door/hooks/route-hook.sh`
  as `script` and `timeoutMinutes` 10. The `PRE` hook goes first, so a run
  that fails between the two puts (a sixth global hook, a 5xx, an expired
  token) leaves a hook that only deletes routes, which answers 200 when
  a route is absent, and never one that writes routes no hook removes.
  It first reads each hook with
  `GetHook` and leaves one registered with the same definition as it is,
  so a rerun changes nothing and does not raise the revision, then checks
  with `ListHooks` that both hooks are there with their phases and
  events. A put reaches only operations the control plane accepts after
  it (control-plane R-40), so the operator runs it before the
  application's first cell. The two
  hooks serve every front door on the control plane, and take two of
  its five global hook slots. One pin serves them all, so moving it
  changes the hook for every front door at once: the hook-to-registrar
  API stays backward compatible across sample versions (a new hook works
  with an older registrar and the reverse), or every front door on the
  control plane upgrades together. `--delete` removes `front-door-post`,
  then `front-door-pre`, with
  `DeleteHook`, a 404 included, and checks that `ListHooks` names
  neither.
  Run it first when the last front door on a control plane is removed:
  once no `RouteHookAccess` policy is attached, the hook can no longer
  read the front door hook parameters, so it fails, and with it every cell
  and deployment create and update on the control plane.
- **`frontDoorApiDomain`**, the output a cell create or update script of
  a front-door application writes to `OUTPUTS_FILE` (control-plane R-43):
  the host name of the cell's API origin, a Lambda function URL host in
  the control plane's Region. A cell event without it fails the route
  hook, and so the operation. A cell whose API moves to a new host needs
  the operator's `PutCellRoute` (§3.4).
- **`PARAM_FRONT_DOOR_CUSTOM_DOMAIN`**, an optional declared deployment
  parameter (control-plane ADR-0039), carries the domain a tenant asks
  for. The route hook does not send it, because the global hook role's
  `customDomain` gets 403. The vendor reads it, sets it with the
  edge operator role, and hands the tenant the domain challenge the
  registrar answers with, to publish (§3.4 step 5, ADR-0018).
- **`CellRouteAccess` construct**, used in a cell stack: grants
  `cloudfront.amazonaws.com` `lambda:InvokeFunctionUrl` and
  `lambda:InvokeFunction` on the cell's function, conditioned on the edge
  distribution's ARN (ADR-0011).

### 5.3 Edge errors

All with a small static HTML or JSON body and `no-store`:

| Status | When |
|---|---|
| 401 | no token, an undecodable token, or no single `tenant_id` (a `tenants` list included): in `single` mode on every path that needs a tenant, in `host` mode on `/api/*` and `/agents/*` (§3.3 step 5). With `WWW-Authenticate: Bearer` |
| 403 | unknown tenant (`single`), or in `host` mode a `host#` entry with no `tenant#` entry; in `host` mode, `/api/*` or `/agents/*` with a `tenant_id` other than the host's tenant (§3.3 step 5); or a cross-site call to `/api/*`, `/agents/*` or `/signin-state` |
| 404 | unknown host (`host` mode, the apex `<appDomain>` included, or an unknown dedicated domain), `/signin-state` in `single` mode, or `/agents` and any `/agents/` path other than `/agents/<backend>/invocations`, `/agents/` included (§3.3 step 3, ADR-0019) |
| 429 | tenant over its rate on `/api/*` or `/agents/*`, or one client IP over its rate on one host (`host` mode, at the edge): the WAF rate rules' Block action returns a custom 429, and a scope-down keeps SPA loads out of the count. Each rule's `CustomResponse` sets its own response header, `x-tfd-rate-rule: ip` on the per-IP rule and `x-tfd-rate-rule: host` on the per-host rule, so a client and the integration test can tell which rule answered. The header names a rule, not a tenant, so it discloses nothing about who else uses the host (ADR-0009, ADR-0021) |
| 400 | `/signin-state` with a missing or malformed nonce; `/signin-state` or `/logout` on a dedicated domain (`host` mode); on `login.<appDomain>`: a missing or changed `state`, an unknown `kid`, an `h` that is not a pooled host, an unregistered or suspended tenant host, or any other path. An authentic expired `state` gets 302 to `https://<h>/` instead (§3.3 step 2) |
| 503 | tenant suspended, or its cell has no route |

## 6. Contracts

### 6.1 What the deployer supplies

- A public hosted zone for `appDomain` in the edge account.
- An edge account that is the vendor's alone. The deployer never
  registers it with the control plane as `owner: TENANT`, and it hosts
  no tenant-owned cell. A tenant-owned account gives its tenant a role
  pair it controls (§3.4), and that role pair deploys stacks, so the
  tenant would hold the edge-account rights the design keeps from
  tenants: the store (and with it the `signin` key and every route), the
  router, the distribution, the response headers policy, the web ACL and
  the SPA bucket (§6.2 limits; the threat model's AR-6). The integration
  test registers its edge account tenant-owned as a test-only shortcut
  (§10 step 1); a deployment does not copy that topology.
- An issuer that meets `ARCHITECTURE.md` §2.1 and accepts the app's
  callback and sign-out URLs: `https://<appDomain>/` as both in `single`
  mode. In `host` mode, `https://login.<appDomain>/callback` as the
  callback URL, which tenant-host sign-out also uses (§3.5), and no
  sign-out URL (ADR-0016). A dedicated domain adds no URL in either
  mode: its users sign in on `signInHost`, which in `single` mode is
  `<appDomain>` (§3.5).
- A control plane whose `GetCell` and `GetDeployment` return `accountId`,
  `applicationId` and `status`, whose `GetDeployment` also returns
  `createdAt` (control-plane §5.2) and whose `GetTenant`
  returns `name`, with a reader role enabled (control-plane R-36), and
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
- A control plane with global hooks (control-plane R-39 to R-46,
  control-plane ADR-0044) and two global hook slots free, on which an
  operator runs `register-hooks.sh` (§5.2). In the control plane's
  account, this front door's `RouteHookAccess` stack, deployed after the
  main stack with its `registrarUrl` (§3.6), with its policy
  listed in the control plane's `globalHookManagedPolicyArns`, which
  takes only customer-managed policies in the control plane's own
  account and partition, and an update of the control plane. The global
  hook project must be able to fetch the hook's source: a public GitHub
  repository needs no credential, and a private one or a fork needs the
  source credentials the control plane's provisioning projects use
  (control-plane N-6). The registrar admits no role in a cell account
  (§3.4).
  The front door's hooks name only cell and deployment events, so the
  application, tenant and account events of control-plane ADR-0045 do
  not run them. Under ADR-0045 the control plane's record writes
  (`PutApplication`, `CreateTenant`, `PutAccount` and their updates and
  deletes) answer 202 and are polled; the registrar's reads
  (`GetCell`, `GetDeployment`, `GetTenant`) still answer 200.
- An edge operator role in the edge account (`edgeOperatorRoleArn`,
  §3.6), held as §3.4 says.
- For an issuer whose multi-tenant exchange runs on its own API
  (`tenant-identity` `shared-pool-multi-tenant`): `exchangeEndpoint`
  (§3.6). That API must also send CORS headers for the app's origins
  (§7.2), which only the issuer can configure. For `tenant-identity`,
  deploy its `shared-pool-multi-tenant` stack with `allowedOrigins`
  set to `https://<appDomain>` in `single` mode, or `https://*.<appDomain>`
  in `host` mode (`tenant-identity` §5.4.1 and ADR-0040), with
  `appDomain` in lower case in both. Pages on those origins are the only
  ones that post the exchange: in `host` mode the SPA holds a session only on `<tenant>.<appDomain>`, the apex
  answers 404 and `login.<appDomain>` serves no SPA; a dedicated domain
  holds no token in either mode, because its session moves to
  `signInHost` (§3.5). The pattern lets every page one label under
  `appDomain` read the exchange's answers, so serve nothing but the
  front door one label under `appDomain`. `tenant-identity`'s synth
  refuses a pattern whose domain is a public suffix or is or ends in
  `amazonaws.com`, and `appDomain` is a domain with its own hosted zone
  in any case (above).
- With `dedicatedDomains` on, an ACM certificate quota in the edge
  account's `us-east-1` raised before the dedicated domains near 2,500
  (§4.1).
- Cell scripts of the application that write `frontDoorApiDomain` to
  `OUTPUTS_FILE` on create and update (§5.2). Cells that existed before
  the front door's hooks get their routes by the operator's backfill
  (§3.4).
- In `host` mode, the edge account's read boundary for the `signin` key.
  The registrar role, the sweeper's role, the custom resource and any edge-account principal
  with `cloudfront-keyvaluestore:GetKey` or `ListKeys` on the route
  table, or `cloudfront:UpdateFunction` or `cloudfront:TestFunction` on
  the router, can read the key. The integration test role is one: it
  calls `TestFunction` and signs a test `state` with the live key (§10
  step 18). It is also a writer of the store: it holds
  `cloudfront-keyvaluestore:PutKey` and `DeleteKey` to write and remove
  the step 2 fixture, which would let it replace the `signin` key or
  any route. It also holds `dynamodb:GetItem` and `PutItem` on the
  sweeper's table, which holds no token and no key,
  `lambda:InvokeFunction` on the sweeper function, to start a daily run
  by hand, and `logs:FilterLogEvents` on the sweeper's log group and
  `cloudwatch:GetMetricData`, to read that run's three-miss line and
  count (§10 step 14). The
  deployer scopes that role to the test run, creating it
  for the run and removing it after. The registrar code never reads
  `signin` or `app`. The deployer keeps those actions off every other
  role in the edge account: KeyValueStore has no resource policy, so
  the stack cannot (§3.5).
- A cell API that verifies the token in `x-tenant-token`, refuses a
  `tenant_id` that differs from `x-tenant-route` (compared
  case-insensitively; `tenant_id` is the claim `tenantClaim` names,
  §3.6), refuses tenants its cell does not host, and in
  `single` mode limits each verified tenant to `tenantRequestsPer5Min`
  (ADR-0009). The demo cell API is the reference.
- CloudFront origin access control support on the cell origin (Lambda
  function URL, or S3), with the cell stack granting the edge distribution
  through `CellRouteAccess`.
- Any client of `/api/*` through the front door, not only the SPA, sends
  the SHA-256 of a `PUT` or `POST` body in `x-amz-content-sha256` (§7.2,
  ADR-0011).

### 6.2 What the sample promises

- A request with no tenant, or with an unknown or suspended tenant, never
  reaches an origin, once the route change has propagated (§4.2). This
  holds for traffic that goes through the edge (limits, below).
- A request reaches only the cell its route names.
- No role a cell account holds can write or delete a route. The route
  hook writes routes on the vendor's operations, each naming the cell and
  account the control plane placed it in.
- A tenant cannot lift its own suspension at the edge (§4.2): no role
  it holds writes its route. Where a suspension does not hold, the
  limits below say so.
- No tenant route can claim another tenant's host: only the edge
  operator role sets a `customDomain`, one under `appDomain` gets 400,
  and one another tenant holds gets 409.
- No dedicated domain is routed, and no certificate is requested for
  it, until the domain's DNS holds a challenge token the registrar
  issued for that tenant and that domain. A former holder's leftover
  record and another tenant's token do not pass (ADR-0018).
- A forged token cannot be served: the cell's signature check refuses
  it. A validly signed token routed to the wrong cell is refused by that
  cell's hosts check.
- In `host` mode, a token for one tenant is refused at the edge on
  another tenant's host, so it never reaches that tenant's cell.
- Every response carries the §7 header set.
- Each pooled tenant is registered and removed with one registrar call, with
  no distribution change.
- Per-tenant requests, errors, bytes and refusals are visible in both
  modes, from the access log's `viewer-request-log-data` field: for every
  request on a host the router looks up, and on `<appDomain>` in
  `single` mode for every request that reaches the token decode. A
  request that reaches the decode names the tenant it is routed on. The
  field names the claimed tenant (§3.1).
- An ordered teardown leaves nothing behind. Three pieces live outside
  CloudFormation, or outlive it, in the control plane's account (the two
  global hooks, the `globalHookManagedPolicyArns` entry and the hook
  parameter, which the stack keeps), so `cdk destroy` alone is not the
  teardown. In order: (1) delete the application's deployments, then its
  cells, through the control plane, whose `front-door-pre` hooks remove
  their routes; (2) run `register-hooks.sh --delete` when this is the
  last front door on the control plane; (3) take the `RouteHookAccess`
  policy out of `globalHookManagedPolicyArns` and update the control
  plane; (4) destroy `RouteHookAccess`, which keeps its parameter; (5)
  delete that parameter; (6) destroy the front door stacks. Out of
  order, every create and update of the application fails after the
  hook's retries, every delete waits through three hook attempts and
  raises the skip alarm, and `RouteHookAccess` cannot be deleted while
  its policy is attached (IAM `DeleteConflict`). A parameter left
  behind names a registrar that step 6 removes, so the application's next
  create or update fails. In step 6 a custom resource on the
  distribution, run before the distribution's delete, disables and
  deletes every dedicated distribution tenant on it (it skips the pooled
  distribution tenant by its id before any read, as the sweeper does, a
  second guard after IAM, which refuses both roles' update and delete on
  its `pooled/<distribution id>` tag (§3.4 IAM paragraphs), and
  CloudFormation deletes that one), then deletes every
  certificate the registrar tagged with this distribution, one still
  pending validation included, which has no distribution tenant and
  would outlive the stack, polling until each disable has deployed (the
  CDK provider framework's `isComplete`), because CloudFront cannot
  delete a distribution that still has distribution tenants. The
  teardown exists whether or not `dedicatedDomains` is on. The registrar
  function depends on it and the teardown depends on the distribution
  and the connection group, so a stack delete removes the registrar
  function first (no new dedicated distribution tenant can appear), then
  runs the teardown, then deletes the connection group and the
  distribution. The provider framework (two functions and a Step
  Functions waiter) is therefore part of every stack, and the
  integration run records the deploy and destroy time it adds. The
  README states the same order.

Limits of these promises:

- The edge's refusals apply to traffic that goes through it. Cell origins
  admit only the distribution (origin access control, ADR-0011). The agent
  ingress is a public endpoint: it verifies the token and selects the
  tenant itself and does not see the route table, so a request sent to it
  directly is served for a suspended tenant and is never refused as
  unknown. The hardening path, not built here, is an ingress that admits
  only the distribution, through a secret origin header that a WAF rule on
  the ingress checks, or one that reads the suspension.
- A suspension holds at the edge only. A cell in a tenant-owned account
  can serve its own users while the tenant is suspended: the tenant
  controls the function URL's resource policy and can call its cell
  directly (§3.4). A token the issuer has already issued stays valid
  until it expires, so a direct call to such a cell or to the agent
  ingress keeps working for at least one token lifetime. The hardening
  path, not built here, sits at the issuer: it refuses to mint or
  exchange a token for a suspended tenant, so direct access ends
  within one token lifetime. The front door does not tell the issuer.
- A vendor role that deletes a deployment, whose delete hook removes
  the entry, and creates a new one resets its suspension to `active`
  (§4.2), and nothing tells the edge operator. The edge operator
  suspends the new deployment again. When the delete hook was skipped,
  the leftover entry carries its suspension to the new deployment.
- A caller who holds a tenant id can sort it in `single` mode with a
  forged, unsigned token: 403 for an unregistered id, 503 for a
  suspended one, the cell's refusal for a live one (§3.3 steps 5 and
  6). In `host` mode `/config.json` on a tenant's host answers 503 for
  a suspended tenant, 200 for an active one and 404 for an unknown
  host. Tenant ids are ULIDs, so they cannot be enumerated.
- The edge's own configuration is the deployer's. A principal that can
  update the router (`cloudfront:UpdateFunction`, `PublishFunction`),
  the distribution, the response headers policy or the web ACL
  (`wafv2:UpdateWebACL`) removes the checks each one carries, for every
  tenant at once, and the stack cannot narrow those actions to what it
  owns. The edge account's administrators are the deployer, and
  CloudTrail names each call. That holds only while the edge account is
  the vendor's alone (§6.1): a tenant-owned role pair in it would make a
  tenant one of those principals.
- The front door hook parameter is the switch for routing an
  application's tenants. Deleting it, which only an administrator of
  the control plane's account can do, makes the hook skip the
  application silently (§3.4 route hook step 1). The hardening path,
  not built here, is a sweeper reconcile of the `tenant#` entries
  against `GetDeployment` that alarms on a mismatch.
- The parameter `RouteHookAccess` keeps has a fixed name. After a
  stack delete outside the ordered teardown, or after a first create
  that rolled back (CloudFormation keeps `Retain` resources then too),
  the next deploy of `RouteHookAccess` fails because the parameter
  exists: delete it, or import it into the new stack, first. A changed
  `applicationId` replaces the parameter under a new name and keeps the
  old one; while the old one stays, the hook calls the registrar for the
  old application, the registrar answers 403 (§3.4 step 3) and that
  application's creates and updates fail. The operator deletes the old
  application's parameter in the same change (§3.1).
- Route writes share one store ETag, so sustained writes above about
  one a second, or a burst larger than the 20 writes the stress slice
  sends at once, can fail creates (§3.4 step 5). One a second is the
  load the registrar is sized for; no larger burst is characterised.
- `single` mode has no edge rate rule. The origin's per-tenant limit
  counts verified requests only (ADR-0009).
- In `host` mode the edge rate rules count a request before the router
  refuses it. The per-IP rule stops one address using up a tenant's
  budget. A flood from many addresses can still bring a tenant's host to
  its limit. `ipRequestsPer5Min` is one value for every host, so a
  tenant whose users share one office NAT address shares one per-IP
  count, about 1.7 requests per second at the default 500 (ADR-0009,
  ADR-0021).
- `/config.json` on a tenant host or a dedicated domain is an
  unauthenticated read that confirms the tenant exists, and its `rev`
  adds when the tenant's current deployment was created and whether it
  was created again. The sample accepts this low-value disclosure; it is
  a [threat-model](../threat-model.md) residual (T-51, AR-11), with the
  other limits in this list.

### 6.3 Samples consumed

| Sample | How | Needed for |
|---|---|---|
| `control-plane` | its API (`GetCell`, `GetDeployment`, `GetTenant`) with the reader grant (R-36) and a client-credentials reader token (spike S-9 showed both are needed: a `role` trigger on the vendor IdP and the `vendorIdp.clientIds` input of R-38, ADR-0043), its global hooks (R-39 to R-46, control-plane ADR-0044): `PutHook`, the `<fleet>-global-hook` role and `globalHookManagedPolicyArns`, the hook environment and `SCRIPT_OUTPUTS`. A prerequisite: without hooks the front door registers no route | placement checks, route registration, the integration test |
| `tenant-identity` `shared-pool` and `shared-pool-multi-tenant` | its published parameters; the second topology also mints the `tenants` token and serves the token exchange (§3.5), whose `allowedOrigins` input lists the app's origins (`tenant-identity` §5.4.1 and ADR-0040; the values are in §6.1). Step 5 of §10 uses a `tenants` token only to check the edge's 401 and calls no exchange. | the demo issuer and the integration test |
| `agentic-runtime-isolation` | its `/application-plane/shared/agent-runtime/ingress` parameter: `baseUrl` gives the `agentIngress` origin's domain and origin path. The integration test does not compose it: step 23 runs against a stand-in ingress (ADR-0024) | `/agents/*`, optional |

What the front door assumes of the agent ingress's paths (ADR-0019):
the origin path is the path of the published `baseUrl`, the stage
(`/prod`); the ingress serves an agent at `<baseUrl>/<backend>/invocations`
with `<backend>` matching `[a-z0-9-]{1,32}`, as its `urlFor` and
published interface state; and it routes with no `/agents` prefix. The
router forwards only that route, as `<originPath>/<backend>/invocations`.
It does not forward the ingress's other routes: the bare `/invocations`
default-backend route, `/<backend>/delegations`, `/.well-known/*` and
`/entitlements/*`. The ingress serves `POST` only; a `GET` passes the
edge and gets the ingress's own 403. These assumptions hold for the
`api-gateway` ingress, which S-5 stands in for; an `agentcore-gateway`
ingress behind `/agents/*` needs its URL form checked first.

### 6.4 Published interface

- **Constructs** `TenantFrontDoor`, `CellRouteAccess` and `RouteHookAccess`
  (`src/index.ts`).
  `TenantFrontDoor` exposes `distributionId`, `distributionArn`,
  `routeTableArn`, `registrarUrl`, `appDomain`, `addressing`,
  `pooledTenantId` (the distribution tenant) and `routingEndpoint`.
- **Stack output** `RoutingEndpoint` of the main stack: the routing
  endpoint of the stack's connection group, which the pooled distribution
  tenant and every dedicated distribution tenant join. It is the CNAME
  target the operator gives a tenant for its dedicated domain once
  `PutTenantRoute` answers 200 (§3.4 step 5). The answer itself does not
  carry it, because the target is the same for every domain of the
  front door.
- **Published parameter** `/application-plane/shared/front-door/edge` in
  the edge account, one JSON document: `version`, `appDomain`,
  `addressing`, `applicationId`, `distributionArn`, `registrarUrl`,
  `tenantClaim`, `reservedLabels`. A cell stack in another account cannot
  read it, so the application's shared stack in each cell account copies
  `distributionArn`, which `CellRouteAccess` needs, to
  `/application-plane/applications/<applicationId>/shared/front-door`
  (control-plane §6.2): the ARN alone as a plain string, which a cell
  stack reads as a CloudFormation SSM parameter (ADR-0026). The
  `RouteHookAccess` stack writes
  `/application-plane/applications/<applicationId>/shared/front-door-hook`
  in the control plane's account for the route hook (§3.1), one JSON
  document: `version` (1), `registrarUrl`, `appDomain` and `addressing`,
  which the hook needs to poll a tenant host in `host` mode (§4.2). The names differ, so a control-plane account that also
  hosts cells, as in the integration test, holds both.

## 7. Web platform baseline

One response headers policy on every behaviour, the same in both modes. The SPA is static, so CSP
uses script hashes, not nonces. The build step computes the hashes and writes
the policy. For one release the policy carries the previous and the new
script hashes: the policy deploys first, then the SPA files are uploaded,
and the next release drops the old hash. Two sets of hashes fit within the
1,783-character CSP limit (ADR-0008).

### 7.1 Headers

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000`, with no `includeSubDomains` and no `preload` (§7.3) |
| `Content-Security-Policy` | `default-src 'self'; script-src 'sha384-…' 'strict-dynamic' 'report-sample'; connect-src 'self' <token origin> <exchange origin>; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' <authorize origin>; frame-ancestors 'none'; worker-src 'none'; require-trusted-types-for 'script'; report-to fd`, where `<exchange origin>` is present only when `exchangeEndpoint` is set and `report-to fd` only when `reportingEndpoint` is set |
| `Reporting-Endpoints` | `fd="<reportingEndpoint>"`, only when set |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` (sign-in is a full redirect, no popup) |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `Clear-Site-Data` | on `/logout` only: `"storage", "cache"` (§7.3) |

`worker-src 'none'`: the SPA starts no worker, and an import map does
not cover a worker's top-level script. A SPA that needs a worker pins
its script (a hash source or `integrity` on the worker's own fetch) and
changes this directive in the same release (ADR-0023).

`<token origin>` and `<authorize origin>` are the origins of the token and
authorize endpoints in the `issuer` input (§3.6), and `<exchange origin>`
that of its `exchangeEndpoint`, not the issuer URL: for
Cognito they are the user pool domain, while the issuer is on
`cognito-idp.<region>.amazonaws.com`. A `connect-src` that names only the
issuer blocks the code exchange. The stack takes them from its inputs at
synth, with no network call. The SPA reads the same endpoints from
`/config.json` and never fetches the discovery document, which
`connect-src` would block. In `host` mode `form-action` also allows
`https://login.<appDomain>`.

The response headers policy overrides origin headers, so a cell in a
tenant-owned account cannot weaken the baseline (P-8).

**Reports.** A CSP or Reporting API report carries the document's URL
at the time of the violation, query string included, and the
authorization code and `state` sit in the query of the callback page
until `history.replaceState` runs. So `replaceState` runs first: the
first element of `<head>` after `<meta charset>` is a hashed inline
classic script that copies `location.search` into a variable the entry
reads and, only when the query holds `code`, `state` or `error`,
calls `history.replaceState(null, "", location.pathname)`. The SPA
has no other query or fragment routes, so nothing else is lost.
It runs before the parser reaches the import map and the entry, so no
load, and no violation those loads could cause, happens while the URL
holds the code. Both modes handle the callback this way: `/callback`
in `host` mode and `https://<appDomain>/` in `single` mode need no
behaviour or policy of their own, and with `reportingEndpoint` set
reporting stays on for the whole session. The one window left is a
violation before that script runs: the script failing its own hash (a
broken release, which §10 step 3 catches) or a script that something
else, such as a browser extension, injects at document start (T-36,
AR-32). The code is bound to the PKCE verifier the SPA holds (§3.5),
so a reported code alone redeems nothing.

**Imported chunks.** `'strict-dynamic'` trusts every script the hashed
entry loads, so a chunk that someone could write to the SPA bucket
would run in every tenant's origin. The build therefore writes an
import map into `index.html` with an `integrity` entry (`sha384`) for
every chunk the entry can import, statically or with `import()`, and
the entry's own `<script>` carries `integrity`. The import map is an
inline script, so its hash is in `script-src` like the entry's. The
chain from the policy to every chunk is anchored in the response
headers policy, which is not in the bucket. The build fails when an
emitted chunk has no `integrity` entry, as it does for a script with
no hash. A browser that ignores `integrity` in an import map loads
chunks unchecked, and the bucket's write controls (§3.1) are the
control there (ADR-0023). A release adds three hashes to the policy,
the callback script's, the import map's and the entry's, so the two
releases it carries hold six, about 450 characters. With four origins
of 60 characters each the whole policy is about 1,000 characters of
the 1,783.

### 7.2 SPA rules

- No HTML strings into the DOM: `textContent`, `createElement`, or
  `setHTML()` with a fallback sanitiser. Agent output is text, never HTML.
- The first script in `<head>` is the inline callback script (§7.1
  Reports); nothing else in the document loads before it.
- A callback with `error` shows a fixed message. Anyone holding a
  `state` can choose the `error_description` text, so the SPA never
  renders it as HTML, at most as `textContent`.
- In `host` mode, after the code exchange, a token whose `tenant_id` is
  not `/config.json`'s tenant is discarded and the user signed out
  before any `/api/*` or `/agents/*` call (§3.5).
- Trusted Types enforced, with no pass-through policy.
- Same-origin API and agent calls, so they need no CORS. The one
  cross-origin call is the multi-tenant token exchange to
  `exchangeEndpoint`, when set (§3.5). It MUST stay a CORS simple
  request, because the exchange API has no `OPTIONS` route: a `POST`
  whose only header the SPA sets is
  `Content-Type: application/x-www-form-urlencoded` (a `URLSearchParams`
  body, which adds `;charset=UTF-8`), with `credentials` not `include`.
  Browser instrumentation that adds a tracing header to every `fetch`
  excludes this URL, or the browser sends a preflight that API Gateway
  refuses with 403 and no CORS header. The browser lets the SPA read the
  answer only if it carries `Access-Control-Allow-Origin` naming the
  page's origin. The exchange API sends that header only for an `Origin`
  equal to `https://<appDomain>` in `single` mode or one label under
  `appDomain` in `host` mode, and `Vary: Origin` on every answer. API
  Gateway's own answers (a throttle 429, a resource-policy 403, an
  integration failure or timeout, a 502 when the function fails to
  start) carry no CORS header, so the SPA sees a network error and no
  status. It retries a network error on the exchange at most twice with
  backoff (1 s, then 3 s), then keeps the refresh token and shows a fixed
  "try again later" error.
- `PUT` and `POST` calls to `/api/*` send the body's SHA-256 in
  `x-amz-content-sha256`, which origin access control needs to sign a
  request with a body to a Lambda function URL (ADR-0011).
- Content-hashed asset names, so `/assets/*` can be immutable.
- Every module the entry can import is named in the import map with
  its `integrity` (§7.1). The SPA loads no script from another origin.
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

The shared response headers policy sends HSTS without `includeSubDomains`.
It also serves dedicated distribution tenants, and `includeSubDomains` on
a tenant's apex domain would force HTTPS on every subdomain of it for a
year. HSTS with `includeSubDomains` and preload for `appDomain`'s own
subdomains is a step of the same hardening checklist, for the deployer to
take on `appDomain` itself. The sample does not do it.

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
| [ADR-0013](../adr/0013-register-routes-through-a-registrar-that-checks-the-control-plane.md) | Register routes through a registrar that checks the control plane, called from the cell's account. Superseded by ADR-0017 | registrar with a placement check; a cross-account role that writes the store directly; the control plane writes routes |
| [ADR-0014](../adr/0014-run-one-front-door-per-control-plane-application.md) | One front door per control-plane application | one per application; one shared front door keyed by application |
| [ADR-0015](../adr/0015-read-the-control-plane-with-a-reader-token.md) | Read the control plane with a reader token | reader role (control-plane ADR-0042); operator app client; an IAM-authorised read stage |
| [ADR-0016](../adr/0016-sign-in-through-one-shared-host-in-host-mode.md) | Sign in and out through one shared host in `host` mode | shared sign-in host with a signed `state`; a callback URL per tenant; a wildcard callback URL |
| [ADR-0017](../adr/0017-register-routes-from-a-control-plane-global-hook.md) | Register routes from a control-plane global hook; the registrar admits no cell account role, still checks the control plane, and takes a cell's origin once; amends ADR-0002, ADR-0003, ADR-0012, ADR-0014, ADR-0015 | provisioning role in the cell account calls the registrar; tombstones and operator-only rules; the control plane writes the store directly; a global hook calls the registrar |
| [ADR-0018](../adr/0018-prove-a-dedicated-domain-with-a-per-tenant-dns-challenge.md) | Keep dedicated domains in the sample, off unless `dedicatedDomains` is on; route one only after a TXT record holds a token the registrar issued for the tenant and domain, resolved by the function's default resolver and re-checked daily; amends ADR-0002, ADR-0012, ADR-0016 | validated ACM certificate only; TXT record with a registrar-issued per-tenant token; HTTP file challenge on the domain; operator attestation only |
| [ADR-0019](../adr/0019-strip-agents-before-the-agent-ingress.md) | The router strips `/agents` from `/agents/<backend>/invocations` before the agent ingress, and answers 404 for any other `/agents` path; amends ADR-0011 | router `uri` rewrite; an `/agents` base path on the ingress side; no prefix |
| [ADR-0020](../adr/0020-keep-the-re-check-state-in-a-sweeper-owned-dynamodb-table.md) | Keep the dedicated-domain re-check state in a sweeper-owned DynamoDB table: one item for each tenant and domain, one for each daily run | the log as the record (Logs Insights); a sweeper-owned DynamoDB table; fields in the route table |
| [ADR-0021](../adr/0021-add-a-per-ip-rate-rule-ahead-of-the-per-host-rule.md) | In `host` mode, a rate rule aggregated on `Host` and client IP, `ipRequestsPer5Min` (500, chosen, not measured), ahead of the per-host rule; amends ADR-0009 | no per-IP rule; an IP-only rule; a `Host`-and-IP aggregate |
| [ADR-0022](../adr/0022-pin-each-sweeper-page-to-the-listers-date-and-re-read-the-route-table.md) | Pin each sweeper page to the lister's date, which it must match to today and then uses for every read and write; count three misses only on a miss; re-read each passed tenant's entry with `GetKey`, 10 at a time, with no scan (page bound 842 s); grant `BatchWriteItem`; amends ADR-0020 | no date passed; a date the page trusts; a date the page must match to today; a `ListKeys` scan with a deadline; a `GetKey` per passed id |
| [ADR-0023](../adr/0023-pin-imported-spa-chunks-with-an-import-map-integrity.md) | Pin each imported SPA chunk with an `integrity` entry in an import map, and the entry script with `integrity`; the import map's hash joins the entry's in the CSP; amends ADR-0008 | an import map with `integrity`; one bundle with no imports; one hash per chunk in the CSP |
| [ADR-0024](../adr/0024-test-the-agent-route-against-a-stand-in-ingress.md) | Test the agent route against the stand-in ingress of spike S-5, not a composed `agentic-runtime-isolation` | compose `agentic-runtime-isolation` (deploy or reuse); a stand-in |
| [ADR-0025](../adr/0025-change-a-route-status-without-reading-the-control-plane.md) | The edge operator's status change skips the control-plane read, so a suspension works while the control plane is down | read the placement first; skip the read |
| [ADR-0026](../adr/0026-copy-the-distribution-arn-to-cell-accounts-as-a-plain-string.md) | Copy the distribution ARN to each cell account as a plain string | a JSON document; a plain string |
| [ADR-0027](../adr/0027-write-the-hook-parameter-from-the-registrar-url-input.md) | Proposed. Write the front door hook parameter, one JSON document, from a `registrarUrl` input once the main stack is deployed | an input read after the main stack's deploy; the hook reads the edge parameter across accounts; a fixed registrar domain; a separate app |
| [ADR-0029](../adr/0029-join-stress-requests-on-the-cloudfront-request-id.md) | Join the stress slice's requests to the edge log on the CloudFront request id, with no correlation header; the origin is joined by counts | the stress ADR-0005 correlation header; the CloudFront request id; X-Ray trace ids |
| [ADR-0030](../adr/0030-run-the-stress-slice-on-the-smoke-stack.md) | Run the stress slice on the smoke stack, its stacks, hook role and construct id named by a run prefix; budget Lambda concurrency only | the smoke stack named by a prefix; a stack of its own in the front door app; wait for platform mode |

## 9. Spikes

Each spike reports its deploy and destroy time. The questions, pass
criteria and measurements are in [spikes.md](./spikes.md).

| # | Question | Result |
|---|---|---|
| [S-1](./spikes.md#s-1) | Does a multi-tenant distribution run a viewer-request function with a KeyValueStore, and where must the logs go? | Passed with a logging change: the log group is in `us-east-1` (ADR-0010) |
| [S-2](./spikes.md#s-2) | How long does a KeyValueStore write take to apply at the edge? | Median 28.4 s, p99 29.4 s, max 29.5 s at one location |
| [S-3](./spikes.md#s-3) | Does origin access control reach a function URL in another account? | Passed, with the distribution ARN as the permission's `SourceArn` (ADR-0011) |
| [S-4](./spikes.md#s-4) | How does `host` mode get one callback URL per tenant at thousands of tenants? | A client takes 100 callback URLs; passed with a shared sign-in host (ADR-0016) |
| [S-4o](./spikes.md#s-4o) | Does Cognito's `/logout` keep `state`, and which form returns to a tenant host? | The `redirect_uri` form keeps `state` (ADR-0016) |
| [S-5](./spikes.md#s-5) | Does streaming pass through `/agents/*` unbuffered, with the path stripped? | Passed on a standard distribution; the `tenant-only` distribution is checked by the `/agents/*` integration step (§10) (ADR-0019) |
| [S-6](./spikes.md#s-6) | Does a WAF rate rule keyed on `Host` count each tenant on its own? | Passed (ADR-0009) |
| [S-7](./spikes.md#s-7) | Can the router decode a token payload within the function limits? | Passed, 13-14 % compute (ADR-0005) |
| [S-8](./spikes.md#s-8) | Can a resource policy admit a role by `aws:PrincipalArn` in any account? | Passed with an explicit `Deny` added (§3.4) |
| [S-9](./spikes.md#s-9) | Does a client-credentials token from the registrar's client pass the control plane authorizer? | Failed; the `vendorIdp.clientIds` fallback passed (ADR-0015, §6.1) |
| [S-10](./spikes.md#s-10) | What does the registrar function see from its default resolver for a challenge record? | Passed; negative answers last up to the zone's negative-caching TTL (§3.4 step 5, ADR-0018) |

## 10. Integration test outline

Runs in `eu-central-1`, with the edge stacks in `us-east-1` (ADR-0010),
in two accounts. The control plane's account hosts the test's own
control plane and cell A, and is registered vendor-owned, as the control
plane registers its home account (control-plane §1.1). The edge account
hosts the front door and cell B, and is registered tenant-owned, a
test-only shortcut that spares a third account (step 1): the test
deploys the control plane's standalone account role pair there with an
`externalId`, because `PutAccount` refuses `owner: TENANT` without one
and proves that the pair enforces it (control-plane §3.3, §6.4). The test
always deploys its own control plane and never uses a shared one. The
registrar therefore admits a role of another account, every hook call
exercises the identity-side grant that `RouteHookAccess` gives the hook
role, a cell runs in a tenant-owned account, and the global hooks and
the policy the test adds land on no shared control plane, even when a
run stops early. The test reuses the
`tenant-identity` shared pool in both topologies it needs: `shared-pool`
and `shared-pool-multi-tenant`, whose users hold the `tenants` token of
step 5. It needs a public hosted zone for a test domain. Its test inputs,
none of them committed, are `TFD_APP_DOMAIN`, the `appDomain`, which must
be a name below the zone's apex; `TFD_HOSTED_ZONE_ID`, the zone's id; and
`TFD_DEDICATED_DOMAIN`, a second name in the zone, outside `appDomain`,
for step 14. The test role holds `route53:ChangeResourceRecordSets` on
that zone only, to write step 14's TXT records, and `route53:GetChange`
to wait for each change.

Test-only shortcuts, all by the test role and none by the sample's own
code: the step 2 fixture, one `host#` key written straight to the route
table (P-3); and in step 14 the sweeper's table items, which the test
seeds and reads with `dynamodb:GetItem` and `PutItem` on that table
only, because a page acts only on the current UTC day (§3.4). Step 14
also starts the daily run by hand, with `lambda:InvokeFunction` on the
sweeper function only, and reads its result with `logs:FilterLogEvents`
on the sweeper's log group and `cloudwatch:GetMetricData` for the
three-miss count, which IAM cannot narrow to one metric. For step
14's probe of the repeat request, the test role also holds the
registrar's `RequestCertificate` and `AddTagsToCertificate`
statements, built by the same code as the registrar's so their
conditions cannot drift, and `acm:DeleteCertificate` conditioned on
the registrar's distribution tag. The test
creates the test role and the edge operator role it passes as
`edgeOperatorRoleArn` (§3.6) for the run, and removes both after (§6.2).

`test/integ.single.ts` covers the default mode; `test/integ.host.ts` repeats the steps marked (host) with
`addressing: 'host'`.

Expected time, from S-1: deploying the edge stacks and the distribution
takes about 481 s and destroying them about 312 s, before the control plane
and the cells the test also deploys, and each cell or deployment event
runs one route hook build. The route changes of steps 2, 13, 16 and 20
to 22, and the deletes of step 24, go through the route hook, which
waits its 45 s bound (§4.2) before the operation ends. Step 20 adds one
probe build per event, and step 22 waits through two skipped delete
hooks, each three builds of at least one 60 s poll with 60 s and 120 s
between them, so at least 6 minutes each.
The step 2 fixture and the suspensions of steps 13 and 22 are writes
the test makes without the hook, so after each the test waits 90 s for
propagation (§4.2) before its next call. The rotation check after
the list is a separate run with its own time. The dedicated-domain
checks (steps 3, 11 and 18) use a fixture `host#` entry and
`cloudfront:TestFunction`, so they deploy no distribution tenant and no
certificate. Step 14 runs the domain challenge against the real
`TFD_DEDICATED_DOMAIN`: it requests one certificate, creates no
distribution tenant, and adds three waits of a little over 60 s for the
TXT record's TTL, two daily sweeper runs started by hand, each
followed by a wait for its page (at most 15 s for one entry), two stack
updates of the main stack and a wait of up to 15 minutes for the
sweeper to delete the certificate. Step 23 adds the stand-in's deploy
and destroy (67 s and 33 s in S-5), two 90 s waits around the
suspended-tenant check, and a streamed call of a few seconds. The
control plane the test deploys has its own deploy and
destroy time, which the test reports with the rest.

1. Deploy the control plane in the control plane's account, which
   installs that account's role pair, and deploy the account role pair in
   the edge account with an `externalId` the test generates for the run.
   Register both accounts with `PutAccount`: the control plane's account
   as `owner: VENDOR`, and the edge account as `owner: TENANT` with that
   `externalId`. Each `PutAccount` answers 202 (control-plane ADR-0045),
   and the test polls `GetAccount` until the account is `ACTIVE`; it
   polls `GetApplication` and `GetTenant` the same way after the
   application and tenant writes below. The edge account's registration
   lets the test run a tenant-owned cell without a third account. It is a test-only shortcut that a deployment
   must not copy: a real front door's edge account is vendor-owned and
   hosts no tenant-owned cell (§6.1). Deploy the agent ingress stand-in
   (S-5's: a REST API with a REQUEST authoriser and a streaming Lambda proxy that records
   the path and headers it receives), then the front door, with
   `dedicatedDomains` on (§3.6), `edgeOperatorRoleArn` set to the
   operator role the test created, `controlPlane` naming the control
   plane's account and the stand-in's endpoint as `agentIngress`. In the
   control plane's account deploy its
   `RouteHookAccess` stack (the front door app with `registrarUrl` from
   the edge parameter, §3.6), add the stack's policy to the control plane's
   `globalHookManagedPolicyArns` and update the control plane, then run
   `register-hooks.sh`: `ListHooks` names `front-door-post` and
   `front-door-pre`. Register the demo application, whose cell scripts
   write `frontDoorApiDomain` to `OUTPUTS_FILE`.
2. Create tenant `a` (placed by the control plane in its own,
   vendor-owned account, cell A) and tenant `b` (pinned with `accountId`
   to the edge account, cell B). The route hook registers each cell and tenant
   route after its script, and every cell and deployment reaches
   `ACTIVE` with `front-door-post` in its `lastGlobalHooks`.
   The test role then writes one fixture straight to the route table,
   the only write that bypasses the registrar (P-3):
   `host#dedicated-a.example.com` naming `a`, with the control plane's
   account as `ac`, a dedicated domain with no DNS, certificate or distribution
   tenant. It writes with the store's ETag, as every other writer does,
   then waits 90 s, or polls `cloudfront:TestFunction` until
   `/config.json` for that host answers 200, before step 3.
3. `/` serves the SPA with every §7.1 header, and so does every answer
   the router generates itself: the 302 of `/logout`, `/config.json`,
   and the 401, 403, 404 and 503 answers of steps 5, 6, 9, 13 and 17.
   A build test checks that the first script of `index.html` is the
   inline callback script, ahead of the import map and the entry, and
   that the policy's `script-src` carries its hash (§7.1 Reports). In a
   browser, `/callback?code=x&state=y` in `host` mode and
   `/?code=x&state=y` in `single` mode load with no CSP violation and
   end with no query in the address.
   In `single` mode
   `/signin-state` returns 404, and `/logout` returns 302 to the
   issuer's logout endpoint with `client_id` and
   `logout_uri=https://<appDomain>/`, with `Clear-Site-Data:
   "storage", "cache"` (§7.1). Through `cloudfront:TestFunction` with
   `Host: dedicated-a.example.com`, `/config.json` names `signInHost`
   `<appDomain>`.
4. `/api/whoami` with a token for `a` returns `a` from cell A; with a token
   for `b` returns `b` from cell B in the edge account. Each cell read
   the token from `x-tenant-token`.
5. `/api/whoami` with no token, or with a token that carries a `tenants`
   list and no `tenant_id` (from the `shared-pool-multi-tenant`
   topology), returns 401 from the edge (no origin log line). So does a
   request whose `Authorization` header is one byte over 8,192 (§3.3
   step 5), and `cloudfront:TestFunction` with a header of exactly
   8,192 bytes answers without a compute-limit error.
6. A token for an unregistered tenant returns 403 from the edge.
7. A token whose payload is edited to name `b`, with `a`'s signature,
   reaches cell B and is refused there with 403.
8. A client `x-tenant-route: b` or `x-tenant-token` header with `a`'s
   token is ignored.
9. `Sec-Fetch-Site: same-site` on `/api/*` returns 403.
10. A direct call to either cell's function URL, without CloudFront,
    returns 403. Template tests check that the SPA bucket's policy denies
    `s3:PutObject`, `DeleteObject` and `DeleteObjectVersion` to every
    principal except the two deployment roles, and that versioning and
    Block Public Access are on (§3.1), and the SPA build test checks that
    a chunk with no `integrity` entry fails the build (§7.1).
11. The edge account's tenant provisioning role, the tenant-owned role
    that ran `b`'s script, calls `PutTenantRoute` for `b`, its own
    tenant, and for `a`: 403 for both, from the resource policy's
    explicit `Deny` (§3.4), and `a` is still routed to cell A. Its call for `b` with
    `customDomain` `dedicated-b.example.com` gets 403 too, and no `host#`
    key is written. The edge operator role calls
    `PutTenantRoute` for `b` with `customDomain` `a.<appDomain>`: 400,
    and in `host` mode `a.<appDomain>` still routes to cell A. With
    `customDomain` `dedicated-a.example.com`, `a`'s dedicated domain
    from step 2: 409, and the fixture still names `a`.
12. The edge account's cell provisioning role calls `DeleteCellRoute`
    for cell B, its own cell, and for cell A: 403 for both, from the
    explicit `Deny`. The control plane account's cell provisioning role,
    which ran cell A's script, makes the same calls: 403 for both, because
    the resource policy admits no role of that account but the global
    hook role. An edge-account principal that is neither a pair role nor
    the operator role, with `execute-api:Invoke` in its identity policy,
    calls the registrar: 403 (the explicit `Deny`, §3.4).
13. Suspend `b`: after 90 s, `b`'s token returns 503, `a` is still served.
    The edge account's tenant provisioning role then calls
    `DeleteTenantRoute` and `PutTenantRoute` for `b`: 403 for both, and
    `b`'s entry is unchanged. `UpdateDeployment` for `b` through the
    control plane runs `front-door-post`, which puts `b`'s route again;
    the deployment reaches `ACTIVE`, and after 90 s `b`'s token still
    returns 503.
14. Domain challenge (ADR-0018), in `test/integ.single.ts` only.
    `<dd>` is `TFD_DEDICATED_DOMAIN`, for example
    `dedicated-c.test.example.com` when `appDomain` is
    `app.test.example.com`. The test writes TXT records at
    `_tfd-challenge.<dd>` with a 60 s TTL, and publishes the first
    records before the registrar first looks the name up, so no
    negative answer is cached, which could hide a record for the zone's
    negative-caching TTL (spike S-10). After each change it waits for the change to reach
    `INSYNC` and then past the TTL; spike S-10 saw no old answer later
    than 31 s after `INSYNC` for a 60 s record. The edge operator role
    calls `PutTenantRoute` for `a` with `customDomain` `<dd>`: 202 with `stage`
    `domain-challenge` and a TXT record carrying token Ta, and `a`'s
    entry holds `d`, `dk` and `dx`. It drops the domain from `a`
    (`PutTenantRoute` without `customDomain`): 200, the entry holds none
    of them, and the registrar holds no certificate for `<dd>`. It sets
    `<dd>` for `b`: 202 with a new token Tb. The test publishes
    `tfd-verify=<Ta>`, the leftover of a former holder, and a value of
    the same form with a random token, and waits past the TTL: `b`'s
    repeat answers 202 with `challenge` `mismatch`, and the registrar
    still holds no certificate for `<dd>`. It adds `tfd-verify=<Tb>`
    beside them and waits past the TTL: `b`'s repeat answers 202 with
    `stage` `certificate` and ACM's validation record, and the
    registrar holds one certificate for `<dd>`, tagged with `b`. `a`'s
    call for `<dd>` now gets 409 (§3.4 step 4), and `a`'s entry gets no
    token. The test publishes no ACM record and makes no further call
    for `b` with `<dd>`, so no distribution tenant is created. `b`'s
    challenge has passed, so the daily re-check covers it. The test
    reaches a third missed day by editing the sweeper's table, not the
    sweeper (the test-only shortcut above). With `tfd-verify=<Tb>` still
    published, it writes `b`'s entry item for `<dd>` as it would stand
    after two missed days: `lastCheckedDay` yesterday (UTC),
    `lastOutcome` `miss`, `missStreak` 2, `errorStreak` 0, `missBefore`
    1 and `errorBefore` 0. It starts each hand run only when at least
    15 minutes remain before 00:00 UTC, and otherwise waits for the new
    day, because a page that starts after midnight exits as a no-op
    (§3.4). It invokes the sweeper function with the Scheduler's input
    and waits until the item shows today and the
    day's run item shows `pagesStarted` 1 and `pagesFinished` `{1}`.
    The test reports the time the page's `GetKey` reads took, from the
    page's log, for each hand run, because their 2 s limit (§3.4) is
    chosen, not measured. The
    check is a pass: the item holds `lastOutcome` `pass`, `missStreak` 0
    and `errorStreak` 0, and no three-miss line was logged. The test
    then removes `tfd-verify=<Tb>`, waits past the TTL, writes the item
    as before and invokes the sweeper again, which is the same run on
    the same day, and waits until the item shows today and `lastOutcome`
    `miss`: `missStreak` 3, `missBefore` 2, `errorStreak` 0. That run
    logged the three-miss line for `b` and `<dd>` with no token in it
    and added one count to the re-check metric. With `b` still holding
    `<dd>`, a stack update that turns `dedicatedDomains` off fails on
    the guard and rolls back, and `b`'s entry still holds `d`. The test drops `<dd>` from
    `b`, deletes the TXT records and waits until the sweeper has
    deleted the certificate (one 15-minute run at most). The same stack
    update then succeeds, and the edge operator role's `PutTenantRoute`
    for `a` with `customDomain` `<dd>` gets 400. Step 24's leftover
    check confirms the certificate is gone. A former holder whose
    challenge had passed differs only by a certificate the sweeper
    deletes before the domain is free, so the test does not build one.
    `b`'s certificate request is the run's check that ACM authorises the
    tags of a request under the tag grant's `aws:ResourceTag` condition (§3.4).
    The repeat of sub-step 6 within ACM's hour sends the same token and
    tags again for a certificate that already carries the distribution
    tag, which `b`'s calls never reach, because a pending certificate
    is found and not requested again. The test makes that repeat as the
    registrar would (the test-only probe above): it requests a
    certificate for `probe.<dd>` with the registrar's three tags for
    `b` and a random idempotency token, then repeats the request at
    once, before a sweeper run can delete it, with the same token and
    tags. Both return the same ARN and neither gets
    `AccessDenied`. It deletes the probe certificate and repeats the
    request once more with that token: the test reports whether ACM
    returns the deleted ARN, which the registrar reads as no
    certificate (sub-step 6), or a new one, which it then deletes too.
    The probe certificate carries `b`'s tags for a domain that is not
    `b`'s `d`, so a sweeper run between a request and the test's delete
    removes it; each of the test's deletes accepts
    `ResourceNotFoundException`.
    The step creates no distribution tenant, so the create in the stack's
    connection group, its tags and the `ListTagsForResource` reads are
    not checked here.
15. Wait 60 s for log delivery (33 s in S-1). Per-tenant counts name
    `a` and `b`, queried in `us-east-1` where the log group is
    (ADR-0010), from `viewer-request-log-data` in both modes (§3.1); in
    `host` mode `x-host-header` agrees with it, and an `/assets/*` load
    on `a.<appDomain>` names `a` (host). Requests to
    `login.<appDomain>` leave the field empty (host). The registrar's API access
    log, in `eu-central-1`, names the edge account and the control
    plane's account on the refused calls of steps 11 to 13, and the registrar log names the global hook
    role on the writes of steps 2, 13 and 16.
16. Delete `b`'s deployment: `front-door-pre` removes `b`'s route before
    the delete script runs, and once the deployment is gone `b`'s token
    returns 403, because its entry is gone.
17. (host) `a.<appDomain>/config.json` names `a`; an unregistered host
    returns 404; `a.<appDomain>/api/whoami` with no token returns 401
    with `WWW-Authenticate: Bearer`; a token for `a` on
    `b.<appDomain>/api/whoami` returns 403 from the edge, with no origin
    log line in cell B;
    `a` over its rate gets 429 while `b` is served, with
    `ipRequestsPer5Min` set above `tenantRequestsPer5Min` for this step,
    because the test sends from one address and the per-IP rule would
    answer first. The test sets it with a stack update of the edge stack
    in `us-east-1` before the step and sets it back with a second one
    after; each changes only the web ACL's rule and is expected to take
    about 2 minutes (an estimate, not measured; the test reports the
    measured time). After each update the test waits about 60 s for the
    rule change to reach the edge (an estimate, not measured), and the
    check tolerates a longer wait. It sends `a` over its rate until the
    first 429, for at most 5 minutes, and fails when none comes. That
    first 429 must carry `x-tfd-rate-rule: host`. When it carries
    `x-tfd-rate-rule: ip`, the old per-IP value still applies at the
    edge: the test waits out the 5-minute rate window and repeats the
    check, with at most 3 retries (4 checks in total), and fails after
    the last. Each check allows up to 5 minutes of sending plus the
    5-minute wait, so the step can take about 40 minutes at worst. It
    reports the time from the stack update to the passing check. It then asserts
    `b` is served. Through
    `cloudfront:TestFunction` with
    `Host: <appDomain>`, the router answers 404.
18. (host) Sign-in host (ADR-0016). `/signin-state` on `a`'s host with
    `Sec-Fetch-Site: same-origin` returns a `state`; cross-site it gets
    403, and with a malformed nonce 400. A real sign-in through the issuer
    reaches the sign-in host and gets a 302 to `a`'s `/callback` with the
    code and `state`; the SPA's exchange with the same `redirect_uri`
    returns a token. A missing or changed `state`, a host that is not a
    registered tenant, and a suspended tenant's host each get 400 on
    `login.<appDomain>`; an expired `state` gets 302 to `a`'s `/`. The
    dedicated-domain checks run through `cloudfront:TestFunction` on
    the router with `Host: dedicated-a.example.com` (step 2), which has
    no DNS or certificate and so costs no deploy: `/config.json` names
    `signInHost` `a.<appDomain>`, and `/signin-state` and `/logout` get
    400. A `state` for that domain, which the test signs with the live
    `signin` key, gets 400 on `login.<appDomain>`. `/logout` on `a`'s host
    returns 302 to the issuer's logout endpoint with `client_id`,
    `response_type=code`, the sign-in host's `redirect_uri` and a
    `state` for `a`'s host, with `Clear-Site-Data: "storage",
    "cache"`. The issuer then shows the sign-in form, so the session
    ended. After a fresh sign-in the sign-in host's `Location` is
    `https://a.<appDomain>/` with no `code` and no `state`.
    `login.<appDomain>/logout` returns the static signed-out page.
19. An application without a front door. Register `demo-plain`, which
    has no `RouteHookAccess` stack and whose scripts write no outputs,
    and create a deployment of `a` in it: its cell and its deployment
    reach `ACTIVE` with `front-door-post` in `lastGlobalHooks`, and the
    route table is unchanged.
20. The shared role outside its operation. The test registers a third
    global hook, `tfd-probe` (`test/hooks/probe-hook.sh`, `POST` on
    `CELL_UPDATE` and `DEPLOYMENT_UPDATE`), whose id sorts after
    `front-door-post`, so it runs after it (control-plane R-45). It acts
    only for an application with a front door hook parameter and calls
    the registrar under the global hook role. On `a`'s
    `UpdateDeployment` it calls `DeleteTenantRoute` for `a` (record
    `UPDATING`) and `PutCellRoute` for cell A (record `ACTIVE`): 409
    for both. On `UpdateCell` for cell A it calls `PutCellRoute` for
    cell A with another function URL host in the Region: 409, the
    origin is write-once; and with a host outside the function URL
    form: 400. It exits 0 only when every answer is the expected one,
    so a wrong answer lands the operation in `UPDATE_FAILED` with
    `tfd-probe` named. Both operations reach `ACTIVE`, `a`'s token is
    still served by cell A, and the test then removes `tfd-probe` with
    `DeleteHook`.
21. A cell event without `frontDoorApiDomain`. The demo application
    declares a cell parameter, `FRONT_DOOR_OUTPUT` (default `on`; a
    control-plane parameter name matches `[A-Z][A-Z0-9_]{0,63}`); its
    cell update script writes no `frontDoorApiDomain` when
    `PARAM_FRONT_DOOR_OUTPUT` is `off`. `UpdateCell` for cell A with
    `parameters: {FRONT_DOOR_OUTPUT: off}` lands in `UPDATE_FAILED`
    with `front-door-post` named in `statusReason`, and `a` is still
    served. `UpdateCell` with `removeParameters: [FRONT_DOOR_OUTPUT]`
    brings it back to `ACTIVE` (§3.4). A cell create
    runs the same hook code; the test builds no failing cell for it,
    because cell parameters are empty at a cell's birth
    (control-plane R-34).
22. A skipped delete hook, and a suspension across a re-created
    deployment. Create tenant `c` in cell A and suspend it;
    after 90 s its token gets 503. The test points the front door hook
    parameter's `registrarUrl` at a path the registrar does not serve,
    which API Gateway refuses with 403, and deletes `c`'s deployment:
    `front-door-pre` fails three times and is skipped, the control
    plane counts the skip, the deployment is deleted, and `c`'s entry
    stays `suspended`. The test restores the parameter and creates `c`'s
    deployment again: its `createdAt` differs from the entry's `dt`, so
    `front-door-post` replaces the entry and keeps `suspended`, and
    `c`'s token still gets 503. The edge operator role resumes `c`
    (`UpdateTenantRouteStatus`), and after 90 s `c`'s token is served by
    cell A. The test suspends `c` again and, with the parameter intact,
    deletes `c`'s deployment (`front-door-pre` removes the entry, and
    after 90 s `c`'s token gets 403) and creates it again: the new entry
    is `active`, and `c`'s token is served by cell A (AR-31). The test
    breaks the parameter again and deletes `c`'s
    deployment, which skips the hook again; the edge operator role's
    `DeleteTenantRoute` for `c` answers 200, and after 90 s `c`'s token
    gets 403. The test restores the parameter.
23. `/agents/*` on the `tenant-only` distribution (ADR-0019), in
    `test/integ.single.ts` and, for the rewrite and the 404 cases,
    again in `test/integ.host.ts`. S-5 ran on a standard distribution,
    so this step is what verifies the path on the distribution the
    front door deploys. Through `cloudfront:TestFunction` on the
    deployed router, with `Host: <appDomain>` (`a.<appDomain>` in
    `host` mode) and a token for `a`: `POST
    /agents/support-bot/invocations` with the query string `x=1`
    comes out with `uri` `/support-bot/invocations`, the query string
    unchanged and `x-tenant-route: a`. Each of `/agents`, `/agents/`,
    `/agents/support-bot`, `/agents/support-bot/invocations/`,
    `/agents/Support-Bot/invocations`, an `invocations` path with a
    33-character backend, `/agents/support-bot/delegations`,
    `/agents//invocations`, `/agents/%73upport-bot/invocations` and
    `/agents/..%2fentitlements/invocations` gets 404 with the static
    body and no rewrite. `/agents/entitlements/invocations` passes the
    router, rewritten to `/entitlements/invocations`: the backend name
    fits the pattern, and only the real ingress decides where that
    path lands (ADR-0024). With no token the agent route gets 401, with
    a token for an unregistered tenant 403, and with `Sec-Fetch-Site:
    same-site` 403. The edge operator role then suspends `a`, and after
    90 s `a`'s token on the agent route gets 503 with
    `Retry-After: 300`; it resumes `a` and waits 90 s before the
    streamed call below. Then one streamed `POST
    https://<appDomain>/agents/support-bot/invocations` with `a`'s
    token goes through the real distribution to the stand-in, which
    writes ten events 500 ms apart: 200, the first byte at the client
    within 1 s of the stand-in's first write, one event per read with
    client gaps near 500 ms, so nothing was buffered. The stand-in saw
    `<stage>/support-bot/invocations` with no `/agents`, the viewer's
    bearer in `Authorization` and `x-tenant-route: a`. `POST /agents`
    gets CloudFront's own 403, `/agents/` the router's 404, and the
    stand-in logs no request for either.
24. Remove the step 2 fixture key. Tear down in the §6.2 order: delete
    the deployments and cells of both applications through the control
    plane, whose `front-door-pre` hook removes their routes; run
    `register-hooks.sh --delete` when no other front door uses the
    control plane; take the `RouteHookAccess` policy out of
    `globalHookManagedPolicyArns` and update the control plane; destroy
    `RouteHookAccess`, which keeps its hook parameter; delete that
    parameter; then destroy everything else the test deployed,
    in both accounts, the control plane and the operator role included,
    except the shared identity pool. The leftover
    check also finds no registrar certificate for `<dd>` or
    `probe.<dd>` (step 14), no
    hook parameter and no stand-in stack (step 1).

Rotation check, optional and run on its own against a `host` mode front
door: run the three rotation updates of §4.1 and check that a `state`
minted before the switch to the new `current` still verifies, and that
it gets 400 once the old id is removed. It adds three stack updates, the
90 s propagation wait and the 10-minute `state` lifetime, so at least
11 minutes plus the updates.

Not tested end to end, and covered by unit tests with a stubbed
resolver or clock instead: the expiry of an open challenge and the new
token it gets (the 7-day `dx` has no test-only override); a resolver
error answered as `unresolved`, on an operator call and as an error
line in the daily re-check (in the public test zone only a lame
delegation makes the resolver fail, and that would leave a dangling
delegation); a CNAME at the challenge name; the in-call lookups (step
14 publishes its records before the first lookup, so it never drives a
stale one): a pass on a later lookup after earlier misses, `mismatch`
winning over `missing` across lookups, `unresolved` only when all five
lookups error (a mix of errors and misses is a miss), the stop at the
first CNAME, and the 1 s limit on each lookup; the lookup before the
`host#<d>` write (step 14 requests a certificate but publishes no ACM
validation record, so the certificate never issues and no call reaches
that lookup); and the restart
after an ETag conflict on a challenge write; the day
rules of the daily re-check (a repeated page or lister on the same day
changing nothing, a miss replacing a pass and a pass replacing an error
on the same day, an error day leaving the miss streak as it was and
emitting no three-miss count, a page whose date is not the current UTC
date exiting as a no-op with its stale-page line, a page whose
`GetKey` for a passed id returns `ResourceNotFoundException` skipping
that id with one line naming the tenant id, writing no item for it and
finishing, a `GetKey` failing with another error failing the page, a day
with no check leaving a streak as it was, and an entry that errors three
days in a row with its `unverifiable` line and count); a daily-run page
that fails, so that it adds no page number to `pagesFinished`, the
on-failure queue, the missing-pages count, the missing-pages alarm and
the no-lister alarm (a previous day with no run item, the 0 of a first
run and two days with no lister included); the lister's deletion of the
items of a domain that is changed or dropped; the starter's deploy-time
run and its zero-page run item; the guard's 40 s wait; a run with zero
pages; the teardown's deletion of a certificate that is still pending
(step 14 leaves none behind, because the sweeper deletes its
certificate); the router's
answer to every `/agents` path when `agentIngress` is off (step 23's
front door always sets it).

Also not driven end to end, and covered by unit tests with a stubbed
control plane, store, resolver or clock instead: the lifecycle of a
dedicated distribution tenant (its creation, `CNAMEAlreadyExists`, its
disable and delete, and the teardown resource's polling for a disable to
deploy), because step 14 never lets a certificate issue and a real
distribution tenant needs a validated certificate for a name in the test
zone and a CloudFront deploy of minutes; the registrar's `createdAt`
parse (a stubbed `GetDeployment` returning `...:01Z` for an entry
stored from `...:01.000Z` keeps the entry, and one that does not parse
gets 503 with no write, §4.1), because the real control plane returns
one form only; the cell's hosts check on a
validly signed token routed to the wrong cell, and the origin's refusal
of a route hint that differs from the verified claim (the demo cell API's
unit tests; step 7 drives a forged signature only); the `single` mode
origin rate limit (the demo cell API's unit test); the edge operator's
`PutCellRoute` backfill and origin change, `DeleteHostRoute`, the 503 for
a missing `cell#`, the 507 answers and the 429 for a certificate
quota; a `host#` entry with no `tenant#`
entry (a router test on a stubbed store); the SPA's token exchange to
`exchangeEndpoint`, CORS headers and the bounded retry included (a
browser test against a stub endpoint; `tenant-identity`'s own §10 step 7
checks its exchange's CORS answers); and the per-IP rate rule's block (the web ACL template test
checks its priority, its Host-and-IP key and each rule's
`x-tfd-rate-rule` header, and the test has one source address). The alarms' notifications are not checked; a template test checks that
every alarm names `alarmTopicArn` when it is set, and
step 14 checks the metric count the re-check alarm watches. The route
hook's own paths that the run does not provoke (a throttled parameter
read and its five attempts, the registrar retries on 503, 429 and no
answer, the fail-at-once statuses, `SCRIPT_OUTPUTS` that is not an
object of strings or repeats a key, a `frontDoorApiDomain` outside the
origin form, credentials in an unexpected form, and the `host` mode
poll that gives up after 45 s) and `register-hooks.sh` are unit tested
by running the scripts with bash against stub `curl`, `aws` and `sleep`
commands.

## 11. Open questions

- Q-1: What raises the router's compute utilization to 94 % in the worst
  minute under ordinary load, and what margin is left to the function's
  limit (§3.3)? The stress slice reads the metric once a minute, as the
  maximum over that minute's invocations, and does not isolate the
  invocation that costs it. A run that sends one request in a minute, or
  reads the function's own log of compute time, settles it.

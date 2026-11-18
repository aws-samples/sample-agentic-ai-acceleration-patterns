<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant front door for agentic applications: specification

Status: Proposed. §8 lists the decisions, all Accepted except ADR-0017,
which is Proposed. This specification describes route registration as
ADR-0017 decides it, from the control plane's global hooks
(control-plane ADR-0044, also Proposed, Q-5). ADR-0017 will supersede
ADR-0013 once ADR-0044 is accepted; until then ADR-0013 stays Accepted,
and the control-plane hooks branch merges before this one. Two spikes are
still open: S-5 (`/agents/*` streaming, §9), which if it fails reopens
the `/agents/*` origin request policy in ADR-0011, and S-10 (DNS answers
to the registrar's Lambda function), which if it fails reopens the
resolver choice in ADR-0018.

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
- A per-tenant rate limit at the edge in `host` mode and at the origin
  in `single` mode (ADR-0009).
- Optional dedicated domains: a tenant proves that it controls its own
  domain with a TXT record carrying a token the registrar issued for
  that tenant and domain, before any certificate or distribution tenant
  exists for it (ADR-0018).
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
   write and keeps no placement data of its own.
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
| Dedicated distribution tenant | edge | CloudFront distribution tenant | Serves one tenant's own domain, with its own ACM certificate in `us-east-1` and optional web ACL override. Only when `dedicatedDomains` is on (§3.6). On the edge operator role's `PutTenantRoute` the registrar first issues a domain challenge; once the tenant has published its token it requests the certificate and, once that has validated, creates the distribution tenant. It removes both in two phases when the domain goes, and re-checks the challenge record daily (§3.4 step 5, ADR-0018) |
| Tenant router | edge | CloudFront Function (viewer request, JS 2.0) | Finds the tenant, refuses or routes. It names the tenant it routed on in the access log with `cf.logCustomData` (Telemetry, below). In `host` mode it also mints and checks the signed sign-in `state` and starts sign-out (§3.5, ADR-0016) |
| Route table | edge | CloudFront KeyValueStore | `tenant`, `host` and `cell` entries, the `app` settings and, in `host` mode, the `signin` key (§4) |
| Route registrar | edge | API Gateway (IAM auth) and Lambda | The only writer of the route table, and the only creator of dedicated distribution tenants, which its scheduled sweeper deletes once disabled; the sweeper also re-checks each routed dedicated domain's challenge record daily (§3.4 step 5). Admits only the control plane's global hook role and the edge operator role, and checks each write against the control plane (§3.4) |
| SPA origin | edge | S3 bucket with origin access control | One build for every tenant |
| Cell API origin | the cell's | The cell's API (demo: Lambda function URL with origin access control) | Verifies the token, checks the route hint and the cell's tenants |
| `CellRouteAccess` construct | the cell's | Lambda permission | Grants `cloudfront.amazonaws.com` `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, conditioned on the edge distribution's ARN |
| Agent route | edge | `/agents/*` behaviour | Streams to the agent ingress of `agentic-runtime-isolation`, when configured, with the `Managed-AllViewerExceptHostHeader` origin request policy |
| Route hook | the control plane's | CodeBuild, the control plane's global hook project, under `<fleet>-global-hook` (control-plane R-41) | `hooks/route-hook.sh`, registered as two global hooks. `front-door-post` (`POST` on `CELL_CREATE`, `CELL_UPDATE`, `DEPLOYMENT_CREATE`, `DEPLOYMENT_UPDATE`) puts the cell or tenant route; `front-door-pre` (`PRE` on `CELL_DELETE`, `DEPLOYMENT_DELETE`) deletes it (§3.2, §3.4). It acts only for an application that has a front door hook parameter (`RouteHookAccess`, below) in the control plane's account, and exits 0 for every other (ADR-0014) |
| `RouteHookAccess` stack | the control plane's | IAM and SSM Parameter Store | The front door hook parameter `/application-plane/applications/<applicationId>/shared/front-door-hook` with `registrarUrl`, a name of its own so that it cannot collide with the cell-account copy (§6.4) when the control plane's account also hosts cells, and a customer-managed policy, listed in the control plane's `globalHookManagedPolicyArns`, that lets `<fleet>-global-hook` invoke this registrar and read any front door hook parameter, `/application-plane/applications/*/shared/front-door-hook` |
| `register-hooks.sh` | the operator's shell | the control plane API, with an operator token | Puts both global hooks with `PutHook`, from this sample's source at a pinned commit; idempotent. `--delete` removes them (§5.2) |
| Telemetry | edge | CloudFront standard logging v2: delivery source, delivery destination, delivery and log group in `us-east-1` (ADR-0010) | Per-tenant requests, errors, bytes, latency, from the record fields ADR-0010 lists, never `cs-uri-query`, `cs(Referer)` or `cs(Cookie)`. The tenant is in `viewer-request-log-data`, in both modes. In `single` mode every pooled tenant shares one host and one distribution tenant, so no other field names it. In `host` mode `x-host-header` names a pooled host's tenant but not a dedicated domain's, so the router fills the field there too, and one query serves both modes. The router calls `cf.logCustomData` where it first knows the tenant, with the lower-case tenant id, or `-` when the id does not match the §4.1 id pattern: straight after the §3.3 step 2 `host#` lookup, with the entry's `t`, on every host it looks up (`host` mode, and a dedicated domain in either mode); and in §3.3 step 5 in `single` mode, on every host, with the decoded claim, or `-` when step 5 found none. CloudFront keeps only the last value a request logs, so in `single` mode on a dedicated domain the claim, which the router routes on, replaces the host's tenant for every request that reaches step 5. It never passes the token, a header, the path or the query. CloudFront writes the value into the request's own access-log record, URL-encoded, at most 800 bytes; an id of the §4.1 form needs no encoding. On a looked-up host every request therefore names the tenant, SPA loads, `/config.json`, `/logout` and step 4 refusals included. On `<appDomain>` in `single` mode the requests answered before step 5 (SPA loads, `/config.json`, `/logout`, step 4 refusals) carry no tenant, because no token is decoded for them. The sign-in host and a 404 for an unknown host leave the field empty. The field names the claimed tenant, which is unverified: the decoded claim in `single` mode, the host the caller chose in `host` mode. Traffic with a forged claim counts against the tenant it names, so the field serves operations and cost estimates, and a billing-grade count comes from the cell's own log of verified requests |

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

Routes reach the route table on a path of their own, from the control
plane's workflow, never from a request or a cell account (ADR-0017):

| Control-plane event | Hook, phase | Registrar call | Values from |
|---|---|---|---|
| `CELL_CREATE`, `CELL_UPDATE` | `front-door-post`, `POST` | `PutCellRoute` | `CELL_ID`; the API domain from the cell script's `frontDoorApiDomain` output (`SCRIPT_OUTPUTS`, control-plane R-43) |
| `DEPLOYMENT_CREATE`, `DEPLOYMENT_UPDATE` | `front-door-post`, `POST` | `PutTenantRoute` | `TENANT_ID`, `TENANT_NAME` |
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
and token endpoints, client id and scopes, plus the tenant id
(upper-cased back to its control-plane form, which the token exchange
expects), display name and `redirectUri`
(`https://login.<appDomain>/callback`) in `host` mode. It holds nothing
secret. The SPA does not fetch the issuer's discovery document (§7.1).
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
   `host#<host>`. No entry: 404 with a static page. An entry: call
   `cf.logCustomData` with its `t` (§3.1), so every later answer on the
   host, SPA loads and step 4 refusals included, names the tenant; in
   `single` mode step 5 replaces it with the decoded claim.
3. Paths that need no tenant (§3.2) skip to step 8, and so does
   `/signin-state` in `single` mode.
4. For `/api/*`, `/agents/*` and `/signin-state`, check `Sec-Fetch-Site`.
   Allow only `same-origin`, `none`, or no header; refuse the rest with
   403 (§7.3).
5. Find the tenant:
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

The router reads at most three keys per request. `/api/*` on a host it
looks up (`host` mode, or a dedicated domain) reads all three: `host#`,
`tenant#` and `cell#`. The token decode reads no key, so the `host` mode
agreement check of step 5 adds no read, and its compute is the decode
S-7 measured (13-14 %). It checks no token signatures and writes
nothing to the store; its only output besides the request or the
answer is the tenant id it passes to `cf.logCustomData` (§3.1). In
`single` mode it holds no secrets. In `host` mode it holds one, the
sign-in HMAC key in the `signin` entry (§3.5, ADR-0016).

### 3.4 Route registrar, step by step

The registrar is a regional API in the edge account with `AWS_IAM`
authorisation. Its resource policy admits two principals by
`aws:PrincipalArn`: the control plane's global hook role,
`arn:<partition>:iam::<control plane account>:role/<fleet>-global-hook`
(§3.6), under which the route hook runs, and the edge account's own
operator role. The policy also carries an explicit `Deny` with
`ArnNotLike` on `aws:PrincipalArn` for every other principal: without it,
any principal in the edge account whose identity policy allows
`execute-api:Invoke` gets in, because a same-account call needs only one
of the two policies to allow it (spike S-8). When the control plane runs
in another account, the hook role also needs `execute-api:Invoke` on the
registrar in its identity policy, which the `RouteHookAccess` policy
gives it (§3.1). No role of a cell account is admitted, its provisioning
role pair included, so a tenant-owned account reaches the registrar with
no credential it holds (ADR-0017). Admission only gets a caller to the
checks below; it grants no route.

Every global hook on the control plane runs under the same
`<fleet>-global-hook` role (control-plane R-41). Admission therefore
proves that a vendor global hook is calling, not that the route hook is
calling for the record it names. So the registrar still reads the
control plane on every write, takes the placement from it, and admits a
global hook's write only while the record has an operation of the
matching kind in flight (ADR-0015, ADR-0017). That binds a write to the
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
within the pinned form, as under ADR-0013.

On every write:

1. Take the caller's role from the signed request context: the global
   hook role or the edge operator role. Ignore any account or cell id in
   the body.
2. Read the placement from the control plane API with a reader token
   (control-plane R-36): the registrar's own app client on the vendor IdP,
   whose `role` is one of the control plane's `readerRoles`, so the
   registrar can read placement and change nothing:
   - cell route: `GetCell(cellId)`;
   - tenant route: `GetDeployment(tenantId, applicationId)`, where
     `applicationId` is the front door's own.
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
   that entry's `dt` (409 otherwise), and the entry keeps its `c`, `ac`
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
   replaces it as a new entry, and removes the old entry's `host#` keys
   and its domain as a delete would. A new `tenant#` entry gets
   `s: active`. Any write to an existing entry keeps its `s`, whether
   the global hook role or the edge operator role makes it: only
   `UpdateTenantRouteStatus` changes it (§4.2).

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
      `_tfd-challenge.<d>` TXT `tfd-verify=<dk>`, and the expiry. This
      call looks nothing up: no record can hold a token that did not
      exist before it.
   2. Challenge open (`dx` present): when `dx` has passed, issue a new
      token and expiry as in sub-step 1 and answer 202 with the new
      record; the old token no longer passes. Otherwise resolve TXT at
      `_tfd-challenge.<d>` with the function's default resolver (below).
      When one record's strings, joined, equal `tfd-verify=<dk>`, the
      challenge passes: remove `dx` with the ETag, keep `dk`, and go on
      to sub-step 3 in the same call. Other values at the name, a former
      holder's or another tenant's token among them, are ignored. No
      match: answer 202 with the same record and `challenge: "missing"`
      (no TXT record at the name) or `"mismatch"` (records, none with
      this token). No certificate is requested before the challenge
      passes.
   3. Challenge passed (`dk` without `dx`): find what exists and create
      only what is missing. The certificate is an ACM certificate in
      `us-east-1`, which CloudFront requires, requested by the registrar across Regions with DNS validation and
      tagged with the tenant id and the distribution id. The registrar
      finds it among its own certificates by domain name and tags, and
      finds the distribution tenant with `GetDistributionTenantByDomain`.
   4. Certificate pending: answer 202 with `stage: "certificate"` and
      ACM's validation record. The operator repeats the call once the
      tenant has published the record in the domain's DNS.
   5. Certificate issued: create the distribution tenant with it, on
      this distribution and with the same tags, unless it exists; write
      `host#<d>`; answer 200. No request is routed on the domain before
      then. A repeat after 200 changes nothing and answers 200.
   6. Certificate failed, or validation timed out (ACM stops waiting
      after 72 hours): 422 with ACM's reason. The operator drops the
      domain and sets it again, which also issues a new challenge.

   The token binds the challenge to one tenant and one domain: it lives
   in that tenant's `tenant#` entry next to `d`, is compared only for
   that `d`, and goes when `d` goes. A token issued to another tenant,
   or for another domain, is never compared, and a former holder's
   record names a token that was removed with its `d`, so neither
   passes. The resolver is the default one of a Lambda function outside
   a VPC, AWS's recursive resolver: no third party, no egress rule and
   no resolver code. It caches an answer for its TTL, and a negative
   answer for the zone's negative-caching TTL, so a repeat made before
   the tenant published the record can delay the pass by that much
   (spike S-10 measures it). Caching can delay a pass but never cause
   one, because no cached answer can predate the token. The check
   trusts one DNS answer from one Region without DNSSEC, as ACM's own
   DNS validation does. Shortcut: one vantage point; upgrade to a second
   Region's answer, or DNSSEC validation, when a vendor needs the
   multi-perspective check public certificate authorities make.

   The tenant keeps the `_tfd-challenge` record while the domain is
   routed. A second EventBridge Scheduler schedule runs the sweeper
   daily, which resolves the record for every `tenant#` entry with a
   passed challenge and logs each miss (no record, or none with the
   entry's `dk`) with the tenant and the domain, never the token. A
   metric filter counts the misses, and an alarm fires when three daily
   runs in a row find one. The alarm tells the operator, who drops the
   domain with `PutTenantRoute` or removes the route. The sweeper never
   drops a domain itself: a DNS fault or a tenant's mistake would then
   take a routed domain offline with no person deciding. This covers a
   domain that changes owner: the new owner's zone lacks the record,
   the alarm fires, and the old tenant's route stays until the operator
   drops it. An operator call with the same domain after 200 does not
   re-check and answers 200; a changed domain gets a new challenge.
   ACM's managed renewal depends on ACM's validation record, not on
   this one, and the re-check does not follow renewals.

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
   the domain's distribution tenant. A sweeper in the registrar, run
   every 15 minutes by EventBridge Scheduler, lists this distribution's
   dedicated distribution tenants and the registrar's certificates.
   One whose domain is no longer the `d` of the tenant it is tagged with
   is disabled if it is still enabled, deleted once it is disabled and
   deployed, and its certificate deleted after it. The sweeper finds
   what a crashed call left the same way. A changed domain is offline
   from the write until the new one validates. Before it touches a
   distribution tenant or a certificate, the registrar checks that its
   tags name this tenant and this distribution (409 otherwise), so a
   write for one tenant never removes another tenant's domain.

   On an ETag conflict, re-read the keys the write touches and repeat
   the step 3 operator checks, step 4 and the 507 size check (§4.1)
   before the next attempt. Two writers that race for one domain
   therefore cannot both pass, and an operator write that loses to a
   delete gets 409.
6. Log the caller role, key and outcome, never the body.

Deletes run steps 1, 2 and 6. A delete from the global hook role needs
the record missing or in `DELETING`, the status in which the control
plane runs a `PRE` hook on delete: 409 otherwise, so no global hook can
remove the route of a live cell or deployment. A missing record is
accepted so that cleanup works after the control plane has already
removed it (P-9 of the control plane: cleanup is always reachable). A
delete removes a `host#` key only when its `t` names the tenant, and
finds the tenant's dedicated `host#<d>` key from the `d` of its
`tenant#` entry. The edge operator role's deletes skip step 2: it may
remove any tenant or cell route, to clear one that a skipped delete
hook left behind (below). Status changes (`suspended`, `active`),
dedicated domains and `DeleteHostRoute`, which clears a `host#` key left
behind (§5.1), are vendor operations: only the edge account's operator
role may make them.

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

Besides the store, the registrar's role holds the CloudFront actions on
distribution tenants (`CreateDistributionTenant`,
`GetDistributionTenant`, `GetDistributionTenantByDomain`,
`ListDistributionTenants`, `UpdateDistributionTenant`,
`DeleteDistributionTenant`, with tagging on create) and, in `us-east-1`,
the ACM actions `RequestCertificate`, `DescribeCertificate`,
`ListCertificates`, `ListTagsForCertificate`, `AddTagsToCertificate` and
`DeleteCertificate`, the ACM writes conditioned on the registrar's tag.
Where IAM cannot narrow a CloudFront action to this distribution's
tenants, the registrar checks a distribution tenant's distribution and
tags before it changes it. It uses these actions only on the edge
operator role's domain calls, on deletes and replacements of an entry
that has a `d`, and in the sweeper. The stack's teardown custom resource
holds the same set (§6.2). While `dedicatedDomains` is off the registrar
role holds none of them and the sweeper and its schedules are not
deployed. The teardown custom resource holds them in both cases, so a
front door that once served a dedicated domain still tears down. The
domain challenge needs no IAM action: it is a DNS lookup.

The route hook (`hooks/route-hook.sh`) runs on the events of §3.2 with
the control plane's hook environment (control-plane R-42):

1. Read `/application-plane/applications/<APPLICATION_ID>/shared/front-door-hook`
   in the control plane's account. No such parameter: exit 0, because
   the application has no front door (ADR-0014). Any other read error
   fails the hook.
2. Take the ids from `CELL_ID` and `TENANT_ID`, and the display name
   from `TENANT_NAME`, never from `SCRIPT_OUTPUTS`. On a cell `POST`,
   read `frontDoorApiDomain` from `SCRIPT_OUTPUTS`. `TENANT_NAME` and
   the outputs are tenant-shaped data; the outputs are written by a
   script that in a tenant-owned account the tenant controls
   (control-plane R-43, T44). The hook finds a repeated key with a
   streaming parse (`jq --stream`, comparing the keys it emits with the
   object's own), because plain `jq` keeps the last value of a repeated
   key. An object with a repeated key, or no `frontDoorApiDomain`,
   fails the hook. It checks the value against the §3.4 step 3 origin
   form before sending, and the registrar checks it again (400). It
   builds every request body with `jq --arg`, and never `eval`s an
   input or splices one into a command line.
3. Call the registrar with `curl --aws-sigv4`, signed for
   `execute-api` with the hook role's credentials, which the hook reads
   from the CodeBuild container credential endpoint and never prints.
   They are temporary, so the request also carries the session token
   in `x-amz-security-token`. The key pair and that header reach curl
   through a config file (`-K`), mode 600 in a temporary directory,
   never as command-line arguments, which other processes in the
   container could read. Then wait for propagation as §4.2 says.
4. Act on the answer. 200 or 202: exit 0. 503, 429, another 5xx, or no
   answer: retry inside the build, five attempts with backoff over
   about two minutes, then fail; the control plane does not retry a
   create or update hook, so a hook that wants retries makes them
   itself (control-plane R-46). 400, 403, 409 or 507: fail at once,
   printing the status and the registrar's message. The cause is in the
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
(control-plane R-46). A 409 from `DeleteCellRoute` (a tenant route still
names the cell after a skipped deployment delete hook) and a 503 that
outlasts the retries end that way. The control plane's skip alarm tells
the operator, who removes the leftover route with the edge operator
role's `DeleteTenantRoute` or `DeleteCellRoute`. Until then a leftover
tenant route keeps its status and its old cell, whose hosts check
refuses the tenant once the delete script has removed its namespace. A
later `CreateDeployment` for the same tenant does not inherit it: the
new deployment's `createdAt` differs from the entry's `dt`, so the
hook's put replaces the entry, `s: active` and routed to the new cell
(step 5).

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
  4. On `/callback` the SPA first reads the query into memory and calls
     `history.replaceState` to drop it from the address, before any
     other fetch, `/config.json` included, so no later request carries
     the code or `state` in `Referer`. The assets the page itself loads
     still do, which is why the access log leaves out `cs(Referer)`
     (§3.1). The SPA then refuses the callback unless the `state`'s `n`
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
  that one client) stays out of scope: the domain challenge proves that
  the tenant controls the domain's DNS, which is why a code must not go
  there (ADR-0016, amended by ADR-0018).
- The `signin` key holds one or two keys of 32 random bytes, named by
  `kid` (§4.1). A custom resource of the front door stack generates them
  with a cryptographic random source for the ids in `signinKeys` (§3.6)
  and writes them to the store. It writes with the store's ETag
  (`IfMatch`) and re-reads and retries on a conflict, as the registrar
  does (§3.4 step 5), because both write the same store. The key is
  never in the template, a stack output, the custom resource's response
  `Data` or a log. KeyValueStore actions name the store, not a key, and
  a function has one store (ADR-0012). So the registrar role, the
  custom resource and any edge-account principal with
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
  on `/agents/*` is to refuse unknown and suspended tenants at the edge.
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
| `fleet` | yes | | The control plane's fleet name, which names its global hook role, `<fleet>-global-hook`, the one control-plane role the registrar admits |
| `issuer` | yes | | The SPA's client id and scopes, and the issuer's authorize, token and logout endpoints as `https` URLs, or a Cognito user-pool domain they are derived from (`/oauth2/authorize`, `/oauth2/token`, `/logout`). Validated at synth, with no network call (§7.1) |
| `signinKeys` | no | `{ids: ["k1"], current: "k1"}` | `host` mode only: `{ids: string[], current: string}`, the `kid`s the `signin` key holds and the one that signs. Synth checks that `ids` holds one or two unique ids, each matching `[a-z0-9]{1,8}`, and that `current` is one of them (§4.1) |
| `tenantClaim` | no | `tenant_id` | Claim the router and the origin read |
| `spaSource` | no | the demo SPA | Path of the built SPA |
| `agentIngress` | no | off | Agent ingress endpoint; omit to leave `/agents/*` off |
| `dedicatedDomains` | no | off | Lets the edge operator role set a tenant's `customDomain` (§3.4 step 5, ADR-0018). Off: any `customDomain` gets 400, and the registrar role holds no ACM or distribution-tenant action and runs no sweeper |
| `tenantRequestsPer5Min` | no | 2,000 | Per-tenant rate (ADR-0009) |
| `reportingEndpoint` | no | off | URL for CSP and other browser reports |

## 4. Data model

### 4.1 Route table (KeyValueStore)

| Key | Value (JSON, 1 KB max) | Written by |
|---|---|---|
| `tenant#<tenantId>` | `{"v":1,"c":"<cellId>","ac":"<accountId>","dt":<deployment createdAt, Unix ms>,"s":"active"\|"suspended","n":"<display name>","d":"<dedicated domain>","dk":"<challenge token>","dx":<challenge expiry, Unix s>}`, `d` and `dk` only for a tenant with a dedicated domain, `dx` only while its challenge is open | registrar, from the route hook on deployment create and update; `d` from the edge operator role (§3.4 step 3) |
| `host#<host>` | `{"v":1,"t":"<tenantId>","ac":"<accountId>"}` | registrar, in `host` mode and for a dedicated tenant's domain; only a pooled host's entry is a sign-in target (§3.3 step 2) |
| `cell#<cellId>` | `{"v":1,"ac":"<accountId>","o":"<api domain>"}` | registrar, from the route hook on cell create (`o` is write-once for it) and from the edge operator role (§3.4 step 3) |
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
  propagation (60 s, S-2), so every edge location can verify the new key
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
  step 5). No tenant input reaches it, and the router never reads it.
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
- Display name `n` is for display only, and the registrar never refuses
  any name the control plane accepts. A control-plane `TenantName` runs to
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
  507, and an alarm fires at 80 %.

### 4.2 Route status

| Status | Edge answer | Set by |
|---|---|---|
| (no entry) | 403 (`single`) or 404 (`host`) | tenant removal, or never registered |
| `active` | routed | the route hook's first write for a deployment of the tenant; afterwards only `UpdateTenantRouteStatus` (§3.4 step 5) |
| `suspended` | 503, `Retry-After: 300` | vendor operator in the edge account |

A change reaches an edge location within the store's propagation time:
about 30 s (spike S-2, measured at one location: median 28.4 s, p99 29.4 s,
max 29.5 s). The route hook bounds its wait at 45 s after the registrar
returns, so the operation does not end before its route is live. For
cell routes and every call in `single` mode it waits the full 45 s, a
bound and not a check: in `single` mode a route cannot be observed
without a tenant token, and a `cell#` route cannot be observed from
outside. In `host` mode a tenant route put polls
`https://<tenant>.<appDomain>/config.json` and returns on the first 200,
and a tenant route delete returns on the first 404. When none arrives within
45 s, it prints a warning and exits 0: the write succeeded and only
propagation is late. No unauthenticated probe path exists, because it
would reveal whether a tenant id exists.

`suspended` and a delete take effect after the same window. Until then the
tenant is still routed, and the cell's hosts check is the only refusal
(§3.5). Removal is a delete, not a status. A later `PutTenantRoute`, from
either role, keeps the stored status.

A tenant cannot lift its own suspension. The registrar admits no role a
cell account holds (§3.4), so a tenant-owned account can neither write
nor delete its route. Only the route hook writes it, on an operation
the vendor started. A hook's put to an existing entry keeps `suspended`,
and a hook's delete is accepted only while the control plane is
deleting the deployment (§3.4). The route starts `active` again only
when the vendor deletes the deployment and creates a new one, whose
`dt` differs, also when the delete hook was skipped (§3.4 step 5).

## 5. API surface

### 5.1 Route registrar

Modelled in Smithy; all operations `AWS_IAM`, all idempotent.

| Op | HTTP | Caller | Contract |
|---|---|---|---|
| `PutCellRoute` | `PUT /cells/{cellId}` | global hook role (route hook, cell create and update); edge operator role, for backfill and origin changes (§3.4) | Body `{apiDomain}`, from the cell script's `frontDoorApiDomain` output, or from the operator. A Lambda function URL host in the control plane's Region (400 otherwise). Account taken from the control plane, never the body. For the global hook role, 409 while the cell is neither `CREATING` nor `UPDATING`, and 409 when `cell#` holds another origin: the origin is write-once for it. Checks §3.4. 200 |
| `DeleteCellRoute` | `DELETE /cells/{cellId}` | global hook role (route hook, cell delete); edge operator role, to clear a route a skipped hook left | 409 while a tenant route names the cell, and for the global hook role while the cell is neither missing nor `DELETING` (§3.4). 200, also when absent |
| `PutTenantRoute` | `PUT /tenants/{tenantId}` | global hook role (route hook, deployment create and update); edge operator role to set `customDomain` | Body `{displayName, customDomain?}`. `displayName` is stored as §4.1 says. The entry records the deployment's `createdAt` as `dt`. A new `tenant#` entry gets `s: active`; a write to an existing entry keeps its `s`, from either role, and only `UpdateTenantRouteStatus` changes it. A hook put whose deployment `createdAt` differs from the stored `dt` replaces the entry as a new one (§3.4 step 5). Only the edge operator role may send `customDomain`, and only while `dedicatedDomains` is on (400 otherwise); the global hook role that sends it gets 403, and its call without it keeps the stored domain. The operator's call sets the domain, or drops it when `customDomain` is absent. A new domain is one host name of at most 64 characters with no wildcard, outside `appDomain` and held by no other tenant. The call writes it as `d` on `tenant#` first, with a domain challenge for this tenant and domain, and answers 202 with `stage: "domain-challenge"` and the TXT record to publish, `_tfd-challenge.<d>` `tfd-verify=<token>`, valid for 7 days. A repeat resolves that record: until it holds this tenant's token the call answers 202 again, with `challenge: "missing"` or `"mismatch"`, and an expired challenge gets a new token. Once it passes, the call requests the domain's ACM certificate in `us-east-1`, which validates by DNS once the tenant publishes ACM's validation record, and answers 202 with `stage: "certificate"` and that record until then; a repeat finds the certificate and creates nothing twice (ADR-0018). Once the certificate has validated, the call creates the dedicated distribution tenant and writes the domain's `host#` key, which routes requests and records its owner (`t`, `ac`), and answers 200. A failed or timed-out validation gets 422. A changed or dropped domain removes the old `host#<d>` at once and its distribution tenant and certificate in two phases (§3.4 steps 3 to 5). The domain is never a sign-in target: its users sign in on `signInHost` (§3.5). Cell taken from the control plane, never the body. Checks §3.4. 200, or 202 while the challenge or the certificate is pending |
| `DeleteTenantRoute` | `DELETE /tenants/{tenantId}` | global hook role (route hook, deployment delete); edge operator role, to clear a route a skipped hook left | Removes the `tenant#` key, the pooled host's `host#` key and the `host#<d>` key its `d` names, each `host#` key only when its `t` names the tenant (§3.4). It disables the distribution tenant of that `d`, and the sweeper deletes it and its certificate, each only when its tags name this tenant (§3.4 step 5). For the global hook role, 409 while the deployment is neither missing nor `DELETING`. 200, also when absent |
| `DeleteHostRoute` | `DELETE /hosts/{host}` | edge operator role | Removes one `host#` key whatever its `t` and `ac`, and the `d` of the tenant it names when `d` is that host, to clear a key left behind. That domain's distribution tenant and certificate then go in two phases (§3.4 step 5). 200, also when absent |
| `UpdateTenantRouteStatus` | `PUT /tenants/{tenantId}/status` | edge operator role | Body `{status}` |

Errors: 400 for a malformed id or domain, an `apiDomain` that is not a
Lambda function URL host in the control plane's Region, an empty
display name, a `customDomain` that is not one host name of at most 64
characters without a wildcard, or that equals `appDomain` or ends in
`.<appDomain>`, and any `customDomain` while `dedicatedDomains` is off;
403
from API Gateway for any principal the resource policy does not admit,
and from the registrar when the placement record is missing or belongs
to another application (the message names neither the real account nor
the real cell), or a role other than the edge operator role sends
`customDomain`; 409 for a global hook role write whose record is not in
the status of its operation (§3.4), a global hook role `PutCellRoute`
that would change a cell's origin, a missing cell route, a cell still
in use, an operator domain change with no tenant route or for another
deployment (`dt`), a `customDomain` whose `host#` entry names another
tenant, one another tenant holds pending (a registrar certificate for
it tagged with that tenant), one CloudFront already serves (`CNAMEAlreadyExists`), or a
distribution tenant or certificate tagged for another tenant (the
message names no tenant); 422 when the dedicated domain's certificate
failed validation or timed out (a domain challenge never fails: it
expires and is issued again); 507
when a write would exceed the route table's 5 MB (ADR-0012); 503 when
the control plane cannot be read (the write is refused, never made
unchecked).

### 5.2 Script and construct forms

- **`hooks/route-hook.sh`**, the route hook (§3.4), driven by the control
  plane's hook variables (`APPLICATION_ID`, `EVENT`, `PHASE`, `CELL_ID`,
  `TENANT_ID`, `TENANT_NAME`, `SCRIPT_OUTPUTS`; control-plane R-42) and
  the registrar URL from the front door hook parameter in the control
  plane's account. It signs with the global hook role's credentials
  through `curl --aws-sigv4`, with the session token in
  `x-amz-security-token` and every credential in a `-K` config file,
  parses the outputs with `jq --stream` and
  builds bodies with `jq --arg` (§3.4).
- **`scripts/register-hooks.sh [--delete]`**, run by an operator with an
  operator token: puts `front-door-post` and `front-door-pre` with
  `PutHook` (control-plane R-39), each with this sample's repository as
  `source`, pinned to a full commit SHA, and
  `samples/tenant-front-door/hooks/route-hook.sh` as `script`. The two
  hooks serve every front door on the control plane, and take two of
  its five global hook slots. One pin serves them all, so moving it
  changes the hook for every front door at once: the hook-to-registrar
  API stays backward compatible across sample versions (a new hook works
  with an older registrar and the reverse), or every front door on the
  control plane upgrades together. `--delete` removes them with
  `DeleteHook`.
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
| 403 | unknown tenant (`single`); in `host` mode, `/api/*` or `/agents/*` with a `tenant_id` other than the host's tenant (§3.3 step 5); or a cross-site call to `/api/*`, `/agents/*` or `/signin-state` |
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
  sign-out URL (ADR-0016). A dedicated domain adds no URL in either
  mode: its users sign in on `signInHost`, which in `single` mode is
  `<appDomain>` (§3.5).
- A control plane whose `GetCell` and `GetDeployment` return `accountId`,
  `applicationId` and `status`, with a reader role enabled (control-plane R-36), and
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
  account, this front door's `RouteHookAccess` stack, with its policy
  listed in the control plane's `globalHookManagedPolicyArns`, which
  takes only customer-managed policies in the control plane's own
  account. The registrar admits no role in a cell account (§3.4).
- Cell scripts of the application that write `frontDoorApiDomain` to
  `OUTPUTS_FILE` on create and update (§5.2). Cells that existed before
  the front door's hooks get their routes by the operator's backfill
  (§3.4).
- In `host` mode, the edge account's read boundary for the `signin` key.
  The registrar role, the custom resource and any edge-account principal
  with `cloudfront-keyvaluestore:GetKey` or `ListKeys` on the route
  table, or `cloudfront:UpdateFunction` or `cloudfront:TestFunction` on
  the router, can read the key. The integration test role is one: it
  calls `TestFunction` and signs a test `state` with the live key (§10
  step 18). It is also a writer of the store: it holds
  `cloudfront-keyvaluestore:PutKey` and `DeleteKey` to write and remove
  the step 2 fixture, which would let it replace the `signin` key or
  any route. The deployer scopes that role to the test run, creating it
  for the run and removing it after. The registrar code never reads
  `signin` or `app`. The deployer keeps those actions off every other
  role in the edge account: KeyValueStore has no resource policy, so
  the stack cannot (§3.5).
- A cell API that verifies the token in `x-tenant-token`, refuses a
  `tenant_id` that differs from `x-tenant-route` (compared
  case-insensitively), refuses tenants its cell does not host, and in
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
  reaches an origin, once the route change has propagated (§4.2).
- A request reaches only the cell its route names.
- No role a cell account holds can write or delete a route. The route
  hook writes routes on the vendor's operations, each naming the cell and
  account the control plane placed it in.
- A tenant cannot lift its own suspension (§4.2).
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
- An ordered teardown leaves nothing behind. Two pieces live outside
  CloudFormation in the control plane's account (the two global hooks
  and the `globalHookManagedPolicyArns` entry), so `cdk destroy` alone
  is not the teardown. In order: (1) delete the application's
  deployments, then its cells, through the control plane, whose
  `front-door-pre` hooks remove their routes; (2) run
  `register-hooks.sh --delete` when this is the last front door on the
  control plane; (3) take the `RouteHookAccess` policy out of
  `globalHookManagedPolicyArns` and update the control plane; (4)
  destroy `RouteHookAccess`; (5) destroy the front door stacks. Out of
  order, every create and update of the application fails after the
  hook's retries, every delete waits through three hook attempts and
  raises the skip alarm, and `RouteHookAccess` cannot be deleted while
  its policy is attached (IAM `DeleteConflict`). In step 5 a custom
  resource on the distribution, run before the distribution's delete,
  disables and deletes every dedicated distribution tenant on it and
  then their certificates, polling until each disable has deployed (the
  CDK provider framework's `isComplete`), because CloudFront cannot
  delete a distribution that still has distribution tenants. The README
  states the same order.

### 6.3 Samples consumed

| Sample | How | Needed for |
|---|---|---|
| `control-plane` | its API (`GetCell`, `GetDeployment`) with the reader grant (R-36) and a client-credentials reader token (spike S-9 showed both are needed: a `role` trigger on the vendor IdP and the `vendorIdp.clientIds` input of R-38, ADR-0043), its global hooks (R-39 to R-46, control-plane ADR-0044): `PutHook`, the `<fleet>-global-hook` role and `globalHookManagedPolicyArns`, the hook environment and `SCRIPT_OUTPUTS`. A prerequisite: without hooks the front door registers no route, and ADR-0044 is still Proposed (Q-5) | placement checks, route registration, the integration test |
| `tenant-identity` `shared-pool` | its published parameters | the demo issuer and the integration test |
| `agentic-runtime-isolation` | its `/application-plane/shared/agent-runtime/ingress` parameter | `/agents/*`, optional |

### 6.4 Published interface

- **Constructs** `TenantFrontDoor`, `CellRouteAccess` and `RouteHookAccess`
  (`src/index.ts`).
  `TenantFrontDoor` exposes `distributionId`, `distributionArn`,
  `routeTableArn`, `registrarUrl`, `appDomain`, `addressing` and
  `pooledTenantId` (the distribution tenant).
- **Published parameter** `/application-plane/shared/front-door/edge` in
  the edge account, one JSON document: `version`, `appDomain`,
  `addressing`, `applicationId`, `distributionArn`, `registrarUrl`,
  `tenantClaim`, `reservedLabels`. A cell stack in another account cannot
  read it, so the application's shared stack in each cell account copies
  `distributionArn`, which `CellRouteAccess` needs, to
  `/application-plane/applications/<applicationId>/shared/front-door`
  (control-plane §6.2). The `RouteHookAccess` stack writes
  `/application-plane/applications/<applicationId>/shared/front-door-hook`
  in the control plane's account, with `registrarUrl`, for the route
  hook (§3.1). The names differ, so a control-plane account that also
  hosts cells, as in the integration test, holds both.

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
- In `host` mode, after the code exchange, a token whose `tenant_id` is
  not `/config.json`'s tenant is discarded and the user signed out
  before any `/api/*` or `/agents/*` call (§3.5).
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
| [ADR-0013](../adr/0013-register-routes-through-a-registrar-that-checks-the-control-plane.md) | Register routes through a registrar that checks the control plane, called from the cell's account. Accepted; ADR-0017 supersedes it once control-plane ADR-0044 is accepted | registrar with a placement check; a cross-account role that writes the store directly; the control plane writes routes |
| [ADR-0014](../adr/0014-run-one-front-door-per-control-plane-application.md) | One front door per control-plane application | one per application; one shared front door keyed by application |
| [ADR-0015](../adr/0015-read-the-control-plane-with-a-reader-token.md) | Read the control plane with a reader token | reader role (control-plane ADR-0042); operator app client; an IAM-authorised read stage |
| [ADR-0016](../adr/0016-sign-in-through-one-shared-host-in-host-mode.md) | Sign in and out through one shared host in `host` mode | shared sign-in host with a signed `state`; a callback URL per tenant; a wildcard callback URL |
| [ADR-0017](../adr/0017-register-routes-from-a-control-plane-global-hook.md) | Proposed. Register routes from a control-plane global hook; the registrar admits no cell account role, still checks the control plane, and takes a cell's origin once | provisioning role in the cell account calls the registrar; tombstones and operator-only rules; the control plane writes the store directly; a global hook calls the registrar |
| [ADR-0018](../adr/0018-prove-a-dedicated-domain-with-a-per-tenant-dns-challenge.md) | Keep dedicated domains in the sample, off unless `dedicatedDomains` is on; route one only after a TXT record holds a token the registrar issued for the tenant and domain, resolved by the function's default resolver and re-checked daily | validated ACM certificate only; TXT record with a registrar-issued per-tenant token; HTTP file challenge on the domain; operator attestation only |

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
| S-8 | Can an API Gateway resource policy admit a role name in any account through `aws:PrincipalArn`, and does the request context give the caller's account? | a provisioning role in the second account reaches the registrar; a role of another name is refused. **Passed 2026-11-13** with one design fix: the second account's provisioning role got 200 with `identity.accountId` and `userArn` in the request context; another role name got 403. The edge account's own admin also got 200 through its identity policy, so the resource policy adds an explicit `Deny` with `ArnNotLike` (§3.4, ADR-0013). Deploy 75 s, destroy 33 s. The result holds for the principal ADR-0017 admits instead, the control plane's `<fleet>-global-hook` role: one role ARN, matched by the same cross-account `aws:PrincipalArn` condition and guarded by the same `Deny` |
| S-9 | Does a client-credentials token from the registrar's own vendor IdP client pass the control plane authorizer (single `audience`, required `sub` and `role`)? | `GetCell` returns 200 with that token, the token's `role` is the reader value, and a write returns 403. **Failed 2026-11-13; fallback proven**: the token has no `aud` (`sub` equals `client_id`), and the audience check denies it. A V3 trigger on the Essentials plan adds `role: control-plane:reader` but its `aud` override is ignored. With a `client_id` allow-list in place of the audience check, the same token is allowed with the reader grant (ADR-0015, §6.1). Deploy 36 s per phase, destroy 61 s |
| S-10 | What does the registrar's Lambda function, outside a VPC, see from its default resolver for a challenge record (ADR-0018)? | the resolver it uses is reported; a TXT record published under a fresh name is seen on the first lookup; after a lookup that found no record, the time until a newly published record is seen is measured against the zone's negative-caching TTL; after a value change, the time until the new value is seen is measured against the record's TTL; a record split into several strings is read whole. Each figure is the delay an operator meets between publishing and a passing repeat (§3.4 step 5) |

## 10. Integration test outline

Runs in `eu-central-1`, with the edge stacks in `us-east-1` (ADR-0010),
in two accounts: the edge account, which also hosts the control plane and
cell A, and a second account registered tenant-owned, hosting cell B. It
reuses the `tenant-identity` shared pool, and reuses a `control-plane`
deployment when one is found, deploying one otherwise (Q-2). It needs a
public hosted zone for a test domain (Q-1), with `appDomain` a name
below the zone's apex, so that a second name in the zone,
`TFD_DEDICATED_DOMAIN`, lies outside `appDomain` for step 14.
`test/integ.single.ts` covers the default mode; `test/integ.host.ts` repeats the steps marked (host) with
`addressing: 'host'`.

Expected time, from S-1: deploying the edge stacks and the distribution
takes about 481 s and destroying them about 312 s, before the control plane
and the cells the test also deploys, and each cell or deployment event
runs one route hook build. The route changes of steps 2, 13, 16 and 20
to 22, and the deletes of step 23, go through the route hook, which
waits its 45 s bound (§4.2) before the operation ends. Step 20 adds one
probe build per event, and step 22 waits through two skipped delete
hooks, each three attempts 60 s and 120 s apart, about 4 minutes each.
The step 2 fixture and the suspensions of steps 13 and 22 are writes
the test makes without the hook, so after each the test waits 60 s for
propagation (ADR-0003, spike S-2) before its next call. The rotation check after
the list is a separate run with its own time. The dedicated-domain
checks (steps 3, 11 and 18) use a fixture `host#` entry and
`cloudfront:TestFunction`, so they deploy no distribution tenant and no
certificate. Step 14 runs the domain challenge against the real
`TFD_DEDICATED_DOMAIN`: it requests one certificate, creates no
distribution tenant, and adds two waits of a little over 60 s for the
TXT record's TTL. The control plane shares the edge account here, so the
route hook's call is a same-account call; spike S-8 covered the
cross-account form of the same `aws:PrincipalArn` match. The
identity-side grant that `RouteHookAccess` gives the hook role, which
only a cross-account call needs, is not exercised here.

1. Deploy the front door, with `dedicatedDomains` on (§3.6). In the
   control plane's account deploy its
   `RouteHookAccess` stack, add the stack's policy to the control plane's
   `globalHookManagedPolicyArns` and update the control plane, then run
   `register-hooks.sh`: `ListHooks` names `front-door-post` and
   `front-door-pre`. Register the demo application, whose cell scripts
   write `frontDoorApiDomain` to `OUTPUTS_FILE`.
2. Create tenant `a` (placed in the edge account) and tenant `b` (pinned to
   the second account). The route hook registers each cell and tenant
   route after its script, and every cell and deployment reaches
   `ACTIVE` with `front-door-post` in its `lastGlobalHooks`.
   The test role then writes one fixture straight to the route table,
   the only write that bypasses the registrar (P-3):
   `host#dedicated-a.example.com` naming `a`, with the edge account as
   `ac`, a dedicated domain with no DNS, certificate or distribution
   tenant. It writes with the store's ETag, as every other writer does,
   then waits 60 s, or polls `cloudfront:TestFunction` until
   `/config.json` for that host answers 200, before step 3.
3. `/` serves the SPA with every §7.1 header. In `single` mode
   `/signin-state` returns 404, and `/logout` returns 302 to the
   issuer's logout endpoint with `client_id` and
   `logout_uri=https://<appDomain>/`, with `Clear-Site-Data:
   "storage", "cache"` (§7.1). Through `cloudfront:TestFunction` with
   `Host: dedicated-a.example.com`, `/config.json` names `signInHost`
   `<appDomain>`.
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
    for `b`, its own tenant, and for `a`: 403 for both, from the resource
    policy, and `a` is still routed to cell A. Its call for `b` with
    `customDomain` `dedicated-b.example.com` gets 403 too, and no `host#`
    key is written. The edge operator role calls
    `PutTenantRoute` for `b` with `customDomain` `a.<appDomain>`: 400,
    and in `host` mode `a.<appDomain>` still routes to cell A. With
    `customDomain` `dedicated-a.example.com`, `a`'s dedicated domain
    from step 2: 409, and the fixture still names `a`.
12. The second account's cell provisioning role calls `DeleteCellRoute`
    for cell B, its own cell, and for cell A: 403 for both.
    An edge-account principal that is not the operator role, with
    `execute-api:Invoke` in its identity policy, calls the registrar: 403
    (the explicit `Deny`, §3.4).
13. Suspend `b`: after 60 s, `b`'s token returns 503, `a` is still served.
    The second account's tenant provisioning role then calls
    `DeleteTenantRoute` and `PutTenantRoute` for `b`: 403 for both, and
    `b`'s entry is unchanged. `UpdateDeployment` for `b` through the
    control plane runs `front-door-post`, which puts `b`'s route again;
    the deployment reaches `ACTIVE`, and after 60 s `b`'s token still
    returns 503.
14. Domain challenge (ADR-0018), in `test/integ.single.ts` only.
    `<dd>` is `TFD_DEDICATED_DOMAIN`, for example
    `dedicated-c.test.example.com` when `appDomain` is
    `app.test.example.com`. The test writes TXT records at
    `_tfd-challenge.<dd>` with a 60 s TTL, and writes each value before
    the registrar first looks the name up, so no negative answer is
    cached (spike S-10). The edge operator role calls `PutTenantRoute`
    for `a` with `customDomain` `<dd>`: 202 with `stage`
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
    for `b`, so no distribution tenant is created. It drops `<dd>` from
    `b` and deletes the TXT records; the sweeper deletes the
    certificate, which step 23's leftover check confirms. A former
    holder whose challenge had passed differs only by a certificate
    the sweeper deletes before the domain is free, so the test does
    not build one.
15. Wait 60 s for log delivery (33 s in S-1). Per-tenant counts name
    `a` and `b`, queried in `us-east-1` where the log group is
    (ADR-0010), from `viewer-request-log-data` in both modes (§3.1); in
    `host` mode `x-host-header` agrees with it, and an `/assets/*` load
    on `a.<appDomain>` names `a` (host). Requests to
    `login.<appDomain>` leave the field empty (host). The registrar's API access
    log, in `eu-central-1`, names the second account on the refused
    calls of steps 11 to 13, and the registrar log names the global hook
    role on the writes of steps 2, 13 and 16.
16. Delete `b`'s deployment: `front-door-pre` removes `b`'s route before
    the delete script runs, and once the deployment is gone `b`'s token
    returns 403, because its entry is gone.
17. (host) `a.<appDomain>/config.json` names `a`; an unregistered host
    returns 404; `a.<appDomain>/api/whoami` with no token returns 401
    with `WWW-Authenticate: Bearer`; a token for `a` on
    `b.<appDomain>/api/whoami` returns 403 from the edge, with no origin
    log line in cell B;
    `a` over its rate gets 429 while `b` is served.
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
22. A skipped delete hook. Create tenant `c` in cell A and suspend it;
    after 60 s its token gets 503. The test points the front door hook
    parameter's `registrarUrl` at a path the registrar does not serve,
    which API Gateway refuses with 403, and deletes `c`'s deployment:
    `front-door-pre` fails three times and is skipped, the control
    plane counts the skip, the deployment is deleted, and `c`'s entry
    stays `suspended`. The test restores the parameter and creates `c`'s
    deployment again: its `createdAt` differs from the entry's `dt`, so
    `front-door-post` writes a new entry, and `c`'s token is served by
    cell A. The test breaks the parameter again and deletes `c`'s
    deployment, which skips the hook again; the edge operator role's
    `DeleteTenantRoute` for `c` answers 200, and after 60 s `c`'s token
    gets 403. The test restores the parameter.
23. Remove the step 2 fixture key. Tear down in the §6.2 order: delete
    the deployments and cells of both applications through the control
    plane, whose `front-door-pre` hook removes their routes; run
    `register-hooks.sh --delete` when no other front door uses the
    control plane; take the `RouteHookAccess` policy out of
    `globalHookManagedPolicyArns` and update the control plane; destroy
    `RouteHookAccess`; then destroy everything else the test deployed,
    in both accounts, except the shared identity pool. The leftover
    check also finds no registrar certificate for `<dd>` (step 14).

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
| Q-3 | Does the dedicated tenant (custom domain) path belong in this sample or in a follow-up, and how does the vendor confirm that a tenant controls a domain before the edge operator role sets its `customDomain`? A validated certificate is not enough: ACM reuses one validation record per domain name per account, so it proves the edge account's record is in DNS, not which tenant published it, and a former holder's record keeps validating. **Answered 2026-11-18** (ADR-0018): the path stays in this sample, off unless the deployer turns on `dedicatedDomains` (§3.6). The registrar issues a 32-byte random token bound to the tenant and the domain, kept as `dk` with a 7-day expiry `dx` on the `tenant#` entry (§4.1), and answers 202 with `_tfd-challenge.<domain>` TXT `tfd-verify=<token>`. A repeat resolves the record with the Lambda function's default resolver and requests the certificate only when it holds this tenant's token (§3.4 step 5). The sweeper re-checks routed domains daily and alarms; the operator drops a domain that changed owner. Spike S-10 measures the resolver | scope |
| Q-4 | Should the integration test also compose `agentic-runtime-isolation` for `/agents/*`, or reuse a deployment only when one is found? | integration test |
| Q-5 | Route registration depends on the control plane's global hooks (control-plane R-39 to R-46, ADR-0044), which are Proposed and not yet merged. Does their final shape keep what ADR-0017 uses: `POST` hooks only after a successful script, `PRE` delete hooks with three attempts that cannot stop a delete, one `<fleet>-global-hook` role, `SCRIPT_OUTPUTS` and `globalHookManagedPolicyArns`? If not, ADR-0017 is revisited. ADR-0017 stays Proposed and ADR-0013 Accepted until ADR-0044 is accepted, and the control-plane hooks branch merges before this one | build start |
| Q-6 | With hooks, an integration test that reuses a control plane (Q-2) also changes it: it attaches a policy to `<fleet>-global-hook` and registers two global hooks, which then run on every application's operations, and a third, `tfd-probe`, while step 20 runs. The test therefore needs three of the five global hook slots free. Is that acceptable on a shared control plane, or does the test always deploy its own? | integration test |

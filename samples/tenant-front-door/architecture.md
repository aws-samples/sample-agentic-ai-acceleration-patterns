<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant Front Door: Architecture

> **Status: implemented; integration test green in `host` mode.** The
> integration test ([`integration-test.md`](integration-test.md)) passed in
> `host` mode; `single` mode has not run live.
>
> | Field | Value |
> |---|---|
> | Last green integration run | 2026-11-21, `host` mode, two accounts (103 checks passed, 0 failed, 3 skipped; 64 minutes with the teardown; leftover check 0 found) |
> | Region | `eu-west-1` for the control plane and the cells, `us-east-1` for the edge stacks, `eu-central-1` for the `tenant-identity` shared pool |
> | Mode and steps passed | `host`: steps 1, 2, 3, 4, 11, 15, 17, 18, 23 and 24 |
> | Not exercised live | `single` mode and its steps (5 to 10, 12 to 14, 16, 19 to 22), and the `single`-mode parts of steps 3, 15 and 23 (including the streamed call to the stand-in); unit tests cover their logic (the threat model's Mitigations table names them). In `host` mode, the inline callback script order (SPA build tests cover it), the CSP check of the callback in a browser, and a real sign-in through the issuer (both left to a manual check) |
> | Code the green run may not have covered | The registrar's control-plane read retry (spec §3.4 step 2) and the route table ETag-conflict handling are in the code at the date of this block; whether the 2026-11-21 run's build held them cannot be told from the history, so they count as not exercised live. Unit tests cover them (`test/registrar/control-plane.test.ts`, `test/registrar/route-store.test.ts`) |
> | Driver code the green run did not cover | The 0700 run directory, moving a reused run id's `state.env` aside, the wording of one skip in step 18, and the check of the sign-in host's log lines, which runs at the end of step 18. Only the driver's stub tests cover them; run `npx projen integ:host` after changing the driver |
> | End-to-end demo | 2026-11-21, against a kept `host` mode deployment: three runs of `scripts/demo.sh` passed (137 s, 153 s and 199 s) |
> | Unit tests | 43 suites, 1,318 tests passed, and eslint clean (the test and eslint steps of `npx projen build`, 2026-11-23) |
> | Scans | ProtoShield 2026-11-22 on the sample, and ASH 2026-11-21 on the files the threat model's "Security review" lists; neither has been rerun on the code at the date of this block |

This document describes what is built. The design is in
[`design/tenant-front-door.spec.md`](design/tenant-front-door.spec.md), the
decisions in [`adr/`](adr/README.md), and the threats in
[`threat-model.md`](threat-model.md).

## 1. Purpose

One web address, or one address per tenant, for a multi-tenant agentic
application, in front of every cell the control plane placed. A single
Amazon CloudFront multi-tenant distribution in one edge account serves the
shared single-page application (SPA), routes every `/api/*` request to the
cell that hosts the request's tenant, in whichever registered account that
cell lives, and sends `/agents/*` to the agent ingress. A CloudFront
Function, the tenant router, finds the tenant and looks it up in a
CloudFront KeyValueStore, the route table (ADR-0002, ADR-0003). A route
registrar is the only writer of routes (the `tenant#`, `host#` and `cell#`
entries), and it is called by a vendor route hook that the control plane
runs on its own cell and deployment operations (ADR-0017). The stack's
custom resources write the `app` and `signin` entries (section 6 below).

The sample is not an identity provider, not the authoriser (the cell
verifies the token), and not tenant onboarding or placement (the control
plane does those).

## 2. Actors and identity

| Actor | Identity | Reaches |
|---|---|---|
| Tenant user | Access token from an issuer that meets the token contract (`ARCHITECTURE.md` §2.1) | The SPA, `/api/*`, `/agents/*` through the edge |
| Control plane's route hook | Role `<fleet>-global-hook` in the control plane's account | The registrar's cell and tenant route calls |
| Edge operator | A role in the edge account that the deployer names in `edgeOperatorRoleArn` | The registrar's vendor-only calls: suspend and resume, dedicated domain, backfill, origin change, clearing leftovers |
| Registrar | Its own Lambda role in the edge account, and a reader token from the vendor IdP | The route table, ACM, CloudFront, and the control plane's read operations |
| Cell API | The cell's own function | Verifies the token; checks the route hint and its own tenants |

The tenant is a claim the issuer signs (`tenant_id` by default; the
`tenantClaim` input names another). The router reads it without checking
the signature, only to choose a route. The cell verifies the signature and
refuses a claim that differs from the route hint or names a tenant its cell
does not host (P-1, P-4, ADR-0005). No role a cell account holds can write a
route.

## 3. Components

The [components diagram](diagrams/tenant-front-door.components.drawio.svg)
shows the parts and the pattern each carries, and the [architecture
diagram](diagrams/tenant-front-door.drawio.svg) shows the AWS resources,
the request path and the route registration path. Both are embedded in the
README's [Architecture](README.md#architecture) section.

Four stacks, deployed in this order (ADR-0010, ADR-0027):

| Stack | Account and Region | Holds |
|---|---|---|
| `<prefix>-edge` | edge, `us-east-1` | ACM certificate for `<appDomain>` (and `*.<appDomain>` in `host` mode); the CloudFront-scope web ACL with its rate rules |
| `<prefix>-main` | edge, the control plane's Region | The multi-tenant distribution and its pooled distribution tenant, the router, the KeyValueStore, the response headers policy, the SPA bucket, the registrar (API Gateway REST API and Lambda), the custom resources, the published parameter; with `dedicatedDomains` on, the sweeper |
| `<prefix>-edge-logging` | edge, `us-east-1` | Standard logging v2: the log group, delivery source, delivery destination and delivery |
| `<prefix>-route-hook-access` | the control plane's account and Region | The front door hook parameter and the hook policy (`RouteHookAccess`); added when the `registrarUrl` input is set |

`<prefix>` is the `stackNamePrefix` input, `TenantFrontDoor` by default in
the sample app (`src/main.ts`). A cell's own stack uses `CellRouteAccess`,
in the cell's account; given no `distributionArn`, it reads the ARN from a
plain-string copy in that account (ADR-0011, ADR-0026).

| Component | Runs on | Source |
|---|---|---|
| Tenant router | CloudFront Function, viewer request, JS 2.0 | [`src/router/router.js`](src/router/router.js) |
| Route table | CloudFront KeyValueStore, 5 MB | [`src/shared/route-table.ts`](src/shared/route-table.ts) |
| Route registrar | API Gateway (`AWS_IAM`, stage `v1`) and Lambda on Node.js 24 | [`src/registrar/`](src/registrar/), model in [`model/routes.smithy`](model/routes.smithy) |
| Sweeper | Lambda run by EventBridge Scheduler, only with `dedicatedDomains` | [`src/sweeper/`](src/sweeper/) |
| Route hook | CodeBuild, the control plane's global hook project | [`hooks/route-hook.sh`](hooks/route-hook.sh) |
| Hook registration | The operator's shell | [`scripts/register-hooks.sh`](scripts/register-hooks.sh) |
| `RouteHookAccess` | IAM and SSM Parameter Store | [`src/hooks/route-hook-access.cdk.ts`](src/hooks/route-hook-access.cdk.ts) |
| `CellRouteAccess` | Lambda permissions | [`src/demo-cell/cell-route-access.cdk.ts`](src/demo-cell/cell-route-access.cdk.ts) |
| Demo cell API and demo SPA | Lambda function URL; static files | [`src/demo-cell/`](src/demo-cell/), [`spa/`](spa/) |

## 4. Request paths

The router runs on every viewer request. Its steps carry the numbers of
spec §3.3, which the ADRs and the threat model cite:

1. Removes every client `x-tenant-*` header.
2. Lower-cases the host. On `host` mode's sign-in host it answers the
   sign-in redirects (section 7 below). It looks up the host in the route
   table when the mode is `host` or the host is a dedicated domain; no
   entry gives 404.
3. Answers 404 for any `/agents` path that is not
   `/agents/<backend>/invocations` (ADR-0019).
4. Checks `Sec-Fetch-Site` on `/api/*`, `/agents/*` and, in `host` mode,
   `/signin-state`: `same-origin`, `none` or no header pass; anything else
   gets 403.
5. Finds the tenant. On `/api/*` and `/agents/*` it decodes the bearer
   token's claim without checking the signature (ADR-0005): no token, an
   undecodable one or a `tenants` list gets 401, and in `host` mode a claim
   other than the host's tenant gets 403. `/config.json` and `/signin-state`
   take the host's tenant. An `Authorization` header over 8,192 bytes gets
   401 on every path that needs a tenant.
6. Reads `tenant#<id>`: no entry gives 403, `suspended` gives 503 with
   `Retry-After: 300`.
7. For `/api/*`, reads the tenant's `cell#` entry (none gives 503), sets
   the origin to the cell's API with origin access control, and sets
   `x-tenant-token` and `x-tenant-route` (ADR-0004, ADR-0011). For
   `/agents/*`, sets `x-tenant-route`, strips the leading `/agents`, and
   leaves the origin at the agent ingress, with no `cell#` read and no
   token header.
8. Serves `/config.json` and `/logout` at the edge (ADR-0006), and
   `/signin-state` in `host` mode only (`single` mode: 404). Rewrites
   other SPA paths to `/index.html`.

| Path | Origin | Cached |
|---|---|---|
| `/assets/*` | SPA bucket | one year, immutable |
| `/`, SPA routes | SPA bucket | revalidated |
| `/config.json`, `/logout`, `/signin-state` | generated at the edge | no |
| `/api/*` | the tenant's cell API | no |
| `/agents/*` | the agent ingress, streamed | no |

The edge adds one field to the access log, `viewer-request-log-data`,
holding the tenant the router routed on (section 10 below).

## 5. Route registration

A route is written when the control plane runs a cell or deployment
operation:

| Control-plane event | Hook, phase | Registrar call |
|---|---|---|
| `CELL_CREATE`, `CELL_UPDATE` | `front-door-post`, `POST` | `PutCellRoute` with the cell script's `frontDoorApiDomain` |
| `DEPLOYMENT_CREATE`, `DEPLOYMENT_UPDATE` | `front-door-post`, `POST` | `PutTenantRoute` |
| `DEPLOYMENT_DELETE` | `front-door-pre`, `PRE` | `DeleteTenantRoute` |
| `CELL_DELETE` | `front-door-pre`, `PRE` | `DeleteCellRoute` |

The hook reads the front door hook parameter for its application. No
parameter means no front door, and the hook exits 0 (ADR-0014). Otherwise
it signs the call with the hook role's credentials. The registrar then:

1. Admits only the hook role and the edge operator role (a resource policy
   with an explicit deny for every other principal).
2. Reads the cell or deployment from the control plane with a reader token,
   and takes the cell and account from that record, never from the body. A
   read that times out, fails on the network or gets a 5xx is tried once
   more inside a 10 s budget; a read that still fails refuses the write with
   503 (spec §3.4 step 2).
3. Refuses (403) a record that is missing or belongs to another
   application, and, for the hook role, refuses (409) a record that has no
   matching operation in flight.
4. Accepts a cell's origin only in the form
   `<32 characters>.lambda-url.<Region>.on.aws`, and only once for the hook
   role.
5. Writes the route table with the store's ETag, retrying on a conflict,
   and republishes the `RouteTableBytes` metric (ADR-0003, ADR-0031).

A route usually reaches every request at the edge 30 to 60 seconds after
the write. The hook waits at most 45 seconds for it, and in `host` mode
polls the tenant's `/config.json`; past 45 seconds it warns and exits 0, so
the wait is a bound, not a guarantee (AR-7). `UpdateTenantRouteStatus` (the
edge operator) sets `active` or `suspended` without reading the control
plane (ADR-0025). A hook write never changes a stored status.

### Registrar API

The registrar is modelled in [`model/routes.smithy`](model/routes.smithy);
every operation uses `AWS_IAM` and is idempotent.

| Operation | HTTP | Caller |
|---|---|---|
| `PutCellRoute` | `PUT /cells/{cellId}` | hook role, edge operator role |
| `DeleteCellRoute` | `DELETE /cells/{cellId}` | hook role, edge operator role |
| `PutTenantRoute` | `PUT /tenants/{tenantId}` | hook role; edge operator role to set `customDomain` |
| `DeleteTenantRoute` | `DELETE /tenants/{tenantId}` | hook role, edge operator role |
| `UpdateTenantRouteStatus` | `PUT /tenants/{tenantId}/status` | edge operator role |
| `DeleteHostRoute` | `DELETE /hosts/{host}` | edge operator role |

`PutTenantRoute` with a `customDomain` answers 202 while the domain
challenge or the certificate is pending (section 8 below). The errors are
400 (a malformed input), 403 (a principal or record the registrar does not
admit), 409 (a write that does not match the record's state), 422 (a failed
certificate validation), 429 (the stage throttle, or `certificate-quota`),
503 (the control plane cannot be read, or the store's ETag still conflicts)
and 507 (the route table is full). Spec §5.1 says which operation gets
which, and gives the error shapes.

## 6. Data model

The route table holds five kinds of key, each value at most 1 KB of JSON:

| Key | Holds | Written by |
|---|---|---|
| `tenant#<tenantId>` | `c` cell, `ac` account, `dt` deployment creation time, `s` status, `n` display name; `d`, `dk`, `dx` for a dedicated domain | Registrar |
| `host#<host>` | `t` tenant, `ac` account; pooled hosts in `host` mode and dedicated domains | Registrar |
| `cell#<cellId>` | `ac` account, `o` API domain | Registrar |
| `app` | The issuer's public settings | The main stack |
| `signin` | The signing keys for the sign-in `state`, `host` mode only | A custom resource |

Tenant ids are lower-cased in every key. The ceiling is 16,949 pooled
tenants in `single` mode and 8,583 in `host` mode (80 % of 5 MB), and the
registrar answers 507 past 5 MB (ADR-0012). Dedicated domains use the
remaining headroom and ACM's certificate quota (spec §4.1).

## 7. Sign-in

The SPA signs in with the authorization code flow and PKCE and keeps tokens
in memory (ADR-0007). In `single` mode the callback is `https://<appDomain>/`.
In `host` mode the one callback is `https://login.<appDomain>/callback`. The
router mints an HMAC-signed `state` that names the tenant host and a
nonce, and the sign-in host forwards the code only to a registered pooled
host (ADR-0016). A dedicated domain never receives a code: its SPA sends the
user to `signInHost`.

A user in several tenants holds a token with a `tenants` list. The SPA
narrows it to one tenant through the issuer's RFC 8693 exchange before any
`/api/*` call, at the issuer's token endpoint or at `exchangeEndpoint`.

## 8. Dedicated domains

With `dedicatedDomains` on, the edge operator can set a tenant's own domain.
The registrar issues a DNS challenge (a TXT record at
`_tfd-challenge.<domain>` holding a token for that tenant and domain),
requests an ACM certificate in `us-east-1` once the challenge passes, and
creates a distribution tenant once the certificate validates (ADR-0018).
The sweeper deletes removed domains' distribution tenants and certificates
every 15 minutes, and re-checks every passed challenge daily (ADR-0020,
ADR-0022). The state of the re-check is in the sweeper's own DynamoDB table.
Five alarms cover the sweeper: three misses, `unverifiable`, queue depth,
missing pages and no lister.

## 9. Web baseline

One response headers policy on every behaviour sets a hash-based CSP with
Trusted Types, HSTS, `X-Frame-Options: DENY`, `nosniff`, a referrer policy,
Cross-Origin-Opener and Resource policies, and a permissions policy
(ADR-0008, ADR-0023). The SPA is built with content-hashed assets and an
import map with `integrity` for every chunk. The SPA bucket admits the
distribution only, and denies object writes to every principal except the two
deployment roles.

## 10. Observability and costs

- **Tenant in the telemetry.** The access log's `viewer-request-log-data`
  field names the tenant the router routed on, in both modes. It is the
  claimed tenant, so it serves operations and cost estimates; a billing-grade
  count comes from the cell's own log of verified requests. The log delivery
  leaves out the query string, the referrer and the cookie.
- **Registrar.** The registrar logs one structured line per call with the
  caller role, the key and the outcome, never a body or a token, and
  publishes `RouteTableBytes` per distribution. An alarm fires at 80 % of
  the store.
- **Rate limits.** In `host` mode two WAF rate rules (per client address and
  host, then per host) count each tenant host's `/api/*` and `/agents/*`
  requests. In `single` mode the cell limits each verified tenant
  (ADR-0009, ADR-0021).
- **Cost attribution.** A dedicated domain's certificate and distribution
  tenant carry the cost allocation tag `TenantId` (the tenant id in the
  control plane's upper-case form). Pooled tenants share one distribution
  tenant, one web ACL and the SPA bucket, so their cost is attributed from
  the access log: a tenant's request count times the CloudFront and AWS
  WAF per-request prices, plus its bytes out times the per-GB data
  transfer price. The fixed parts (the registrar, the route table, the
  logging delivery, the web ACL rules) are not attributable per tenant;
  the vendor splits them by each tenant's share of requests, or equally.

## 11. Deployment and teardown

The deploy has two steps for one app, because the registrar's URL exists only
after the main stack is deployed and a stack in another account cannot read
it (ADR-0027). The README's [Deploy](README.md#deploy) section gives the
commands. Teardown runs in the order of spec §6.2, because three pieces
live outside the front door stacks, in the control plane's account: the two
global hooks, the `globalHookManagedPolicyArns` entry, and the retained hook
parameter. A custom resource on the distribution disables and deletes the
dedicated distribution tenants and ACM certificates before the distribution
goes.

## 12. Known gaps

The accepted risks are `AR-n` in [`threat-model.md`](threat-model.md), and
the README lists the limits and shortcuts under "Known limitations".

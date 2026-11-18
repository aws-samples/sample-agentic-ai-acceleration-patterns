<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant Front Door: Threat Model

> Status: **Design stage; nothing is built.** Written from
> [`design/tenant-front-door.spec.md`](./design/tenant-front-door.spec.md)
> (P-1 to P-9, §3 to §7, §10, §11),
> [`design/spikes.md`](./design/spikes.md) and
> [ADR-0001](./adr/0001-default-to-one-url-with-the-tenant-from-the-token.md)
> to ADR-0022 ([index](./adr/README.md)). Enumerated STRIDE per trust
> boundary. 60 threats (T-1 to T-60), 43 mitigations (M-1 to M-43), 28
> accepted risks (AR-1 to AR-28).
>
> Every mitigation points at the specification section and the ADR that
> decide it. The build has not started, so there are no code or cdk-nag
> locations yet. They are added to the Where column of each mitigation
> when the build lands, together with the test that checks it. "Planned
> check" names a step of the integration test in spec §10.

Registration of routes is described as
[ADR-0017](./adr/0017-register-routes-from-a-control-plane-global-hook.md)
decides it: the control plane's global hooks write each route. ADR-0017 is
Proposed. It depends on control-plane ADR-0044, which is also Proposed
(spec Q-5). T-33 and AR-2 say what applies if the hooks do not land.

Scope: the `TenantFrontDoor`, `CellRouteAccess` and `RouteHookAccess`
constructs and what they deploy: the edge stack, the main stack and the
edge logging stack (ADR-0010); the multi-tenant distribution, the tenant
router and its route table (a CloudFront KeyValueStore); the route
registrar; the sweeper with its table, queue and schedules; the custom
resources (the `signin` key, the starter, the guard and the teardown); the
route hook and `register-hooks.sh`; and the integration test's own roles.
The demo cell API and the demo SPA appear only as the reference for the
contract a cell API and a SPA must meet (spec §6.1, §7.2).

Out of scope: how the issuer authenticates users and narrows tokens
([tenant-identity](../tenant-identity/threat-model.md)); what the control
plane does with its own API, accounts and hooks
([control-plane](../control-plane/threat-model.md)), except where the front
door relies on it; what the agent ingress does behind its public endpoint
([agentic-runtime-isolation](../agentic-runtime-isolation/threat-model.md));
what a cell does with a verified request; the internals of CloudFront, AWS
WAF, ACM, KeyValueStore and Route 53 (AWS shared responsibility); and the
security of a tenant's own DNS provider.

Terms: the **edge account** holds the front door. A **cell** is the
application's deployment unit, in a vendor-owned account or in a
tenant-owned one. The **registrar** is the only writer of the route table.
The **edge operator role** is the vendor's own role that makes the
vendor-only registrar calls. The **global hook role** is
`<fleet>-global-hook` in the control plane's account.

## Actors

| Actor | Trust | What they hold |
|---|---|---|
| Tenant user | authenticated, one tenant | an access token with `tenant_id`, signed by the issuer |
| Multi-tenant user | authenticated, several tenants | a token with a `tenants` list and a refresh token, which the SPA keeps in memory and exchanges for a one-tenant token (§3.5) |
| Malicious tenant user | authenticated | a valid token for tenant A and the will to reach tenant B's cell, host or data |
| Internet caller | none | forged, expired or missing tokens, any `Host`, any path, load |
| Tenant that owns an account | controls its account | its cell and the function URL's resource policy; its provisioning role pair; the outputs its cell script writes; the DNS of its own domain (ADR-0013, ADR-0017) |
| Domain holder, current or former | controls DNS for one domain | TXT records at any name in its zone, including leftover ones; ACM validation records of earlier certificates |
| Edge operator | administrative, vendor | the edge operator role: suspend and resume, `customDomain`, backfill, origin changes, clearing leftovers (§3.4) |
| Control plane operator | administrative, vendor | the control plane API: creates tenants, cells and deployments, places them in accounts, registers hooks (control-plane ADR-0015) |
| Other global hook | vendor code, same role | `<fleet>-global-hook`, shared by every global hook (control-plane R-41) |
| Other principal in the edge account | outside the construct | identity policies that may allow `execute-api:Invoke`, KeyValueStore actions, `cloudfront:UpdateFunction`, log reads |
| Deployer | administrative | instantiates the constructs; brings the edge operator role; owns the issuer, the zone, the quotas and the alarm channel |
| Issuer | trusted for `tenant_id` | signs every tenant token; hosts the authorize, token, logout and exchange endpoints (`ARCHITECTURE.md` §2.1) |
| Compromised function code | caller-influenced | the registrar, the sweeper, the router or a custom resource, with its role |
| Script in the page | caller-influenced | whatever runs in the SPA's origin, including an injected script |
| Integration runner | test account only | the test role and the operator role the test creates for the run (§10) |

## Assets

| Asset | Why it matters |
|---|---|
| Route table (`tenant#`, `host#`, `cell#`) | Decides which cell serves each tenant and which tenants are live or suspended (P-3) |
| `signin` key (`host` mode) | Mints `state` values for any registered tenant host while it is live (§3.5) |
| `app` entry | Names the issuer endpoints and client the SPA signs in with (§4.1) |
| Tenant access token and refresh token | The only source of tenant identity at the cell; the refresh token lasts a day in `tenant-identity` (§3.5) |
| Authorization code and `state` | Redeem a token for whoever holds the PKCE verifier; the code is in a URL (§3.5) |
| Reader token and client secret | Read placement and display names from the control plane (ADR-0015) |
| Global hook role session | Calls the registrar; shared by every global hook (§3.4) |
| Edge operator role | Makes every vendor-only route change (§3.4) |
| Domain challenge token (`dk`) | Proves one tenant controls one domain; public by design (ADR-0018) |
| Certificates and distribution tenants for dedicated domains | Serve a tenant's own domain under the vendor's edge (ADR-0002) |
| Sweeper table | The streaks that raise the domain alarms (ADR-0020) |
| Access log, registrar log, sweeper log | Name the tenant of every routed request, and the tenant and domain on an alarm (§3.1) |
| `/config.json` | Public settings; names the tenant and display name on a tenant host (§3.2) |
| Quotas: 5 MB store, 2,500 ACM certificates, WAF counts | One tenant or one client must not use up what the others share (ADR-0012, ADR-0009) |

## Trust boundaries

| Boundary | Crossed by | Authenticated and authorised by |
|---|---|---|
| B1 Viewer → edge | any HTTPS request: `Host`, path, headers, bearer token | WAF rate rules (M-27), the router (M-1, M-3, M-4, M-29), the response headers policy (M-30) |
| B2 Edge → cell API origin | the routed `/api/*` request, in the cell's account | origin access control and the Lambda permission (M-5), the cell's own checks (M-2) |
| B3 Edge → agent ingress | the routed `/agents/*` request | the path filter (M-34), the ingress's own token check (M-35) |
| B4 Writers → route table | registrar calls from the global hook role or the edge operator role; the registrar's store writes; anyone with store actions | resource policy and explicit `Deny` (M-6), the registrar's checks (M-7 to M-11), the store boundary (M-36) |
| B5 Registrar and route hook ↔ control plane | reader-token reads; `SCRIPT_OUTPUTS` from a cell script; the hook's environment | reader grant (M-14), outputs handling (M-12), hook semantics (M-13) |
| B6 Issuer ↔ sign-in host ↔ tenant host | authorize redirect, code and `state`, sign-out | signed `state` (M-19, M-20), the SPA's nonce and PKCE (M-32), pooled hosts only (M-22) |
| B7 Tenant DNS ↔ registrar and sweeper; registrar → ACM and CloudFront | TXT lookups, certificate requests, distribution tenants | the per-tenant challenge (M-23), the daily re-check (M-24), two-phase removal (M-25) |
| B8 Browser page ↔ SPA ↔ issuer and exchange endpoint | script, tokens in memory, calls to the token and exchange endpoints | CSP and Trusted Types (M-31), token handling (M-32), `connect-src` fixed at deploy time |
| B9 Everything → telemetry and public reads | access log, registrar and sweeper logs, `/config.json`, alarms | closed log field list (M-21), public reads kept minimal (M-37), telemetry labelled (M-38) |
| B10 Sweeper ↔ its table, queue and schedule | DynamoDB items, an asynchronous invocation per page | the sweeper role alone (M-16), a date that must match today (M-26) |
| B11 Integration runner → edge account | the test role and the test operator role | created for the run and removed after (M-39) |
| B12 Deployer and operator setup | `RouteHookAccess`, `globalHookManagedPolicyArns`, `register-hooks.sh`, the operator role, teardown | ordered setup and teardown (M-41), pinned hook source (M-41), build gates (M-40) |

## Threats

STRIDE per boundary: S spoofing, T tampering, R repudiation, I information
disclosure, D denial of service, E elevation of privilege. Status values:
**Mitigated**; **Accepted** (an accepted risk, AR-n); **Open** (waits for a
spec §11 question, and the build gate M-40 holds the dependent code).

| ID | B | STRIDE | Threat and consequence | Status | Mitigations |
|---|---|---|---|---|---|
| T-1 | B1 | S | In `single` mode a caller edits a token's payload to name tenant B, or sends an unsigned token. The router routes on the claim without checking it. Served as B if any cell trusted the claim | Mitigated: the router grants nothing; the cell refuses a bad signature. A forged request costs one origin invocation (AR-8) | M-1, M-2 |
| T-2 | B1 | S | A client sets `x-tenant-route`, `x-tenant-token` or another `x-tenant-*` header to steer the route or hand the cell a different token | Mitigated | M-3, M-2 |
| T-3 | B1 | I, E | In `host` mode a user with a valid token for tenant A calls tenant B's host. The token would reach B's cell, which can sit in an account B owns, and B could keep it | Mitigated | M-4, M-2 |
| T-4 | B1 | I | A caller learns that a tenant exists or is suspended. A forged claim for a known id gets 403 when unregistered and 503 when suspended; in `host` mode an unknown host gets 404 | Accepted (AR-11) | M-37 |
| T-5 | B1 | D | In `single` mode WAF cannot read the token, so there is no edge rate rule. Forged claims naming a live tenant reach its cell | Accepted (AR-8) | M-28, M-1 |
| T-6 | B1 | D | In `host` mode an anonymous client sends tokenless requests to one tenant host. WAF counts them before the router refuses them, so the tenant's own users get 429. Many addresses, or one shared office address, change the picture | Mitigated for one address; residual AR-9 | M-27 |
| T-7 | B1 | D | Floods of unknown hosts or tenants, and hostile input to the router (a very large token, long paths) | Refused at the edge, no origin reached; cost and unmeasured large-token behaviour accepted (AR-9, AR-27) | M-1, M-27 |
| T-8 | B1 | T, E | A page on another site, or another tenant's host in `host` mode, makes a request to `/api/*`, `/agents/*` or `/signin-state` from the user's browser | Mitigated; residual AR-13 | M-29, M-32 |
| T-9 | B1 | I | A response made for one tenant is cached and served to another, most likely in `single` mode where every tenant shares one host | Mitigated | M-33 |
| T-10 | B1 | E | A suspension or a route delete takes about 30 s to reach every edge location. Until then the tenant is still routed | Accepted (AR-7) | M-2, M-13 |
| T-11 | B2 | E | A caller reaches a cell's function URL without the edge, skipping the suspension check, the rate rule and the header baseline. Or `CellRouteAccess` is set loosely so another distribution passes | Mitigated | M-5 |
| T-12 | B2 | I | A valid token reaches a cell that does not host its tenant: a wrong or stale `cell#` route, an operator backfill error, a wrong placement (T-28). If the account belongs to someone else, that party sees a live bearer token | Mitigated for the refusal. The cell still receives the token (AR-4) | M-2, M-8, M-4 |
| T-13 | B2 | E | A cell API does not verify the token, ignores the hint or skips the hosts check, so a forged token or a token for another tenant is served | Contract only; the front door cannot enforce it (AR-26) | M-2 |
| T-14 | B2 | T | A cell in a tenant-owned account answers with hostile content, or with headers that weaken the baseline | Mitigated for headers and rendering; the content stays the cell owner's (AR-4) | M-30, M-31 |
| T-15 | B3 | E | A caller sends a request straight to the agent ingress, a public endpoint. It checks the token and picks the tenant, but it does not see the route table, so a suspended tenant's tokens still work | Accepted (AR-3) | M-35 |
| T-16 | B3 | E | A caller reaches other routes of the ingress through the edge (`/invocations`, `/<backend>/delegations`, `/.well-known/*`, `/entitlements/*`) with encodings, extra slashes, case or `..` | Mitigated. The real ingress behind the filter is tested only through a stand-in (Q-4) | M-34 |
| T-17 | B4 | E | A tenant that owns an account calls the registrar with the provisioning roles it controls: write, delete or re-create any route, its own included (lift its suspension, point its route at another cell) | Mitigated by ADR-0017; AR-2 applies if the hooks do not land | M-6, M-7, M-9 |
| T-18 | B4 | E | Another principal in the edge account, whose identity policy allows `execute-api:Invoke`, calls the registrar. A same-account call needs only one of the two policies (spike S-8) | Mitigated | M-6 |
| T-19 | B4 | T, I, E | A principal in the edge account with KeyValueStore actions writes any route, or reads the `signin` key, with no registrar in the way. The store has no resource policy and its actions name the store, not a key | Accepted; the deployer's boundary (AR-6) | M-36 |
| T-20 | B4 | E | Every global hook runs as one role, so admission proves only that some vendor global hook is calling. Another global hook can set a new cell's origin before `front-door-post` does, or put a tenant route during that tenant's create or update | Mitigated to a failed operation; residual AR-1 | M-7, M-8, M-9, M-10 |
| T-21 | B4 | T | A cell's origin points at the wrong host: the cell script in a tenant-owned account chooses its own cell's origin, a hook sets it, or an operator backfill names a wrong host | Mitigated | M-8, M-17 |
| T-22 | B4 | E | A tenant bypasses its own suspension: (a) by re-writing its route through the registrar, (b) through another global hook, (c) by serving from its own account, (d) by calling the agent ingress directly | (a) and (b) Mitigated. (c) AR-4. (d) AR-3. AR-2 applies if the hooks do not land | M-6, M-7, M-9 |
| T-23 | B4 | E | A stolen or misused edge operator role sets origins, suspends and resumes tenants, sets domains and clears routes | Accepted (AR-20) | M-17, M-18, M-23 |
| T-24 | B4 | T | Concurrent writers overwrite each other's entry: hook retries, an operator call, the `signin` custom resource | Mitigated | M-15 |
| T-25 | B4 | E | Compromised code in a function of the stack. The registrar is the route table's one writer, so its compromise is control of routing. IAM cannot narrow some CloudFront actions to this distribution's tenants, so the code checks tags first | Accepted (AR-19) | M-16, M-36 |
| T-26 | B4 | R | Nobody can say which actor changed a route: every global hook shares one role, and the operator role shows as a role name | Mitigated; residual AR-1 | M-18 |
| T-27 | B5 | I | A stolen reader token, or the app client's secret in the edge account. It reads placement, tenant names and the source locations of applications and hooks | Accepted (AR-22) | M-14 |
| T-28 | B5 | I | The control plane places a tenant in another customer's tenant-owned account (control-plane T27). The route follows the placement, so the tenant's traffic and tokens go there | Accepted (AR-5) | M-7 |
| T-29 | B5 | T | A cell script in a tenant-owned account writes outputs that steer the hook: a repeated key, a missing key, shell metacharacters, an oversized value | Mitigated | M-12, M-8 |
| T-30 | B5 | I | The hook's credentials leak: build logs, the process list, other processes in the build container | Mitigated; residual AR-1 | M-12 |
| T-31 | B5 | D, T | The control plane cannot be read, so registrar writes are refused and creates fail. A delete hook fails three times and is skipped, which leaves a route | Mitigated; residual AR-23 | M-13, M-14, M-9 |
| T-32 | B5 | T | The control plane's `GetDeployment` has no `createdAt` or no stated format (Q-7). The registrar cannot tell a repeat from a new deployment, so a repeat might reset `suspended` to `active`, or a new deployment might inherit a stale entry | Open (Q-7, issue 55) | M-9, M-40 |
| T-33 | B5 | E | The control plane's global hooks do not land, or change shape (Q-5). Cell accounts' provisioning roles are then admitted again, and the gap of ADR-0013 returns: a tenant-owned account can rewrite its own route | Open (Q-5); AR-2 | M-40 |
| T-34 | B6 | S | A `state` is forged, or the `signin` key leaks, so the sign-in host forwards a code to a tenant host of the attacker's choosing | Mitigated | M-19, M-20 |
| T-35 | B6 | S | A `state` is replayed, or a code is stolen from a URL and redeemed | Mitigated | M-19, M-32 |
| T-36 | B6 | I | Authorization codes or `state` land in a log, a referrer or the browser history | Mitigated | M-21, M-32 |
| T-37 | B6 | I, S | A code is sent to a dedicated domain, where the tenant runs the server. The tenant starts its own authorize request, sends the link to a signed-in user of the shared pool and redeems the code | Mitigated | M-22, M-19 |
| T-38 | B6 | T | Sign-out is triggered cross-site, and the code the issuer sends after sign-out has no PKCE challenge, so `client_id` and `redirect_uri` redeem it | Accepted (AR-16) | M-42, M-21 |
| T-39 | B6 | S | A `Host` variant (case, an extra label, a reserved label, the apex, a dedicated domain) reaches the sign-in host's forwarding or makes the router mint a `state` for a host that is not a pooled tenant host | Mitigated | M-19, M-11 |
| T-40 | B7 | S | A tenant is routed on a domain it does not control: a former holder's ACM validation record still validates, a second tenant's certificate request validates from the first's record, a leftover TXT record is taken for proof | Mitigated | M-23, M-11 |
| T-41 | B7 | E | A routed domain changes owner. The old tenant stays routed, so the new owner's visitors reach another tenant's app on their domain, under the vendor's certificate | Accepted (AR-14) | M-24 |
| T-42 | B7 | S, D | The DNS check is fooled or blinded: a CNAME left pointing into a zone anyone can register, a stale or negative answer, one vantage point without DNSSEC, or a holder who breaks only `_tfd-challenge.<d>` so that every lookup errors | Mitigated; residual AR-15 | M-23, M-24 |
| T-43 | B7 | D, T | Two tenants, or two operator calls, race for one domain. Both pass the pending-claim check, one gets the distribution tenant, the other keeps a pending `d` | Mitigated; residual AR-28 | M-23, M-15 |
| T-44 | B7 | D | Dedicated distribution tenants and certificates are orphaned by a dropped domain, a crashed call, a switched-off `dedicatedDomains` or a stack delete. A distribution with distribution tenants cannot be deleted | Mitigated | M-25 |
| T-45 | B7 | D | The shared response headers policy serves tenants' own domains. HSTS with `includeSubDomains` would force HTTPS on every subdomain of a tenant's apex for a year | Mitigated; the `appDomain` side is a deployer step (AR-17) | M-30 |
| T-46 | B8 | E, I | Script runs in the page (an injected script, a dependency, agent output rendered as HTML, an attacker-chosen `error_description`) and uses the access token, or the longer-lived refresh token | Mitigated; residual AR-12 | M-31, M-32 |
| T-47 | B8 | I | A token is written to `localStorage`, `sessionStorage`, a cookie or the URL, and outlives a sign-out or a tenant switch | Mitigated | M-32 |
| T-48 | B8 | S, T | In `host` mode another tenant's host is `same-site`: it can toss a cookie or call this host's endpoints. In `single` mode every tenant shares storage and service workers | Mitigated; residual AR-17 | M-29, M-32 |
| T-49 | B8 | T, S | Someone who can write `app` or a `tenant#` entry changes what `/config.json` says, and sends the user's sign-in to an attacker's authorize endpoint | Mitigated for token exfiltration; the redirect itself falls under AR-6 | M-36, M-31 |
| T-50 | B8 | I | The exchange API answers cross-origin with `*` or any `Origin`, so any site can read its answers (Q-8). Until the API has an allowed-origins input, the demo issuer's exchange does not work from the SPA at all | Open (Q-8, issue 56) | M-31, M-40 |
| T-51 | B9 | I | `/config.json` is unauthenticated. On a tenant host or dedicated domain it confirms the tenant and shows its display name and `rev`, the create time of its current deployment | Accepted (AR-11) | M-37 |
| T-52 | B9 | R, T | The tenant field in the access log is the claimed tenant. A forged claim, or a flood against a public host, counts against the tenant it names. A billing or alarm decision rests on a field an attacker chose | Accepted (AR-10) | M-38 |
| T-53 | B9 | I | Log readers see traffic metadata: host, path, tenant, edge location, status, bytes, and each request to the sign-in host | Accepted (AR-6) | M-21, M-36 |
| T-54 | B9 | R | An alarm fires and nobody answers: its notification is not checked by the sample | Accepted (AR-25) | M-24 |
| T-55 | B10 | T | Someone invokes the sweeper with a crafted input (a chosen day, another list of tenant ids), or edits the sweeper table to hold back an alarm | Mitigated | M-26, M-16 |
| T-56 | B10 | D | Detection is down: a page fails, the resolver has an outage, the table is lost, or the schedule never ran | Mitigated; residual AR-14 | M-24, M-26 |
| T-57 | B11 | E | The test role writes the route table (so it can replace the `signin` key or any route), reads the `signin` key, edits the sweeper table, and invokes the sweeper. It stays behind if a run stops early | Accepted (AR-24) | M-39 |
| T-58 | B12 | D | The route hook runs for every application on the control plane. A wrong `RouteHookAccess` policy, a missing parameter read, or a teardown out of order fails the creates and updates of every application, and delays every delete by three attempts | Mitigated; residual AR-21 | M-41 |
| T-59 | B12 | T, E | The hook's source is poisoned, or its pin is moved: code runs in the control plane's account as the global hook role, for every front door on that control plane | Mitigated; residual AR-21 | M-41 |
| T-60 | B12 | D | The route table or ACM runs out: 5 MB store, 2,500 certificates, 5,000 certificate requests in 365 days. A tenant create or a domain set then fails | Mitigated; residual AR-18 | M-43 |

## Mitigations

Each row names the specification section and the ADR that decide it. The
**Where** column also takes the code, test and cdk-nag locations when the
build lands. "Planned check" is a step of the integration test in spec §10.
Items marked "deployer action" go on the sample README's production
hardening checklist (standard §7).

| ID | Mitigation | Where | Threats |
|---|---|---|---|
| M-1 | The router reads the tenant and never trusts it. It decodes the token payload with no signature check, holds no verification key, and grants nothing (P-1). It refuses a request with no tenant, an unknown tenant or a suspended tenant at the edge, before any origin (P-7). In `host` mode it holds only the `signin` key | Spec P-1, P-7, §3.3 steps 4 to 6, 8; ADR-0001, ADR-0005; spike S-7. Planned check: steps 5, 6, 7 | T-1, T-5, T-7 |
| M-2 | The cell is the authoriser. It verifies the token it reads from `x-tenant-token`, refuses a `tenant_id` that differs from `x-tenant-route` (compared case-insensitively), and refuses a tenant its own namespace does not hold, building the path from the verified claim. A refusal is logged with both ids | Spec P-4, §3.5 (the bullet on the cell API), §6.1; ADR-0005, ADR-0011. Planned check: step 7 (forged signature); the hosts check and the hint check are unit-tested in the demo cell API | T-1, T-2, T-3, T-10, T-12, T-13 |
| M-3 | Every client `x-tenant-*` header is removed first. The router sets `x-tenant-route`, and copies the bearer into `x-tenant-token` after the strip. The `/api/*` origin request policy forwards exactly four headers, so no other client header reaches the cell. No cookie is forwarded | Spec P-2, P-3, §3.2, §3.3 steps 1 and 7; ADR-0005, ADR-0011. Planned check: step 8 | T-2 |
| M-4 | In `host` mode the router decodes the bearer's `tenant_id` on `/api/*` and `/agents/*` and refuses with 403 a claim that names another tenant than the host's. A token for one tenant never leaves the edge toward another tenant's cell. The cell repeats the check on the verified claim | Spec P-2, P-4, §3.3 step 5, §3.5; ADR-0005. Planned check: step 17 | T-3, T-12 |
| M-5 | Origin access control signs every origin request. `CellRouteAccess` grants `cloudfront.amazonaws.com` `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the cell's function, conditioned on the one distribution's ARN, with no shared secret. The construct requires the ARN as a prop | Spec §3.1, §3.2, §5.2, §6.1; ADR-0011; spike S-3. Planned check: step 10 | T-11 |
| M-6 | Registrar admission: a resource policy that admits two principals by `aws:PrincipalArn` (the global hook role and the edge operator role), and an explicit `Deny` with `ArnNotLike` for every other principal. No role of a cell account is admitted, the provisioning role pair included. Admission grants no route | Spec P-5, §3.4 (opening paragraphs); ADR-0017, ADR-0013 (the `Deny`); spike S-8. Planned check: steps 11, 12 | T-17, T-18, T-22 |
| M-7 | Placement has one source: the registrar reads the control plane on every write, takes the cell and account from the record and never from the body, and applies its own `applicationId`. It refuses with 403 a missing record or one of another application. A hook put needs the record in `CREATING` or `UPDATING`, a hook delete needs `DELETING` or missing. It never writes without the read (503) | Spec P-5, P-6, §3.4 steps 1 to 3; ADR-0014, ADR-0015, ADR-0017. Planned check: step 20 | T-17, T-20, T-22, T-28 |
| M-8 | A cell's origin has one form and one writer. It must be `<32 [a-z0-9]>.lambda-url.<control plane Region>.on.aws`. The global hook role writes it once and gets 409 on a different value; only the edge operator role changes it. A tenant route needs a cell route that has the same account as the deployment. A cell stays out of `ACTIVE` until its own hook put succeeds, and placement uses only `ACTIVE` cells | Spec §3.4 steps 3 and 4, §5.1; ADR-0017; control-plane §7.1. Planned check: step 20 | T-12, T-20, T-21, T-29 |
| M-9 | The registrar owns status and replacement. A new `tenant#` entry is `active`; any later write from either role keeps `s`; only `UpdateTenantRouteStatus`, which only the edge operator role may call, changes it. A hook delete is accepted only while the record is `DELETING` or gone. `dt` (the deployment's `createdAt`) tells a retry from a new deployment, which replaces a leftover entry as a new one | Spec P-5, §3.4 steps 3 and 5, §4.1, §4.2, §5.1; ADR-0017. Planned check: steps 13, 20, 22 | T-17, T-20, T-22, T-31, T-32 |
| M-10 | The display name `n` comes from the control plane's `GetTenant`, never from a hook. The registrar replaces control characters, `"` and `\`, and cuts it to 64 bytes, so no stored character needs escaping | Spec §3.4 step 2, §4.1; ADR-0017 | T-20 |
| M-11 | Host and domain rules in every route write: only the edge operator role may send `customDomain`, and only while `dedicatedDomains` is on; one lower-case host of at most 64 characters, no wildcard; never `appDomain` or `*.<appDomain>`; reserved labels (`www`, `api`, `admin`, `auth`, `login`, `static`, `status`) refused; 409 on a host or a pending claim another tenant holds | Spec §3.4 steps 3 and 4, §4.1, §5.1; ADR-0013, ADR-0016, ADR-0018. Planned check: step 11 | T-39, T-40 |
| M-12 | The route hook handles input as untrusted. Ids come from `CELL_ID` and `TENANT_ID`, never from `SCRIPT_OUTPUTS`. It finds a repeated key with a streaming parse, rejects a missing `frontDoorApiDomain`, checks the origin form before sending (the registrar checks it again), builds bodies with `jq --arg`, and never `eval`s. Credentials reach `curl --aws-sigv4` through a mode-600 `-K` file, not the command line, and are never printed | Spec §3.4 (route hook steps 1 to 3), §5.2; ADR-0017; control-plane R-43 | T-29, T-30 |
| M-13 | Hook failure semantics keep the table honest. A failing `POST` hook fails the create or update, so `ACTIVE` means routed. The delete hook runs `PRE`, before the delete script, so the route goes while the record still exists. A delete hook that fails three times is skipped and counted by the control plane. The hook waits 45 s for propagation after a write | Spec §3.4 (route hook step 4 and the paragraphs after it), §4.2; ADR-0017, ADR-0003; control-plane R-45, R-46. Planned check: steps 16, 21, 22 | T-10, T-31 |
| M-14 | The registrar reads the control plane with a reader token only: its own app client, whose `role` is a namespaced entry of the control plane's `readerRoles`, the client id in `vendorIdp.clientIds`, and `requiredScope` set when the client can call another API. The secret lives in Secrets Manager in the edge account. The token is cached until it expires. A failed read refuses the write | Spec §3.6, §6.1, §3.4 step 2; ADR-0015; spike S-9; control-plane R-36, R-38. Deployer action: rotate the secret | T-27, T-31 |
| M-15 | Store writes are optimistic. Every write uses the store's ETag (`IfMatch`); on a conflict the registrar re-reads the keys, repeats the checks of steps 3 and 4 and the size check, and retries. A write that rests on a DNS answer is retried only if the entry still holds the same `d` and `dk`. The `signin` custom resource does the same | Spec §3.4 step 5 (end), §3.5; ADR-0003 | T-24, T-43 |
| M-16 | Roles are split and narrow. The registrar never deletes a distribution tenant or certificate, and holds no ACM or CloudFront domain action while `dedicatedDomains` is off. The sweeper cannot write routes: it holds read actions on the store, not `PutKey`. Only the sweeper role holds the sweeper table, and its ACM delete is conditioned on the registrar's tag, as are the registrar's ACM writes. Where IAM cannot narrow an action, the code checks the tenant's distribution and tags first (409) | Spec §3.4 (IAM paragraphs), §3.1; ADR-0018, ADR-0020, ADR-0022 | T-25, T-55 |
| M-17 | The edge operator role is the vendor's own and the stack does not create it. It sits behind the vendor's sign-in and multi-factor rule, and no role a cell account, a tenant or the hook role can assume reaches it. The registrar's own checks apply to it too: form of the origin, the `GetCell` read, the domain rules and the challenge | Spec §3.4 (operator role paragraph), §3.6; ADR-0017. Deployer action: MFA, short sessions, review of who can assume it | T-21, T-23 |
| M-18 | Audit: the registrar logs the caller role, key and outcome, never the body (step 6). The API access log names the calling account, the edge account or the control plane's, on the refused calls. CloudTrail records each operator call under the role's name. The hook role's calls say "some global hook" (AR-1) | Spec §3.4 step 6, §10 step 15; ADR-0017 | T-23, T-26 |
| M-19 | The `state` is `base64url(payload).base64url(HMAC-SHA256)` with the `signin` key named by `kid`, an `exp` 10 minutes out, the tenant host `h` that minted it, and the SPA's nonce `n`. The sign-in host forwards only when the HMAC and `kid` verify, `h` is a pooled host, `host#<h>` exists and its tenant is `active`. The router mints a `state` only on a pooled host. An expired or nonce-less `state` gets 302 to `https://<h>/` with no code. Everything else is 400 | Spec §3.3 step 2, §3.5, §5.3; ADR-0016. Planned check: step 18 | T-34, T-35, T-39, T-37 |
| M-20 | The `signin` key is 32 random bytes from a cryptographic source, made by a custom resource, never in the template, an output, the custom resource's response or a log. The store holds one or two keys. Rotation is three stack updates with waits for propagation (60 s) and `state` lifetime (10 minutes). Rotate on a schedule and whenever the key may have been read. The readers and writers are listed in [Who can read and write what](#who-can-read-and-write-what) | Spec §3.5, §4.1, §6.1, §10 (rotation check); ADR-0016. Deployer action: keep store and function actions off other roles | T-34 |
| M-21 | The access log delivery has a closed field list and leaves out `cs-uri-query`, `cs(Referer)` and `cs(Cookie)`. The sample enables no other log that holds a query string. The SPA reads the callback query into memory and calls `history.replaceState` before any other fetch. Registrar and sweeper logs never carry a body, a token or a challenge token | Spec §3.1, §3.5 step 4, §3.4 step 6; ADR-0010, ADR-0016. Deployer action: a WAF log, a real-time log or an origin's access log added later must drop the query string too | T-36, T-38, T-53 |
| M-22 | A dedicated domain is never a sign-in target and holds no session. Its SPA sends the user to `signInHost` (`<tenant>.<appDomain>` in `host` mode, `<appDomain>` in `single` mode), which `/config.json` names. `/signin-state` and `/logout` on a dedicated domain answer 400, and a `state` for one gets 400 on the sign-in host | Spec §3.2, §3.3 step 2, §3.5; ADR-0016, ADR-0018. Planned check: steps 3, 18 | T-37 |
| M-23 | A dedicated domain is routed only after a challenge: a 32-byte random token the registrar issued for this tenant and this domain, published at `_tfd-challenge.<d>` as `tfd-verify=<token>`, valid 7 days. The token lives in the tenant's own entry, is compared only for that `d`, and goes with it. A CNAME at the name is refused. A resolver error is never a pass. No certificate is requested before the pass, and the record is resolved again before `host#<d>` is written. A pending claim by another tenant gets 409 | Spec P-5, §3.4 steps 4 and 5; ADR-0018; spike S-10. Planned check: steps 11, 14 | T-23, T-40, T-42, T-43 |
| M-24 | The sweeper checks every passed challenge daily, routed or not. It raises the three-miss alarm, the `unverifiable` alarm (three days of resolver errors), the queue-depth alarm, the missing-pages alarm and the no-lister alarm. It never drops a domain itself, so a DNS fault cannot take a domain offline with no person deciding. A streak counts checks, not calendar days, so a failed page delays an alarm and never cancels it | Spec §3.4 step 5; ADR-0018, ADR-0020, ADR-0022. Planned check: step 14 (the metric the alarm watches) | T-41, T-42, T-54, T-56 |
| M-25 | Removal is two-phase and teardown is complete. A dropped or changed domain removes `host#<d>`, `d`, `dk` and `dx` at once, disables the distribution tenant, and the sweeper deletes it and then its certificate, each only when its tags name this tenant and this distribution. A guard custom resource refuses the update that turns `dedicatedDomains` off while any `d` or leftover resource exists. A teardown custom resource deletes every dedicated distribution tenant and every certificate the registrar tagged, a pending one included | Spec §3.4 step 5 (removal, guard), §6.2; ADR-0002, ADR-0018. Planned check: steps 14, 24 | T-44 |
| M-26 | The sweeper takes no day from its caller. Each page compares the date the lister passed with today's UTC date and exits as a no-op when they differ. It re-reads every passed tenant's entry with `GetKey` and checks only those ids. An outcome is written once for each tenant, domain and day, with a condition, so a repeat changes nothing | Spec §3.4 step 5; ADR-0020, ADR-0022 | T-55, T-56 |
| M-27 | In `host` mode the web ACL carries two rate rules scoped to `/api/*` and `/agents/*`: one aggregated on `Host` and client IP (`ipRequestsPer5Min`, default 500), ahead of one keyed on `Host` (`tenantRequestsPer5Min`, default 2,000). Each answers a custom 429 with `x-tfd-rate-rule`. SPA loads are outside the count | Spec §3.6, §5.3, §6.2; ADR-0009, ADR-0021; spike S-6. Planned check: step 17, and the web ACL template test. Deployer action: raise `ipRequestsPer5Min` for a tenant behind one address | T-6, T-7 |
| M-28 | In `single` mode the cell limits each verified tenant to `tenantRequestsPer5Min`. The count is on the verified claim, so a forged or tokenless request does not use up a tenant's budget | Spec §6.1, §6.2; ADR-0009. Planned check: the demo cell API's unit test | T-5 |
| M-29 | Fetch Metadata: on `/api/*`, `/agents/*` and `/signin-state` the router allows `same-origin`, `none` or no header, and refuses the rest with 403. In `host` mode that excludes `same-site`. Any cookie the application adds uses the `__Host-` prefix. The sample sets no cookie | Spec P-7, §3.3 step 4, §7.3; ADR-0007. Planned check: steps 9, 18, 23. Deployer action: the Public Suffix List entry for `appDomain` | T-8, T-48 |
| M-30 | One response headers policy on every behaviour, set once at the edge and overriding the origin's headers (P-8): CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`. HSTS has no `includeSubDomains` and no `preload`, because the policy also serves tenants' own domains | Spec P-8, §7.1, §7.3; ADR-0002, ADR-0008. Planned check: step 3. Deployer action: HSTS with `includeSubDomains` and preload on `appDomain` itself | T-14, T-45 |
| M-31 | A hash-based CSP with `strict-dynamic`, `require-trusted-types-for 'script'` and no pass-through policy. The SPA writes no HTML strings into the DOM, renders agent output and `error_description` as text, and sends tokens only to the origins in `connect-src`, which the stack takes from its inputs at deploy time and which the route table cannot change. The build fails when a script has no hash | Spec §7.1, §7.2; ADR-0007, ADR-0008 | T-14, T-46, T-49, T-50 |
| M-32 | Tokens live in SPA memory. No access token, refresh token or code goes to `localStorage`, `sessionStorage` or a cookie; only the PKCE verifier and the nonce go to `sessionStorage`, until `/callback` deletes them on every outcome. The SPA refuses a callback whose nonce differs, and discards a token whose `tenant_id` is not the host's. A reload signs in again. The refresh token goes only to the issuer's token endpoint and `exchangeEndpoint` | Spec §3.5, §7.2; ADR-0007 | T-8, T-35, T-36, T-46, T-47, T-48 |
| M-33 | Cache rules: `/config.json`, `/logout`, `/signin-state` and every router-made answer are `no-store`; `/api/*` and `/agents/*` use `CachingDisabled`; only `/assets/*` (content-hashed, the same for every tenant) and the SPA shell (`no-cache`, the same for every tenant) are shared | Spec §3.2, §5.3; ADR-0006 | T-9 |
| M-34 | The router forwards only `^/agents/[a-z0-9-]{1,32}/invocations$`, strips the leading `/agents`, and answers 404 for every other `/agents` path, `/agents` and `/agents/` included. The check runs before the SPA rewrite. With `agentIngress` off every `/agents` path is 404 | Spec §3.3 step 3, §6.3; ADR-0019. Planned check: step 23 | T-16 |
| M-35 | The agent ingress verifies the token and selects the tenant itself, so a request that reaches it, by the edge or directly, is checked for identity and tenant. It does not see the route table | Spec §1.2, §3.5, §6.3; ADR-0011; [agentic-runtime-isolation threat model](../agentic-runtime-isolation/threat-model.md) | T-15 |
| M-36 | One writer, and a stated boundary for the rest. The registrar is the only code that writes routes. The registrar role, the sweeper role, the `signin` custom resource and every edge-account principal with KeyValueStore actions on the store, and every principal with `cloudfront:UpdateFunction` or `TestFunction` on the router, can read the `signin` key; the deployer keeps those actions off every other role. KeyValueStore has no resource policy, so the stack cannot do it | Spec P-3, §3.5, §6.1; ADR-0003, ADR-0012, ADR-0016, ADR-0017 (Option 3). Deployer action: review those principals | T-19, T-25, T-49, T-53 |
| M-37 | Public reads carry only what is public. `/config.json` holds issuer endpoints, client id and scopes, and on a tenant host the id, display name and `rev`; no secret. Refusals have static bodies. Tenant ids are 26-character ULIDs. In `single` mode `/config.json` names no tenant | Spec §3.2, §4.1, §5.3, §6.2; ADR-0006 | T-4, T-51 |
| M-38 | Telemetry says what it is. The router logs a tenant only when the id matches `[a-z0-9-]{1,63}` (else `-`), never the token, a header, the path or the query. The field names the claimed tenant. A billing-grade count comes from the cell's log of verified requests | Spec §3.1 (Telemetry), §6.2; ADR-0010 | T-52 |
| M-39 | The test role and the test operator role are created for the run and removed after. The test stacks create them, not the shipped constructs. The leftover check of step 24 looks for them. The fixture key and the sweeper-table items are the test's only writes that bypass the registrar and the sweeper | Spec §6.1, §10 (test-only shortcuts, step 24). Planned check: step 24 | T-57 |
| M-40 | Build gates. The code that depends on an open question does not land until the question is answered: Q-5 (hooks) before the route hook and the admission policy, Q-7 (`createdAt`) before `dt`, Q-8 (exchange CORS) before the narrowing flow is claimed to work with the demo issuer. ADR-0017 stays Proposed and ADR-0013 Accepted until control-plane ADR-0044 is accepted | Spec §11, §3.5, §6.3; ADR-0013, ADR-0017 | T-32, T-33, T-50 |
| M-41 | Hook setup is safe to leave running. The hook exits 0 for an application with no front door hook parameter and retries a throttled read for about a minute. `register-hooks.sh` pins the hook's source to a full commit SHA, and the hook-to-registrar API stays backward compatible across versions, because one pin serves every front door. Setup and teardown go in the order of spec §6.2, which the README repeats | Spec §3.4, §5.2, §6.2; ADR-0014, ADR-0017; control-plane M10 (the pin rule). Planned check: steps 19, 24 | T-58, T-59 |
| M-42 | Sign-out hygiene. `/logout` mints a `state` with no nonce, so the code that follows sign-out is dropped at the sign-in host and goes nowhere. It sends `Clear-Site-Data: "storage", "cache"` and no `"cookies"` directive, which would clear every site the vendor runs under the domain. The query is not logged | Spec §3.5 step 5, §7.3; ADR-0016. Planned check: step 18 | T-38 |
| M-43 | Capacity is bounded and visible. Display names are cut to 64 bytes. The registrar refuses a write past 5 MB with 507, and an alarm fires at 80 %. The ceilings are 16,949 tenants in `single` mode and 8,583 in `host` mode, and 3,472 dedicated tenants in the headroom. ACM's quota (2,500 by default) binds first; a request past it answers 507. Only the edge operator role can set a domain | Spec §4.1, §5.1; ADR-0012, ADR-0018. Deployer action: raise the ACM quota before routing more than about 2,500 dedicated domains | T-60 |

## Who can read and write what

ADR-0016 asks for these lists. KeyValueStore has no resource policy and its
actions name the store, not a key, so a role that can read or write the
store can do it for every key. The router's own function configuration is
part of the same permission unit.

**Principals that can write the route table:**

| Principal | Writes | Note |
|---|---|---|
| Registrar role | `tenant#`, `host#`, `cell#` | The only code that writes routes. Its code never writes `signin` or `app` |
| `signin` custom resource role | `signin` | Writes with the ETag; deploy time |
| The deploying principal and the stack's custom resources | `app` | Written on deploy, so an issuer change is a stack update |
| Integration test role | any key (`PutKey`, `DeleteKey`) | Test account only; one fixture (M-39) |
| Any other principal the deployer gives KeyValueStore write actions | any key | The deployer's boundary (AR-6) |

**Principals that can read the `signin` key** (and with it, every route):

| Principal | Why it can |
|---|---|
| Registrar role | reads the store for the checks of step 3 to 5 |
| Sweeper role | `ListKeys` and `GetKey` for the re-check |
| Guard role | `DescribeKeyValueStore` and `ListKeys` for the on-to-off refusal |
| `signin` custom resource role | writes it |
| Any principal with `cloudfront:UpdateFunction` or `cloudfront:TestFunction` on the router | can run the function against the store |
| Integration test role | `TestFunction`, to sign a test `state` with the live key |
| Any other principal with KeyValueStore read actions | the deployer's boundary (AR-6) |

A leaked key mints a `state` for any registered tenant host while the key is
live. The nonce and PKCE binding still stop it from yielding a token (T-34).

**Principals that can read the CloudFront log group in `us-east-1`:** any
principal in the edge account with CloudWatch Logs read actions on it. The
stack grants none. The integration test role reads it in step 15. The log
names the tenant of every routed request, and shows each request to the
sign-in host, but holds no query string, referrer or cookie (M-21). The
registrar's log group is in the deployment Region, and the sweeper's own log
group holds the tenant and domain on an alarm line, never a token.

**Principals that can read or write the sweeper table:** the sweeper role
(`GetItem`, `Query`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`), and the
integration test role (`GetItem`, `PutItem`). The registrar role has no access.
The table holds no token and no key.

## Accepted risks

The deployer who runs a front door accepts these. Each goes on the sample
README's production hardening checklist.
They are listed in order of consequence. A line starting "Why" gives the
reason; "Bounded by" says what limits it.

1. **AR-1: One role for every global hook (T-20, T-26, T-30).** The
   registrar admits `<fleet>-global-hook`, and every global hook runs under
   it. Admission proves that some vendor global hook is calling, not that the
   route hook is. Any global hook can write while a create, update or delete
   of a record is in flight, and the registrar cannot tell which hook did.
   *Why:* the control plane has no role per global hook yet (control-plane
   §11). *Bounded by:* the record supplies the cell and account; a put
   keeps `s`; a delete needs a deleting record; a cell's origin is
   write-once, so a hook that sets it early fails the cell's operation and
   leaves the cell out of `ACTIVE`, where the operator role replaces the
   origin. The sample's hooks are vendor code, pinned (M-41). Revisit when
   the control plane offers a role per global hook; the registrar can then
   admit the route hook alone.
2. **AR-2: If hooks do not land, ADR-0013 applies and its gap returns (T-17,
   T-22, T-33).** Under ADR-0013 the registrar admits the provisioning roles
   of cell accounts. A tenant-owned account controls those roles, so it can
   delete its suspended route and put it again, which starts `active`.
   *Why:* control-plane ADR-0044 is Proposed (spec Q-5). The specification
   describes ADR-0017, and this risk applies only to a deployer who runs the
   front door before the hooks exist. *Bounded by:* nothing in the sample.
   Until ADR-0017 is accepted, do not place tenants in tenant-owned accounts
   when a suspension must hold; cells in vendor-owned accounts do not give
   the tenant these roles.
3. **AR-3: A request sent straight to the agent ingress skips the edge's
   refusals (T-15, T-22).** The ingress is a public endpoint. It verifies
   the token and picks the tenant, so identity and tenant isolation hold,
   but it does not see the route table: a suspended tenant's tokens still
   work, and an unknown tenant is not refused as unknown. *Why:* spec §1.2
   and §6.2 state it as a limit; the hardening path sits on the ingress, which
   belongs to another sample. *Bounded by:* the ingress's own checks (M-35).
   Hardening: an ingress that admits only the distribution through a secret
   origin header that a WAF rule on the ingress checks, or one that reads
   the suspension.
4. **AR-4: A tenant that owns a cell's account controls that cell (T-12,
   T-14, T-22).** The tenant can change its function URL's resource policy and
   call its own cell directly, so the edge cannot enforce a suspension there.
   It sees the bearer token of every request routed to it, and a token routed
   to it by mistake (T-12) is a live token of another tenant's user. It can
   return any content. *Why:* the front door controls routes, not the
   tenant's compute. A suspension stops the vendor's traffic, not the
   tenant's use of its own account. *Bounded by:* the cell receives only the
   tokens of tenants whose route names it (M-8); the route cannot name
   another account's cell (M-7); the response headers policy and the SPA's
   rules hold for what the browser does with the answer (M-30, M-31).
5. **AR-5: A wrong placement by the control plane sends a tenant's traffic
   to another customer's account (T-28).** The route follows the control
   plane's record (P-6). A control plane operator can place any tenant in any
   registered account (control-plane T27). *Why:* the front door has no
   second source of placement, by design. *Bounded by:* the registrar reads
   the record on every write, so a correction takes effect on the next
   update. The control plane's own account-scoping seam (control-plane §11)
   is the real fix.
6. **AR-6: Principals in the edge account with store, function or log
   rights (T-19, T-49, T-53).** Anyone who can write the store can write
   any route, or change the issuer endpoints in `app`; anyone who can read it
   holds the `signin` key. *Why:* KeyValueStore has no resource policy and
   its actions name the store. *Bounded by:* the sample's roles (M-16, M-36)
   and the deployer's own account hygiene. Deployer action: keep those
   actions and `cloudfront:UpdateFunction` off every other role; review the
   [lists above](#who-can-read-and-write-what).
7. **AR-7: Suspension and delete take effect after propagation (T-10).**
   A write reaches an edge location in about 30 s (spike S-2: median
   28.4 s, p99 29.4 s, max 29.5 s, one location). The hook waits 45 s.
   Until then the tenant is still routed, and the cell's hosts check is the
   only refusal. *Why:* the store is eventually consistent; no
   alternative reads at the edge without a network call (ADR-0003). *Bounded
   by:* the window is under a minute at the measured location; other
   locations were not measured.
8. **AR-8: `single` mode has no edge rate rule, and forged claims reach an
   origin (T-1, T-5).** WAF cannot read the token's tenant. A request with
   a forged claim naming a live tenant costs one invocation of that cell
   before the cell refuses it. *Why:* ADR-0009; the origin limit counts
   verified requests only, which is the property wanted for a per-tenant
   budget. *Bounded by:* tokenless and unregistered requests are refused at
   the edge. Deployer action: add a WAF rate rule on the client address to
   the distribution if forged load matters.
9. **AR-9: Floods from many addresses, shared office addresses, and the
   cost of refused traffic (T-6, T-7).** In `host` mode a flood from many
   addresses can still bring a tenant's host to its count. `ipRequestsPer5Min`
   is one value for every host and a chosen value, not a measured one: a
   tenant whose users share one NAT address gets about 1.7 requests per second
   at the default before the per-host rule applies. Unknown hosts and
   unregistered tenants are refused at the edge and reach no origin, but
   CloudFront and WAF still bill the requests. *Why:* the per-IP rule
   fixes the one-address lock-out; no edge key can name a verified tenant.
   *Bounded by:* the per-IP and per-host rules, and edge refusals that reach
   no origin. Deployer action: raise `ipRequestsPer5Min` for a tenant behind
   a NAT; raising it applies to every host.
10. **AR-10: The tenant field in the access log is the claimed tenant
    (T-52).** A forged claim, or traffic at a tenant's public host, counts
    against the tenant it names. *Why:* the edge cannot see a verified tenant.
    *Bounded by:* the field is for operations and cost estimates only
    (M-38); billing and alarm decisions use the cell's log of verified
    requests.
11. **AR-11: Public disclosure of tenant existence, status and display name
    (T-4, T-51).** `/config.json` on a tenant host names the tenant, its
    display name and `rev`. A forged claim for a known id gets 403 or 503
    (unregistered or suspended) in `single` mode, and an unknown host gets
    404 in `host` mode. *Why:* low value, stated in spec §6.2; the SPA needs
    the settings before sign-in. *Bounded by:* ULID ids cannot be
    enumerated; the file holds nothing secret (M-37). A caller who already
    knows a tenant id can probe it in `single` mode: 403 from the edge for an
    unregistered id, 503 for a suspended one, the cell's refusal for a live
    one.
12. **AR-12: Script in the page can use the tokens (T-46).** The access
    token is in memory for its lifetime. The refresh token, kept for the
    multi-tenant exchange, lives as long as the issuer's (one day in
    `tenant-identity`). *Why:* ADR-0007 weighs a backend-for-frontend and
    declines it for this sample. *Bounded by:* CSP with hashes and Trusted
    Types, no HTML strings (M-31); a reload loses the tokens. Revisit when a
    tenant needs tokens kept out of page script.
13. **AR-13: A request with no `Sec-Fetch-Site` header is allowed (T-8).**
    Old browsers and non-browser clients send none. *Why:* the header check
    is defence in depth; the bearer token in a header, which no browser
    attaches on its own, is the credential. *Bounded by:* the token (M-32).
14. **AR-14: A domain that changes owner stays routed until an operator drops
    it (T-41, T-56).** The alarm fires after three missed daily checks. A
    resolver can serve a removed record for up to a day (spike S-10 saw 661 s
    for a 86,400 s TTL), and the sweeper runs once a day. A domain dropped
    and set again between two runs keeps its streaks and can alarm early; a
    lost table restarts every streak at zero; a failed page delays an alarm.
    *Why:* the sweeper does not drop a domain itself, so a DNS fault or a
    tenant's mistake cannot take a domain offline with no person deciding
    (ADR-0018). *Bounded by:* the alarms (M-24), and the fact that a dedicated
    domain never receives a sign-in code (M-22). Deployer action: wire the
    alarms (AR-25) and drop the domain on the alarm.
15. **AR-15: The DNS check trusts one answer from one vantage point, without
    DNSSEC (T-42).** ACM's own validation does the same. Negative answers
    can delay a pass for the tenant zone's negative-caching TTL. *Why:*
    ADR-0018 states the shortcut. *Bounded by:* caching can delay a pass and
    cannot cause one, because no cached answer can predate the token. Upgrade
    to a second Region's answer, or DNSSEC validation, when a vendor needs
    the multi-perspective check public certificate authorities make.
16. **AR-16: Sign-out can be triggered cross-site, and the code after
    sign-out has no PKCE challenge (T-38).** A page can send the browser to
    `/logout`, which signs the user out and nothing more. The code the issuer
    issues after sign-out is redeemable by `client_id` and `redirect_uri`
    alone. *Why:* Cognito's `logout_uri` form drops `state`, so only the
    `redirect_uri` form can return the user to a tenant host (spike S-4o,
    ADR-0016). *Bounded by:* the code reaches only `login.<appDomain>`,
    which drops it and does not log it (M-42, M-21).
17. **AR-17: Same-site neighbours and `appDomain`'s own HSTS are the
    deployer's steps (T-45, T-48).** The sample does not add `appDomain` to
    the Public Suffix List, and does not send HSTS with `includeSubDomains`
    and preload for `appDomain`'s subdomains. *Why:* both act on the
    deployer's own domain, which the sample cannot change (spec §7.3).
    *Bounded by:* Fetch Metadata and `__Host-` cookies (M-29). Deployer
    action: both steps.
18. **AR-18: Capacity ceilings and no shard (T-60).** Past 16,949 tenants in
    `single` mode, 8,583 in `host` mode or about 3,472 dedicated tenants the
    store is full; ACM's 2,500-certificate default binds before that, and a
    domain dropped and set again uses the 5,000 requests in 365 days. A
    create then fails with 507. *Why:* sharding by distribution is a plan,
    not a build (ADR-0012). *Bounded by:* the 80 % alarm; only the edge
    operator role sets a domain. Deployer action: raise the ACM quota first.
19. **AR-19: Compromised code in the registrar, sweeper, router or a custom
    resource (T-25).** The registrar's compromise is control of routing: it
    can write any route, and its role can read the `signin` key. The
    sweeper's compromise reaches deletes of distribution tenants and
    certificates in the account. *Why:* any single writer is a single point.
    *Bounded by:* the role split (M-16), dependency pinning and the build
    scans (standard §6). Detection is CloudTrail on the roles.
20. **AR-20: The edge operator role (T-23).** A stolen or misused role
    changes any route: suspend, resume, set an origin, clear. *Why:* the
    vendor needs one role that does this. *Bounded by:* the registrar's own
    checks still apply to it (M-17); CloudTrail names each call (M-18).
    Deployer action: MFA, short sessions, review who can assume it.
21. **AR-21: The hook's blast radius on the control plane (T-58, T-59).** The
    hook runs for every application on the control plane. A wrong
    `RouteHookAccess` policy, or a teardown out of order, fails every create
    and update and delays every delete. One pin serves every front door, so
    moving it changes the hook for all of them, and a poisoned source runs
    in the control plane's account as the shared role. *Why:* a global hook
    is how the control plane runs vendor code on cell and deployment events
    (ADR-0017). *Bounded
    by:* the pinned commit (M-41), exit 0 for applications with no front
    door, and the control plane's own limits on hooks (control-plane T41,
    T43).
22. **AR-22: The reader token reads more than the registrar needs (T-27).**
    The reader grant covers ten `GET` operations; the registrar uses three.
    A leak discloses fleet topology, non-secret parameter values and the
    source locations of applications and hooks, never a change. *Why:*
    control-plane ADR-0042 has no narrower grant. *Bounded by:* the token's
    lifetime and the secret's rotation (M-14).
23. **AR-23: A skipped delete hook leaves a route (T-31).** The control plane
    skips a delete hook after three attempts so that cleanup stays
    reachable. The route stays until the edge operator role clears it. The
    leftover `suspended` entry stays `suspended`; a leftover `active` entry
    points at its old cell, whose hosts check refuses once the delete script
    has removed the tenant's namespace, or at a cell route that is gone (503).
    *Why:* a delete must not wait on the front door. *Bounded by:* the
    control plane's skip alarm, the operator's `DeleteTenantRoute`, and `dt`:
    a later deployment of the tenant replaces the entry (M-9).
24. **AR-24: Test-only shortcuts (T-57).** The test role can write the
    store, read the `signin` key, edit the sweeper table and start the
    sweeper; the test creates its own operator role. *Why:* a page acts
    only on the current UTC day, so the test seeds items to reach a third
    missed day, and a fixture `host#` key stands in for a domain with no
    DNS (spec §10). *Bounded by:* test account only; created for the run and
    removed after; none of it is in the shipped constructs. If a run stops
    early, remove the roles and the fixture by hand: the leftover check of
    step 24 lists them.
25. **AR-25: The alarms' notifications are not checked (T-54).** The test
    checks the metric the re-check alarm watches (step 14), not what the
    alarm does. *Why:* the channel and the response are the deployer's.
    *Bounded by:* nothing in the sample. Deployer action: wire every alarm of
    M-24 and the 80 % store alarm to a channel someone watches.
26. **AR-26: The cell API contract is not enforceable by the front door
    (T-13).** A cell API that does not verify the token, ignore a hint that
    differs from the claim, or check its hosts, serves a forged token. *Why:*
    the cell is the authoriser (ADR-0005), and the front door cannot see
    inside it. *Bounded by:* the demo cell API is the reference, with unit
    tests; the contract is spec §6.1; step 7 drives a forged signature. A
    cell in a tenant-owned account that skips verification only exposes its
    own tenant.
27. **AR-27: The router with a very large token is not measured (T-7).**
    Spike S-7 measured a 1,184-byte token (13 % compute) and malformed tokens
    (9 to 10 %, 401). It did not measure a token near the header size limit.
    A function error answers only the sender's own request with an error
    status, reaches no origin and costs no other tenant anything. *Bounded
    by:* the 401 on a malformed token and CloudFront's own limit on header
    size. A unit test
    on the decoder's input length, or a rule that refuses a long
    `Authorization` header before the function, closes it when the build
    lands.
28. **AR-28: Two operator calls can race for one domain (T-43).** Both can
    pass the pending-claim check; only one gets the distribution tenant, and
    the other keeps a pending `d` until the operator drops it. *Why:* the
    race is between two vendor actions and ends in a 409, not a wrong route.
    *Bounded by:* the ETag re-check (M-15), the certificate and distribution
    tenant checks (M-16), and the operator's repeat-safe calls.

## Open items

| Question | What waits | What this threat model assumes meanwhile |
|---|---|---|
| Q-4: does the integration test compose `agentic-runtime-isolation` for `/agents/*`? | the real ingress behind the path filter (T-16) | The path filter, the rewrite and the streaming are checked against a stand-in (step 23). An `agentcore-gateway` ingress behind `/agents/*` needs its URL form checked first (ADR-0019) |
| Q-5: do control-plane global hooks keep the shape ADR-0017 uses? | ADR-0017 acceptance, the route hook, the admission policy (T-33, AR-2) | ADR-0017 holds. If it does not, ADR-0013 applies and AR-2 is the cost |
| Q-7: does `GetDeployment` return `createdAt`, with a stated format? ([issue 55](https://github.com/aws-samples/sample-agentic-ai-acceleration-patterns/issues/55)) | `dt`, the replacement of a leftover entry (T-32) | The registrar compares exact stored `dt` values. Without a stable value, a repeat could reset `suspended` to `active`, so the build waits (M-40) |
| Q-8: does `tenant-identity` add an allowed-origins input to its exchange API? ([issue 56](https://github.com/aws-samples/sample-agentic-ai-acceleration-patterns/issues/56)) | narrowing a `tenants` token with the demo issuer (T-50) | The router refuses a `tenants` token with 401 either way, so this is a gap in the tested path, not in the boundary. Another issuer must echo only `https://<appDomain>` or one label under it (spec §7.2) |

## Security review

No scanner has run: nothing is built. When the build lands, the synthesised
tree is scanned with ProtoShield and the Automated Security Helper (standard
§6). This section then lists each finding as fixed, accepted with its
reason, or a false positive with the evidence, and every cdk-nag suppression
cites a mitigation or an ADR here.

## Links

- [Specification](./design/tenant-front-door.spec.md), [spikes](./design/spikes.md)
  and the [ADR index](./adr/README.md)
- [control-plane threat model](../control-plane/threat-model.md): hooks (T39
  to T44, M28 to M32), reader grant (T36), cross-customer placement (T27)
- [tenant-identity threat model](../tenant-identity/threat-model.md): the
  issuer, token narrowing and the exchange endpoint
- [agentic-runtime-isolation threat model](../agentic-runtime-isolation/threat-model.md):
  the agent ingress behind `/agents/*`

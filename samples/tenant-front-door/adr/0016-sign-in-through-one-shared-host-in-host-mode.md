<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0016: Sign in through one shared host in host mode

- Status: Accepted
- Date: 2026-11-17
- Amended by: ADR-0018
- Deciders: Dave Roberts (PSA)

## Context

In `host` mode each tenant has its own origin, `<tenant>.<appDomain>`
(ADR-0001). The issuer must send the authorization code back to an origin
it trusts, and a Cognito app client lists those origins as callback URLs.
Sign-out has the same shape: Cognito's `/logout` with `logout_uri` needs
that URL registered as a sign-out URL on the app client, a list with the
same 100-URL limit. The front door must serve thousands of tenants per
distribution (ADR-0012) and add a tenant without a release.

Spike S-4 (2026-11-16) measured Cognito: one app client takes 100 callback
URLs and refuses the 101st; a pool takes 1,000 app clients by default,
10,000 at most; `UpdateUserPoolClient` gives about 15 updates per second
and then `TooManyRequestsException`. Cognito saves a wildcard callback URL
(`https://*.<appDomain>/callback`), but treats the `*` as a literal
character: it refused `https://t7.<appDomain>/callback` with
`redirect_mismatch`, as it did a two-label host, the apex, a suffix trick,
another path, `http` and a port. Only the literal string itself,
`https://*.<appDomain>/callback`, reached the sign-in page and got a code.

Spike S-4o (2026-11-16) measured Cognito's `/logout`. Its parameters are
Cognito's own, `logout_uri` and `redirect_uri`, not the
`post_logout_redirect_uri` of OpenID Connect RP-initiated logout. With
`client_id`, a registered `logout_uri` on the shared host and a `state`,
Cognito ended the session and redirected to the `logout_uri` with the
`state` dropped, so a shared sign-out URL cannot learn which tenant host
to return to. An unregistered `logout_uri`, on another domain or on a
tenant host, was refused with a redirect to Cognito's own `/login` page.
With `client_id`, `response_type=code`, `scope`, a registered
`redirect_uri` and a `state`, Cognito redirected to its sign-in page with
the `state` kept, and after sign-in sent the code and the same `state` to
the `redirect_uri`. A rerun on 2026-11-17 showed that this form also
signs the user out: a live session gave a code without the sign-in
form, both `/logout` forms ended it, and the next authorize showed the
form again.

## Options considered

### Option 1: The tenant script adds a callback URL

Each tenant script adds `https://<tenant>.<appDomain>/` to an app client,
starting a new client every 100 tenants. Pros: the code goes straight to the
tenant origin. Cons: a read-modify-write on a shared client at 15 updates
per second, raced by concurrent onboarding; tenants in different client
groups have different client ids, so `/config.json` and the token carry
one per tenant group and the cell and the control plane must accept all of
them; one more place a tenant script must clean up. The client count is not
the limit: ADR-0012, as ADR-0017 amends it, caps `host` mode at 8,583
tenants, which is 86 clients, inside the default quota of 1,000.

### Option 2: One shared sign-in host with a signed `state`

One host, `login.<appDomain>`, is the only callback URL. The tenant origin
starts sign-in with a `state` the edge signs, and starts sign-out with
Cognito's `redirect_uri` form of `/logout`, which comes back through the
same callback URL with a fresh `state` (S-4o). Pros: no issuer change per
tenant; no ceiling; tested end to end in S-4 (hosted sign-in, a real code,
the redirect to the tenant host), whose sign-in host refused a missing or
changed `state` and any host outside `appDomain` with 400. Cons: one more
hop; a sign-out ends on the issuer's sign-in page rather than a signed-out
page; a `state` can be replayed until it expires, so the SPA must bind its
nonce and PKCE verifier; the router holds an HMAC key that needs rotation.

### Option 3: A wildcard callback URL

Pros: no extra hop and no per-tenant change. Cons: Cognito does not match
it; a tenant host gets `redirect_mismatch` (S-4). Another issuer that
matched it loosely would send codes to any host under the domain.

## Decision

Option 2. In `host` mode the one callback URL is the shared sign-in host,
`login.<appDomain>`, a reserved label (spec §4.1) served by the same
router function as every other host. The router mints a `state` signed
with an HMAC key from the route table that binds the tenant host, the
SPA's nonce and a 10-minute expiry; the sign-in host forwards the code
only to an active, registered tenant host, and the SPA's nonce and PKCE
verifier make a replayed `state` useless. The router mints a `state`
only on a pooled host, one label under `appDomain` that the vendor's
wildcard DNS record and certificate cover, and the sign-in host
forwards only to one, so a dedicated domain signs in on its pooled
host `<tenant>.<appDomain>`, which `/config.json` names as
`signInHost`. The registrar refuses a `customDomain`
that equals `appDomain` or ends in `.<appDomain>` (spec §3.4 step 4),
so a pooled host's only `host#` entry is its own tenant's. That rule is
what makes a pooled host always the vendor's SPA for its own tenant.
Sign-out uses Cognito's `redirect_uri` form of `/logout` with a fresh
`state` for the tenant host, because S-4o showed that the `logout_uri`
form drops `state`: the user
signs out, signs in again and returns to their own tenant host. This
needs no issuer change per tenant and has no ceiling, where Option 1
needs a client update per tenant at 15 per second and Option 3 does not
work on Cognito; Option 1 stays possible for a deployer with few tenants.
The `state` format, the mint, the sign-in host's checks, the key and its
rotation are in spec §3.3 step 2, §3.5 and §4.1.

## Consequences

- Easier: onboarding a tenant in `host` mode touches no issuer setting, and
  neither does sign-out, which reuses the one callback URL.
- Easier: the router answers `/signin-state`, `/logout` and the sign-in
  host from the store alone, with at most three reads per request.
- Harder: sign-out depends on Cognito's `redirect_uri` form of `/logout`.
  Another issuer needs its own mapping from the tenant host's `/logout`.
- Harder: the code Cognito issues after a sign-out has no PKCE challenge,
  so `client_id` and the `redirect_uri` redeem it. Its `state` carries no
  nonce, so the sign-in host sends the user to the tenant host's `/`
  without it, and the SPA starts a fresh sign-in that the issuer's new
  session answers without the sign-in form (spec §3.5). The code
  reaches only `login.<appDomain>` and is not logged: the access log
  delivery leaves out `cs-uri-query` (ADR-0010).
- Harder: a dedicated domain in `host` mode is never a sign-in target.
  Its DNS belongs to the tenant, so a code forwarded there would reach a
  server the tenant runs. That tenant could start an authorize request
  with its own nonce and PKCE verifier, send the link to any signed-in
  user of the shared pool and redeem the code for that user's token.
  Its users sign in on `signInHost`, the host where sign-in happens,
  which `/config.json` names: the pooled host `<tenant>.<appDomain>` in
  `host` mode, where they stay for the session, and `<appDomain>` in
  `single` mode (spec §3.5). A dedicated domain with its own callback URL
  (Option 1 for that one client) is out of scope until spec Q-3 is
  answered.
- Harder: the pooled-host rule holds only while the registrar keeps
  `customDomain` outside `appDomain` and refuses a write over another
  tenant's `host#` entry. The `host#` value names its tenant (`t`),
  which the registrar checks before another tenant's write, and
  records the account (`ac`), which deletes check; `ac` adds 20 bytes
  per tenant (ADR-0012). Only the edge operator role sets a
  `customDomain`.
- Harder: the sign-in host and its function are part of the edge, and the
  integration test for `host` mode signs in and out through it (spec §10).
- Harder: the router is no longer secret-free in `host` mode. The route
  table is one permission unit, so the registrar role and any
  edge-account principal with read actions on the store can read the key;
  the deployer keeps those actions off every other role (spec §6.1).
- Harder: the SPA needs `sessionStorage` for two single-use values
  (ADR-0007).
- Follow-up: the sample's threat model lists every principal that can read
  the `signin` key, the integration test role that calls `TestFunction`
  and signs a test `state` among them (spec §10 step 18), and every
  principal that can write the store, the test role included: it holds
  `PutKey` and `DeleteKey` for its fixture, scoped to the test run
  (spec §6.1). It also lists every reader of the CloudFront log group
  in `us-east-1`, which sees each request to the sign-in host and names
  the tenant of every routed request.
- Follow-up: count `state` refusals apart from other 400s: every 400 on
  `login.<appDomain>` in the access log is a refusal.
- Revisit when the issuer matches wildcard callback URLs strictly, returns
  `state` on a `logout_uri` redirect, or a per-tenant issuer replaces the
  shared one.

Amended 2026-11-18 by ADR-0018, which answers spec Q-3: a tenant proves
control of a dedicated domain's DNS with a registrar-issued token before
the domain is routed. The challenge confirms that the tenant controls
the domain's DNS and can point it at a server of its own, so an
authorization code sent there could leave the vendor's edge. A
dedicated domain therefore stays out of the sign-in path, and one with
its own callback URL stays out of scope.

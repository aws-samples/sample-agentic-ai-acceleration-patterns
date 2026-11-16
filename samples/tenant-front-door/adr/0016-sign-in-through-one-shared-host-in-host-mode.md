<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0016: Sign in through one shared host in host mode

- Status: Accepted
- Date: 2026-11-16
- Deciders: Dave Roberts (PSA)

## Context

In `host` mode each tenant has its own origin, `<tenant>.<appDomain>`
(ADR-0001). The issuer must send the authorization code back to an origin
it trusts, and a Cognito app client lists those origins as callback URLs.
Sign-out has the same shape: Cognito's `/logout` needs `logout_uri` to be
a sign-out URL registered on the app client, and that list has the same
100-URL limit. The front door must serve thousands of tenants per
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

## Options considered

### Option 1: The tenant script adds a callback URL

Each tenant script adds `https://<tenant>.<appDomain>/` to an app client,
starting a new client every 100 tenants. Pros: the code goes straight to the
tenant origin. Cons: a read-modify-write on a shared client at 15 updates
per second, raced by concurrent onboarding; tenants in different client
groups have different client ids, so `/config.json` and the token carry
one per tenant group and the cell and the control plane must accept all of
them; one more place a tenant script must clean up. The client count is not
the limit: ADR-0012 caps `host` mode at 9,367 tenants, which is 94 clients,
inside the default quota of 1,000.

### Option 2: One shared sign-in host with a signed `state`

One host, `login.<appDomain>`, is the only callback URL and the only
sign-out URL. The tenant origin starts sign-in and sign-out with a `state`
the edge signs. Pros: no issuer change per tenant; no ceiling; tested end
to end in S-4 (hosted sign-in, a real code, the redirect to the tenant
host), which refused a missing, changed or expired `state` and any host
outside `appDomain` with 400. Cons: one more hop; a `state` can be
replayed until it expires, so the SPA must bind its nonce and PKCE
verifier; the router holds an HMAC key that needs rotation.

### Option 3: A wildcard callback URL

Pros: no extra hop and no per-tenant change. Cons: Cognito does not match
it; a tenant host gets `redirect_mismatch` (S-4). Another issuer that
matched it loosely would send codes to any host under the domain.

## Decision

Option 2. `host` mode signs in and out through one shared host with a
signed `state`. The sign-in host, `login.<appDomain>`, is a reserved label
(spec §4.1) served by the same router function as every other host. Option
1 stays possible for a deployer with few tenants. Option 3 does not work
on Cognito.

**The state.** `state` is `base64url(payload) + "." + base64url(HMAC)`,
where the HMAC is HMAC-SHA256 over the encoded payload. The payload is
`{"v":1,"kid":"<key id>","p":"in"|"out","h":"<tenant host>","n":"<nonce>",
"exp":<unix seconds>}`. The purpose `p` stops a sign-out state from being
used at `/callback` and the reverse. Lifetime is 10 minutes.

**Minting.** Only the edge holds the key, so the tenant origin asks for a
`state`. The router answers `GET /signin-state?nonce=<base64url>` on a
tenant host, in `host` mode only (§3.3 step 2 has already found
`host#<host>`). It requires `Sec-Fetch-Site: same-origin`, a nonce of 16 to
64 base64url characters, and answers `{"state":"..."}` with `no-store`. `h`
is the request's lower-cased `Host`, so a tenant cannot mint a `state` for
another host. The sign-out state has no SPA nonce: `/logout` on a tenant
host answers 302 to the issuer's logout endpoint with `logout_uri` set to
`https://login.<appDomain>/logout` and a `state` the router mints with
`p: "out"` and a random `n`, and carries `Clear-Site-Data`.

**The sign-in host.** A router step runs before the `host#` lookup (§3.3
step 2) when `Host` is `login.<appDomain>`. It handles two paths and
answers 400 for anything else:

- `/callback?code&state`: verify the `kid`, the HMAC with the key for that
  `kid`, `p: "in"`, and `exp`; then check that `host#<h>` exists and that
  its tenant is `active`. All hold: 302 to `https://<h>/callback` with the
  same `code` and `state` (and `error` and `error_description` when the
  issuer reports a failure). Otherwise 400.
- `/logout?state`: the same checks with `p: "out"`; 302 to `https://<h>/`.

**The SPA.** On the tenant host it makes a random nonce and the PKCE
verifier, saves both in `sessionStorage` (ADR-0007), fetches
`/signin-state?nonce=...`, and navigates to the issuer's authorize endpoint
with `redirect_uri=https://login.<appDomain>/callback`, the `state` and the
code challenge. It learns the `redirect_uri` from `/config.json`
(`redirectUri`, host mode). On `/callback` it reads `n` from the `state`,
refuses the callback unless `n` equals the saved nonce, exchanges the code
with the saved verifier and the same `redirect_uri`, and deletes both
saved values. A replayed `state` yields no token: the replayer lacks the
verifier. The router cannot see the exchange.

**The key.** The route table holds one `signin` key (spec §4.1):
`{"v":1,"cur":"<kid>","k":{"<kid>":"<base64 key>"}}`, 32 random bytes per
key. It is about 150 bytes with two keys, inside the 20 % the registrar
leaves for non-tenant entries (ADR-0012). A custom resource generates it
with a cryptographic random source and writes it to the store, so the key
never appears in the template, the stack outputs or a log. In `host` mode
the router therefore holds one secret; in `single` mode it holds none.
Who can read it: any principal with `cloudfront-keyvaluestore:GetKey` or
`ListKeys` on the store, and any principal that can update the router
(`cloudfront:UpdateFunction`) or run `cloudfront:TestFunction` on it,
because a function with the store attached reads it. The stack grants
those only to the deployer and the custom resource. A leaked key lets its
holder mint a `state` for any registered tenant host for as long as the
key is live, and the PKCE and nonce binding still stops it from yielding a
token.

**Rotation.** Two keys can be live, named by `kid`. Rotation is three
stack updates of the custom resource, which generates a key for a `kid` it
has not stored, keeps the others and deletes any `kid` not listed:

1. List the new `kid` beside the old, with `cur` still the old. Wait past
   propagation (spike S-2: about 30 s, so 60 s), so every edge location
   can verify the new key before anything signs with it.
2. Switch `cur` to the new `kid`. States now sign with the new key and
   states already issued still verify with the old one.
3. After the state lifetime (10 minutes) remove the old `kid`.

An operator runs the three updates and the waits between them. Rotate
on a schedule and whenever the key may have been read.

## Consequences

- Easier: onboarding a tenant in `host` mode touches no issuer setting, and
  neither does sign-out.
- Easier: the router answers `/signin-state` and the sign-in host from the
  store alone, with at most three reads per request.
- Harder: the sign-in host and its function are part of the edge, and the
  integration test for `host` mode signs in and out through it (spec §10).
- Harder: the router is no longer secret-free in `host` mode, and the
  store's read permissions are part of the security boundary.
- Harder: the SPA needs `sessionStorage` for two single-use values
  (ADR-0007).
- Follow-up: count `state` refusals apart from other 400s: every 400 on
  `login.<appDomain>` in the access log is a refusal.
- Revisit when the issuer matches wildcard callback URLs strictly, or a
  per-tenant issuer replaces the shared one.

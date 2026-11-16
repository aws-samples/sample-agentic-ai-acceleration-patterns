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
The front door must serve thousands of tenants per distribution
(ADR-0012) and add a tenant without a release.

Spike S-4 (2026-11-16) measured Cognito: one app client takes 100 callback
URLs and refuses the 101st; a pool takes 1,000 app clients by default,
10,000 at most; `UpdateUserPoolClient` gives about 15 updates per second
and then `TooManyRequestsException`. Cognito saved a wildcard callback URL
(`https://*.<appDomain>/callback`), but the spike did not show that sign-in
accepts a tenant host through it.

## Options considered

### Option 1: The tenant script adds a callback URL

Each tenant script adds `https://<tenant>.<appDomain>/` to an app client,
starting a new client every 100 tenants. Pros: the code goes straight to the
tenant origin. Cons: a ceiling of 100,000 tenants per pool at 1,000 clients,
and far lower without a quota increase; a read-modify-write on a shared
client at 15 updates per second, raced by concurrent onboarding; one more
place a tenant script must clean up.

### Option 2: One shared sign-in host with a signed `state`

One host, `login.<appDomain>`, is the only callback URL. The tenant origin
starts sign-in with `state` = `base64url(payload) + "." + HMAC-SHA256`, the
payload holding the tenant host, the SPA's nonce and an expiry. A viewer
request function on the sign-in host checks the HMAC, the expiry and that
the host is a tenant host under `appDomain`, then answers 302 to
`https://<tenant>/callback` with the code and `state`. The HMAC key lives in
the KeyValueStore, written at deploy time. Pros: no issuer change per
tenant; no ceiling; tested end to end in S-4 (hosted sign-in, a real code,
the redirect to the tenant host), and refuses a missing, changed or expired
`state` and any host outside `appDomain` with 400. Cons: one more hop; a
`state` can be replayed until it expires, so the SPA must bind its nonce
and PKCE verifier; the key needs rotation.

### Option 3: A wildcard callback URL

Pros: no extra hop and no per-tenant change. Cons: unproven at sign-in, and
an issuer that matches it loosely sends codes to any host under the domain.

## Decision

Option 2. `host` mode signs in through one shared host with a signed
`state`. The sign-in host is a reserved label (spec §4.1). The SPA checks
the nonce and keeps the PKCE verifier in memory, so a replayed `state`
yields no token. Option 1 stays possible for a deployer with few tenants.
Option 3 is not used until a spike shows the issuer matching it strictly.

## Consequences

- Easier: onboarding a tenant in `host` mode touches no issuer setting.
- Harder: the sign-in host and its function are part of the edge, and the
  integration test for `host` mode signs in through it.
- Follow-up: rotate the HMAC key with two live keys in the store; log
  `state` refusals apart from other 400s.
- Revisit when the issuer accepts a strictly matched wildcard callback, or a
  per-tenant issuer replaces the shared one.

<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0007: Keep tokens in SPA memory

- Status: Accepted
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

Tenant users sign in in the SPA with authorization code flow and PKCE
(spec §3.5). The SPA then calls `/api/*` and `/agents/*` on its own origin.
In `single` mode the tenant router reads the tenant from the
`Authorization: Bearer` token (spec §3.3 step 5, ADR-0001), and the cell API
verifies that token (ADR-0005). Agent replies stream, and the SPA renders
them with `fetch` and a `ReadableStream` so the token goes in a header
(spec §7.2).

In `single` mode every tenant shares one browser origin, so storage and
service workers are shared across tenants (spec §7.3). A token written to
persistent storage would outlive a tenant switch or a sign-out on that
browser. The sample does not ship server-side rendering or a
backend-for-frontend (spec §1.2).

## Options considered

### Option 1: Tokens in memory, PKCE, bearer header

The SPA holds the access token in a JavaScript variable. No token is
written to `localStorage`, `sessionStorage` or cookies. Sign-in is a
full-page redirect to the issuer, which discards page memory, so the PKCE
verifier and the sign-in nonce are the exception: the origin that starts
the flow keeps them in `sessionStorage`, from the authorize redirect until
`/callback` reads and deletes them. They are single-use values, not
credentials, and `sessionStorage` is per tab and per origin.

Pros: no server-side session component. The router and the cell API read
the same bearer token, in both addressing modes. A browser never attaches
the token on its own, so a cross-site request carries no credential, and
Fetch Metadata refuses it at the edge as well (spec §7.3). No shared storage
in `single` mode holds anything for the next tenant.
Cons: a script that runs in the page can use the token while the page is
open. A page reload drops the token, and the SPA signs in again.

### Option 2: Backend-for-frontend with a `__Host-` cookie

A server component holds the tokens and gives the browser a `__Host-`
session cookie. It attaches the token to API calls.

Pros: the access token never reaches page script. Cons: a new stateful
component on the request path, per tenant cell or at the edge. The router
would have to read the tenant from a session it cannot decode, which breaks
the routing model of ADR-0001 and ADR-0005. Cookies bring CSRF back as a
concern. It is out of scope for this sample (spec §1.2).

## Decision

Option 1. Access tokens stay in SPA memory, obtained with authorization code
flow and PKCE, and the SPA sends them only in the `Authorization` header.
The PKCE verifier and the nonce live in `sessionStorage` on the origin that
starts sign-in until `/callback` deletes them. The router can
read the tenant from the token at the edge without trusting it (P-1), the
cell verifies the same token (P-4), and the shared origin in `single` mode
holds no tenant state. The risk of script in the page using the token is
handled by the browser baseline: a hash-based CSP with Trusted Types
(ADR-0008) and the no-HTML-strings rule (spec §7.2).

## Consequences

- Easier: no session store, no cookie handling, no CSRF tokens, no CORS.
  The same SPA works in `single` and `host` mode.
- Easier: sign-out clears memory, and `/logout` sends `Clear-Site-Data`
  (spec §7.1), so nothing is left on the browser.
- Harder: the SPA must clear its in-memory state when the user switches
  tenant or signs out (spec §7.2), and its tests cover that.
- Harder: a reload or a new tab needs a fresh sign-in redirect. The
  issuer's own session decides whether the user sees a prompt.
- Harder: `/callback` must delete the verifier and the nonce on every
  outcome, success or failure, so a stale value never serves a later
  sign-in.
- Follow-up: the demo SPA has no code path that writes a token to storage,
  and a unit test checks that storage holds no token and no verifier after
  sign-in.
- Revisit when the sample adds server-side rendering or a backend-for-frontend
  (spec §1.2), or when a tenant needs tokens kept out of page script.

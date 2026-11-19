# ADR-0041: Bind `RefreshToken`'s result to the path's user and tenant

- Status: Accepted
- Date: 2026-11-19
- Amends: ADR-0013
- Deciders: Dave Roberts (SA)

## Context
`RefreshToken` (`POST /platform/tenants/{tenantId}/users/{username}/token/refresh`,
the test aid of ADR-0006) runs the R-12 membership check on the path's user
(ADR-0013) and then `AdminInitiateAuth` with `REFRESH_TOKEN_AUTH` and the
body's refresh token. A refresh token names no user, and `REFRESH_TOKEN_AUTH`
takes no user name, so Cognito serves whoever the token belongs to. With the
membership check alone:

- in `shared-pool` and `shared-pool-multi-tenant`, tenant A's refresh token
  sent on tenant B's path, naming a real user of B, passes the check and
  returns A's own new tokens;
- in `pool-per-tenant`, the tenant's app client refuses another pool's
  token, but another user's refresh token from the same pool is served on
  any user's path.

ADR-0013 lists `RefreshToken` among the operations that stay inside the
path's tenant. The caller is the IAM-signed vendor, who can already issue a
token for any user, so no tenant's data is reached; the gap is that the route
does not keep the promise its path makes.

## Options considered
### Option 1: Compare the refreshed access token's `sub` and tenant claim with the path
After the refresh, decode the access token Cognito returned and require
`token_use=access`, a `sub` equal to the path user's `sub`, and a tenant
claim naming the path's tenant. Pros: `sub` is immutable and unique, and
does not depend on whether the path named the user by user name or e-mail
alias; `shared-pool` and `pool-per-tenant` already read the user with
`AdminGetUser` for R-12, so they need no extra call. Cons: one more
`AdminGetUser` in `shared-pool-multi-tenant`, whose R-12 check reads groups
only; the new tokens are minted before they are refused.

### Option 2: Compare the `username` claim instead of `sub`
Pros: no `AdminGetUser` needed in `shared-pool-multi-tenant`. Cons: the path
may name the user by e-mail alias, so the claim and the path differ for the
same user; matching would need the canonical user name anyway, which is the
same call.

### Option 3: Name the user in the refresh call
`REFRESH_TOKEN_AUTH` takes `REFRESH_TOKEN` and, for an app client with a
secret, a `SECRET_HASH` built from the user name. The app clients have no
secret, so there is no parameter that makes Cognito refuse another user's
token. Pros: none for this purpose. Cons: not available.

### Option 4: Verify the refreshed token's signature as well
Pros: rejects a token that did not come from the pool. Cons: the token is not
caller input; it came back from Cognito over TLS on the platform function's
own IAM-signed call, so a check adds a JWKS fetch per pool and proves
nothing that channel does not.

### Option 5: Remove `RefreshToken`
Pros: no route, no gap. Cons: the integration test needs it to show that
refresh re-runs the trigger (P-2, spec §10 steps 6 and 9), which is why
ADR-0006 has it.

## Decision
Option 1. After `REFRESH_TOKEN_AUTH`, each provisioner calls
`assertRefreshedFor` (`src/topology/cognito-users.ts`) with the path user's
`sub` and the topology's tenant claim: `tenant_id` in `shared-pool` and
`pool-per-tenant`, `tenants` containing the tenant in
`shared-pool-multi-tenant` (refresh mints an un-narrowed token, and narrowed
tokens carry no refresh token, M-12). The claims are read without a
signature check (Option 4 adds nothing). A mismatch answers the same 404
`ResourceNotFoundError`, with the same fixed text, as a non-member, and the
new tokens are discarded, never returned. A token that cannot be decoded is
a server fault (500), never served. An empty or missing `sub` on the user
record fails closed.

## Consequences
`RefreshToken` keeps the path's tenant promise in every topology. Unit tests
in `test/topology/*.test.ts` and `test/topology/cognito-users.test.ts` cover
the binding, and spec §10 step 6a runs another tenant's and another user's
refresh token end to end.

The discarded tokens are not revoked: the caller already holds the refresh
token they came from. The pre-token trigger logs "issued" for them, so that
log line means "minted", not "served".

The two 404s are not indistinguishable in time: a binding refusal comes back
after a full Cognito refresh and trigger run, a non-member refusal before
either. The timing tells the caller whether the path's user is a member of
the tenant. The same IAM caller can read that from `GetUser`, so this is
accepted.

An invalid refresh token, or another pool's token in `pool-per-tenant`, still
answers 409 from Cognito's refusal, before the binding runs; either way no
token is returned.

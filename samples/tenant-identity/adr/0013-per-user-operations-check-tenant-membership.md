# ADR-0013: Check that a user belongs to the path's tenant before any per-user platform operation

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
Per-user platform routes take both a tenant and a user:
`/platform/tenants/{tenantId}/users/{username}`. In `pool-per-tenant` the
tenant picks the pool, so a user of another tenant is simply not found. In
the shared pools every user lives in one pool, and a username is enough for
Cognito. As specified, `DeleteUser` for tenant A with a username from tenant
B would delete B's user in `shared-pool`; in `shared-pool-multi-tenant`,
`DeleteMembership` and `DeleteUser` would act on a user who is not in A, and
the test aids would issue tokens for B's user through A's path (threat model
T-16). The path names a tenant; the operation must stay inside it.

## Options considered
### Option 1: Trust the caller; the platform API is vendor-only
Pros: no extra Cognito calls. Cons: the path promises a tenant scope the
code does not keep. A vendor script with a wrong tenant id deletes another
tenant's user, which is the cross-tenant mistake the sample teaches against.
### Option 2: Drop the tenant from per-user paths
Pros: the API says what it does. Cons: loses the tenant context the
provisioner needs in topology 1, and breaks one contract across topologies
(P-1).
### Option 3: The provisioner checks membership first and answers 404 when the user is not in the tenant
Pros: one rule in every topology, inside the provisioner where topology
knowledge already lives (P-1). 404, not 403, so the vendor API does not say
whether the user exists in another tenant. Cons: one extra Cognito read per
call (`AdminGetUser` or `AdminListGroupsForUser`).

## Decision
Option 3. Every per-user operation except `CreateUser` and `CreateMembership`
(`DeleteUser`, `DeleteMembership`, `IssueToken`, `RefreshToken`) first asks
the provisioner whether the user belongs to the tenant. Topology 1: the user
exists in the tenant's pool. Topology 2: `custom:tenantId` equals the path's
tenant. Topology 3: the user is in group `t-<tenantId>`. If not, the call
fails with `ResourceNotFoundError` (404) and changes nothing. `CreateMembership`
is the one operation that crosses tenants by design; it is vendor intent and
topology 3 only.

## Consequences
Easier: a wrong tenant id in a vendor call cannot reach another tenant's
users; the rule is testable once in the shared scenario. Harder: one more
Cognito read per call, inside Cognito's admin API quotas at vendor scale;
the platform role needs `AdminGetUser` and `AdminListGroupsForUser`, scoped
like its other actions (N-3). The check and the action are two calls, so a
concurrent membership change can race them; at vendor scale that is
accepted.

## Amendment 2026-11-19: bind RefreshToken's result to the path's user and tenant

Found by the W-6 stress slice (PR #64). `RefreshToken` checked that the
path's user is a member of the path's tenant, then ran `REFRESH_TOKEN_AUTH`
with the body's refresh token. That token names no user, so tenant A's
refresh token sent on tenant B's path with a real user name of B passed the
check and returned A's own new tokens. In `pool-per-tenant` the tenant's app
client already refuses another pool's token, but another user's refresh
token from the same pool was served on any user's path. The decision above
lists `RefreshToken` and says the operation stays inside the path's tenant;
the membership check alone did not keep that promise.

This amendment completes the decision for `RefreshToken`:

- After the refresh, the provisioner compares the returned access token's
  `sub` with the path user's `sub` and checks the token's tenant claim
  (`tenant_id` in topologies 1 and 2, `tenants` contains the tenant in
  topology 3). `sub` is used, not the `username` claim: it is immutable and
  unique, and it does not depend on whether the path named the user by
  username or by e-mail alias. It costs no extra call in topologies 1 and 2
  (the R-12 `AdminGetUser` already returns it) and one `AdminGetUser` in
  topology 3, whose R-12 check reads groups only.
- The claims are read without a signature check. The token is not caller
  input: it came back from Cognito in this call, over TLS, on the platform
  function's own IAM-signed `AdminInitiateAuth`. Verifying it again would
  add a JWKS fetch per pool and prove nothing that channel does not. A token
  that cannot be decoded is a server fault (500), never served.
- On a mismatch the call answers the same 404 `ResourceNotFoundError`, with
  the same fixed text, as a non-member: nothing says the token was someone
  else's. The new tokens are discarded, never returned. They are not
  revoked: the caller already holds the refresh token they came from.

Unit tests in `test/topology/*.test.ts` cover a foreign tenant's token, another
user's token in the same tenant, and the user's own token in each topology;
spec §10 step 6a runs the cross-tenant case end to end. The pre-token trigger still logs "issued" for a refreshed token the binding then discards; read that log line as "minted", not "served".

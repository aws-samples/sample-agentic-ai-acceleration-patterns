# ADR-0043: Accept listed client ids when a token has no audience

- Status: Proposed
- Date: 2026-11-14
- Amends: ADR-0004
- Deciders: Dave Roberts (SA)

## Context
The authorizer verifies one `audience` (ADR-0004) and requires `sub` and
`role` (ADR-0018). A person's Cognito ID token carries `aud`, so operators
and readers pass. A machine client does not. The `tenant-front-door`
route registrar reads placement with a reader token from its own app
client, through the OAuth client credentials flow. A Cognito
client-credentials access token carries `client_id`, `scope`, `sub` (equal
to `client_id`) and no `aud`, and Cognito returns no ID token for that
flow. The audience check therefore refuses every machine client on a
Cognito vendor IdP.

Spike S-9 of `tenant-front-door` (2026-11-13) measured it. Today's
authorizer denied the token. A pre-token-generation trigger (V3 event, on
the Essentials feature plan) added `role: control-plane:reader`, but
Cognito ignored the trigger's `aud` override. A check that accepted a
listed `client_id` when `aud` was absent allowed the same token with the
reader grant. The issuer cannot supply `aud`, so the control plane must
accept something in its place.

## Options considered
### Option 1: A list of client ids, used only when a token has no `aud`
A new optional stack input, `vendorIdp.clientIds` (default none). A token
that carries `aud` is checked against `audience`, exactly as today. A token
without `aud` passes that step only when its `client_id` claim is in the
list and equals `sub`, so the client acts as itself and a person's access
token issued through that client is refused. Signature, issuer, `exp`,
`sub` and `role` are checked as before in both cases. Pros: off by
default, so an existing deployment admits no new caller; names exactly
the clients the deployer trusts, the same thing an audience does for ID
tokens; `client_id` is the claim RFC 9068 §2.2 defines for the client
(the same section requires `aud`, which Cognito leaves out, hence the
need); one path per token, never two tries. Cons: a second
list to review beside the issuer's client registrations; a deployer can
list a client that serves a broader population.

### Option 2: Require a custom scope instead of an audience
The deployer names a resource-server scope (`control-plane/read`) that a
token without `aud` must carry. Pros: the OAuth way to say "this token is
for this API". Cons: any client on the issuer can be granted the scope by
configuration, so the scope does not name a client; it is a second
authorization claim beside `role`, which already chooses the grant; a
person's access token rarely carries custom scopes.

### Option 3: Treat `client_id` as an audience
Pass `audience` and the client ids to the JWT library as one list and copy
`client_id` into `aud` before the check. Pros: one input. Cons: mixes two
claims with different meaning; a token minted for another app whose `aud`
happens to equal a listed client id would pass; the input name stops
saying what it holds.

### Option 4: Admit only the reader grant through a client id
As option 1, but a token admitted by `client_id` may hold only the reader
grant. Pros: a leaked machine secret can never change the fleet. Cons:
couples how a token is identified to what it may do; blocks a CI pipeline
that runs operator calls with its own client; `role` and `readerRoles`
already decide the grant (R-36).

## Decision
Option 1. `vendorIdp.clientIds` lists the client ids accepted when a token
has no `aud`, and the token's `sub` must equal its `client_id`. It
defaults to none, so nothing changes until a deployer names one. The
token is verified once without an audience, then one path is taken on the
payload: any `aud` key, even `[]`, `""` or `null`, takes the audience
path, unchanged from today, and never falls back to the client id path. The grant still comes from `role`
alone. The issuer must still mint `role` for the machine client; on
Cognito that is a V3 pre-token-generation trigger, which needs the
Essentials or Plus feature plan. That is the vendor IdP's configuration,
not this stack's.

## Consequences
- A machine client with a listed id and a role in `readerRoles` reads the
  fleet; with a role in `allowedRoles` it operates it. The
  `tenant-front-door` registrar becomes possible (its ADR-0015).
- The caller's `sub` is the client id, so the access log and every build's
  `OPERATOR_ID` name the client, not a person (M12 still holds).
- A listed client that serves a broader population widens access the way
  a shared audience does (T20). The list is reviewed with the issuer's
  client registrations (M9).
- A machine client's secret lasts until rotated and has no second
  factor, so a leak is bounded by rotation, not by token lifetime (T38).
  Machine clients get the reader role unless they must operate.
- The integration test's vendor IdP moves to the Essentials plan, a user
  pool domain and a V3 trigger, and adds a resource server with one scope
  and two machine clients with secrets, one listed in `clientIds`. Step 1
  proves the listed client's token reads and is refused on writes, and
  that the unlisted client's token gets 403. A unit test covers what
  Cognito cannot mint: a failing `aud` with a listed `client_id`,
  malformed `aud` values, and a person's access token from a listed
  client.
- Spec changes: R-2, §3.2 (new R-38), §3.3 (`vendorIdp.clientIds`), the §5
  error table, §10 and step 1. Threat model: T20, M9, M12 and M13
  widened, new T37, T38 and M27.
- This record lands in one PR with the code. That PR also sets it to
  Accepted, adds a dated "Amended by ADR-0043" note to ADR-0004, and
  updates the README (context input, example, Identity checklist),
  `integration-test.md`, and `architecture.md`, which describes only what
  is built.
- Revisit if the vendor IdP can set `aud` on access tokens, or a deployer
  needs a client admitted with a narrower grant than its role names.

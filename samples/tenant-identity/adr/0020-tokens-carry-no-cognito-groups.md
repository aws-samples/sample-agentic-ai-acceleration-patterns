# ADR-0020: Remove `cognito:groups` from every token the trigger issues

- Status: Accepted
- Date: 2026-10-22
- Deciders: Dave Roberts (SA)

## Context
ADR-0003 says the access token carries no groups unless the trigger adds
them, and decides that the trigger makes no group overrides. That premise is
wrong: Cognito writes `cognito:groups` into the access token as well as the
ID token. The sample's groups are `t-<tenantId>` (topology 3) and
`admin-<tenantId>` (every topology). So every token, including a token
narrowed to one tenant, listed every tenant and admin role the user held.
That breaks the P-6 contract ("nothing else is added: no roles") and undoes
narrowing (P-10) for any service that reads the groups. A blind security
review found it on 2026-10-22.

## Options considered
### Option 1: Override the groups with none on every token
Pros: one rule, every topology; the token contract is exactly P-6. Cons: a
client that read `cognito:groups` from the ID token loses it. The sample has
no such client, and the claims a client needs are in the access token.
### Option 2: Override the groups only on narrowed tokens
Pros: un-narrowed tokens keep Cognito's default. Cons: un-narrowed tokens
still name every admin role, which no consumer needs, and the contract
differs between narrowed and un-narrowed tokens.
### Option 3: Keep the groups and document them as part of the contract
Pros: no change. Cons: narrowing would grant nothing in topology 3, the
sample's main subject.

## Decision
Option 1. The trigger sets `groupOverrideDetails.groupsToOverride = []` on
every issuance. Everything else in ADR-0003 stands: one V2 trigger attached
to every pool, the tenant claim and sample scopes on the access token only,
and the trigger as the only code that decides what tenant identity a token
carries. The trigger still reads the event's input groups
(`groupConfiguration`) to work out tenants and the admin scope; the
override changes only the output.

## Consequences
Easier: the token holds exactly the P-6 claims, so narrowing means the same
in every topology. Unit tests check the override on every path, and the e2e
checks that no token it verifies carries `cognito:groups`. Harder: a
consumer that wanted group names must use the tenant claim and scopes
instead. Revisit if a later sample needs roles in the token; it would add a
narrowed `roles` claim, not Cognito's raw groups.

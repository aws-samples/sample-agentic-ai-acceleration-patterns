# ADR-0039: Keep the sample's exchange endpoint, because Cognito token exchange cannot pick a tenant

- Status: Accepted
- Date: 2026-11-17
- Amends: ADR-0009, ADR-0012
- Deciders: Dave Roberts (SA)

## Context
ADR-0009 and ADR-0012 say to revisit if Cognito adds a native token-exchange
grant. Amazon Cognito user pools offer OAuth 2.0 Token Exchange (RFC 8693)
through `GetDerivedToken` and the `/oauth2/token` token-exchange grant, on
the Essentials or Plus feature plan
([developer guide](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-token-exchange.html),
[API reference](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_GetDerivedToken.html)).
The subject token can be an access token or an ID token. The issued token's
scopes are the intersection of the requested scopes, the subject token's
scopes and the app client's scopes. It carries no refresh token, is bound
to at most one audience or one resource (a resource server registered in
the pool), and names the caller in `act` when an actor token is presented.
The pre token generation trigger runs with `TokenGeneration_TokenExchange`
and receives the user's attributes; it can add, suppress or override
claims, but cannot add scopes. `GetDerivedToken` takes no `ClientMetadata`.

The sample's exchange exists to turn a token that lists every tenant of the
user (`tenants`, P-6) into one that names one tenant (`tenant_id`).

## Options considered
### Option 1: Replace the endpoint with Cognito token exchange
Pros: no endpoint to run; an access token can be the subject, so a service
could narrow a token it received; `act` and audience come built in. Cons: the request has no field the
trigger can read to pick a tenant. `ClientMetadata` is not accepted, and
both `Audiences` and `Resources` must name a registered resource server, so
naming the tenant there needs a resource server per tenant, with 100 per
pool by default and 300 at most. The trigger sees the user, who in
`shared-pool-multi-tenant` belongs to every tenant of their `t-<id>` groups,
not the one asked for. Scopes narrow; the tenant does not.
### Option 2: Keep the endpoint over `GetTokensFromRefreshToken` (ADR-0009 Option 3)
Pros: the tenant is named in `resource`, passed to the trigger in
`ClientMetadata`, and checked after issue (ADR-0012); works in all three
topologies. Cons: unchanged from ADR-0009: only the refresh-token holder
can narrow, and there is no `act` claim.

## Decision
Option 2. Cognito token exchange narrows scopes and audience, but the
sample's job is narrowing the tenant, and the exchange request cannot carry
it. The sample's app clients do not enable `ALLOW_TOKEN_EXCHANGE_IMPERSONATION`
or `ALLOW_TOKEN_EXCHANGE_DELEGATION`, so `GetDerivedToken` is refused on
them, and the pools have no domain, so the `/oauth2/token` route does not
exist. A unit test keeps both flows off the shared-pool client.

## Consequences
No runtime code changes. The README's "What this is NOT" and the spec's §11
delegation row name Cognito token exchange as the source of delegation and
audience binding. Threat model M-12 depends on the exchange flows staying
off, because the app clients are public: with the flows on, anyone holding
a narrowed token could exchange it. The trigger does not branch on
`triggerSource`, so on a `TokenGeneration_TokenExchange` event it gets no
`clientMetadata` and takes the un-narrowed path. In
`shared-pool-multi-tenant` it then either emits every active tenant in
`tenants`, widening the token, or refuses the exchange if the event carries
no groups. It never narrows. Enabling the flows needs a trigger change and
an integration test first. Revisit if `GetDerivedToken` accepts `ClientMetadata` or another
field the trigger can read, which would let Option 1 name the tenant.

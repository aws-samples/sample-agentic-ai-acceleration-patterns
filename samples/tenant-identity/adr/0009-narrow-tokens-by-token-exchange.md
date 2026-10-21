# ADR-0009: Narrow tokens by RFC 8693 token exchange, with Cognito re-issuing the token

- Status: Accepted
- Date: 2026-10-20
- Deciders: Dave Roberts (SA)

## Context
In `shared-pool-multi-tenant` a user's access token names every tenant the
user belongs to (`tenants`, P-6). A service that acts for one tenant then
holds a token that is valid for all of them. If that service leaks the
token, every tenant the user belongs to is exposed, and the service has to
be trusted to pick the right tenant from the array on every request. Least
privilege asks for a token that names one tenant and only the scopes the
call needs, obtained before the call, so the multi-tenant token never
reaches the service. OAuth 2.0 Token Exchange (RFC 8693) is the standard
shape for "give me a narrower token for this one target". Cognito has no
token-exchange grant. `GetTokensFromRefreshToken` accepts `ClientMetadata`
and invokes the pre-token-generation trigger; re:Post reports that the
older `REFRESH_TOKEN_AUTH` flow of `InitiateAuth` / `AdminInitiateAuth` does
not pass `ClientMetadata` to that trigger.

## Options considered
### Option 1: Leave it to the consumer to pick a tenant from `tenants`
Pros: nothing to build. Cons: the multi-tenant token reaches every service,
which is the exposure this decision exists to remove.
### Option 2: Our own exchange endpoint that verifies the access token and signs a new JWT with a KMS key
Pros: the subject token can be an access token, so a service could narrow a
token it received; the full RFC 8693 surface, including the `act` claim for
delegation. Cons: a second issuer and JWKS that every consumer must trust;
key management and rotation; the endpoint becomes a token consumer
(ADR-0007) and the most privileged part of the sample; it undercuts the
spec's argument that Cognito is the trusted source of tenant identity (§1).
### Option 3: An RFC 8693 endpoint over Cognito, with the refresh token as subject token
The endpoint accepts `subject_token_type =
urn:ietf:params:oauth:token-type:refresh_token`, calls
`GetTokensFromRefreshToken` with the requested tenant and scopes in
`ClientMetadata`, and the trigger narrows the claims (ADR-0010). Pros:
Cognito signs the narrowed token, so there is one issuer and consumers
change nothing; the endpoint holds no privilege, because the trigger
enforces the narrowing; offboarding at issuance (P-2) applies to narrowed
tokens unchanged. Cons: only the holder of the refresh token, the client,
can narrow; a service that received a broad access token cannot. The design
depends on `ClientMetadata` reaching the trigger through
`GetTokensFromRefreshToken`, which the integration test must prove. Refresh
token rotation must stay off, or each exchange would invalidate the client's
refresh token. Every exchange is a Cognito call and a trigger invocation.
### Option 4: Narrow at sign-in by passing `ClientMetadata` to `InitiateAuth`
Pros: no endpoint (the former §11 seam). Cons: one tenant per session;
switching tenant needs a new sign-in with the password; a client that calls
services for different tenants cannot use it.

## Decision
Option 3. The client narrows before it calls, so the broad token never
leaves it, and Cognito stays the only signer. The wire format is RFC 8693
§2: refresh token in, `urn:ietf:params:oauth:token-type:access_token` out,
the tenant named as `resource = urn:tenant-identity:tenant:<ULID>`, the
scopes as `scope`. The response carries the access token only, with no
refresh token, so the narrowing cannot outlive the access-token lifetime
(N-1). Narrowing works in all three topologies (P-1). In topologies 1 and 2
the tenant can only be the one the user already has, so in practice only the
scopes narrow.

## Consequences
Easier: a single-tenant service can require `tenant_id` and its scope and
reject every multi-tenant token, in every topology. No new trust anchor.
Harder: clients exchange before calling a tenant service and may reuse the
narrowed token for its five-minute lifetime. A service cannot narrow a token
on its own. App clients are pinned to refresh-token rotation off (R-6).
Exchange traffic counts against Cognito's request-rate quotas. Revisit if
Cognito adds a native token-exchange grant, or if a delegation use case needs
the `act` claim. Either one leads back to Option 2 or to a managed exchange
service.

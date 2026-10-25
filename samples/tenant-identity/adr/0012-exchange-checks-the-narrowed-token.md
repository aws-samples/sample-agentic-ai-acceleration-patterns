# ADR-0012: Make the exchange endpoint check that Cognito actually narrowed the token

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
The exchange endpoint passes the narrowing request to Cognito in
`ClientMetadata` on `GetTokensFromRefreshToken`, and the trigger applies it
(ADR-0009, ADR-0010). If the function only mapped Cognito's outcome,
narrowing would depend on one Cognito behaviour: `ClientMetadata`
reaching the trigger on refresh. The documentation says it does; older
re:Post threads say the earlier refresh flow dropped it. If it is dropped,
the trigger sees no narrowing request and issues a full token: `tenants`
for every tenant in topology 3, both scopes, and
`aws.cognito.signin.user.admin`. The endpoint would return that token with
a 200 that claims it is narrowed. Narrowing would fail open, silently
(threat model T-17).

## Options considered
### Option 1: Rely on the integration test
Pros: no extra code. Cons: the test proves the behaviour on one day in one
Region. A later Cognito change, or a pool configuration that differs, fails
open in production with nothing to notice it.
### Option 2: The endpoint verifies the returned token against the JWKS
Pros: a full check. Cons: the endpoint becomes a token consumer, needs the
issuer per topology (a registry read in topology 1, so DynamoDB permissions),
for no gain: the token came straight from Cognito over
TLS, so its signature is not in question, only its content.
### Option 3: The endpoint decodes the returned token's payload and compares it to the request
Pros: a few lines, no permissions (R-7 holds), no network call. Catches the
failure in every topology: a narrowed token never carries
`aws.cognito.signin.user.admin`, so an un-narrowed token always fails the
scope comparison, even in topologies 1 and 2 where the tenant is already
single. Cons: the endpoint parses a JWT payload without verifying it, which
a reader could copy into a place where it is not safe.

## Decision
Option 3. After Cognito returns, the function base64url-decodes the access
token's payload and refuses unless all hold: `token_use` is `access`;
`tenant_id` is present and equals the requested tenant (when one was
requested); there is no `tenants` claim; the `scope` set equals the
requested set. On a mismatch it returns 500 `{error: "server_error"}`,
discards the token, and logs the rule that failed, never the token (N-4,
N-6). The code comment says why skipping the signature is safe here and
nowhere else: the token was received from Cognito in this invocation. The
trigger stays the enforcement point; this check catches the trigger not
being asked.

## Consequences
Easier: narrowing fails closed even if Cognito's `ClientMetadata` behaviour
changes; a failure shows up as 500s and a log line, not as wide tokens.
Harder: the function carries a small JWT payload parser and a unit test
that feeds it un-narrowed tokens. Direct callers of
`GetTokensFromRefreshToken` do not get this check; for them the trigger is
the only guard, which is the behaviour the integration test proves (§10
step 7). Revisit if Cognito adds a native token-exchange grant.

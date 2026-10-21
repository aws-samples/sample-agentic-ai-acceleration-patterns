# ADR-0012: Provide `IssueToken` and `RefreshToken` test-aid routes, and return the refresh token

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)
- Supersedes: ADR-0006

## Context
ADR-0006 added `POST /platform/tenants/{t}/users/{u}/token` so the
integration test and the README demo can obtain real Cognito tokens for
synthetic users in every topology, without a browser, a hosted UI domain, or
a client secret. It constrained the response to the access token only, never
the ID or refresh token.

Two later needs break that constraint:

- Token exchange (ADR-0009) takes the user's refresh token as the subject
  token. The test is the client (spec §3.2), so it must hold a refresh token.
- Offboarding is enforced at issuance (ADR-0010), and refresh re-runs the
  trigger. The test proves this by refreshing after `DeleteTenant` (spec §10
  steps 6 and 7), which also needs the refresh token and a route that uses it.

The spec already describes both routes this way (§5.1); the record did not.

## Options considered
### Option 1: Keep ADR-0006; the test calls `AdminInitiateAuth` itself for refresh tokens
Pros: the deployed route stays access-token-only. Cons: the same reason
ADR-0006 rejected direct calls: the test must know each topology's pool and
client ids, which breaks "same test code against all three stacks" (§10).
### Option 2: `IssueToken` returns access, ID, and refresh tokens; add a `RefreshToken` test aid
Pros: one call gives the test everything sign-in gives a real client; the
refresh route uses `AdminInitiateAuth` with `REFRESH_TOKEN_AUTH`, so the test
shows the trigger re-running without knowing pool ids. Cons: the test aid now
hands out a credential that lasts 1 day (N-1) instead of 5 minutes, and that
can be exchanged (ADR-0009).
### Option 3: Return a refresh token from `IssueToken`, but do refresh only through `POST /oauth2/token`
Pros: one test aid route instead of two. Cons: the exchange endpoint always
narrows, so it cannot show that a plain refresh returns the un-narrowed token
(§10 step 6a) or that refresh fails after offboarding in every topology.

## Decision
Option 2. ADR-0006's other constraints carry over unchanged: both routes are
named test aids in the Smithy model's documentation, the README, and the
hardening checklist ("remove before production"); both sit on the
IAM-protected platform API (ADR-0005); the password is the caller-supplied
value. `IssueToken` returns `{accessToken, idToken, refreshToken, expiresIn}`.
`RefreshToken` takes `{refreshToken}` and returns `{accessToken, idToken,
expiresIn}`. Neither route logs any token.

## Consequences
Easier: the test drives sign-in, refresh, exchange, and offboarding through
one API in every topology. Harder: the accepted test-aid risk in the threat
model grows. A caller with the vendor's IAM permission can mint a refresh
token for any user, which is valid for a day and can be exchanged for any
tenant that user holds. A real deployment must delete both routes. Revisit if
the repo gains a shared test-identity helper that samples can import instead.

# ADR-0006: Provide `IssueToken` and `RefreshToken` test-aid routes on the platform API

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
The integration test and the README demo must obtain real Cognito tokens
for synthetic users in every topology, without a browser, a hosted UI
domain, or a client secret. Login UI and federation are out of scope (spec
§1.2). The test is also the client (spec §3.2): it needs a refresh token to
exchange (ADR-0009), and it must refresh after `DeleteTenant` to show that
refresh re-runs the trigger (ADR-0008, spec §10 steps 6 and 9).

## Options considered
### Option 1: Test code calls Cognito directly (`AdminInitiateAuth` from the test)
Pros: nothing added to the deployed API. Cons: the test must know each
topology's pool and client ids (per tenant in `pool-per-tenant`), which
re-implements provisioner knowledge in the test and breaks "same test code
against all three stacks" (spec §10).
### Option 2: Hosted UI with a test browser (Playwright)
Pros: realistic. Cons: a domain per pool, a headless browser in the test
runner, minutes added per topology; out of scope by §1.2.
### Option 3: `IssueToken` and `RefreshToken` routes on the IAM-protected platform API
Pros: the platform function already knows the topology's pool for a tenant.
`AdminSetUserPassword` (permanent) then `AdminInitiateAuth` with
`ADMIN_USER_PASSWORD_AUTH` returns tokens with no client secret, and
`REFRESH_TOKEN_AUTH` refreshes them. One API serves the test in every
topology. Cons: the deployed API holds routes that mint tokens, including
1-day refresh tokens (N-1), for any user, protected only by the vendor's IAM
permission.
### Option 4: `IssueToken` only; refresh through `POST /oauth2/token`
Pros: one test-aid route instead of two. Cons: the exchange always narrows,
so it cannot show that a plain refresh returns the un-narrowed token (spec
§10 step 7) or that refresh fails after offboarding in every topology.

## Decision
Option 3. `IssueToken` returns `{accessToken, idToken, refreshToken,
expiresIn}`; `RefreshToken` takes `{refreshToken}` and returns
`{accessToken, idToken, expiresIn}`. Both routes are named test aids in the
Smithy model's documentation, the README, and the hardening checklist
("remove before production"). Both sit on the IAM-protected platform API
(ADR-0005) and run the membership check (ADR-0013). The password is the
caller-supplied value, so the test never sees Cognito's temporary password.
Neither route logs a token.

## Consequences
Easier: the test drives sign-in, refresh, exchange, and offboarding through
one API in every topology; the README demo is three commands. Harder: a
caller with the vendor's IAM permission can mint a refresh token for any
user, valid for a day and exchangeable for any tenant that user holds. The
threat model lists this as an accepted risk scoped to the sample (T-6), and
a real deployment must delete both routes. Revisit if the repo gains a
shared test-identity helper that samples can import instead.

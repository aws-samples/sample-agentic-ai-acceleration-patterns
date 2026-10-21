# ADR-0006: Provide a server-side `IssueToken` route as a test aid, and label it as such

- Status: Superseded by ADR-0012
- Date: 2026-10-13
- Deciders: Dave Roberts (SA)

## Context
The integration test and the README demo must obtain real Cognito access
tokens for synthetic users in every topology, without a browser, a hosted UI
domain, or a client secret. Login UI and federation are out of scope (spec
§1.2). The sample still has to prove end-to-end that a token issued by the
pool resolves correctly.

## Options considered
### Option 1: Test code calls Cognito directly (`AdminInitiateAuth` from the integ test)
Pros: nothing added to the deployed API. Cons: the test must know each
topology's pool and client ids (per tenant in `pool-per-tenant`), which
re-implements provisioner knowledge in the test and breaks "same test code
against all three stacks" (spec §10).
### Option 2: Hosted UI with a test browser (Playwright) in the integ test
Pros: realistic. Cons: a domain per pool, a headless browser in the test
runner, minutes added per topology; out of scope by §1.2.
### Option 3: `POST /platform/tenants/{t}/users/{u}/token` on the IAM-protected platform API
Pros: the platform function already knows the topology's pool for a tenant;
`AdminSetUserPassword` (permanent) then `AdminInitiateAuth` with
`ADMIN_USER_PASSWORD_AUTH` returns tokens with no client secret; the test and
the README demo use one call. Cons: a route that mints tokens for any user
exists in the deployed API, protected only by the vendor's IAM permission.

## Decision
Option 3, with three constraints: the route is named a test aid in the
Smithy model's documentation, the README, and the hardening checklist ("remove
before production"); the password is set to the caller-supplied value so the
test never sees Cognito's temporary password in a log; the response carries
the access token only, never the ID or refresh token.

## Consequences
Easier: one scenario proves sign-in and resolution in every topology; the
README demo is three commands. Harder: a real deployment must delete the
route; the threat model lists it as an accepted risk scoped to the sample
(T-6). Revisit if the repo gains a shared test-identity helper that samples
can import instead.

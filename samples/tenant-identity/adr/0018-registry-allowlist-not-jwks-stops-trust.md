# ADR-0018: Rely on the registry allowlist, not a vanished JWKS, to stop trust in a deleted pool

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
Spec §7.1 said that deleting a `pool-per-tenant` pool makes its JWKS
endpoint disappear, so verifiers stop trusting its tokens. The first
integration run showed otherwise. A probe on 2026-10-21 in eu-central-1
created a pool, deleted it, and fetched
`https://cognito-idp.eu-central-1.amazonaws.com/<pool>/.well-known/jwks.json`
at 0, 30, 120 and 300 seconds (cumulative) after deletion: every fetch returned 200 with
the pool's keys.

## Options considered
### Option 1: Keep the claim and wait in the test until the JWKS goes away
Cons: no documented time bound; the test would be flaky or slow, and the
README would promise something Cognito does not do.
### Option 2: The registry is the allowlist that stops trust
`DeleteTenant` removes the tenant, and its issuer, from the registry.
A consumer that checks the issuer against `ListTenants` (spec §1.2, §4.1)
stops trusting the pool at once. A consumer that checks signatures only
keeps trusting outstanding access tokens until they expire (N-1, 5
minutes); no new token can be issued, because the pool is gone.

## Decision
Option 2. The integration test asserts that A's issuer is gone from
`ListTenants` and that `DescribeUserPool` answers `ResourceNotFound`. It
still asserts that a pre-deletion token verifies against cached keys.

## Consequences
Easier: the sample states only what Cognito does. Harder: the property
weakens from "the issuer disappears" to "the issuer leaves the
allowlist"; a consumer must use the registry to get it. The README's
consumer guidance and hardening checklist must say so. Revisit if Cognito
documents JWKS removal on pool deletion.

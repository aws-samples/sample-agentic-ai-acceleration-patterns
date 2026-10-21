# ADR-0016: Verify tenant tokens in one Lambda authoriser for `/tenant/*`; other consumption stays out of scope

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)
- Supersedes: ADR-0007

## Context
ADR-0007 removed every token consumer from the sample and said a consumer
would be its own sample. Tenant-admin user management (ADR-0015) needs one
consumer: the `/tenant/*` routes must verify a tenant admin's access token
before acting. The rest of ADR-0007 still holds: the sample does not build
consumers for the services a tenant's users call, and the integration test
still verifies tokens with its own library.

The route must work the same way in all three topologies (P-1). In
`pool-per-tenant` every tenant has its own issuer, so the set of trusted
issuers grows with onboarding.

## Options considered
### Option 1: HTTP API JWT authoriser
Pros: no code. Cons: one issuer per authoriser. Works for `shared-pool*`,
not for `pool-per-tenant`, so topology-specific wiring leaks into the API
(P-1). Cannot check tenant status.
### Option 2: REST API with a Cognito user-pool authoriser
Pros: no code; takes a list of pools. Cons: the list is fixed at deploy
time, so onboarding a tenant in `pool-per-tenant` means redeploying the
API; the sample's API is an HTTP API (R-1). Cannot check tenant status.
### Option 3: One HTTP API Lambda authoriser that reads the registry
Pros: one code path for all topologies; the registry is already the issuer
allowlist for `pool-per-tenant` (§4.1); it can refuse a tenant that is not
`ACTIVE`, so offboarding takes effect on this route at once instead of
after the access-token lifetime. Cons: verification code in the sample,
and a registry read per request on this route.

## Decision
Option 3, with result caching off so the bound stays the token's own
lifetime. The authoriser verifies the signature against the issuing pool's
JWKS (`aws-jwt-verify`); requires `token_use` `access`, the pool's app
client, a `tenant_id` claim, no `tenants` claim, and scope
`tenant-admin/users`; and checks that the tenant is `ACTIVE` and, in
`pool-per-tenant`, that the registry maps the issuing pool to that same
tenant. It passes only `tenantId` and `sub` to the function. Its role reads
the registry and nothing else. The per-request status read that ADR-0007
argued against is accepted here because the route changes identity: it is
rare, and acting for a deleted tenant is the worst outcome it can have.

## Consequences
Easier: a reader sees a complete consumer for the one route family whose
job is identity, written against the claims of P-6. Harder: the sample owns
verification code and its tests; the README must say this authoriser is a
pattern for `/tenant/*`, not a general consumer for services the tenant's
users call (still a seam, §11). Revisit if API Gateway HTTP API JWT
authorisers gain multiple issuers.

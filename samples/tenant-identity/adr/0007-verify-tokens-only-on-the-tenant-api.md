# ADR-0007: Verify tokens only on `/tenant/*`, in one Lambda authoriser; build no consumer for tenant services

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
The sample's subject is how Cognito carries tenant identity: three ways to
overlay a tenant onto a user pool, the provisioning that creates each, and
the trigger that puts the result into the access token. How a service that
tenant users call verifies the token and scopes a request is the consumer's
design (spec §1.2). One route family is identity work, though: the tenant
admin API (ADR-0014), which must verify a narrowed admin token before it
changes users.

The verifier must work the same way in all three topologies (P-1). In
`pool-per-tenant` every tenant has its own issuer, so the set of trusted
issuers grows with onboarding.

## Options considered
### Option 1: A general consumer, such as an `/app/*` route with in-function verification
Pros: a reader sees a service receive the tenant. Cons: the consumer grows
into a large part of the design (resolution rules, a status cache, a tenant
selection header), and puts a per-request lookup on the hot path, which the
spec's argument for Cognito as the trusted source rejects (§1). The sample
would be judged on a part that is not its subject.
### Option 2: HTTP API JWT authoriser on `/tenant/*`
Pros: no code. Cons: one issuer per authoriser. Works for `shared-pool*`,
not for `pool-per-tenant`, so topology-specific wiring leaks into the API
(P-1). Cannot check tenant status.
### Option 3: REST API with a Cognito user-pool authoriser
Pros: no code; takes a list of pools. Cons: the list is fixed at deploy
time, so onboarding a tenant in `pool-per-tenant` means redeploying the API;
the sample's API is an HTTP API (R-1). Cannot check tenant status.
### Option 4: One HTTP API Lambda authoriser on `/tenant/*` that reads the registry
Pros: one code path for all topologies; the registry is already the issuer
allowlist for `pool-per-tenant` (§4.1); it can refuse a tenant that is not
`ACTIVE`, so offboarding takes effect on this route at once. Cons:
verification code in the sample, and a registry read per request on this
route.

## Decision
Option 4, for `/tenant/*` only. The authoriser has result caching off. It
verifies the signature against the issuing pool's JWKS (`aws-jwt-verify`);
requires `token_use` `access`, the pool's app client, a `tenant_id` claim,
no `tenants` claim, and scope `tenant-admin/users`; and checks that the
tenant is `ACTIVE` and, in `pool-per-tenant`, that the registry maps the
issuing pool to that same tenant. It passes only `tenantId` and `sub` to the
function. Its role reads the registry and nothing else. The per-request
status read is accepted here because the route changes identity: it is
rare, and acting for a deleted tenant is the worst outcome it can have.

No other consumer is built. The integration test verifies every other token
with `aws-jwt-verify` against the issuer the registry or the published
parameters name; that is test code, and the README says so. The consumer
options for tenant services are an extension seam (spec §11).

## Consequences
Easier: the sample stops at its subject, the token, and shows one complete
verifier for the route family whose job is identity. Harder: the sample owns
verification code and its tests; the README must say this authoriser is a
pattern for `/tenant/*`, not a general consumer; `pool-per-tenant`
consumers must manage a growing issuer allowlist, which the spec states as a
comparison dimension rather than solving. Revisit if HTTP API JWT
authorisers gain multiple issuers, or if a consumer sample is wanted (its
own sample, not an addition to this one).

# ADR-0007: Authenticate the vendor to the platform API with IAM, not a vendor IdP

- Status: Accepted
- Date: 2026-10-13
- Deciders: Dave Roberts (SA)

## Context
The platform API (`/platform/*`) onboards tenants and manages users. The
vendor (the operator, §1.1) calls it. The `control-plane` sample answers the
vendor identity question with an external IdP (issuer and audience by context) and
a Lambda authorizer; this sample's subject is tenant identity, and a second
IdP would double the identity surface the reader has to understand.

## Options considered
### Option 1: Vendor IdP with a JWT, as in `control-plane`
Pros: same vendor experience across samples. Cons: a deployer needs an IdP
before deploying an identity sample; the authorizer and its tests are a copy
of `control-plane` code; it draws attention away from the tenant topologies.
### Option 2: Cognito itself, a fourth "vendor" pool
Pros: no external dependency. Cons: conflates vendor and tenant identity in
the sample whose point is to separate them; `pool-per-tenant` would then have
one pool that is not a tenant.
### Option 3: IAM authorisation (SigV4) on `/platform/*`
Pros: no extra provider; the deploying principal or any granted role can
operate the API; the integration test signs with the credentials it already
has; least privilege is an IAM policy on `execute-api:Invoke`. Cons: vendor
staff are AWS principals, which suits an internal platform team but not a
vendor portal; stated as an explicit limitation.

## Decision
Option 3. `/platform/*` uses `AWS_IAM` authorisation; it is the only API the
sample exposes (ADR-0009). The README says that a vendor
portal would front the platform API with its own identity (the
`control-plane` pattern) and that nothing in this sample depends on which.

## Consequences
Easier: the sample deploys with no prerequisites; the identity story is only
about tenants. Harder: a human on the vendor side uses SigV4 tooling
(`awscurl`, the test client) rather than a browser. Revisit if the two samples are composed
into one platform; then one vendor IdP fronts both.

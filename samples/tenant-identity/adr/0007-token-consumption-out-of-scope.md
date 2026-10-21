# ADR-0007: Keep token consumption out of the sample; the integration test verifies tokens

- Status: Superseded by ADR-0016
- Date: 2026-10-14
- Deciders: Dave Roberts (SA)

## Context
The sample's subject is how Cognito carries tenant identity: three ways to
overlay a tenant onto a user pool, the provisioning that creates each, and
the trigger that puts the result into the access token. The first draft of
the spec also built a consumer: an `/app/whoami` route, a seven-step
resolution algorithm with a per-request registry status check and cache
(former P-2, §5.3, N-2, N-5), a tenant-selection header that could narrow
but never widen the token's memberships, and a decision to verify tokens
inside the function rather than in a gateway authoriser. That consumer grew to
about a
third of the design and contradicted the spec's own argument that, once the
tenant rides in a signed token, no second lookup is needed on the request
path. A reviewer asked why the consumption side was in the sample at all.

## Options considered
### Option 1: Keep a minimal consumer behind an API Gateway Cognito authoriser
Pros: a reader sees a real service receive the tenant with zero verification
code. Cons: still a consumer, with its own questions (pool ARNs per
authoriser in `pool-per-tenant`, access-token scopes on the method) that are
about consuming tokens, not issuing them; the sample would be judged on a
part that is not its subject.
### Option 2: Keep the in-function resolver as designed
Pros: already specified. Cons: puts a status lookup on the hot path that the
problem statement argues against; the cache TTL becomes the sample's
offboarding story instead of the identity provider's; the selection header
is a consumer policy dressed as a principle.
### Option 3: No consumer; the integration test verifies the tokens
Pros: the sample stops exactly at its subject, the token; every topology is
proven by the same assertion on the same claims; offboarding is answered
where identity lives (ADR-0008); the API shrinks to the platform routes.
Cons: nothing in the deployed stack demonstrates a request being scoped to a
tenant; the README must point readers at the consumer options instead.

## Decision
Option 3. The application function, `/app/*` routes, resolution algorithm,
selection header, and registry cache are removed. The integration test
obtains tokens through the `IssueToken` and `RefreshToken` test aids and
verifies them with `aws-jwt-verify` against the issuer the registry or the
published parameters name; that is test code and the README says so. The
consumer options (Cognito authoriser, JWT authoriser, in-function verifier
with the registry as issuer allowlist) are recorded as an extension seam.
The two records that had designed the removed consumer were dropped from the
trail before the sample's first release rather than kept as superseded.

## Consequences
Easier: the spec's scope matches its title; the only topology-specific code
is the provisioner and the trigger's tenant lookup; the "identity provider as
trusted source" argument in §1 is no longer undercut by a per-request
lookup. Harder: a reader who wants to see the token used must build a
consumer from the seam; `pool-per-tenant` consumers must manage a growing
issuer allowlist, which the spec now states as a comparison dimension rather
than solving. Revisit if a consumer sample is wanted; it would be its own
sample, not an addition to this one.

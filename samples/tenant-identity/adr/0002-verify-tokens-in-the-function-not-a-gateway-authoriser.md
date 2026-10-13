# ADR-0002: Verify bearer tokens inside the application function, not with an API Gateway JWT authoriser

- Status: Accepted
- Date: 2026-10-13
- Deciders: Dave Roberts (SA)

## Context
Requests to `/app/*` carry a Cognito access token. API Gateway HTTP APIs offer
a built-in JWT authoriser configured with one issuer and a list of audiences.
In `pool-per-tenant` every tenant is its own issuer, created at onboarding,
after the API is deployed. The resolver also has to confirm tenant status in
the registry (P-2), which no gateway authoriser does.

## Options considered
### Option 1: Gateway JWT authoriser
Pros: no verification code; the gateway caches JWKS. Cons: one issuer per
authoriser, so `pool-per-tenant` would need the API redeployed per tenant or
one route per tenant; still needs an in-function registry check, so two
places verify; different code paths per topology, breaking P-1.
### Option 2: Lambda authoriser (REQUEST type) shared by all topologies
Pros: one verification point for all routes; policy caching. Cons: the cached
policy is keyed by token and the registry status check would be cached with
it for the TTL, extending offboarding latency past `registryCacheSeconds`;
adds a function and an invocation per request for an API with one route.
### Option 3: Verify in the application function with a JWKS-caching library
Pros: one code path, topology-specific only at step 4 of the resolution
algorithm (spec §5.3); the issuer lookup can refuse unknown pools before any
JWKS fetch (T-3); the registry status check sits next to the token check with
one cache TTL. Cons: every application route must call the resolver; the
sample must own the verifier's correctness.

## Decision
Option 3, with `aws-jwt-verify` as the reference verifier (cached JWKS per
issuer, bounded LRU per N-5). The `/app/*` routes have no gateway authoriser;
the function rejects before any business logic.

## Consequences
Easier: identical request path across topologies; the integration test can
assert the step at which a token was rejected from one log line. Harder: a
new application route must call the resolver first; the README's hardening
checklist says so, and the unit tests assert that `WhoAmI` cannot be reached
without it. Revisit if the sample grows many application routes, where a
Lambda authoriser's caching would start to pay for its cost.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0012: Authenticate tenant users with the token contract through a Lambda authoriser and the vendor with IAM, and register the scopes at deploy

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-16)

## Context
Two caller types reach the API. Tenant users call `/tenant/*` with an access
token whose `tenant_id` is the only trusted tenant source on that path
(§7.6). The vendor, through a control-plane tenant create script, calls
`/platform/*` to create and delete keys. The token must meet the repository
contract (`ARCHITECTURE.md` §2.1): verified issuer, allowed `client_id`,
expiry, `token_use`, and refused while it still carries `tenants`. Deliver and
read need separate scopes. API Gateway caches an authoriser's policy per
token and applies it to every method the token calls within the TTL, so a
route-specific decision cached from one call is wrong for the next (F-16).
The construct must work with any issuer that meets the contract, not only
`tenant-identity`. Realises P-2 and §3.1 (API, token authoriser), §3.2,
§3.3 (`identity`, `identityApi`), §6.4, §7.6.

## Options considered
### Option 1: API Gateway Cognito user pool authoriser
Pros: managed, no code, checks scopes per method. Cons: Cognito only, so the
construct could not take a generic OIDC issuer; cannot check a `client_id`
allowlist on access tokens or refuse a token that still carries `tenants`;
cannot pass `tenantId` and `sub` to the integration as named context.
### Option 2: Custom TOKEN authoriser that checks the scope per route
Pros: verifies every rule of §2.1. Cons: the cached policy is either
`/tenant/*`, so a cached Allow from `GetDelivery` lets a read-only token call
`CreateDelivery` within the TTL, or method-scoped, so the next route gets a
spurious 403 (F-16).
### Option 3: Custom TOKEN authoriser for identity, scope enforced by the handler
Pros: verifies every rule of §2.1 against the discovery URL, so any compliant
issuer works; returns one Allow on `/tenant/*` with `tenantId`, `sub` and
`scope` as context, which is correct for every route the token may call;
the handler checks the scope the route needs; result caching by token keeps
cost and latency low. Cons: security-critical code the sample owns in two
places, with unit tests for every refusal; a cold start on the first request.
### Option 4: REQUEST authoriser with method and path in the identity sources
Pros: the scope decision can stay in the authoriser and is cached per route.
Cons: the cache key grows per route, lowering the hit rate; the decision
moves away from the code that knows what the route does.
### Option 5: API keys
Pros: trivial. Cons: API keys identify a usage plan, not a user or a tenant;
they are not an authentication mechanism and cannot carry a verified tenant.
The sample uses them only for per-tenant throttling (ADR-0015).

## Decision
Option 3 for `/tenant/*` and IAM (SigV4) for `/platform/*`. The authoriser
verifies the token and returns an Allow on `/tenant/*` with `tenantId`, `sub`
and `scope` in the context; it makes no route decision. The handler, not the
authoriser, enforces the scope: `ingestion/deliver` for `CreateDelivery`,
`ingestion/read` for `GetDelivery` and `ListDeliveries`, 403 otherwise. The
authoriser cache TTL is at most 300 s, and that TTL is the revocation lag for
a token the issuer revokes before it expires. IAM on the platform routes keeps
vendor identity separate from tenant identity (`ARCHITECTURE.md` §2.3) and lets
the deployer grant `execute-api:Invoke` to exactly the control-plane role. The
construct takes the issuer as props (`identity.discoveryUrl`,
`allowedClientIds`) and depends on no parameter. Only the demo app and the
integration driver read `tenant-identity`'s published parameters
(`/application-plane/shared/identity/*`); at deploy the demo registers both
scopes in `tenant-identity`'s catalogue through its `PUT /platform/scopes/{scope}`,
the way `agentic-runtime-isolation` registers backend scopes; `identityApi` can
be passed by value or skipped by a deployer with another issuer.

## Consequences
Easier: tenant-identity's tokens work unchanged; a deployer with another
compliant issuer swaps two props; the integration test proves the cache does
not leak a scope decision (a read-only token's `CreateDelivery` is 403 and its
`GetDelivery` right after is 200, §10 step 3). Harder: the authoriser and the
handler's scope check are both part of the tenant boundary and are tested like
it; a revoked token keeps working for up to 300 s, which the README states;
scope registration is a deploy-time call into another sample, so the demo
fails fast when the parameters are missing. Revisit if API Gateway gains a
native authoriser that can enforce the full token contract.

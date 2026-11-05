<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0012: Authenticate tenant users with the token contract through a Lambda authoriser and the vendor with IAM, and register the scopes at deploy

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-16)
- Revised: 2026-11-05, second security review (G-2, G-8)

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
`tenant-identity`.

Two facts from the second review. The tenant id is the session tag value and
the S3 prefix, so its grammar is part of the isolation, and the authoriser is
where it enters on the tenant path (G-2, spec §7.0). And per-tenant
throttling (ADR-0015) needs the authoriser to return the tenant's API key
**value** as `usageIdentifierKey`; reading it needs a role, the registry
stored only the key id, and usage-plan throttling applies only to methods
with `apiKeyRequired: true` (G-8). Realises P-2 and §3.1 (API, token
authoriser), §3.2, §3.3 (`identity`, `identityApi`), §6.4, §7.0, §7.1, §7.6.

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
places, with unit tests for every refusal; a cold start on the first request;
the authoriser needs its own narrow registry read.
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
verifies the token, then checks `tenant_id` against the grammar
`^[a-z0-9][a-z0-9-]{1,34}$` and returns 401 for a token whose tenant id does
not match (G-2); the same grammar is enforced in the Smithy model for
`/platform/tenants/{tenantId}` and in the processor's key parse (ADR-0003).
It returns an Allow on `/tenant/*` with `tenantId`, `sub` and `scope` in the
context; it makes no route decision.

The authoriser runs under its own base role, `authoriserRole` (ADR-0003),
which may only `dynamodb:GetItem` on the table with `dynamodb:Select =
SPECIFIC_ATTRIBUTES` and `ForAllValues:StringEquals dynamodb:Attributes =
[PK, SK, apiKeyValue, status]` (G-8). It reads `TENANT#<tenantId>/KEY` and
returns `apiKeyValue` as `usageIdentifierKey`, cached with the authoriser
result. The value is stored on the key row at `CreateTenantKey` (ADR-0015),
so the authoriser needs no `apigateway:GET` on every tenant's key value. It
borrows no other role, so the one-function-one-role asymmetry of P-8 holds.
Every `/tenant/*` method has `apiKeyRequired: true` with `apiKeySource:
AUTHORIZER`, and a template test asserts it, because without it the usage
plan does not throttle (G-8).

The handler, not the authoriser, enforces the scope: `ingestion/deliver` for
`CreateDelivery`, `ingestion/read` for `GetDelivery` and `ListDeliveries`, 403
otherwise. The authoriser cache TTL is at most 300 s, and that TTL is the
revocation lag for a token the issuer revokes before it expires. IAM on the
platform routes keeps vendor identity separate from tenant identity
(`ARCHITECTURE.md` §2.3) and lets the deployer grant `execute-api:Invoke` to
exactly the control-plane role. The construct takes the issuer as props
(`identity.discoveryUrl`, `allowedClientIds`) and depends on no parameter.
Only the demo app and the integration driver read `tenant-identity`'s
published parameters (`/application-plane/shared/identity/*`); at deploy the
demo registers both scopes in `tenant-identity`'s catalogue through its
`PUT /platform/scopes/{scope}`, the way `agentic-runtime-isolation` registers
backend scopes; `identityApi` can be passed by value or skipped by a deployer
with another issuer.

## Consequences
Easier: tenant-identity's tokens work unchanged; a deployer with another
compliant issuer swaps two props; the integration test proves the cache does
not leak a scope decision (a read-only token's `CreateDelivery` is 403 and its
`GetDelivery` right after is 200, §10 step 3); a malformed tenant id never
reaches STS or S3. Harder: the authoriser and the handler's scope check are
both part of the tenant boundary and are tested like it, including one unit
test per illegal tenant-id character; `authoriserRole` is a filtered,
table-wide read of two attributes of every key row, named in the threat
model; a tenant with no key row yet gets no `usageIdentifierKey` and is
refused by API Gateway, which the README states; a revoked token keeps
working for up to 300 s, which the README states; scope registration is a
deploy-time call into another sample, so the demo fails fast when the
parameters are missing. Revisit if API Gateway gains a native authoriser that
can enforce the full token contract.

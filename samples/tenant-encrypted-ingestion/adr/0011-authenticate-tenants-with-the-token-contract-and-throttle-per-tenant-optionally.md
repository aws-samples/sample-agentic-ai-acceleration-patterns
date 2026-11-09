<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0011: Authenticate tenants with the token contract and throttle per tenant optionally

- Status: Accepted
- Date: 2026-11-05
- Amended by: ADR-0019
- Deciders: Dave Roberts (PSA)

## Context
Tenant users hold `tenant-identity` access tokens (`tenant_id`, `sub`,
`client_id`, `scope`), and the tenant id the pipeline tags sessions with must
come from that verified claim (§7.6). Two routes need different scopes, and an
API Gateway authoriser result is cached per token across routes. The vendor
calls `/platform/*` from a control-plane script with SigV4. One tenant must
not exhaust STS (600 rps per account), KMS or Lambda for the others. API keys
are limited to 10,000 per account and Region, not adjustable, and
`tenant-identity` already uses one per tenant. Realises P-2, N-3, N-8.

## Options considered
### Option 1: API Gateway Cognito authoriser
Pros: managed, checks scopes per method. Cons: Cognito only, so no generic
OIDC issuer; cannot check a `client_id` allowlist or refuse a token carrying
`tenants`; cannot pass `tenantId` as named context.
### Option 2: Lambda authoriser deciding the scope per route
Pros: verifies every rule. Cons: a cached `/tenant/*` Allow from a read lets
a read-only token call `CreateDelivery` within the TTL; a method-scoped
policy gives the next route a spurious 403.
### Option 3: Lambda authoriser for identity, scope in the handler, limits split
Pros: one Allow on `/tenant/*` with context is right for every route; the
handler checks the scope the route needs; an in-flight counter bounds open
work always, and a usage plan bounds rate when wanted. Cons: security-critical
code in two places, unit-tested per refusal; per-tenant API keys spend a hard
quota, so they cannot be the default.

## Decision
Option 3. The authoriser verifies issuer, `client_id` allowlist, expiry,
`token_use`, refuses a token carrying `tenants`, checks §7.0 (401), and
returns Allow on `/tenant/*` with `tenantId`, `sub` and `scope` as context,
cached per token for 300 s, the stated revocation lag. The handler enforces
`ingestion/deliver` for `CreateDelivery` and `ingestion/read` for the reads;
both scopes are registered in `tenant-identity` at deploy with `PUT
/platform/scopes/{scope}`. `/platform/*` uses IAM. `authoriserRole` holds no
data permission and reads no table. Every tenant always has an `inFlight`
counter on its key row: `CreateDelivery` increments it in the transaction
that creates the row and returns 429 at `maxInFlightPerTenant`, every
terminal transition decrements it, and the sweep reconciles it. Per-tenant
throttling is the optional prop `tenantThrottle: { rateLimit, burstLimit }`,
off by default: when set, `CreateTenantKey` creates one API key per tenant
with the deterministic value `tei-<hex(sha256(stackId + tenantId))[0:40]>`,
the authoriser computes the same value from the verified claim and returns it
as `usageIdentifierKey`, the API uses `apiKeySource: AUTHORIZER`, and every
`/tenant/*` method sets `apiKeyRequired: true`. The value only identifies a
tenant for throttling, so it may be derivable and is never stored.

## Consequences
Easier: any compliant OIDC issuer works; a read-only token is refused on
`CreateDelivery` even with a cached Allow; one tenant's STS, KMS, Lambda and
validator use is bounded by default; with throttling on, a noisy tenant's
excess costs no Lambda call. Harder: with `tenantThrottle` the 10,000-key
quota is shared with `tenant-identity`, so the composed deployment caps at
5,000 tenants, and `CreateApiKey` at 5 rps bounds bulk onboarding (N-3, N-4);
after offboarding, `CreateDelivery` is 403 from API Gateway with throttling
on and 409 from the handler with it off; a token stays usable for up to 300 s
after revocation. Revisit if API Gateway raises the API key quota, or offers
per-identity throttling without keys.

Implemented 2026-11-06 (`src/authoriser/`, `src/api/handler.ts`,
`src/construct/api.ts`). Offboarding with `tenantThrottle` on deletes the
tenant's API key (`src/platform/delete-tenant-key.ts`), but API Gateway may
still admit the key while its usage-plan cache lasts, so `CreateDelivery`
after offboarding is 403 from API Gateway or 409 `TenantKeyUnavailable`
from the handler; the run of 2026-11-06, with throttling on, saw 409. The
tenant is refused either way (architecture.md §14).

Amended 2026-11-09 (ADR-0019): "any compliant OIDC issuer works" was not
true of the implementation of 2026-11-06, which needed `client_id` and
`token_use` (Cognito's claims) and read tenant-identity's parameters to
register the scopes. ADR-0019 makes it true: the verifier accepts `aud`
when `client_id` is absent and the header `typ: at+jwt` when `token_use`
is absent (RS256 only), and `identityApi` is a required prop whose
`'none'` skips the scope registration.

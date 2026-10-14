# ADR-0005: Let the client select a tenant with a header that can only narrow the token's memberships

- Status: Superseded by ADR-0009
- Date: 2026-10-13
- Deciders: Dave Roberts (SA)

## Context
In `shared-pool-multi-tenant` a token names several tenants; a request acts
for one. Something must choose. In the other two topologies the token names
exactly one tenant, and the sample should still behave predictably when a
client sends a tenant anyway.

## Options considered
### Option 1: Tenant in the URL path (`/app/tenants/{tenantId}/whoami`)
Pros: RESTful, cacheable. Cons: every application route grows a path
parameter; the tenant becomes part of the resource identity even where it is
a request scope.
### Option 2: Tenant chosen at sign-in via `clientMetadata`, trigger emits one `tenant_id`
Pros: tokens are tenant-scoped; no per-request choice. Cons: switching tenant
is a new sign-in; the trigger must trust `clientMetadata`, which the client
controls, so it must still intersect with groups; the sample would then
differ between topology 3 and the others at the token layer. Recorded as an
extension seam (spec §11).
### Option 3: Optional `X-Tenant-Id` header, validated against the token's memberships
Pros: one rule for all topologies (P-3): absent with one membership picks it;
absent with several is a 400 `TenantSelectionRequired`; present and in the
set picks it; present and outside the set is a 403. The client cannot widen
anything. Cons: a header is easy to forget; the 400 makes that explicit.

## Decision
Option 3. The header name is configurable (`tenantHeader`, default
`X-Tenant-Id`). Never a silent default when the token is ambiguous.

## Consequences
Easier: the resolution algorithm is identical across topologies after step 4;
the integration test exercises all four header outcomes. Harder: topology 3
clients must send the header when a user has several tenants; the README
states the rule. Revisit if a consumer prefers session-scoped tokens; that
is Option 2, implemented as a change to the trigger and a new ADR.

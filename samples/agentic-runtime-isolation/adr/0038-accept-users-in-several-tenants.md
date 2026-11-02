<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0038: Accept users in several tenants; the request names one the verified token lists

- Status: Accepted
- Date: 2026-11-02
- Amends: ADR-0004
- Amended by: ADR-0040
- Deciders: Dave Roberts (PSA)

## Context
ADR-0004 consumes tenant-identity's `shared-pool` topology, in which a user belongs to exactly one tenant and the token carries one `tenant_id`. The v1 spec listed "not multi-tenant-per-user" as a scope boundary. Requirement R-1 of the v2 spec withdraws it: a tenant user may belong to several tenants, as tenant-identity's `shared-pool-multi-tenant` topology already allows through a `tenants` claim (repo `ARCHITECTURE.md` §2.1). Under v1 that token was narrowed to one tenant by the client before the call (RFC 8693 at tenant-identity, ADR-0007). ADR-0031 removes client-side narrowing, so the ingress itself must settle which tenant a request acts for, and it must do so from the verified token alone (P-3): the tenant decides the entitlement rows read (ADR-0030), the `tenant_id` minted into the transaction token (ADR-0031), the session prefix (P-2) and the `TenantId` session tag (P-8).

## Options considered
### Option 1: Keep one tenant per token; require the client to narrow first
Pros: nothing changes at the ingress; the identity provider stays the only place a tenant is chosen. Cons: needs the refresh token and the tenant-identity exchange on every tenant switch; ADR-0031 has just removed that path for the agent and the gateway, so keeping it for the client alone leaves two narrowing mechanisms; a consumer on an identity provider without token exchange cannot use the sample for multi-tenant users at all.

### Option 2: The request names the tenant in a header; the ingress checks it against the verified `tenants` list
`X-Tenant-Id` selects one of the tenants the token already names. A token with `tenants` and no header is 400 `tenant_required`; a header naming a tenant outside the list, or sent with a token that carries `tenant_id`, is 403 `tenant_not_allowed`. Pros: no refresh token, no second issuer call, one check in the authoriser the ingress already runs; the header can only select, never add, so P-3 holds. Cons: a client bug that sends the wrong header lands the user in another of their own tenants (never in a foreign one); the header is a new field the Gateway `CUSTOM_JWT` authoriser does not see, so on the `agentcore-gateway` ingress the interceptor must enforce it, as it does the session header (ADR-0002).

### Option 3: Mint one transaction token per tenant and let the agent choose
Pros: no header. Cons: the agent chooses the tenant, which breaks P-2 and P-3 (tenant context from the validated token, chosen before the compute); several tokens per request multiply the mint cost.

## Decision
Option 2, behind `identity.multiTenant` (default `false`, so a v1 deployment refuses a `tenants` token exactly as before). The ingress reads `tenant_id` when present, otherwise `tenants` and `X-Tenant-Id`, refuses any other combination, and from then on uses the one selected tenant everywhere a v1 ingress used `tenant_id`. The transaction token always carries exactly one `tenant_id` and never a `tenants` claim, so no component behind the ingress sees the choice.

## Consequences
Easier: a consumer on `shared-pool-multi-tenant` needs no token exchange; the identity token can stay small. Harder: the `agentcore-gateway` interceptor gains a check and the header must be in the Gateway's passed request headers; the integration test gains a multi-tenant user (step 19). The `X-Tenant-Id` header is not forwarded to the backend (M-8 still holds); the tenant reaches the agent only inside the transaction token. Follow-up: a threat-model entry for the wrong-own-tenant case, and the ingress log line records which path (claim or header) chose the tenant. Revisit if tenant-identity publishes a per-request tenant selection of its own, or if the Gateway's `CUSTOM_JWT` authoriser can read a custom header.

**2026-11-02.** Amended by ADR-0040: the transaction token's `sub` is tenant-qualified so a 3LO grant is never shared across a user's tenants.

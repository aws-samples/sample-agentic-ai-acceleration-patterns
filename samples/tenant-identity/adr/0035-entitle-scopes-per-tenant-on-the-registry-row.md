# ADR-0035: Entitle scopes per tenant on the registry row

- Status: Proposed
- Date: 2026-10-29
- Deciders: Dave Roberts (SA)

## Context
With a scope catalogue (ADR-0034) the question moves from "which scopes exist"
to "which tenant may hold which". Tenants buy different things: one tenant has
the billing backend, another does not. A token must never carry a scope its
tenant is not entitled to, whatever the user asks for at the exchange
(ADR-0009, ADR-0010). The platform, not the tenant, decides the entitlement,
and the trigger already reads the tenant's registry row on every issuance for
the status rule (ADR-0008).

## Options considered
### Option 1: A `scopes` field on the tenant registry row
`CreateTenant` takes an optional `scopes` list; when absent, the row is written
with every scope in the catalogue at that moment. A new `UpdateTenant`
(`PATCH /platform/tenants/{tenantId}`) replaces the list; `GetTenant` and
`ListTenants` return it. Each entry must exist in the catalogue, else 400
`invalid_scope`. Pros: the trigger already has the row, so no extra read; one
place to look; a change takes effect at the next issuance (5 min at most, the
same bound as offboarding). Cons: a tenant created before a backend is added
does not gain the new scope by itself; the platform calls `UpdateTenant`.

### Option 2: A Cognito group per tenant and scope
`scope-<tenantId>-<scope>` groups, users added to each. Pros: the trigger sees
groups for free. Cons: the entitlement would live on users, not on the tenant,
so every user needs a group write when the tenant's plan changes, and the
`pool-per-tenant` provisioner would have to create a group per scope.

### Option 3: A tier on the tenant that maps to scopes in config
Pros: one field. Cons: the sample already uses `tier` for the pool topology
(ADR-0027); a second meaning for it would be a trap, and a tier-to-scope table
is a fixed list by another name.

## Decision
Option 1. The scopes a user holds for a tenant are

```
held(user, tenant) = catalogue ∩ tenant.scopes ∩ user.scopes[tenant]
                     ∪ { tenant-admin/users  if the user is in admin-<tenantId> }
```

where `user.scopes[tenant]` defaults to `tenant.scopes` (ADR-0036). The trigger
writes `held` on an un-narrowed single-tenant token; on an un-narrowed
multi-tenant token (topology 3) it writes the intersection of `held` over the
active tenants, because that token names no single tenant and a scope on it
must be true for every tenant it names (ADR-0010). A narrowing request is
granted only when every requested scope is in `held` for the target tenant;
otherwise `invalid_scope`, with the same fixed text as today.

## Consequences
`CreateTenant`'s default is a snapshot: a tenant created when the catalogue
held `default/chat` does not hold `billing/read` registered a day later until
`UpdateTenant` says so. That is the intended meaning of entitlement, and the
README says so. A scope deleted from the catalogue (ADR-0034) drops out of
`held` by the first intersection without touching tenant rows; a later
`UpdateTenant` that still names it gets `invalid_scope`. The control-plane
mount (ADR-0028) passes no `scopes`, so mounted tenants get the snapshot
default. `PlatformInvokePolicy` (ADR-0030) gains `PATCH /platform/tenants/*`,
which by ARN shape also reaches `UpdateUser`; recorded in `threat-model.md`.

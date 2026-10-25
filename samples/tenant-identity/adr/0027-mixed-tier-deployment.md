# ADR-0027: Serve a standard and a premium tier from one deployment, chosen per tenant

- Status: Accepted
- Date: 2026-10-23
- Deciders: Dave Roberts (SA)

## Context
ADR-0001 fixes one topology per stack. The README calls `pool-per-tenant`
the natural premium tier and a shared pool the default tier. A vendor who
wants both today runs two stacks: two APIs, two registries, two sets of
shared parameters, and clients that must know which stack a tenant lives
in. ADR-0001 said to revisit this "if a real consumer needs mixed topologies
in one deployment".

The question: can one deployment hold standard tenants in a shared pool and
premium tenants in pools of their own, without consumers needing a different
auth or isolation mechanism per tier?

Scope: a user belongs to exactly one tenant. That is true of both
`shared-pool` (§7.2) and `pool-per-tenant` (§7.1), so their token contract
(P-6) is already identical: one `tenant_id` claim, un-narrowed and narrowed.
A tier therefore changes nothing a consumer reads from a token.

What already fits:
- The registry row carries `topology` per tenant (§4.1), and the
  `byUserPoolId` index (§4.2) maps a pool to its tenant.
- The provisioner and tenant-source strategies are already per topology
  (P-1); nothing outside `src/topology/` branches on it.
- The authoriser already treats the registry as the issuer allowlist for
  per-tenant pools (ADR-0007, ADR-0018).
- Per-tenant throttling (ADR-0025) and the per-tenant IAM wall (ADR-0026)
  are both keyed on the tenant, not the stack.

## Options considered
### Option 1: Two stacks, one per tier (today)
Pros: nothing to build; each stack keeps the guarantees it has been tested
for. Cons: two API URLs and two registries, so the vendor's control plane
and every client route by tier; `ListTenants` sees half the tenants; moving
a tenant between tiers crosses stacks; the shared parameters collide
(ADR-0017).

### Option 2: Routing front over two stacks
A thin tenant directory maps a tenant to its stack and proxies. Pros: each
stack unchanged. Cons: a third component with its own registry copy that
can drift, and a second hop on every call. It hides Option 1's split rather
than removing it.

### Option 3: One stack, tier chosen per tenant at `CreateTenant`
A new deploy-time value `topology=tiered` deploys the shared pool and the
per-tenant pool machinery side by side. `CreateTenant` takes a required
`tier` (`standard` → `shared-pool`, `premium` → `pool-per-tenant`) and writes
it to the row's `topology`. Pros: one API, one registry, one token contract,
one authoriser; the tier is a tenant attribute the vendor can see and
report on; tier change becomes a registry-level operation in one stack.
Cons: two strategies in one runtime, so every component that picks a
strategy must bind it to the tenant's row and refuse a mismatch; the stack
carries both topologies' IAM.

## Decision
Option 3, as a fourth accepted `topology` value, `tiered`. The three single
topologies stay as they are, so the side-by-side comparison of ADR-0001
still holds. P-7 is amended: the deploy-time choice may be `tiered`, which
offers both tiers; a tenant's tier is chosen once, explicitly, at
`CreateTenant`, and is never inferred or defaulted.

### The binding rule
A premium row records its own pool (`userPoolId`, as in `pool-per-tenant`);
a standard row records no pool. A `pool-per-tenant` tenant is reachable only
through the pool its row names; every other tenant is reachable only through
the shared pool. Every path that maps a Cognito pool to a tenant MUST apply
this after reading the row:

| Arrived via | Row must say | Else |
|---|---|---|
| The shared pool (trigger: the event carries `custom:tenantId`; authoriser: `iss` is the shared pool's) | not `pool-per-tenant` | refuse (`pool_mismatch`) |
| Any other pool | `pool-per-tenant`, and that pool is the row's `userPoolId` | refuse (`pool_mismatch`) |

This stops a premium tenant's id being claimed through the shared pool (for
example by a vendor bug that writes a premium id into `custom:tenantId`),
and a standard tenant being reached with a token from a premium pool. The
rule holds trivially in a single-topology stack and is applied in every
stack, so nothing branches on the deployment to skip it
(`src/topology/binding.ts`).

### Component changes
| Component | Change |
|---|---|
| CDK stack | `tiered` deploys the shared pool, its app client and groups (as `shared-pool`) plus the pool-per-tenant grants, tags and tenant-scoped role (ADR-0026). Every function reads `TOPOLOGY=tiered`. Publishes the shared pool's `userPoolId`/`appClientId` parameters, which serve the standard tier only. |
| Smithy (`platform`) | `CreateTenantInput.tier`: enum `standard \| premium`, required when the stack is `tiered`, refused (`UnsupportedInTopology`) otherwise. `Tenant` output gains `tier`, derived from the row's `topology`. |
| Registry | `topology` is the tenant's tier. Premium rows carry `userPoolId`, `appClientId` and `issuer` as in `pool-per-tenant`; standard rows carry none, because the `byUserPoolId` index maps a pool to exactly one tenant and the shared pool's id cannot sit on every standard row. |
| Provisioner | `createProvisioners` in `src/topology/` returns the strategy for a row's `topology`, built once per topology the deployment offers; a topology the deployment does not offer throws. Platform and tenant-user handlers resolve it per request instead of once per cold start. Still the only place that branches (P-1). |
| Pre-token trigger | One function, attached to the shared pool and every premium pool. The event's shape says which pool it came from: only the shared pool's schema has `custom:tenantId`, so an event with the attribute takes the shared-pool path and any other takes the `byUserPoolId` lookup. Then the binding rule. (Wiring the shared pool's id into the trigger's environment would be a CDK cycle: the pool depends on the trigger.) |
| Tenant authoriser | Decodes `iss` (unverified, as today). The shared pool's issuer → verify against the shared app client; another pool → the registry path of ADR-0007. Then the binding rule, as a new refusal `pool_mismatch` next to `issuer_tenant_mismatch`. |
| Token exchange | No `client_id` comparison in `tiered` (nor in `pool-per-tenant`): the form's client is passed to Cognito, and a client of a pool the registry does not know is refused by the trigger's pool lookup (M-5), so no token with a tenant claim is issued. The shared topologies keep the `invalid_client` check (T-28, M-25). |
| Tenant-user function | Standard tenants: its own role, scoped to the shared pool ARN (code-only wall, T-18). Premium tenants: the tenant-tagged STS role (ADR-0026, IAM wall). Chosen per request from the row's `topology`. |
| Throttling | One usage plan per tier (ADR-0025 "revisit if tiers"); `CreateTenant` adds the key to its tier's plan. Standard: 10 rps / 20 burst per tenant; premium: 25 rps / 50 burst per tenant; the shared `/tenant/*` stage limit (50 / 100) sits above both. |
| Teardown drain | Unchanged in shape: it deletes each row through the dispatcher. |

Amended 2026-10-23 during implementation:
- Standard rows do not store the shared pool's `userPoolId`; the binding rule
  is "pool-per-tenant rows only through their own pool, every other row only
  through the shared pool".
- The trigger tells the pools apart by event shape (`custom:tenantId`
  present), not by a configured shared pool id.
- The token exchange compares no `client_id` in `tiered`; a foreign client is
  refused by the trigger because its pool is not in the registry.
- The premium usage plan is 25 rps / 50 burst per tenant.

### What consumers see
- **Token checks: no change.** Every access token carries `tenant_id` and
  the same scopes in both tiers. A verifier must already accept many issuers
  for `pool-per-tenant`; in `tiered` the allowlist is the registry's issuers
  plus the shared pool's. A verifier that also applies the binding rule (or
  calls through `/tenant/*`) gets the same guarantees as the authoriser.
- **Isolation below the token: no change.** Data stores key off `tenant_id`
  in both tiers.
- **Sign-in: one change.** The client must pick the pool before login. The
  vendor maps a login hint (tenant URL, e-mail domain, or an "organisation"
  step) to a tenant, then calls `GetTenant` from its own backend to get
  `userPoolId` and `appClientId`. A premium tenant returns its own pool; a
  standard tenant returns no pool fields, and the client uses the shared
  pool's ids from the published parameters (§6.3). The sample builds no public discovery route, because
  one would reveal which tenants exist (extension seam).

### Tier change: specified, not built
Moving a tenant between tiers is a user migration, because Cognito cannot
export passwords. The path for `standard` → `premium`:
1. Create the tenant's pool and client; the row stays `ACTIVE` on the shared
   pool.
2. Attach a user-migration trigger to the new pool that, on first sign-in,
   checks the password against the shared pool (`AdminInitiateAuth`) and
   creates the user, so users keep their passwords. Users who never sign in
   are created with a forced reset.
3. Flip the row to `pool-per-tenant` with the new pool fields in one
   conditional write. From then on the binding rule refuses the old issuer,
   so shared-pool tokens stop working at the next request, not after one
   token lifetime.
4. Delete the tenant's users and groups from the shared pool.

`premium` → `standard` runs the same steps in reverse; an e-mail that already
exists in the shared pool under another tenant blocks it (§7.2, 409).

### Parallel readiness
Contracts first: the `tier` field (Smithy), the dispatcher interface, and the
binding rule with its refusal name. Once they are written, the trigger, the
authoriser, the token exchange, the provisioner dispatch, the CDK stack and
the e2e scenario can be built in parallel. Tier change depends on all of
them and comes last.

## Consequences
Easier: one API and one registry for both tiers; a premium tier with its own
pool settings, issuer, IAM wall and throttle, while consumers check tokens
one way; tier is visible per tenant in `ListTenants`.

Harder:
- Two strategies in one runtime. The binding rule is the new security
  property, and it must hold in the trigger and the authoriser alike (the
  exchange relies on the trigger). Each mismatch needs a unit test, and the
  e2e needs a step that puts a premium tenant's id on a shared-pool user and
  expects no token (spec §10 step 12); a forged cross-tier token for the
  authoriser is unit-level, since Cognito will not mint one.
- The stack holds both topologies' IAM: the account-wide `CreateUserPool`
  (T-7) is present even for a deployment with only standard tenants.
- The tenant-user and platform functions resolve the strategy per request,
  so they read the row before every Cognito call (they already do for
  ADR-0013 and R-12).
- Quotas: standard tenants share the shared pool's group ceiling; premium
  tenants share the 1,000-pool ceiling (adjustable to 10,000). Cognito
  request rates are per account and Region across all pools (T-24).
- Tier change is specified but not built; a deployment that needs it builds
  the migration trigger.

Revisit if a premium tenant needs its own Region or account (a cell per
tenant, beyond this sample), or if tier change becomes frequent enough to
need its own workflow.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0012: Onboard a tenant on its cell through the role pair's tenant role

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (PSA)

## Context
Spec §3.3 step 3 has the stress application's tenant script make the tenant usable on its
cell: a subscription on the cell ingress's Entitlements API (`PutTenantSubscription`), a
tenant in tenant-identity and a route at the front door. The script runs in the control
plane's tenant CodeBuild project under the cell account's role pair tenant role
(control-plane ADR-0025). That role holds the control plane's SSM namespace grants and
whatever the account owner attaches through `tenantBuildManagedPolicyArns`
(control-plane ADR-0022), and nothing else. The Entitlements API's vendor operations take
SigV4 (`execute-api:Invoke`). The cell's own roles sit on `/cell/` under the workload
boundary (ADR-0011); the role pair stays on `/` without a cell boundary (spec §3.7).

The script must also find the cell's Entitlements API, which the cell stack creates.

## Options considered
### Option 1: An owner policy on the tenant role, scoped to the tenant subscription methods
The owner stacks gain a fifth policy, `cell-tenant-build-policy`: `execute-api:Invoke` on
`GET`, `PUT` and `DELETE` of `/entitlements/tenants/*` on the account's APIs in its Region.
The role pair attaches it to the tenant role. The cell script publishes the API's base URL
under the cell namespace (`/application-plane/cells/<cell id>/entitlements-api-url`), which
the tenant role already reads. Pros: the owner decides what a tenant build may do, as
ADR-0047 does for the cell role; nothing in the cell changes; the methods cannot write plans,
agents or tools. Cons: the grant reaches the tenant subscription methods of every API in
the account, which in a cell-only account means every cell's.

### Option 2: A tenant-scoped role in each cell that the tenant build assumes
Pros: one cell per grant. Cons: a `/cell/` role trusted from the role pair crosses the path
wall the other way (a role on `/` assuming into `/cell/`), every cell would need a change,
and the tenant role would need `sts:AssumeRole` on `role/cell/*`, which reaches every cell
role the TVM can.

### Option 3: The cell script writes subscriptions for the tenants
Pros: no tenant grant at all. Cons: tenants arrive after the cell, one build at a time; the
cell script runs once per cell.

## Decision
Option 1. The grant is the narrowest that lets a tenant build do its one write, it is the
owner's to give or withdraw (the account check refuses nothing it does), and it follows the
same pattern as the cell build policy. The script records the deployment under
`/application-plane/tenants/<tenant id>/<application id>` with the cell and the
subscription version, which the control-plane slice reads back as an isolation assertion
(P-1). The tenant-identity tenant and the front-door route join when those slices compose
(W-9, W-7).

## Consequences
The owner redeploys `CellPolicies` and the role pair once (`deploy-owner.sh`,
`deploy-role-pair.sh`). A compromised tenant build can change or delete any tenant's
subscription on any cell in the account; it cannot change a plan, an agent or a tool. The
tenant role also trusts the control plane's API role, for the `PutAccount` handshake
(control-plane ADR-0028), so the API role can use this grant too: whoever can run code as
the API role in the platform account can change any tenant's subscription on every cell of
every cell account the pair is installed in, as ADR-0047 says of the cell role's policy. The
tenant parameters `AGENTS` and `TOOLS` (default `default` and none) name what a tenant is
subscribed to. Revisit when the stress cell gets per-tenant tool sets, or when a cell
account holds cells of more than one application.

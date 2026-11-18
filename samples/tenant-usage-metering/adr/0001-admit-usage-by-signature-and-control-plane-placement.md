<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0001: Admit usage by the caller's signature and the control plane's placement

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (SA)

## Context
A usage event says which tenant used what. If the metering service
believes the body, any emitter can bill any tenant, or report as another
emitter. Cells can live in tenant-owned accounts, where the tenant
controls every credential the cell holds (control-plane §6.5). The
metering service needs a fact about each caller that the caller cannot
forge, and a list of the tenants each caller may speak for that the
caller cannot edit.

## Options considered
### Option 1: Trust the body
Emitters send `tenantId` and `cellId`; any caller with the ingest policy
is admitted. Pros: simplest. Cons: one compromised or dishonest cell can
write usage for every tenant in the fleet.

### Option 2: A signed claim per emitter
Each emitter carries a token naming its cell and tenants, issued at
provisioning. Pros: no lookup on the hot path. Cons: a token issued into
a tenant-owned account is held by the tenant; revoking it needs a deny
list; a tenant moved or removed keeps a valid token until it expires.

### Option 3: SigV4 caller plus a registry the control plane writes
The ingest door is IAM-authorised. The caller's assumed-role ARN, which
API Gateway verifies, names the account and the role; the role is
`<fleet>-ue-<cellId>`. Which cells exist, and which tenants each holds,
is written by the control plane's global hooks under
`<fleet>-global-hook`, a role no cell account holds or trusts
(control-plane R-41). Pros: the caller's identity comes from AWS, the
list comes from the vendor; deleting a tenant or a cell revokes within
the registry cache (60 seconds); no secret is issued into any cell.
Cons: one registry read per batch, cached; the emitter role name is a
convention the cell script must follow; the API resource policy can only
match the role-name pattern, since cell accounts are registered at run
time.

## Decision
Option 3. It is the only one where neither the emitter's identity nor its
tenant list is held or written by the emitter. The function admits only
assumed-role callers, and looks the role up by `<accountId>#<roleName>`,
so a role of the same name in an account the control plane never
registered is refused. The registrations are written in `PRE` hooks, so
a cell or deployment is known before its script runs and is `CLOSING`
before its delete script removes anything.

## Consequences
- A pooled cell may still report for any tenant it holds. That is stated
  as out of scope (spec §1.2); a role per deployment is a seam.
- Every global hook shares `<fleet>-global-hook`, so any global hook the
  vendor registers can also register emitters (spec §3.4).
- A delete hook the control plane skips after its retries leaves a
  registration `ACTIVE` (spec §3.4); reconciliation is a seam.
- Without the control plane, any principal in `registrarPrincipalArns`
  plays its part; the guarantee is then only as strong as that principal.
- The quantity is still the emitter's word (spec §1.2, T-3).

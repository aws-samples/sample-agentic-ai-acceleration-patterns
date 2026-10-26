# ADR-0032: Make the first admin a conditional write on the registry row

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (SA)

## Context
The control-plane mount promises exactly one first admin per tenant (mounting spec §6.4). Its replay step re-creates a missing admin after a `CreateTenant` that left none (spec §5.1 last sentence) or a build killed before the password was parked. A blind review found the planned `ListUsers`-then-`CreateUser` check is a read-then-write: two racing creates can both see no admin and both succeed. This sample's own rule is that conditional writes on the authoritative record decide, not reads (control-plane P-5).

## Options considered
### Option 1: A `firstAdminUsername` slot on the registry row, claimed by `attribute_not_exists`
`CreateUser {firstAdmin: true}` claims the slot in one conditional write, then creates the Cognito user, and releases the slot if Cognito fails. `CreateTenant` uses the same path. A taken slot is 409. Con: one more registry attribute and one more optional input.

### Option 2: Rely on Cognito username uniqueness
The username is the email in every topology, so a second `CreateUser` for the same email is already 409. Con: only holds while every retry carries the same `ADMIN_EMAIL`; a different email makes a second admin with no error, and the invariant lives in Cognito behaviour the sample does not state.

### Option 3: Enforce one admin per tenant, full stop
Reject any `CreateUser {admin: true}` when an admin exists. Con: changes the parent sample's model, where a tenant may have several admins.

## Decision
Option 1 (mounting spec M-R-8, M-R-9). It is the pattern the samples already use for every lifecycle transition, it holds under any interleaving, and it leaves ordinary `CreateUser {admin: true}` alone: a tenant may have many admins; it has one *first* admin. The mount's replay drops the `ListUsers` read and calls `CreateUser {firstAdmin: true}` directly, treating 409 as "done".

## Consequences
`CreateUser` gains `firstAdmin`, the registry row gains `firstAdminUsername`, and `DeleteUser` on the holder releases the slot so a lost admin can be replaced. `GetTenant` does not expose the field. README API section and the tenant-identity spec (§4 registry, §5.1 platform API) gain the input and the attribute (amend with a dated note when accepted). `PlatformInvokePolicy` no longer needs `GET .../users` for the mount; the route stays reachable through `GET /platform/tenants/*`, which the threat model already records.

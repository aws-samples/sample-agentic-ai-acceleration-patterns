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

Amended 2026-10-27 after the implementation review (decision unchanged; the
code is in `src/platform/platform.ts` and `src/shared/registry.ts`, the
mounting spec M-R-8 and M-R-9 carry the same note):
- The attribute is `firstAdminEmail`, not `firstAdminUsername`, and holds
  the e-mail. Option 2's premise that the username is the e-mail in every
  topology is false: in `pool-per-tenant` Cognito generates a UUID username
  and the e-mail is an alias. The service compares a user with the slot on
  the user's e-mail, never on the name a caller passed.
- The claim is re-asserted after the Cognito create (a second conditional
  write, `attribute_not_exists(firstAdminEmail) OR firstAdminEmail = :email`).
  While Cognito ran, a `DeleteUser` naming the same e-mail found no user yet
  and released the slot as stale; without the second write a racing
  `firstAdmin` call could claim it and the tenant would end up with two first
  admins. If the re-assertion finds another e-mail (409) or no row (404),
  the user just created is deleted again and that error surfaces.
- `CreateTenant` does not go through the claim: its slot is written in the
  same conditional update that flips the row to `ACTIVE`, so no `ACTIVE` row
  ever has an empty slot while `CreateTenant` is still creating its admin.
  Only the Cognito half (create, re-assert, release on failure) is shared.
- `DeleteMembership` on the holder (topology 3) releases the slot exactly as
  `DeleteUser` does; `UpdateUser {admin: false}` on the holder does not, since
  the user is still in the tenant and a free slot would allow a second first
  admin. A stale slot is released by naming the gone holder's e-mail; the
  gone holder's UUID username is a plain 404 and keeps the slot.
- A claim whose row has vanished is 404 `ResourceNotFoundError`, not 409:
  the conditional writes return the old item on failure, and no item means
  no tenant.

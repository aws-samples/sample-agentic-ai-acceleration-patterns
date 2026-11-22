<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0025: Change a route's status without reading the control plane

- Status: Accepted
- Date: 2026-11-19
- Deciders: Dave Roberts (PSA)
- Amends: ADR-0013

## Context
The registrar reads the control plane on every hook write and takes each
route's cell and account from it (spec §3.4 step 2, ADR-0013, ADR-0015).
An unreadable control plane, or one that returns a `createdAt` that does
not parse, makes the write fail with 503 (§5.1). The edge operator role's
deletes already skip that read, so a route a skipped delete hook left can
be cleared after the control plane removed its record.

`UpdateTenantRouteStatus` suspends or resumes a tenant at the edge
(§4.2). It is the vendor's tool for stopping a tenant's traffic quickly,
and the moment it is needed may be when the control plane is down or
misbehaving. It writes only `s` of an existing `tenant#` entry: no cell,
account, `dt` or name.

## Options considered
### Option 1: Read the placement first, as hook writes do
Pros: one rule for every put; a suspension of a deployment the control
plane no longer knows is refused (403). Cons: while the control plane
cannot be read, the operator cannot suspend anyone; the check guards no
value, because the status write copies the entry's placement fields as
they are.
### Option 2: Skip the read for the status change
Pros: a suspension works whenever the store is reachable; it changes
nothing the control plane decides. Cons: the operator can set the status
of an entry whose deployment the control plane has already deleted. A
new deployment replaces such an entry with its own `dt` (§3.4 step 5)
and keeps the status, which is what the operator set. Resuming such a
leftover before then routes the tenant to the old entry's cell again,
as any leftover `active` entry does: that cell's hosts check refuses
once the delete script has removed the tenant's namespace, and a cell
route that is gone answers 503 (AR-23, M-2). The operator's delete
clears the entry.

## Decision
Option 2. The status is the edge operator's own decision, not a value the
control plane owns, and the write copies every placement field it read
from the entry. Skipping the read keeps the one emergency control
available when the control plane is not. The call still needs the edge
operator role and an existing `tenant#` entry (409 otherwise).

## Consequences
- Spec §3.4 names `UpdateTenantRouteStatus` beside the operator's deletes
  as the writes that skip step 2.
- The registrar's unit tests cover a status change while the control
  plane is unreachable.
- Revisit if the status ever carries a value the control plane owns.

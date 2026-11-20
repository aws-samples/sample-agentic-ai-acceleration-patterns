<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0008: Key registrations by emitter, not by cell

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (SA)

## Context
The admin API, its ids and the table keys named the registration unit after
the control plane's cell: `/cells/{cellId}/emitter`, `CellEmitter`,
`CELL#<cellId>`, `TENANT_NOT_IN_CELL`. The service therefore read as usable
only with the control plane. Deployers outside it have other layouts: one
pooled application in one account, or many applications across many
accounts. For them the unit that signs usage is one IAM role in one account
for one application, and "cell" is a word they would have to map onto it.

## Options considered
### Option 1: Keep the cell names and explain the mapping in the docs
Pros: no breaking change. Cons: every deployer outside the control plane
reads a concept that is not theirs on every path, key and error; the docs
carry the translation forever.

### Option 2: Rename the API, ids, table keys, error code and props to emitter
`Emitter`, `PutEmitter`, `GetEmitter`, `DeleteEmitter`, `ListEmitters`,
`emitterId`, `/emitters/{emitterId}`, `ROLE#<account>#<role>`,
`EMITTER#<emitterId>`, `TENANT_NOT_BOUND`,
`testOnlyAllowEmittersInMeteringAccount`. Pros: the API names what the
service checks, a role in an account for an application; the control plane
maps one cell to one emitter with `emitterId` = the cell id. Cons: breaking
change to paths, keys, error code and props.

### Option 3: Add an emitter API beside the cell API
Pros: no break for existing callers. Cons: two names for one item, two sets
of routes to secure and test, and a sample that teaches both.

## Decision
Option 2. The sample has no consumers that need a migration, and the names
are its contract with every deployer. The control plane's own names stay as
they are: the hook events (`CELL_CREATE`, `CELL_DELETE`), the hook
environment (`CELL_ID`, `CELL_ACCOUNT_ID`) and the `METERING_API_URL` cell
parameter. The hook script passes `CELL_ID` as the `emitterId`.

## Consequences
- Breaking change to the admin API paths (`/emitters/{emitterId}` and
  `/emitters/{emitterId}/tenants[/{tenantId}]`), the table key layout
  (`ROLE#<account>#<role>` for the role-keyed item, `EMITTER#<emitterId>`
  for the id lookup and the binding partition), the caller field
  `emitterId` on raw and error objects, and the error code
  `TENANT_NOT_BOUND`.
- Existing deployments must be redeployed with an empty table. This is a
  sample; there is no migration.
- ADR-0001's "cell" wording reads as "emitter" for the API; the decision
  it records is unchanged.
- Revisit if a consumer needs a registration unit wider than one role in
  one account for one application.

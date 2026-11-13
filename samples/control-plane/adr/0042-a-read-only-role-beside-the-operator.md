# ADR-0042: A read-only role beside the operator

- Status: Proposed
- Date: 2026-11-13
- Amends: ADR-0015, ADR-0018
- Deciders: Dave Roberts (SA)

## Context
Every caller the authorizer admits holds all twenty-two operations
(ADR-0015, ADR-0018): `ALLOWED_ROLES` is a membership gate, not a matrix.
Systems are now appearing that need to read placement and nothing else. The
`tenant-front-door` sample's route registrar asks `GetCell` and
`GetDeployment` which account a cell or deployment lives in before it
accepts a route, and it faces every cell account, customer accounts
included. Holding an operator credential would let a bug or a leak in that
registrar delete tenants, cells and accounts, or register an application
whose code runs in every admitting account (T34). ADR-0015 declined a
partial matrix because one that protects nothing is worse than a stated
assumption; a read-only role does protect something, so the question is
how to add it without widening anything for existing deployments.

## Options considered
### Option 1: A reader grant chosen by role claim, enforced in the authorizer policy and again in the service
A second stack input, `readerRoles` (default none), lists role values that
get the reader grant. The authorizer returns a policy on
`<api>/<stage>/GET/*` for a reader and on `<api>/<stage>/*` for an
operator; the service refuses a reader on any non-`GET` operation. Pros:
off by default, so nothing changes until a deployer opts in; the cached
authorizer result stays valid for every call the role may make and never
for one it may not; two walls, so a policy shape error is caught by the
service and a service bug by API Gateway. Cons: the read set is defined by
HTTP method, so a future read operation that is not a `GET` needs a matrix
row, not a convention.

### Option 2: A per-operation matrix configured by the deployer
A map of role to operation names. Pros: any shape. Cons: a configuration
surface the sample has no use for beyond two roles; easy to misconfigure
into an operator by listing every operation; the cached policy must be
built from operation ARNs.

### Option 3: Read through IAM instead of the vendor IdP
A second, IAM-authorised API stage for reads, called with SigV4. Pros: no
token or client secret for the reader. Cons: a second identity model on one
control plane, a second stage to throttle and log, and the reader still
needs a role the control plane must trust by account.

### Option 4: Keep one role; give readers an operator token
Pros: no change. Cons: every reader can change the fleet; the
`tenant-front-door` registrar becomes the most exposed full-admin
credential the vendor holds.

## Decision
Option 1. Two grants, operator and reader, chosen by the verified `role`
claim through `allowedRoles` and `readerRoles`; the reader grant is the ten
`GET` operations; the authorizer expresses it as the method-scoped IAM
policy and the service checks it again. `readerRoles` defaults to none, so
an existing deployment admits no new caller, and a value in both lists
fails synth so no claim maps to two grants. The read operations return no
secret (`adminEmail` is never stored, `externalId` is never returned,
parameter values are never secrets), so a reader learns fleet topology and
nothing it could use to act.

## Consequences
- The route registrar, dashboards and audit jobs read with a credential
  that cannot change the fleet. A stolen reader token discloses topology:
  tenant names, account ids, cell placement (T36).
- The caller context carries the grant; the access log records it, so a
  reader's calls are told apart from an operator's.
- The integration test adds a reader token: every `GET` passes, every other
  method is 403 with nothing written.
- Finer operator roles (an application registrar apart from an onboarder,
  account scoping) remain a seam (spec §11); they would close T34 and T27,
  which this record does not.
- Revisit when a read operation needs a method other than `GET`, or a
  reader needs a subset of the reads.

# ADR-0042: A read-only role beside the operator

- Status: Accepted
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
operator, computed from the grant alone; the service requires the operator
grant on every non-`GET` operation. Pros: off by default, so nothing
changes until a deployer opts in; the cached authorizer result stays valid
for every call the role may make and never for one it may not; two walls,
defined independently (by method in the policy, by operation name in the
service), so one mistake does not open both. Cons: the read set is defined
by HTTP method, so every future `GET` joins it (spec R-37 keeps that safe)
and a read that is not a `GET` needs a matrix row.

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
`GET` operations; the authorizer's policy depends on the grant alone, and
the service lets a reader run only the ten operations it lists by name, so
a new `GET` stays refused to readers there until it is listed, and treats
a missing grant as an ingress fault. `readerRoles` defaults to
none, so an existing deployment admits no new caller, and a value in both
lists fails synth and cold start, so no claim maps to two grants. A reader
can change nothing. It can read a great deal: fleet topology, parameter
values that are not secrets by contract only (N-11, T35), and every
application's source location, which names the repository a T34 attacker
would target. That disclosure is the price, recorded as T36.

## Consequences
- The route registrar, dashboards and audit jobs read with a credential
  that cannot change the fleet. A stolen reader token discloses what T36
  lists.
- The caller context carries the grant; the access log records it, so a
  reader's calls are told apart from an operator's.
- The integration test adds a reader token: every `GET` passes, every other
  method is 403 with nothing written. A service unit test covers the
  second wall, which the integration test cannot reach.
- Spec changes: P-10, §1.2, §3.2 (R-36, R-37), §3.3 (`allowedRoles`,
  `readerRoles`), the §5 error table, N-11, §10 step 1, §11. Threat model:
  T2, T20, T27, T34, T35, new T36 and M26.
- ADR-0015 and ADR-0018 carry dated "Amended by ADR-0042" trailing
  notes.
- Finer operator roles (an application registrar apart from an onboarder,
  account scoping) remain a seam (spec §11); they would close T34 and T27,
  which this record does not.
- Revisit when a read operation needs a method other than `GET`, or a
  reader needs a subset of the reads (the registrar uses two of the ten).

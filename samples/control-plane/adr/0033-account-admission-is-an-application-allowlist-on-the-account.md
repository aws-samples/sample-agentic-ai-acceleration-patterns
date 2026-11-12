# ADR-0033: Account admission is an application allowlist on the account

- Status: Accepted
- Date: 2026-11-10
- Amends: ADR-0024
- Deciders: Dave Roberts (SA)

## Context
With several applications on one control plane (ADR-032), an account is either **dedicated** to some applications or **shared** by any. Placement must know which applications an account admits, operators must be able to see and change it, and a tenant-owned account must be able to host cells of more than one of the vendor's applications under its one role pair. The binding has to live somewhere on the table.

## Options considered
### Option 1: `applicationIds` on the account record
An optional set on the account. Absent means shared: any application may place there. Present means dedicated: only the named applications may. `PutAccount` sets it (each id must name a registered application, 404 otherwise); it is a policy field under R-24, so the counter paths never touch it. Pros: "which applications may use this account" is answered by one record; placement reads it from the account records it already reads; passes the P-1 test (a field, not an entity); works for both owners. Cons: no per-application cell cap inside a shared account (`maxCells` stays account-wide).

### Option 2: `accountIds` on the application record
Each application lists the accounts it may use; a shared account appears in several applications. Cons: a dedicated account's binding is spread over every application record; `PutAccount` cannot show or change it; placement must read every application to learn one account's admission.

### Option 3: A join entity per (account, application)
`ACCOUNT#<id>` / `APP#<id>` items with their own cell counter and cap. Pros: a per-application cap inside a shared account. Cons: an entity that stores nothing its neighbours do not, except a cap nobody asked for; one more counter with two more transactional paths; one more query in placement. Fails P-1 unless the cap is required.

## Decision
Option 1. `Account.applicationIds` is an optional, replaceable set. Eligibility for an application is `owner = VENDOR AND (applicationIds absent OR applicationIds ∋ applicationId)` for untargeted placement; a targeted `CreateTenant` into an account that does not admit the application is a 400, because the request names a wrong account, not a full one. An application id left in an allowlist after `DeleteApplication` is harmless: nothing can be placed for an application that does not exist, and the next `PutAccount` replaces the set.

## Consequences
Spec §4.4 (Account) gains the field and §7.1 the eligibility rule; `PutAccount` validates the ids and `GetAccount`/`ListAccounts` return them. A per-application cap inside a shared account is recorded as a seam (§11): it would be Option 3 layered on this decision, with the account-level `maxCells` kept as the outer bound.

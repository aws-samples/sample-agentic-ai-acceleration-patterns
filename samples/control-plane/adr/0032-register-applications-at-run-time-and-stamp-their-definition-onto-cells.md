# ADR-0032: Register applications at run time and stamp their definition onto cells

- Status: Accepted
- Date: 2026-11-10
- Amends: ADR-0012, ADR-0013
- Deciders: Dave Roberts (SA)

## Context
One control plane served one application: the CellDefinition (source, cell scripts, tenant scripts, `maxTenants`) was a deployment input of the control plane stack, and every cell was stamped from it (ADR-012). A vendor with two applications deployed two control planes under two fleet names, each with its own table, API, workflow, build projects and role pairs in every account. The vendor wants one control plane to onboard tenants of several applications in parallel, with each application either in accounts of its own or sharing accounts with other applications. The question is where an application's definition lives and how it reaches a cell.

## Options considered
### Option 1: An Application entity registered through the API
`PutApplication` is create-or-replace on `/applications/{applicationId}` with the former CellDefinition as its body. `CreateTenant` names the application; a new cell is stamped from the application's current definition, exactly as it was stamped from the deployment input. Pros: a new application needs no redeploy; the same reasoning as ADR-024 for accounts (an operator act, present when the error shows); the definition validation that ran at synth runs in the handler and answers 400; the integration test can register applications per run. Cons: four more operations; the supply-chain pin check (ADR-020) moves from a synth warning to a log line at registration.

### Option 2: A deployment-time list of applications
`applications: CellDefinition[]` in CDK context, stamped into the service environment. Pros: no new operations; synth keeps every validation. Cons: a new application is a redeploy of the control plane; the list is static for a run, so an integration test cannot exercise registration; accounts are already run-time registered, so the two configuration sources would differ for no reason.

### Option 3: One control plane per application
Keep the deployment input and run several control planes under distinct fleet names. Cons: that is the status quo the vendor is replacing; every account installs one role pair per control plane; an account shared by two applications is two registrations with two independent cell counters, so `maxCells` cannot bound the account.

## Decision
Option 1. An **application** is the fourth entity on the table (`APPLICATION#<applicationId>`), identified by an operator-chosen id (`[a-z0-9-]{1,32}`, also usable as a parameter path segment) and holding `source`, `cellScripts`, `tenantScripts`, `maxTenants` and the authoritative `cellCount`. `PutApplication` writes only the definition fields and never `cellCount`; `DeleteApplication` is a single conditional delete requiring `cellCount = 0`, the same rule as `DeleteAccount`. `CreateTenant` takes a required `applicationId` (404 if unknown; part of the idempotency hash). Cells and tenants carry an immutable `applicationId`; a new cell is stamped from the application at creation and keeps that stamp, so a changed definition affects only cells created afterwards (P-4, per application). The new-cell transaction claims the application's cell slot alongside the account's: account, application, cell and tenant (and the idempotency record) in one `TransactWriteItems`; the cell-delete transaction releases both. Scripts receive `APPLICATION_ID`. The control plane stack has no `cellDefinition` input.

## Consequences
The spec gains §4.1 (Application), §5.4 (application operations) and a fourth counter under P-6 (two code paths, both transactional). `ListCells` and `ListTenants` accept an `applicationId` filter, served by one more partition shape. The `CELL_DEFINITION` environment variable and `validateCellDefinition` at synth go; the same checks run in `PutApplication`. The acceptance test registers two applications and shows two of their cells in one account. The role pair, the build projects and the workflow are unchanged: source and scripts already arrive per execution (ADR-002). Revisit if applications ever need their own trust boundary (a role pair per application), which would make the application a deployment unit again.

**Amended by ADR-0039 (2026-11-12):** the application also holds parameter declarations. They sit outside the definition and are never stamped: requests are validated against the application's current declarations, whichever cell a deployment lives in.

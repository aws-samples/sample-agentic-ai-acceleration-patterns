# ADR-0040: Applications declare cell parameters with defaults

- Status: Accepted
- Date: 2026-11-12
- Amends: ADR-0039
- Deciders: Dave Roberts (SA)

## Context
ADR-0039 gave tenant scripts declared parameters and gave cell scripts none, because a cell serves many deployments and the values are per deployment. Cell scripts still need values of their own that can differ from cell to cell: an instance size, a shard count, a capacity tier for a busy cell. Values that are the same for every cell of an application already have a home in the versioned script source or in `/application-plane/applications/<applicationId>/shared/*`. A value that differs per cell has none. The hard constraint is that cells are never created by an operator request (R-11): placement creates them inside `CreateDeployment`, so at a cell's birth no one is present to supply a value.

## Options considered
### Option 1: Declarations with mandatory defaults, values changed through `UpdateCell`
The application declares `cellParameters` as `{name, default, description?}`. A new cell starts on the defaults; `UpdateCell` takes `parameters` and `removeParameters` and merges them into the values stored on the cell, as `UpdateDeployment` does for deployments. Cell scripts get `PARAM_<NAME>`. Pros: placement never needs a value it cannot get; the update and merge rules are the ones ADR-0039 already set; `GetCell` shows what a cell runs with. Cons: a cell that should start on a non-default value is built once on the default, then updated.

### Option 2: Allow required cell parameters
As option 1, with a `required` flag. Cons: a required parameter without a default leaves placement with nothing to fill it, so every new cell would fail or be refused.

### Option 3: Let `CreateDeployment` carry cell values
The request that creates a cell supplies its values. Cons: a tenant's onboarding request would shape a cell other tenants later share; whether a request creates a cell depends on the fleet at that moment, so the same request means different things at different times.

### Option 4: One declaration list with a scope field
Tenant and cell parameters in one list, each marked `tenant` or `cell`. Pros: one list. Cons: easy to mix up; the same field set means different rules (a cell parameter must have a default, a tenant parameter may be required).

### Option 5: Stamp the cell declarations onto each cell
Each cell keeps the declarations it was created with. Pros: a cell script only sees the set it was written for. Cons: the update rules then differ from cell to cell, and the tenant parameters of ADR-0039 already chose not to stamp.

## Decision
Option 1, with a separate list and no stamp. Specifically:

- **Declarations.** `PutApplication` takes up to 20 `cellParameters`. Names follow the tenant parameter rules and MUST NOT appear in both lists, so `PARAM_X` means one thing wherever it is set. Every cell parameter has a default; there is no `required` flag.
- **Values.** The cell record holds the values an operator set, empty at birth. `UpdateCell` merges a body of `parameters` and `removeParameters` in the conditional write that moves the cell to `UPDATING`, conditioned on the status and on the cell's map as read; a name in both, an undeclared name or a tenant parameter name is a 400. The map, not `updatedAt`, is the guard: placements and deployment deletes write a cell's `updatedAt` while it is `ACTIVE`, and must not fail an unrelated `UpdateCell`. `DeleteCell` never validates.
- **Resolution.** At accept time the stored values plus the defaults of unset declarations go into the execution input. Stored values for names no longer declared are still passed.
- **Who sees what.** Cell scripts get the cell set on every operation; tenant scripts do not. A tenant script that needs a cell value reads what the cell create script published under `/application-plane/cells/<cellId>/*`.
- **Delete scripts.** A cell delete script finds what the cell made through `/application-plane/cells/<cellId>/*`, never by recomputing from `PARAM_` values, because the default it receives can differ from the one its create used. A create script names a resource from the contract's ids only, or records its identifier before creating it, so a create that fails partway can still be cleaned up (R-35).
- **No secrets.** Same rule as ADR-0039 (N-11).

## Consequences
The spec changes P-3, P-4 (cell values tune a cell without changing what it can host, and placement never reads them), §4.1 (`cellParameters`), §4.2 (cell `parameters`) with a new R-34, §5.3 (`UpdateCell` body, `DeleteCell` resolution), §5.5 and §5.7 (validation), §6.1 (`PARAM_<NAME>` for cell scripts), §7.2, R-20, N-11 and the acceptance scenario. The §11 seam "parameters for cell scripts" is replaced by "cell parameter values at birth", which rides the pre-provisioning seam. The Smithy model gains a `CellParameterDeclaration` structure, a `cellParameters` member on the application, a `parameters` member on the cell output, and an input body on `UpdateCell`. The threat model entry planned for ADR-0039 covers cell values too. A cell that needs a non-default value runs its create build on the default and an update build afterwards; revisit if that second build is too costly, through per-account overrides or a pre-provisioning body.

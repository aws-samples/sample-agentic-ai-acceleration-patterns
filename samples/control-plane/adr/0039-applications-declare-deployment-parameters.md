# ADR-0039: Applications declare deployment parameters

- Status: Accepted
- Date: 2026-11-12
- Amends: ADR-0004, ADR-0017, ADR-0032
- Deciders: Dave Roberts (SA)

## Context
Tenant scripts often need a few values that differ per deployment and that only the operator knows at onboarding: an allowed email domain that restricts who may sign in, a log level, a feature switch. ADR-004 kept every such value out of the control plane and named a generic `parameters` map as the extension point. Without it, a script can only fetch the value from somewhere the operator wrote it by hand, so onboarding becomes two steps with no validation and no record of what a deployment was built with. Each application needs its own set, all of them optional unless the application says otherwise, and the values must reach the create, update and delete scripts alike. `UpdateDeployment` has no body today, and `adminEmail` reaches only the create script and is never stored, so neither path carries a value to later builds.

## Options considered
### Option 1: Declared parameters, values stored on the deployment
The application declares `{name, required, default?, description?}` entries. `CreateDeployment` and `UpdateDeployment` take values, validated against the declarations; the deployment stores them; every tenant build gets them as `PARAM_<NAME>` variables. Pros: a typo or a missing required value is a 400 at the API, not a failed build an hour later; update and delete see the same values as create; `GetDeployment` shows what a deployment runs with. Cons: the control plane holds application-plane values (opaque to it); the values are plaintext in the table, the execution history and the build overrides.

### Option 2: A free map, no declarations
Any name, any value, passed through. Pros: nothing to declare. Cons: a misspelt name reaches the script silently; nothing can say a value is required; no defaults.

### Option 3: Values in the tenant's SSM namespace, written out of band
The operator writes `/application-plane/tenants/<tenantId>/<applicationId>/*` before `CreateDeployment`. Pros: no control plane change. Cons: the namespace lives in the cell's account, which is unknown until placement runs; the operator needs write access to every hosting account, a customer's included; no validation.

### Option 4: Stamp the declarations onto the cell with the definition
As option 1, but each cell keeps the declarations it was created with. Pros: a script only ever sees the parameter set it was written for. Cons: two deployments of one application can need different values depending on their cell, which placement chooses; `CreateDeployment` could not validate before placement.

## Decision
Option 1, with the declarations held on the application and not stamped. Specifically:

- **Declarations.** `PutApplication` takes up to 20 declarations. Names match `[A-Z][A-Z0-9_]{0,63}`; a required parameter has no default. The declarations are replaceable and apply to the next request; existing stored values are kept.
- **Values.** `CreateDeployment` takes `parameters` (name to string, at most 1,024 characters each). An undeclared name or a missing required value is a 400 before placement. The values are part of the idempotency hash.
- **Partial update.** `UpdateDeployment` takes `parameters` (set these) and `removeParameters` (drop these); every other stored value is kept. A name in both, or removing a required parameter, is a 400. The merge rides the conditional write that moves the deployment to `UPDATING`, so two updates cannot interleave. A `removeParameters` list is used instead of null map values because a sparse map is awkward for many clients, and an empty string is a valid value, not a deletion.
- **Resolution.** At accept time the service resolves the stored values plus the defaults of unset declared parameters into the execution input. A parameter with neither is absent from the environment. Stored values for names no longer declared are still passed, so a delete script can clean up after them. `DeleteDeployment` never validates (cleanup is always reachable).
- **Environment.** Tenant scripts get `PARAM_<NAME>` on every operation. The prefix keeps a declared name off the contract's own variables and the build's (`TENANT_ID`, `AWS_REGION`, `PATH`). Cell scripts get no parameters.
- **No secrets.** Values are plaintext. A secret is passed by name (a Secrets Manager secret or an SSM `SecureString` in the tenant namespace) and read by the script under its own role. The service logs names, never values.

## Consequences
The spec changes P-3 (the control plane carries declared values but never interprets them), §4.1 and §4.4 (the two new fields), R-32 and R-33 (resolution, validation and merge), §5.2 and §5.5 (the operation inputs), §6.1 (`PARAM_<NAME>`), §7.2 (a tolerated race with `PutApplication`), §7.3 (the hash), N-11 (no secrets) and the acceptance scenario; the §11 seam for opaque parameters is replaced by seams for secret parameters and cell parameters. The Smithy model gains a `ParameterDeclaration` structure, a `parameters` member on the application, on `CreateDeployment`, on `UpdateDeployment` (with `removeParameters`) and on the deployment output; the workflow passes the resolved set as CodeBuild environment-variable overrides. The threat model gains an entry for parameter values in the table, the execution history and `BatchGetBuilds` when the code lands. Making a parameter required on a live application turns the next `UpdateDeployment` of every deployment lacking it into a 400 until the operator supplies the value, which is deliberate: the operator decides when each deployment gets it. Revisit if applications need secret values held by the control plane, or per-cell parameters for cell scripts; both are recorded seams.

**Amended by ADR-0040 (2026-11-12):** cell scripts now receive parameters too, from a separate `cellParameters` list on the application. Every cell parameter has a default, a new cell starts on the defaults, and `UpdateCell` changes a cell's values with the same merge as `UpdateDeployment`. A name may not appear in both lists.

# ADR-0025: Provision through a per-account role pair assumed by the build projects

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR-0002, ADR-0012, ADR-0019, ADR-0022
- Amended by: ADR-0028, ADR-0029
- Deciders: Dave Roberts (SA)

## Context
With cells in several accounts (ADR-024), provisioning scripts must run with permissions in the cell's account. The CodeBuild projects live in the control plane account, so a build must assume a role in the target account. P-12 requires the cell/tenant permission asymmetry to survive, P-4 wants one code path, and the customer-sovereignty scenario requires that the account owner, not the vendor, decides what provisioning may do and can revoke it.

## Options considered
### Option 1: Uniform — every build assumes a role pair installed in the hosting account, the control plane's own account included
A deployable `CellAccountStack` installs `<fleet>-cell-provisioning` and `<fleet>-tenant-provisioning` with the §6.2 permissions, trusting the control plane's two build roles by fixed name and an optional `sts:ExternalId`. The control plane stack installs the same pair in its own account. The build roles keep only AssumeRole on those names, source read, and logs. Pros: one buildspec, one trust model, identical script credentials everywhere; the owner's trust policy is the gate and revocation is deleting the pair. Cons: fixed role names (hence a `fleetName` input); an AssumeRole per build; role chaining caps script credentials at one hour.

### Option 2: Hybrid — home-account builds run under the build roles as before, foreign accounts assume a role
Pros: no change for single-account deployments. Cons: two code paths in the buildspec and IAM; scripts see different credential shapes by account; the home account is a special case that hides cross-account bugs until the first foreign cell.

### Option 3: Per-account CodeBuild projects deployed into each account
Pros: no role chaining. Cons: build infrastructure in the customer's account, a cross-account StartBuild path, and per-account workflow wiring — the proliferation P-1 forbids.

## Decision
Option 1. The one-hour chaining cap equals the existing build task budget (R-23), so nothing is lost and the two limits are now the same number (N-7). Each build role's AssumeRole resource is its own half of the pair by name in any account (`arn:…:iam::*:role/<fleet>-cell-provisioning` for the cell build, `…/<fleet>-tenant-provisioning` for the tenant build) because accounts are registered at run time (ADR-024); that is safe because the target trust policy, written by the owner, is the gate. `externalId` closes the confused deputy for customer accounts and is harmless on vendor accounts. The AssumeRole session name is the verified operator id, so the owner's CloudTrail attributes provisioning to the operator (extends ADR-019 into the target account). `tenantBuildManagedPolicyArns` keeps its name and account check but attaches to the tenant provisioning role of the stack's own account (control plane stack or `CellAccountStack`), so a customer attaches policies in their account and the vendor never does (narrows ADR-022). The buildspec assumes the role and exports the credentials before `bash "$SCRIPT_PATH"`; scripts gain `CELL_ACCOUNT_ID`.

## Consequences
Single-account deployments gain one step: register the home account (ADR-024); the pair itself comes with the control plane stack. Two control planes in one account need distinct `fleetName`s because role names are physical. A refused AssumeRole is a normal build failure landing in `*_FAILED` with the refusal as `statusReason` — the control plane's view of a customer revoking access. Scripts that need more than an hour must become resumable steps (R-15, R-27). The threat model gains the cross-account surface: wildcard-account AssumeRole resource, external id handling, and credential exposure in build logs. Revisit if a target needs a different Region (the credentials already work in any Region; the gap is the account record and script input, spec §11).

---

**Amended by ADR-0028 (2026-11-09):** each half of the pair trusts the control plane's API role (`<fleet>-api`) as well as its build role, so the PutAccount handshake probe can assume it. Found on the first integration run.

**Amended by ADR-0029 (2026-11-09):** the external id is required, not recommended, for tenant-owned accounts; `PutAccount` refuses `owner: TENANT` without one. Vendor-owned accounts may still omit it.

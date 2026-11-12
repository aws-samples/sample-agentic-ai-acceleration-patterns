# Control Plane — Architecture Decision Records

One file per decision, numbered in the order they were made; the number is
never reused. Records are immutable once accepted: a change is a new record
that supersedes the old one. Prose elsewhere in this sample cites records by
their original three-digit form (`ADR-012`); the file is `0012-*.md`.

Template for new records: [`docs/sample-standard.md` §2.2](../../../docs/sample-standard.md#2-design-trail).

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](0001-no-placement-entity.md) | No placement entity — the 1:1 link needs no join | Superseded by ADR-0037 | — |
| [ADR-0002](0002-one-shared-codebuild-project.md) | One shared CodeBuild project with per-execution StartBuild overrides | Accepted | — |
| [ADR-0003](0003-forward-caller-jwt-cross-service.md) | Cross-service calls forward the caller's vendor JWT | Superseded by ADR-009 | — |
| [ADR-0004](0004-vendor-idp-only.md) | The control plane knows only the vendor IdP; customer identity is an application plane decision | Accepted | — |
| [ADR-0005](0005-async-mutations-via-step-functions.md) | Mutations that end in CodeBuild are async (202) via Step Functions | Accepted | — |
| [ADR-0006](0006-control-plane-data-not-tenant-scoped.md) | Control plane data is not tenant-scoped by caller | Accepted | — |
| [ADR-0007](0007-cross-service-status-propagation.md) | Cross-service status propagation | Superseded by ADR-009 | — |
| [ADR-0008](0008-resource-is-a-provisioned-silo.md) | A resource is a provisioned silo instance; its lifecycle runs the scripts | Superseded by ADR-012 | — |
| [ADR-0009](0009-single-service-tenant-embeds-resource.md) | Single service — the tenant embeds its silo resource | Accepted | — |
| [ADR-0010](0010-shared-resources-via-ssm-parameters.md) | Shared resources are supplied to the application plane via SSM parameters read at deploy time | Accepted | — |
| [ADR-0011](0011-resolve-inputs-before-execution.md) | Resolve workflow inputs before execution and update records by field ownership | Accepted | — |
| [ADR-0012](0012-cell-based-deployment-model.md) | Cell-based deployment model with a deployment-configured CellDefinition | Accepted | 2026-09-07 |
| [ADR-0013](0013-implicit-cell-creation-atomic-slot-claim.md) | Implicit cell creation; capacity via an atomic slot claim whose lifetime equals the tenant record | Accepted | 2026-09-07 |
| [ADR-0014](0014-explicit-cell-scale-in.md) | Cell scale-in is explicit — empty cells persist until an operator deletes them | Accepted | 2026-09-07 |
| [ADR-0015](0015-authentication-only-gating.md) | Authentication-only gating under the dedicated operator-issuer assumption | Accepted | 2026-09-07 |
| [ADR-0016](0016-unsigned-pagination-tokens.md) | Pagination tokens stay unsigned — partition-pinned queries make forged tokens harmless | Accepted | 2026-09-07 |
| [ADR-0017](0017-create-tenant-idempotency.md) | CreateTenant idempotency via an optional clientToken and a transactional idempotency record | Accepted | 2026-09-07 |
| [ADR-0018](0018-enforce-role-claim.md) | Enforce the `role` claim as a coarse membership gate (threat model M13) | Accepted | 2026-09-15 |
| [ADR-0019](0019-operator-identity-end-to-end.md) | Operator identity flows end-to-end — access logs to build environment (threat model M12) | Accepted | 2026-09-15 |
| [ADR-0020](0020-supply-chain-pinning-warn-and-allow.md) | Supply-chain pinning is warn-and-allow — a full commit SHA is the only immutable ref (threat model M10) | Accepted | 2026-09-15 |
| [ADR-0021](0021-bounded-blast-radius.md) | Bounded blast radius for amplification and log exposure (threat model M15/M17) | Accepted | 2026-09-15 |
| [ADR-0022](0022-attach-deployer-supplied-managed-policies-to-the-tenant-build-role.md) | Attach deployer-supplied managed policies to the tenant build role | Accepted | 2026-10-26 |
| [ADR-0023](0023-pass-the-tenant-name-to-tenant-scripts.md) | Pass the tenant name to tenant scripts as `TENANT_NAME` | Accepted | 2026-10-26 |
| [ADR-0024](0024-register-accounts-at-run-time-and-claim-cell-slots-atomically.md) | Register accounts at run time and claim cell slots atomically (amends ADR-013, ADR-014) | Accepted | 2026-11-09 |
| [ADR-0025](0025-provision-through-a-per-account-role-pair.md) | Provision through a per-account role pair assumed by the build projects (amends ADR-002, ADR-012, ADR-019, ADR-022) | Accepted | 2026-11-09 |
| [ADR-0026](0026-fleet-full-is-a-modelled-error.md) | Fleet full is a modelled `InsufficientCapacityError`, never new capacity | Accepted | 2026-11-09 |
| [ADR-0027](0027-verify-the-account-handshake-at-registration.md) | Verify the account handshake at registration | Accepted | 2026-11-09 |
| [ADR-0028](0028-the-role-pair-also-trusts-the-control-plane-api-role.md) | The account role pair also trusts the control plane API role (amends ADR-025, ADR-027) | Accepted | 2026-11-09 |
| [ADR-0029](0029-require-an-external-id-for-tenant-owned-accounts.md) | Require an external id for tenant-owned accounts (amends ADR-025) | Accepted | 2026-11-09 |
| [ADR-0030](0030-prove-the-pair-enforces-the-external-id.md) | Prove the pair enforces the external id with a negative probe (amends ADR-0027, ADR-0029) | Accepted | 2026-11-10 |
| [ADR-0031](0031-lost-placement-races-on-a-full-fleet-are-a-retryable-conflict.md) | Lost placement races on a full fleet are a retryable conflict (amends ADR-0026) | Accepted | 2026-11-10 |
| [ADR-0032](0032-register-applications-at-run-time-and-stamp-their-definition-onto-cells.md) | Register applications at run time and stamp their definition onto cells (amends ADR-0012, ADR-0013) | Accepted | 2026-11-10 |
| [ADR-0033](0033-account-admission-is-an-application-allowlist-on-the-account.md) | Account admission is an application allowlist on the account (amends ADR-0024) | Accepted | 2026-11-10 |
| [ADR-0034](0034-the-shared-parameter-namespace-is-per-application.md) | The shared parameter namespace is per application (amends ADR-0010) | Accepted | 2026-11-10 |
| [ADR-0035](0035-new-cells-go-to-dedicated-accounts-before-shared-ones.md) | New cells go to dedicated accounts before shared ones (amends ADR-0024) | Accepted | 2026-11-10 |
| [ADR-0036](0036-the-application-chooses-fill-or-round-robin-across-accounts.md) | The application chooses fill or round robin across accounts (amends ADR-0035) | Accepted | 2026-11-11 |
| [ADR-0037](0037-a-deployment-is-one-tenant-in-one-application.md) | A deployment is one tenant in one application (supersedes ADR-0001; amends ADR-0009, ADR-0012, ADR-0013, ADR-0017, ADR-0023, ADR-0032) | Accepted | 2026-11-11 |
| [ADR-0038](0038-an-account-wide-shared-namespace-beside-the-per-application-one.md) | An account-wide shared namespace beside the per-application one (amends ADR-0034, ADR-0010) | Accepted | 2026-11-11 |

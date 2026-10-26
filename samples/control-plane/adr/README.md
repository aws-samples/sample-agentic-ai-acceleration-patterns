# Control Plane — Architecture Decision Records

One file per decision, numbered in the order they were made; the number is
never reused. Records are immutable once accepted: a change is a new record
that supersedes the old one. Prose elsewhere in this sample cites records by
their original three-digit form (`ADR-012`); the file is `0012-*.md`.

Template for new records: [`docs/sample-standard.md` §2.2](../../../docs/sample-standard.md#2-design-trail).

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](0001-no-placement-entity.md) | No placement entity — the 1:1 link needs no join | Accepted | — |
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

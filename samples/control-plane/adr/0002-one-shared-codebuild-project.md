# ADR-0002: One shared CodeBuild project with per-execution StartBuild overrides

**Status:** Accepted for the implemented silo baseline; refined by ADR-012
for the cell design, which uses separate shared cell and tenant projects/roles

**Context:** Each tenant carries its own `ProjectSource`. Options: create a
CodeBuild project per tenant (control plane mutates build infrastructure), or
run everything through one shared project using `StartBuild` overrides.

**Decision:** For the silo baseline, one shared CodeBuild project.
`StartBuild` supplies `sourceTypeOverride`, `sourceLocationOverride`,
`buildspecOverride` (inline buildspec that executes `$SCRIPT_PATH`), and
`environmentVariablesOverride` per execution. Verified against the CodeBuild
API reference 2026-09-03. The cell design retains shared projects but splits
cell and tenant builds into two projects with distinct service roles
(ADR-012), because their application-plane permissions differ.

**Consequences:** Tenant records stay pure metadata — no orphaned CodeBuild
projects on offboarding. One IAM service role is the single provisioning
blast radius (documented hardening point). Trade-off: source auth for private
repos is configured at the project level (CodeConnections), not per tenant —
acceptable for a sample; per-tenant `auth` support is a noted extension.

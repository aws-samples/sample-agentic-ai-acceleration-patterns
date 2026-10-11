# ADR-0010: Shared resources are supplied to the application plane via SSM parameters read at deploy time

**Status:** Accepted

**Context:** Silo deployments are rarely 100% isolated — some application
plane infrastructure is shared across tenants (a VPC, a hosted zone / base
domain, a container image repository, an event bus). Provisioning scripts
need references to these shared resources when deploying a silo. Options:
the control plane stores and injects them (as build environment variables),
scripts hardcode them in source, or scripts resolve them at deploy time from
a well-known location.

**Decision:** Shared application plane resources publish their identifiers to
SSM Parameter Store under an agreed namespace (`/application-plane/shared/<name>`).
Create/update scripts read them **at deploy time** during the CodeBuild run
(`aws ssm get-parameter`) and wire them into the silo. The CodeBuild service
role is granted `ssm:GetParameter` on that namespace. The control plane is
not involved in the exchange.

**Consequences:** Consistent with ADR-004's plane boundary — the control
plane carries no application plane configuration; SSM is the contract between
shared infrastructure and silo deployments. Deploy-time resolution means
shared resource changes (e.g. a new image tag) take effect on the next
create/update build with no control plane change and no tenant record
mutation. Scripts fail fast if a required parameter is missing — a clear
`CREATE_FAILED`/`UPDATE_FAILED` with the missing parameter in `statusReason`.
Trade-off: the namespace is an implicit contract; the sample documents it and
ships a demo parameter alongside the sample scripts.

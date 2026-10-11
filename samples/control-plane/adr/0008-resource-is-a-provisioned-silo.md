# ADR-0008: A resource is a provisioned silo instance; its lifecycle runs the scripts

**Status:** Superseded by ADR-012 — the provisioning definition moves from the tenant to the deployment-configured CellDefinition

**Context:** An early draft treated a resource as a reusable template
(source + scripts) provisioned through placements. The silo model simplifies
this: every tenant gets exactly one dedicated resource, defined at onboarding.

**Decision:** The resource *is* the provisioned instance. Its definition
(`source` + `scripts`) is provided in `CreateTenant`. The create/update/delete
scripts are executed by the shared CodeBuild project for the matching
lifecycle operation.

**Consequences:** No template catalogue. Alternative considered: a
deployment-configured default silo definition (CDK context) so `CreateTenant`
needs only a name — rejected as the default because it hides the
`ProjectSource` requirement from the API surface, but trivially added later
as a fallback when `resource` is omitted.

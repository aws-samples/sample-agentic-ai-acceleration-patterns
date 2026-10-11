# ADR-0004: The control plane knows only the vendor IdP; customer identity is an application plane decision

**Status:** Accepted (revised — customer IdP removed from the control plane)

**Context:** Earlier drafts took two identity providers as deployment inputs:
the vendor IdP protecting the control plane, and a customer IdP injected as
environment variables into provisioning builds so scripts could configure
application-plane auth. On review, the customer IdP is an **application plane
decision** — which identity provider a silo uses to authenticate its end
users belongs to the silo's own definition, not to control plane
configuration.

**Decision:** The control plane takes exactly one identity input: the vendor
IdP (issuer URL + audience, via CDK context), consumed by the Lambda
Authorizer (JWKS-based JWT validation) on every operation. Customer identity
is entirely the provisioning scripts' concern — a script that needs IdP
configuration carries it in its own source or fetches it itself. The control
plane passes only tenant identity (`TENANT_ID`, `OPERATION`) to builds.

**Consequences:** A cleaner plane boundary: the control plane holds no
application plane configuration of any kind and needs no changes when silo
auth strategies differ per tenant or evolve. Scripts that need per-tenant
customer IdP settings own that problem end to end. The boundary test is
*configuration vs. onboarding input*: `adminEmail` (the first customer
admin, passed to the create script as `ADMIN_EMAIL` for application plane
user bootstrap) is onboarding input that crosses the boundary exactly once —
it is **not persisted** on the tenant record, where it would add no value
after the script has run; it survives only in the workflow execution history
and build logs, which suffice for audit. If a future variant wants the
control plane to carry opaque per-tenant configuration to scripts, the
extension point is a generic `parameters: map<string, string>` field on the
tenant's resource definition, passed through as build environment variables —
deliberately generic, not IdP-shaped.

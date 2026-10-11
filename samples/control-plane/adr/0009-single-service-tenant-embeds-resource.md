# ADR-0009: Single service — the tenant embeds its silo resource

**Status:** Accepted

**Context:** The stated goal is **the simplest correct silo control plane**.
The two-service split (tenant service + resource service) generated all of the
design's hard questions — cross-service auth (ADR-003), status propagation
(ADR-007), service discovery — while the 1:1 relationship meant the resource
had no independent existence: created only with its tenant, deleted only with
its tenant, status mirroring the tenant's. A service boundary that adds
machinery without adding capability is the boundary to remove.

**Decision:** One service, one table, one API. The tenant record embeds the
silo (`source`, `scripts`, `status`, `lastBuildId`). Resource create/delete
have no standalone API — they are `CreateTenant`/`DeleteTenant`. The silo
remains readable and re-applicable as a singleton sub-resource:
`GET /tenants/{tenantId}/resource` and `PUT /tenants/{tenantId}/resource`
(runs the update script). The provisioning workflow writes terminal state
directly to the shared table.

**Consequences:** Seven API operations; zero cross-service calls, zero
propagation machinery, zero discovery. One status field — truthful in a silo
model, where tenant lifecycle is silo lifecycle. What is lost: the sample no
longer demonstrates multi-service control plane composition (service-to-service
auth, event-driven propagation) — those patterns are preserved as reference
analysis in ADRs 003 and 007. **Re-split seam** for pooled/hybrid models:
extract the embedded `ResourceDefinition` into a resource service with
independent lifecycle, reintroduce placement as the tenant↔resource join
(ADR-001), and adopt ADR-007's option 1 or 4 for propagation. The
`/tenants/{tenantId}/resource` sub-path is exactly where that extraction
happens without breaking clients.

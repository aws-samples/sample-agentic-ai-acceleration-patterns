# ADR-0001: No placement entity — the 1:1 link needs no join

**Status:** Accepted (folded into ADR-009); the predicted seam is exercised by ADR-012 — placement returns as `tenant.cellId`

**Context:** Early drafts modelled a placement entity linking tenants to
resources, with its own CRUDL API. In the silo model the link is strictly 1:1,
and the resource had to know its tenant anyway (provisioning scripts receive
`TENANT_ID`). The placement stored nothing the resource didn't, mirrored its
status, and pass-through-ed every operation.

**Decision:** Cut it. A placement entity is the evolution seam for
pooled/hybrid models (where it becomes the N:1 join between tenants and shared
resources) — reintroduce it when a pooled variant is actually built rather
than carrying speculative generality in a silo-only sample.

**Consequences:** Fewer entities and operations. ADR-009 later took the same
reasoning one step further and removed the separate resource entity too.

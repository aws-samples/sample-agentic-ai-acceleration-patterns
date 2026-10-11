# ADR-0006: Control plane data is not tenant-scoped by caller

**Status:** Accepted

**Context:** The usual multi-tenant pattern scopes every operation to the
caller's `tenantId` from the JWT. Here, callers are vendor operators managing
*all* tenants — tenants are the subject of the API, not the caller.

**Decision:** The authorizer validates vendor IdP JWTs and emits a
`CallerContext { operatorId, role }` rather than a tenant-scoped context.
Tenant partitioning in DynamoDB (`PK=TENANT#...`) is retained as the data
layout, keyed by the *target* tenant from the request, not the caller. The
configured issuer is dedicated to the control plane and issues tokens only to
fully privileged vendor operators; the sample intentionally has no
per-operation role matrix.

**Consequences:** The ingress-extracts-context pattern is preserved (handler
is a pass-through, service never sees the raw event), but the context carries
operator identity. `role` is retained for audit and future extension, not
current authorization. A deployment that connects a broader workforce or
customer issuer must add and enforce an explicit role matrix first.
Application-plane services built on top of this sample would use the
conventional caller-tenant-scoped context.

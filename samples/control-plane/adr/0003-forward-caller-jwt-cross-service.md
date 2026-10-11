# ADR-0003: Cross-service calls forward the caller's vendor JWT

**Status:** Superseded by ADR-009 (no cross-service calls remain)

**Context:** The two-service design needed the tenant service to call the
resource service's API in the request path.

**Decision (historical):** Forward the caller's vendor IdP JWT rather than
introducing M2M client credentials — valid because all cross-service calls
happened in the request path where the token is live.

**Consequences:** The pattern (and its constraint — background workflows have
no live token, see ADR-007) remains the reference approach if the sample is
ever re-split into multiple services.

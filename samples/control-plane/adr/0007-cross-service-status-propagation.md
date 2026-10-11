# ADR-0007: Cross-service status propagation

**Status:** Superseded by ADR-009 (no propagation needed — single service)

**Context:** In the two-service design, the provisioning workflow finished
minutes after the API returned 202, and the tenant service had to learn the
outcome. Four mechanisms were evaluated:

1. **EventBridge push** — resource service publishes terminal-state events;
   tenant service consumes. No credentials, one bus + rule + Lambda; event
   schema contract, at-least-once delivery.
2. **Caller-driven read-repair** — `GetTenant` polls `GetResource` with the
   live caller JWT and lazily repairs status. Rejected: reads gain side
   effects, `ListTenants` stays stale, and tenant record *removal* becomes a
   side effect of a `GET` — offboarded tenants persist as ghosts unless polled.
3. **Tenant-side polling workflow with the caller JWT** — rejected: the token
   must sit in Step Functions execution state (visible in execution history),
   and provisioning routinely outlasts JWT TTL — expiry mid-poll strands the
   tenant in `CREATING` with no remediation.
4. **Tenant-side polling workflow with M2M client credentials** — sound
   (token fetched per poll, never stored), at the cost of an M2M client on
   the vendor IdP and a Wait-loop state machine.

**Decision (historical):** EventBridge (option 1) as the fewest moving parts
with zero credential management; option 4 the runner-up where demonstrating
service-to-service auth matters.

**Consequences:** ADR-009 dissolved the problem — the workflow and the tenant
table are in the same service, so terminal state is written directly. This
analysis remains the reference if the sample is ever re-split.

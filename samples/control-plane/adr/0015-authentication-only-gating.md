# ADR-0015: Authentication-only gating under the dedicated operator-issuer assumption

**Status:** Accepted (2026-09-07) — amended by ADR-018 (the `role` claim is now enforced as a coarse membership gate; the no-per-operation-matrix decision stands)

**Context:** Every operation requires a vendor IdP JWT, but no operation
checks a role or scope — any authenticated caller can perform any operation.
For a broad trust population that would be an
authenticated-as-authorized flaw. The dangerous variant of that flaw was
eliminated by ADR-012 (callers can no longer supply provisioning code), but
the question remained whether the sample should implement a per-operation
role/scope matrix.

**Decision:** Keep gating on authentication alone, and make the assumption
that justifies it explicit: the configured issuer is a **dedicated
control-plane trust boundary** that issues tokens exclusively to fully
privileged vendor operators (§2 of the architecture). Under that assumption
every authenticated caller IS authorized for every operation, and a
role/scope matrix would gate nothing — it would be configuration surface
with no consumer, inventing requirements the sample does not have. The
`role` claim is carried honestly (present only when the IdP issued it, never
fabricated) for audit and as the extension point.

**Consequences:** Connecting a broader issuer — workforce, customer, or any
population that is not uniformly privileged — requires designing an explicit
role/scope matrix and enforcing it per operation BEFORE deployment;
authentication alone is not sufficient for that trust population. The
extension point is mechanical: the authorizer already forwards `role`, and
`CallerContext` already carries it to every operation. This is a documented
boundary of the sample, not a TODO — there is no half-built gating to
maintain, and no false impression that a partial matrix protects anything.

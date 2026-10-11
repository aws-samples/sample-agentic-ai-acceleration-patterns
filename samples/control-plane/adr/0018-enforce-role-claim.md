# ADR-0018: Enforce the `role` claim as a coarse membership gate (threat model M13)

**Status:** Accepted (2026-09-15)

**Context:** ADR-015 kept gating on authentication alone under the
dedicated-issuer assumption, carrying the `role` claim unenforced. The
threat model (T2 issuer misconfiguration, T20 issuer scope creep) showed
that assumption has no code-side backstop: pointing `vendorIdpIssuerUrl` at
a broader issuer — or gradual client/audience reuse on the dedicated one —
silently makes every token holder a control-plane admin. The failure mode
is configuration drift, not an exploit, so it needed a check that fails
closed inside the authorizer.

**Decision:** The authorizer enforces the `role` claim against an allowed
set (`ALLOWED_ROLES` env var, comma-separated, default `operator`). A token
whose `role` is missing or outside the set is denied — never defaulted,
because a fabricated role would grant by omission. `ALLOWED_ROLES` set but
empty (e.g. `",,"`) throws at cold start: an explicit misconfiguration must
not silently widen (fallback) or blankly deny (empty set) access. This is a
coarse membership gate, not the per-operation matrix ADR-015 declined —
every allowed role still holds all eleven operations.

**Consequences:** A misconfigured broader issuer no longer grants admin to
its whole population — only to principals whose tokens carry an allowed
role, which a workforce/customer issuer does not mint by accident. Issuer
scope creep (T20) now requires both a token AND the claim. The IdP must
issue `role: "operator"` on operator tokens (deployment contract, README
checklist). The extension point for a real matrix is unchanged: the claim
is validated at the boundary and carried in `CallerContext`.

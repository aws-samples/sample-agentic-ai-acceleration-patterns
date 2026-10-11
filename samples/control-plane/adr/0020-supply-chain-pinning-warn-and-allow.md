# ADR-0020: Supply-chain pinning is warn-and-allow — a full commit SHA is the only immutable ref (threat model M10)

**Status:** Accepted (2026-09-15)

**Context:** The provisioning source is fetched fresh by CodeBuild on every
lifecycle build and executed via `bash "$SCRIPT_PATH"` under the fleet
roles. With no ref pinning, a poisoned commit on the default branch is
arbitrary code execution across the fleet on the next lifecycle operation
(T5 — the threat model's highest-consequence open item). The sample had no
way to express an immutable source at all.

**Decision:** `SourceDefinition` gains an optional `sourceVersion`, stamped
per cell like the rest of the definition and forwarded to CodeBuild
StartBuild as `SourceVersion` (a Choice state sends the pinned/unpinned
task variant so an empty string is never passed). Synthesis warns — does
not fail — when `sourceVersion` is absent or not a full 40-character commit
SHA: branches and tags are mutable refs anyone with repo write access can
move, so only a commit SHA counts as pinned. Warn-and-allow because mutable
refs are legitimate during development and this is a sample; the README
hardening checklist makes pinning a production gate.

**Consequences:** A pinned fleet executes exactly the reviewed commit —
compromising the repo no longer changes what existing cells run; the attack
must move to the deployment path (CellDefinition change), which is a
reviewed CDK deploy. Updating provisioning code for pinned cells becomes an
explicit act (new SHA → new/updated cells), which is the point. Unpinned
deployments still work but carry a synth-time warning naming the threat.
Content trust (branch protection, signing, read-only deploy credentials)
remains repository-side — documented in the checklist, not enforceable from
the pipeline.

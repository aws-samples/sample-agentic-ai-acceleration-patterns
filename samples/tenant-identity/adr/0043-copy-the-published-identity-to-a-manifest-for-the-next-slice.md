# ADR-0043: Copy the published identity to a manifest for the next slice

- Status: Accepted
- Date: 2026-11-21
- Amends: ADR-0042
- Deciders: Dave Roberts (SA)

## Context
ADR-0042 has the stress slice publish one JSON parameter, `/<prefix>/identity`
(stack name, API URL, API id, pool id, app client id, Region; ids and names
only), for the next slice. In a platform run the next slice is
`agentic-runtime-isolation`, which runs its load from the k6 driver host and
reads every input from manifest
files in `$STRESS_HOME/$STRESS_PREFIX/` (`stress/README.md`, "Platform mode:
manifests"): ids and names only, a file per producer, each checked before use
with a message that names the file and the slice that writes it.

## Options considered
### Option 1: The next slice reads the SSM parameter itself
Pros: one source of truth, nothing to keep in step. Cons: the consumer then
needs `ssm:GetParameter` on a path that belongs to another slice, and a
missing or unusable parameter cannot name the producing slice the way a
missing manifest does; the other three inputs it reads are files.

### Option 2: Copy the parameter's value to `identity.json` on every `deploy`
Pros: one input style for the consumer; the same check and the same error
text as for the other manifests; the file holds the value the parameter holds,
so there is nothing to translate. Cons: a second copy that goes stale if the
parameter changes outside `deploy`.

## Decision
Option 2. `slice.sh deploy` calls `scripts/stress/identity-manifest.sh write`
after `driver publish`: the value of the parameter goes to
`$STRESS_HOME/$STRESS_PREFIX/identity.json` through a temporary file moved into
place, so a failed read leaves an earlier file as it was and no empty one.
`teardown --fixtures` calls `identity-manifest.sh remove` after the parameter
is gone, with the tenant manifest, so the manifest and the parameter go
together (ADR-0042). The file is mode 0600 in a 0700 folder and holds no
secret.

## Consequences
Easier: the consumer reads all four of its manifests the same way and names the
producer when one is missing.

Harder: `deploy` is the only writer, so a parameter changed by hand is not
seen until the next `deploy`. `identity-manifest.sh` has a test
(`test/stress/identity-manifest.test.ts`) with a stubbed `aws`.

Revisit when: a second consumer wants the parameter, or the runner passes
manifests itself.

<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0026: Run the Python tests and the tree checks in the projen build

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

A projen TypeScript project runs jest and eslint only. The runner is
Python, its Dockerfiles and the scripts are not TypeScript, and the
standard asks for an MIT-0 header on every authored file, no account
ids or aliases in the tree, and the sample's terms ("vendor", "tenant").
Several contributors build this sample in parallel; each new dependency would
change `.projenrc.ts` and `package-lock.json`, which do not merge cleanly.

## Options considered

### Option 1: projen tasks that `test` spawns, and one owner for the project files
Pros: `npx projen build` is the single gate; nothing to install (Python 3
standard library, bash, git). Cons: the checks are grep-based, so they
catch forms, not meaning.

### Option 2: Separate CI steps
Pros: richer tools (ruff, a header linter). Cons: the repository has no CI
for samples; the gate would be a habit, not a build.

## Decision

Option 1. `test` spawns, after jest and eslint:

- `test:runner`: `python3 -B -m unittest discover -s runner/tests -t .`
  from the sample root; tests need no root and no Docker. Behaviour that
  needs Linux privileges or a real sandbox (uid drop, seccomp, cgroups,
  PID 1 reaping) is proven by the integration test, and the runner owner
  lists which is which in `integration-test.md`.
- `check:headers` (`scripts/check-headers.sh`): every tracked or new
  `.py`, `Dockerfile` and `.sh` file carries the two header lines in its
  first five lines.
- `check:terms` (`scripts/check-terms.sh`): none of the terms the
  standard bans in favour of "vendor" and "tenant" (the pattern is in the
  script, with two AWS network terms the spec quotes allowed), no account
  alias of the test account, and no 12-digit number, in any tracked or
  new file except generated ones. Account aliases are private, so the
  script does not list them; a contributor passes them in
  `CHECK_TERMS_PRIVATE`.

`.projenrc.ts` and `package-lock.json` already carry every dependency the
sample needs (ADR-0023); only the maintainers change them, and a missing
dependency is a question for the maintainers (`scripts/CONVENTIONS.md`).

## Consequences

`npx projen build` fails on a missing header, a banned term or a red
Python test, in every contributor's branch. A Python linter is not part of the
gate. A check that needs an exception edits the allowed list in the script
with a reason.

<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0037: Name the backend in the runner environment, and pin the runner images

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

One runner program serves three backends with different ports, nonce
rules, memory caps and filters (spec §3.5). The `nitro` and `agentcore`
images come from one Dockerfile, so the image alone does not say which
backend it runs in. Guessing from the environment (a `RUNNER_NONCE_HASH`
means `nitro`) would turn a missing variable into the wrong adoption rule.
The `microvm` image runs the AL2023 `python3` package, which is Python 3.9,
and its Dockerfile must pin that package to an exact version (spec §3.5).
The scaffold's container Dockerfile declared `ARG TARGETPLATFORM` before
`FROM --platform=$TARGETPLATFORM`; with the Docker builder on the build
host that left the platform empty and the build failed.

## Options considered

### Option 1: An explicit `RUNNER_BACKEND` variable
`microvm`, `nitro` or `agentcore`, required; the runner exits 1 when it is
missing or unknown. Pros: one obvious rule, and a misconfigured task fails
at start, not at the first job. Cons: two backends must set one more
variable.

### Option 2: Infer the backend from the environment
Pros: no new variable. Cons: a `nitro` task whose override lost
`RUNNER_NONCE_HASH` would run with the `agentcore` session rule.

## Decision

Option 1.

- `runner/microvm/Dockerfile` sets `ENV RUNNER_BACKEND=microvm`. The
  `nitro` task definition and the `agentcore` runtime set
  `RUNNER_BACKEND` in the container environment. The runner removes
  `RUNNER_NONCE_HASH` from its own environment at start, and hands code
  an environment it builds itself (`PATH`, `HOME`, `TMPDIR`, `LANG`, and
  `MALLOC_ARENA_MAX` on `microvm`), so neither variable reaches code.
- The seccomp table follows `platform.machine()` of the running image
  (`x86_64` or `aarch64`); an image on any other machine has no filter and
  cannot start a `microvm` or `nitro` job. Both tables exist for both
  filters, so the Docker test can run the `microvm` filter on an x86_64
  host; the `microvm` backend itself is ARM_64 only.
- `runner/Dockerfile` uses a plain `FROM` of the digest-pinned multi-arch
  index; the build's `--platform` picks the image. It copies the runner
  modules only.
- `runner/microvm/Dockerfile` installs `python3-3.9.25-1.amzn2023.0.11`,
  the package of the base image's AL2023 release (2023.12.20261102). The
  runner and its tests are Python 3.9 compatible, and the Docker test runs
  them under that package.

## Consequences

The `nitro` and `agentcore` backend owners add `RUNNER_BACKEND` to their
container environment; without it the task or session ends at start.
Moving the `microvm` base image to a new release means checking the
`python3` version of that release and changing the pin in the same commit.

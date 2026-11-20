<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0053: Run the runtime from the construct's repository and never from a code zip

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

AgentCore Runtime takes a container image or a code package. S-9 deployed a
V2 container runtime in the §3.7 network (READY in 201 to 204 s) and found
direct code deployment failed under the S3 endpoint policy and, when it
worked, took about 9 minutes. S-10 found a direct-code runtime runs as
uid 991 and cannot drop code to a second user, while a container starts as
root and the runner drops each job to uid 1001. ADR-0015 already chose the
container. ADR-0024 puts the image in a repository the construct owns, so the
endpoint policy and the roles can name it, and copies it there from a CDK
image asset.

The core creates the repository and, for every container backend, copies the
runner image into it once per architecture and names the tag
(`BackendContext.runnerImageTag`). The runtime is arm64.

## Options considered

### Option 1: Use the core's copy and its tag
Pros: one image copy per architecture whichever backends are on; this backend
holds no second copy function with its own permissions. Cons: the runtime
cannot be used without a core that names the tag.

### Option 2: Copy the image in this backend
Pros: the backend stands alone. Cons: with `nitro` on Graviton two backends
would write the same tag in an immutable repository, and each copy adds a
Lambda with broad ECR rights.

### Option 3: Point the runtime at the CDK asset in the bootstrap repository
Pros: no copy. Cons: the roles and endpoint policies would have to admit the
bootstrap repository, which holds every asset of the account and Region
(ADR-0024, option 2).

## Decision

Option 1. The runtime's artifact is `fromImageUri(<repository>:<tag>)`, a
container configuration only, and the backend refuses to build when the core
names no tag. The core owns the copy, so the runtime (returned by
`drainOrder()`) is ordered after it by the core; this backend has nothing to
depend on.

## Consequences

A synth test asserts the artifact has a container configuration and no code
configuration, that the tag is the core's, and that this backend adds no copy;
the construct test asserts the tag in the runtime equals the tag the core
copied. Not proven before the integration test: the copy of a manifest list
produced by a build with attestations into an arm64 runtime, and a second
deploy of an unchanged asset against an immutable tag. The deploy takes the
runtime's create time (201 to 553 s, spec §5.3).

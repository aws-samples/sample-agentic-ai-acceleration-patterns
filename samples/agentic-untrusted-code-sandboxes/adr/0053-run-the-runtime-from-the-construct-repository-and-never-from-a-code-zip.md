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

The core creates the repository and may know the tag of the image it copied
(`BackendContext.runnerImageTag`). The runtime is arm64.

## Options considered

### Option 1: Use the core's copy when it gives a tag, and copy the image here when it does not
Pros: one image copy per architecture when the core makes it; the backend
works alone. Cons: two paths, one of them unused in a given deployment.

### Option 2: Always copy here
Pros: one path. Cons: with `nitro` on Graviton two backends would write the
same tag in an immutable repository; a rerun of the same tag with
`cdk-ecr-deployment` is untested.

### Option 3: Point the runtime at the CDK asset in the bootstrap repository
Pros: no copy. Cons: the roles and endpoint policies would have to admit the
bootstrap repository, which holds every asset of the account and Region
(ADR-0024, option 2).

## Decision

Option 1. The runtime's artifact is `fromImageUri(<repository>:<tag>)`, a
container configuration only. With no tag from the core, this backend builds a
`DockerImageAsset` of `runnerPath()` for `linux/arm64` and copies it into the
runner repository as `runner-arm64-<asset hash>` with `cdk-ecr-deployment`,
setting `imageArch` to `arm64` because that library copies only `amd64`
unless told otherwise. The runtime depends on the copy. With a tag from the
core, the core owns the copy, and the runtime (returned by `drainOrder()`)
must be ordered after it by the core; this backend has nothing to depend on.

## Consequences

A synth test asserts the artifact has a container configuration and no code
configuration, and the copy and its architecture. Not proven before the
integration test: the copy of a manifest list produced by a build with
attestations, and a second deploy of an unchanged asset against an immutable
tag. The deploy takes the runtime's create time (201 to 553 s, spec §5.3).

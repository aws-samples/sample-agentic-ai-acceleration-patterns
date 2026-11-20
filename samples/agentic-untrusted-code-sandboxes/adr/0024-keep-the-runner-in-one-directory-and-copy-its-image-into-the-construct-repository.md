<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0024: Keep the runner in one directory and copy its image into the construct repository

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §3.5 asks for one Python runner, packaged as a MicroVM image code
artifact (a Dockerfile on the AL2023 base, ARM_64) and as container images
for `nitro` (the architecture of `nitro.instanceTypes`) and `agentcore`
(arm64), both from one `COPY`-only Dockerfile on a digest-pinned Python
base. The task execution role, the AgentCore runtime role and the ECR
endpoint policy name "the runner repository", and §5.3 lists an ECR
repository with `emptyOnDelete`. The spec does not say where the runner
lives, where the Dockerfiles are, or how an image reaches that repository.
A CDK `DockerImageAsset` pushes to the CDK bootstrap repository, which the
construct does not own and cannot scope a policy to.

## Options considered

### Option 1: Image asset, then a copy into the construct repository with `cdk-ecr-deployment`
Pros: the repository is the construct's (policies name it, `emptyOnDelete`
cleans it); the build is the CDK's usual Docker asset build; a `COPY`-only
Dockerfile builds either platform without emulation. Cons: one more
dependency and one more Lambda in the stack.

### Option 2: Point the policies at the bootstrap repository
Pros: nothing extra. Cons: the bootstrap repository holds every asset of
the account and Region, so the endpoint policy and the roles would admit
images the sample does not own; contradicts §5.3.

### Option 3: A CodeBuild project that builds from an S3 source asset into the construct repository
Pros: builds in the cloud. Cons: a project, a role, a wait custom
resource and build-time internet for the base image; slower deploys.

## Decision

Option 1, with this layout:

| Path | Holds | Owner |
|---|---|---|
| `runner/runner.py` | the runner entry, run as PID 1 or the container entrypoint | runner owner |
| `runner/*.py` | runner modules, standard library only | runner owner |
| `runner/Dockerfile` | the container image for `nitro` and `agentcore`; `COPY` only, the base image digest in an `ARG` | runner owner (the `COPY` list) |
| `runner/microvm/Dockerfile` | the MicroVM code artifact's Dockerfile on the AL2023 minimal base | runner owner |
| `runner/PROTOCOL.md`, `runner/protocol/` | the wire protocol and its vectors (ADR-0025) | maintainer decision only |
| `runner/tests/` | Python unit tests (ADR-0026) | runner owner |

- Container images: the core creates the runner repository when `nitro`
  or `agentcore` is enabled (immutable tags, scan on push, `emptyOnDelete`).
  The backend that needs an image builds it with a `DockerImageAsset`
  whose directory is `runnerPath()` and whose `platform` is the backend's
  architecture, and copies it with `cdk-ecr-deployment` to the runner
  repository under the tag `runner-<arch>-<asset hash>`. Policies grant
  pulls on the runner repository only.
- The MicroVM artifact: the `microvm` backend stages a directory at synth
  with `runner/microvm/Dockerfile` at its root and the runner sources under
  `runner/`, and ships it as an S3 asset (`CodeArtifact.Uri`), without
  Docker. The Dockerfile copies from `runner/`.
- A backend never edits a Dockerfile's base image for its own needs; a
  change goes through the runner owner.

## Consequences

The stack holds one copy Lambda while `nitro` or `agentcore` is enabled.
A `cdk destroy` empties the repository. Both container images build from
the same context, so the image the integration test ran is the image a
consumer deploys. The bootstrap repository still holds the asset copy,
which the CDK manages as usual.

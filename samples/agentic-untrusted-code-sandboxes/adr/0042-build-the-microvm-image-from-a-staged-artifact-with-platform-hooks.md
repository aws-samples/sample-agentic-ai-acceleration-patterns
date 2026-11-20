<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0042: Build the MicroVM image from a staged artifact, with the platform hooks enabled

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

`AWS::Lambda::MicrovmImage` and `AWS::Lambda::NetworkConnector` have L1
constructs only. The image needs a code artifact in S3 with a Dockerfile at
its root (ADR-0024), a build role, a base image and version, an egress
connector for the build, a CPU architecture, a memory size and a hook
configuration. The platform calls hooks on fixed paths under
`/aws/lambda-microvms/runtime/v1/` (`ready`, `run`, `resume`, `suspend`,
`terminate`) on the hook port, only for hooks set to `ENABLED`, and
requires the `ready` image hook when any MicroVM hook is used.

## Options considered

### Option 1: Stage `runner/microvm/Dockerfile` and the runner sources as one S3 asset, configure hooks in the image
Pros: no Docker at synth; one asset hash for the whole runner; the same
sources feed the container backends. Cons: the staging step is code.

### Option 2: A prebuilt artifact kept in the repository
Pros: no staging. Cons: a binary that drifts from the runner sources.

## Decision

Option 1.

- The artifact holds `Dockerfile` at its root and the runner sources under
  `runner/`. It leaves out tests, bytecode, the vector generator, the
  container `Dockerfile` and the `microvm/` directory.
- Base image `al2023-1`, version `3`: the input the spike stack deployed,
  which the platform resolved to 3.1 (S-1, S-4). It pins the major version
  and not the minor one; `3.1` as an input is untested, and a change goes
  with a passing integration run. `ARM_64` only. The build uses the
  Lambda-managed `INTERNET_EGRESS` (spec §3.5); runtime egress is the VPC
  connector only (ADR-0041). `AdditionalOsCapabilities` is empty: a MicroVM
  grants no capability the runner needs, and none is added (ADR-0019).
  `MinimumMemoryInMiB` is `microvm.memoryMiB`; the guest has about four
  times that (S-15).
- Hooks on port 9000: `ready` (120 s), `run` (10 s), `resume` (10 s) and
  `suspend` (10 s) enabled, the timeouts the spike stack ran with (S-1 to
  S-4); `terminate` stays disabled, because the runner serves no such hook.
  The platform sends
  `POST /aws/lambda-microvms/runtime/v1/ready`, `.../run`, `.../resume` and
  `.../suspend`, and the runner serves exactly those paths on port 9000. It
  answers `ready` with 200 once it can take a hook (503 while it cannot), the
  first `run` hook with 200 and every later one with 200 and no change (spec
  §3.5).
- The image sets `RUNNER_BACKEND=microvm` in `environmentVariables` as well as
  in the Dockerfile `ENV`, so the runner has its backend name whichever of the
  two the platform passes to PID 1.
- Both roles trust `lambda.amazonaws.com` only for calls from this account
  (`aws:SourceAccount`).
- The build role trusts `lambda.amazonaws.com`; it reads the one artifact
  object and writes `/aws/lambda-microvms/<imageName>`, which is also the
  image's build log group. The connector operator role trusts the same
  principal and creates network interfaces in the sandbox subnets with the
  connector's security group, and tags only interfaces the connector
  service manages (`ec2:ManagedResourceOperator`), the two statements the
  spike's operator role ran with (S-1).

## Consequences

The runner owner serves the `ready` hook and the platform hook paths in
addition to the `/run`, `/suspend` and `/resume` names that
`runner/PROTOCOL.md` lists; until it does, an image build fails at the
`ready` hook. An empty capability list and the
build role's exact permissions are unverified until the first deploy. The
operator role does not restrict the tag keys or the create action of the
interfaces it tags; add those conditions (the AWS managed operator policy has
them) if a deploy shows the service accepts them. An image
update takes about 150 s (S-19). The artifact is staged in a temporary
directory, so asset staging cannot be disabled (`--no-staging`); synth refuses.

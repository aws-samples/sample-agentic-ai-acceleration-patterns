<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0002: Model each boundary as a pluggable sandbox backend

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The sample exists to compare three boundaries: Lambda MicroVMs, Nitro
Sandboxes and a second AgentCore Runtime. A vendor picks one by its own
constraints (cluster or not, idle cost, state, attestation). The comparison
only holds if the same tool, the same runner and the same test drive all
three.

## Options considered

### Option 1: One construct, a `backends` prop, one `SandboxBackend` interface
Pros: one contract (P-5); the test runs the same steps on each; a vendor
enables one or several. Cons: the interface must fit three lifecycles
(explicit start, task start, implicit session).

### Option 2: Three samples, one per boundary
Pros: each is smaller. Cons: three tools, three tests, and the comparison
lives only in prose.

### Option 3: One boundary only (MicroVM)
Pros: smallest and fastest to deploy. Cons: does not answer the decision
the sample is for.

## Decision

Option 1, with `start`, `ready`, `run` and `stop` per backend and reuse
decided by the tool from the registry (spec §3.4). `agentcore` implements
`start` as a no-op because a session starts on first invoke.

## Consequences

The runner is packaged twice (MicroVM code artifact, arm64 container image).
Deploying all three costs the most and deploys the slowest; `backends`
defaults to `['microvm']` and the integration test enables all three. A
fourth backend (EKS pods, Fargate) is one more implementation of the same
interface.

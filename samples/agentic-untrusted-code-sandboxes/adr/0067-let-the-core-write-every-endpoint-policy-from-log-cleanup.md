<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0067: Let the core write every endpoint policy from its own resources and `logCleanup()`

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0051
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0051 has the `agentcore` backend return its statements for each sandbox
endpoint's policy from `endpointStatements()`, for the core to merge, and the
`nitro` backend has the same method. The core never calls it.
`SandboxEndpoints` (`src/core/endpoints.ts`) writes each endpoint's policy
itself: the ECR layer bucket and, with `sessionFiles`, the sessions prefix of
the input bucket on the S3 endpoint; the runner repository on the ECR
endpoints; and on the Logs endpoint the log groups and prefixes every backend
names in `logCleanup()`. So the two methods and their unit tests described a
copy that never deploys, and two threat-model rows (T-14, T-28) cited those
tests as evidence.

## Options considered

### Option 1: Delete `endpointStatements()` and test the policies the core deploys
Pros: one place builds each policy, and the tests read the synthesised
endpoint resources. A backend already names its log groups in `logCleanup()`,
which the cleanup resource also uses, so the Logs policy and the cleanup can
never drift apart. Cons: a future backend that needs another resource in an
endpoint policy adds it to the core.

### Option 2: Make the core call `endpointStatements()` and drop its own copy
Pros: each backend owns its endpoint needs. Cons: two lists of a backend's log
groups (`logCleanup()` and the Logs statements) that must agree, and a
statement from a backend that names a wider resource reaches a shared endpoint
with no check in the core.

## Decision

Option 1. `BackendConstruct` has no `endpointStatements()`. A backend states
which endpoints it needs in `endpoints()` and which log groups it writes in
`logCleanup()`; `SandboxEndpoints` writes every endpoint policy from those and
from the core's own repository and bucket. The tests that synthesise the real
endpoints (`test/core-infra.cdk.test.ts`, `test/agentcore.construct.test.ts`,
`test/nitro.core.test.ts`) are the evidence for the endpoint policies.

## Consequences

The endpoint policies have one source. A backend that needs a resource other
than its log groups in an endpoint policy needs a change in
`src/core/endpoints.ts` and a new record. Revisit if a fourth backend needs
endpoint access the core cannot derive.

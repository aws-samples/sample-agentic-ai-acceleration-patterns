<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0008: Drive the integration test with the CDK CLI

- Status: Proposed
- Date: 2026-11-18
- Amended by: ADR-0015, ADR-0058
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The test may need to deploy an `agentic-runtime-isolation` ingress through
its own deploy path, then this sample's stack, run a long step table
against three backends, and destroy only what it deployed, also when a step
fails (standard §5.2).

## Options considered

### Option 1: `@aws-cdk/integ-runner`
Pros: the repository default. Cons: deploys and destroys one stack at a
time; assertions as `awsApiCall`s do not fit scripts run inside sandboxes
and multi-call race steps.

### Option 2: The CDK CLI in `scripts/integ.sh`
Pros: deploys the producer and this stack with `cdk deploy`, runs the step
table as a TypeScript driver, and destroys from an exit trap. Cons: the
script owns its cleanup logic.

## Decision

Option 2, the shape agentic-runtime-isolation ADR-0044 and tenant-identity
ADR-0023 already use. The driver reuses the producer and the shared
identity pool when their parameters exist and never destroys the pool.

## Consequences

`integration-test.md` documents the script, its knobs and its leftovers
check. The `teardown` step is `cdk destroy` itself, so C-6 is tested on
the consumer's path, not by a test-only stop.

Note 2026-11-18: amended by ADR-0015. The driver always deploys its own ingress with a test-only token mint, because no consumer can sign tokens for an ingress it does not own; it reuses only the shared identity pool.

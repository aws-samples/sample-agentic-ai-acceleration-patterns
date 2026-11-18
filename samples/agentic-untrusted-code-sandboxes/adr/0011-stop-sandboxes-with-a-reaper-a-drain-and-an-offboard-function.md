<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0011: Stop sandboxes with a reaper, a drain and an offboard function

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Sandboxes are started at run time, outside CloudFormation. ECS tasks have
no idle stop and block the cluster's delete while they run. MicroVMs and
AgentCore sessions end on their own idle and life settings, but not on
`cdk destroy`. A crashed start can leave a sandbox with no row. A tenant
that leaves must not keep a running sandbox.

## Options considered

### Option 1: A scheduled reaper, a delete-time drain, and an offboard function
Pros: idle `nitro` tasks stop; orphans are found by tag or image; `cdk
destroy` stops everything before the resources it depends on go (C-6); the
control plane's tenant delete script has one call to make. Cons: three
small functions and a role that can see every row.

### Option 2: A task per call with no reuse on `nitro`
Pros: nothing to reap. Cons: rejected in ADR-0005.

### Option 3: Leave stopping to the test
Pros: no code. Cons: a consumer's `cdk destroy` fails or leaks.

## Decision

Option 1 (spec §4.1, §5.2, §5.3). The reaper and the drain use a role that
reads and updates every registry row and can stop the sample's sandboxes,
and that cannot read the input bucket. The drain waits up to 10 minutes and
fails the delete loudly if anything is left.

## Consequences

The reaper runs every 5 minutes, so a `nitro` task lives up to
`sandboxIdle` + 5 minutes after its last call. Each stop writes the
`sandboxSeconds` line used for cost (ADR-0013). Offboarding does not delete
tenant objects (spec §1.2).

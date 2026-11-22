<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0070: Scale in `nitro` instances two minutes after the last task

- Status: Proposed
- Date: 2026-11-22
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The `nitro` backend runs each tenant's task on Amazon ECS Managed Instances
(ADR-0004). The capacity provider has no minimum-instances setting; its
`ScaleInAfter` setting decides how long an instance with no task stays up.
An idle instance is a fixed cost no tenant is billed for (spec §3.8), and a
capacity provider cannot be deleted while an instance remains, so a long
`ScaleInAfter` also holds up a stack delete when the drain has not run
(spec §5.3). A short one means a tenant's first call after a quiet spell
starts from zero instances. The spikes measured: scale-in 131 s after the
last task with `ScaleInAfter` 120 (S-7); a capacity provider delete that
failed with `ScaleInAfter` 900 (S-14); a first task from zero instances in
31 to 34 s (S-7). Integration run 14 measured a start from zero in 37 s
against the 300 s start cap.

## Options considered

### Option 1: 120 s
Pros: an idle instance costs about two minutes after the last task; the
capacity provider delete waits about 162 s without the drain. Cons: a tenant
whose first call comes after a quiet spell waits for an instance (about 35
s), so the first call returns `sandbox_starting` and the caller retries.

### Option 2: The service default or a longer value (for example 900 s)
Pros: bursts of first calls a few minutes apart find a warm instance. Cons:
up to 15 minutes of instance cost after every last task, borne by no
tenant, and a capacity provider delete that fails when the drain did not
end the instances (S-14).

### Option 3: Keep a warm instance with a placeholder task
Pros: no cold start from zero. Cons: a standing cost on every deployment,
and a task that is no tenant's on the instances tenants share.

## Decision

Option 1. The sample keeps no warm instance and sets `ScaleInAfter` to
120 s in `src/backends/nitro.cdk.ts` (`SCALE_IN_AFTER_SECONDS`). The cold
start is bounded by the start cap and already handled by the
`sandbox_starting` retry, while idle instance time is cost no tenant pays.

## Consequences

The integration step `cold-from-zero` waits for scale-in before it runs,
and a vendor whose tenants call in bursts after quiet spells sees one
`sandbox_starting` per burst. A vendor who wants warm capacity changes the
constant, and accepts the idle cost and a slower delete. Revisit when the
capacity provider offers a minimum instance count.

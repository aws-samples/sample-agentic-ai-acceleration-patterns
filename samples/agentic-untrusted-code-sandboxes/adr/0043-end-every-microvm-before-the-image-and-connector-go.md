<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0043: End every MicroVM before the image and the connector go

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

A MicroVM image cannot be deleted while a MicroVM of it is live; the delete
fails at once and CloudFormation does not retry it (S-1). The connector
delete succeeds under running MicroVMs, but the platform documents that a
connector in use should not be deleted. The image build writes to a log
group the service creates, outside the stack.

## Options considered

### Option 1: The drain waits for every MicroVM of the image to be `TERMINATED`, and the stack orders it before the image and the connector
Pros: the delete succeeds first time (92 s in S-14). Cons: the drain needs
the image's MicroVMs listed.

### Option 2: Rely on `maximumDurationInSeconds` to end them
Pros: no code. Cons: up to 8 hours.

## Decision

Option 1.

- `drainOrder()` returns the image and the connector. The core makes the
  drain depend on both, so CloudFormation deletes the drain (which runs on
  delete) first.
- `MicrovmBackend.list()` reports every MicroVM of the image with `live`
  true for any state except `TERMINATED`. `TERMINATING` counts as live,
  because the image delete is not safe until the platform reports
  `TERMINATED`. The reaper and the drain stop what is live and listed;
  `stop` accepts a conflict on a MicroVM that is already ending.
- `logCleanup()` names `/aws/lambda-microvms/<imageName>`. The core's log
  cleanup resource is deleted after the image and removes the group.
- The reaper and the drain hold `lambda:ListMicrovms` on `*` (the action
  takes no resource, and the backend lists by image),
  `lambda:GetMicrovm` and `lambda:TerminateMicrovm` on the image. The
  drain holds nothing more on `microvm`.

## Consequences

`cdk destroy` leaves no MicroVM and no build log group (C-6). A MicroVM
that stays `TERMINATING` beyond the drain's 10-minute bound fails the
stack delete, which is the signal that the platform did not end it.

<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0014: Name the Memory per stack instance

- Status: Accepted
- Date: 2026-11-11
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

AgentCore Memory names are unique in the account and Region. AgentCore
deletes a Memory asynchronously, and a Memory being deleted keeps its name:
on 2026-11-10 one stayed `DELETING` for more than fifteen hours. The
construct derived the name from its construct path alone, so the next deploy
of the same stack failed with `Memory with name ... already exists` until the
old deletion finished (integration run 6).

## Options considered

### Option 1: Keep the path-derived name and wait

Pros: stable names. Cons: a slow deletion blocks every redeploy for hours.

### Option 2: A name prop the deployer sets

Pros: the deployer controls it. Cons: every deployer must choose a fresh name
after a slow deletion, which is the failure this decision removes.

### Option 3: Append the stack instance to the name

The first segment of the stack's id (`AWS::StackId`), a fresh value for each
stack creation, follows the path-derived part: `<path, 39 chars>_<8 hex>`,
within the 48-character name pattern. Pros: no collision with an old Memory;
no new prop. Cons: the name changes when the stack is recreated, which the
construct never relies on: consumers use the published Memory id and ARN.

## Decision

Option 3.

## Consequences

A redeploy proceeds while an earlier Memory of the same stack is still being
deleted. Nothing reads the Memory by name; the fence, the role, the target,
and the published parameter use its id and ARN.

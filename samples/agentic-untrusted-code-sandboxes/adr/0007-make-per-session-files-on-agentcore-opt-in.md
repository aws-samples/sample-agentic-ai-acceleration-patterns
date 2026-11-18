<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0007: Make per-session files on AgentCore opt-in

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

On platform version V2, credentials a session receives carry
`aws:AgentCoreRuntimeSourceSid`. One runtime role policy can then give each
session its own S3 prefix, `sessions/${aws:AgentCoreRuntimeSourceSid}/*`,
with no role per session. That is a useful pattern to show, but it puts
credentials in the sandbox, against ADR-0003. The key shows which session
the credentials were issued to, not that a call came from inside it.

## Options considered

### Option 1: Off by default, a `sessionFiles` prop turns it on
Pros: the default keeps C-2; the pattern is still shown and tested.
Cons: one more option combination to test.

### Option 2: Always on
Pros: files survive a session stop. Cons: code holds credentials that
reach its prefix, and with any egress could copy them out.

### Option 3: Leave it out
Pros: simplest. Cons: drops the one feature only V2 offers here.

## Decision

Option 1. With `sessionFiles`, the runtime role gets `s3:GetObject` and
`s3:PutObject` on `sessions/${aws:AgentCoreRuntimeSourceSid}/*` and a
matching `s3:ListBucket` with an `s3:prefix` condition. SDK clients are
built inside the handler, after the V2 snapshot (spike S-10).

## Consequences

The integration test runs the `agentcore` steps twice, once per setting,
and checks that a session cannot read another session's prefix. The README
says what the key proves and what it does not.

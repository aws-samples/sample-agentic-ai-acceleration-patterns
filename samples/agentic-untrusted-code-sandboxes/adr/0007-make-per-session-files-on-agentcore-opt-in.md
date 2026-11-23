<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0007: Make per-session files on AgentCore opt-in

- Status: Accepted
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

On platform version V2, credentials a session receives carry
`aws:AgentCoreRuntimeSourceSid`. One runtime role policy can then give each
session its own S3 prefix, `sessions/${aws:AgentCoreRuntimeSourceSid}/*`,
with no role per session. That is a useful pattern to show. Code in an
AgentCore session already holds the runtime role (ADR-0003); this grant
widens that role from infrastructure (ECR pull, own logs) to tenant data.
The key shows which session the credentials were issued to, not that a
call came from inside it. Because the session id is derived from the
tenant (ADR-0009), the prefix is in effect one per tenant and outlives a
session restart.

## Options considered

### Option 1: Off by default, a `sessionFiles` prop turns it on
Pros: the default keeps the runtime role free of tenant data; the pattern
is still shown and tested. Cons: one more option combination to test.

### Option 2: Always on
Pros: files survive a session stop. Cons: every session's code holds
credentials to tenant data, which a script could misuse within the
endpoint policy.

### Option 3: Leave it out
Pros: simplest. Cons: drops the one feature only V2 offers here.

## Decision

Option 1. With `sessionFiles`, the runtime role gets `s3:GetObject` and
`s3:PutObject` on `sessions/${aws:AgentCoreRuntimeSourceSid}/*` and a
matching `s3:ListBucket` with an `s3:prefix` condition, and the sandbox
subnets' S3 gateway endpoint policy also admits the input bucket's
`sessions/` prefix (ADR-0012). SDK clients are built inside the handler,
after the V2 snapshot (spike S-10).

## Consequences

The integration test deploys a second construct instance with
`agentcore` only and `sessionFiles` on, and its `session-files` step checks
that a session reads and writes its own prefix and is denied another's.
The prefix persists across restarts and offboarding; deleting it is the
vendor's (spec §1.2). The README says what the key proves and what it does
not.

<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0007: Derive the fenced operations from the service model

- Status: Accepted
- Date: 2026-11-10
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

The Memory resource policy denies data-plane access to every principal
except the Gateway execution role (ADR-0004). A Deny only covers the
actions it names. The first fence named 15 operations by hand. The Memory
service model in the pinned SDK has a 16th, `IngestData`
(`POST /memories/{memoryId}/ingest`), which writes content straight into
long-term extraction. Any principal in the vendor's account with an identity
Allow could use it to place facts in any tenant's namespace without passing
Gateway or Cedar.

A wildcard Deny (`bedrock-agentcore:*` on the Memory ARN) would also block
the control-plane calls the vendor needs on the same resource, such as
`GetMemory`, `DeleteMemory`, and `PutResourcePolicy`.

## Options considered

### Option 1: Keep a hand-written list and add `IngestData`

Closes the gap today. The next new operation reopens it, silently, because
nothing compares the list with the service.

### Option 2: Deny `bedrock-agentcore:*` on the Memory ARN

Covers future operations, but locks the vendor out of control-plane
management of the Memory resource unless it adds exceptions, and those
exceptions are a hand-written list again.

### Option 3: Derive the list from the service model and pin the review

Every `bedrock-agentcore` operation whose request URI starts with
`/memories/{memoryId}/` is a data-plane operation on one Memory resource. The
fence denies all of them. A unit test compares the derived set with the set
that has been reviewed against the Cedar policies, so an SDK upgrade that
adds an operation fails the build until someone decides whether agents need
it.

## Decision

Option 3. `MEMORY_DATA_ACTIONS` in `src/fence.ts` is the reviewed set;
`test/fence.test.ts` derives the Memory data operations from the HTTP traits
of the pinned `@aws-sdk/client-bedrock-agentcore` and fails on any
difference. `IngestData` is fenced and has no Cedar permit and no role
grant. The SDK is pinned exactly so the derived set changes only when the
pin does. (The first version of this check read the botocore model in the
Python kit that ADR-0013 replaced.)

## Consequences

The connector exposes 12 of these operations as Cedar actions; the batch
record operations and `IngestData` are not connector operations
([connector guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-connector.html#memory-gateway-connector-what),
[IngestData](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_IngestData.html)),
so for them the fence is the only control.

A new Memory data operation is denied outside Gateway as soon as the SDK pin
includes it, and the review is forced rather than remembered. A new
operation that the service ships before the SDK models it is not covered;
the threat model names this (T-4). The integration test reads the deployed
policy back and checks it names the same set.

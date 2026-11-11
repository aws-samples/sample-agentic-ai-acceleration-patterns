<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0005: Keep stored event reads and deletion out of the agent API

- Status: Accepted
- Date: 2026-10-26
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

A Cedar permit for `ListEvents`, `GetEvent`, or `DeleteEvent` is safe only if
it can compare the request's `actorId` and `sessionId` with the token's
claims. Those values are path parameters. In the live run on 2026-10-26 the
native connector passed `context.input` for `ListEvents` to Policy without
them, although the Memory FGAC reference lists path parameters as request
context.

## Options considered

### Option 1: Permit event reads on the operation alone

Lets agents reread history, but any caller could read any tenant's
sessions.

### Option 2: Leave event reads and deletion without a permit

Agents write events and recall extracted facts; the application keeps the
context an active conversation needs in its own session layer.

## Decision

Option 2. No policy permits `ListEvents`, `GetEvent`, or `DeleteEvent`, so
default deny applies to every caller. A deployment that needs stored event
reads adds a trusted service that checks the caller's tenant and session
before it reads.

## Consequences

The live probe for event reads shows they are off for everyone; it is not
evidence of per-tenant read scoping. Revisit when Policy receives path
parameters for these operations, verified live, and add per-session read
permits with their own allow and deny tests.

The current FGAC reference
lists `actorId` and `sessionId` as path parameters in `context.input` and
shows a `ListEvents` permit on `context.input.actorId`
([FGAC reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-fgac.html#memory-gateway-fgac-context-fields),
[policy examples](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-fgac-policy-examples.html)).
The same reference warns that a permit reading a field the request lacks
denies with 403 and no creation-time finding, which matches what the
2026-10-26 run saw. The integration test re-tests it (step 10): it grants the
Gateway role `ListEvents` and adds a per-session `ListEvents` permit guarded
with `has` on `actorId` and `sessionId`. On 2026-11-10 in `us-east-1` the
caller's own session was still denied (403), so Policy received neither
field, and the decision stands. If a later run sees the fields arrive, this
record is superseded by one that adds per-session event reads.

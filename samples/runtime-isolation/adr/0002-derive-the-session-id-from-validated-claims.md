<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0002: Derive the session id from validated tenant and user claims

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
The session id must be stable for a conversation, unique per caller, at least 33 characters, and impossible to aim at someone else's microVM.

## Options considered
### Option 1: Server-generated opaque id stored in a table
Pros: unguessable. Cons: a store to run, list, expire, and protect; the table becomes the mapping and the boundary.
### Option 2: Hash prefix of `tenant_id|sub` plus a client `conversationId`
Pros: no store; recomputable at ingress from the token alone; tenant-qualified; a prefix is not a secret because the token, not the id, is the credential. Cons: listing a user's sessions needs another source.
### Option 3: Raw `tenant_id` and `sub` in the id
Cons: leaks identifiers into logs and metrics that carry the session id.

## Decision
Option 2: `s-<base32(sha256(tenant_id|sub))[0:26]>-<conversationId>`, with `sessionScope: 'tenant'` hashing `tenant_id` only. Both ingresses build the id themselves from the validated token and the body's `conversationId`; the client never sends a session id. The API Gateway integration Lambda passes it to `InvokeAgentRuntime`. The AgentCore Gateway REQUEST interceptor writes it to `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` in `transformedGatewayRequest.headers`, overwriting any value the client sent (spike V-3 showed the Runtime receives the interceptor's value). A check-and-reject of a client-built id was the alternative; it was dropped so both ingresses share one contract and one session module, and so the session-id format is not a client contract.

## Consequences
Easier: no state; one request contract (`{conversationId, prompt}`) on both ingresses; the session-id format can change without breaking clients. Harder: the hash and the base32 alphabet are a contract between ingress and tests, so they live in one shared module. Per-tenant scope trades user separation inside a tenant for fewer cold starts; the README says so.

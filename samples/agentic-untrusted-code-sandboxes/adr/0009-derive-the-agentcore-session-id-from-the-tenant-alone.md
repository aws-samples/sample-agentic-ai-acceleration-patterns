<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0009: Derive the AgentCore session id from the tenant alone

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

AgentCore does not check who owns a session id; the caller keeps that
mapping. `InvokeAgentRuntime` requires a `runtimeSessionId` of at least 33
characters. The sample keeps one sandbox per tenant (R-4), and tenant ids
may be short (`A`) or use characters a session id should not carry.

## Options considered

### Option 1: `rc-` + hex SHA-256 of the tenant id
Pros: always 67 characters; no tenant characters in the id; the same
tenant always maps to the same session, so the registry row is a cache, not
the source of truth. Cons: anyone who knows a tenant id and holds the tool
role can compute its session id (filtered, P-6).

### Option 2: A random id stored in the registry
Pros: not guessable. Cons: the tool role can still call any session it
learns; a lost row loses the session and its files.

### Option 3: Tenant plus user
Pros: per-user sandboxes. Cons: not what R-4 asks; a different sample
option.

## Decision

Option 1. The guessable id adds no reach: only the tool role may invoke the
runtime, and the tool chooses the tenant from the signed context. The
runner's nonce and boot id detect a session that restarted under the same
id (ADR-0010).

## Consequences

A unit test asserts the length and format. If S-8 finds a session-id
condition key, the tool's invoke moves to the tool tenant role with that
condition and this becomes enforced.

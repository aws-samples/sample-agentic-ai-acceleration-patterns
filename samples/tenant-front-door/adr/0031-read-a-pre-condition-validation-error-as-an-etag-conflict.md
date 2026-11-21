<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0031: Read a pre-condition validation error as an ETag conflict

- Status: Accepted
- Date: 2026-11-21
- Deciders: Dave Roberts (PSA)

## Context
Every write to the route table is one `UpdateKeys` call with the store's
ETag as `IfMatch` (ADR-0003). The registrar and the route table's custom
resource retry such a write when the ETag is stale: they read the store
again and plan the write again (spec §3.4 step 5, M-15). The API documents
a `ConflictException` for a stale ETag. A real KeyValueStore answers a stale
`IfMatch` with a `ValidationException` (HTTP 400) whose message says the
pre-condition failed. With only the documented exception read as a
conflict, a write that lost the race failed with a 400 instead of
retrying.

## Options considered
### Option 1: Only `ConflictException`
Pros: the documented behaviour, no string match. Cons: does not match what
the store answers, so every lost race fails the write.
### Option 2: `ConflictException`, HTTP 409 and 412, and a `ValidationException` whose message says the pre-condition failed
Pros: retries the stale ETag the store reports. One function,
`src/shared/etag-conflict.ts`, serves both writers. Cons: matches on message
text, so a change to the store's wording stops the match; the writes then
fail loudly instead of retrying.
### Option 3: Read the ETag again after any failure and compare
Pros: no message match. Cons: one more read per failure, and an unrelated
`ValidationException` (a key that is too long, say) would retry five times
before it reaches the caller.

## Decision
Option 2. Any other `ValidationException` is not a conflict and reaches the
caller unchanged, and a write that loses five attempts answers 503, as
before.

## Consequences
- Both KeyValueStore writers share one test, so they cannot disagree about
  what a conflict is.
- A change of the store's message wording fails writes loudly. The tests pin
  the message the store gives today.
- Revisit if the store changes the wording of that message, or the SDK
  gains a typed error for a stale `IfMatch`.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0022: Bound the TVM credential cache and share one STS call per tag set

- Status: Accepted
- Date: 2026-10-27
- Deciders: Dave Roberts (PSA)

## Context
The TVM caches vended credentials per Lambda execution environment (`src/shared/tvm.ts`, ADR-0012). The cache was an unbounded `Map`. Expired entries were never evicted, so memory grew with every tag set the instance had ever seen. Concurrent cache misses for the same tag set each called STS.

STS `AssumeRole` allows 600 requests per second per account per Region, shared with every other STS call in the account, and is raised only through a Support case. The fleet's STS rate is about instances × tag sets ÷ credential lifetime. With `tvm.includeUserIdTag` the key space is the number of users, not tenants.

## Options considered
### Option 1: Keep the unbounded cache
Pros: no change. Cons: memory grows without bound; a cold-start burst sends one STS call per concurrent request.
### Option 2: A shared cross-instance credential cache (DynamoDB or ElastiCache)
Pros: about one STS call per tag set per lifetime for the whole fleet. Cons: it becomes a store of live tenant credentials, a new authorisation boundary with a wide blast radius; it saves only about one call per instance per tenant per lifetime.
### Option 3: A bounded LRU per instance with single flight
Pros: memory bounded; concurrent misses share one STS call; no new store of credentials. Cons: an instance serving more active tag sets than the bound calls STS more often.

## Decision
Option 3.

- New prop `tvm.cacheMaxEntries`, default 1000.
- LRU on `Map` insertion order: a hit is deleted and re-inserted, so the oldest entry is first.
- When the cache is over the bound, expired entries are dropped first, then the least recently used.
- Single flight: an in-flight promise map, keyed like the cache, so concurrent misses for one tag set make one STS call.

The tenant limits (ADR-0020) also run before the TVM, so a limited request never reaches STS.

## Consequences
Easier: memory per instance is bounded (about 1.5 KB per entry, so 1000 entries is about 1.5 MB); a cold-start herd for one tenant makes one STS call per instance.

Harder: an instance with more active tag sets than the bound evicts entries that are still valid and calls STS again. Size the bound to the active tenants (or users, with `includeUserIdTag`) per instance.

Revisit if STS throttling shows up in CloudTrail or metrics at the expected fleet size.

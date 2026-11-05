<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0036: Bound change lag by a version in the token cache key and a 5-minute token life

- Status: Accepted
- Date: 2026-11-02
- Amended by: ADR-0043; the 2026-11-04 review (cache key)
- Deciders: Dave Roberts (PSA)

## Context
A tenant admin's cut and a vendor's subscription drop must take effect fast. Minting a transaction token (ADR-0031) costs a KMS `Sign` and two `GetItem` calls (ADR-0030), which should not be paid on every request: KMS `Sign` has a shared per-Region quota and adds 10 to 20 ms. A token already handed out stays valid until `exp`, whatever the store says.

## Options considered
### Option 1: No cache, mint per request
Pros: every request sees the store as it is now. Cons: KMS `Sign` and two reads on every request; the KMS quota becomes the ingress's ceiling.

### Option 2: Cache per (tenant, `sub`, agent) for the token's life
Pros: one mint per user and agent per token life. Cons: a cut waits for the cached token to expire before new requests see it.

### Option 3: Cache keyed also on `tenant.version`, bumped by every tenant or cut write
The mint path reads the tenant row (one `GetItem`, cheap) to get `version`, and reuses a cached token only when the version matches. DynamoDB Streams could later push invalidations to warm instances. Pros: a change lands at once for new mints; the expensive `Sign` is still cached. Cons: the tenant read happens on every request; a version bump invalidates every cached token of the tenant, not only the cut user's.

## Decision
Option 3. Tokens live 300 s by default, set by `transactionToken.ttl` from 60 s to 900 s.

## Consequences
Easier: a cut or a drop is seen by the next mint; the store stays the single source of truth with no push channel. Harder: a token in flight keeps its grant until `exp`, at most `ttl`; the README states that bound. A busy tenant's cut forces a burst of re-mints across all its users. Left out: revoking tokens in flight. The named way is a `jti` denylist checked by the tools gateway interceptor; it is not built. Follow-up: a test that a cut changes the next mint; a metric for mint rate per tenant. Revisit if a consumer needs revocation faster than `ttl`, or if the per-request tenant read shows up in latency (then Streams).

**Amended 2026-11-04.** `transactionToken.ttl` is validated at 120 s to 900 s (ADR-0043: a tools gateway refuses a token with 60 s or less left), not 60 s to 900 s. From the review of the implemented sample: the mint cache key also includes the granted `scope` and the sorted list of tools gateways in `aud`, so a catalogue change that adds a tool to a granted target or moves a target to another gateway re-mints on the next request (`mintCacheKey` in `src/shared/mint.ts`).

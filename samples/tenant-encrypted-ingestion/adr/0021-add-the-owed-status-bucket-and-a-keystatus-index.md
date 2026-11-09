<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0021: Add the OWED status bucket and a keyStatus index

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR-0010
- Deciders: Dave Roberts (PSA)

## Context
ADR-0010 gives the registry one sparse GSI, `statusBucket-urlExpiresAt`,
whose partition key `statusBucket = OPEN` exists only on open delivery
rows, so the hourly sweep finds open work without a scan. Two sweep jobs
need rows that index does not hold. First, consumers are promised every
terminal event at least once (spec §6.2): the processor and the sweep write
the terminal status, then `PutEvents`, then `eventPublishedAt`, and a crash
or a failed publish between the write and the publish leaves a terminal row
whose event nobody has sent. Second, the sweep re-probes `REVOKED` keys
(ADR-0004) and reconciles each tenant's `inFlight` counter (ADR-0011), so it
must list key rows; `sweepRole` holds no `Scan` (M-14), and a scan of a
table holding every delivery row would grow with deliveries, not tenants.

## Options considered
### Option 1: Scan for terminal rows without `eventPublishedAt` and for key rows
Pros: no index; no new attribute. Cons: cost and duration grow with every
delivery row ever kept; `sweepRole` gains `Scan`, a read of every tenant's
partition in one call.
### Option 2: Publish first, then write the terminal status
Pros: no owed state; nothing to find. Cons: an event for a status the
registry does not yet hold; a crash after the publish republishes on the
next receive anyway, and a lost lease publishes a status the row never
reaches.
### Option 3: Write first with `statusBucket = OWED`, publish, clear it
Pros: the terminal write and the owed marker are one write; the event is
published only for a status that is stored; the sweep finds owed events
with one query on the existing index. Cons: a second constant partition on
the GSI; the sweep must not race a processor still finishing.
### Option 4: A second sparse GSI on `keyStatus` for key rows
Pros: key rows only (no delivery row carries `keyStatus`, ADR-0003), so a
query per status lists exactly the tenants; no `Scan`. Cons: one more index
to pay for and to keep in the tenant roles' denied names.

## Decision
Options 3 and 4. `statusBucket` takes a third state: `OPEN` while
`AWAITING_UPLOAD` or `PROCESSING`, `OWED` on a terminal row whose event is
not yet published, and absent otherwise. The processor and the sweep set
`OWED` in the same write as the terminal status
(`src/processor/handler.ts`, `src/sweep/handler.ts`) and remove it in the
write that sets `eventPublishedAt`; `EXPIRED` publishes no event and drops
the attribute at once (`src/shared/registry.ts`). The sweep queries
`statusBucket = OWED`, skips a row touched within `OWED_GRACE_MS` (five
minutes) so a processor still finishing is not raced, publishes and clears
it. A second sparse GSI, `keyStatus` (partition key `keyStatus`, all
attributes projected, `src/construct/registry.ts`), holds key rows only;
the sweep queries it for `REVOKED` rows to probe and `ACTIVE` rows to
reconcile `inFlight`.

## Consequences
Easier: at-least-once delivery of terminal events survives a crash or a
failed publish without an operator; the sweep's work grows with tenants and
open or owed rows, never with history; `sweepRole` keeps no `Scan`. Harder:
the `statusBucket` GSI has two constant partitions, still well within
limits at N-2 rates; a second GSI adds write cost on every key-row change;
an owed event is late by up to one sweep interval plus the grace. Revisit
if sweep volume outgrows one GSI partition (shard `statusBucket`), or if
EventBridge gains a transactional write with DynamoDB.

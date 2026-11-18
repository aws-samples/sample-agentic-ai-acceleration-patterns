<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0006: Publish a subscriber construct that always has a dead-letter queue

- Status: Accepted
- Date: 2026-11-18
- Deciders: Dave Roberts (SA)

## Context
The sample has two EventBridge Custom Event Buses: the ingest bus, with
every checked usage event (ADR-0002), and the usage bus, with one
`UsageRecorded` event per counted record. Other systems join here: a live
limiter, a dashboard, a billing adapter, another team's account through
AWS RAM. Each of them creates its own subscriber.

A subscriber retries five times or for 300 seconds by default, then drops
the event unless it has a dead-letter queue. For usage that is a lost
billable event, and no one sees it. The sample's own Firehose subscriber
has a queue, a retry policy and alarms (ADR-0002), but a reader written
by someone else starts from the default.

Both buses hold every tenant's usage: the ingest bus its raw events, the
usage bus its counted records. An account a bus is shared with can create
any subscriber on it, filtered or not, so the share itself is the
boundary.

## Options considered
### Option 1: Document the rule
The README says every subscriber needs a queue, a retry policy and
alarms. Pros: nothing to maintain. Cons: the default still drops events,
and a reader that misses the note fails silently.

### Option 2: A `UsageSubscriber` construct for both buses
A published construct takes the bus, a stream (`raw` or `usage`), a
target and optional filters, and always creates the queue, the retry
policy of 24 hours maximum event age, and alarms. Pros: the safe
setup is the only one the construct can build; one place to change it;
consumers stay producer-agnostic (standard §1.1). Cons: one more
published interface to keep stable; readers that need options the
construct does not expose fall back to the L1 resource.

### Option 3: Only the sample subscribes; others read S3 or the API
Pros: no shared bus to govern. Cons: readers poll; the bus's retention
and RAM sharing, the reasons for ADR-0002, go unused.

## Decision
Option 2, for both streams. `usage` is the default stream, because most
readers want counted, deduplicated records. `raw` is offered for readers
that must act inside the hour. Each bus is shared only with the vendor
accounts on its list, `rawSubscriberAccountIds` or
`usageSubscriberAccountIds`. Cells are registered at run time, so the
check sits in the registry: `PutCellEmitter`, which runs in the
`CELL_CREATE` `PRE` hook, refuses a cell whose account is on either list
or is the metering account, which owns both buses, so the cell create
fails before its script runs; and a deploy that adds
an account already holding a registered cell fails. The check refuses
vendor-owned cell accounts too, on purpose: an account that holds cells
runs application code, and that code must not see other cells' tenants.
It is not to be relaxed to tenant-owned accounts only.

## Consequences
- `UsageSubscriber` props and outputs are a published interface; a change
  is a breaking change with its own ADR (standard §1.1).
- The `EVENT_BUS` sink type is gone; the usage bus is always on, and the
  sink types are `HTTP` and `S3_EXPORT`.
- The integration test attaches one `UsageSubscriber` per stream to an
  SQS queue and checks that the events arrive and the dead-letter queue
  stays empty.
- The deploy-time check needs a custom resource that reads the registry
  before the RAM share changes; it fails the deploy rather than shrinking
  the share silently.

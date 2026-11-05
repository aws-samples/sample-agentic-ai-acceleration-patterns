<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0010: Keep one tenant-partitioned registry with a stream watch

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
The sample must store each tenant's key binding and every delivery's state,
with conditional transitions, at 10,000 tenants (N-3), and keep one tenant's
items out of reach of another tenant's session (ADR-0003). Some items belong
to no tenant: the `KEYARN#` uniqueness item, and tombstones of removed
tenants. Expired URLs must be found without a table scan, terminal rows must
age out, and a changed binding must not go unnoticed, because the roles that
write bindings are guarded by conditions their own code chooses. Realises
P-2, P-8 and spec §4.

## Options considered
### Option 1: SSM parameters per tenant for bindings
Pros: simple reads; the repository's discovery mechanism. Cons: `PutParameter`
is throttled at a few requests per second per account; no conditional writes,
so no safe `CREATING -> ACTIVE`; deliveries do not fit at all.
### Option 2: One table per tenant
Pros: physical separation, per-table backup. Cons: onboarding creates
infrastructure; table quotas and policies at 10,000 tenants; a silo in a
pool deployment for no isolation gain, since ABAC enforces the partition.
### Option 3: One table, one partition per tenant, a stream watch
Pros: `PK = TENANT#<tenantId>`, `SK = KEY` or `DELIVERY#<ulid>`, so
`ListDeliveries` is one reverse query; `dynamodb:LeadingKeys` enforces the
partition; transactions give safe transitions; a stream can watch bindings.
Cons: a busy tenant concentrates on one partition; per-tenant restore is not
a table restore; non-tenant items need roles outside `LeadingKeys`.

## Decision
Option 3: one on-demand table with PITR (35 days), an AWS-owned key
(identifiers and status only, never content), TTL on `ttl` and a stream with
`NEW_AND_OLD_IMAGES`. Items are the key row (`SK = KEY`), delivery rows
(`SK = DELIVERY#<deliveryId>`), `KEYARN#<keyArn>` items written for both
tiers, and a `SYSTEM` partition. Key and delivery rows are kept apart by
attribute name, with the write rules of ADR-0003. Two expiry attributes do
two jobs: `urlExpiresAt` is the sort key of a sparse GSI whose partition key
`statusBucket = OPEN` exists only on `AWAITING_UPLOAD` and `PROCESSING` rows,
so the hourly sweep queries open work without a scan; `ttl` is set only on
terminal `EXPIRED`, `REJECTED` and `KEY_UNAVAILABLE` rows, 30 days on.
`statusBucket` is one constant value, so the GSI is one hot partition, which
is well within limits at N-2 rates. A registry watch, a Lambda on the stream
behind an event-source filter `SK = KEY` under `watchRole`, alarms on a
`MODIFY` that changes `keyArn` or `tier`, writes a `TOMBSTONE#<tenantId>`
item with a 7-day `ttl` into `SYSTEM` on every `REMOVE`, and alarms on an
`INSERT` for a tenant that has a tombstone. Failed batches go to an SQS
on-failure destination; images are never logged. `watchRole` reads the
stream, puts metrics and may `UpdateItem` only in `SYSTEM`.

## Consequences
Easier: a cross-tenant read is impossible to write; open work is one GSI
query; terminal rows clean themselves up; a rebind by key-factory or platform
code, and a removed tenant reappearing, raise an alarm (§10 step 11 checks
the tombstone). Harder: base roles reach the table without `LeadingKeys`,
which is filtered isolation the threat model names; the watch detects, it
does not prevent; a tenant re-onboarded within 7 days alarms by design and
needs an acknowledgement; PITR keeps file names and hashes of offboarded
tenants for 35 days (ADR-0005). Revisit if IAM adds a sort-key condition key
for DynamoDB (ADR-0003),
or if sweep volume outgrows one GSI partition, then shard `statusBucket`.

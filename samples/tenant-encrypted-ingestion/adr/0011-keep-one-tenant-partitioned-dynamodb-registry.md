<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0011: Keep one tenant-partitioned DynamoDB registry, encrypted with an AWS-owned key

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-8, F-10, F-17, F-21)
- Revised: 2026-11-05, second security review (G-1, G-8, G-13, G-14, G-18, G-20)

## Context
The API needs each tenant's key binding and status before it presigns
(ADR-0007); the processor needs the delivery row to lease and transition
(ADR-0016); tenants list their deliveries newest first; the vendor needs
per-tenant counters for cost (ADR-0013) and for limits (ADR-0015); the
authoriser needs the tenant's API key value before any tenant session exists
(ADR-0012). Access must be tenant-scoped by IAM, not by query code (P-2), at
10,000 tenants (N-3). Some items belong to no tenant: the `KEYARN#` item that
keeps one key from serving two tenants, the drain's sentinel, and the sweep's
cross-tenant query, which must not be a Scan (F-10, F-21).

The second review found that the registry's `keyArn` is the binding every
other check trusts: the presigner signs it, the processor compares `HeadObject`
against it, and the tenant roles' tag condition admits any key tagged for the
tenant. Code holding table-wide `UpdateItem`, or a tenant session's
`LeadingKeys` scope, could rewrite it, and every check would then agree with
the rewritten value (G-1, G-13). A `keyArn` stored in a non-canonical form
gives a second `KEYARN#` item for one key (G-14). And an eventually
consistent read just after a write can miss the row (G-18). Realises P-2, P-6,
P-9 and §4, §4.1, §4.2, §7.1, §8.

## Options considered
### Option 1: SSM parameters per tenant for key bindings
Pros: simple reads; already the repository's discovery mechanism. Cons:
`PutParameter` is throttled at a few requests per second per account, which
the repository has hit on destroy; no conditional writes, so no safe
`CREATING -> ACTIVE` transition; deliveries do not fit at all.
### Option 2: One table per tenant
Pros: physical separation; per-table backup. Cons: onboarding creates
infrastructure; table quotas and per-table policies at 10,000 tenants; a pool
deployment that behaves like a silo for no isolation gain, since ABAC already
enforces the partition.
### Option 3: One table, partition per tenant
Pros: `PK = TENANT#<tenantId>` with `SK = KEY` for the binding and
`SK = DELIVERY#<ulid>` for deliveries, so a tenant's items share one partition
and `ListDeliveries` is a reverse query by ULID; `dynamodb:LeadingKeys` in
each tenant role's identity policy (ADR-0003) makes a cross-tenant read
impossible to write; conditional writes and transactions give safe
transitions; `dynamodb:Attributes` conditions can pin individual attributes;
on-demand capacity, PITR on. Cons: a very busy tenant concentrates on one
partition; per-tenant restore is not a table restore; non-tenant items need a
principal outside `LeadingKeys`.

## Decision
Option 3. One partition per tenant matches the ABAC session exactly, so the
table enforces tenant scoping with one IAM condition. Three non-tenant item
shapes sit beside it: `KEYARN#<keyArn>` / `KEY`, keyed on the **canonical**
key ARN (`DescribeKey().KeyMetadata.Arn`, ADR-0004, G-14), written in the
same transaction as the key row and removed with it; `SYSTEM` / `DRAINING`,
the drain's sentinel that both `CreateTenantKey` writes are conditioned on
(ADR-0006); and a sparse GSI keyed by `statusBucket` (`OPEN` while a delivery
is `AWAITING_UPLOAD`, `PROCESSING` or `HELD`) with `expiresAt` as sort key, so
the sweep queries open deliveries across tenants without a Scan.

Table-wide access is split by function (ADR-0003): `keyFactoryRole` writes
the key row, the `KEYARN#` item and reads the sentinel; `platformRole` runs
every other platform operation and the drain; `sweepRole` queries the GSI and
updates rows it finds; `authoriserRole` reads `apiKeyValue` and `status` of a
key row and nothing else (G-8). That is a filtered component, stated as such
in ADR-0003 and the threat model, reached only through IAM-authenticated
`/platform/*`, the authoriser and scheduled jobs.

**The binding is written once** (G-1, ADR-0018). `keyArn` is written only by
`keyFactoryRole`'s `PutItem` with `attribute_not_exists(keyArn)`; every role,
base or tenant, has `UpdateItem` denied when `dynamodb:Attributes` contains
`keyArn` or `tier`, and the tenant roles additionally have `PutItem` and
`UpdateItem` denied on `keyArn`, `tier` and `apiKeyValue` (G-13). A
DynamoDB stream on the table feeds a registry-watch Lambda that raises an
alarm on any `KEY` item whose `keyArn` or `tier` changed between the old and
new image, the detective control behind the preventive Deny. The counters
(`inFlight`, `bytesStored`, `deliveriesAccepted`, `deliveriesRejected`,
`kmsRequests`) stay writable by the tenant roles in their own partition; a
compromised tenant session can skew its own counters, which is named.

The key row is written `CREATING` before the key exists and flipped to
`ACTIVE` by a conditional update once the key works (ADR-0004), so a failed
create leaves a visible row a retry can finish (as tenant-identity ADR-0021);
it also holds `apiKeyId`, `apiKeyValue` and the `inFlight` counter
(ADR-0015). Delivery transitions are conditional on the current status and,
once leased, on `leaseOwner` (ADR-0016); each terminal transition decrements
`inFlight` in the same transaction. Every processor and sweep read of a
delivery or key row uses `ConsistentRead` (G-18). TTL (30 days) removes
`AWAITING_UPLOAD`, `EXPIRED` and `REJECTED` rows; `ACCEPTED` rows stay. PITR
is on with its fixed 35-day window, which keeps an offboarded tenant's rows,
file names and hashes included, for that long (G-20, ADR-0006). The table is
encrypted with an AWS-owned key because it holds identifiers, statuses and
counters only, never document content or key material, and never a file name
in a key (ADR-0017); a per-tenant key on the table would add cost and no
protection, since DynamoDB encrypts a whole table with one key.

## Consequences
Easier: one table to deploy, back up and drain on stack delete (ADR-0006); the
partition key is the caller's tenant, so there is no cross-tenant query for a
tenant-path bug to write; the sweep costs one GSI query per hour; an existing
tenant cannot be rebound by any role, and an attempt that somehow succeeds
alarms. Harder: the registry must never store content, file text or user data
beyond `sub` and the validated `fileName`; validator `message` is stored, so
its author owns keeping content out (ADR-0009); the API key value sits in the
table, which is acceptable because it identifies a tenant for throttling and
authenticates nothing (ADR-0015); a stream, a Lambda and an alarm to deploy
and test; table-wide roles can still corrupt status and counters of any
tenant, which their narrow entry points and CloudTrail data events are the
controls for; the PITR window is a named residual of offboarding. Revisit if
a tenant's delivery rate approaches a single partition's throughput, which
calls for write sharding in the sort key, or if `LeadingKeys` patterns could
confine the table-wide roles to the non-tenant items.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0011: Keep one tenant-partitioned DynamoDB registry, encrypted with an AWS-owned key

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
The API needs each tenant's key binding and status before it presigns
(ADR-0007); the processor needs the delivery row to check and transition
(ADR-0010); tenants list their deliveries newest first; the vendor needs
per-tenant counters for cost (ADR-0013). Access must be tenant-scoped by IAM,
not by query code (P-2), at 10,000 tenants (N-3). Realises P-2, P-6, P-9 and
§4, §4.1, §4.2, §7.2.

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
and `ListDeliveries` is a reverse query by ULID; `dynamodb:LeadingKeys` in the
session policy makes a cross-tenant read impossible to write; conditional
writes give safe transitions; on-demand capacity, PITR on. Cons: a very busy
tenant concentrates on one partition; per-tenant restore is not a table
restore.

## Decision
Option 3. One partition per tenant matches the ABAC session exactly, so the
table enforces tenant scoping with one IAM condition. The key row is written
`CREATING` before the key exists and flipped to `ACTIVE` by a conditional
update once the key works (ADR-0004), so a failed create leaves a visible row
a retry can finish (as tenant-identity ADR-0021). Delivery transitions are
conditional on the current status. TTL (30 days) removes `AWAITING_UPLOAD`,
`EXPIRED` and `REJECTED` rows; `ACCEPTED` rows stay. The table is encrypted
with an AWS-owned key because it holds identifiers, statuses and counters
only, never document content or key material; a per-tenant key on the table
would add cost and no protection, since DynamoDB encrypts a whole table with
one key.

## Consequences
Easier: one table to deploy, back up and drain on stack delete (ADR-0006); the
partition key is the caller's tenant, so there is no cross-tenant query for a
bug to write. Harder: the registry must never store content, file text or user
data beyond `sub`; validator `message` is stored, so its author owns keeping
content out (ADR-0009). Revisit if a tenant's delivery rate approaches a
single partition's throughput, which calls for write sharding in the sort key.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0006: Make offboarding cryptographic

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-9, F-21, F-25, F-26)

## Context
When a tenant leaves, its documents must become unreadable, including copies
the vendor did not track: an object a delete missed, a backup, a consumer's
cache of ciphertext. S3 deletes of many objects take time and can fail part
way. Presigned URLs issued before the delete stay valid up to their TTL, so an
upload can land after the purge (F-26). The function that deletes must be
able to list and delete under both of the tenant's prefixes, which no
upload or process session may (F-9). A test or a deployer that tears down the
stack with tenants still registered must not leave keys that cost $1 per
month forever, and the drain that schedules them must not race a create
(F-21). Realises P-6 and §3.3 (`keyDeletionWindowDays`), §4.1, §5.1
`DeleteTenantKey`, §6.2, §8, N-3, N-4.

## Options considered
### Option 1: Delete the objects only
Pros: no KMS change; the key stays for audit. Cons: a missed object stays
readable; the key keeps costing; nothing proves the data is gone.
### Option 2: Disable the key
Pros: instant and reversible; every object becomes unreadable at once. Cons:
reversible is the problem for offboarding: anyone with key administration can
re-enable it; the key keeps costing.
### Option 3: Schedule key deletion after deleting objects and the alias
Pros: every object encrypted with the key is unreadable once the key is gone,
whether or not the object delete finished; a key pending deletion cannot be
used and is not billed; the window allows `CancelKeyDeletion` if offboarding
was a mistake. Cons: irreversible after the window; deletion is never
immediate.
### Option 4: Window length, shortest (7 days) versus the KMS default (30)
Seven days ends the exposure and the recovery option soonest and matches
"total" offboarding; thirty gives more time to catch a mistaken delete. Both
are free while pending.

## Decision
Option 3 with a 7-day default. `DeleteTenantKey` sets the row `DELETING` and
removes the tenant's API key first (ADR-0015), so no new `CreateDelivery` is
possible; lists and deletes the tenant's objects under `ingest/` and
`documents/` in pages of 1,000 under a `tenantPlatformRole` session, the one
tenant role with `s3:ListBucket` on both prefixes and `s3:DeleteObject` on
both (ADR-0003, F-9); then for `vendor-key` deletes the alias and calls
`ScheduleKeyDeletion` with `keyDeletionWindowDays` (7..30, default 7), and for
`tenant-key` leaves the key to its owner. It removes the key row and the
`KEYARN#` item in one transaction, and schedules a final prefix sweep after
`uploadUrlTtlSeconds` for URLs that were in flight (F-26). Meanwhile the
processor deletes any drop object whose row is missing or `DELETING` and
publishes nothing (ADR-0008), and the bucket policy's `s3:signatureAge`
limit and `If-None-Match` narrow what a late URL can do (ADR-0007). On stack
delete a registry drain, ordered after the API and the platform function,
writes a `SYSTEM`/`DRAINING` sentinel, waits one platform-function timeout
(in-flight invocations survive the function's deletion), re-scans with
`ConsistentRead`, and schedules every remaining `vendor-key` key the same way
(as tenant-identity ADR-0022). `CreateTenantKey` conditions both the
`CREATING` write and the `CREATING -> ACTIVE` flip on the sentinel being
absent; a flip that fails because the drain started schedules the
just-created key for deletion before returning 409. As a backstop the drain
lists keys by the construct's `tei:stack` tag and schedules any the registry
does not know (F-21).

## Consequences
Easier: offboarding has one verifiable end state (§10 step 11: no objects
under either prefix, no alias, key `PendingDeletion`, no event for a late
upload); teardown is clean within what KMS allows. Harder: keys pending
deletion survive `cdk destroy` for up to the window, which the integration
test lists and the README documents; they also count against the 100,000-key
quota until deleted (F-25, N-3), so tenant churn at scale consumes quota for 7
to 30 days; the final sweep means `DeleteTenantKey`'s effect completes one TTL
after it returns; deleting objects inline does not scale to millions of
objects, so bulk offboarding is a seam (§11). A `tenant-key` tenant's own key
and any ciphertext it still holds remain its responsibility. Revisit if KMS
offers immediate deletion.

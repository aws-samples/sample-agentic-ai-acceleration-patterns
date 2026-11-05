<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0006: Make offboarding cryptographic

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-9, F-21, F-25, F-26)
- Revised: 2026-11-05, second security review (G-11, G-14, G-20)

## Context
When a tenant leaves, its documents must become unreadable, including copies
the vendor did not track: an object a delete missed, a noncurrent version, a
backup, a consumer's cache of ciphertext. S3 deletes of many objects take
time and can fail part way. The bucket is versioned with a 7-day noncurrent
expiry (ADR-0019, G-11), so a plain `DeleteObject` only adds a delete marker
and leaves every version readable by anyone the key admits. Presigned URLs
issued before the delete stay valid up to their TTL, so an upload can land
after the purge (F-26). The function that deletes must be able to list and
delete under both of the tenant's prefixes, which no upload or process
session may (F-9). The registry has point-in-time recovery on, which keeps
every item, the tenant's file names and hashes included, for 35 days after
any delete (G-20). A test or a deployer that tears down the stack with
tenants still registered must not leave keys that cost $1 per month forever,
and the drain that schedules them must not race a create (F-21). Realises
P-6 and §3.3 (`keyDeletionWindowDays`), §4, §4.1, §5.1 `DeleteTenantKey`,
§6.2, §7.4, §8, N-3, N-4.

## Options considered
### Option 1: Delete the objects only
Pros: no KMS change; the key stays for audit. Cons: a missed object or
version stays readable; the key keeps costing; nothing proves the data is
gone.
### Option 2: Disable the key
Pros: instant and reversible; every object becomes unreadable at once. Cons:
reversible is the problem for offboarding: anyone with key administration can
re-enable it; the key keeps costing.
### Option 3: Schedule key deletion after deleting objects, versions and the alias
Pros: every object and version encrypted with the key is unreadable once the
key is gone, whether or not the delete finished; a key pending deletion
cannot be used and is not billed; the window allows `CancelKeyDeletion` if
offboarding was a mistake. Cons: irreversible after the window; deletion is
never immediate.
### Option 4: Window length, shortest (7 days) versus the KMS default (30)
Seven days ends the exposure and the recovery option soonest and matches
"total" offboarding; thirty gives more time to catch a mistaken delete. Both
are free while pending.

## Decision
Option 3 with a 7-day default. `DeleteTenantKey` sets the row `DELETING` and
removes the tenant's API key first (ADR-0015), so no new `CreateDelivery` is
possible. It then lists and deletes the tenant's objects **and every version
and delete marker** under `ingest/` and `documents/` in pages of 1,000 under
a `tenantPlatformRole` session, the one tenant role with listing on both
prefixes and `s3:DeleteObject` and `s3:DeleteObjectVersion` on both
(ADR-0003, F-9, G-11); listing versions (`ListObjectVersions`) is authorised
as `s3:ListBucketVersions`, which carries the same `s3:prefix` condition as
`s3:ListBucket`. For `vendor-key` it deletes the alias and calls
`ScheduleKeyDeletion` with `keyDeletionWindowDays` (7..30, default 7); for
`tenant-key` it leaves the key to its owner. It removes the key row and the
`KEYARN#<keyArn>` item in one transaction, where `keyArn` is the canonical
`DescribeKey().KeyMetadata.Arn` stored at create, so the uniqueness item it
deletes is the same one `CreateTenantKey` wrote (G-14). It schedules a final
prefix sweep after `uploadUrlTtlSeconds` for URLs that were in flight
(F-26). Meanwhile the processor deletes any drop object whose row is missing
or `DELETING` and publishes nothing (ADR-0008), and the bucket policy's
`s3:signatureAge` limit and `If-None-Match` narrow what a late URL can do
(ADR-0007).

On stack delete a registry drain, ordered after the API and the platform
function, writes a `SYSTEM`/`DRAINING` sentinel, waits one platform-function
timeout (in-flight invocations survive the function's deletion), re-scans
with `ConsistentRead`, and schedules every remaining `vendor-key` key the same
way (as tenant-identity ADR-0022). `CreateTenantKey` conditions both the
`CREATING` write and the `CREATING -> ACTIVE` flip on the sentinel being
absent; a flip that fails because the drain started schedules the
just-created key for deletion before returning 409. As a backstop the drain
lists keys by the construct's `tei:stack` tag and schedules any the registry
does not know (F-21).

Two things outlive offboarding by design and are named, not hidden: the key
pending deletion (for the window, unusable without `CancelKeyDeletion`), and
the registry's point-in-time backups, which keep the tenant's key row and
delivery rows, file names and hashes included and never document content,
for 35 days (P-6, G-20).

## Consequences
Easier: offboarding has one verifiable end state (§10 step 11: no objects and
no versions under either prefix, `ListObjectVersions` empty, no alias, key
`PendingDeletion`, no event for a late upload); teardown is clean within what
KMS allows. Harder: version deletion doubles the delete calls for every
document that was ever overwritten or deleted; keys pending deletion survive
`cdk destroy` for up to the window, which the integration test lists and the
README documents; they also count against the 100,000-key quota until
deleted (F-25, N-3), so tenant churn at scale consumes quota for 7 to 30
days; the final sweep means `DeleteTenantKey`'s effect completes one TTL
after it returns; deleting objects inline does not scale to millions of
objects, so bulk offboarding is a seam (§11); "offboarding is total" does not
cover the registry's PITR window, and a vendor that must erase identifiers
sooner turns PITR off and accepts the recovery loss. A `tenant-key` tenant's
own key and any ciphertext it still holds remain its responsibility. Revisit
if KMS offers immediate deletion, or if DynamoDB offers per-item exclusion
from PITR.

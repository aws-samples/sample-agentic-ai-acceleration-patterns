<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0006: Make offboarding cryptographic

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
When a tenant leaves, its documents must become unreadable, including copies
the vendor did not track: an object a delete missed, a backup, a consumer's
cache of ciphertext. S3 deletes of many objects take time and can fail part
way. A test or a deployer that tears down the stack with tenants still
registered must not leave keys that cost $1 per month forever. Realises P-6
and §3.3 (`keyDeletionWindowDays`), §5.1 `DeleteTenantKey`, §6.2, N-4.

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
Option 3 with a 7-day default. `DeleteTenantKey` sets the row `DELETING`,
deletes the tenant's objects under `ingest/` and `documents/`, then for
`vendor-key` deletes the alias and calls `ScheduleKeyDeletion` with
`keyDeletionWindowDays` (7..30, default 7); for `tenant-key` it leaves the key
to its owner. The row is removed last, so the API presigns nothing and the
processor drops events for the prefix. A deployer who wants a longer recovery
window sets the prop. On stack delete a registry drain, ordered after the API and the platform
function and guarded by a `DRAINING` sentinel that `CreateTenantKey` checks
(threat model M-31), schedules every
remaining `vendor-key` key the same way (as tenant-identity ADR-0022), so
`cdk destroy` leaves only keys pending deletion.

## Consequences
Easier: offboarding has one verifiable end state (§10 step 11: no objects, no
alias, key `PendingDeletion`); teardown is clean within what KMS allows.
Harder: keys pending deletion survive `cdk destroy` for up to the window, which
the integration test lists and the README documents; deleting objects inline
does not scale to millions of objects, so bulk offboarding is a seam (§11). A
`tenant-key` tenant's own key and any ciphertext it still holds remain its
responsibility. Revisit if KMS offers immediate deletion.

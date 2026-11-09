<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0005: Make offboarding cryptographic

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
A leaving tenant expects its documents to be gone, and the vendor must be able
to say so with evidence, not with "we ran a delete" (P-6). The bucket is
versioned (ADR-0002), so a delete leaves noncurrent versions; a presigned URL
may still be in flight; the registry holds file names and hashes; and the
pipeline is asynchronous, so a late upload can arrive after the tenant's rows
are gone. The stack itself can also be deleted with tenants still onboarded,
and every `vendor-key` key it made must then be scheduled too. Realises P-6
and spec §5.1, §6.2.

## Options considered
### Option 1: Delete the objects only
Pros: no KMS change; the key stays for audit. Cons: a missed object or version
stays readable; the key keeps costing; nothing proves the data is gone.
### Option 2: Disable the key
Pros: instant and reversible; every object becomes unreadable at once. Cons:
reversible is the problem: anyone with key administration can enable it
again; the key keeps costing.
### Option 3: Delete versions and the alias, then schedule key deletion
Pros: every object and version encrypted with the key is unreadable once the
key is gone, whether or not the deletes finished; a key pending deletion
cannot be used and is not billed; the window allows `CancelKeyDeletion` after
a mistaken offboarding. Cons: irreversible after the window; deletion is
never immediate. On the window: 7 days ends exposure and the recovery option
soonest; 30 (the KMS default) gives more time to catch a mistake.

## Decision
Option 3 with a 7-day window by default (`keyDeletionWindowDays`, 7..30).
`DeleteTenantKey` sets `keyStatus = DELETING`, deletes the tenant's API key
when `tenantThrottle` is on, and under a `tenantPlatformRole` session lists
every version and delete marker under `ingest/<t>/` and `documents/<t>/` and
deletes each one. For `vendor-key` it deletes the alias and schedules the key
for deletion; for `tenant-key` the key is the tenant's and is left untouched.
The key row and the `KEYARN#` item are removed in one transaction, and the
registry watch writes a 7-day tombstone (ADR-0010). There is no final prefix
sweep after the fact: a URL in flight fails on the pending-deletion key
(`vendor-key`) or lands an object the processor deletes because the row is
missing (`tenant-key`), and the 1-day noncurrent-version lifecycle on
`ingest/` removes what remains. On stack delete, a drain under `platformRole`
runs after CloudFormation has removed the API and the platform functions: it
schedules every registered `vendor-key` key and, as a backstop, lists keys by
the `tei:stack` tag (`ListKeys`, `ListResourceTags`) and schedules any the
registry no longer knows, which covers a create in flight when the API went.

## Consequences
Easier: offboarding is one call whose result is checkable (§10 step 11: no
version under either prefix, alias gone, key `PendingDeletion`); `tenant-key`
tenants can also offboard themselves by deleting their key. Harder: two named
residuals stay. The key pending deletion exists for the window, and the
account principal could cancel it. Registry backups (PITR, 35 days) keep file
names and hashes, never content, for 35 days after the rows go. Keys pending
deletion count against the KMS key quota (N-3), so bulk offboarding followed
by bulk onboarding needs headroom. An offboarded tenant re-onboarding within
7 days raises a watch alarm someone must acknowledge. Revisit if KMS offers immediate
deletion, if registry backups must forget a tenant sooner, or if the
`DRAINING` sentinel (§11) is built to close the drain's window.

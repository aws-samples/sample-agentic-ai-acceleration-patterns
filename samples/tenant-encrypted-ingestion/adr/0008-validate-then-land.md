<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0008: Validate, then land, through a quarantine drop prefix

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-11, F-12, F-26, F-30a)
- Revised: 2026-11-05, second security review (G-2, G-12, G-18)

## Context
Agents and extraction pipelines downstream act on whatever lands. A file that
lies about its type, a ZIP bomb, an oversize upload or an object encrypted
with the wrong key must never become visible to them, not even briefly.
Downstream consumers should need one rule to stay safe, not a check of their
own. The bytes that land must be the bytes that were checked: an object
rewritten between a check and the copy would land unvalidated content
(F-11). A late upload for a tenant being offboarded, or a second event for a
finished delivery, must not leave an object behind (F-26). The processor must
not read a registry row before it holds the tenant session that scopes the
read (F-30a). A drop object in an archive storage class cannot be read by
`GetObject` at all and would wedge the delivery (G-12). An eventually
consistent `GetItem` right after `CreateDelivery` can read a fresh row as
missing, and "missing" means "delete the drop object", so a valid upload
would be destroyed (G-18). And a `CopyObject` that sets
`Content-Disposition` must use `MetadataDirective: REPLACE`, which also
replaces `Content-Type`. Realises P-2, P-3, P-10 and §3.1 (bucket prefixes),
§3.3 (`dropRetentionDays`, `maxObjectSizeBytes`, `allowedContentTypes`),
§4.2, §8.

## Options considered
### Option 1: Land, then flag
Pros: one prefix, no copy, documents visible soonest. Cons: every consumer must
check a flag before reading, and one that does not acts on an unvalidated
file; a race between landing and flagging exposes the file anyway.
### Option 2: Validate in a drop prefix, then copy to a landed prefix
Pros: `documents/` holds only accepted objects, so the rule for consumers is
"subscribe to `DeliveryAccepted`, never read `ingest/`"; the drop is a
quarantine with a short lifecycle (`dropRetentionDays`, 1..7), so a stuck or
rejected object cannot linger; `tenantUploadRole` can write only `ingest/`,
so a tenant cannot write into `documents/` at all. Cons: a `CopyObject` per
accepted delivery (one `Decrypt` plus one `GenerateDataKey`); a short moment
where the object exists in both prefixes.
### Option 3: One prefix with object tags for status
Pros: no copy. Cons: tag-based read conditions in every consumer policy; tags
can be changed by anyone with `PutObjectTagging`; same failure as Option 1 for
a consumer that ignores tags.

## Decision
Option 2. Separation by prefix is enforceable by IAM, while separation by flag
or tag relies on every consumer's code. The processor takes the tenant id from
the object key's second segment and drops the event if it does not match the
tenant-id grammar (§7.0, G-2); it assumes `tenantProcessRole` for that id
first, with at least the processor timeout of session lifetime left
(ADR-0003), and only then loads the delivery row under that session with
`ConsistentRead`, so a wrong id is an `AccessDenied`, never another tenant's
row (F-30a), and a just-written row is never read as missing (G-18). Every
processor and sweep read of a delivery or key row is a consistent read.

A missing or `DELETING` row means the tenant is being offboarded: the
processor deletes the drop object and publishes nothing. A terminal row means
a late or duplicate event: it deletes the drop object if one is left (F-26).
Otherwise it takes the lease (ADR-0016) and runs the structural checks: key
match (`HeadObject` `SSEKMSKeyId` equals the registry's canonical `keyArn`
and no bucket key, else `structural:KEY_MISMATCH`), storage class
(`StorageClass` other than `STANDARD` is `structural:STORAGE_CLASS`, the
backstop to the bucket policy's storage-class Deny, G-12), size
(`ContentLength` equals the declared size and is within the limit, else
`TOO_LARGE` or `SIZE_MISMATCH`, F-12), and it records `dropEtag` on the row.
Every later read is pinned to that ETag: the streaming `GetObject`
(`IfMatch`) for magic bytes against the declared type (`TYPE_MISMATCH`,
`UNSUPPORTED_TYPE`), ZIP central-directory sanity (`BAD_ARCHIVE`) and
SHA-256; each validator's presigned `GET` (ADR-0009); and the `CopyObject` to
`documents/<tenantId>/<deliveryId>` with the same key, `bucket-key-enabled:
false`, `CopySourceIfMatch = dropEtag` and `MetadataDirective: REPLACE`
carrying both `Content-Type` (the declared type) and `Content-Disposition`
(from the row's `fileName`, ADR-0017), since `REPLACE` drops any metadata the
copy does not set. A precondition failure at any pinned step is `REJECTED
structural:OBJECT_CHANGED`. The bucket policy's `If-None-Match` rule makes an
overwrite impossible in the first place (ADR-0007); the ETag pin is the
proof. Then the processor deletes the drop and marks the row `ACCEPTED`,
conditional on its lease. A rejected object is deleted at once.

## Consequences
Easier: consumers and the agentic-runtime-isolation tenant role grant read on
`documents/${aws:PrincipalTag/TenantId}/*` only; the key-match check makes a
mismatch visible even though ADR-0002 makes it impossible to create; an
object can neither change under the checks nor outlive a terminal row; an
archived drop object ends in a named rejection instead of a retry loop.
Harder: the copy doubles the KMS request count of an accepted delivery;
consistent reads cost twice the read capacity of eventually consistent ones;
structural checks are not content checks, so malware scanning and schema
rules are the deployer's custom validators; three rejection reasons
(`SIZE_MISMATCH`, `OBJECT_CHANGED`, `STORAGE_CLASS`) to document and test.
Revisit if S3 offers an atomic conditional move between prefixes.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0008: Validate, then land, through a quarantine drop prefix

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-11, F-12, F-26, F-30a)

## Context
Agents and extraction pipelines downstream act on whatever lands. A file that
lies about its type, a ZIP bomb, an oversize upload or an object encrypted
with the wrong key must never become visible to them, not even briefly.
Downstream consumers should need one rule to stay safe, not a check of their
own. The bytes that land must be the bytes that were checked: an object
rewritten between a check and the copy would land unvalidated content
(F-11). A late upload for a tenant being offboarded, or a second event for a
finished delivery, must not leave an object behind (F-26). And the
processor must not read a registry row before it holds the tenant session
that scopes the read (F-30a). Realises P-2, P-3, P-10 and §3.1 (bucket
prefixes), §3.3 (`dropRetentionDays`, `maxObjectSizeBytes`,
`allowedContentTypes`), §4.2, §8.

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
the object key, assumes `tenantProcessRole` for it first and only then loads
the delivery row under that session, so a wrong id is an `AccessDenied`,
never another tenant's row (F-30a). A missing or `DELETING` row means the
tenant is being offboarded: the processor deletes the drop object and
publishes nothing. A terminal row means a late or duplicate event: it deletes
the drop object if one is left (F-26). Otherwise it takes the lease
(ADR-0016) and runs the structural checks: key match (`HeadObject`
`SSEKMSKeyId` equals the registry's `keyArn` and no bucket key, else
`structural:KEY_MISMATCH`), size (`ContentLength` equals the declared size
and is within the limit, else `TOO_LARGE` or `SIZE_MISMATCH`, F-12), and it
records `dropEtag` on the row. Every later read is pinned to that ETag: the
streaming `GetObject` (`IfMatch`) for magic bytes against the declared type
(`TYPE_MISMATCH`, `UNSUPPORTED_TYPE`), ZIP central-directory sanity
(`BAD_ARCHIVE`) and SHA-256; each validator's presigned `GET` (ADR-0009); and
the `CopyObject` to `documents/<tenantId>/<deliveryId>` with the same key,
`bucket-key-enabled: false`, `CopySourceIfMatch = dropEtag` and
`Content-Disposition` from the row's `fileName` (ADR-0017). A precondition
failure at any pinned step is `REJECTED structural:OBJECT_CHANGED`. The bucket
policy's `If-None-Match` rule makes an overwrite impossible in the first place
(ADR-0007); the ETag pin is the proof. Then the processor deletes the drop and
marks the row `ACCEPTED`, conditional on its lease. A rejected object is
deleted at once.

## Consequences
Easier: consumers and the agentic-runtime-isolation tenant role grant read on
`documents/${aws:PrincipalTag/TenantId}/*` only; the key-match check makes a
mismatch visible even though ADR-0002 makes it impossible to create; an
object can neither change under the checks nor outlive a terminal row.
Harder: the copy doubles the KMS request count of an accepted delivery;
structural checks are not content checks, so malware scanning and schema
rules are the deployer's custom validators; two new rejection reasons
(`SIZE_MISMATCH`, `OBJECT_CHANGED`) to document and test. Revisit if S3 offers
an atomic conditional move between prefixes.

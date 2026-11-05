<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0008: Validate, then land, through a quarantine drop prefix

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
Agents and extraction pipelines downstream act on whatever lands. A file that
lies about its type, a ZIP bomb, an oversize upload or an object encrypted
with the wrong key must never become visible to them, not even briefly.
Downstream consumers should need one rule to stay safe, not a check of their
own. Realises P-3, P-10 and §3.1 (bucket prefixes), §3.3
(`dropRetentionDays`, `maxObjectSizeBytes`, `allowedContentTypes`), §8.

## Options considered
### Option 1: Land, then flag
Pros: one prefix, no copy, documents visible soonest. Cons: every consumer must
check a flag before reading, and one that does not acts on an unvalidated
file; a race between landing and flagging exposes the file anyway.
### Option 2: Validate in a drop prefix, then copy to a landed prefix
Pros: `documents/` holds only accepted objects, so the rule for consumers is
"subscribe to `DeliveryAccepted`, never read `ingest/`"; the drop is a
quarantine with a one-day lifecycle (`dropRetentionDays`, 1..7), so a stuck or
rejected object cannot linger; the session policy gives the API write on
`ingest/` only, so a tenant cannot write into `documents/` at all. Cons: a
`CopyObject` per accepted delivery (one `Decrypt` plus one `GenerateDataKey`);
a short moment where the object exists in both prefixes.
### Option 3: One prefix with object tags for status
Pros: no copy. Cons: tag-based read conditions in every consumer policy; tags
can be changed by anyone with `PutObjectTagging`; same failure as Option 1 for
a consumer that ignores tags.

## Decision
Option 2. Separation by prefix is enforceable by IAM, while separation by flag
or tag relies on every consumer's code. The processor runs the structural
checks in this order: key match (`HeadObject` `SSEKMSKeyId` equals the
registry's `keyArn`, else `structural:KEY_MISMATCH`), size (`TOO_LARGE`),
magic bytes against the declared type (`TYPE_MISMATCH`,
`UNSUPPORTED_TYPE`), ZIP central-directory sanity (`BAD_ARCHIVE`), and a
SHA-256 computed while streaming. Custom validators follow (ADR-0009). Only
then `CopyObject` to `documents/<tenantId>/<deliveryId>/<fileName>` with the
same key and `CopySourceIfMatch` set to the ETag read by `HeadObject`, so an
object overwritten after validation fails the copy and the delivery is
retried from the first check (threat model M-18); delete the drop, and mark
the row `ACCEPTED`. A rejected object is
deleted at once.

## Consequences
Easier: consumers and the agentic-runtime-isolation TVM grant read on
`documents/${aws:PrincipalTag/TenantId}/*` only; the key-match check makes a
mismatch visible even though ADR-0002 makes it impossible to create. Harder:
the copy doubles the KMS request count of an accepted delivery; structural
checks are not content checks, so malware scanning and schema rules are the
deployer's custom validators. Revisit if S3 offers an atomic conditional move
between prefixes.

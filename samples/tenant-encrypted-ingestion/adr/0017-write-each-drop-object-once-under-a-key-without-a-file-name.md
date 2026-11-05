<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0017: Write each drop object once under a key without a file name

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, second security review (G-11, G-12, G-19)

## Context
The first design keyed drop objects as `ingest/<tenantId>/<deliveryId>/<fileName>`.
Two problems follow. A presigned URL can be used repeatedly until it expires,
so an uploader can overwrite the drop object while the processor runs or
after acceptance, the bytes that were validated may not be the bytes that
land, and unvalidated objects linger in `ingest/` (F-11); bucket versioning,
now on for recovery (ADR-0019), keeps the old version but does not stop the
overwrite. And the object key travels far: a tenant-chosen, possibly personal
name (`smith-passport.pdf`) would appear in S3 server access logs, CloudTrail
S3 data events, the KMS encryption context `aws:s3:arn` logged in the vendor's
CloudTrail and, for `tenant-key`, in the tenant's, in EventBridge events, in
SQS and DLQ bodies, and in `landedKey` on the bus (F-13). A file name in a key
also carries a path-traversal and unicode surface. The tenant still needs its
file name back on the landed document.

Two facts from the second review bear on the write-once URL. The SDK
presigner signs `If-None-Match` only if told to; unsigned, the header drops
out of the URL and only the bucket policy still requires it (G-19). And an
uploader can add unsigned headers the URL does not fix, of which
`x-amz-storage-class` is the one that hurts: a drop object written to
`GLACIER` or `DEEP_ARCHIVE` cannot be read by the processor and carries a
minimum storage charge (G-12). Realises P-3, P-7, P-10 and §4.2, §5.2, §5.4,
§7.4, §7.5, N-6.

## Options considered
### Option 1: Keep `fileName` in the key, with a character allowlist
Pros: the landed key is readable to a human; no extra metadata. Cons: an
allowlist (`[A-Za-z0-9._-]{1,128}`) removes traversal and unicode but not the
leak: a personal name still lands in every log, event and encryption context
above, in two accounts for `tenant-key`; overwrite (F-11) needs a separate
fix anyway.
### Option 2: Opaque key `ingest/<tenantId>/<deliveryId>`, `If-None-Match`, `fileName` on the row and in `Content-Disposition`
Pros: the key is two vendor-chosen identifiers, so no tenant-chosen string
reaches a log, an event or an encryption context; the presigned PUT signs
`If-None-Match: *` and the bucket policy denies a PUT to `ingest/*` without
it, so each URL writes exactly once and an overwrite is impossible; the
`fileName` is validated against `[A-Za-z0-9._-]{1,128}` at `CreateDelivery`,
stored on the delivery row and set as `Content-Disposition: attachment;
filename="<fileName>"` on the landed object at the copy, so the tenant and
consumers still get it. Cons: the landed key is not human-readable; a consumer
reads the name from the object's metadata or `GetDelivery`; conditional
writes require the client to send the header exactly.

## Decision
Option 2. The drop key is `ingest/<tenantId>/<deliveryId>` and the landed key
`documents/<tenantId>/<deliveryId>`. The presigned PUT signs `If-None-Match:
*` with the encryption headers, `Content-Length` and `Content-Type`
(ADR-0007), all six listed under the presigner's `signableHeaders`, and a
unit test parses `X-Amz-SignedHeaders` from a generated URL and asserts all
six, so the write-once header cannot fall out of the signature unnoticed
(G-19). The bucket policy denies `PutObject` to `ingest/*` when
`s3:if-none-match` is absent, and denies it when `s3:x-amz-storage-class` is
present and not `STANDARD` or `s3:x-amz-website-redirect-location` is present
(§7.4, G-12); the processor rejects any drop object whose `StorageClass` is
not `STANDARD` as `structural:STORAGE_CLASS` (ADR-0008). The conditional-write
Deny stays scoped to `ingest/*`: a `CopyObject` into a prefix that enforces
it fails, and the copy into `documents/` must not. The processor pins every
read and the copy to the ETag it recorded (ADR-0008), so the conditional
write prevents an overwrite and the ETag proves none happened. `fileName`
lives only on the delivery row and in the landed object's
`Content-Disposition`; it never appears in a key, a log line, an event or a
queue message.

## Consequences
Easier: one class of personal data leaves the logs, CloudTrail, the KMS
encryption context and the event bus for good; traversal and unicode in keys
are gone; the validated bytes are the landed bytes; a reused URL gets 412 and
an archive storage class gets 403, which the integration test asserts (§10
step 4); a presigner misconfiguration fails a unit test; unit tests assert
that no log line or event carries the file name. Harder: tooling that
browses the bucket sees ULIDs, not names; a consumer that wants the name
reads `Content-Disposition` or calls `GetDelivery`; a client that drops the
`If-None-Match` header gets 403 and must follow the returned headers; a
client that wants another storage class for its drop cannot have one, by
design. Revisit if deliveries move to multipart upload, where the write-once
mechanism has to be rebuilt on `CompleteMultipartUpload`.

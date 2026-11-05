<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0006: Presign a write-once upload under an opaque key

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
Tenants need a way to deliver files of up to 100 MiB without AWS credentials,
and the vendor must decide where each file goes, with which key, at what size,
and that it is written once (P-3, P-7). A tenant-chosen file name in the
object key would reach CloudTrail, the KMS encryption context, S3 events, SQS
and access logs, in two accounts for `tenant-key`. The SDK presigner signs
only `host` by default and hoists `x-amz-*` headers into the query string,
where the uploader could drop them. A presigned URL from role-chained
credentials dies with them, after at most one hour. Realises P-3, P-7 and
spec §7.4, §7.5.

## Options considered
### Option 1: SFTP through AWS Transfer Family
Pros: familiar to tenants that use SFTP; users can map to `tenantUploadRole`.
Cons: a server billed per hour per protocol; SSH keys per user; a second
identity system beside `tenant-identity`; kept as a seam (§11).
### Option 2: Presigned `PUT` from the API, every header that matters signed
Pros: the API picks the key under the token's tenant and signs under a
`tenantUploadRole` session (ADR-0003), so a URL can write only where that
role may, and editing its path breaks the signature; bytes go straight to S3.
Cons: the client must send the returned headers exactly; no resumable
multipart; access logs hold the signed URI; presigner defaults must be
overridden and tested.
### Option 3: Presigned `POST` with a policy document, or proxying through Lambda
`POST` bounds the size natively but cannot express the conditional write, so
write-once would rest on the bucket policy alone. Proxying runs into the
10 MB API Gateway and 6 MB Lambda payload limits and gives the proxy write
access to every tenant's prefix.

## Decision
Option 2. `CreateDelivery` presigns a `PUT` on `ingest/<tenantId>/<deliveryId>`
(a ULID; no file name in the key) with six signed headers:
`x-amz-server-side-encryption: aws:kms`, the tenant's `keyArn` as the KMS key
id, `x-amz-server-side-encryption-bucket-key-enabled: false`,
`If-None-Match: *`, `Content-Length` and `Content-Type` as declared. The
presigner lists all six in `signableHeaders` and the three `x-amz-*` in
`unhoistableHeaders` (SDK v3 `getSignedUrl`), and a unit test asserts them.
The file name, `[A-Za-z0-9._-]{1,128}`, lives on the row and returns as
`Content-Disposition` on the landed object (ADR-0007). The bucket denies a
PUT on `ingest/*` without `s3:if-none-match` (which also refuses multipart
there, so the Deny stays scoped to `ingest/*`), a PUT without SSE-KMS, a
storage class other than `STANDARD` and any website redirect, because those
two headers are unsigned. Write-once holds per object version: on a versioned
bucket, once the processor deletes the drop version, the same URL writes
again until its TTL and the processor discards that upload against the
terminal row. The URL lifetime is `uploadUrlTtlSeconds`, at most 3300 so a
fresh one-hour session always outlives it, and the API returns `expiresAt =
min(now + TTL, credentials.Expiration)`. A bucket Deny on `s3:signatureAge`
above the configured TTLs stops code from presigning longer; `X-Amz-Expires`
is what ends a URL.

## Consequences
Easier: an uploader cannot change the key, the encryption, the size or the
target, and §10 step 4 proves each with a 403 or `SignatureDoesNotMatch`; no
tenant-chosen string reaches a log, an event or a context. Harder: the landed
key is not readable to a human, so consumers read the name from
`Content-Disposition` or `GetDelivery`; extra unsigned `x-amz-*` headers are
undocumented, so the test records them; a logged PUT URL is reusable after
processing until its TTL, at the cost of one processor run (N-6). Revisit if
S3 adds a condition key for the bucket-key header or a write-once setting
per prefix.

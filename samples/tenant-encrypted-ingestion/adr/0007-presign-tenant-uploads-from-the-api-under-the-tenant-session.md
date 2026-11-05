<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0007: Presign tenant uploads from the API under the tenant session, with the key fixed in signed headers

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-11, F-12, F-13, F-14, F-18, F-23)
- Revised: 2026-11-05, second security review (G-4, G-10, G-11, G-12, G-17, G-19)

## Context
Tenant users need to put files of up to 100 MiB into the drop. They hold a
`tenant-identity` token, never AWS credentials of the vendor's account. Each
upload must land under exactly one vendor-chosen key in the tenant's prefix,
encrypted with that tenant's key, and nothing the uploader sends may change
either (P-3, P-7). A presigned URL is a bearer credential with properties
that the design has to close: it can be used repeatedly until it expires
(F-11); it does not bound the body unless the length is signed (F-12); it
dies when the signing credentials do, whatever `X-Amz-Expires` says (F-18);
and S3 server access logs record the full request URI, signature and
credential id included (F-14).

Four more facts came out of the second review. The AWS SDK for JavaScript v3
presigner signs only `host` by default and hoists `x-amz-*` headers into the
query string, so `Content-Length`, `Content-Type` and `If-None-Match` are
signed only if the presigner is told to; if they are not, the size bound and
the write-once header silently disappear from the URL (G-19). Headers the
uploader adds unsigned have policy answers whatever S3 does with them:
`x-amz-storage-class: GLACIER` parks a drop object where the processor's
`GetObject` fails, and `x-amz-website-redirect-location` has no business on a
drop (G-12). An Allow-only log-bucket policy is filtered within one account,
and the logs carry the validators' presigned `GET` URIs too, which are
reusable until their TTL (G-10). And without a principal-scoped Deny any
vendor principal with an identity `s3:PutObject` could write under the
prefixes (G-11). Realises P-3, P-7 and §1.2, §5.2 `CreateDelivery`, §7.4,
§7.5.

## Options considered
### Option 1: SFTP through AWS Transfer Family
Pros: familiar to tenants that exchange files by SFTP; per-user role mapping
can reuse `tenantUploadRole` (§11). Cons: a server billed by the hour per
protocol whether used or not; SSH key or password management per tenant
user; a second identity system beside `tenant-identity`; out of scope for the
pattern, which is the key boundary, not the transport.
### Option 2: Direct S3 access with an IAM user per tenant
Pros: native S3 tooling. Cons: long-lived access keys outside the vendor's
account; IAM user quota; the tenant could choose object keys and encryption
headers within whatever the policy allows.
### Option 3: Presigned `PUT` from the API
Pros: the API picks the object key under the token's tenant and signs under a
`tenantUploadRole` session (ADR-0003), so a URL can only write where that
role may; every header that matters is signed, so changing or omitting one
breaks the signature (§10 step 4); bytes go straight to S3, no size limit
from the API; the URL expires with its TTL. Cons: the client must send the
returned headers exactly; one URL per object, no resumable multipart in the
sample; access logs carry the signed URI; the presigner's defaults must be
overridden and tested.
### Option 4: Presigned `POST` with a policy document
Pros: `content-length-range` bounds the body natively. Cons: a form upload
with its own policy format; the conditional-write header is not a POST policy
condition, so the write-once guarantee would rest on the bucket policy alone;
two client shapes to document.
### Option 5: The API proxies the bytes through Lambda
Pros: the vendor sees every byte before S3 does. Cons: the API Gateway REST
payload limit of 10 MB
(https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html)
and the Lambda synchronous request payload limit of 6 MB
(https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
rule out 100 MiB deliveries; pays compute for transfer; the Lambda role needs
write and KMS use on every tenant's prefix.

## Decision
Option 3 (spec §7.5). The object key is `ingest/<tenantId>/<deliveryId>`,
with no tenant-chosen file name in it (ADR-0017). Signed headers:
`x-amz-server-side-encryption: aws:kms`,
`x-amz-server-side-encryption-aws-kms-key-id: <keyArn>`,
`x-amz-server-side-encryption-bucket-key-enabled: false` (ADR-0002, F-23),
`If-None-Match: *` (write once, F-11), `Content-Length` equal to the declared
`sizeBytes` (F-12) and `Content-Type` equal to the declared type. The
presigner lists all six under `signableHeaders` and the three `x-amz-*`
headers under `unhoistableHeaders` (SDK for JavaScript v3 `getSignedUrl`), so
none is hoisted into the query string or left unsigned, and a unit test
parses `X-Amz-SignedHeaders` from a generated URL and asserts all six (G-19).
`CreateDelivery` returns the same headers so the client knows what to send.

The bucket policy backs the signature (§7.4, ADR-0019): it denies `PutObject`
to `ingest/*` when `s3:if-none-match` is absent; denies a PUT that is not
SSE-KMS; denies a PUT to `ingest/*` whose `s3:x-amz-storage-class` is present
and not `STANDARD`, or that carries `s3:x-amz-website-redirect-location`
(G-12); denies `PutObject` on `ingest/*` unless `aws:PrincipalArn` is one of
the three tenant roles, and `PutObject`, `DeleteObject` and
`DeleteObjectVersion` on `documents/*` unless it is `tenantProcessRole` or
`tenantPlatformRole` (role ARNs, never session ARNs, G-11); and denies any
request whose `s3:signatureAge` exceeds `max(uploadUrlTtlSeconds,
validatorObjectUrlTtlSeconds) * 1000` ms, so neither the upload URL nor a
validator's `GET` dies early (G-17). The bucket-key header has no S3 condition
key, so the bucket policy carries no statement for it; the signature, the
bucket default and KMS statement 4c hold it instead (ADR-0002, G-4).

`uploadUrlTtlSeconds` is 60..3300, default 900: the cap leaves 300 s under
the one-hour role-chaining session, the API presigns only from a session with
at least TTL plus 60 s left, and `expiresAt = min(now + TTL,
credentials.Expiration)` (F-18, ADR-0003). The cheap checks (`fileName`
pattern, type in `allowedContentTypes`, declared size under
`maxObjectSizeBytes`, the tenant's in-flight limit, ADR-0015) run at
`CreateDelivery`, before any upload.

S3 server access logs go to a separate SSE-S3 log bucket with an explicit
**Deny** of `s3:GetObject` unless `aws:PrincipalArn` is
`accessLogReaderRole`, because they are the one place the presigned URIs are
recorded (F-14, G-10); an Allow alone would be filtered. A logged upload URL
is single-use (`If-None-Match`); a logged validator `GET` is reusable until
its `validatorObjectUrlTtlSeconds` runs out, so log delivery latency, minutes,
is what keeps that window small, not zero (N-6). No tenant operation
downloads a document: a download route is a seam (§11), as is a transfer
endpoint.

## Consequences
Easier: no transfer infrastructure; an unencrypted, wrongly encrypted,
archived, redirected, oversize or repeated upload is refused by S3 itself; a
URL that leaks after use is worthless for upload, because it is single-use
and its signature dies with the TTL; a regression in the presigner's
configuration fails a unit test instead of silently widening the URL; no
principal outside the tenant roles can write or delete under the prefixes,
whatever its identity policy says. Harder: the URL is a bearer credential for
its lifetime, so it is never logged by the sample's functions; the
access-log residual (reusable validator `GET`s within their TTL) is stated in
N-6 and the threat model; a principal that needs to read access logs must be
`accessLogReaderRole`; whether S3 accepts extra unsigned `x-amz-*` headers on
a query-signed PUT is not documented, so the integration test asserts the
storage-class 403 and records the outcome for `x-amz-tagging` and
`x-amz-server-side-encryption-context` (§10 step 4); an unused URL leaves an
`AWAITING_UPLOAD` row that the hourly sweep flips to `EXPIRED` (§8). Revisit
if deliveries outgrow a single `PUT` (5 GB), which needs presigned multipart
and a different write-once mechanism.

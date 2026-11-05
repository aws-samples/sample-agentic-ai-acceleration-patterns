<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0007: Presign tenant uploads from the API under the tenant session, with the key fixed in signed headers

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-11, F-12, F-13, F-14, F-18, F-23)

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
credential id included (F-14). Realises P-3, P-7 and §1.2, §5.2
`CreateDelivery`, §7.4, §7.5.

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
sample; access logs carry the signed URI.
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
`sizeBytes` (F-12) and `Content-Type` equal to the declared type;
`CreateDelivery` returns them so the client knows what to send. The bucket
policy backs the signature: it denies `PutObject` to `ingest/*` when
`s3:if-none-match` is absent, denies a PUT that is not SSE-KMS or asks for a
bucket key, and denies any request whose `s3:signatureAge` exceeds the TTL
(§7.4). `uploadUrlTtlSeconds` is 60..3300, default 900: the cap leaves 300 s
under the one-hour role-chaining session, the API presigns only from a
session with at least TTL plus 60 s left, and `expiresAt = min(now + TTL,
credentials.Expiration)` (F-18, ADR-0003). The cheap checks (`fileName`
pattern, type in `allowedContentTypes`, declared size under
`maxObjectSizeBytes`, the tenant's in-flight limit, ADR-0015) run at
`CreateDelivery`, before any upload. S3 server access logs go to a separate
SSE-S3 log bucket whose `s3:GetObject` is allowed to one
`accessLogReaderRole` only, because they are the one place the presigned URI
is recorded (F-14). No tenant operation downloads a document: a download
route is a seam (§11), as is a transfer endpoint.

## Consequences
Easier: no transfer infrastructure; an unencrypted, wrongly encrypted,
oversize or repeated upload is refused by S3 itself; a URL that leaks after
use is worthless, because it is single-use and its signature dies with the
TTL. Harder: the URL is a bearer credential for its lifetime, so it is never
logged by the sample's functions; the access-log residual is stated in N-6 and
the threat model; whether S3 accepts extra unsigned `x-amz-*` headers on a
query-signed PUT is not documented, so the integration test records the
outcome (§10 step 4); an unused URL leaves an `AWAITING_UPLOAD` row that the
hourly sweep flips to `EXPIRED` (§8). Revisit if deliveries outgrow a single
`PUT` (5 GB), which needs presigned multipart and a different write-once
mechanism.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0007: Presign tenant uploads from the API under the tenant session, with the key fixed in signed headers

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
Tenant users need to put files of up to 100 MiB into the drop. They hold a
`tenant-identity` token, never AWS credentials of the vendor's account. Each
upload must land under exactly one vendor-chosen key in the tenant's prefix,
encrypted with that tenant's key, and nothing the uploader sends may change
either (P-3, P-7). Realises P-3, P-7 and §1.2, §5.2 `CreateDelivery`, §7.2.

## Options considered
### Option 1: SFTP through AWS Transfer Family
Pros: familiar to tenants that exchange files by SFTP; per-user session
policies can mirror §7.2. Cons: a server billed by the hour per protocol
whether used or not; SSH key or password management per tenant user; a second
identity system beside `tenant-identity`; out of scope for the pattern, which
is the key boundary, not the transport.
### Option 2: Direct S3 access with an IAM user per tenant
Pros: native S3 tooling. Cons: long-lived access keys outside the vendor's
account; IAM user quota; the tenant could choose object keys and encryption
headers within whatever the policy allows.
### Option 3: Presigned `PUT` from the API
Pros: the API picks the object key `ingest/<tenantId>/<deliveryId>/<fileName>`
under the token's tenant and signs under the tenant-scoped session (ADR-0003),
so a URL can only write where that session may; `x-amz-server-side-encryption:
aws:kms` and the key id are signed headers, so changing them breaks the
signature (§10 step 4); bytes go straight to S3, no size limit from the API;
the URL expires after `uploadUrlTtlSeconds`. Cons: the client must send the
returned headers exactly; one URL per object, no resumable multipart in the
sample.
### Option 4: The API proxies the bytes through Lambda
Pros: the vendor sees every byte before S3 does. Cons: API Gateway's 10 MB
payload limit and Lambda's 6 MB invoke limit rule out 100 MiB deliveries;
pays compute for transfer; the Lambda role needs write and KMS use on every
tenant's prefix.

## Decision
Option 3. It reuses the token the tenant already holds, gives AWS the final say
on where and with which key an object lands, and costs nothing when idle. The
cheap checks (type in `allowedContentTypes`, declared size under
`maxObjectSizeBytes`) run at `CreateDelivery`, before any upload. No tenant
operation downloads a document: the sample lands documents for agents and
pipelines, and a download route is a seam (§11), as is a transfer endpoint.

## Consequences
Easier: no transfer infrastructure; the bucket policy's SSE-KMS-only deny plus
the signed headers make an unencrypted or wrongly encrypted upload impossible.
Harder: the presigned URL is a bearer credential for its lifetime, so it is
never logged and the default TTL is 15 minutes; an unused URL leaves an
`AWAITING_UPLOAD` row that the hourly sweep flips to `EXPIRED` (§8). Revisit if
deliveries outgrow a single `PUT` (5 GB), which needs presigned multipart.

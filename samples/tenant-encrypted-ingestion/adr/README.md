<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Architecture decision records

| # | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-encrypt-server-side-with-sse-kms-and-one-kms-key-per-tenant.md) | Encrypt server-side with SSE-KMS and one KMS key per tenant | Accepted | 2026-11-05 |
| [0002](./0002-bind-each-key-to-its-tenant-prefix-with-a-deny-first-key-policy.md) | Bind each key to its tenant prefix with a deny-first key policy | Accepted | 2026-11-05 |
| [0003](./0003-put-the-tenant-boundary-in-identity-policies-of-one-tenant-role-per-function.md) | Put the tenant boundary in identity policies of one tenant role per function | Accepted | 2026-11-05 |
| [0004](./0004-offer-two-key-tiers-and-fail-closed-through-an-s3-probe.md) | Offer two key tiers and fail closed through an S3 probe | Accepted | 2026-11-05 |
| [0005](./0005-make-offboarding-cryptographic.md) | Make offboarding cryptographic | Accepted | 2026-11-05 |
| [0006](./0006-presign-a-write-once-upload-under-an-opaque-key.md) | Presign a write-once upload under an opaque key | Accepted | 2026-11-05 |
| [0007](./0007-validate-then-land-with-etag-pins-and-a-lease.md) | Validate, then land, with ETag pins and a lease | Accepted | 2026-11-05 |
| [0008](./0008-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md) | Make validation a pluggable chain of deployer-supplied validators | Accepted | 2026-11-05 |
| [0009](./0009-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md) | Drive the pipeline with EventBridge, SQS and Lambda | Accepted | 2026-11-05 |
| [0010](./0010-keep-one-tenant-partitioned-registry-with-a-stream-watch.md) | Keep one tenant-partitioned registry with a stream watch | Accepted | 2026-11-05 |
| [0011](./0011-authenticate-tenants-with-the-token-contract-and-throttle-per-tenant-optionally.md) | Authenticate tenants with the token contract and throttle per tenant optionally | Accepted | 2026-11-05 |
| [0012](./0012-deliver-the-pattern-as-a-construct-with-per-tenant-observability.md) | Deliver the pattern as a construct with per-tenant observability | Accepted | 2026-11-05 |

Renumbered 2026-11-05 before implementation; earlier drafts were never merged.

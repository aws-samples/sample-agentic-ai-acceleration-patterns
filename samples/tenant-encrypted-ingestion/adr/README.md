<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Architecture decision records

| # | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-encrypt-server-side-with-sse-kms-and-one-kms-key-per-tenant.md) | Encrypt server-side with SSE-KMS and one KMS key per tenant | Accepted | 2026-11-05 |
| [0002](./0002-bind-each-key-to-its-tenant-prefix-in-the-key-policy.md) | Bind each key to its tenant's prefix in the key policy, and keep S3 Bucket Keys off | Accepted | 2026-11-05 |
| [0003](./0003-put-the-tenant-boundary-in-the-identity-policy-of-one-tenant-role-per-function.md) | Put the tenant boundary in the identity policy of one tenant role per function | Accepted | 2026-11-05 |
| [0004](./0004-offer-two-key-tiers-behind-one-contract.md) | Offer two key tiers, vendor-key and tenant-key, behind one contract | Accepted | 2026-11-05 |
| [0005](./0005-fail-closed-on-an-unusable-key-with-a-distinct-class.md) | Fail closed on an unusable key with a distinct KEY_UNAVAILABLE class | Accepted | 2026-11-05 |
| [0006](./0006-make-offboarding-cryptographic.md) | Make offboarding cryptographic | Accepted | 2026-11-05 |
| [0007](./0007-presign-tenant-uploads-from-the-api-under-the-tenant-session.md) | Presign tenant uploads from the API under the tenant session, with the key fixed in signed headers | Accepted | 2026-11-05 |
| [0008](./0008-validate-then-land.md) | Validate, then land, through a quarantine drop prefix | Accepted | 2026-11-05 |
| [0009](./0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md) | Make validation a pluggable chain of deployer-supplied validators behind a carrier-neutral contract | Accepted | 2026-11-05 |
| [0010](./0010-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md) | Drive the pipeline with S3 Object Created, EventBridge, SQS and Lambda, and publish outcomes on a construct-owned bus | Accepted | 2026-11-05 |
| [0011](./0011-keep-one-tenant-partitioned-dynamodb-registry.md) | Keep one tenant-partitioned DynamoDB registry, encrypted with an AWS-owned key | Accepted | 2026-11-05 |
| [0012](./0012-authenticate-tenant-users-with-the-token-contract-and-the-vendor-with-iam.md) | Authenticate tenant users with the token contract through a Lambda authoriser and the vendor with IAM, and register the scopes at deploy | Accepted | 2026-11-05 |
| [0013](./0013-observe-and-attribute-cost-per-tenant.md) | Observe and attribute cost per tenant from log fields, with per-tenant metrics opt-in | Accepted | 2026-11-05 |
| [0014](./0014-deliver-the-pattern-as-a-cdk-construct.md) | Deliver the pattern as the CDK construct TenantEncryptedIngestion, with a thin demo stack | Accepted | 2026-11-05 |
| [0015](./0015-limit-each-tenant-with-a-usage-plan-key-and-an-in-flight-counter.md) | Limit each tenant with a usage plan key and an in-flight counter | Accepted | 2026-11-05 |
| [0016](./0016-make-processing-a-lease-not-a-terminal-state.md) | Make PROCESSING a lease, not a terminal state | Accepted | 2026-11-05 |
| [0017](./0017-write-each-drop-object-once-under-a-key-without-a-file-name.md) | Write each drop object once under a key without a file name | Accepted | 2026-11-05 |

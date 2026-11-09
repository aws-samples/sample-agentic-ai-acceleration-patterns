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
| [0013](./0013-scope-the-base-roles-kms-use-deny-to-tenant-tagged-keys.md) | Scope the base roles' KMS use Deny to tenant-tagged keys | Accepted | 2026-11-06 |
| [0014](./0014-drive-the-integration-test-with-the-cdk-cli-and-read-test-wiring-from-outputs.md) | Drive the integration test with the CDK CLI and read test wiring from outputs | Accepted | 2026-11-06 |
| [0015](./0015-copy-logdrain-and-scoperegistration-from-agentic-runtime-isolation.md) | Copy LogDrain and ScopeRegistration from agentic-runtime-isolation | Accepted | 2026-11-06 |
| [0016](./0016-alarm-on-putkeypolicy-through-eventbridge-and-probe-on-any-403-or-kms-error.md) | Alarm on PutKeyPolicy through EventBridge and probe on any 403 or KMS error | Accepted | 2026-11-06 |
| [0017](./0017-let-the-sweep-publish-and-give-the-key-factory-a-table-wide-registry-grant.md) | Let the sweep publish, and give the key factory a table-wide registry grant | Accepted | 2026-11-06 |
| [0018](./0018-rely-on-the-invoke-timeout-and-the-lease-for-a-hanging-validator.md) | Rely on the invoke timeout and the lease for a hanging validator | Accepted | 2026-11-06 |
| [0019](./0019-accept-access-tokens-from-any-oidc-issuer-and-require-the-deployer-to-name-the-scope-registration.md) | Accept access tokens from any OIDC issuer and require the deployer to name the scope registration | Accepted | 2026-11-09 |
| [0020](./0020-admit-upper-case-tenant-ids.md) | Admit upper-case tenant ids | Accepted | 2026-11-09 |
| [0021](./0021-add-the-owed-status-bucket-and-a-keystatus-index.md) | Add the OWED status bucket and a keyStatus index | Accepted | 2026-11-09 |
| [0022](./0022-shape-the-api-errors-as-built.md) | Shape the API errors as built | Accepted | 2026-11-09 |
| [0023](./0023-prove-the-isolation-walls-with-template-tests-and-integration-assertions.md) | Prove the isolation walls with template tests and integration assertions | Accepted | 2026-11-09 |
| [0024](./0024-ship-re2-wasm-with-every-function-bundle.md) | Ship re2.wasm with every function bundle | Accepted | 2026-11-09 |
| [0025](./0025-retry-api-gateway-control-plane-throttles-in-createtenantkey.md) | Retry API Gateway control-plane throttles in CreateTenantKey | Accepted | 2026-11-09 |

Renumbered 2026-11-05 before implementation; earlier drafts were never merged.

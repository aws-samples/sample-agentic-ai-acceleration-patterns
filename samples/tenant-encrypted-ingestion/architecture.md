<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Tenant Encrypted Ingestion: Architecture

> **Status: implemented and verified by the integration run of 2026-11-06.**
> Last green run: 2026-11-06, eu-central-1, a vendor test account plus a
> second account owning tenant B's `tenant-key` key (cross-account claim
> exercised), about 73 minutes end to end; CloudFormation create 1 min 10 s
> (test aid) and 2 min 17 s (demo stack), delete 3 min 9 s and 1 min 35 s, from
> the stack events of that run (N-4: each under 5 minutes). Coverage: spec §10 steps 1 to 11 (with 7b
> and 7c) and the driver's step 0 prelude all passed; step 12 ran as
> `scripts/integ.sh`'s teardown: both stacks destroyed, no stack with the
> sample's prefix left, only the two `vendor-key` keys left, both
> `PendingDeletion`, and the second account's three test keys scheduled for
> deletion. Unit tests: 289 and growing on 2026-11-06; see the build.
> **Not exercised:** the access-log
> `Requester` check (step 10) is best effort and no access log arrived
> within 3 minutes; `kmsRequests` against CloudTrail is recorded, not
> checked (6 against 19, [§11](#11-observability-and-per-tenant-cost-attribution));
> the standard §6 security scans ran on 2026-11-06 and are dispositioned in the
> [threat model](./threat-model.md#security-review).

This file describes what is deployed. The design trail is the
[specification](./design/tenant-encrypted-ingestion.spec.md), the
[ADRs](./adr/README.md) and the [threat model](./threat-model.md). Where
the code refines the specification, this file states the implemented
behaviour and [§14](#14-known-gaps-and-residuals) lists the refinement.

## 1. Purpose

One drop zone and pipeline serve every tenant, and each tenant's documents
are encrypted with that tenant's own KMS key, enforced by KMS and IAM, not
application code (ADR-0001). A tenant user gets a presigned, write-once PUT
under an opaque key (ADR-0006); S3 encrypts the upload with the tenant's
key; the pipeline validates it under a tenant-scoped session, structural
checks first and then the deployer's validator chain, and only then lands
it under `documents/<tenantId>/` and publishes `DeliveryAccepted`
(ADR-0007, ADR-0008). It is a pool with per-tenant keys: the tenant unit is
the key, the prefix (`ingest/<t>/`, `documents/<t>/`) and the registry
partition (`TENANT#<t>`). Two key tiers share one contract: `vendor-key`
(the vendor's key) and `tenant-key` (a key in the tenant's account the
tenant can withdraw; the pipeline fails closed) (ADR-0004). Offboarding is
cryptographic (ADR-0005). The deliverable is the `TenantEncryptedIngestion`
construct with a demo stack (ADR-0012).

## 2. Actors and identity

- The **vendor** owns every role and calls `/platform/*` with SigV4
  (`AWS_IAM`).
- A **tenant** is a tenant-identity tenant. Its id matches
  `^[A-Za-z0-9][A-Za-z0-9-]{1,34}$` (spec §7.0, so ULIDs pass), checked in
  the authoriser (401), the Smithy path pattern (400), before every
  `AssumeRole`, and on the object key's second segment in the processor.
- A **tenant user** calls `/tenant/*` with a tenant-identity access token
  (5-minute lifetime). The TOKEN authoriser verifies the token contract
  (signature, `iss`, `exp`, `client_id`, `token_use`, `sub`, no `tenants`,
  one valid `tenant_id`), answers every refusal with 401, and passes
  `tenantId`, `sub`, `scope` and the usage key (ADR-0011). The handler
  checks `ingestion/deliver` or `ingestion/read` per route; both scopes are
  registered in tenant-identity's catalogue at deploy.
- The **tenant's account** appears only for `tenant-key`, owning a key
  tagged `TenantId=<t>` whose policy trusts the tenant roles ([§5.2](#52-tenant-key-template)).
- A **consumer** role (`consumerRoles`, deployer-owned) reads
  `documents/<t>/` under its own session tagged with the tenant.
- Seven **base roles** (one per function) and three **tenant roles**
  (assumed with a `TenantId` session tag) carry the work; every call made
  for a tenant is signed by a tenant-role session (ADR-0003). The
  `ScopeRegistration` role, the `LogDrain` role and CDK's singleton
  provider roles ([§3](#3-components)) sit outside the pipeline.

## 3. Components

Every function: Node.js 24, ARM64, esbuild with the SDK bundled, JSON log
format, its own `DESTROY` log group, the role passed in so CDK adds no
managed policy (`src/construct/functions.ts`). Each bundle copies
`re2.wasm` beside `index.js` (an `afterBundling` hook): the Smithy SSDK
validates `@pattern` with re2-wasm, which loads `re2.wasm` from `__dirname`
at init.

| Resource | Role it runs under | Code (under `src/`) |
|---|---|---|
| Ingestion bucket (versioned, EventBridge on) and access-log bucket | - | `construct/bucket.ts`, `bucket-policy.ts`, `access-log-bucket.ts` |
| Tenant keys, created at run time (never a stack resource) | - | `platform/create-tenant-key.ts`, `key-policy.ts` |
| Registry table, two sparse GSIs, stream | - | `construct/registry.ts`, `shared/registry.ts` |
| REST API, stage `v1`; usage plan with `tenantThrottle` | - | `construct/api.ts` |
| `AuthoriserFunction` (10 s) | `authoriserRole` | `authoriser/` |
| `TenantApiFunction` (15 s) | `apiRole` -> `tenantUploadRole` | `api/handler.ts` |
| `KeyFactoryFunction`, `CreateTenantKey` only (30 s) | `keyFactoryRole` -> `tenantPlatformRole` | `platform/handler.ts` |
| `PlatformFunction`, Get/Rotate/Delete (60 s) | `platformRole` -> `tenantPlatformRole` | `platform/handler.ts` |
| `Object Created` rule on the default bus (prefix `ingest/`), target DLQ | - | `construct/events.ts` |
| Queue, DLQ, target DLQ (SSE-SQS, DLQs 14 days) | - | `construct/queues.ts` |
| `ProcessorFunction` (batch 1, timeout T) | `processorRole` -> `tenantProcessRole` | `processor/` |
| Delivery bus | - | `construct/events.ts` |
| `SweepFunction`, hourly (15 min) | `sweepRole` -> `tenantProcessRole` | `sweep/handler.ts` |
| `RegistryWatchFunction`, stream filter `SK = KEY`, on-failure queue | `watchRole` | `registry-watch/handler.ts` |
| `KeyDrainFunction` + `Custom::TenantKeyDrain` | `platformRole` | `platform/drain.ts` |
| `ScopeRegistration` (copied, ADR-0015) | tenant-identity's `PlatformInvokePolicy` less a Deny on `/platform/tenants*` | `shared/scope-registration.*.ts` |
| `LogDrain` (90 s hold on log-group deletion; copied, ADR-0015) | a role with no permissions | `shared/log-drain.ts` |
| Alarms: key binding; `PutKeyPolicy` (rule, audit queue, alarm; ADR-0016) | - | `construct/alarms.ts` |
| Three Contributor Insights rules | - | `construct/observability.ts` |
| Demo validators `pdf-pages`, `test-switch` | own logs-only roles | `../examples/validator-pdf-pages`, `validators/` |

The construct creates none of its dependencies and publishes nothing; the
demo stack publishes the parameters ([§12](#12-deployment-and-teardown)).

## 4. Roles and policies

`${tag}` is `${aws:PrincipalTag/TenantId}`; "assume" is `sts:AssumeRole`
plus `sts:TagSession` on exactly one tenant role (`src/construct/roles.ts`).

### 4.1 Base roles

| Role | Identity policy as built |
|---|---|
| `authoriserRole` | its log group only |
| `apiRole` | assume `tenantUploadRole` |
| `processorRole` | assume `tenantProcessRole`; receive, delete, change visibility on the queue; `events:PutEvents` on the bus; invoke each bound validator; `dynamodb:UpdateItem` with `dynamodb:Attributes` within `[PK, SK, keyStatus, lastKeyCheckAt, updatedAt]` and `ReturnValues NONE` (sets `REVOKED`) |
| `keyFactoryRole` | `kms:CreateKey` with `KeySpec SYMMETRIC_DEFAULT`, `KeyOrigin AWS_KMS`, `KeyUsage ENCRYPT_DECRYPT`, `MultiRegion false`; `kms:TagResource` with `Null aws:RequestTag/TenantId = false` and `aws:TagKeys` within `[TenantId, tei:stack]`; the statement 1 actions of [§5.1](#51-vendor-key-as-built) on this account's keys and tenant aliases; `PutItem`, `UpdateItem`, `ConditionCheckItem`, `GetItem` on the table, no attribute Deny (ADR-0017); assume `tenantPlatformRole`; Deny `PutKeyPolicy`, `CreateGrant`, `UntagResource`; the tenant-key use Deny; with `tenantThrottle`, `apigateway:POST`/`GET` on `/apikeys`, `/usageplans`, `/usageplans/*/keys` |
| `platformRole` | assume `tenantPlatformRole`; the statement 1 actions of [§5.1](#51-vendor-key-as-built) on this account's keys; `ListKeys`; table-wide `GetItem`, `Query`, `Scan`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem`; Deny `UpdateItem` naming `keyArn` or `tier`; Deny `CreateKey`, `TagResource`, `UntagResource`, `PutKeyPolicy`, `CreateGrant`; the tenant-key use Deny; with `tenantThrottle`, `apigateway:DELETE` on `/apikeys/*` |
| `sweepRole` | assume `tenantProcessRole`; `Query` on the GSIs; `GetItem`, `UpdateItem` with the same `keyArn`/`tier` Deny; `events:PutEvents` on the bus (ADR-0017) |
| `watchRole` | read the stream; `PutMetricData` in namespace `TenantEncryptedIngestion`; `UpdateItem` with `LeadingKeys = SYSTEM`; send to its on-failure queue |

The usage plan is found by name at run time: passing its id to the
factory's environment is a CloudFormation cycle.

**The KMS use Deny is scoped to tenant keys.** `keyFactoryRole` and
`platformRole` Deny `kms:Encrypt`, `Decrypt`, `GenerateDataKey*`,
`ReEncrypt*` on `*` with `Null aws:ResourceTag/TenantId = false`, never
unconditioned: Lambda decrypts a function's environment variables with
`kms:Decrypt` under the execution role (the untagged `aws/lambda` key), and
an unconditioned Deny stops the function at init with no log line
(ADR-0013). The other base roles hold no KMS Allow.

### 4.2 Tenant roles

| Role | Trusted by | Identity policy as built |
|---|---|---|
| `tenantUploadRole` | `apiRole` | `s3:PutObject` on `ingest/${tag}/*` with SSE `aws:kms`; `kms:GenerateDataKey`; registry, upload allowlist |
| `tenantProcessRole` | `processorRole`, `sweepRole` | `s3:GetObject`, `DeleteObjectVersion` on `ingest/${tag}/*`; `s3:PutObject` (SSE-KMS) on `ingest/${tag}/_probe/*` and `documents/${tag}/*`; `kms:Decrypt`, `GenerateDataKey`; registry, process allowlist |
| `tenantPlatformRole` | `platformRole`, `keyFactoryRole` | `s3:ListBucket`, `ListBucketVersions` with `s3:prefix` under both tenant prefixes; `DeleteObject`, `DeleteObjectVersion` on both; `GetObject`, `PutObject` (SSE-KMS) on `ingest/${tag}/_probe/*`; `kms:Decrypt`, `GenerateDataKey`; registry `GetItem`, `Query` |

Each KMS use statement is on `arn:aws:kms:<region>:*:key/*` with
`aws:ResourceTag/TenantId = ${tag}` and `kms:ViaService =
s3.<region>.amazonaws.com`, plus `kms:DescribeKey` with the tag alone. The
account is a wildcard because `tenant-key` keys live in the tenant's
account. `aws:ResourceTag/TenantId` evaluates against a KMS key in another
account: verified on 2026-11-05 with a second account and repeated by integ
steps 1 and 8.

**Trust-policy guard.** Each tenant role trusts only its named base roles,
with `ForAllValues:StringEquals aws:TagKeys = [TenantId]`, `Null
aws:RequestTag/TenantId = false` (the first alone holds for an empty tag
set) and `StringNotLike aws:RequestTag/TenantId` on `*/*`, `*:*`, `*=*`,
`*+*`, `*@*`, `*.*`, `* *`, `*,*`; code enforces the grammar itself.
Sessions last 3600 s and are cached per tenant, reused only with the
caller's minimum left (URL TTL + 60 s in the API, T in the processor, 5
minutes in the sweep). `RoleSessionName` is `t-<tenantId>-<suffix>`, the
suffix the last 16 characters of the delivery id or an operation name of
the call that first assumed the cached session; the sweep's is always
`sweep`.

### 4.3 DynamoDB write rules

Each tenant role's `RegistryOwnTenantAllowlisted` statement allows
`UpdateItem`, `ConditionCheckItem`, `GetItem`, `Query` (platform role: the
reads only) with `dynamodb:LeadingKeys = TENANT#${tag}`, its
`dynamodb:Attributes` allowlist and `ReturnValues` in `NONE`,
`UPDATED_OLD`, `UPDATED_NEW`. `ProtectKeyBinding` Denies `dynamodb:*` when
any named attribute is `keyArn`, `tier`, `apiKeyValue` or `keyStatus`
(`apiKeyValue` is on no row: no code can store a usage key value). No
tenant role holds `PutItem`, `DeleteItem` or `Scan`.

| Allowlist | Names |
|---|---|
| upload | `PK SK objectKey fileName declaredContentType declaredSizeBytes status statusBucket urlExpiresAt createdBy createdAt updatedAt inFlight` |
| process | `PK SK status statusBucket leaseOwner leaseUntil sizeBytes sha256 dropEtag dropVersionId landedKey reason reasonMessage validators ttl eventPublishedAt updatedAt inFlight bytesStored deliveriesAccepted deliveriesRejected kmsRequests` |

`updateExpression` (`src/shared/registry.ts`) names every attribute through
a `#name` placeholder, so the name map is exactly what IAM evaluates, and
throws before sending a name outside the role's allowlist. Base-role access
is filtered: `keyFactoryRole` keeps `PutItem` (guarded by
`attribute_not_exists(keyArn)` in code), `platformRole` keeps `DeleteItem`;
the registry watch detects a rebinding ([§9.4](#94-sweep-and-registry-watch))
(ADR-0010).

## 5. Key policies

Pure builders in `src/platform/key-policy.ts`; roles are matched on
`aws:PrincipalArn`; no wildcard action (`kms:Create*` would include
`CreateGrant`) (ADR-0002).

### 5.1 `vendor-key`, as built

`CreateKey` names the four properties, passes the policy with
`BypassPolicyLockoutSafetyCheck = true` (the creating role has no
`PutKeyPolicy`) and the tags `TenantId=<t>` and `tei:stack=<StackId>`;
then `CreateAlias alias/tenant-<t>-ingestion` and `EnableKeyRotation`.

| # | Sid | Statement |
|---|---|---|
| 1 | `AdministrationPlatformRole` | `platformRole`: `DeleteAlias`, `DescribeKey`, `GetKeyRotationStatus`, `RotateKeyOnDemand`, `ListResourceTags`, `GetKeyPolicy`, `ScheduleKeyDeletion`, `CancelKeyDeletion` |
| 1 | `AdministrationKeyFactoryRole` | `keyFactoryRole`: `CreateAlias`, `EnableKeyRotation`, `DescribeKey`, `ScheduleKeyDeletion` |
| 2 | `TenantRolesUseViaS3OnTenantPrefixes` | the tenant roles: `GenerateDataKey`, `Decrypt` with `kms:ViaService` = S3 and `kms:EncryptionContext:aws:s3:arn` like `arn:aws:s3:::<b>/ingest/<t>/*` or `.../documents/<t>/*` |
| 2 | `TenantRolesDescribeKey` | the tenant roles: `DescribeKey`, unconditioned |
| 2b | `ConsumerRolesDecryptLandedDocuments` | each consumer role: `Decrypt` via S3 on `documents/<t>/*`; omitted without consumers |
| 3 | `AccountAdministration` | the account principal: statement 1's actions plus `PutKeyPolicy`; no use action, `CreateGrant` or `TagResource` |
| 4a-i | `DenyUseExceptTenantRoles` | Deny `Encrypt`, `GenerateDataKey*`, `ReEncrypt*`, `CreateGrant` unless a tenant role |
| 4a-ii | `DenyDecryptExceptTenantAndConsumerRoles` | Deny `Decrypt` unless a tenant or consumer role |
| 4b | `DenyUseExceptViaS3` | Deny every use action without `kms:ViaService` = S3 |
| 4c | `DenyUseOutsideTenantPrefixes` | Deny every use action with a context outside the two prefixes |
| 5 | `DenyTagging` | Deny `TagResource`, `UntagResource` |

Verified by spike on 2026-11-05: `CreateKey` with `Tags` is not blocked by
the new key's statement 5; a later `TagResource` is. During `CreateKey`,
`aws:ResourceTag` is populated from the request tags, so the factory's
`TagResource` Allow conditions on `aws:RequestTag` and `aws:TagKeys`, never
on `aws:ResourceTag`. Bucket Keys are off on the bucket, the PUT and the
copy: a bucket key puts the bucket ARN in the context and 4c denies.

### 5.2 `tenant-key` template

`buildTenantKeyTemplate` renders, for a single-Region `SYMMETRIC_DEFAULT`
key in the bucket's Region tagged `TenantId=<t>`: the tenant account
principal's administration (`kms:*`), statement 2 for the three published
tenant role ARNs, `DescribeKey` for them, and statement 2b for the
consumers; never a grant. Admission is implicit: `DescribeKey` returns no
tags, so a `tenantPlatformRole` session for `<t>` being admitted at all
proves the tag (ADR-0004).

## 6. Bucket

**Settings** (`src/construct/bucket.ts`): `BucketOwnerEnforced`, Block
Public Access, TLS only, versioning, default SSE-S3 with Bucket Keys off
(never used), EventBridge notifications, access logs through the log
bucket's policy. Lifecycle on `ingest/`: current objects after
`dropRetentionDays` (default 1), noncurrent versions and incomplete
multipart after 1 day, expired delete markers in a second rule (S3 refuses
it beside an expiration in days); on `documents/`: noncurrent versions
after 7 days.

**Policy** (`src/construct/bucket-policy.ts`), every statement a Deny to
`*`: no TLS (`enforceSSL`); `DenyPutWithoutSseKms`;
`DenyDropWithoutIfNoneMatch` on `ingest/*` (write once, no multipart
there); `DenyDropNonStandardStorageClass`; `DenyDropWebsiteRedirect`;
`DenyOldSignatures` (`s3:signatureAge` above `max(uploadUrlTtlSeconds,
validatorObjectUrlTtlSeconds)`); `DenyDropWriteExceptTenantRoles` (the
three); `DenyDocumentWriteExceptProcessRole`;
`DenyDropDeleteExceptProcessPlatformAutoDelete`;
`DenyDocumentDeleteExceptPlatformAutoDelete`. The auto-delete exemption
names the singleton role of
`Custom::S3AutoDeleteObjectsCustomResourceProvider`, which CDK makes
depend on this policy; without it `cdk destroy` could not empty the bucket.

**KMS answers before the bucket policy.** S3 asks KMS for the data key
before it evaluates the bucket policy, so a `PutObject` naming a tenant key
by a principal the key policy does not admit is refused by KMS (4a-i), not
by the principal-scoped bucket Deny. The bucket Deny is observed with the
AWS managed `aws/s3` key: in step 5, `TestProbeRole` naming A's key was
refused by KMS, and naming `aws/s3` on `ingest/<A>/` and `documents/<A>/`
by S3.

**A broken key is a 400.** S3 returns 400 `KMS.DisabledException` for a
disabled key and 400 `KMS.KMSInvalidStateException` for a key pending
deletion; a removed key-policy statement is a 403 `AccessDenied` (steps 8
and 11).

**Access-log bucket**: SSE-S3, TLS only, objects expire after
`dropRetentionDays + 30`, and `DenyReadExceptAccessLogReader` Denies
`GetObject`/`GetObjectVersion` unless `accessLogReaderRole`: the logs hold
presigned query strings.

## 7. Data model

One table: on demand, PITR (35 days), stream `NEW_AND_OLD_IMAGES`, TTL on
`ttl`, AWS-owned key. Key and delivery rows share a partition and are kept
apart by attribute name; a unit test asserts the schemas share only `PK`,
`SK`, `createdAt`, `updatedAt` (ADR-0010).

| Item | Key | Attributes |
|---|---|---|
| Tenant key | `TENANT#<t>` / `KEY` | `tier`, `keyArn`, `keyAlias`, `keyStatus`, `apiKeyId` (the id, never the value), counters `inFlight`, `bytesStored`, `deliveriesAccepted`, `deliveriesRejected`, `kmsRequests` (0 at create), `createdAt`, `updatedAt`, `lastKeyCheckAt` |
| Binding | `KEYARN#<keyArn>` / `KEY` | `boundTenantId`, `createdAt`; written with the key row in one transaction, so a key never serves two tenants |
| Delivery | `TENANT#<t>` / `DELIVERY#<ulid>` | `objectKey`, `landedKey`, `fileName`, declared type and size, `sizeBytes`, `sha256`, `dropEtag`, `dropVersionId`, `status`, `statusBucket`, `urlExpiresAt`, `ttl`, `eventPublishedAt`, `reason`, `reasonMessage`, `validators`, `leaseOwner`, `leaseUntil`, `createdBy`, timestamps |
| Tombstone | `SYSTEM` / `TOMBSTONE#<t>` | `removedAt`, `reinsertedAt`, `ttl` 7 days |

- `keyStatus`: `CREATING -> ACTIVE <-> REVOKED`, and `-> DELETING`.
- `status`: `AWAITING_UPLOAD -> PROCESSING -> ACCEPTED | REJECTED |
  KEY_UNAVAILABLE`, or `AWAITING_UPLOAD -> EXPIRED`. `PROCESSING` is a
  lease: `leaseOwner` the SQS message id, `leaseUntil` now + T (epoch ms).
- `urlExpiresAt`: epoch seconds, `min(now + TTL, session expiry)`. `ttl`:
  30 days on, on `EXPIRED`, `REJECTED` and `KEY_UNAVAILABLE` rows only.
- `statusBucket`: `OPEN` while open; `OWED` on a terminal row whose event
  is not yet on the bus, removed when `eventPublishedAt` is set; `EXPIRED`
  publishes no event and drops it at once.
- GSI `statusBucket-urlExpiresAt`: open and owed rows. GSI `keyStatus`: key
  rows only (no delivery row carries `keyStatus`), so the sweep finds
  `REVOKED` and `ACTIVE` keys without `Scan`.
- `CreateDelivery` creates the row (`attribute_not_exists(PK)`) and adds 1
  to `inFlight` in one transaction conditioned on `inFlight <
  maxInFlightPerTenant`; every terminal transition subtracts it in the same
  transaction as the status write.

## 8. API

Smithy (`model/`: `IngestionPlatformService` with resource `TenantKey`,
`IngestionTenantService` with resource `Delivery`), the TypeScript SSDK in
each handler. REST, Regional, stage `v1`, stage throttle 100 rps / burst
200, authoriser cache 300 s, data tracing off.

| Operation | Route | Statuses |
|---|---|---|
| `CreateTenantKey` | `POST /platform/tenants/{tenantId}/key` | 201; 409 row or binding exists; 422 `KeyNotUsable` (key in the vendor account, untagged, tagged for another tenant, another tenant's key); 400 `UnsupportedInDeployment` |
| `GetTenantKey` | `GET .../key` | 200, `keyStatus` refreshed by the probe for an `ACTIVE` or `REVOKED` row, returned as stored for `CREATING` or `DELETING`; 404 without a row |
| `RotateTenantKey` | `POST .../key/rotate` | 200 `vendor-key`; 400 `UnsupportedInTier`; 404 without a row; 409 not `ACTIVE`, limit reached or rotation in progress |
| `DeleteTenantKey` | `DELETE .../key` | 202; 204 when absent |
| `CreateDelivery` | `POST /tenant/deliveries` | 201 `{deliveryId, uploadUrl, headers, expiresAt}`; 400; 403 `Forbidden` without the scope; 409 `TenantKeyUnavailable` (key missing or not `ACTIVE`); 429 `TooManyDeliveries` |
| `GetDelivery` | `GET /tenant/deliveries/{deliveryId}` | 200; 404 outside the caller's tenant |
| `ListDeliveries` | `GET /tenant/deliveries?status=&nextToken=` | 200, newest first, 50 per page; `nextToken` must name the caller's partition |

Every status above was observed in the run except 400
`UnsupportedInDeployment`, the 409s of `RotateTenantKey`, the 404 of
`GetDelivery` and `ListDeliveries`, which the unit tests cover
(`test/platform.test.ts`, `test/api.test.ts`).

**CreateTenantKey.** A `CREATING` row and `KEYARN#` are written in one
transaction, the key is probed through S3 under a `tenantPlatformRole`
session (four attempts while a new tag propagates), the API key is created
with `tenantThrottle`, and the row flips to `ACTIVE` conditionally; a
repeat finishes a `CREATING` row. A `vendor-key` key whose binding failed
is scheduled for deletion at once. A `tenant-key` ARN must be a key ARN
(no alias, no bare id), in the bucket's Region and not in the vendor's
account; `DescribeKey` under the tenant session must be admitted and
report the canonical ARN, `SYMMETRIC_DEFAULT`, `Enabled`, single-Region.
The tag check runs before the binding, so another tenant's key is 422.

**DeleteTenantKey**, each step idempotent: `keyStatus = DELETING`; delete
the API key; delete every version and delete marker under both prefixes
under the tenant session; for `vendor-key` delete the alias and schedule
the key (`keyDeletionWindowDays`); delete the row and `KEYARN#` in one
transaction. **GetTenantKey** probes: a KMS-sourced failure moves `ACTIVE`
to `REVOKED`, success moves `REVOKED` to `ACTIVE`, anything else changes
nothing, conditional on the status read.

**Error model.** Every error is `{code, message, requestId}`:
`ValidationError`, `UnsupportedInTier`, `UnsupportedInDeployment` (400),
`Forbidden` (403), `NotFound` (404), `Conflict`, `TenantKeyUnavailable`
(409), `KeyNotUsable` (422), `TooManyDeliveries` (429), `InternalError`
(500). Messages are fixed strings: no `tenantId` in a `/tenant/*` error, no
key ARN, no echoed input (`src/api/errors.ts`).

**Usage-plan key** (N-8, ADR-0011). With `tenantThrottle`: `apiKeySource:
AUTHORIZER`, `apiKeyRequired` on every `/tenant/*` method, a usage plan on
the stage, and one API key per tenant whose value is deterministic,
`tei-<hex(sha256(stackId + tenantId))[0:40]>`. The authoriser computes it
from the verified claim as `usageIdentifierKey`, so it reads no table and
no row stores it. `inFlight` applies with or without the plan.

**Presigned PUT** (`src/shared/presign.ts`): a `tenantUploadRole` session
signs `PUT ingest/<t>/<deliveryId>` with six signed headers (SSE `aws:kms`,
the key id, bucket key `false`, `If-None-Match: *`, `Content-Length`,
`Content-Type`), the three `x-amz-*` unhoistable. Step 4 saw 403 for each
changed header, `SignatureDoesNotMatch` for an edited path and 412 for a
second PUT.

## 9. Pipeline

### 9.1 Steps as coded

`src/processor/handler.ts`, one message per invocation (ADR-0007,
ADR-0009):

0. The tenant is the key's second segment only; a key failing the grammar,
   with no ULID delivery id, or with `_probe` as third segment is dropped.
1. Assume `tenantProcessRole` for `<t>` before reading anything.
2. Delivery and key row, `ConsistentRead`. Missing, or `DELETING`: delete
   the drop version, stop. Terminal: delete leftover versions, publish an
   owed event, stop. `AWAITING_UPLOAD`, or own or expired lease: lease.
   Another live lease: stop.
3. `HeadObject` (`dropEtag`, `dropVersionId`): `KEY_MISMATCH` unless
   SSE-KMS with the registry `keyArn` and no bucket key; `STORAGE_CLASS`;
   `TOO_LARGE`; `SIZE_MISMATCH`.
4. `GetObject IfMatch dropEtag`, one stream: magic bytes, the ZIP central
   directory (no ZIP64, at most 10,000 entries, no escaping path, bounded
   expansion), sha256.
5. The validator chain ([§10](#10-validator-chain)).
6. `CopyObject` to `documents/<t>/<d>`, `CopySourceIfMatch`, metadata
   `REPLACE` (`Content-Type`, `Content-Disposition` with the file name),
   SSE-KMS with `keyArn`, bucket key off. A missed pin is `OBJECT_CHANGED`.
7. Flip: one transaction writes the terminal status, `statusBucket OWED`,
   the results and `ttl` (unless accepted) on `leaseOwner`, with the key
   row's counters (`inFlight - 1`, `kmsRequests`, accepted or rejected).
8. Delete exactly `dropVersionId`.
9. `PutEvents`, then `eventPublishedAt`, `REMOVE statusBucket`.

The drop is written once, every read and the copy are pinned to the ETag
`HeadObject` returned, and the exact version read is deleted. The order is
copy, flip, delete version, publish: a crash after the copy leaves a lease
the next receive re-takes (same ETag); a crash after the flip leaves an
`OWED` row that step 2 or the sweep finishes. The `leaseOwner` condition
keeps two processors from landing one delivery.

**Lease and timing.** T = 60 s + the declared validator timeouts + 60 s,
at most 900 s or synth fails (`src/construct/pipeline.ts`); the demo's T is
210 s. Visibility `visibilityTimeoutFactor x T`; the DLQ after
`maxReceiveCount` receives.

### 9.2 Classifier and probe

Every S3 call at steps 3 to 8 goes through `guardS3`
(`src/processor/probe.ts`). The probe runs on a 403 or `AccessDenied` and
on any error whose code or message names KMS (`kms:` or `KMS.`), since a
disabled or pending-deletion key is a 400 from S3 (ADR-0016). The classifier matches
the KMS code in the message; the probe through S3 confirms, under the same
session: `PutObject` of `ingest/<t>/_probe/<ulid>` with the registry key,
`GetObject`, delete that version (`src/shared/probe.ts`). A KMS-sourced
probe failure: `KEY_UNAVAILABLE` with the KMS error as `reason`, drop
version deleted, `DeliveryKeyUnavailable` published, `processorRole` sets
`REVOKED`, message deleted (no DLQ retry). A probe success or another
failure rethrows the original error, so a pipeline fault never marks a
tenant `REVOKED` (ADR-0004). Step 8: a key disabled mid-delivery gave
`KMS.DisabledException`, a removed use statement `AccessDenied`; both
`REVOKED`, DLQ unchanged.

### 9.3 Queue and bus policies

- Queue: Deny `SendMessage` unless `aws:SourceArn` is the rule or
  `aws:PrincipalArn` is `redriveOperatorRole`.
- DLQ: Deny `SendMessage` unless `aws:SourceArn` is the queue. SQS's own
  move meets it (step 7b), and a redrive by the operator worked.
- Bus: Deny `PutEvents` unless `processorRole` or `sweepRole` (ADR-0017). Readers are
  filtered: any rule in the vendor account sees every tenant's events.
- Event detail is `{tenantId, deliveryId, landedKey?, sizeBytes?,
  contentType?, reason?}` through an allowlist: no file name, key ARN or
  URL. At least once.

### 9.4 Sweep and registry watch

**Sweep**, hourly (`src/sweep/handler.ts`), S3 and delivery-row writes
under a `tenantProcessRole` session:

1. `AWAITING_UPLOAD` rows past `urlExpiresAt + abandonGraceSeconds` with
   no drop: `EXPIRED`, `inFlight - 1`, no event. The process role has
   no `ListBucket`, so a HEAD of a missing key is 403; here 403 means
   absent, like 404.
2. `PROCESSING` with `leaseUntil` older than `maxReceiveCount x visibility
   + abandonGraceSeconds`: `REJECTED structural:PROCESSING_ABANDONED`, drop
   version deleted, event published.
3. `OWED` rows untouched for 5 minutes: publish, set `eventPublishedAt`.
4. `REVOKED` keys: probe; `ACTIVE` only on success.
5. `inFlight` reconciled to the open-row count, conditional on the value
   read; a key row touched in the last 5 minutes waits for the next run.

**Registry watch** (`src/registry-watch/handler.ts`, filter `SK = KEY`,
which also passes `KEYARN#` items, skipped in code): a `MODIFY` changing
`keyArn` or `tier` alarms; `REMOVE` writes the tombstone; `INSERT` while a
tombstone exists alarms. The alarm is a `KeyBindingChanged` data point and
a WARN line; images are never logged (ADR-0010). Step 11 wrote the
tombstone and the alarm stayed `OK`.

## 10. Validator chain

`LambdaValidator(fn, {name, timeout})` (`src/validators/lambda-validator.ts`)
grants the processor `lambda:InvokeFunction` and `fn` nothing; `name` is
`[a-z0-9-]{1,32}`, unique, not `structural`; `timeout` at most 10 minutes
(ADR-0008). Per validator, in order (`src/processor/validators.ts`):

- a GET presigned by the `tenantProcessRole` session with `If-Match`
  signed, valid `validatorObjectUrlTtlSeconds` (default 300);
- one synchronous invoke under `processorRole`: `{version, tenantId,
  deliveryId, fileName, contentType, sizeBytes, sha256, objectUrl, etag,
  objectUrlExpiresAt, previous}`;
- a verdict of exactly `ACCEPT`, or `REJECT` with `code` `[A-Z0-9_]{1,40}`
  and `message` up to 500 characters (`src/processor/verdict.ts`); anything
  else or a `FunctionError` is a validator error;
- the first `REJECT` stops the chain (`<name>:<code>`). A validator error
  throws; on the last receive the delivery is first `REJECTED
  <name>:VALIDATOR_ERROR`, so the DLQ copy is an audit record;
- one log line per call; never the URL, body or error message.

The processor does not abort a validator at its declared timeout; the
declared timeout feeds T (ADR-0018). A validator past it meets its own function
timeout (an error) or the processor's, which leaves the lease to the next
receive or the sweep (step 7c: `test-switch` declares 60 s and may run 5
minutes). Step 7b: a 5-page PDF was `pdf-pages:TOO_MANY_PAGES` without
invoking `test-switch`; mode `throw` was `test-switch:VALIDATOR_ERROR`
with the message in the DLQ.

## 11. Observability and per-tenant cost attribution

**Log fields** (`src/shared/logger.ts`): one JSON line, top-level fields
from an allowlist; other fields, and strings that look like a URL, SigV4
parameter or credential, are dropped. Every line has `tenantId` (`-` when
about no tenant). The processor writes one `delivery processed` line per
delivery it terminates. The API
access log has `requestId`, `httpMethod`, `resourcePath`, `status`,
`tenantId` (from the authoriser), `caller`, `latency`. Steps 7b and 10: no
line in the nine log groups held `X-Amz-Signature` or a test file name; the
processor line carried `tenantId`, `status`, `sizeBytes`, `kmsRequests`.

**Contributor Insights**, three rules (all `ENABLED` in the run), cost
independent of tenant count: `<addr>-tei-top-deliveries` (processor,
`tenantId` and `status`, count), `<addr>-tei-top-bytes` (processor,
accepted `sizeBytes` summed by `tenantId`), `<addr>-tei-top-requests` (API
access log, `/tenant/deliveries` by `tenantId` and `status`).

**EMF, opt-in** (`perTenantMetrics`, default off): one record per delivery
in `TenantEncryptedIngestion` with dimensions `TenantId`, `Status` and
`Deliveries`, `DeliveryBytes`, `KmsRequests`, `DeliveryDuration`. Off by
default: a dimension per tenant is a custom metric per tenant.

**RoleSessionName** `t-<tenantId>-...` names the tenant in CloudTrail and
S3 access logs without a join. **TenantId cost allocation tag**: every
`vendor-key` key carries it, so the key-month splits by tenant once the tag
is activated; `tenant-key` keys bill to the tenant's account.

**Registry counters** are the per-tenant figures: `bytesStored`,
`deliveriesAccepted`, `deliveriesRejected`, `kmsRequests`, the last
metered as four plus one per validator for an accepted delivery (PUT,
structural read, one per validator GET, two for the copy;
`src/shared/metering.ts`).

**Known gap: `kmsRequests` does not match CloudTrail.** For one accepted
delivery with two validators the processor metered 6; CloudTrail held 19
KMS events for the processor session. The breakdown of the 19 has not been
done (the driver's note names the probe and S3's own retries as
candidates). The attribution formula for KMS is pending until the
accounting is reconciled. The other drivers are per tenant: `bytesStored`
(S3 storage), deliveries (Lambda, SQS, EventBridge, DynamoDB), `/tenant`
requests (API Gateway). The sweep, the watch, Contributor Insights and log
storage carry no tenant and are apportioned by deliveries.

## 12. Deployment and teardown

**Demo stack** `TenantEncryptedIngestion` (`src/demo.cdk.ts`): cdk-nag on
the app; tenant-identity's pool and API read at deploy from
`/application-plane/shared/identity/`; validators `pdf-pages` (limit 3)
and `test-switch` (mode in SSM); roles, tiers and timings from context. A
placeholder build carries a CloudFormation rule that refuses to deploy.

**Published parameters** under `/application-plane/shared/ingestion/`:
`apiUrl`, `bucketName`, `tenantRoleArns` (`upload,process,platform`),
`consumerRoleArns` (or `none`), `eventBusArn`, `accessLogBucketName`.

**Drain** (`Custom::TenantKeyDrain`, ADR-0005): the API and the factory,
platform, processor and sweep functions depend on it, so CloudFormation
removes them first. On Delete, under `platformRole`, it schedules every
registered `vendor-key` key and, as a backstop, any key with this stack's
`tei:stack` tag the registry no longer knows; `tenant-key` keys are never
touched; it always answers `SUCCESS`. The run's teardown left only keys
`PendingDeletion`.

**Auto-delete exemption** ([§6](#6-bucket)) and **log drain**: writers ->
`LogDrain` (waits 90 s) -> log groups, so late deliveries land before
their groups go.

**Test-aid stack** (`TenantEncryptedIngestionTestAid`): `TestProbeRole`
(KMS use on `*`, Denies on policy, grant and tag changes, so any denial
comes from a key or bucket policy), `TestConsumerRole`, a scratch bucket
and key from the same builders with a mistaken Allow for the probe role,
and the capture queue, redrive and access-log reader roles.

## 13. Integration test

`scripts/integ.sh` with `test/integ/app.ts` and `test/integ.ingestion.ts`,
driven by the CDK CLI; the driver reads the test's own stacks' outputs from
`--outputs-file` as test-only wiring, standing for the construct
properties a consumer reads in its own CDK code (ADR-0014):

1. **Account guard**: refuses an account without the `tei:test-account`
   Organizations tag or the SSM parameter
   `/tenant-encrypted-ingestion/test-account = true` (a member account
   cannot read its own tags). The run passed on the parameter.
2. **Fixture rule**: the tenant-identity shared pool is a long-lived fixture
   of the test account; the script reuses it, deploys it only when absent,
   and never destroys it.
3. Deploys the test-aid stack and `TenantEncryptedIngestionInteg` with the
   test profile (`maxReceiveCount 1`, `visibilityTimeoutFactor 2`,
   `abandonGraceSeconds 60`, `uploadUrlTtlSeconds 120`,
   `maxInFlightPerTenant 5`, `tenantThrottle`), and with
   `TEI_TENANT_KEY_PROFILE` a second account for `tenant-key`.
4. Runs the steps 0 (prelude: tenants A, B, D) to 11, named as spec §10;
   step 8 changes B's key in the second account. Before it exits, the
   driver deletes the tenants step 0 created in the shared pool
   (`DELETE /platform/tenants/{tenantId}`) and names any it could not
   delete; the pool itself stays.
5. Teardown (step 12) from the EXIT trap: `cdk destroy --all`, then fail on
   any stack with the prefix or tagged key not `PendingDeletion`.

**Lifetimes.** Access tokens live 5 minutes and several steps wait longer,
so a 401 on a run-issued token re-issues it and retries once. Sessions are
3600 s. After a key policy or tag change the driver waits up to 5 minutes.
**Runtime** about 73 minutes (spec target 60 to 90); the dollar cost was
not measured (spec target under $2).

## 14. Known gaps and residuals

The design's residuals are the threat model's
[accepted risks](./threat-model.md#accepted-risks) (plaintext behind TLS,
compromised code acting as one tenant, key-factory binding, the
administrator's `PutKeyPolicy`, presigned URIs in access logs, and more).

Open:

- **`kmsRequests` against CloudTrail** (6 against 19); KMS attribution
  pending ([§11](#11-observability-and-per-tenant-cost-attribution)).
- **Access-log `Requester`** not observed within 3 minutes (best effort).
- **Offboarding at API Gateway**: spec step 11 expects 403 (API key gone);
  the run saw 409 `TenantKeyUnavailable` from the handler. Why API Gateway
  still admitted the request was not established; the tenant is refused
  either way.
- **`PutKeyPolicy` alarm** needs CloudTrail management events on
  EventBridge in the account (ADR-0016).
- **IAM Access Analyzer check of the key policy** (spec §7.2): the unit
  test running `check-no-new-access` against a baseline holding every Deny
  is not implemented, since it calls an AWS API. The template tests in
  `test/key-policy.test.ts` and integ step 5 on the scratch key are the
  control (ADR-0002 note, threat model M-17).

Refinements of the specification, implemented as described above:

- `statusBucket = OWED` and the sweep's owed-event pass; the `keyStatus`
  GSI; `boundTenantId` on `KEYARN#`.
- `sweepRole` holds `events:PutEvents` and is exempt from the bus Deny;
  `keyFactoryRole` holds `GetItem`, a table-wide registry grant (spec:
  `KEY`, `KEYARN#`, `SYSTEM` items) and the API Gateway routes (ADR-0017).
- The probe also runs on an error naming KMS (ADR-0016); the sweep reads a
  HEAD 403 as absent, since `tenantProcessRole` has no `ListBucket`; the
  usage plan is found by name; the processor does not abort a validator at
  its declared timeout (ADR-0018).
- `RotateTenantKey` is 404 without a row and 409 when the key is not
  `ACTIVE` or a rotation is in progress; `GetTenantKey` is 404 without a
  row and returns a `CREATING` or `DELETING` row unprobed.
- `RoleSessionName`'s suffix names the call that first assumed the cached
  session, not every call made with it; the sweep's is `sweep`.
- `TestProbeRole` holds `GetObject` and `PutObject` on every sample bucket
  (spec §10's test-aid bullet: Get only on the ingestion bucket), because
  step 5 needs its PUT to the ingestion bucket refused by the bucket
  policy, not by its own identity policy.
- The integration test is driven by the CDK CLI and reads the test's own
  stack outputs (ADR-0014); `LogDrain` and `ScopeRegistration` are copies
  of agentic-runtime-isolation's (ADR-0015).
- Another tenant's `keyArn` is 422 (spec step 1: 409); a disabled or
  pending-deletion key is an S3 400 (spec steps 8, 11: 403).
- `Forbidden` is a code §5.3 lacks; `RotationLimitReached` is a 409
  `Conflict` message, not a code.
- The `PutKeyPolicy` alarm is an EventBridge rule plus `TriggeredRules`,
  not a CloudTrail metric filter.
- The integration profile's `uploadUrlTtlSeconds` is 120, not 60.

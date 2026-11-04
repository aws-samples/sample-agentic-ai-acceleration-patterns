# Specification: Per-Tenant Encrypted Ingestion for Agentic Applications

> **Status:** Draft, 2026-11-04. This document is the *requirements and
> principles* layer of the tenant-encrypted-ingestion sample: it states what a
> correct implementation must do and why, without prescribing every
> implementation detail. An implementer (human or LLM) should be able to build
> a functionally equivalent sample from this spec alone. Where a requirement is
> a deliberate design position rather than an obvious necessity, the reasoning
> is given inline; the spec is also a teaching document.

The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

---

## 1. Problem statement

Agentic applications are fed with tenant documents: contracts, loan files,
case packages, knowledge bases. A tenant drops files; the application
validates them and makes them available to the agents and extraction
pipelines that act on that tenant's behalf. The documents are the most
sensitive data the application holds, and every tenant shares one drop zone
and one pipeline.

This sample demonstrates **per-tenant encryption of a shared ingestion path
with AWS KMS**, where the boundary between tenants is enforced by KMS and IAM,
not by application code:

- Every tenant has **its own KMS key**. Every object a tenant delivers, and
  every object the pipeline derives from it, is encrypted with that key and
  no other.
- The key is bound to the tenant's prefix **by the key's own policy**: the
  key refuses to encrypt or decrypt an object outside
  `<prefix>/<tenantId>/` (§7.1). A key that leaks cannot be used on another
  tenant's objects, and another tenant's key cannot be used on this one's.
- The pipeline works under **tenant-scoped credentials** (ABAC with a
  `TenantId` session tag) that reach only the one tenant's prefix and the one
  tenant's key. A bug in the pipeline cannot read across tenants because AWS
  refuses the call.
- Two **key tiers** sit behind one contract. `vendor-key`: the vendor creates
  and owns the key, with automatic rotation on. `tenant-key`: the tenant brings
  its own key from its own AWS account, grants the pipeline's role the use of
  it, and can revoke that grant at any time; the pipeline fails closed.
- **Offboarding is cryptographic.** Deleting a tenant schedules its key for
  deletion; every object encrypted with it becomes unreadable, whether or not
  the object delete has completed.

The sample ships the pattern as a CDK construct, `TenantEncryptedIngestion`,
plus a thin demo stack, an integration test that proves the boundary from
both sides, and a demo script.

### 1.1 Deployment model

**Pool with per-tenant keys.** One bucket, one API, one event pipeline, one
registry table serve every tenant; the tenant unit is the KMS key, the S3
prefix and the registry partition. In the repository's vocabulary
(`ARCHITECTURE.md` §3) this is a pool at the infrastructure layer with
**enforced** isolation at the data layer: the key policy and the ABAC session
policy are the wall; the code only chooses which side of it to stand on.

The sample does not silo: a tenant that needs its own bucket or pipeline
takes the construct into its own stack, which is why the construct is the
deliverable (standard §4.5).

### 1.2 What this sample is NOT

- **Not a transfer endpoint.** No SFTP, no AWS Transfer Family, no browser
  upload page. Tenants upload with a presigned S3 URL the API hands out
  (§5.2). A transfer endpoint is an extension seam (§11).
- **Not client-side encryption.** The sample encrypts server-side (SSE-KMS).
  S3 and the pipeline see plaintext in flight behind TLS; the risk is named
  in the threat model, and a sealed-drop tier (client-side envelope with an
  asymmetric KMS key) is an extension seam (§11), not built.
- **Not OpenPGP.** No PGP keys, no `.gpg` deliveries, no third-party crypto
  library. What a PGP drop gives (one key per tenant, rotation, revocation,
  a scoped blast radius) the sample gets from KMS natively.
- **Not document understanding.** No extraction, classification, OCR, or
  model calls. The pipeline validates and lands; it publishes a
  `DeliveryAccepted` event that a later sample (rule-set-driven extraction
  with a reviewer gate) consumes.
- **Not malware scanning.** Validation is structural (size, type, magic
  bytes, archive sanity). A scanner is an extension seam.
- **Not identity.** Tenant users authenticate with `tenant-identity`; the
  sample verifies its token contract and never issues tokens.
- **Not a control plane.** Tenant keys are created through this sample's
  platform API, which a control-plane tenant create script calls (§6.4).
- **Not multi-Region.** One bucket in one Region; replication is out of
  scope.

### 1.3 Comparison the sample must make visible

The README MUST show, side by side, what each tier gives and costs:

| | `vendor-key` | `tenant-key` |
|---|---|---|
| Key owner | vendor account | tenant account |
| Who can revoke | vendor (offboarding) | tenant, at any time |
| Rotation | KMS automatic (yearly) plus on demand | tenant's own |
| Tenant needs an AWS account | no | yes |
| Onboarding steps for the tenant | none | create key, tag it, set key policy, hand over ARN |
| Pipeline failure when the key is gone | n/a | fails closed, `KEY_UNAVAILABLE` |
| Cost to the vendor | $1 per key-month plus requests | requests only |
| Cost to the tenant | none | $1 per key-month |

---

## 2. Guiding principles

### P-1. The key is bound to the tenant, and the binding is enforced by KMS

A tenant key MUST be usable only on objects under that tenant's prefixes.
The binding lives in the key policy as an encryption-context condition
(§7.1), so it holds for every caller, including the vendor's own
administrators and a pipeline bug. Rules in: key policy conditions on
`kms:EncryptionContext:aws:s3:arn`; S3 Bucket Keys off, because a bucket key
replaces the object ARN in the context with the bucket ARN and the binding
is lost. Rules out: a bucket policy that names tenants one by one (it hits
the 20 KB limit at a few hundred tenants and is filtered, not enforced).

### P-2. Code chooses the tenant; AWS enforces it

Every call the pipeline makes on a tenant's behalf MUST be signed with
credentials that carry a `TenantId` session tag and a session policy that
reaches only `<prefix>/${aws:PrincipalTag/TenantId}/*` and keys whose
`TenantId` resource tag matches. The tenant id the code uses MUST come from a
verified source: the access token on the API, the object key prefix the
presigner fixed on the pipeline. A tenant id from a request body, a header,
or an object's own metadata is never trusted.

### P-3. Everything a tenant delivers is encrypted with that tenant's key

The bucket MUST refuse an object that is not SSE-KMS (bucket policy deny on
`s3:x-amz-server-side-encryption != aws:kms`). The presigned URL MUST fix the
key id in the signed headers, so the uploader cannot change it. The pipeline
MUST re-check the key on every object it processes (`HeadObject`
`SSEKMSKeyId` equals the registry's key for the prefix) and reject a
mismatch; P-1 makes the mismatch impossible to create, the check makes it
visible if it ever is.

### P-4. One contract, two key tiers

The tier is a tenant attribute, not a deployment choice. The pipeline, the
API and the data model MUST be identical across tiers; only `CreateTenantKey`
and `DeleteTenantKey` branch, and `RotateTenantKey` is `UnsupportedInTier` for
`tenant-key`. A consumer of the construct sees one `keyArn` per tenant and
does not care who owns it.

### P-5. Fail closed, and say why

When a tenant's key cannot be used (revoked grant, disabled key, pending
deletion), the pipeline MUST stop processing that tenant's deliveries, record
the distinct failure class `KEY_UNAVAILABLE` on the delivery and `REVOKED` on
the key record, and MUST NOT retry into the dead-letter queue as if the
failure were transient. A corrupt file is `REJECTED`; a missing key is not a
corrupt file.

### P-6. Offboarding is cryptographic and total

`DeleteTenantKey` MUST, for `vendor-key`, delete the alias, schedule the key
for deletion with the shortest window KMS allows (7 days) and remove the
tenant's objects; for `tenant-key`, remove the registry binding and the
tenant's objects. After it returns, no new object can land under the prefix
(the registry row is gone, so the API presigns nothing) and the pipeline
drops events for that prefix.

### P-7. The tenant cannot write outside its own prefix

A presigned URL names exactly one object key under
`ingest/<tenantId>/<deliveryId>/`, chosen by the vendor. It is signed with
tenant-scoped credentials (P-2), so even a forged URL for another prefix
fails the signature's own session policy. The tenant never holds AWS
credentials of the vendor's account.

### P-8. Least privilege as role asymmetry

The API role may presign and write registry rows but cannot read objects.
The pipeline role may read the drop prefix and write the documents prefix
but cannot create or delete keys. The key-management role may call KMS
`CreateKey`, `ScheduleKeyDeletion` and `RotateKeyOnDemand` but holds no S3
permission. Each role is assumed into tenant-scoped sessions (P-2); the base
roles alone reach no tenant object.

### P-9. Say what each tenant costs, and show it per tenant

Keys are dedicated resources and carry a `TenantId` cost allocation tag. S3
storage and KMS requests are pooled, so the pipeline MUST meter per tenant
what drives them: bytes accepted, bytes stored (cumulative on the registry
row), deliveries, KMS requests (two per delivery: one `GenerateDataKey` on
the upload, one `Decrypt` plus one `GenerateDataKey` on the copy). The
`tenantId` is a field in every structured log line and access log; per-tenant
metrics are derivable from those fields with Contributor Insights, and
optionally emitted as EMF (`perTenantMetrics`, off by default because custom
metrics scale with tenants times metrics).

### P-10. Validate, then land; never land, then validate

A delivery MUST reach the `documents/` prefix only after it passed every
check (size, type, magic bytes, archive sanity, key match). The drop prefix
is a quarantine with a one-day lifecycle; a rejected object is deleted at
once. Downstream consumers subscribe to `DeliveryAccepted` and never read
`ingest/`.

---

## 3. System shape

### 3.1 Components

| Component | Service | Role |
|---|---|---|
| Ingestion bucket | Amazon S3 | prefixes `ingest/<tenantId>/` (drop, 1-day lifecycle) and `documents/<tenantId>/` (landed). Versioning off, Bucket Keys off (P-1), access logs on, TLS-only and SSE-KMS-only bucket policy |
| Tenant keys | AWS KMS | one symmetric key per `vendor-key` tenant, alias `alias/tenant-<tenantId>-ingestion`, tag `TenantId`, automatic rotation on; `tenant-key` tenants register a key ARN in their own account |
| Registry | Amazon DynamoDB | tenant key rows and delivery rows, tenant-partitioned (§4) |
| Ingestion API | API Gateway REST + Lambda | `/platform/*` (IAM, vendor) and `/tenant/*` (token authoriser, tenant users), modelled in Smithy |
| Token authoriser | Lambda | verifies the `tenant-identity` token contract (`ARCHITECTURE.md` §2.1) and passes `tenantId`, `sub` to the integration |
| Pipeline | EventBridge, SQS (+ DLQ), Lambda | S3 `Object Created` on `ingest/` -> queue -> processor; validates, copies to `documents/`, writes the delivery row, publishes `DeliveryAccepted` or `DeliveryRejected` on the sample's event bus |
| Token vending | AWS STS | API and processor assume a tenant role with a `TenantId` session tag and a session policy (P-2) |
| Observability | CloudWatch Logs, Contributor Insights, optional EMF | `tenantId` field everywhere; top-tenant rules for deliveries, bytes, rejections, key failures |

### 3.2 Caller and identity model

- A **tenant user** holds an access token from `tenant-identity` with
  `tenant_id`, `sub`, `client_id`, `scope`. It calls `/tenant/*`. The
  authoriser verifies issuer, client, expiry, `token_use`, and refuses a
  token still carrying `tenants`. The scope `ingestion/deliver` is required
  for `CreateDelivery`; `ingestion/read` for `GetDelivery` and
  `ListDeliveries`. The sample registers both scopes in `tenant-identity`'s
  catalogue at deploy (its `PutScope`), the way `agentic-runtime-isolation`
  registers backend scopes.
- The **vendor** calls `/platform/*` with IAM (SigV4). A control-plane
  tenant create script is the expected caller (§6.4).
- The **tenant's AWS account** appears only in the `tenant-key` tier, as the
  owner of a key whose policy trusts the construct's `ingestionRole`. It
  never calls the API.
- **S3** calls KMS on the caller's behalf (`kms:ViaService`); the caller is
  always a tenant-scoped session.

### 3.3 Deployment inputs (construct props)

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `identity.discoveryUrl` | string | required | OIDC discovery URL of the token issuer |
| `identity.allowedClientIds` | string[] | required, non-empty | `client_id` values accepted |
| `identityApi` | `{ apiUrl, platformInvokePolicyArn }` | read from `/application-plane/shared/identity/*` at deploy | where to register the two scopes; by value when the deployer does not use `tenant-identity` |
| `allowTenantKeys` | boolean | `false` | enables the `tenant-key` tier on `CreateTenantKey`; off, the tier is `UnsupportedInDeployment` |
| `keyRotation` | boolean | `true` | KMS automatic rotation on every `vendor-key` key |
| `keyDeletionWindowDays` | 7..30 | `7` | window passed to `ScheduleKeyDeletion` |
| `maxObjectSizeBytes` | number | `104857600` (100 MiB) | a larger delivery is `REJECTED: TOO_LARGE` |
| `allowedContentTypes` | string[] | `['application/pdf','application/zip','image/png','image/jpeg','image/tiff']` | checked against the declared type and the magic bytes |
| `uploadUrlTtlSeconds` | 60..3600 | `900` | presigned URL lifetime |
| `dropRetentionDays` | 1..7 | `1` | lifecycle on `ingest/` |
| `perTenantMetrics` | boolean | `false` | emit EMF per tenant in addition to the structured log fields (P-9) |
| `logRetention` | `logs.RetentionDays` | one month | every log group |

Props are validated in the constructor; a bad value fails synth with a
message naming the prop. The demo stack reads its context (`identityParams`
prefix) and fails fast when it is missing.

### 3.4 Read-only properties

`bucket`, `apiUrl`, `ingestionRole` (the role every `tenant-key` key policy
must trust), `eventBus`, `registryTable`, `tenantRole` (the ABAC role both
functions assume), `keyManagementRole`.

---

## 4. Data model

One DynamoDB table, tenant-partitioned (`PK = TENANT#<tenantId>`), on-demand,
PITR on, encrypted with an AWS-owned key (the table holds identifiers and
status, never document content).

### 4.1 Tenant key

| Attribute | Value |
|---|---|
| `PK` / `SK` | `TENANT#<tenantId>` / `KEY` |
| `tier` | `vendor-key` \| `tenant-key` |
| `keyArn` | the key the prefix is bound to |
| `keyAlias` | `alias/tenant-<tenantId>-ingestion` (`vendor-key` only) |
| `status` | `CREATING` -> `ACTIVE` -> `DELETING`; `ACTIVE` <-> `REVOKED` (`tenant-key` only) |
| `bytesStored`, `deliveriesAccepted`, `deliveriesRejected` | counters the processor increments (P-9) |
| `createdAt`, `updatedAt`, `lastKeyCheckAt` | ISO timestamps |

The row is written `CREATING` before the key exists and flipped to `ACTIVE`
by a conditional update, so a failed create leaves a row the operator can
see and a retry can finish (the same shape as tenant-identity ADR-0021).

### 4.2 Delivery

| Attribute | Value |
|---|---|
| `PK` / `SK` | `TENANT#<tenantId>` / `DELIVERY#<deliveryId>` (`deliveryId` a ULID, so `ListDeliveries` pages newest first) |
| `objectKey` | `ingest/<tenantId>/<deliveryId>/<fileName>` |
| `landedKey` | `documents/<tenantId>/<deliveryId>/<fileName>` once `ACCEPTED` |
| `declaredContentType`, `declaredSizeBytes` | from `CreateDelivery` |
| `sizeBytes`, `sha256` | measured by the processor |
| `status` | `AWAITING_UPLOAD` -> `PROCESSING` -> `ACCEPTED` \| `REJECTED` \| `KEY_UNAVAILABLE`; `AWAITING_UPLOAD` -> `EXPIRED` when the URL lifetime passes with no object |
| `reason` | on `REJECTED`: `TOO_LARGE`, `TYPE_MISMATCH`, `UNSUPPORTED_TYPE`, `BAD_ARCHIVE`, `KEY_MISMATCH`; on `KEY_UNAVAILABLE`: the KMS error code |
| `createdBy` | `sub` of the requesting user (an id, never user data) |
| `expiresAt` | TTL for `AWAITING_UPLOAD`/`EXPIRED`/`REJECTED` rows (30 days); `ACCEPTED` rows have no TTL |

Transitions are conditional writes on the current status; a late duplicate
event for an already `ACCEPTED` delivery is a no-op.

---

## 5. API surface

Modelled in Smithy with the `StandardOperationVerb` validator (standard
§4.2). Two resources: `TenantKey` under `/platform`, `Delivery` under
`/tenant`.

### 5.1 Platform operations (`/platform`, IAM)

| Operation | Route | Result |
|---|---|---|
| `CreateTenantKey` | `POST /platform/tenants/{tenantId}/key` `{tier, keyArn?}` | 201 with the key row. `vendor-key`: creates the key, alias, tags, policy (§7.1), enables rotation. `tenant-key`: requires `keyArn`; verifies the key under a tenant-scoped session (`DescribeKey`, `GenerateDataKey` with a probe context, `Decrypt` of the result), so the row is `ACTIVE` only if the pipeline will actually be able to use the key. 400 `UnsupportedInDeployment` when `allowTenantKeys` is off; 409 if a row exists; 422 `KeyNotUsable` with the KMS error when the probe fails |
| `GetTenantKey` | `GET /platform/tenants/{tenantId}/key` | 200; refreshes `status` with a `DescribeKey` (`REVOKED` if the key is disabled, pending deletion, or the grant is gone), `lastKeyCheckAt` |
| `RotateTenantKey` | `POST /platform/tenants/{tenantId}/key/rotate` | 200; `vendor-key`: KMS `RotateKeyOnDemand` (the alias and ARN do not change; old material stays for decrypt). `tenant-key`: 400 `UnsupportedInTier` |
| `DeleteTenantKey` | `DELETE /platform/tenants/{tenantId}/key` | 202; sets `DELETING`, deletes the tenant's objects under both prefixes, then `vendor-key`: deletes the alias and schedules key deletion; `tenant-key`: nothing on the key. Removes the row last. Idempotent on a missing row (204) |

The vendor-key rotation story is native: automatic rotation keeps the ARN,
the alias and every old backing key, so no object is ever re-encrypted and
no `{current, previous}` bookkeeping exists.

### 5.2 Tenant operations (`/tenant`, token authoriser)

| Operation | Route | Result |
|---|---|---|
| `CreateDelivery` | `POST /tenant/deliveries` `{fileName, contentType, sizeBytes}` | 201 `{deliveryId, uploadUrl, headers, expiresAt}`. 400 on a type not in `allowedContentTypes` or a size over `maxObjectSizeBytes` (the cheap checks happen before the upload). 409 `TenantKeyUnavailable` when the key row is not `ACTIVE`. The URL is a presigned `PUT` signed under the tenant-scoped session with `x-amz-server-side-encryption: aws:kms` and `x-amz-server-side-encryption-aws-kms-key-id: <keyArn>` in the signed headers; `headers` repeats them so a client knows what to send |
| `GetDelivery` | `GET /tenant/deliveries/{deliveryId}` | 200 the row; 404 if the row is not under the caller's tenant |
| `ListDeliveries` | `GET /tenant/deliveries?status=&nextToken=` | 200, newest first, the caller's tenant only (the partition key *is* the caller's tenant: there is no cross-tenant query to write) |

No tenant operation downloads a document: the sample lands documents for
agents and pipelines, not for people. A download route is an extension seam.

### 5.3 Error model

`{code, message, requestId}`; `tenantId` never appears in an error body from
`/tenant/*` (the caller knows it) and never a key ARN of another tenant.
Codes: `ValidationError`, `NotFound`, `Conflict`, `UnsupportedInTier`,
`UnsupportedInDeployment`, `KeyNotUsable`, `TenantKeyUnavailable`,
`InternalError`.

### 5.4 Events

The construct owns an EventBridge bus. The processor publishes
`source: tenant-encrypted-ingestion`, `detail-type: DeliveryAccepted |
DeliveryRejected | DeliveryKeyUnavailable`, with `detail: {tenantId,
deliveryId, landedKey?, keyArn, sizeBytes?, contentType?, reason?}`. A
consumer that reads `landedKey` MUST do so under its own tenant-scoped
credentials; the event carries no presigned URL.

---

## 6. Contracts

### 6.1 What the deployer supplies

- An OIDC issuer whose access tokens meet `ARCHITECTURE.md` §2.1 (the demo
  uses `tenant-identity`, `shared-pool`).
- Credentials with `execute-api:Invoke` on `/platform/*` for whoever onboards
  tenants.
- For a `tenant-key` tenant: a symmetric KMS key in the tenant's account,
  tagged `TenantId=<tenantId>`, whose key policy grants the construct's
  `ingestionRole` `kms:DescribeKey`, `kms:GenerateDataKey`, `kms:Decrypt`
  with `kms:ViaService: s3.<region>.amazonaws.com` and
  `kms:EncryptionContext:aws:s3:arn` like `arn:aws:s3:::<bucket>/*/<tenantId>/*`.
  The README gives the policy verbatim with placeholders; `CreateTenantKey`
  proves it works before the row goes `ACTIVE`.

### 6.2 What the sample promises

- No object under `<prefix>/<tenantId>/` is ever encrypted with a key other
  than that tenant's, and that tenant's key never encrypts or decrypts an
  object elsewhere (P-1, P-3). The integration test proves both directions
  (§10).
- No code path in the sample can read tenant B's object while acting for
  tenant A, because the session policy and the key policy both refuse
  (P-2). The integration test proves it by trying (§10).
- `CreateDelivery` for tenant A can only produce a URL that writes under
  `ingest/A/` with A's key (P-7).
- A revoked or deleted `tenant-key` key stops the pipeline for that tenant
  within one delivery, with `KEY_UNAVAILABLE` on the delivery and `REVOKED`
  on the key row (P-5); nothing is retried into the DLQ for that cause.
- `DeleteTenantKey` leaves no readable object and no alias; the key is
  pending deletion for `keyDeletionWindowDays` and costs nothing meanwhile
  (P-6).
- Clean teardown: `cdk destroy` leaves no bucket, table, API, bus, queue,
  role, alias, parameter, or log group with the sample's prefix. Keys
  created by tenants the test did not delete are scheduled for deletion by a
  registry drain on stack delete (as tenant-identity ADR-0022); pending
  deletion is the best KMS allows and is documented.
- Per-tenant observability and cost attribution per P-9.

### 6.3 Published interface

Construct `TenantEncryptedIngestion` from `src/index.ts`, props §3.3,
properties §3.4. The demo stack publishes under
`/application-plane/shared/ingestion/`:

| Parameter | Value |
|---|---|
| `apiUrl` | the REST API base URL |
| `bucketName` | the ingestion bucket |
| `ingestionRoleArn` | the role a `tenant-key` key policy trusts |
| `eventBusArn` | where `Delivery*` events are published |

A tenant's `keyArn` is not a shared parameter; a consumer calls
`GetTenantKey` or reads the `Delivery*` event.

### 6.4 Composition (standard §1.1)

**Consumes** `tenant-identity` `shared-pool`: `/application-plane/shared/identity/{userPoolId, appClientId}`
to build `identity.discoveryUrl` and `allowedClientIds` in the demo stack, and
`{apiUrl, platformInvokePolicyArn}` to register the scopes `ingestion/deliver`
and `ingestion/read` through `PUT /platform/scopes/{scope}` at deploy, the way
`agentic-runtime-isolation`'s `AgentBackend` does. Only the demo app and the
integration driver read the parameters; the construct takes the issuer as
props.

**Consumed by** (planned): a control-plane tenant create script that calls
`CreateTenantKey` and writes `keyArn` into `/application-plane/tenants/<tenantId>`;
the extraction sample, which subscribes to `DeliveryAccepted` and reads
`landedKey` under its own tenant-scoped credentials; `agentic-runtime-isolation`,
whose TVM session policy can grant an agent `s3:GetObject` on
`documents/${aws:PrincipalTag/TenantId}/*` plus `kms:Decrypt` on keys tagged
with the same `TenantId`, so an agent reads only its tenant's documents.

---

## 7. Isolation mechanics (normative detail)

### 7.1 Key policy of a `vendor-key` key

Three statements:

1. **Key administration** for the `keyManagementRole`: `kms:Create*`,
   `kms:Describe*`, `kms:Enable*`, `kms:Put*`, `kms:Update*`, `kms:Revoke*`,
   `kms:Disable*`, `kms:Get*`, `kms:Delete*`, `kms:TagResource`,
   `kms:ScheduleKeyDeletion`, `kms:CancelKeyDeletion`, `kms:RotateKeyOnDemand`.
   No `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey*`.
2. **Use via S3, bound to the prefix** for the `tenantRole`:
   `kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey`, condition
   `kms:ViaService = s3.<region>.amazonaws.com` **and**
   `kms:EncryptionContext:aws:s3:arn` `StringLike`
   `arn:aws:s3:::<bucket>/ingest/<tenantId>/*` or
   `arn:aws:s3:::<bucket>/documents/<tenantId>/*`.
3. **No root bypass of the binding.** The account root keeps
   `kms:*` so the key can never become unmanageable (KMS requires a
   manageable key), but the README states that administrators use the key
   only through statement 1 and the threat model names root as the
   residual trust.

S3 Bucket Keys MUST stay off on the bucket: with a bucket key the
encryption context is the bucket ARN and statement 2 cannot see the prefix.
The cost is one KMS request per object write and per object read, stated in
the README.

### 7.2 Session policy of the tenant-scoped session

The API and the processor assume `tenantRole` with
`Tags: [{TenantId: <tenantId>}]` and a session policy that only ever uses
`${aws:PrincipalTag/TenantId}`:

- `s3:PutObject` (API, for presigning) on `arn:aws:s3:::<bucket>/ingest/${aws:PrincipalTag/TenantId}/*`,
  condition `s3:x-amz-server-side-encryption = aws:kms`.
- `s3:GetObject`, `s3:DeleteObject` on `ingest/${aws:PrincipalTag/TenantId}/*`
  and `s3:PutObject` on `documents/${aws:PrincipalTag/TenantId}/*` (processor).
- `kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey` on `*` with
  `aws:ResourceTag/TenantId = ${aws:PrincipalTag/TenantId}` and
  `kms:ViaService = s3.<region>.amazonaws.com`. The resource-tag condition is
  what makes the `tenant-key` tier work without naming the tenant's account:
  the tenant tags its key, the vendor's session reaches only keys tagged with
  its own tenant, and the key policy on the tenant side only trusts
  `ingestionRole`. Both sides have to agree for a call to succeed.
- `dynamodb:*Item`, `dynamodb:Query` on the table with
  `dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/TenantId}`.

The trust policy of `tenantRole` allows `sts:AssumeRole` and `sts:TagSession`
only from the two function roles, and `sts:TagSession` only for the key
`TenantId` (the caller cannot add tags the policy does not expect).

### 7.3 Where the tenant id comes from

| Path | Source | Why it is trusted |
|---|---|---|
| `/tenant/*` | `tenant_id` claim | signed by the issuer, verified by the authoriser |
| processor | the second path segment of the object key | only a presigned URL from the API can write under `ingest/`, and the API fixes the key under the token's tenant (P-7); the processor cross-checks against the delivery row before it does anything else |
| `/platform/*` | path parameter | vendor-only, IAM-authenticated; the vendor is trusted to name tenants |

---

## 8. Pipeline

```
tenant PUT (presigned) ──► s3://<bucket>/ingest/<tenantId>/<deliveryId>/<file>
   └─ Object Created ──► EventBridge rule (prefix ingest/) ──► SQS (+ DLQ, 3 receives)
        ──► processor Lambda
              1. tenantId, deliveryId from the key; load the delivery row (must be AWAITING_UPLOAD)
              2. assume tenantRole {TenantId}
              3. HeadObject: SSEKMSKeyId == key row's keyArn, else REJECTED KEY_MISMATCH
                 size <= max, else REJECTED TOO_LARGE
              4. GetObject (streamed): magic bytes vs declared type; ZIP central directory sane
              5. CopyObject -> documents/<tenantId>/<deliveryId>/<file>, SSE-KMS same key
              6. DeleteObject on the drop; row -> ACCEPTED (conditional); counters; event
   KMS AccessDenied / DisabledException / KMSInvalidStateException at 3-5
              -> row KEY_UNAVAILABLE, key row REVOKED, event, message deleted (no retry)
   any other error -> throw (SQS retry, then DLQ)
```

Idempotency: the `AWAITING_UPLOAD -> PROCESSING` transition is a conditional
write; a second event for the same object sees `PROCESSING` or a terminal
state and exits. A delivery whose URL expired with no object is flipped to
`EXPIRED` by a scheduled sweep (hourly, `status = AWAITING_UPLOAD and
expiresAt < now`) so the tenant's list is honest.

---

## 9. Non-functional requirements

- **N-1 Latency.** `CreateDelivery` p50 under 300 ms (one `AssumeRole`, one
  conditional put, one presign). A 100 MiB delivery is accepted within 60 s
  of the upload completing.
- **N-2 Throughput.** 1,000 deliveries per minute across tenants with no
  design change: the queue absorbs bursts; KMS symmetric request quota
  (5,500 to 50,000 rps per account depending on Region) is two orders above
  the three calls per delivery.
- **N-3 Scale.** 10,000 tenants: 10,000 keys (KMS default quota 100,000
  per account and Region), one bucket, one table. No per-tenant policy, no
  per-tenant statement, no per-tenant stack.
- **N-4 Deploy and destroy time.** Construct deploys in under 5 minutes;
  `CreateTenantKey` returns in under 3 s; `cdk destroy` completes in under 5
  minutes. Keys pending deletion are the one thing that survives, by KMS
  design and at no cost.
- **N-5 Cost of an idle tenant.** $1 per month (`vendor-key`), $0
  (`tenant-key`), stated in the README with the per-delivery request cost.
- **N-6 No plaintext at rest, anywhere.** Drop, landed objects, SQS
  messages (no content, only keys), logs (no content, no presigned URLs).

---

## 10. Acceptance criteria (integration test outline)

The integration test is the reference implementation (standard §5.2). CDK
CLI driver (`scripts/integ.sh`), one Region, stacks: `tenant-identity`
(`shared-pool`, deployed through its own path or reused if detected), the
demo stack. Steps, in README order:

1. **Two tenants, two tiers.** `CreateTenantKey A vendor-key`;
   create a second KMS key in the test account tagged `TenantId=B` with the
   §6.1 key policy trusting `ingestionRole` (same-account stand-in for a
   tenant account, stated in the README), `CreateTenantKey B tenant-key
   keyArn`. Both `ACTIVE`. `CreateTenantKey B tenant-key` with a key missing
   the tag -> 422 `KeyNotUsable`.
2. **Register users.** Two tenant users via `tenant-identity`, tokens with
   `ingestion/deliver ingestion/read`.
3. **Happy path, both tiers.** `CreateDelivery` for A and B, upload a
   synthetic PDF with the returned headers, poll `GetDelivery` to
   `ACCEPTED`; `HeadObject` on `landedKey` shows the tenant's key; a
   `DeliveryAccepted` event arrived on the bus.
4. **The uploader cannot change the key.** PUT to A's URL with
   `x-amz-server-side-encryption-aws-kms-key-id` set to B's key -> 403
   (signature mismatch). PUT with no SSE header -> 403.
5. **Key binding, both directions.** With the test's own credentials
   (which hold `kms:GenerateDataKey` on A's key by key policy statement 2
   only via the `tenantRole`), attempt `PutObject` to `ingest/B/x` with A's
   key under a session for A -> denied by the session policy; attempt the
   same under a session for B with A's key -> denied by A's key policy
   (`KMS.AccessDeniedException`). Both must fail, and the test asserts the
   error source.
6. **Cross-tenant read.** Under a session for A, `GetObject` B's landed
   object -> `AccessDenied` from S3 (session policy) before KMS is reached.
7. **Rejections.** Declared `application/pdf`, upload a ZIP -> `REJECTED
   TYPE_MISMATCH`; oversize declared -> 400 at `CreateDelivery`; a URL left
   unused past its TTL -> `EXPIRED` after the sweep (the test sets a short
   TTL via context).
8. **Revocation (`tenant-key`).** Disable B's key; `CreateDelivery` B,
   upload -> `KEY_UNAVAILABLE`, key row `REVOKED`, `DeliveryKeyUnavailable`
   event, DLQ empty. Re-enable; `GetTenantKey` -> `ACTIVE`; a new delivery
   succeeds.
9. **Rotation (`vendor-key`).** `RotateTenantKey A` -> 200; the object
   landed in step 3 still reads (`GetObject` under A's session);
   `RotateTenantKey B` -> 400 `UnsupportedInTier`.
10. **Observability.** The processor log group holds one structured line per
    delivery with `tenantId`, `deliveryId`, `status`, `sizeBytes`,
    `kmsRequests`; the access log holds `tenantId`; the Contributor Insights
    rules exist.
11. **Offboarding.** `DeleteTenantKey A` -> 202; objects under both A
    prefixes gone; alias gone; key `PendingDeletion`; `CreateDelivery` with
    A's token -> 409. `DeleteTenantKey B` -> B's key untouched, row gone.
12. **Teardown.** `cdk destroy --all`; nothing with the sample's prefix
    remains except keys pending deletion, which the test lists and reports.

Runtime target: under 25 minutes, under $1 per run.

---

## 11. Extension seams (documented, not built)

- **Sealed drop tier.** An asymmetric KMS key per tenant whose public key the
  tenant uses offline to wrap a data key; the processor unwraps with
  `kms:Decrypt`. Gives a drop S3 never sees in plaintext, at the price of
  tenant-side tooling and a vendor-defined envelope format.
- **Transfer endpoint.** AWS Transfer Family (SFTP) in front of `ingest/`,
  one server, per-tenant users with a session policy identical to §7.2.
- **Malware scan** between step 4 and step 5 of the pipeline.
- **Download route** on `/tenant/*` returning a presigned `GET` under the
  tenant session.
- **Bulk offboarding.** `DeleteTenantKey` deletes objects inline; a tenant
  with millions of objects needs S3 Batch Operations or a lifecycle rule
  filtered on the prefix.
- **Control-plane mount.** `scripts/control-plane/` tenant create and delete
  scripts that call `CreateTenantKey` and `DeleteTenantKey`.

## 12. Reading order for implementers

1. §2 principles, then §7 (the two policies are the sample).
2. §4 and §5, then write the Smithy model.
3. §8, then the processor.
4. §10, then the integration test, step by step in that order.

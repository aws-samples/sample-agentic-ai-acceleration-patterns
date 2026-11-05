# Specification: Per-Tenant Encrypted Ingestion for Agentic Applications

> **Status:** Draft, 2026-11-05. Reviewed three times by independent blind reviewers before implementation; the review history is in [`threat-model.md`](../threat-model.md), appendix A.

This is the *requirements and principles* layer of the
tenant-encrypted-ingestion sample: what a correct implementation must do
and why. An implementer (human or LLM) should be able to build a
functionally equivalent sample from it alone. Where a requirement is a
design position rather than a necessity, the reasoning is inline; the spec
is also a teaching document. MUST, MUST NOT, SHOULD and MAY are as in
RFC 2119.

---

## 1. Problem statement

Agentic applications are fed with tenant documents: contracts, loan files,
case packages, knowledge bases. A tenant drops files; the application
validates them and hands them to the agents and extraction pipelines that
act for that tenant. They are the most sensitive data the application
holds, and every tenant shares one drop zone and one pipeline. Two problems
come with that:

1. **Isolation.** One tenant's documents must never be readable with
   another tenant's key or by code acting for another tenant, and a tenant
   must be able to leave with its documents made unreadable.
2. **Admission.** What counts as an acceptable delivery differs per
   deployment and per tenant (a page limit, a form type, a malware scan, a
   rule a regulated tenant imposes). The vendor cannot know these checks in
   advance, and a check that reads a document must run inside the
   pipeline's isolation, not with broad access of its own. The pipeline
   needs a **validation chain the deployer extends** without touching its
   code or permissions.

The sample demonstrates **per-tenant encryption of a shared ingestion path
with AWS KMS**, enforced by KMS and IAM rather than application code, and
**pluggable admission validation** inside that boundary:

- Every tenant has **its own KMS key**; every object it delivers, and every
  object derived from it, is encrypted with that key and no other.
- The **key policy** binds the key to the tenant's prefixes and to the
  pipeline's tenant roles and the deployer's consumer roles (§7.2). A
  leaked key cannot be used on another tenant's objects.
- The pipeline works under **tenant-scoped credentials**: ABAC with a
  `TenantId` session tag, the conditions in the role's own identity policy
  (§7.1). A wrong-tenant bug is refused by AWS. Compromised function code
  can mint a session for any one tenant; the threat model accepts that.
- Two **key tiers**, one contract. `vendor-key`: the vendor owns the key,
  rotation on. `tenant-key`: the tenant brings a key from its own account,
  lets the tenant roles use it, and can withdraw that at any time; the
  pipeline fails closed.
- **Offboarding is cryptographic**: the key is scheduled for deletion and
  every object encrypted with it becomes unreadable.
- **Validation is a chain.** Structural checks first, then every **custom
  validator** the deployer plugged in, each a function in any language or
  account that gets a short-lived, single-object URL signed by the tenant
  session and returns a verdict. A validator holds no AWS permission, so a
  bad one can read one document for a few minutes (P-11). Nothing lands
  until the chain accepts.

The deliverable is a CDK construct, `TenantEncryptedIngestion`, with a
demo stack, an integration test, a demo script and an example validator.

### 1.1 Deployment model

**Pool with per-tenant keys.** One bucket, API, pipeline and registry table
serve every tenant; the tenant unit is the KMS key, the S3 prefix and the
registry partition. In `ARCHITECTURE.md` §3 terms: a pool at the
infrastructure layer with **enforced** isolation at the data layer. Where
the design falls back to **filtered** isolation (the event bus, table-wide
registry access of base roles) it says so in place. A tenant that needs a
silo takes the construct into its own stack (standard §4.5).

### 1.2 What this sample is NOT

- **Not a transfer endpoint.** No SFTP or upload page; tenants PUT to a
  presigned URL (§5.2). Transfer Family is a seam (§11).
- **Not client-side encryption.** SSE-KMS; S3 and the pipeline see
  plaintext behind TLS. A sealed-drop tier is a seam (§11).
- **Not OpenPGP.** KMS gives what a PGP drop would, natively.
- **Not document understanding.** No extraction or model calls; the
  pipeline lands and publishes `DeliveryAccepted` for a later extraction
  sample with a human approval gate.
- **Not malware scanning or content rules.** Built-in checks are
  structural; anything more is a custom validator (§3.5).
- **Not identity.** Users authenticate with `tenant-identity`; the sample
  verifies its token contract.
- **Not a control plane** (§6.4), **not multi-Region**.

### 1.3 Comparison the sample must make visible

The README MUST show side by side:

| | `vendor-key` | `tenant-key` |
|---|---|---|
| Key owner | vendor account | tenant account |
| Who can revoke | vendor (offboarding) | tenant, at any time |
| Rotation | KMS automatic (yearly) plus on demand | tenant's own |
| Tenant needs an AWS account | no | yes |
| Tenant onboarding steps | none | create key, tag it, set key policy, hand over ARN |
| Pipeline failure when the key is gone | n/a | fails closed, `KEY_UNAVAILABLE` |
| Cost to the vendor | $1 per key-month plus requests | requests only |
| Cost to the tenant | none | $1 per key-month |

---

## 2. Guiding principles

### P-1. The key is bound to the tenant, and KMS enforces the binding

A tenant key MUST be usable only on objects under that tenant's prefixes,
and only by the tenant roles and the consumer roles. The binding is a key
policy condition on `kms:EncryptionContext:aws:s3:arn` plus explicit Denies
(§7.2), so it holds against every identity policy in the vendor's account
and every pipeline bug. S3 Bucket Keys stay off on the bucket and every
request: a bucket key puts the bucket ARN in the context and the binding is
lost. The account principal can rewrite the key policy; that call is logged
and alarmed, and it is the residual. Ruled out: a bucket policy naming
tenants one by one (20 KB limit, filtered).

### P-2. Code chooses the tenant; AWS enforces it

Every call made for a tenant MUST be signed with credentials carrying a
`TenantId` session tag, from a role whose **identity policy** reaches only
`<prefix>/${aws:PrincipalTag/TenantId}/*`, keys tagged with that tenant,
and registry items in its partition (§7.1). The wall is in the role, not
in a session policy: a session policy can only narrow, so code that
omitted it would hold the role's full permissions. The tenant id MUST come
from a verified source (§7.6), never a body, a header or object metadata.
The trust policy fixes the tag key, not its value: compromised function
code choosing the value is the accepted residual, bounded by one role per
function and CloudTrail `AssumeRole` events naming the tag.

### P-3. Everything a tenant delivers is encrypted with that tenant's key

The bucket refuses non-SSE-KMS objects and drop writes without
`If-None-Match: *` (§7.4). The presigned URL signs the key id, the
bucket-key flag, the length and `If-None-Match` (§7.5). The processor
re-checks `SSEKMSKeyId` against the registry; P-1 makes a mismatch
impossible to create, the check makes it visible.

### P-4. One contract, two key tiers

The tier is a tenant attribute. Pipeline, API and data model are identical
across tiers; only `CreateTenantKey` and `DeleteTenantKey` branch, and
`RotateTenantKey` is `UnsupportedInTier` for `tenant-key`.

### P-5. Fail closed, and say why

When a tenant's key cannot be used (removed statement, disabled, pending
deletion, deleted), the pipeline MUST record `KEY_UNAVAILABLE` on the
delivery and `keyStatus = REVOKED` on the key row, and MUST NOT retry into
the DLQ. A corrupt file is `REJECTED`; a missing key is not a corrupt file.
S3 reports a key-policy denial as a plain `AccessDenied`, so the pipeline
never classifies by error code: on any 403 from S3 it probes through S3
under the same session (§8). A KMS-sourced probe failure is
`KEY_UNAVAILABLE`; a probe success means the fault is the pipeline's own,
which is thrown and never marks a tenant `REVOKED`. The sweep re-probes
`REVOKED` keys and restores them.

### P-6. Offboarding is cryptographic and total

`DeleteTenantKey` removes every version of the tenant's objects under both
prefixes, the registry row and the `KEYARN#` item; for `vendor-key` it also
deletes the alias and schedules the key for deletion (7 days). The API then
presigns nothing for the tenant. A URL in flight fails on the
pending-deletion key (`vendor-key`) or lands an object the processor
deletes because the row is missing (`tenant-key`); the 1-day
noncurrent-version lifecycle on `ingest/` removes the version. Named, not
hidden: the key pending deletion, and registry backups that keep file
names and hashes (never content) for 35 days.

### P-7. The tenant cannot write outside its own prefix

A presigned URL names one key, `ingest/<tenantId>/<deliveryId>`, chosen by
the vendor (no file name in the key: names leak into CloudTrail, the KMS
context, SQS and access logs; it lives on the row and in
`Content-Disposition`). It is signed by a tenant-scoped session, so a URL
for another prefix fails the signer's identity policy and editing a real
URL's path breaks its signature. It writes once, for the declared size,
until its `X-Amz-Expires`.

### P-8. Least privilege as role asymmetry

Seven base roles reach no document; three tenant roles carry the ABAC wall
and are trusted only by named base roles (§7.1). `authoriserRole` holds no
data permission. The API cannot read an object because no role it can
assume may. The sweep cannot read a landed document; it could overwrite
one, which versioning makes recoverable for 7 days. The bucket policy
repeats the asymmetry from the resource side (§7.4). In the registry,
tenant-role code cannot touch a key row's `keyArn`, `tier` or `keyStatus`,
nor create or delete a row whole (enforced); key-factory code can rewrite a
binding, because its write-once guard is a condition the code chooses
(detected by the registry watch, not prevented). Consumer roles may only
decrypt under `documents/<tenantId>/` via S3.

### P-9. Say what each tenant costs, and show it per tenant

Keys carry a `TenantId` cost allocation tag. Pooled costs are metered per
tenant on what drives them: bytes accepted and stored, deliveries, KMS
requests (four plus one per validator for an accepted delivery). `tenantId`
is in every log line and, via the session name, every access log and
CloudTrail record. Top tenants come from Contributor Insights; full
per-tenant figures from the registry counters and Logs Insights. Rule
cost does not grow with tenants. Per-tenant EMF is optional.

### P-10. Validate, then land; never land, then validate

A delivery reaches `documents/` only after every check passed, and the
bytes that land are the bytes checked: the drop is written once and every
read and the copy are pinned to its ETag (§8). The drop prefix is a
quarantine; a processed drop is removed at once by deleting the exact
version read. Consumers subscribe to `DeliveryAccepted` and never read
`ingest/`.

### P-11. Validation is a chain the deployer extends, behind one contract

Structural checks run first, then each custom validator in order, stopping
at the first `REJECT`. A validator gets a presigned, ETag-pinned,
short-lived `GET` signed by the tenant session and returns a verdict
(§3.5); it never holds AWS credentials. A cross-account validator needs a
resource policy admitting `processorRole`, owned by the deployer. A
validator error is retried and rejects the delivery on the last receive;
it is never read as `ACCEPT`, and only its type is logged. The contract
names no carrier (Lambda today, §11). Ruled out: validator code inside the
processor (it would run under the processor's role) and asynchronous
voting over the bus (a silent voter blocks every delivery).

---

## 3. System shape

### 3.1 Components

| Component | Service | Role |
|---|---|---|
| Ingestion bucket | S3 | `ingest/<tenantId>/` (drop), `documents/<tenantId>/` (landed). Versioning on. `ingest/`: noncurrent versions expire after 1 day, expired delete markers removed, current objects after `dropRetentionDays`, incomplete multipart after 1 day. `documents/`: noncurrent versions after 7 days. Bucket Keys off, policy §7.4, access logs to a separate bucket |
| Tenant keys | KMS | one symmetric key per `vendor-key` tenant, alias `alias/tenant-<tenantId>-ingestion`, tags `TenantId`, `tei:stack`, rotation on; `tenant-key` keys live in the tenant's account |
| Registry | DynamoDB | one table, tenant partitions plus `SYSTEM` (§4); sparse GSI (`statusBucket`, `urlExpiresAt`); TTL `ttl`; a stream |
| Ingestion API | API Gateway REST + Lambda | `/platform/*` (IAM), `/tenant/*` (token authoriser), Smithy |
| Token authoriser | Lambda (`authoriserRole`) | verifies the `tenant-identity` contract (`ARCHITECTURE.md` §2.1) and §7.0; passes `tenantId`, `sub`, `scope`; with `tenantThrottle`, the computed usage key (N-8). Reads no table |
| Platform functions | Lambda (`keyFactoryRole` for `CreateTenantKey`, `platformRole` otherwise and the drain) | key creation is a role of its own |
| Registry watch | Streams + Lambda (`watchRole`) | alarms on a changed binding or a removed tenant reappearing (§7.1) |
| Pipeline | EventBridge, SQS (+ DLQ), Lambda | `Object Created` on `ingest/` -> queue -> processor (§8) -> `Delivery*` events on the sample's bus |
| Custom validators | Lambda (deployer-owned) | §3.5; example `examples/validator-pdf-pages` |
| Consumer roles | IAM (deployer-owned) | read `documents/<tenantId>/` under their own tenant sessions (§7.2) |
| Per-tenant limits | registry, optional usage plan | `inFlight` always; an API key per tenant with `tenantThrottle` (N-8) |
| Sweep | EventBridge schedule + Lambda (`sweepRole`) | hourly: expiry, abandoned leases, `REVOKED` re-probe, `inFlight` reconcile (§8) |
| Observability | CloudWatch Logs, Contributor Insights, optional EMF | `tenantId` everywhere (P-9) |

### 3.2 Caller and identity model

- A **tenant user** holds a `tenant-identity` access token (`tenant_id`,
  `sub`, `client_id`, `scope`). The authoriser checks issuer, client,
  expiry, `token_use`, refuses a token carrying `tenants`, and passes
  `tenantId`, `sub`, `scope`. The **handler** enforces the scope per route:
  `ingestion/deliver` for `CreateDelivery`, `ingestion/read` for the reads.
  Both scopes are registered in `tenant-identity` at deploy (`PutScope`).
- The **vendor** calls `/platform/*` with SigV4, typically from a
  control-plane script (§6.4).
- The **tenant's AWS account** appears only for `tenant-key`, owning a key
  whose policy trusts `tenantRoleArns` and `consumerRoleArns` (§7.3).
- A **consumer** reads landed documents under its own session tagged with
  the tenant.
- **S3** calls KMS for the caller (`kms:ViaService`); the caller is always
  a tenant-scoped session.

### 3.3 Deployment inputs (construct props)

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `identity.discoveryUrl` | string | required | issuer discovery URL |
| `identity.allowedClientIds` | string[] | required | accepted `client_id`s |
| `identityApi` | `{ apiUrl, platformInvokePolicyArn }` | from `/application-plane/shared/identity/*` | where to register scopes |
| `allowTenantKeys` | boolean | `false` | enables `tenant-key` |
| `consumerRoles` | `iam.IRole[]` | `[]` | may decrypt under `documents/<tenantId>/` (statement 2b); fixed at key creation |
| `keyRotation` | boolean | `true` | rotation on `vendor-key` keys |
| `keyDeletionWindowDays` | 7..30 | `7` | deletion window |
| `maxObjectSizeBytes` | number | 100 MiB | larger is `TOO_LARGE` |
| `allowedContentTypes` | string[] | PDF, ZIP, PNG, JPEG, TIFF | declared type and magic bytes |
| `uploadUrlTtlSeconds` | 60..3300 | `900` | URL lifetime, 300 s under the one-hour session |
| `maxInFlightPerTenant` | 1..10000 | `100` | open deliveries per tenant (N-8) |
| `tenantThrottle` | `{ rateLimit, burstLimit }` | off | per-tenant usage plan (N-8) |
| `dropRetentionDays` | 1..7 | `1` | expiry of current drop objects |
| `validators` | `IDeliveryValidator[]` | `[]` | custom validators, in order |
| `validatorObjectUrlTtlSeconds` | 60..900 | `300` | validator `GET` lifetime |
| `maxReceiveCount` | 1..10 | `3` | receives before the DLQ (§8) |
| `visibilityTimeoutFactor` | 2..12 | `6` | visibility timeout in processor timeouts |
| `abandonGraceSeconds` | 60..86400 | `3600` | grace before the sweep abandons or expires |
| `redriveOperatorRole` | `iam.IRole` | none | the queue's one other sender; unset, no redrive (§7.7) |
| `perTenantMetrics` | boolean | `false` | EMF per tenant |
| `logRetention` | `logs.RetentionDays` | one month | every log group |
| `accessLogReaderRole` | `iam.IRole` | none | the access-log bucket's one reader |

Props are validated in the constructor; a bad value fails synth naming the
prop. The demo stack reads its context (`identityParams` prefix, optional
`consumerRoleArns`) and fails fast on a missing value.

### 3.4 Read-only properties

`bucket`, `accessLogBucket`, `apiUrl`, `eventBus`, `registryTable`,
`queue`, `deadLetterQueue`, `processorFunction`, `sweepFunction`,
`tenantRoles` (`{ upload, process, platform }`), `platformRole`,
`keyFactoryRole`, `sweepRole`. The integration test reaches pipeline
internals only through these.

### 3.5 Validator contract

```ts
export interface IDeliveryValidator {
  readonly name: string;            // [a-z0-9-]{1,32}, unique in the chain
  readonly timeout: Duration;       // <= 10 minutes
  bind(scope: Construct, processor: iam.IGrantable): void;   // grant invoke, nothing else
  readonly carrier: 'lambda';
  readonly functionArn: string;
}
```

`LambdaValidator(fn, opts?)` grants the processor `lambda:InvokeFunction`
and `fn` nothing. Request, one per validator per delivery:

```json
{
  "version": "1", "tenantId": "a1b2c3", "deliveryId": "01JBX...",
  "fileName": "case-4711.pdf", "contentType": "application/pdf",
  "sizeBytes": 1834022, "sha256": "9f86d0...",
  "objectUrl": "https://<bucket>.s3.<region>.amazonaws.com/ingest/a1b2c3/01JBX...?X-Amz-...",
  "etag": "\"9b2cf5...\"", "objectUrlExpiresAt": "2026-11-04T13:05:00Z",
  "previous": [{ "validator": "structural", "verdict": "ACCEPT" }]
}
```

`objectUrl` is a `GET` signed by the `tenantProcessRole` session with
`If-Match` signed: this object, these bytes, until `objectUrlExpiresAt`.
It is never logged, nor is a validator error's body; a validator MUST NOT
persist it. Verdict:

```json
{ "version": "1", "verdict": "ACCEPT" }
{ "version": "1", "verdict": "REJECT", "code": "TOO_MANY_PAGES", "message": "412 pages, limit 300" }
```

`code` is `[A-Z0-9_]{1,40}`, the reason `<name>:<code>`; `message` is
stored and returned and MUST NOT contain document content. A
schema-invalid verdict, a function error or a timeout is a **validator
error**: thrown, retried, and on the last receive `<name>:VALIDATOR_ERROR`.
One log line per call: `tenantId`, `deliveryId`, `validator`, `verdict`,
`code`, `durationMs`.

---

## 4. Data model

One DynamoDB table, `PK = TENANT#<tenantId>`, on-demand, PITR on (35
days, P-6), a stream with `NEW_AND_OLD_IMAGES`, TTL on `ttl`, AWS-owned
key (identifiers and status only). Key rows and delivery rows share each
tenant partition and IAM has no sort-key condition key, so they are kept
apart by **attribute name**: the key row's protected attributes (`keyArn`,
`tier`, `keyStatus`) appear on no delivery row, and each tenant role may
write only an allowlist (§7.1). A unit test asserts the two row schemas
share no name outside the allowlists.

### 4.1 Tenant key (`SK = KEY`)

| Attribute | Value |
|---|---|
| `tier` | `vendor-key` \| `tenant-key`. Protected |
| `keyArn` | canonical ARN (`DescribeKey().KeyMetadata.Arn`); an alias ARN, bare id, other-Region key, or for `tenant-key` a key in the vendor's account is rejected. Written once by `keyFactoryRole` (`PutItem`, `attribute_not_exists(keyArn)`). Protected |
| `keyAlias` | `alias/tenant-<tenantId>-ingestion` (`vendor-key`) |
| `keyStatus` | `CREATING` -> `ACTIVE` -> `DELETING`; `ACTIVE` <-> `REVOKED` (`tenant-key`, set and cleared by the probe). Protected; base roles only |
| `apiKeyId` | with `tenantThrottle` only; the value is computed, never stored (N-8) |
| `inFlight` | count of the tenant's `OPEN` delivery rows |
| `bytesStored`, `deliveriesAccepted`, `deliveriesRejected`, `kmsRequests` | counters (P-9) |
| `createdAt`, `updatedAt`, `lastKeyCheckAt` | timestamps |

In the same transaction, for **both** tiers, `CreateTenantKey` writes
`PK = KEYARN#<keyArn>`, `SK = KEY`, so one key never serves two tenants.
The row is written `CREATING` and flipped to `ACTIVE` conditionally, so a
failed create leaves a row a retry can finish (as tenant-identity
ADR-0021). The `SYSTEM` partition holds the watch's `TOMBSTONE#<tenantId>`
items (7-day `ttl`).

### 4.2 Delivery (`SK = DELIVERY#<deliveryId>`, a ULID, newest first)

| Attribute | Value |
|---|---|
| `objectKey` | `ingest/<tenantId>/<deliveryId>` |
| `landedKey` | `documents/<tenantId>/<deliveryId>` once `ACCEPTED`, with `Content-Disposition: attachment; filename="<fileName>"` |
| `fileName` | `[A-Za-z0-9._-]{1,128}`; never in a key, log or event |
| `declaredContentType`, `declaredSizeBytes` | from `CreateDelivery` |
| `sizeBytes`, `sha256`, `dropEtag`, `dropVersionId` | from the processor; the ETag pins reads and the copy, the version id names what is deleted |
| `status` | `AWAITING_UPLOAD` -> `PROCESSING` -> `ACCEPTED` \| `REJECTED` \| `KEY_UNAVAILABLE`; `AWAITING_UPLOAD` -> `EXPIRED`. `PROCESSING` is a lease (`leaseOwner` = SQS message id, `leaseUntil`) |
| `statusBucket` | `OPEN` while `AWAITING_UPLOAD` or `PROCESSING`: the GSI partition key. One constant value is one hot GSI partition, well within limits at N-2 rates |
| `urlExpiresAt` | URL expiry; the GSI sort key |
| `ttl` | on `EXPIRED`, `REJECTED`, `KEY_UNAVAILABLE` rows only, 30 days on |
| `eventPublishedAt` | set once the terminal event is on the bus; absent means it is owed |
| `reason`, `reasonMessage` | `structural:` `TOO_LARGE`, `SIZE_MISMATCH`, `TYPE_MISMATCH`, `UNSUPPORTED_TYPE`, `BAD_ARCHIVE`, `KEY_MISMATCH`, `STORAGE_CLASS`, `OBJECT_CHANGED`, `PROCESSING_ABANDONED`; `<validator>:<code>`; `<validator>:VALIDATOR_ERROR`; the KMS error on `KEY_UNAVAILABLE`. The validator's `message` |
| `validators` | `{validator, verdict, code?, durationMs}` in run order |
| `createdBy`, `createdAt`, `updatedAt` | requester `sub`; timestamps |

Transitions are conditional on the current status and, once leased, on
`leaseOwner`. `CreateDelivery` creates the row with `UpdateItem` and
`attribute_not_exists(PK)` and increments `inFlight` in the same
transaction; every open-to-terminal transition decrements it.

---

## 5. API surface

Smithy, `StandardOperationVerb` validator (standard §4.2): `TenantKey`
under `/platform`, `Delivery` under `/tenant`.

### 5.1 Platform operations (`/platform`, IAM)

| Operation | Route | Result |
|---|---|---|
| `CreateTenantKey` | `POST /platform/tenants/{tenantId}/key` `{tier, keyArn?}` | 201, under `keyFactoryRole`. `vendor-key`: key with the §7.2 policy and tags, alias, rotation. `tenant-key`: 422 if the ARN's account is the vendor's; `DescribeKey` under a `tenantPlatformRole` session (admission is the tag check, §7.3; `SYMMETRIC_DEFAULT`, `Enabled`, single-Region, the bucket's Region); then a probe through S3 (`PutObject`, `GetObject`, `DeleteObjectVersion` of `ingest/<tenantId>/_probe/<ulid>`), since the key policy requires `kms:ViaService`. Both: key row and `KEYARN#` in one transaction, `ACTIVE` only if the pipeline can use the key; with `tenantThrottle`, the API key. 400 `UnsupportedInDeployment`; 409 if row or `KEYARN#` exists; 422 `KeyNotUsable` |
| `GetTenantKey` | `GET .../key` | 200; refreshes `keyStatus` with the probe (`DescribeKey` cannot tell a removed use statement from a healthy key) |
| `RotateTenantKey` | `POST .../key/rotate` | `vendor-key`: `RotateKeyOnDemand`, 200, 409 `RotationLimitReached`; `tenant-key`: 400 `UnsupportedInTier` |
| `DeleteTenantKey` | `DELETE .../key` | 202; `keyStatus = DELETING`; with `tenantThrottle`, deletes the API key; deletes every version under both prefixes (`tenantPlatformRole`); `vendor-key`: deletes alias, schedules deletion; removes row and `KEYARN#` in one transaction. 204 if missing |

Automatic rotation keeps ARN, alias and old material; nothing is
re-encrypted.

### 5.2 Tenant operations (`/tenant`, token authoriser)

| Operation | Route | Result |
|---|---|---|
| `CreateDelivery` | `POST /tenant/deliveries` `{fileName, contentType, sizeBytes}` | 201 `{deliveryId, uploadUrl, headers, expiresAt}`; 403 without `ingestion/deliver`; 400 on a bad name, type or size; 409 `TenantKeyUnavailable` when the key row is missing or not `ACTIVE`; 429 `TooManyDeliveries`. A §7.5 PUT under a `tenantUploadRole` session |
| `GetDelivery` | `GET /tenant/deliveries/{deliveryId}` | 200; 404 outside the caller's tenant |
| `ListDeliveries` | `GET /tenant/deliveries?status=&nextToken=` | 200, newest first; the partition key is the caller's tenant |

### 5.3 Error model

`{code, message, requestId}`; no `tenantId` in `/tenant/*` errors, never
another tenant's key ARN. Codes: `ValidationError`, `NotFound`, `Conflict`,
`UnsupportedInTier`, `UnsupportedInDeployment`, `KeyNotUsable`,
`TenantKeyUnavailable`, `TooManyDeliveries`, `InternalError`.

### 5.4 Events

`source: tenant-encrypted-ingestion`, `detail-type: DeliveryAccepted |
DeliveryRejected | DeliveryKeyUnavailable`, `detail: {tenantId,
deliveryId, landedKey?, sizeBytes?, contentType?, reason?}`: no file name,
no key ARN (call `GetTenantKey`), no URL; a consumer reads `landedKey` as a
consumer role under its own tenant session. Delivery is at least once, so
consumers MUST de-duplicate on `deliveryId`. The bus is vendor-side and
**filtered**: its policy controls only who puts events (§7.7), any rule in
the vendor's account sees every tenant's events, and a consumer MUST
filter on `detail.tenantId`.

---

## 6. Contracts

### 6.1 What the deployer supplies

- An OIDC issuer meeting `ARCHITECTURE.md` §2.1 (the demo: `tenant-identity`
  `shared-pool`), and `execute-api:Invoke` on `/platform/*` for onboarding.
- The `consumerRoles`, decided before the first tenant is onboarded.
- Per `tenant-key` tenant: a `SYMMETRIC_DEFAULT` key in its account, tagged
  `TenantId=<tenantId>`, with the §7.3 policy (verbatim in the README).
- Optionally `accessLogReaderRole`, `redriveOperatorRole`, validators.

### 6.2 What the sample promises

- No object under `<prefix>/<tenantId>/` is encrypted with another key, and
  the tenant's key touches nothing elsewhere (P-1, P-3).
- No code path reads B's object while acting for A: identity policy and
  key policy both refuse, each proven alone (§10 steps 5, 6). Compromised
  code acting for B on purpose is outside the promise.
- `CreateDelivery` for A writes only under `ingest/A/` with A's key (P-7).
- A revoked `tenant-key` key stops that tenant within one delivery
  (`KEY_UNAVAILABLE`, `REVOKED`, no DLQ retry); a pipeline fault never
  marks a tenant `REVOKED` (P-5).
- Every delivery reaches a terminal state, published at least once: a
  crashing processor within `maxReceiveCount × visibilityTimeoutFactor × T
  + abandonGraceSeconds` (default 18T plus one hour), a failing validator
  on the last receive (§8).
- Tenant-role code cannot change a binding (enforced); key-factory code
  can, and the watch alarms (detected). A compromised `keyFactoryRole` can
  bind a **new** tenant to a key it chose; the threat model names it.
- One tenant cannot exhaust STS, KMS or Lambda capacity beyond
  `maxInFlightPerTenant` and, when set, `tenantThrottle` (N-8).
- Clean teardown: nothing with the sample's prefix remains. The auto-delete
  provider role is exempt from the bucket's delete Denies (§7.4). A drain
  on stack delete, under `platformRole` and after CloudFormation has
  removed the API and platform functions, schedules every registered
  `vendor-key` key and, as a backstop, lists keys by the `tei:stack` tag
  (`ListKeys`, `ListResourceTags`) and schedules any the registry no longer
  knows (a create in flight when the API went).

### 6.3 Published interface

Construct from `src/index.ts` (props §3.3, properties §3.4). The demo stack
publishes under `/application-plane/shared/ingestion/`: `apiUrl`,
`bucketName`, `tenantRoleArns` (`upload,process,platform`),
`consumerRoleArns` (possibly empty), `eventBusArn`, `accessLogBucketName`.

### 6.4 Composition (standard §1.1)

**Consumes** `tenant-identity` `shared-pool`:
`/application-plane/shared/identity/{userPoolId, appClientId}` for the
issuer props and `{apiUrl, platformInvokePolicyArn}` to register
`ingestion/deliver` and `ingestion/read` via `PUT /platform/scopes/{scope}`
(as `agentic-runtime-isolation`'s `AgentBackend` does). Only the demo app
and the integration driver read the parameters.

**Consumed by** (planned): a control-plane script calling `CreateTenantKey`
and writing `keyArn` to `/application-plane/tenants/<tenantId>`; the
extraction sample, a consumer role on `DeliveryAccepted`;
`agentic-runtime-isolation`, whose tenant role can be a consumer role with
`s3:GetObject` on `documents/${aws:PrincipalTag/TenantId}/*` and
`kms:Decrypt` on keys tagged with the same tenant.

---

## 7. Isolation mechanics (normative detail)

This section is the sample: the ABAC wall in tenant-role identity
policies, a key policy that denies use to everything but named roles via
S3, a bucket policy that names who writes and deletes, a presigned PUT
that writes once.

### 7.0 Tenant id grammar

`^[a-z0-9][a-z0-9-]{1,34}$`, checked wherever a tenant id enters: the
authoriser (401), the Smithy path parameter (400), the processor on the
key's second segment (deleted, no event). It keeps `/` out, so
`ingest/${tag}/*` never nests one tenant in another, and keeps session
names under 64 characters.

### 7.1 Roles and registry write rules

`${tag}` is `${aws:PrincipalTag/TenantId}`; "assume" is `sts:AssumeRole`
plus `sts:TagSession`.

| Role | Assumed by | Identity policy |
|---|---|---|
| `authoriserRole` | token authoriser | logs only |
| `apiRole` | API Lambda | assume `tenantUploadRole` only |
| `processorRole` | processor | assume `tenantProcessRole` only; receive, delete, change visibility on the queue; `events:PutEvents` on the bus; invoke bound validators; `dynamodb:UpdateItem` with `ForAllValues:StringEquals dynamodb:Attributes = [PK, SK, keyStatus, lastKeyCheckAt, updatedAt]`, `ReturnValues NONE` (sets `REVOKED`) |
| `keyFactoryRole` | `CreateTenantKey` | `kms:CreateKey` with `StringEquals` `kms:KeySpec = SYMMETRIC_DEFAULT`, `kms:KeyOrigin = AWS_KMS`, `kms:KeyUsage = ENCRYPT_DECRYPT` and `"Bool": {"kms:MultiRegion": "false"}` (the call passes all four); `kms:TagResource` with `Null aws:RequestTag/TenantId = false` and `ForAllValues:StringEquals aws:TagKeys = [TenantId, tei:stack]`; `kms:CreateAlias`, `EnableKeyRotation`, `DescribeKey`, `ScheduleKeyDeletion` (undo); `dynamodb:PutItem`, `UpdateItem`, `ConditionCheckItem` for `KEY`, `KEYARN#`, `SYSTEM` items; assume `tenantPlatformRole`; Deny `kms:PutKeyPolicy`, `CreateGrant`, `UntagResource`, every use action |
| `platformRole` | other `/platform/*`, drain | assume `tenantPlatformRole`; `kms:DescribeKey`, `DeleteAlias`, `GetKeyRotationStatus`, `RotateKeyOnDemand`, `ListResourceTags`, `GetKeyPolicy`, `ScheduleKeyDeletion`, `CancelKeyDeletion`, `ListKeys`; `apigateway:*` on the plan's keys; table-wide `GetItem`, `Query`, `Scan`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem`, with `UpdateItem` denied on `ForAnyValue:StringEquals dynamodb:Attributes = [keyArn, tier]`; Deny `kms:CreateKey`, `TagResource`, `UntagResource`, `PutKeyPolicy`, `CreateGrant`, every use action |
| `sweepRole` | sweep | assume `tenantProcessRole` only; `Query` on the GSI, `GetItem`, `UpdateItem` with the same Deny |
| `watchRole` | registry watch | `dynamodb:GetRecords`, `GetShardIterator`, `DescribeStream`, `ListStreams` on the stream; `cloudwatch:PutMetricData`; `UpdateItem` with `LeadingKeys = SYSTEM`; send to its on-failure queue |
| `tenantUploadRole` | `apiRole` | `s3:PutObject` on `ingest/${tag}/*` with SSE-KMS; `kms:GenerateDataKey` on `*` with `aws:ResourceTag/TenantId = ${tag}` and `kms:ViaService = s3.<region>.amazonaws.com`; `kms:DescribeKey` with the tag; registry statement with allowlist `PK, SK, objectKey, fileName, declaredContentType, declaredSizeBytes, status, statusBucket, urlExpiresAt, createdBy, createdAt, updatedAt, inFlight` |
| `tenantProcessRole` | `processorRole`, `sweepRole` | `s3:GetObject`, `DeleteObjectVersion` on `ingest/${tag}/*`; `s3:PutObject` with SSE-KMS on `ingest/${tag}/_probe/*` and `documents/${tag}/*`; `kms:Decrypt`, `GenerateDataKey` with tag and ViaService; `DescribeKey` with the tag; registry statement below |
| `tenantPlatformRole` | `platformRole`, `keyFactoryRole` | `s3:ListBucket`, `ListBucketVersions` with `s3:prefix` like `ingest/${tag}/*`, `documents/${tag}/*`; `s3:DeleteObject`, `DeleteObjectVersion` on both; `s3:PutObject`, `GetObject` on `ingest/${tag}/_probe/*`; KMS as the process role; registry `GetItem`, `Query` |

**Trust.** Each tenant role trusts only its named base roles, with
`ForAllValues:StringEquals aws:TagKeys = ["TenantId"]`, `Null
aws:RequestTag/TenantId = false` (the first alone is true for an empty tag
set) and `StringNotLike aws:RequestTag/TenantId` on `*/*`, `*:*`, `*=*`,
`*+*`, `*@*`, `*.*`, `* *`, `*,*` (IAM wildcards cannot express §7.0, which
code enforces). `RoleSessionName` is `t-<tenantId>-<suffix>` (the last 16
characters of the `deliveryId` or an operation name), so S3, CloudTrail
and KMS logs name the tenant without a join.

**Registry write rules.** A tenant role may `UpdateItem`,
`ConditionCheckItem`, `GetItem` and `Query` in its own partition and
nothing else: no `PutItem` or `DeleteItem` (they replace or remove a whole
item, including attributes the request never names), no `Scan`. Writes
name only the role's allowlist and return at most the updated attributes;
an explicit Deny refuses any request naming a protected attribute. Reads
are whole-item, without a projection, which the attribute conditions do
not constrain: the role reads `keyArn` and `keyStatus` and acts on them in
code, and conditions its writes only on allowlisted names. The
`tenantProcessRole` statement:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RegistryOwnTenantAllowlisted",
      "Effect": "Allow",
      "Action": ["dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:<region>:111122223333:table/<registry>",
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["TENANT#${aws:PrincipalTag/TenantId}"],
          "dynamodb:Attributes": [
            "PK", "SK", "status", "statusBucket", "leaseOwner", "leaseUntil",
            "sizeBytes", "sha256", "dropEtag", "dropVersionId", "landedKey",
            "reason", "reasonMessage", "validators", "ttl", "eventPublishedAt",
            "updatedAt", "inFlight", "bytesStored", "deliveriesAccepted",
            "deliveriesRejected", "kmsRequests"
          ]
        },
        "StringEqualsIfExists": {
          "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"]
        }
      }
    },
    {
      "Sid": "ProtectKeyBinding",
      "Effect": "Deny",
      "Action": "dynamodb:*",
      "Resource": "arn:aws:dynamodb:<region>:111122223333:table/<registry>*",
      "Condition": {
        "ForAnyValue:StringEquals": {
          "dynamodb:Attributes": ["keyArn", "tier", "apiKeyValue", "keyStatus"]
        }
      }
    }
  ]
}
```

The Deny uses `ForAnyValue` (a `ForAllValues` Deny fires only when every
named attribute is protected), and names `apiKeyValue`, which no row
carries, so code can never store a usage key value beside the binding.

**Base-role registry access is filtered.** The base roles have no
`LeadingKeys` condition; they serve `/platform/*`, the drain, the sweep and
the pipeline, never a tenant request, and reach documents only through a
tenant role. `keyFactoryRole` keeps `PutItem` to write the binding,
guarded by `attribute_not_exists(keyArn)` in code; `platformRole` keeps
`DeleteItem` for offboarding. Together they could rebind a tenant, which
the **registry watch** detects: a Lambda on the stream behind an
event-source filter `SK = KEY` alarms on a `MODIFY` that changes `keyArn`
or `tier`, and on an `INSERT` for a tenant with a `TOMBSTONE#<tenantId>`
item, which it writes on every `REMOVE` (a re-onboarding within 7 days
alarms and is acknowledged). Failed batches go to an SQS on-failure
destination; images are never logged.

**Session lifetime.** 3600 s (the role-chaining cap). A cached session
MUST have at least TTL plus 60 s left to presign and at least T left to
start a processor run; `expiresAt = min(now + TTL, credentials.Expiration)`.

### 7.2 Key policy of a `vendor-key` key

Written once at `CreateKey` with `BypassPolicyLockoutSafetyCheck = true`
(the creating role holds no `kms:PutKeyPolicy`; statement 3 keeps the key
manageable). `<b>` is the bucket, `<t>` the tenant; roles are role ARNs
with path, matched on `aws:PrincipalArn` (for an assumed role, the role
ARN, never the session ARN).

**1. Administration.** `platformRole`: `kms:DeleteAlias`, `DescribeKey`,
`GetKeyRotationStatus`, `RotateKeyOnDemand`, `ListResourceTags`,
`GetKeyPolicy`, `ScheduleKeyDeletion`, `CancelKeyDeletion`.
`keyFactoryRole`: `kms:CreateAlias`, `EnableKeyRotation`, `DescribeKey`,
`ScheduleKeyDeletion`. No wildcard: `kms:Create*` includes
`kms:CreateGrant`, with which a role grants itself `Decrypt`.

**2. Use via S3, bound to the prefix.** The three tenant roles:
`kms:GenerateDataKey`, `kms:Decrypt` with `kms:ViaService =
s3.<region>.amazonaws.com` and `StringLike kms:EncryptionContext:aws:s3:arn`
= `arn:aws:s3:::<b>/ingest/<t>/*`, `arn:aws:s3:::<b>/documents/<t>/*`; a
companion statement grants them `kms:DescribeKey` unconditioned (a direct
call has no ViaService and no context).

**2b. Consumer read.** Each consumer role: `kms:Decrypt` only, via S3,
context `arn:aws:s3:::<b>/documents/<t>/*` only.

**3. Account administration.** The account principal (which lets identity
policies in the vendor account reach the key): the statement 1 actions
plus `kms:PutKeyPolicy`; no use action, `CreateGrant` or `TagResource`.

**4. Deny use to everyone else**, in separate statements (conditions in one
statement are ANDed, so one "unless A and B and C" Deny would fire only
when all three fail):

- **4a-i.** Deny `kms:Encrypt`, `GenerateDataKey*`, `ReEncrypt*`,
  `CreateGrant` to `*` when `ArnNotEquals aws:PrincipalArn` = the three
  tenant roles.
- **4a-ii.** Deny `kms:Decrypt` to `*` unless `aws:PrincipalArn` is a
  tenant role or a consumer role.
- **4b.** Deny `kms:Encrypt`, `Decrypt`, `GenerateDataKey*`, `ReEncrypt*`,
  `CreateGrant` to `*` when `StringNotEquals kms:ViaService =
  s3.<region>.amazonaws.com`.
- **4c.** Deny the same to `*` when `StringNotLike
  kms:EncryptionContext:aws:s3:arn` = the two prefix patterns.

**5. Deny tagging.** `kms:TagResource`, `kms:UntagResource` to `*`, so no
key the factory created can be retagged. Verified by spike on 2026-11-05:
`CreateKey` with tags succeeds under a key policy that carries this Deny
(the new policy is not applied to the create call's own tagging); a later
`TagResource TenantId=other` by the factory is refused, by this statement
and, even without it, because no key-policy statement grants
`kms:TagResource` to anyone. The same spike showed that
`aws:ResourceTag/TenantId` **is** populated from the request tags during
`CreateKey`, so an identity Deny on `Null aws:ResourceTag/TenantId = false`
would block every create; the factory's tagging Allow is conditioned on
`aws:RequestTag` and `aws:TagKeys` for that reason.

Reading a tenant's documents as an administrator, or adding a consumer,
takes `PutKeyPolicy`, which CloudTrail records and a metric filter alarms
on: that is the residual. The consumer set is fixed at key creation;
changing it is a `PutKeyPolicy` per key, an alarmed bulk operation the
README documents and the sample does not build. A unit test checks the
rendered policy with IAM Access Analyzer `check-no-new-access` against a
baseline with every Deny; §10 step 5 proves 4a-i, 4a-ii, 4b and 4c.

Bucket Keys stay off on the bucket and on every request: the PUT and the
`CopyObject` carry `x-amz-server-side-encryption-bucket-key-enabled:
false`. S3 has no condition key for it; a bucket key puts the bucket ARN
in the context, statement 2 misses and 4c denies, so the request fails
closed, and the processor rejects any object reporting `BucketKeyEnabled`.
The cost is one KMS request per object write and read.

### 7.3 Key policy of a `tenant-key` key (README template)

In the tenant's account, on a `SYMMETRIC_DEFAULT`, single-Region key in the
bucket's Region, tagged `TenantId=<t>`: statement 2 for the three tenant
roles (`tenantRoleArns`); statement 2b for the consumer roles
(`consumerRoleArns`); `kms:DescribeKey` for the tenant roles; the
tenant's own administration and any Denies it adds; never a grant.

Both sides must agree: the vendor's identity policies reach only keys
tagged with the session's tenant, and the tenant's policy trusts only the
vendor's roles via S3 on its own prefix. The tag check at
`CreateTenantKey` is **implicit**: `DescribeKey` returns no tags; the
`tenantPlatformRole` session for `<t>` being admitted at all proves the
tag. `aws:ResourceTag/TenantId` **does** evaluate on a key in another
account, verified by spike on 2026-11-05 with a second account: a vendor
session tagged for the key's tenant was admitted to a direct `DescribeKey`
and to `PutObject` and `GetObject` through S3 with that key, and a session
tagged for another tenant was refused on both paths although the key
policy itself allowed any `ingest/*` prefix. §10 step 1 repeats it in the
integration test. KMS tag and policy changes take up to five minutes.

### 7.4 Bucket policy and bucket settings

Ownership `BucketOwnerEnforced`, Block Public Access, versioning and
lifecycle as in §3.1. Statements:

- Deny without TLS (`aws:SecureTransport = false`).
- Deny `s3:PutObject` unless `s3:x-amz-server-side-encryption = aws:kms`
  (a negated operator on an absent key is true, so a missing header is
  caught).
- Deny `s3:PutObject` on `ingest/*` when `s3:if-none-match` is `Null`: a
  drop is written once. This also refuses multipart uploads there, and it
  MUST stay scoped to `ingest/*` (a `CopyObject` into an enforced prefix
  fails).
- Deny `s3:PutObject` on `ingest/*` with an `s3:x-amz-storage-class` other
  than `STANDARD` or any `s3:x-amz-website-redirect-location` (unsigned
  headers could park a drop where the processor cannot read it).
- **Principal-scoped writes and deletes**, by role ARN: Deny `PutObject` on
  `ingest/*` unless a tenant role, on `documents/*` unless
  `tenantProcessRole`; Deny `DeleteObject` and `DeleteObjectVersion` on
  `ingest/*` unless `tenantProcessRole`, `tenantPlatformRole` or the
  auto-delete provider role, on `documents/*` unless `tenantPlatformRole`
  or the auto-delete provider role. That role is the stack singleton of
  `Custom::S3AutoDeleteObjectsCustomResourceProvider`; CDK makes it depend
  on the bucket policy, so without the exemption the Deny would block it
  emptying the versioned bucket and `cdk destroy` would fail.
- Deny `s3:*` when `s3:signatureAge` exceeds `max(uploadUrlTtlSeconds,
  validatorObjectUrlTtlSeconds)`: this stops code from presigning longer
  than the configured TTL; `X-Amz-Expires` is what ends a URL.
- Access logs go to a separate SSE-S3 bucket (`DESTROY`, auto-delete,
  retention `dropRetentionDays` plus 30 days). They hold presigned query
  strings with signatures, so that bucket Denies `s3:GetObject` unless
  `aws:PrincipalArn` is `accessLogReaderRole` (an Allow alone is
  filtered).

### 7.5 The presigned PUT

Signed by a `tenantUploadRole` session, `PUT` on
`ingest/<tenantId>/<deliveryId>`, with these in `X-Amz-SignedHeaders`:

| Header | Value |
|---|---|
| `x-amz-server-side-encryption` | `aws:kms` |
| `x-amz-server-side-encryption-aws-kms-key-id` | the tenant's `keyArn` |
| `x-amz-server-side-encryption-bucket-key-enabled` | `false` |
| `If-None-Match` | `*` |
| `Content-Length` | declared `sizeBytes` |
| `Content-Type` | declared `contentType` |

The SDK signs only `host` by default; the presigner MUST list all six in
`signableHeaders` and the three `x-amz-*` in `unhoistableHeaders` (SDK v3
`getSignedUrl`), and a unit test asserts all six. Extra unsigned `x-amz-*`
headers are undocumented; §7.4 denies those that matter.

### 7.6 Where the tenant id comes from

| Path | Source | Why it is trusted |
|---|---|---|
| `/tenant/*` | `tenant_id` claim | signed, verified, matched to §7.0. The handler checks scope per route: the authoriser result is cached per token for up to 300 s (the revocation lag), so a route-specific policy would be wrong on the next route. The usage key is computed from this claim |
| processor, sweep | second segment of the object key | only tenant roles write under `ingest/` and the API fixes the key under the token's tenant; the processor assumes the session for that id **before** loading the row, so a wrong id is `AccessDenied`, never another tenant's row |
| `/platform/*` | path parameter | IAM, vendor-only, validated in the model; for `tenant-key` the key's tag must match (§7.3) |

### 7.7 Queue and bus policies

In one account an identity Allow reaches a queue or bus, so Allow-only
resource policies are filtered; the construct adds Denies.

- **Queue.** Allow `sqs:SendMessage` to `events.amazonaws.com` with
  `aws:SourceArn` = the rule. Deny `sqs:SendMessage` unless `aws:SourceArn`
  is the rule or `aws:PrincipalArn` is `redriveOperatorRole` (when set).
  Unset, only the rule sends and an operator redrive is not possible.
- **DLQ.** Deny `sqs:SendMessage` unless `aws:SourceArn` is the queue;
  whether the automatic move meets this is undocumented, §10 step 7b shows
  it, and the Deny is dropped if it blocks the move.
- **EventBridge target DLQ** keeps its own policy (rule only).
- **Bus.** Deny `events:PutEvents` unless `aws:PrincipalArn` is
  `processorRole`. The `Object Created` rule is on the default bus, where
  S3 delivers.
- SSE-SQS everywhere; DLQ retention 14 days, so the uploader's IP address
  in S3 events is kept for up to 14 days.

A forged `Object Created` message is harmless: the processor acts only
under the session for the key's prefix, on an `AWAITING_UPLOAD` row.

---

## 8. Pipeline

```
tenant PUT -> ingest/<t>/<d> -> Object Created -> rule (default bus) -> SQS (+ DLQ) -> processor
 0. t, d from the key; t fails §7.0, or third segment _probe -> delete message, stop
 1. assume tenantProcessRole {TenantId: t}, session t-<t>-<last 16 of d>
 2. row and key row, ConsistentRead
      row or key row missing, or keyStatus DELETING -> delete the drop version, stop
      terminal -> delete a leftover drop version; no eventPublishedAt -> publish, set it; stop
      AWAITING_UPLOAD, or PROCESSING with own or expired lease -> lease (leaseOwner, leaseUntil = now + T)
      PROCESSING with another live lease -> stop
 3. HeadObject -> dropEtag, dropVersionId
      SSEKMSKeyId != keyArn or BucketKeyEnabled -> REJECTED structural:KEY_MISMATCH
      StorageClass != STANDARD -> structural:STORAGE_CLASS
      ContentLength != declared, or > max -> structural:SIZE_MISMATCH | TOO_LARGE
 4. GetObject IfMatch dropEtag: magic bytes, ZIP directory, sha256
 5. validators in order: presign GET (IfMatch) -> invoke -> verdict
      REJECT -> REJECTED <name>:<code>
      error -> not last receive: throw; last receive: REJECTED <name>:VALIDATOR_ERROR, then throw
               (the DLQ copy is an audit record only)
 6. CopyObject -> documents/<t>/<d>, same key, bucket key off, CopySourceIfMatch dropEtag,
      REPLACE metadata (Content-Type, Content-Disposition); PreconditionFailed -> structural:OBJECT_CHANGED
 7. row -> ACCEPTED, landedKey (on leaseOwner); counters; inFlight - 1
 8. DeleteObjectVersion (dropVersionId)
 9. PutEvents; UpdateItem SET eventPublishedAt
 REJECTED: row -> REJECTED with ttl (on leaseOwner), inFlight - 1, then 8, then 9
 403 / AccessDenied from S3 at 3-8 -> probe; any other error -> throw
```

**Probe.** On any 403 at steps 3 to 8 the processor runs, under the same
session, `PutObject`, `GetObject`, `DeleteObjectVersion` of
`ingest/<t>/_probe/<ulid>` with the registry key. A KMS-sourced failure (a
code or message naming `kms:`): row `KEY_UNAVAILABLE` (`ttl`, `inFlight -
1`), `processorRole` sets `keyStatus = REVOKED`, drop version deleted,
`DeliveryKeyUnavailable` published, message deleted. Probe success: the
fault is the pipeline's own; throw.

**Order and re-entry.** Copy, flip, delete, publish. A crash after the copy
leaves a lease the next receive re-takes (the copy repeats, pinned to the
same ETag); a crash after the flip leaves a terminal row, and step 2
removes the drop and publishes the owed event. The `leaseOwner` condition
keeps two processors from landing one delivery; the ETag pin proves no
overwrite happened. A URL replayed after the drop version is deleted meets
a terminal row and its object is deleted (N-6).

**Timing.** T = structural budget + validator timeouts + copy budget, at
most 15 minutes, else synth fails naming the validators. Visibility
timeout `visibilityTimeoutFactor × T`; the DLQ after at most
`maxReceiveCount × visibilityTimeoutFactor × T` (18T by default).

**Sweep** (hourly, `sweepRole`, GSI `statusBucket = OPEN`, `ConsistentRead`,
S3 under the tenant session):

- `AWAITING_UPLOAD` -> `EXPIRED` (`ttl`, `inFlight - 1`) only when `now >
  urlExpiresAt + abandonGraceSeconds` **and** `HeadObject` on the drop is
  404, so a long PUT that started in time is never discarded.
- `PROCESSING` with `leaseUntil` older than `maxReceiveCount ×
  visibilityTimeoutFactor × T + abandonGraceSeconds` -> `REJECTED
  structural:PROCESSING_ABANDONED`, drop version deleted, event published.
- `REVOKED` key rows: probe; `ACTIVE` only on success.
- `inFlight` reconciled to the count of `OPEN` rows with an `UpdateItem`
  conditional on the value read, retried on conflict.

---

## 9. Non-functional requirements

- **N-1 Latency.** `CreateDelivery` p50 under 300 ms; a 100 MiB delivery
  accepted within 60 s of the upload.
- **N-2 Throughput.** 1,000 deliveries per minute with no design change;
  the KMS quota (10,000 to 100,000 rps by Region) is two orders above four
  to six calls per delivery. `tenant-key` calls count against the vendor's
  quota.
- **N-3 Scale.** 10,000 tenants: 10,000 keys (quota 100,000, counting keys
  pending deletion), one bucket, one table, nothing per tenant in any
  policy. STS `AssumeRole` is 600 rps per account, so
  `maxInFlightPerTenant` is not optional at scale. With `tenantThrottle`:
  10,000 API keys per account and Region, not adjustable, shared with
  `tenant-identity`'s per-tenant keys, so the composed deployment caps at
  5,000 tenants.
- **N-4 Deploy and destroy time.** Each under 5 minutes; `CreateTenantKey`
  under 3 s (`vendor-key`) or 10 s (`tenant-key`). `CreateApiKey` is 5 rps
  per account, which bounds bulk onboarding with `tenantThrottle`.
- **N-5 Idle tenant.** $1 per month (`vendor-key`), $0 (`tenant-key`).
- **N-6 No plaintext at rest.** Objects, SQS messages (keys only), logs
  (no content, URLs or file names). Residuals: access logs hold presigned
  URIs, behind a one-reader Deny. A logged PUT URL is single-use until the
  drop is processed; after the drop version is deleted the same URL writes
  again until its TTL, and the processor discards that upload (terminal
  row) at the cost of one run. A logged validator GET is reusable until its
  TTL, which log delivery latency nearly consumes.
- **N-7 Standard compliance (§4.3, §4.4).** cdk-nag `AwsSolutionsChecks`;
  an explicit `DESTROY` `LogGroup` per function; SSE-SQS; the §3.1
  lifecycle rules; the target DLQ; the auto-delete exemption; the stream
  filter and on-failure destination; `apiKeyRequired` with
  `tenantThrottle`. Each is a template test.
- **N-8 Per-tenant limits.** Always: `inFlight` (429 at
  `maxInFlightPerTenant`), which bounds one tenant's STS, KMS, Lambda and
  validator use. With `tenantThrottle`: a usage plan on `/tenant/*` and one
  API key per tenant, created at `CreateTenantKey` with the deterministic
  value `tei-<hex(sha256(stackId + tenantId))[0:40]>` (44 characters; API
  Gateway needs 20). The authoriser computes it from the verified claim
  and returns it as `usageIdentifierKey`; the API uses `apiKeySource:
  AUTHORIZER` and every `/tenant/*` method `apiKeyRequired: true`. The
  value only identifies a tenant for throttling, so it may be derivable,
  and `authoriserRole` needs no DynamoDB permission.

---

## 10. Acceptance criteria (integration test outline)

The integration test is the reference implementation (standard §5.2):
`scripts/integ.sh`, one Region, refused unless the account carries the
`tei:test-account` tag. Stacks in order: `tenant-identity` (`shared-pool`,
reused if present), the **test-aid stack**, the demo stack with
`TestConsumerRole` as its consumer role. The test-aid stack holds:

- `TestProbeRole`, trusted by the runner for one hour: KMS use actions and
  `DescribeKey` on `*`, `s3:GetObject` on the ingestion bucket, `GetObject`
  and `PutObject` on the scratch bucket; Deny `kms:PutKeyPolicy`,
  `CreateGrant`, `ScheduleKeyDeletion`, `TagResource`, `UntagResource`,
  `s3:PutBucketPolicy`, `DeleteBucketPolicy`, `PutBucketEncryption`. Any
  denial it meets comes from a key or bucket policy.
- `TestConsumerRole`: `s3:GetObject` on `documents/${tag}/*` of both
  buckets, `kms:Decrypt` via S3 on keys tagged `${tag}`.
- A scratch bucket (§7.4 minus the principal statements) and a scratch key
  for its tenant `A`, from the §7.2 builder, with `TestScratchWriterRole`
  as tenant role, `TestConsumerRole` as consumer, and a mistaken Allow of
  every use action for `TestProbeRole`.

Context `tenantKeyAccount` names a second account for the `tenant-key`
key; without it the README says the cross-account claim is unproven. Test
profile: `maxReceiveCount 1`, `visibilityTimeoutFactor 2`,
`abandonGraceSeconds 60`, `uploadUrlTtlSeconds 60`,
`maxInFlightPerTenant 5`, `tenantThrottle` set. Validators: `pdf-pages`
(limit 3) and `test-switch`, whose mode (`accept`, `throw`, `pause`,
`sleep`) is an SSM parameter the test writes, so nothing redeploys; it
declares a timeout below its function's own, so `sleep` outlasts the
processor. The test waits 5 minutes after each key policy or tag change.

1. **Two tenants, two tiers.** `CreateTenantKey A vendor-key`; a key tagged
   `TenantId=B` with the §7.3 policy, `CreateTenantKey B tenant-key`. Both
   `ACTIVE`, no probe version left. Untagged or wrongly tagged key, or a
   key in the vendor's account -> 422; C with B's `keyArn` -> 409.
2. **Users.** Two tenant users with both scopes; one token with
   `ingestion/read` only.
3. **Happy path.** A and B upload a PDF -> `ACCEPTED`; `landedKey` has the
   tenant's key and the `Content-Disposition` name; one `DeliveryAccepted`
   without a key ARN; no drop version left. Read-only token:
   `CreateDelivery` -> 403, then `GetDelivery` -> 200.
4. **The uploader cannot change the request.** B's key id, no SSE header,
   another `Content-Length`, `x-amz-storage-class: GLACIER` -> 403; a second
   PUT before processing -> 412; A's URL with the path edited to
   `ingest/B/...` -> `SignatureDoesNotMatch`. Extra unsigned headers:
   recorded.
5. **Each key-policy wall alone, against the mistaken Allow** (by error
   message). `TestProbeRole` on the scratch bucket: PUT `ingest/B/x` ->
   KMS 403 (4c); PUT `ingest/A/y` -> KMS 403 (4a-i); direct
   `GenerateDataKey` -> denied (4b); GET `documents/A/d` (written by
   `TestScratchWriterRole`) -> KMS 403 (4a-ii); `TestConsumerRole` for A
   -> 200 (2b). `TestScratchWriterRole` PUT with `bucket-key-enabled:
   true` -> KMS 403. On the ingestion bucket, `TestProbeRole` PUT to
   `ingest/A/z` with every header right -> 403 from S3. The
   identity-policy wall: `SimulatePrincipalPolicy` on the deployed tenant
   roles with `TenantId = A` denies every S3, KMS and DynamoDB action on
   B's resources, any `PutItem` or `DeleteItem`, and any write naming
   `keyArn`, `tier` or `keyStatus`.
6. **Cross-tenant read.** `TestConsumerRole` for A: A's landed object ->
   200, B's -> 403 from S3. `TestProbeRole` on B's -> KMS 403.
7. **Rejections and limits.** Declared PDF, uploaded ZIP ->
   `TYPE_MISMATCH`; oversize declared -> 400; an unused URL -> `EXPIRED`
   once the test invokes `sweepFunction` past TTL plus grace; tenant D's
   sixth open delivery -> 429.
7b. **Validators.** A 5-page PDF -> `pdf-pages:TOO_MANY_PAGES`, `test-switch`
   not invoked. Mode `throw` -> on the last receive
   `test-switch:VALIDATOR_ERROR`, drop version gone, `DeliveryRejected`,
   the message in `deadLetterQueue`. No log line holds `X-Amz-Signature`
   or a file name.
7c. **Abandoned lease.** Mode `sleep`: the processor times out holding the
   lease; after 2T plus 60 s `sweepFunction` -> `PROCESSING_ABANDONED`,
   drop version gone, event published.
8. **Revocation, decided by the probe.** Mode `pause`. B uploads; while
   `PROCESSING`, disable B's key -> the copy and the probe fail ->
   `KEY_UNAVAILABLE`, `REVOKED`, `DeliveryKeyUnavailable`, DLQ unchanged,
   `CreateDelivery B` -> 409. Re-enable; `sweepFunction` -> `ACTIVE`; a new
   delivery is `ACCEPTED`. Repeat removing **only** the use statement
   (`DescribeKey` kept): same outcome, `REVOKED` until it is back. A unit
   test covers an S3 403 whose probe succeeds: thrown, never `REVOKED`.
9. **Rotation.** `RotateTenantKey A` -> 200, step 3's object still reads;
   `RotateTenantKey B` -> 400.
10. **Observability.** One processor line per delivery with `tenantId`,
    `status`, `kmsRequests`; the access-log `Requester` names
    `t-<tenantId>-...`; `kmsRequests` matches CloudTrail for one delivery.
11. **Offboarding.** URL in flight, `DeleteTenantKey A` -> 202; no version
    under either A prefix; alias gone; key `PendingDeletion`;
    `CreateDelivery A` -> 403 from API Gateway (API key gone; 409 from the
    handler with `tenantThrottle` off, a unit test); the in-flight PUT ->
    403. `DeleteTenantKey B` -> key untouched, row and `KEYARN#` gone,
    tombstone written, no alarm.
12. **Teardown.** `cdk destroy --all`: the versioned bucket, the test-aid
    stack and its scratch bucket are gone, nothing with the sample's prefix
    remains but keys pending deletion, which the test lists.

Runtime target: 60 to 90 minutes, under $2 per run.

---

## 11. Extension and hardening seams (documented, not built)

Extension:

- **Sealed drop tier**: an asymmetric key per tenant; the tenant wraps a
  data key offline, the processor unwraps.
- **Transfer Family** (SFTP) in front of `ingest/`, users mapped to
  `tenantUploadRole` sessions.
- **Step Functions carrier** for validators: the §3.5 request and verdict
  as a task with a callback.
- **Malware scan** as a validator (GuardDuty Malware Protection for S3).
- **Download route**: a presigned `GET` under the tenant session.
- **Bulk offboarding** with S3 Batch Operations.
- **Control-plane mount**: `scripts/control-plane/` calling the platform
  API.

Hardening:

- **Manual hold and redrive of validator errors**: a `HELD` state keeping
  the drop for a redrive through `redriveOperatorRole`.
- **`DRAINING` sentinel**: a `SYSTEM` row the drain writes and
  `CreateTenantKey` checks, closing the window the tag backstop covers.
- **Alias-bound keys** for `vendor-key`: tenant roles also conditioned on
  `kms:ResourceAliases = alias/tenant-${tag}-ingestion`.
- **Per-tenant bus subscription**: construct-made rules with a fixed
  `detail.tenantId` filter, so reading events is enforced.

## 12. Reading order for implementers

1. §2, then §7 (the policies are the sample).
2. §4 and §5, then the Smithy model.
3. §8, then the processor.
4. §10, then the integration test in step order.

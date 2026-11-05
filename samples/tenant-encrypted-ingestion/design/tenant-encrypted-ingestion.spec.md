# Specification: Per-Tenant Encrypted Ingestion for Agentic Applications

> **Status:** Draft, 2026-11-04; revised 2026-11-05 after an independent
> security review (30 findings, report kept out of the repository; the
> findings are cited as F-n in the text and dispositioned in the threat
> model). This document is the *requirements and
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

Two problems come with that shared path:

1. **Isolation.** One tenant's documents must never be readable with another
   tenant's key or by code acting for another tenant, and a tenant must be
   able to leave with its documents made unreadable.
2. **Admission.** What counts as an acceptable delivery differs per
   deployment and per tenant: a page limit, a required form type, a malware
   scan, a schema check on a sidecar file, a rule a regulated tenant imposes.
   The vendor cannot know these checks in advance, and a check that reads a
   tenant's document must run inside the same isolation as the pipeline, not
   with broad access of its own. The pipeline therefore needs a **validation
   chain the deployer extends** without touching the pipeline's code or its
   permissions.

This sample demonstrates **per-tenant encryption of a shared ingestion path
with AWS KMS**, where the boundary between tenants is enforced by KMS and IAM,
not by application code, and **pluggable admission validation** that runs
inside that boundary:

- Every tenant has **its own KMS key**. Every object a tenant delivers, and
  every object the pipeline derives from it, is encrypted with that key and
  no other.
- The key is bound to the tenant's prefix **by the key's own policy**: the
  key refuses to encrypt or decrypt an object outside
  `<prefix>/<tenantId>/` (§7.1). A key that leaks cannot be used on another
  tenant's objects, and another tenant's key cannot be used on this one's.
- The pipeline works under **tenant-scoped credentials** (ABAC with a
  `TenantId` session tag, the conditions in the role's own identity policy)
  that reach only the one tenant's prefix and the one tenant's key. A
  wrong-tenant bug in the pipeline is refused by AWS. Compromised function
  code is the residual: it can mint a session for any one tenant, and the
  threat model says so.
- Two **key tiers** sit behind one contract. `vendor-key`: the vendor creates
  and owns the key, with automatic rotation on. `tenant-key`: the tenant brings
  its own key from its own AWS account, lets the pipeline's tenant roles use
  it through its key policy, and can withdraw that at any time; the pipeline
  fails closed.
- **Offboarding is cryptographic.** Deleting a tenant schedules its key for
  deletion; every object encrypted with it becomes unreadable, whether or not
  the object delete has completed.
- **Validation is a chain, not a hard-coded step.** Built-in structural
  checks run first; then every **custom validator** the deployer plugged in,
  in order, each a function in any language or account that receives a
  short-lived, single-object URL signed by the tenant's session and returns
  a verdict. A validator holds no AWS permission of its own, so a bad one
  can read one document for a few minutes and nothing else (P-11, §3.5).
  Nothing lands until the whole chain accepts.

The sample ships the pattern as a CDK construct, `TenantEncryptedIngestion`,
plus a thin demo stack, an integration test that proves the boundary from
both sides, a demo script, and one example custom validator
(`examples/validator-pdf-pages`) that shows how a deployer extends the
validation chain (P-11).

### 1.1 Deployment model

**Pool with per-tenant keys.** One bucket, one API, one event pipeline, one
registry table serve every tenant; the tenant unit is the KMS key, the S3
prefix and the registry partition. In the repository's vocabulary
(`ARCHITECTURE.md` §3) this is a pool at the infrastructure layer with
**enforced** isolation at the data layer: the key policy and the ABAC
identity policy of the tenant roles are the wall; the code only chooses
which side of it to stand on.

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
- **Not malware scanning, not content rules.** Built-in validation is
  structural (size, type, magic bytes, archive sanity). Anything beyond that
  (a scanner, a schema check, a tenant-specific rule) is a **custom
  validator** the deployer plugs in (§3.5, P-11); the sample ships the
  contract and one example validator, not the checks themselves.
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
(§7.2), so it holds for every caller the key policy does not name,
including every IAM identity policy in the vendor's account and a pipeline
bug. The account principal can rewrite the key policy; that call is logged
and alarmed, and it is the residual (§7.2 statement 4). Rules in: key
policy conditions on `kms:EncryptionContext:aws:s3:arn`; an explicit Deny
of every use action outside the three tenant roles via S3; S3 Bucket Keys
off on the bucket and on every request, because a bucket key replaces the
object ARN in the context with the bucket ARN and the binding is lost. Rules out: a bucket policy that names tenants one by one (it hits
the 20 KB limit at a few hundred tenants and is filtered, not enforced).

### P-2. Code chooses the tenant; AWS enforces it

Every call the pipeline makes on a tenant's behalf MUST be signed with
credentials that carry a `TenantId` session tag, assumed from a role whose
**identity policy** reaches only `<prefix>/${aws:PrincipalTag/TenantId}/*`
and keys whose `TenantId` resource tag matches (§7.1). The wall is in the
role, not in a session policy the caller passes: a session policy can only
narrow, so code that omits it would hold the role's full permissions. The
tenant id the code uses MUST come from a verified source: the access token
on the API, the object key prefix the presigner fixed on the pipeline. A
tenant id from a request body, a header, or an object's own metadata is
never trusted. What this does not stop: compromised function code choosing
the tag value. The trust policy fixes the tag key, not the value; one role
per function and CloudTrail `AssumeRole` events naming the tag are the
limits that remain (threat model T-14, accepted).

### P-3. Everything a tenant delivers is encrypted with that tenant's key

The bucket MUST refuse an object that is not SSE-KMS (bucket policy deny on
`s3:x-amz-server-side-encryption != aws:kms`) and any drop object written
without `If-None-Match: *` (§7.4). The presigned URL MUST fix the key id,
the bucket-key flag, the content length and `If-None-Match` in the signed
headers (§7.5), so the uploader cannot change the key, inflate the body, or
overwrite what was validated. The pipeline
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

When a tenant's key cannot be used (a removed key-policy statement,
disabled key, pending deletion, deleted key), the pipeline MUST stop processing that tenant's deliveries, record
the distinct failure class `KEY_UNAVAILABLE` on the delivery and `REVOKED` on
the key record, and MUST NOT retry into the dead-letter queue as if the
failure were transient. A corrupt file is `REJECTED`; a missing key is not a
corrupt file. The classifier MUST match on the KMS error code S3 surfaces
and confirm with `DescribeKey`; a bare S3 `AccessDenied` is the pipeline's
own fault and MUST NOT mark a tenant `REVOKED` (§8). Recovery is automatic:
the sweep re-checks `REVOKED` keys and flips them back.

### P-6. Offboarding is cryptographic and total

`DeleteTenantKey` MUST, for `vendor-key`, delete the alias, schedule the key
for deletion with the shortest window KMS allows (7 days) and remove the
tenant's objects under both prefixes (listing and deleting under a
`tenantPlatformRole` session, §7.1); for `tenant-key`, remove the registry
binding, the `KEYARN#` item and the tenant's objects. After it returns, no
new object can land under the prefix (the registry row is gone, so the API
presigns nothing), the pipeline deletes any late drop object and publishes
nothing, and a final prefix sweep runs after `uploadUrlTtlSeconds` for URLs
that were in flight.

### P-7. The tenant cannot write outside its own prefix

A presigned URL names exactly one object key, `ingest/<tenantId>/<deliveryId>`,
chosen by the vendor (no tenant-chosen file name in the key: names leak
into CloudTrail, KMS encryption context, SQS and access logs; the file name
lives on the row and in `Content-Disposition`). It is signed with
tenant-scoped credentials (P-2), so even a forged URL for another prefix
fails the signer's own identity policy. It writes once (`If-None-Match`),
for the declared size, and dies with its TTL (`s3:signatureAge`). The
tenant never holds AWS credentials of the vendor's account.

### P-8. Least privilege as role asymmetry

Three base roles reach no tenant object: `apiRole` may only assume
`tenantUploadRole`; `processorRole` may only assume `tenantProcessRole`,
read its queue, invoke bound validators and put events; `platformRole` may
only assume `tenantPlatformRole`, administer keys (explicit actions, never
`CreateGrant`, `PutKeyPolicy` or a use action) and reach the registry
table-wide (filtered, §7.1). Three tenant roles carry the ABAC wall in
their identity policies and are each trusted by exactly one base role:
upload (presign, `GenerateDataKey`), process (read drop, write landed,
`Decrypt`), platform (list and delete both prefixes, the probe). The API
cannot read an object because no role it can assume may; that is the
asymmetry, and it is enforced, not a code choice.

### P-9. Say what each tenant costs, and show it per tenant

Keys are dedicated resources and carry a `TenantId` cost allocation tag. S3
storage and KMS requests are pooled, so the pipeline MUST meter per tenant
what drives them: bytes accepted, bytes stored (cumulative on the registry
row), deliveries, KMS requests as counted calls (four plus one per validator
for an accepted delivery: `GenerateDataKey` on the upload, `Decrypt` for
the processor's read, `Decrypt` per validator `GET`, `Decrypt` plus
`GenerateDataKey` on the copy; N-2). The
`tenantId` is a field in every structured log line and access log; per-tenant
metrics are derivable from those fields with Contributor Insights, and
optionally emitted as EMF (`perTenantMetrics`, off by default because custom
metrics scale with tenants times metrics).

### P-10. Validate, then land; never land, then validate

A delivery MUST reach the `documents/` prefix only after it passed every
check (size, type, magic bytes, archive sanity, key match, the validator
chain), and the bytes that land MUST be the bytes that were checked: the
drop object is written once (bucket policy) and every read and the copy
are pinned to its ETag (§8). The drop prefix
is a quarantine with a one-day lifecycle; a rejected object is deleted at
once. Downstream consumers subscribe to `DeliveryAccepted` and never read
`ingest/`.

### P-11. Validation is a chain the deployer extends, behind one contract

The processor runs the built-in structural checks first, then every custom
validator the deployer supplied, in list order, and stops at the first
`REJECT`. A validator is a function the construct invokes with a JSON
request and a JSON verdict (§3.5); it never receives AWS credentials and
never reaches the bucket on its own: it gets a presigned `GET` for the one
object, signed by the tenant session, pinned to the validated ETag and
short-lived, so a validator that misbehaves can read one document for a
few minutes and nothing else. A validator in another account also needs a
resource policy on its function that allows `processorRole` to invoke it;
the deployer owns that policy. The processor logs a validator error's type
only, never its body, which may echo the URL. The
contract names no carrier: today it rides on a synchronous Lambda invoke;
a Step Functions task could carry the same request and verdict later
(§11). Rules in: validators in any language or account, chained, bounded by
a timeout, visible per tenant in logs. Rules out: validator code bundled
into the processor (it would run under the processor's role and break P-8),
and validators that vote asynchronously over the event bus (a silent voter
would block every delivery).

---

## 3. System shape

### 3.1 Components

| Component | Service | Role |
|---|---|---|
| Ingestion bucket | Amazon S3 | prefixes `ingest/<tenantId>/` (drop, 1-day lifecycle, abort multipart after 1 day) and `documents/<tenantId>/` (landed). Versioning off, Bucket Keys off (P-1), bucket policy §7.4 (TLS, SSE-KMS, `If-None-Match`, no bucket key, `signatureAge`), access logs to a separate SSE-S3 log bucket |
| Tenant keys | AWS KMS | one symmetric key per `vendor-key` tenant, alias `alias/tenant-<tenantId>-ingestion`, tag `TenantId`, automatic rotation on; `tenant-key` tenants register a key ARN in their own account |
| Registry | Amazon DynamoDB | tenant key rows and delivery rows, tenant-partitioned (§4); a sparse GSI (`statusBucket`, `expiresAt`) for the sweep |
| Ingestion API | API Gateway REST + Lambda | `/platform/*` (IAM, vendor) and `/tenant/*` (token authoriser, tenant users), modelled in Smithy |
| Token authoriser | Lambda | verifies the `tenant-identity` token contract (`ARCHITECTURE.md` §2.1) and passes `tenantId`, `sub` to the integration |
| Pipeline | EventBridge, SQS (+ DLQ), Lambda | S3 `Object Created` on `ingest/` -> queue (SSE-SQS, explicit-deny policy §7.7) -> processor; runs the structural checks and the validator chain under a lease (§8), copies to `documents/`, writes the delivery row, publishes `DeliveryAccepted` or `DeliveryRejected` on the sample's event bus |
| Custom validators | Lambda (deployer-owned) | zero or more functions the processor invokes in order with the §3.5 contract; the sample ships one example (`examples/validator-pdf-pages`, rejects a PDF over N pages) to show the shape |
| Token vending | AWS STS | each base role assumes its one tenant role with a `TenantId` session tag and a `t-<tenantId>-...` session name; the ABAC wall is the tenant role's identity policy (P-2, §7.1) |
| Per-tenant limits | API Gateway usage plan, registry counter | one API key per tenant on `/tenant/*`; `inFlight` counter on the key row, 429 at `maxInFlightPerTenant` (N-8) |
| Sweep | EventBridge schedule, Lambda (`platformRole`) | hourly: expires unused URLs, abandons dead leases, re-checks `REVOKED` keys, reconciles `inFlight` (§8) |
| Observability | CloudWatch Logs, Contributor Insights, optional EMF | `tenantId` field everywhere; top-tenant rules for deliveries, bytes, rejections, key failures |

### 3.2 Caller and identity model

- A **tenant user** holds an access token from `tenant-identity` with
  `tenant_id`, `sub`, `client_id`, `scope`. It calls `/tenant/*`. The
  authoriser verifies issuer, client, expiry, `token_use`, and refuses a
  token still carrying `tenants`, and returns an Allow on `/tenant/*` with
  `tenantId`, `sub` and `scope` in the context, plus the tenant's API key
  value as `usageIdentifierKey` (read from the key row by `tenantId`, cached
  with the authoriser result) so the per-tenant usage plan applies (N-8). The
  **handler** enforces the scope per route (§7.6): `ingestion/deliver` for `CreateDelivery`;
  `ingestion/read` for `GetDelivery` and `ListDeliveries`. The sample registers both scopes in `tenant-identity`'s
  catalogue at deploy (its `PutScope`), the way `agentic-runtime-isolation`
  registers backend scopes.
- The **vendor** calls `/platform/*` with IAM (SigV4). A control-plane
  tenant create script is the expected caller (§6.4).
- The **tenant's AWS account** appears only in the `tenant-key` tier, as the
  owner of a key whose policy trusts the construct's three tenant roles via
  S3 (§7.3, published as `tenantRoleArns`). It never calls the API.
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
| `uploadUrlTtlSeconds` | 60..3300 | `900` | presigned URL lifetime; the cap leaves 300 s under the one-hour role-chaining session so the URL never outlives its credentials (§7.1) |
| `maxInFlightPerTenant` | 1..10000 | `100` | deliveries a tenant may have in `AWAITING_UPLOAD` or `PROCESSING` at once; 429 beyond (N-8) |
| `tenantThrottle` | `{ rateLimit, burstLimit }` | `{ 20, 40 }` | per-tenant usage plan on `/tenant/*` (N-8) |
| `dropRetentionDays` | 1..7 | `1` | lifecycle on `ingest/` |
| `validators` | `IDeliveryValidator[]` | `[]` | custom validators run after the structural checks, in order (P-11, §3.5). The construct ships `LambdaValidator` |
| `validatorObjectUrlTtlSeconds` | 60..900 | `300` | lifetime of the presigned `GET` handed to each validator |
| `onValidatorError` | `'hold' \| 'reject'` | `'hold'` | what happens when a validator fails after retries: `hold` leaves the message in the DLQ with the object in the drop (an operator can replay); `reject` marks the delivery `REJECTED: VALIDATOR_ERROR` and deletes the drop. Neither lands the object |
| `perTenantMetrics` | boolean | `false` | emit EMF per tenant in addition to the structured log fields (P-9) |
| `logRetention` | `logs.RetentionDays` | one month | every log group (each an explicit `LogGroup` with `DESTROY`, N-7) |
| `accessLogReaderRole` | `iam.IRole` | none | the one principal allowed to read the S3 access-log bucket (§7.4); unset, only the account principal can |

Props are validated in the constructor; a bad value fails synth with a
message naming the prop. The demo stack reads its context (`identityParams`
prefix) and fails fast when it is missing.

### 3.4 Read-only properties

`bucket`, `apiUrl`, `eventBus`, `registryTable`, `tenantRoles`
(`{ upload, process, platform }`, the three roles a `tenant-key` key policy
must trust, §7.1), `platformRole`.

### 3.5 Validator contract

```ts
export interface IDeliveryValidator {
  readonly name: string;            // [a-z0-9-]{1,32}, unique in the chain; appears in reasons and logs
  readonly timeout: Duration;       // <= 10 minutes; the processor's timeout must cover the chain
  bind(scope: Construct, processor: iam.IGrantable): void;   // grant invoke, nothing else
  readonly carrier: 'lambda';       // the one carrier today (P-11)
  readonly functionArn: string;     // for 'lambda'
}
```

`LambdaValidator(fn: lambda.IFunction, opts?: { name?, timeout? })` is the
shipped implementation. Its `bind` grants the processor `lambda:InvokeFunction`
on `fn`; it grants `fn` nothing.

**Request** (one invocation per validator per delivery):

```json
{
  "version": "1",
  "tenantId": "a1b2c3",
  "deliveryId": "01JBX...",
  "fileName": "case-4711.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 1834022,
  "sha256": "9f86d0...",
  "objectUrl": "https://<bucket>.s3.<region>.amazonaws.com/ingest/a1b2c3/01JBX...?X-Amz-...",
  "etag": "\"9b2cf5...\"",
  "objectUrlExpiresAt": "2026-11-04T13:05:00Z",
  "previous": [{ "validator": "structural", "verdict": "ACCEPT" }]
}
```

`objectUrl` is a presigned `GET` signed by the `tenantProcessRole` session
(§7.1) with `If-Match: <etag>` in the signed headers, so it can fetch
exactly this object, exactly these bytes, and only until
`objectUrlExpiresAt`. It is never logged, and a validator error's body is
never logged either (it may echo the URL). A validator MUST NOT persist it.
A validator function in another account needs a resource policy that allows
`processorRole` to invoke it; `LambdaValidator.bind` can only grant
in-account.

**Verdict:**

```json
{ "version": "1", "verdict": "ACCEPT" }
{ "version": "1", "verdict": "REJECT", "code": "TOO_MANY_PAGES", "message": "412 pages, limit 300" }
```

`code` is `[A-Z0-9_]{1,40}`; the delivery's `reason` becomes
`<name>:<code>`. `message` is stored on the row and returned by
`GetDelivery`; it MUST NOT contain document content (the validator author
owns that promise; the README says so). A verdict that fails schema
validation, a function error, or a timeout is a **validator error** and
follows `onValidatorError`; it is never read as `ACCEPT`.

The chain stops at the first `REJECT`. `previous` lets a later validator
see what ran before it. The processor logs one line per validator call:
`tenantId`, `deliveryId`, `validator`, `verdict`, `code`, `durationMs`.

---

## 4. Data model

One DynamoDB table, tenant-partitioned (`PK = TENANT#<tenantId>`), on-demand,
PITR on, encrypted with an AWS-owned key (the table holds identifiers and
status, never document content).

### 4.1 Tenant key

| Attribute | Value |
|---|---|
| `PK` / `SK` | `TENANT#<tenantId>` / `KEY`; plus a `KEYARN#<keyArn>` / `KEY` uniqueness item written in the same transaction, and a `SYSTEM` / `DRAINING` sentinel written by the stack-delete drain |
| `tier` | `vendor-key` \| `tenant-key` |
| `keyArn` | the key the prefix is bound to |
| `keyAlias` | `alias/tenant-<tenantId>-ingestion` (`vendor-key` only) |
| `status` | `CREATING` -> `ACTIVE` -> `DELETING`; `ACTIVE` <-> `REVOKED` (`tenant-key` only; set only on a KMS-coded failure confirmed by `DescribeKey`, cleared by the sweep) |
| `apiKeyId` | the tenant's API Gateway key for the usage plan (N-8) |
| `inFlight` | deliveries in `AWAITING_UPLOAD` or `PROCESSING` (N-8) |
| `bytesStored`, `deliveriesAccepted`, `deliveriesRejected`, `kmsRequests` | counters the processor increments (P-9) |
| `createdAt`, `updatedAt`, `lastKeyCheckAt` | ISO timestamps |

The row is written `CREATING` before the key exists and flipped to `ACTIVE`
by a conditional update, so a failed create leaves a row the operator can
see and a retry can finish (the same shape as tenant-identity ADR-0021).
Both writes are conditioned on the `DRAINING` sentinel being absent; if the
flip fails because the drain started in between, the handler schedules the
just-created key for deletion before returning 409. The drain reads with
`ConsistentRead`, waits one platform-function timeout after writing the
sentinel, re-scans, and as a backstop lists keys by the construct's
`tei:stack` tag and schedules any the registry does not know (F-21).

### 4.2 Delivery

| Attribute | Value |
|---|---|
| `PK` / `SK` | `TENANT#<tenantId>` / `DELIVERY#<deliveryId>` (`deliveryId` a ULID, so `ListDeliveries` pages newest first) |
| `objectKey` | `ingest/<tenantId>/<deliveryId>` (no file name in the key, P-7) |
| `landedKey` | `documents/<tenantId>/<deliveryId>` once `ACCEPTED`; the object carries `Content-Disposition: attachment; filename="<fileName>"` |
| `fileName` | `[A-Za-z0-9._-]{1,128}`, validated at `CreateDelivery`; stored here and never in a key, a log or an event |
| `declaredContentType`, `declaredSizeBytes` | from `CreateDelivery` |
| `sizeBytes`, `sha256`, `dropEtag` | measured by the processor; `dropEtag` pins every later read and the copy (§8) |
| `status` | `AWAITING_UPLOAD` -> `PROCESSING` -> `ACCEPTED` \| `REJECTED` \| `KEY_UNAVAILABLE`; `AWAITING_UPLOAD` -> `EXPIRED` when the URL lifetime passes with no object. `PROCESSING` is a lease: `leaseOwner` (SQS message id), `leaseUntil` (§8) |
| `statusBucket` | `OPEN` while `AWAITING_UPLOAD` or `PROCESSING`, absent otherwise: the sparse GSI key the sweep queries |
| `reason` | on `REJECTED`: `structural:TOO_LARGE`, `structural:SIZE_MISMATCH`, `structural:TYPE_MISMATCH`, `structural:UNSUPPORTED_TYPE`, `structural:BAD_ARCHIVE`, `structural:KEY_MISMATCH`, `structural:OBJECT_CHANGED`, `structural:PROCESSING_ABANDONED`, `<validator>:<code>` from a custom validator, `<validator>:VALIDATOR_ERROR` under `onValidatorError: reject`; on `KEY_UNAVAILABLE`: the KMS error code |
| `reasonMessage` | the validator's `message`, if any |
| `validators` | list of `{validator, verdict, code?, durationMs}` in run order |
| `createdBy` | `sub` of the requesting user (an id, never user data) |
| `expiresAt` | TTL for `AWAITING_UPLOAD`/`EXPIRED`/`REJECTED` rows (30 days); `ACCEPTED` rows have no TTL |

Transitions are conditional writes on the current status and, once leased,
on `leaseOwner`; a late duplicate event for a terminal delivery deletes any
drop object left and is otherwise a no-op. Every transition that leaves
`AWAITING_UPLOAD` or `PROCESSING` for a terminal state decrements the key
row's `inFlight` in the same transaction.

---

## 5. API surface

Modelled in Smithy with the `StandardOperationVerb` validator (standard
§4.2). Two resources: `TenantKey` under `/platform`, `Delivery` under
`/tenant`.

### 5.1 Platform operations (`/platform`, IAM)

| Operation | Route | Result |
|---|---|---|
| `CreateTenantKey` | `POST /platform/tenants/{tenantId}/key` `{tier, keyArn?}` | 201 with the key row. `vendor-key`: creates the key, alias, tags, policy (§7.1), enables rotation. `tenant-key`: requires `keyArn`; `DescribeKey` under a `tenantPlatformRole` session (`KeySpec SYMMETRIC_DEFAULT`, enabled, `TenantId` tag **equal to the path's `tenantId`**), then probes **through S3** because the key policy requires `kms:ViaService` (F-7): `PutObject`, `HeadObject`, `GetObject`, `DeleteObject` of `ingest/<tenantId>/_probe/<ulid>` with the key, under the same session; writes a `KEYARN#<keyArn>` uniqueness item in the same transaction as the key row, so one key can never serve two tenants and the row is `ACTIVE` only if the pipeline will actually be able to use the key. Both tiers: creates the tenant's API key in the usage plan (N-8). 400 `UnsupportedInDeployment` when `allowTenantKeys` is off; 409 if a row or the `KEYARN#` item exists, or the drain's sentinel is present; 422 `KeyNotUsable` with the KMS error when the probe fails |
| `GetTenantKey` | `GET /platform/tenants/{tenantId}/key` | 200; refreshes `status` with a `DescribeKey` under the tenant session (`REVOKED` only when the key is disabled, pending deletion, not found, or `DescribeKey` itself is denied by the key policy; back to `ACTIVE` when it is usable), `lastKeyCheckAt` |
| `RotateTenantKey` | `POST /platform/tenants/{tenantId}/key/rotate` | 200; `vendor-key`: KMS `RotateKeyOnDemand` (the alias and ARN do not change; old material stays for decrypt); 409 `RotationLimitReached` on KMS `LimitExceededException` (25 on-demand rotations per key). `tenant-key`: 400 `UnsupportedInTier` |
| `DeleteTenantKey` | `DELETE /platform/tenants/{tenantId}/key` | 202; sets `DELETING` and removes the tenant's API key (no new presign is possible), lists and deletes the tenant's objects under both prefixes in pages of 1,000 under a `tenantPlatformRole` session, then `vendor-key`: deletes the alias and schedules key deletion; `tenant-key`: nothing on the key. Removes the row and the `KEYARN#` item in one transaction. Schedules a final prefix sweep after `uploadUrlTtlSeconds` for URLs that were in flight. Idempotent on a missing row (204) |

The vendor-key rotation story is native: automatic rotation keeps the ARN,
the alias and every old backing key, so no object is ever re-encrypted and
no `{current, previous}` bookkeeping exists.

### 5.2 Tenant operations (`/tenant`, token authoriser)

| Operation | Route | Result |
|---|---|---|
| `CreateDelivery` | `POST /tenant/deliveries` `{fileName, contentType, sizeBytes}` | 201 `{deliveryId, uploadUrl, headers, expiresAt}`. 403 without `ingestion/deliver`. 400 on a `fileName` outside `[A-Za-z0-9._-]{1,128}`, a type not in `allowedContentTypes` or a size over `maxObjectSizeBytes` (the cheap checks happen before the upload). 409 `TenantKeyUnavailable` when the key row is not `ACTIVE`. 429 `TooManyDeliveries` at `maxInFlightPerTenant`. The URL is a presigned `PUT` per §7.5 (key, bucket-key flag, `If-None-Match`, `Content-Length`, `Content-Type` all signed) under a `tenantUploadRole` session; `expiresAt = min(now + TTL, credentials.Expiration)`; `headers` repeats the signed headers so a client knows what to send |
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
deliveryId, landedKey?, keyArn, sizeBytes?, contentType?, reason?}`; never
the file name (a consumer reads it from the landed object's
`Content-Disposition`). A consumer that reads `landedKey` MUST do so under
its own tenant-scoped credentials; the event carries no presigned URL. The
bus policy denies `PutEvents` to every principal but `processorRole`
(§7.7).

---

## 6. Contracts

### 6.1 What the deployer supplies

- An OIDC issuer whose access tokens meet `ARCHITECTURE.md` §2.1 (the demo
  uses `tenant-identity`, `shared-pool`).
- Credentials with `execute-api:Invoke` on `/platform/*` for whoever onboards
  tenants.
- For a `tenant-key` tenant: a `SYMMETRIC_DEFAULT` KMS key in the tenant's
  account, tagged `TenantId=<tenantId>`, with the §7.3 key policy trusting
  the published `tenantRoleArns`. The README gives the policy verbatim with
  placeholders; `CreateTenantKey` proves it works through S3 before the row
  goes `ACTIVE`.
- Optionally an `accessLogReaderRole` (§7.4) and validator functions
  (§3.5).

### 6.2 What the sample promises

- No object under `<prefix>/<tenantId>/` is ever encrypted with a key other
  than that tenant's, and that tenant's key never encrypts or decrypts an
  object elsewhere (P-1, P-3). The integration test proves both directions
  (§10).
- No code path in the sample can read tenant B's object while acting for
  tenant A, because the tenant role's identity policy and the key policy
  both refuse (P-2). The integration test proves each wall on its own
  (§10 steps 5 and 6). Compromised function code acting for B on purpose
  is outside this promise (T-14).
- `CreateDelivery` for tenant A can only produce a URL that writes under
  `ingest/A/` with A's key (P-7).
- A revoked or deleted `tenant-key` key stops the pipeline for that tenant
  within one delivery, with `KEY_UNAVAILABLE` on the delivery and `REVOKED`
  on the key row (P-5); nothing is retried into the DLQ for that cause, and
  a pipeline fault never marks a tenant `REVOKED`.
- Every delivery reaches a terminal state: a crash, a held validator error
  or an abandoned lease ends in `ACCEPTED`, `REJECTED` or `KEY_UNAVAILABLE`
  within one sweep interval after the processor timeout (§8).
- One tenant cannot exhaust the account's STS, KMS or Lambda capacity for
  the others beyond `tenantThrottle` and `maxInFlightPerTenant` (N-8).
- `DeleteTenantKey` leaves no readable object and no alias; the key is
  pending deletion for `keyDeletionWindowDays` and costs nothing meanwhile
  (P-6). A URL that was in flight either fails or lands an object the
  processor deletes without an event.
- Clean teardown: `cdk destroy` leaves no bucket, table, API, bus, queue,
  role, alias, parameter, or log group with the sample's prefix. Keys
  created by tenants the test did not delete are scheduled for deletion by a
  registry drain on stack delete (as tenant-identity ADR-0022). The drain
  runs after the API and the platform function are deleted (CloudFormation
  dependency order) and writes a `DRAINING` sentinel row that
  `CreateTenantKey` checks in its transaction, so a create cannot race the
  drain; pending
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
| `tenantRoleArns` | the three role ARNs a `tenant-key` key policy trusts (`upload,process,platform`, comma-separated) |
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
whose tenant role can grant an agent `s3:GetObject` on
`documents/${aws:PrincipalTag/TenantId}/*` plus `kms:Decrypt` on keys tagged
with the same `TenantId`, so an agent reads only its tenant's documents; the
`tenant-key` key policy would then also have to trust that role.

---

## 7. Isolation mechanics (normative detail)

> Rewritten 2026-11-05 after the independent security review (F-1 to F-9,
> F-11 to F-15, F-18, F-23, F-28). The ABAC wall now lives in role
> **identity** policies, one tenant role per function; the key policy denies
> use to everything but those roles via S3; the presigned PUT writes once.

### 7.1 Roles

Three base roles hold no tenant permission. Three tenant roles hold the
ABAC wall in their **identity policy**, so no caller can widen or drop it
(a session policy can only narrow; the design passes none, F-1).

| Role | Assumed by | Identity policy (every statement uses `${aws:PrincipalTag/TenantId}`) |
|---|---|---|
| `apiRole` (base) | API Lambda | `sts:AssumeRole`+`sts:TagSession` on `tenantUploadRole` only; nothing on S3, KMS or the table |
| `processorRole` (base) | processor Lambda | `sts:AssumeRole`+`sts:TagSession` on `tenantProcessRole` only; `sqs:*Message` on the queue; `events:PutEvents` on the bus; `lambda:InvokeFunction` on bound validators |
| `platformRole` (base) | platform Lambda (`/platform/*`), drain, sweep | `sts:AssumeRole`+`sts:TagSession` on `tenantPlatformRole`; KMS administration (§7.2 statement 1 actions, plus `kms:CreateKey`); table-wide `dynamodb:*Item`, `Query`, `TransactWriteItems` and the sweep GSI (filtered, see below); explicit **Deny** `kms:PutKeyPolicy`, `kms:CreateGrant`, `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey*`, `kms:ReEncrypt*` |
| `tenantUploadRole` | `apiRole` | `s3:PutObject` on `ingest/${tag}/*` with `s3:x-amz-server-side-encryption = aws:kms`; `kms:GenerateDataKey` on `*` with `aws:ResourceTag/TenantId = ${tag}` and `kms:ViaService = s3.<region>.amazonaws.com`; `kms:DescribeKey` on `*` with `aws:ResourceTag/TenantId = ${tag}` (no ViaService, F-7); `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query` with `ForAllValues:StringEquals dynamodb:LeadingKeys = TENANT#${tag}` |
| `tenantProcessRole` | `processorRole` | `s3:GetObject`, `s3:DeleteObject` on `ingest/${tag}/*`; `s3:PutObject` on `documents/${tag}/*` with `s3:x-amz-server-side-encryption = aws:kms`; `kms:Decrypt`, `kms:GenerateDataKey`, with tag and ViaService as above; `kms:DescribeKey` with tag; the same DynamoDB statement |
| `tenantPlatformRole` | `platformRole` | `s3:ListBucket` with `s3:prefix` like `ingest/${tag}/*`, `documents/${tag}/*`; `s3:DeleteObject` on both prefixes; `s3:PutObject`, `s3:GetObject` on `ingest/${tag}/_probe/*` (the `tenant-key` probe, §5.1); KMS use via S3 and `DescribeKey` as above; the same DynamoDB statement |

Trust policy of each tenant role: `sts:AssumeRole` and `sts:TagSession`
from its one base role only, with `ForAllValues:StringEquals aws:TagKeys =
["TenantId"]` **and** `Null aws:RequestTag/TenantId = false` (the first
alone is true for an empty tag set) and `StringLike aws:RequestTag/TenantId
= [a-z0-9-]*`. `RoleSessionName` is `t-<tenantId>-<deliveryId | operation>`
so S3 access logs, CloudTrail and KMS logs name the tenant without a join
(F-28).

The trust policy restricts the tag **key**, not its value: compromised
function code can mint a session for any tenant, one at a time. That is the
residual the design accepts and names (P-2, threat model T-14).

`platformRole`'s table access is filtered, not enforced: `CreateTenantKey`
writes the tenant row and the `KEYARN#` item in one transaction, the drain
reads every row, and the sweep queries a sparse GSI (`statusBucket`,
`expiresAt`) across tenants. It is reached only through `/platform/*` (IAM,
vendor) and never by a tenant request (F-10).

Session lifetime: a tenant session is requested with `DurationSeconds =
3600` (a Lambda role assuming another role is role chaining, so one hour is
the cap). A function MAY cache a session per tenant for its lifetime, but
MUST presign only when the session's remaining lifetime is at least the
URL's TTL plus 60 s, and MUST report `expiresAt = min(now + TTL,
credentials.Expiration)` (F-18).

### 7.2 Key policy of a `vendor-key` key

Four statements, written once at `CreateKey` with
`BypassPolicyLockoutSafetyCheck = true` (the creating role must not hold
`kms:PutKeyPolicy`, which the lockout check would otherwise require; the
account principal in statement 3 keeps the key manageable, F-4).

1. **Administration** for `platformRole`, explicit actions only:
   `kms:CreateAlias`, `kms:DeleteAlias`, `kms:DescribeKey`,
   `kms:EnableKeyRotation`, `kms:GetKeyRotationStatus`,
   `kms:RotateKeyOnDemand`, `kms:TagResource`, `kms:UntagResource`,
   `kms:ListResourceTags`, `kms:GetKeyPolicy`, `kms:ScheduleKeyDeletion`,
   `kms:CancelKeyDeletion`. No wildcard: `kms:Create*` would include
   `kms:CreateGrant`, with which a role grants itself `Decrypt` (F-3).
2. **Use via S3, bound to the prefix** for `tenantUploadRole`,
   `tenantProcessRole` and `tenantPlatformRole`: `kms:GenerateDataKey`,
   `kms:Decrypt`, condition `kms:ViaService = s3.<region>.amazonaws.com`
   **and** `kms:EncryptionContext:aws:s3:arn` `StringLike`
   `arn:aws:s3:::<bucket>/ingest/<tenantId>/*` or
   `arn:aws:s3:::<bucket>/documents/<tenantId>/*`. A separate statement
   grants the same three roles `kms:DescribeKey` with no condition (a direct
   call has no ViaService and no context, F-7).
3. **Account administration.** `arn:aws:iam::<account>:root` (the account
   principal, which lets IAM identity policies in the vendor account reach
   the key) gets the statement 1 actions plus `kms:PutKeyPolicy`, so the key
   never becomes unmanageable. It gets **no** use action and no
   `kms:CreateGrant`.
4. **Deny use to everyone else.** `Deny` `kms:Encrypt`, `kms:Decrypt`,
   `kms:GenerateDataKey*`, `kms:ReEncrypt*`, `kms:CreateGrant` to `*`
   unless `aws:PrincipalArn` is one of the three tenant roles **and**
   `kms:ViaService` is S3 **and** the encryption context matches the
   prefix. An administrator who wants to read a tenant's documents has to
   call `PutKeyPolicy` first, which CloudTrail records and a metric filter
   alarms on (threat model M-29). That is the residual (F-5): the binding
   holds against every identity policy in the account, and against the
   account principal until it rewrites the policy.

S3 Bucket Keys MUST stay off on the bucket **and** on every request: the
presigned PUT and the `CopyObject` carry
`x-amz-server-side-encryption-bucket-key-enabled: false` (a per-object
bucket key would replace the object ARN with the bucket ARN; statement 4
then denies, which fails closed but would reject a valid delivery, F-23).
The cost is one KMS request per object write and per object read.

### 7.3 Key policy of a `tenant-key` key (template the README gives verbatim)

In the tenant's account, on a `SYMMETRIC_DEFAULT` key tagged
`TenantId=<tenantId>`:

- **Use via S3, bound to the prefix** for the vendor's `tenantUploadRole`,
  `tenantProcessRole` and `tenantPlatformRole` ARNs (published as
  `tenantRoleArns`, §6.3): `kms:GenerateDataKey`, `kms:Decrypt` with
  `kms:ViaService = s3.<region>.amazonaws.com` and
  `kms:EncryptionContext:aws:s3:arn` like
  `arn:aws:s3:::<bucket>/ingest/<tenantId>/*`,
  `arn:aws:s3:::<bucket>/documents/<tenantId>/*`.
- **`kms:DescribeKey`** for the same three roles, no condition.
- The tenant's own administration statements are the tenant's business; the
  sample never asks for more than the two statements above and never asks
  for a grant.

Both sides have to agree: the vendor's identity policy reaches only keys
tagged with the session's tenant, and the tenant's key policy trusts only
the vendor's three roles via S3 on the tenant's own prefix. Whether
`aws:ResourceTag/TenantId` evaluates against a key in another account is
not shown in AWS documentation; the integration test runs a real second
account before the tier is called proven (§10 step 1), and ADR-0004 names
the fallback (the identity policy names the registered `keyArn` list).

### 7.4 Bucket policy

- Deny any request without TLS (`aws:SecureTransport = false`).
- Deny `s3:PutObject` unless `s3:x-amz-server-side-encryption = aws:kms`
  (also catches a missing header: a negated operator on an absent key is
  true).
- Deny `s3:PutObject` to `ingest/*` when `s3:if-none-match` is `Null`, so
  every drop object is written exactly once and a presigned URL cannot
  overwrite (F-11).
- Deny `s3:PutObject` when `s3:x-amz-server-side-encryption-bucket-key-enabled = true`.
- Deny `s3:*` when `s3:signatureAge` exceeds `uploadUrlTtlSeconds * 1000`
  ms, so a leaked URL dies with its TTL even if the session outlives it.
- Server access logging to a **separate** log bucket (SSE-S3, which access
  logging requires; `DESTROY`, auto-delete, same retention as the drop plus
  30 days). Access logs record the presigned query string including
  `X-Amz-Signature` and `X-Amz-Credential`; the log bucket therefore allows
  `s3:GetObject` to one log-reader role only (F-14).
- `AbortIncompleteMultipartUpload` after 1 day on `ingest/`; lifecycle
  expiry on `ingest/` after `dropRetentionDays`.

### 7.5 The presigned PUT

Signed under a `tenantUploadRole` session for tenant `<tenantId>`, method
`PUT`, key `ingest/<tenantId>/<deliveryId>` (no file name in the key,
F-13), with these headers in `X-Amz-SignedHeaders`, so a changed or
missing value fails the signature:

| Header | Value |
|---|---|
| `x-amz-server-side-encryption` | `aws:kms` |
| `x-amz-server-side-encryption-aws-kms-key-id` | the tenant's `keyArn` |
| `x-amz-server-side-encryption-bucket-key-enabled` | `false` |
| `If-None-Match` | `*` |
| `Content-Length` | the declared `sizeBytes` (F-12) |
| `Content-Type` | the declared `contentType` |

`CreateDelivery` returns the same headers so a client knows what to send.
Whether S3 accepts **extra unsigned** `x-amz-*` headers on a query-signed
PUT (for example `x-amz-tagging`) is not documented; the integration test
tries one (§10 step 4) and the result is recorded in `architecture.md`.

### 7.6 Where the tenant id comes from

| Path | Source | Why it is trusted |
|---|---|---|
| `/tenant/*` | `tenant_id` claim | signed by the issuer, verified by the authoriser; the handler, not the authoriser, enforces the scope per route (the authoriser's policy is cached per token for up to 300 s, so a route-specific policy would be wrong on the next route; the 300 s is the revocation lag, F-16) |
| processor | the second path segment of the object key | only a presigned URL from the API can write under `ingest/`, and the API fixes the key under the token's tenant (P-7); the processor assumes the tenant session for that id first and then loads the delivery row under it (`LeadingKeys` makes a wrong id a `AccessDenied`, never another tenant's row) |
| `/platform/*` | path parameter | vendor-only, IAM-authenticated; the vendor is trusted to name tenants. For `tenant-key`, the key's `TenantId` tag MUST equal the path parameter |

### 7.7 Queue and bus policies

Within one account an identity Allow is enough to reach a queue or a bus,
so Allow-only resource policies are filtered. The construct adds explicit
denies (F-15):

- Queue: `Deny sqs:SendMessage` unless `aws:SourceArn` is the EventBridge
  rule ARN. DLQ: `Deny sqs:SendMessage` unless the principal is the source
  queue's redrive (`aws:SourceArn` of the queue).
- Bus: `Deny events:PutEvents` unless `aws:PrincipalArn` is `processorRole`.
- Both queues use SSE-SQS. The EventBridge target has a retry policy (24 h,
  185 attempts) and its own DLQ.

A forged `Object Created` message is harmless even so: the processor acts
only under the tenant session for the key's prefix and only on a row in
`AWAITING_UPLOAD` (P-2, §8).

---

## 8. Pipeline

```
tenant PUT (presigned, If-None-Match: *) ──► s3://<bucket>/ingest/<tenantId>/<deliveryId>
   └─ Object Created ──► EventBridge rule (prefix ingest/) ──► SQS (+ DLQ, 3 receives)
        ──► processor Lambda (base role: processorRole)
              0. tenantId, deliveryId from the key; a third segment `_probe` -> delete the event, stop
              1. assume tenantProcessRole {TenantId}, RoleSessionName t-<tenantId>-<deliveryId>
              2. load the delivery row under that session. Missing or DELETING -> delete the drop object, stop.
                 Terminal -> delete the drop object if present, stop.
                 AWAITING_UPLOAD -> PROCESSING with leaseOwner = messageId, leaseUntil = now + processor timeout
                 PROCESSING with leaseOwner == messageId, or leaseUntil < now -> take the lease again, continue
                 PROCESSING with a live lease held by another message -> stop (duplicate in flight)
              3. HeadObject: SSEKMSKeyId == key row's keyArn, else REJECTED structural:KEY_MISMATCH
                 BucketKeyEnabled -> REJECTED structural:KEY_MISMATCH
                 ContentLength == declaredSizeBytes and <= max, else REJECTED structural:TOO_LARGE | SIZE_MISMATCH
                 record dropEtag on the row
              4. GetObject (IfMatch = dropEtag, streamed): magic bytes vs declared type; ZIP central directory sane; sha256
              5. for each validator in order (P-11, §3.5):
                   presign GET (tenantProcessRole session, validatorObjectUrlTtlSeconds, IfMatch) -> Invoke -> verdict
                   REJECT -> row REJECTED <name>:<code>, delete drop, event, stop
                   error/timeout/bad verdict -> onValidatorError (hold: throw; reject: as REJECT); log errorType only
              6. CopyObject -> documents/<tenantId>/<deliveryId>, SSE-KMS same key, bucket-key-enabled false,
                 CopySourceIfMatch = dropEtag, Content-Disposition from the row's fileName
                 PreconditionFailed -> REJECTED structural:OBJECT_CHANGED, delete drop, event, stop
              7. DeleteObject on the drop; row -> ACCEPTED (conditional on leaseOwner); counters; event
   KMS-sourced error at 3-6 (S3 surfaces the KMS error code; the processor matches on the KMS code, never on a bare
   AccessDenied) -> DescribeKey under the session; if the key is disabled, pending deletion, not found, or DescribeKey
   itself is denied -> row KEY_UNAVAILABLE, key row REVOKED, event, message deleted (no retry);
   otherwise the error is the pipeline's own -> throw (SQS retry, then DLQ)
   any other error -> throw (SQS retry, then DLQ)
```

The processor's timeout is computed at synth: structural budget plus the
sum of validator timeouts plus the copy budget, capped at 15 minutes; a
chain that does not fit fails synth with the validator names and their
timeouts. The queue's visibility timeout is six times that value; the DLQ
retains messages for 14 days, longer than any drop object lives.

Idempotency and liveness: `PROCESSING` is a **lease**, not a terminal
state (F-8). A retry of the same SQS message, an operator's DLQ replay, and
a redrive after a crash all re-enter at step 2 and continue; a second
message for the same object while the lease is live exits. A conditional
write on `leaseOwner` guards every later transition, so two processors
never both land the same delivery. The drop object's ETag, read once at
step 3, pins steps 4, 5 and 6 to the validated bytes; the bucket policy's
`If-None-Match` makes an overwrite impossible in the first place, and the
ETag check is the proof.

The hourly sweep (`platformRole`, sparse GSI on `statusBucket`) flips
`AWAITING_UPLOAD` rows past `expiresAt` to `EXPIRED`, and `PROCESSING` rows
whose `leaseUntil` is more than one processor timeout in the past to
`REJECTED structural:PROCESSING_ABANDONED` (deleting the drop object under
the tenant session). It also re-checks every `REVOKED` key row with
`DescribeKey` and flips it back to `ACTIVE` when the key is usable again,
so recovery needs no vendor call (ADR-0005, F-20).

---

## 9. Non-functional requirements

- **N-1 Latency.** `CreateDelivery` p50 under 300 ms (one `AssumeRole`
  when the cached session is too old to presign, one conditional put, one
  presign). A 100 MiB delivery is accepted within 60 s of the upload
  completing.
- **N-2 Throughput.** 1,000 deliveries per minute across tenants with no
  design change: the queue absorbs bursts. KMS symmetric request quota is
  10,000, 20,000 or 100,000 rps per account and Region (by Region), two
  orders above the four to six calls per delivery (one `GenerateDataKey`
  on the upload, one `Decrypt` for the processor's read, one `Decrypt` per
  validator `GET`, one `Decrypt` plus one `GenerateDataKey` on the copy).
  `tenant-key` traffic is throttled against the **vendor's** quota (the
  caller's account), not the tenant's (F-22).
- **N-3 Scale.** 10,000 tenants: 10,000 keys (KMS default quota 100,000
  per account and Region, counting keys pending deletion, F-25), one
  bucket, one table. No per-tenant policy, no per-tenant statement, no
  per-tenant stack. STS `AssumeRole` is 600 rps per account, shared with
  everything else in the account, so per-tenant limits (N-8) are not
  optional at scale (F-17).
- **N-4 Deploy and destroy time.** Construct deploys in under 5 minutes;
  `CreateTenantKey` returns in under 3 s (`vendor-key`) or 10 s
  (`tenant-key`, the S3 probe round trip); `cdk destroy` completes in under
  5 minutes. Keys pending deletion are the one thing that survives, by KMS
  design and at no cost.
- **N-5 Cost of an idle tenant.** $1 per month (`vendor-key`), $0
  (`tenant-key`), stated in the README with the per-delivery request cost.
- **N-6 No plaintext at rest, anywhere.** Drop, landed objects, SQS
  messages (no content, only keys), Lambda logs (no content, no presigned
  URLs, no file names). Residual: S3 server access logs record the
  presigned request URI including the signature; they live in a separate
  bucket readable by one role, and the signature is dead after the TTL and
  single-use (§7.4, F-14).
- **N-7 Standard compliance (sample standard §4.3, §4.4).** cdk-nag
  `AwsSolutionsChecks` in `src/main.ts`; an explicit `LogGroup` with
  `DESTROY` and `logRetention` for every function (Lambda's implicit log
  group would survive `cdk destroy`); SSE-SQS on both queues; the access-log
  bucket with `DESTROY` and auto-delete; `AbortIncompleteMultipartUpload`
  on `ingest/`; an EventBridge target DLQ; each asserted by a template test
  (F-27).
- **N-8 Per-tenant limits.** `/tenant/*` is throttled per tenant with one
  usage plan and an API key per tenant (as tenant-identity ADR-0025), the
  key id stored on the key row and the key issued at `CreateTenantKey`.
  `CreateDelivery` increments an `inFlight` counter on the key row in the
  same conditional write as the delivery row and refuses with 429
  `TooManyDeliveries` at `maxInFlightPerTenant` (prop, default 100); the
  processor decrements it at every terminal transition and the sweep
  reconciles it. Together they bound one tenant's STS, KMS, Lambda and
  validator consumption (F-17, F-29).

---

## 10. Acceptance criteria (integration test outline)

The integration test is the reference implementation (standard §5.2). CDK
CLI driver (`scripts/integ.sh`), one Region, stacks: `tenant-identity`
(`shared-pool`, deployed through its own path or reused if detected), the
demo stack, and a **test-aid stack** with: a `TestProbeRole` whose identity
policy allows `s3:*` on the bucket and `kms:*` on `*` (so a denial it meets
can only come from a key policy or a bucket policy, F-19), a
`TestConsumerRole` shaped like a downstream consumer (`s3:GetObject` on
`documents/${aws:PrincipalTag/TenantId}/*`, KMS `Decrypt` via S3 with the
tag condition), and, when the context `tenantKeyAccount` names a second
account the runner can assume into, the `tenant-key` key is created
**there**; otherwise in the test account, and the README says the
cross-account claim is then unproven. Steps, in README order:

1. **Two tenants, two tiers.** `CreateTenantKey A vendor-key`; create a
   second KMS key tagged `TenantId=B` with the §7.3 key policy trusting the
   published `tenantRoleArns` (in `tenantKeyAccount` when set),
   `CreateTenantKey B tenant-key keyArn`. Both `ACTIVE`; the probe object
   `ingest/B/_probe/*` is gone and produced no delivery. `CreateTenantKey B
   tenant-key` with a key missing the tag, or tagged with another tenant's
   id -> 422 `KeyNotUsable`. `CreateTenantKey C tenant-key` with B's
   `keyArn` -> 409 (`KEYARN#` uniqueness).
2. **Register users.** Two tenant users via `tenant-identity`, tokens with
   `ingestion/deliver ingestion/read`; one token with `ingestion/read`
   only.
3. **Happy path, both tiers.** `CreateDelivery` for A and B, upload a
   synthetic PDF with the returned headers, poll `GetDelivery` to
   `ACCEPTED`; `HeadObject` on `landedKey` shows the tenant's key and the
   `Content-Disposition` file name; a `DeliveryAccepted` event arrived on
   the bus. The read-only token's `CreateDelivery` -> 403 from the handler,
   and its `GetDelivery` right after -> 200 (the authoriser cache did not
   leak the scope decision, F-16).
4. **The uploader cannot change the request.** PUT to A's URL with
   `x-amz-server-side-encryption-aws-kms-key-id` set to B's key -> 403
   (`SignatureDoesNotMatch`). PUT with no SSE header -> 403. PUT with a
   different `Content-Length` -> 403. A second PUT to the same URL -> 412
   (`PreconditionFailed`, `If-None-Match`). PUT with an extra unsigned
   `x-amz-tagging` header: the outcome is recorded, not asserted.
5. **Key binding, both directions, each wall alone.** Under `TestProbeRole`
   (broad identity policy): `PutObject` to `ingest/B/x` naming A's key ->
   403 with a KMS message (A's key policy statement 4 alone, since nothing
   else denies the probe role); `PutObject` to `ingest/A/y` naming A's key
   with `bucket-key-enabled: true` -> 403 (bucket policy). Under a
   `tenantUploadRole` session for A: `PutObject` to `ingest/B/x` -> 403
   from S3 (identity policy, before KMS). Error sources are asserted by
   message, not by exception class.
6. **Cross-tenant read.** Under a `TestConsumerRole` session for A:
   `GetObject` A's landed object -> 200; `GetObject` B's landed object ->
   403 from S3 (identity policy). Under `TestProbeRole` with no tag:
   `GetObject` B's landed object -> 403 with a KMS message (key policy
   alone).
7. **Rejections.** Declared `application/pdf`, upload a ZIP -> `REJECTED
   structural:TYPE_MISMATCH`; oversize declared -> 400 at `CreateDelivery`;
   a URL left unused past its TTL -> `EXPIRED` after the sweep (the test
   sets a short TTL via context); `CreateDelivery` past
   `maxInFlightPerTenant` (set to 2 via context) -> 429.
7b. **Custom validators.** The demo stack wires two `LambdaValidator`s:
   the shipped `pdf-pages` example (limit 3 pages) and a test validator
   `always-error` that throws with `objectUrl` in its error message.
   Upload a 5-page PDF -> `REJECTED pdf-pages:TOO_MANY_PAGES`,
   `reasonMessage` set, `validators` on the row lists `structural ACCEPT`
   then `pdf-pages REJECT`, and `always-error` was never invoked (chain
   stopped). Upload a 2-page PDF with `always-error` enabled via context ->
   under `onValidatorError: hold` the message lands in the DLQ, the row is
   `PROCESSING`, and the object is still in the drop; a DLQ redrive with
   `always-error` disabled finishes the delivery `ACCEPTED` (the lease
   re-entry, F-8); under `reject` the row is `REJECTED
   always-error:VALIDATOR_ERROR`. The test asserts the validator's log line
   carries `tenantId` and `durationMs`, and that no Lambda log line
   contains `X-Amz-Signature` or the file name.
7c. **Abandoned lease.** With the processor's concurrency set to 0 via
   context after the upload, wait past the lease and run the sweep ->
   `REJECTED structural:PROCESSING_ABANDONED`, drop object gone.
8. **Revocation (`tenant-key`).** Disable B's key; `CreateDelivery` B,
   upload -> `KEY_UNAVAILABLE`, key row `REVOKED`, `DeliveryKeyUnavailable`
   event, DLQ empty, `CreateDelivery` B -> 409. Re-enable; the sweep (or
   `GetTenantKey`) -> `ACTIVE`; a new delivery succeeds. Remove the vendor
   roles from B's key policy instead of disabling -> the same path, with
   the KMS access-denied code, and no `REVOKED` is set for an S3
   `AccessDenied` the test provokes with a wrong bucket policy on a scratch
   prefix (F-20).
9. **Rotation (`vendor-key`).** `RotateTenantKey A` -> 200; the object
   landed in step 3 still reads under `TestConsumerRole` for A;
   `RotateTenantKey B` -> 400 `UnsupportedInTier`; the 26th
   `RotateTenantKey A` is not attempted, the 409 mapping is a unit test.
10. **Observability.** The processor log group holds one structured line
    per delivery with `tenantId`, `deliveryId`, `status`, `sizeBytes`,
    `kmsRequests`; the S3 access log's `Requester` carries the
    `t-<tenantId>-...` session name; the Contributor Insights rules exist;
    the metered `kmsRequests` equals the CloudTrail KMS event count for the
    delivery (sampled once).
11. **Offboarding.** `CreateDelivery A` (URL in flight), then
    `DeleteTenantKey A` -> 202; objects under both A prefixes gone; alias
    gone; key `PendingDeletion`; `CreateDelivery` with A's token -> 409;
    the in-flight URL's PUT -> 403 (bucket policy `signatureAge` or key
    pending deletion) or, if it lands, the processor deletes it and no
    event is published. `DeleteTenantKey B` -> B's key untouched, row and
    `KEYARN#` item gone.
12. **Teardown.** `cdk destroy --all`; nothing with the sample's prefix
    remains (buckets, table, API, bus, queues, roles, aliases, parameters,
    log groups, API keys and usage plan) except keys pending deletion,
    which the test lists and reports.

Runtime target: under 30 minutes, under $1 per run.

---

## 11. Extension seams (documented, not built)

- **Sealed drop tier.** An asymmetric KMS key per tenant whose public key the
  tenant uses offline to wrap a data key; the processor unwraps with
  `kms:Decrypt`. Gives a drop S3 never sees in plaintext, at the price of
  tenant-side tooling and a vendor-defined envelope format.
- **Transfer endpoint.** AWS Transfer Family (SFTP) in front of `ingest/`,
  one server, per-tenant users mapped to `tenantUploadRole` sessions (§7.1).
- **Step Functions carrier for validators.** A second `IDeliveryValidator`
  carrier (`'state-machine'`) that runs the same §3.5 request and verdict
  as a Step Functions task, for scans longer than a Lambda invoke or for
  parallel branches. Validators do not change; the processor starts an
  execution and waits for a callback instead of invoking.
- **Malware scan** as a custom validator (a GuardDuty Malware Protection
  for S3 finding, or a scanner container behind a Lambda).
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

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Tenant Encrypted Ingestion: Threat Model

> Status: **Draft from the specification, 2026-11-05; not yet verified by
> an integration run.** 37 threats (T-1 to T-37), 33 mitigations (M-1 to
> M-33), 12 accepted risks. Enumerated STRIDE-per-boundary with the
> threat-modelling MCP server (export kept out of the repository); reviewed
> three times by independent blind reviewers before implementation
> ([appendix A](#appendix-a-review-history)).

Written from
[`design/tenant-encrypted-ingestion.spec.md`](./design/tenant-encrypted-ingestion.spec.md)
(P-1 to P-11, §3 to §5, §7.0 to §7.7, §8 to §11) and
[ADR-0001](./adr/0001-encrypt-server-side-with-sse-kms-and-one-kms-key-per-tenant.md)
to
[ADR-0012](./adr/0012-deliver-the-pattern-as-a-construct-with-per-tenant-observability.md).
No code exists yet: every "planned location" names the file the
implementation must put the control in, and the unit test, template test
or integration step named in the same row is the check that will prove it.
Integration steps are spec §10's numbering. Security scans ran 2026-11-06
(last section).

Scope: the `TenantEncryptedIngestion` construct (one versioned ingestion
bucket with the `ingest/` and `documents/` prefixes and its separate
access-log bucket; one KMS key per tenant in the `vendor-key` or
`tenant-key` tier; the seven base roles and three tenant roles of spec
§7.1; the ingestion API with its token authoriser and the optional
per-tenant throttle; the EventBridge rule on the default bus, the SQS queue,
its DLQ and the EventBridge target DLQ; the processor, the hourly sweep, the
registry watch on the DynamoDB stream and the stack-delete drain; the custom
validator chain; the DynamoDB registry; the construct's event bus, logs and
Contributor Insights), the demo stack and its published SSM parameters, the
example validator, and the integration test's test-aid stack. Out of scope:
how `tenant-identity` issues tokens (its own threat model), what a consumer
does with a landed document, what a deployer's validator checks beyond the
spec §3.5 contract, the tenant's AWS account beyond the key it registers,
and the internals of S3, KMS and STS (AWS shared responsibility).

## Actors

| Actor | Trust | What they hold |
|---|---|---|
| Tenant user | authenticated, one tenant | a `tenant-identity` access token (`tenant_id`, `sub`, `client_id`, `scope`); one presigned PUT per delivery |
| Malicious tenant user | authenticated, one tenant | a valid token for tenant B and the will to reach tenant A's prefix, key or rows, or to run up the vendor's bill |
| Internet caller | none | forged, expired or replayed tokens; load |
| Holder of a leaked URL or token | none, borrows a tenant's | a presigned PUT or GET, or a token, found in a log, a proxy or a client |
| Vendor operator | administrative | IAM credentials with `execute-api:Invoke` on `/platform/*`; optionally `redriveOperatorRole` |
| Other IAM principal in the vendor account | elevated, outside the construct | identity policies that may allow `sts:AssumeRole`, `sqs:SendMessage`, `events:PutEvents`, `ssm:PutParameter`, `s3:*` on the buckets, log reads |
| Account principal of the vendor account | full, through IAM | key policy statement 3 of every `vendor-key` key: administration and `kms:PutKeyPolicy`, no use, grant or tag action |
| Compromised tenant-path function code | caller-influenced | API and processor and sweep code: its base role (`apiRole`, `processorRole`, `sweepRole`) and its one tenant role (`tenantUploadRole`, `tenantProcessRole`) for any tenant id that passes the trust guard |
| Compromised platform-side function code | caller-influenced | `keyFactoryRole` (`CreateKey` with a policy of its choosing, one tag set at create, `PutItem` of `KEY`, `KEYARN#`, `SYSTEM` items) or `platformRole` (KMS administration without create, tag, grant or use; table-wide reads and writes except `keyArn`, `tier`; `DeleteItem`); each with `tenantPlatformRole` |
| Compromised authoriser or watch code | caller-influenced | `authoriserRole` (logs only) or `watchRole` (the stream, metrics, `SYSTEM` items) |
| Tenant AWS account (`tenant-key`) | external, owns one key | a KMS key tagged `TenantId`, trusting the tenant and consumer roles via S3; can withdraw that at any time |
| Validator | deployer-owned, no AWS permission from the construct | one presigned, ETag-pinned GET per call, reusable until `validatorObjectUrlTtlSeconds` |
| Consumer | deployer-owned | a consumer role in `consumerRoles`, used under its own tenant session; `Delivery*` events |
| S3 service | AWS | calls KMS for the caller (`kms:ViaService`), always a tenant-scoped session |
| Integration runner | test account only | `TestProbeRole`, `TestConsumerRole`, `TestScratchWriterRole`; refused outside an account tagged `tei:test-account` or marked by the SSM parameter `/tenant-encrypted-ingestion/test-account` |

## Assets

| Asset | Why it matters |
|---|---|
| Tenant documents in `ingest/` (unvalidated) and `documents/` (landed), with noncurrent versions | The most sensitive data the vendor holds; landed versions recoverable for 7 days |
| Tenant KMS keys and their `TenantId` tag | The boundary between tenants (P-1); the tag admits a key to a tenant session; deleting the key offboards the tenant (P-6) |
| The tenant-to-key binding (`KEY` row `keyArn`, `tier`, `keyStatus`; the `KEYARN#` item) | Decides which key every future document of a tenant is encrypted with |
| Tenant role sessions | Reach one tenant's prefixes, key and registry partition (P-2) |
| Tenant id | Becomes a prefix segment, a session tag and part of a session name; its grammar is part of the isolation (§7.0) |
| Tenant access token | The only tenant source on `/tenant/*` |
| Presigned PUT and GET URLs | The PUT writes once for a declared size; the GET reads one object version for minutes |
| Registry rows | Delivery status, leases, counters, `inFlight`, the file name |
| Events, queue and DLQ messages | Tell consumers what landed; S3 events carry the uploader's IP address |
| Logs, metrics, access logs, CloudTrail | Carry the tenant, never content, URLs or file names (P-9, N-6) |
| Registry backups (PITR) | File names and hashes, never content, for 35 days |
| Shared quotas (STS, KMS, Lambda, API keys, KMS keys) | One tenant must not exhaust them for the others (N-3, N-8) |
| Published parameters | Tell consumers and `tenant-key` owners the API and the roles to trust |

## Trust boundaries

| Boundary | Crossed by | Authenticated and authorised by | Layer (`ARCHITECTURE.md` §3.3) |
|---|---|---|---|
| B1 Tenant ↔ vendor API | `/tenant/*` with a bearer token; `/platform/*` with SigV4 | token authoriser and handler scope (M-1, M-2), field grammar (M-3), IAM on `/platform/*` (M-4), per-tenant limits (M-5) | Identity |
| B2 Tenant upload → bucket | presigned `PUT` with six signed headers | the `tenantUploadRole` session's signature and identity policy (M-6, M-12), the bucket policy (M-7, M-8), the processor's checks (M-9) | Data |
| B3 Vendor code → tenant role session | `AssumeRole` + `TagSession` from each base role to its one tenant role | trust policies and grammar (M-13), ABAC identity policies (M-12), role asymmetry (M-14), tenant id from the key (M-15) | Data |
| B4 S3 ↔ KMS | `GenerateDataKey`, `Decrypt` with `kms:ViaService` | key policy statements 2, 2b, 4a-i, 4a-ii, 4b, 4c; Bucket Keys off (M-17) | Data |
| B5 Vendor account ↔ tenant account | KMS calls on a `tenant-key` key, cross-account | the tenant's key policy, the tag in the identity policies, admission checks (M-19), the probe (M-18) | Data |
| B6 Processor ↔ validator | `lambda:InvokeFunction` with the §3.5 request; the validator's GET | invoke grant, tenant-signed pinned GET, verdict schema (M-20, M-21) | Data |
| B7 Vendor administration ↔ keys, registry and bucket | key creation (`keyFactoryRole`), administration, offboarding and the drain (`platformRole`), the sweep, the account principal | key policy statements 1, 3 and 5 (M-17), the factory's bounds (M-22), registry write rules and watch (M-23, M-24), alarms (M-25), offboarding (M-26), versioning (M-8) | Data |
| B8 Pipeline → consumers | `Delivery*` events on the construct's bus; `GetObject` of `landedKey` | bus policy (M-16), events and consumer roles (M-29) | Data |
| B9 Everything → telemetry, queues, backups and parameters | logs, access logs, metrics, queue bodies, PITR, SSM | logger allowlist and access-log reader Deny (M-27), metering (M-28), parameters (M-30), standard settings (M-31) | Observability |
| B10 Integration runner → test account | the test-aid stack's roles, scratch bucket and scratch key | account tag gate, scoped test roles, teardown check (M-32, M-33) | Data |

## Threats

STRIDE per boundary: S spoofing, T tampering, R repudiation, I information
disclosure, D denial of service, E elevation of privilege. One threat per
control: where two earlier threats attacked the same control from two
sides, they are one row here.

| ID | Boundary | STRIDE | Threat |
|---|---|---|---|
| T-1 | B1 | S | An internet caller or tenant user presents a forged, expired, ID, other-client or multi-tenant token, or one whose `tenant_id` breaks the §7.0 grammar, and is served as a tenant. |
| T-2 | B1 | E | A token holding only `ingestion/read` creates a delivery, directly or through an authoriser decision cached for another route. |
| T-3 | B1 | I | A tenant user of A names tenant B in a body, header, query or path, guesses B's `deliveryId`, or reads B's id or key ARN from an error, and reaches B's rows or metadata. |
| T-4 | B1 | T | A tenant user sends a `fileName` with separators, quotes, control characters or excess length, forging a `Content-Disposition` or injecting into logs. |
| T-5 | B1 | E | A caller without vendor IAM credentials reaches `/platform/*` and creates, rebinds, rotates or offboards a tenant key. |
| T-6 | B1 | D | One tenant loops `CreateDelivery`, uploads or validator-heavy deliveries, or onboarding at scale meets the STS, KMS, Lambda, API key or KMS key quotas, throttling every other tenant (noisy neighbour). |
| T-7 | B2 | T | An uploader changes the presigned PUT: edits the path to another tenant, swaps or drops the SSE headers, turns the bucket key on, sends a different size or type, adds unsigned storage-class, redirect or ACL headers, or uses plain HTTP; or the presigner signs too little, so the URL carries no bound at all. |
| T-8 | B2 | T | An uploader writes the drop object again during or after validation, so the bytes that land differ from the bytes the chain checked. |
| T-9 | B2 | S | A holder of a leaked PUT URL uploads a document of its choosing as the tenant, before or after the tenant's own upload. |
| T-10 | B2 | T | An uploader sends content that differs from the declared type, a polyglot or an archive bomb, to land malformed content or exhaust the processor. |
| T-11 | B3 | E | Compromised tenant-path function code assumes its tenant role with tenant B's `TenantId` (the trust policy fixes the tag key, not its value) and acts as B, one session at a time. |
| T-12 | B3 | E | A tenant session is minted outside the function that owns it, with extra tags or none, or with a tenant id containing `/` or another separator so one tenant's `${tag}` paths and key context cover another's; or the trust guard is written so that every `AssumeRole` fails and an implementer widens it to `*`. |
| T-13 | B3 | E | Function code uses its base role without a tenant session, or another function's powers, to reach documents, keys or the registry: the wall placed in a session policy the caller may omit, the API reading objects, the sweep landing, the authoriser reading API key values. |
| T-14 | B3 | S | The processor takes the tenant id from object metadata, event detail or a file name instead of the key, or acts on a forged or replayed `Object Created` message; or the queue's Deny also refuses its legitimate senders and an operator redrive. |
| T-15 | B3 | T | At-least-once delivery, concurrent receives, an eventually consistent read or a crash between steps lands one delivery twice, deletes a valid upload, double-counts, or loses or duplicates the terminal event. |
| T-16 | B3 | D | Lease, sweep and lifetime timing disagree: a delivery stays `PROCESSING` for ever, the sweep abandons or expires a delivery SQS or the uploader is still working on, or a URL or session dies before the work it was issued for. |
| T-17 | B4 | E | The key-policy Deny does not hold: a tenant's key is used on another tenant's prefix, called directly instead of via S3, used by a principal with a mistaken Allow or a grant, or loses its prefix binding because a bucket key put the bucket ARN in the context; or the Denies are composed so they fire only when every condition fails. |
| T-18 | B5 | D | The tenant withdraws, disables or deletes a `tenant-key` key mid-flight, or a pipeline fault surfaces as the same S3 `AccessDenied`, and the pipeline retries into the DLQ, calls a missing key a corrupt file, or marks a healthy tenant `REVOKED`. |
| T-19 | B5 | E | A `tenant-key` registration admits the wrong key: tagged for another tenant, already serving a tenant, spelled as an alias or bare id, in another Region, multi-Region, in the vendor's own account; or `aws:ResourceTag/TenantId` does not evaluate on a key in another account as the identity policies assume. |
| T-20 | B5 | I | S3, the processor and every validator see each document in plaintext in flight behind TLS and in memory, so a tenant expecting a vendor-blind drop is mistaken. |
| T-21 | B6 | I | A validator copies the document out, persists or logs its URL, echoes the URL in an error body, or returns document content in its verdict `message`. |
| T-22 | B6 | E | A validator obtains AWS credentials from the processor or reaches an object other than the one it was given; or a deployer widens the processor's permissions to reach a cross-account validator. |
| T-23 | B6 | T | A malformed, empty or unexpected verdict, a function error or a timeout is read as `ACCEPT`; or a compromised validator accepts what the deployer's rule would refuse. |
| T-24 | B6 | D | A validator hangs, throttles or fails on every call, wedging every tenant's deliveries or multiplying Lambda cost and concurrency per delivery. |
| T-25 | B7 | E | A vendor operator or IAM administrator reads tenant documents outside the pipeline: a platform role decrypting, granting itself `Decrypt`, retagging a key, or `PutKeyPolicy` through the account principal. |
| T-26 | B7 | T | Tenant-role code touches the binding: rewrites `keyArn`, `tier` or `keyStatus`, replaces or deletes a key row whole, or stores a usage key value beside it. |
| T-27 | B7 | T | Platform-side code rebinds a tenant: `keyFactoryRole` creates a key with a policy it chose, binds a new tenant to it or rewrites an existing tenant's `KEY` row, and `platformRole` removes a row so a re-onboarding takes another key, while every pipeline check agrees with the rewritten row. |
| T-28 | B7 | D | Offboarding goes wrong: the wrong tenant, a `DeleteTenantKey` that stops half way or cannot list a prefix, a URL used after the purge, a key created while the stack is deleted and never scheduled, a key deletion cancelled during the window. |
| T-29 | B7 | D | A vendor principal or code under a tenant role overwrites or deletes landed documents, or the bucket's own delete Denies block `cdk destroy`. |
| T-30 | B8 | I | A consumer reads landed documents or `ingest/` with a broad role instead of a tenant session, or no consumer can read at all because the key policy admits only the pipeline. |
| T-31 | B8 | S | A vendor principal publishes a forged `DeliveryAccepted`, a consumer acts twice on a repeated event, or a rule in the vendor account reads every tenant's events. |
| T-32 | B9 | I | A presigned URL with its signature, a file name, an uploader's IP address or registry images reach Lambda logs, access logs, CloudTrail, the KMS context, queue bodies or backups, and are read or replayed there. |
| T-33 | B9 | R | A delivery, a revocation, an API call or a cost cannot be attributed to a tenant, so a dispute or a bill cannot be settled. |
| T-34 | B9 | T | A vendor principal with `ssm:PutParameter` overwrites the published `apiUrl`, `tenantRoleArns` or `consumerRoleArns`, sending consumers elsewhere or a `tenant-key` owner trusting the wrong roles. |
| T-35 | B9 | I | The sample deviates from the sample standard: log groups survive `cdk destroy`, queues are unencrypted, multipart uploads linger, events drop on target failure, cdk-nag findings go unaddressed. |
| T-36 | B10 | E | An integration step passes on the wrong denial (a missing Allow, the identity policy, a tag mismatch) so a wall it claims to prove is absent, or a wall cannot be reached by the test at all. |
| T-37 | B10 | E | The test-aid roles outlive the run or reach a shared account, becoming a skeleton key over every tenant key and the bucket policy. |

## Mitigations

Each mitigation names the principle and ADR it realises, the planned code
location, and the test that will prove it. "Deployer action" items belong in
the README's production hardening checklist. Role, policy and statement
names follow spec §7.

| ID | Mitigation | Realises | Planned location and check |
|---|---|---|---|
| M-1 | Token authoriser on every `/tenant/*` method: JWKS signature, `iss` from `identity.discoveryUrl`, `client_id` in `identity.allowedClientIds`, `exp`, `token_use: access`, one string `tenant_id` matching `^[A-Za-z0-9][A-Za-z0-9-]{1,34}$`, a token carrying `tenants` refused; every refusal a 401. The Allow is the same for every `/tenant/*` route and carries `tenantId`, `sub`, `scope`; result cache at most 300 s, stated as the revocation lag. `authoriserRole` holds logs only | P-2, [ADR-0011](./adr/0011-authenticate-tenants-with-the-token-contract-and-throttle-per-tenant-optionally.md) | `src/authoriser/handler.ts`, `src/construct/api.ts`; unit test one case per refusal; template test: `authoriserRole` has no data action; integ step 2 |
| M-2 | The handler, not the authoriser, enforces scope per route (`ingestion/deliver` for `CreateDelivery`, `ingestion/read` for the reads); both scopes registered in `tenant-identity` at deploy. The tenant id comes only from `requestContext.authorizer.tenantId`; every registry key is `TENANT#<caller>`, so another tenant's `deliveryId` is a 404. Errors are `{code, message, requestId}`, never a tenant id or a key ARN | P-2, [ADR-0011](./adr/0011-authenticate-tenants-with-the-token-contract-and-throttle-per-tenant-optionally.md), [ADR-0010](./adr/0010-keep-one-tenant-partitioned-registry-with-a-stream-watch.md) | `src/api/handler.ts`, `src/api/errors.ts`, `src/shared/registry.ts`; unit tests over every route and error path; integ step 3 (read-only token: `CreateDelivery` 403, `GetDelivery` 200) |
| M-3 | `fileName` is `[A-Za-z0-9._-]{1,128}`, checked in the Smithy model and the handler (400); it lives on the row and in a quoted `Content-Disposition` only, never in a key, log or event; the object key is `ingest/<tenantId>/<deliveryId>` | P-7, [ADR-0006](./adr/0006-presign-a-write-once-upload-under-an-opaque-key.md) | `model/` (`@pattern`), `src/api/handler.ts`; unit test; integ step 3 (`Content-Disposition` on `landedKey`) |
| M-4 | `/platform/*` uses `AWS_IAM` only; the token authoriser is not attached there and no `/tenant/*` route reaches a platform operation | P-8, [ADR-0011](./adr/0011-authenticate-tenants-with-the-token-contract-and-throttle-per-tenant-optionally.md) | `src/construct/api.ts`; template test on every method's authorisation type |
| M-5 | Per-tenant limits. Always: `inFlight` counts `OPEN` rows, incremented with the row's creation in one transaction, decremented by every terminal transition, reconciled by the sweep; `CreateDelivery` is 429 at `maxInFlightPerTenant`, which bounds one tenant's STS, KMS, Lambda and validator use. With `tenantThrottle`: one API key per tenant with the deterministic value `tei-<hex(sha256(stackId + tenantId))[0:40]>`, computed by the authoriser from the verified claim and returned as `usageIdentifierKey`, `apiKeySource: AUTHORIZER`, `apiKeyRequired: true` on every `/tenant/*` method. N-3 states the hard caps (10,000 API keys per account and Region shared with `tenant-identity`, so 5,000 tenants composed; 100,000 KMS keys counting pending deletion; `CreateApiKey` 5 rps; 25 on-demand rotations per key, surfaced as 409 `RotationLimitReached`) | N-3, N-8, [ADR-0011](./adr/0011-authenticate-tenants-with-the-token-contract-and-throttle-per-tenant-optionally.md) | `src/api/handler.ts`, `src/authoriser/usage-key.ts`, `src/construct/api.ts`, `src/platform/create-tenant-key.ts`; unit test (authoriser and factory compute the same value); template test (`apiKeyRequired`, `apiKeySource`); integ step 7 (sixth open delivery 429), step 9 |
| M-6 | The presigned PUT is signed by a `tenantUploadRole` session on `ingest/<tenantId>/<deliveryId>` with six signed headers: `x-amz-server-side-encryption: aws:kms`, the key id = registry `keyArn`, `bucket-key-enabled: false`, `If-None-Match: *`, `Content-Length` = declared size, `Content-Type`; the three `x-amz-*` in `unhoistableHeaders`. `expiresAt = min(now + TTL, credentials.Expiration)`. Editing the path breaks the signature, and a URL for another prefix fails the signer's identity policy (M-12) | P-3, P-7, [ADR-0006](./adr/0006-presign-a-write-once-upload-under-an-opaque-key.md) | `src/shared/presign.ts`, `src/api/handler.ts`; unit test asserts all six signed headers and the unhoisted three; integ step 4 (other key id, no SSE, other length: 403; path edited to `ingest/B/...`: `SignatureDoesNotMatch`; extra unsigned headers recorded) |
| M-7 | Bucket policy and settings: Deny without TLS; Deny `PutObject` without `aws:kms`; Deny `PutObject` on `ingest/*` without `If-None-Match` (write once, no multipart there); Deny `PutObject` on `ingest/*` with a storage class other than `STANDARD` or any website redirect; Deny `s3:*` past `s3:signatureAge = max(uploadUrlTtlSeconds, validatorObjectUrlTtlSeconds)` so code cannot presign longer than configured; `BucketOwnerEnforced`, Block Public Access | P-3, P-7, [ADR-0006](./adr/0006-presign-a-write-once-upload-under-an-opaque-key.md), [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-with-a-deny-first-key-policy.md) | `src/construct/bucket-policy.ts`; template test per statement; integ step 4 (`GLACIER`: 403; second PUT before processing: 412) |
| M-8 | Principal-scoped writes and deletes by role ARN: `PutObject` on `ingest/*` only by tenant roles, on `documents/*` only by `tenantProcessRole`; `DeleteObject` and `DeleteObjectVersion` on `ingest/*` only by `tenantProcessRole`, `tenantPlatformRole` and the `Custom::S3AutoDeleteObjectsCustomResourceProvider` role, on `documents/*` only by `tenantPlatformRole` and that role. Versioning on; `documents/` noncurrent versions kept 7 days; `ingest/` noncurrent versions 1 day, expired delete markers removed, current drops after `dropRetentionDays`, incomplete multipart after 1 day | P-8, [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-with-a-deny-first-key-policy.md) | `src/construct/bucket-policy.ts`, `src/construct/bucket.ts`; template test (each Deny's exception list, the auto-delete exemption, lifecycle rules); integ step 5 (`TestProbeRole` PUT with every header right: 403 from S3), step 12 (versioned bucket gone) |
| M-9 | Processor structural checks before anything lands: `HeadObject` reads `dropEtag` and `dropVersionId`; `SSEKMSKeyId` other than the registry `keyArn` or `BucketKeyEnabled` is `KEY_MISMATCH`; a storage class other than `STANDARD` is `STORAGE_CLASS`; a length other than declared or over `maxObjectSizeBytes` is `SIZE_MISMATCH` or `TOO_LARGE`; `GetObject` pinned to the ETag checks magic bytes against the declared type and an allowlist, the ZIP central directory with bounded entry count and expansion, and computes `sha256` | P-3, P-10, [ADR-0007](./adr/0007-validate-then-land-with-etag-pins-and-a-lease.md) | `src/processor/structural.ts`; unit test per reason code; integ step 3, step 7 (declared PDF, uploaded ZIP: `TYPE_MISMATCH`) |
| M-10 | Validate then land with pins and a lease: every read, every validator GET and the `CopyObject` carry the drop ETag (`PreconditionFailed` is `OBJECT_CHANGED`); step order copy, conditional flip to `ACCEPTED` on `leaseOwner`, `DeleteObjectVersion` of `dropVersionId`, publish, `SET eventPublishedAt`; terminal re-entry deletes a leftover drop and publishes an owed event; every row read is `ConsistentRead`; a terminal or missing row deletes the drop version; consumers de-duplicate on `deliveryId` | P-10, [ADR-0007](./adr/0007-validate-then-land-with-etag-pins-and-a-lease.md) | `src/processor/handler.ts`; unit test per crash point (after copy, after flip, after delete) and for two concurrent receives; integ step 3 (one `DeliveryAccepted`, no drop version left) |
| M-11 | Timing bounds: T = structural budget + validator timeouts + copy budget, at most 15 minutes, else synth fails; visibility `visibilityTimeoutFactor × T`; the sweep abandons a lease only after `maxReceiveCount × visibilityTimeoutFactor × T + abandonGraceSeconds`, and expires `AWAITING_UPLOAD` only when `now > urlExpiresAt + abandonGraceSeconds` and `HeadObject` on the drop is 404; a cached session needs TTL plus 60 s left to presign and T left to start a run | P-10, [ADR-0007](./adr/0007-validate-then-land-with-etag-pins-and-a-lease.md), [ADR-0009](./adr/0009-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md) | `src/construct/pipeline.ts` (T, visibility), `src/sweep/handler.ts`, `src/shared/tenant-session.ts`; synth test (T over 15 minutes fails naming the validators); unit test (session lifetime); integ step 7 (`EXPIRED` past TTL plus grace), step 7c (`PROCESSING_ABANDONED` after 2T plus 60 s) |
| M-12 | ABAC in the tenant roles' identity policies, not in a session policy: S3 on `<prefix>/${aws:PrincipalTag/TenantId}/*`; KMS on keys with `aws:ResourceTag/TenantId = ${tag}` and `kms:ViaService = s3.<region>.amazonaws.com`; registry with `dynamodb:LeadingKeys = TENANT#${tag}`. Code that omits anything still holds only the role's own policy | P-2, [ADR-0003](./adr/0003-put-the-tenant-boundary-in-identity-policies-of-one-tenant-role-per-function.md) | `src/construct/roles.ts`; template test per tenant role; integ step 5 (`SimulatePrincipalPolicy` with `TenantId = A` denies every S3, KMS and DynamoDB action on B's resources), step 6 |
| M-13 | Tenant role trust: only the named base roles; `ForAllValues:StringEquals aws:TagKeys = ["TenantId"]`, `Null aws:RequestTag/TenantId = false`, `StringNotLike` on `*/*`, `*:*`, `*=*`, `*+*`, `*@*`, `*.*`, `* *`, `*,*`; the §7.0 grammar enforced in code at the authoriser (401), the Smithy path (400) and the processor (deleted, no event); `RoleSessionName` `t-<tenantId>-<suffix>` under 64 characters | P-2, [ADR-0003](./adr/0003-put-the-tenant-boundary-in-identity-policies-of-one-tenant-role-per-function.md) | `src/construct/roles.ts`, `src/shared/tenant-id.ts`, `src/shared/tenant-session.ts`; template test (trust conditions); unit test (grammar, session name length); integ step 10 (access-log `Requester` names `t-<tenantId>-...`) |
| M-14 | Role asymmetry: seven base roles reach no document; each assumes exactly its tenant role (`apiRole` upload, `processorRole` and `sweepRole` process, `platformRole` and `keyFactoryRole` platform); `authoriserRole` logs only; `watchRole` the stream, metrics and `SYSTEM` items; `processorRole` writes only `keyStatus`, `lastKeyCheckAt`, `updatedAt` of a key row; `platformRole` and `keyFactoryRole` carry explicit Denies of `PutKeyPolicy`, `CreateGrant`, `UntagResource` and every use action, `platformRole` also of `CreateKey` and `TagResource`; `tenantUploadRole` cannot read or delete, `tenantProcessRole` cannot list or write outside `_probe/` and `documents/` | P-8, [ADR-0003](./adr/0003-put-the-tenant-boundary-in-identity-policies-of-one-tenant-role-per-function.md) | `src/construct/roles.ts`; template test per role (no S3 or KMS use action on any base role, each Deny present, one assumable tenant role) |

| M-15 | The processor and sweep take the tenant id only from the object key's second segment, check it against §7.0, skip a third segment `_probe`, and assume `tenantProcessRole` for that id **before** loading the row, so a wrong id is `AccessDenied`, never another tenant's row; object metadata, event detail and the file name are never read for the tenant. A forged `Object Created` acts only under the key's own tenant, on an `AWAITING_UPLOAD` row | P-2, [ADR-0007](./adr/0007-validate-then-land-with-etag-pins-and-a-lease.md) | `src/processor/handler.ts` (steps 0 to 2), `src/sweep/handler.ts`; unit test (metadata naming another tenant ignored; bad segment deleted with no event; message for a terminal row deletes the drop) |
| M-16 | Queue and bus resource policies with explicit Denies: the queue Allows `sqs:SendMessage` to `events.amazonaws.com` with `aws:SourceArn` = the rule and Denies it unless the rule or `aws:PrincipalArn` = `redriveOperatorRole` (unset: no redrive, stated); the DLQ Denies unless `aws:SourceArn` is the queue (dropped if it blocks the automatic move); the EventBridge target DLQ keeps its own rule-only policy; the bus Denies `events:PutEvents` unless `processorRole`; SSE-SQS on every queue | [ADR-0009](./adr/0009-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md) | `src/construct/queues.ts`, `src/construct/events.ts`; template test per policy; integ step 7b (the message reaches `deadLetterQueue`), step 3 (`Object Created` arrives on the default bus) |
| M-17 | Key policy of every `vendor-key` key, written once at `CreateKey` (`BypassPolicyLockoutSafetyCheck`, the creator holds no `PutKeyPolicy`): 1 administration for `platformRole` and `keyFactoryRole` without wildcards; 2 tenant roles `GenerateDataKey`, `Decrypt` with `kms:ViaService` = S3 and `kms:EncryptionContext:aws:s3:arn` on the tenant's two prefixes, plus `DescribeKey`; 2b consumer roles `Decrypt` via S3 on `documents/<t>/*` only; 3 the account principal with administration and `PutKeyPolicy`, no use, grant or tag action; separate Denies 4a-i (use and `CreateGrant` unless a tenant role), 4a-ii (`Decrypt` unless a tenant or consumer role), 4b (unless via S3), 4c (unless the context is one of the two prefixes); 5 Deny `TagResource`, `UntagResource` to `*`. Roles matched on `aws:PrincipalArn`. Bucket Keys off on the bucket and in every PUT and `CopyObject` header; a bucket key's context misses statement 2 and meets 4c, so it fails closed | P-1, [ADR-0001](./adr/0001-encrypt-server-side-with-sse-kms-and-one-kms-key-per-tenant.md), [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-with-a-deny-first-key-policy.md) | `src/platform/key-policy.ts`; unit test with IAM Access Analyzer `check-no-new-access` against a baseline holding every Deny; integ step 5 on the scratch key against a mistaken Allow (4c, 4a-i, 4b, 4a-ii each alone, 2b for `TestConsumerRole`, `bucket-key-enabled: true` refused), step 6 (`TestProbeRole` on B's object: KMS 403) |
| M-18 | Fail closed through an S3 probe: on any S3 error at steps 3 to 8 that is a 403 or `AccessDenied` or names KMS (a disabled key is 400 `KMS.DisabledException`, a key pending deletion 400 `KMS.KMSInvalidStateException`), the processor runs `PutObject`, `GetObject`, `DeleteObjectVersion` of `ingest/<t>/_probe/<ulid>` under the same session; a KMS-sourced failure is `KEY_UNAVAILABLE` on the delivery and `keyStatus = REVOKED`, the drop version deleted, `DeliveryKeyUnavailable` published, the message deleted (no DLQ); a probe success is the pipeline's own fault, thrown, never `REVOKED`; never classified by error code alone. `CreateDelivery` is 409 while `REVOKED`; the sweep and `GetTenantKey` re-probe and restore `ACTIVE` only on success | P-5, [ADR-0004](./adr/0004-offer-two-key-tiers-and-fail-closed-through-an-s3-probe.md) | `src/processor/probe.ts`, `src/processor/handler.ts`, `src/sweep/handler.ts`, `src/platform/get-tenant-key.ts`; unit test (S3 403 with a succeeding probe: thrown, never `REVOKED`); integ step 8 (key disabled, S3 400 `KMS.DisabledException`, then only the use statement removed, S3 403 `AccessDenied`: `KEY_UNAVAILABLE`, `REVOKED`, DLQ unchanged, 409, restored) |
| M-19 | `tenant-key` admission: 422 for a key ARN in the vendor's account; `DescribeKey` under a `tenantPlatformRole` session for the tenant, so admission at all proves the `TenantId` tag; canonical ARN from `KeyMetadata.Arn` (alias ARN, bare id, other Region refused); `SYMMETRIC_DEFAULT`, `Enabled`, single-Region; a probe through S3 before `ACTIVE`; the `KEYARN#` item written for both tiers in the same transaction (409 if it exists); the README carries the §7.3 policy verbatim with the tenant and consumer roles | P-4, [ADR-0004](./adr/0004-offer-two-key-tiers-and-fail-closed-through-an-s3-probe.md) | `src/platform/create-tenant-key.ts`; unit test per refusal; integ step 1 (untagged, wrongly tagged, vendor-account key: 422; C with B's `keyArn`: 409; both `ACTIVE`, no probe version left) against the second account named by `tenantKeyAccount` |
| M-20 | What a validator receives: a presigned GET signed by the `tenantProcessRole` session with `If-Match` signed, for one object version, lifetime `validatorObjectUrlTtlSeconds`; no credentials; `LambdaValidator` grants the processor `lambda:InvokeFunction` and the function nothing; a cross-account validator needs the deployer's own resource policy for `processorRole`. The URL and a validator error's body are never logged; `message` is stored and returned, and the contract forbids document content in it | P-11, [ADR-0008](./adr/0008-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md) | `src/validators/lambda-validator.ts`, `src/processor/validators.ts`; template test (the validator function's role gains nothing); unit test (error body not logged); integ step 7b (no log line holds `X-Amz-Signature` or a file name) |
| M-21 | Verdict handling: structural checks first; validators in order, stopping at the first `REJECT`; the verdict is schema-checked (`version`, `verdict`, `code` `[A-Z0-9_]{1,40}`); a schema-invalid verdict, function error or timeout is a validator error: thrown and retried, and on the last receive (`ApproximateReceiveCount == maxReceiveCount`) `REJECTED <name>:VALIDATOR_ERROR`, drop version deleted, `DeliveryRejected` published, the DLQ copy an audit record only. Validator timeouts are part of T (M-11); validator invocations are bounded by `inFlight` (M-5) | P-11, [ADR-0008](./adr/0008-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md) | `src/processor/verdict.ts`, `src/processor/validators.ts`; unit test (malformed, empty, extra field, error, timeout: never `ACCEPT`); integ step 7b (`pdf-pages:TOO_MANY_PAGES` with `test-switch` not invoked; mode `throw`: `test-switch:VALIDATOR_ERROR`) |
| M-22 | The key factory's bounds: `keyFactoryRole` alone may `kms:CreateKey`, with `kms:KeySpec = SYMMETRIC_DEFAULT`, `kms:KeyOrigin = AWS_KMS`, `kms:KeyUsage = ENCRYPT_DECRYPT`, `kms:MultiRegion = false` (the call passes all four), and `kms:TagResource` only with a `TenantId` request tag and the keys `[TenantId, tei:stack]`; it holds no `PutKeyPolicy`, `CreateGrant`, `UntagResource` or use action; statement 5 stops retagging of every key it created. Whether `aws:ResourceTag` is set during `CreateKey` is a spike in the README's implementation notes | P-1, P-8, [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-with-a-deny-first-key-policy.md), [ADR-0003](./adr/0003-put-the-tenant-boundary-in-identity-policies-of-one-tenant-role-per-function.md) | `src/construct/roles.ts`, `src/platform/create-tenant-key.ts`; template test (conditions and Denies); unit test (the call names all four key properties) |
| M-23 | Registry write rules: tenant roles may `UpdateItem`, `ConditionCheckItem`, `GetItem`, `Query` only, in `TENANT#${tag}`, naming only their allowlist, `ReturnValues` in `NONE`, `UPDATED_OLD`, `UPDATED_NEW`; no `PutItem`, `DeleteItem` or `Scan`; an explicit Deny `dynamodb:*` with `ForAnyValue:StringEquals dynamodb:Attributes = [keyArn, tier, apiKeyValue, keyStatus]`. The protected names appear on no delivery row; `CreateDelivery` creates its row with `UpdateItem` and `attribute_not_exists(PK)`; `platformRole` and `sweepRole` are denied `UpdateItem` naming `keyArn` or `tier` | P-8, [ADR-0003](./adr/0003-put-the-tenant-boundary-in-identity-policies-of-one-tenant-role-per-function.md), [ADR-0010](./adr/0010-keep-one-tenant-partitioned-registry-with-a-stream-watch.md) | `src/construct/roles.ts`, `src/shared/registry.ts`; unit test (the two row schemas share no name outside the allowlists); integ step 5 (`SimulatePrincipalPolicy`: any `PutItem`, `DeleteItem` or write naming `keyArn`, `tier`, `keyStatus` denied) |
| M-24 | Registry watch: `keyFactoryRole` writes the binding with `PutItem` and `attribute_not_exists(keyArn)`, `CREATING` then `ACTIVE`; a Lambda on the stream (`NEW_AND_OLD_IMAGES`) behind an event-source filter `SK = KEY` alarms on a `MODIFY` changing `keyArn` or `tier` and on an `INSERT` for a tenant with a `TOMBSTONE#<tenantId>` item, which it writes on every `REMOVE` with a 7-day `ttl`; failed batches go to an SQS on-failure destination; images are never logged | P-8, [ADR-0010](./adr/0010-keep-one-tenant-partitioned-registry-with-a-stream-watch.md) | `src/registry-watch/handler.ts`, `src/construct/registry.ts`; unit test (each alarm case, nothing logged from an image); template test (filter, on-failure destination); integ step 11 (`DeleteTenantKey B`: tombstone written, no alarm) |
| M-25 | An EventBridge rule on the CloudTrail `PutKeyPolicy` management event, with an SQS audit queue as target, and an alarm on the rule's `TriggeredRules` metric (amended 2026-11-06: not a CloudWatch Logs metric filter); the consumer set is fixed at key creation and changing it is an alarmed bulk `PutKeyPolicy` the README documents and the sample does not build | P-1, [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-with-a-deny-first-key-policy.md) | `src/construct/alarms.ts`; template test (rule event pattern, audit-queue target, alarm); deployer action: a CloudTrail trail delivering management events to EventBridge, and route the alarm to an on-call target |
| M-26 | Offboarding: `DeleteTenantKey` sets `keyStatus = DELETING` (presigning stops), deletes the tenant's API key (with `tenantThrottle`), lists and deletes every version under both prefixes under `tenantPlatformRole`, for `vendor-key` deletes the alias and schedules deletion (`keyDeletionWindowDays`), and removes the row and `KEYARN#` in one transaction; 204 if missing, so a half-done call is resumed by repeating it. A late PUT fails on the pending-deletion key (S3 400 `KMS.KMSInvalidStateException`) or lands where the processor finds no row and deletes it. The stack-delete drain runs under `platformRole` after CloudFormation removed the API and platform functions, schedules every registered `vendor-key` key, and as a backstop lists keys by the `tei:stack` tag and schedules any the registry no longer knows | P-6, [ADR-0005](./adr/0005-make-offboarding-cryptographic.md) | `src/platform/delete-tenant-key.ts`, `src/platform/drain.ts`; unit test (repeat after a failure at each step); integ step 11 (no version under either A prefix, alias gone, key `PendingDeletion`, `CreateDelivery A` refused, 403 from API Gateway or 409 `TenantKeyUnavailable` from the handler while the usage-plan cache lasts, in-flight PUT 400 or 403), step 12 (only keys pending deletion remain, listed) |
| M-27 | Telemetry without secrets: one field-allowlisted logger (`tenantId` on every line; never a URL, signature, file name, document content or stream image); an explicit `DESTROY` log group per function with `logRetention`; access logs to a separate SSE-S3 bucket that Denies `s3:GetObject` unless `accessLogReaderRole`, retained `dropRetentionDays` plus 30 days; events and queue bodies carry keys and ids, never names or URLs; queue retention and PITR stated in the README | N-6, P-9, [ADR-0012](./adr/0012-deliver-the-pattern-as-a-construct-with-per-tenant-observability.md) | `src/shared/logger.ts`, `src/construct/access-log-bucket.ts`; unit test (logger drops non-allowlisted fields); template test (reader Deny, retention); integ step 7b (no `X-Amz-Signature`, no file name in any log) |
| M-28 | Attribution: the `t-<tenantId>-<suffix>` session name in every S3 access log, CloudTrail and KMS record; registry counters (`bytesStored`, `deliveriesAccepted`, `deliveriesRejected`, `kmsRequests` at four plus one per validator for an accepted delivery); one processor line per delivery; Contributor Insights for the top tenants; `TenantId` cost allocation tag on keys; optional per-tenant EMF; the delivery row records `createdBy` and every transition | P-9, [ADR-0012](./adr/0012-deliver-the-pattern-as-a-construct-with-per-tenant-observability.md) | `src/shared/metering.ts`, `src/processor/handler.ts`, `src/construct/observability.ts`; integ step 10 (`kmsRequests` matches CloudTrail for one delivery; `Requester` names the tenant) |
| M-29 | Events and consumers: `Delivery*` detail carries `tenantId`, `deliveryId`, `landedKey`, size, type, reason; no file name, key ARN or URL; delivery is at least once and consumers de-duplicate on `deliveryId`; consumers filter on `detail.tenantId` and read `landedKey` as a role in `consumerRoles` under their own tenant session (statement 2b, their own identity policy on `documents/${tag}/*`); `ingest/` is never readable by a consumer | P-1, P-10, [ADR-0009](./adr/0009-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md), [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-with-a-deny-first-key-policy.md) | `src/shared/events.ts`, `src/platform/key-policy.ts`; unit test (event schema); integ step 3 (no key ARN in the event), step 6 (`TestConsumerRole` for A: A's object 200, B's 403) |
| M-30 | Published parameters under `/application-plane/shared/ingestion/` are written by CloudFormation only; deployer action: Deny `ssm:PutParameter` and `DeleteParameter` on that path to every principal but the deployment role | [ADR-0012](./adr/0012-deliver-the-pattern-as-a-construct-with-per-tenant-observability.md) | `src/main.ts` (demo stack); README production hardening checklist |
| M-31 | Sample-standard settings (N-7), each a template test: cdk-nag `AwsSolutionsChecks` with reasoned suppressions; an explicit `DESTROY` log group per function; SSE-SQS; the §3.1 lifecycle rules; the EventBridge target DLQ; the auto-delete exemption; the stream filter and on-failure destination; `apiKeyRequired` with `tenantThrottle` | [ADR-0012](./adr/0012-deliver-the-pattern-as-a-construct-with-per-tenant-observability.md) | `src/construct/*.ts`, `test/construct.test.ts`; `npx projen build` with cdk-nag |
| M-32 | Test fidelity: the test-aid stack owns a scratch bucket (the §7.4 policy minus the principal statements) and a scratch key built by the same key-policy builder plus a mistaken Allow of every use action for `TestProbeRole`, so each Deny is met alone; assertions are by error message (KMS 403 against S3 403); the identity-policy wall is proven with `SimulatePrincipalPolicy` on the deployed tenant roles; validator behaviour comes from an SSM parameter, so nothing redeploys; the test waits 5 minutes after each key policy or tag change; without `tenantKeyAccount` the README says the cross-account claim is unproven | [ADR-0012](./adr/0012-deliver-the-pattern-as-a-construct-with-per-tenant-observability.md) | `scripts/integ.sh`, `test/integ/test-aid-stack.ts`; integ steps 1, 5, 6, 7b, 7c, 8 |
| M-33 | Test-aid containment: `scripts/integ.sh` refuses an account without the `tei:test-account` tag or the `/tenant-encrypted-ingestion/test-account` SSM marker; `TestProbeRole` is trusted by the runner for one hour and Denies `kms:PutKeyPolicy`, `CreateGrant`, `ScheduleKeyDeletion`, `TagResource`, `UntagResource`, `s3:PutBucketPolicy`, `DeleteBucketPolicy`, `PutBucketEncryption`; teardown destroys the test-aid stack and lists what remains | [ADR-0012](./adr/0012-deliver-the-pattern-as-a-construct-with-per-tenant-observability.md) | `scripts/integ.sh`, `test/integ/test-aid-stack.ts`; template test (the Denies); integ step 12 |

## Threat to mitigation mapping

"Mitigated by design": the mitigations close the threat once built and the
named test passes. "Accepted (residual)": the mitigations narrow it and the
rest is listed under [Accepted risks](#accepted-risks). "Unverified": the
design depends on AWS behaviour the documentation does not state; the
named integration step decides it.

| Threat | Mitigations | Disposition |
|---|---|---|
| T-1 | M-1 | Mitigated by design |
| T-2 | M-1, M-2 | Mitigated by design |
| T-3 | M-2, M-12 | Mitigated by design |
| T-4 | M-3, M-27 | Mitigated by design |
| T-5 | M-4 | Mitigated by design |
| T-6 | M-5, M-21 | Accepted (residual): the `inFlight` counter is filtered against code; keys pending deletion count against the KMS key quota |
| T-7 | M-6, M-7, M-8, M-9, M-17 | Mitigated by design |
| T-8 | M-7, M-10 | Mitigated by design |
| T-9 | M-6, M-7, M-10, M-11 | Accepted (residual): a used PUT URL writes again after the drop version is deleted, until its TTL |
| T-10 | M-9, M-21 | Mitigated by design |
| T-11 | M-13, M-14, M-28 | Accepted (residual): compromised function code acts as one tenant per session |
| T-12 | M-13 | Mitigated by design |
| T-13 | M-1, M-12, M-14 | Mitigated by design |
| T-14 | M-15, M-16 | Mitigated by design |
| T-15 | M-10, M-15 | Mitigated by design |
| T-16 | M-10, M-11, M-21 | Mitigated by design |
| T-17 | M-12, M-17, M-32 | Mitigated by design |
| T-18 | M-18, M-19 | Mitigated by design |
| T-19 | M-12, M-19, M-32 | Mitigated by design; cross-account `aws:ResourceTag` verified by spike 2026-11-05, repeated by integ step 1 |
| T-20 | none | Accepted (by design): plaintext in flight behind TLS |
| T-21 | M-20, M-27 | Accepted (residual): a validator reads the one document it is given, for minutes |
| T-22 | M-14, M-20 | Mitigated by design |
| T-23 | M-21 | Mitigated by design; what a validator decides is the deployer's (out of scope) |
| T-24 | M-5, M-11, M-21 | Mitigated by design |
| T-25 | M-14, M-17, M-22, M-25 | Accepted (residual): an IAM administrator can `PutKeyPolicy` first, alarmed |
| T-26 | M-14, M-23 | Mitigated by design |
| T-27 | M-22, M-23, M-24 | Accepted (residual): key-factory code can bind a new tenant to a key it made, or rebind one, detected by the watch |
| T-28 | M-4, M-26 | Accepted (residual): PITR keeps file names 35 days; keys pending deletion survive destroy |
| T-29 | M-8, M-14 | Mitigated by design |
| T-30 | M-17, M-29 | Mitigated by design |
| T-31 | M-16, M-29 | Accepted (residual): the event bus is vendor-side and filtered |
| T-32 | M-3, M-7, M-27 | Accepted (residual): access logs record presigned URIs; queues hold IP addresses 14 days; PITR keeps file names |
| T-33 | M-13, M-28 | Mitigated by design |
| T-34 | M-30 | Mitigated by design (deployer action) |
| T-35 | M-31 | Mitigated by design |
| T-36 | M-32 | Mitigated by design |
| T-37 | M-33 | Mitigated by design |

## Accepted risks

Listed in order of consequence. Each goes on the README's production
hardening checklist unless marked "by design".

1. **Plaintext in flight behind TLS (T-20, T-21; by design).** The sample
   encrypts server side
   ([ADR-0001](./adr/0001-encrypt-server-side-with-sse-kms-and-one-kms-key-per-tenant.md)).
   S3, the processor and every validator see each document in plaintext
   inside TLS and in memory; a bad validator can read the one document it
   was given, for `validatorObjectUrlTtlSeconds`. A tenant that needs a drop
   the vendor cannot read needs the sealed-drop tier, a spec §11 seam.
2. **Compromised function code acts as one tenant per session (T-11).**
   The trust policies fix the tag key and keep separators out of its value
   (M-13), not which tenant it names. A wrong-tenant bug is refused by AWS
   (M-12); deliberate compromise of the API, processor, sweep or platform
   code is not. What bounds it: one tenant role per function, so a
   compromised API can only presign uploads and a compromised sweep cannot
   read a landed document (it could overwrite one, recoverable for 7 days);
   every `AssumeRole` in CloudTrail with the tag and a `t-<tenantId>-...`
   session name (M-28); `maxInFlightPerTenant` (M-5). Dependency hygiene is
   the deployer's.
3. **Key-factory code binds a tenant to a key of its choosing (T-27).**
   KMS cannot constrain the policy passed to `CreateKey`, so compromised
   `keyFactoryRole` code can create a key that also lets an outside
   principal decrypt, tag it for a new tenant and write that tenant's
   binding; its `PutItem` can also rewrite an existing tenant's `KEY` row,
   because the write-once guard is a condition the code chooses. Tenant-role
   code cannot do either (M-23, enforced). A changed `keyArn` or `tier`, and
   a removed tenant reappearing within 7 days, alarm through the registry
   watch (M-24, detected, not prevented). A new tenant bound at creation
   raises no alarm. Alias-bound keys are a spec §11 hardening seam.
4. **An IAM administrator can `PutKeyPolicy` first (T-25).** Statement 3
   gives the account principal `kms:PutKeyPolicy` so a key stays manageable,
   so any IAM administrator in the vendor account can add itself to a
   `vendor-key` key and then read with it, or cancel a pending deletion
   during the window. CloudTrail records the call and an EventBridge rule on
   that event alarms (M-25); adding a consumer is the same alarmed call.
5. **Cross-account `aws:ResourceTag` (T-19) is verified, not documented.**
   AWS documentation shows only same-account examples. A spike on
   2026-11-05 with a second account showed the condition is evaluated on
   the tenant's key for a direct `DescribeKey` and for S3-initiated use, in
   both the allow and the refuse direction. Integ step 1 repeats it on
   every run; the fallback in
   [ADR-0004](./adr/0004-offer-two-key-tiers-and-fail-closed-through-an-s3-probe.md)
   stays documented in case the behaviour changes.
6. **S3 access logs record presigned URIs (T-32).** Server access logs hold
   query strings with signatures and access key ids. They go to a separate
   bucket that Denies `s3:GetObject` to every principal but
   `accessLogReaderRole` (M-27). A logged validator GET stays reusable until
   its TTL, which log delivery latency nearly consumes.
7. **A used PUT URL writes again over a delete marker until its TTL (T-9).**
   The URL is single-use while the drop exists (`If-None-Match: *`). Once
   the processor deletes the drop version, the same URL writes again until
   `X-Amz-Expires`; the processor meets a terminal row and discards the
   upload, at the cost of one processor run (N-6).
8. **PITR keeps file names for 35 days after offboarding (T-28, T-32).**
   Registry backups keep file names and hashes, never content, of an
   offboarded tenant for the PITR window.
9. **Keys pending deletion survive destroy and count against quota (T-6,
   T-28).** `DeleteTenantKey` and the drain schedule deletion for
   `keyDeletionWindowDays`; the keys remain and count against the 100,000-key quota until then. Teardown lists them.
10. **Queues hold uploader IP addresses for 14 days (T-32).** S3
    `Object Created` events carry `source-ip-address` and `requester`;
    the DLQ keeps them up to 14 days, SSE-SQS encrypted.
11. **The `inFlight` counter is filtered against code (T-6).** It is in the
    tenant roles' allowlist, so compromised code under a tenant role can
    reset its own tenant's counter and lift the cap for that tenant. The
    sweep reconciles it hourly; `tenantThrottle`, when set, is enforced by
    API Gateway. A bug cannot touch another tenant's counter (M-23).
12. **The event bus is vendor-side and filtered (T-31).** The bus policy
    controls who puts events (M-16), not who reads: any rule in the vendor
    account sees every tenant's `Delivery*` events (no file names, ARNs or
    URLs). Consumers filter on `detail.tenantId`; a per-tenant subscription
    is a spec §11 hardening seam.

## Security review

Run 2026-11-06 on the synthesised tree (`npx projen build` under the
deployment profile, then ProtoShield and the Automated Security Helper 3.2.0
against the sample directory with `cdk.out/` present). Scanner outputs stay
out of the repository. Dispositions:

| Scanner | Finding | Disposition |
|---|---|---|
| ProtoShield license headers | 80 files "carry MIT headers, Apache 2.0 required" | False positive: ProtoShield's default plugin configuration expects Apache-2.0; this repository is MIT-0 by its `LICENSE` and the sample standard §4.1, and every authored file carries the MIT-0 header |
| ProtoShield IAM (High) | `TestProbeRole` holds KMS use actions on `*` and S3 object actions on every bucket | Accepted for the probe's KMS scope, by design (M-32): the role must be admitted by its identity policy so a denial it meets can only come from a key or bucket policy; it is trusted by the test account only, one-hour sessions, denied every administration action, and deployed only into an account that carries the test marker (M-33). Its S3 scope is **fixed** to the sample's buckets (`arn:aws:s3:::tenantencryptedingestion*`) |
| ProtoShield IAM (High) | `TestAccessLogReaderRole` reads every bucket | **Fixed**: scoped to the sample's buckets |
| ProtoShield IAM (Medium) | `TestConsumerRole` reads `documents/<tenant>/*` of any bucket | **Fixed**: scoped to the sample's buckets |
| ProtoShield IAM (Info) | `PlatformInvokePolicy` broader than needed, narrowed by an explicit Deny | No change; the scanner calls it good practice |
| ProtoShield CVE, ASH grype (Medium) | `minimatch` GHSA-g3hv-75wg-m249 (DoS), `glob` AbortSignal bypass | Accepted: both are transitive dependencies of `aws-cdk-lib` and the development toolchain; `npm ls --omit=dev` shows `minimatch` only under `aws-cdk-lib`, and neither is in any Lambda bundle (esbuild output grepped). Refreshed with the next `npx projen upgrade` |
| ASH opengrep, semgrep (High) | non-literal `RegExp` in `src/shared/registry.ts` | **Fixed**: the placeholder scan is a plain string walk (`mentionsPlaceholder`); the input was code-defined attribute names, never caller data |
| ASH detect-secrets (High) | an access key id and secret in `test/runtime-helpers.ts`; high-entropy strings in `test/shared.test.ts`, `test/processor.test.ts` | False positive: the key is `AKIAEXAMPLEEXAMPLE00` with `example-secret-not-real`, returned by a mocked STS; the strings are a fixed ULID and a SHA-256 fixture |
| ASH cfn-nag (Medium, 158) and checkov | on `cdk.out/` and `cdk.integ.out/` templates | Not dispositioned one by one: the synthesised templates are machine output the cdk-nag aspect already checks (0 unsuppressed errors, every suppression cites an ADR or M-n); cfn-nag's generic rules (log group retention, Lambda in a VPC, SQS policies) repeat what `cdk-nag` evaluated with context. Checkov and detect-secrets ran as SKIPPED in ASH's final table because of the global threshold |

Carried as integration checks and settled by the green run of 2026-11-06
(eu-central-1, a vendor account and a second tenant-key account):
cross-account `aws:ResourceTag` (step 1); a 412 for a signed
`If-None-Match` and a 403 for an extra unsigned header (step 4); S3 asks KMS
for the data key before it evaluates the bucket policy (step 5); the S3 error
shape of a KMS failure is 400 with the KMS code in the message, confirmed by
the probe (step 8); SQS's own move to the DLQ meets the DLQ policy (step 7b);
`Object Created` arrives on the default bus (step 3). Two spikes ran before
implementation (2026-11-05): `CreateKey` with tags is not blocked by the new
key's Deny-tagging statement, a later retag is; and `aws:ResourceTag` is
populated at `CreateKey` from the request tags, so no identity Deny may test
it there. Found at the first deployment: Lambda decrypts a function's
environment variables under its execution role, so the base roles' KMS use
Deny is scoped to keys tagged `TenantId`.

## Appendix A: Review history

Three independent blind design reviews ran on 2026-11-05, before any code:
30, 20 and 24 findings. Each reviewer read the specification, the ADRs and
this threat model against the AWS documentation without seeing the earlier
reports. Every finding was adopted into the specification; the design, the
ADRs and this file were then rewritten to read as the final design, so no
finding is cited above. The reports are kept out of the repository.

**First review (30 findings: one critical, eight high, twelve medium, eight
low, one informational).** It found that the tenant wall lived only in a
session policy the calling code chose, so code that omitted it kept the
role's full permissions; that `kms:Create*` in the administration statement
includes `kms:CreateGrant`; that `CreateKey` with an explicit policy forces
the creator to hold `PutKeyPolicy`; that the statement for the account
principal is not what it claimed; that the `tenant-key` policy trusted the
wrong role and the probe, a direct KMS call, could never pass it; that a
`PROCESSING` row had no way out; that offboarding could not list or delete
what it promised; and that file names in object keys spread into logs and
the KMS context. What changed: ABAC moved into the identity policies of one
tenant role per function, with the base roles split by function; the
administration actions were enumerated and the creator holds no
`PutKeyPolicy`; the probe goes through S3; `PROCESSING` became a lease; the
object key became opaque; scope moved into the handler; Bucket Keys are off
per request as well as on the bucket.

**Second review (20 findings: two high, nine medium, eight low, one
informational).** It found that platform code could create, tag and bind a
key of its own and redirect an existing tenant's future documents; that the
tenant id had no enforceable grammar, so a `/` could nest one tenant inside
another; that the key-policy Deny written as one statement fired only when
every condition failed; that the sweep abandoned leases SQS was still
retrying and the queue Deny blocked a redrive; that the test could pass on
the wrong denial and its probe role was a skeleton key; and that an
unversioned bucket made a delete by any vendor principal final. What
changed: the §7.0 tenant-id grammar with a `StringNotLike` trust guard and
code checks; three separate Denies (later four); a dedicated key factory
with bounded `CreateKey` and tagging, and a registry watch; versioning with
principal-scoped write and delete Denies; timing derived from the receive
count; an account-tag gate and administration Denies on the test roles;
canonical key ARNs and fully signed PUT headers.

**Third review (24 findings: five high, eight medium, seven low, four
informational).** It found that the key policy locked out every consumer;
that the test could not reach two of the key-policy Denies; that "the key
ARN is written once" was filtered, not enforced, because `PutItem` replaces
a whole item; that the bucket's delete Denies blocked `cdk destroy`; that
one API key per tenant broke a hard API Gateway quota; and that the step
order, versioned deletes, drop expiry, validator-error handling and the
fail-closed classifier each had a gap. What changed: consumer roles with
statement 2b and the Deny split into 4a-i and 4a-ii; a scratch bucket and
key with a mistaken Allow, and `SimulatePrincipalPolicy` for the identity
wall; registry write rules (no `PutItem` or `DeleteItem` for tenant roles,
attribute allowlists, a Deny on protected names), stated as enforced for
tenant-role code and detected for key-factory code; the auto-delete
provider's exemption; per-tenant throttling made optional with a
deterministic key and the quota stated; copy, flip, delete, publish with
`eventPublishedAt`; deletes by version id; expiry only for an absent drop;
a validator error rejecting on the last receive; the probe run on any S3
403.

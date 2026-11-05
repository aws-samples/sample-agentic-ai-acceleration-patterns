<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Tenant Encrypted Ingestion: Threat Model

> Status: **Draft from the specification, 2026-11-05; revised the same day
> after an independent security review (30 findings, F-1..F-30, report kept
> out of the repository); not yet verified by an integration run.** 64
> threats (T-1 to T-64), 58 mitigations (M-1 to M-58), 14 accepted risks.
> Written from
> [`design/tenant-encrypted-ingestion.spec.md`](./design/tenant-encrypted-ingestion.spec.md)
> (P-1 to P-11, §3.5, §4, §5, §7, §8, §9, §10) and ADR-0001 to ADR-0017,
> enumerated STRIDE-per-boundary with the threat-modelling MCP server (Threat
> Composer export kept out of the repository). No code exists yet: every
> "planned location" names the file and step the implementation must put the
> control in, and every unit test or integration step named is the check
> that will prove it. Every review finding is adopted into the spec and the
> ADRs and cited below as F-n where it changed a threat, a mitigation or a
> disposition. Security scans are pending; see
> [Security review](#security-review).

Scope: the `TenantEncryptedIngestion` construct (one ingestion bucket with the
`ingest/` and `documents/` prefixes and its separate access-log bucket, one
KMS key per tenant in the `vendor-key` or `tenant-key` tier, the three base
roles and three tenant roles of spec §7.1, the ingestion API with its token
authoriser and per-tenant usage plan, the EventBridge rule, SQS queue and DLQ
and processor Lambda, the hourly sweep, the custom validator chain, the
DynamoDB registry, the construct-owned event bus, logs and Contributor
Insights), the demo stack and its published SSM parameters, the example
validator, and the integration test's test-aid stack. Out of scope: how
tenant-identity issues tokens (its own threat model), what a downstream
consumer does with a landed document (the extraction sample), what a
deployer's own validator checks beyond the §3.5 contract, the tenant's own
AWS account beyond the key it registers, and the internals of S3, KMS and STS
(AWS shared responsibility).

## Actors

| Actor | Trust | What they hold |
|---|---|---|
| Tenant user | authenticated, one tenant | a tenant-identity access token with `tenant_id`, `sub`, `client_id`, `scope` (`ingestion/deliver`, `ingestion/read`); a presigned PUT per delivery |
| Malicious tenant user (same or another tenant) | authenticated | a valid token for tenant B and a will to reach tenant A's prefix, key or rows, or to run up the vendor's bill |
| Internet caller | none | forged, expired or replayed tokens; load |
| Holder of a leaked presigned URL or token | none, but borrows a tenant's | a presigned PUT or GET, or a token, found in a log, a proxy or a client |
| Vendor operator | administrative | IAM credentials with `execute-api:Invoke` on `/platform/*`; a control-plane tenant create script |
| Other IAM principal in the vendor account | elevated | identity policies for `sts:AssumeRole`, `sqs:SendMessage`, `events:PutEvents`, `ssm:PutParameter`, `s3:GetObject` on the access-log bucket, CloudWatch Logs reads |
| Account principal of the vendor account | full, through IAM | key policy statement 3 of every `vendor-key` key: administration plus `kms:PutKeyPolicy`, no use action; any IAM administrator in the account reaches the key through it |
| Tenant AWS account (`tenant-key` tier) | external, owns one key | a KMS key tagged `TenantId`, whose policy trusts the construct's three tenant roles (`tenantRoleArns`) via S3; can remove that statement, disable or delete the key at any time |
| S3 service | AWS | calls KMS on the caller's behalf (`kms:ViaService`); always for a tenant role session |
| Deployer-owned validator function | caller-influenced, no AWS permission from the construct | one presigned GET per call, pinned to one ETag, valid `validatorObjectUrlTtlSeconds` |
| Compromised API, processor or platform function code | caller-influenced | its base role, and the power to assume its one tenant role with any `TenantId` value (T-14) |
| Downstream consumer | its own trust | `DeliveryAccepted` events; its own tenant-scoped credentials |

## Assets

| Asset | Why it matters |
|---|---|
| Tenant documents, drop (`ingest/`) and landed (`documents/`) | The most sensitive data the vendor holds; unvalidated in the drop |
| Tenant KMS keys (both tiers) | The boundary between tenants (P-1); deleting one offboards the tenant (P-6) |
| Tenant role sessions (`tenantUploadRole`, `tenantProcessRole`, `tenantPlatformRole`) | Reach one tenant's prefixes, key and partition (P-2) |
| Tenant access token | The only tenant source on `/tenant/*` (P-2) |
| Presigned PUT and GET URLs | Each writes once or reads exactly one object for minutes |
| Registry rows | Bind a tenant to its key ARN; carry delivery status, leases, counters and the file name |
| Delivery events | Tell consumers what landed and where |
| Logs, metrics, access logs | Must carry the tenant, never content; Lambda logs never a URL, signature or file name (P-9, N-6) |
| Shared account quotas (STS, KMS, Lambda) | One tenant must not exhaust them for the others (N-8) |
| Published parameters | Tell consumers and `tenant-key` owners the API and the roles to trust |

## Trust boundaries

| Boundary | Crossed by | Authenticated and authorised by | Layer (`ARCHITECTURE.md` §3.3) |
|---|---|---|---|
| B1 Tenant ↔ vendor API | `/tenant/*` with a bearer token; `/platform/*` with SigV4 | token authoriser (M-1), scope in the handler (M-2), tenant id from the authoriser only (M-3), per-tenant usage plan and in-flight cap (M-50); IAM on `/platform/*` (M-6) | Identity |
| B2 Tenant upload → bucket | presigned `PUT` with the §7.5 signed headers | SigV4 of the `tenantUploadRole` session, that role's identity policy, the signed headers, the bucket policy (M-7, M-8, M-45, M-49, M-52) | Data |
| B3 Vendor code → tenant role session | `AssumeRole` + `TagSession` from each base role to its one tenant role; every tenant call after it | tenant role trust policies (M-12), ABAC in the tenant roles' identity policies on `${aws:PrincipalTag/TenantId}` (M-11), tenant id from the key prefix (M-14) | Data |
| B4 S3 ↔ KMS | `GenerateDataKey`, `Decrypt` with `kms:ViaService` | key policy statement 2 on `aws:s3:arn`, statement 4 Deny of every other use, Bucket Keys off on the bucket and per request (M-10, M-43, M-49) | Data |
| B5 Vendor account ↔ tenant account | the same KMS calls on a `tenant-key` key, cross-account | the tenant's key policy trusting the three tenant roles (§7.3) and the identity policies' `aws:ResourceTag/TenantId` (M-11, M-22, M-41) | Data |
| B6 Processor ↔ validator | `lambda:Invoke` with the §3.5 request; the validator's `GET` of the presigned URL | invoke grant or the deployer's resource policy, presigned GET for one object and one ETag, verdict schema (M-23, M-24, M-57) | Data |
| B7 Vendor admin and account principal ↔ key policy | key administration, offboarding, the registry drain | statement 1 explicit actions, statements 3 and 4, `platformRole`'s identity Deny, the alarm (M-28, M-29, M-42, M-43, M-30, M-31) | Data |
| B8 Pipeline → downstream consumers | `DeliveryAccepted` on the construct's bus; `GetObject` of `landedKey` | bus policy with explicit Deny (M-36), consumer's own tenant session (M-19) | Data |
| B9 Everything → telemetry and parameters | logs, access logs, metrics, `ssm:GetParameter` / `PutParameter` | field-allowlisted logger (M-33), separate access-log bucket (M-53), IAM | Observability |

## Threats

STRIDE per boundary: S spoofing, T tampering, R repudiation, I information
disclosure, D denial of service, E elevation of privilege.

| ID | Boundary | STRIDE | Threat |
|---|---|---|---|
| T-1 | B1 | S | Internet caller with a forged, expired, ID or other-client token can call a `/tenant/*` route as a tenant user, leading to deliveries created or read without a sign-in. |
| T-2 | B1 | S | Tenant user with a token that carries a `tenants` claim or no single `tenant_id` can have the API pick a tenant the user did not intend, leading to a delivery presigned under the wrong tenant. |
| T-3 | B1 | E | Tenant user holding only `ingestion/read` can call `CreateDelivery`, leading to a read-only user writing into the tenant's drop. |
| T-4 | B1 | T | Malicious tenant user of tenant A can put tenant B's id in a request body, header, query string or path, leading to a URL presigned for, or a row read from, tenant B. |
| T-5 | B1 | I | Malicious tenant user of tenant A can guess or enumerate a ULID `deliveryId` of tenant B on `GetDelivery`, or read tenant B's id or key ARN from an error body, leading to disclosure of another tenant's delivery metadata. |
| T-6 | B1 | T | Malicious tenant user with a valid token can send a `fileName` with `/`, `..`, quotes, control characters or an over-long name, leading to a forged `Content-Disposition` on the landed object, or log injection. |
| T-7 | B1 | E | Tenant user or internet caller without vendor IAM credentials can reach `/platform/*` (`CreateTenantKey`, `DeleteTenantKey`, `RotateTenantKey`), leading to tenant keys created, rebound or offboarded by a non-vendor. |
| T-8 | B2 | T | Malicious tenant user holding a presigned PUT for its own prefix can edit the URL's object key to another tenant's prefix, or forge a URL for one, leading to a document planted in another tenant's drop. |
| T-9 | B2 | T | Uploader holding a valid presigned PUT can swap the `x-amz-server-side-encryption-aws-kms-key-id` header for another tenant's key or a key it controls, leading to an object under A's prefix encrypted with a key other than A's. |
| T-10 | B2 | T | Uploader holding a valid presigned PUT can omit the SSE headers, ask for SSE-S3, or upload over plain HTTP, leading to a tenant object at rest without the tenant's key, or in flight without TLS. |
| T-11 | B2 | S | Holder of a leaked presigned PUT URL before it is used and before `uploadUrlTtlSeconds` passes can upload a document of its choosing as the tenant, leading to an attacker-chosen document entering the tenant's pipeline. |
| T-12 | B2 | T | Uploader after the cheap checks at `CreateDelivery` passed can upload content that differs from the declared type: a polyglot, an archive bomb, leading to malformed content landing, or the processor exhausted. |
| T-13 | B2 | T | Uploader still holding an unexpired presigned PUT (reusable until expiry) can overwrite the drop object during or after validation, leading to bytes landing in `documents/` that differ from the bytes the chain checked, or unvalidated objects left in `ingest/`. |
| T-14 | B3 | E | Compromised API, processor or platform function code can assume its tenant role with tenant B's `TenantId` (the trust policy fixes the tag key, not its value), leading to that function acting as tenant B, one session at a time. |
| T-15 | B3 | S | Uploader controlling object metadata or event detail can make the processor take the tenant id from `x-amz-meta-*`, the event detail or the file name instead of the key prefix, leading to a delivery processed, landed and metered under the wrong tenant. |
| T-16 | B3 | E | Other IAM principal in the vendor account with an identity policy allowing `sts:AssumeRole` can assume a tenant role, or add session tags beyond `TenantId`, or none, leading to a tenant session minted outside the three functions. |
| T-17 | B3 | E | Compromised function using its base role without a tenant session can reach tenant objects or keys, or use another function's powers (API reading objects, processor creating keys, platform function using a key), leading to isolation bypassed below the ABAC layer. |
| T-18 | B3 | T | Other IAM principal in the vendor account with `sqs:SendMessage` in its identity policy, or a replay of a captured S3 event, can inject an `Object Created` message, leading to a delivery reprocessed, a rejected one revisited, or a landed one overwritten. |
| T-19 | B3 | T | At-least-once delivery from S3, EventBridge and SQS can deliver the same event twice or concurrently, leading to double counters, double events, or a race between two processor runs. |
| T-20 | B4 | E | Principal holding tenant A's key permissions through a pipeline bug or a leaked key ARN can use A's key on B's prefix, or B's key on A's prefix, leading to a tenant's key protecting or exposing another tenant's objects. |
| T-21 | B4 | I | Deployer or later configuration drift can enable S3 Bucket Keys on the bucket, leading to the encryption context becoming the bucket ARN and the key-to-prefix binding silently no longer holding. |
| T-22 | B4 | E | Compromised code holding a tenant session can call KMS directly (`Decrypt`, `GenerateDataKey`) instead of through S3, leading to the key used outside the bucket, on ciphertext copied elsewhere. |
| T-23 | B4 | D | Tenant looping `CreateDelivery` or uploads can exhaust the account-wide STS `AssumeRole` quota (600 rps, shared with the rest of the account), the vendor's KMS request quota (also charged for `tenant-key` traffic), Lambda concurrency or queue throughput, leading to every other tenant throttled (noisy neighbour). |
| T-24 | B5 | D | Tenant AWS account owning a `tenant-key` key can remove the key-policy statement for the vendor's roles, disable the key, schedule deletion or delete it while deliveries are in flight, leading to retries into the DLQ, half-landed deliveries, or a corrupt file reported for a missing key. |
| T-25 | B5 | E | Tenant AWS account registering a `tenant-key` key can tag its key with another tenant's `TenantId`, omit the encryption-context condition, or hand over a key ARN it does not own or that another tenant already uses, leading to a key the identity policy admits for the wrong tenant. |
| T-26 | B5 | R | Tenant or vendor can dispute whether a document was delivered, by whom, or when a key was revoked, leading to no evidence to settle the dispute. |
| T-27 | B5 | I | S3 and the processor under SSE-KMS can see the document in plaintext in flight behind TLS and in memory, leading to a tenant expecting vendor-blind delivery being mistaken. |
| T-28 | B6 | I | Compromised or careless validator receiving a presigned GET can copy the document out, or persist or log the URL for later use, leading to disclosure of one tenant document. |
| T-29 | B6 | E | Compromised validator invoked by the processor can obtain AWS credentials from the processor or reach any object other than the one it was given, leading to a validator reading across tenants. |
| T-30 | B6 | T | Validator can return a malformed, empty or unexpected verdict, a function error, or extra fields, leading to the processor reading a bad verdict as `ACCEPT`. |
| T-31 | B6 | D | Validator can hang, time out, throttle or fail on every call, leading to deliveries for every tenant held, or a queue backlog. |
| T-32 | B6 | I | Validator can put document content into its verdict `message`, leading to content stored on the registry row and returned by `GetDelivery`. |
| T-33 | B6 | T | Compromised validator can return `ACCEPT` for a document it should reject, leading to a document admitted that the deployer's rule would refuse. |
| T-34 | B7 | E | Vendor operator holding `platformRole` can decrypt tenant objects with a tenant key, leading to vendor staff reading tenant documents outside the pipeline. |
| T-35 | B7 | E | `platformRole` holding `kms:Create*` (which includes `kms:CreateGrant`) or `kms:Put*` can grant itself `Decrypt` with no `kms:ViaService` or context condition, or rewrite the key policy, leading to the binding removed by the role meant only to administer it. |
| T-36 | B7 | E | Any IAM administrator in the vendor account, through the account principal in statement 3, can call `PutKeyPolicy` to add itself and then use any `vendor-key` key outside statement 2, leading to residual trust in the vendor account's IAM administration. |
| T-37 | B7 | D | Vendor operator can offboard the wrong tenant, or have `DeleteTenantKey` stop half way, leading to documents destroyed in error, or an offboarded tenant's objects left readable. |
| T-38 | B7 | T | Stack delete while the API still accepts calls can race a `CreateTenantKey` against the registry drain (the sentinel checked only at the `CREATING` write, an eventually consistent scan, invocations in flight after the function is deleted), leading to a key created after the drain listed the rows, never scheduled for deletion. |
| T-39 | B7 | I | Vendor administrator during the deletion window can cancel a pending key deletion after `cdk destroy` or `DeleteTenantKey`, leading to ciphertext copied out before deletion becoming readable again. |
| T-40 | B8 | I | Downstream consumer with a broad role subscribed to `DeliveryAccepted` can read `landedKey` (or an `ingest/` object) without tenant-scoped credentials, leading to isolation turned from enforced to filtered downstream. |
| T-41 | B8 | S | Other IAM principal in the vendor account with `events:PutEvents` in its identity policy can publish a forged `DeliveryAccepted` on the construct's bus, leading to consumers acting on a delivery that never passed the chain. |
| T-42 | B9 | I | Anyone with log read access can find a presigned PUT or GET URL, its signature and access key id, or a file name in Lambda, API Gateway, validator or S3 server access logs, leading to a leaked URL replayed within its lifetime, or personal data in logs. |
| T-43 | B9 | R | S3 server access logs and CloudTrail in formats the sample does not control can record requests without a tenant field, leading to per-tenant activity not attributable from that log alone. |
| T-44 | B9 | R | Pooled S3, Lambda, SQS, EventBridge and API Gateway can report usage that carries no tenant, leading to per-tenant cost not attributable without metering. |
| T-45 | B9 | T | Other IAM principal in the vendor account with `ssm:PutParameter` can overwrite the published `apiUrl` or `tenantRoleArns`, leading to consumers sent elsewhere, or a `tenant-key` owner trusting the wrong roles. |
| T-46 | B3 | D | A thrown error, a crash, a held validator error or a DLQ replay can leave a delivery `PROCESSING` that every retry treats as a duplicate (F-8), leading to a delivery that never reaches a terminal state and a drop object that expires with no event. |
| T-47 | B7 | I | `DeleteTenantKey` and the drain running under a session that cannot list a prefix or delete under `documents/` (F-9) can return having removed nothing landed, leading to an offboarded tenant's documents left readable under a live key (`tenant-key`) or until the deletion window ends. |
| T-48 | B5 | D | A `tenant-key` probe or status refresh made as a direct KMS call meets the key policy's `kms:ViaService` and encryption-context conditions (F-7), leading to every `tenant-key` registration refused and a healthy key flipped to `REVOKED`. |
| T-49 | B7 | E | `CreateKey` with an explicit policy passes the lockout safety check only if the calling role may later call `kms:PutKeyPolicy` (F-4), leading to `platformRole` needing the one permission that lets it rewrite every tenant's binding. |
| T-50 | B3 | E | The `KEYARN#` uniqueness items, the `DRAINING` sentinel and the cross-tenant sweep are unreachable under `dynamodb:LeadingKeys` (F-10), leading to a table-wide principal that, misused or compromised, reads and writes every tenant's registry rows. |
| T-51 | B2 | D | Uploader holding a URL for a declared 1 KB delivery can send up to 5 GB per URL (F-12), leading to storage, KMS and request cost amplified onto the vendor's pooled bill before any check rejects it. |
| T-52 | B9 | I | A tenant-chosen file name in the object key (`smith-passport.pdf`) is copied into CloudTrail S3 data events, the KMS encryption context in both accounts' CloudTrail, S3 access logs, EventBridge and SQS bodies and `landedKey` (F-13), leading to personal data spread across logs the sample cannot scrub. |
| T-53 | B1 | E | API Gateway caching the authoriser's decision per token (F-16) can reuse an Allow obtained on `GetDelivery` for `CreateDelivery`, or a route-specific Deny for the next route, leading to a read-only token writing, or a valid call refused, within the cache TTL. |
| T-54 | B2 | D | A URL presigned from a cached session expires when the session's credentials do (F-18), leading to `expiresAt`, the `EXPIRED` sweep and `objectUrlExpiresAt` reporting a URL as valid when it is already dead, or a URL that outlives the TTL the vendor intended. |
| T-55 | B3 | E | An integration step denied by the identity policy before the key policy is reached, or by a missing permission rather than a tag mismatch (F-19), leading to a test that passes while a wall it claims to prove is absent. |
| T-56 | B5 | D | A pipeline fault (a wrong identity or bucket policy) surfaces through S3 as `AccessDenied`, the same shape as a KMS denial (F-20), leading to a healthy tenant marked `REVOKED`, `CreateDelivery` refused for the whole tenant, and no automatic recovery. |
| T-57 | B4 | T | Uploader or a copy call can set `x-amz-server-side-encryption-bucket-key-enabled: true` per object (F-23), leading to the bucket ARN in the encryption context for that object and the prefix binding gone for it. |
| T-58 | B3 | D | A tenant session built with a passed session policy can exceed the 2,048-character packed limit with long ARNs and four statements (F-24), leading to every `AssumeRole` failing and the pipeline stopped. |
| T-59 | B7 | D | Tenant churn at N-3 scale and repeated rotation can consume the KMS key quota (pending-deletion keys count for 7 to 30 days) and the 25 on-demand rotations per key (F-25), leading to `CreateTenantKey` or `RotateTenantKey` failing with an untyped error. |
| T-60 | B7 | I | A presigned URL issued before `DeleteTenantKey` set `DELETING` can still be used after the object purge (F-26), leading to an object landing under an offboarded tenant's prefix with a live `tenant-key` key, readable by the vendor until the lifecycle runs. |
| T-61 | B9 | I | Deviations from the sample standard (F-27): Lambda's implicit log groups surviving `cdk destroy`, an access-log bucket under the SSE-KMS-only policy, unencrypted queues, incomplete multipart uploads, EventBridge events dropped on target failure, leading to data left behind after destroy, access logging that silently fails, or deliveries lost. |
| T-62 | B6 | I | A validator's `FunctionError` body can echo its `objectUrl`, and a validator in another account cannot be invoked through `LambdaValidator.bind` alone (F-29a, b), leading to the URL in the processor's logs, or a deployer widening the processor's permissions to make a cross-account validator work. |
| T-63 | B6 | D | Tenant submitting many deliveries multiplies validator invocations, each up to its timeout, across the chain (F-29c), leading to Lambda cost and concurrency amplified per delivery for every tenant. |
| T-64 | B9 | R | Metering that counts three KMS requests per delivery omits the processor's read and each validator's `GET` (F-22), leading to per-tenant KMS cost under-reported and N-2's headroom overstated. |

## Mitigations

Each mitigation names the principle and ADR it realises and the planned code
location. "Deployer action" items belong in the README's production hardening
checklist. Role, policy and statement names follow spec §7.

| ID | Mitigation | Realises | Planned location |
|---|---|---|---|
| M-1 | Token authoriser on every `/tenant/*` method: JWKS signature, `iss` from `identity.discoveryUrl`, `client_id` in `identity.allowedClientIds`, `exp`, `token_use: access`; a single string `tenant_id` required; a token carrying `tenants` refused; every refusal a Deny; an Allow is always for `/tenant/*` with `tenantId`, `sub` and `scope` in the context | P-2, [ADR-0012][adr-0012] | `src/authoriser/handler.ts`, `src/construct/api.ts` (authoriser on each `/tenant/*` method); unit test one case per refusal |
| M-2 | Scope enforced by the **handler** per route, never by the authoriser: `ingestion/deliver` for `CreateDelivery`, `ingestion/read` for `GetDelivery` and `ListDeliveries`; the authoriser's cached policy is the same for every route, so a cached decision cannot carry a scope; cache TTL at most 300 s, documented as the token revocation lag (F-16); both scopes registered in tenant-identity's catalogue at deploy (`PutScope`) | P-2, [ADR-0012][adr-0012] | `src/api/handler.ts` (route table with required scope), `src/construct/api.ts` (authoriser cache TTL, scope registration custom resource); integ step 3 |
| M-3 | The tenant id on `/tenant/*` comes only from `requestContext.authorizer.tenantId`; no route reads a tenant id from body, header, query or path; every registry read and write uses `PK = TENANT#<caller>`, so `GetDelivery` of another tenant's ULID is a 404 and `ListDeliveries` has no cross-tenant query to write | P-2, [ADR-0011][adr-0011], [ADR-0012][adr-0012] | `src/api/handler.ts` (context extraction), `src/shared/registry.ts` (key builder); unit tests |
| M-4 | Fixed error model `{code, message, requestId}`; `/tenant/*` bodies never carry a tenant id or a key ARN | P-2, [ADR-0012][adr-0012] | `src/api/errors.ts`; unit test over every error path |
| M-5 | `fileName` restricted to `[A-Za-z0-9._-]{1,128}`, no leading dot, validated at `CreateDelivery` (400 otherwise) and in the Smithy model; it is used only in a quoted `Content-Disposition` and never in a key, log or event (M-46) | P-7, [ADR-0007][adr-0007], [ADR-0017][adr-0017] | `src/api/handler.ts` (`CreateDelivery` input validation), Smithy `@pattern` on `fileName` in `model/` |
| M-6 | `/platform/*` uses `AWS_IAM` authorisation only; the token authoriser is not attached there and no tenant route reaches a platform operation | P-8, [ADR-0012][adr-0012] | `src/construct/api.ts` (method authorisation per resource); template assertion |
| M-7 | The presigned PUT is signed under a `tenantUploadRole` session whose **identity policy** allows `s3:PutObject` only on `ingest/${aws:PrincipalTag/TenantId}/*`, for the key `ingest/<tenantId>/<deliveryId>` the vendor chose; the §7.5 headers (SSE, key id, bucket-key flag, `If-None-Match`, `Content-Length`, `Content-Type`) are signed, so editing the path, the key or a header breaks the signature or meets the identity policy | P-7, [ADR-0003][adr-0003], [ADR-0007][adr-0007] | `src/shared/presign.ts`, `src/api/handler.ts` (`CreateDelivery`); integ step 4 |
| M-8 | Bucket policy: deny any request with `aws:SecureTransport = false`; deny `s3:PutObject` unless `s3:x-amz-server-side-encryption = aws:kms` (also catches a missing header); block public access; Bucket Keys off on the bucket | P-3, [ADR-0001][adr-0001] | `src/construct/bucket-policy.ts`; template assertion; integ step 4 |
| M-9 | The processor re-checks every object: `HeadObject` `SSEKMSKeyId` equals the registry key for the prefix and `BucketKeyEnabled` is false, else `REJECTED structural:KEY_MISMATCH` | P-3, [ADR-0001][adr-0001], [ADR-0002][adr-0002] | `src/processor/handler.ts` step 3 |
| M-10 | Key policy statement 2: `tenantUploadRole`, `tenantProcessRole` and `tenantPlatformRole` get `kms:GenerateDataKey` and `kms:Decrypt` only with `kms:ViaService = s3.<region>.amazonaws.com` and `kms:EncryptionContext:aws:s3:arn` like `arn:aws:s3:::<bucket>/ingest/<tenantId>/*` or `.../documents/<tenantId>/*`; a separate statement grants the same three roles `kms:DescribeKey` with no condition | P-1, [ADR-0002][adr-0002] | `src/platform/key-policy.ts` statement 2 (built by `CreateTenantKey`); unit test on the rendered policy; integ step 5 |
| M-11 | ABAC lives in the **identity policies** of `tenantUploadRole`, `tenantProcessRole` and `tenantPlatformRole` (spec §7.1): S3 only on `<prefix>/${aws:PrincipalTag/TenantId}/*`, KMS only on keys with `aws:ResourceTag/TenantId = ${aws:PrincipalTag/TenantId}` (use also with `kms:ViaService`), DynamoDB only with `ForAllValues:StringEquals dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/TenantId}`. No session policy is passed: a session policy can only narrow, so code that omits it would hold the role's full permissions, while an identity-policy wall cannot be dropped by the caller (F-1). This also removes the 2,048-character session-policy limit (F-24); identity policies allow 10,240 | P-2, [ADR-0003][adr-0003] | `src/construct/roles.ts` (tenant roles); `src/shared/tenant-session.ts` (the one place a tenant session is assumed: tag and session name, no `Policy` parameter); template assertion that every tenant-role statement carries the tag condition; integ steps 5 and 6 |
| M-12 | Tenant role trust policies: each tenant role trusted by exactly one base role (`tenantUploadRole` by `apiRole`, `tenantProcessRole` by `processorRole`, `tenantPlatformRole` by `platformRole`), `sts:AssumeRole` and `sts:TagSession` only, `ForAllValues:StringEquals aws:TagKeys = ["TenantId"]` **and** `Null aws:RequestTag/TenantId = false` (the first alone is true for an empty tag set) and `StringLike aws:RequestTag/TenantId = [a-z0-9-]*` | P-2, [ADR-0003][adr-0003] | `src/construct/roles.ts`; template assertion per trust policy |
| M-13 | Role asymmetry, enforced: `apiRole`, `processorRole` and `platformRole` hold no S3 object permission and no KMS use permission; each may assume only its one tenant role; the API cannot read an object because `tenantUploadRole` has no `s3:GetObject`; the processor cannot create, schedule or administer keys; `platformRole` reaches S3 only through `tenantPlatformRole` (list, delete, the probe) | P-8, [ADR-0003][adr-0003] | `src/construct/roles.ts`; template assertions per role |
| M-14 | The processor takes `tenantId` and `deliveryId` from the second and third key segments, ignores `_probe`, assumes `tenantProcessRole` for that tenant **first** and then loads the delivery row under that session (`LeadingKeys` turns a wrong id into `AccessDenied`, never another tenant's row, F-30a); it requires `objectKey` to equal the event key; object metadata, event detail and file name are never a tenant source | P-2, [ADR-0008][adr-0008] | `src/processor/handler.ts` steps 0-2 |
| M-15 | Conditional transitions: every status write is conditional on the current status and, once leased, on `leaseOwner`; a late duplicate for a terminal delivery only deletes a leftover drop object; counters and the `inFlight` decrement move in the same transaction as the terminal status | P-10, [ADR-0010][adr-0010], [ADR-0011][adr-0011], [ADR-0016][adr-0016] | `src/processor/handler.ts` steps 2 and 7, `src/shared/registry.ts` |
| M-16 | Queue policy with an explicit **Deny** of `sqs:SendMessage` unless `aws:SourceArn` is the construct's EventBridge rule; the DLQ denies everything but its source queue's redrive; both queues SSE-SQS; the rule matches `source: aws.s3`, the bucket name and the `ingest/` prefix. An Allow-only policy would be filtered, because a same-account identity Allow suffices (F-15) | P-10, [ADR-0010][adr-0010] | `src/construct/queues.ts` (rule and queue policies); template assertion |
| M-17 | Structural checks before anything lands: `ContentLength` from `HeadObject` equals `declaredSizeBytes` and is at most `maxObjectSizeBytes` (`TOO_LARGE`, `SIZE_MISMATCH`), magic bytes against the declared type, ZIP central directory bounds (entry count, total uncompressed size, ratio), streamed SHA-256 | P-10, [ADR-0008][adr-0008] | `src/processor/structural.ts`, `src/processor/handler.ts` steps 3-4; unit tests with synthetic polyglot and bomb fixtures |
| M-18 | ETag pins: `dropEtag` is recorded at step 3 and pins the step 4 `GetObject` (`IfMatch`), every validator's presigned `GET` (`If-Match` signed) and the step 6 `CopyObject` (`CopySourceIfMatch`); a `PreconditionFailed` is `REJECTED structural:OBJECT_CHANGED`, so the bytes that land are the bytes that were checked (F-11) | P-10, [ADR-0008][adr-0008], [ADR-0017][adr-0017] | `src/processor/handler.ts` steps 3-6 |
| M-19 | Quarantine: `ingest/` has a `dropRetentionDays` lifecycle and a rejected object is deleted at once; consumers subscribe to `DeliveryAccepted`, read only `documents/` and only under their own tenant-scoped credentials; the event carries no URL | P-10, [ADR-0008][adr-0008], [ADR-0010][adr-0010] | `src/construct/bucket-policy.ts` (lifecycle), `src/processor/handler.ts` step 7; README consumer section |
| M-20 | Presigned PUT bounded to one opaque key, one tenant, one key ARN, the declared size, one write (`If-None-Match`), and `uploadUrlTtlSeconds` (default 900 s, at most 3,300 s); `s3:signatureAge` in the bucket policy kills it at the TTL; an unused URL becomes `EXPIRED` in the hourly sweep; a leaked URL that is used still runs the whole chain | P-7, [ADR-0007][adr-0007] | `src/api/handler.ts`, `src/construct/bucket-policy.ts`, `src/sweep/handler.ts` |
| M-21 | Fail closed on a KMS-coded failure only: the classifier matches the KMS error code S3 surfaces at steps 3-6 (KMS access denied, disabled, invalid state, not found), never a bare S3 `AccessDenied`, and confirms with `DescribeKey` under the tenant session; only a disabled, pending-deletion or missing key, or a `DescribeKey` the key policy denies, sets the delivery `KEY_UNAVAILABLE` and the key row `REVOKED`, publishes `DeliveryKeyUnavailable` and deletes the message without retry; anything else throws (SQS retry, DLQ). `CreateDelivery` returns 409 while the row is not `ACTIVE`. The hourly sweep re-checks every `REVOKED` key and flips it back to `ACTIVE`, so recovery needs no vendor call (F-20) | P-5, [ADR-0005][adr-0005] | `src/processor/errors.ts` (classifier), `src/processor/handler.ts` steps 3-6, `src/sweep/handler.ts`, `src/api/handler.ts`; integ step 8 |
| M-22 | `CreateTenantKey` for `tenant-key`: `DescribeKey` under a `tenantPlatformRole` session requires `KeySpec SYMMETRIC_DEFAULT`, an enabled key and a `TenantId` tag **equal to the path's `tenantId`** (F-30b); a `KEYARN#<arn>` uniqueness item is written in the same transaction as the key row, so one key cannot serve two tenants; `DeleteTenantKey` removes both in one transaction | P-4, [ADR-0004][adr-0004], [ADR-0011][adr-0011] | `src/platform/create-tenant-key.ts`, `src/platform/delete-tenant-key.ts`; integ steps 1 and 11 |
| M-23 | Validator isolation: each call gets a presigned GET for one object, signed under the `tenantProcessRole` session, pinned to `dropEtag`, valid `validatorObjectUrlTtlSeconds` (default 300 s) and never past the session's expiry (M-47); the payload carries no credentials; `LambdaValidator.bind` grants `processorRole` `lambda:InvokeFunction` and the validator nothing | P-11, [ADR-0009][adr-0009] | `src/validators/lambda-validator.ts`, `src/processor/handler.ts` step 5 |
| M-24 | Strict verdict schema: `version: "1"`, `verdict` in `ACCEPT|REJECT`, `code` `[A-Z0-9_]{1,40}`, `message` capped at 1,024 characters, no other properties; a schema failure, `FunctionError` or timeout is a validator error and never `ACCEPT` | P-11, [ADR-0009][adr-0009] | `src/processor/verdict.ts`; unit test per malformed shape |
| M-25 | Validator time is budgeted: per-validator timeout, processor timeout computed at synth from the chain (synth fails if it does not fit 15 minutes), visibility timeout six times that, `onValidatorError` hold or reject, DLQ depth alarm | P-11, [ADR-0009][adr-0009] | `src/construct/index.ts` (timeout budget, DLQ alarm), `src/processor/handler.ts` step 5; integ step 7b |
| M-26 | Validator message hygiene: stored as `reasonMessage`, returned only to the same tenant, never logged (the log line carries `code`); the README states the author's promise not to include content | P-11, [ADR-0009][adr-0009] | `src/processor/verdict.ts`, `src/shared/logger.ts`; README validator section |
| M-27 | Built-in structural checks run first and the chain stops at the first `REJECT`; each validator's verdict is recorded on the row with its name, so an `ACCEPT` is attributable to one validator | P-11, [ADR-0009][adr-0009] | `src/processor/handler.ts` steps 4-5 |
| M-28 | Key policy statement 1 gives `platformRole` an explicit action list: `kms:CreateAlias`, `kms:DeleteAlias`, `kms:DescribeKey`, `kms:EnableKeyRotation`, `kms:GetKeyRotationStatus`, `kms:RotateKeyOnDemand`, `kms:TagResource`, `kms:UntagResource`, `kms:ListResourceTags`, `kms:GetKeyPolicy`, `kms:ScheduleKeyDeletion`, `kms:CancelKeyDeletion`. No wildcard (`kms:Create*` would include `kms:CreateGrant`, F-3), no `kms:PutKeyPolicy`, no use action | P-1, [ADR-0002][adr-0002] | `src/platform/key-policy.ts` statement 1; unit test asserts the exact list and the absence of `CreateGrant`, `PutKeyPolicy`, `Decrypt`, `Encrypt`, `GenerateDataKey*`, `ReEncrypt*` |
| M-29 | Detect key-policy changes: an EventBridge rule on CloudTrail `PutKeyPolicy`, `CreateGrant`, `CancelKeyDeletion` and `Decrypt` outside `kms:ViaService` for keys tagged `TenantId`, alarmed (deployer action; CloudTrail is account-level). It is what makes the account-principal residual (T-36) visible | P-1, [ADR-0002][adr-0002], [ADR-0013][adr-0013] | README production hardening checklist |
| M-30 | Offboarding order: row to `DELETING` and the tenant's API key removed first (no new presign), objects under both prefixes listed and deleted in pages of 1,000 under a `tenantPlatformRole` session (M-40), alias deleted, `ScheduleKeyDeletion` with `keyDeletionWindowDays`, row and `KEYARN#` item removed in one transaction last; idempotent on retry; the window lets an operator cancel a wrong delete | P-6, [ADR-0006][adr-0006] | `src/platform/delete-tenant-key.ts`; integ step 11 |
| M-31 | Registry drain runs after the API is gone: the API and platform function depend on the drain resource so CloudFormation deletes them first; the drain writes a `DRAINING` sentinel that `CreateTenantKey` checks at the `CREATING` write **and** at the `ACTIVE` flip, and a flip that fails on the sentinel schedules the just-created key for deletion before returning 409; the drain reads with `ConsistentRead`, waits one platform-function timeout after the sentinel, re-scans, and as a backstop lists keys by the construct's `tei:stack` tag and schedules any the registry does not know (F-21) | P-6, [ADR-0006][adr-0006] | `src/construct/index.ts` (dependency order), `src/platform/drain.ts`, `src/platform/create-tenant-key.ts` |
| M-32 | Per-tenant metering and burst absorption: `kmsRequests`, bytes and deliveries per tenant in the structured log and on the key row, Contributor Insights top-tenant rules, processor reserved concurrency and SQS `maximumConcurrency` so a burst queues instead of hitting KMS | P-9, [ADR-0013][adr-0013] | `src/construct/index.ts` (rules, concurrency), `src/processor/handler.ts` step 7 |
| M-33 | Field-allowlisted logger: only `tenantId`, `deliveryId`, `validator`, `verdict`, `code`, `errorType`, `durationMs`, `status`, `sizeBytes`, `kmsRequests`; never a URL, signature, header, file name or validator error body; the API Gateway access log format omits the query string | P-9, [ADR-0013][adr-0013] | `src/shared/logger.ts`, `src/construct/api.ts` (access log format); unit test and integ step 7b assert no `X-Amz-Signature` and no file name |
| M-34 | `tenantId` in every Lambda log line and the API access log (`$context.authorizer.tenantId`); S3 access logs and CloudTrail name the tenant through the session name (M-51), with the second key segment as the fallback join in `architecture.md` | P-9, [ADR-0013][adr-0013] | `src/shared/logger.ts`, `src/construct/api.ts`; `architecture.md` observability section; integ step 10 |
| M-35 | Cost attribution: `TenantId` cost allocation tag on every `vendor-key` key; per-tenant counters and `kmsRequests` metered for pooled S3 and KMS; the formula and the unattributable remainder (API Gateway, Lambda, SQS, EventBridge, apportioned by deliveries) in the README Costs section, which also says `tenant-key` requests are throttled against the vendor's quota and that the billed account is not documented | P-9, [ADR-0013][adr-0013] | `src/platform/create-tenant-key.ts` (tags), `src/processor/handler.ts` step 7; README Costs |
| M-36 | The construct owns its event bus; its resource policy has an explicit **Deny** of `events:PutEvents` unless `aws:PrincipalArn` is `processorRole` (F-15), and events carry `source: tenant-encrypted-ingestion` | P-8, [ADR-0010][adr-0010] | `src/construct/events.ts` (event bus policy); template assertion |
| M-37 | Audit trail: the delivery row keeps `createdBy` (`sub`), `sha256`, `sizeBytes`, `dropEtag`, the validator list and timestamps; PITR on; S3 access logs; CloudTrail `AssumeRole` events carry the `TenantId` tag and the session name; KMS calls on a `tenant-key` key appear in the tenant's own CloudTrail | P-2, [ADR-0011][adr-0011], [ADR-0013][adr-0013] | `src/processor/handler.ts` step 7, `src/construct/registry.ts` (PITR), `src/construct/bucket-policy.ts` (access logging) |
| M-38 | Published parameters are written by the demo stack only; the README key policy takes `tenantRoleArns` from the deployer's own channel, and the hardening checklist restricts `ssm:PutParameter` on `/application-plane/shared/ingestion/*` | P-8, [ADR-0014][adr-0014] | `src/main.ts` (parameters); README production hardening checklist |
| M-39 | `PROCESSING` is a lease: `leaseOwner` (SQS message id) and `leaseUntil` on the row; the same message or an expired lease re-enters at step 2 and continues; a live lease held by another message exits; the hourly sweep moves leases more than one processor timeout past `leaseUntil` to `REJECTED structural:PROCESSING_ABANDONED`, deleting the drop object (F-8) | P-10, [ADR-0010][adr-0010], [ADR-0016][adr-0016] | `src/processor/handler.ts` step 2, `src/sweep/handler.ts`; integ steps 7b (DLQ redrive) and 7c (abandoned lease) |
| M-40 | `tenantPlatformRole`, trusted by `platformRole` only, holds `s3:ListBucket` with `s3:prefix` like `ingest/${tag}/*` and `documents/${tag}/*` and `s3:DeleteObject` on both prefixes, so offboarding and the drain can enumerate and delete everything a tenant has (F-9) | P-6, P-8, [ADR-0003][adr-0003], [ADR-0006][adr-0006] | `src/construct/roles.ts`, `src/platform/delete-tenant-key.ts`; integ step 11 |
| M-41 | The `tenant-key` probe runs **through S3**: `PutObject`, `HeadObject`, `GetObject`, `DeleteObject` of `ingest/<tenantId>/_probe/<ulid>` with the key under a `tenantPlatformRole` session; `DescribeKey` has its own unconditioned statement in the §7.3 template and in the vendor's statement 2; the processor and the EventBridge rule ignore `_probe/` (F-7) | P-4, P-5, [ADR-0004][adr-0004], [ADR-0005][adr-0005] | `src/platform/create-tenant-key.ts`, `src/processor/handler.ts` step 0, `src/construct/queues.ts` (rule filter); integ step 1 |
| M-42 | `CreateKey` is called with `BypassPolicyLockoutSafetyCheck = true`, so `platformRole` never needs `kms:PutKeyPolicy`; `platformRole`'s identity policy carries an explicit **Deny** of `kms:PutKeyPolicy`, `kms:CreateGrant`, `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey*`, `kms:ReEncrypt*`; the account principal in statement 3 keeps the key manageable (F-4) | P-1, P-8, [ADR-0002][adr-0002] | `src/platform/create-tenant-key.ts` (`CreateKey` call), `src/construct/roles.ts` (`platformRole`); template assertion; unit test on the `CreateKey` input |
| M-43 | Key policy statement 3 gives the account principal the statement 1 actions plus `kms:PutKeyPolicy`, and no use action or `kms:CreateGrant`; statement 4 **denies** `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey*`, `kms:ReEncrypt*`, `kms:CreateGrant` to `*` unless `aws:PrincipalArn` is one of the three tenant roles **and** `kms:ViaService` is S3 **and** the encryption context matches the tenant's prefix. Every IAM identity policy in the vendor account, `AdministratorAccess` included, is refused until someone rewrites the key policy (F-3, F-5) | P-1, [ADR-0002][adr-0002] | `src/platform/key-policy.ts` statements 3 and 4; unit test on the rendered policy; integ step 5 (`TestProbeRole` refused by statement 4) |
| M-44 | `platformRole` is the one table-wide registry principal, named and filtered (F-10): it writes the tenant row and the `KEYARN#` item in one transaction, reads every row in the drain, and queries the sparse GSI (`statusBucket`, `expiresAt`) in the sweep, never a Scan; it is reached only through `/platform/*` (IAM), the drain and the sweep, never by a tenant request; no other role reaches the table without `LeadingKeys` | P-8, [ADR-0011][adr-0011] | `src/construct/roles.ts`, `src/construct/registry.ts` (GSI), `src/sweep/handler.ts`; template assertion that only `platformRole` lacks `LeadingKeys` |
| M-45 | `Content-Length` equal to the declared `sizeBytes` is a signed header of the presigned PUT, so a larger body fails the signature; the processor rejects a measured size that differs as `structural:SIZE_MISMATCH` (F-12) | P-7, P-10, [ADR-0007][adr-0007] | `src/shared/presign.ts`, `src/processor/handler.ts` step 3; integ step 4 |
| M-46 | Opaque object key `ingest/<tenantId>/<deliveryId>` and `documents/<tenantId>/<deliveryId>`: the file name lives only on the delivery row and in the landed object's `Content-Disposition`; events, logs, SQS bodies and KMS encryption context carry no file name (F-13) | P-7, N-6, [ADR-0017][adr-0017] | `src/api/handler.ts`, `src/processor/handler.ts` step 6, `src/shared/events.ts`; integ step 3 (`Content-Disposition`) and 7b (no file name in logs) |
| M-47 | Fresh-session rule: tenant sessions are requested for 3,600 s (the role-chaining cap); a function presigns only when the session's remaining lifetime is at least the URL's TTL plus 60 s, and reports `expiresAt = min(now + TTL, credentials.Expiration)`, the same for `objectUrlExpiresAt`; `uploadUrlTtlSeconds` above 3,300 fails synth; the bucket policy denies requests whose `s3:signatureAge` exceeds the TTL (F-18) | P-7, [ADR-0007][adr-0007] | `src/shared/tenant-session.ts`, `src/shared/presign.ts`, `src/construct/index.ts` (prop validation), `src/construct/bucket-policy.ts`; unit tests |
| M-48 | Test-aid stack: `TestProbeRole` (identity policy `s3:*` on the bucket, `kms:*` on `*`) so a denial it meets can only come from a key policy or the bucket policy; `TestConsumerRole` shaped like a downstream consumer for the cross-tenant read; context `tenantKeyAccount` puts the `tenant-key` key in a real second account; error sources asserted by message, not by exception class (F-19) | P-1, P-2, [ADR-0003][adr-0003], [ADR-0004][adr-0004] | `test/integ/test-aid-stack.ts`, `scripts/integ.sh`; integ steps 1, 5, 6, 9 |
| M-49 | `x-amz-server-side-encryption-bucket-key-enabled: false` is signed into the presigned PUT and set on `CopyObject`; the bucket policy denies `s3:PutObject` when the header is `true`; statement 4 would also refuse (fail closed); M-9 still checks `BucketKeyEnabled` (F-23) | P-1, [ADR-0002][adr-0002] | `src/shared/presign.ts`, `src/processor/handler.ts` step 6, `src/construct/bucket-policy.ts`; integ step 5 |
| M-50 | Per-tenant limits (N-8, F-17): one usage plan and one API key per tenant on `/tenant/*` (`tenantThrottle`), issued at `CreateTenantKey`, id on the key row, removed at `DeleteTenantKey`; `CreateDelivery` increments `inFlight` in the same conditional write as the delivery row and returns 429 `TooManyDeliveries` at `maxInFlightPerTenant`; every terminal transition decrements it and the sweep reconciles it. Together they bound one tenant's STS, KMS, Lambda and validator consumption | P-9, [ADR-0015][adr-0015] | `src/construct/api.ts` (usage plan), `src/platform/create-tenant-key.ts`, `src/api/handler.ts`, `src/processor/handler.ts` step 7, `src/sweep/handler.ts`; integ step 7 |
| M-51 | `RoleSessionName = t-<tenantId>-<deliveryId | operation>` on every tenant session: S3 access logs (`Requester`), CloudTrail S3, KMS and STS events name the tenant without a join; the principal tag appears in the `AssumeRole` event (F-28) | P-9, [ADR-0003][adr-0003], [ADR-0013][adr-0013] | `src/shared/tenant-session.ts`; integ step 10 |
| M-52 | Write-once drop object: `If-None-Match: *` is a signed header of the presigned PUT, and the bucket policy denies `s3:PutObject` to `ingest/*` when `s3:if-none-match` is `Null`; a second PUT to the same URL is `412`; the processor deletes any drop object whose row is terminal, missing or `DELETING` (F-11) | P-3, P-10, [ADR-0017][adr-0017] | `src/construct/bucket-policy.ts`, `src/shared/presign.ts`, `src/processor/handler.ts` step 2; integ step 4 |
| M-53 | S3 server access logs go to a **separate** bucket: SSE-S3 (access logging requires it), `DESTROY` and auto-delete, retention `dropRetentionDays` plus 30 days, `s3:GetObject` allowed to `accessLogReaderRole` only (unset: only the account principal); a logged signature is single-use and dead after the TTL (F-14, F-27c) | N-6, [ADR-0013][adr-0013] | `src/construct/access-log-bucket.ts`; template assertion |
| M-54 | Standard compliance (N-7, F-27): cdk-nag `AwsSolutionsChecks` in `src/main.ts`; an explicit `LogGroup` with `DESTROY` and `logRetention` for every function; SSE-SQS on queue and DLQ; `AbortIncompleteMultipartUpload` after 1 day on `ingest/`; EventBridge target retry policy and its own DLQ; DLQ retention 14 days, longer than any drop object; each asserted by a template test | N-7, [ADR-0014][adr-0014] | `src/main.ts`, `src/construct/*.ts`, `test/construct.test.ts` |
| M-55 | KMS quotas stated and typed (F-25): N-3 counts keys pending deletion against the 100,000-key quota and the README states the churn cost; `RotateTenantKey` maps `LimitExceededException` (25 on-demand rotations per key) to 409 `RotationLimitReached` | P-6, [ADR-0001][adr-0001], [ADR-0006][adr-0006] | `src/platform/rotate-tenant-key.ts`; unit test; README Costs and quotas |
| M-56 | URLs in flight at offboarding (F-26): the API key and the row change first, so no new URL is issued; the processor deletes any drop object whose row is missing or `DELETING` and publishes nothing; `DeleteTenantKey` schedules a final prefix sweep after `uploadUrlTtlSeconds`; `s3:signatureAge` and, for `vendor-key`, the pending-deletion key refuse late PUTs | P-6, [ADR-0006][adr-0006] | `src/platform/delete-tenant-key.ts`, `src/processor/handler.ts` step 2, `src/sweep/handler.ts`; integ step 11 |
| M-57 | Validator carrier hygiene (F-29a, b): the processor logs a validator error's `errorType` only, never its body; a unit test feeds a URL-bearing error body and asserts it is never logged; the README says a validator in another account needs a resource policy on its function allowing `processorRole` to invoke (deployer action), so the processor's role never widens | P-11, [ADR-0009][adr-0009] | `src/processor/handler.ts` step 5, `src/shared/logger.ts`; README validator section; integ step 7b (`always-error`) |
| M-58 | KMS requests metered as counted calls (F-22): four plus one per validator for an accepted delivery (`GenerateDataKey` on upload, `Decrypt` on the processor's read, `Decrypt` per validator `GET`, `Decrypt` plus `GenerateDataKey` on the copy) and the probe calls; N-2 restated with current quotas; integ step 10 reconciles the metered value once against CloudTrail | P-9, [ADR-0013][adr-0013] | `src/processor/handler.ts` step 7, `src/platform/create-tenant-key.ts`; integ step 10 |

## Threat to mitigation mapping

| Threat | Mitigations | Disposition |
|---|---|---|
| T-1 | M-1 | Mitigated by design |
| T-2 | M-1 | Mitigated by design |
| T-3 | M-2 | Mitigated by design |
| T-4 | M-3 | Mitigated by design |
| T-5 | M-3, M-4 | Mitigated by design |
| T-6 | M-5, M-46 | Mitigated by design |
| T-7 | M-6 | Mitigated by design |
| T-8 | M-7 | Mitigated by design |
| T-9 | M-7, M-9 | Mitigated by design |
| T-10 | M-8 | Mitigated by design |
| T-11 | M-20, M-47, M-52 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-12 | M-17, M-45 | Mitigated by design |
| T-13 | M-18, M-52 | Mitigated by design |
| T-14 | M-11, M-12, M-13, M-50, M-51 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-15 | M-14 | Mitigated by design |
| T-16 | M-12 | Mitigated by design |
| T-17 | M-13, M-42 | Mitigated by design |
| T-18 | M-14, M-15, M-16 | Mitigated by design |
| T-19 | M-15, M-39 | Mitigated by design |
| T-20 | M-9, M-10, M-11, M-43 | Mitigated by design |
| T-21 | M-8, M-9 | Mitigated by design |
| T-22 | M-10, M-11, M-43 | Mitigated by design |
| T-23 | M-32, M-50 | Mitigated by design |
| T-24 | M-21 | Mitigated by design |
| T-25 | M-9, M-22, M-41, M-48 | Unverified until the `tenantKeyAccount` integration run; accepted meanwhile, see [Accepted risks](#accepted-risks) |
| T-26 | M-37, M-51 | Mitigated by design |
| T-27 | none | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-28 | M-23 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-29 | M-23 | Mitigated by design |
| T-30 | M-24 | Mitigated by design |
| T-31 | M-25 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-32 | M-26 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-33 | M-27 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-34 | M-13, M-28, M-42, M-43 | Mitigated by design |
| T-35 | M-28, M-29, M-42, M-43 | Mitigated by design |
| T-36 | M-29, M-43 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-37 | M-30, M-40 | Mitigated by design |
| T-38 | M-31 | Mitigated by design |
| T-39 | M-29 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-40 | M-19 | Mitigated by design |
| T-41 | M-36 | Mitigated by design |
| T-42 | M-20, M-33, M-47, M-52, M-53 | Mitigated by design for Lambda, API Gateway and validator logs; Accepted (residual) for S3 server access logs, see [Accepted risks](#accepted-risks) |
| T-43 | M-34, M-51 | Mitigated by design |
| T-44 | M-35, M-58 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-45 | M-38 | Mitigated by design |
| T-46 | M-15, M-39 | Mitigated by design |
| T-47 | M-30, M-40 | Mitigated by design |
| T-48 | M-41 | Mitigated by design |
| T-49 | M-42 | Mitigated by design |
| T-50 | M-44 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-51 | M-45, M-50 | Mitigated by design |
| T-52 | M-5, M-46 | Mitigated by design |
| T-53 | M-1, M-2 | Mitigated by design |
| T-54 | M-47 | Mitigated by design |
| T-55 | M-48 | Mitigated by design |
| T-56 | M-21 | Mitigated by design |
| T-57 | M-9, M-49 | Mitigated by design |
| T-58 | M-11 | Mitigated by design (moot: no session policy is passed) |
| T-59 | M-55 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-60 | M-47, M-52, M-56 | Mitigated by design |
| T-61 | M-53, M-54 | Mitigated by design |
| T-62 | M-33, M-57 | Mitigated by design |
| T-63 | M-25, M-50 | Mitigated by design |
| T-64 | M-58 | Mitigated by design |

Dispositions changed by the review: T-14 from mitigated to accepted (F-2);
T-23 (F-17) and T-43 (F-28) from accepted to mitigated; T-42 split, with S3
access logs accepted (F-14); T-25 relabelled unverified. T-13, T-18, T-34,
T-35, T-38 and T-41 stay mitigated, but by new or rewritten mitigations,
because the earlier ones did not hold (F-3, F-5, F-11, F-15, F-21).

## Accepted risks

Listed in order of consequence. Each goes on the README's production
hardening checklist unless marked "by design".

- **T-27, plaintext in flight behind TLS (by design).** The sample encrypts
  server side (SSE-KMS, [ADR-0001][adr-0001]). S3 and the processor see each
  document in plaintext inside TLS and in memory; every custom validator
  sees it too. A tenant that needs a drop the vendor cannot read needs the
  sealed-drop tier (client-side envelope with an asymmetric key), an
  extension seam (spec §11), not built.
- **T-14, compromised function code can act as any one tenant.** The tenant
  roles' trust policies fix the tag key, not its value (F-2), so code that
  is compromised inside the API, processor or platform function can assume
  its own tenant role for tenant B. A wrong-tenant **bug** is refused by AWS
  (M-11); deliberate compromise is not. What remains: one tenant role per
  function, so a compromised API can only presign uploads and never read
  (M-12, M-13); every `AssumeRole` is in CloudTrail with the `TenantId` tag
  and a `t-<tenantId>-...` session name (M-51); per-tenant limits bound how
  fast it can move (M-50). Dependency hygiene and code review own the rest
  ([ADR-0003][adr-0003]).
- **T-36, every IAM administrator can reach a `vendor-key` key through the
  account principal.** KMS requires a key to stay manageable, so statement 3
  lets the account principal administer the key and call `PutKeyPolicy`
  ([ADR-0002][adr-0002], spec §7.2). Statement 4 denies every use outside the
  three tenant roles via S3 (M-43), so an administrator has to rewrite the
  key policy first; that call is in CloudTrail and alarmed (M-29), and
  nothing prevents it. A tenant that does not accept this takes the
  `tenant-key` tier ([ADR-0004][adr-0004]), where the tenant's own account
  holds that position instead.
- **T-50, `platformRole` reaches the whole registry.** The uniqueness items,
  the drain sentinel and the sweep cannot live under one tenant's
  `LeadingKeys` (F-10), so one role is table-wide. It is named, reached only
  through IAM-authenticated `/platform/*`, the drain and the sweep, holds no
  S3 or KMS use permission (M-42, M-44), and its table access is filtered,
  not enforced ([ADR-0011][adr-0011]).
- **T-25, cross-account `aws:ResourceTag/TenantId` unverified.** The
  identity policies admit a `tenant-key` key by its `TenantId` resource tag,
  which the tenant sets ([ADR-0003][adr-0003], [ADR-0004][adr-0004]). AWS
  documentation shows only same-account examples, so whether the condition
  evaluates against a key in another account is unproven until the
  integration test runs with `tenantKeyAccount` set (M-48, spec §10 step 1);
  ADR-0004 names the fallback (the identity policy names the registered
  `keyArn` list). A tenant that tags its key with another tenant's id still
  cannot get it used for that tenant: `CreateTenantKey` requires the tag to
  equal the path's tenant (M-22), the presigner signs only the registry's
  key (M-7), the key ARN is unique (M-22) and the processor rejects a
  mismatch (M-9). KMS tag changes are eventually consistent for a few
  minutes, so a re-tag can briefly flip results (F-30e).
- **T-42, S3 server access logs record presigned URIs.** The log's
  `Request-URI` carries `X-Amz-Credential` and `X-Amz-Signature` (F-14);
  the sample does not control the format. The logs live in a separate
  bucket readable by one role (M-53), and the URL they record is single-use
  (M-52), size-bound (M-45) and dead after its TTL (M-47). Lambda, API
  Gateway and validator logs never carry a URL (M-33, M-57).
- **T-28, a validator can leak its presigned GET.** A validator that
  persists, logs or forwards its URL exposes that one object, those bytes,
  until `validatorObjectUrlTtlSeconds` passes (default 300 s), and a
  validator can always copy the bytes it was given
  ([ADR-0009][adr-0009]). The URL reaches no other object and carries no
  credential (M-23). The validator is deployer-owned code and its author
  owns that promise.
- **T-32, a validator message could carry document content.** The
  `message` of a `REJECT` is stored on the row and returned by
  `GetDelivery` to the same tenant ([ADR-0009][adr-0009]). M-24 caps its
  length and M-26 keeps it out of logs, but whether it contains content is
  the validator author's responsibility; the README says so.
- **T-33, a compromised validator can accept a document it should reject.**
  Admission is only as strong as the validator the deployer plugged in. The
  structural checks still run first (M-17), the object is still encrypted
  with the tenant's key and lands only in that tenant's prefix, and the row
  records which validator accepted (M-27).
- **T-31, a silent or slow validator holds deliveries in the DLQ.** Under
  `onValidatorError: 'hold'` (the default, [ADR-0009][adr-0009]) a validator
  that times out or errors leaves affected deliveries in the DLQ with their
  objects in the drop until an operator replays them; the lease lets the
  replay finish (M-39) and the drop lifecycle bounds how long an object
  waits. Nothing lands that the chain did not accept. A deployer that
  prefers availability sets `'reject'`. The DLQ depth alarm (M-25) is the
  signal.
- **T-39, a KMS key pending deletion survives `cdk destroy` (by design).**
  KMS deletes keys only after a 7 to 30 day window ([ADR-0006][adr-0006]);
  `cdk destroy` and `DeleteTenantKey` leave keys `PendingDeletion` at no
  cost, and the integration test lists them (spec §10 step 12). Within the
  window an administrator could cancel the deletion; M-29 detects
  `CancelKeyDeletion`.
- **T-59, keys pending deletion count against the KMS key quota (by
  design).** Churn at N-3 scale holds quota for the deletion window, and
  each key has 25 on-demand rotations (F-25). M-55 states both and returns
  a typed 409; raising the quota is a deployer action.
- **T-11, a leaked unused presigned PUT lets a third party upload once.**
  Within its lifetime the holder can write the one object, under that
  tenant's prefix, with that tenant's key, at the declared size
  ([ADR-0007][adr-0007]). It writes once (M-52), dies with its TTL and the
  session (M-47), and the upload runs the whole validation chain (M-20).
  Shorten the TTL for higher-risk tenants.
- **T-44, pooled costs have an unattributable remainder.** API Gateway,
  Lambda, SQS and EventBridge are apportioned by deliveries per tenant;
  KMS requests are counted per call (M-58); `tenant-key` requests are
  throttled against the vendor's quota, and which account is billed for
  them is not documented (M-35, [ADR-0013][adr-0013]).

## Security review

Scans pending: no code has been written yet. Before the pull request, the
security review of the sample standard (`docs/sample-standard.md` §6) runs on
the synthesised tree: `npx projen build` under the deployment profile, then
ProtoShield and the Automated Security Helper against the sample directory
with `cdk.out/` present. Every finding will be dispositioned here (fixed,
accepted with reason, or false positive with evidence); scanner outputs stay
out of the repository.

Independent design review, 2026-11-05: 30 findings (F-1 to F-30; one
critical, eight high, twelve medium, eight low, one informational), all
adopted into the spec and the ADRs, and dispositioned above. The report is
kept out of the repository. Items it could not verify are carried as
integration-test checks: cross-account `aws:ResourceTag` (T-25, step 1),
extra unsigned headers on a presigned PUT (spec §7.5, step 4), and the S3
error codes that surface KMS failures (M-21, step 8).

[adr-0001]: ./adr/0001-encrypt-server-side-with-sse-kms-and-one-kms-key-per-tenant.md
[adr-0002]: ./adr/0002-bind-each-key-to-its-tenant-prefix-in-the-key-policy.md
[adr-0003]: ./adr/0003-put-the-tenant-boundary-in-the-identity-policy-of-one-tenant-role-per-function.md
[adr-0004]: ./adr/0004-offer-two-key-tiers-behind-one-contract.md
[adr-0005]: ./adr/0005-fail-closed-on-an-unusable-key-with-a-distinct-class.md
[adr-0006]: ./adr/0006-make-offboarding-cryptographic.md
[adr-0007]: ./adr/0007-presign-tenant-uploads-from-the-api-under-the-tenant-session.md
[adr-0008]: ./adr/0008-validate-then-land.md
[adr-0009]: ./adr/0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md
[adr-0010]: ./adr/0010-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md
[adr-0011]: ./adr/0011-keep-one-tenant-partitioned-dynamodb-registry.md
[adr-0012]: ./adr/0012-authenticate-tenant-users-with-the-token-contract-and-the-vendor-with-iam.md
[adr-0013]: ./adr/0013-observe-and-attribute-cost-per-tenant.md
[adr-0014]: ./adr/0014-deliver-the-pattern-as-a-cdk-construct.md
[adr-0015]: ./adr/0015-limit-each-tenant-with-a-usage-plan-key-and-an-in-flight-counter.md
[adr-0016]: ./adr/0016-make-processing-a-lease-not-a-terminal-state.md
[adr-0017]: ./adr/0017-write-each-drop-object-once-under-a-key-without-a-file-name.md

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Tenant Encrypted Ingestion: Threat Model

> Status: **Draft from the specification, 2026-11-05; revised the same day
> after an independent security review (30 findings, F-1..F-30, report kept
> out of the repository); revised again the same day after a second blind
> review (20 findings, G-1..G-20, report kept out of the repository); not
> yet verified by an integration run.** 83 threats (T-1 to T-83), 72
> mitigations (M-1 to M-72), 17 accepted risks.
> Written from
> [`design/tenant-encrypted-ingestion.spec.md`](./design/tenant-encrypted-ingestion.spec.md)
> (P-1 to P-11, §3.5, §4, §5, §7.0 to §7.7, §8, §9, §10) and ADR-0001 to
> ADR-0019, enumerated STRIDE-per-boundary with the threat-modelling MCP
> server (Threat Composer export kept out of the repository). No code exists
> yet: every "planned location" names the file and step the implementation
> must put the control in, and every unit test or integration step named is
> the check that will prove it. Every finding of both reviews is adopted
> into the spec and the ADRs and cited below as F-n or G-n where it changed
> a threat, a mitigation or a disposition. Security scans are pending; see
> [Security review](#security-review).

Scope: the `TenantEncryptedIngestion` construct (one versioned ingestion
bucket with the `ingest/` and `documents/` prefixes and its separate
access-log bucket, one KMS key per tenant in the `vendor-key` or
`tenant-key` tier, the six base roles and three tenant roles of spec §7.1,
the ingestion API with its token authoriser and per-tenant usage plan, the
EventBridge rule on the default bus, the SQS queue, its DLQ and the
EventBridge target DLQ, the processor Lambda, the hourly sweep, the registry
watch on the DynamoDB stream, the custom validator chain, the DynamoDB
registry, the construct-owned event bus, logs and Contributor Insights), the
demo stack and its published SSM parameters, the example validator, and the
integration test's test-aid stack. Out of scope: how tenant-identity issues
tokens (its own threat model), what a downstream consumer does with a landed
document (the extraction sample), what a deployer's own validator checks
beyond the §3.5 contract, the tenant's own AWS account beyond the key it
registers, and the internals of S3, KMS and STS (AWS shared
responsibility).

## Actors

| Actor | Trust | What they hold |
|---|---|---|
| Tenant user | authenticated, one tenant | a tenant-identity access token with `tenant_id` (grammar §7.0), `sub`, `client_id`, `scope` (`ingestion/deliver`, `ingestion/read`); a presigned PUT per delivery |
| Malicious tenant user (same or another tenant) | authenticated | a valid token for tenant B and a will to reach tenant A's prefix, key or rows, or to run up the vendor's bill |
| Internet caller | none | forged, expired or replayed tokens; load |
| Holder of a leaked presigned URL or token | none, but borrows a tenant's | a presigned PUT or GET, or a token, found in a log, a proxy or a client |
| Vendor operator | administrative | IAM credentials with `execute-api:Invoke` on `/platform/*`; a control-plane tenant create script; `sqs:StartMessageMoveTask` and `sqs:SendMessage` for a DLQ redrive |
| Other IAM principal in the vendor account | elevated | identity policies for `sts:AssumeRole`, `sqs:SendMessage`, `events:PutEvents`, `ssm:PutParameter`, `s3:PutObject` and `s3:DeleteObject` on the bucket, `s3:GetObject` on the access-log bucket, CloudWatch Logs reads |
| Account principal of the vendor account | full, through IAM | key policy statement 3 of every `vendor-key` key: administration plus `kms:PutKeyPolicy`, no use action, no tagging; any IAM administrator in the account reaches the key through it |
| Tenant AWS account (`tenant-key` tier) | external, owns one key | a KMS key tagged `TenantId`, whose policy trusts the construct's three tenant roles (`tenantRoleArns`) via S3; can remove that statement, disable or delete the key at any time |
| S3 service | AWS | calls KMS on the caller's behalf (`kms:ViaService`); always for a tenant role session |
| Deployer-owned validator function | caller-influenced, no AWS permission from the construct | one presigned GET per call, pinned to one ETag, reusable until `validatorObjectUrlTtlSeconds` passes |
| Compromised authoriser code | caller-influenced | `authoriserRole`: a filtered, table-wide `GetItem` of `apiKeyValue` and `status` (G-8); no tenant role |
| Compromised API, processor or sweep code | caller-influenced | its base role (`apiRole`, `processorRole`, `sweepRole`) and the power to assume its one tenant role (`tenantUploadRole`, or `tenantProcessRole` for both the processor and the sweep) with any `TenantId` value that passes the trust-policy guard (T-14); `sweepRole` also writes delivery rows table-wide |
| Compromised `keyFactoryRole` code (`CreateTenantKey`) | caller-influenced | `kms:CreateKey` with a policy of its choosing (KMS cannot constrain policy content), one tag at create, `PutItem` of new `KEY` and `KEYARN#` items table-wide, `tenantPlatformRole` for the probe (T-50, G-1) |
| Compromised `platformRole` code (other `/platform/*` operations, drain) | caller-influenced | KMS administration without create, tag, grant or use; table-wide reads and status writes, never `keyArn` or `tier`; `tenantPlatformRole` for listing and deleting a tenant's objects and versions |
| Downstream consumer | its own trust | `DeliveryAccepted` events; its own tenant-scoped credentials |
| Integration runner | test account only | `TestProbeRole` (use actions only, explicit Deny of administration) and `TestConsumerRole`, refused outside an account tagged `tei:test-account` (G-9) |

## Assets

| Asset | Why it matters |
|---|---|
| Tenant documents, drop (`ingest/`) and landed (`documents/`), with their noncurrent versions | The most sensitive data the vendor holds; unvalidated in the drop; landed documents recoverable for 7 days after an overwrite or delete (G-11) |
| Tenant KMS keys (both tiers) and their `TenantId` tag | The boundary between tenants (P-1); the tag admits a key to a tenant session; deleting the key offboards the tenant (P-6) |
| The tenant-to-key binding (`KEY` row `keyArn`, `tier`, the `KEYARN#` item) | Decides which key every future document of the tenant is encrypted with (G-1) |
| Tenant role sessions (`tenantUploadRole`, `tenantProcessRole`, `tenantPlatformRole`) | Reach one tenant's prefixes, key and partition (P-2) |
| Tenant id | Becomes an S3 prefix segment, a session tag and part of a session name; its grammar is part of the isolation (§7.0, G-2) |
| Tenant access token | The only tenant source on `/tenant/*` (P-2) |
| Presigned PUT and GET URLs | The PUT writes once; the GET reads exactly one object, reusably, for minutes |
| Registry rows | Bind a tenant to its key ARN; carry delivery status, leases, counters, the API key value and the file name |
| Delivery events, queue and DLQ messages | Tell consumers what landed and where; S3 events carry the uploader's IP address (G-20) |
| Logs, metrics, access logs | Must carry the tenant, never content; Lambda logs never a URL, signature or file name (P-9, N-6) |
| Registry backups (PITR) | Keep file names and hashes, never content, for 35 days, including an offboarded tenant's (P-6, G-20) |
| Shared account quotas (STS, KMS, Lambda) | One tenant must not exhaust them for the others (N-8) |
| Published parameters | Tell consumers and `tenant-key` owners the API and the roles to trust |

## Trust boundaries

| Boundary | Crossed by | Authenticated and authorised by | Layer (`ARCHITECTURE.md` §3.3) |
|---|---|---|---|
| B1 Tenant ↔ vendor API | `/tenant/*` with a bearer token; `/platform/*` with SigV4 | token authoriser with the §7.0 grammar (M-1, M-63), scope in the handler (M-2), tenant id from the authoriser only (M-3), per-tenant usage plan with `apiKeyRequired` and in-flight cap (M-50, M-71); IAM on `/platform/*` (M-6) | Identity |
| B2 Tenant upload → bucket | presigned `PUT` with the §7.5 signed headers | SigV4 of the `tenantUploadRole` session, that role's identity policy, the signed headers (M-7, M-70), the bucket policy (M-8, M-45, M-52, M-64, M-66) | Data |
| B3 Vendor code → tenant role session | `AssumeRole` + `TagSession` from each base role to its one tenant role; every tenant call after it | tenant role trust policies with the `StringNotLike` guard (M-12, M-63), ABAC in the tenant roles' identity policies on `${aws:PrincipalTag/TenantId}` (M-11), tenant id from the key prefix (M-14), role split (M-13, M-62) | Data |
| B4 S3 ↔ KMS | `GenerateDataKey`, `Decrypt` with `kms:ViaService` | key policy statement 2 on `aws:s3:arn`, statements 4a, 4b and 4c Deny every other use, Bucket Keys off on the bucket and per request (M-10, M-43, M-49) | Data |
| B5 Vendor account ↔ tenant account | the same KMS calls on a `tenant-key` key, cross-account | the tenant's key policy trusting the three tenant roles (§7.3), the identity policies' `aws:ResourceTag/TenantId` as the implicit tag check, the canonical key ARN (M-11, M-22, M-41, M-67) | Data |
| B6 Processor ↔ validator | `lambda:Invoke` with the §3.5 request; the validator's `GET` of the presigned URL | invoke grant or the deployer's resource policy, presigned GET for one object and one ETag, verdict schema (M-23, M-24, M-57) | Data |
| B7 Vendor administration ↔ keys, registry and bucket | key creation (`keyFactoryRole`), key administration, offboarding and the drain (`platformRole`), the sweep (`sweepRole`), the account principal | key policy statements 1, 3, 4 and 5, each base role's identity Deny, the write-once binding and the registry watch, principal-scoped bucket Denies and versioning (M-28, M-29, M-30, M-31, M-42, M-43, M-59, M-60, M-61, M-62, M-64, M-65) | Data |
| B8 Pipeline → downstream consumers | `DeliveryAccepted` on the construct's bus; `GetObject` of `landedKey` | bus policy with explicit Deny (M-36), consumer's own tenant session (M-19) | Data |
| B9 Everything → telemetry, queues, backups and parameters | logs, access logs, metrics, queue bodies, PITR, `ssm:GetParameter` / `PutParameter` | field-allowlisted logger (M-33), separate access-log bucket with an explicit-deny reader policy (M-53), stated retention (M-72), IAM | Observability |
| B10 Integration runner → test account | the test-aid stack's roles and scratch key | trust in the runner's role only, one-hour sessions, account tag gate, teardown check (M-48) | Data |

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
| T-13 | B2 | T | Uploader still holding an unexpired presigned PUT can overwrite the drop object during or after validation, leading to bytes landing in `documents/` that differ from the bytes the chain checked, or unvalidated objects left in `ingest/`. |
| T-14 | B3 | E | Compromised API, processor, sweep or platform function code can assume its tenant role with tenant B's `TenantId` (the trust policy fixes the tag key and its character set, not its value), leading to that function acting as tenant B, one session at a time. |
| T-15 | B3 | S | Uploader controlling object metadata or event detail can make the processor take the tenant id from `x-amz-meta-*`, the event detail or the file name instead of the key prefix, leading to a delivery processed, landed and metered under the wrong tenant. |
| T-16 | B3 | E | Other IAM principal in the vendor account with an identity policy allowing `sts:AssumeRole` can assume a tenant role, or add session tags beyond `TenantId`, or none, leading to a tenant session minted outside the functions that own it. |
| T-17 | B3 | E | Compromised function using its base role without a tenant session can reach tenant objects or keys, or use another function's powers (the API reading objects, the processor or the sweep creating keys, the platform function creating or tagging keys, any of them using a key), leading to isolation bypassed below the ABAC layer. |
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
| T-28 | B6 | I | Compromised or careless validator receiving a presigned GET can copy the document out, or persist or log the URL for reuse within its TTL, leading to disclosure of one tenant document. |
| T-29 | B6 | E | Compromised validator invoked by the processor can obtain AWS credentials from the processor or reach any object other than the one it was given, leading to a validator reading across tenants. |
| T-30 | B6 | T | Validator can return a malformed, empty or unexpected verdict, a function error, or extra fields, leading to the processor reading a bad verdict as `ACCEPT`. |
| T-31 | B6 | D | Validator can hang, time out, throttle or fail on every call, leading to deliveries for every tenant held, or a queue backlog. |
| T-32 | B6 | I | Validator can put document content into its verdict `message`, leading to content stored on the registry row and returned by `GetDelivery`. |
| T-33 | B6 | T | Compromised validator can return `ACCEPT` for a document it should reject, leading to a document admitted that the deployer's rule would refuse. |
| T-34 | B7 | E | Vendor operator holding `platformRole` or `keyFactoryRole` can decrypt tenant objects with an existing tenant key, leading to vendor staff reading tenant documents outside the pipeline. |
| T-35 | B7 | E | `keyFactoryRole` or `platformRole` holding `kms:Create*` (which includes `kms:CreateGrant`), `kms:Put*` or `kms:TagResource` can grant itself `Decrypt` with no `kms:ViaService` or context condition, rewrite the key policy, or retag a key to another tenant (tagging alone can grant use, G-1), leading to the binding removed by a role meant only to create or administer keys. |
| T-36 | B7 | E | Any IAM administrator in the vendor account, through the account principal in statement 3, can call `PutKeyPolicy` to add itself and then use any `vendor-key` key outside statement 2, leading to residual trust in the vendor account's IAM administration. |
| T-37 | B7 | D | Vendor operator can offboard the wrong tenant, or have `DeleteTenantKey` stop half way, leading to documents destroyed in error, or an offboarded tenant's objects left readable. |
| T-38 | B7 | T | Stack delete while the API still accepts calls can race a `CreateTenantKey` against the registry drain (the sentinel checked only at the `CREATING` write, an eventually consistent scan, invocations in flight after the function is deleted), leading to a key created after the drain listed the rows, never scheduled for deletion. |
| T-39 | B7 | I | Vendor administrator during the deletion window can cancel a pending key deletion after `cdk destroy` or `DeleteTenantKey`, leading to ciphertext copied out before deletion becoming readable again. |
| T-40 | B8 | I | Downstream consumer with a broad role subscribed to `DeliveryAccepted` can read `landedKey` (or an `ingest/` object) without tenant-scoped credentials, leading to isolation turned from enforced to filtered downstream. |
| T-41 | B8 | S | Other IAM principal in the vendor account with `events:PutEvents` in its identity policy can publish a forged `DeliveryAccepted` on the construct's bus, leading to consumers acting on a delivery that never passed the chain. |
| T-42 | B9 | I | Anyone with log read access can find a presigned PUT or GET URL, its signature and access key id, or a file name in Lambda, API Gateway, validator or S3 server access logs (a GET stays reusable until its TTL, G-10), leading to a leaked URL replayed within its lifetime, or personal data in logs. |
| T-43 | B9 | R | S3 server access logs and CloudTrail in formats the sample does not control can record requests without a tenant field, leading to per-tenant activity not attributable from that log alone. |
| T-44 | B9 | R | Pooled S3, Lambda, SQS, EventBridge and API Gateway can report usage that carries no tenant, leading to per-tenant cost not attributable without metering. |
| T-45 | B9 | T | Other IAM principal in the vendor account with `ssm:PutParameter` can overwrite the published `apiUrl` or `tenantRoleArns`, leading to consumers sent elsewhere, or a `tenant-key` owner trusting the wrong roles. |
| T-46 | B3 | D | A thrown error, a crash, a held validator error or a DLQ replay can leave a delivery `PROCESSING` that every retry treats as a duplicate (F-8), leading to a delivery that never reaches a terminal state and a drop object that expires with no event. |
| T-47 | B7 | I | `DeleteTenantKey` and the drain running under a session that cannot list a prefix or delete under `documents/` (F-9) can return having removed nothing landed, leading to an offboarded tenant's documents left readable under a live key (`tenant-key`) or until the deletion window ends. |
| T-48 | B5 | D | A `tenant-key` probe or status refresh made as a direct KMS call meets the key policy's `kms:ViaService` and encryption-context conditions (F-7), leading to every `tenant-key` registration refused and a healthy key flipped to `REVOKED`. |
| T-49 | B7 | E | `CreateKey` with an explicit policy passes the lockout safety check only if the calling role may later call `kms:PutKeyPolicy` (F-4), leading to `keyFactoryRole` needing the one permission that lets it rewrite every tenant's binding. |
| T-50 | B7 | E | Compromised or buggy `keyFactoryRole` code can call `CreateKey` with a policy it chose (one that also lets an outside principal `kms:Decrypt`; KMS cannot constrain policy content), tag it for a tenant that has no key row yet and write that tenant's `KEY` and `KEYARN#` items (G-1); and the table-wide registry principals (`keyFactoryRole`, `platformRole`, `sweepRole`, and `authoriserRole`'s two-attribute read) are filtered, not enforced (F-10, G-8), leading to a **new** tenant's documents decryptable outside the vendor with every pipeline check passing, or registry rows other than the binding corrupted. |
| T-51 | B2 | D | Uploader holding a URL for a declared 1 KB delivery can send up to 5 GB per URL (F-12), leading to storage, KMS and request cost amplified onto the vendor's pooled bill before any check rejects it. |
| T-52 | B9 | I | A tenant-chosen file name in the object key (`smith-passport.pdf`) is copied into CloudTrail S3 data events, the KMS encryption context in both accounts' CloudTrail, S3 access logs, EventBridge and SQS bodies and `landedKey` (F-13), leading to personal data spread across logs the sample cannot scrub. |
| T-53 | B1 | E | API Gateway caching the authoriser's decision per token (F-16) can reuse an Allow obtained on `GetDelivery` for `CreateDelivery`, or a route-specific Deny for the next route, leading to a read-only token writing, or a valid call refused, within the cache TTL. |
| T-54 | B2 | D | A URL presigned from a cached session expires when the session's credentials do (F-18), leading to `expiresAt`, the `EXPIRED` sweep and `objectUrlExpiresAt` reporting a URL as valid when it is already dead, or a URL that outlives the TTL the vendor intended. |
| T-55 | B10 | E | An integration step denied by the identity policy before the key policy is reached, by a missing Allow rather than the Deny it claims to prove, or by a missing permission rather than a tag mismatch (F-19, G-3), leading to a test that passes while a wall it claims to prove is absent. |
| T-56 | B5 | D | A pipeline fault (a wrong identity or bucket policy) surfaces through S3 as `AccessDenied`, the same shape as a KMS denial (F-20), leading to a healthy tenant marked `REVOKED`, `CreateDelivery` refused for the whole tenant, and no automatic recovery. |
| T-57 | B4 | T | Uploader or a copy call can set `x-amz-server-side-encryption-bucket-key-enabled: true` per object (F-23), leading to the bucket ARN in the encryption context for that object and the prefix binding gone for it. |
| T-58 | B3 | D | A tenant session built with a passed session policy can exceed the 2,048-character packed limit with long ARNs and four statements (F-24), leading to every `AssumeRole` failing and the pipeline stopped. |
| T-59 | B7 | D | Tenant churn at N-3 scale and repeated rotation can consume the KMS key quota (pending-deletion keys count for 7 to 30 days) and the 25 on-demand rotations per key (F-25), leading to `CreateTenantKey` or `RotateTenantKey` failing with an untyped error. |
| T-60 | B7 | I | A presigned URL issued before `DeleteTenantKey` set `DELETING` can still be used after the object purge (F-26), leading to an object landing under an offboarded tenant's prefix with a live `tenant-key` key, readable by the vendor until the lifecycle runs. |
| T-61 | B9 | I | Deviations from the sample standard (F-27): Lambda's implicit log groups surviving `cdk destroy`, an access-log bucket under the SSE-KMS-only policy, unencrypted queues, incomplete multipart uploads, EventBridge events dropped on target failure, leading to data left behind after destroy, access logging that silently fails, or deliveries lost. |
| T-62 | B6 | I | A validator's `FunctionError` body can echo its `objectUrl`, and a validator in another account cannot be invoked through `LambdaValidator.bind` alone (F-29a, b), leading to the URL in the processor's logs, or a deployer widening the processor's permissions to make a cross-account validator work. |
| T-63 | B6 | D | Tenant submitting many deliveries multiplies validator invocations, each up to its timeout, across the chain (F-29c), leading to Lambda cost and concurrency amplified per delivery for every tenant. |
| T-64 | B9 | R | Metering that counts three KMS requests per delivery omits the processor's read and each validator's `GET` (F-22), leading to per-tenant KMS cost under-reported and N-2's headroom overstated. |
| T-65 | B7 | T | Compromised or buggy code under any role with table writes (`keyFactoryRole`, `platformRole`, `sweepRole`, or a tenant role inside its own partition) can rewrite an existing tenant's `KEY.keyArn` or `tier`, or retag a key so the tenant's session admits it (G-1, G-13), leading to an existing tenant's future documents silently redirected to another key while the presigner, the identity policy and the processor's M-9 check all agree with the rewritten row. |
| T-66 | B3 | T | Code holding a `tenantUploadRole` or `tenantProcessRole` session can rewrite the attributes of its own `KEY` row that no Deny covers (`status`, `inFlight`, `bytesStored`, `deliveriesAccepted`, `kmsRequests`) (G-13), leading to the in-flight cap bypassed for that tenant or its metered cost falsified. |
| T-67 | B3 | E | A tenant id containing `/` (or `*`, `:`, `,` and other separators) that reaches a session tag (G-2) makes `ingest/${tag}/*` and the key-policy context of tenant `a` cover `ingest/a/b/...`, leading to one tenant nested inside another's prefix, key and log attribution. |
| T-68 | B3 | D | A trust-policy guard written as `StringLike` with a character class (IAM knows only `*` and `?`), or a `RoleSessionName` longer than 64 characters (G-2), leading to every `AssumeRole` failing and the pipeline stopped, or an implementer "fixing" it with `*` so the tag value is unconstrained. |
| T-69 | B4 | E | Key policy statement 4 written as one Deny "unless principal and ViaService and context" is the AND of the negations, so it denies only when all three fail (G-3), leading to a mistaken Allow or a grant for another principal, or a direct KMS call by a tenant role, surviving the Deny the design relies on. |
| T-70 | B3 | T | An hourly sweep that abandons a `PROCESSING` row one processor timeout after its lease, while SQS still has retries left (visibility 6T, three receives) (G-6), leading to an in-progress retry or a held validator error turned into `REJECTED PROCESSING_ABANDONED` and its drop object deleted before SQS retried or an operator could redrive. |
| T-71 | B3 | D | A queue Deny "unless `aws:SourceArn` is the rule" also refuses an operator's `StartMessageMoveTask` (which carries no `aws:SourceArn`), and an EventBridge target DLQ given the redrive DLQ's Deny refuses EventBridge (G-7), leading to held deliveries that cannot be replayed and events dropped when the target fails. |
| T-72 | B10 | E | A test-aid `TestProbeRole` with `kms:*` on `*` and `s3:*` on the bucket, deployed into a shared account or surviving a failed destroy (G-9), leading to a skeleton key: `PutKeyPolicy` on every `vendor-key` key through statement 3, `ScheduleKeyDeletion` of any tenant, and the bucket policy removed. |
| T-73 | B7 | D | Any vendor principal with identity `s3:PutObject` or `s3:DeleteObject` on the bucket, or code under `platformRole` or `sweepRole` through a tenant role, can overwrite or delete landed documents (KMS stops reading, not deleting) on an unversioned bucket (G-11), leading to unrecoverable loss of tenants' landed documents. |
| T-74 | B2 | D | Uploader adding an unsigned `x-amz-storage-class: GLACIER` or `DEEP_ARCHIVE`, `x-amz-website-redirect-location` or `x-amz-acl` to the presigned PUT (G-12), leading to a drop object the processor's `GetObject` cannot read (`InvalidObjectState`), a delivery wedged in retries, minimum-duration storage charges, or a redirect stored on a tenant object. |
| T-75 | B5 | T | Vendor operator or tenant registering a `tenant-key` key by alias ARN, bare key id or another spelling (G-14), leading to a second `KEYARN#` item for one key so one key serves two tenants, a key in another Region, or every delivery `KEY_MISMATCH` because `HeadObject` reports the canonical ARN. |
| T-76 | B3 | D | An eventually consistent `GetItem` right after `CreateDelivery` can read a fresh delivery row as missing (G-18), leading to the processor deleting a valid upload as a late duplicate, or the sweep acting on a stale status. |
| T-77 | B2 | T | A presigner that does not list `Content-Length`, `Content-Type` and `If-None-Match` as signable, and hoists the `x-amz-*` headers into the query string (the SDK default) (G-19), leading to the size bound and the write-once header silently missing from the URL and nothing bounding the upload size. |
| T-78 | B5 | D | Tenant AWS account removing only the "use via S3" statement from its key policy leaves `DescribeKey` working and `Enabled` (G-5), leading to a classifier that confirms with `DescribeKey` calling the denial the pipeline's own fault (DLQ, no `KEY_UNAVAILABLE`), and a recovery check that flips `REVOKED` back to `ACTIVE` every hour, burning one delivery each time. |
| T-79 | B1 | E | A token authoriser with no declared role (borrowing a base role or a table-wide read), returning an `apiKeyId` where API Gateway needs the key value, on methods without `apiKeyRequired` (G-8), leading to one-function-one-role broken, the authoriser able to read every tenant's API key value through `apigateway:GET`, or the per-tenant usage plan never applied. |
| T-80 | B6 | D | A bucket `s3:signatureAge` Deny set at `uploadUrlTtlSeconds` that is shorter than `validatorObjectUrlTtlSeconds`, or a processor run started on a cached session with less lifetime left than the processor timeout (G-17), leading to validator URLs and the processor's own S3 calls dying mid-run and read as validator errors or retried into the DLQ. |
| T-81 | B9 | I | S3 `Object Created` events carry the uploader's `source-ip-address` and `requester` into the queue, the redrive DLQ and the EventBridge target DLQ (G-20), leading to tenant users' IP addresses held for up to 14 days in queues the sample owns. |
| T-82 | B9 | I | Point-in-time recovery on the registry keeps every row for 35 days (G-20), leading to an offboarded tenant's file names and hashes, never content, outliving `DeleteTenantKey` in the backups. |
| T-83 | B9 | I | An access-log bucket protected only by an Allow for one reader role is reachable by any vendor principal with an identity `s3:GetObject` (G-10), leading to presigned URIs, signatures and session names in the logs read outside the named role. |

## Mitigations

Each mitigation names the principle and ADR it realises and the planned code
location. "Deployer action" items belong in the README's production
hardening checklist. Role, policy and statement names follow spec §7.

| ID | Mitigation | Realises | Planned location |
|---|---|---|---|
| M-1 | Token authoriser on every `/tenant/*` method: JWKS signature, `iss` from `identity.discoveryUrl`, `client_id` in `identity.allowedClientIds`, `exp`, `token_use: access`; a single string `tenant_id` matching the §7.0 grammar required (401 otherwise, M-63); a token carrying `tenants` refused; every refusal a Deny; an Allow is always for `/tenant/*` with `tenantId`, `sub` and `scope` in the context | P-2, [ADR-0012][adr-0012] | `src/authoriser/handler.ts`, `src/construct/api.ts` (authoriser on each `/tenant/*` method); unit test one case per refusal |
| M-2 | Scope enforced by the **handler** per route, never by the authoriser: `ingestion/deliver` for `CreateDelivery`, `ingestion/read` for `GetDelivery` and `ListDeliveries`; the authoriser's cached policy is the same for every route, so a cached decision cannot carry a scope; cache TTL at most 300 s, documented as the token revocation lag (F-16); both scopes registered in tenant-identity's catalogue at deploy (`PutScope`) | P-2, [ADR-0012][adr-0012] | `src/api/handler.ts` (route table with required scope), `src/construct/api.ts` (authoriser cache TTL, scope registration custom resource); integ step 3 |
| M-3 | The tenant id on `/tenant/*` comes only from `requestContext.authorizer.tenantId`; no route reads a tenant id from body, header, query or path; every registry read and write uses `PK = TENANT#<caller>`, so `GetDelivery` of another tenant's ULID is a 404 and `ListDeliveries` has no cross-tenant query to write | P-2, [ADR-0011][adr-0011], [ADR-0012][adr-0012] | `src/api/handler.ts` (context extraction), `src/shared/registry.ts` (key builder); unit tests |
| M-4 | Fixed error model `{code, message, requestId}`; `/tenant/*` bodies never carry a tenant id or a key ARN | P-2, [ADR-0012][adr-0012] | `src/api/errors.ts`; unit test over every error path |
| M-5 | `fileName` restricted to `[A-Za-z0-9._-]{1,128}`, no leading dot, validated at `CreateDelivery` (400 otherwise) and in the Smithy model; it is used only in a quoted `Content-Disposition` and never in a key, log or event (M-46) | P-7, [ADR-0007][adr-0007], [ADR-0017][adr-0017] | `src/api/handler.ts` (`CreateDelivery` input validation), Smithy `@pattern` on `fileName` in `model/` |
| M-6 | `/platform/*` uses `AWS_IAM` authorisation only; the token authoriser is not attached there and no tenant route reaches a platform operation | P-8, [ADR-0012][adr-0012] | `src/construct/api.ts` (method authorisation per resource); template assertion |
| M-7 | The presigned PUT is signed under a `tenantUploadRole` session whose **identity policy** allows `s3:PutObject` only on `ingest/${aws:PrincipalTag/TenantId}/*`, for the key `ingest/<tenantId>/<deliveryId>` the vendor chose; the six §7.5 headers (SSE, key id, bucket-key flag, `If-None-Match`, `Content-Length`, `Content-Type`) are in `X-Amz-SignedHeaders` (M-70), so editing the path, the key or a header breaks the signature or meets the identity policy | P-7, [ADR-0003][adr-0003], [ADR-0007][adr-0007] | `src/shared/presign.ts`, `src/api/handler.ts` (`CreateDelivery`); integ step 4 |
| M-8 | Bucket policy: deny any request with `aws:SecureTransport = false`; deny `s3:PutObject` unless `s3:x-amz-server-side-encryption = aws:kms` (also catches a missing header); block public access; Object Ownership `BucketOwnerEnforced`; Bucket Keys off on the bucket | P-3, [ADR-0001][adr-0001] | `src/construct/bucket-policy.ts`; template assertion; integ step 4 |
| M-9 | The processor re-checks every object: `HeadObject` `SSEKMSKeyId` equals the registry's canonical `keyArn` for the prefix (M-67) and `BucketKeyEnabled` is false, else `REJECTED structural:KEY_MISMATCH` | P-3, [ADR-0001][adr-0001], [ADR-0002][adr-0002] | `src/processor/handler.ts` step 3 |
| M-10 | Key policy statement 2: `tenantUploadRole`, `tenantProcessRole` and `tenantPlatformRole` get `kms:GenerateDataKey` and `kms:Decrypt` only with `kms:ViaService = s3.<region>.amazonaws.com` and `kms:EncryptionContext:aws:s3:arn` like `arn:aws:s3:::<bucket>/ingest/<tenantId>/*` or `.../documents/<tenantId>/*`; a separate statement grants the same three roles `kms:DescribeKey` with no condition | P-1, [ADR-0002][adr-0002] | `src/platform/key-policy.ts` statement 2 (built by `CreateTenantKey`); unit test on the rendered policy; integ step 5 |
| M-11 | ABAC lives in the **identity policies** of `tenantUploadRole`, `tenantProcessRole` and `tenantPlatformRole` (spec §7.1): S3 only on `<prefix>/${aws:PrincipalTag/TenantId}/*` (`tenantProcessRole` writes `documents/` and `ingest/${tag}/_probe/*` only; `tenantUploadRole` has no `s3:GetObject`), KMS only on keys with `aws:ResourceTag/TenantId = ${aws:PrincipalTag/TenantId}` (use also with `kms:ViaService`), DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `Query` and `ConditionCheckItem` only with `ForAllValues:StringEquals dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/TenantId}`, no `DeleteItem` and no `Scan` (G-16), and the attribute Deny of M-59. No session policy is passed: a session policy can only narrow, so code that omits it would hold the role's full permissions, while an identity-policy wall cannot be dropped by the caller (F-1). This also removes the 2,048-character session-policy limit (F-24); identity policies allow 10,240 | P-2, [ADR-0003][adr-0003] | `src/construct/roles.ts` (tenant roles); `src/shared/tenant-session.ts` (the one place a tenant session is assumed: tag and session name, no `Policy` parameter); template assertion that every tenant-role statement carries the tag condition; integ steps 5 and 6 |
| M-12 | Tenant role trust policies: `tenantUploadRole` trusted by `apiRole`, `tenantProcessRole` by `processorRole` and `sweepRole`, `tenantPlatformRole` by `platformRole` and `keyFactoryRole`; `sts:AssumeRole` and `sts:TagSession` only, `ForAllValues:StringEquals aws:TagKeys = ["TenantId"]` **and** `Null aws:RequestTag/TenantId = false` (the first alone is true for an empty tag set) **and** a `StringNotLike aws:RequestTag/TenantId` guard on `["*/*", "*:*", "*=*", "*+*", "*@*", "*.*", "* *", "*,*"]`. The earlier guard used `StringLike` with a character class, which IAM does not support (only `*` and `?`): it would have refused every `AssumeRole` or, "fixed" with `*`, constrained nothing (G-2). The guard keeps the separators out; the full grammar is enforced in code (M-63). `RoleSessionName` is `t-<tenantId>-<suffix>` with a 16-character suffix, at most 54 characters (M-51) | P-2, [ADR-0003][adr-0003] | `src/construct/roles.ts`; template assertion per trust policy; unit test that renders the guard and asserts one refused value per illegal character |
| M-13 | Role asymmetry, enforced across six base roles: `authoriserRole`, `apiRole`, `processorRole`, `keyFactoryRole`, `platformRole` and `sweepRole` hold no S3 object permission and no KMS use permission; each may assume only its named tenant roles; the API cannot read an object because `tenantUploadRole` has no `s3:GetObject`; the processor and the sweep cannot create, tag, schedule or administer keys; only `keyFactoryRole` creates and tags keys, and it cannot administer, grant or use them; `platformRole` administers without create, tag, grant or use; `sweepRole` reaches only `ingest/` (through `tenantProcessRole`, never `documents/` for deletes, M-64); the authoriser reads two attributes and nothing else (M-71) (G-1, G-8, G-11) | P-8, [ADR-0003][adr-0003], [ADR-0018][adr-0018] | `src/construct/roles.ts`; template assertions per role |
| M-14 | The processor takes `tenantId` and `deliveryId` from the second and third key segments, deletes the event when the tenant id does not match §7.0 (M-63), ignores `_probe`, assumes `tenantProcessRole` for that tenant **first** and then loads the delivery row under that session with `ConsistentRead` (`LeadingKeys` turns a wrong id into `AccessDenied`, never another tenant's row, F-30a; M-69); it requires `objectKey` to equal the event key; object metadata, event detail and file name are never a tenant source | P-2, [ADR-0008][adr-0008] | `src/processor/handler.ts` steps 0-2 |
| M-15 | Conditional transitions: every status write is conditional on the current status and, once leased, on `leaseOwner`; a late duplicate for a terminal delivery only deletes a leftover drop object; counters and the `inFlight` decrement move in the same transaction as the terminal status | P-10, [ADR-0010][adr-0010], [ADR-0011][adr-0011], [ADR-0016][adr-0016] | `src/processor/handler.ts` steps 2 and 7, `src/shared/registry.ts` |
| M-16 | Queue policies with explicit **Denies** (an Allow-only policy would be filtered, because a same-account identity Allow suffices, F-15). Main queue: Allow `sqs:SendMessage` to `events.amazonaws.com` with `aws:SourceArn` = the rule ARN; Deny `sqs:SendMessage` unless `aws:SourceArn` is the rule ARN **or** `aws:CalledViaLast = sqs.amazonaws.com`, so an operator's `StartMessageMoveTask` redrive from the DLQ (which needs the caller's own `sqs:SendMessage` and carries no `aws:SourceArn`) still works (G-7). Redrive DLQ: Deny `sqs:SendMessage` unless `aws:SourceArn` is the queue ARN (dropped if integ step 7b shows it blocks SQS's own move). EventBridge target DLQ, a separate queue: Allow `events.amazonaws.com` with `aws:SourceArn` = the rule ARN, Deny every other sender. All three SSE-SQS; the rule lives on the account's default bus (where S3 delivers) and matches `source: aws.s3`, the bucket name and the `ingest/` prefix | P-10, [ADR-0010][adr-0010] | `src/construct/queues.ts` (rule and three queue policies); template assertion; integ step 7b (redrive) |
| M-17 | Structural checks before anything lands: `ContentLength` from `HeadObject` equals `declaredSizeBytes` and is at most `maxObjectSizeBytes` (`TOO_LARGE`, `SIZE_MISMATCH`), magic bytes against the declared type, ZIP central directory bounds (entry count, total uncompressed size, ratio), streamed SHA-256 | P-10, [ADR-0008][adr-0008] | `src/processor/structural.ts`, `src/processor/handler.ts` steps 3-4; unit tests with synthetic polyglot and bomb fixtures |
| M-18 | ETag pins: `dropEtag` is recorded at step 3 and pins the step 4 `GetObject` (`IfMatch`), every validator's presigned `GET` (`If-Match` signed) and the step 6 `CopyObject` (`CopySourceIfMatch`); a `PreconditionFailed` is `REJECTED structural:OBJECT_CHANGED`, so the bytes that land are the bytes that were checked (F-11) | P-10, [ADR-0008][adr-0008], [ADR-0017][adr-0017] | `src/processor/handler.ts` steps 3-6 |
| M-19 | Quarantine: `ingest/` has a `dropRetentionDays` lifecycle and a rejected object is deleted at once; consumers subscribe to `DeliveryAccepted`, read only `documents/` and only under their own tenant-scoped credentials; the event carries no URL | P-10, [ADR-0008][adr-0008], [ADR-0010][adr-0010] | `src/construct/bucket-policy.ts` (lifecycle), `src/processor/handler.ts` step 7; README consumer section |
| M-20 | Presigned PUT bounded to one opaque key, one tenant, one key ARN, the declared size, one write (`If-None-Match`), and `uploadUrlTtlSeconds` (default 900 s, at most 3,300 s); the bucket policy's `s3:signatureAge` Deny at `max(uploadUrlTtlSeconds, validatorObjectUrlTtlSeconds) * 1000` ms kills any presigned URL past the longer TTL (G-17); an unused URL becomes `EXPIRED` in the hourly sweep; a leaked URL that is used still runs the whole chain | P-7, [ADR-0007][adr-0007] | `src/api/handler.ts`, `src/construct/bucket-policy.ts`, `src/sweep/handler.ts` |
| M-21 | Fail closed on a KMS-coded failure only, confirmed by a probe: the classifier matches the KMS error code S3 surfaces at steps 3-6 (`KMS.AccessDeniedException`, `KMS.DisabledException`, `KMS.KMSInvalidStateException`, `KMS.NotFoundException`) for the registry `keyArn`, never a bare S3 `AccessDenied`, and confirms with the through-S3 probe (Put/Get/Delete of `ingest/<tenantId>/_probe/<ulid>` under the same `tenantProcessRole` session), **not** with `DescribeKey`, which a tenant that removed only the use statement still allows (G-5). Probe fails with a KMS code: delivery `KEY_UNAVAILABLE`, key row `REVOKED`, `DeliveryKeyUnavailable`, message deleted without retry. Probe succeeds: the error was the pipeline's own, throw (SQS retry, DLQ). `CreateDelivery` returns 409 while the row is not `ACTIVE`. The sweep and `GetTenantKey` flip `REVOKED` back to `ACTIVE` only when the same probe succeeds, so a key whose use is still denied stays `REVOKED` and recovery needs no vendor call (F-20) | P-5, [ADR-0005][adr-0005] | `src/processor/errors.ts` (classifier), `src/processor/handler.ts` steps 3-6, `src/sweep/handler.ts`, `src/platform/get-tenant-key.ts`, `src/api/handler.ts`; integ step 8 (including the use-statement-only variant) |
| M-22 | `CreateTenantKey` for `tenant-key`: `DescribeKey` under a `tenantPlatformRole` session for the path's `tenantId` must be admitted at all, which is the tag check: `DescribeKey` returns no tags and the §7.3 template grants no `kms:ListResourceTags`, so the equality of the key's `TenantId` tag with the path's tenant is enforced by the identity policy's `aws:ResourceTag/TenantId` condition on `DescribeKey` and on the probe, not read from a response (F-30b, G-15); the response must show `KeySpec SYMMETRIC_DEFAULT`, `Enabled`, single-Region and the bucket's Region; the canonical ARN is stored (M-67); a `KEYARN#<arn>` uniqueness item is written in the same transaction as the key row, so one key cannot serve two tenants; `DeleteTenantKey` removes both in one transaction | P-4, [ADR-0004][adr-0004], [ADR-0011][adr-0011] | `src/platform/create-tenant-key.ts`, `src/platform/delete-tenant-key.ts`; integ steps 1 and 11 |
| M-23 | Validator isolation: each call gets a presigned GET for one object, signed under the `tenantProcessRole` session, pinned to `dropEtag`, valid `validatorObjectUrlTtlSeconds` (default 300 s) and never past the session's expiry (M-47); the payload carries no credentials; `LambdaValidator.bind` grants `processorRole` `lambda:InvokeFunction` and the validator nothing | P-11, [ADR-0009][adr-0009] | `src/validators/lambda-validator.ts`, `src/processor/handler.ts` step 5 |
| M-24 | Strict verdict schema: `version: "1"`, `verdict` in `ACCEPT|REJECT`, `code` `[A-Z0-9_]{1,40}`, `message` capped at 1,024 characters, no other properties; a schema failure, `FunctionError` or timeout is a validator error and never `ACCEPT` | P-11, [ADR-0009][adr-0009] | `src/processor/verdict.ts`; unit test per malformed shape |
| M-25 | Validator time is budgeted: per-validator timeout, processor timeout T computed at synth from the chain (synth fails if it does not fit 15 minutes), visibility timeout 6T, `maxReceiveCount` 3 (a message reaches the DLQ after at most 18T), DLQ retention 14 days, `onValidatorError` hold or reject, DLQ depth alarm | P-11, [ADR-0009][adr-0009] | `src/construct/index.ts` (timeout budget, DLQ alarm), `src/processor/handler.ts` step 5; integ step 7b |
| M-26 | Validator message hygiene: stored as `reasonMessage`, returned only to the same tenant, never logged (the log line carries `code`); the README states the author's promise not to include content | P-11, [ADR-0009][adr-0009] | `src/processor/verdict.ts`, `src/shared/logger.ts`; README validator section |
| M-27 | Built-in structural checks run first and the chain stops at the first `REJECT`; each validator's verdict is recorded on the row with its name, so an `ACCEPT` is attributable to one validator | P-11, [ADR-0009][adr-0009] | `src/processor/handler.ts` steps 4-5 |
| M-28 | Key policy statement 1 gives each creating or administering role an explicit action list. `platformRole`: `kms:DeleteAlias`, `kms:DescribeKey`, `kms:GetKeyRotationStatus`, `kms:RotateKeyOnDemand`, `kms:ListResourceTags`, `kms:GetKeyPolicy`, `kms:ScheduleKeyDeletion`, `kms:CancelKeyDeletion`. `keyFactoryRole`: `kms:CreateAlias`, `kms:EnableKeyRotation`, `kms:DescribeKey`, `kms:ScheduleKeyDeletion` (to undo a failed create). No wildcard (`kms:Create*` would include `kms:CreateGrant`, F-3), no `kms:PutKeyPolicy`, no `kms:TagResource` or `kms:UntagResource` (the tag is set at `CreateKey`, M-60), no use action | P-1, [ADR-0002][adr-0002], [ADR-0018][adr-0018] | `src/platform/key-policy.ts` statement 1; unit test asserts the exact lists and the absence of `CreateGrant`, `PutKeyPolicy`, `TagResource`, `UntagResource`, `Decrypt`, `Encrypt`, `GenerateDataKey*`, `ReEncrypt*` |
| M-29 | Detect key-policy changes: an EventBridge rule on CloudTrail `PutKeyPolicy`, `CreateGrant`, `CancelKeyDeletion`, `TagResource`, `UntagResource` and `Decrypt` outside `kms:ViaService` for keys tagged `TenantId`, alarmed (deployer action; CloudTrail is account-level). It is what makes the account-principal residual (T-36) visible | P-1, [ADR-0002][adr-0002], [ADR-0013][adr-0013] | README production hardening checklist |
| M-30 | Offboarding order: row to `DELETING` and the tenant's API key removed first (no new presign), objects **and every version** under both prefixes listed and deleted in pages of 1,000 under a `tenantPlatformRole` session (`s3:DeleteObject`, `s3:DeleteObjectVersion`, M-40, M-65), alias deleted, `ScheduleKeyDeletion` with `keyDeletionWindowDays`, row and `KEYARN#` item removed in one transaction last; idempotent on retry; the window lets an operator cancel a wrong delete | P-6, [ADR-0006][adr-0006] | `src/platform/delete-tenant-key.ts`; integ step 11 (`ListObjectVersions` empty) |
| M-31 | Registry drain runs after the API is gone: the API and platform functions depend on the drain resource so CloudFormation deletes them first; the drain (`platformRole`) writes a `DRAINING` sentinel that `CreateTenantKey` (`keyFactoryRole`) checks at the `CREATING` write **and** at the `ACTIVE` flip, and a flip that fails on the sentinel schedules the just-created key for deletion before returning 409; the drain reads with `ConsistentRead`, waits one platform-function timeout after the sentinel, re-scans, and as a backstop lists keys by the construct's `tei:stack` tag and schedules any the registry does not know (F-21) | P-6, [ADR-0006][adr-0006] | `src/construct/index.ts` (dependency order), `src/platform/drain.ts`, `src/platform/create-tenant-key.ts` |
| M-32 | Per-tenant metering and burst absorption: `kmsRequests`, bytes and deliveries per tenant in the structured log and on the key row, Contributor Insights top-tenant rules, processor reserved concurrency and SQS `maximumConcurrency` so a burst queues instead of hitting KMS | P-9, [ADR-0013][adr-0013] | `src/construct/index.ts` (rules, concurrency), `src/processor/handler.ts` step 7 |
| M-33 | Field-allowlisted logger: only `tenantId`, `deliveryId`, `validator`, `verdict`, `code`, `errorType`, `durationMs`, `status`, `sizeBytes`, `kmsRequests`; never a URL, signature, header, file name or validator error body; the API Gateway access log format omits the query string | P-9, [ADR-0013][adr-0013] | `src/shared/logger.ts`, `src/construct/api.ts` (access log format); unit test and integ step 7b assert no `X-Amz-Signature` and no file name |
| M-34 | `tenantId` in every Lambda log line and the API access log (`$context.authorizer.tenantId`); S3 access logs and CloudTrail name the tenant through the session name (M-51), with the second key segment as the fallback join in `architecture.md` | P-9, [ADR-0013][adr-0013] | `src/shared/logger.ts`, `src/construct/api.ts`; `architecture.md` observability section; integ step 10 |
| M-35 | Cost attribution: `TenantId` cost allocation tag on every `vendor-key` key; per-tenant counters and `kmsRequests` metered for pooled S3 and KMS; the formula and the unattributable remainder (API Gateway, Lambda, SQS, EventBridge, apportioned by deliveries) in the README Costs section, which also says `tenant-key` requests are throttled against the vendor's quota and that the billed account is not documented | P-9, [ADR-0013][adr-0013] | `src/platform/create-tenant-key.ts` (tags), `src/processor/handler.ts` step 7; README Costs |
| M-36 | The construct owns its event bus; its resource policy has an explicit **Deny** of `events:PutEvents` unless `aws:PrincipalArn` is `processorRole` (F-15); events carry `source: tenant-encrypted-ingestion`; the bus carries only `Delivery*` events (the S3 rule lives on the default bus) | P-8, [ADR-0010][adr-0010] | `src/construct/events.ts` (event bus policy); template assertion |
| M-37 | Audit trail: the delivery row keeps `createdBy` (`sub`), `sha256`, `sizeBytes`, `dropEtag`, the validator list and timestamps; PITR on (35 days, M-72); S3 access logs; CloudTrail `AssumeRole` events carry the `TenantId` tag and the session name; KMS calls on a `tenant-key` key appear in the tenant's own CloudTrail | P-2, [ADR-0011][adr-0011], [ADR-0013][adr-0013] | `src/processor/handler.ts` step 7, `src/construct/registry.ts` (PITR), `src/construct/bucket-policy.ts` (access logging) |
| M-38 | Published parameters are written by the demo stack only; the README key policy takes `tenantRoleArns` from the deployer's own channel, and the hardening checklist restricts `ssm:PutParameter` on `/application-plane/shared/ingestion/*` | P-8, [ADR-0014][adr-0014] | `src/main.ts` (parameters); README production hardening checklist |
| M-39 | `PROCESSING` is a lease: `leaseOwner` (SQS message id) and `leaseUntil = now + T` on the row; the same message or an expired lease re-enters at step 2 and continues; a live lease held by another message exits. The sweep abandons a `PROCESSING` row only when `leaseUntil` is more than 18T plus one hour in the past, i.e. after `maxReceiveCount × visibilityTimeout` when SQS has given up, never while a retry is still due (G-6); it then sets `REJECTED structural:PROCESSING_ABANDONED` and deletes the drop object under the tenant session. Worst case from upload to a terminal state for a crashing processor: 18T plus one hour, stated in spec §6.2 (F-8) | P-10, [ADR-0010][adr-0010], [ADR-0016][adr-0016] | `src/processor/handler.ts` step 2, `src/sweep/handler.ts`; integ steps 7b (DLQ redrive) and 7c (abandoned lease) |
| M-40 | `tenantPlatformRole`, trusted by `platformRole` and `keyFactoryRole` only, holds `s3:ListBucket` with `s3:prefix` like `ingest/${tag}/*` and `documents/${tag}/*`, `s3:DeleteObject` and `s3:DeleteObjectVersion` on both prefixes, and `s3:PutObject`/`s3:GetObject` on `ingest/${tag}/_probe/*` only, so offboarding and the drain can enumerate and delete everything a tenant has, versions included (F-9, G-11) | P-6, P-8, [ADR-0003][adr-0003], [ADR-0006][adr-0006] | `src/construct/roles.ts`, `src/platform/delete-tenant-key.ts`; integ step 11 |
| M-41 | The `tenant-key` probe runs **through S3**: `PutObject` (with `If-None-Match: *`, which the bucket policy requires on `ingest/*`), `HeadObject`, `GetObject`, `DeleteObject` of `ingest/<tenantId>/_probe/<ulid>` with the key, under a `tenantPlatformRole` session at `CreateTenantKey` and a `tenantProcessRole` session in the processor and the sweep (M-21); `DescribeKey` has its own unconditioned statement in the §7.3 template and in the vendor's statement 2, but decides nothing about usability; the processor and the EventBridge rule ignore `_probe/` (F-7, G-5) | P-4, P-5, [ADR-0004][adr-0004], [ADR-0005][adr-0005] | `src/platform/create-tenant-key.ts`, `src/processor/handler.ts` step 0, `src/sweep/handler.ts`, `src/construct/queues.ts` (rule filter); integ steps 1 and 8 |
| M-42 | `CreateKey` is called by `keyFactoryRole` with `BypassPolicyLockoutSafetyCheck = true`, so no role ever needs `kms:PutKeyPolicy`; `keyFactoryRole` carries an explicit **Deny** of `kms:PutKeyPolicy`, `kms:CreateGrant`, `kms:UntagResource` and every KMS use action; `platformRole` an explicit **Deny** of `kms:CreateKey`, `kms:TagResource`, `kms:UntagResource`, `kms:PutKeyPolicy`, `kms:CreateGrant` and every use action; the account principal in statement 3 keeps the key manageable (F-4) | P-1, P-8, [ADR-0002][adr-0002], [ADR-0018][adr-0018] | `src/platform/create-tenant-key.ts` (`CreateKey` call), `src/construct/roles.ts` (`keyFactoryRole`, `platformRole`); template assertion; unit test on the `CreateKey` input |
| M-43 | Key policy statement 3 gives the account principal the statement 1 actions plus `kms:PutKeyPolicy`, and no use action, `kms:CreateGrant` or `kms:TagResource`. Statement 4 is **three** Denies, each of `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey*`, `kms:ReEncrypt*`, `kms:CreateGrant` to `*`: 4a `ArnNotEquals aws:PrincipalArn` the three tenant **role** ARNs (with path; `aws:PrincipalArn` of an assumed role is the role ARN, never the session ARN), 4b `StringNotEquals kms:ViaService` S3, 4c `StringNotLike kms:EncryptionContext:aws:s3:arn` the two prefixes. Conditions inside one statement are ANDed, so the single "unless A and B and C" Deny of the earlier design denied only when all three failed (G-3). Every IAM identity policy in the vendor account, `AdministratorAccess` included, every grant and any mistaken later Allow are refused until someone rewrites the key policy (F-3, F-5). A unit test renders the policy and runs IAM Access Analyzer `check-no-new-access` against a baseline with the three Denies; integ step 5 proves each Deny on a scratch key that also carries a mistaken Allow for `TestProbeRole` | P-1, [ADR-0002][adr-0002] | `src/platform/key-policy.ts` statements 3, 4a, 4b, 4c; unit test on the rendered policy; integ step 5 |
| M-44 | The table-wide registry principals are named, split and filtered (F-10, G-1, G-8): `keyFactoryRole` writes new `KEY`, `KEYARN#` and `SYSTEM` items (`PutItem`, `ConditionCheckItem`, `UpdateItem`); `platformRole` reads every row in the drain and the platform operations (`GetItem`, `Query`, `Scan` for the drain only, `UpdateItem`, `DeleteItem`, `ConditionCheckItem`); `sweepRole` queries the sparse GSI (`statusBucket`, `expiresAt`) and updates delivery and key status (`Query`, `GetItem`, `UpdateItem`), never a Scan; `authoriserRole` reads two attributes (M-71). Transactions are authorised per item, so every policy lists `PutItem`, `UpdateItem`, `DeleteItem` and `ConditionCheckItem` as needed and never `TransactWriteItems`, which is not an IAM action (G-16). Every role's `UpdateItem` is denied on `keyArn` and `tier` (M-59). They are reached only through IAM-authenticated `/platform/*`, the drain, the sweep and the authoriser, never by a tenant request; no other role reaches the table without `LeadingKeys` | P-8, [ADR-0011][adr-0011], [ADR-0018][adr-0018] | `src/construct/roles.ts`, `src/construct/registry.ts` (GSI), `src/sweep/handler.ts`; template assertion that only the four named roles lack `LeadingKeys` and that no policy names `TransactWriteItems` |
| M-45 | `Content-Length` equal to the declared `sizeBytes` is a signed header of the presigned PUT (M-70), so a larger body fails the signature; the processor rejects a measured size that differs as `structural:SIZE_MISMATCH` (F-12) | P-7, P-10, [ADR-0007][adr-0007] | `src/shared/presign.ts`, `src/processor/handler.ts` step 3; integ step 4 |
| M-46 | Opaque object key `ingest/<tenantId>/<deliveryId>` and `documents/<tenantId>/<deliveryId>`: the file name lives only on the delivery row and in the landed object's `Content-Disposition`; events, logs, SQS bodies and KMS encryption context carry no file name (F-13) | P-7, N-6, [ADR-0017][adr-0017] | `src/api/handler.ts`, `src/processor/handler.ts` step 6, `src/shared/events.ts`; integ step 3 (`Content-Disposition`) and 7b (no file name in logs) |
| M-47 | Fresh-session rule: tenant sessions are requested for 3,600 s (the role-chaining cap); a function presigns only when the session's remaining lifetime is at least the URL's TTL plus 60 s, and reports `expiresAt = min(now + TTL, credentials.Expiration)`, the same for `objectUrlExpiresAt`; the processor starts a run (step 1) only with at least T of session lifetime left, so its own S3 calls and the validator URLs cannot die mid-run (G-17); `uploadUrlTtlSeconds` above 3,300 fails synth; the bucket policy's `s3:signatureAge` Deny uses the larger of the two TTLs (M-20, F-18) | P-7, [ADR-0007][adr-0007] | `src/shared/tenant-session.ts`, `src/shared/presign.ts`, `src/processor/handler.ts` step 1, `src/construct/index.ts` (prop validation), `src/construct/bucket-policy.ts`; unit tests |
| M-48 | Test-aid stack, narrowed (G-9): `TestProbeRole` holds only use actions (`kms:Encrypt`, `Decrypt`, `GenerateDataKey*`, `ReEncrypt*`, `DescribeKey` on `*`; `s3:GetObject`, `PutObject`, `DeleteObject` on the bucket) and an explicit Deny of `kms:PutKeyPolicy`, `CreateGrant`, `ScheduleKeyDeletion`, `TagResource`, `UntagResource`, `s3:PutBucketPolicy`, `DeleteBucketPolicy`, `PutBucketEncryption`, so a denial it meets can only come from a key policy or the bucket policy and the role is never a skeleton key; it is trusted only by the runner's role, for one hour; `scripts/integ.sh` refuses to deploy the stack unless the account carries the `tei:test-account` tag, and step 12 checks it is gone. A **scratch key** built by the §7.2 policy builder plus one mistaken Allow for `TestProbeRole` lets step 5 prove each Deny of statement 4 rather than the absence of an Allow (G-3). `TestConsumerRole` is shaped like a downstream consumer for the cross-tenant read; context `tenantKeyAccount` puts the `tenant-key` key in a real second account; error sources are asserted by message, not by exception class (F-19) | P-1, P-2, [ADR-0003][adr-0003], [ADR-0004][adr-0004] | `test/integ/test-aid-stack.ts`, `scripts/integ.sh`; integ steps 1, 5, 6, 9, 12 |
| M-49 | `x-amz-server-side-encryption-bucket-key-enabled: false` is signed into the presigned PUT and set on `CopyObject`. There is no S3 condition key for that header (G-4), so the bucket policy statement of the earlier design is dropped; what holds instead: the bucket default keeps Bucket Keys off, a per-object bucket key puts the bucket ARN in the encryption context so statement 2 does not match and Deny 4c refuses (fail closed, a KMS-sourced 403), and M-9 rejects any object reporting `BucketKeyEnabled` (F-23) | P-1, [ADR-0002][adr-0002] | `src/shared/presign.ts`, `src/processor/handler.ts` steps 3 and 6; integ step 5 (KMS-sourced 403) |
| M-50 | Per-tenant limits (N-8, F-17): one usage plan and one API key per tenant on `/tenant/*` (`tenantThrottle`), issued at `CreateTenantKey`, with `apiKeyId` and `apiKeyValue` on the key row and removed at `DeleteTenantKey`; the authoriser returns `apiKeyValue` (the value, not the id) as `usageIdentifierKey` (M-71); every `/tenant/*` method has `apiKeyRequired: true`, without which the usage plan does not apply (G-8); `CreateDelivery` increments `inFlight` in the same conditional write as the delivery row and returns 429 `TooManyDeliveries` at `maxInFlightPerTenant`; every terminal transition decrements it and the sweep reconciles it. Together they bound one tenant's STS, KMS, Lambda and validator consumption | P-9, [ADR-0015][adr-0015] | `src/construct/api.ts` (usage plan, `apiKeyRequired`), `src/platform/create-tenant-key.ts`, `src/api/handler.ts`, `src/processor/handler.ts` step 7, `src/sweep/handler.ts`; template test asserting `apiKeyRequired` on every `/tenant/*` method; integ step 7 |
| M-51 | `RoleSessionName = t-<tenantId>-<suffix>` on every tenant session, the suffix being the last 16 characters of the `deliveryId` or an operation name of at most 16 characters, so the name is at most 54 characters and never fails the 64-character limit (G-2): S3 access logs (`Requester`), CloudTrail S3, KMS and STS events name the tenant without a join; the principal tag appears in the `AssumeRole` event (F-28) | P-9, [ADR-0003][adr-0003], [ADR-0013][adr-0013] | `src/shared/tenant-session.ts`; unit test on the longest tenant id; integ step 10 |
| M-52 | Write-once drop object: `If-None-Match: *` is a signed header of the presigned PUT (M-70), and the bucket policy denies `s3:PutObject` to `ingest/*` when `s3:if-none-match` is `Null` (scoped to `ingest/*`, because conditional-write enforcement makes a `CopyObject` into the prefix fail); a second PUT to the same URL is `412`; the processor deletes any drop object whose row, read with `ConsistentRead` (M-69), is terminal, missing or `DELETING` (F-11) | P-3, P-10, [ADR-0017][adr-0017] | `src/construct/bucket-policy.ts`, `src/shared/presign.ts`, `src/processor/handler.ts` step 2; integ step 4 |
| M-53 | S3 server access logs go to a **separate** bucket: SSE-S3 (access logging requires it), `DESTROY` and auto-delete, retention `dropRetentionDays` plus 30 days, and an explicit **Deny** of `s3:GetObject` unless `aws:PrincipalArn` is `accessLogReaderRole` (an Allow alone would be filtered, G-10). The logs record presigned URIs: a logged PUT is single-use (M-52); a logged validator GET is reusable until `validatorObjectUrlTtlSeconds` passes, and log delivery latency (minutes) keeps that window small, not zero (F-14, F-27c, G-10) | N-6, [ADR-0013][adr-0013] | `src/construct/access-log-bucket.ts`; template assertion |
| M-54 | Standard compliance (N-7, F-27): cdk-nag `AwsSolutionsChecks` in `src/main.ts`; an explicit `LogGroup` with `DESTROY` and `logRetention` for every function; SSE-SQS on the queue and both DLQs; `AbortIncompleteMultipartUpload` after 1 day on `ingest/`; EventBridge target retry policy (24 h, 185 attempts) and its own DLQ (M-16); DLQ retention 14 days, longer than any drop object; each asserted by a template test | N-7, [ADR-0014][adr-0014] | `src/main.ts`, `src/construct/*.ts`, `test/construct.test.ts` |
| M-55 | KMS quotas stated and typed (F-25): N-3 counts keys pending deletion against the 100,000-key quota and the README states the churn cost; `RotateTenantKey` maps `LimitExceededException` (25 on-demand rotations per key) to 409 `RotationLimitReached` | P-6, [ADR-0001][adr-0001], [ADR-0006][adr-0006] | `src/platform/rotate-tenant-key.ts`; unit test; README Costs and quotas |
| M-56 | URLs in flight at offboarding (F-26): the API key and the row change first, so no new URL is issued; the processor deletes any drop object whose row is missing or `DELETING` and publishes nothing; `DeleteTenantKey` schedules a final prefix sweep after `uploadUrlTtlSeconds`; `s3:signatureAge` and, for `vendor-key`, the pending-deletion key refuse late PUTs | P-6, [ADR-0006][adr-0006] | `src/platform/delete-tenant-key.ts`, `src/processor/handler.ts` step 2, `src/sweep/handler.ts`; integ step 11 |
| M-57 | Validator carrier hygiene (F-29a, b): the processor logs a validator error's `errorType` only, never its body; a unit test feeds a URL-bearing error body and asserts it is never logged; the README says a validator in another account needs a resource policy on its function allowing `processorRole` to invoke (deployer action), so the processor's role never widens | P-11, [ADR-0009][adr-0009] | `src/processor/handler.ts` step 5, `src/shared/logger.ts`; README validator section; integ step 7b (`always-error`) |
| M-58 | KMS requests metered as counted calls (F-22): four plus one per validator for an accepted delivery (`GenerateDataKey` on upload, `Decrypt` on the processor's read, `Decrypt` per validator `GET`, `Decrypt` plus `GenerateDataKey` on the copy) and the probe calls; N-2 restated with current quotas; integ step 10 reconciles the metered value once against CloudTrail | P-9, [ADR-0013][adr-0013] | `src/processor/handler.ts` step 7, `src/platform/create-tenant-key.ts`; integ step 10 |
| M-59 | The binding is written once: `keyArn` and `tier` are set only by `keyFactoryRole`'s `PutItem` with `attribute_not_exists(keyArn)`; every base role's `UpdateItem` is **denied** when `dynamodb:Attributes` contains `keyArn` or `tier`, and every tenant role's `PutItem`/`UpdateItem` when it contains `keyArn`, `tier` or `apiKeyValue` (G-1, G-13). Rebinding an existing tenant therefore needs `DeleteTenantKey` (which offboards) followed by a new create | P-1, P-4, [ADR-0011][adr-0011], [ADR-0018][adr-0018] | `src/construct/roles.ts` (attribute Denies), `src/platform/create-tenant-key.ts` (conditional `PutItem`); template assertion per role; unit test on the `PutItem` condition |
| M-60 | Tag once, create narrowly (G-1): `keyFactoryRole` may `CreateKey` only with `kms:KeySpec = SYMMETRIC_DEFAULT`, `kms:KeyOrigin = AWS_KMS`, `kms:MultiRegion = false`, `ForAllValues:StringEquals aws:TagKeys = [TenantId, tei:stack]` and `Null aws:RequestTag/TenantId = false`, and `kms:TagResource` only when `Null aws:ResourceTag/TenantId = true` (an untagged key); key policy statement 5 denies `kms:TagResource` and `kms:UntagResource` to `*`, and `platformRole` and the account principal hold neither, so a key's `TenantId` tag is set at `CreateKey` and never changed | P-1, [ADR-0002][adr-0002], [ADR-0018][adr-0018] | `src/construct/roles.ts` (`keyFactoryRole`), `src/platform/key-policy.ts` statement 5, `src/platform/create-tenant-key.ts`; unit test on the rendered policy and the `CreateKey` input |
| M-61 | Registry watch, the detective control behind M-59 and M-60: the table's DynamoDB stream feeds a Lambda that alarms on any `KEY` or `KEYARN#` item whose `keyArn` or `tier` changed (old image differs from new image), and on a `KEY` item removed outside `DeleteTenantKey`'s `DELETING` path (G-1) | P-1, [ADR-0018][adr-0018], [ADR-0013][adr-0013] | `src/registry-watch/handler.ts`, `src/construct/registry.ts` (stream, alarm); unit test with synthetic stream records |
| M-62 | Powers split across three platform roles (G-1, G-11): `keyFactoryRole` (only `CreateTenantKey`) creates and tags keys and writes new bindings; `platformRole` (every other `/platform/*` operation and the drain) administers, offboards and deletes, and can neither create nor tag; `sweepRole` (the hourly sweep) assumes only `tenantProcessRole`, holds no KMS action and can never create a key, retag one or delete under `documents/` | P-8, [ADR-0018][adr-0018], [ADR-0003][adr-0003] | `src/construct/roles.ts`, `src/construct/index.ts` (one function per role); template assertions per role |
| M-63 | Tenant id grammar `^[a-z0-9][a-z0-9-]{1,34}$` (spec §7.0, G-2), enforced wherever a tenant id enters: the authoriser (401), the `/platform/tenants/{tenantId}` path parameter in the Smithy model (400), and the processor's key parse (event deleted, no processing); the trust-policy guard (M-12) keeps separators out as a second wall. The grammar keeps `/` out of every prefix and every session name within 64 characters | P-2, P-7, [ADR-0003][adr-0003] | `src/shared/tenant-id.ts` (one validator), `src/authoriser/handler.ts`, Smithy `@pattern` on `tenantId` in `model/`, `src/processor/handler.ts` step 0; unit test per illegal character and at both length bounds |
| M-64 | Principal-scoped bucket Denies (G-11), on role ARNs: `s3:PutObject` on `ingest/*` unless `tenantUploadRole`, `tenantProcessRole` or `tenantPlatformRole`; `s3:PutObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion` on `documents/*` unless `tenantProcessRole` or `tenantPlatformRole`; `s3:DeleteObject` on `ingest/*` unless `tenantProcessRole` or `tenantPlatformRole`. An identity policy elsewhere in the vendor account can then read nothing (KMS) and change nothing (S3) under the two prefixes; `sweepRole` reaches only `ingest/` | P-8, P-10, [ADR-0019][adr-0019] | `src/construct/bucket-policy.ts`; template assertion; integ step 5 (`TestProbeRole` 403 from S3) |
| M-65 | Versioning on, with a lifecycle rule that expires noncurrent versions after 7 days and removes expired delete markers, so an overwritten or deleted landed document is recoverable for a week; offboarding deletes every version (`s3:DeleteObjectVersion`, M-30) so P-6 still holds (G-11) | P-6, P-10, [ADR-0019][adr-0019], [ADR-0006][adr-0006] | `src/construct/bucket-policy.ts` (versioning, lifecycle); template assertion; integ step 11 |
| M-66 | Unsigned header Denies (G-12): the bucket policy denies `s3:PutObject` to `ingest/*` when `s3:x-amz-storage-class` is present and not `STANDARD`, or when `s3:x-amz-website-redirect-location` is present; Object Ownership `BucketOwnerEnforced` makes ACL headers inert; the processor rejects a drop object whose `StorageClass` is not `STANDARD` as `structural:STORAGE_CLASS`; integ step 4 asserts a `GLACIER` PUT is a 403 and records `x-amz-server-side-encryption-context` and `x-amz-tagging` | P-10, [ADR-0007][adr-0007], [ADR-0017][adr-0017] | `src/construct/bucket-policy.ts`, `src/processor/handler.ts` step 3; integ step 4 |
| M-67 | Canonical key ARN (G-14): `CreateTenantKey` stores `DescribeKey().KeyMetadata.Arn`, never the caller-supplied string; an alias ARN, a bare key id or a key whose Region differs from the bucket's is rejected (422); the `KEYARN#` item is keyed on the canonical ARN, so one key cannot be registered twice under two spellings, and M-9 compares like with like | P-4, [ADR-0004][adr-0004], [ADR-0011][adr-0011] | `src/platform/create-tenant-key.ts`; unit test per non-canonical form; integ step 1 |
| M-68 | `HELD` state for `onValidatorError: hold` (G-6): on a validator error the processor writes `HELD` (lease cleared, `statusBucket` still `OPEN`), logs `errorType` only and throws; SQS retries and then the DLQ keep the message; a redrive re-enters at step 2 and takes the lease; the sweep leaves `HELD` rows alone until 14 days after `updatedAt` (the DLQ retention) and only then abandons them. Worst case for a held validator error: 14 days, stated in spec §6.2 | P-10, P-11, [ADR-0016][adr-0016], [ADR-0009][adr-0009] | `src/processor/handler.ts` steps 2 and 5, `src/sweep/handler.ts`; integ step 7b (sweep leaves `HELD`, redrive accepts) |
| M-69 | `ConsistentRead` on every processor and sweep read of a delivery or key row (G-18), so a row written by `CreateDelivery` a moment before is never read as missing and a fresh upload is never deleted as a late duplicate | P-10, [ADR-0011][adr-0011], [ADR-0016][adr-0016] | `src/shared/registry.ts` (read helper), `src/processor/handler.ts` step 2, `src/sweep/handler.ts`; unit test that the helper sets `ConsistentRead` |
| M-70 | Signed-headers mechanism named (G-19): the presigner passes all six §7.5 headers under `signableHeaders` and the three `x-amz-*` headers under `unhoistableHeaders` (AWS SDK for JavaScript v3 `getSignedUrl`); a unit test parses `X-Amz-SignedHeaders` from a generated URL and asserts all six are present | P-7, [ADR-0007][adr-0007] | `src/shared/presign.ts`; unit test |
| M-71 | `authoriserRole`, the authoriser's own role (G-8): `dynamodb:GetItem` on the table with `dynamodb:Select = SPECIFIC_ATTRIBUTES` and `ForAllValues:StringEquals dynamodb:Attributes = [PK, SK, apiKeyValue, status]`, nothing else (no `apigateway:GET`, no tenant role). A filtered table-wide read of two attributes: `apiKeyValue` identifies a tenant for throttling and authenticates nothing, and `status` is the only other field it sees; a compromised authoriser can at most misattribute throttling between tenants (T-50) | P-8, P-9, [ADR-0015][adr-0015], [ADR-0012][adr-0012] | `src/construct/roles.ts`, `src/authoriser/handler.ts`; template assertion on the condition keys |
| M-72 | Retention named, not hidden (G-20): the README and the offboarding text state that S3 events carry the uploader's `source-ip-address` and `requester`, so the queue and both DLQs hold tenant users' IP addresses for up to 14 days (DLQ retention), and that PITR keeps an offboarded tenant's file names and hashes, never content, for 35 days | P-6, N-6, [ADR-0006][adr-0006], [ADR-0013][adr-0013] | README data handling and offboarding sections; `src/construct/queues.ts` (retention), `src/construct/registry.ts` (PITR) |

## Threat to mitigation mapping

| Threat | Mitigations | Disposition |
|---|---|---|
| T-1 | M-1, M-63 | Mitigated by design |
| T-2 | M-1 | Mitigated by design |
| T-3 | M-2 | Mitigated by design |
| T-4 | M-3 | Mitigated by design |
| T-5 | M-3, M-4 | Mitigated by design |
| T-6 | M-5, M-46 | Mitigated by design |
| T-7 | M-6 | Mitigated by design |
| T-8 | M-7, M-64 | Mitigated by design |
| T-9 | M-7, M-9, M-70 | Mitigated by design |
| T-10 | M-8 | Mitigated by design |
| T-11 | M-20, M-47, M-52 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-12 | M-17, M-45, M-70 | Mitigated by design |
| T-13 | M-18, M-52, M-70 | Mitigated by design |
| T-14 | M-11, M-12, M-13, M-50, M-51, M-62, M-63 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-15 | M-14 | Mitigated by design |
| T-16 | M-12 | Mitigated by design |
| T-17 | M-13, M-42, M-62 | Mitigated by design |
| T-18 | M-14, M-15, M-16 | Mitigated by design |
| T-19 | M-15, M-39, M-69 | Mitigated by design |
| T-20 | M-9, M-10, M-11, M-43 | Mitigated by design |
| T-21 | M-8, M-9, M-49 | Mitigated by design |
| T-22 | M-10, M-11, M-43 | Mitigated by design |
| T-23 | M-32, M-50, M-71 | Mitigated by design |
| T-24 | M-21, M-41 | Mitigated by design |
| T-25 | M-9, M-22, M-41, M-48, M-60, M-67 | Unverified until the `tenantKeyAccount` integration run; accepted meanwhile, see [Accepted risks](#accepted-risks) |
| T-26 | M-37, M-51 | Mitigated by design |
| T-27 | none | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-28 | M-20, M-23 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-29 | M-23 | Mitigated by design |
| T-30 | M-24 | Mitigated by design |
| T-31 | M-25, M-68 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-32 | M-26 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-33 | M-27 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-34 | M-13, M-28, M-42, M-43, M-62 | Mitigated by design for every existing key; a key created for a new tenant is T-50 |
| T-35 | M-28, M-29, M-42, M-43, M-60 | Mitigated by design for every existing key; a key created for a new tenant is T-50 |
| T-36 | M-29, M-43 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-37 | M-30, M-40, M-65 | Mitigated by design |
| T-38 | M-31 | Mitigated by design |
| T-39 | M-29 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-40 | M-19, M-64 | Mitigated by design |
| T-41 | M-36 | Mitigated by design |
| T-42 | M-20, M-33, M-47, M-52, M-53 | Mitigated by design for Lambda, API Gateway and validator logs; Accepted (residual) for S3 server access logs, see [Accepted risks](#accepted-risks) |
| T-43 | M-34, M-51 | Mitigated by design |
| T-44 | M-35, M-58 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-45 | M-38 | Mitigated by design |
| T-46 | M-15, M-39, M-68 | Mitigated by design |
| T-47 | M-30, M-40 | Mitigated by design |
| T-48 | M-41 | Mitigated by design |
| T-49 | M-42 | Mitigated by design |
| T-50 | M-13, M-44, M-59, M-60, M-61, M-62, M-71 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-51 | M-45, M-50, M-70 | Mitigated by design |
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
| T-65 | M-59, M-60, M-61, M-62 | Mitigated by design |
| T-66 | M-50, M-51, M-59 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-67 | M-12, M-63 | Mitigated by design |
| T-68 | M-12, M-51, M-63 | Mitigated by design |
| T-69 | M-43, M-48 | Mitigated by design |
| T-70 | M-39, M-68 | Mitigated by design |
| T-71 | M-16 | Mitigated by design |
| T-72 | M-48 | Mitigated by design |
| T-73 | M-62, M-64, M-65 | Mitigated by design for every principal outside `tenantProcessRole` and `tenantPlatformRole`; deliberate deletion under those roles is part of T-14 |
| T-74 | M-8, M-66 | Mitigated by design |
| T-75 | M-22, M-67 | Mitigated by design |
| T-76 | M-69 | Mitigated by design |
| T-77 | M-70 | Mitigated by design |
| T-78 | M-21, M-41 | Mitigated by design |
| T-79 | M-50, M-71 | Mitigated by design |
| T-80 | M-20, M-47 | Mitigated by design |
| T-81 | M-72 | Accepted (residual, by design), see [Accepted risks](#accepted-risks) |
| T-82 | M-72 | Accepted (residual, by design), see [Accepted risks](#accepted-risks) |
| T-83 | M-53 | Mitigated by design |

Dispositions changed by the first review: T-14 from mitigated to accepted
(F-2); T-23 (F-17) and T-43 (F-28) from accepted to mitigated; T-42 split,
with S3 access logs accepted (F-14); T-25 relabelled unverified. T-13,
T-18, T-34, T-35, T-38 and T-41 stayed mitigated, but by new or rewritten
mitigations, because the earlier ones did not hold (F-3, F-5, F-11, F-15,
F-21).

Dispositions changed by the second review:

- **T-50 restated, still accepted.** Its earlier text ("a bug in it can
  corrupt registry rows but cannot read a document") was wrong for future
  documents (G-1). The residual is now honest and narrower: a compromised
  `keyFactoryRole` can bind a **new** tenant to a key whose policy it
  chose. Rebinding an **existing** tenant is split out as T-65 and
  mitigated by design (M-59 to M-62).
- **T-34 and T-35 qualified.** Still mitigated for every existing key; a key
  created for a new tenant reduces to T-50.
- **T-31 and T-42 widened, still accepted.** A held validator error now
  waits in `HELD` up to the 14-day DLQ retention instead of being abandoned
  by the next sweep (G-6); logged validator GETs are reusable within their
  TTL, not single-use (G-10). The log bucket's reader restriction is now
  enforced (T-83, mitigated).
- **T-73 partly mitigated.** Every principal outside the two named tenant
  roles is refused by the bucket policy and versioning recovers an
  overwrite or delete for 7 days (M-64, M-65); deliberate deletion under
  those roles stays inside T-14.
- **Still mitigated, by rewritten mitigations, because the earlier ones did
  not hold as written:** T-16 (M-12: the `StringLike` guard never matched,
  G-2); T-20 and T-22 (M-43: one Deny was the AND of its negations, G-3);
  T-21 and T-57 (M-49: no condition key exists for the bucket-key header,
  G-4); T-24 and T-56 (M-21: `DescribeKey` cannot see a removed use
  statement, G-5); T-46 (M-39, M-68: the sweep abandoned live retries, G-6);
  T-18 (M-16: the Deny blocked redrive, G-7); T-23 (M-50, M-71: no
  authoriser role, key id instead of value, no `apiKeyRequired`, G-8); T-55
  (M-48: `TestProbeRole` had no Allow to beat and was a skeleton key, G-3,
  G-9); T-9, T-12, T-13 and T-51 (M-70: the headers were only signed if the
  presigner was told to, G-19).
- **New:** T-65 to T-83. T-66, T-81 and T-82 are accepted; the rest are
  mitigated by design.

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
  roles' trust policies fix the tag key and keep separators out of its
  value (M-12, M-63), not the tenant it names (F-2), so code that is
  compromised inside the API, processor, sweep or platform functions can
  assume its own tenant role for tenant B. A wrong-tenant **bug** is
  refused by AWS (M-11); deliberate compromise is not. What remains: one
  tenant role per function and six base roles, so a compromised API can
  only presign uploads and never read, and a compromised sweep can never
  reach `documents/` (M-12, M-13, M-62); every `AssumeRole` is in CloudTrail
  with the `TenantId` tag and a `t-<tenantId>-...` session name (M-51);
  per-tenant limits bound how fast it can move (M-50). Code under
  `tenantProcessRole` or `tenantPlatformRole` can also delete a tenant's
  landed documents; versioning recovers a delete for 7 days except where
  `tenantPlatformRole` deletes versions (T-73, M-65). Dependency hygiene
  and code review own the rest ([ADR-0003][adr-0003]).
- **T-50, a compromised `keyFactoryRole` can bind a new tenant to a key it
  chose.** KMS cannot constrain the content of the policy passed to
  `CreateKey`, so `CreateTenantKey` code that is compromised or wrong can
  create a key that also lets an outside principal decrypt, tag it for a
  tenant that has no key row yet, and write the binding; every pipeline
  check then passes for that tenant's documents (G-1). It cannot touch an
  existing tenant: `keyArn` is written once and no role may update it
  (M-59), a key is tagged once and never retagged (M-60), the registry
  watch alarms on any change (M-61), and key creation is a role of its own
  that the sweep and the drain never hold (M-62)
  ([ADR-0018][adr-0018]). The table-wide registry access of
  `keyFactoryRole`, `platformRole`, `sweepRole` and the two-attribute read
  of `authoriserRole` is filtered, not enforced (F-10, G-8, M-44, M-71); it
  is reached only through IAM-authenticated `/platform/*`, the drain, the
  sweep and the authoriser, and none of those roles holds a KMS use action
  ([ADR-0011][adr-0011]). The `CreateKey` event in CloudTrail and the
  key-policy alarm (M-29) are where a hostile policy shows; a deployer that
  wants more reviews `CreateTenantKey` changes like key-policy changes.
- **T-36, every IAM administrator can reach a `vendor-key` key through the
  account principal.** KMS requires a key to stay manageable, so statement 3
  lets the account principal administer the key and call `PutKeyPolicy`
  ([ADR-0002][adr-0002], spec §7.2). Statements 4a, 4b and 4c deny every use
  outside the three tenant roles via S3 on the tenant's prefixes (M-43), so
  an administrator has to rewrite the key policy first; that call is in
  CloudTrail and alarmed (M-29), and nothing prevents it. A tenant that does
  not accept this takes the `tenant-key` tier ([ADR-0004][adr-0004]), where
  the tenant's own account holds that position instead.
- **T-25, cross-account `aws:ResourceTag/TenantId` unverified.** The
  identity policies admit a `tenant-key` key by its `TenantId` resource tag,
  which the tenant sets ([ADR-0003][adr-0003], [ADR-0004][adr-0004]). AWS
  documentation shows only same-account examples, so whether the condition
  evaluates against a key in another account is unproven until the
  integration test runs with `tenantKeyAccount` set (M-48, spec §10 step 1);
  ADR-0004 names the fallback (the identity policy names the registered
  `keyArn` list). The tag check at `CreateTenantKey` is that implicit
  condition, not a field read from a response (M-22, G-15). A tenant that
  tags its key with another tenant's id still cannot get it used for that
  tenant: the session for the path's tenant must be admitted (M-22), the
  canonical key ARN is unique (M-67), the presigner signs only the
  registry's key (M-7) and the processor rejects a mismatch (M-9). KMS tag
  changes take up to five minutes to affect authorisation, so a re-tag by
  the tenant can briefly flip results (F-30e).
- **T-66, a tenant session can rewrite its own counters.** `LeadingKeys`
  scopes a tenant role to its partition, which includes its own `KEY` row.
  The binding (`keyArn`, `tier`) and `apiKeyValue` are denied to it (M-59),
  but `status`, `inFlight` and the cost counters are not, because the
  pipeline writes them under the tenant session (G-13). Code that does
  this is compromised code (T-14); the sweep reconciles `inFlight` hourly
  (M-50), the usage plan still throttles (M-50), and the session name puts
  every write in CloudTrail data events if the deployer enables them
  (M-51).
- **T-42, S3 server access logs record presigned URIs.** The log's
  `Request-URI` carries `X-Amz-Credential` and `X-Amz-Signature` (F-14);
  the sample does not control the format. The logs live in a separate
  bucket that explicitly denies every reader but `accessLogReaderRole`
  (M-53). A logged PUT is single-use (M-52), size-bound (M-45) and dead
  after its TTL (M-47); a logged validator GET can be replayed until
  `validatorObjectUrlTtlSeconds` passes, and log delivery takes minutes, so
  the window is small, not zero (G-10). Lambda, API Gateway and validator
  logs never carry a URL (M-33, M-57).
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
- **T-31, a silent or slow validator holds deliveries.** Under
  `onValidatorError: 'hold'` (the default, [ADR-0009][adr-0009]) a validator
  that times out or errors leaves the delivery `HELD`, the message in the
  DLQ and the object in the drop until an operator redrives it; the sweep
  leaves `HELD` rows alone for the 14-day DLQ retention and only then
  abandons them (M-68, G-6); the queue policy admits the redrive (M-16); the
  lease lets the replay finish (M-39). Nothing lands that the chain did not
  accept. A deployer that prefers availability sets `'reject'`. The DLQ
  depth alarm (M-25) is the signal.
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
  session (M-47) and with the bucket's `s3:signatureAge` Deny (M-20), and
  the upload runs the whole validation chain. Shorten the TTL for
  higher-risk tenants.
- **T-82, registry backups outlive offboarding (by design).** PITR keeps 35
  days of the table, so an offboarded tenant's file names and hashes, never
  content, remain in the backups that long (G-20). P-6 and the README name
  it (M-72); a deployer who needs a shorter window lowers the PITR period
  ([ADR-0006][adr-0006]).
- **T-81, queues hold tenant users' IP addresses (by design).** S3
  `Object Created` events carry `source-ip-address` and `requester`; the
  queue, the redrive DLQ and the EventBridge target DLQ keep them for up to
  14 days, SSE-SQS encrypted and reachable only through the queue policies
  (M-16, G-20). The README names it (M-72); the processor never logs them
  (M-33).
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

Two independent design reviews, 2026-11-05: 30 + 20 findings, all adopted.
The first (F-1 to F-30; one critical, eight high, twelve medium, eight low,
one informational) and the second, blind to the first (G-1 to G-20; two
high, nine medium, eight low, one informational), are adopted into the
spec and the ADRs ([ADR-0018][adr-0018] and [ADR-0019][adr-0019] record the
second review's two structural decisions) and dispositioned above. Both
reports are kept out of the repository. Items they could not verify are
carried as integration-test checks: cross-account `aws:ResourceTag` (T-25,
step 1); extra unsigned headers on a presigned PUT and a `412` for a signed
`If-None-Match` on a presigned URL (spec §7.5, step 4); the S3 error codes
that surface KMS failures (M-21, step 8); whether SQS's own move to the
redrive DLQ is checked against the DLQ policy (M-16, step 7b); and that S3
`Object Created` events reach only the default bus (M-16, step 3). Whether
`PutBucketPolicy` rejects the non-existent bucket-key condition key is moot,
because the statement is dropped (M-49).

Open trail item (G-20): the
[architecture diagram](./diagrams/tenant-encrypted-ingestion.drawio.svg)
does not yet show the sweep, the drain, the platform functions under
`keyFactoryRole` and `platformRole`, the registry watch, the access-log
bucket or the authoriser's registry read; it is updated before the pull
request.

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
[adr-0018]: ./adr/0018-create-keys-from-a-dedicated-role-and-never-rebind-a-tenant.md
[adr-0019]: ./adr/0019-version-the-bucket-and-scope-writes-and-deletes-to-the-tenant-roles.md

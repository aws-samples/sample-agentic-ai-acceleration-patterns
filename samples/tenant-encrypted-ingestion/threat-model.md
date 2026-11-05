<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Tenant Encrypted Ingestion: Threat Model

> Status: **Draft from the specification, 2026-11-05; not yet verified by an
> integration run.** 45 threats (T-1 to T-45), 38 mitigations
> (M-1 to M-38). Written from
> [`design/tenant-encrypted-ingestion.spec.md`](./design/tenant-encrypted-ingestion.spec.md)
> (P-1 to P-11, §3.5, §4, §5, §7, §8, §10) and ADR-0001 to ADR-0014,
> enumerated STRIDE-per-boundary with the threat-modelling MCP server (Threat
> Composer export kept out of the repository). No code exists yet: every
> "planned location" names the file and step the implementation must put the
> control in, and every unit test or integration step named is the check
> that will prove it. Four mitigations were found while modelling and are
> folded into the spec and ADRs of the same date: M-18 (copy pinned to the
> validated ETag, ADR-0008), M-22 (key ARN uniqueness item, ADR-0004), M-28
> (no `kms:PutKeyPolicy` in key policy statement 1, ADR-0002) and M-31
> (`DRAINING` sentinel, ADR-0006). Security scans are pending; see
> [Security review](#security-review).

Scope: the `TenantEncryptedIngestion` construct (one ingestion bucket with the
`ingest/` and `documents/` prefixes, one KMS key per tenant in the
`vendor-key` or `tenant-key` tier, the tenant-scoped STS session, the
ingestion API with its token authoriser, the EventBridge rule, SQS queue and
DLQ and processor Lambda, the custom validator chain, the DynamoDB registry,
the construct-owned event bus, logs and Contributor Insights), the demo stack
and its published SSM parameters, and the example validator. Out of scope:
how tenant-identity issues tokens (its own threat model), what a downstream
consumer does with a landed document (the extraction sample), what a
deployer's own validator checks beyond the §3.5 contract, the tenant's own
AWS account beyond the key it registers, and the internals of S3, KMS and STS
(AWS shared responsibility).

## Actors

| Actor | Trust | What they hold |
|---|---|---|
| Tenant user | authenticated, one tenant | a tenant-identity access token with `tenant_id`, `sub`, `client_id`, `scope` (`ingestion/deliver`, `ingestion/read`); a presigned PUT per delivery |
| Malicious tenant user (same or another tenant) | authenticated | a valid token for tenant B and a will to reach tenant A's prefix, key or rows |
| Internet caller | none | forged, expired or replayed tokens; load |
| Holder of a leaked presigned URL or token | none, but borrows a tenant's | a presigned PUT or GET, or a token, found in a log, a proxy or a client |
| Vendor operator | administrative | IAM credentials with `execute-api:Invoke` on `/platform/*`; a control-plane tenant create script |
| Other IAM principal in the vendor account | elevated | identity policies for `sts:AssumeRole`, `sqs:SendMessage`, `events:PutEvents`, `ssm:PutParameter`, CloudWatch Logs reads |
| Account root of the vendor account | full | `kms:*` in every `vendor-key` key policy (statement 3) |
| Tenant AWS account (`tenant-key` tier) | external, owns one key | a KMS key tagged `TenantId`, whose policy trusts `ingestionRole`; can revoke at any time |
| S3 service | AWS | calls KMS on the caller's behalf (`kms:ViaService`); always for a tenant-scoped session |
| Deployer-owned validator function | caller-influenced, no AWS permission from the construct | one presigned GET per call, valid `validatorObjectUrlTtlSeconds` |
| Compromised processor or API code | caller-influenced | its base role and, per delivery, one tenant session |
| Downstream consumer | its own trust | `DeliveryAccepted` events; its own tenant-scoped credentials |

## Assets

| Asset | Why it matters |
|---|---|
| Tenant documents, drop (`ingest/`) and landed (`documents/`) | The most sensitive data the vendor holds; unvalidated in the drop |
| Tenant KMS keys (both tiers) | The boundary between tenants (P-1); deleting one offboards the tenant (P-6) |
| Tenant-scoped STS credentials | Reach one tenant's prefixes, key and partition (P-2) |
| Tenant access token | The only tenant source on `/tenant/*` (P-2) |
| Presigned PUT and GET URLs | Each writes or reads exactly one object for minutes |
| Registry rows | Bind a tenant to its key ARN; carry delivery status and counters |
| Delivery events | Tell consumers what landed and where |
| Logs, metrics, access logs | Must carry `tenantId`, never a URL, signature or content (P-9, N-6) |
| Published parameters | Tell consumers and `tenant-key` owners the API and the role to trust |

## Trust boundaries

| Boundary | Crossed by | Authenticated and authorised by | Layer (`ARCHITECTURE.md` §3.3) |
|---|---|---|---|
| B1 Tenant ↔ vendor API | `/tenant/*` with a bearer token; `/platform/*` with SigV4 | token authoriser (M-1, M-2), tenant id from the authoriser only (M-3); IAM on `/platform/*` (M-6) | Identity |
| B2 Tenant upload → bucket | presigned `PUT` with SSE-KMS headers | SigV4 of the tenant session, the session policy, signed key header, bucket policy (M-7, M-8) | Data |
| B3 Vendor code → tenant-scoped session | `AssumeRole` + `TagSession` from the API and the processor; every tenant call after it | `tenantRole` trust policy (M-12), session policy ABAC on `${aws:PrincipalTag/TenantId}` (M-11), tenant id from the key prefix (M-14) | Data |
| B4 S3 ↔ KMS | `GenerateDataKey`, `Decrypt` with `kms:ViaService` | key policy statement 2 encryption context on `aws:s3:arn`, Bucket Keys off (M-8, M-10) | Data |
| B5 Vendor account ↔ tenant account | the same KMS calls on a `tenant-key` key, cross-account | the tenant's key policy trusting `ingestionRole` and the session's `aws:ResourceTag/TenantId` (M-11, M-22) | Data |
| B6 Processor ↔ validator | `lambda:Invoke` with the §3.5 request; the validator's `GET` of the presigned URL | invoke grant only, presigned GET for one object, verdict schema (M-23, M-24) | Data |
| B7 Vendor admin and root ↔ key policy | key administration, offboarding, the registry drain | key policy statement 1 without use actions, root as residual trust (M-28, M-29, M-30) | Data |
| B8 Pipeline → downstream consumers | `DeliveryAccepted` on the construct's bus; `GetObject` of `landedKey` | bus policy (M-36), consumer's own tenant session (M-19) | Data |
| B9 Everything → telemetry and parameters | logs, access logs, metrics, `ssm:GetParameter` / `PutParameter` | field-allowlisted logger (M-33), IAM | Observability |

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
| T-6 | B1 | T | Malicious tenant user with a valid token can send a `fileName` with `/`, `..`, control characters or an over-long name, leading to an object key outside `ingest/<tenantId>/<deliveryId>/`, or log injection. |
| T-7 | B1 | E | Tenant user or internet caller without vendor IAM credentials can reach `/platform/*` (`CreateTenantKey`, `DeleteTenantKey`, `RotateTenantKey`), leading to tenant keys created, rebound or offboarded by a non-vendor. |
| T-8 | B2 | T | Malicious tenant user holding a presigned PUT for its own prefix can edit the URL's object key to another tenant's prefix, or forge a URL for one, leading to a document planted in another tenant's drop. |
| T-9 | B2 | T | Uploader holding a valid presigned PUT can swap the `x-amz-server-side-encryption-aws-kms-key-id` header for another tenant's key or a key it controls, leading to an object under A's prefix encrypted with a key other than A's. |
| T-10 | B2 | T | Uploader holding a valid presigned PUT can omit the SSE headers, ask for SSE-S3, or upload over plain HTTP, leading to a tenant object at rest without the tenant's key, or in flight without TLS. |
| T-11 | B2 | S | Holder of a leaked presigned PUT URL before `uploadUrlTtlSeconds` passes can upload a document of its choosing as the tenant, leading to an attacker-chosen document entering the tenant's pipeline. |
| T-12 | B2 | T | Uploader after the cheap checks at `CreateDelivery` passed can upload content that differs from the declared type or size: a polyglot, an archive bomb, an oversized file, leading to malformed content landing, or the processor exhausted. |
| T-13 | B2 | T | Uploader still holding an unexpired presigned PUT can overwrite the drop object between the processor's validation and its copy, leading to unvalidated content landing in `documents/`. |
| T-14 | B3 | E | Compromised processor or API code acting for tenant A can read, write or decrypt tenant B's objects or registry rows, leading to cross-tenant disclosure from a code bug or a dependency compromise. |
| T-15 | B3 | S | Uploader controlling object metadata or event detail can make the processor take the tenant id from `x-amz-meta-*`, the event detail or the file name instead of the key prefix, leading to a delivery processed, landed and metered under the wrong tenant. |
| T-16 | B3 | E | Other IAM principal in the vendor account with an identity policy allowing `sts:AssumeRole` can assume `tenantRole`, or add session tags beyond `TenantId`, leading to a tenant session minted outside the two functions. |
| T-17 | B3 | E | Compromised function using its base role without a tenant session can reach tenant objects or keys, or use another role's powers (API reading objects, processor creating keys, key-management role touching S3), leading to isolation bypassed below the ABAC layer. |
| T-18 | B3 | T | Other IAM principal in the vendor account with `sqs:SendMessage` or by replaying a captured S3 event can inject or replay an `Object Created` message for an existing object, leading to a delivery reprocessed, a rejected one revisited, or a landed one overwritten. |
| T-19 | B3 | T | At-least-once delivery from S3, EventBridge and SQS can deliver the same event twice or concurrently, leading to double counters, double events, or a race between two processor runs. |
| T-20 | B4 | E | Principal holding tenant A's key permissions through a pipeline bug or a leaked key ARN can use A's key on B's prefix, or B's key on A's prefix, leading to a tenant's key protecting or exposing another tenant's objects. |
| T-21 | B4 | I | Deployer or later configuration drift can enable S3 Bucket Keys on the bucket, leading to the encryption context becomes the bucket ARN and the key-to-prefix binding silently stops holding. |
| T-22 | B4 | E | Compromised code holding a tenant session can call KMS directly (`Decrypt`, `GenerateDataKey`) instead of through S3, leading to the key used outside the bucket, on ciphertext copied elsewhere. |
| T-23 | B4 | D | Tenant with a high delivery volume can exhaust the account-wide KMS request quota, Lambda concurrency or queue throughput, leading to every other tenant's deliveries throttled (noisy neighbour). |
| T-24 | B5 | D | Tenant AWS account owning a `tenant-key` key can revoke the grant, disable the key or schedule deletion while deliveries are in flight, leading to retries into the DLQ, half-landed deliveries, or a corrupt file reported for a missing key. |
| T-25 | B5 | E | Tenant AWS account registering a `tenant-key` key can tag its key with another tenant's `TenantId`, omit the encryption-context condition, or hand over a key ARN it does not own or that another tenant already uses, leading to a key the session policy admits for the wrong tenant. |
| T-26 | B5 | R | Tenant or vendor can dispute whether a document was delivered, by whom, or when a key was revoked, leading to no evidence to settle the dispute. |
| T-27 | B5 | I | S3 and the processor under SSE-KMS can see the document in plaintext in flight behind TLS and in memory, leading to a tenant expecting vendor-blind delivery is mistaken. |
| T-28 | B6 | I | Compromised or careless validator receiving a presigned GET can copy the document out, or persist or log the URL for later use, leading to disclosure of one tenant document. |
| T-29 | B6 | E | Compromised validator invoked by the processor can obtain AWS credentials from the processor or reach any object other than the one it was given, leading to a validator reading across tenants. |
| T-30 | B6 | T | Validator can return a malformed, empty or unexpected verdict, a function error, or extra fields, leading to the processor reading a bad verdict as `ACCEPT`. |
| T-31 | B6 | D | Validator can hang, time out, throttle or fail on every call, leading to deliveries for every tenant held, or a queue backlog. |
| T-32 | B6 | I | Validator can put document content into its verdict `message`, leading to content stored on the registry row and returned by `GetDelivery`. |
| T-33 | B6 | T | Compromised validator can return `ACCEPT` for a document it should reject, leading to a document admitted that the deployer's rule would refuse. |
| T-34 | B7 | E | Vendor operator with IAM or the key-management role can decrypt tenant objects with a tenant key, leading to vendor staff reading tenant documents outside the pipeline. |
| T-35 | B7 | E | Key-management role or vendor administrator holding `kms:Put*` from key policy statement 1 can rewrite a key policy to grant itself `kms:Decrypt` or drop the prefix condition, leading to the binding removed by the role meant only to administer it. |
| T-36 | B7 | E | Account root keeping `kms:*` in every key policy can use any tenant key outside statement 2, leading to residual trust in the vendor account's root. |
| T-37 | B7 | D | Vendor operator can offboard the wrong tenant, or have `DeleteTenantKey` stop half way, leading to documents destroyed in error, or an offboarded tenant's objects left readable. |
| T-38 | B7 | T | Stack delete while the API still accepts calls can race a `CreateTenantKey` against the registry drain, leading to a key created after the drain listed the rows, never scheduled for deletion. |
| T-39 | B7 | I | Vendor administrator during the deletion window can cancel a pending key deletion after `cdk destroy` or `DeleteTenantKey`, leading to ciphertext copied out before deletion becoming readable again. |
| T-40 | B8 | I | Downstream consumer with a broad role subscribed to `DeliveryAccepted` can read `landedKey` (or an `ingest/` object) without tenant-scoped credentials, leading to isolation turned from enforced to filtered downstream. |
| T-41 | B8 | S | Other IAM principal in the vendor account with `events:PutEvents` can publish a forged `DeliveryAccepted` on the construct's bus, leading to consumers acting on a delivery that never passed the chain. |
| T-42 | B9 | I | Anyone with log read access can find a presigned PUT or GET URL, its signature, or a file name in Lambda, API Gateway or validator logs, leading to a leaked URL replayed within its lifetime, or personal data in logs. |
| T-43 | B9 | R | S3 server access logs in a format the sample does not control can record requests without a `tenantId` field, leading to per-tenant activity not attributable from that log alone. |
| T-44 | B9 | R | Pooled S3, Lambda, SQS, EventBridge and API Gateway can report usage that carries no tenant, leading to per-tenant cost not attributable without metering. |
| T-45 | B9 | T | Other IAM principal in the vendor account with `ssm:PutParameter` can overwrite the published `apiUrl` or `ingestionRoleArn`, leading to consumers sent elsewhere, or a `tenant-key` owner trusting the wrong role. |

## Mitigations

Each mitigation names the principle and ADR it realises and the planned code
location. "Deployer action" items belong in the README's production hardening
checklist.

| ID | Mitigation | Realises | Planned location |
|---|---|---|---|
| M-1 | Token authoriser on every `/tenant/*` method: JWKS signature, `iss` from `identity.discoveryUrl`, `client_id` in `identity.allowedClientIds`, `exp`, `token_use: access`; a single string `tenant_id` required; a token carrying `tenants` refused; every refusal a Deny | P-2, [ADR-0012](./adr/0012-authenticate-tenant-users-with-the-token-contract-and-the-vendor-with-iam.md) | `src/authoriser/handler.ts`, `src/construct.ts` (authoriser on each `/tenant/*` method); unit test one case per refusal |
| M-2 | Scope checks per route: `ingestion/deliver` for `CreateDelivery`, `ingestion/read` for `GetDelivery` and `ListDeliveries`; both scopes registered in tenant-identity's catalogue at deploy (`PutScope`) | P-2, [ADR-0012](./adr/0012-authenticate-tenant-users-with-the-token-contract-and-the-vendor-with-iam.md) | `src/api/handler.ts` (route table with required scope), `src/construct.ts` (scope registration custom resource) |
| M-3 | The tenant id on `/tenant/*` comes only from `requestContext.authorizer.tenantId`; no route reads a tenant id from body, header, query or path; every registry read and write uses `PK = TENANT#<caller>`, so `GetDelivery` of another tenant's ULID is a 404 and `ListDeliveries` has no cross-tenant query to write | P-2, [ADR-0011](./adr/0011-keep-one-tenant-partitioned-dynamodb-registry.md), [ADR-0012](./adr/0012-authenticate-tenant-users-with-the-token-contract-and-the-vendor-with-iam.md) | `src/api/handler.ts` (context extraction), `src/shared/registry.ts` (key builder); unit tests |
| M-4 | Fixed error model `{code, message, requestId}`; `/tenant/*` bodies never carry a tenant id or a key ARN | P-2, [ADR-0012](./adr/0012-authenticate-tenant-users-with-the-token-contract-and-the-vendor-with-iam.md) | `src/api/errors.ts`; unit test over every error path |
| M-5 | The vendor chooses the object key: `ingest/<tenantId>/<deliveryId>/<fileName>` with `deliveryId` a fresh ULID and `fileName` restricted to `[A-Za-z0-9._-]{1,128}`, no leading dot, no `/`; anything else is a 400 | P-7, [ADR-0007](./adr/0007-presign-tenant-uploads-from-the-api-under-the-tenant-session.md) | `src/api/handler.ts` (`CreateDelivery` input validation), Smithy `@pattern` on `fileName` in `model/` |
| M-6 | `/platform/*` uses `AWS_IAM` authorisation only; the token authoriser is not attached there and no tenant route reaches a platform operation | P-8, [ADR-0012](./adr/0012-authenticate-tenant-users-with-the-token-contract-and-the-vendor-with-iam.md) | `src/construct.ts` (method authorisation per resource); template assertion |
| M-7 | The presigned PUT is signed with tenant-session credentials whose session policy allows `s3:PutObject` only on `ingest/${aws:PrincipalTag/TenantId}/*`; the KMS key id and `aws:kms` are signed headers, so editing the key, the path or the header breaks the signature or meets the session policy | P-7, [ADR-0003](./adr/0003-run-every-tenant-scoped-call-under-an-abac-session.md), [ADR-0007](./adr/0007-presign-tenant-uploads-from-the-api-under-the-tenant-session.md) | `src/api/handler.ts` (`CreateDelivery` presign), `src/shared/tenant-session.ts` (session policy); integ step 4 |
| M-8 | Bucket policy: deny `s3:PutObject` unless `s3:x-amz-server-side-encryption = aws:kms`; deny any request with `aws:SecureTransport = false`; block public access; Bucket Keys off | P-3, [ADR-0001](./adr/0001-encrypt-server-side-with-sse-kms-and-one-kms-key-per-tenant.md) | `src/construct.ts` (bucket and bucket policy); template assertion; integ step 4 |
| M-9 | The processor re-checks every object: `HeadObject` `SSEKMSKeyId` equals the registry key for the prefix and `BucketKeyEnabled` is false, else `REJECTED structural:KEY_MISMATCH` | P-3, [ADR-0001](./adr/0001-encrypt-server-side-with-sse-kms-and-one-kms-key-per-tenant.md), [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-in-the-key-policy.md) | `src/processor/handler.ts` step 3 |
| M-10 | Key policy statement 2: `tenantRole` gets `kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey` only with `kms:ViaService = s3.<region>.amazonaws.com` and `kms:EncryptionContext:aws:s3:arn` like `arn:aws:s3:::<bucket>/ingest/<tenantId>/*` or `.../documents/<tenantId>/*` | P-1, [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-in-the-key-policy.md) | `src/platform/key-policy.ts` statement 2 (built by `CreateTenantKey`); unit test on the rendered policy; integ step 5 (both directions) |
| M-11 | Session policy (spec §7.2): S3 only on `<prefix>/${aws:PrincipalTag/TenantId}/*`, KMS only on keys with `aws:ResourceTag/TenantId = ${aws:PrincipalTag/TenantId}` and `kms:ViaService`, DynamoDB only with `dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/TenantId}` | P-2, [ADR-0003](./adr/0003-run-every-tenant-scoped-call-under-an-abac-session.md) | `src/shared/tenant-session.ts` (the one place a tenant session is built); integ steps 5 and 6 |
| M-12 | `tenantRole` trust policy: `sts:AssumeRole` and `sts:TagSession` only from the API and processor function roles, `aws:TagKeys` exactly `[TenantId]`, `aws:RequestTag/TenantId` present | P-2, [ADR-0003](./adr/0003-run-every-tenant-scoped-call-under-an-abac-session.md) | `src/construct.ts` (`tenantRole`); template assertion |
| M-13 | Role asymmetry: the base function roles hold no S3 object or KMS use permission; the API role cannot read objects; the processor cannot create or delete keys; the key-management role holds no S3 permission | P-8, [ADR-0003](./adr/0003-run-every-tenant-scoped-call-under-an-abac-session.md) | `src/construct.ts` (role definitions); template assertions per role |
| M-14 | The processor takes `tenantId` and `deliveryId` from the second and third key segments, loads the delivery row under that tenant's session and requires `objectKey` to equal the event key; object metadata, event detail and file name are never a tenant source | P-2, [ADR-0008](./adr/0008-validate-then-land.md) | `src/processor/handler.ts` step 1 |
| M-15 | Conditional transitions: `AWAITING_UPLOAD -> PROCESSING` and `PROCESSING -> ACCEPTED` are conditional writes; a replayed or duplicate event sees a non-`AWAITING_UPLOAD` row and exits; counters move in the same transaction as the terminal status | P-10, [ADR-0010](./adr/0010-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md), [ADR-0011](./adr/0011-keep-one-tenant-partitioned-dynamodb-registry.md) | `src/processor/handler.ts` steps 1 and 7, `src/shared/registry.ts` |
| M-16 | Queue policy allows `sqs:SendMessage` only from the construct's EventBridge rule (`aws:SourceArn`); the rule matches `source: aws.s3`, the bucket name and the `ingest/` prefix | P-10, [ADR-0010](./adr/0010-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md) | `src/construct.ts` (rule and queue policy); template assertion |
| M-17 | Structural checks before anything lands: size from `HeadObject`, magic bytes against the declared type, ZIP central directory bounds (entry count, total uncompressed size, ratio), streamed SHA-256 | P-10, [ADR-0008](./adr/0008-validate-then-land.md) | `src/processor/structural.ts`, `src/processor/handler.ts` steps 3-4; unit tests with synthetic polyglot and bomb fixtures |
| M-18 | The copy lands what was validated: `CopyObject` with `CopySourceIfMatch` set to the ETag read at step 3, so an overwrite between validation and copy fails the copy and the delivery is retried from the start (spec §8 step 6, ADR-0008) | P-10, [ADR-0008](./adr/0008-validate-then-land.md) | `src/processor/handler.ts` step 6 |
| M-19 | Quarantine: `ingest/` has a `dropRetentionDays` lifecycle and a rejected object is deleted at once; consumers subscribe to `DeliveryAccepted`, read only `documents/` and only under their own tenant session; the event carries no URL | P-10, [ADR-0008](./adr/0008-validate-then-land.md), [ADR-0010](./adr/0010-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md) | `src/construct.ts` (lifecycle rule), `src/processor/handler.ts` step 7; README consumer section |
| M-20 | Presigned PUT bounded to one key, one tenant, one key ARN and `uploadUrlTtlSeconds` (default 900 s); the delivery row admits one upload; an unused URL becomes `EXPIRED` in the hourly sweep; a leaked URL still runs the whole chain | P-7, [ADR-0007](./adr/0007-presign-tenant-uploads-from-the-api-under-the-tenant-session.md) | `src/api/handler.ts`, `src/sweep/handler.ts` |
| M-21 | Fail closed: KMS `AccessDenied`, `DisabledException`, `KMSInvalidStateException` at steps 3-6 set the delivery `KEY_UNAVAILABLE` and the key row `REVOKED`, publish `DeliveryKeyUnavailable` and delete the message without retry; `CreateDelivery` returns 409 when the key row is not `ACTIVE`; `GetTenantKey` refreshes the status | P-5, [ADR-0005](./adr/0005-fail-closed-on-an-unusable-key-with-a-distinct-class.md) | `src/processor/errors.ts` (classifier), `src/processor/handler.ts` steps 3-6, `src/api/handler.ts`; integ step 8 |
| M-22 | `CreateTenantKey` for `tenant-key` probes under the tenant session (`DescribeKey`, `GenerateDataKey` with a probe context, `Decrypt`), requires `KeySpec SYMMETRIC_DEFAULT` and the `TenantId` tag, and writes a `KEYARN#<arn>` uniqueness item in the same transaction as the key row so one key cannot serve two tenants | P-4, [ADR-0004](./adr/0004-offer-two-key-tiers-behind-one-contract.md), [ADR-0011](./adr/0011-keep-one-tenant-partitioned-dynamodb-registry.md) | `src/platform/create-tenant-key.ts`; integ step 1 |
| M-23 | Validator isolation: each call gets a presigned GET for one object, signed by the tenant session, valid `validatorObjectUrlTtlSeconds` (default 300 s); the payload carries no credentials; `LambdaValidator.bind` grants the processor `lambda:InvokeFunction` and the validator nothing | P-11, [ADR-0009](./adr/0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md) | `src/validators/lambda-validator.ts`, `src/processor/handler.ts` step 5 |
| M-24 | Strict verdict schema: `version: "1"`, `verdict` in `ACCEPT|REJECT`, `code` `[A-Z0-9_]{1,40}`, `message` capped at 1,024 characters, no other properties; a schema failure, `FunctionError` or timeout is a validator error and never `ACCEPT` | P-11, [ADR-0009](./adr/0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md) | `src/processor/verdict.ts`; unit test per malformed shape |
| M-25 | Validator time is budgeted: per-validator timeout, processor timeout computed at synth from the chain, visibility timeout six times that, `onValidatorError` hold or reject, DLQ depth alarm | P-11, [ADR-0009](./adr/0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md) | `src/construct.ts` (timeout budget, DLQ alarm), `src/processor/handler.ts` step 5; integ step 7b |
| M-26 | Validator message hygiene: stored as `reasonMessage`, returned only to the same tenant, never logged (the log line carries `code`); the README states the author's promise not to include content | P-11, [ADR-0009](./adr/0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md) | `src/processor/verdict.ts`, `src/shared/logger.ts`; README validator section |
| M-27 | Built-in structural checks run first and the chain stops at the first `REJECT`; each validator's verdict is recorded on the row with its name, so an `ACCEPT` is attributable to one validator | P-11, [ADR-0009](./adr/0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md) | `src/processor/handler.ts` steps 4-5 |
| M-28 | Key policy statement 1 gives the key-management role administration without `kms:Encrypt`, `kms:Decrypt` or `kms:GenerateDataKey*`; no `kms:PutKeyPolicy` (spec §7.1; the policy is set at `CreateKey` and the root statement keeps the key manageable) | P-1, [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-in-the-key-policy.md) | `src/platform/key-policy.ts` statement 1; unit test asserts no use actions and no `kms:PutKeyPolicy` |
| M-29 | Detect key-policy changes: an EventBridge rule on CloudTrail `PutKeyPolicy`, `CreateGrant`, `CancelKeyDeletion` and `Decrypt` outside `kms:ViaService` for keys tagged `TenantId` (deployer action; CloudTrail is account-level) | P-1, [ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-in-the-key-policy.md), [ADR-0013](./adr/0013-observe-and-attribute-cost-per-tenant.md) | README production hardening checklist |
| M-30 | Offboarding order: row to `DELETING` first (no new presign), objects under both prefixes deleted under the tenant session, alias deleted, `ScheduleKeyDeletion` with `keyDeletionWindowDays`, row removed last; idempotent on retry; the processor drops events for a missing or `DELETING` row; the window lets an operator cancel a wrong delete | P-6, [ADR-0006](./adr/0006-make-offboarding-cryptographic.md) | `src/platform/delete-tenant-key.ts`; integ step 11 |
| M-31 | Registry drain runs after the API is gone: the API and platform function depend on the drain resource so CloudFormation deletes them first, and the drain writes a `DRAINING` sentinel that `CreateTenantKey` checks in its transaction | P-6, [ADR-0006](./adr/0006-make-offboarding-cryptographic.md) | `src/construct.ts` (dependency order), `src/platform/drain.ts`, `src/platform/create-tenant-key.ts` |
| M-32 | Per-tenant metering and a throttling seam: `kmsRequests`, bytes and deliveries per tenant in the structured log and on the key row, Contributor Insights top-tenant rules, processor reserved concurrency and SQS `maximumConcurrency` so a burst queues instead of hitting KMS, and a per-tenant in-flight cap in `CreateDelivery` as the documented seam | P-9, [ADR-0013](./adr/0013-observe-and-attribute-cost-per-tenant.md) | `src/construct.ts` (rules, concurrency), `src/processor/handler.ts` step 7, `src/api/handler.ts` |
| M-33 | Field-allowlisted logger: only `tenantId`, `deliveryId`, `validator`, `verdict`, `code`, `durationMs`, `status`, `sizeBytes`, `kmsRequests`; never a URL, signature, header or file name; the API Gateway access log format omits the query string | P-9, [ADR-0013](./adr/0013-observe-and-attribute-cost-per-tenant.md) | `src/shared/logger.ts`, `src/construct.ts` (access log format); unit test and integ step 7b assert no `X-Amz-Signature` |
| M-34 | `tenantId` in every Lambda log line and the API access log (`$context.authorizer.tenantId`); for S3 server access logs the tenant is joined from the second key segment, with the query in `architecture.md` | P-9, [ADR-0013](./adr/0013-observe-and-attribute-cost-per-tenant.md) | `src/shared/logger.ts`, `src/construct.ts`; `architecture.md` observability section; integ step 10 |
| M-35 | Cost attribution: `TenantId` cost allocation tag on every `vendor-key` key; per-tenant counters and `kmsRequests` metered for pooled S3 and KMS; the formula and the unattributable remainder (API Gateway, Lambda, SQS, EventBridge, apportioned by deliveries) in the README Costs section | P-9, [ADR-0013](./adr/0013-observe-and-attribute-cost-per-tenant.md) | `src/platform/create-tenant-key.ts` (tags), `src/processor/handler.ts` step 7; README Costs |
| M-36 | The construct owns its event bus; its resource policy allows `events:PutEvents` only from the processor role and events carry `source: tenant-encrypted-ingestion` | P-8, [ADR-0010](./adr/0010-drive-the-pipeline-with-eventbridge-sqs-and-lambda.md) | `src/construct.ts` (event bus policy); template assertion |
| M-37 | Audit trail: the delivery row keeps `createdBy` (`sub`), `sha256`, `sizeBytes`, the validator list and timestamps; PITR on; S3 access logs; KMS calls on a `tenant-key` key appear in the tenant's own CloudTrail | P-2, [ADR-0011](./adr/0011-keep-one-tenant-partitioned-dynamodb-registry.md), [ADR-0013](./adr/0013-observe-and-attribute-cost-per-tenant.md) | `src/processor/handler.ts` step 7, `src/construct.ts` (PITR, access logging) |
| M-38 | Published parameters are written by the demo stack only; the README key policy takes `ingestionRoleArn` from the deployer's own channel, and the hardening checklist restricts `ssm:PutParameter` on `/application-plane/shared/ingestion/*` | P-8, [ADR-0014](./adr/0014-deliver-the-pattern-as-a-cdk-construct.md) | `src/main.ts` (parameters); README production hardening checklist |

## Threat to mitigation mapping

| Threat | Mitigations | Disposition |
|---|---|---|
| T-1 | M-1 | Mitigated by design |
| T-2 | M-1 | Mitigated by design |
| T-3 | M-2 | Mitigated by design |
| T-4 | M-3 | Mitigated by design |
| T-5 | M-3, M-4 | Mitigated by design |
| T-6 | M-5 | Mitigated by design |
| T-7 | M-6 | Mitigated by design |
| T-8 | M-7 | Mitigated by design |
| T-9 | M-7, M-9 | Mitigated by design |
| T-10 | M-8 | Mitigated by design |
| T-11 | M-20 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-12 | M-17 | Mitigated by design |
| T-13 | M-18 | Mitigated by design |
| T-14 | M-11 | Mitigated by design |
| T-15 | M-14 | Mitigated by design |
| T-16 | M-12 | Mitigated by design |
| T-17 | M-13 | Mitigated by design |
| T-18 | M-14, M-15, M-16 | Mitigated by design |
| T-19 | M-15 | Mitigated by design |
| T-20 | M-9, M-10, M-11 | Mitigated by design |
| T-21 | M-8, M-9 | Mitigated by design |
| T-22 | M-10, M-11 | Mitigated by design |
| T-23 | M-32 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-24 | M-21 | Mitigated by design |
| T-25 | M-9, M-22 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-26 | M-37 | Mitigated by design |
| T-27 | none | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-28 | M-23 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-29 | M-23 | Mitigated by design |
| T-30 | M-24 | Mitigated by design |
| T-31 | M-25 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-32 | M-26 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-33 | M-27 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-34 | M-13, M-28 | Mitigated by design |
| T-35 | M-28, M-29 | Mitigated by design |
| T-36 | M-29 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-37 | M-30 | Mitigated by design |
| T-38 | M-31 | Mitigated by design |
| T-39 | M-29 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-40 | M-19 | Mitigated by design |
| T-41 | M-36 | Mitigated by design |
| T-42 | M-20, M-33 | Mitigated by design |
| T-43 | M-34 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-44 | M-35 | Accepted (residual), see [Accepted risks](#accepted-risks) |
| T-45 | M-38 | Mitigated by design |

## Accepted risks

Listed in order of consequence. Each goes on the README's production
hardening checklist unless marked "by design".

- **T-27, plaintext in flight behind TLS (by design).** The sample encrypts
  server side (SSE-KMS, [ADR-0001](./adr/0001-encrypt-server-side-with-sse-kms-and-one-kms-key-per-tenant.md)). S3 and the processor see each document
  in plaintext inside TLS and in memory; every custom validator sees it too.
  A tenant that needs a drop the vendor cannot read needs the sealed-drop
  tier (client-side envelope with an asymmetric key), an extension seam
  (spec §11), not built.
- **T-36, the account root can bypass key policy statement 2.** KMS requires
  a key to stay manageable, so the root keeps `kms:*` ([ADR-0002](./adr/0002-bind-each-key-to-its-tenant-prefix-in-the-key-policy.md), spec §7.1
  statement 3). The root of the vendor account is therefore the residual
  trust for every `vendor-key` tenant. M-29 detects use outside
  `kms:ViaService`; nothing prevents it. A tenant that does not accept it
  takes the `tenant-key` tier ([ADR-0004](./adr/0004-offer-two-key-tiers-behind-one-contract.md)), where the root of the tenant's
  own account holds that position instead.
- **T-25, cross-account `aws:ResourceTag/TenantId` only tested same-account.**
  The session policy admits a `tenant-key` key by its `TenantId` resource tag,
  which the tenant sets ([ADR-0003](./adr/0003-run-every-tenant-scoped-call-under-an-abac-session.md), [ADR-0004](./adr/0004-offer-two-key-tiers-behind-one-contract.md)). The integration test uses a
  same-account key as the stand-in for a tenant account (spec §10 step 1), so
  the cross-account evaluation of the resource-tag condition is not proven
  by the test. A tenant that tags its key with another tenant's id still
  cannot get that key used for the other tenant: the presigner signs only the
  registry's key for the tenant (M-7), the key ARN is unique across tenants
  (M-22) and the processor rejects a mismatch (M-9). A real cross-account run
  is a hardening item.
- **T-28, a validator can leak its presigned GET.** A validator that
  persists, logs or forwards its URL exposes that one object until
  `validatorObjectUrlTtlSeconds` passes (default 300 s, at most 900 s), and a
  validator can always copy the bytes it was given ([ADR-0009](./adr/0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md)). The URL
  reaches no other object and carries no credential (M-23). The validator is
  deployer-owned code and its author owns that promise.
- **T-32, a validator message could carry document content.** The `message`
  of a `REJECT` is stored on the row and returned by `GetDelivery` to the same
  tenant ([ADR-0009](./adr/0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md)). M-24 caps its length and M-26 keeps it out of logs,
  but whether it contains content is the validator author's responsibility;
  the README says so.
- **T-33, a compromised validator can accept a document it should reject.**
  Admission is only as strong as the validator the deployer plugged in. The
  structural checks still run first (M-17), the object is still encrypted
  with the tenant's key and lands only in that tenant's prefix, and the row
  records which validator accepted (M-27).
- **T-31, a silent or slow validator holds deliveries in the DLQ.** Under
  `onValidatorError: 'hold'` (the default, [ADR-0009](./adr/0009-make-validation-a-pluggable-chain-of-deployer-supplied-validators.md)) a validator that
  times out or errors leaves every affected delivery in the DLQ with its
  object in the drop until an operator replays it, and the drop lifecycle
  (`dropRetentionDays`) bounds how long the object waits. Nothing lands that
  the chain did not accept. A deployer that prefers availability over
  re-checking sets `'reject'`. The DLQ depth alarm (M-25) is the signal.
- **T-39, a KMS key pending deletion survives `cdk destroy` (by design).**
  KMS deletes keys only after a 7 to 30 day window ([ADR-0006](./adr/0006-make-offboarding-cryptographic.md)); `cdk
  destroy` and `DeleteTenantKey` leave keys `PendingDeletion` at no cost, and
  the integration test lists them (spec §10 step 12). Within the window an
  administrator could cancel the deletion; M-29 detects `CancelKeyDeletion`.
- **T-11, a leaked presigned PUT lets a third party upload once.** Within
  `uploadUrlTtlSeconds` the holder can write the one object, under that
  tenant's prefix, with that tenant's key ([ADR-0007](./adr/0007-presign-tenant-uploads-from-the-api-under-the-tenant-session.md)). The upload still
  runs the whole validation chain (M-20). Shorten the TTL for higher-risk
  tenants.
- **T-23, KMS quota and concurrency are shared per account and Region.** One
  tenant can still consume a share of the KMS request quota, Lambda
  concurrency and queue throughput. Metering per tenant and the throttling
  seam (M-32, [ADR-0013](./adr/0013-observe-and-attribute-cost-per-tenant.md)) make it visible and bounded; a hard per-tenant
  quota is an extension.
- **T-43, S3 server access logs carry no `tenantId` field.** The log format
  is S3's. The tenant is the second segment of the object key, and M-34
  documents the join ([ADR-0013](./adr/0013-observe-and-attribute-cost-per-tenant.md)).
- **T-44, pooled costs have an unattributable remainder.** API Gateway,
  Lambda, SQS and EventBridge are apportioned by deliveries per tenant;
  `tenant-key` KMS requests are billed to the tenant's account (M-35,
  [ADR-0013](./adr/0013-observe-and-attribute-cost-per-tenant.md)).

## Security review

Pending. No code has been written yet. Before the pull request, the security
review of the sample standard (`docs/sample-standard.md` §6) runs on the
synthesised tree: `npx projen build` under the deployment profile, then
ProtoShield and the Automated Security Helper against the sample directory
with `cdk.out/` present. Every finding will be dispositioned here (fixed,
accepted with reason, or false positive with evidence); scanner outputs stay
out of the repository.

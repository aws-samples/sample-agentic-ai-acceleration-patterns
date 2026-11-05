<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0003: Put the tenant boundary in the identity policy of one tenant role per function

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-1, F-2, F-9, F-10, F-18, F-24, F-28)

## Context
The API presigns uploads and writes registry rows; the processor reads the
drop, writes the landed prefix and updates rows; the platform function, the
stack-delete drain and the sweep create and delete keys, list and delete a
tenant's objects and probe a tenant-owned key. Each acts for one tenant at a
time, chosen from a verified source (§7.6). A bug that picks the wrong tenant
must be refused by AWS, not caught by code (P-2), no single role should hold
everything the pipeline can do (P-8), and the design must hold at 10,000
tenants (N-3).

Where the ABAC conditions live decides whether the wall is enforced. A
session policy passed on `AssumeRole` can only narrow the role's identity
policy, and the caller chooses whether to pass it: code that omits it holds
the role's full identity permissions, which for ABAC must cover every
tenant's prefix and key (F-1). Passed session policies are also capped at
2,048 characters including managed policy ARNs, with the session tags in the
same packed size, which long bucket and key ARNs across four statements
approach (F-24); an identity policy allows 10,240. The trust policy can fix
the session tag **key** but never its **value**, so whatever code calls
`AssumeRole` chooses the tenant (F-2). A Lambda role assuming another role is
role chaining, capped at one hour, and a URL presigned with temporary
credentials dies when they do (F-18). Realises P-2, P-7, P-8 and §3.1, §3.4,
§7.1, §7.6.

## Options considered
### Option 1: One broad pipeline role, code filters by tenant
Pros: simplest; no STS call per request. Cons: filtered isolation; the role
reaches every tenant's prefix, key and partition, so one wrong variable or a
compromised dependency reads across tenants; the API could read documents it
only needs to presign.
### Option 2: One IAM role per tenant
Pros: enforced; each role names one prefix and one key. Cons: the IAM role
quota (1,000 per account by default, 5,000 at most) caps the tenant count
below N-3; onboarding creates IAM resources, which is slow and eventually
consistent; thousands of near-identical policies to audit.
### Option 3: One shared `tenantRole` with the ABAC conditions in a session policy
Pros: one role and one policy document; no per-tenant IAM resource. Cons: the
wall is whatever the caller passes, so it is filtered, not enforced (F-1); the
API and the processor assume the same role, so "the API cannot read objects"
holds only if the API passes the narrower policy; the 2,048-character cap
(F-24); the platform function, drain and sweep are not trusted at all, so
offboarding cannot list or delete a tenant's objects (F-9).
### Option 4: ABAC in the identity policy of one tenant role per function
Pros: enforced; three tenant roles, `tenantUploadRole`, `tenantProcessRole`
and `tenantPlatformRole`, each trusted by exactly one base role, each with
`${aws:PrincipalTag/TenantId}` in every statement of its **identity** policy
(S3 resources on `ingest/` and `documents/`, `dynamodb:LeadingKeys` on
`TENANT#${aws:PrincipalTag/TenantId}`, `aws:ResourceTag/TenantId` on keys,
`kms:ViaService` for use actions); no session policy is passed, so there is
nothing to omit; the asymmetry is in the roles, not in the code; no
per-tenant IAM resource. Cons: six roles instead of three; one `AssumeRole`
per tenant context (STS quota 600 requests per second per account, shared
with everything else in the account, bounded per tenant by ADR-0015); ABAC
policies are harder to read than ARNs.

## Decision
Option 4 (spec §7.1). Three base roles reach no tenant object: `apiRole` may
only assume `tenantUploadRole`; `processorRole` may only assume
`tenantProcessRole`, receive and delete its queue's messages, invoke bound
validators and put events; `platformRole` may only assume
`tenantPlatformRole`, administer keys with the explicit action list of
ADR-0002 (never `kms:CreateGrant`, `kms:PutKeyPolicy` or a use action, each
also denied in its identity policy) and reach the registry table-wide.
`tenantUploadRole` may `PutObject` on `ingest/${tag}/*` with SSE-KMS,
`GenerateDataKey` via S3 and `DescribeKey` on keys tagged with the tenant;
`tenantProcessRole` may `GetObject` and `DeleteObject` on `ingest/${tag}/*`,
`PutObject` on `documents/${tag}/*`, `Decrypt` and `GenerateDataKey` via S3;
`tenantPlatformRole` may `ListBucket` with `s3:prefix` on both tenant
prefixes, `DeleteObject` on both, `PutObject` and `GetObject` on
`ingest/${tag}/_probe/*` and use the key via S3 (F-9). All three carry the
same `LeadingKeys` statement on the registry. Each trust policy names its one
base role and requires `ForAllValues:StringEquals aws:TagKeys = ["TenantId"]`
**and** `Null aws:RequestTag/TenantId = false` (the first alone is true for
an empty tag set) and a `[a-z0-9-]*` value pattern; that fixes the key, not
the value, and the residual is stated in ADR-0001 and the threat model
(T-14). `RoleSessionName` is `t-<tenantId>-<deliveryId | operation>`, so S3
access logs, CloudTrail and KMS events name the tenant without a join (F-28,
ADR-0013). Sessions are requested for 3,600 s, the role-chaining cap; a
function MAY cache one per tenant, but MUST presign only when its remaining
lifetime is at least the URL's TTL plus 60 s, and reports `expiresAt =
min(now + TTL, credentials.Expiration)` (F-18, ADR-0007). `platformRole`'s
table-wide registry access is a filtered component, chosen deliberately:
the `KEYARN#` uniqueness item, the `SYSTEM`/`DRAINING` sentinel and the
sweep's cross-tenant GSI query cannot live under any one tenant's
`LeadingKeys` (F-10, ADR-0011). It is reached only through IAM-authenticated
`/platform/*`, the drain and the sweep, never by a tenant request, and it
holds no S3 permission and no KMS use action, so a bug in it can corrupt
registry rows but cannot read a document. The tenant id that goes into the
tag comes only from the verified token, the presigner-fixed object key, or
the platform path (§7.6).

## Consequences
Easier: adding a tenant adds no IAM resource; a cross-tenant call fails at
S3, DynamoDB or KMS with an `AccessDenied` that names the wall; a template
test asserts that no tenant-role statement lacks the tag condition and that
each tenant role trusts exactly one base role; the integration test attacks
the identity-policy wall separately from the key-policy wall (§10 steps 5
and 6). Harder: six roles to read and test; every tenant-scoped request may
pay an STS round trip (N-1 budgets one), cached sessions are reused only
within the freshness rule above; compromised function code can still act as
any one tenant per session, which CloudTrail `AssumeRole` events (with the
tag and the session name) make visible but do not prevent. Revisit if STS
throttling appears under N-2 load despite ADR-0015, or if AWS offers a way to
bind a tag value to a verified source at `AssumeRole`.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0003: Put the tenant boundary in the identity policy of one tenant role per function

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-1, F-2, F-9, F-10, F-18, F-24, F-28)
- Revised: 2026-11-05, second security review (G-1, G-2, G-8, G-11, G-13, G-16, G-17)

## Context
The API presigns uploads and writes registry rows; the processor reads the
drop, writes the landed prefix and updates rows; the authoriser reads one
tenant's API key value; the platform function creates and deletes keys, lists
and deletes a tenant's objects and probes a tenant-owned key; the stack-delete
drain and the sweep clean up. Each acts for one tenant at a time, chosen from
a verified source (§7.6). A bug that picks the wrong tenant must be refused by
AWS, not caught by code (P-2), no single role should hold everything the
pipeline can do (P-8), and the design must hold at 10,000 tenants (N-3).

Where the ABAC conditions live decides whether the wall is enforced. A
session policy passed on `AssumeRole` can only narrow the role's identity
policy, and the caller chooses whether to pass it: code that omits it holds
the role's full identity permissions, which for ABAC must cover every
tenant's prefix and key (F-1). Passed session policies are also capped at
2,048 characters including managed policy ARNs, with the session tags in the
same packed size (F-24); an identity policy allows 10,240. The trust policy
can fix the session tag **key** but never its **value**, so whatever code
calls `AssumeRole` chooses the tenant (F-2). A Lambda role assuming another
role is role chaining, capped at one hour, and a URL presigned with temporary
credentials dies when they do (F-18).

Four further facts came out of the second review. IAM `StringLike` knows only
`*` and `?`, so a trust-policy value pattern such as `[a-z0-9-]*` matches only
values that begin with that literal text: every `AssumeRole` would fail, and
the obvious "fix" with `*` constrains nothing (G-2). Session tag values may
contain `/`, and the tenant roles' resources are `ingest/${tag}/*`, so an
unconstrained tenant id `a/b` would nest inside tenant `a`'s prefix (G-2).
`RoleSessionName` is 2 to 64 characters of `[\w+=,.@-]`, so the session name
format bounds the tenant id's length (G-2). And `TransactWriteItems` is not
an IAM action: a transaction is authorised per item as `PutItem`,
`UpdateItem`, `DeleteItem` or `ConditionCheckItem`, each against the same
`LeadingKeys` condition (G-16). Realises P-2, P-7, P-8 and §3.1, §3.4, §7.0,
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
and `tenantPlatformRole`, each trusted only by named base roles, each with
`${aws:PrincipalTag/TenantId}` in every statement of its **identity** policy
(S3 resources on `ingest/` and `documents/`, `dynamodb:LeadingKeys` on
`TENANT#${aws:PrincipalTag/TenantId}`, `aws:ResourceTag/TenantId` on keys,
`kms:ViaService` for use actions); no session policy is passed, so there is
nothing to omit; the asymmetry is in the roles, not in the code; no
per-tenant IAM resource. Cons: nine roles; one `AssumeRole` per tenant
context (STS quota 600 requests per second per account, shared with
everything else in the account, bounded per tenant by ADR-0015); ABAC
policies are harder to read than ARNs; the tenant id needs a grammar, since
the trust policy can only keep characters out, not prove a value.

## Decision
Option 4 (spec §7.0, §7.1). **Six base roles** reach no tenant object:

- `authoriserRole`: `dynamodb:GetItem` on the table with `dynamodb:Select =
  SPECIFIC_ATTRIBUTES` and `ForAllValues:StringEquals dynamodb:Attributes =
  [PK, SK, apiKeyValue, status]`, nothing else (G-8, ADR-0012). A filtered,
  table-wide read of two attributes, named in the threat model.
- `apiRole`: may only assume `tenantUploadRole`.
- `processorRole`: may only assume `tenantProcessRole`, receive, delete and
  change visibility of its queue's messages, put events on the bus and
  invoke bound validators.
- `keyFactoryRole`: `CreateTenantKey` only. `kms:CreateKey` restricted to
  `SYMMETRIC_DEFAULT`, `AWS_KMS` origin, single-Region and the tag keys
  `TenantId` and `tei:stack`; `kms:TagResource` only on a key that has no
  `TenantId` yet; alias, rotation, `DescribeKey` and `ScheduleKeyDeletion` to
  undo a failed create; `PutItem`, `ConditionCheckItem` and `UpdateItem` on
  the `KEY`, `KEYARN#` and `SYSTEM` items; may assume `tenantPlatformRole`
  for the probe; explicit Deny of `kms:PutKeyPolicy`, `kms:CreateGrant`,
  `kms:UntagResource` and every use action (ADR-0018).
- `platformRole`: every other `/platform/*` operation and the drain. May
  assume `tenantPlatformRole`; KMS administration without creation (the
  ADR-0002 statement 1 list plus `kms:ListKeys`); `apigateway:*` on the
  usage plan's keys; table-wide `GetItem`, `Query`, `UpdateItem`,
  `DeleteItem`, `ConditionCheckItem` and `Scan` (the drain); explicit Deny of
  `kms:CreateKey`, `kms:TagResource`, `kms:UntagResource`,
  `kms:PutKeyPolicy`, `kms:CreateGrant` and every use action.
- `sweepRole`: the hourly sweep. May assume `tenantProcessRole` **only**,
  never `tenantPlatformRole`, so it deletes drop objects and runs the
  recovery probe but can never reach `documents/` (G-11, ADR-0019);
  `dynamodb:Query` on the sweep GSI, `GetItem` and `UpdateItem` table-wide;
  no KMS action.

The registry actions are listed per item, never as `TransactWriteItems`, and
`ConditionCheckItem` appears only where a transaction carries a condition
check (G-16). Every role's `UpdateItem` is denied when `dynamodb:Attributes`
contains `keyArn` or `tier`, so `keyArn` is written once by a `PutItem` with
`attribute_not_exists(keyArn)` and never changed (G-1, ADR-0011).

**Three tenant roles** hold the wall. `tenantUploadRole` may `PutObject` on
`ingest/${tag}/*` with SSE-KMS, `GenerateDataKey` via S3 and `DescribeKey` on
keys tagged with the tenant. `tenantProcessRole` may `GetObject` and
`DeleteObject` on `ingest/${tag}/*`, `PutObject` on `ingest/${tag}/_probe/*`
(the recovery probe, G-5) and on `documents/${tag}/*`, `Decrypt` and
`GenerateDataKey` via S3. `tenantPlatformRole` may `ListBucket` with
`s3:prefix` on both tenant prefixes, `DeleteObject` and
`DeleteObjectVersion` on both (offboarding, ADR-0006), `PutObject` and
`GetObject` on `ingest/${tag}/_probe/*` and use the key via S3 (F-9). All
three carry the same `LeadingKeys` statement on the registry (`GetItem`,
`PutItem`, `UpdateItem`, `Query`, `ConditionCheckItem`; no `DeleteItem`, no
`Scan`), and `PutItem`/`UpdateItem` are **denied** when `dynamodb:Attributes`
contains `keyArn`, `tier` or `apiKeyValue`, so code holding a tenant session
cannot rebind its own tenant or change its throttling identity (G-13). The
counters (`inFlight`, `bytesStored` and the like) stay writable by the tenant
roles; that residual is named in the threat model.

**Tenant id grammar.** A tenant id matches `^[a-z0-9][a-z0-9-]{1,34}$`
(2 to 35 characters), enforced in code at every entry: the authoriser, the
Smithy model for `/platform/tenants/{tenantId}`, and the processor's key
parse (§7.0, G-2). Each trust policy names its base roles and requires
`ForAllValues:StringEquals aws:TagKeys = ["TenantId"]` **and** `Null
aws:RequestTag/TenantId = false` (the first alone is true for an empty tag
set) **and** `StringNotLike aws:RequestTag/TenantId = ["*/*", "*:*", "*=*",
"*+*", "*@*", "*.*", "* *", "*,*"]`. The `StringNotLike` guard replaces the
earlier `StringLike` value pattern, which IAM cannot express: the trust
policy now keeps out every character that would break a prefix or a session
name, and the grammar in code does the rest. That fixes the key and its
character set, not the tenant it names; the residual is stated in ADR-0001
and the threat model (T-14).

**Session names.** `RoleSessionName` is `t-<tenantId>-<suffix>`, where
`suffix` is the last 16 characters of the `deliveryId` or an operation name
of at most 16 characters: at most 2 + 35 + 1 + 16 = 54 characters, under the
64-character limit, so no valid tenant id can make `AssumeRole` fail closed
(G-2). S3 access logs, CloudTrail and KMS events then name the tenant without
a join (F-28, ADR-0013).

**Session lifetime.** Sessions are requested for 3,600 s, the role-chaining
cap. A function MAY cache one per tenant, but MUST presign only when its
remaining lifetime is at least the URL's TTL plus 60 s, MUST start a
processor run at step 1 only with at least the processor timeout of lifetime
left (G-17), and reports `expiresAt = min(now + TTL,
credentials.Expiration)` (F-18, ADR-0007).

Table-wide registry access (`keyFactoryRole`, `platformRole`, `sweepRole`,
and the two-attribute read of `authoriserRole`) is a filtered component,
chosen deliberately: the `KEYARN#` uniqueness item, the `SYSTEM`/`DRAINING`
sentinel, the sweep's cross-tenant GSI query and the authoriser's lookup
before any tenant session exists cannot live under one tenant's `LeadingKeys`
(F-10, ADR-0011). It is reached only through IAM-authenticated `/platform/*`,
the drain, the sweep and the authoriser, never by a tenant request, and none
of those roles can read a document. What a compromised `keyFactoryRole` can
still do is bind a **new** tenant to a key whose policy it chose; it cannot
rebind an existing tenant (ADR-0018). The tenant id that goes into the tag
comes only from the verified token, the presigner-fixed object key, or the
platform path (§7.6).

## Consequences
Easier: adding a tenant adds no IAM resource; a cross-tenant call fails at
S3, DynamoDB or KMS with an `AccessDenied` that names the wall; a template
test asserts that no tenant-role statement lacks the tag condition, that each
tenant role trusts only its named base roles, that the trust policy carries
the `StringNotLike` guard, that no policy names `TransactWriteItems`, and
that the `keyArn`/`tier` Deny is on every role; a unit test per illegal
character shows the grammar refuses it and the trust policy would too; the
integration test attacks the identity-policy wall separately from the
key-policy wall (§10 steps 5 and 6). Harder: nine roles to read and test;
every tenant-scoped request may pay an STS round trip (N-1 budgets one), and
cached sessions are reused only within the freshness rules above; a tenant id
longer than 35 characters (a UUID is 36) cannot be used as is, so a control
plane with UUID tenant ids maps them; compromised function code can still act
as any one tenant per session, which CloudTrail `AssumeRole` events (with the
tag and the session name) make visible but do not prevent. Revisit if STS
throttling appears under N-2 load despite ADR-0015, if IAM gains a regular
expression operator, or if AWS offers a way to bind a tag value to a verified
source at `AssumeRole`.

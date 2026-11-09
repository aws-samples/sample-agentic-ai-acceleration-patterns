<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0003: Put the tenant boundary in identity policies of one tenant role per function

- Status: Accepted
- Date: 2026-11-05
- Amended by: ADR-0017, ADR-0020
- Deciders: Dave Roberts (PSA)

## Context
The API presigns, the processor and sweep read and land drops, the platform
functions create, probe and delete; each acts for one tenant at a time, from a
verified source (§7.6). A wrong-tenant bug must be refused by AWS (P-2), no
role should hold everything (P-8), at 10,000 tenants (N-3). A session policy
only narrows, and the caller may omit it. The trust policy fixes a tag key,
never its value. IAM wildcards know only `*` and `?`. Tag values may hold
`/`, which would nest `ingest/a/b/` in tenant `a`. Role chaining caps a
session at one hour. And IAM has no sort-key condition key, while the key row
and delivery rows share a tenant partition (ADR-0010), so a tenant role that
may write its partition could rewrite its own `keyArn`.

## Options considered
### Option 1: One broad pipeline role, code filters by tenant
Pros: simplest, no STS call. Cons: filtered; one wrong variable reads across
tenants; the API could read documents it only presigns.
### Option 2: One IAM role per tenant
Pros: enforced, one prefix and key per role. Cons: the role quota (5,000 at
most) is below N-3; onboarding creates eventually consistent IAM resources.
### Option 3: One shared tenant role, ABAC in a session policy
Pros: one role. Cons: the wall is whatever the caller passes, so it is
filtered; 2,048-character cap; every function holds the same reach.
### Option 4: ABAC in the identity policy of one tenant role per function
Pros: enforced, nothing to omit, no per-tenant IAM resource, the asymmetry is
in the roles. Cons: ten roles; an `AssumeRole` per tenant context (600 rps per
account); the tenant id needs a grammar code enforces.

The registry part of the boundary (a tenant role must not rewrite its own
key binding) has four options of its own.
### Option 5: Registry: a second table for bindings
Pros: separates bindings from delivery rows by resource. Cons: splits every
transaction across tables; doubles PITR, streams and policies.
### Option 6: Registry: one table, tenant roles update-only
Tenant roles limited to `UpdateItem` on an attribute allowlist. Pros: keeps
one transaction; enforced for tenant roles. Cons: leaves key-factory code
able to rewrite a binding.
### Option 7: Registry: bind keys by alias
`kms:ResourceAliases` in the key's use statements. Pros: adds a KMS-side
check. Cons: only for `vendor-key` (kept as a seam, §11).
### Option 8: Registry: accept the gap
Pros: nothing to build. Cons: leaves tenant code able to rebind itself.

## Decision
Option 4 and one table update-only (spec §7.0, §7.1). Seven base roles reach
no document: `authoriserRole` (logs only), `apiRole`, `processorRole`,
`keyFactoryRole` (`kms:CreateKey` pinned to `SYMMETRIC_DEFAULT`, `AWS_KMS`,
`ENCRYPT_DECRYPT`, single-Region; `TagResource` only with a `TenantId` request
tag and the tag keys `TenantId`, `tei:stack`; Deny `PutKeyPolicy`,
`CreateGrant`, `UntagResource` and use), `platformRole` (administration
without creation), `sweepRole` (assumes `tenantProcessRole` only) and
`watchRole`. Three tenant roles, `tenantUploadRole`, `tenantProcessRole`,
`tenantPlatformRole`, carry `${aws:PrincipalTag/TenantId}` in every statement
and trust only named base roles, with `ForAllValues:StringEquals aws:TagKeys
= [TenantId]`, `Null aws:RequestTag/TenantId = false` and a `StringNotLike`
guard on `/`, `:`, `=`, `+`, `@`, `.`, space and comma; code enforces
`^[a-z0-9][a-z0-9-]{1,34}$` at the authoriser, the model and the processor.
`RoleSessionName` is `t-<tenantId>-<16-char suffix>`, under 64 characters,
so logs name the tenant. Sessions last 3600 s; a cached one presigns only
with TTL plus 60 s left and starts a run only with T left. In the registry a
tenant role may `UpdateItem`, `ConditionCheckItem`, `GetItem`, `Query` in
`TENANT#${tag}` only, with `ForAllValues:StringEquals dynamodb:Attributes` on
its allowlist and `ReturnValues` at most the updated attributes; no `PutItem`,
`DeleteItem` or `Scan`, so `CreateDelivery` creates its row with `UpdateItem`
and `attribute_not_exists(PK)`; an explicit Deny refuses `dynamodb:*` when
`ForAnyValue:StringEquals dynamodb:Attributes` names `keyArn`, `tier`,
`apiKeyValue` or `keyStatus` (a `ForAllValues` Deny would fire only if every
name were protected). The key row's protected names are chosen so no delivery
row shares them: `keyStatus`, never `status`. `keyFactoryRole` keeps
`PutItem` on `KEY`, `KEYARN#` and `SYSTEM` items with
`attribute_not_exists(keyArn)` in code, so the claim is: tenant-role code
cannot touch a binding (enforced), key-factory code can rewrite one (detected
by the registry watch, ADR-0010).

## Consequences
Easier: a tenant adds no IAM resource; a cross-tenant call fails with an
`AccessDenied`; template tests assert the tag in every tenant statement, the
trust guard and the Deny; a unit test asserts the two row schemas share no
name outside the allowlists; `SimulatePrincipalPolicy` proves the identity
wall alone (§10 step 5). Harder: ten roles to read; an STS round trip per
context, bounded by `inFlight` (ADR-0011); UUID tenant ids (36 characters)
must be mapped; compromised function code can act as any one tenant, visible
in CloudTrail but not prevented; a compromised `keyFactoryRole` can bind a
new tenant to a key it chose. Revisit if IAM gains a regex operator or a
sort-key condition key, or AWS can bind a tag value to a verified source.

Amended 2026-11-06 (ADR-0017): `keyFactoryRole` holds table-wide
`PutItem`, `UpdateItem`, `ConditionCheckItem` and `GetItem`, without the
`keyArn`/`tier` Deny, because the key row and its `KEYARN#` item sit in
different partitions and its `UpdateItem` to `ACTIVE` names `keyArn` in its
condition; the claim above is unchanged, and the stream watch does not
cover delivery rows the factory could also overwrite. Implemented
2026-11-06 otherwise as decided (`src/construct/roles.ts`), with the base
roles' KMS use Deny scoped to `TenantId`-tagged keys (ADR-0013). Sessions
are cached per tenant (`src/shared/tenant-session.ts`), so the
`RoleSessionName` suffix names the delivery or operation that first
assumed the session; the sweep's is always `sweep`. Outside the ten roles
the deployment also has the `ScopeRegistration` custom-resource role
(ADR-0015), the `LogDrain` role (no permissions) and CDK's singleton
provider roles; none is in the pipeline (architecture.md §3).

Amended 2026-11-09 by ADR-0020: the grammar is
`^[A-Za-z0-9][A-Za-z0-9-]{1,34}$`, so tenant-identity's upper-case ULID
tenant ids pass; two ids that differ only by case are two tenants. The
`StringNotLike` trust guard is unchanged. The registry options were split
into named options on 2026-11-09; the decision text is unchanged.

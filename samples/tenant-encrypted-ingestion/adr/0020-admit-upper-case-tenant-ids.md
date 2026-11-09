<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0020: Admit upper-case tenant ids

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR-0003
- Deciders: Dave Roberts (PSA)

## Context
ADR-0003 fixes the tenant id grammar at `^[a-z0-9][a-z0-9-]{1,34}$`,
enforced at the authoriser, the Smithy model and the processor. Its
purpose is to keep `/` and the other IAM-significant characters out of a
session tag, so `ingest/${aws:PrincipalTag/TenantId}/*` never nests one
tenant in another, and to keep `RoleSessionName` under 64 characters.
tenant-identity issues tenant ids as ULIDs: 26 characters of Crockford
base32, upper case only. Every token from it failed the grammar with a
401, so the composed deployment could not work.

## Options considered
### Option 1: Keep lower case and map
Lower-case the claim in the authoriser, or map it through a table. Pros:
the grammar stays as written. Cons: the tenant id in the registry, the
object keys and the session tags no longer equals the id in the token, so
every log and CloudTrail record needs a translation; a table is a lookup
on the hot path and a binding to protect.
### Option 2: Admit upper case
`^[A-Za-z0-9][A-Za-z0-9-]{1,34}$`. Pros: the claim is used as issued; no
mapping; the characters it admits are all safe in a session tag, an S3
prefix, a KMS alias and an API key name. Cons: two ids that differ only by
case become possible, and must not reach one tenant's resources.

## Decision
Option 2. The grammar is `^[A-Za-z0-9][A-Za-z0-9-]{1,34}$`
(`src/shared/tenant-id.ts`, `model/__global.smithy`), and the `StringNotLike`
trust guard of ADR-0003 is unchanged. Two ids that differ only by case are
two distinct tenants everywhere the id is used, and the implementation
relies on every such place comparing case-sensitively: S3 object keys and
prefixes (`ingest/<tenantId>/`, `documents/<tenantId>/`) are
case-sensitive, so are the `${aws:PrincipalTag/TenantId}` resource match
and the `StringEquals` tag conditions on tag values, the DynamoDB key
`TENANT#<tenantId>`, and the deterministic API key name and value
(ADR-0011). The KMS alias is `alias/tenant-<tenantId>-ingestion`
(`src/platform/common.ts`); the code relies on alias names being
case-sensitive, which was not verified against the KMS documentation for
this record. If KMS folded case, the second tenant's `CreateAlias` would
fail with `AlreadyExistsException`, `ensureAlias` would find the alias
pointing at another key and answer 409 `Conflict`, and the tenant would get
no key: it fails closed, never sharing a key, and the `KEYARN#` item
already keeps one key to one tenant. tenant-identity issues ULIDs, upper
case only, so no case-only collision arises from that issuer; a deployer
who brings another issuer (ADR-0019) owns the uniqueness of its
`tenant_id` claim, case included.

## Consequences
Easier: tenant-identity's tokens pass as issued; logs, object keys and
session names carry the same id as the token. Harder: a reader can no
longer assume ids are lower case; an issuer that emits `Acme` and `acme`
for one customer creates two tenants. Revisit if a target store turns out
to fold case, or if the grammar has to admit a character outside
`[A-Za-z0-9-]`.

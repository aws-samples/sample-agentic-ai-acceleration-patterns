<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0013: Scope the base roles' KMS use Deny to tenant-tagged keys

- Status: Accepted
- Date: 2026-11-06
- Deciders: Dave Roberts (PSA)

## Context
The base roles (`keyFactoryRole`, `platformRole`) must never use a tenant
key: they administer keys, and the walls of ADR-0002 and ADR-0003 assume
that only the three tenant roles, through S3, ever call `kms:Decrypt` or
`kms:GenerateDataKey` on one. The specification wrote that as an explicit
Deny of every KMS use action on `*` in each base role's identity policy.

The first deployment (2026-11-05) failed on it. Lambda decrypts a function's
environment variables with `kms:Decrypt` under the function's execution
role, against the AWS managed `aws/lambda` key, before the handler starts.
An explicit Deny on `kms:Decrypt` with `Resource: *` therefore stopped
every function of those roles at init, with no log line, because the
handler never ran. The key-drain custom resource under `platformRole` never
answered CloudFormation, the stack rolled back for an hour on the
custom-resource timeout, and the same Deny blocked the rollback's Delete.
The design decision is how to keep the Deny without denying Lambda its own
key.

## Options considered
### Option 1: Drop the Deny and rely on the absence of an Allow
Pros: nothing to get wrong. Cons: an Allow added later by mistake, or a
grant, would let the role use a tenant key with no second wall; the key
policy statement 4a-i still refuses it, but the identity policy would no
longer say so.
### Option 2: Deny the use actions on every key except the AWS managed `aws/lambda` key
Pros: narrowest possible exception. Cons: the managed key's ARN is
account-specific and discovered at deploy time; a lookup or a
`kms:ResourceAliases` condition on `alias/aws/lambda` adds machinery for
one exception, and other AWS-owned keys a role may legitimately touch
later (SQS, SSM) would each need the same treatment.
### Option 3: Deny the use actions only on keys tagged `TenantId`
Pros: names the thing being protected (a tenant's key, ADR-0001), covers
both tiers because `tenant-key` keys carry the same tag, and leaves every
untagged service key alone; one condition, `Null aws:ResourceTag/TenantId =
false`. Cons: a tenant key that lost its tag would fall outside the Deny;
ADR-0002's statement 5 denies retagging on every key the factory created,
and the integration test asserts the tag on both tiers.

## Decision
Option 3. `denyTenantKeyUse()` in `src/construct/roles.ts` is the one
KMS use Deny the two key-administering base roles (`keyFactoryRole`,
`platformRole`) carry: `kms:Encrypt`, `kms:Decrypt`,
`kms:GenerateDataKey*`, `kms:ReEncrypt*` on `*` with `Null
aws:ResourceTag/TenantId = false`. The administration Denies
(`kms:PutKeyPolicy`, `kms:CreateGrant`, `kms:TagResource`,
`kms:UntagResource`, `kms:CreateKey` where it applies) stay unconditioned,
because no AWS service calls them on a function's behalf. Spec §7.1 names
the condition in both base-role rows.

## Consequences
Easier: every function starts; the Deny still says in the identity policy
what the key policy enforces. A template test asserts that no base role
denies a KMS use action without the tag condition, so the mistake cannot
return unnoticed. Harder: the Deny depends on the tag, so the tag-once rule
of ADR-0002 matters for it too. Lesson recorded for the drain: a custom
resource whose function cannot start cannot answer CloudFormation, and the
stack waits the full custom-resource timeout before it fails; the drain
handler answers inside its own deadline for every other failure. Revisit if
a base role ever needs a tagged key for its own purposes, which none does.

Clarified 2026-11-06: the unconditioned administration Denies listed
above apply as each role needs. `platformRole` denies `kms:CreateKey`,
`TagResource`, `UntagResource`, `PutKeyPolicy` and `CreateGrant`;
`keyFactoryRole` denies `PutKeyPolicy`, `CreateGrant` and `UntagResource`
but not `kms:TagResource`, which it holds conditioned on a `TenantId`
request tag and the tag keys `[TenantId, tei:stack]` to tag a key at
`CreateKey` (ADR-0002 statement 5 stops any later retag).

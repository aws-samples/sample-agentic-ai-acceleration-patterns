<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0002: Bind each key to its tenant's prefix in the key policy, and keep S3 Bucket Keys off

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-3, F-4, F-5, F-7, F-23)
- Revised: 2026-11-05, second security review (G-1, G-3, G-4)

## Context
A per-tenant key (ADR-0001) is only a tenant boundary if it cannot be used on
another tenant's objects. Two failures must be impossible: tenant A's object
encrypted with B's key, and A's key used to encrypt or decrypt anything outside
A's prefixes. The binding has to hold for every caller the key policy does not
name, including vendor administrator roles and a pipeline bug, and at 10,000
tenants (N-3). When S3 calls KMS for SSE-KMS it passes the encryption context
`aws:s3:arn`, which is the object ARN, unless an S3 Bucket Key is enabled on
the bucket or on the request, in which case it is the bucket ARN.

Six KMS and IAM facts shape the policy. A wildcard such as `kms:Create*`
includes `kms:CreateGrant`, and a grant can give any grantee, the granting role
included, `Decrypt` with no `kms:ViaService` and no context condition (F-3).
`CreateKey` with an explicit policy refuses a policy that does not let the
caller call `PutKeyPolicy` later, unless `BypassPolicyLockoutSafetyCheck` is
set (F-4). The account principal in a key policy is not a single person: it
lets every IAM identity policy in the account reach the key, so an
`AdministratorAccess` role can `Decrypt` directly if the account principal
holds use actions (F-5). Several condition keys in one statement are ANDed,
so a Deny written as "unless the principal is X **and** the call is via S3
**and** the context matches" denies only when all three are violated at once:
a direct call by a tenant role, or a call through S3 by another principal, is
not denied (G-3). `aws:PrincipalArn` for an assumed role is the **role** ARN
(with its path), never the `assumed-role` session ARN. And KMS warns that
`kms:TagResource` alone can grant use of a key whose callers are admitted by
a tag condition, which is exactly how the tenant roles reach keys (ADR-0003,
G-1). Realises P-1, P-3, P-8 and §3.1, §6.2, §7.2.

## Options considered
### Option 1: Bucket policy naming each tenant's prefix and key
Pros: one place to read; S3 evaluates it on every request. Cons: one or two
statements per tenant hit the 20 KB bucket policy limit at a few hundred
tenants; every onboarding rewrites a shared policy; it constrains S3 requests,
not the key, so the key can still be used elsewhere through another path; in
the repository's terms the result is a growing list the vendor curates, close
to filtered isolation.
### Option 2: ABAC in the tenant roles' identity policies only
Pros: scales (one policy with `${aws:PrincipalTag/TenantId}`, ADR-0003); no
per-tenant document. Cons: binds the caller, not the key; any principal with a
broader identity policy, an administrator or a mis-scoped role, can still use
A's key on B's prefix; one wall instead of two.
### Option 3: Key policy condition on `kms:EncryptionContext:aws:s3:arn`
Pros: the key itself refuses any object outside
`arn:aws:s3:::<bucket>/ingest/<tenantId>/*` and `.../documents/<tenantId>/*`;
with `kms:ViaService` it is usable only through S3; the policy is written once
per key at `CreateTenantKey`, so nothing shared grows; it is the same use
statement a tenant puts on its own key in the `tenant-key` tier (§7.3). Cons:
requires Bucket Keys off, so every object write and read costs a KMS request
(about $0.03 per 10,000) and counts against the KMS request quota; on its own
it is an Allow, which an identity policy reaching the key through the account
principal can bypass.
### Option 4: Account principal with the default `kms:*`
Pros: the KMS default; IAM administrators can recover any key. Cons: every
identity policy in the account that grants KMS use reaches every tenant's key,
outside S3 and outside the prefix; the binding of Option 3 then holds only for
roles that happen not to have such a policy (F-5).
### Option 5: Account principal for administration only, plus explicit Denies of use and tagging
Pros: an administrator can still manage, disable, schedule deletion and
rewrite the policy, so the key never becomes unmanageable; to use a key
outside the binding, or to change its tenant tag, the administrator must first
call `PutKeyPolicy`, which CloudTrail records and an alarm reports (threat
model M-29). Cons: the account principal remains a residual trust; each deny
statement is one more thing a test must assert, and the use Deny must be
three statements, not one (G-3).
### Option 6: Lockout check satisfied by `kms:PutKeyPolicy` on the creating role, or bypassed
Giving the creating role `kms:PutKeyPolicy` passes the check without a flag
but lets that role later widen the use statement of any key (F-4). Setting
`BypassPolicyLockoutSafetyCheck = true` keeps the permission off the role and
relies on the account principal's administration statement to keep the key
manageable.

## Decision
Option 3 as the first wall, Option 2 as the second (ADR-0003), Option 5 for
the account principal, and the bypass flag of Option 6. Each `vendor-key` key
gets its policy once, at `CreateKey`, from `keyFactoryRole` (ADR-0018) with
`BypassPolicyLockoutSafetyCheck = true` (spec §7.2):

1. **Administration**, explicit actions, no wildcard and no
   `kms:CreateGrant`, split by role: `platformRole` gets `kms:DeleteAlias`,
   `kms:DescribeKey`, `kms:GetKeyRotationStatus`, `kms:RotateKeyOnDemand`,
   `kms:ListResourceTags`, `kms:GetKeyPolicy`, `kms:ScheduleKeyDeletion`,
   `kms:CancelKeyDeletion`; `keyFactoryRole` gets `kms:CreateAlias`,
   `kms:EnableKeyRotation`, `kms:DescribeKey`, `kms:ScheduleKeyDeletion`.
   Neither gets `kms:TagResource` or `kms:UntagResource`: the `TenantId` tag
   is set by `CreateKey` itself (G-1).
2. **Use via S3, bound to the prefix** for `tenantUploadRole`,
   `tenantProcessRole` and `tenantPlatformRole`: `kms:GenerateDataKey` and
   `kms:Decrypt` with `kms:ViaService = s3.<region>.amazonaws.com` and the
   prefix encryption context, plus a separate unconditioned `kms:DescribeKey`
   for the same roles (a direct call carries neither condition key, F-7).
3. **Account administration**: the account principal gets the statement 1
   actions plus `kms:PutKeyPolicy`, and no use action, no `kms:CreateGrant`,
   no `kms:TagResource`.
4. **Deny use to everyone else, as three separate statements** (G-3), each
   denying `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey*`,
   `kms:ReEncrypt*` and `kms:CreateGrant` to `*`:
   4a `ArnNotEquals aws:PrincipalArn` the three tenant **role** ARNs,
   including their path; 4b `StringNotEquals kms:ViaService
   s3.<region>.amazonaws.com`; 4c `StringNotLike
   kms:EncryptionContext:aws:s3:arn` the two prefix patterns. Separate Denies
   are ORed by evaluation, so any one violated condition denies. A single
   Deny with the three conditions ANDed would deny almost nothing.
5. **Deny tagging**: `kms:TagResource` and `kms:UntagResource` to `*`, so a
   key's `TenantId` is the one `CreateKey` wrote, and retagging, which would
   hand the key to another tenant's roles through their tag condition, needs
   a `PutKeyPolicy` first (G-1).

The policy is proved twice. A unit test renders it and runs IAM Access
Analyzer `check-no-new-access` against a baseline that carries the three use
Denies and the tagging Deny, plus assertions on the explicit action lists and
the absence of `kms:CreateGrant` in any Allow. The integration test creates a
**scratch key** with the same policy builder plus one extra Allow of every
use action for `TestProbeRole` (a simulated mistaken edit) and shows that 4a,
4b and 4c each still deny it (§10 step 5). That is the job the Denies
actually do: without the mistaken Allow, a role absent from statement 2 is
already refused for lack of an Allow, so a test against the real key alone
cannot tell whether the Denies exist.

S3 Bucket Keys stay off on the bucket and on every request: the presigned PUT
and the `CopyObject` carry `x-amz-server-side-encryption-bucket-key-enabled:
false`. S3 has **no condition key** for that header (the `PutObject`
condition keys are `s3:x-amz-server-side-encryption`,
`...-aws-kms-key-id`, `s3:if-none-match`, `s3:signatureAge` and others, not
the bucket-key flag), so the bucket policy cannot enforce it and carries no
statement for it (G-4). What enforces it instead: the header is in the
presigned URL's signed headers (ADR-0007), so an uploader cannot flip it; the
bucket default keeps Bucket Keys off; a request that does enable one presents
the bucket ARN as context, which statement 2 does not match and 4c denies, so
it fails closed with a KMS-sourced 403; and the processor rejects any object
that reports `BucketKeyEnabled` (ADR-0008). The bucket policy otherwise keeps
only tenant-neutral and principal-scoped rules (§7.4, ADR-0019).

## Consequences
Easier: each wall is proven on its own, and the Denies are proven against a
mistaken Allow rather than assumed (§10 steps 5 and 6), with the refusing
wall asserted by message; a leaked key ARN cannot be replayed on another
tenant's data; a key cannot change tenants by retagging. Harder: KMS
requests per accepted delivery are four plus one per validator, stated in the
README (P-9, N-2); the account principal stays a residual, named in the
threat model and reduced to "can rewrite the policy, and that is alarmed";
the `PutKeyPolicy` alarm is a deployer action because CloudTrail is
account-level; a consumer that enables Bucket Keys breaks deliveries (fail
closed), so the construct sets them off explicitly, a unit test asserts the
bucket default, and the integration test asserts the KMS-sourced 403 for a
request that sets the header to `true`; the tests need a scratch key and the
test-aid stack (ADR-0014). Revisit if S3 Bucket Keys gain a per-prefix
context, if S3 adds a condition key for the bucket-key header (then add the
bucket-policy Deny), or if KMS offers a way to make a key policy immutable.

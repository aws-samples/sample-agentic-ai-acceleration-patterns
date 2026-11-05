<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0002: Bind each key to its tenant's prefix in the key policy, and keep S3 Bucket Keys off

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-3, F-4, F-5, F-7, F-23)

## Context
A per-tenant key (ADR-0001) is only a tenant boundary if it cannot be used on
another tenant's objects. Two failures must be impossible: tenant A's object
encrypted with B's key, and A's key used to encrypt or decrypt anything outside
A's prefixes. The binding has to hold for every caller the key policy does not
name, including vendor administrator roles and a pipeline bug, and at 10,000
tenants (N-3). When S3 calls KMS for SSE-KMS it passes the encryption context
`aws:s3:arn`, which is the object ARN, unless an S3 Bucket Key is enabled on
the bucket or on the request, in which case it is the bucket ARN.

Three KMS facts shape the policy. A wildcard such as `kms:Create*` includes
`kms:CreateGrant`, and a grant can give any grantee, the granting role
included, `Decrypt` with no `kms:ViaService` and no context condition (F-3).
`CreateKey` with an explicit policy refuses a policy that does not let the
caller call `PutKeyPolicy` later, unless `BypassPolicyLockoutSafetyCheck` is
set (F-4). And the account principal in a key policy is not a single person:
it lets every IAM identity policy in the account reach the key, so an
`AdministratorAccess` role can `Decrypt` directly if the account principal
holds use actions (F-5). Realises P-1, P-3, P-8 and §3.1, §6.2, §7.2.

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
### Option 5: Account principal for administration only, plus an explicit Deny of use
Pros: an administrator can still manage, disable, schedule deletion and
rewrite the policy, so the key never becomes unmanageable; to use a key
outside the binding the administrator must first call `PutKeyPolicy`, which
CloudTrail records and an alarm reports (threat model M-29). Cons: the
account principal remains a residual trust; a deny statement is one more
thing a unit test must assert.
### Option 6: Lockout check satisfied by `kms:PutKeyPolicy` on the creating role, or bypassed
Giving `platformRole` `kms:PutKeyPolicy` passes the check without a flag but
lets that role later widen the use statement of any key (F-4). Setting
`BypassPolicyLockoutSafetyCheck = true` keeps the permission off the role and
relies on the account principal's administration statement to keep the key
manageable.

## Decision
Option 3 as the first wall, Option 2 as the second (ADR-0003), Option 5 for
the account principal, and the bypass flag of Option 6. Each `vendor-key` key
gets a four-statement policy at `CreateKey` with
`BypassPolicyLockoutSafetyCheck = true` (spec §7.2): (1) administration for
`platformRole` with an explicit action list, `kms:CreateAlias`,
`kms:DeleteAlias`, `kms:DescribeKey`, `kms:EnableKeyRotation`,
`kms:GetKeyRotationStatus`, `kms:RotateKeyOnDemand`, `kms:TagResource`,
`kms:UntagResource`, `kms:ListResourceTags`, `kms:GetKeyPolicy`,
`kms:ScheduleKeyDeletion`, `kms:CancelKeyDeletion`, no wildcard and no
`kms:CreateGrant`; (2) use via S3 for `tenantUploadRole`, `tenantProcessRole`
and `tenantPlatformRole`, `kms:GenerateDataKey` and `kms:Decrypt` with
`kms:ViaService = s3.<region>.amazonaws.com` and the prefix encryption
context, plus a separate unconditioned `kms:DescribeKey` for the same roles
(a direct call carries neither condition key, F-7); (3) the account principal
with the statement 1 actions plus `kms:PutKeyPolicy`, and no use action and
no `kms:CreateGrant`; (4) a Deny of `kms:Encrypt`, `kms:Decrypt`,
`kms:GenerateDataKey*`, `kms:ReEncrypt*` and `kms:CreateGrant` to `*` unless
the principal is one of the three tenant roles, the call comes via S3 and the
context matches the prefix. `platformRole`'s identity policy denies
`kms:PutKeyPolicy`, `kms:CreateGrant` and every use action. S3 Bucket Keys
stay off on the bucket and on every request: the presigned PUT and the
`CopyObject` carry `x-amz-server-side-encryption-bucket-key-enabled: false`,
and the bucket policy denies a PUT with it set to `true` (F-23); a per-object
bucket key would replace the object ARN with the bucket ARN, and statement 4
would then refuse a valid delivery. The bucket policy otherwise keeps only
tenant-neutral rules (§7.4).

## Consequences
Easier: the integration test proves the key-policy wall on its own with a
broadly permitted test role (§10 steps 5 and 6) and asserts which wall
refused by message; a leaked key ARN cannot be replayed on another tenant's
data; a unit test asserts the explicit action list, the absence of
`kms:CreateGrant` and of any use action outside statement 2, and the Deny.
Harder: KMS requests per accepted delivery are four plus one per validator,
stated in the README (P-9, N-2); the account principal stays a residual,
named in the threat model and reduced to "can rewrite the policy, and that is
alarmed"; the `PutKeyPolicy` alarm is a deployer action because CloudTrail is
account-level; a consumer that enables Bucket Keys breaks deliveries (fail
closed), so the construct sets them off explicitly and a unit test asserts it.
Revisit if S3 Bucket Keys gain a per-prefix context, or if KMS offers a way to
make a key policy immutable.

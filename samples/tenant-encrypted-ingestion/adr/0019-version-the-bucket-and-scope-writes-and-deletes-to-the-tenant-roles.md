<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0019: Version the bucket and scope writes and deletes to the tenant roles

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
KMS stops a principal outside the binding from **reading** a tenant's
documents (ADR-0002); it does not stop one from **deleting or overwriting**
them, because `DeleteObject` needs no key and a `PutObject` can name any key
the writer may use. Within one account an identity-policy Allow is enough to
reach the bucket, so the bucket policy as first written, with no
principal-scoped statement, let any vendor principal with an identity
`s3:PutObject` or `s3:DeleteObject` on the bucket overwrite or delete landed
documents. Versioning was off, so such a delete was unrecoverable. Inside the
design, `tenantPlatformRole`, reachable from the role the hourly sweep ran
under, could delete every tenant's landed documents one session at a time
(G-11). The threat model named T-14 for the API and the processor but not
this blast radius for the platform path.

Three S3 facts constrain the fix. `aws:PrincipalArn` is the role ARN for an
assumed role, so a bucket policy can name the tenant roles without naming
sessions. Conditional-write enforcement (`s3:if-none-match`) on a prefix makes
a `CopyObject` into that prefix fail, so it can apply to `ingest/` only, not
to `documents/` where the processor copies (ADR-0017). And on a versioned
bucket a plain `DeleteObject` only adds a delete marker; erasing data needs
`DeleteObjectVersion` on every version. Realises P-6, P-7, P-8 and §3.1,
§7.1, §7.4, §10 step 11.

## Options considered
### Option 1: Versioning off, state the unrecoverable-deletion residual, alarm on deletes
Pros: no change to storage cost or offboarding; a CloudWatch metric alarm on
`DeleteObject` volume under `documents/` (from CloudTrail data events or
request metrics) reports a mass delete. Cons: detection, not prevention or
recovery; any principal in the account with an identity S3 Allow can still
delete or overwrite, and a deleted document is gone; the trail would have to
say "enforced" about reads and "filtered" about writes on the same prefix.
### Option 2: Versioning on with a 7-day noncurrent expiry, plus principal-scoped bucket Denies
Pros: the bucket policy denies `s3:PutObject` on `ingest/*` unless
`aws:PrincipalArn` is `tenantUploadRole`, `tenantProcessRole` or
`tenantPlatformRole`; denies `s3:PutObject`, `s3:DeleteObject` and
`s3:DeleteObjectVersion` on `documents/*` unless it is `tenantProcessRole`
or `tenantPlatformRole`; and denies `s3:DeleteObject` on `ingest/*` unless it
is `tenantProcessRole` or `tenantPlatformRole`; so an identity policy
elsewhere in the account can read nothing (KMS) and change nothing (S3) under
the two prefixes. Inside those roles the ABAC wall still limits each session
to one tenant (ADR-0003). Versioning makes a delete or an overwrite by a role
that is allowed recoverable for a week; a lifecycle rule expires noncurrent
versions after 7 days and removes expired delete markers, so storage does not
grow without bound. The sweep moves to `sweepRole`, which assumes only
`tenantProcessRole` and so can never delete from `documents/` (ADR-0003).
Cons: offboarding must delete versions and delete markers too; noncurrent
versions cost storage for 7 days; versioned buckets are slower to empty on
teardown.
### Option 3: S3 Object Lock on `documents/`
Pros: WORM retention; even an administrator cannot delete a locked version
before its retention ends (compliance mode). Cons: Object Lock is a
bucket-level setting that also needs versioning, and it cannot be removed
once on; a locked version cannot be deleted at offboarding, which breaks
"offboarding is total" (P-6) and leaves ciphertext until retention ends;
compliance mode also blocks `cdk destroy` from emptying the bucket, so clean
teardown (N-7) fails; it protects against a threat the sample does not need
to promise (an administrator who can already rewrite key policies).

## Decision
Option 2 (spec §7.4). The bucket has versioning on, a lifecycle rule that
expires noncurrent versions after 7 days and removes expired delete markers,
and the three principal-scoped Denies above, each naming role ARNs (with
their path), never session ARNs. `tenantPlatformRole` holds
`s3:DeleteObjectVersion` on both tenant prefixes for offboarding, and
`DeleteTenantKey` deletes every version and delete marker under both
prefixes (ADR-0006). The `If-None-Match` Deny stays on `ingest/*` only
(ADR-0017); landed documents are protected by the principal scope and by
versioning, not by conditional writes. The sweep runs under `sweepRole`,
which cannot reach `documents/`. Object Lock is not used.

## Consequences
Easier: a principal outside the three tenant roles cannot write or delete
under either prefix, whatever its identity policy says, so writes are
enforced like reads; a deletion or overwrite by an allowed role, a bug in
the processor or the platform function, is recoverable for 7 days from the
noncurrent version; the integration test asserts a principal-scoped 403 for
`TestProbeRole` with every header right (§10 step 5) and `ListObjectVersions`
empty after offboarding (§10 step 11); a template test asserts versioning,
the lifecycle rule and the three Denies. Harder: offboarding deletes
versions too, which doubles the delete calls for every overwritten or deleted
document; noncurrent versions cost storage for up to 7 days, stated in the
README's cost table; a `documents/` object deleted by mistake is gone after
7 days, which is the window a deployer has to notice; a deployer that adds a
downstream writer or a lifecycle role must add its role ARN to the Denies;
`If-None-Match` still protects only `ingest/`, so a `documents/` overwrite by
`tenantProcessRole` or `tenantPlatformRole` is prevented by nothing but code
and recovered by versioning; teardown takes longer because the auto-delete
custom resource must remove every version. Revisit if S3 adds
conditional-write enforcement that does not break `CopyObject`, or if a deployment needs
WORM retention, which then needs its own offboarding story.

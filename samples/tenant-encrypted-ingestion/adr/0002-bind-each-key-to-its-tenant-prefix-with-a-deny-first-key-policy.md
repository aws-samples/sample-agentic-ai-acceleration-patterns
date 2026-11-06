<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0002: Bind each key to its tenant prefix with a deny-first key policy

- Status: Accepted
- Date: 2026-11-05
- Amended by: ADR-0016
- Deciders: Dave Roberts (PSA)

## Context
A per-tenant key (ADR-0001) is a boundary only if it cannot be used on another
tenant's objects, by any caller the key policy does not name, at 10,000
tenants (N-3). For SSE-KMS, S3 passes the object ARN as encryption context
`aws:s3:arn`, unless an S3 Bucket Key is on, when it passes the bucket ARN.
Five facts shape the policy. `kms:Create*` includes `kms:CreateGrant`, with
which a role grants itself `Decrypt` free of every condition. The account
principal lets every identity policy in the account reach the key. Conditions
in one statement are ANDed, so one "unless A and B and C" Deny fires only when
all three fail. `aws:PrincipalArn` of an assumed role is the role ARN with its
path. And `kms:TagResource` can hand a key to whoever a tag condition admits,
which is how the tenant roles reach keys (ADR-0003). Realises P-1, P-3, P-8.

## Options considered
### Option 1: Bucket policy naming each tenant's prefix and key
Pros: one place to read; S3 evaluates it on every request. Cons: the 20 KB
limit is reached at a few hundred tenants; every onboarding rewrites a shared
policy; it constrains S3 requests, not the key, which stays usable on other
paths; a curated list is filtered isolation.
### Option 2: ABAC in the tenant roles' identity policies only
Pros: scales with one policy per role (ADR-0003). Cons: binds the caller, not
the key; an administrator or a mis-scoped role with a broader identity policy
can still use A's key on B's prefix; one wall instead of two.
### Option 3: Key policy conditioned on the encryption context, with Denies
Pros: the key itself refuses any object outside `ingest/<t>/` and
`documents/<t>/`, and with `kms:ViaService` any path but S3; written once per
key, so nothing shared grows; the same use statement a tenant puts on its own
key (ADR-0004); explicit Denies make it hold against every identity policy.
Cons: Bucket Keys must stay off, so every object write and read is a KMS
request; the account principal remains a residual; every Deny needs a test.

## Decision
Option 3, with Option 2 as the second wall (ADR-0003), written once at
`CreateKey` by `keyFactoryRole` with `BypassPolicyLockoutSafetyCheck = true`,
because the creating role holds no `kms:PutKeyPolicy` and statement 3 keeps
the key manageable (spec §7.2). Statement 1 gives administration as explicit
lists, never a wildcard: `platformRole` `DeleteAlias`, `DescribeKey`,
`GetKeyRotationStatus`, `RotateKeyOnDemand`, `ListResourceTags`,
`GetKeyPolicy`, `ScheduleKeyDeletion`, `CancelKeyDeletion`; `keyFactoryRole`
`CreateAlias`, `EnableKeyRotation`, `DescribeKey`, `ScheduleKeyDeletion`.
Statement 2 lets the three tenant roles `GenerateDataKey` and `Decrypt` only
via `s3.<region>.amazonaws.com` with the context on the two tenant prefixes,
plus an unconditioned `DescribeKey`. Statement 2b lets each consumer role
`Decrypt` only, via S3, on `documents/<t>/*` only. Statement 3 gives the
account principal the statement 1 actions plus `PutKeyPolicy`, and no use
action, `CreateGrant` or `TagResource`. The Deny is four statements, because
separate Denies are ORed: 4a-i denies `Encrypt`, `GenerateDataKey*`,
`ReEncrypt*`, `CreateGrant` unless the principal is a tenant role; 4a-ii
denies `Decrypt` unless it is a tenant role or a consumer role (consumers
read, never write); 4b denies every use action outside `kms:ViaService` S3;
4c denies it outside the two prefix contexts. Statement 5 denies
`TagResource` and `UntagResource` to `*`, so no key the factory made can be
retagged to another tenant. Bucket Keys stay off on the bucket and on every
request: the PUT and the `CopyObject` carry
`x-amz-server-side-encryption-bucket-key-enabled: false`; S3 has no condition
key for that header, so instead it is signed (ADR-0006), a bucket key fails
closed on 4c, and the processor rejects any object reporting
`BucketKeyEnabled` (ADR-0007). The bucket repeats the binding from the
resource side (§7.4): `PutObject` on `ingest/*` is denied unless the principal
is a tenant role and on `documents/*` unless `tenantProcessRole`; deletes are
denied but to `tenantProcessRole` (`ingest/*` only), `tenantPlatformRole` and
the teardown role (ADR-0012); versioning keeps an allowed overwrite or delete
recoverable for 7 days, where Object Lock would break offboarding (ADR-0005)
and teardown. The consumer set is fixed at key creation;
changing it, or reading as an administrator, takes `PutKeyPolicy`, which a
CloudTrail metric filter alarms on: that is the stated residual.

## Consequences
Easier: a leaked key ARN cannot be replayed on another tenant's data; a key
cannot change tenants by retagging; each Deny is proven alone against a
scratch key carrying a mistaken Allow, since without that Allow a missing
Deny is invisible (§10 step 5), and a unit test runs IAM Access Analyzer
`check-no-new-access` against a baseline holding every Deny. Harder: one KMS
request per object write and read; adding a consumer is an alarmed
`PutKeyPolicy` per key, a bulk operation the README documents and the sample
does not build; the `PutKeyPolicy` alarm needs an account trail, a deployer
action; a spike (2026-11-05) showed that statement 5 does not block
`CreateKey`'s own tags and does block a later retag, and that
`aws:ResourceTag` is populated from the request tags at `CreateKey`, so
the factory's tagging Allow conditions on `aws:RequestTag`, never on
`aws:ResourceTag`. Revisit if S3 adds a condition key for the
bucket-key header, if Bucket Keys gain a per-prefix context, or if KMS offers
an immutable key policy. Implemented 2026-11-06 (ADR-0016): the
`PutKeyPolicy` alarm is an EventBridge rule on the CloudTrail event, targeting an SQS audit queue and
alarmed on the rule's `TriggeredRules` metric, not a CloudWatch Logs metric
filter; the account trail must deliver management events to EventBridge.

Amended 2026-11-06 (ADR-0016): the alarm is the EventBridge rule and audit
queue above, not a CloudWatch Logs metric filter. Not implemented
2026-11-06: the unit test running IAM Access Analyzer `check-no-new-access`
against a baseline holding every Deny does not exist; it calls an AWS API,
which the unit tests do not. The control is the template tests in
`test/key-policy.test.ts` (every statement by Sid, the four use Denies as
separate statements, no `kms:Create*` or `CreateGrant` Allow, tagging
denied to everyone) plus §10 step 5 against the deployed scratch key; the
gap is in architecture.md §14 and threat model M-17.

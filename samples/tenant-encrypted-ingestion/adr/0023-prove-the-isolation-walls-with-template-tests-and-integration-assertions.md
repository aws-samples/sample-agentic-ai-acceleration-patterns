<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0023: Prove the isolation walls with template tests and integration assertions

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR-0002
- Deciders: Dave Roberts (PSA)

## Context
Three verification promises made before implementation did not survive
contact with the deployed stack. ADR-0002's Consequences promise a unit
test that runs IAM Access Analyzer `check-no-new-access` against a baseline
holding every Deny of the key policy; unit tests call no AWS API, and the
test was never built. Integration step 5 was to prove each wall alone,
including the principal-scoped bucket-policy Deny, by a PUT naming tenant
A's key; S3 asks KMS for the data key before it evaluates the bucket
policy, so that PUT is answered by A's key policy and the bucket Deny is
never reached (verified 2026-11-06). And step 10 compared the processor's
metered `kmsRequests` with the CloudTrail KMS events of the processor
session: one accepted delivery with two validators metered 6 against 19
events, a breakdown not yet done (architecture.md). The walls still need
proof; the question is which evidence carries it.

## Options considered
### Option 1: IAM Access Analyzer policy checks
`check-no-new-access` against a baseline policy, run as a unit test or a
build step. Pros: a formal check that no edit widens the key policy. Cons:
an AWS API call with credentials in every build; it proves the policy
document, not what S3 and KMS do together at request time; the baseline is
one more file to keep in step with every statement.
### Option 2: CloudTrail counts as acceptance checks
Assert per-tenant KMS request counts and refusals from CloudTrail. Pros:
the record the account itself keeps. Cons: delivery lags by minutes; the
count includes the probe and S3's own retries, so it does not match the
meter; a flaky count would fail a run whose walls held.
### Option 3: Template tests plus live assertions per wall
Unit tests on the synthesised policies, statement by statement, and
integration step 5 against the deployed stack and a scratch key, each wall
alone. Pros: the template tests run offline in every build; step 5
observes the refusal S3 and KMS actually return. Cons: no formal
no-new-access proof; a policy edit that keeps every asserted statement and
adds a broad one is caught only if a test names it.

## Decision
Option 3. `test/key-policy.test.ts` asserts every statement of the
`vendor-key` policy by Sid, the use Denies as separate statements, no
`kms:Create*` or `CreateGrant` Allow and tagging denied to everyone, and
the construct tests assert each role and bucket statement; the Access
Analyzer test is not built. Integration step 5 proves each Deny alone
against the scratch key carrying a mistaken Allow, and on the ingestion
bucket isolates the principal-scoped bucket Deny with the AWS managed
`aws/s3` key, which the probe role may use: a PUT naming A's key is
expected to fail at KMS, and a PUT under `aws/s3` to fail with an S3
`AccessDenied` that names no KMS cause (`test/integ.ingestion.ts`). The
step 10 comparison of `kmsRequests` with CloudTrail is informational: the
driver records both numbers as a note and asserts only that the processor
line carries `kmsRequests`.

## Consequences
Easier: the policy assertions run in every build without credentials;
each wall's refusal is observed on the deployed stack; a CloudTrail lag no
longer fails a run. Harder: a widening that the template tests do not name
can pass the build; the KMS attribution in the per-tenant meter stays
unreconciled with CloudTrail until the 19 events are broken down. Revisit
if the build gains AWS credentials (then add the Access Analyzer check), if
S3 changes the order in which it consults KMS and the bucket policy, or
once the `kmsRequests` accounting matches CloudTrail (then assert it).

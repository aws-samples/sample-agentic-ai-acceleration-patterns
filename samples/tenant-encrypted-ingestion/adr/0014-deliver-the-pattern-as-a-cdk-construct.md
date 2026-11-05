<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0014: Deliver the pattern as the CDK construct TenantEncryptedIngestion, with a thin demo stack

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-6, F-17, F-27)
- Revised: 2026-11-05, second security review (G-1, G-3, G-9, G-10, G-11)

## Context
The sample is a pool with per-tenant keys (§1.1). A tenant that needs its own
bucket or pipeline, or a vendor that wants the pattern inside an existing
application, must be able to take it into its own app without copying a
stack. The repository standard makes a construct the unit of reuse
(`docs/sample-standard.md` §4.5) and asks for cdk-nag on the app and clean
teardown (§4.3, §4.4): Lambda's implicit log groups survive `cdk destroy`, and
an access-log target bucket cannot use SSE-KMS (F-27). The demo still needs
to wire the pattern to `tenant-identity` and publish what other samples
consume, including the role ARNs a `tenant-key` key policy must trust (F-6).

The second review added two things. The roles split further (`keyFactoryRole`
and `sweepRole` beside `platformRole`, ADR-0003, ADR-0018) and the access-log
bucket gained a policy that names its reader (G-10), so a consumer composing
the construct needs handles on them, for alarms, permission boundaries and
reader wiring. And the integration test's `TestProbeRole`, as first
specified with `kms:*` on `*` and `s3:*` on the bucket, was a skeleton key:
through the account principal's administration statement it could rewrite any
key policy, schedule any key for deletion and remove the bucket policy, so a
test-aid stack deployed into a shared account, or one that survived a failed
destroy, would defeat every wall the sample claims (G-9). Realises §1.1,
§3.3, §3.4, §6.2, §6.3, §10, N-7 and standard §4.3, §4.4, §4.5.

## Options considered
### Option 1: A stack only
Pros: least code; `cdk deploy` and done. Cons: reuse means forking; a silo
deployment means a second copy of the stack with edits; the stack's
dependencies (issuer, parameters) are baked in.
### Option 2: A construct, plus a thin demo stack
Pros: a consumer instantiates `TenantEncryptedIngestion` once per pool or once
per siloed tenant; dependencies arrive as props; options are typed props with
secure defaults; the demo stack is only wiring. Cons: a props type and its
validation to maintain; read-only properties instead of stack outputs.

## Decision
Option 2. `TenantEncryptedIngestion` is exported with its props from
`src/index.ts`. It takes the issuer as props and creates none of its
dependencies. Optional behaviour is off unless set: `allowTenantKeys` false,
`perTenantMetrics` false, `validators` empty, `onValidatorError` `hold`,
`keyRotation` true, `keyDeletionWindowDays` 7, `dropRetentionDays` 1,
`uploadUrlTtlSeconds` 900 (at most 3300), `validatorObjectUrlTtlSeconds`
300, `maxInFlightPerTenant` 100, `tenantThrottle` 20/40,
`accessLogReaderRole` unset (then only the account principal can read the
access logs). The constructor validates every prop (ranges, non-empty
`allowedClientIds`, validator names unique and `[a-z0-9-]{1,32}`, the chain
fitting the processor timeout) and fails synth with a message that names the
prop. Every function gets an explicit `LogGroup` with `logRetention` and
`RemovalPolicy.DESTROY`; the bucket (versioned, ADR-0019), the separate
SSE-S3 access-log bucket (auto-delete objects) and the table are `DESTROY`;
the three queues are SSE-SQS and the EventBridge target has its own DLQ. The
construct carries its own `NagSuppressions` with reasons and applies no
aspect; `src/main.ts` applies the cdk-nag `AwsSolutionsChecks` aspect to the
demo app (F-27).

It exposes `bucket`, `accessLogBucket`, `apiUrl`, `eventBus`,
`registryTable`, `tenantRoles` (`{ upload, process, platform }`, the three
roles a `tenant-key` key policy must trust), `platformRole`,
`keyFactoryRole` and `sweepRole` (spec §3.4). The demo stack in
`src/main.ts` reads its context, fails fast when the `identityParams` prefix
is missing, wires the shipped `examples/validator-pdf-pages`, and publishes
`apiUrl`, `bucketName`, `tenantRoleArns` and `eventBusArn` under
`/application-plane/shared/ingestion/`. The construct writes no parameter
itself.

The integration test's **test-aid stack** is not part of the construct and
is narrowed so it can never be a skeleton key (G-9, spec §10).
`TestProbeRole` holds **use** actions only, `kms:Encrypt`, `kms:Decrypt`,
`kms:GenerateDataKey*`, `kms:ReEncrypt*`, `kms:DescribeKey` and
`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on the bucket, with an
explicit Deny of `kms:PutKeyPolicy`, `kms:CreateGrant`,
`kms:ScheduleKeyDeletion`, `kms:TagResource`, `kms:UntagResource`,
`s3:PutBucketPolicy`, `s3:DeleteBucketPolicy` and `s3:PutBucketEncryption`;
a denial it meets can then only come from a key policy or a bucket policy. It
is trusted only by the test runner's role, for one hour. `scripts/integ.sh`
refuses to deploy the test-aid stack unless the account carries the
`tei:test-account` tag, and the teardown check lists it. The stack also
creates the scratch key with the §7.2 policy builder plus one mistaken Allow
for `TestProbeRole`, which proves the three use Denies (ADR-0002, G-3).

## Consequences
Easier: siloing a tenant is a second construct instance; unit tests synthesise
the construct in a bare stack once per option combination the spec promises,
and template tests assert each N-7 item (explicit log groups with `DESTROY`,
SSE-SQS, the access-log bucket's encryption, removal policy and reader Deny,
the multipart abort rule, the target DLQ, bucket versioning and its
noncurrent expiry); a consumer can attach alarms or boundaries to every
base role it can see; the extraction sample and the agentic-runtime-isolation
tenant role wire to the published parameters; the test-aid stack cannot
weaken a wall even if it is left behind. Harder: every new option is a prop
with a default, a validation rule and a test; more read-only properties to
keep stable; a tenant's `keyArn` is not a shared parameter, so consumers call
`GetTenantKey` or read the `Delivery*` event; a consumer app that uses the
construct must apply cdk-nag itself; a test account must be tagged before the
integration test runs, which the README states. Revisit if the pattern needs
to span stacks, for example a bucket owned elsewhere.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0004: Offer two key tiers and fail closed through an S3 probe

- Status: Accepted
- Date: 2026-11-05
- Amended by: ADR-0016
- Deciders: Dave Roberts (PSA)

## Context
Most tenants want encryption without running anything; some, often regulated,
want to hold the key and withdraw it at any time (spec §1.3). A tenant-owned
key lives in another account, so the vendor must admit it safely and must
fail closed when it disappears. Three facts constrain the check. The key
policy requires `kms:ViaService` S3 (ADR-0002), so a direct `Encrypt` or
`Decrypt` probe is denied for every key, healthy or not. `DescribeKey` cannot
tell a removed use statement from a healthy key. And S3 reports a KMS
key-policy denial as a plain `AccessDenied`, the same code as a broken bucket
policy or identity policy. A missing key is not a corrupt file, and a
pipeline fault must never stop a healthy tenant. Realises P-4, P-5.

## Options considered
### Option 1: `vendor-key` only
Pros: one key lifecycle, nothing cross-account. Cons: no tenant control over
revocation; tenants that require their own key cannot onboard.
### Option 2: Both tiers, classified on KMS error codes plus `DescribeKey`
Pros: cheap. Cons: S3 hides the KMS cause behind `AccessDenied`, so codes
alone either miss a revocation or mark a healthy tenant revoked on a pipeline
bug; `DescribeKey` misses a removed use statement and flaps on recovery.
### Option 3: Both tiers, every 403 confirmed by a probe through S3
Pros: the probe (`PutObject`, `GetObject`, `DeleteObjectVersion` of
`ingest/<t>/_probe/<ulid>` under the same tenant session) exercises exactly
the path the pipeline uses, so disabled, deleted, pending deletion and a
removed use statement all show, and a healthy key with a broken pipeline does
not; the same probe admits a key at onboarding. Cons: three S3 and a few KMS
requests per check; the exact error shapes are pinned by the integration test.

## Decision
Option 3: the tier is a tenant attribute; only `CreateTenantKey` and
`DeleteTenantKey` branch, and `RotateTenantKey` is `UnsupportedInTier` for
`tenant-key` (P-4). `CreateTenantKey`
stores the canonical `DescribeKey().KeyMetadata.Arn`, rejecting an alias
ARN, a bare id, another Region's key and, for `tenant-key`, any ARN whose
account is the vendor's own (422). The `tenant-key` tag check is implicit:
`DescribeKey` returns no tags, but it runs under a `tenantPlatformRole`
session for `<t>`, whose identity policy reaches only keys tagged
`TenantId=<t>`, so being admitted proves the tag; the key must be
`SYMMETRIC_DEFAULT`, enabled and single-Region in the bucket's Region, then
pass the probe, and only then is the row `ACTIVE`. A `KEYARN#<keyArn>` item
is written in the same transaction for both tiers, so one key never serves
two tenants. In the pipeline, on any 403 or `AccessDenied` from S3 at steps 3
to 8 the processor runs the probe; a failure whose code or message names
`kms:` sets the delivery `KEY_UNAVAILABLE`, the key row `keyStatus =
REVOKED` (by `processorRole`), deletes the drop version, publishes
`DeliveryKeyUnavailable` and deletes the message, so nothing retries into the
DLQ; a probe success means the fault is the pipeline's own, which is thrown
and never classified by code alone. `CreateDelivery` answers 409 while the
key is `REVOKED`; `GetTenantKey` and the hourly sweep re-probe and restore
`ACTIVE` only on success. `aws:ResourceTag/TenantId` evaluates on a key in
another account: undocumented, but verified by spike on 2026-11-05 with a
second account (allowed for the matching tenant session, refused for
another, on `DescribeKey` and through S3). §10 step 1 repeats it; the
fallback, identity policies that list the registered `keyArn`s, stays
documented.

## Consequences
Easier: one pipeline, one API and one data model for both tiers; a tenant
withdrawing its key stops within one delivery without an operator; a broken
deployment never marks tenants revoked, which a unit test with a succeeding
probe asserts. Harder: `tenant-key` onboarding is a key, a tag and a README
policy template the tenant applies verbatim (§7.3), and KMS tag and policy
changes take up to five minutes; the probe writes and deletes an object under
`_probe/`, whose event the processor skips at step 0; `tenant-key` requests count against
the vendor's KMS quota. Revisit if S3 surfaces the KMS cause in its error, if
KMS documents cross-account `aws:ResourceTag` (drop the fallback), or if a
third tier (the sealed drop, §11) is built.

Amended 2026-11-06 (ADR-0016): the probe also runs on any S3 error whose
code or message names KMS, because S3 surfaces a disabled key and a key
pending deletion as 400, not 403; the probe still decides. Implemented
2026-11-06 (`src/processor/probe.ts`, `src/shared/errors.ts`,
`src/shared/probe.ts`); §10 step 8 saw `KMS.DisabledException` and a
removed use statement both set `REVOKED` with the DLQ unchanged, and
`CreateDelivery` answered 409 `TenantKeyUnavailable` while `REVOKED`.

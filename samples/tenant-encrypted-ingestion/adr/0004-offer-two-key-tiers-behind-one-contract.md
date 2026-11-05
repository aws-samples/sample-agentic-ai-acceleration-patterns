<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0004: Offer two key tiers, vendor-key and tenant-key, behind one contract

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
Some tenants want the vendor to handle keys entirely; regulated tenants want
to own the key in their own AWS account and be able to revoke the vendor's
use of it at any time. Both must ride the same bucket, pipeline and data model,
or the pipeline grows a branch per tier and the isolation proof doubles
(§10). Realises P-4, P-5 and §1.3, §3.3 (`allowTenantKeys`), §5.1, §6.1.

## Options considered
### Option 1: `vendor-key` only
Pros: one key lifecycle; nothing to verify across accounts. Cons: no tenant
control over revocation; tenants that require their own key cannot onboard.
### Option 2: `tenant-key` only
Pros: tenants hold the kill switch; the vendor pays no key cost. Cons: every
tenant needs an AWS account and onboarding steps; excludes most tenants.
### Option 3: Both tiers behind one contract
Pros: the tier is a tenant attribute; the pipeline, API and data model are
identical; only `CreateTenantKey` and `DeleteTenantKey` branch. Cons: a
cross-account trust path to verify and to fail closed on (ADR-0005); two
offboarding behaviours.
### Option 4: A third tier now, the sealed drop
Pros: S3 never sees plaintext. Cons: tenant tooling, an envelope format, and a
different processor path, which breaks "one contract" (ADR-0001 Option 4).

## Decision
Option 3. `vendor-key`: the vendor creates the key with the §7.1 policy, alias,
`TenantId` tag and automatic rotation. `tenant-key`: the tenant creates a
symmetric key in its own account, tags it `TenantId=<tenantId>`, and grants the
construct's `ingestionRole` `DescribeKey`, `GenerateDataKey` and `Decrypt` via
S3 with the prefix encryption-context condition; the vendor session reaches it
through `aws:ResourceTag/TenantId` (ADR-0003), so both sides must agree for a
call to succeed. `CreateTenantKey` probes the key under a tenant-scoped session
(`DescribeKey`, `GenerateDataKey` with a probe context, `Decrypt`), requires
`KeySpec SYMMETRIC_DEFAULT` and the `TenantId` tag, and writes a
`KEYARN#<keyArn>` uniqueness item with the key row so one key never serves
two tenants (threat model M-22), before the
row goes `ACTIVE`, returning 422 `KeyNotUsable` on failure. `RotateTenantKey`
returns 400 `UnsupportedInTier` for `tenant-key`, since rotation is the
tenant's. `allowTenantKeys` is off by default (`UnsupportedInDeployment`),
because the tier opens a cross-account trust the deployer should choose. The
sealed drop stays a seam (§11).

## Consequences
Easier: a consumer sees one `keyArn` per tenant; the README comparison table
(§1.3) is the whole story. Harder: a tenant can revoke at any time, so
revocation is a normal state (`REVOKED`, ADR-0005) not an incident.
Open risk: the integration test stands in for the tenant account with a second
key in the same account (§10 step 1), so `aws:ResourceTag/TenantId` on a key in
another account is evaluated only same-account. The README states this, and a
cross-account run is a follow-up before the tier is called proven. Revisit if
that run shows the resource-tag condition does not apply cross-account; the
fallback is a session policy that names the registered `keyArn`.

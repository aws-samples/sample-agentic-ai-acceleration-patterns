<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0004: Offer two key tiers, vendor-key and tenant-key, behind one contract

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-6, F-7, F-22, F-30b)
- Revised: 2026-11-05, second security review (G-14, G-15)

## Context
Some tenants want the vendor to handle keys entirely; regulated tenants want
to own the key in their own AWS account and be able to revoke the vendor's
use of it at any time. Both must ride the same bucket, pipeline and data model,
or the pipeline grows a branch per tier and the isolation proof doubles
(§10). A tenant-owned key is reached cross-account, so the tenant's key policy
must trust exactly the vendor roles whose sessions call S3 (F-6), and every
use statement requires `kms:ViaService = s3`, so a direct KMS call from the
vendor can never prove the key works (F-7).

Three more facts bear on registration. A key can be named several ways (key
id, key ARN, alias name, alias ARN), and S3 reports the key ARN form in
`HeadObject`; a registry value in another form gives a second `KEYARN#` item
for one key, so one key could serve two tenants, and makes every delivery fail
the processor's key check (G-14). `DescribeKey` returns no tags, and the §7.3
template grants no `kms:ListResourceTags`, so the vendor cannot read the
`TenantId` tag of a tenant-owned key (G-15). And KMS tag changes take up to
five minutes to affect authorisation. Realises P-4, P-5 and §1.3, §3.3
(`allowTenantKeys`), §5.1, §6.1, §6.3, §7.3.

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
Option 3. `vendor-key`: `keyFactoryRole` creates the key with the §7.2 policy
(ADR-0002, ADR-0018), alias, the `TenantId` tag set at `CreateKey`, and
automatic rotation. `tenant-key`: the tenant creates a `SYMMETRIC_DEFAULT`,
single-Region key in its own account, in the bucket's Region, tags it
`TenantId=<tenantId>`, and puts the §7.3 template on it: use via S3
(`kms:GenerateDataKey`, `kms:Decrypt` with `kms:ViaService` and the prefix
encryption context) and an unconditioned `kms:DescribeKey` for the three
tenant roles `tenantUploadRole`, `tenantProcessRole` and
`tenantPlatformRole`, published as `tenantRoleArns` (§6.3), never a grant.
The vendor's identity policy reaches the key through
`aws:ResourceTag/TenantId` (ADR-0003), so both sides must agree for a call
to succeed.

`CreateTenantKey` for `tenant-key`, under a `tenantPlatformRole` session for
the path's `tenantId`:

1. **Canonicalise.** Call `DescribeKey` and take `KeyMetadata.Arn` as the
   only value ever stored or compared. Reject an alias ARN, an alias name or a
   bare key id in the request, and a key whose Region differs from the
   bucket's (G-14). The response must also show `KeySpec SYMMETRIC_DEFAULT`,
   `Enabled` and single-Region.
2. **Tag check, implicitly.** The tag is never read from the response: that
   the session for `<tenantId>` is admitted to `DescribeKey` and to the probe
   at all is the check, because its identity policy requires
   `aws:ResourceTag/TenantId = <tenantId>` (F-30b, G-15). A key missing the
   tag or tagged for another tenant is refused by IAM and reported as 422
   `KeyNotUsable`.
3. **Probe through S3**, because a direct `GenerateDataKey`/`Decrypt` carries
   no `kms:ViaService` and is refused by the template (F-7): `PutObject`,
   `HeadObject`, `GetObject` and `DeleteObject` of
   `ingest/<tenantId>/_probe/<ulid>` with the key, under the same session.
   The processor drops events for `_probe/` keys.
4. **Bind.** Write the key row and a `KEYARN#<canonical keyArn>` uniqueness
   item in one transaction, so one key never serves two tenants; return 422
   `KeyNotUsable` with the KMS error when the probe fails, 409 when a row or
   the `KEYARN#` item exists.

`RotateTenantKey` returns 400 `UnsupportedInTier` for `tenant-key`, since
rotation is the tenant's. `allowTenantKeys` is off by default
(`UnsupportedInDeployment`), because the tier opens a cross-account trust the
deployer should choose. The sealed drop stays a seam (§11).

## Consequences
Easier: a consumer sees one `keyArn` per tenant, always in ARN form, and the
processor's `HeadObject` comparison is a string equality; the README
comparison table (§1.3) is the whole story; the probe proves the exact path
the pipeline will use. Harder: a tenant can revoke at any time, so revocation
is a normal state (`REVOKED`, ADR-0005) not an incident; the probe costs four
S3 requests and a few KMS requests per onboarding (N-4 budgets 10 s); KMS
throttles the account that makes the request, so `tenant-key` traffic
consumes the **vendor's** KMS request quota, not the tenant's (F-22, N-2); a
tenant that later trusts a downstream consumer role (§6.4) must extend its
own key policy; an implementer looking for a tag field in `DescribeKey` will
not find one, so the README states the implicit check in one sentence; a
tenant that tags its key and registers it straight away may see a 422 for up
to five minutes while the tag propagates, and the README tells the tenant to
retry. Open risk: AWS documentation does not show whether a vendor-side
`aws:ResourceTag/TenantId` condition evaluates against a key in another
account. The integration test creates the `tenant-key` key in the account
named by the `tenantKeyAccount` context when set; without it the key is in
the test account and the README states the cross-account claim is unproven.
Revisit if that run shows the condition does not apply cross-account; the
fallback is a tenant-role identity policy that names the registered `keyArn`
list instead of the tag (and then an explicit, readable tag check through
`kms:ListResourceTags` in the template).

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0003: Run every tenant-scoped call under an ABAC session assumed from asymmetric base roles

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
The API presigns uploads and writes registry rows; the processor reads the
drop, writes the landed prefix and updates rows; a key-management path creates
and deletes keys. All of them act for one tenant at a time, chosen from a
verified source (§7.3). A bug that picks the wrong tenant must be refused by
AWS, not caught by code (P-2), and no single role should hold everything the
pipeline can do (P-8). The design must hold at 10,000 tenants (N-3).
Realises P-2, P-7, P-8 and §3.1, §7.2, §7.3.

## Options considered
### Option 1: One broad pipeline role, code filters by tenant
Pros: simplest; no STS call per request. Cons: filtered isolation; the role
reaches every tenant's prefix, key and partition, so one wrong variable or a
compromised dependency reads across tenants; the API could read documents it
only needs to presign.
### Option 2: One IAM role per tenant
Pros: enforced; each role names one prefix and one key. Cons: the IAM role
quota (1,000 per account by default, 5,000 at most) caps the tenant count
below N-3; onboarding creates IAM resources, which is slow and eventually
consistent; thousands of near-identical policies to audit.
### Option 3: ABAC session with a `TenantId` session tag
Pros: enforced; one `tenantRole` and one session policy written once, with
`${aws:PrincipalTag/TenantId}` in the S3 resources
(`ingest/` and `documents/`), `dynamodb:LeadingKeys` on
`TENANT#${aws:PrincipalTag/TenantId}`, and `aws:ResourceTag/TenantId` plus
`kms:ViaService = s3.<region>.amazonaws.com` on keys; no per-tenant IAM
resource; the trust policy allows `sts:TagSession` only for the key `TenantId`
and only from the function roles. Cons: one `AssumeRole` per tenant context
(STS quota 600 requests per second per account and Region, shared with
everything else in the account); session tags are limited to 50 and a packed
size; ABAC policies are harder to read than ARNs.

## Decision
Option 3. It is the only option that is enforced and scales past the IAM role
quota, and it keeps a single policy that the integration test can attack
(§10 steps 5 and 6). The base roles are asymmetric and reach no tenant object
on their own: the API role may assume `tenantRole` and presign but holds no
`s3:GetObject`; the processor role may assume `tenantRole` but cannot create or
delete keys; the key-management role holds KMS administration and no S3
permission. The tenant id that goes into the tag comes only from the verified
token, the presigner-fixed object key, or the IAM-authenticated platform path.

## Consequences
Easier: adding a tenant adds no IAM resource; a cross-tenant call fails at S3,
DynamoDB or KMS with an `AccessDenied` that names the wall. Harder: every
tenant-scoped request pays an STS round trip (N-1 budgets one); at high rates
the processor caches sessions per tenant within their lifetime, and the STS
quota is named in the README. The resource-tag condition is what makes the
`tenant-key` tier work cross-account (ADR-0004). Revisit if STS throttling
appears under N-2 load.

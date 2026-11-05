<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0002: Bind each key to its tenant's prefix in the key policy, and keep S3 Bucket Keys off

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
A per-tenant key (ADR-0001) is only a tenant boundary if it cannot be used on
another tenant's objects. Two failures must be impossible: tenant A's object
encrypted with B's key, and A's key used to encrypt or decrypt anything outside
A's prefixes. The binding has to hold for every caller, including vendor
administrators and a pipeline bug, and at 10,000 tenants (N-3). When S3 calls
KMS for SSE-KMS it passes the encryption context `aws:s3:arn`, which is the
object ARN, unless an S3 Bucket Key is enabled, in which case it is the bucket
ARN. Realises P-1, P-3 and §3.1, §7.1, §6.2.

## Options considered
### Option 1: Bucket policy naming each tenant's prefix and key
Pros: one place to read; S3 evaluates it on every request. Cons: one or two
statements per tenant hit the 20 KB bucket policy limit at a few hundred
tenants; every onboarding rewrites a shared policy; it constrains S3 requests,
not the key, so the key can still be used elsewhere through another path; in
the repository's terms the result is a growing list the vendor curates, close
to filtered isolation.
### Option 2: IAM session policy only
Pros: scales (one policy with `${aws:PrincipalTag/TenantId}`, ADR-0003); no
per-tenant document. Cons: binds the caller, not the key; any principal with a
broader policy, an administrator or a mis-scoped role, can still use A's key
on B's prefix; one wall instead of two.
### Option 3: Key policy condition on `kms:EncryptionContext:aws:s3:arn`
Pros: the key itself refuses any object outside
`arn:aws:s3:::<bucket>/ingest/<tenantId>/*` and `.../documents/<tenantId>/*`,
whoever asks; with `kms:ViaService` it is usable only through S3; the policy
is written once per key at `CreateTenantKey`, so nothing shared grows; it is
the same statement a tenant puts on its own key in the `tenant-key` tier
(§6.1). Cons: requires Bucket Keys off, so every object write and read costs a
KMS request (about $0.03 per 10,000) and counts against the KMS request
quota; the account root keeps `kms:*` because KMS requires a manageable key.

## Decision
Option 3, combined with Option 2 as the second wall. The key policy is the
only place where the binding holds independently of who the caller is, and it
costs nothing to scale because each key carries its own policy. S3 Bucket Keys
stay off on the bucket, since a bucket key replaces the object ARN in the
context with the bucket ARN and statement 2 of §7.1 could no longer see the
prefix. The bucket policy keeps only tenant-neutral rules: TLS only, SSE-KMS
only.

The administration statement grants no `kms:PutKeyPolicy`: the policy is
written once at `CreateKey`, so the key-management role cannot later widen
the use statement on an existing key, and only the account root can
(threat model M-28).

## Consequences
Easier: the integration test can prove both directions (§10 step 5) and assert
which wall refused; a leaked key cannot be replayed on another tenant's data.
Harder: the KMS request cost per delivery is three requests, stated in the
README (P-9, N-2); root remains a residual trust named in the threat model; a
consumer that enables Bucket Keys on the bucket silently breaks the binding,
so the construct sets it off explicitly and a unit test asserts it. Revisit if
S3 Bucket Keys gain a per-prefix context.

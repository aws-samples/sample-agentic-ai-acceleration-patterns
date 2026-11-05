<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0001: Encrypt server-side with SSE-KMS and one KMS key per tenant

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-2, F-5, F-22, F-25)

## Context
Tenants drop their most sensitive documents into one shared bucket that one
pipeline reads (spec §1, §1.1). Isolation has to hold at rest, has to survive a
pipeline bug, and has to end with a tenant's documents unreadable when it
leaves. The pattern that prompted the sample, a field engagement, solved this
with an OpenPGP drop: each tenant encrypts files with a vendor-issued PGP key
before upload. What that gives (one key per tenant, rotation, revocation, a
blast radius of one tenant) is the requirement; the question is which
mechanism delivers it with the least tenant-side tooling and the most
enforcement by AWS rather than by code. The claim has to be stated precisely:
"enforced" must say which callers AWS refuses and which it cannot (F-2).
Realises P-1, P-2, P-3, P-6 and §1, §1.2, §3.1, §6.2, §7.2.

## Options considered
### Option 1: OpenPGP drop, one PGP key pair per tenant
Pros: the drop is never plaintext outside the tenant; familiar to tenants that
already exchange files by PGP. Cons: the vendor runs key generation, storage,
rotation and revocation itself, plus a third-party crypto library in the
pipeline; every tenant needs PGP tooling; the private keys live in a secret
store the pipeline reads broadly, so the boundary is filtered by code, not
enforced; offboarding means deleting a secret and trusting there is no copy.
### Option 2: SSE-KMS with one KMS key per tenant
Pros: KMS generates, stores, rotates (automatic and on demand) and deletes
the key; every use is a CloudTrail event naming the key; the key policy binds
the key to the tenant's prefix and denies use to every other principal
(ADR-0002), and the tenant role's identity policy binds the caller to the
tenant (ADR-0003), so there are two walls and both are evaluated by AWS;
scheduling the key for deletion makes every object unreadable at once
(ADR-0006); a tenant can bring its own key (ADR-0004); no tenant-side tooling.
Cons: $1 per key per month; S3 and the pipeline see plaintext in flight behind
TLS; one KMS request per object read and write, because Bucket Keys must stay
off (ADR-0002).
### Option 3: SSE-S3, or one shared KMS key with prefix-scoped IAM only
Pros: no per-tenant key cost, no per-tenant key lifecycle. Cons: the key is
not a tenant boundary; isolation rests on IAM prefix rules alone, a mistake in
one policy exposes every tenant; no cryptographic offboarding; no
tenant-owned tier.
### Option 4: Client-side envelope with an asymmetric KMS key (AWS Encryption SDK)
Pros: the drop is never plaintext to S3; KMS still holds the private key and
logs every unwrap. Cons: tenants need tooling and a vendor-defined envelope
format; validation has to unwrap first, so the pipeline holds plaintext
anyway; the format becomes a contract the vendor must version.

## Decision
Option 2. It is the only option where KMS and IAM, not pipeline code, decide
which tenant a key serves, while asking nothing of a tenant beyond an upload.
Per-tenant keys deliver everything the PGP drop was chosen for, natively.
"Enforced" covers, and only covers: a wrong-tenant bug in the sample's code
(the tenant session it was given is refused on another tenant's prefix, key
and partition); every IAM identity policy in the vendor's account, including
administrator roles (the key policy's Deny refuses them, ADR-0002); and a
leaked key ARN (useless outside the tenant's prefix and the three tenant
roles). It does not cover compromised function code: the code that assumes
the tenant role chooses the `TenantId` value, so it can act as any one tenant
at a time (threat model T-14, accepted residual, limited by one tenant role
per function and by CloudTrail `AssumeRole` events that name the tag,
ADR-0003). Nor does it cover the account principal rewriting a key policy,
which CloudTrail records and an alarm reports (ADR-0002). The
plaintext-in-flight gap is named in the threat model, and Option 4 is kept as
a documented seam, the sealed-drop tier (§11), for a tenant that requires S3
never to see plaintext.

## Consequences
Easier: rotation needs no re-encryption and no `{current, previous}`
bookkeeping; offboarding is a KMS call; the tier contract (ADR-0004) is one
`keyArn` per tenant. Harder: 10,000 tenants are 10,000 keys (default quota
100,000 per account and Region, counting keys pending deletion, N-3) and $10K
per month at the vendor tier; KMS request cost scales with deliveries (four
plus one per validator for an accepted delivery, N-2, ADR-0013); the README
and threat model must repeat the residuals above rather than claim more.
Revisit if a tenant demands that the vendor never holds plaintext, which
promotes the sealed-drop seam to a tier, or if AWS offers a way to bind a
session tag's value to a verified source.

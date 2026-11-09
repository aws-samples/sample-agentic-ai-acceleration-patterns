<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0001: Encrypt server-side with SSE-KMS and one KMS key per tenant

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
Tenants drop their most sensitive documents into one shared bucket that one
pipeline reads (spec §1, §1.1). Isolation has to hold at rest, survive a
pipeline bug, and end with a tenant's documents unreadable when it leaves. The
field pattern behind the sample used an OpenPGP drop: each tenant encrypts
files with a vendor-issued PGP key before upload. What that gives (one key per
tenant, rotation, revocation, a blast radius of one tenant) is the
requirement; the question is which mechanism delivers it with the least
tenant-side tooling and the most enforcement by AWS rather than by code. The
claim must also be precise: "enforced" has to say which callers AWS refuses
and which it cannot. Realises P-1, P-3, P-6 and spec §1.2, §3.1, §6.2.

## Options considered
### Option 1: OpenPGP drop, one PGP key pair per tenant
Pros: the drop is never plaintext outside the tenant; familiar to tenants that
already exchange files by PGP. Cons: the vendor runs key generation, storage,
rotation and revocation itself, plus a third-party crypto library in the
pipeline; every tenant needs PGP tooling; the private keys sit in a secret
store the pipeline reads broadly, so the boundary is filtered by code;
offboarding means deleting a secret and trusting there is no copy.
### Option 2: SSE-KMS with one KMS key per tenant
Pros: KMS generates, stores, rotates and deletes the key; every use is a
CloudTrail event naming the key; the key policy binds the key to the tenant's
prefixes (ADR-0002) and the tenant role's identity policy binds the caller to
the tenant (ADR-0003), two walls both evaluated by AWS; scheduling deletion
makes every object unreadable at once (ADR-0005); a tenant can bring its own
key (ADR-0004); no tenant-side tooling. Cons: $1 per key-month; S3 and the
pipeline see plaintext behind TLS; one KMS request per object write and read,
because Bucket Keys stay off (ADR-0002).
### Option 3: One shared KMS key with prefix-scoped IAM only
Pros: no per-tenant key cost or lifecycle. Cons: the key is not a tenant
boundary; isolation rests on IAM prefix rules alone, and one policy mistake
exposes every tenant; no cryptographic offboarding; no tenant-owned tier.
### Option 4: Client-side envelope with an asymmetric KMS key
Pros: S3 never sees plaintext; KMS still holds the private key and logs every
unwrap. Cons: tenants need tooling and a vendor-defined envelope format;
validation must unwrap first, so the pipeline holds plaintext anyway; the
format becomes a contract the vendor must version.

## Decision
Option 2: it is the only option where KMS and IAM, not pipeline code, decide
which tenant a key serves, while asking nothing of a tenant beyond an upload,
and it delivers natively everything the PGP drop was chosen for. "Enforced"
covers exactly three things: a wrong-tenant bug in the sample's code (the
session it holds is refused on another tenant's prefix, key and partition);
every identity policy in the vendor's account, administrator roles included
(the key policy Denies refuse them, ADR-0002); and a leaked key ARN (useless
outside the tenant's prefixes and the named roles). It does not cover
compromised function code: the code that assumes a tenant role chooses the
`TenantId` value, so it can act as any one tenant at a time; that residual is
accepted, bounded by one tenant role per function and made visible by
CloudTrail `AssumeRole` events naming the tag (ADR-0003). Nor does it cover
the account principal rewriting a key policy, which is logged and alarmed
(ADR-0002). Option 4 stays a documented seam, the sealed-drop tier (§11).

## Consequences
Easier: rotation needs no re-encryption and no `{current, previous}`
bookkeeping; offboarding is a KMS call (ADR-0005); the tier contract is one
`keyArn` per tenant (ADR-0004). Harder: 10,000 tenants are 10,000 keys (quota
100,000 per account and Region, counting keys pending deletion, N-3) and
$10K per month at the vendor tier; KMS requests scale with deliveries (four
plus one per validator for an accepted delivery, N-2, ADR-0012); the README
and threat model must state the residuals above and claim no more. Revisit if
a tenant requires that the vendor never hold plaintext, which promotes the
sealed-drop seam to a tier, or if AWS offers a way to bind a session tag's
value to a verified source.

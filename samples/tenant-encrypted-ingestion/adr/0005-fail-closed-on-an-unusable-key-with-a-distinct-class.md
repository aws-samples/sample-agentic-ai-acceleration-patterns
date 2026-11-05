<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0005: Fail closed on an unusable key with a distinct KEY_UNAVAILABLE class

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-7, F-20, F-30d)
- Revised: 2026-11-05, second security review (G-5)

## Context
In the `tenant-key` tier (ADR-0004) the tenant can disable its key, schedule
it for deletion, delete it, or remove the statement that trusts the vendor's
tenant roles from its key policy at any moment. A `vendor-key` key can also
become unusable during offboarding (ADR-0006). The processor learns of it
through S3: `HeadObject`, `GetObject` and `CopyObject` (§8 steps 3 to 6)
return an S3 error that carries the KMS cause. A bare S3 `AccessDenied` looks
the same whether the tenant revoked the key or the sample's own bucket or
identity policy is wrong (F-20), and the classifier's mistake has a high
cost: the tenant goes `REVOKED` and every `CreateDelivery` returns 409. The
pipeline must not land anything, must not burn retries on a cause that
retries cannot fix, must not mistake its own fault for the tenant's decision,
and must tell the tenant and the vendor which of "your file is bad" and "your
key is gone" happened.

`DescribeKey` cannot be the confirmation. The key policy grants it in a
statement of its own, with no condition, because a direct call carries no
`kms:ViaService` (ADR-0002, F-7). The most natural tenant revocation removes
the "use via S3" statement and leaves that one in place, so `DescribeKey`
still succeeds and still reports `Enabled` while every S3 request is denied
(G-5). A classifier that trusts `DescribeKey` calls that the pipeline's own
fault and retries into the DLQ; a recovery that trusts it flips the row back
to `ACTIVE` every hour and burns one delivery each time. Realises P-5 and
§4.1, §4.2, §5.1 `GetTenantKey`, §5.4, §6.2, §8.

## Options considered
### Option 1: Treat it as transient and let SQS retry into the DLQ
Pros: no special case in the processor. Cons: three receives per delivery,
then a DLQ full of messages an operator cannot fix; the tenant sees
`PROCESSING` until the sweep; the DLQ alarm fires for a tenant decision,
drowning real faults.
### Option 2: Treat it as `REJECTED`
Pros: terminal, no retry. Cons: says the file is corrupt when it is not; the
tenant fixes the wrong thing; the key row stays `ACTIVE`, so the API keeps
presigning uploads that are bound to fail.
### Option 3: A distinct terminal class `KEY_UNAVAILABLE`, classified on any access denial
Pros: names the cause. Cons: a pipeline bug (a wrong bucket policy, a missing
identity-policy statement) marks a healthy tenant `REVOKED` and stops it.
### Option 4: A distinct terminal class `KEY_UNAVAILABLE`, classified on KMS error codes and confirmed with `DescribeKey`
Pros: names the cause; `DescribeKey` is one cheap call. Cons: misses a
revocation that removes only the use statement, and its recovery flaps on the
same case (G-5).
### Option 5: A distinct terminal class `KEY_UNAVAILABLE`, classified on KMS error codes and confirmed with the through-S3 probe
Pros: names the cause; the probe exercises exactly the path the pipeline uses
(the same `_probe/` Put, Get and Delete `CreateTenantKey` runs, ADR-0004), so
every form of revocation, whether disabled, deleted, pending deletion or a
removed use statement, shows up, and a healthy key with a broken pipeline
does not; the delivery row records the KMS error code; the key row flips to
`REVOKED`, so `CreateDelivery` returns 409 `TenantKeyUnavailable` until the
key works again; a `DeliveryKeyUnavailable` event lets the vendor alert or
notify; the message is deleted, not retried. Cons: a probe costs three S3
requests and a few KMS requests per check; the exact S3 error codes that
carry each KMS cause are not fully documented, so the integration test pins
them (§10 step 8).

## Decision
Option 5. The processor matches only on the KMS error codes S3 surfaces
(`KMS.AccessDeniedException`, `KMS.DisabledException`,
`KMS.KMSInvalidStateException`, `KMS.NotFoundException`) for the registry's
`keyArn`, never on a bare S3 `AccessDenied`, and confirms with the
through-S3 probe under the same `tenantProcessRole` session: `PutObject`,
`GetObject` and `DeleteObject` of `ingest/<tenantId>/_probe/<ulid>` with the
key (spec §8, G-5). Only when the probe also fails with a KMS code does the
delivery become `KEY_UNAVAILABLE` and the key row `REVOKED`, with the event
published and the message deleted. A probe that succeeds means the error was
the pipeline's own, and it throws into the normal SQS retry and DLQ path, as
do KMS throttling and every other error. `GetTenantKey` applies the same
rule under a `tenantPlatformRole` session. Recovery uses the probe too: the
hourly sweep re-checks every `REVOKED` row with it under `tenantProcessRole`
(the `sweepRole` path, ADR-0003) and flips it back to `ACTIVE` only when the
probe succeeds, so a key whose use is still denied stays `REVOKED` (F-20,
G-5); `GetTenantKey` does the same on demand. `DescribeKey` is used only at
registration, to read the canonical ARN and key spec (ADR-0004).

## Consequences
Easier: the integration test asserts the full path (§10 step 8): delivery
`KEY_UNAVAILABLE`, key `REVOKED`, event published, DLQ empty, recovery after
re-enable through the sweep, no `REVOKED` for an S3 `AccessDenied` it
provokes with a wrong bucket policy on a scratch prefix, and a variant that
removes **only** the use statement and leaves `DescribeKey`: the delivery is
still `KEY_UNAVAILABLE`, and the sweep leaves the row `REVOKED` until the
statement is back. Contributor Insights can rank tenants by key failures
(ADR-0013). Harder: the probe writes under `ingest/`, so the processor ignores
`_probe/` events and `tenantProcessRole` needs `PutObject` on
`ingest/${tag}/_probe/*`; each `REVOKED` tenant costs one probe per sweep
until it recovers or offboards. A delivery that hit `KEY_UNAVAILABLE` is not
replayed automatically; the tenant uploads again after restoring the key, and
the README says so. The drop object expires with the lifecycle (ADR-0008).
Recovery lags by up to one sweep interval. KMS tag changes take up to five
minutes to affect authorisation, so a tenant re-tagging its key can flip the
result for that long. Revisit if tenants need automatic replay after
recovery, or if S3 documents a stable error code per KMS cause.

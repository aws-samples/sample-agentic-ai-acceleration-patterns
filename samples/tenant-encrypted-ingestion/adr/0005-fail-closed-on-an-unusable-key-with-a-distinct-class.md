<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0005: Fail closed on an unusable key with a distinct KEY_UNAVAILABLE class

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-7, F-20, F-30d)

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
key is gone" happened. Realises P-5 and §4.1, §4.2, §5.1 `GetTenantKey`,
§5.4, §6.2, §8.

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
Pros: names the cause; the delivery row records the KMS error code; the key
row flips to `REVOKED`, so `CreateDelivery` returns 409 `TenantKeyUnavailable`
until the key works again; a `DeliveryKeyUnavailable` event lets the vendor
alert or notify; the message is deleted, not retried; a pipeline fault stays a
pipeline fault. Cons: one more status, event and branch to test; the exact S3
error codes and messages that carry each KMS cause are not fully documented,
so the integration test pins them (§10 step 8).

## Decision
Option 4. The processor matches only on the KMS error code S3 surfaces
(disabled, invalid state, not found, KMS access denied), never on a bare S3
`AccessDenied`, and confirms with a `DescribeKey` under the tenant session
(which the key policies allow without `kms:ViaService`, ADR-0002, F-7). Only
when the key is disabled, pending deletion, not found, or `DescribeKey`
itself is denied by the key policy does the delivery become `KEY_UNAVAILABLE`
and the key row `REVOKED`; otherwise the error is the pipeline's own and
throws into the normal SQS retry and DLQ path, as do KMS throttling and every
other error. `GetTenantKey` applies the same rule. Recovery is automatic: the
hourly sweep re-checks every `REVOKED` row with `DescribeKey` and flips it
back to `ACTIVE` when the key is usable again (F-20), so no vendor call is
needed; `GetTenantKey` does the same on demand.

## Consequences
Easier: the integration test asserts the full path (§10 step 8): delivery
`KEY_UNAVAILABLE`, key `REVOKED`, event published, DLQ empty, recovery after
re-enable through the sweep, and no `REVOKED` for an S3 `AccessDenied` it
provokes with a wrong bucket policy on a scratch prefix. Contributor Insights
can rank tenants by key failures (ADR-0013). Harder: a delivery that hit
`KEY_UNAVAILABLE` is not replayed automatically; the tenant uploads again
after restoring the key, and the README says so. The drop object expires with
the lifecycle (ADR-0008). Recovery lags by up to one sweep interval. KMS tag
changes are eventually consistent, so a tenant re-tagging its key can flip the
result for a few minutes. Revisit if tenants need automatic replay after
recovery, or if S3 documents a stable error code per KMS cause.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0005: Fail closed on an unusable key with a distinct KEY_UNAVAILABLE class

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
In the `tenant-key` tier (ADR-0004) the tenant can disable its key, schedule
it for deletion or remove the grant to `ingestionRole` at any moment. A
`vendor-key` key can also become unusable during offboarding (ADR-0006). The
processor then gets `KMS.AccessDeniedException`, `DisabledException` or
`KMSInvalidStateException` on `HeadObject`, `GetObject` or `CopyObject`
(§8 steps 3 to 6). The pipeline must not land anything, must not burn retries
on a cause that retries cannot fix, and must tell the tenant and the vendor
which of "your file is bad" and "your key is gone" happened. Realises P-5 and
§4.1, §4.2, §5.4, §6.2, §8.

## Options considered
### Option 1: Treat it as transient and let SQS retry into the DLQ
Pros: no special case in the processor. Cons: three receives per delivery,
then a DLQ full of messages an operator cannot fix; the tenant sees
`PROCESSING` forever; the DLQ alarm fires for a tenant decision, drowning real
faults.
### Option 2: Treat it as `REJECTED`
Pros: terminal, no retry. Cons: says the file is corrupt when it is not; the
tenant fixes the wrong thing; the key row stays `ACTIVE`, so the API keeps
presigning uploads that are bound to fail.
### Option 3: A distinct terminal class `KEY_UNAVAILABLE`
Pros: names the cause; the delivery row records the KMS error code; the key
row flips to `REVOKED`, so `CreateDelivery` returns 409 `TenantKeyUnavailable`
until the key works again; a `DeliveryKeyUnavailable` event lets the vendor
alert or notify; the message is deleted, not retried. Cons: one more status,
event and branch to test; the processor must classify KMS errors correctly,
and a mistaken classification of a throttle would drop a delivery.

## Decision
Option 3. A missing key is a state of the tenant's choosing, not a fault of
the file or of the pipeline, so it gets its own class and stops the tenant's
pipeline within one delivery. Only the three KMS error codes above map to
`KEY_UNAVAILABLE`; KMS throttling and every other error still throw and follow
the normal SQS retry and DLQ path. `GetTenantKey` re-checks with `DescribeKey`
and returns the row to `ACTIVE` once the tenant restores the key, so recovery
needs no vendor action.

## Consequences
Easier: the integration test asserts the full path (§10 step 8): delivery
`KEY_UNAVAILABLE`, key `REVOKED`, event published, DLQ empty, recovery after
re-enable. Contributor Insights can rank tenants by key failures (ADR-0013).
Harder: a delivery that hit `KEY_UNAVAILABLE` is not replayed automatically;
the tenant uploads again after restoring the key, and the README says so. The
drop object expires with the one-day lifecycle (ADR-0008). Revisit if tenants
need automatic replay after recovery.

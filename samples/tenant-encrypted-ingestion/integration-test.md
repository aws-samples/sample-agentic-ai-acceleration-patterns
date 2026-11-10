<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Per-Tenant Encrypted Ingestion for Agentic Applications: deployment integration test

This file describes the sample's deployment integration test, per
[sample standard §5.3](../../docs/sample-standard.md#53-integration-test-document-integration-testmd).

## What it is

The deployment integration test
([`test/integ.ingestion.ts`](./test/integ.ingestion.ts), driven by
[`scripts/integ.sh`](./scripts/integ.sh) with the app
[`test/integ/app.ts`](./test/integ/app.ts)) is the reference implementation
of this sample's wiring ([sample standard §5.2](../../docs/sample-standard.md#52-integration-test)):
it reuses tenant-identity through its published parameters, deploys the
sample's own demo stack, drives the flow through the public API and the
published parameters under `/application-plane/shared/ingestion/`, and
tears down what it deployed.

## How to run it

**Account guard.** The script runs only in an account that carries the
Organizations tag `tei:test-account` or the SSM parameter
`/tenant-encrypted-ingestion/test-account` set to `true`, and refuses any
other (M-33). A member account cannot read its own Organizations tags, so
the parameter is the usual marker; set it once in a non-production test
account.

Run it in exactly one Region: set `AWS_REGION`; the script fails fast when
it is unset.

```bash
export AWS_REGION=eu-central-1 && npx projen integ
```

To exercise the `tenant-key` tier across accounts, name a profile for a
second account:

```bash
export AWS_REGION=eu-central-1 && TEI_TENANT_KEY_PROFILE=<profile> npx projen integ
```

Its account becomes the `tenantKeyAccount` context (which turns
`allowTenantKeys` on), and tenant B's key is created, tagged, disabled and
re-enabled there and scheduled for deletion at the end. Without it B is a
second `vendor-key` tenant and the run says the cross-account claim is not
exercised. The second account's credentials must last the whole run: its
steps fall at about minutes 10 and 60. tenant-identity's access tokens live
five minutes, so the driver re-issues a run-issued token on a 401 and
retries once.

## What it stands up

It reuses the account's tenant-identity `shared-pool` deployment, deploying
it through its own path only when none is published, and never destroys
it: the pool is the test account's shared fixture. It then synthesises the
integration app into `cdk.integ.out/` and deploys two stacks with the CDK
CLI:

- the **test-aid stack** (`TenantEncryptedIngestionTestAid`:
  `TestProbeRole`, `TestConsumerRole`, a scratch bucket and scratch key
  built from the same policy builders with a mistaken Allow for the probe
  role, an event capture queue, and the redrive and access-log reader
  roles);
- the **demo stack** (`TenantEncryptedIngestionInteg`, the sample's own
  demo stack with the test profile, `TestConsumerRole` as consumer).

The driver deletes the tenants it created in the shared pool before it
exits and names any it could not delete. Teardown runs from the exit trap,
also on failure, and fails the run if a stack with the sample's prefix is
left or a key it tagged is not `PendingDeletion`.

## Steps

| Step | What it checks |
|---|---|
| 0 | Prelude: tenants A, B and D created in tenant-identity, entitled to `ingestion/deliver` and `ingestion/read` |
| 1 | `CreateTenantKey` A `vendor-key` and B `tenant-key` (second account) both `ACTIVE`; untagged, wrongly tagged, vendor-account and another tenant's key are 422 `KeyNotUsable` |
| 2 | Tenant users with both scopes, and one token with `ingestion/read` only |
| 3 | Happy path: A and B deliver a PDF, `ACCEPTED`, landed with the tenant's key and the file name; one `DeliveryAccepted` without a key ARN; read-only token: `CreateDelivery` 403, `GetDelivery` 200 |
| 4 | The uploader cannot change the request: another key, no SSE, another length, `GLACIER` are 403; a second PUT is 412; an edited path is `SignatureDoesNotMatch` |
| 5 | Each key-policy Deny alone against the scratch key's mistaken Allow, by error message; the bucket Deny with the `aws/s3` key; the identity-policy wall with `SimulatePrincipalPolicy` on the deployed tenant roles |
| 6 | Cross-tenant read: `TestConsumerRole` for A reads A's landed document, is refused B's by S3; `TestProbeRole` on B's is refused by KMS |
| 7 | Rejections and limits: `TYPE_MISMATCH`, oversize 400, an unused URL `EXPIRED` by the sweep, tenant D's sixth open delivery 429 |
| 7b | Validators: a 5-page PDF is `pdf-pages:TOO_MANY_PAGES` without invoking `test-switch`; mode `throw` is `test-switch:VALIDATOR_ERROR` with the message in the DLQ; no log line holds a signature or file name |
| 7c | Abandoned lease: mode `sleep` outlasts the processor; the sweep ends it as `PROCESSING_ABANDONED` and publishes |
| 8 | Revocation decided by the probe: B's key disabled mid-delivery, then its use statement removed: `KEY_UNAVAILABLE`, `REVOKED`, DLQ unchanged, `CreateDelivery` 409; back to `ACTIVE` after the sweep |
| 9 | Rotation: `RotateTenantKey` A 200 and step 3's document still reads; B 400 `UnsupportedInTier` |
| 10 | Observability: one processor line per delivery with `tenantId`, `status`, `kmsRequests`; `kmsRequests` compared with CloudTrail (informational); the access-log `Requester` (best effort) |
| 10b | Cost attribution: A's registry counters (`GetTenantKey`) equal the tenant's own `ListDeliveries` view (`deliveriesAccepted`, `deliveriesRejected`, `bytesStored` as the sum of accepted `sizeBytes`, `kmsRequests` at least four per accepted and one per processor-refused delivery, `inFlight` 0); A's key carries the `TenantId` cost allocation tag; the `tei-top-bytes` and `tei-top-deliveries` Contributor Insights reports name A with the same figures |
| 11 | Offboarding: `DeleteTenantKey` A 202, no version left under A's prefixes, alias gone, key `PendingDeletion`, `CreateDelivery` A refused, the in-flight PUT fails; `DeleteTenantKey` B leaves B's key untouched and writes the tombstone without an alarm |
| 12 | Teardown, by `scripts/integ.sh`: `cdk destroy --all`, then the leftover check (the driver reports the step as skipped) |
| cleanup | The driver deletes the tenants it created in tenant-identity's shared pool, each then 404; a tenant left fails the run |

## Runtime and cost

One run takes 53 to 65 minutes end to end (the four integration runs of
2026-11-09). CloudFormation took about 4 minutes to create the two stacks
(test aid 1 min 10 s, demo stack 2 min 17 s) and about 5 minutes to delete
them (demo stack 3 min 9 s, test aid 1 min 35 s), so N-4 holds; the rest is
the driver's waits. The driver waits five minutes after each key policy or
tag change and on URL TTLs, leases and the sweep. The spec's cost target is
under $2 per run; the cost of a run has not been measured.

Last green run: 2026-11-09, after the identity-provider change (two runs
on 2026-11-06, before it, were green too), in eu-central-1, a vendor test
account plus a second account owning tenant B's key; the last two runs,
with step 10b, ran 179 checks each. Every step passed
([`architecture.md`](./architecture.md) status block). The run's cleanup
step deleted the three tenants it had created in the shared tenant-identity
pool. Not covered by that run: no access log arrived within three minutes
for the `Requester` check, `kmsRequests` against CloudTrail is recorded
rather than checked, and offboarding saw 409 from the handler, not 403 from
API Gateway ([§14](./architecture.md#14-known-gaps-and-residuals)).

## After an interruption

A run that stops before its exit trap leaves what the teardown and the
driver's cleanup would have removed. Look for, and remove by hand:

- stacks whose name starts with `TenantEncryptedIngestion`
  (`TenantEncryptedIngestionTestAid`, `TenantEncryptedIngestionInteg`);
- keys the run tagged that are not `PendingDeletion`, including tenant B's
  key in the second account when `TEI_TENANT_KEY_PROFILE` was set;
- tenants the driver created in tenant-identity's shared pool.

Leave the tenant-identity `shared-pool` deployment in place: it is the test
account's shared fixture.

## Test-only shortcuts

One shortcut is a test's only. The driver is a separate process, so it
cannot read construct properties; `scripts/integ.sh` deploys with the CDK
CLI's `--outputs-file`, and the driver reads the test's own stacks' outputs
from that file: the processor and sweep function names, queue and DLQ URLs
and ARNs, the registry table, event bus, log group, Contributor Insights
rule and alarm names, the pipeline timing and the test-switch parameter
from the demo stack, and the probe, consumer, scratch and capture
resources from the test-aid stack. These are test-only wiring standing for
the construct properties (`processorFunction`, `queue`, `registryTable`,
...) that your own CDK code reads; do not copy them as the composition
contract, which is the published parameters
([ADR-0014](./adr/0014-drive-the-integration-test-with-the-cdk-cli-and-read-test-wiring-from-outputs.md)).

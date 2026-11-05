<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0013: Observe and attribute cost per tenant from log fields, with per-tenant metrics opt-in

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-14, F-22, F-28)
- Revised: 2026-11-05, second security review (G-2, G-10, G-20)

## Context
In a pool the vendor must answer "which tenant is failing, which is busiest,
what does each cost" without a per-tenant stack. Keys are dedicated per
tenant; S3 storage, requests and KMS requests are pooled and appear on the
bill as one line. Custom CloudWatch metrics are billed per metric per month,
so a dimension per tenant multiplies cost by tenants times metrics: 10,000
tenants with five metrics is 50,000 metrics. Logs the sample does not format,
S3 server access logs and CloudTrail, must still name the tenant (F-28), and
S3 access logs record presigned request URIs in full (F-14), the validators'
presigned `GET`s included, which stay reusable until their TTL (G-10). A flat
"three KMS requests per delivery" undercounts the real calls (F-22). And not
every store of operational data is a log: S3 `Object Created` events carry
the uploader's source IP address and requester, and they sit in the queues
for up to 14 days (G-20). Realises P-9 and §3.1 (Observability), §3.3
(`perTenantMetrics`, `logRetention`, `accessLogReaderRole`), §4.1, §7.4,
§7.7, N-2, N-5, N-6, §10 step 10.

## Options considered
### Option 1: Per-tenant metrics always on (EMF with a `TenantId` dimension)
Pros: dashboards and alarms per tenant out of the box. Cons: cost scales with
tenants times metrics and dominates the sample's idle cost at scale; most
tenants never need their own alarm.
### Option 2: Logs only
Pros: cheapest; every question is a Logs Insights query. Cons: no ranking or
alarm without someone writing a query; no answer to "top tenants now".
### Option 3: Log fields everywhere, Contributor Insights by default, EMF opt-in
Pros: `tenantId` is a field in every structured log line and in the API
access log, so any per-tenant view is derivable; Contributor Insights rules
(deliveries, bytes, rejections, key failures) rank top tenants at a fixed cost
per rule, independent of tenant count; a deployer who needs per-tenant alarms
sets `perTenantMetrics` and accepts the cost. Cons: Contributor Insights
shows top contributors, not every tenant; two code paths for metrics.

## Decision
Option 3, with `perTenantMetrics` off by default. Dedicated cost is
attributed with a `TenantId` cost allocation tag on every `vendor-key` key.
Pooled cost is metered on the tenant's registry row (ADR-0011): bytes
accepted, bytes stored, deliveries accepted and rejected, and `kmsRequests`
counted as the calls actually made, not a constant: for an accepted delivery
four plus one per validator (`GenerateDataKey` on the upload, `Decrypt` for
the processor's read, `Decrypt` per validator `GET`, `Decrypt` plus
`GenerateDataKey` on the copy, N-2), fewer for a delivery rejected early, and
a few more for each through-S3 probe (ADR-0005). KMS throttles the calling
account, so `tenant-key` requests count against the vendor's quota and the
README says so (F-22). Every tenant session's `RoleSessionName` is
`t-<tenantId>-<suffix>`, with `suffix` the last 16 characters of the
`deliveryId` or an operation name of at most 16 characters (ADR-0003, G-2),
so the S3 access log's `Requester` and every CloudTrail S3, KMS and STS event
name the tenant without a join on key segments (F-28), and no valid tenant id
can push the name past 64 characters. The processor writes one line per
delivery with `tenantId`, `deliveryId`, `status`, `sizeBytes` and
`kmsRequests`, and one line per validator call (ADR-0009). The sample's logs
never carry document content, presigned URLs, file names or the S3 event's
source IP address (N-6).

S3 server access logs are the one place a presigned URI appears, signature
and credential id included. They go to a separate SSE-S3 log bucket with an
explicit Deny of `s3:GetObject` to every principal but `accessLogReaderRole`
(ADR-0007, F-14, G-10). A logged upload URL is single-use; a logged validator
`GET` is reusable until `validatorObjectUrlTtlSeconds` (at most 900 s) after
it was signed, so the exposure window is that TTL minus the log delivery
latency, small but not zero. The queues and both DLQs hold tenant users' IP
addresses for up to 14 days (ADR-0010); both residuals are named in N-6 and
the threat model (G-20). Every log group is an explicit `LogGroup` with
`logRetention` (one month by default) and `DESTROY` (ADR-0014).

## Consequences
Easier: the vendor can price a tenant from its row and the key tag; the
integration test checks the fields, the rules, the session name in the access
log, and that metered `kmsRequests` equals the CloudTrail KMS event count for
one sampled delivery. Harder: the counters are approximations of the bill, not
the bill, and a compromised tenant session can skew its own (ADR-0011); S3
storage per tenant is the cumulative `bytesStored`, not an S3 measurement;
which account is billed for cross-account KMS requests is not documented, so
the README states only the throttling account; the access-log bucket is a
sensitive store with its own reader, and reading it needs that role; IP
addresses in the queues are personal data under some regimes, so the README
names the 14-day retention and how to shorten it. Revisit if S3 or KMS offer
per-prefix or per-tag usage reporting that makes the counters redundant.

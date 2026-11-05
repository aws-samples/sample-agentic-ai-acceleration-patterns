<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0013: Observe and attribute cost per tenant from log fields, with per-tenant metrics opt-in

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
In a pool the vendor must answer "which tenant is failing, which is busiest,
what does each cost" without a per-tenant stack. Keys are dedicated per
tenant; S3 storage, requests and KMS requests are pooled and appear on the
bill as one line. Custom CloudWatch metrics are billed per metric per month,
so a dimension per tenant multiplies cost by tenants times metrics: 10,000
tenants with five metrics is 50,000 metrics. Realises P-9 and §3.1
(Observability), §3.3 (`perTenantMetrics`, `logRetention`), §4.1, N-5, §10
step 10.

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
accepted, bytes stored, deliveries accepted and rejected, and KMS requests,
counted as three per accepted delivery (one `GenerateDataKey` on upload, one
`Decrypt` and one `GenerateDataKey` on copy). The processor writes one line
per delivery with `tenantId`, `deliveryId`, `status`, `sizeBytes` and
`kmsRequests`, and one line per validator call (ADR-0009). Logs never carry
document content or presigned URLs (N-6), and every log group has
`logRetention` (one month by default).

## Consequences
Easier: the vendor can price a tenant from its row and the key tag; the
integration test checks the fields and the rules exist. Harder: the counters
are approximations of the bill, not the bill; S3 storage per tenant is the
cumulative `bytesStored`, not an S3 measurement. Revisit if S3 or KMS offer
per-prefix or per-tag usage reporting that makes the counters redundant.

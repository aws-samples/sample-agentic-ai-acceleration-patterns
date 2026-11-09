<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0012: Deliver the pattern as a construct with per-tenant observability

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
The sample is a pattern a vendor adopts once per pool, or once per siloed
tenant (spec §1.1), so it must be reusable without forking, with its inputs as
typed props and secure defaults, and it must tear down cleanly (N-4, N-7).
The integration test must reach pipeline internals without a redeploy. The
vendor must also answer "what does each tenant cost and do" in a pool where
every resource is shared (P-9), at 10,000 tenants, without a cost that grows
per tenant, and CDK's bucket auto-delete provider depends on the bucket
policy, whose delete Denies would otherwise block it on a versioned bucket.

## Options considered
### Option 1: A stack only, metrics per tenant always on
Pros: least code; `cdk deploy` and done; dashboards and alarms per tenant out
of the box. Cons: reuse means forking; a silo means a copied stack; EMF with
a `TenantId` dimension makes metric cost grow with tenants and dominate idle
cost at scale.
### Option 2: A construct and thin demo stack, logs only
Pros: one `TenantEncryptedIngestion` per pool or silo; dependencies arrive as
props; cheapest telemetry. Cons: no ranking or alarm without someone writing
a query; no answer to "top tenants now".
### Option 3: A construct, tenant ids everywhere, Contributor Insights, EMF opt-in
Pros: reuse as in Option 2; every log line and session names the tenant, so
any per-tenant view is derivable; Contributor Insights ranks top tenants at a
fixed cost per rule; a deployer who needs per-tenant alarms opts in. Cons: a
props type and its validation to maintain; two metric paths; Contributor
Insights shows top contributors, not every tenant.

## Decision
Option 3. `TenantEncryptedIngestion` takes the §3.3 props, validated in the
constructor so a bad value fails synth naming the prop, and exposes `bucket`,
`accessLogBucket`, `apiUrl`, `eventBus`, `registryTable`, `queue`,
`deadLetterQueue`, `processorFunction`, `sweepFunction`, `tenantRoles`,
`platformRole`, `keyFactoryRole` and `sweepRole`; the demo stack is wiring
and publishes `/application-plane/shared/ingestion/*`. A test-aid stack owns
`TestProbeRole`, `TestConsumerRole`, a scratch bucket and a scratch key, so
the test proves each wall without touching the real bucket's policy. The
bucket's delete Denies exempt the `Custom::S3AutoDeleteObjectsCustomResourceProvider`
singleton role, without which `cdk destroy` could not empty the versioned
bucket. Every function gets an explicit `DESTROY` `LogGroup` with
`logRetention`. `tenantId` is a field in every structured log line, and
`RoleSessionName` `t-<tenantId>-...` puts it in every S3 access log,
CloudTrail and KMS record without a join (ADR-0003). Contributor Insights
rules rank deliveries, bytes, rejections and key failures; full per-tenant
figures come from the key-row counters (`bytesStored`, `deliveriesAccepted`,
`deliveriesRejected`, `kmsRequests`) and Logs Insights; `perTenantMetrics`
adds EMF per tenant. `vendor-key` keys carry `TenantId` as a cost allocation
tag, so the largest per-tenant cost appears on the bill directly.

## Consequences
Easier: a silo is a second instance; the test reaches internals through
read-only properties and changes validator behaviour through an SSM
parameter, so nothing redeploys; teardown leaves nothing with the sample's
prefix but keys pending deletion (§10 step 12); per-tenant cost needs no
extra infrastructure and rule cost does not grow with tenants. Harder: S3
access logs hold presigned query strings, so their bucket admits one reader
(`accessLogReaderRole`) by a Deny, a stated residual; the cost tag must be
activated in Billing by the deployer; pooled costs (S3, Lambda, SQS) are
apportioned from counters, not billed per tenant. Revisit if CloudWatch
offers per-dimension metrics priced by use, or if CDK's auto-delete provider
stops depending on the bucket policy.

Implemented 2026-11-06 with three Contributor Insights rules
(`src/construct/observability.ts`): deliveries by `tenantId` and `status`,
accepted bytes by `tenantId`, and API requests to `/tenant/deliveries` by
`tenantId` and `status`. Rejections and key failures appear as the
`status` split of the deliveries rule (`REJECTED`, `KEY_UNAVAILABLE`), not
as rules of their own.

Changed 2026-11-09: the requests rule counts both tenant resource paths,
`/tenant/deliveries` and `/tenant/deliveries/{deliveryId}`, so a
`GetDelivery` poll is ranked with the other calls.

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0015: Limit each tenant with a usage plan key and an in-flight counter

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
Every `CreateDelivery` and every processed delivery costs an `AssumeRole`,
and every delivery costs four or more KMS requests, a processor run and one
invoke per validator (N-2, ADR-0009). STS allows 600 requests per second per
account, shared with everything else in the vendor's account; the KMS request
quota is per account and Region, and `tenant-key` traffic counts against the
vendor's quota, not the tenant's (ADR-0004). One tenant looping
`CreateDelivery`, or uploading as fast as it can, can therefore throttle every
other tenant's API and pipeline and the account's other workloads (F-17).
Reserved concurrency on the processor only queues the work; it does not stop
a tenant from filling the queue. Two different things need bounding: the rate
of requests a tenant makes, and the amount of work a tenant has open at once.
Realises §3.1 (Per-tenant limits), §3.3 (`maxInFlightPerTenant`,
`tenantThrottle`), §4.1, §5.1, §5.2, §6.2, N-3, N-8.

## Options considered
### Option 1: Shared stage throttle only
Pros: one setting on the API stage; no per-tenant resource. Cons: the limit is
shared, so one tenant can consume all of it and the others get 429s; it bounds
request rate, not open work, so a tenant within the rate can still keep
thousands of deliveries in flight.
### Option 2: Per-tenant API key and usage plan
Pros: API Gateway enforces a rate and burst per tenant before the handler
runs, so a noisy tenant's excess costs no Lambda, STS or DynamoDB call; the
same pattern as tenant-identity ADR-0025; the key is a usage-plan identifier,
not a credential. Cons: one API key per tenant to create and delete; it bounds
rate only, so slow-and-steady uploads of large files still accumulate open
work in the pipeline.
### Option 3: In-flight counter on the key row
Pros: `CreateDelivery` increments `inFlight` in the same conditional write as
the new delivery row and refuses at `maxInFlightPerTenant`, so the number of
deliveries a tenant has in `AWAITING_UPLOAD` or `PROCESSING` is bounded
exactly; every terminal transition decrements it in the same transaction.
Cons: it bounds open work, not request rate, so a tenant can still hammer the
API with requests that are refused; the counter must be reconciled when a
transition is lost.
### Option 4: Both
Pros: the usage plan caps request rate at the edge, the counter caps open work
in the pipeline; together they bound one tenant's STS, KMS, Lambda and
validator consumption. Cons: two mechanisms to create, test and tear down.

## Decision
Option 4. `CreateTenantKey` issues the tenant's API key in the construct's
usage plan on `/tenant/*` (`tenantThrottle`, default rate 20, burst 40) and
stores `apiKeyId` on the key row; the authoriser returns that tenant's key
value as `usageIdentifierKey` (`apiKeySource: AUTHORIZER`, as tenant-identity
ADR-0025), chosen from the verified token's tenant, so a tenant cannot
borrow another's allowance and never handles an API key itself.
`CreateDelivery` increments `inFlight` conditionally on `inFlight <
maxInFlightPerTenant` (default 100) in the same transaction as the delivery
row and returns 429 `TooManyDeliveries` at the limit. The processor and the
sweep decrement it at every terminal transition (ADR-0016), and the sweep
reconciles it against the open deliveries it finds on the `statusBucket`
GSI. `DeleteTenantKey` removes the API key first, so no new delivery can
start while the tenant's objects are being deleted (ADR-0006).

## Consequences
Easier: one tenant's consumption of STS, KMS, Lambda and validator capacity is
bounded per tenant, so N-3's 10,000 tenants share the account's quotas
predictably; the threat model can move the noisy-neighbour risk from accepted
to mitigated; the integration test exercises the counter (§10 step 7, limit 2
via context). Harder: the authoriser now needs the tenant's key value, a lookup it caches
with its result for the same TTL (ADR-0012); the usage plan and the API keys
are resources the drain
and `cdk destroy` must remove (§10 step 12); a lost decrement holds a slot
until the next sweep; the defaults are guesses, and a deployer with large
tenants raises them per deployment, not per tenant. Revisit if tenants need
per-tenant limits that differ, which calls for one usage plan per tier, or if
STS or KMS quotas still bind under N-2 load.

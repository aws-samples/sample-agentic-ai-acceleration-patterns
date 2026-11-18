<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0002: Give the stress test its own tenant-identity deployment

- Status: Accepted
- Date: 2026-11-18
- Deciders: Dave Roberts (PSA)

## Context
Every sample's integration test reuses one long-lived `tenant-identity`
`shared-pool` deployment in the test account, and never destroys it. That
pool holds two Cognito groups per tenant, and a user pool holds at most
10,000 groups, so one pool caps at 5,000 tenants (runtime-isolation stress
finding F-11). The `large` tier keeps 4,000 tenants as a fixture (ADR-0004).
In the shared pool they would leave room for 1,000 tenants across every
other integration run, and a killed seed has already left hundreds of
groups behind.

## Options considered
### Option 1: A second `shared-pool` deployment for the stress test only
Pros: the stress fleet and the integration tests never share a quota; the
stress pool can be torn down without touching anyone else. Cons: one more
long-lived deployment; its stack and parameter names must not collide with
the shared pool's.

### Option 2: Reuse the shared pool and cap the stress fleet lower
Pros: nothing new to deploy. Cons: `large` drops to about 2,000 tenants to
leave room for others, below the scale the samples claim.

### Option 3: A pool per run
Pros: no fixture. Cons: seeding 4,000 tenants takes hours (ADR-0004), and
Cognito bills each user as a monthly active user per pool, so every run pays
again.

## Decision
Option 1. The `tenant-identity` slice deploys `shared-pool` under a stress
prefix with `publishSharedParameters=false`, and publishes its identifiers
under the stress prefix, not under `/application-plane/shared/identity`.
Every cell in a stress run trusts that issuer. The integration tests keep
the shared pool to themselves.

## Consequences
Easier: no stress run can starve an integration run of Cognito groups, and
the reverse. Harder: tenant-identity must support a second `shared-pool`
deployment with its own parameter prefix (check that it does before W-6);
the stress pool's users count as monthly active users once a month. Revisit
when tenant-identity spreads tenants across pools: then one stress
deployment can hold more than 5,000 tenants.

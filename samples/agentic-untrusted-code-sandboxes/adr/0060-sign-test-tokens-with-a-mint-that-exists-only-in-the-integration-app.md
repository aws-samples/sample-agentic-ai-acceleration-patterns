<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0060: Sign test tokens with a mint that exists only in the integration app

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The behaviour steps call `run_code` on the tools gateway with a bearer token
for a tenant. Only the ingress holds the key that signs a transaction token,
so no consumer can sign one for an ingress it does not own (S-12). The test
also needs a token for tenants that have no identity in tenant-identity
(`A`, `B`, `C`, `D`, `E`), and a tool context signed with the wrong key.

## Options considered

### Option 1: Real users in tenant-identity and the ingress's own token exchange
Pros: the consumer path for every call. Cons: five tenants and users to
create and delete through two APIs, entitlement writes for each, and every
call carries the ingress's minting latency.

### Option 2: A test-only mint function with `tokenSigner.grantSign`
Pros: one invoke gives a token for any tenant id; the tenant ids are exactly
those the spec names. Cons: a stated shortcut: the test signs tokens the
ingress would not mint for these tenants.

## Decision

Option 2 for every step except one. `test/integ/mint.function.ts` is a copy of
the mint in `agentic-runtime-isolation`'s integration test, reduced to the
claims of a transaction token and a forged tool context. It is deployed in the
integration app only, with `grantSign` on the ingress's key, and writes no
log line that holds a token. The `parse` step also makes one call as a
consumer would: a throwaway tenant and admin user in tenant-identity's
`shared-pool` (created through its platform API with SigV4, deleted in a
`finally`), a subscription in the ingress's entitlement store, the user's
identity token as the bearer, and the sample agent's `tool <target>/<tool>`
probe. That path exercises the grant and the 120 s ingress path.
The function loads the AWS SDK's KMS client with `require`, because the
Lambda runtime provides it and the sample declares no dependency on it
(ADR-0023: every dependency is in `.projenrc.ts`).

## Consequences

The mint's claim set follows the producer's; a change to the producer's
token needs the same change here (the unit test pins today's claims). The
shared tenant-identity pool is read and never destroyed.

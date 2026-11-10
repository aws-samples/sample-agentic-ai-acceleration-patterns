<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0013: Ship a construct with a bundled standard-claims issuer

- Status: Accepted
- Date: 2026-11-10
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

The sample began as a Python validation kit with an SDK deployment driver
and a Cognito fixture that minted custom memory claims (ADR-0002, ADR-0003).
The Sample Standard asks for a reusable CDK construct, a thin demo stack,
and an integration test that deploys and tears down the sample (§4.5,
§5.2). The construct must stay producer-agnostic so a deployer can swap
the issuer (§1.1).

## Options considered

### Option 1: Consume tenant-identity's shared pool in the demo

Pros: the repository's identity provider. Cons: a second sample to deploy
for every run, for a claim set the construct does not depend on.

### Option 2: Bundle a synthetic Cognito issuer that mints the standard claims

A user pool whose pre-token trigger copies an immutable, vendor-set
`custom:tenantId` attribute into `tenant_id`; Cognito supplies `sub`,
`client_id`, and `token_use`. Pros: one stack; the same claim set as
tenant-identity, so swapping issuers is configuration. Cons: the demo does
not exercise tenant-identity itself.

## Decision

Option 2. `TenantMemoryIsolation` takes the issuer's discovery URL, its
allowed clients or audiences, and the claim names as props. The demo stack
bundles the synthetic issuer unless `issuerDiscoveryUrl` and
`issuerClientIds` are given, which point it at an existing issuer such as
tenant-identity's shared pool. The Python kit is removed.

## Consequences

The sample is one CDK app in TypeScript, built and tested by projen. The
construct consumes no other sample, so composition is the published
interface alone (spec §6.3). Moving to tenant-identity, or to the agent
runtime ingress (ADR-0008), changes context, not code.

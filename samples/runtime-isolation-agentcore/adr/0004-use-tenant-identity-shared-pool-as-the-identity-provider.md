<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0004: Use tenant-identity `shared-pool` as the identity provider, read from its parameters

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
Samples are self-contained (standard §1), but this sample's subject is the Runtime boundary, not tokens. tenant-identity already issues the needed contract (`tenant_id`, scopes, RFC 8693 narrowing) and publishes `/application-plane/shared/identity/{userPoolId,appClientId,apiUrl}`.

## Options considered
### Option 1: Rebuild a small identity stack inside this sample
Pros: self-contained. Cons: a third copy of the trigger and exchange logic in the repository; drift.
### Option 2: Import tenant-identity's stack class by relative path
Cons: a compile-time dependency between samples; breaks when the sample is copied out.
### Option 3: Construct takes `discoveryUrl` and client ids; the demo app reads tenant-identity's SSM parameters; the integ driver deploys tenant-identity first
Pros: the construct depends on a contract (§6.2), not a sample; tenant-identity is reused as shipped. Cons: the demo and integ need a second sample deployed.

## Decision
Option 3, topology `shared-pool` only (one tenant per user). This is a recorded exception to standard §1 for the demo app and the integration test; the construct itself has no dependency on tenant-identity.

## Consequences
Easier: one identity implementation in the repo. Harder: the integ runtime and cost include a tenant-identity deployment; ADR-0017 of tenant-identity means only one CLI-deployed topology may own the shared parameters per account, so the driver checks for an existing deployment first.

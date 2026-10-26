<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0004: Use tenant-identity `shared-pool` as the identity provider, read from its parameters

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
Samples compose (standard §1.1): a sample consumes another through its published interface instead of re-implementing it. This sample's subject is the Runtime boundary, not tokens. tenant-identity already issues the needed contract (`tenant_id`, scopes, RFC 8693 narrowing) and publishes `/application-plane/shared/identity/{userPoolId,appClientId,apiUrl}`.

## Options considered
### Option 1: Rebuild a small identity stack inside this sample
Pros: no second sample to deploy. Cons: a second copy of the trigger and exchange logic in the repository; drift.
### Option 2: Import tenant-identity's stack class by relative path
Cons: reaches into another sample's `src/` and binds the construct to one producer; standard §1.1 forbids both.
### Option 3: Construct takes `discoveryUrl` and client ids; the demo app reads tenant-identity's SSM parameters; the integ driver deploys tenant-identity first
Pros: uses tenant-identity's published interface (`/application-plane/shared/identity/*`) as standard §1.1 asks; the construct depends on a contract (§6.2), not a sample, so any OIDC provider that meets it works. Cons: the demo and integ need tenant-identity deployed.

## Decision
Option 3, topology `shared-pool` only (one tenant per user). Only the demo app and the integration test name tenant-identity; the construct has no dependency on it.

## Consequences
Easier: one identity implementation in the repo. Harder: the integ runtime and cost include a tenant-identity deployment; ADR-0017 of tenant-identity means only one CLI-deployed topology may own the shared parameters per account, so the driver checks for an existing deployment first.

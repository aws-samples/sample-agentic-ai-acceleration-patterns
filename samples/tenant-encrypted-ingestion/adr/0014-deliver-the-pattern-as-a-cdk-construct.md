<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0014: Deliver the pattern as the CDK construct TenantEncryptedIngestion, with a thin demo stack

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
The sample is a pool with per-tenant keys (§1.1). A tenant that needs its own
bucket or pipeline, or a vendor that wants the pattern inside an existing
application, must be able to take it into its own app without copying a
stack. The repository standard makes a construct the unit of reuse
(`docs/sample-standard.md` §4.5). The demo still needs to wire the pattern to
`tenant-identity` and publish what other samples consume. Realises §1.1,
§3.3, §3.4, §6.3 and standard §4.5.

## Options considered
### Option 1: A stack only
Pros: least code; `cdk deploy` and done. Cons: reuse means forking; a silo
deployment means a second copy of the stack with edits; the stack's
dependencies (issuer, parameters) are baked in.
### Option 2: A construct, plus a thin demo stack
Pros: a consumer instantiates `TenantEncryptedIngestion` once per pool or once
per siloed tenant; dependencies arrive as props; options are typed props with
secure defaults; the demo stack is only wiring. Cons: a props type and its
validation to maintain; read-only properties instead of stack outputs.

## Decision
Option 2. `TenantEncryptedIngestion` is exported with its props from
`src/index.ts`. It takes the issuer as props and creates none of its
dependencies. Optional behaviour is off unless set: `allowTenantKeys` false,
`perTenantMetrics` false, `validators` empty, `onValidatorError` `hold`,
`keyRotation` true, `keyDeletionWindowDays` 7, `dropRetentionDays` 1. The
constructor validates every prop (ranges, non-empty `allowedClientIds`,
validator names unique and `[a-z0-9-]{1,32}`, the chain fitting the processor
timeout) and fails synth with a message that names the prop. It carries its
own `NagSuppressions` with reasons and applies no aspect. It exposes `bucket`,
`apiUrl`, `ingestionRole`, `eventBus`, `registryTable`, `tenantRole` and
`keyManagementRole`. The demo stack in `src/main.ts` reads its context,
fails fast when the `identityParams` prefix is missing, wires the shipped
`examples/validator-pdf-pages`, and publishes `apiUrl`, `bucketName`,
`ingestionRoleArn` and `eventBusArn` under `/application-plane/shared/ingestion/`.
The construct writes no parameter itself.

## Consequences
Easier: siloing a tenant is a second construct instance; unit tests synthesise
the construct in a bare stack once per option combination the spec promises;
the extraction sample and the agentic-runtime-isolation TVM wire to the
published parameters. Harder: every new option is a prop with a default, a
validation rule and a test; a tenant's `keyArn` is not a shared parameter, so
consumers call `GetTenantKey` or read the `Delivery*` event. Revisit if the
pattern needs to span stacks, for example a bucket owned elsewhere.

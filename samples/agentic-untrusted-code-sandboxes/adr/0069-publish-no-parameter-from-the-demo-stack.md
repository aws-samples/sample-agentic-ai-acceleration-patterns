<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0069: Publish no parameter from the demo stack

- Status: Proposed
- Date: 2026-11-22
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The sample standard (§1.1) names two parts of a sample's published
interface: the construct, and parameters the demo stack writes to SSM
Parameter Store for consumers in other apps. This sample's construct is
consumed in the same app: a vendor puts it behind its own tools gateway
with `RunCodeToolTarget`, or grants its own API `lambda:InvokeFunction` on
`runCodeFunction` with `grantInvokeRunCode`. No sample in the repository
reads this sample's values at deploy time, and the integration stack
publishes nothing, so its two construct instances cannot collide on one
parameter name (agentic-runtime-isolation ADR-0042).

## Options considered

### Option 1: The demo stack writes one JSON parameter
Under `/application-plane/shared/code-sandbox/sandboxes`, with the function,
table, bucket, offboard function and backend ARNs. Pros: a consumer in
another app could find the values without a stack output. Cons: no consumer
exists; a cross-app consumer would also need IAM grants the parameter cannot
give (invoke on the function, the tool tenant role's trust), so the
parameter alone does not wire anything; the code has run end to end
without it, and adding it now adds an untested resource.

### Option 2: Publish no parameter
The construct's read-only properties are the whole interface. Pros: one
way in, the one the integration test is the reference for; nothing to keep
in step with the properties. Cons: a consumer in another app reads the
stack's resources itself or adds its own parameter.

## Decision

Option 2. The construct is consumed in the same app, the grants a consumer
needs are made through the construct's methods, and a parameter would carry
values without the rights to use them. The specification's Contracts section
states that the sample publishes nothing, and `ARCHITECTURE.md` gives it no
parameter namespace.

## Consequences

A vendor wires the sample from the construct's properties in its own app.
A later sample that consumes this one from another app adds the parameter in
the same change, under a new ADR, with its namespace in `ARCHITECTURE.md`.

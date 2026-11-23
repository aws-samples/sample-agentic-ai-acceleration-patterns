<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0069: Publish one JSON parameter from the demo stack

- Status: Accepted
- Date: 2026-11-22
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The sample standard (§1.1) names two parts of a sample's published
interface: the construct, and the parameters the demo stack writes to SSM
Parameter Store for consumers in other apps and for scripts. The construct
writes no parameter (standard §4.5), and the integration stack deploys two
construct instances in one stack, which would collide on one parameter name.
Parameter Store allows 3 writes per second per account
(agentic-runtime-isolation ADR-0042).

## Options considered

### Option 1: One parameter per value
Pros: a reader fetches one value without parsing. Cons: about ten parameters
per deployment against a 3 writes per second limit, and a consumer reads
several names that must stay in step.

### Option 2: One JSON parameter written by the demo stack
`/application-plane/shared/code-sandbox/sandboxes`, one document with
`version`, `toolTarget`, `runCodeFunctionArn`, `backends`, `defaultBackend`,
`registryTableName`, `inputBucketName`, `offboardFunctionArn`, and per
backend `imageArn`, `clusterArn` and `taskDefinitionArn`, or `runtimeArn`.
Pros: one write, one read, the shape the other samples publish; the demo
script and a consumer in another app find every value in one place. Cons: a
consumer parses JSON, and a reshaped document is a breaking change.

### Option 3: No parameter
Pros: nothing to keep in step with the construct. Cons: no deploy-time
interface; the demo script and a consumer in another app would read stack
resources the sample does not publish.

## Decision

Option 2. The demo stack in `src/demo.cdk.ts`, never the construct, writes
the one document from the construct's read-only properties; the integration
stack publishes nothing, so its two instances cannot collide. `toolTarget`
is `none` in the demo stack, which has no gateway entry, and
`runCodeFunctionArn` is `none` without `standalone`.

## Consequences

`scripts/demo.sh` and any consumer read one parameter. A parameter only
names resources: a consumer in another app still needs the grants the
construct makes in its own app (`grantInvokeRunCode`, a `RunCodeToolTarget`).
Adding a field is compatible; renaming or removing one needs a new ADR and a
`version` change. The name is fixed, so an account and Region hold one demo
stack; a vendor's own app that needs more than one stack names each
parameter itself.

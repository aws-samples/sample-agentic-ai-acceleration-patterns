<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0009: Deploy the driver as its own CDK app in `stress/`

- Status: Accepted
- Date: 2026-11-19
- Deciders: Dave Roberts (PSA)

## Context
ADR-0007 moves the `StressDriver` stack to `stress/driver/`. In runtime-isolation
it was one of three stacks of one CDK app, and took the sample's tier and the
ingress stack's registry prefix as props. The platform run has no single ingress
stack, and every slice needs the same host.

## Options considered
### Option 1: Each sample's app imports the stack from `stress/driver/`
Pros: one app per sample, as before. Cons: the file resolves `aws-cdk-lib` from
`stress/node_modules` and the sample's app from its own, so two copies of the CDK
load in one process, which constructs and `Stack.isStack` checks do not tolerate.
### Option 2: `stress/driver/app.ts` is the driver's own app, with scripts
Pros: one copy of the CDK; the host deploys and goes away on its own, with its
own tests and cdk-nag run; any slice calls two scripts. Cons: `stress/` gains
`aws-cdk-lib`, `aws-cdk` and `cdk-nag` as dev dependencies; a slice passes the
parameter prefixes the host may read as an environment variable instead of a prop.
### Option 3: Publish the stack as a package
Pros: clean dependency. Cons: a package build for a test asset.

## Decision
Option 2. `stress/driver/deploy.sh` and `teardown.sh` synthesise
`stress/driver/app.ts` into `stress/cdk.driver.out/` and deploy or remove
`<STRESS_PREFIX>-driver`. `STRESS_TIER` picks the instance type from
`src/tiers.ts`; `STRESS_PARAMETER_PREFIXES` lists the SSM paths the host may
read besides tenant-identity's (a slice's registry prefix). The stack takes an
instance type and those prefixes, not a tier or a sample's stack. The CDK and
cdk-nag versions match the samples'. The runtime-isolation scripts call the two
scripts and merge the stack's outputs into their own `outputs.json`.

## Consequences
Easier: one host stack, one CDK copy, and the stack's tests run in `stress/`.
Harder: a slice that wants the host in the same CloudFormation deploy as its own
stacks cannot have that; it deploys the host as a second step. `nag.ts` is a
copy of the two helpers every sample keeps (the samples do not import each other).
ProtoShield flags three wildcard resources on the host role, as it did in
runtime-isolation (its threat model records them as accepted): `execute-api:Invoke`
on every API of the account (the platform and entitlement API ids are not known at
deploy time, and each authorises every call itself), `ssm:GetParameter` on the
identity and slice prefixes, and `s3:GetObject`/`PutObject` on the objects of the
host's own results bucket. The change does not widen them: the SSM grant takes its
prefixes as input and the tests pin the action set.
Revisit if the platform run wants the host in the platform account's own stacks.

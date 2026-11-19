<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0017: Split the core from the gateway entry

- Status: Proposed
- Date: 2026-11-19
- Amends: ADR-0001
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0001 made the ingress optional, but one construct still imported
`ToolTarget` and `toolHandler` from `agentic-runtime-isolation`. A vendor
with their own identity provider and API would then install, build and
trust a sample they never deploy. Standard §1.1 asks that a consumer's
construct stay producer-agnostic.

## Options considered

### Option 1: A core construct at the package root and a gateway construct under a subpath
Pros: the core has no producer import; the producer becomes a dev and
optional peer dependency; the gateway path is still one construct away.
Cons: two constructs and two functions to document and test.

### Option 2: One construct, a dynamic `require` of the producer when `ingress` is set
Pros: one construct. Cons: the import is hidden from the type system and
from bundlers; a missing package fails at synth, not at install.

### Option 3: Keep the static dependency
Pros: nothing to change. Cons: the standalone case carries the producer.

## Decision

Option 1. `UntrustedCodeSandboxes` (package root) holds the pattern and
deploys `runCodeFunction` only with `standalone: true`, which a vendor's
own API invokes with IAM, passing a tenant id it verified; the function
vends the tool tenant role itself. A core with no entry fails synth. `RunCodeToolTarget` (`gateway` subpath) takes the core construct
and an ingress, deploys a gateway function that wraps the same run logic
in `toolHandler`, and gets its subnets, security group, environment, timeout, trust,
actions and log group from `sandboxes.bindRunCode`. It is the one
construct that names the producer, an accepted exception to standard
§1.1, which otherwise reserves that for demo apps and tests. Invoke on
`runCodeFunction` is granted through `grantInvokeRunCode`, or by an
identity policy on its published ARN; same-account identity policies
that allow invoke on `*` also reach it (threat T-82).
A lint rule and a unit test keep the producer import inside
`src/gateway/`.

## Consequences

The integration test drives both entries: the behaviour steps through
the gateway, and a `standalone` step through `runCodeFunction` with IAM.
On the standalone path the vendor decides the tenant (threat T-61, T-82).
The core function's budget may reach 120 s; the gateway entry refuses a
budget above 90 s.

Package shape, written in `.projenrc.ts` with `project.package.addField`
because projen owns `package.json`: `devDependencies` holds
`agentic-runtime-isolation` as `file:../agentic-runtime-isolation`;
`peerDependencies` holds it as `*` with
`peerDependenciesMeta.agentic-runtime-isolation.optional = true`;
`exports` maps `.` to the core entry and `./gateway` to the gateway
entry, with `typesVersions` for consumers on `node10` resolution. No
sample consumes another through `file:` yet, and the producer has no
`main` or `exports`. The same pull request therefore changes
`agentic-runtime-isolation`'s `.projenrc.ts` to add `main: lib/index.js`
and `types: lib/index.d.ts` (its `src/index.ts` already exports
`ToolTarget` and `toolHandler`), and runs that sample's build and tests.
A deep import of the producer's source was rejected, because standard
§1.1 asks for imports through the producer's package entry. The first
build proves the gateway import from the integration app and from a stub
consumer that has the producer, and the §8 `standalone-build` step proves
a consumer without it installs, compiles and synths the core.

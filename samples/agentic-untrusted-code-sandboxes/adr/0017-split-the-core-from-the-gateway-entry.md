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
`exports` maps `.` to `lib/index.js` and `./gateway` to
`lib/gateway/index.js`, with `main` and `types` on `lib/index.js` and
`lib/index.d.ts`, and `typesVersions` for consumers on `node10`
resolution. The core is the first sample meant to be installed outside
the repository, so it ships compiled JavaScript: a `.ts` entry under a
consumer's `node_modules` is not compiled by the default ts-node and is
refused by Node's type stripping there. Its constructs build their
Lambdas from `path.join(__dirname, '….function.ts')`, so a post-compile
projen task copies every `src/**/*.function.ts`, the modules they import,
and the runner sources into `lib/` at the same relative paths, and the
package's `files` keeps them. esbuild compiles those handler sources at
the consumer's synth. A unit test asserts that every `__dirname` entry
the constructs name exists under `lib/` after compile. No
sample consumes another through `file:` yet, and the producer has no
`main` or `exports`. The same pull request therefore changes
`agentic-runtime-isolation`'s `.projenrc.ts` to set `main` and `types` to
`src/index.ts`, and adds an `exports` map with `.` → `src/index.ts` and
`./tools` → `src/tools/context.ts`, so the gateway handler imports
`toolHandler` from `agentic-runtime-isolation/tools` and its bundle does
not pull in the producer's constructs or `aws-cdk-lib`. A `lib/` target
was rejected: tsc copies no `.function.ts` files into `lib/`, so every
producer construct that builds a Lambda from `__dirname` would fail at
synth, and `lib/` is not committed. That sample's build and tests run in
the same pull request, and the integration app's synth is the check that
the entry resolves.
A deep import of the producer's source was rejected, because standard
§1.1 asks for imports through the producer's package entry. The first
build proves the gateway import from the integration app and from a stub
consumer that has the producer, and the §8 `standalone-build` step installs the core
from an `npm pack` tarball into a consumer without the producer and
proves it installs, compiles and synths.

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
A lint rule and a unit test keep the producer out of everything the
core entry (`src/index.ts`) reaches; only `src/gateway/` and the demo app
files import it.

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
Lambdas from TypeScript handler sources, so a post-compile projen task
copies every `src/**/*.function.ts`, the modules they import and the
runner sources into a separate tree, `lib/handlers/`, at the same
relative paths, and the package's `files` keeps it. Nothing in `lib/`
outside `lib/handlers/` resolves into that tree, so no `.ts` file sits
next to a compiled `.js`, which ts-node with `--prefer-ts-exts` and `tsc`
would otherwise pick over the `.js` and `.d.ts`. The constructs name
their entries through one helper, `handlerEntry(relativePath)`, which
returns the `src/` path when the construct runs from `src/` (in the
repository) and the `lib/handlers/` path when it runs from `lib/`.
esbuild compiles those sources at the consumer's synth. Unit tests
assert that every entry the constructs name exists under `lib/handlers/`
after compile, and that no `.ts` other than a `.d.ts` ships outside
`lib/handlers/` (shadowing happens only within one directory, so the
mirrored copies under `lib/handlers/` are safe). No
sample consumes another through `file:` yet, and the producer has no
`main` or `exports`. The same pull request therefore changes
`agentic-runtime-isolation`'s `.projenrc.ts` to set `main` and `types` to
`src/index.ts`, and adds an `exports` map with `.` → `src/index.ts` and
`./tools` → `src/tools/context.ts`, so the gateway handler imports
`toolHandler` from `agentic-runtime-isolation/tools` and its bundle does
not pull in the producer's constructs or `aws-cdk-lib`. The producer keeps
a `src/` entry because it is only ever installed through `file:` from a
checkout: the symlink resolves to a real path outside `node_modules`, so
ts-node compiles it, and its `__dirname` handler entries stay valid.
`./gateway` therefore works outside this repository only when the
producer is a `file:` install of a checkout; a registry or tarball copy
of the producer is not supported, and the README says so. A `lib/` entry
for the producer would need the same handler-tree work as the core,
which the producer does not need while it is only consumed through
`file:`. That sample's build and tests run in
the same pull request, and the integration app's synth is the check that
the entry resolves.
A deep import of the producer's source was rejected, because standard
§1.1 asks for imports through the producer's package entry. The first
build proves the gateway import from the integration app and from a stub
consumer that installs the producer through `file:`, and the §8 `standalone-build` step installs the core
from an `npm pack` tarball into a consumer without the producer and
proves it installs, compiles and synths.

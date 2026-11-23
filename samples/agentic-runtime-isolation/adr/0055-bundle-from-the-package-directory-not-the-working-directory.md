<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0055: Bundle from the package directory, not the working directory

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (PSA)

## Context
Another sample reaches this package through a `file:` dependency and
constructs `ToolTarget` and `SharedIngress` in its own CDK app, as the
agentic-untrusted-code-sandboxes sample does through the package entry.
`NodejsFunction` decides where to bundle from two props. `depsLockFilePath` defaults to the
first lock file found walking up from the process working directory, and
`projectRoot` defaults to that file's directory. Every entry file of this
package must sit under `projectRoot`. When the consumer's app runs from its
own folder, the lock file found is the consumer's, the entries are not under
it, and the constructor throws `PathNotUnderRoot` before anything is
synthesised. This package's own synth and tests run from the package
directory, so they never showed it.

## Options considered
### Option 1: Pass `projectRoot` and `depsLockFilePath` from the package's own directory
Pros: the entries are always under the root, whatever the working
directory; one helper, spread into every `NodejsFunction` here; no change
for this package's own synth. Cons: the bundle resolves dependencies from
this package's `node_modules`, so the consumer must have installed it (a
`file:` dependency is symlinked, so it has).

### Option 2: Tell consumers to run their app from this package's directory
Pros: no code change. Cons: a consumer app cannot choose its working
directory; two consumers in different folders cannot both do it.

### Option 3: Ship the function code pre-bundled
Pros: no bundling at the consumer's synth. Cons: a build step and a checked-in
or published artifact per function, and every change to a handler needs a
rebuild; the sample would stop reading as source.

## Decision
Option 1. `bundlingRoot()` (`src/shared/bundling-root.cdk.ts`) returns the
package directory as `projectRoot` and its `package-lock.json` as
`depsLockFilePath`, computed from `__dirname`, which Node resolves through
the `file:` symlink to the real package path. `functionProps` spreads it for
the ingress, tools, entitlement and demo functions, and the custom-resource
helper and the two construct-local functions (registry entry, reservation)
spread it directly. A unit test synthesises both constructs from a different
working directory, with and without a lock file of its own.

## Consequences
Easier: any app, in any folder, can construct these constructs. Harder: a
new `NodejsFunction` in this package must spread `bundlingRoot()`, directly
or through `functionProps`, or it fails for consumers; a source check in the
test fails when a `new NodejsFunction(` call has neither. The root assumes
`src/shared` or the compiled `lib/shared` two levels
below the package directory. Revisit if the package is published to a
registry (the lock file is then not shipped; bundle from pre-built code,
Option 3).

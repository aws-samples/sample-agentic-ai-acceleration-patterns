<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0057: Prove the packed core builds without the producer

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0017 makes `agentic-runtime-isolation` an optional peer dependency
and promises that a vendor who imports only the core never installs it.
The import-graph test and the lint rule check the source. They do not
check what `npm pack` ships, what `npm install` of that tarball resolves,
or whether the handler tree is enough to synthesise.

## Options considered

### Option 1: A script that packs, installs into a stub app, compiles and synthesises
Pros: tests the artifact a vendor gets, with the consumer's default
`cdk.json` command and node10 module resolution. Cons: needs the npm
registry and about 15 s.

### Option 2: Rely on the import-graph test
Pros: no network. Cons: blind to a file left out of `files`, a producer
import in a shipped `.js` or `.d.ts`, and a peer error from npm.

## Decision

Option 1: `scripts/standalone-build.sh`, run by name after
`npx projen build`. It:

- packs the sample, checks the tarball holds `lib/handlers/`, and fails
  when a shipped file outside the gateway entry imports or requires the
  producer or a path names it;
- installs the tarball into a temporary app with the sample's pinned
  `aws-cdk-lib`, `constructs`, CDK CLI, `ts-node` and TypeScript, and
  fails on any peer warning or on a producer directory in `node_modules`;
- compiles the app with `tsc` (node10 module resolution, declaration files
  checked, so an unresolved producer type in a `.d.ts` fails), and runs
  `cdk synth` of `UntrustedCodeSandboxes` with `standalone: true` and all
  three backends through the default `ts-node --prefer-ts-exts` app
  command. The app outputs the ARN of the construct's `runCodeFunction`
  (the function a vendor invokes with IAM, which exists only with
  `standalone`), and the script requires that output to name a Lambda
  function with the registry table and the tool tenant role in its
  environment. The core's other functions share that environment, so the
  output, not the environment alone, picks the right one;
- loads the package root and fails if any module of the producer is in the
  module cache, then loads the `gateway` subpath and requires it to fail
  because the producer is missing and for no other reason.

It makes no AWS call. Everything it creates is in one temporary directory
that an `EXIT` trap removes (`STANDALONE_BUILD_KEEP=1` keeps it).

## Consequences

The optional-peer promise is a test, not a sentence. The `gateway`
subpath failing on the missing producer is the behaviour a vendor sees
when they import it without installing the producer (ADR-0017). The
integration test's `standalone-build` step runs this script before the
deploy. The script does not build the sample, so it fails with a clear
message when `lib/` is missing.

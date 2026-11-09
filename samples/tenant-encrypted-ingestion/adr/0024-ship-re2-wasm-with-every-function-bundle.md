<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0024: Ship re2.wasm with every function bundle

- Status: Accepted
- Date: 2026-11-09
- Deciders: Dave Roberts (PSA)

## Context
The Smithy model constrains the tenant id, the delivery id, the file name
and the content type with `@pattern` traits (`model/__global.smithy`). The
generated server SDK validates them with `re2-wasm`, which loads
`re2.wasm` (about 840 KiB) from its own directory at init. esbuild inlines
the JavaScript but not the `.wasm` file, so on the first deployment
(2026-11-06) every function that imports a generated model failed at init
with `ENOENT /var/task/re2.wasm`. The pattern traits are the model-level
half of the tenant id grammar (ADR-0003, ADR-0020): a malformed id is a 400
before a handler runs.

## Options considered
### Option 1: Drop the pattern traits
Pros: nothing to ship. Cons: the grammar leaves the model, so generated
clients and the OpenAPI document no longer state it; every handler must
repeat the check the SSDK would have made.
### Option 2: A Lambda layer holding `re2.wasm`
Pros: one copy for every function. Cons: the bundled module looks for the
file in the bundle's own directory (`__dirname`, `/var/task`), not in
`/opt` where a layer lands, so the load path needs a patch; a layer version
to publish and keep in step with the bundled package.
### Option 3: Copy `re2.wasm` into each bundle
An `afterBundling` command hook copies the file from the installed
`re2-wasm` package into the bundle's output directory. Pros: the file sits
where the module looks; the version is the one the bundle was built with;
one command in one place. Cons: each artifact grows by the file's size,
including functions that never validate a pattern.

## Decision
Option 3. `createFunction` in `src/construct/functions.ts` sets an
`afterBundling` hook that copies
`node_modules/re2-wasm/build/wasm/re2.wasm` into every function bundle it
builds.

## Consequences
Easier: the generated validators work unchanged; the grammar stays in the
model. Harder: every function artifact carries the file; a function built
outside `createFunction` (the copied `ScopeRegistration` and `LogDrain`
handlers, which import no generated model) does not, and must gain the
hook if it ever imports one. Revisit if the Smithy SSDK drops `re2-wasm`,
or esbuild's `NodejsFunction` bundling learns to carry `.wasm` assets.

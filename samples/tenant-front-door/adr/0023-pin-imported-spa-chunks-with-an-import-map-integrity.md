<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0023: Pin imported SPA chunks with an import map integrity

- Status: Accepted
- Date: 2026-11-18
- Amends: ADR-0008
- Deciders: Dave Roberts (PSA)

## Context

ADR-0008 sets a CSP of `script-src 'sha384-…' 'strict-dynamic'`. The hashes
cover the scripts `index.html` loads, and `'strict-dynamic'` lets the
hashed entry script load its own imports. Those imports, the chunks under
`/assets/*`, carry no hash. Whoever can write one object under `/assets/*`
in the SPA bucket therefore runs script in every tenant's origin at once,
with the access token and the refresh token in reach (ADR-0007). The
threat model lists it (T-61). The bucket's own controls reduce who can
write (spec §3.1), but a control on the bucket alone leaves one write as
the whole defence.

Constraints: the policy stays one header for every tenant (P-8), set by
the response headers policy, outside the bucket; it fits the 1,783-character
CSP limit (ADR-0008); nothing runs per request; and the SPA keeps no
script from another origin.

## Options considered

### Option 1: An import map with `integrity`, and `integrity` on the entry

The build writes an inline `<script type="importmap">` into `index.html`
with an `integrity` entry (`sha384`) for every chunk the entry can import,
statically or with `import()`. The entry's `<script>` carries `integrity`.
The import map is an inline script, so its hash goes into `script-src`
with the entry's. The map's keys are path-absolute URLs (`/assets/…`),
which resolve against the document, so the one `index.html` resolves on
every tenant host and dedicated domain.

Browsers that enforce `integrity` in an import map: Chrome and Edge 127
(2024-07), Firefox 138 (2025-04; Firefox ESR 128 does not, ESR 140 does),
Safari 18.0 on macOS and iOS (2024-09). Sources:
[MDN browser-compat-data, `html.elements.script.type.importmap.integrity`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap#browser_compatibility),
read 2026-11-18, and
[WebKit features in Safari 18.0](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)
("subresource integrity in imported module scripts"). Older browsers
apply the import map and ignore its `integrity`.

An import map does not cover a worker's top-level script, which is
fetched outside the document's map. The SPA starts no worker, so the
CSP sets `worker-src 'none'` (spec §7.1); a SPA that needs a worker pins
its script and changes that directive in the same release.

Pros: the SPA keeps code splitting. The chain from the policy to every
chunk is anchored in the response headers policy, so a write to the bucket
changes a chunk's bytes and the browser refuses it. Cost on the policy: two
hashes a release, the import map's and the entry's, beside the callback
script's (spec §7.1): six for the two releases the policy carries, about
450 characters. Cons: a browser that does not honour `integrity` in an import
map loads chunks unchecked, so the bucket's write controls remain the
protection there. The build must name every chunk.

### Option 2: One bundle, no imports

The SPA builds to the entry script alone, with no code splitting and no
dynamic `import()`. The entry's hash then covers all script, and
`'strict-dynamic'` has nothing to trust beyond it.

Pros: protects in every browser, with no import map and nothing to name.
Cons: every user downloads the whole SPA, the agent chat renderer included,
before the first screen; lazy routes are gone; a later dependency that
splits itself needs the build to stop it.

### Option 3: One hash per chunk in the CSP

Pros: no import map. Cons: a hash source applies to an inline script, or to
an external script that carries `integrity`; a module import has no
`integrity` attribute to carry, so the hashes would not match what the
browser checks. The hashes also change with every chunk of every release
and would outgrow the 1,783-character limit.

## Decision

Option 1. It keeps the SPA's code splitting and closes the gap in the one
place the policy already controls, the response headers policy. Where a
browser ignores the import map's `integrity`, the bucket policy (writes
only from the deployment roles), versioning and Block Public Access stay
the control, and the threat model says so (M-44, M-45).

## Consequences

- Easier: a write to an object under `/assets/*` no longer runs in a
  tenant's origin in a browser that checks the import map.
- Harder: the SPA build computes an `integrity` for every chunk and fails
  when one has none; the policy carries the import map's hash besides the
  entry's, and two hashes more for each release it holds (spec §7.1).
- Follow-up: the build test checks that a chunk with no `integrity` entry
  fails the build (spec §10 step 10).
- Revisit when the SPA is small enough to ship as one bundle, which makes
  Option 2 protect every browser, or when browsers older than Chrome or
  Edge 127, Firefox 138 or Safari 18.0, which ignore `integrity` in an
  import map, become a measurable share of a tenant's users. Revisit
  `worker-src 'none'` when the SPA needs a worker.

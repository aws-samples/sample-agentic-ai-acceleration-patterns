<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0008: Use a hash-based CSP with Trusted Types

- Status: Accepted
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

Every tenant gets the same web security baseline, set once at the edge by
one response headers policy that a tenant cannot weaken and an origin cannot
drop (P-8, spec §7.1). Content Security Policy is the part of that baseline
that limits which script runs in the page. It matters more here because the
access token lives in SPA memory (ADR-0007), and because the SPA renders
agent output, which is untrusted text.

The SPA is static: one build in S3, `index.html` revalidated on every load,
content-hashed assets cached for a year (spec §3.2). The SPA rules in
spec §7.2 already forbid HTML strings into the DOM and require Trusted Types
with no pass-through policy.

## Options considered

### Option 1: Script hashes with `'strict-dynamic'` and Trusted Types

The build computes a `sha384` hash for each script that `index.html` loads
and writes the policy: `script-src 'sha384-…' 'strict-dynamic'
'report-sample'`, plus `require-trusted-types-for 'script'`,
`object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'`
(spec §7.1).

Pros: works with a static file and a fixed header, so the response headers
policy carries it and nothing runs per request. `'strict-dynamic'` lets the
hashed entry script load its own imports. Trusted Types turns DOM injection
sinks into errors. Cons: every SPA build changes the hashes, so the policy
changes with each release.

### Option 2: Per-request nonces through Lambda@Edge

A Lambda@Edge function rewrites `index.html` on each response to stamp a
fresh nonce into the script tags and the header.

Pros: no build step for hashes. Cons: a function on every HTML response,
with its cost and latency. The HTML body differs per response, so it cannot
be cached. The header is set per request instead of by the one response
headers policy, which weakens P-8.

### Option 3: Host allowlist

`script-src 'self' <hosts>` with no hashes or nonces.

Pros: simple, no build step. Cons: an allowlisted host that serves an open
redirect or a JSONP endpoint lets an attacker run script, so allowlists are
bypassable. It offers no protection against injected inline script.

## Decision

Option 1. The SPA build computes the script hashes and writes the CSP into
the response headers policy, with `'strict-dynamic'`, Trusted Types enforced
and the other directives in spec §7.1. A static SPA needs no per-request
work, the policy stays one header for every tenant (P-8), and it does not
depend on any third-party host behaving well. The SPA rules in spec §7.2 are
part of this decision: without them Trusted Types would block the app.

## Consequences

- Easier: one policy for every tenant and every path, with no edge compute
  on HTML responses.
- Easier: a DOM injection sink in SPA code fails in the browser and, when
  `reportingEndpoint` is set, sends a report to `fd` (spec §7.1).
- Harder: a new SPA build ships with a stack update, because the hashes live
  in the response headers policy.
- Release order: the policy deploys over minutes, while `index.html` is
  revalidated on every load. So for one release the policy carries both
  the previous and the new script hashes. The policy deploys first, then
  the SPA files are uploaded, and the next release drops the old hash. Two
  sets of hashes fit within the 1,783-character limit on a CSP value in a
  response headers policy.
- Harder: inline styles are refused (`style-src 'self'`), and any third-party
  script must be loaded by the hashed entry script.
- Follow-up: the build fails when a script in `index.html` has no hash in the
  policy. A collector for reports is not in the sample (spec §1.2).
- Revisit when the sample adds server-side rendering or per-tenant SPA
  versions (spec §1.2), which would need nonces or one policy per version.

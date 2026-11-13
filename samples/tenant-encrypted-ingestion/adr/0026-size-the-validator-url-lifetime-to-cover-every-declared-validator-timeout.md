<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0026: Size the validator URL lifetime to cover every declared validator timeout

- Status: Accepted
- Date: 2026-11-13
- Amends: ADR-0008
- Deciders: Dave Roberts (PSA)

## Context
ADR-0008 gives each validator a presigned, ETag-pinned `GET` that lives
`validatorObjectUrlTtlSeconds` (60..900, default 300) and lets a validator
declare a `timeout` of up to 10 minutes. The two values were independent: a
deployer could declare a 600 s validator and keep the 300 s URL, and synth
passed. S3 checks a presigned URL's expiry when a request starts, so a
validator that fetches first and checks afterwards is unaffected. A
validator that starts its `GET` after the URL has expired gets a 403. If it
throws, the delivery retries, each receive signs a fresh URL with the same
lifetime, the late fetch fails every time, and on the last receive the
delivery ends as `<name>:VALIDATOR_ERROR`. If it maps the 403 to its own
`REJECT`, a good document is rejected. Either way a well-formed document is
turned away by a configuration the construct accepted.

The processor signs the URL immediately before the synchronous invoke
(`src/processor/validators.ts`), and the tenant session that signs it has at
least the processor timeout T left when the receive starts
(`src/processor/handler.ts`), and T includes every declared timeout
(spec §8). A URL that lives at least as long as the validator's declared
timeout is therefore valid for any `GET` the validator starts while it runs
within its declaration (ADR-0018 covers a validator that runs past it).

## Options considered
### Option 1: Document "fetch first" in the validator contract only
Pros: no code; the shortest URL lifetime. Cons: the misconfiguration still
synthesises and only shows up as rejected or errored deliveries in
production; the sample cannot enforce how a validator orders its work.
### Option 2: Fail synth when the lifetime is shorter than a validator timeout
Pros: the mismatch is caught at synth with a message naming both values.
Cons: a deployer who adds a validator longer than 300 s must also set
`validatorObjectUrlTtlSeconds`, although the right value is known.
### Option 3: Size each validator's URL to that validator's own timeout
The processor already holds each validator's declared `timeout` when it
signs. Pros: a fast validator next to a slow one keeps a short URL. Cons:
`validatorObjectUrlTtlSeconds` would stop naming one lifetime and become a
floor under per-validator values, so the request's `objectUrlExpiresAt`,
the docs and the threat model would each describe a per-validator rule;
the bucket's `s3:signatureAge` ceiling is the longest lifetime either way,
so the ceiling a leaked signature can reach is the same.
### Option 4: Default the lifetime to cover the longest timeout, and fail synth on an explicit value that does not
The default becomes the larger of 300 and the longest validator `timeout`;
an explicit value below the longest `timeout` fails synth. Pros: the default
is always safe with no extra prop; an explicit value is still checked; the
10-minute timeout cap sits inside the 900 s lifetime cap, so every valid
validator set has a valid lifetime. Cons: adding a long validator lengthens
the URL lifetime, and with it how long a leaked URL can be replayed, without
the deployer setting anything.

## Decision
Option 4. `validatorObjectUrlTtlSeconds` defaults to
`max(300, longest validator timeout)` and must be at least the longest
validator `timeout`; a shorter explicit value fails synth with
`validatorObjectUrlTtlSeconds (<n>) must be at least the longest validator
timeout (<m> s)`. The bucket policy's `s3:signatureAge` limit stays
`max(uploadUrlTtlSeconds, validatorObjectUrlTtlSeconds)` (M-7), so it
follows the resolved lifetime. "Fetch the object first, then run the slow
check" stays the recommended validator shape in the README.

## Consequences
Easier: a validator that runs within its declared timeout can always fetch
its document; the misconfiguration cannot be deployed. Harder: a 600 s
validator gives every validator URL in that deployment a 600 s life, so a
leaked URL (N-6) stays usable for longer; a deployer who wants short URLs
keeps validator timeouts short. Revisit if validators move to a carrier
that fetches on the validator's behalf (spec §11), or if the processor signs
one URL per validator sized to that validator's own timeout.

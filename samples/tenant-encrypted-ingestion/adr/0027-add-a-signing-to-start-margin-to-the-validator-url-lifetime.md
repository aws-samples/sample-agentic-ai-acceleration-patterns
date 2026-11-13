<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0027: Add a 60 s signing-to-start margin to the validator URL lifetime

- Status: Accepted
- Date: 2026-11-13
- Amends: ADR-0026
- Deciders: Dave Roberts (PSA)

## Context
ADR-0026 sizes `validatorObjectUrlTtlSeconds` to the longest validator
`timeout`. The URL's clock starts when the processor signs it, just before
the synchronous invoke (`src/processor/validators.ts`). The invoke latency
and, on a cold start, the validator's init phase come before the
validator's own timeout starts, and Lambda does not count init against the
function timeout. With the lifetime equal to the timeout, a validator that
starts its `GET` in the last seconds of its declaration can present a URL a
few seconds past its `X-Amz-Expires`, and past the equal `s3:signatureAge`
ceiling (M-7). ADR-0026's claim that the URL is valid for any `GET` the
validator starts within its declaration is short by that gap.

The tenant session that signs the URL does not shorten it further. The
processor fetches the session with at least T left (spec §8), and its own
Lambda timeout is T from handler start, so the session outlives every
validator call whose result can still affect the delivery, in any order.

## Options considered
### Option 1: No margin; soften the wording to "fetch early"
Pros: no code; the shortest URL. Cons: the gap stays, and only the README's
"fetch first" advice stands between a late fetch and a 403.
### Option 2: A fixed 60 s margin
The bound becomes the longest timeout plus 60 s, the same margin
`CreateDelivery` uses for the upload session. Pros: covers invoke latency
and a typical cold start; 600 + 60 = 660 still fits the 60..900 range, so
every valid validator set keeps a valid lifetime. Cons: a leaked URL lives
60 s longer.
### Option 3: The margin as a prop
Pros: a deployer with heavy cold starts can raise it. Cons: one more prop
for a number few deployers can reason about; the 900 s cap still bounds it.

## Decision
Option 2. `VALIDATOR_URL_MARGIN_SECONDS = 60` (exported). With validators,
`validatorObjectUrlTtlSeconds` defaults to `max(300, longest timeout + 60)`
and must be at least `longest timeout + 60`; a shorter explicit value fails
synth with `validatorObjectUrlTtlSeconds (<n>) must be at least the longest
validator timeout (<m> s) plus 60 s`. Without validators there is no
bound. The bucket's `s3:signatureAge` ceiling stays
`max(uploadUrlTtlSeconds, validatorObjectUrlTtlSeconds)`.

## Consequences
Easier: a validator that runs within its declared timeout can fetch its
document at any point in it, cold start included. Harder: a 600 s
validator gives every validator URL in the deployment a 660 s life, so a
leaked URL (N-6) lasts 60 s longer. The M-7 `s3:signatureAge` ceiling is the
larger of the two lifetimes, so when `uploadUrlTtlSeconds` is the smaller
one, the ceiling for upload URLs rises with the validator lifetime. Each
upload URL still expires at its own `uploadUrlTtlSeconds`; only the bucket's
backstop on how long code may presign is looser. Revisit if cold starts in
practice exceed the margin (raise it or make it a prop), or if the
processor signs one URL per validator.

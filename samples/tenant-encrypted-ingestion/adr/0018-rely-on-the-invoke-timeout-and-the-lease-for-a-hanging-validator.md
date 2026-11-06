<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0018: Rely on the invoke timeout and the lease for a hanging validator

- Status: Accepted
- Date: 2026-11-06
- Amends: ADR-0008
- Deciders: Dave Roberts (PSA)

## Context
ADR-0008 gives every validator a declared `timeout` (at most 10 minutes)
and states that a timeout is a validator error: thrown, retried, and on the
last receive `<name>:VALIDATOR_ERROR`. That reads as a promise that the
processor stops waiting at the declared timeout. The implementation
(`src/processor/validators.ts`) invokes the validator synchronously and
does not abort the call at the declared value. The declared timeout sizes
the processor's timeout T (spec §8). What actually ends a hanging call is
the validator function's own Lambda timeout, which surfaces as a
`FunctionError` (a validator error), or, if the validator declares less
than its function allows, the processor's own timeout T. In the second
case the receive ends without a terminal state and the delivery is left to
the lease: the next receive, or after the last one the sweep's
`structural:PROCESSING_ABANDONED`. §10 step 7c shows it: `test-switch`
declares 60 s and its function may run 5 minutes.

## Options considered
### Option 1: Abort the invoke at the declared timeout
An `AbortSignal` on the SDK call. Pros: keeps ADR-0008's reading; the
delivery is `<name>:VALIDATOR_ERROR` at the declared time. Cons: aborting
the client does not stop the Lambda invocation, which runs on and is
billed; the processor would report an error for a call that may still
return `ACCEPT`; extra code on the hot path.
### Option 2: Rely on the function's own timeout and on the lease
Pros: no extra code; a deployer who sets the function's timeout at or
below the declared one gets the validator-error path; every other case ends in
a terminal state through the lease and the sweep within the bound of
ADR-0007. Cons: a validator whose function outlives its declaration wedges
one receive and lands as `PROCESSING_ABANDONED`, not as that validator's
error.

## Decision
Option 2. The declared timeout only sizes T; the processor does not abort a
validator at it. A validator function's own timeout is a validator error;
a processor timeout leaves the lease to the next receive or the sweep. The
README's hardening checklist tells deployers to set a validator
function's own timeout at or below what it declares. Spec §3.5 and §8 state the gap.

## Consequences
Easier: no abort logic; behaviour is the same as for any processor crash,
which ADR-0007 already bounds. Harder: a misconfigured validator costs a
full processor run per receive and ends in `PROCESSING_ABANDONED`, which
names the structural stage rather than the validator; validator health
stays the deployer's alarm (ADR-0008). Revisit if the processor gains a
per-validator abort that also stops the invocation, or validators move to
a carrier with its own timeout (Step Functions, spec §11).

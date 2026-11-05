<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0009: Make validation a pluggable chain of deployer-supplied validators behind a carrier-neutral contract

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-8, F-11, F-29)

## Context
What counts as an acceptable delivery differs per deployment and per tenant: a
page limit, a required form, a malware scan, a regulated tenant's rule. The
vendor cannot ship these checks, so the deployer must add them without editing
the processor or widening its permissions. A check reads a tenant document, so
it must stay inside the tenant boundary (ADR-0003) and must not become the
weakest role in the system (P-8). It must also read exactly the bytes the
structural checks saw (F-11), a validator in another account must be
invocable (F-29), its errors can echo the URL it was given (F-29), and a
held validator error must be recoverable rather than stranding the delivery
(F-8). Realises P-8, P-10, P-11 and §3.3 (`validators`,
`validatorObjectUrlTtlSeconds`, `onValidatorError`), §3.5, §8.

## Options considered
### Option 1: In-process TypeScript plugins bundled into the processor
Pros: no extra invoke latency or cost; typed interface. Cons: plugin code runs
under the processor role, which can assume `tenantProcessRole` for any
tenant, so a bad plugin reads across tenants and breaks the role asymmetry of
P-8; TypeScript only; a plugin change redeploys the pipeline.
### Option 2: Chained synchronous Lambda invokes with a JSON contract
Pros: a validator holds no AWS permission of its own; it receives a presigned
`GET` for the one object, signed by the `tenantProcessRole` session, pinned
with `If-Match` to the validated ETag and valid for
`validatorObjectUrlTtlSeconds` (default 300), so a misbehaving validator reads
one document, as it was checked, for minutes and nothing else; any language,
any account; the processor stays the single owner of status and landing.
Cons: one invoke per validator per delivery, each a `Decrypt`; the chain must
fit one processor run (15 minutes).
### Option 3: A Step Functions workflow per delivery
Pros: long scans, parallel branches, visual history. Cons: a state machine and
its role per deployment plus per-transition cost; moves landing logic out of
the processor; heavier than the problem for a chain of quick checks.
### Option 4: Event-bus veto, validators vote asynchronously
Pros: fully decoupled. Cons: the pipeline must wait for every voter, and a
validator that never answers blocks every delivery; "no answer" has no safe
meaning, so it is either a timeout that lands unvalidated files or a stall.

## Decision
Option 2, behind a carrier-neutral contract so Option 3 can be added as a
second carrier (`'state-machine'`, §11) without changing validators.
`IDeliveryValidator` names `name`, `timeout` (at most 10 minutes), `carrier`
and `bind`; `LambdaValidator` is the shipped implementation and its `bind`
grants the processor `lambda:InvokeFunction` on the function and grants the
function nothing. `bind` can only grant in-account: a validator function in
another account needs a resource policy on the function that allows
`processorRole` to invoke it, which the deployer owns and the README shows
(F-29). The request carries ids, declared and measured attributes, `etag`,
`objectUrl` (signed with `If-Match: <etag>`, never logged, never persisted)
and `previous` verdicts; the verdict is `ACCEPT` or `REJECT` with `code` and
`message`. The chain runs after the structural checks, in list order, and
stops at the first `REJECT` (`<name>:<code>`). A function error, timeout or
malformed verdict is a validator error, never an `ACCEPT`; the processor logs
its `errorType` only, never the error body, which may echo the URL (F-29).
It follows `onValidatorError`: `hold` (default) throws, so the message
reaches the DLQ with the drop intact and the row stays `PROCESSING` under its
lease; an operator's DLQ redrive re-enters the lease and finishes the
delivery, and an unattended hold is closed by the sweep as
`REJECTED structural:PROCESSING_ABANDONED` (F-8, ADR-0016). `reject`
records `<name>:VALIDATOR_ERROR`. The processor timeout is computed at synth
from the structural budget, the validator timeouts and the copy budget,
capped at 15 minutes; a chain that does not fit fails synth.

## Consequences
Easier: a deployer adds a scanner or a page limit as a function; the shipped
`examples/validator-pdf-pages` shows the shape; one log line per call carries
`tenantId`, `validator`, `verdict`, `code`, `durationMs`; a unit test asserts
that a URL-bearing error body is never logged. Harder: the validator author
owns not persisting the URL and not echoing content in `message`; the README
says so; the chain multiplies cost per delivery (N invokes, each up to
10 minutes, each a `Decrypt`), which the per-tenant limits of ADR-0015 bound;
a held delivery must be redriven within one sweep cycle after the lease or it
is abandoned. Revisit when a validator needs more than 10 minutes, which
triggers the Step Functions carrier.

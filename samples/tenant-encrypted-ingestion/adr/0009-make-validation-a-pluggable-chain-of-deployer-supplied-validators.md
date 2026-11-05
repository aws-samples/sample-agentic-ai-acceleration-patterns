<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0009: Make validation a pluggable chain of deployer-supplied validators behind a carrier-neutral contract

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)
- Revised: 2026-11-05, security review (F-8, F-11, F-29)
- Revised: 2026-11-05, second security review (G-6, G-7, G-17)

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
(F-8).

The second review showed the hold path did not survive as written. A held
row stayed `PROCESSING` with a dead lease, so the hourly sweep abandoned it,
and deleted the drop object, long before an operator could redrive it from
the DLQ (G-6). And the queue's "deny unless the source is the rule" policy
also denied the redrive itself: `StartMessageMoveTask` needs the caller's own
`sqs:SendMessage` on the destination queue and carries no `aws:SourceArn`
(G-7). A validator's presigned `GET` also has to survive the bucket's
`s3:signatureAge` Deny for its whole TTL (G-17). Realises P-8, P-10, P-11
and §3.3 (`validators`, `validatorObjectUrlTtlSeconds`, `onValidatorError`),
§3.5, §4.2, §7.7, §8.

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
`message`. The bucket's `s3:signatureAge` Deny is the larger of
`uploadUrlTtlSeconds` and `validatorObjectUrlTtlSeconds`, so the validator's
URL lives its full TTL (G-17). The chain runs after the structural checks, in
list order, and stops at the first `REJECT` (`<name>:<code>`). A function
error, timeout or malformed verdict is a validator error, never an `ACCEPT`;
the processor logs its `errorType` only, never the error body, which may
echo the URL (F-29).

A validator error follows `onValidatorError`:

- `hold` (default): the processor writes the row **`HELD`**, clears the lease
  and keeps `statusBucket = OPEN`, then throws. SQS retries (each retry
  re-enters at step 2, takes the lease from `HELD` and runs the chain again)
  and, after `maxReceiveCount`, parks the message in the DLQ with the drop
  object intact (G-6). An operator fixes the validator and redrives with
  `StartMessageMoveTask`; the queue policy admits that send through its
  `aws:CalledViaLast = sqs.amazonaws.com` exception (G-7, ADR-0010), and the
  redriven message re-enters at step 2 and finishes the delivery. The sweep
  leaves `HELD` rows alone for 14 days after `updatedAt`, the DLQ retention,
  and only then abandons them as `REJECTED
  structural:PROCESSING_ABANDONED`, deleting the drop (ADR-0016).
- `reject`: records `<name>:VALIDATOR_ERROR` and deletes the drop.

Neither lands the object. The processor timeout is computed at synth from the
structural budget, the validator timeouts and the copy budget, capped at
15 minutes; a chain that does not fit fails synth.

## Consequences
Easier: a deployer adds a scanner or a page limit as a function; the shipped
`examples/validator-pdf-pages` shows the shape; one log line per call carries
`tenantId`, `validator`, `verdict`, `code`, `durationMs`; a unit test asserts
that a URL-bearing error body is never logged; the hold promise "an operator
can replay from the DLQ" now holds for the DLQ's whole retention, and the
integration test proves it (§10 step 7b: `HELD`, the sweep leaves it alone,
the redrive finishes it `ACCEPTED`). Harder: the validator author owns not
persisting the URL and not echoing content in `message`; the README says so;
the chain multiplies cost per delivery (N invokes, each up to 10 minutes,
each a `Decrypt`), which the per-tenant limits of ADR-0015 bound; a held
delivery counts against the tenant's `inFlight` for up to 14 days, so a
validator outage can push a busy tenant into 429s; one more row state to
document and test. Revisit when a validator needs more than 10 minutes, which
triggers the Step Functions carrier.

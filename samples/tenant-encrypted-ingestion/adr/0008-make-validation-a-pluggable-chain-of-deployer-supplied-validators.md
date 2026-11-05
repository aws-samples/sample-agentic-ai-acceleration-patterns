<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0008: Make validation a pluggable chain of deployer-supplied validators

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
What counts as an acceptable delivery differs per deployment and per tenant: a
page limit, a form type, a malware scan, a rule a regulated tenant imposes
(spec §1). The vendor cannot know these checks in advance, so the deployer
must add them without touching the pipeline's code or permissions. A check
that reads a document must stay inside the tenant boundary: code that runs
under the processor's role could assume `tenantProcessRole` for any tenant
(ADR-0003), and a check that holds AWS credentials of its own widens the set
of principals the key policy must trust. The chain must fit one processor
run and fail safely when a validator misbehaves. Realises P-11, spec §3.5.

## Options considered
### Option 1: In-process plugins bundled into the processor
Pros: no invoke latency or cost; a typed interface. Cons: plugin code runs
under `processorRole`, so a bad plugin can read across tenants and breaks the
role asymmetry of P-8; one language; a plugin change redeploys the pipeline.
### Option 2: Chained synchronous invokes behind a carrier-neutral contract
Pros: a validator holds no AWS permission; it gets a presigned `GET` for one
object, signed by the tenant session, pinned with `If-Match` to the checked
ETag and valid for minutes, so a bad validator reads one document as checked,
briefly, and nothing else; any language, any account; the processor stays the
only owner of status and landing. Cons: one invoke and one `Decrypt` per
validator per delivery; the chain must fit 15 minutes.
### Option 3: Asynchronous voting over the event bus
Pros: fully decoupled. Cons: the pipeline must wait for every voter, and a
voter that never answers blocks every delivery; "no answer" has no safe
meaning, so it is either a timeout that lands unvalidated files or a stall.

## Decision
Option 2. `IDeliveryValidator` names a `name` (`[a-z0-9-]{1,32}`, unique), a
`timeout` (at most 10 minutes), `bind()`, which grants the processor invoke
and nothing else, and a `carrier`; the request and verdict are versioned JSON
that names no carrier, so a Step Functions carrier can follow (§11).
`LambdaValidator(fn)` grants `processorRole` `lambda:InvokeFunction` on `fn`
and grants `fn` nothing. Per validator, the processor presigns a `GET` under
the `tenantProcessRole` session with `If-Match` signed and
`validatorObjectUrlTtlSeconds` (default 300) of life, and sends it with the
tenant id, delivery id, declared metadata, hash, ETag and earlier verdicts. A
validator in another account needs a resource policy on its function
admitting `processorRole`, which the deployer owns. Validators run in order
after the structural checks and the chain stops at the first `REJECT`, whose
reason is `<name>:<code>`. A schema-invalid verdict, a function error or a
timeout is a validator error: thrown, retried by SQS and, on the last
receive, `<name>:VALIDATOR_ERROR` (ADR-0007); it is never read as `ACCEPT`.
The URL and an error's body are never logged; one line per call records
`tenantId`, `deliveryId`, `validator`, `verdict`, `code`, `durationMs`, and
for an error its type only.

## Consequences
Easier: a deployer adds a check with a prop and a function, without touching
the processor; a validator cannot read a second document or reach another
tenant; a rejected delivery names the validator and its code. Harder: one
`Decrypt` per validator per delivery (P-9); a validator's `message` is stored
and returned and must not carry document content, which the sample can state
but not enforce; a logged validator URL would be reusable until its TTL,
which log delivery latency nearly consumes (N-6); a validator that is down
rejects deliveries on the last receive, so validator health is the
deployer's alarm. Revisit if a carrier needs callbacks longer than one
processor run, or if a manual hold of validator errors is built (§11).

<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0053: Log the client's correlation id at the ingress

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (PSA)

## Context
The repository's platform stress test (stress ADR-0005) reports latency per
hop and attributes every refusal to a tenant per request. It needs one id
that the load driver chose, on the driver's record and on each hop's log
line. The ingress lines (`request authorised`, `request served`,
`request admitted`, `request refused`, `token refused`) carry the verified
`tenantId`, `backend` and `txn`, but nothing the client chose, so a driver
record joins them only by tenant and time. A refusal at the authoriser has
no `txn` at all.

## Options considered
### Option 1: Log a client `x-correlation-id` header, shape-checked, as a field
Pros: one id the client controls, the same on every hop that logs it; a
refused request joins as well as a served one; no change to the request
path. Cons: a client-chosen value in the ingress logs, which until now held
only verified identifiers.

### Option 2: Return the ingress's own request id to the client
Pros: no client value is logged. Cons: a refused request at the authoriser
returns API Gateway's response, which cannot carry a custom header without
a gateway response template per status; the client learns the id only
after the response, so a timed-out request has none; the front door would
need a second id.

### Option 3: Accept a W3C `traceparent` header
Pros: a standard, and the Lambda functions already trace with X-Ray
(ADR-0014). Cons: the load driver and CloudFront Functions do not pass a
trace context on, the AgentCore Runtime does not join the ingress's trace,
and X-Ray sampling drops requests under load (stress ADR-0005), so a trace
id is missing on exactly the requests a stress run counts.

## Decision
Option 1. Each ingress function (the `api-gateway` authoriser and
integration function, and the `agentcore-gateway` interceptor) reads
`x-correlation-id` through `correlationIdOf` (`src/shared/headers.ts`) and
logs it as `correlationId` on every line that function writes for the
request. The value is
kept only when it is 1 to 64 characters of `[A-Za-z0-9-]`; any other value
is dropped whole, never trimmed or escaped, so a log line never holds client
text outside that alphabet. The value decides nothing: it is not an
authoriser identity source, not a metric dimension, not forwarded to the
Runtime, and not part of the session id. A request without the header logs
no field.

## Consequences
Easier: a client, the stress driver or a support desk, joins its own
record to the ingress lines on one field, for refusals and served requests
alike. Harder: the ingress logs hold one client-chosen value; its alphabet
and length bound what it can carry (threat model T-109, M-87). A request
answered from the authoriser cache logs no authoriser line, so its id
appears on the integration function's line only; lines written by the
shared modules a function calls (the limiter, the mint, SDK retries) carry
no `correlationId` and join by `tenantId` and time; a delegated hop
(ADR-0048) carries no client header, so it joins its caller by `txn`, not
by `correlationId`. Revisit if a trace context reaches every hop, the load
driver, CloudFront Functions and the Runtime included, without sampling,
or if the Runtime starts to forward client headers.

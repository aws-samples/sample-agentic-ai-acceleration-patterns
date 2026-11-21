<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0029: Join stress requests on the CloudFront request id

- Status: Accepted
- Date: 2026-11-21
- Deciders: Dave Roberts (PSA)

## Context
The stress slice (`scripts/stress/README.md`) reports the edge's own time
per request and checks that the driver's count of requests that reached
the cell equals the cell's log. That needs each driver request joined to
its CloudFront log line. Stress ADR-0005 (`stress/adr/`) chose a
client-supplied correlation header, `x-correlation-id`, that every hop
logs and the router passes on, and left each sample to record the change
in its own ADR. The router logs one custom value with `cf.logCustomData`,
and that value is the tenant (ADR-0010).

## Options considered
### Option 1: The correlation header of stress ADR-0005
The driver sends a fresh `x-correlation-id` per request. Pros: one id for
every hop, including the cell's log. Cons: the router gains a header rule
and the cell a log field, both only for the stress run; the router's one
custom log value is taken by the tenant, so the edge log line would not
carry the id; and the router's code is size-limited (`MAX_ROUTER_BYTES`).
### Option 2: The CloudFront request id
Every response carries `x-amz-cf-id`, and CloudFront's standard log
carries the same value as `x-edge-request-id`. Pros: no change to the
router, the cell or the headers a client may send. Cons: the cell's log
does not carry it, so the origin is joined by counts, not per request.
### Option 3: AWS X-Ray trace ids
Pros: standard. Cons: CloudFront Functions do not join a trace, and
sampling drops requests under load.

## Decision
Option 2. The slice joins each request to its edge log line on
`x-amz-cf-id` and `x-edge-request-id`, and compares the cell's log with
the driver's count of requests that reached the cell, by status. The
router, the cell and the front door's threat model stay as they are,
because no client header is logged or forwarded.

## Consequences
- The `edge` hop of the latency record comes from the standard log's
  `time-taken`, joined one to one.
- A request that reached the cell is not tied to its edge line. A
  mismatch between the counts shows that a hop dropped or added requests,
  not which one.
- The stress spec's decision 6 and the front-door part of its work item
  W-8 describe a correlation header the front door logs. This decision
  replaces that part for the front door: its hop joins on the CloudFront
  request id, and the stress spec records it in its own change.
- Revisit if the router gains a second custom log value or CloudFront
  Functions join a trace.

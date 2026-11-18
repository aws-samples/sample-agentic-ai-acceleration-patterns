<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0005: Log one correlation header at every hop

- Status: Accepted
- Date: 2026-11-18
- Deciders: Dave Roberts (PSA)

## Context
The platform run reports latency per hop (spec §6) and the edge overhead as
client TTFB minus ingress TTFB, per request. That needs one id in the k6
record, the CloudFront log, the router's log line, the cell origin's log
and the runtime-isolation `request served` line. Today each hop has its own
request id and none carries the others.

## Options considered
### Option 1: A driver header, `x-stress-request-id`, logged by each hop
Pros: one id the driver controls; works across accounts. Cons: the router,
the cell origin and the runtime-isolation ingress must each forward and log
it, which is a change to two samples.

### Option 2: The CloudFront request id, forwarded to the origin
Pros: no driver change; CloudFront logs it already. Cons: k6 does not know
it before the response; the ingress still has to log it.

### Option 3: AWS X-Ray trace ids
Pros: standard. Cons: CloudFront Functions and the AgentCore Runtime do not
join one trace; sampling drops requests under load.

## Decision
Option 1, under a neutral name: the samples log a client-supplied
correlation header, `x-correlation-id`, when present, as a field of their
existing log lines, and the router passes it to the origin unchanged. The
value is a client string: each hop accepts at most 64 characters of
`[A-Za-z0-9-]` and drops anything else, and no hop uses it for a decision.
The driver sends a fresh id per request. Each sample records the change in
its own ADR when it implements it.

## Consequences
Easier: per-hop latency and edge overhead join on one field. Harder: the
runtime-isolation ingress and the front door each gain a header rule and a
log field, and their threat models gain a line on a client-controlled log
value. Revisit if a standard trace context (`traceparent`) reaches every hop
including CloudFront Functions and the Runtime.

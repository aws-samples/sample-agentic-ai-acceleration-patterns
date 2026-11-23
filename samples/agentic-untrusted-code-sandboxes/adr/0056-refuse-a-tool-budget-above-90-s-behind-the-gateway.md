<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0056: Refuse a tool budget above 90 s behind the gateway

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Through the `api-gateway` ingress of `agentic-runtime-isolation`, the
agent's whole turn shares that ingress's fixed 120 s integration timeout
(spike S-11). The tool Lambda's timeout is `5 s + startWait + runTimeout +
10 s` (spec §3.3), which the core allows up to 120 s for its own function.
A gateway tool that may take 120 s leaves the agent no time to answer.

## Options considered

### Option 1: Refuse at synth when the budget is above 90 s
Pros: the failure is at the deployer's desk, names the two props to lower,
and cannot be missed. Cons: a deployer who wants 100 s behind the gateway
must lower `startWait` or `runTimeout`.

### Option 2: Clamp the gateway function's timeout to 90 s
Pros: always deploys. Cons: the Lambda is then killed before the runner's
own cap (`runTimeout` + 5 s) can end, so the tool returns no `timedOut`
result and leaves the sandbox running until the reaper finds it.

### Option 3: Check the remaining time inside the handler
Pros: adapts per call. Cons: the Lambda timeout is still the one that
matters, and the handler would repeat what the construct already knows.

## Decision

Option 1. `RunCodeToolTarget` reads the core's resolved tool budget and
throws at construction when it is above 90 s. Below the cap, the gateway
function's timeout is the budget itself, so the `+ 10 s` margin that makes
the tool return `timedOut` on its own is kept. The standalone function
keeps the 120 s cap.

## Consequences

A deployment that serves both entries from one core has one budget, so
the gateway's 90 s is also the standalone function's practical limit
unless the vendor builds a second core. Test: a budget of 90 s synthesises
with a Lambda timeout of 90, 91 s and 105 s fail with the budget in the
message.

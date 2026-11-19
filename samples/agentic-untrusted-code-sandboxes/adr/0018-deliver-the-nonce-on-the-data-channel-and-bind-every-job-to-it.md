<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0018: Deliver the nonce on the data channel and bind every job to it

- Status: Proposed
- Date: 2026-11-19
- Amends: ADR-0010
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The threat model found two gaps in ADR-0010. On `microvm` and `agentcore`
the tool checked a sandbox's identity only in the result, so a wrong
target had already run the code. And the start calls carried the nonce
itself (`runHookPayload`, the `RUNNER_NONCE` container override), which
`DescribeTasks`, `GetMicrovm` and possibly CloudTrail show to anyone who
can read them.

## Options considered

### Option 1: A per-job MAC checked before code runs, and only a hash of the nonce in start calls
Pros: no extra round trip on `microvm` or `agentcore`; a wrong runner
refuses before it writes the input or starts code; start calls and
their logs show only a hash. Cons: every message carries the nonce, and
on `microvm` and `agentcore` the job's code and input travel with it, so
a wrong runner sees all three, but only in the runner process, which
tenant code cannot read, and it refuses and keeps nothing. This rests on
the vendor runner being the sole listener and the sandbox ending when it
exits. `agentcore` has no start call to carry a hash, so its runner
anchors adoption to the session id it is invoked under instead.

### Option 2: A `/hello` challenge before every job on every backend
Pros: identity proven before any job byte, like `nitro`. Cons: one more
round trip per call; on `agentcore` an extra `InvokeAgentRuntime` per
call, about 0.5 s warm.

### Option 3: Keep ADR-0010 as is
Pros: nothing to change. Cons: both gaps stay open.

## Decision

Option 1 (spec §3.4 Identity check, §3.5 nonce delivery). Every job
carries `jobAuth`, an HMAC under the nonce over the run id, the
`tenantId` and a hash of the code and input, length-prefixed as spec §3.5
defines, the same on every backend. The runner refuses a mismatch with
`wrong_sandbox` before it touches `/work`.
Start calls carry `nonceHash` = SHA-256(`"nonce" ‖ nonce`); the nonce
travels on the data channel with every job and `/hello` and is adopted
only if it matches the hash. On `agentcore`, which has no hash, the
runner adopts only when its session id is `rc-` + SHA-256 of the
`tenantId` that `jobAuth` covers.
`nitro` keeps its TLS `/hello` before the first job.

## Consequences

A tool defect that addresses the wrong MicroVM, task or session costs
one refused call and a restart, not a run in another tenant's sandbox.
The result HMAC now confirms acceptance rather than proving identity.
S-14 checks that the AgentCore container receives the session id and
that CloudTrail records none of the nonce carriers. The
registry still holds the nonce, readable by the vendor's roles. Spike
S-14 checks what CloudTrail records for the start calls.

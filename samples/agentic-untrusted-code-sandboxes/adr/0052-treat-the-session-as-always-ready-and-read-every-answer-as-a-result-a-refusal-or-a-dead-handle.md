<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0052: Treat the session as always ready, and read every answer as a result, a refusal or a dead handle

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

An AgentCore session has no start call. It comes into being on the first
`InvokeAgentRuntime` under a session id, which measured 2 to 2.5 s for a new
session (S-9). The platform has no call that reports a session's state and
none that lists a runtime's sessions (S-8). The backend interface
(ADR-0025) asks each backend for `ready`, `list`, `isAlive` and
`stopReason` and for a `run` that returns a result, a refusal, `no_answer`
or a dead handle. The runner answers every job on `/invocations` with
HTTP 200, a result or a refusal body (`runner/PROTOCOL.md`).

## Options considered

### Option 1: Do not call the platform where it cannot answer, and say what the reaper does instead
`start` makes the handle with no call, `ready` is always ready, `list` is
empty, `isAlive` is true, `stopReason` has no facts. Pros: nothing pretends
to know what the platform does not tell. Cons: a session whose row is lost
cannot be found; it ends at `idleRuntimeSessionTimeout`, at `maxLifetime`, or
with the runtime (spec §4.1).

### Option 2: Probe with a throwaway job
`ready` sends a job to check the session. Pros: a real answer. Cons: the
first job starts the session and carries the tenant's code, so a probe would
start it with nothing to run; a probe job without `jobAuth` is refused and
adopts no nonce, so it proves nothing.

### Option 3: Track sessions in a second table
Pros: `list` could answer. Cons: a second source of truth that can disagree
with the registry, for sessions the platform ends by itself anyway.

## Decision

Option 1. `start` validates the tenant id and the nonce and returns the
handle: the session id, the runtime ARN as the address, the nonce. It makes
no call, so the start cap of 30 s is only the budget the caller allows for
the first job. `ready` returns `ready` with an empty patch, because the row
already holds the address and the `bootId` arrives with each result.

`run` sends the job as the `InvokeAgentRuntime` payload with a client that
makes one attempt: the SDK would retry a throttle, a 5xx answer or a dropped
connection, and a retry after the first attempt reached the runner could run
the tenant's code twice. A failed attempt is an error for the caller (the
last row of the table). The client keeps no pooled connection, because with no
retry a socket the service closed while the function was frozen would fail the
first call after a thaw; it costs one TLS handshake per job. It waits at most
`timeoutMs` + 5 s for the answer and its body together, then aborts the call
and returns `no_answer`. It returns:

| Answer | Outcome |
|---|---|
| a refusal with a known code and an optional boot id | `refused` (the tool decides: `busy` to the caller, `wrong_sandbox` and `dirty` a takeover, `tool_failed` an error) |
| a result whose `runId` is the job's and whose proof is HMAC(nonce, `runId`) | `result` |
| a result with another `runId` or a proof that does not match | `dead`, `identity_check_failed` |
| anything else a body can be: not JSON, not an object, a field of the wrong type, an unknown refusal code, a status other than 200 | `dead`, with a reason |
| `ResourceNotFoundException`, `RuntimeClientError` | `dead`, `not_found` or `runtime_client_error` |
| `RetryableConflictException` (documented as a retryable client fault; seen in the integration test when two first calls of one tenant reach the session at once, before the runner sees the job; a session still tearing down is read the same way, so the caller retries until it is gone) | `refused`, `busy` |
| any other error (throttle, access denied, network) | thrown to the caller |

A dead handle makes the tool stop the session and start a new one under the
same id with a new nonce (spec §4.1 step 3), which is also the answer to a
`dirty` session (spec §3.5 step 3). `stop` ends the session with
`StopRuntimeSession` and treats `ResourceNotFoundException` as a stop that has
happened.

## Consequences

The reaper's orphan sweep finds nothing on this backend, the drain stops only
sessions that have a row, and an `agentcore` orphan gets no stop line
(spec §3.8). The unit tests script each answer in the table, the deadline
with fake timers (no answer, a body that stops mid-stream, a late failure
after the deadline), and the guards of ADR-0050; a test against a local HTTP
server and the real SDK client shows one attempt on a 5xx and on a throttle,
and that the answer body is read from the stream. What stays unproven until
the integration test: that a stopped session started again under the same id
gets a new `bootId`, the exact error AgentCore returns for a container that
exited, and whether a call made while the session is still tearing down is
answered with a conflict error (the `StopRuntimeSession` documentation lists
one, and it reads as `busy`) or a throttle on session creation (which reaches
the caller as an error and is not retried).

<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0044: Classify MicroVM data-channel answers and start failures

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §4.1 treats a failed identity check, a `wrong_sandbox` or `dirty`
refusal, "not found" and a connection refusal as a dead handle, and a
missing answer after `timeoutMs` + 5 s as `no_answer`. A MicroVM adds a
proxy between the tool and the runner, with its own error statuses (400,
403, 429, 500, 502), and its API has quota and throttling errors the tool
should name.

## Options considered

### Option 1: Treat every failed call as a dead handle
Pros: simple. Cons: a proxy throttle or a token defect restarts a healthy
sandbox and reruns tenant code.

### Option 2: Decide on the runner's body first, then classify the rest
Pros: restarts only what is gone or wrong. Cons: more cases.

## Decision

Option 2.

| Outcome | Result |
|---|---|
| a runner body with a valid proof | `result` |
| a runner body with `error` `wrong_sandbox`, `busy`, `dirty`, `tool_failed` | `refused`, whatever the HTTP status |
| a runner body with another `error` | `dead` (`unknown_refusal`) |
| a result with a missing or wrong proof | `dead` (`identity_check_failed`) |
| a result with a valid proof and a malformed field | an error (a runner defect, not a dead sandbox) |
| no answer by `timeoutMs` + 5 s, including a stuck body read | `no_answer` |
| connection refused, DNS failure, host or network unreachable, connect timeout (the request never left) | `dead` (`connection_failed`) |
| any other failure, a reset, a socket or a TLS failure included (the safe side) | `no_answer` |
| the proxy's 502, "application not responding or auto-resume failed" | `no_answer`, unless the ended-before-the-call finding below holds |
| no answer, or a connection lost after the request left, when `GetMicrovm` shows the MicroVM `TERMINATED` with a `terminatedAt` more than 2 s before the request left (the margin covers a platform clock ahead of the caller's by up to 2 s) | `dead` (the platform's `stateReason`) |
| a stored address that is not a MicroVM endpoint of the image's Region (`https://<id>.lambda-microvm.<region>.on.aws`) | `dead` (`bad_address`); no token is made and nothing is sent |
| the proxy's 400, 403, 429, 500 | an error that names the status and never the token or the nonce |
| token request or lookup finds the MicroVM missing or ended | `dead` (`not_found`) |
| token request fails and the MicroVM is alive | the error |

`ready` reports `starting` for a `PENDING` MicroVM and for a live one whose
`/ping` does not answer, answers non-200, is not JSON or has no `bootId`
yet (the runner has none until the `/run` hook ran). The start cap belongs
to the caller. `ready` reports `ended` with the platform's `stateReason`
for `TERMINATING` and `TERMINATED`.

Start failures: `ServiceQuotaExceededException` is a `MicrovmStartError`
of kind `quota` that names `L-CD1C0CC4`, the maximum allocated ARM_64
MicroVM memory (spec §6.1); throttling is `throttled` (`RunMicrovm` allows
5 calls per second per account); insufficient capacity is `capacity`. Any
other error passes up unchanged. The `clientToken` is derived from the
nonce, so a retried start launches nothing new.

Memory sizing: the image takes `microvm.memoryMiB`, which charges that much
of the quota per tenant from the first call until 30 suspended minutes after
`sandboxIdle`. Synth warns for a size other than 1024 or 2048, the two the
spikes ran.

## Consequences

A throttled or over-quota deployment shows the cause in the tool line. The
integration test steps `runaway`, `dead-handle` and `failed-start` check
the `no_answer`, `dead` and failed-start rows. Only a request that never left,
or that went to a MicroVM already ended, is a dead handle, so a job that may
have run is never run a second time in a fresh MicroVM: the tool stops the sandbox and reports `timedOut` instead. The
cost is one failed call when auto-resume fails. A smoke run showed the proxy
answers 502, with an empty body and after about 3 s, for a MicroVM that was
terminated out of band. Read alone, that was `no_answer`, so the next call after
an out-of-band end returned a timed-out result and left the row on the dead
handle. The backend now reads `GetMicrovm` on every no-answer path: a MicroVM
that was `TERMINATED` more than 2 s before the request left cannot have run
the job, so the handle is dead and the tool starts a new sandbox. An
unreadable or slow lookup (3 s bound), a MicroVM still running, `TERMINATING`
(it may still serve), a `TERMINATED` one with no `terminatedAt` and one that
ended inside the margin or after the request left all stay `no_answer`.

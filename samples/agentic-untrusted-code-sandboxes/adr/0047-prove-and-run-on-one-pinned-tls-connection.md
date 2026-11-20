<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0047: Prove the sandbox and run the job on one pinned TLS connection

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

A `nitro` task is addressed by a private IP that ECS may give to another
task after the first one stops (ADR-0010; S-7 saw no reuse in twelve tasks
and did not rule it out). The runner makes a self-signed certificate at
boot, so the tool cannot validate a chain. `/hello` answers
`HMAC(nonce, challenge ‖ certFingerprint)` (runner/PROTOCOL.md).

## Options considered

### Option 1: One TLS connection per call; the client records the certificate fingerprint, checks `/hello` against it, and sends the job on that connection
Pros: the proof binds the nonce to the certificate of the connection that
carries the job, so a relay that forwards the runner's answer through its
own certificate fails the check; a recycled address that holds another
nonce gets no job bytes. Cons: one extra round trip per call.

### Option 2: Check the task ARN with `DescribeTasks` before every call
Pros: no runner change. Cons: a throttled control-plane call per run, and
it does not help when the address is right but the process is not
(rejected in ADR-0010).

## Decision

Option 1, in `src/backends/nitro.ts`. `connectTls` opens TLS without chain
validation and hands back the fingerprint (SHA-256 of the DER bytes) and a
keep-alive HTTP/1.1 channel over that one socket. `ready` and `run` post
`/hello` first; a `wrong_sandbox` refusal, a fingerprint that differs from
the connection's, or a proof that does not match is an identity failure:
`ended` in `ready`, a dead handle in `run`, and no job is sent. A runner
that is not listening or answers with something unusable is `starting` in
`ready`. In `run`, a connect or `/hello` error, a runner refusal and a
failed identity check are a dead handle. Once `/hello` has succeeded, any
transport error on the `/run` post (a lost connection, an answer past the
size limit, a timeout) is `no_answer`, because the job may have run and a
rerun in a fresh sandbox would run the tenant's code twice (ADR-0044). The
reason of a dead handle is a code (`connect_failed: ECONNREFUSED`), never
the error text, which carries the task's address. `run` waits at most
`timeoutMs` plus 5 s from the call (`no_answer` after that), reads at most
`6 × maxOutputBytes + 64 KiB` (stdout and stderr are cut by bytes, then
decoded and JSON-escaped), refuses a result whose run id or proof does not
match, and returns a runner refusal as
`refused`. `ready` reads `DescribeTasks` first on every probe and takes the
address from the task's own ENI, never from the row, and dials nothing
unless the task is `RUNNING`.

## Consequences

Every call costs a TLS handshake and a `/hello`, measured nowhere yet.
The check proves only that the peer accepted the nonce, the honest-runner
assumption of spec §3.5. Chain validation stays off for this one hop; a
test with real TLS shows the relay case.

The connection needs TLS 1.3, so a peer cannot renegotiate a new
certificate on the pinned connection, and the channel gives out the checked
socket only: when the runner closes it (an answer with `Connection: close`,
or a limit that destroyed it), the next request fails at once with a
connection error and never opens a second, unchecked connection. The runner
must answer `/hello` while a job runs, as it answers a second `/run` with
`busy`; a runner that did not would make a second call to the same sandbox
a dead handle and stop the sandbox under the first job.

A keep-alive socket that closes between `/hello` and the job also ends as
`no_answer`, although no job byte was sent: the sandbox is stopped and the
tenant sees a timeout. That is the safe side, as in ADR-0044. An answer
that arrives but is unusable (an HTTP error with no refusal) stays a dead
handle, the honest-runner case of spec §3.5.

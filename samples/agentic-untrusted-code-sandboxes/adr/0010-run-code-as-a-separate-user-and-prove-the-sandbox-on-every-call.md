<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0010: Run code as a separate user, and prove the sandbox on every call

- Status: Accepted
- Date: 2026-11-18
- Amended by: ADR-0015, ADR-0018, ADR-0019
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Two problems sit inside the VM. First, if code runs as the runner's own
user, it can fork a child that escapes the kill, kill or replace the
runner, or forge the runner's log lines; the run timeout then rests on the
8-hour platform cap. Second, a `nitro` sandbox is addressed by a private
IP. If tenant A's task dies, ECS can give that IP to tenant B's next task,
and A's next call, carrying A's code and A's input, would land in B's
sandbox. MicroVMs and AgentCore sessions are addressed by service-bound ids,
but a session can restart under the same id and lose its files.

## Options considered

### Option 1: Root runner, code as uid 1001 in its own process group; a per-start nonce the sandbox must prove
Pros: code cannot signal the runner or read its memory; killing the group
and then every uid 1001 process stops forks; the tool sends nothing to a
`nitro` task until it answers a challenge with
`HMAC(nonce, challenge ‖ certFingerprint)` over TLS,
so a reassigned IP gets nothing; the boot id shows a restarted session.
Cons: the nonce sits in the row and in the sandbox's environment; one extra
round trip per `nitro` call.

### Option 2: Check the task ARN with `DescribeTasks` before each call
Pros: no runner change. Cons: a control-plane call per run (throttled);
does not help if the code replaced the runner.

### Option 3: A fresh sandbox per call
Pros: no reuse, no stale address. Cons: rejected in ADR-0005.

## Decision

Option 1 (spec §3.4, §3.5). The tool makes a 32-byte nonce per start and
delivers it through the start call (MicroVM `runHookPayload`, ECS container
override, the first AgentCore job). The runner removes it from the
environment it hands to code. It proves the nonce on every call: an HMAC
over the run id in every result on all three backends, and on `nitro` a
`/hello` before the job. The `nitro` hop is TLS: the runner makes a key and
a self-signed certificate at boot, and binds the certificate fingerprint
into the `/hello` answer, `HMAC(nonce, challenge ‖ certFingerprint)`. The
tool checks the answer against the certificate of the connection it holds
and sends the job on that connection, so the code and the tenant's input
are encrypted in transit and reach only the task that holds the nonce. One
job runs at a time; a second gets `sandbox_busy`. `bootId`, not the nonce,
detects a restart, because a restarted AgentCore runner adopts the next
job's nonce.

## Consequences

Code that learns its own nonce gains nothing: it can only prove it is its
own tenant's sandbox. Principals with `ecs:DescribeTasks` or
`lambda:GetMicrovm` may read a nonce; the threat model lists them. S-4,
S-5 and S-10 check that each backend's runner can drop code to uid 1001. The integration test points A's row at B's task and
expects the refusal, and its runaway step tries forks, a kill of the runner
and a disk fill. If S-4 shows the MicroVM base image cannot drop to a
second user, the threat model records the gap for `microvm`.

Note 2026-11-18: amended by ADR-0015. On `microvm` and `agentcore` the runner makes `bootId` and adopts the nonce when the sandbox first serves a tenant (the `/run` hook, the session's first job), because sandboxes start from a shared snapshot. The AgentCore backend is a container, because a direct-code runtime cannot drop code to a second user.

Note 2026-11-19: amended by ADR-0018. Every job carries a MAC bound to the nonce, which the runner checks before it writes the input or runs code; start calls carry only a hash of the nonce, and the nonce travels on the data channel.

Note 2026-11-19: amended by ADR-0019. The job's memory cap is chosen per backend (rlimits on `microvm`, the platform's task limit plus the watchdog on `nitro`, a session-long job cgroup on `agentcore`), and no runner can set its own `oom_score_adj` to -1000.

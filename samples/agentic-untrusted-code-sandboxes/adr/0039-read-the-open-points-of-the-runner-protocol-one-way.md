<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0039: Read the open points of the runner protocol one way

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

`runner/PROTOCOL.md` and spec §3.5 leave a few runner-side points open:
what "stdout cut first" keeps, how large a body may be, what a broken
`/run` hook does, whether the hook's `tenant` is checked, and how the
runner answers when it cannot become one tenant's.

## Options considered

### Option 1: Decide each point in the runner and write it down here
Pros: no protocol change; the tool already decides on `error`. Cons: a
second reader must find this record.

### Option 2: Change `runner/PROTOCOL.md`
Pros: one document. Cons: a protocol change needs a maintainer decision
and both sides in one pull request, for points the tool does not depend on.

## Decision

Option 1.

- Output: when stdout and stderr together exceed `maxOutputBytes`,
  stdout is shortened first and stderr is kept whole up to the limit, so
  the error that ended a job survives. Each stream is read into memory up
  to `maxOutputBytes` and the rest is counted and dropped.
- Bounds: a body above 9 MiB, an input above 6 MiB after base64
  decoding, or `maxOutputBytes` outside 0 to 16 MiB is a malformed job
  (HTTP 400, `tool_failed`). The tool's own input limit is lower. A body
  may come with `Content-Length` or chunked (chunk sizes 1 to 8 hex
  digits, nothing else), and must arrive within 30 s. The hook port takes
  bodies up to 16 KiB. Each listener serves at most 4 connections at once
  and closes a fifth before it reads a byte, which bounds the runner's
  threads and the memory a peer, tenant code on the loopback included, can
  make it hold before authentication.
- `microvm` hook: a first `/run` hook whose `nonceHash` is not 64
  lowercase hex characters or whose `tenant` breaks the tenant id rule
  answers HTTP 400 and is not taken as the first hook. Once a hook is
  taken, a job whose `tenantId` differs from the hook's `tenant` is
  `wrong_sandbox`, even when the nonce matches.
- `/hello` on `nitro` adopts a matching nonce, as a job does.
- `microvm` hook paths: the platform calls
  `POST /aws/lambda-microvms/runtime/v1/{ready,run,suspend,resume,terminate}`
  on the hook port, and wraps `runHookPayload` as a JSON string in
  `{"microvmId", "runHookPayload"}` (spike S-2; its probe runner answered
  every name under that prefix, `terminate` included). The runner serves
  each name under the prefix and at `/<name>`, unwraps the payload, and
  answers `ready` with HTTP 200 once it serves and can take a job. This
  is the one change this record makes to the hook section of
  `runner/PROTOCOL.md`, by a maintainer decision.
- Becoming one tenant's (sizing, `/work`, `/dev/shm`, the `agentcore`
  cgroups) failing: `nitro` exits 1 at start, so the task stops and the
  start fails; `microvm` keeps the hook and answers every job
  `tool_failed`; `agentcore` adopts nothing and answers `tool_failed`, and
  tries again at the next job.
- The runner's TLS on `nitro` accepts TLS 1.2 and later, with an ECDSA
  P-256 key and a 30-day self-signed certificate made by `openssl` at
  start and loaded from a `memfd`.

## Consequences

The tool sees only the refusal codes the protocol names. A change to any
point here that the tool must know about goes through `runner/PROTOCOL.md`
by a maintainer decision.

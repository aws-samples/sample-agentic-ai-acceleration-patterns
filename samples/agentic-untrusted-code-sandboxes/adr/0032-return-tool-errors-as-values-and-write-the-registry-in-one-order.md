<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0032: Return tool errors as values, and write the registry in one order

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §4.1 and §5.1 fix what `run_code` does and the error codes it
returns, but not the TypeScript signature of the function both entries call,
and §4.1 leaves a few write rules open: which writes carry the version, what a
call does after a failed `start`, how the tool tells a restarted sandbox from
a reused one, and how long credentials live. The gateway entry
(`toolHandler`) turns any thrown error into the one code `tool_failed`, so a
tool that throws loses `sandbox_starting` and its `retryAfterSeconds`.

## Options considered

### Option 1: `runCode` throws a typed error per code
Pros: the usual shape. Cons: both entries must catch and translate; on the
gateway entry a miss turns every code into `tool_failed` (spec §3.3).

### Option 2: `runCode` returns the output or `{ error, retryAfterSeconds? }`, and never throws
Pros: one shape for both entries; the code reaches the agent; a tool
function that cannot throw cannot leak a stack. Cons: a caller must check
the result (`isRunCodeError`).

## Decision

Option 2.

```ts
runCode(request: RunCodeRequest, deps?: RunCodeDeps): Promise<RunCodeOutput | RunCodeError>
```

`request` is `{ tenantId, code, input?, backend?, saveOutput? }`. Every field
is checked as `unknown`, because both entries pass JSON. Any fault the tool
does not map to a code (credentials, DynamoDB, a backend exception, a failed
output write) is `tool_failed`, and the log line carries the error's class
name only.

Registry writes, in the spec's order:

- Every write is conditional. A write that loses a race returns a value, and
  the caller reads the row again, at most four times in one call, then
  returns `sandbox_starting`.
- Takeover (§4.1 step 2) is `attribute_not_exists(state)` for a missing or
  partial row, and `version = :v AND nonce = :n` for a row that was read. The
  nonce is unique per start, so a row deleted and recreated with the same
  version number is never taken over by a caller that read the earlier one.
- The `READY` transition and the probe's patch are one write (state,
  `address`, `bootId`), not the spec's two. A probe that learns only an
  `address` writes it alone.
- The start mark (§3.8) is conditioned on the `lastUsedAt` the caller read, on
  the row still being `READY` for the same handle, and is retried after a
  re-read up to three times. Step 4 (`touch`) is conditioned as the spec says
  and its failure is ignored.
- A `start` that throws leaves a `FAILED` row with no handle and a 30 s
  backoff, and the call returns `sandbox_failed`. Nothing is recorded to stop;
  a sandbox the failed call launched anyway is an orphan the reaper stops.
- A refusal of `wrong_sandbox` or `dirty`, a failed result proof, `dead` or
  a result for another `runId` marks the handle dead. The call takes the row
  over once and runs again on the new sandbox with the same `runId` and a new
  nonce. A second dead handle in the same call sets `FAILED` and returns
  `sandbox_failed`. A call that already waited for a start does not wait again
  after that takeover (§4.1 step 3).
- A `no_answer` returns a result with `timedOut` true, `exitCode` -9 (the
  runner never answered, so the sandbox was killed) and empty output.
- The tool cuts output above `maxOutputBytes` again, stdout first. The
  runner already does; this is the tool's own cap on what it returns.
- `sandbox` is `started` when the call won a takeover, waited for a start, or
  saw a `bootId` different from the one on the row. The first `bootId` a row
  gets (`agentcore` has none from `ready`) is recorded and is not a restart.
- Credentials are one `AssumeRole` with the `TenantId` session tag, cached per
  tenant in the warm environment until two minutes before they expire.

## Consequences

The gateway entry wraps `runCode` and returns its result unchanged. A
vendor's own tool calls it and checks `isRunCodeError`. A caller that gets
`tool_failed` learns nothing about why; the reason is in the log line.
Changing the signature later is a breaking change for the gateway entry.

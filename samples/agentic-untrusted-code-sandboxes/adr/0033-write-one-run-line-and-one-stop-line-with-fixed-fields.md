<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0033: Write one run line and one stop line, with fixed fields

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0013 attributes runs and sandbox seconds from the tool's log, and spec
§3.8 lists the fields and says who writes the stop line. It does not name the
events, say how a failed stop affects the line, or say which time the
`microvm` split uses. The Contributor Insights rules and the integration
test key on these names.

## Options considered

### Option 1: free-form `console.log` lines
Pros: nothing to define. Cons: under the Lambda JSON log format the whole
string lands in `message`, so no field is queryable at the top level.

### Option 2: `process.stdout.write` of one JSON object per line, with an `event` field
Pros: fields stay at the top level; one name per kind of line.
Cons: a line is more code than a `console.log`.

## Decision

Option 2. A line is `{ "event": …, …fields }` and ends with a newline. A
line never carries code, input, output, a nonce, a proof or an error
message, only ids, sizes, outcomes and an error's class name (letters, digits,
`_` and `.`, at most 64, else `Error`). A platform's free-text reason is cut to
200 characters.

| `event` | Written by | Fields |
|---|---|---|
| `run` | the tool, once per call, including a refused one | `tenantId` (`invalid` only when the id itself broke its rule; any other refusal is counted against the tenant), `backend`, `handle`, `runId`, `sandbox`, `outcome` (`ok` or a tool error code), `exitCode`, `timedOut`, `durationMs`, `startMs`, `inputBytes`, `outputBytes`, `stoppedReason` on a failed start or a fault |
| `sandbox_stopped` | the writer that moved the row out of `STARTING` or `READY`, or the stopper of an orphan | `tenantId` (`unknown` for a `microvm` orphan), `backend`, `handle`, `sandboxSeconds`, `by` (`tool`, `reaper`, `drain`, `offboard`), `reason` (`expired`, `dead`, `overrun`, `failed_start`, `idle`, `gone`, `drain`, `offboard`, `orphan`), `stoppedReason` (the platform's reason, or the reason a start failed), `orphan` |
| `stop_failed`, `reaper_error`, `reaper`, `drain`, `drain_registry_gone` | the reaper and the drain | counts and error class names |

`sandboxSeconds` is `stoppedAt - startedAt` from the platform's facts
(`stopReason`) where it gives them, else the row's `createdAt` and the time
of the stop. On `microvm` the line adds `runningSeconds`, `suspendedSeconds`
and `estimated`: suspended is the row's `suspendedMs` plus the last gap,
`stoppedAt - lastUsedAt - sandboxIdle`, capped at `sandboxSeconds`.

The line is written after the conditional write that moves the row, whether or
not the stop call then succeeds. A stop that fails leaves the sandbox to the
next reaper pass, which stops it again and writes no second line, so a
sandbox has exactly one line and a failed stop is visible as `stop_failed`.
An orphan has no row to remember it, so its line is written when a stop works.

With `perTenantMetrics` the tool also writes one EMF line per run (`Runs`,
`Errors`, `RunDuration`) and one per stop (`SandboxSeconds`) in the
namespace `UntrustedCodeSandboxes`, with the dimensions `TenantId` and
`Backend`. A `microvm` orphan with an unknown tenant emits no metric.

## Consequences

The Contributor Insights rules match `event = run` for runs and
`event = sandbox_stopped` for seconds, keyed on `tenantId`. A caller that
sends a bad tenant id shows as `tenantId = invalid`, never as the string it
sent, so a hostile id cannot become a log field value or a metric dimension.
